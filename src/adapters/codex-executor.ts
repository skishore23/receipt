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
  readonly jsonOutput?: boolean;
  readonly outputSchemaPath?: string;
  readonly completionSignalPath?: string;
  readonly completionQuietMs?: number;
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  readonly sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  readonly mutationPolicy?: "read_only_probe" | "workspace_edit";
  readonly disableSandboxModeInference?: boolean;
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
  readonly stallTimeoutMs?: number;
};

export type CodexProgressUpdate = {
  readonly status: "running";
  readonly summary?: string;
  readonly lastMessage?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly tokensUsed?: number;
  readonly progressAt: number;
  readonly eventType?: string;
};

export type CodexRunResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly lastMessage?: string;
  readonly tokensUsed?: number;
  readonly progressAt?: number;
  readonly latestEventType?: string;
  readonly latestEventText?: string;
};

export type CodexControlSignal = {
  readonly kind: "abort" | "restart";
  readonly note?: string;
  readonly meta?: Record<string, unknown>;
};

export type CodexSpawnUpdate = {
  readonly pid: number;
  readonly command: string;
  readonly workspacePath: string;
  readonly startedAt: number;
};

export type CodexRunControl = {
  readonly shouldAbort?: () => Promise<boolean>;
  readonly pollSignal?: () => Promise<CodexControlSignal | undefined>;
  readonly onProgress?: (update: CodexProgressUpdate) => Promise<void> | void;
  readonly onChildSpawn?: (update: CodexSpawnUpdate) => Promise<void> | void;
  readonly onChildExit?: (update: CodexSpawnUpdate & {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }) => Promise<void> | void;
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

export class CodexControlSignalError extends Error {
  readonly signal: CodexControlSignal;
  readonly result: CodexRunResult;

  constructor(signal: CodexControlSignal, result: CodexRunResult) {
    super(signal.kind === "restart" ? "codex exec restart requested" : "codex exec aborted");
    this.name = "CodexControlSignalError";
    this.signal = signal;
    this.result = result;
  }
}

type LocalCodexExecutorOptions = {
  readonly bin?: string;
  readonly timeoutMs?: number;
  readonly stallTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const prependPath = (dir: string, currentPath: string | undefined): string =>
  currentPath ? `${dir}${path.delimiter}${currentPath}` : dir;

const prependPaths = (entries: ReadonlyArray<string | undefined>, currentPath: string | undefined): string =>
  entries
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .reduceRight<string>((acc, entry) => prependPath(entry, acc), currentPath ?? "");

const runtimeBunPathEntries = (env: NodeJS.ProcessEnv): string[] => {
  const candidates = [
    env.RECEIPT_BUN_BIN ? path.dirname(env.RECEIPT_BUN_BIN) : undefined,
    path.basename(process.execPath || "").toLowerCase().includes("bun") ? path.dirname(process.execPath) : undefined,
    env.BUN_INSTALL?.trim() ? path.join(env.BUN_INSTALL.trim(), "bin") : undefined,
    env.HOME?.trim() ? path.join(env.HOME.trim(), ".bun", "bin") : undefined,
  ];
  return [...new Set(candidates.filter((entry): entry is string => typeof entry === "string" && fs.existsSync(entry)))];
};

const normalizePositiveTimeoutMs = (
  value: unknown,
  minimumMs: number,
  maximumMs?: number,
): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const floored = Math.floor(parsed);
  const lowered = maximumMs !== undefined ? Math.min(floored, maximumMs) : floored;
  return Math.max(minimumMs, lowered);
};

const fileContentMtimeMs = async (targetPath: string): Promise<number | undefined> => {
  try {
    const stat = await fsp.stat(targetPath);
    return stat.size > 0 ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
};

const prepareAttemptLog = async (targetPath: string, label: "stdout" | "stderr"): Promise<void> => {
  try {
    const stat = await fsp.stat(targetPath);
    if (stat.isFile() && stat.size > 0) {
      const marker = `\n\n[factory] codex restart ${new Date().toISOString()} (${label})\n`;
      await fsp.appendFile(targetPath, marker, "utf-8");
      return;
    }
  } catch {
    // create a fresh file below
  }
  await fsp.writeFile(targetPath, "", "utf-8");
};

const isMissingPathError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const copyFileIfExists = async (sourcePath: string, targetPath: string): Promise<void> => {
  try {
    const stat = await fsp.stat(sourcePath);
    if (!stat.isFile()) return;
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(sourcePath, targetPath);
  } catch (err) {
    if (isMissingPathError(err)) return;
    throw err;
  }
};

const resolveIsolatedCodexHomeRoot = (env: NodeJS.ProcessEnv, workspacePath: string): string => {
  const configuredRoot = env.RECEIPT_ISOLATED_CODEX_HOME_ROOT?.trim();
  if (configuredRoot) return path.resolve(configuredRoot);
  return path.join(workspacePath, ".receipt", "codex-home-runtime");
};

const prepareIsolatedCodexHome = async (
  env: NodeJS.ProcessEnv,
  workspacePath: string,
): Promise<string | undefined> => {
  const sourceHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  try {
    const stat = await fsp.stat(sourceHome);
    if (!stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const isolatedRoot = resolveIsolatedCodexHomeRoot(env, workspacePath);
  await fsp.mkdir(isolatedRoot, { recursive: true });
  const isolatedHome = await fsp.mkdtemp(path.join(isolatedRoot, "isolated-"));
  await Promise.all([
    copyFileIfExists(path.join(sourceHome, "auth.json"), path.join(isolatedHome, "auth.json")),
    copyFileIfExists(path.join(sourceHome, "config.toml"), path.join(isolatedHome, "config.toml")),
    copyFileIfExists(path.join(sourceHome, "version.json"), path.join(isolatedHome, "version.json")),
    copyFileIfExists(path.join(sourceHome, ".codex-global-state.json"), path.join(isolatedHome, ".codex-global-state.json")),
  ]);
  return isolatedHome;
};

const closeStream = (stream: fs.WriteStream): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(() => resolve());
  });

const extractTokensUsed = (...streams: ReadonlyArray<string>): number | undefined => {
  for (const stream of streams) {
    const match = stream.match(/tokens used\s*\n([\d,]+)/i);
    if (!match?.[1]) continue;
    const parsed = parseInt(match[1].replace(/,/g, ""), 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parseJsonObjectCandidate = (raw: string): Record<string, unknown> | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
};

const clipInline = (value: string | undefined, max = 260): string | undefined => {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
};

const clipTail = (value: string | undefined, max = 400): string | undefined => {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `…${normalized.slice(normalized.length - max + 1)}`;
};

const humanizeEventLabel = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.replace(/[_-]+/g, " ");
};

const usageTokens = (usage: Record<string, unknown> | undefined): number | undefined => {
  const explicit = asNumber(usage?.total_tokens) ?? asNumber(usage?.totalTokens);
  if (explicit !== undefined) return explicit;
  const pieces = [
    asNumber(usage?.input_tokens) ?? asNumber(usage?.inputTokens),
    asNumber(usage?.output_tokens) ?? asNumber(usage?.outputTokens),
    asNumber(usage?.reasoning_tokens) ?? asNumber(usage?.reasoningTokens),
  ].filter((value): value is number => value !== undefined);
  if (pieces.length === 0) return undefined;
  return pieces.reduce((sum, value) => sum + value, 0);
};

const codexItemText = (item: Record<string, unknown> | undefined): string | undefined =>
  clipInline(
    asString(item?.text)
    ?? asString(item?.content)
    ?? asString(item?.summary)
    ?? asString(item?.title),
  );

const summarizeCodexItem = (
  eventType: string,
  item: Record<string, unknown> | undefined,
): { readonly summary?: string; readonly lastMessage?: string } => {
  const itemType = asString(item?.type);
  const text = codexItemText(item);
  if (itemType === "agent_message" && text) {
    return {
      summary: text,
      lastMessage: text,
    };
  }
  const command = clipInline(asString(item?.command), 180);
  if (itemType === "command_execution" && command) {
    if (eventType === "item.failed") return { summary: `Command failed: ${command}` };
    if (eventType === "item.completed") return { summary: `Command completed: ${command}` };
    return { summary: `Running command: ${command}` };
  }
  if (text) return { summary: text };
  if (itemType) {
    const label = humanizeEventLabel(itemType) ?? itemType;
    if (eventType === "item.completed") return { summary: `${label} completed.` };
    if (eventType === "item.failed") return { summary: `${label} failed.` };
    return { summary: `${label} started.` };
  }
  return {};
};

const progressFromCodexJsonEvent = (
  event: Record<string, unknown>,
  now = Date.now(),
): CodexProgressUpdate | undefined => {
  const eventType = asString(event.type);
  if (!eventType) return undefined;
  const progressAt = now;
  if (eventType === "turn.started") {
    return {
      status: "running",
      summary: "Codex started working.",
      progressAt,
      eventType,
    };
  }
  if (eventType === "turn.completed") {
    return {
      status: "running",
      summary: "Codex completed the turn.",
      tokensUsed: usageTokens(asRecord(event.usage)),
      progressAt,
      eventType,
    };
  }
  if (eventType === "turn.failed" || eventType === "error") {
    return {
      status: "running",
      summary: clipInline(
        asString(event.message)
        ?? asString(event.error)
        ?? `${humanizeEventLabel(eventType) ?? eventType}.`,
      ),
      progressAt,
      eventType,
    };
  }
  if (eventType.startsWith("item.")) {
    const itemSummary = summarizeCodexItem(eventType, asRecord(event.item));
    if (!itemSummary.summary && !itemSummary.lastMessage) return undefined;
    return {
      status: "running",
      summary: itemSummary.summary,
      lastMessage: itemSummary.lastMessage,
      progressAt,
      eventType,
    };
  }
  return undefined;
};

export class LocalCodexExecutor implements CodexExecutor {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly stallTimeoutMs?: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: LocalCodexExecutorOptions = {}) {
    this.bin = opts.bin?.trim()
      || process.env.RECEIPT_CODEX_BIN?.trim()
      || process.env.HUB_CODEX_BIN?.trim()
      || "codex";
    this.timeoutMs = Math.max(
      30_000,
      opts.timeoutMs ?? Number(process.env.RECEIPT_CODEX_TIMEOUT_MS ?? process.env.HUB_CODEX_TIMEOUT_MS ?? 1_800_000),
    );
    this.stallTimeoutMs = normalizePositiveTimeoutMs(
      opts.stallTimeoutMs ?? process.env.RECEIPT_CODEX_STALL_TIMEOUT_MS ?? process.env.HUB_CODEX_STALL_TIMEOUT_MS,
      1_000,
      this.timeoutMs,
    );
    this.env = opts.env ?? process.env;
  }

  async run(input: CodexRunInput, control?: CodexRunControl): Promise<CodexRunResult> {
    const initialSandboxMode = input.sandboxMode
      ?? (!input.disableSandboxModeInference && input.mutationPolicy === "read_only_probe" ? "read-only" : undefined);
    const mutationPolicy = input.mutationPolicy ?? (initialSandboxMode === "read-only" ? "read_only_probe" : "workspace_edit");
    let isolatedCodexHome: string | undefined;
    const mergedEnv = { ...this.env, ...input.env };
    const childEnv: NodeJS.ProcessEnv = {
      ...mergedEnv,
      PATH: prependPaths(runtimeBunPathEntries(mergedEnv), mergedEnv.PATH),
    };
    if (input.isolateCodexHome) {
      isolatedCodexHome = await prepareIsolatedCodexHome(childEnv, input.workspacePath);
      if (isolatedCodexHome) childEnv.CODEX_HOME = isolatedCodexHome;
    }

    try {
      const execute = async (sandboxMode: CodexRunInput["sandboxMode"]): Promise<CodexRunResult> => {
        await fsp.mkdir(path.dirname(input.promptPath), { recursive: true });
        await fsp.mkdir(path.dirname(input.lastMessagePath), { recursive: true });
        await fsp.mkdir(path.dirname(input.stdoutPath), { recursive: true });
        await fsp.mkdir(path.dirname(input.stderrPath), { recursive: true });
        await Promise.all([
          fsp.writeFile(input.promptPath, input.prompt, "utf-8"),
          fsp.writeFile(input.lastMessagePath, "", "utf-8"),
          prepareAttemptLog(input.stdoutPath, "stdout"),
          prepareAttemptLog(input.stderrPath, "stderr"),
        ]);

        const args = [
          "-a",
          "never",
          "exec",
          ...(input.model ? ["-m", input.model] : []),
          "-c",
          `model_reasoning_effort=${JSON.stringify(input.reasoningEffort ?? "medium")}`,
          "--cd",
          input.workspacePath,
          ...(sandboxMode
            ? ["--sandbox", sandboxMode]
            : ["--dangerously-bypass-approvals-and-sandbox"]),
          "--skip-git-repo-check",
          "--color",
          "never",
          ...(input.jsonOutput ? ["--json"] : []),
          "--output-last-message",
          input.lastMessagePath,
        ];
        if (input.outputSchemaPath) {
          await fsp.mkdir(path.dirname(input.outputSchemaPath), { recursive: true });
          args.push("--output-schema", input.outputSchemaPath);
        }
        args.push("-");

        const child = spawn(this.bin, args, {
          cwd: input.workspacePath,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const childStartedAt = Date.now();
        if (child.pid && control?.onChildSpawn) {
          void Promise.resolve(control.onChildSpawn({
            pid: child.pid,
            command: [this.bin, ...args].join(" "),
            workspacePath: input.workspacePath,
            startedAt: childStartedAt,
          })).catch(() => undefined);
        }

        let stdout = "";
        let stderr = "";
        let lastOutputAt = Date.now();
        let lastObservedActivityAt = Date.now();
        let completionTriggered = false;
        let controlSignal: CodexControlSignal | undefined;
        let stalled = false;
        let stallMessage = "";
        let progressAt: number | undefined;
        let latestEventType: string | undefined;
        let latestEventText: string | undefined;
        let latestStructuredLastMessage: string | undefined;
        let lastStructuredFileMessage: string | undefined;
        let structuredTokensUsed: number | undefined;
        let stdoutJsonBuffer = "";
        let progressFingerprint = "";
        let progressChain = Promise.resolve();
        let lastMessageWriteChain = Promise.resolve();
        const stdoutFile = fs.createWriteStream(input.stdoutPath, { flags: "a", encoding: "utf-8" });
        const stderrFile = fs.createWriteStream(input.stderrPath, { flags: "a", encoding: "utf-8" });
        const observeOutputActivity = (): void => {
          const now = Date.now();
          lastOutputAt = now;
          lastObservedActivityAt = now;
        };
        const emitProgress = (update: CodexProgressUpdate): void => {
          const callback = control?.onProgress;
          if (!callback) return;
          const fingerprint = JSON.stringify(update);
          if (fingerprint === progressFingerprint) return;
          progressFingerprint = fingerprint;
          progressChain = progressChain
            .then(() => Promise.resolve(callback(update)))
            .catch(() => undefined);
        };
        const consumeJsonStdout = (chunk: string): void => {
          if (!input.jsonOutput) return;
          stdoutJsonBuffer += chunk;
          while (stdoutJsonBuffer.includes("\n")) {
            const newlineIndex = stdoutJsonBuffer.indexOf("\n");
            const line = stdoutJsonBuffer.slice(0, newlineIndex).trim();
            stdoutJsonBuffer = stdoutJsonBuffer.slice(newlineIndex + 1);
            if (!line) continue;
            let parsed: Record<string, unknown> | undefined;
            try {
              parsed = asRecord(JSON.parse(line));
            } catch {
              parsed = undefined;
            }
            if (!parsed) continue;
            const update = progressFromCodexJsonEvent(parsed);
            if (!update) continue;
            const enrichedUpdate: CodexProgressUpdate = {
              ...update,
              stdoutTail: clipTail(stdout, 900),
              stderrTail: clipTail(stderr, 600),
            };
            progressAt = enrichedUpdate.progressAt;
            latestEventType = enrichedUpdate.eventType;
            if (enrichedUpdate.lastMessage) {
              latestEventText = enrichedUpdate.lastMessage;
              latestStructuredLastMessage = enrichedUpdate.lastMessage;
              if (!input.outputSchemaPath || parseJsonObjectCandidate(enrichedUpdate.lastMessage)) {
                const nextMessage = enrichedUpdate.lastMessage;
                lastMessageWriteChain = lastMessageWriteChain
                  .then(async () => {
                    const currentMessage = await fsp.readFile(input.lastMessagePath, "utf-8").catch(() => "");
                    const trimmedCurrentMessage = currentMessage.trim();
                    if (trimmedCurrentMessage && trimmedCurrentMessage !== (lastStructuredFileMessage?.trim() ?? "")) {
                      return;
                    }
                    await fsp.writeFile(input.lastMessagePath, nextMessage, "utf-8");
                    lastStructuredFileMessage = nextMessage;
                  })
                  .catch(() => undefined);
              }
            } else if (enrichedUpdate.summary && !["Codex started working.", "Codex completed the turn."].includes(enrichedUpdate.summary)) {
              latestEventText = enrichedUpdate.summary;
            }
            if (typeof enrichedUpdate.tokensUsed === "number") structuredTokensUsed = enrichedUpdate.tokensUsed;
            lastObservedActivityAt = enrichedUpdate.progressAt;
            emitProgress(enrichedUpdate);
          }
        };

        child.stdout.setEncoding("utf-8");
        child.stderr.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          observeOutputActivity();
          stdoutFile.write(chunk);
          if (!input.jsonOutput) return;
          consumeJsonStdout(chunk);
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
          observeOutputActivity();
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
        const prefersStructuredCompletion = Boolean(input.outputSchemaPath);
        const defaultStallTimeoutMs = Math.min(300_000, Math.max(30_000, input.timeoutMs ?? this.timeoutMs));
        const stallTimeoutMs = normalizePositiveTimeoutMs(
          input.stallTimeoutMs,
          1_000,
          Math.max(1_000, input.timeoutMs ?? this.timeoutMs),
        ) ?? this.stallTimeoutMs ?? defaultStallTimeoutMs;
        const stallPollMs = Math.min(1_000, Math.max(250, Math.floor(stallTimeoutMs / 10)));
        const activityFilePaths = [...new Set([
          input.lastMessagePath.trim(),
          completionSignalPath,
        ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0))];
        const activityFileMtimes = new Map<string, number | undefined>();
        let completionKillTimer: NodeJS.Timeout | undefined;
        let stallKillTimer: NodeJS.Timeout | undefined;
        const completionLoop = completionSignalPath
          ? (async () => {
            let completionSignalMtimeMs: number | undefined;
            let completionStableSince: number | undefined;
            while (child.exitCode === null && !child.killed && !completionTriggered) {
              const signalMtimeMs = await fileContentMtimeMs(completionSignalPath);
              if (signalMtimeMs !== undefined) {
                if (signalMtimeMs !== completionSignalMtimeMs) {
                  completionSignalMtimeMs = signalMtimeMs;
                  completionStableSince = Date.now();
                  lastObservedActivityAt = Date.now();
                }
                const outputQuiet = Date.now() - lastOutputAt >= completionQuietMs;
                const completionStable = completionStableSince !== undefined
                  && Date.now() - completionStableSince >= completionQuietMs;
                if (outputQuiet || (prefersStructuredCompletion && completionStable)) {
                  completionTriggered = true;
                  child.kill("SIGTERM");
                  completionKillTimer = setTimeout(() => {
                    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
                  }, Math.min(2_000, completionQuietMs));
                  return;
                }
              } else {
                completionSignalMtimeMs = undefined;
                completionStableSince = undefined;
              }
              await delay(Math.min(250, completionQuietMs));
            }
          })()
          : undefined;

        const stallLoop = (async () => {
          while (child.exitCode === null && !child.killed && !completionTriggered) {
            for (const candidatePath of activityFilePaths) {
              const nextMtimeMs = await fileContentMtimeMs(candidatePath);
              const previousMtimeMs = activityFileMtimes.get(candidatePath);
              if (nextMtimeMs !== previousMtimeMs) {
                activityFileMtimes.set(candidatePath, nextMtimeMs);
                if (nextMtimeMs !== undefined) lastObservedActivityAt = Date.now();
              }
            }
            if (Date.now() - lastObservedActivityAt >= stallTimeoutMs) {
              stalled = true;
              stallMessage = `codex exec stalled after ${stallTimeoutMs}ms without output or completion updates`;
              child.kill("SIGTERM");
              stallKillTimer = setTimeout(() => {
                if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
              }, Math.min(2_000, stallPollMs * 2));
              return;
            }
            await delay(stallPollMs);
          }
        })();

        const shouldAbort = control?.shouldAbort;
        const pollSignal = control?.pollSignal;
        const abortLoop = shouldAbort || pollSignal
          ? (async () => {
            while (child.exitCode === null && !child.killed) {
              const nextSignal = pollSignal ? await pollSignal() : undefined;
              if (nextSignal) {
                controlSignal = nextSignal;
                child.kill("SIGTERM");
                return;
              }
              if (shouldAbort && await shouldAbort()) {
                controlSignal = { kind: "abort" };
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
            if (stallKillTimer) clearTimeout(stallKillTimer);
            try {
              if (child.pid && control?.onChildExit) {
                await Promise.resolve(control.onChildExit({
                  pid: child.pid,
                  command: [this.bin, ...args].join(" "),
                  workspacePath: input.workspacePath,
                  startedAt: childStartedAt,
                  exitCode: code,
                  signal,
                })).catch(() => undefined);
              }
              if (input.jsonOutput && stdoutJsonBuffer.trim()) {
                consumeJsonStdout("\n");
              }
              await progressChain;
              await lastMessageWriteChain;
              await Promise.all([closeStream(stdoutFile), closeStream(stderrFile)]);
              const lastMessage = await fsp.readFile(input.lastMessagePath, "utf-8").catch(() => "");
              const resolvedLastMessage = lastMessage.trim() || latestStructuredLastMessage?.trim() || undefined;
              resolve({
                exitCode: completionTriggered ? 0 : timedOut ? 124 : code,
                signal: completionTriggered ? null : signal,
                stdout,
                stderr,
                lastMessage: resolvedLastMessage,
                tokensUsed: structuredTokensUsed ?? extractTokensUsed(stdout, stderr),
                progressAt,
                latestEventType,
                latestEventText,
              });
            } catch (err) {
              reject(err);
            }
          });
        });

        await completionLoop;
        await stallLoop;
        await abortLoop;
        if (timedOut) {
          const elapsed = Date.now() - startedAt;
          throw new Error(`codex exec timed out after ${elapsed}ms`);
        }
        if (stalled) {
          throw new Error(stallMessage);
        }
        if (controlSignal) {
          throw new CodexControlSignalError(controlSignal, result);
        }
        if (result.signal === "SIGTERM") {
          throw new Error("codex exec aborted");
        }
        if ((result.exitCode ?? 1) !== 0) {
          const summary = (result.stderr.trim() || result.stdout.trim() || `codex exited with ${result.exitCode}`).slice(0, 1_000);
          throw new CodexExecutionError(summary, result, sandboxMode ?? "danger-full-access", mutationPolicy);
        }
        return result;
      };

      return await execute(initialSandboxMode);
    } finally {
      if (isolatedCodexHome) {
        await fsp.rm(isolatedCodexHome, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
