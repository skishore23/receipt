import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import type { JsonlQueue, QueueJob } from "../../../adapters/jsonl-queue";
import type { MemoryTools } from "../../../adapters/memory-tools";
import type { FactoryService, FactoryObjectiveReceiptSummary } from "../../../services/factory-service";
import type {
  FactoryChatContextImports,
  FactoryChatContextProjection,
} from "../chat-context";
import { syncChatContextProjectionStream, readChatContextProjection } from "../../../db/projectors";
import { buildFactoryQueueJobSnapshot } from "../../../views/factory/job-presenters";
import { isActiveJobStatus } from "../../orchestration-utils";
import { resolveProfileMemorySummary } from "./memory";

const execFileAsync = promisify(execFile);

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export const asStringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];

export const chatIdFromFactoryStream = (stream: string | undefined): string | undefined => {
  const value = stream?.trim();
  if (!value) return undefined;
  const marker = "/sessions/";
  const index = value.lastIndexOf(marker);
  if (index < 0) return undefined;
  const encoded = value.slice(index + marker.length).trim();
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
};

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const nextId = (prefix: string): string =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const parseContinuationDepth = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Math.floor(value), 16))
    : 0;

const FACTORY_CHAT_ITERATION_LADDER = [8, 12, 16, 24, 32, 40] as const;

export const nextIterationBudget = (current: number): number | undefined =>
  FACTORY_CHAT_ITERATION_LADDER.find((candidate) => candidate > current);

export const stableCodexSessionKey = (runId: string, prompt: string): string =>
  `codex:${runId}:${createHash("sha1").update(prompt).digest("hex").slice(0, 12)}`;

export const repoMemoryScope = (repoKey: string): string => `repos/${repoKey}`;
export const profileMemoryScope = (repoKey: string, profileId: string): string => `repos/${repoKey}/profiles/${profileId}`;
export const objectiveMemoryScope = (repoKey: string, profileId: string, objectiveId: string): string =>
  `${profileMemoryScope(repoKey, profileId)}/objectives/${objectiveId}`;
export const workerMemoryScope = (repoKey: string, worker: string): string => `repos/${repoKey}/subagents/${worker}`;

export const toolSummary = (worker: string, status: string, summary: string): string =>
  `${worker} ${status}: ${summary}`;

export const summarizeChildProgress = (input: {
  readonly lastMessage?: string;
  readonly stderrTail?: string;
  readonly stdoutTail?: string;
}): string => (
  asString(input.lastMessage)
  ?? asString(input.stderrTail)
  ?? asString(input.stdoutTail)
  ?? "Child work is running."
);

export const normalizeJobSnapshot = (job: QueueJob): Record<string, unknown> => {
  const base = buildFactoryQueueJobSnapshot(job);
  const result = asRecord(job.result);
  return {
    ...base,
    profileId: asString(job.payload.profileId),
    delegatedTo: asString(result?.delegatedTo) ?? asString(job.payload.delegatedTo),
    objectiveId: asString(result?.objectiveId) ?? asString(job.payload.objectiveId),
    mode: asString(result?.mode) ?? asString(job.payload.mode),
    readOnly: result?.readOnly === true || job.payload.readOnly === true,
  };
};

export const listChildJobsForRun = async (queue: JsonlQueue, runId: string): Promise<ReadonlyArray<QueueJob>> => {
  const jobs = await queue.listJobs({ limit: 200 });
  return jobs.filter((job) => asString(job.payload.parentRunId) === runId);
};

export const jobMatchesProfileContext = (
  job: QueueJob,
  input: {
    readonly runId?: string;
    readonly stream: string;
    readonly profileId: string;
    readonly objectiveId?: string;
  },
): boolean => {
  const parentRunId = asString(job.payload.parentRunId);
  const parentStream = asString(job.payload.parentStream);
  const payloadStream = asString(job.payload.stream);
  const profileId = asString(job.payload.profileId);
  const objectiveId = asString(job.payload.objectiveId);
  return parentRunId === input.runId
    || parentStream === input.stream
    || payloadStream === input.stream
    || profileId === input.profileId
    || (Boolean(input.objectiveId) && objectiveId === input.objectiveId);
};

