import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { bunWhich, resolveBunRuntime } from "../lib/runtime-paths";

const execFileAsync = promisify(execFile);

type DoctorBinaryStatus = {
  readonly ok: boolean;
  readonly path?: string;
  readonly source: "override" | "runtime" | "lookup";
  readonly version?: string;
  readonly error?: string;
};

type DoctorRemote = {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
};

type DoctorAuthStatus = {
  readonly ok: boolean;
  readonly summary?: string;
  readonly error?: string;
};

type DoctorAwsAuthStatus = DoctorAuthStatus & {
  readonly accountId?: string;
  readonly arn?: string;
  readonly userId?: string;
};

export type ReceiptDoctorReport = {
  readonly ok: boolean;
  readonly cwd: string;
  readonly requestedRepoRoot: string;
  readonly dataDir: string;
  readonly configPath?: string;
  readonly configPresent: boolean;
  readonly openAiApiKey: {
    readonly present: boolean;
  };
  readonly binaries: {
    readonly bun: DoctorBinaryStatus;
    readonly git: DoctorBinaryStatus;
    readonly gh: DoctorBinaryStatus;
    readonly aws: DoctorBinaryStatus;
    readonly codex: DoctorBinaryStatus;
  };
  readonly repo: {
    readonly ok: boolean;
    readonly root?: string;
    readonly branch?: string;
    readonly dirty?: boolean;
    readonly changedCount?: number;
    readonly remotes: ReadonlyArray<DoctorRemote>;
    readonly error?: string;
  };
  readonly auth: {
    readonly github: DoctorAuthStatus;
    readonly aws: DoctorAwsAuthStatus;
  };
  readonly blockingIssues: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};

type CommandRunResult = {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

const trim = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const firstNonEmptyLine = (value: string): string | undefined =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

const pathExists = async (targetPath: string): Promise<boolean> =>
  fs.access(targetPath).then(() => true).catch(() => false);

const runCommand = async (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
): Promise<CommandRunResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd,
      encoding: "utf-8",
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      ok: true,
      exitCode: 0,
      stdout,
      stderr,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      readonly code?: string | number;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      ok: false,
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : "",
      error: err.message ?? String(error),
    };
  }
};

const lookupCommand = async (command: string): Promise<string | undefined> => {
  const bunResolved = bunWhich(command);
  if (bunResolved) return bunResolved;
  const lookup = await runCommand(process.platform === "win32" ? "where" : "which", [command]);
  return lookup.ok ? trim(firstNonEmptyLine(lookup.stdout)) : undefined;
};

const resolveBinaryStatus = async (input: {
  readonly name: string;
  readonly overrideEnvName?: string;
  readonly runtimePath?: string;
  readonly versionArgs?: ReadonlyArray<string>;
}): Promise<DoctorBinaryStatus> => {
  const override = input.overrideEnvName ? trim(process.env[input.overrideEnvName]) : undefined;
  const commandPath = override ?? input.runtimePath ?? await lookupCommand(input.name);
  const source = override
    ? "override"
    : input.runtimePath
      ? "runtime"
      : "lookup";
  if (!commandPath) {
    return {
      ok: false,
      source,
      error: `${input.name} not found`,
    };
  }
  if ((path.isAbsolute(commandPath) || commandPath.includes(path.sep)) && !await pathExists(commandPath)) {
    return {
      ok: false,
      path: commandPath,
      source,
      error: `${commandPath} does not exist`,
    };
  }
  const versionResult = await runCommand(commandPath, input.versionArgs ?? ["--version"]);
  const version = trim(firstNonEmptyLine(`${versionResult.stdout}\n${versionResult.stderr}`));
  return {
    ok: versionResult.ok,
    path: commandPath,
    source,
    version,
    error: versionResult.ok ? undefined : (version ?? versionResult.error ?? `${input.name} probe failed`),
  };
};

const parseRemotes = (raw: string): ReadonlyArray<DoctorRemote> => {
  const remotes = new Map<string, { name: string; fetchUrl?: string; pushUrl?: string }>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    const current = remotes.get(name) ?? { name };
    if (kind === "fetch") current.fetchUrl = url;
    else current.pushUrl = url;
    remotes.set(name, current);
  }
  return [...remotes.values()];
};

const readFactoryConfig = async (repoRoot: string): Promise<{
  readonly configPath?: string;
  readonly configPresent: boolean;
  readonly dataDir?: string;
}> => {
  const configPath = path.join(repoRoot, ".receipt", "config.json");
  if (!await pathExists(configPath)) {
    return {
      configPath,
      configPresent: false,
    };
  }
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = raw.trim()
      ? JSON.parse(raw) as { readonly dataDir?: unknown }
      : {};
    const configuredDataDir = typeof parsed.dataDir === "string" && parsed.dataDir.trim()
      ? path.resolve(repoRoot, parsed.dataDir.trim())
      : undefined;
    return {
      configPath,
      configPresent: true,
      dataDir: configuredDataDir,
    };
  } catch {
    return {
      configPath,
      configPresent: true,
    };
  }
};

