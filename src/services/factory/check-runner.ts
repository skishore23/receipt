import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { HubGit } from "../../adapters/hub-git";
import { resolveCliInvocation } from "../../lib/runtime-paths";
import type { FactoryCheckResult, FactoryState, FactoryTaskExecutionMode } from "../../modules/factory";
import { pathExists } from "./artifact-inspection";
import { buildFactoryFailureSignature, priorFactoryFailureSignatureMap } from "./failure-policy";

const execFileAsync = promisify(execFile);
const CHECK_TIMEOUT_MS = 60 * 60 * 1000;
const SHELL_CANDIDATES = [
  (process.env.SHELL ?? "").trim(),
  "/bin/bash",
  "/usr/bin/bash",
  "/bin/sh",
  "/usr/bin/sh",
].filter((value): value is string => value.length > 0);

const safeWorkspacePart = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const prependPath = (dir: string, currentPath: string | undefined): string =>
  currentPath ? `${dir}${path.delimiter}${currentPath}` : dir;

const prependPaths = (entries: ReadonlyArray<string | undefined>, currentPath: string | undefined): string =>
  entries
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .reduceRight<string>((acc, entry) => prependPath(entry, acc), currentPath ?? "");

export const formatShellDiscoveryFailure = (attempted: ReadonlyArray<string>): string =>
  `no executable shell found for factory checks; attempted ${attempted.join(", ")}. Switch to argv mode when possible.`;

export const discoverShell = async (input?: {
  readonly candidates?: ReadonlyArray<string>;
  readonly access?: (candidate: string) => Promise<void>;
}): Promise<{
  readonly shell?: string;
  readonly attempted: ReadonlyArray<string>;
}> => {
  const attempted = [...new Set(input?.candidates ?? SHELL_CANDIDATES)];
  const access = input?.access ?? ((candidate: string) => fs.access(candidate, fsConstants.X_OK));
  for (const candidate of attempted) {
    try {
      await access(candidate);
      return { shell: candidate, attempted };
    } catch {
      // try next candidate
    }
  }
  return { attempted };
};

const runtimeBunPathEntries = (): ReadonlyArray<string> => {
  const candidates = [
    process.env.RECEIPT_BUN_BIN?.trim() ? path.dirname(process.env.RECEIPT_BUN_BIN.trim()) : undefined,
    path.basename(process.execPath || "").toLowerCase().includes("bun") ? path.dirname(process.execPath) : undefined,
    process.env.BUN_INSTALL?.trim() ? path.join(process.env.BUN_INSTALL.trim(), "bin") : undefined,
    process.env.HOME?.trim() ? path.join(process.env.HOME.trim(), ".bun", "bin") : undefined,
  ];
  return [...new Set(candidates.filter((entry): entry is string => Boolean(entry)))];
};