export const latestActiveCodexJob = async (queue: JsonlQueue, input: {
  readonly runId: string;
  readonly stream: string;
  readonly profileId: string;
  readonly objectiveId?: string;
}): Promise<QueueJob | undefined> =>
  (await queue.listJobs({ limit: 200 }))
    .filter((job) => job.agentId === "codex" && isActiveJobStatus(job.status))
    .filter((job) => jobMatchesProfileContext(job, input))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];

export const codexJobPriority = (
  job: QueueJob,
  input: {
    readonly runId: string;
    readonly objectiveId?: string;
  },
): number => {
  if (asString(job.payload.parentRunId) === input.runId) return 3;
  if (input.objectiveId && asString(job.payload.objectiveId) === input.objectiveId) return 2;
  return isActiveJobStatus(job.status) ? 1 : 0;
};

export const summarizeObjectiveReceipts = (receipts: ReadonlyArray<FactoryObjectiveReceiptSummary>, limit = 5): ReadonlyArray<string> =>
  receipts.slice(-Math.max(1, limit)).map((receipt) => `- ${receipt.type}: ${receipt.summary}`);

export const reusableInfrastructureRefs = (
  sharedArtifactRefs: ReadonlyArray<{ readonly ref: string; readonly label?: string }> | undefined,
): {
  readonly scripts: ReadonlyArray<string>;
  readonly knowledge: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
} => {
  const refs = Array.isArray(sharedArtifactRefs) ? sharedArtifactRefs : [];
  const collect = (labelFragment: string): ReadonlyArray<string> => {
    const seen = new Set<string>();
    const values: string[] = [];
    for (const ref of refs) {
      const label = ref.label?.trim().toLowerCase() ?? "";
      const target = ref.ref?.trim();
      if (!target || !label.includes(labelFragment) || seen.has(target)) continue;
      seen.add(target);
      values.push(target);
    }
    return values;
  };
  return {
    scripts: collect("checked-in helper entrypoint"),
    knowledge: collect("checked-in helper manifest"),
    evidence: collect("helper runner"),
  };
};

export const loadProjectedChatContext = async (input: {
  readonly dataDir?: string;
  readonly sessionStream: string;
}): Promise<FactoryChatContextProjection | undefined> => {
  if (!input.dataDir) return undefined;
  await syncChatContextProjectionStream(input.dataDir, input.sessionStream);
  return readChatContextProjection(input.dataDir, input.sessionStream);
};

