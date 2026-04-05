import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { CodexControlSignalError, type CodexExecutor, type CodexRunControl, type CodexRunInput } from "../../../adapters/codex-executor";
import type { FactoryService } from "../../../services/factory-service";
import { factoryChatCodexArtifactPaths, readTextTail } from "../../../services/factory-codex-artifacts";
import { createDisposableProbeWorkspace, diffGitChangedSnapshots, gitChangedFileSnapshots, gitChangedFiles, asString, summarizeChildProgress } from "./input";

const DIRECT_CODEX_MUTATION_MESSAGE = "Direct Codex probes are read-only. This work needs code changes; create or react a Factory objective instead.";
const SANDBOX_BOOTSTRAP_COMPATIBILITY_RE = /\bbwrap:\s*Unknown option --argv0\b/i;

const looksLikeReadOnlyMutationFailure = (message: string): boolean =>
  /\bread[- ]only\b|\bpermission denied\b|\bcannot write\b|\bwrite access\b|\bsandbox\b/i.test(message);

const isSandboxBootstrapCompatibilityError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  if (SANDBOX_BOOTSTRAP_COMPATIBILITY_RE.test(message)) return true;
  if (!error || typeof error !== "object" || !("result" in error)) return false;
  const result = (error as { readonly result?: { readonly stderr?: string; readonly stdout?: string } }).result;
  return SANDBOX_BOOTSTRAP_COMPATIBILITY_RE.test(result?.stderr ?? "")
    || SANDBOX_BOOTSTRAP_COMPATIBILITY_RE.test(result?.stdout ?? "");
};

const tail = (value: string | undefined, max = 400): string | undefined => {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
};

type PreflightResult = {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly remediation: ReadonlyArray<string>;
};

const runPreflight = async (workspacePath: string): Promise<PreflightResult> => {
  const command = "pwd";
  return await new Promise<PreflightResult>((resolve) => {
    const child = spawn(command, [], {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolve({
        command,
        stdout,
        stderr: stderr || (error instanceof Error ? error.message : String(error)),
        exitCode: 1,
        signal: null,
        remediation: [
          "mount path missing -> recreate worktree",
          "binary execution failed -> verify the worktree runner can spawn basic host commands",
        ],
      });
    });
    child.once("close", (exitCode, signal) => {
      const trimmedStderr = stderr.trim();
      resolve({
        command,
        stdout,
        stderr,
        exitCode,
        signal,
        remediation: exitCode === 0
          ? []
          : [
              ...(trimmedStderr.includes("bwrap") || trimmedStderr.includes("sandbox")
                ? ["bwrap unavailable -> set SANDBOX_MODE=none"]
                : []),
              ...(trimmedStderr.includes("No such file") || trimmedStderr.includes("ENOENT")
                ? ["mount path missing -> recreate worktree"]
                : []),
              "worktree runner failed to execute a minimal command -> inspect sandbox/bootstrap configuration",
            ],
      });
    });
  });
};

