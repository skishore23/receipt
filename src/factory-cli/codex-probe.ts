import fs from "node:fs/promises";
import path from "node:path";

import { LocalCodexExecutor } from "../adapters/codex-executor";
import { sqliteBranchStore, sqliteReceiptStore } from "../adapters/sqlite";
import { sqliteQueue, type QueueJob } from "../adapters/sqlite-queue";
import { runFactoryCodexJob } from "../agents/factory-chat";
import { createRuntime } from "@receipt/core/runtime";
import { JobWorker } from "../engine/runtime/job-worker";
import { SseHub } from "../framework/sse-hub";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../modules/job";
import { createFactoryServiceRuntime, createFactoryWorkerHandlers } from "../services/factory-runtime";
import type { FactoryCliConfig } from "./config";

export type CodexProbeMode = "direct" | "queue" | "both";

type ProbeArtifacts = {
  readonly root: string;
  readonly lastMessagePath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
};

export type CodexProbeSnapshot = {
  readonly at: number;
  readonly elapsedMs: number;
  readonly status: string;
  readonly summary?: string;
  readonly lastMessage?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
};

export type CodexProbeRunReport = {
  readonly ok: boolean;
  readonly mode: "direct" | "queue";
  readonly jobId: string;
  readonly artifacts: ProbeArtifacts;
  readonly snapshots: ReadonlyArray<CodexProbeSnapshot>;
  readonly finalStatus: string;
  readonly finalSummary?: string;
  readonly error?: string;
  readonly rawFinal?: unknown;
};

export type CodexProbeReport = {
  readonly ok: boolean;
  readonly mode: CodexProbeMode;
  readonly prompt: string;
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly codexBin: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly direct?: CodexProbeRunReport;
  readonly queue?: CodexProbeRunReport;
};

type RunProbeOptions = {
  readonly mode: CodexProbeMode;
  readonly prompt: string;
  readonly dataDir: string;
  readonly pollMs: number;
  readonly timeoutMs: number;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isTerminalJobStatus = (status: string | undefined): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const clip = (value: string | undefined, max: number): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : `...${trimmed.slice(trimmed.length - max + 3)}`;
};

const probeArtifacts = (dataDir: string, jobId: string): ProbeArtifacts => {
  const root = path.join(dataDir, "factory-chat", "codex", jobId);
  return {
    root,
    lastMessagePath: path.join(root, "last-message.txt"),
    stdoutPath: path.join(root, "stdout.log"),
    stderrPath: path.join(root, "stderr.log"),
  };
};

const readArtifactTails = async (artifacts: ProbeArtifacts): Promise<{
  readonly lastMessage?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
}> => {
  const [lastMessageRaw, stdoutRaw, stderrRaw] = await Promise.all([
    fs.readFile(artifacts.lastMessagePath, "utf-8").catch(() => ""),
    fs.readFile(artifacts.stdoutPath, "utf-8").catch(() => ""),
    fs.readFile(artifacts.stderrPath, "utf-8").catch(() => ""),
  ]);
  return {
    lastMessage: asString(lastMessageRaw),
    stdoutTail: clip(stdoutRaw, 500),
    stderrTail: clip(stderrRaw, 500),
  };
};

const queueSummary = (job: QueueJob): string | undefined => {
  const result = asRecord(job.result);
  const failure = asRecord(result?.failure);
  return (job.status === "failed"
    ? job.lastError ?? asString(failure?.message)
    : job.status === "canceled"
      ? job.canceledReason ?? asString(result?.note)
      : undefined)
    ?? asString(result?.summary)
    ?? asString(result?.finalResponse)
    ?? asString(result?.note)
    ?? asString(result?.message)
    ?? asString(failure?.message)
    ?? job.lastError;
};

const snapshotFromQueueJob = (job: QueueJob, startedAt: number): CodexProbeSnapshot => {
  const result = asRecord(job.result);
  return {
    at: Date.now(),
    elapsedMs: Math.max(0, Date.now() - startedAt),
    status: job.status,
    summary: queueSummary(job),
    lastMessage: asString(result?.lastMessage),
    stdoutTail: clip(asString(result?.stdoutTail), 500),
    stderrTail: clip(asString(result?.stderrTail), 500),
  };
};

const snapshotFromProgress = (progress: Record<string, unknown>, startedAt: number): CodexProbeSnapshot => ({
  at: Date.now(),
  elapsedMs: Math.max(0, Date.now() - startedAt),
  status: asString(progress.status) ?? "running",
  summary: asString(progress.summary),
  lastMessage: asString(progress.lastMessage),
  stdoutTail: clip(asString(progress.stdoutTail), 500),
  stderrTail: clip(asString(progress.stderrTail), 500),
});

