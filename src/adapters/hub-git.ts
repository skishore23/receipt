import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class HubGitError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(status: number, message: string, opts?: { readonly code?: string; readonly details?: Readonly<Record<string, unknown>> }) {
    super(message);
    this.status = status;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}

export type HubGitCommit = {
  readonly hash: string;
  readonly parents: ReadonlyArray<string>;
  readonly subject: string;
  readonly author: string;
  readonly ts: number;
  readonly touchedFiles?: ReadonlyArray<string>;
};

export type HubGitGraph = {
  readonly defaultBranch: string;
  readonly sourceHead?: string;
  readonly commits: ReadonlyArray<HubGitCommit>;
  readonly byHash: Readonly<Record<string, HubGitCommit>>;
  readonly children: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly leaves: ReadonlyArray<string>;
};

export type HubGitWorkspaceSpec = {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly baseHash?: string;
};

export type HubGitWorkspace = {
  readonly workspaceId: string;
  readonly baseHash: string;
  readonly branchName: string;
  readonly path: string;
};

export type HubGitWorkspaceRestoreSpec = {
  readonly workspaceId: string;
  readonly branchName: string;
  readonly workspacePath: string;
  readonly baseHash: string;
};

export type HubWorktreeStatus = {
  readonly exists: boolean;
  readonly dirty: boolean;
  readonly head?: string;
  readonly branch?: string;
};

export type HubSourceStatus = {
  readonly dirty: boolean;
  readonly head?: string;
  readonly branch?: string;
  readonly changedFiles: ReadonlyArray<string>;
};

export type HubWorkspaceCommit = {
  readonly hash: string;
  readonly branch?: string;
};

export type HubSourcePromotion = {
  readonly targetBranch: string;
  readonly previousHead: string;
  readonly mergedHead: string;
};

export type HubMirrorStatus = {
  readonly head?: string;
  readonly syncing: boolean;
  readonly lastSyncAt?: number;
  readonly lastSyncError?: string;
};

type HubGitOptions = {
  readonly dataDir: string;
  readonly repoRoot: string;
};

const HASH_RE = /^[0-9a-f]{4,64}$/i;
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";
const REMOTE_LOCK_STALE_MS = 30_000;

const clean = (value: string): string => value.trim();