export const runFactoryCodexJob = async (input: {
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly jobId: string;
  readonly prompt: string;
  readonly executor: CodexExecutor;
  readonly timeoutMs?: number;
  readonly onProgress?: (update: Record<string, unknown>) => Promise<void>;
  readonly factoryService?: FactoryService;
  readonly payload?: Record<string, unknown>;
}, control?: CodexRunControl): Promise<Record<string, unknown>> => {
  const artifacts = factoryChatCodexArtifactPaths(input.dataDir, input.jobId);
  await fs.mkdir(artifacts.root, { recursive: true });

  let renderedPrompt = input.prompt;
  let readOnly = input.payload?.readOnly === true || asString(input.payload?.mode) === "read_only_probe";
  let env: NodeJS.ProcessEnv | undefined;
  if (input.factoryService && input.payload) {
    const prepared = await input.factoryService.prepareDirectCodexProbePacket({
      jobId: input.jobId,
      prompt: input.prompt,
      profileId: asString(input.payload.profileId),
      objectiveId: asString(input.payload.objectiveId),
      parentRunId: asString(input.payload.parentRunId),
      parentStream: asString(input.payload.parentStream),
      stream: asString(input.payload.stream),
      supervisorSessionId: asString(input.payload.supervisorSessionId),
      readOnly,
    });
    renderedPrompt = prepared.renderedPrompt;
    readOnly = prepared.readOnly;
    env = prepared.env;
  } else {
    await fs.rm(artifacts.resultPath, { force: true });
  }

  let progressStopped = false;
  let lastFingerprint = "";
  const emitProgress = async (): Promise<void> => {
    const [lastMessage, stdoutTail, stderrTail] = await Promise.all([
      readTextTail(artifacts.lastMessagePath, 400),
      readTextTail(artifacts.stdoutPath, 900),
      readTextTail(artifacts.stderrPath, 600),
    ]);
    const update = {
      worker: "codex",
      mode: readOnly ? "read_only_probe" : "workspace_write",
      readOnly,
      status: "running",
      progressAt: Date.now(),
      lastMessage,
      stdoutTail,
      stderrTail,
    };
    const next = {
      ...update,
      summary: summarizeChildProgress(update),
    };
    const fingerprint = JSON.stringify(next);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    await input.onProgress?.(next);
  };
  const progressLoop = (async () => {
    while (!progressStopped) {
      await emitProgress();
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  })();

  const writeResult = async (result: Record<string, unknown>): Promise<void> => {
    await fs.writeFile(artifacts.resultPath, JSON.stringify(result, null, 2), "utf-8");
  };

  let workspacePath = input.repoRoot;
  let workspaceCleanup: (() => Promise<void>) | undefined;
  let sandboxMode: CodexRunInput["sandboxMode"] = readOnly ? "read-only" : "workspace-write";
  let mutationPolicy: NonNullable<CodexRunInput["mutationPolicy"]> = readOnly ? "read_only_probe" : "workspace_edit";
  let disableSandboxModeInference = false;
  let sandboxCompatibilityFallbackUsed = false;
  let initialChangedFileSnapshot = readOnly
    ? await gitChangedFileSnapshots(workspacePath)
    : undefined;
  const preflight = await runPreflight(workspacePath);
  if (preflight.exitCode !== 0) {
    const preflightFailure = {
      status: "failed",
      worker: "codex",
      mode: readOnly ? "read_only_probe" : "workspace_write",
      readOnly,
      summary: "Preflight failed before Codex execution.",
      preflight,
      artifacts,
    };
    await fs.writeFile(
      path.join(artifacts.root, "preflight-failure.json"),
      JSON.stringify(preflightFailure, null, 2),
      "utf-8",
    );
    await writeResult(preflightFailure);
    return preflightFailure;
  }

  const runExecutor = () => input.executor.run({
    prompt: renderedPrompt,
    workspacePath,
    promptPath: artifacts.promptPath,
    lastMessagePath: artifacts.lastMessagePath,
    stdoutPath: artifacts.stdoutPath,
    stderrPath: artifacts.stderrPath,
    timeoutMs: input.timeoutMs,
    env,
    sandboxMode,
    mutationPolicy,
    disableSandboxModeInference,
  }, control);

  try {
    let result;
    try {
      result = await runExecutor();
    } catch (err) {
      if (!readOnly || !isSandboxBootstrapCompatibilityError(err)) throw err;
      const fallbackWorkspace = await createDisposableProbeWorkspace(input.repoRoot, input.jobId);
      workspacePath = fallbackWorkspace.workspacePath;
      workspaceCleanup = fallbackWorkspace.cleanup;
      sandboxMode = undefined;
      disableSandboxModeInference = true;
      sandboxCompatibilityFallbackUsed = true;
      initialChangedFileSnapshot = await gitChangedFileSnapshots(workspacePath);
      await fs.appendFile(
        artifacts.stderrPath,
        "[factory] sandbox compatibility fallback: host sandbox startup failed; retrying read-only probe in a disposable workspace without Codex sandboxing.\n",
        "utf-8",
      ).catch(() => undefined);
      result = await runExecutor();
    }
    progressStopped = true;
    await progressLoop;
    await emitProgress();

    const [repoChangedFiles, finalChangedFileSnapshot] = await Promise.all([
      gitChangedFiles(input.repoRoot),
      readOnly ? gitChangedFileSnapshots(workspacePath) : Promise.resolve(undefined),
    ]);
    const changedFiles = readOnly && initialChangedFileSnapshot && finalChangedFileSnapshot
      ? diffGitChangedSnapshots(initialChangedFileSnapshot, finalChangedFileSnapshot)
      : repoChangedFiles;
    if (readOnly && changedFiles.length > 0) {
      const failed = {
        status: "failed",
        worker: "codex",
        mode: "read_only_probe",
        readOnly: true,
        summary: DIRECT_CODEX_MUTATION_MESSAGE,
        lastMessage: asString(result.lastMessage),
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
        ...(typeof result.tokensUsed === "number" ? { tokensUsed: result.tokensUsed } : {}),
        changedFiles,
        ...(readOnly ? { repoChangedFiles } : {}),
        ...(sandboxCompatibilityFallbackUsed ? { sandboxCompatibilityFallbackUsed: true } : {}),
        artifacts,
      };
      await writeResult(failed);
      throw new Error(DIRECT_CODEX_MUTATION_MESSAGE);
    }

    const completed = {
      status: "completed",
      worker: "codex",
      mode: readOnly ? "read_only_probe" : "workspace_write",
      readOnly,
      summary: asString(result.lastMessage) ?? "Codex completed.",
      lastMessage: asString(result.lastMessage),
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
      ...(typeof result.tokensUsed === "number" ? { tokensUsed: result.tokensUsed } : {}),
      changedFiles,
      ...(readOnly ? { repoChangedFiles } : {}),
      ...(sandboxCompatibilityFallbackUsed ? { sandboxCompatibilityFallbackUsed: true } : {}),
      artifacts,
    };
    await writeResult(completed);
    return completed;
  } catch (err) {
    progressStopped = true;
    await progressLoop;
    await emitProgress();

    if (err instanceof CodexControlSignalError && err.signal.kind === "restart") {
      throw err;
    }

    const [lastMessage, stdoutTail, stderrTail, repoChangedFiles, finalChangedFileSnapshot] = await Promise.all([
      readTextTail(artifacts.lastMessagePath, 400),
      readTextTail(artifacts.stdoutPath, 900),
      readTextTail(artifacts.stderrPath, 600),
      gitChangedFiles(input.repoRoot),
      readOnly ? gitChangedFileSnapshots(workspacePath) : Promise.resolve(undefined),
    ]);
    const changedFiles = readOnly && initialChangedFileSnapshot && finalChangedFileSnapshot
      ? diffGitChangedSnapshots(initialChangedFileSnapshot, finalChangedFileSnapshot)
      : repoChangedFiles;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = readOnly && (changedFiles.length > 0 || looksLikeReadOnlyMutationFailure(rawMessage))
      ? DIRECT_CODEX_MUTATION_MESSAGE
      : rawMessage;
    await writeResult({
      status: "failed",
      worker: "codex",
      mode: readOnly ? "read_only_probe" : "workspace_write",
      readOnly,
      summary: message,
      lastMessage,
      stdoutTail,
      stderrTail,
      changedFiles,
      ...(readOnly ? { repoChangedFiles } : {}),
      ...(sandboxCompatibilityFallbackUsed ? { sandboxCompatibilityFallbackUsed: true } : {}),
      artifacts,
    });
    throw new Error(message);
  } finally {
    if (workspaceCleanup) {
      await workspaceCleanup().catch(() => undefined);
    }
  }
};