const pushSnapshot = (
  snapshots: CodexProbeSnapshot[],
  seen: Set<string>,
  snapshot: CodexProbeSnapshot,
): void => {
  const fingerprint = JSON.stringify({
    status: snapshot.status,
    summary: snapshot.summary,
    lastMessage: snapshot.lastMessage,
    stdoutTail: snapshot.stdoutTail,
    stderrTail: snapshot.stderrTail,
  });
  if (seen.has(fingerprint)) return;
  seen.add(fingerprint);
  snapshots.push(snapshot);
};

const directJobId = (): string =>
  `probe_direct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const queueSessionKey = (): string =>
  `factory.codex.probe:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

const runDirectProbe = async (
  config: FactoryCliConfig,
  opts: RunProbeOptions,
): Promise<CodexProbeRunReport> => {
  const jobId = directJobId();
  const artifacts = probeArtifacts(opts.dataDir, jobId);
  const snapshots: CodexProbeSnapshot[] = [];
  const seen = new Set<string>();
  const startedAt = Date.now();
  try {
    const final = await runFactoryCodexJob({
      dataDir: opts.dataDir,
      repoRoot: config.repoRoot,
      jobId,
      prompt: opts.prompt,
      timeoutMs: opts.timeoutMs,
      executor: new LocalCodexExecutor({
        bin: config.codexBin,
        timeoutMs: opts.timeoutMs,
      }),
      onProgress: async (update) => {
        pushSnapshot(snapshots, seen, snapshotFromProgress(update, startedAt));
      },
    });
    pushSnapshot(snapshots, seen, {
      at: Date.now(),
      elapsedMs: Math.max(0, Date.now() - startedAt),
      status: asString(final.status) ?? "completed",
      summary: asString(final.summary),
      lastMessage: asString(final.lastMessage),
      stdoutTail: clip(asString(final.stdoutTail), 500),
      stderrTail: clip(asString(final.stderrTail), 500),
    });
    return {
      ok: true,
      mode: "direct",
      jobId,
      artifacts,
      snapshots,
      finalStatus: "completed",
      finalSummary: asString(final.summary),
      rawFinal: final,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const tails = await readArtifactTails(artifacts);
    pushSnapshot(snapshots, seen, {
      at: Date.now(),
      elapsedMs: Math.max(0, Date.now() - startedAt),
      status: "failed",
      summary: error,
      lastMessage: tails.lastMessage,
      stdoutTail: tails.stdoutTail,
      stderrTail: tails.stderrTail,
    });
    return {
      ok: false,
      mode: "direct",
      jobId,
      artifacts,
      snapshots,
      finalStatus: "failed",
      finalSummary: error,
      error,
      rawFinal: { error },
    };
  }
};

const runQueueProbe = async (
  config: FactoryCliConfig,
  opts: RunProbeOptions,
): Promise<CodexProbeRunReport> => {
  const jobRuntime = createRuntime<JobCmd, JobEvent, JobState>(
    sqliteReceiptStore<JobEvent>(opts.dataDir),
    sqliteBranchStore(opts.dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );
  const queue = sqliteQueue({
    runtime: jobRuntime,
    stream: "jobs",
  });
  const { service } = createFactoryServiceRuntime({
    dataDir: opts.dataDir,
    queue,
    jobRuntime,
    sse: new SseHub(),
    repoRoot: config.repoRoot,
    codexBin: config.codexBin,
    repoSlotConcurrency: config.repoSlotConcurrency,
  });
  const handlers = createFactoryWorkerHandlers(service);
  const worker = new JobWorker({
    queue,
    workerId: `factory_codex_probe_${process.pid}`,
    idleResyncMs: Math.max(250, opts.pollMs),
    leaseMs: Math.max(120_000, Math.min(opts.timeoutMs, 120_000)),
    concurrency: 1,
    leaseAgentIds: Object.keys(handlers),
    handlers,
    onLeaseRenewal: (event) => {
      console.error(JSON.stringify({ type: "job.lease_renewed", scope: "codex-probe", ...event }));
    },
  });
  const snapshots: CodexProbeSnapshot[] = [];
  const seen = new Set<string>();
  const startedAt = Date.now();
  const runId = `probe_run_${startedAt.toString(36)}`;
  const stream = `factory/probes/${runId}`;
  let jobId = `probe_queue_${startedAt.toString(36)}`;
  try {
    await service.ensureBootstrap();
    worker.start();
    const queued = await queue.enqueue({
      jobId,
      agentId: "codex",
      lane: "collect",
      sessionKey: queueSessionKey(),
      singletonMode: "allow",
      maxAttempts: 1,
      payload: {
        kind: "factory.codex.run",
        prompt: opts.prompt,
        task: opts.prompt,
        timeoutMs: opts.timeoutMs,
        runId,
        stream,
        parentRunId: runId,
        parentStream: stream,
        profileId: "codex-probe",
      },
    });
    jobId = queued.id;
    pushSnapshot(snapshots, seen, snapshotFromQueueJob(queued, startedAt));
    const deadline = Date.now() + opts.timeoutMs + 15_000;
    while (Date.now() <= deadline) {
      const current = await queue.getJob(jobId);
      if (current) {
        pushSnapshot(snapshots, seen, snapshotFromQueueJob(current, startedAt));
        if (isTerminalJobStatus(current.status)) {
          const finalSummary = queueSummary(current);
          return {
            ok: current.status === "completed",
            mode: "queue",
            jobId,
            artifacts: probeArtifacts(opts.dataDir, jobId),
            snapshots,
            finalStatus: current.status,
            finalSummary,
            error: current.status === "completed" ? undefined : finalSummary ?? `queue job ${jobId} ${current.status}`,
            rawFinal: current,
          };
        }
      }
      await sleep(opts.pollMs);
    }
    await queue.queueCommand({
      jobId,
      command: "abort",
      payload: { reason: "codex probe timeout" },
      by: "factory.codex-probe",
    });
    const aborted = await queue.waitForJob(jobId, 15_000);
    if (aborted) pushSnapshot(snapshots, seen, snapshotFromQueueJob(aborted, startedAt));
    return {
      ok: false,
      mode: "queue",
      jobId,
      artifacts: probeArtifacts(opts.dataDir, jobId),
      snapshots,
      finalStatus: aborted?.status ?? "failed",
      finalSummary: (aborted ? queueSummary(aborted) : undefined) ?? "codex probe timed out before terminal status was captured",
      error: "codex probe timed out before terminal status was captured",
      rawFinal: aborted,
    };
  } finally {
    worker.stop();
  }
};

const oneLine = (value: string | undefined, max = 160): string | undefined => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
};

const renderRunText = (run: CodexProbeRunReport): string => {
  const lines = [
    `job=${run.jobId}`,
    `final=${run.finalStatus}`,
    run.finalSummary ? `summary=${oneLine(run.finalSummary, 220)}` : undefined,
    `artifacts=${run.artifacts.root}`,
    `last_message=${run.artifacts.lastMessagePath}`,
    `stdout=${run.artifacts.stdoutPath}`,
    `stderr=${run.artifacts.stderrPath}`,
    "",
    "snapshots:",
    ...run.snapshots.map((snapshot) => {
      const suffix = oneLine(snapshot.summary ?? snapshot.lastMessage ?? snapshot.stderrTail ?? snapshot.stdoutTail, 160);
      return `  ${String(snapshot.elapsedMs).padStart(5, " ")}ms  ${snapshot.status}${suffix ? `  ${suffix}` : ""}`;
    }),
    run.error ? "" : undefined,
    run.error ? `error=${oneLine(run.error, 220)}` : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
};

export const renderCodexProbeText = (report: CodexProbeReport): string => {
  const sections = [
    "Codex probe",
    `mode=${report.mode}`,
    `repo_root=${report.repoRoot}`,
    `probe_data_dir=${report.dataDir}`,
    `codex_bin=${report.codexBin}`,
    `timeout_ms=${report.timeoutMs}`,
    `poll_ms=${report.pollMs}`,
    `prompt=${oneLine(report.prompt, 220)}`,
  ];
  if (report.direct) {
    sections.push("", "== Direct ==", renderRunText(report.direct));
  }
  if (report.queue) {
    sections.push("", "== Queue ==", renderRunText(report.queue));
  }
  sections.push("", `ok=${String(report.ok)}`);
  return sections.join("\n");
};

export const runFactoryCodexProbe = async (
  config: FactoryCliConfig,
  opts: RunProbeOptions,
): Promise<CodexProbeReport> => {
  await fs.mkdir(opts.dataDir, { recursive: true });
  const direct = opts.mode === "direct" || opts.mode === "both"
    ? await runDirectProbe(config, opts)
    : undefined;
  const queue = opts.mode === "queue" || opts.mode === "both"
    ? await runQueueProbe(config, opts)
    : undefined;
  return {
    ok: [direct, queue].filter(Boolean).every((run) => run?.ok !== false),
    mode: opts.mode,
    prompt: opts.prompt,
    repoRoot: config.repoRoot,
    dataDir: opts.dataDir,
    codexBin: config.codexBin,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    direct,
    queue,
  };
};