export const buildFactoryChatContextImports = async (input: {
  readonly memoryTools: MemoryTools;
  readonly repoKey: string;
  readonly profileId: string;
  readonly primaryScope: string;
  readonly primarySummary: string;
  readonly query: string;
  readonly runId: string;
  readonly iteration: number;
  readonly objectiveId?: string;
  readonly queue: JsonlQueue;
  readonly stream: string;
  readonly factoryService: FactoryService;
}): Promise<FactoryChatContextImports> => {
  const profileMemorySummary = await resolveProfileMemorySummary({
    memoryTools: input.memoryTools,
    repoKey: input.repoKey,
    profileId: input.profileId,
    primaryScope: input.primaryScope,
    primarySummary: input.primarySummary,
    query: input.query,
    runId: input.runId,
    iteration: input.iteration,
  });
  const baseImports: FactoryChatContextImports = {
    ...(profileMemorySummary ? { profileMemorySummary } : {}),
  };
  if (input.objectiveId) {
    try {
      const [detail, debug] = await Promise.all([
        input.factoryService.getObjective(input.objectiveId),
        input.factoryService.getObjectiveDebug(input.objectiveId).catch(() => undefined),
      ]);
      const activeJobs = debug?.activeJobs ?? [];
      return {
        ...baseImports,
        objective: {
          objectiveId: detail.objectiveId,
          title: detail.title,
          status: detail.status,
          phase: detail.phase,
          summary: detail.blockedExplanation?.summary
            ?? detail.latestDecision?.summary
            ?? detail.latestSummary
            ?? detail.nextAction
            ?? `${detail.title} is ${detail.status}.`,
          importedBecause: "bound",
        },
        runtime: {
          summary: activeJobs.length > 0
            ? `${activeJobs.length} active job${activeJobs.length === 1 ? "" : "s"}: ${activeJobs.slice(0, 3).map((job) => `${job.id} ${job.agentId} ${job.status}`).join(", ")}`
            : detail.latestSummary
              ?? detail.nextAction
              ?? `${detail.title} is ${detail.status}.`,
          objectiveId: detail.objectiveId,
          active: activeJobs.length > 0,
          importedBecause: "bound",
        },
      };
    } catch {
      return baseImports;
    }
  }
  const activeChildren = (await listChildJobsForRun(input.queue, input.runId))
    .filter((job) => isActiveJobStatus(job.status))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const activeChild = activeChildren[0];
  if (activeChild) {
    return {
      ...baseImports,
      runtime: {
        summary: summarizeChildProgress({
          lastMessage: asString(asRecord(activeChild.result)?.lastMessage),
          stderrTail: asString(asRecord(activeChild.result)?.stderrTail),
          stdoutTail: asString(asRecord(activeChild.result)?.stdoutTail),
        }),
        active: true,
        importedBecause: "live_work",
        focusKind: "job",
        focusId: activeChild.id,
      },
    };
  }
  return baseImports;
};

const tail = (value: string | undefined, max = 400): string | undefined => {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
};

type GitChangedFileEntry = {
  readonly path: string;
  readonly status: string;
  readonly previousPath?: string;
};

type GitChangedFileSnapshotEntry = {
  readonly status: string;
  readonly fingerprint?: string;
};

const gitStatusEntries = async (repoRoot: string): Promise<ReadonlyArray<GitChangedFileEntry>> => {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=1", "-z", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const tokens = stdout.split("\u0000");
    const entries: GitChangedFileEntry[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) continue;
      const status = token.slice(0, 2);
      const filePath = token.slice(3);
      if (!status || !filePath) continue;
      const previousPath = status.includes("R") || status.includes("C")
        ? tokens[index + 1] || undefined
        : undefined;
      entries.push(previousPath ? { path: filePath, status, previousPath } : { path: filePath, status });
      if (previousPath) index += 1;
    }
    return entries;
  } catch {
    return [];
  }
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const copyPathPreservingType = async (sourcePath: string, targetPath: string): Promise<void> => {
  const stat = await fs.lstat(sourcePath);
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(sourcePath);
    await fs.symlink(linkTarget, targetPath);
    return;
  }
  if (stat.isDirectory()) {
    await fs.cp(sourcePath, targetPath, { recursive: true, dereference: false });
    return;
  }
  await fs.copyFile(sourcePath, targetPath);
};

const ensureProbeWorkspaceNodeModulesLink = async (sourceRoot: string, workspacePath: string): Promise<void> => {
  const sourceNodeModulesPath = path.join(sourceRoot, "node_modules");
  const workspaceNodeModulesPath = path.join(workspacePath, "node_modules");
  if (!(await pathExists(sourceNodeModulesPath)) || await pathExists(workspaceNodeModulesPath)) return;
  await fs.symlink(
    sourceNodeModulesPath,
    workspaceNodeModulesPath,
    process.platform === "win32" ? "junction" : "dir",
  ).catch(() => undefined);
};