export const runReceiptDoctor = async (input: {
  readonly cwd: string;
  readonly requestedRepoRoot: string;
  readonly defaultDataDir: string;
}): Promise<ReceiptDoctorReport> => {
  const [bunStatus, gitStatus, ghStatus, awsStatus, codexStatus] = await Promise.all([
    resolveBinaryStatus({
      name: "bun",
      overrideEnvName: "RECEIPT_BUN_BIN",
      runtimePath: resolveBunRuntime(),
    }),
    resolveBinaryStatus({
      name: "git",
      overrideEnvName: "RECEIPT_GIT_BIN",
    }),
    resolveBinaryStatus({
      name: "gh",
      overrideEnvName: "RECEIPT_GH_BIN",
    }),
    resolveBinaryStatus({
      name: "aws",
      overrideEnvName: "RECEIPT_AWS_BIN",
    }),
    resolveBinaryStatus({
      name: "codex",
      overrideEnvName: "RECEIPT_CODEX_BIN",
    }),
  ]);

  let detectedRepoRoot: string | undefined;
  let repoError: string | undefined;
  let branch: string | undefined;
  let dirty: boolean | undefined;
  let changedCount: number | undefined;
  let remotes: ReadonlyArray<DoctorRemote> = [];

  if (!gitStatus.ok || !gitStatus.path) {
    repoError = gitStatus.error ?? "git unavailable";
  } else {
    const repoRootResult = await runCommand(gitStatus.path, ["-C", input.requestedRepoRoot, "rev-parse", "--show-toplevel"]);
    if (!repoRootResult.ok) {
      repoError = trim(repoRootResult.stderr) ?? trim(repoRootResult.error) ?? `not a git repo: ${input.requestedRepoRoot}`;
    } else {
      detectedRepoRoot = trim(repoRootResult.stdout);
      const [branchResult, statusResult, remotesResult] = await Promise.all([
        runCommand(gitStatus.path, ["-C", detectedRepoRoot!, "rev-parse", "--abbrev-ref", "HEAD"]),
        runCommand(gitStatus.path, ["-C", detectedRepoRoot!, "status", "--porcelain"]),
        runCommand(gitStatus.path, ["-C", detectedRepoRoot!, "remote", "-v"]),
      ]);
      branch = branchResult.ok ? trim(branchResult.stdout) : undefined;
      if (statusResult.ok) {
        const changedLines = statusResult.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
        dirty = changedLines.length > 0;
        changedCount = changedLines.length;
      }
      remotes = remotesResult.ok ? parseRemotes(remotesResult.stdout) : [];
    }
  }

  const repoRootForConfig = detectedRepoRoot ?? path.resolve(input.requestedRepoRoot);
  const config = await readFactoryConfig(repoRootForConfig);
  const dataDir = trim(process.env.RECEIPT_DATA_DIR)
    ?? trim(process.env.DATA_DIR)
    ?? config.dataDir
    ?? (detectedRepoRoot ? path.join(detectedRepoRoot, ".receipt", "data") : input.defaultDataDir);

  let resolvedGithubAuth: DoctorAuthStatus;
  if (!ghStatus.ok || !ghStatus.path) {
    resolvedGithubAuth = {
      ok: false,
      error: ghStatus.error ?? "gh unavailable",
    };
  } else {
    const status = await runCommand(ghStatus.path, ["auth", "status"]);
    const summary = trim(firstNonEmptyLine(`${status.stdout}\n${status.stderr}`));
    resolvedGithubAuth = status.ok
      ? { ok: true, summary: summary ?? "gh auth status ok" }
      : { ok: false, error: summary ?? status.error ?? "gh auth status failed" };
  }

  let resolvedAwsAuth: DoctorAwsAuthStatus;
  if (!awsStatus.ok || !awsStatus.path) {
    resolvedAwsAuth = {
      ok: false,
      error: awsStatus.error ?? "aws unavailable",
    };
  } else {
    const identity = await runCommand(awsStatus.path, ["sts", "get-caller-identity", "--output", "json"]);
    if (!identity.ok) {
      resolvedAwsAuth = {
        ok: false,
        error: trim(identity.stderr) ?? identity.error ?? "aws sts get-caller-identity failed",
      };
    } else {
      try {
        const parsed = JSON.parse(identity.stdout) as {
          readonly Account?: unknown;
          readonly Arn?: unknown;
          readonly UserId?: unknown;
        };
        const accountId = typeof parsed.Account === "string" ? parsed.Account : undefined;
        const arn = typeof parsed.Arn === "string" ? parsed.Arn : undefined;
        const userId = typeof parsed.UserId === "string" ? parsed.UserId : undefined;
        resolvedAwsAuth = {
          ok: true,
          accountId,
          arn,
          userId,
          summary: [accountId, arn].filter(Boolean).join(" "),
        };
      } catch {
        resolvedAwsAuth = {
          ok: false,
          error: "aws sts get-caller-identity returned invalid JSON",
        };
      }
    }
  }

  const blockingIssues = [
    !bunStatus.ok ? `bun unavailable: ${bunStatus.error ?? "missing"}` : undefined,
    !gitStatus.ok ? `git unavailable: ${gitStatus.error ?? "missing"}` : undefined,
    !codexStatus.ok ? `codex unavailable: ${codexStatus.error ?? "missing"}` : undefined,
    !detectedRepoRoot ? `repo invalid: ${repoError ?? "not a git repository"}` : undefined,
    !trim(process.env.OPENAI_API_KEY) ? "OPENAI_API_KEY missing" : undefined,
  ].filter((issue): issue is string => Boolean(issue));

  const warnings = [
    !config.configPresent ? `Factory config missing at ${config.configPath}` : undefined,
    resolvedGithubAuth.ok ? undefined : `GitHub auth unavailable: ${resolvedGithubAuth.error ?? "gh auth status failed"}`,
    resolvedAwsAuth.ok ? undefined : `AWS auth unavailable: ${resolvedAwsAuth.error ?? "aws sts get-caller-identity failed"}`,
  ].filter((issue): issue is string => Boolean(issue));

  return {
    ok: blockingIssues.length === 0,
    cwd: input.cwd,
    requestedRepoRoot: input.requestedRepoRoot,
    dataDir: path.resolve(dataDir),
    configPath: config.configPath,
    configPresent: config.configPresent,
    openAiApiKey: {
      present: Boolean(trim(process.env.OPENAI_API_KEY)),
    },
    binaries: {
      bun: bunStatus,
      git: gitStatus,
      gh: ghStatus,
      aws: awsStatus,
      codex: codexStatus,
    },
    repo: {
      ok: Boolean(detectedRepoRoot),
      root: detectedRepoRoot,
      branch,
      dirty,
      changedCount,
      remotes,
      error: repoError,
    },
    auth: {
      github: resolvedGithubAuth,
      aws: resolvedAwsAuth,
    },
    blockingIssues,
    warnings,
  };
};