const isPathWithinRoot = (targetPath: string, rootPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

type FactoryWorkspaceGit = Pick<HubGit, "repoRoot" | "worktreesDir" | "worktreeStatus" | "restoreWorkspace" | "removeWorkspace">;

export type FactoryBaselineCheckCache = Map<string, Promise<{
  readonly digest: string;
  readonly excerpt: string;
} | undefined>>;

export const factoryTaskWorkspaceStatus = async (input: {
  readonly workspacePath: string;
  readonly executionMode: FactoryTaskExecutionMode;
  readonly git: Pick<HubGit, "worktreeStatus">;
}): Promise<{ readonly exists: boolean; readonly dirty: boolean; readonly head?: string; readonly branch?: string }> => {
  if (input.executionMode === "isolated") {
    const exists = await fs.access(input.workspacePath).then(() => true).catch(() => false);
    return {
      exists,
      dirty: false,
    };
  }
  return input.git.worktreeStatus(input.workspacePath);
};

const ensureWorkspaceReceiptCli = async (input: {
  readonly workspacePath: string;
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly worktreesDir: string;
}): Promise<string> => {
  const repoReceiptBinDir = path.join(input.workspacePath, ".receipt", "bin");
  const repoShimPath = path.join(repoReceiptBinDir, process.platform === "win32" ? "receipt.cmd" : "receipt");
  if (input.workspacePath === input.repoRoot && await pathExists(repoShimPath)) {
    return repoReceiptBinDir;
  }
  const shimRoot = input.workspacePath === input.repoRoot
    ? path.join(
        input.dataDir,
        "factory",
        "repo-bin",
        createHash("sha1").update(input.workspacePath).digest("hex").slice(0, 12),
      )
    : input.workspacePath;
  const binDir = path.join(shimRoot, ".receipt", "bin");
  const shimPath = path.join(binDir, process.platform === "win32" ? "receipt.cmd" : "receipt");
  await fs.mkdir(binDir, { recursive: true });
  if (process.platform !== "win32" && input.workspacePath !== input.repoRoot) {
    const sourceShimPath = path.join(input.repoRoot, ".receipt", "bin", "receipt");
    if (await pathExists(sourceShimPath)) {
      await fs.copyFile(sourceShimPath, shimPath);
      await fs.chmod(shimPath, 0o755);
      return binDir;
    }
  }
  const { command, args, entryPath } = resolveCliInvocation(import.meta.url);
  const body = process.platform === "win32"
    ? [
        "@echo off",
        `set "DATA_DIR=${input.dataDir}"`,
        `set "RECEIPT_DATA_DIR=${input.dataDir}"`,
        `"${command}" "${entryPath}" %*`,
        "",
      ].join("\r\n")
    : [
        "#!/bin/sh",
        `export DATA_DIR=${shellQuote(input.dataDir)}`,
        `export RECEIPT_DATA_DIR=${shellQuote(input.dataDir)}`,
        `exec ${shellQuote(command)} ${args.map((arg) => shellQuote(arg)).join(" ")} "$@"`,
        "",
      ].join("\n");
  await fs.writeFile(shimPath, body, "utf-8");
  if (process.platform !== "win32") await fs.chmod(shimPath, 0o755);
  return binDir;
};

const ensureWorkspaceDependencyLinks = async (input: {
  readonly workspacePath: string;
  readonly repoRoot: string;
  readonly worktreesDir: string;
}): Promise<void> => {
  if (!isPathWithinRoot(input.workspacePath, input.worktreesDir)) return;
  const sourceNodeModulesPath = path.join(input.repoRoot, "node_modules");
  if (!(await pathExists(sourceNodeModulesPath))) return;
  const workspaceNodeModulesPath = path.join(input.workspacePath, "node_modules");
  const existing = await fs.lstat(workspaceNodeModulesPath).catch(() => undefined);
  if (existing) return;
  await fs.symlink(
    sourceNodeModulesPath,
    workspaceNodeModulesPath,
    process.platform === "win32" ? "junction" : "dir",
  );
};

export const ensureFactoryWorkspaceCommandEnv = async (input: {
  readonly workspacePath: string;
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly worktreesDir: string;
}): Promise<{
  readonly receiptBinDir: string;
  readonly path: string;
}> => {
  await ensureWorkspaceDependencyLinks(input);
  const receiptBinDir = await ensureWorkspaceReceiptCli(input);
  const workspaceNodeModulesBin = await pathExists(path.join(input.workspacePath, "node_modules", ".bin"))
    ? path.join(input.workspacePath, "node_modules", ".bin")
    : undefined;
  const repoNodeModulesBin = await pathExists(path.join(input.repoRoot, "node_modules", ".bin"))
    ? path.join(input.repoRoot, "node_modules", ".bin")
    : undefined;
  const repoReceiptBinDir = await pathExists(path.join(input.repoRoot, ".receipt", "bin"))
    ? path.join(input.repoRoot, ".receipt", "bin")
    : undefined;
  return {
    receiptBinDir,
    path: prependPaths(
      [receiptBinDir, workspaceNodeModulesBin, repoNodeModulesBin, repoReceiptBinDir, ...runtimeBunPathEntries()],
      process.env.PATH,
    ),
  };
};

export const runFactoryChecks = async (input: {
  readonly commands: ReadonlyArray<string>;
  readonly workspacePath: string;
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly worktreesDir: string;
}): Promise<ReadonlyArray<FactoryCheckResult>> => {
  const workspaceCommandEnv = await ensureFactoryWorkspaceCommandEnv(input);
  const shell = await discoverShell();
  console.info(JSON.stringify({ event: "factory.check.shell.discovery", shell: shell.shell ?? null, attempted: shell.attempted }));
  if (!shell.shell) {
    throw new Error(formatShellDiscoveryFailure(shell.attempted));
  }
  const results: FactoryCheckResult[] = [];
  for (const command of input.commands) {
    const startedAt = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("check command timed out after 60 minutes")), CHECK_TIMEOUT_MS);
    try {
      const { stdout, stderr } = await execFileAsync(shell.shell, ["-lc", command], {
        cwd: input.workspacePath,
        encoding: "utf-8",
        env: {
          ...process.env,
          DATA_DIR: input.dataDir,
          RECEIPT_DATA_DIR: input.dataDir,
          PATH: workspaceCommandEnv.path,
        },
        maxBuffer: 16 * 1024 * 1024,
        signal: ac.signal,
      });
      results.push({
        command,
        ok: true,
        exitCode: 0,
        stdout,
        stderr,
        startedAt,
        finishedAt: Date.now(),
        shell: shell.shell,
        shellDiscoveryAttempted: shell.attempted,
      });
    } catch (err) {
      const failure = err as Error & { stdout?: string; stderr?: string; code?: number };
      results.push({
        command,
        ok: false,
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        startedAt,
        finishedAt: Date.now(),
        shell: shell.shell,
        shellDiscoveryAttempted: shell.attempted,
      });
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
};

export const baselineFactoryFailureSignature = async (input: {
  readonly state: FactoryState;
  readonly command: string;
  readonly baseHash: string;
  readonly dataDir: string;
  readonly git: FactoryWorkspaceGit;
  readonly baselineCheckCache: FactoryBaselineCheckCache;
}): Promise<{
  readonly digest: string;
  readonly excerpt: string;
} | undefined> => {
  const cacheKey = `${input.state.objectiveId}:${input.baseHash}:${input.command}`;
  const existing = input.baselineCheckCache.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    const workspaceId = `factory_baseline_${safeWorkspacePart(input.state.objectiveId)}_${createHash("sha1").update(input.command).digest("hex").slice(0, 10)}`;
    const workspacePath = path.join(input.git.worktreesDir, workspaceId);
    const branchName = `hub/baseline/${workspaceId}`;
    try {
      const workspace = await input.git.restoreWorkspace({
        workspaceId,
        branchName,
        workspacePath,
        baseHash: input.baseHash,
      });
      const [result] = await runFactoryChecks({
        commands: [input.command],
        workspacePath: workspace.path,
        dataDir: input.dataDir,
        repoRoot: input.git.repoRoot,
        worktreesDir: input.git.worktreesDir,
      });
      if (!result || result.ok) return undefined;
      return buildFactoryFailureSignature(result, {
        worktreesDir: input.git.worktreesDir,
        repoRoot: input.git.repoRoot,
      });
    } catch {
      return undefined;
    } finally {
      await input.git.removeWorkspace(workspacePath).catch(() => undefined);
    }
  })();

  input.baselineCheckCache.set(cacheKey, pending);
  return pending;
};

