import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export type CodexRunInput = {
  readonly prompt: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly lastMessagePath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly model?: string;
  readonly outputSchemaPath?: string;
  readonly completionSignalPath?: string;
  readonly completionQuietMs?: number;
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  readonly sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  readonly mutationPolicy?: "read_only_probe" | "workspace_edit";
  readonly isolateCodexHome?: boolean;
  readonly objectiveId?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly integrationRef?: { readonly kind: string; readonly ref: string; readonly label?: string };
  readonly contextRefs?: ReadonlyArray<{ readonly kind: string; readonly ref: string; readonly label?: string }>;
  readonly skillBundlePaths?: ReadonlyArray<string>;
  readonly repoSkillPaths?: ReadonlyArray<string>;
  readonly memoryConfigPath?: string;
  readonly receiptBinDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
};

export type CodexRunResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly lastMessage?: string;
  readonly tokensUsed?: number;
};

export type CodexRunControl = {
  readonly shouldAbort?: () => Promise<boolean>;
};

export type CodexExecutor = {
  readonly run: (input: CodexRunInput, control?: CodexRunControl) => Promise<CodexRunResult>;
};

export class CodexExecutionError extends Error {
  readonly result: CodexRunResult;
  readonly sandboxMode: NonNullable<CodexRunInput["sandboxMode"]>;
  readonly mutationPolicy: NonNullable<CodexRunInput["mutationPolicy"]>;

  constructor(
    message: string,
    result: CodexRunResult,
    sandboxMode: NonNullable<CodexRunInput["sandboxMode"]>,
    mutationPolicy: NonNullable<CodexRunInput["mutationPolicy"]>,
  ) {
    super(message);
    this.name = "CodexExecutionError";
    this.result = result;
    this.sandboxMode = sandboxMode;
    this.mutationPolicy = mutationPolicy;
  }
}