const pathExists = async (value: string): Promise<boolean> => {
  try {
    await fs.promises.access(value, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const looksLikeRemoteUrl = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
  || /^[^/\\]+@[^:]+:/.test(value);

const canonicalizeRepoPath = async (value: string): Promise<string> => {
  const trimmed = clean(value);
  if (!trimmed || looksLikeRemoteUrl(trimmed)) return trimmed;
  const resolved = path.resolve(trimmed);
  return clean(await fs.promises.realpath(resolved).catch(() => resolved));
};

const safeBranchPart = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

const parseTouchedFiles = (raw: string): ReadonlyArray<string> =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const parseLines = (raw: string): ReadonlyArray<string> =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const parseStatusFiles = (raw: string): ReadonlyArray<string> =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const file = line.slice(3).trim();
      if (!file) return line;
      const renamed = file.split(" -> ").pop();
      return renamed?.trim() || file;
    });

const isOperationalPath = (file: string): boolean => {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return normalized === ".receipt" || normalized.startsWith(".receipt/");
};

export class HubGit {
  readonly repoRoot: string;
  readonly bareDir: string;
  worktreesDir: string;
  private readonly configuredWorktreesDir: string;
  private worktreesDirReady: Promise<void> | undefined;

  private readonly remoteName = "source";
  private readyPromise: Promise<void> | undefined;
  private graphCache: { readonly key: string; readonly graph: HubGitGraph } | undefined;
  private syncPromise: Promise<void> | undefined;
  private lastSyncAt: number | undefined;
  private lastSyncError: string | undefined;

  constructor(opts: HubGitOptions) {
    this.repoRoot = path.resolve(opts.repoRoot);
    this.bareDir = path.join(opts.dataDir, "hub", "repo.git");
    this.configuredWorktreesDir = path.join(opts.dataDir, "hub", "worktrees");
    this.worktreesDir = this.configuredWorktreesDir;
  }

  invalidateGraph(): void {
    this.graphCache = undefined;
  }

  async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.prepare();
    }
    return this.readyPromise;
  }

  private async ensureWorktreesDirReady(): Promise<void> {
    if (!this.worktreesDirReady) {
      this.worktreesDirReady = this.prepareWorktreesDir();
    }
    return this.worktreesDirReady;
  }

  private async prepareWorktreesDir(): Promise<void> {
    const candidates = [this.configuredWorktreesDir, ...this.alternateWorktreesDirs()];
    let lastError: NodeJS.ErrnoException | undefined;
    for (const candidate of candidates) {
      try {
        await fs.promises.mkdir(candidate, { recursive: true });
        await fs.promises.access(candidate, fs.constants.W_OK);
        this.worktreesDir = candidate;
        return;
      } catch (err) {
        lastError = err instanceof Error ? err as NodeJS.ErrnoException : undefined;
      }
    }

    throw new HubGitError(500, "unable to prepare a writable worktree base directory", {
      code: "ERR_WORKTREE_DIR_CREATE_FAILED",
      details: {
        path: this.configuredWorktreesDir,
        errno: lastError?.errno,
        message: lastError?.message,
      },
    });
  }

  private alternateWorktreesDirs(): ReadonlyArray<string> {
    const candidates: string[] = [];
    const xdgStateHome = process.env.XDG_STATE_HOME;
    if (xdgStateHome) candidates.push(path.join(xdgStateHome, "receipt", "worktrees"));
    candidates.push(path.join(os.tmpdir(), "receipt-worktrees"));
    return candidates.filter((candidate) => candidate !== this.configuredWorktreesDir);
  }

  async syncFromSource(): Promise<void> {
    await this.ensureReady();
    if (!this.syncPromise) {
      this.syncPromise = (async () => {
        try {
          await this.ensureRemote();
          await this.fetchSourceMirror();
          this.invalidateGraph();
          this.lastSyncAt = Date.now();
          this.lastSyncError = undefined;
        } catch (err) {
          this.lastSyncError = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          this.syncPromise = undefined;
        }
      })();
    }
    return this.syncPromise;
  }

  scheduleSyncFromSource(): void {
    void this.syncFromSource().catch(() => {
      // background sync failures are surfaced through mirrorStatus
    });
  }

  async defaultBranch(): Promise<string> {
    await this.ensureReady();
    const symbolic = clean(await this.execGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: this.repoRoot }).catch(() => ""));
    if (symbolic) return symbolic;
    const branch = clean(await this.execGit(["branch", "--show-current"], { cwd: this.repoRoot }).catch(() => ""));
    if (branch) return branch;
    throw new HubGitError(503, "unable to determine source default branch");
  }

  async sourceHead(): Promise<string | undefined> {
    const branch = await this.defaultBranch();
    const ref = `refs/remotes/${this.remoteName}/${branch}`;
    return clean(await this.execGit(["rev-parse", "--verify", ref], { gitDir: this.bareDir }).catch(() => ""));
  }

  async mirrorHead(branch?: string): Promise<string | undefined> {
    await this.ensureReady();
    const resolvedBranch = branch || await this.defaultBranch();
    const ref = `refs/remotes/${this.remoteName}/${resolvedBranch}`;
    return clean(await this.execGit(["rev-parse", "--verify", ref], { gitDir: this.bareDir }).catch(() => "")) || undefined;
  }

  async mirrorStatus(branch?: string): Promise<HubMirrorStatus> {
    return {
      head: await this.mirrorHead(branch),
      syncing: Boolean(this.syncPromise),
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
    };
  }

  async resolveBaseHash(baseHash?: string): Promise<string> {
    await this.syncFromSource();
    return baseHash ? this.resolveCommit(baseHash) : this.requiredSourceHead();
  }

  async sourceStatus(): Promise<HubSourceStatus> {
    await this.ensureReady();
    const statusRaw = await this.execGit(["status", "--porcelain=v1"], { cwd: this.repoRoot });
    const head = clean(await this.execGit(["rev-parse", "HEAD"], { cwd: this.repoRoot }).catch(() => ""));
    const branch = clean(await this.execGit(["branch", "--show-current"], { cwd: this.repoRoot }).catch(() => ""));
    const changedFiles = parseStatusFiles(statusRaw).filter((file) => !isOperationalPath(file));
    return {
      dirty: changedFiles.length > 0,
      head: head || undefined,
      branch: branch || undefined,
      changedFiles,
    };
  }

  async resolveCommit(hash: string): Promise<string> {
    if (!HASH_RE.test(hash.trim())) {
      throw new HubGitError(400, "invalid commit hash");
    }
    await this.ensureReady();
    const resolved = clean(await this.execGit(["rev-parse", "--verify", `${hash}^{commit}`], { gitDir: this.bareDir }).catch(() => ""));
    if (!resolved) {
      throw new HubGitError(404, "commit not found");
    }
    return resolved;
  }

  async graph(): Promise<HubGitGraph> {
    await this.ensureReady();
    const cacheKey = await this.graphKey();
    if (this.graphCache?.key === cacheKey) return this.graphCache.graph;

    const raw = await this.execGit(
      ["log", "--all", "--date-order", `--pretty=format:%H${FIELD_SEP}%P${FIELD_SEP}%s${FIELD_SEP}%an${FIELD_SEP}%at${RECORD_SEP}`],
      { gitDir: this.bareDir }
    );
    const commits: HubGitCommit[] = [];
    const byHash: Record<string, HubGitCommit> = {};
    const children = new Map<string, string[]>();

    for (const record of raw.split(RECORD_SEP)) {
      const trimmedRecord = record.trim();
      if (!trimmedRecord) continue;
      const [hash = "", parentRaw = "", subject = "", author = "", tsRaw = "0"] = trimmedRecord.split(FIELD_SEP);
      if (!hash) continue;
      const commit: HubGitCommit = {
        hash,
        parents: parentRaw.trim() ? parentRaw.trim().split(/\s+/) : [],
        subject,
        author,
        ts: Number.parseInt(tsRaw, 10) * 1000,
      };
      commits.push(commit);
      byHash[hash] = commit;
    }

    for (const commit of commits) {
      for (const parent of commit.parents) {
        const bucket = children.get(parent) ?? [];
        bucket.push(commit.hash);
        children.set(parent, bucket);
      }
    }

    const childMap: Record<string, ReadonlyArray<string>> = {};
    for (const commit of commits) {
      childMap[commit.hash] = [...(children.get(commit.hash) ?? [])];
    }

    const leaves = commits
      .filter((commit) => (childMap[commit.hash]?.length ?? 0) === 0)
      .map((commit) => commit.hash);

    const graph = {
      defaultBranch: await this.defaultBranch(),
      sourceHead: await this.sourceHead(),
      commits,
      byHash,
      children: childMap,
      leaves,
    } satisfies HubGitGraph;

    this.graphCache = { key: cacheKey, graph };
    return graph;
  }

  async getCommit(hash: string): Promise<HubGitCommit> {
    const resolved = await this.resolveCommit(hash);
    const graph = await this.graph();
    const commit = graph.byHash[resolved];
    if (!commit) throw new HubGitError(404, "commit not found");
    return {
      ...commit,
      touchedFiles: await this.touchedFiles(resolved),
    };
  }

  async getChildren(hash: string): Promise<ReadonlyArray<HubGitCommit>> {
    const resolved = await this.resolveCommit(hash);
    const graph = await this.graph();
    return (graph.children[resolved] ?? [])
      .map((childHash) => graph.byHash[childHash])
      .filter((commit): commit is HubGitCommit => Boolean(commit));
  }

  async getLineage(hash: string): Promise<ReadonlyArray<HubGitCommit>> {
    const resolved = await this.resolveCommit(hash);
    const graph = await this.graph();
    const lineage: HubGitCommit[] = [];
    let current: HubGitCommit | undefined = graph.byHash[resolved];
    while (current) {
      lineage.push(current);
      const parent: string | undefined = current.parents[0];
      current = parent ? graph.byHash[parent] : undefined;
    }
    return lineage;
  }

  async diff(hashA: string, hashB: string): Promise<string> {
    const [a, b] = await Promise.all([this.resolveCommit(hashA), this.resolveCommit(hashB)]);
    return this.execGit(["diff", a, b], { gitDir: this.bareDir });
  }

  async createWorkspace(spec: HubGitWorkspaceSpec): Promise<HubGitWorkspace> {
    await this.syncFromSource();
    await this.ensureWorktreesDirReady();
    const workspacePath = path.join(this.worktreesDir, spec.workspaceId);
    if (fs.existsSync(workspacePath)) {
      throw new HubGitError(409, "workspace path already exists");
    }

    const branchName = `hub/${safeBranchPart(spec.agentId)}/${spec.workspaceId}`;
    const branchRef = `refs/heads/${branchName}`;
    const branchExists = await this.execGit(["show-ref", "--verify", "--quiet", branchRef], { gitDir: this.bareDir })
      .then(() => true)
      .catch(() => false);
    if (branchExists) {
      throw new HubGitError(409, "workspace branch already exists");
    }

    const baseHash = spec.baseHash ? await this.resolveCommit(spec.baseHash) : await this.requiredSourceHead();
    await this.execGit(["worktree", "add", "-b", branchName, workspacePath, baseHash], { gitDir: this.bareDir });
    await this.configureWorktreeIdentity(workspacePath);
    this.invalidateGraph();
    return {
      workspaceId: spec.workspaceId,
      baseHash,
      branchName,
      path: workspacePath,
    };
  }

  async restoreWorkspace(spec: HubGitWorkspaceRestoreSpec): Promise<HubGitWorkspace> {
    await this.syncFromSource();
    await this.ensureWorktreesDirReady();
    const workspaceExists = fs.existsSync(spec.workspacePath);
    const hasWorktreeMetadata = workspaceExists ? await this.hasLiveWorktreeMetadata(spec.workspacePath) : false;
    if (workspaceExists && !hasWorktreeMetadata) {
      await this.removeWorkspaceDirectory(spec.workspacePath);
    }
    if (!fs.existsSync(spec.workspacePath)) {
      await this.execGit(["worktree", "prune"], { gitDir: this.bareDir });
      const branchRef = `refs/heads/${spec.branchName}`;
      const branchExists = await this.execGit(["show-ref", "--verify", "--quiet", branchRef], { gitDir: this.bareDir })
        .then(() => true)
        .catch(() => false);
      if (branchExists) {
        await this.execGit(["worktree", "add", "--force", spec.workspacePath, spec.branchName], { gitDir: this.bareDir });
      } else {
        const baseHash = await this.resolveCommit(spec.baseHash);
        await this.execGit(["worktree", "add", "--force", "-b", spec.branchName, spec.workspacePath, baseHash], { gitDir: this.bareDir });
      }
      this.invalidateGraph();
    }
    await this.configureWorktreeIdentity(spec.workspacePath);
    return {
      workspaceId: spec.workspaceId,
      baseHash: spec.baseHash,
      branchName: spec.branchName,
      path: spec.workspacePath,
    };
  }

  async removeWorkspace(workspacePath: string): Promise<void> {
    await this.ensureReady();
    if (!fs.existsSync(workspacePath)) return;
    if (!await this.hasLiveWorktreeMetadata(workspacePath)) {
      await this.removeWorkspaceDirectory(workspacePath);
      await this.execGit(["worktree", "prune"], { gitDir: this.bareDir }).catch(() => undefined);
      this.invalidateGraph();
      return;
    }
    await this.execGit(["worktree", "remove", "--force", workspacePath], { gitDir: this.bareDir });
    this.invalidateGraph();
  }

  async resetWorkspace(workspacePath: string, baseHash: string): Promise<HubWorktreeStatus> {
    await this.syncFromSource();
    if (!fs.existsSync(workspacePath)) {
      throw new HubGitError(404, "workspace path is missing");
    }
    if (!await this.hasLiveWorktreeMetadata(workspacePath)) {
      throw new HubGitError(404, "workspace path is missing");
    }
    const resolvedBase = await this.resolveCommit(baseHash);
    const mergeHead = clean(await this.execGit(["rev-parse", "--verify", "-q", "MERGE_HEAD"], { cwd: workspacePath }).catch(() => ""));
    if (mergeHead) {
      await this.execGit(["merge", "--abort"], { cwd: workspacePath });
    }
    await this.execGit(["reset", "--hard", resolvedBase], { cwd: workspacePath });
    await this.execGit(["clean", "-fd", "-e", ".receipt/"], { cwd: workspacePath }).catch(() => undefined);
    return this.worktreeStatus(workspacePath);
  }

  async worktreeStatus(workspacePath: string): Promise<HubWorktreeStatus> {
    await this.ensureReady();
    if (!fs.existsSync(workspacePath)) {
      return { exists: false, dirty: false };
    }
    if (!await this.hasLiveWorktreeMetadata(workspacePath)) {
      return { exists: false, dirty: false };
    }
    const dirtyRaw = await this.execGit(["status", "--porcelain=v1", "--", ".", ":(exclude).receipt"], { cwd: workspacePath });
    const head = clean(await this.execGit(["rev-parse", "HEAD"], { cwd: workspacePath }).catch(() => ""));
    const branch = clean(await this.execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspacePath }).catch(() => ""));
    return {
      exists: true,
      dirty: dirtyRaw.trim().length > 0,
      head: head || undefined,
      branch: branch || undefined,
    };
  }

  async commitWorkspace(workspacePath: string, message: string): Promise<HubWorkspaceCommit> {
    await this.ensureReady();
    const status = await this.worktreeStatus(workspacePath);
    if (!status.exists) throw new HubGitError(404, "workspace path is missing");
    if (!status.dirty) throw new HubGitError(409, "workspace has no tracked changes");
    await this.execGit(["add", "-A", "--", ".", ":(exclude).receipt"], { cwd: workspacePath });
    await this.execGit(["commit", "-m", message], { cwd: workspacePath });
    const head = clean(await this.execGit(["rev-parse", "HEAD"], { cwd: workspacePath }));
    if (!head) throw new HubGitError(500, "unable to resolve workspace HEAD after commit");
    this.invalidateGraph();
    return {
      hash: head,
      branch: clean(await this.execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspacePath }).catch(() => "")) || undefined,
    };
  }

  async ensureIntegrationWorkspace(
    objectiveId: string,
    baseHash: string,
    opts?: { readonly resetToBase?: boolean },
  ): Promise<HubGitWorkspace> {
    await this.syncFromSource();
    await this.ensureWorktreesDirReady();
    const workspaceId = `factory_integration_${safeBranchPart(objectiveId)}`;
    const workspacePath = path.join(this.worktreesDir, workspaceId);
    const branchName = `hub/integration/${workspaceId}`;
    if (fs.existsSync(workspacePath) && await this.hasLiveWorktreeMetadata(workspacePath)) {
      if (opts?.resetToBase) {
        const resolvedBase = await this.resolveCommit(baseHash);
        await this.execGit(["merge", "--abort"], { cwd: workspacePath }).catch(() => undefined);
        await this.execGit(["reset", "--hard", resolvedBase], { cwd: workspacePath });
        await this.execGit(["clean", "-fd", "-e", ".receipt/"], { cwd: workspacePath }).catch(() => undefined);
      }
      await this.configureWorktreeIdentity(workspacePath);
      return {
        workspaceId,
        baseHash,
        branchName,
        path: workspacePath,
      };
    }
    return this.restoreWorkspace({
      workspaceId,
      branchName,
      workspacePath,
      baseHash,
    });
  }

  async mergeCommitIntoWorkspace(workspacePath: string, commitHash: string, message: string): Promise<HubWorkspaceCommit> {
    await this.ensureReady();
    const status = await this.worktreeStatus(workspacePath);
    if (!status.exists) throw new HubGitError(404, "workspace path is missing");
    const resolved = await this.resolveCommit(commitHash);
    try {
      await this.execGit(["merge", "--no-ff", "-m", message, resolved], { cwd: workspacePath });
    } catch (err) {
      await this.execGit(["merge", "--abort"], { cwd: workspacePath }).catch(() => undefined);
      const messageText = err instanceof Error ? err.message : String(err);
      throw new HubGitError(409, `unable to merge ${shortCommit(resolved)} into workspace: ${messageText}`);
    }
    const head = clean(await this.execGit(["rev-parse", "HEAD"], { cwd: workspacePath }).catch(() => ""));
    if (!head) throw new HubGitError(500, "unable to resolve workspace HEAD after merge");
    this.invalidateGraph();
    return {
      hash: head,
      branch: clean(await this.execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspacePath }).catch(() => "")) || undefined,
    };
  }

  async promoteCommit(commitHash: string): Promise<HubSourcePromotion> {
    await this.ensureReady();
    const source = await this.sourceStatus();
    const previousHead = source.head;
    if (!previousHead) {
      throw new HubGitError(503, "source repository has no HEAD commit");
    }
    const targetBranch = source.branch || await this.defaultBranch();
    const resolved = await this.resolveCommit(commitHash);
    const commitMessage = await this.commitSubject(resolved);
    if (resolved === previousHead) {
      return {
        targetBranch,
        previousHead,
        mergedHead: previousHead,
      };
    }
    if (source.dirty) {
      await this.execGit(["fetch", "--no-tags", this.bareDir, resolved], { cwd: this.repoRoot });
      const touchedFiles = await this.diffTouchedFiles(previousHead, resolved);
      const overlappingFiles = touchedFiles.filter((file) => source.changedFiles.includes(file));
      if (overlappingFiles.length > 0) {
        if (!await this.workingTreeMatchesFetchedCommit(touchedFiles)) {
          throw new HubGitError(
            409,
            `source repository has uncommitted changes overlapping promoted files: ${overlappingFiles.slice(0, 8).join(", ")}`
          );
        }
        const mergedHead = await this.commitSelectedPaths(commitMessage, touchedFiles);
        await this.syncFromSource();
        return {
          targetBranch,
          previousHead,
          mergedHead,
        };
      }
      if (!await this.isAncestor(previousHead, resolved)) {
        throw new HubGitError(
          409,
          `source repository has uncommitted changes and ${shortCommit(resolved)} is not a descendant of ${shortCommit(previousHead)}`
        );
      }
      return this.promoteDirtyDisjointCommit({
        targetBranch,
        previousHead,
        resolved,
        touchedFiles,
        commitMessage,
      });
    }
    try {
      await this.execGit(["fetch", "--no-tags", this.bareDir, resolved], { cwd: this.repoRoot });
      await this.execGit(["merge", "--ff-only", "FETCH_HEAD"], { cwd: this.repoRoot });
    } catch (err) {
      const message = err instanceof HubGitError ? err.message : String(err);
      throw new HubGitError(
        409,
        `unable to fast-forward ${targetBranch} to ${shortCommit(resolved)}: ${message}`
      );
    }
    const mergedHead = clean(await this.execGit(["rev-parse", "HEAD"], { cwd: this.repoRoot }).catch(() => ""));
    if (!mergedHead) {
      throw new HubGitError(500, "unable to resolve source HEAD after merge");
    }
    await this.syncFromSource();
    return {
      targetBranch,
      previousHead,
      mergedHead,
    };
  }

  private async promoteDirtyDisjointCommit(input: {
    readonly targetBranch: string;
    readonly previousHead: string;
    readonly resolved: string;
    readonly touchedFiles: ReadonlyArray<string>;
    readonly commitMessage: string;
  }): Promise<HubSourcePromotion> {
    const touchedFiles = [...new Set(input.touchedFiles)].sort();
    const patchPath = path.join(this.bareDir, `.receipt-promote-${process.pid}-${Date.now()}.patch`);
    try {
      const patch = await this.execGit(["diff", "--binary", `${input.previousHead}..${input.resolved}`], { gitDir: this.bareDir });
      if (patch.trim()) {
        await fs.promises.writeFile(patchPath, patch, "utf-8");
        await this.execGit(["apply", "--index", "--3way", "--whitespace=nowarn", patchPath], { cwd: this.repoRoot });
        await this.commitSelectedPaths(input.commitMessage, touchedFiles);
      }
      const mergedHead = clean(await this.execGit(["rev-parse", "HEAD"], { cwd: this.repoRoot }).catch(() => ""));
      if (!mergedHead) {
        throw new HubGitError(500, "unable to resolve source HEAD after patch promotion");
      }
      await this.syncFromSource();
      return {
        targetBranch: input.targetBranch,
        previousHead: input.previousHead,
        mergedHead,
      };
    } catch (err) {
      if (touchedFiles.length > 0) {
        await this.execGit(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...touchedFiles], { cwd: this.repoRoot })
          .catch(() => undefined);
      }
      const message = err instanceof HubGitError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      throw new HubGitError(409, `unable to promote ${shortCommit(input.resolved)} into dirty source workspace: ${message}`);
    } finally {
      await fs.promises.unlink(patchPath).catch(() => undefined);
    }
  }

  private async prepare(): Promise<void> {
    const gitOk = await this.execBare(["--version"]).then(() => true).catch(() => false);
    if (!gitOk) throw new HubGitError(503, "git is not available on PATH");

    const isRepo = await this.execGit(["rev-parse", "--show-toplevel"], { cwd: this.repoRoot })
      .then(() => true)
      .catch(() => false);
    if (!isRepo) {
      throw new HubGitError(503, "HUB_REPO_ROOT is not a git repository");
    }

    await fs.promises.mkdir(path.dirname(this.bareDir), { recursive: true });
    await fs.promises.mkdir(this.worktreesDir, { recursive: true });

    const headFile = path.join(this.bareDir, "HEAD");
    if (!fs.existsSync(headFile)) {
      await this.execBare(["init", "--bare", this.bareDir]);
    }

    await this.ensureRemote();
  }

  private async ensureRemote(): Promise<void> {
    await this.withRemoteConfigLock(async () => {
      const desired = clean(path.resolve(this.repoRoot));
      const desiredCanonical = await canonicalizeRepoPath(desired);
      const current = clean(await this.execGit(["remote", "get-url", this.remoteName], { gitDir: this.bareDir }).catch(() => ""));
      const currentCanonical = current ? await canonicalizeRepoPath(current) : "";
      const currentAccessible = current && !looksLikeRemoteUrl(current)
        ? await pathExists(current)
        : Boolean(current);
      if (!current) {
        await this.execGit(["remote", "add", this.remoteName, desired], { gitDir: this.bareDir }).catch(async (err) => {
          const refreshed = clean(await this.execGit(["remote", "get-url", this.remoteName], { gitDir: this.bareDir }).catch(() => ""));
          if (refreshed) return;
          throw err;
        });
      } else if (current !== desired && (!currentAccessible || currentCanonical !== desiredCanonical)) {
        await this.execGit(["remote", "set-url", this.remoteName, desired], { gitDir: this.bareDir });
      }

      const sourceRemotes = await this.sourceRepoRemotes();
      const desiredByName = new Map(sourceRemotes.map((remote) => [remote.name, remote.url]));
      const bareRemoteNames = parseLines(await this.execGit(["remote"], { gitDir: this.bareDir }).catch(() => ""));

      for (const remoteName of bareRemoteNames) {
        if (remoteName === this.remoteName || desiredByName.has(remoteName)) continue;
        await this.execGit(["remote", "remove", remoteName], { gitDir: this.bareDir }).catch(() => undefined);
      }

      for (const sourceRemote of sourceRemotes) {
        const remoteUrl = clean(await this.execGit(["remote", "get-url", sourceRemote.name], { gitDir: this.bareDir }).catch(() => ""));
        const canonicalRemoteUrl = remoteUrl ? await canonicalizeRepoPath(remoteUrl) : "";
        if (!remoteUrl) {
          await this.execGit(["remote", "add", sourceRemote.name, sourceRemote.url], { gitDir: this.bareDir });
          continue;
        }
        if (remoteUrl === sourceRemote.url || canonicalRemoteUrl === sourceRemote.url) continue;
        await this.execGit(["remote", "set-url", sourceRemote.name, sourceRemote.url], { gitDir: this.bareDir });
      }
    });
  }

  private async sourceRepoRemotes(): Promise<ReadonlyArray<{ readonly name: string; readonly url: string }>> {
    const remoteNames = parseLines(await this.execGit(["remote"], { cwd: this.repoRoot }).catch(() => ""));
    const remotes = await Promise.all(
      remoteNames
        .filter((name) => name !== this.remoteName)
        .map(async (name) => {
          const url = clean(await this.execGit(["remote", "get-url", name], { cwd: this.repoRoot }).catch(() => ""));
          if (!url) return undefined;
          return {
            name,
            url: await canonicalizeRepoPath(url),
          };
        }),
    );
    return remotes.filter((remote): remote is { readonly name: string; readonly url: string } => Boolean(remote));
  }

  private async withRemoteConfigLock<T>(op: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.bareDir, ".receipt-remote.lock");
    for (;;) {
      let handle: fs.promises.FileHandle | undefined;
      try {
        await fs.promises.mkdir(this.bareDir, { recursive: true });
        handle = await fs.promises.open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          startedAt: Date.now(),
          repoRoot: this.repoRoot,
        }));
        try {
          return await op();
        } finally {
          await handle.close().catch(() => undefined);
          await fs.promises.unlink(lockPath).catch(() => undefined);
        }
      } catch (err) {
        await handle?.close().catch(() => undefined);
        if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
          const stale = await fs.promises.stat(lockPath)
            .then((stat) => (Date.now() - stat.mtimeMs) > REMOTE_LOCK_STALE_MS)
            .catch(() => false);
          if (stale) {
            await fs.promises.unlink(lockPath).catch(() => undefined);
            continue;
          }
          await delay(10);
          continue;
        }
        throw err;
      }
    }
  }

  private async requiredSourceHead(): Promise<string> {
    const head = await this.sourceHead();
    if (!head) throw new HubGitError(503, "source repository has no commits");
    return head;
  }

  private sourceFetchRefspec(): string {
    return `+refs/heads/*:refs/remotes/${this.remoteName}/*`;
  }

  private async fetchSourceMirror(): Promise<void> {
    const refspec = this.sourceFetchRefspec();
    try {
      await this.execGit(["fetch", "--prune", this.remoteName, refspec], { gitDir: this.bareDir });
      return;
    } catch (remoteErr) {
      const remoteMessage = remoteErr instanceof Error ? remoteErr.message : String(remoteErr);
      try {
        await this.execGit(["fetch", "--prune", this.repoRoot, refspec], { gitDir: this.bareDir });
        return;
      } catch (repoRootErr) {
        const repoRootMessage = repoRootErr instanceof Error ? repoRootErr.message : String(repoRootErr);
        throw new HubGitError(
          500,
          `unable to sync source mirror via remote '${this.remoteName}' or repoRoot '${this.repoRoot}': ${remoteMessage}; ${repoRootMessage}`,
        );
      }
    }
  }

  private async graphKey(): Promise<string> {
    const refs = await this.execGit(
      ["for-each-ref", `--format=%(refname)${FIELD_SEP}%(objectname)`, "refs/heads", `refs/remotes/${this.remoteName}`],
      { gitDir: this.bareDir }
    );
    return `${await this.defaultBranch()}\n${refs}`;
  }

  private async touchedFiles(hash: string): Promise<ReadonlyArray<string>> {
    const raw = await this.execGit(
      ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", hash],
      { gitDir: this.bareDir }
    );
    return parseTouchedFiles(raw);
  }

  private async diffTouchedFiles(hashA: string, hashB: string): Promise<ReadonlyArray<string>> {
    const raw = await this.execGit(
      ["diff", "--name-only", hashA, hashB],
      { gitDir: this.bareDir }
    );
    return parseTouchedFiles(raw);
  }

  private async workingTreeMatchesFetchedCommit(paths: ReadonlyArray<string>): Promise<boolean> {
    if (paths.length === 0) return true;
    const raw = await this.execGit(
      ["diff", "--name-only", "FETCH_HEAD", "--", ...paths],
      { cwd: this.repoRoot }
    );
    return parseTouchedFiles(raw).length === 0;
  }

  private async commitSubject(hash: string): Promise<string> {
    const subject = clean(await this.execGit(["show", "-s", "--format=%s", hash], { gitDir: this.bareDir }).catch(() => ""));
    return subject || `Factory promote ${shortCommit(hash)}`;
  }

  private async isAncestor(baseHash: string, headHash: string): Promise<boolean> {
    try {
      await this.execGit(["merge-base", "--is-ancestor", baseHash, headHash], { gitDir: this.bareDir });
      return true;
    } catch {
      return false;
    }
  }

  private async commitSelectedPaths(message: string, paths: ReadonlyArray<string>): Promise<string> {
    if (paths.length > 0) {
      await this.execGit(["add", "--", ...paths], { cwd: this.repoRoot });
      await this.execGit(["commit", "-m", message, "--", ...paths], { cwd: this.repoRoot });
    }
    const mergedHead = clean(await this.execGit(["rev-parse", "HEAD"], { cwd: this.repoRoot }).catch(() => ""));
    if (!mergedHead) {
      throw new HubGitError(500, "unable to resolve source HEAD after path-limited commit");
    }
    return mergedHead;
  }

  private async configureWorktreeIdentity(workspacePath: string): Promise<void> {
    const userName = clean(await this.execGit(["config", "--get", "user.name"], { cwd: this.repoRoot }).catch(() => "Receipt Hub"));
    const userEmail = clean(await this.execGit(["config", "--get", "user.email"], { cwd: this.repoRoot }).catch(() => "hub@local"));
    await this.execGit(["config", "user.name", userName || "Receipt Hub"], { cwd: workspacePath });
    await this.execGit(["config", "user.email", userEmail || "hub@local"], { cwd: workspacePath });
    await this.ensureWorktreeExclude(workspacePath);
  }

  private async resolveWorkspaceGitDir(workspacePath: string): Promise<string | undefined> {
    const gitPath = path.join(workspacePath, ".git");
    const stat = await fs.promises.stat(gitPath).catch(() => undefined);
    if (!stat) return undefined;
    if (stat.isDirectory()) return gitPath;
    if (!stat.isFile()) return undefined;
    const gitMeta = await fs.promises.readFile(gitPath, "utf-8").catch(() => "");
    const gitDirMatch = gitMeta.match(/^gitdir:\s*(.+)$/im);
    return gitDirMatch ? path.resolve(workspacePath, gitDirMatch[1].trim()) : undefined;
  }

  private async hasLiveWorktreeMetadata(workspacePath: string): Promise<boolean> {
    const gitDir = await this.resolveWorkspaceGitDir(workspacePath);
    return gitDir ? pathExists(gitDir) : false;
  }

  private async removeWorkspaceDirectory(workspacePath: string): Promise<void> {
    await fs.promises.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  }

  private async ensureWorktreeExclude(workspacePath: string): Promise<void> {
    const gitMeta = await fs.promises.readFile(path.join(workspacePath, ".git"), "utf-8").catch(() => "");
    const gitDirMatch = gitMeta.match(/^gitdir:\s*(.+)$/im);
    const gitDir = gitDirMatch
      ? path.resolve(workspacePath, gitDirMatch[1].trim())
      : path.join(workspacePath, ".git");
    const excludePath = path.join(gitDir, "info", "exclude");
    const markers = [".receipt/", "node_modules"];
    let current = "";
    try {
      current = await fs.promises.readFile(excludePath, "utf-8");
    } catch {
      current = "";
    }
    const lines = current.split(/\r?\n/).map((line) => line.trim());
    const missing = markers.filter((marker) => !lines.includes(marker));
    if (missing.length === 0) return;
    const next = current.trimEnd();
    const suffix = `${missing.join("\n")}\n`;
    const body = next ? `${next}\n${suffix}` : suffix;
    await fs.promises.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.promises.writeFile(excludePath, body, "utf-8");
  }

  private async execBare(args: ReadonlyArray<string>): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("git command timed out")), 60_000);
    try {
      const result = await execFileAsync("git", [...args], {
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
        signal: ac.signal,
      });
      return result.stdout;
    } finally {
      clearTimeout(timer);
    }
  }

  private async execGit(
    args: ReadonlyArray<string>,
    opts: { readonly cwd?: string; readonly gitDir?: string; readonly timeoutMs?: number }
  ): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("git command timed out")), opts.timeoutMs ?? 60_000);
    try {
      if (args[0] === "merge") console.log(`execGit merge starting in ${opts.cwd}...`);
      const result = await execFileAsync(
        "git",
        [...args],
        {
          cwd: opts.cwd,
          env: opts.gitDir ? { ...process.env, GIT_DIR: opts.gitDir } : process.env,
          encoding: "utf-8",
          maxBuffer: 16 * 1024 * 1024,
          signal: ac.signal,
        }
      );
      if (args[0] === "merge") console.log(`execGit merge finished`);
      return result.stdout;
    } catch (err) {
      if (args[0] === "merge") console.log(`execGit merge threw error:`, err);
      const message = err instanceof Error && "stderr" in err
        ? String((err as Error & { stderr?: string }).stderr ?? err.message).trim()
        : err instanceof Error
          ? err.message
          : String(err);
      throw new HubGitError(500, message || "git command failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

const shortCommit = (value: string): string => value.slice(0, 8);