export const classifyFactoryFailedCheck = async (input: {
  readonly state: FactoryState;
  readonly check: FactoryCheckResult;
  readonly baseHash: string;
  readonly dataDir: string;
  readonly git: FactoryWorkspaceGit;
  readonly baselineCheckCache: FactoryBaselineCheckCache;
}): Promise<{
  readonly inherited: boolean;
  readonly digest: string;
  readonly excerpt: string;
  readonly source?: string;
}> => {
  const { digest, excerpt } = buildFactoryFailureSignature(input.check, {
    worktreesDir: input.git.worktreesDir,
    repoRoot: input.git.repoRoot,
  });
  const prior = priorFactoryFailureSignatureMap(input.state, {
    worktreesDir: input.git.worktreesDir,
    repoRoot: input.git.repoRoot,
  }).get(digest);
  if (prior) {
    return {
      inherited: true,
      digest,
      excerpt,
      source: prior.source,
    };
  }
  const baseline = await baselineFactoryFailureSignature({
    state: input.state,
    command: input.check.command,
    baseHash: input.baseHash,
    dataDir: input.dataDir,
    git: input.git,
    baselineCheckCache: input.baselineCheckCache,
  });
  return {
    inherited: Boolean(baseline && baseline.digest === digest),
    digest,
    excerpt,
    source: baseline && baseline.digest === digest
      ? `baseline/${input.baseHash.slice(0, 8)}`
      : undefined,
  };
};