type LocalCodexExecutorOptions = {
  readonly bin?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const fileHasContent = async (targetPath: string): Promise<boolean> => {
  try {
    const stat = await fsp.stat(targetPath);
    return stat.size > 0;
  } catch {
    return false;
  }
};

const copyPathIfExists = async (sourcePath: string, targetPath: string): Promise<void> => {
  try {
    const stat = await fsp.stat(sourcePath);
    if (stat.isDirectory()) {
      await fsp.mkdir(targetPath, { recursive: true });
      const entries = await fsp.readdir(sourcePath, { withFileTypes: true });
      for (const entry of entries) {
        await copyPathIfExists(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
      }
      return;
    }
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(sourcePath, targetPath);
  } catch {
    // ignore missing or unreadable optional Codex home artifacts
  }
};

const prepareIsolatedCodexHome = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
  const sourceHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  try {
    const stat = await fsp.stat(sourceHome);
    if (!stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const isolatedHome = await fsp.mkdtemp(path.join(os.tmpdir(), "receipt-codex-home-"));
  await Promise.all([
    copyPathIfExists(path.join(sourceHome, "auth.json"), path.join(isolatedHome, "auth.json")),
    copyPathIfExists(path.join(sourceHome, "config.toml"), path.join(isolatedHome, "config.toml")),
    copyPathIfExists(path.join(sourceHome, "version.json"), path.join(isolatedHome, "version.json")),
    copyPathIfExists(path.join(sourceHome, ".codex-global-state.json"), path.join(isolatedHome, ".codex-global-state.json")),
  ]);
  return isolatedHome;
};

const closeStream = (stream: fs.WriteStream): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(() => resolve());
  });

export class LocalCodexExecutor implements CodexExecutor {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: LocalCodexExecutorOptions = {}) {
    this.bin = opts.bin?.trim()
      || process.env.RECEIPT_CODEX_BIN?.trim()
      || process.env.HUB_CODEX_BIN?.trim()
      || "codex";
    this.timeoutMs = Math.max(
      30_000,
      opts.timeoutMs ?? Number(process.env.RECEIPT_CODEX_TIMEOUT_MS ?? process.env.HUB_CODEX_TIMEOUT_MS ?? 900_000),
    );
    this.env = opts.env ?? process.env;
  }

  async run(input: CodexRunInput, control?: CodexRunControl): Promise<CodexRunResult> {
    await fsp.mkdir(path.dirname(input.promptPath), { recursive: true });
    await fsp.mkdir(path.dirname(input.lastMessagePath), { recursive: true });
    await fsp.mkdir(path.dirname(input.stdoutPath), { recursive: true });
    await fsp.mkdir(path.dirname(input.stderrPath), { recursive: true });
    await Promise.all([
      fsp.writeFile(input.promptPath, input.prompt, "utf-8"),
      fsp.writeFile(input.lastMessagePath, "", "utf-8"),
      fsp.writeFile(input.stdoutPath, "", "utf-8"),
      fsp.writeFile(input.stderrPath, "", "utf-8"),
    ]);

    const sandboxMode = input.sandboxMode
      ?? (input.mutationPolicy === "read_only_probe" ? "read-only" : "workspace-write");
    const mutationPolicy = input.mutationPolicy ?? (sandboxMode === "read-only" ? "read_only_probe" : "workspace_edit");
    const args = [
      "-a",
      "never",
      "exec",
      ...(input.model ? ["-m", input.model] : []),
      "-c",
      `model_reasoning_effort=${JSON.stringify(input.reasoningEffort ?? "medium")}`,
      "--cd",
      input.workspacePath,
      "--sandbox",
      sandboxMode,
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-last-message",
      input.lastMessagePath,
    ];
    if (input.outputSchemaPath) {
      await fsp.mkdir(path.dirname(input.outputSchemaPath), { recursive: true });
      args.push("--output-schema", input.outputSchemaPath);
    }
    args.push("-");

    let isolatedCodexHome: string | undefined;
    const childEnv = { ...this.env, ...input.env };
    if (input.isolateCodexHome) {
      isolatedCodexHome = await prepareIsolatedCodexHome(childEnv);
      if (isolatedCodexHome) childEnv.CODEX_HOME = isolatedCodexHome;
    }

    try {
      const child = spawn(this.bin, args, {
        cwd: input.workspacePath,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let lastOutputAt = Date.now();
      let completionTriggered = false;
      const stdoutFile = fs.createWriteStream(input.stdoutPath, { flags: "a", encoding: "utf-8" });
      const stderrFile = fs.createWriteStream(input.stderrPath, { flags: "a", encoding: "utf-8" });

      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        lastOutputAt = Date.now();
        stdoutFile.write(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        lastOutputAt = Date.now();
        stderrFile.write(chunk);
      });

      child.stdin.write(input.prompt);
      child.stdin.end();

      let timedOut = false;
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, Math.max(30_000, input.timeoutMs ?? this.timeoutMs));

      const completionSignalPath = input.completionSignalPath?.trim();
      const completionQuietMs = Math.max(250, input.completionQuietMs ?? 1_000);
      let completionKillTimer: NodeJS.Timeout | undefined;
      const completionLoop = completionSignalPath
        ? (async () => {
          while (child.exitCode === null && !child.killed && !completionTriggered) {
            if (
              await fileHasContent(completionSignalPath)
              && Date.now() - lastOutputAt >= completionQuietMs
            ) {
              completionTriggered = true;
              child.kill("SIGTERM");
              completionKillTimer = setTimeout(() => {
                if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
              }, Math.min(2_000, completionQuietMs));
              return;
            }
            await delay(Math.min(250, completionQuietMs));
          }
        })()
        : undefined;

      const shouldAbort = control?.shouldAbort;
      const abortLoop = shouldAbort
        ? (async () => {
          while (child.exitCode === null && !child.killed) {
            if (await shouldAbort()) {
              child.kill("SIGTERM");
              return;
            }
            await delay(500);
          }
        })()
        : undefined;

      const result = await new Promise<CodexRunResult>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", async (code, signal) => {
          clearTimeout(timer);
          if (completionKillTimer) clearTimeout(completionKillTimer);
          try {
            await Promise.all([closeStream(stdoutFile), closeStream(stderrFile)]);
            const lastMessage = await fsp.readFile(input.lastMessagePath, "utf-8").catch(() => "");
            const match = stdout.match(/tokens used\s*\n([\d,]+)/i);
            let tokensUsed: number | undefined;
            if (match && match[1]) {
              tokensUsed = parseInt(match[1].replace(/,/g, ""), 10);
              if (isNaN(tokensUsed)) tokensUsed = undefined;
            }
            resolve({
              exitCode: completionTriggered ? 0 : timedOut ? 124 : code,
              signal: completionTriggered ? null : signal,
              stdout,
              stderr,
              lastMessage: lastMessage.trim() || undefined,
              tokensUsed,
            });
          } catch (err) {
            reject(err);
          }
        });
      });

      await completionLoop;
      await abortLoop;
      if (timedOut) {
        const elapsed = Date.now() - startedAt;
        throw new Error(`codex exec timed out after ${elapsed}ms`);
      }
      if (result.signal === "SIGTERM") {
        throw new Error("codex exec aborted");
      }
      if ((result.exitCode ?? 1) !== 0) {
        const summary = (result.stderr.trim() || result.stdout.trim() || `codex exited with ${result.exitCode}`).slice(0, 1_000);
        throw new CodexExecutionError(summary, result, sandboxMode, mutationPolicy);
      }
      return result;
    } finally {
      if (isolatedCodexHome) {
        await fsp.rm(isolatedCodexHome, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