export const renderReceiptDoctorText = (report: ReceiptDoctorReport): string => {
  const lines = [
    `doctor: ${report.ok ? "ok" : "blocked"}`,
    `cwd: ${report.cwd}`,
    `repo root: ${report.repo.root ?? report.requestedRepoRoot}`,
    `data dir: ${report.dataDir}`,
    `factory config: ${report.configPresent ? report.configPath ?? "present" : `missing (${report.configPath ?? "unknown"})`}`,
    `OPENAI_API_KEY: ${report.openAiApiKey.present ? "present" : "missing"}`,
    `bun: ${report.binaries.bun.ok ? `${report.binaries.bun.path ?? "bun"}${report.binaries.bun.version ? ` (${report.binaries.bun.version})` : ""}` : report.binaries.bun.error ?? "missing"}`,
    `git: ${report.binaries.git.ok ? `${report.binaries.git.path ?? "git"}${report.binaries.git.version ? ` (${report.binaries.git.version})` : ""}` : report.binaries.git.error ?? "missing"}`,
    `gh: ${report.binaries.gh.ok ? `${report.binaries.gh.path ?? "gh"}${report.auth.github.summary ? ` (${report.auth.github.summary})` : ""}` : report.binaries.gh.error ?? "missing"}`,
    `aws: ${report.binaries.aws.ok ? `${report.binaries.aws.path ?? "aws"}${report.auth.aws.summary ? ` (${report.auth.aws.summary})` : ""}` : report.binaries.aws.error ?? "missing"}`,
    `codex: ${report.binaries.codex.ok ? `${report.binaries.codex.path ?? "codex"}${report.binaries.codex.version ? ` (${report.binaries.codex.version})` : ""}` : report.binaries.codex.error ?? "missing"}`,
    `repo status: ${report.repo.ok ? `${report.repo.branch ?? "HEAD"}${report.repo.dirty ? ` dirty (${report.repo.changedCount ?? 0} changed)` : " clean"}` : report.repo.error ?? "not a git repo"}`,
  ];
  if (report.repo.remotes.length > 0) {
    lines.push(`remotes: ${report.repo.remotes.map((remote) => `${remote.name}=${remote.fetchUrl ?? remote.pushUrl ?? "unknown"}`).join(", ")}`);
  }
  if (report.blockingIssues.length > 0) {
    lines.push("blocking issues:");
    lines.push(...report.blockingIssues.map((issue) => `- ${issue}`));
  }
  if (report.warnings.length > 0) {
    lines.push("warnings:");
    lines.push(...report.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join("\n")}\n`;
};