const mirrorDirtyGitStateToWorkspace = async (sourceRoot: string, workspacePath: string): Promise<void> => {
  const entries = await gitStatusEntries(sourceRoot);
  for (const entry of entries) {
    if (entry.previousPath && entry.previousPath !== entry.path) {
      await fs.rm(path.join(workspacePath, entry.previousPath), { recursive: true, force: true }).catch(() => undefined);
    }
    const sourcePath = path.join(sourceRoot, entry.path);
    const targetPath = path.join(workspacePath, entry.path);
    const sourceExists = await pathExists(sourcePath);
    if (!sourceExists || entry.status.includes("D")) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    await copyPathPreservingType(sourcePath, targetPath);
  }
};

export type DisposableProbeWorkspace = {
  readonly workspacePath: string;
  readonly cleanup: () => Promise<void>;
};

export const createDisposableProbeWorkspace = async (
  repoRoot: string,
  jobId: string,
): Promise<DisposableProbeWorkspace> => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `receipt-direct-probe-${jobId}-`));
  const workspacePath = path.join(tempRoot, "workspace");
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    await execFileAsync("git", ["worktree", "add", "--detach", workspacePath, "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    await ensureProbeWorkspaceNodeModulesLink(repoRoot, workspacePath);
    await mirrorDirtyGitStateToWorkspace(repoRoot, workspacePath);
    return {
      workspacePath,
      cleanup: async () => {
        await execFileAsync("git", ["worktree", "remove", "--force", workspacePath], {
          cwd: repoRoot,
          encoding: "utf-8",
          maxBuffer: 4 * 1024 * 1024,
        }).catch(() => undefined);
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch {
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    await fs.cp(repoRoot, workspacePath, { recursive: true, dereference: false });
    return {
      workspacePath,
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }
};

const gitWorkingTreeFingerprint = async (repoRoot: string, filePath: string): Promise<string | undefined> => {
  try {
    const absolutePath = path.join(repoRoot, filePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) return `symlink:${await fs.readlink(absolutePath)}`;
    if (stat.isDirectory()) return `dir:${stat.mtimeMs}:${stat.size}`;
    const content = await fs.readFile(absolutePath);
    return createHash("sha1").update(content).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
};

const gitChangedFileSnapshot = async (
  repoRoot: string,
): Promise<ReadonlyMap<string, GitChangedFileSnapshotEntry>> => {
  const entries = await gitStatusEntries(repoRoot);
  const snapshots = await Promise.all(entries.map(async ({ path: filePath, status }) => (
    [filePath, { status, fingerprint: await gitWorkingTreeFingerprint(repoRoot, filePath) }] as const
  )));
  return new Map(snapshots);
};

const diffGitChangedFileSnapshots = (
  before: ReadonlyMap<string, GitChangedFileSnapshotEntry>,
  after: ReadonlyMap<string, GitChangedFileSnapshotEntry>,
): ReadonlyArray<string> => {
  const changed = new Set<string>();
  for (const filePath of before.keys()) {
    const previous = before.get(filePath);
    const current = after.get(filePath);
    if (!current || previous?.status !== current.status || previous?.fingerprint !== current.fingerprint) {
      changed.add(filePath);
    }
  }
  for (const filePath of after.keys()) {
    const previous = before.get(filePath);
    const current = after.get(filePath);
    if (!previous || previous.status !== current?.status || previous.fingerprint !== current?.fingerprint) {
      changed.add(filePath);
    }
  }
  return [...changed].sort((left, right) => left.localeCompare(right));
};

export const gitChangedFiles = async (repoRoot: string): Promise<ReadonlyArray<string>> => {
  const entries = await gitStatusEntries(repoRoot);
  return entries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
};

export const gitChangedFileSnapshots = async (repoRoot: string): Promise<ReadonlyMap<string, GitChangedFileSnapshotEntry>> =>
  gitChangedFileSnapshot(repoRoot);

export const diffGitChangedSnapshots = (
  before: ReadonlyMap<string, GitChangedFileSnapshotEntry>,
  after: ReadonlyMap<string, GitChangedFileSnapshotEntry>,
): ReadonlyArray<string> =>
  diffGitChangedFileSnapshots(before, after);
