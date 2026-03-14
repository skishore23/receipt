import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export type CodexRunInput = {
  readonly prompt: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly lastMessagePath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly timeoutMs?: number;
};

export type CodexRunResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly lastMessage?: string;
};

export type CodexRunControl = {
  readonly shouldAbort?: () => Promise<boolean>;
};

export type CodexExecutor = {
  readonly run: (input: CodexRunInput, control?: CodexRunControl) => Promise<CodexRunResult>;
};

type LocalCodexExecutorOptions = {
  readonly bin?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
    this.bin = opts.bin?.trim() || process.env.HUB_CODEX_BIN?.trim() || "codex";
    this.timeoutMs = Math.max(30_000, opts.timeoutMs ?? Number(process.env.HUB_CODEX_TIMEOUT_MS ?? 900_000));
    this.env = opts.env ?? process.env;
  }

  async run(input: CodexRunInput, control?: CodexRunControl): Promise<CodexRunResult> {
    await fsp.mkdir(path.dirname(input.lastMessagePath), { recursive: true });
    await fsp.mkdir(path.dirname(input.stdoutPath), { recursive: true });
    await fsp.mkdir(path.dirname(input.stderrPath), { recursive: true });
    await Promise.all([
      fsp.writeFile(input.stdoutPath, "", "utf-8"),
      fsp.writeFile(input.stderrPath, "", "utf-8"),
    ]);

    const args = [
      "-a",
      "never",
      "exec",
      "--cd",
      input.workspacePath,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-last-message",
      input.lastMessagePath,
      "-",
    ];

    const child = spawn(this.bin, args, {
      cwd: input.workspacePath,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const stdoutFile = fs.createWriteStream(input.stdoutPath, { flags: "a", encoding: "utf-8" });
    const stderrFile = fs.createWriteStream(input.stderrPath, { flags: "a", encoding: "utf-8" });

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutFile.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
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
        try {
          await Promise.all([closeStream(stdoutFile), closeStream(stderrFile)]);
          const lastMessage = await fsp.readFile(input.lastMessagePath, "utf-8").catch(() => "");
          resolve({
            exitCode: timedOut ? 124 : code,
            signal,
            stdout,
            stderr,
            lastMessage: lastMessage.trim() || undefined,
          });
        } catch (err) {
          reject(err);
        }
      });
    });

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
      throw new Error(summary);
    }
    return result;
  }
}
