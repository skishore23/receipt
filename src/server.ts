// ============================================================================
// Server - Hono transport + manifest-based routing
// ============================================================================

import fs from "node:fs";
import path from "node:path";

import { Hono } from "hono";

import type { JobBackend } from "./adapters/job-backend";
import { jsonlStore, jsonBranchStore } from "./adapters/jsonl";
import { jsonlQueue, type EnqueueJobInput, type QueueJob } from "./adapters/jsonl-queue";
import {
  createMemoryTools,
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
} from "./adapters/memory-tools";
import { createDelegationTools } from "./adapters/delegation";
import { createHeartbeat, parseHeartbeatSpecsFromEnv } from "./adapters/heartbeat";
import { resonateJobBackend } from "./adapters/resonate-job-backend";
import { createResonateDriverStarter, createResonateRoleRuntime } from "./adapters/resonate-runtime";
import { resolveProcessRole } from "./adapters/resonate-config";
import { createRuntime } from "@receipt/core/runtime";
import type { JobCmd, JobEvent, JobState } from "./modules/job";
import { decide as decideJob, reduce as reduceJob, initial as initialJob } from "./modules/job";
import type { AgentCmd, AgentEvent } from "./modules/agent";
import { decide as decideAgent, reduce as reduceAgent, initial as initialAgent } from "./modules/agent";
import { llmStructured, llmText, embed } from "./adapters/openai";
import { loadAgentPrompts, hashAgentPrompts } from "./prompts/agent";
import { normalizeAgentConfig } from "./agents/agent";
import { createQueuedBudgetContinuation, parseContinuationDepth } from "./agents/agent-continuation";
import { runOrchestrator, normalizeFactoryChatConfig, runFactoryCodexJob } from "./agents/orchestrator";
import { emitToContinuedRun, resolveContinuedRunTarget } from "./agents/run-target";
import { createFactoryServiceRuntime, createFactoryWorkerHandlers } from "./services/factory-runtime";
import { FACTORY_CONTROL_AGENT_ID, type FactoryService } from "./services/factory-service";
import { shouldQueueObjectiveAudit, shouldQueueObjectiveControlReconcile } from "./services/factory-job-gates";
import { loadAgentRoutes } from "./framework/agent-loader";
import { SseHub } from "./framework/sse-hub";
import { makeEventId, text } from "./framework/http";
import { JobWorker, type JobHandler } from "./engine/runtime/job-worker";
import { deriveJobFailureDecision } from "./engine/runtime/job-failure-policy";
import { registerResonateAgentActionWorker } from "./engine/runtime/resonate-agent-actions";
import { resolveFactoryRuntimeConfig } from "./factory-cli/config";
import {
  renderFactoryStreamingResetFragment,
  renderFactoryStreamingTokenFragment,
} from "./views/factory/transcript";
import { getReceiptDb, listChangesAfter, pollLatestChangeSeq } from "./db/client";

// ============================================================================
// Config
// ============================================================================

const PORT = Number(process.env.PORT ?? 8787);
const FACTORY_RUNTIME = await resolveFactoryRuntimeConfig(process.cwd());
const WORKSPACE_ROOT = FACTORY_RUNTIME.repoRoot;
const DATA_DIR = FACTORY_RUNTIME.dataDir;
const JOB_BACKEND = process.env.JOB_BACKEND === "resonate" ? "resonate" : "local";
console.log(JSON.stringify({
  level: "info",
  event: "factory_server_startup",
  shellPath: FACTORY_RUNTIME.shell.shellPath ?? null,
  execMode: FACTORY_RUNTIME.shell.execMode,
  shellSource: FACTORY_RUNTIME.shell.source,
}));
const STARTUP_SETTLE_MS = (() => {
  const fallback = JOB_BACKEND === "resonate" ? 1_000 : 0;
  const parsed = Number(process.env.RESONATE_STARTUP_SETTLE_MS ?? fallback);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
})();
const PROCESS_ROLE = JOB_BACKEND === "resonate" && !process.env.RECEIPT_PROCESS_ROLE
  ? "api"
  : resolveProcessRole(process.env.RECEIPT_PROCESS_ROLE);

// ============================================================================
// Composition: Store -> Runtime
// ============================================================================

const makeStore = <E,>() => jsonlStore<E>(DATA_DIR);

const branchStore = jsonBranchStore(DATA_DIR);

const agentStore = makeStore<AgentEvent>();
const agentRuntime = createRuntime(
  agentStore,
  branchStore,
  decideAgent,
  reduceAgent,
  initialAgent
);

const jobStore = makeStore<JobEvent>();
const jobRuntime = createRuntime<JobCmd, JobEvent, JobState>(
  jobStore,
  branchStore,
  decideJob,
  reduceJob,
  initialJob
);

const memoryStore = makeStore<MemoryEvent>();
const memoryRuntime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
  memoryStore,
  branchStore,
  decideMemory,
  reduceMemory,
  initialMemoryState
);

// ============================================================================
// Prompts + Models
// ============================================================================

const AGENT_PROMPTS = loadAgentPrompts();
const AGENT_PROMPTS_HASH = hashAgentPrompts(AGENT_PROMPTS);
const AGENT_PROMPTS_PATH = "prompts/agent.prompts.json";
const AGENT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";
const FACTORY_CHAT_MODEL =
  process.env.RECEIPT_FACTORY_CHAT_MODEL?.trim()
  || process.env.HUB_FACTORY_CHAT_MODEL?.trim()
  || process.env.OPENAI_MODEL
  || "gpt-5.4-mini";

const JOB_STREAM = "jobs";
const jobWorkerId = process.env.JOB_WORKER_ID ?? `worker_${process.pid}`;
const parseWorkerConcurrency = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
};
const chatJobConcurrency = parseWorkerConcurrency(process.env.CHAT_JOB_CONCURRENCY, 50);
const orchestrationJobConcurrency = parseWorkerConcurrency(process.env.ORCHESTRATION_JOB_CONCURRENCY, 20);
const codexJobConcurrency = parseWorkerConcurrency(process.env.CODEX_JOB_CONCURRENCY, 30);
const jobIdleResyncMs = Number(process.env.JOB_IDLE_RESYNC_MS ?? process.env.JOB_POLL_MS ?? 5_000);
const jobLeaseMs = Number(process.env.JOB_LEASE_MS ?? 300_000);
const codexJobLeaseMs = Number(process.env.CODEX_JOB_LEASE_MS ?? 900_000);
const subJobWaitMsRaw = Number(process.env.SUBJOB_WAIT_MS ?? 1_500);
const subJobWaitMs = Number.isFinite(subJobWaitMsRaw)
  ? Math.max(0, Math.min(Math.floor(subJobWaitMsRaw), 30_000))
  : 1_500;
const subJobPollMsRaw = Number(process.env.SUBJOB_WAIT_POLL_MS ?? 250);
const subJobPollMs = Number.isFinite(subJobPollMsRaw)
  ? Math.max(20, Math.min(Math.floor(subJobPollMsRaw), 2_000))
  : 250;
const subJobJoinWaitMsRaw = Number(process.env.SUBJOB_JOIN_WAIT_MS ?? 180_000);
const subJobJoinWaitMs = Number.isFinite(subJobJoinWaitMsRaw)
  ? Math.max(0, Math.min(Math.floor(subJobJoinWaitMsRaw), 600_000))
  : 180_000;

const sse = new SseHub();
const memoryTools = createMemoryTools({
  dir: DATA_DIR,
  runtime: memoryRuntime,
  embed: process.env.OPENAI_API_KEY ? embed : undefined,
});
const objectiveIdForJob = (job: { readonly payload: Record<string, unknown>; readonly result?: unknown } | undefined): string | undefined => {
  if (!job) return undefined;
  const payloadObjectiveId = typeof job.payload.objectiveId === "string" && job.payload.objectiveId.trim()
    ? job.payload.objectiveId.trim()
    : undefined;
  if (payloadObjectiveId) return payloadObjectiveId;
  const result = job.result && typeof job.result === "object" && !Array.isArray(job.result)
    ? job.result as Record<string, unknown>
    : undefined;
  return typeof result?.objectiveId === "string" && result.objectiveId.trim()
    ? result.objectiveId.trim()
    : undefined;
};

const profileIdForJob = (job: { readonly payload: Record<string, unknown>; readonly result?: unknown } | undefined): string | undefined => {
  if (!job) return undefined;
  const payloadProfile = job.payload.profile;
  if (payloadProfile && typeof payloadProfile === "object" && !Array.isArray(payloadProfile)) {
    const rootProfileId = typeof (payloadProfile as { readonly rootProfileId?: unknown }).rootProfileId === "string"
      ? (payloadProfile as { readonly rootProfileId: string }).rootProfileId.trim()
      : "";
    if (rootProfileId) return rootProfileId;
  }
  const payloadProfileId = typeof job.payload.profileId === "string" && job.payload.profileId.trim()
    ? job.payload.profileId.trim()
    : undefined;
  if (payloadProfileId) return payloadProfileId;
  const result = job.result && typeof job.result === "object" && !Array.isArray(job.result)
    ? job.result as Record<string, unknown>
    : undefined;
  if (result?.profile && typeof result.profile === "object" && !Array.isArray(result.profile)) {
    const rootProfileId = typeof (result.profile as { readonly rootProfileId?: unknown }).rootProfileId === "string"
      ? (result.profile as { readonly rootProfileId: string }).rootProfileId.trim()
      : "";
    if (rootProfileId) return rootProfileId;
  }
  return typeof result?.profileId === "string" && result.profileId.trim()
    ? result.profileId.trim()
    : undefined;
};

const agentStreamForJob = (job: { readonly payload: Record<string, unknown> } | undefined): string | undefined => {
  if (!job) return undefined;
  const payloadKind = typeof job.payload.kind === "string" ? job.payload.kind.trim() : "";
  const payloadStream = typeof job.payload.stream === "string" && job.payload.stream.trim()
    ? job.payload.stream.trim()
    : undefined;
  if (payloadKind !== "factory.run") return undefined;
  return payloadStream;
};

let queueImpl: JobBackend | undefined;
let factoryServiceRef: FactoryService | undefined;

const shouldQueueFactoryTaskReconcile = async (objectiveId: string, sourceUpdatedAt: number): Promise<boolean> => {
  const queue = queueImpl;
  const factoryService = factoryServiceRef;
  const [recentJobs, detail] = await Promise.all([
    queue?.listJobs({ limit: 200 }) ?? Promise.resolve([]),
    factoryService?.getObjective(objectiveId).catch(() => undefined) ?? Promise.resolve(undefined),
  ]);
  return shouldQueueObjectiveControlReconcile({
    controlAgentId: FACTORY_CONTROL_AGENT_ID,
    objectiveId,
    recentJobs,
    sourceUpdatedAt,
    objectiveInactive: detail != null && isTerminalObjectiveStatus(detail.status),
  });
};

const isTerminalObjectiveStatus = (status: unknown): boolean =>
  status === "completed" || status === "blocked" || status === "canceled" || status === "failed";

const shouldQueueFactoryObjectiveAudit = async (objectiveId: string, objectiveUpdatedAt: number): Promise<boolean> => {
  const queue = queueImpl;
  return shouldQueueObjectiveAudit({
    controlAgentId: FACTORY_CONTROL_AGENT_ID,
    objectiveId,
    objectiveUpdatedAt,
    recentJobs: queue ? await queue.listJobs({ limit: 200 }) : [],
  });
};

const baseQueue = jsonlQueue({
  runtime: jobRuntime,
  stream: JOB_STREAM,
  watchDir: DATA_DIR,
  expireLeasesOnRefresh: JOB_BACKEND === "local",
  fullRefreshWindowMs: Number(process.env.RESONATE_QUEUE_FULL_REFRESH_MS ?? (JOB_BACKEND === "resonate" ? 300_000 : 30_000)),
  onJobChange: async (jobs) => {
    for (const job of jobs) {
      sse.publish("jobs", job.id);
      const agentStream = agentStreamForJob(job ? { payload: job.payload as Record<string, unknown> } : undefined);
      if (agentStream) sse.publish("agent", agentStream);
      const objectiveId = objectiveIdForJob(job
        ? {
            payload: job.payload as Record<string, unknown>,
            result: job.result,
          }
        : undefined);
      if (objectiveId) {
        sse.publish("factory", objectiveId);
        sse.publish("objective-runtime", objectiveId);
      }
      const profileId = profileIdForJob(job
        ? {
            payload: job.payload as Record<string, unknown>,
            result: job.result,
          }
        : undefined);
      if (profileId) sse.publish("profile-board", profileId);

      // Structurally sound auto-recovery for crashed/expired factory jobs
      // We enqueue a control job to reconcile the objective so the orchestrator
      // naturally picks it up, avoiding mutable global state or direct side-effects.
      if ((job.status === "failed" || job.status === "canceled") && typeof job.payload === "object" && job.payload && job.payload.kind === "factory.task.run") {
        if (objectiveId && await shouldQueueFactoryTaskReconcile(objectiveId, job.updatedAt)) {
          queue.enqueue({
            agentId: "factory-control",
            lane: "collect",
            sessionKey: `factory:objective:${objectiveId}`,
            singletonMode: "steer",
            maxAttempts: 1,
            payload: {
              kind: "factory.objective.control",
              objectiveId,
              reason: "reconcile",
            },
          }).catch(console.error);
        }
      }

      if (
        objectiveId
        && (job.status === "completed" || job.status === "failed" || job.status === "canceled")
        && typeof job.payload === "object"
        && job.payload
        && job.payload.kind !== "factory.objective.audit"
      ) {
        const factoryService = factoryServiceRef;
        if (factoryService) {
          const detail = await factoryService.getObjective(objectiveId).catch(() => undefined);
          if (detail && isTerminalObjectiveStatus(detail.status) && await shouldQueueFactoryObjectiveAudit(objectiveId, detail.updatedAt)) {
            queue.enqueue({
              agentId: FACTORY_CONTROL_AGENT_ID,
              lane: "collect",
              sessionKey: `factory:audit:${objectiveId}`,
              singletonMode: "steer",
              maxAttempts: 1,
              payload: {
                kind: "factory.objective.audit",
                objectiveId,
                objectiveStatus: detail.status,
                objectiveUpdatedAt: detail.updatedAt,
              },
            }).catch(console.error);
          }
        }
      }
    }
    sse.publish("receipt");
  },
});
queueImpl = baseQueue;
const queue: JobBackend = {
  enqueue: (input) => queueImpl!.enqueue(input),
  leaseNext: (opts) => queueImpl!.leaseNext(opts),
  leaseJob: (jobId, workerId, leaseMs) => queueImpl!.leaseJob(jobId, workerId, leaseMs),
  heartbeat: (jobId, workerId, leaseMs) => queueImpl!.heartbeat(jobId, workerId, leaseMs),
  progress: (jobId, workerId, result) => queueImpl!.progress(jobId, workerId, result),
  complete: (jobId, workerId, result) => queueImpl!.complete(jobId, workerId, result),
  fail: (jobId, workerId, error, noRetry, result) => queueImpl!.fail(jobId, workerId, error, noRetry, result),
  cancel: (jobId, reason, by) => queueImpl!.cancel(jobId, reason, by),
  queueCommand: (input) => queueImpl!.queueCommand(input),
  consumeCommands: (jobId, filter) => queueImpl!.consumeCommands(jobId, filter),
  getJob: (jobId) => queueImpl!.getJob(jobId),
  listJobs: (opts) => queueImpl!.listJobs(opts),
  waitForJob: (jobId, timeoutMs, pollMs) => queueImpl!.waitForJob(jobId, timeoutMs, pollMs),
  waitForWork: (opts) => queueImpl!.waitForWork(opts),
  notifyWorkAvailable: () => queueImpl!.notifyWorkAvailable(),
  snapshot: () => queueImpl!.snapshot(),
  refresh: () => queueImpl!.refresh(),
};

const enqueueJob = async (job: EnqueueJobInput): Promise<void> => {
  const created = await queue.enqueue(job);
  sse.publish("jobs", created.id);
};

const createRunControl = (jobId: string) => ({
  jobId,
  checkAbort: async (): Promise<boolean> => {
    const job = await queue.getJob(jobId);
    if (!job) return false;
    if (job.status === "canceled") return true;
    if (job.abortRequested) return true;
    const abortCommands = await queue.consumeCommands(jobId, ["abort"]);
    return abortCommands.length > 0;
  },
  pullCommands: async (): Promise<ReadonlyArray<{ command: "steer" | "follow_up"; payload?: Record<string, unknown> }>> => {
    const commands = await queue.consumeCommands(jobId, ["steer", "follow_up"]);
    return commands
      .filter((cmd): cmd is typeof cmd & { command: "steer" | "follow_up" } =>
        cmd.command === "steer" || cmd.command === "follow_up"
      )
      .map((cmd) => ({ command: cmd.command, payload: cmd.payload }));
  },
});

// ============================================================================
// Agent Runner Factory
// ============================================================================

type AgentRunControl = {
  readonly jobId?: string;
  readonly checkAbort?: () => Promise<boolean>;
  readonly pullCommands?: () => Promise<ReadonlyArray<{ command: "steer" | "follow_up"; payload?: Record<string, unknown> }>>;
};

type AgentRunner = (
  payload: Record<string, unknown>,
  control?: AgentRunControl
) => Promise<Record<string, unknown> | void>;

const extractRunPayload = (payload: Record<string, unknown>, defaultStream: string) => ({
  stream: typeof payload.stream === "string" && payload.stream.trim() ? payload.stream : defaultStream,
  runId: typeof payload.runId === "string" && payload.runId.trim()
    ? payload.runId
    : `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  runStream: typeof payload.runStream === "string" && payload.runStream.trim().length > 0
    ? payload.runStream
    : undefined,
  problem: typeof payload.problem === "string" ? payload.problem : "",
});

const apiStatus = () => {
  const apiReady = Boolean(process.env.OPENAI_API_KEY);
  return { apiReady, apiNote: apiReady ? undefined : "OPENAI_API_KEY not set" } as const;
};

type AgentRunnerSpec = {
  readonly defaultAgentId: string;
  readonly defaultStream: string;
  readonly jobKind: string;
  readonly sseTopic: "agent";
  readonly sseTokenEvent: string;
  readonly sseHtmlTokenEvent?: string;
  readonly sseResetEvent?: string;
  readonly normalizeConfig: (input: Record<string, unknown>) => unknown;
  readonly runtime: unknown;
  readonly prompts: unknown;
  readonly model: string;
  readonly promptHash: string;
  readonly promptPath: string;
  readonly runFn: (input: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  readonly extras?: Record<string, unknown>;
  readonly autoContinueOnBudget?: boolean;
};

const createAgentRunner = (spec: AgentRunnerSpec): AgentRunner =>
  async (payload, control) => {
    const { stream, runId, runStream, problem } = extractRunPayload(payload, spec.defaultStream);
    const supervisorSessionId = typeof payload.supervisorSessionId === "string" && payload.supervisorSessionId.trim().length > 0
      ? payload.supervisorSessionId.trim()
      : runId;
    const configInput = typeof payload.config === "object" && payload.config
      ? payload.config as Record<string, unknown> : {};
    const config = spec.normalizeConfig(configInput);
    const { apiReady, apiNote } = apiStatus();
    const payloadWithSession = {
      ...payload,
      supervisorSessionId,
    };
    const publishStreamingReset = () => {
      if (!spec.sseResetEvent) return;
      sse.publishData(spec.sseTopic, stream, spec.sseResetEvent, renderFactoryStreamingResetFragment());
    };
    const onIterationBudgetExhausted = spec.autoContinueOnBudget
      ? createQueuedBudgetContinuation({
        queue,
        agentId: spec.defaultAgentId,
        jobKind: spec.jobKind,
        stream,
        payload: payloadWithSession,
        continuationDepth: parseContinuationDepth(payload.continuationDepth),
      })
      : undefined;
    publishStreamingReset();
    try {
      const runnerResult = await spec.runFn({
        ...payloadWithSession,
        stream, runId, runStream, problem, config,
        runtime: spec.runtime, prompts: spec.prompts,
        llmText: (opts: Record<string, unknown>) => llmText({
          ...(opts as { system?: string; user: string }),
          onDelta: async (delta) => {
            if (!delta) return;
            sse.publishData(spec.sseTopic, stream, spec.sseTokenEvent, JSON.stringify({ runId, delta }));
            if (spec.sseHtmlTokenEvent) {
              sse.publishData(
                spec.sseTopic,
                stream,
                spec.sseHtmlTokenEvent,
                renderFactoryStreamingTokenFragment({ runId, delta }),
              );
            }
          },
        }),
        model: spec.model, promptHash: spec.promptHash, promptPath: spec.promptPath,
        apiReady, apiNote, control,
        onIterationBudgetExhausted,
        broadcast: () => { sse.publish(spec.sseTopic, stream); sse.publish("receipt"); },
        ...(spec.extras ?? {}),
      });
      return {
        runId,
        stream,
        ...(runnerResult ?? {}),
      };
    } finally {
      publishStreamingReset();
    }
  };

const delegationTools = createDelegationTools({
  enqueue: async (opts) => {
    const created = await queue.enqueue({
      agentId: opts.agentId,
      payload: opts.payload,
      lane: "collect",
      singletonMode: "allow",
      maxAttempts: 2,
    });
    sse.publish("jobs", created.id);
    return { id: created.id };
  },
  waitForJob: async (jobId, timeoutMs) => {
    const job = await queue.waitForJob(jobId, timeoutMs, subJobPollMs);
    if (!job) throw new Error(`job ${jobId} not found`);
    return { id: job.id, status: job.status, result: job.result, lastError: job.lastError };
  },
  getJob: async (jobId) => {
    const job = await queue.getJob(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    return { id: job.id, status: job.status, result: job.result, lastError: job.lastError };
  },
  dataDir: DATA_DIR,
});

const redriveQueuedJobRef = JOB_BACKEND === "resonate"
  ? {
      current: undefined as (((job: QueueJob) => Promise<void>) | undefined),
      lastAttemptAt: new Map<string, number>(),
    }
  : undefined;

const { service: factoryService } = createFactoryServiceRuntime({
  dataDir: DATA_DIR,
  queue,
  jobRuntime,
  sse,
  repoRoot: WORKSPACE_ROOT,
  codexBin: FACTORY_RUNTIME.codexBin,
  memoryTools,
  redriveQueuedJob: redriveQueuedJobRef
    ? async (job) => {
        await redriveQueuedJobRef.current?.(job);
      }
    : undefined,
});
factoryServiceRef = factoryService;
const factoryWorkerHandlers = createFactoryWorkerHandlers(factoryService);
const agentRunner = createAgentRunner({
  defaultAgentId: "agent",
  defaultStream: "agents/agent", sseTopic: "agent", sseTokenEvent: "agent-token",
  jobKind: "agent.run",
  normalizeConfig: normalizeAgentConfig, runtime: agentRuntime,
  prompts: AGENT_PROMPTS, model: AGENT_MODEL,
  promptHash: AGENT_PROMPTS_HASH, promptPath: AGENT_PROMPTS_PATH,
  runFn: runOrchestrator as unknown as (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  autoContinueOnBudget: true,
  extras: { memoryTools, delegationTools, workspaceRoot: WORKSPACE_ROOT, llmStructured, queue, dataDir: DATA_DIR, factoryService },
});

const factoryRunner = createAgentRunner({
  defaultAgentId: "factory",
  defaultStream: "agents/factory", sseTopic: "agent", sseTokenEvent: "agent-token",
  sseHtmlTokenEvent: "factory-stream-token",
  sseResetEvent: "factory-stream-reset",
  jobKind: "factory.run",
  normalizeConfig: normalizeFactoryChatConfig, runtime: agentRuntime,
  prompts: AGENT_PROMPTS, model: FACTORY_CHAT_MODEL,
  promptHash: AGENT_PROMPTS_HASH, promptPath: AGENT_PROMPTS_PATH,
  runFn: runOrchestrator as unknown as (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  extras: {
    memoryTools,
    delegationTools,
    workspaceRoot: WORKSPACE_ROOT,
    llmStructured,
    queue,
    factoryService,
    dataDir: DATA_DIR,
    repoRoot: factoryService.git.repoRoot,
    profileRoot: process.cwd(),
  },
});


const parseDelegateTask = (payload: Record<string, unknown> | undefined): { task: string; agentId?: string } | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const candidate = payload.delegate_task;
  if (!candidate || typeof candidate !== "object") return undefined;
  const rec = candidate as Record<string, unknown>;
  const task = typeof rec.task === "string" ? rec.task.trim() : "";
  if (!task) return undefined;
  const agentId = typeof rec.agentId === "string" && rec.agentId.trim().length > 0 ? rec.agentId.trim() : undefined;
  return { task, agentId };
};

type SubJobSummary = {
  readonly summary: string;
  readonly done: boolean;
};

const emitMergedSummary = async (opts: {
  readonly parentStream?: string;
  readonly parentRunId?: string;
  readonly subJobId: string;
  readonly subRunId: string;
  readonly task: string;
  readonly summary: string;
}): Promise<void> => {
  if (!opts.parentStream || !opts.parentRunId || !opts.summary.trim()) return;
  await emitToContinuedRun({
    runtime: agentRuntime,
    baseStream: opts.parentStream,
    parentRunId: opts.parentRunId,
    eventIdForStream: makeEventId,
    eventForRun: (runId) => ({
      type: "subagent.merged",
      runId,
      agentId: "orchestrator",
      subJobId: opts.subJobId,
      subRunId: opts.subRunId,
      task: opts.task,
      summary: opts.summary,
    }),
  });
  sse.publish("receipt");
};

const summarizeSubJob = async (jobId: string, timeoutMs = subJobWaitMs): Promise<SubJobSummary> => {
  const done = await queue.waitForJob(jobId, timeoutMs, subJobPollMs);
  if (!done) return { summary: `sub-agent status: missing (${jobId})`, done: true };
  if (done.status === "completed") return { summary: JSON.stringify(done.result ?? { status: done.status }), done: true };
  if (done.status === "queued" || done.status === "leased" || done.status === "running") {
    return { summary: `sub-agent status: pending (${done.status}; job ${jobId})`, done: false };
  }
  return { summary: `sub-agent status: ${done.status}`, done: true };
};

const scheduleSubJobJoin = (opts: {
  readonly parentJobId: string;
  readonly parentStream: string;
  readonly parentRunId: string;
  readonly subJobId: string;
  readonly subRunId: string;
  readonly emitMerged: (summary: string) => Promise<void>;
}) => {
  void (async () => {
    const settled = await summarizeSubJob(opts.subJobId, subJobJoinWaitMs);
    if (!settled.done) return;

    await opts.emitMerged(settled.summary);
    sse.publish("receipt");

    const target = await resolveContinuedRunTarget({
      runtime: agentRuntime,
      baseStream: opts.parentStream,
      parentRunId: opts.parentRunId,
    });
    const candidateJobIds = [...new Set([target.jobId, opts.parentJobId].filter((value): value is string => Boolean(value)))];
    for (const jobId of candidateJobIds) {
      const parent = await queue.getJob(jobId);
      if (!parent) continue;
      if (parent.status !== "queued" && parent.status !== "leased" && parent.status !== "running") continue;
      await queue.queueCommand({
        jobId,
        command: "follow_up",
        payload: { note: `Sub-agent summary (${opts.subRunId}):\n${settled.summary}` },
        by: "subagent-join",
      });
      sse.publish("jobs", jobId);
      break;
    }
  })().catch((err) => {
    console.error("sub-agent join failed", err);
  });
};

// ============================================================================
// Worker Handler Factory
// ============================================================================

type WorkerHandlerSpec = {
  readonly defaultStream: string;
  readonly defaultAgentId: string;
  readonly kind: string;
  readonly defaultSubConfig: Record<string, unknown>;
  readonly runtime: Pick<typeof agentRuntime, "chain" | "execute">;
  readonly runner: AgentRunner;
  readonly mergeEventExtras?: Record<string, unknown>;
};

const mergeCommands = (
  merged: Record<string, unknown>,
  commands: ReadonlyArray<{ command: string; payload?: Record<string, unknown> }>,
) => {
  for (const cmd of commands) {
    if (cmd.command === "steer" && cmd.payload) {
      if (typeof cmd.payload.problem === "string") merged.problem = cmd.payload.problem;
      if (typeof cmd.payload.config === "object" && cmd.payload.config) {
        merged.config = { ...(merged.config as Record<string, unknown> | undefined), ...(cmd.payload.config as Record<string, unknown>) };
      }
    }
    if (cmd.command === "follow_up" && typeof cmd.payload?.note === "string") {
      const base = typeof merged.problem === "string" ? merged.problem : "";
      merged.problem = `${base}\n\nFollow-up:\n${cmd.payload.note}`.trim();
    }
  }
};

const handleDelegates = async (
  spec: WorkerHandlerSpec,
  job: { readonly id: string; readonly payload: Record<string, unknown> },
  merged: Record<string, unknown>,
  commands: ReadonlyArray<{ command: string; payload?: Record<string, unknown> }>,
) => {
  if (Boolean(merged.isSubAgent)) return;
  for (const cmd of commands) {
    if (cmd.command !== "follow_up") continue;
    const delegate = parseDelegateTask(cmd.payload as Record<string, unknown> | undefined);
    if (!delegate) continue;

    const parentStream = String(merged.stream);
    const parentRunId = String(merged.runId);
    const subRunId = `${parentRunId}_sub_${Date.now().toString(36)}`;
    const subStream = `${parentStream}/sub/${subRunId}`;

    const subJob = await queue.enqueue({
      agentId: delegate.agentId ?? spec.defaultAgentId,
      lane: "follow_up",
      sessionKey: `subagent:${job.id}:${subRunId}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload: {
        kind: spec.kind,
        stream: subStream, runId: subRunId,
        problem: delegate.task,
        config: spec.defaultSubConfig,
        isSubAgent: true,
      },
    });

    const summaryNow = await summarizeSubJob(subJob.id);
    const base = typeof merged.problem === "string" ? merged.problem : "";
    merged.problem = `${base}\n\nSub-agent summary (${subRunId}):\n${summaryNow.summary}`.trim();

    const mergedEvent = {
      type: "subagent.merged", agentId: "orchestrator",
      subJobId: subJob.id, subRunId, task: delegate.task,
      ...(spec.mergeEventExtras ?? {}),
    } as const;

    const emitMerged = async (summary: string) => {
      await emitToContinuedRun({
        runtime: spec.runtime,
        baseStream: parentStream,
        parentRunId,
        eventIdForStream: makeEventId,
        eventForRun: (runId) => ({ ...mergedEvent, runId, summary } satisfies AgentEvent),
      });
    };

    await emitMerged(summaryNow.summary);
    sse.publish("receipt");

    if (!summaryNow.done) {
      scheduleSubJobJoin({
        parentJobId: job.id,
        parentStream,
        parentRunId,
        subJobId: subJob.id,
        subRunId,
        emitMerged,
      });
    }
  }
};

const createWorkerHandler = (spec: WorkerHandlerSpec): JobHandler =>
  async (job, ctx) => {
    const commands = await ctx.pullCommands(["steer", "follow_up"]);
    const merged = { ...job.payload } as Record<string, unknown>;
    if (typeof merged.stream !== "string" || !merged.stream.trim()) merged.stream = spec.defaultStream;
    if (typeof merged.runId !== "string" || !merged.runId.trim()) {
      merged.runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    }
    mergeCommands(merged, commands);
    await handleDelegates(spec, job, merged, commands);
    const result = await spec.runner(merged, createRunControl(job.id));
    const normalizedResult: Record<string, unknown> = {
      runId: merged.runId as string | undefined,
      stream: merged.stream as string | undefined,
      ...(result ?? {}),
    };
    if (normalizedResult.status === "failed") {
      const decision = deriveJobFailureDecision(normalizedResult);
      if (job.payload.kind === "factory.task.run" && decision.noRetry) {
        await factoryService.applyTaskWorkerResult(job.payload as never, {
          summary: `Codex job failed: ${decision.error}`,
          outcome: "blocked",
        }).catch(() => undefined);
        await factoryService.reactObjective(String(job.payload.objectiveId ?? "")).catch(() => undefined);
      }
      return {
        ok: false,
        error: decision.error,
        result: normalizedResult,
        noRetry: decision.noRetry,
      };
    }
    return { ok: true, result: normalizedResult };
  };

const jobHandlers = {
  agent: createWorkerHandler({
    defaultStream: "agents/agent", defaultAgentId: "agent", kind: "agent.run",
    defaultSubConfig: { maxIterations: 3, maxToolOutputChars: 2500, memoryScope: "agent", workspace: "." },
    runtime: agentRuntime, runner: agentRunner,
  }),
  factory: createWorkerHandler({
    defaultStream: "agents/factory", defaultAgentId: "factory", kind: "factory.run",
    defaultSubConfig: {
      maxIterations: 8,
      maxToolOutputChars: 6000,
      memoryScope: "repos/factory/profiles/generalist",
      workspace: ".",
    },
    runtime: agentRuntime, runner: factoryRunner,
  }),
  ...factoryWorkerHandlers,
  codex: async (job, ctx) => {
    if (job.payload.kind !== "factory.codex.run") {
      return factoryWorkerHandlers.codex(job, ctx);
    }
    await ctx.pullCommands(["steer", "follow_up"]);
    const payload = job.payload as Record<string, unknown>;
    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    if (!prompt) {
      return {
        ok: false,
        error: "factory codex prompt required",
        noRetry: true,
        result: { status: "failed", summary: "factory codex prompt required" },
      };
    }
    const timeoutMs = typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
      ? Math.max(30_000, Math.min(Math.floor(payload.timeoutMs), 900_000))
      : 180_000;
    const isTerminalJobStatus = (status: unknown): boolean =>
      status === "completed" || status === "failed" || status === "canceled";
    const shouldAbort = async (): Promise<boolean> => {
      const latest = await queue.getJob(job.id);
      return latest?.abortRequested === true || isTerminalJobStatus(latest?.status);
    };
    const parentRunId = typeof payload.parentRunId === "string" ? payload.parentRunId.trim() : "";
    const parentStream = typeof payload.parentStream === "string" ? payload.parentStream.trim() : "";
    const task = typeof payload.task === "string" && payload.task.trim()
      ? payload.task.trim()
      : prompt;
    let lastMergedSummary = "";
    const emitCodexMerged = async (summary: string): Promise<void> => {
      const next = summary.trim();
      if (!next || next === lastMergedSummary) return;
      lastMergedSummary = next;
      await emitMergedSummary({
        parentRunId,
        parentStream,
        subJobId: job.id,
        subRunId: job.id,
        task,
        summary: next,
      });
    };
    try {
      const result = await runFactoryCodexJob({
        dataDir: DATA_DIR,
        repoRoot: factoryService.git.repoRoot,
        jobId: job.id,
        prompt,
        timeoutMs,
        executor: factoryService.codexExecutor,
        factoryService,
        payload,
        onProgress: async (update) => {
          await queue.progress(job.id, ctx.workerId, update);
          const summary = typeof update.summary === "string" ? update.summary : "";
          await emitCodexMerged(summary);
        },
      }, {
        shouldAbort,
        onChildSpawn: async (update) => {
          ctx.registerLeaseProcess({
            pid: update.pid,
            label: "codex child",
          });
        },
        onChildExit: async () => {
          ctx.clearLeaseProcess();
        },
      });
      await emitCodexMerged(typeof result.summary === "string" ? result.summary : "Codex completed.");
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emitCodexMerged(message);
      const aborted = await shouldAbort();
      return {
        ok: !aborted,
        error: aborted ? undefined : message,
        noRetry: true,
        result: {
          status: aborted ? "canceled" : "failed",
          summary: message,
        },
      };
    }
  },
} satisfies Record<string, JobHandler>;

const workers = [
  new JobWorker({
    queue,
    handlers: jobHandlers,
    workerId: `${jobWorkerId}:chat`,
    leaseAgentIds: ["factory"],
    leaseLanes: ["chat"],
    idleResyncMs: jobIdleResyncMs,
    leaseMs: jobLeaseMs,
    concurrency: chatJobConcurrency,
    onError: (error) => {
      console.error(`[job-worker ${jobWorkerId}:chat]`, error);
    },
  }),
  new JobWorker({
    queue,
    handlers: jobHandlers,
    workerId: `${jobWorkerId}:orchestration`,
    leaseAgentIds: ["agent", FACTORY_CONTROL_AGENT_ID],
    idleResyncMs: jobIdleResyncMs,
    leaseMs: jobLeaseMs,
    concurrency: orchestrationJobConcurrency,
    onError: (error) => {
      console.error(`[job-worker ${jobWorkerId}:orchestration]`, error);
    },
  }),
  new JobWorker({
    queue,
    handlers: jobHandlers,
    workerId: `${jobWorkerId}:codex`,
    leaseAgentIds: ["codex"],
    idleResyncMs: jobIdleResyncMs,
    leaseMs: codexJobLeaseMs,
    concurrency: codexJobConcurrency,
    onError: (error) => {
      console.error(`[job-worker ${jobWorkerId}:codex]`, error);
    },
  }),
];
const resonateRoleRuntime = JOB_BACKEND === "resonate"
  ? createResonateRoleRuntime(PROCESS_ROLE, {
      queue,
      handlers: jobHandlers,
      onError: (error) => {
        console.error(`[resonate ${PROCESS_ROLE}]`, error);
      },
    })
  : undefined;
const startResonateDriver = JOB_BACKEND === "resonate"
  ? createResonateDriverStarter(resonateRoleRuntime!.client)
  : undefined;
if (redriveQueuedJobRef && PROCESS_ROLE === "api") {
  redriveQueuedJobRef.current = async (job) => {
    const now = Date.now();
    const lastAttemptAt = redriveQueuedJobRef.lastAttemptAt.get(job.id) ?? 0;
    if (now - lastAttemptAt < 5_000) return;
    redriveQueuedJobRef.lastAttemptAt.set(job.id, now);
    await startResonateDriver!(job, {
      dispatchKey: `${job.id}:redrive:${now}`,
    });
  };
}
if (JOB_BACKEND === "resonate" && PROCESS_ROLE === "worker-chat") {
  registerResonateAgentActionWorker(resonateRoleRuntime!.client, DATA_DIR);
}
if (JOB_BACKEND === "resonate") {
  queueImpl = resonateJobBackend({
    base: baseQueue,
    startDriver: startResonateDriver!,
    onDispatchError: (error, job) => {
      console.error(`[resonate dispatch ${job.id}]`, error);
    },
  });
}
const startRuntimeWorkers = async (): Promise<void> => {
  if (JOB_BACKEND === "local") {
    for (const worker of workers) worker.start();
    return;
  }
  await resonateRoleRuntime?.start();
};

let objectiveResumeScheduled = false;
const scheduleObjectiveResume = (): void => {
  if (objectiveResumeScheduled) return;
  if (JOB_BACKEND === "resonate" && PROCESS_ROLE !== "api") return;
  objectiveResumeScheduled = true;
  const runResume = () => {
    factoryService.resumeObjectives().catch((err) => {
      console.error("[factory resume]", err);
    });
  };
  if (STARTUP_SETTLE_MS <= 0) {
    queueMicrotask(runResume);
    return;
  }
  const timer = setTimeout(runResume, STARTUP_SETTLE_MS);
  timer.unref();
};

// ============================================================================
// Heartbeat
// ============================================================================

const heartbeatSpecs = (() => {
  const configured = [...FACTORY_RUNTIME.schedules];
  const seen = new Set(configured.map((spec) => spec.id));
  for (const spec of parseHeartbeatSpecsFromEnv(process.env)) {
    if (seen.has(spec.id)) continue;
    configured.push(spec);
    seen.add(spec.id);
  }
  return configured;
})();

const heartbeats = heartbeatSpecs.map((spec) =>
  createHeartbeat(spec, {
    enqueue: async (opts) => {
      const created = await queue.enqueue({
        agentId: opts.agentId,
        payload: opts.payload,
        lane: opts.lane,
        singletonMode: opts.singletonMode,
        sessionKey: opts.sessionKey,
        maxAttempts: opts.maxAttempts,
      });
      sse.publish("jobs", created.id);
      return { id: created.id };
    },
  })
);

const app = new Hono();

app.onError((err) => {
  if (err instanceof BadJsonError) return text(400, err.message);
  console.error(err);
  return text(500, "Server error");
});

const routes = await loadAgentRoutes({
  dataDir: DATA_DIR,
  sse,
  llmText,
  enqueueJob,
  queue,
  jobRuntime,
  runtimes: {
    agent: agentRuntime,
    memory: memoryRuntime,
  },
  prompts: {
    agent: AGENT_PROMPTS,
  },
  promptHashes: {
    agent: AGENT_PROMPTS_HASH,
  },
  promptPaths: {
    agent: AGENT_PROMPTS_PATH,
  },
  models: {
    agent: AGENT_MODEL,
  },
  helpers: {
    memoryTools,
    delegationTools,
    factoryService,
    profileRoot: process.cwd(),
  },
});

routes.forEach((route) => route.register(app));

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

class BadJsonError extends Error {
  constructor(msg: string) { super(msg); }
}

const readJsonBody = async (req: Request): Promise<Record<string, unknown>> => {
  const rawText = await req.text();
  if (!rawText.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(rawText); } catch {
    throw new BadJsonError("Malformed JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadJsonError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

app.post("/agents/:id/jobs", async (c) => {
  const agentId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const payload = (typeof body.payload === "object" && body.payload)
    ? body.payload as Record<string, unknown>
    : body;
  const lane = body.lane === "chat" || body.lane === "steer" || body.lane === "follow_up" || body.lane === "collect"
    ? body.lane
    : "collect";
  const jobId = typeof body.jobId === "string" ? body.jobId : undefined;
  const maxAttempts = typeof body.maxAttempts === "number" && Number.isFinite(body.maxAttempts)
    ? Math.max(1, Math.min(Math.floor(body.maxAttempts), 8))
    : 2;
  const singleton = (typeof body.singleton === "object" && body.singleton)
    ? body.singleton as Record<string, unknown>
    : undefined;
  const sessionKey = typeof body.sessionKey === "string"
    ? body.sessionKey
    : (typeof singleton?.key === "string" ? singleton.key : undefined);
  const singletonMode = body.singletonMode === "allow" || body.singletonMode === "cancel" || body.singletonMode === "steer"
    ? body.singletonMode
    : (singleton?.mode === "allow" || singleton?.mode === "cancel" || singleton?.mode === "steer"
      ? singleton.mode
      : "allow");

  const job = await queue.enqueue({
    jobId,
    agentId,
    lane,
    sessionKey,
    singletonMode,
    payload,
    maxAttempts,
  });
  sse.publish("jobs", job.id);
  return jsonResponse(202, { ok: true, job });
});

app.get("/healthz", async () => jsonResponse(200, {
  ok: true,
  uptimeSec: Math.floor(process.uptime()),
  dataDir: DATA_DIR,
  jobBackend: JOB_BACKEND,
  processRole: PROCESS_ROLE,
  queue: queue.snapshot(),
  codexBin: process.env.RECEIPT_CODEX_BIN ?? process.env.HUB_CODEX_BIN ?? "codex",
  resonateUrl: process.env.RESONATE_URL ?? "http://127.0.0.1:8001",
}));

app.post("/jobs/:id/steer", async (c) => {
  const jobId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const payload = (typeof body.payload === "object" && body.payload)
    ? body.payload as Record<string, unknown>
    : body;
  const queued = await queue.queueCommand({
    jobId,
    command: "steer",
    payload,
    by: typeof body.by === "string" ? body.by : undefined,
  });
  if (!queued) return text(404, "job not found");
  sse.publish("jobs", jobId);
  return jsonResponse(202, { ok: true, command: queued });
});

app.post("/jobs/:id/follow-up", async (c) => {
  const jobId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const payload = (typeof body.payload === "object" && body.payload)
    ? body.payload as Record<string, unknown>
    : body;
  const queued = await queue.queueCommand({
    jobId,
    command: "follow_up",
    payload,
    by: typeof body.by === "string" ? body.by : undefined,
  });
  if (!queued) return text(404, "job not found");
  sse.publish("jobs", jobId);
  return jsonResponse(202, { ok: true, command: queued });
});

app.post("/jobs/:id/abort", async (c) => {
  const jobId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const reason = typeof body.reason === "string" ? body.reason : "abort requested";
  const queued = await queue.queueCommand({
    jobId,
    command: "abort",
    payload: { reason },
    by: typeof body.by === "string" ? body.by : undefined,
  });
  if (!queued) return text(404, "job not found");
  sse.publish("jobs", jobId);
  return jsonResponse(202, { ok: true, command: queued });
});

app.get("/jobs/:id", async (c) => {
  const job = await queue.getJob(c.req.param("id"));
  if (!job) return text(404, "job not found");
  return jsonResponse(200, job);
});

app.get("/jobs/:id/wait", async (c) => {
  const timeoutMsRaw = Number(c.req.query("timeoutMs") ?? 15_000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(0, Math.min(timeoutMsRaw, 120_000)) : 15_000;
  const job = await queue.waitForJob(c.req.param("id"), timeoutMs, 200);
  if (!job) return text(404, "job not found");
  return jsonResponse(200, job);
});

app.get("/jobs/:id/events", async (c) => sse.subscribe("jobs", c.req.param("id"), c.req.raw.signal));

app.get("/jobs", async (c) => {
  const status = c.req.query("status");
  const parsed = status === "queued"
    || status === "leased"
    || status === "running"
    || status === "completed"
    || status === "failed"
    || status === "canceled"
    ? status
    : undefined;
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 50;
  const jobs = await queue.listJobs({ status: parsed, limit });
  return jsonResponse(200, { jobs });
});

app.post("/memory/:scope/read", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const entries = await memoryTools.read({
    scope,
    limit,
    audit: { actor: "api", route: "/memory/:scope/read" },
  });
  return jsonResponse(200, { entries });
});

app.post("/memory/:scope/search", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const query = typeof body.query === "string" ? body.query : "";
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const entries = await memoryTools.search({
    scope,
    query,
    limit,
    audit: { actor: "api", route: "/memory/:scope/search" },
  });
  return jsonResponse(200, { entries });
});

app.post("/memory/:scope/summarize", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const query = typeof body.query === "string" ? body.query : undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const maxChars = typeof body.maxChars === "number" ? body.maxChars : undefined;
  const result = await memoryTools.summarize({
    scope,
    query,
    limit,
    maxChars,
    audit: { actor: "api", route: "/memory/:scope/summarize" },
  });
  return jsonResponse(200, result);
});

app.post("/memory/:scope/commit", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const textValue = typeof body.text === "string" ? body.text : "";
  if (!textValue.trim()) return text(400, "text required");
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;
  const entry = await memoryTools.commit({
    scope,
    text: textValue,
    tags,
    meta: typeof body.meta === "object" && body.meta ? body.meta as Record<string, unknown> : undefined,
  });
  sse.publish("receipt");
  return jsonResponse(201, { entry });
});

app.post("/memory/:scope/diff", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const fromTs = typeof body.fromTs === "number" ? body.fromTs : Number.NaN;
  if (!Number.isFinite(fromTs)) return text(400, "fromTs required");
  const toTs = typeof body.toTs === "number" ? body.toTs : undefined;
  const entries = await memoryTools.diff({
    scope,
    fromTs,
    toTs,
    audit: { actor: "api", route: "/memory/:scope/diff" },
  });
  return jsonResponse(200, { entries });
});

// ── Static asset serving ────────────────────────────────────────────────────

const ASSET_DIR = (() => {
  const fromDist = path.resolve(import.meta.dir, "assets");
  const fromSrc = path.resolve(import.meta.dir, "..", "dist", "assets");
  try { if (fs.existsSync(fromDist)) return fromDist; } catch {}
  return fromSrc;
})();
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

app.get("/assets/:file", async (c) => {
  const fileName = c.req.param("file");
  if (fileName.includes("..") || fileName.includes("/")) return text(400, "invalid asset path");
  const filePath = path.join(ASSET_DIR, fileName);
  try {
    const body = fs.readFileSync(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": ext === ".css" || ext === ".js" ? "no-cache" : "public, max-age=3600",
      },
    });
  } catch {
    return text(404, "asset not found");
  }
});

app.notFound(() => text(404, "Not found"));

const shouldServeHttp = JOB_BACKEND === "local" || PROCESS_ROLE === "api";
const shouldRunHeartbeats = JOB_BACKEND === "local" || PROCESS_ROLE === "api";
const queueRefreshMs = Number(process.env.RESONATE_QUEUE_REFRESH_MS ?? 5_000);
let uiWarmupScheduled = false;
const scheduleUiWarmup = (): void => {
  if (uiWarmupScheduled) return;
  if (!shouldServeHttp || PROCESS_ROLE !== "api") return;
  uiWarmupScheduled = true;
  const runWarmup = async (): Promise<void> => {
    try {
      await factoryService.ensureBootstrap();
      await factoryService.listObjectives();
    } catch (err) {
      console.error("[factory ui warmup]", err);
    }
  };
  const timer = setTimeout(() => {
    void runWarmup();
  }, Math.max(50, Math.min(STARTUP_SETTLE_MS || 250, 500)));
  timer.unref();
};

try {
  await startRuntimeWorkers();
} catch (err) {
  console.error("[runtime] startup failed", err);
  process.exit(1);
}

if (shouldRunHeartbeats) {
  for (const hb of heartbeats) hb.start();
}

let queueRefreshTimer: ReturnType<typeof setTimeout> | undefined;
if (JOB_BACKEND === "resonate" && PROCESS_ROLE === "api" && Number.isFinite(queueRefreshMs) && queueRefreshMs > 0) {
  let refreshInFlight = false;
  const refreshIntervalMs = Math.max(1_000, Math.floor(queueRefreshMs));
  const scheduleNextQueueRefresh = (): void => {
    queueRefreshTimer = setTimeout(async () => {
      if (refreshInFlight) {
        scheduleNextQueueRefresh();
        return;
      }
      refreshInFlight = true;
      try {
        await queue.refresh();
      } catch (err) {
        console.error("[resonate queue refresh]", err);
      } finally {
        refreshInFlight = false;
        scheduleNextQueueRefresh();
      }
    }, refreshIntervalMs);
    queueRefreshTimer.unref();
  };
  scheduleNextQueueRefresh();
}

let receiptWatcher: ReturnType<typeof setInterval> | undefined;
if (shouldServeHttp) {
  const db = getReceiptDb(DATA_DIR);
  let lastSeq = pollLatestChangeSeq(db);
  receiptWatcher = setInterval(() => {
    try {
      const changes = listChangesAfter(db, lastSeq);
      if (changes.length === 0) return;
      lastSeq = changes[changes.length - 1]!.seq;
      for (const change of changes) {
        sse.publish("receipt");
        if (change.stream.startsWith("jobs/")) {
          const jobId = change.stream.slice("jobs/".length);
          if (jobId && !jobId.includes("/")) sse.publish("jobs", jobId);
        }
        if (change.stream.startsWith("factory/objectives/")) {
          const objectiveId = change.stream.slice("factory/objectives/".length);
          if (objectiveId && !objectiveId.includes("/")) sse.publish("factory", objectiveId);
        }
      }
    } catch (err) {
      console.warn("Receipt change poller failed:", err);
    }
  }, 500);
  receiptWatcher.unref();
}

const SERVER_IDLE_TIMEOUT_SECONDS = 30;
const serverOptions: Bun.Serve.Options<undefined> = {
  fetch: app.fetch,
  port: PORT,
  idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
};
const serveWithOptions = Bun.serve as (options: Bun.Serve.Options<undefined>) => Bun.Server<undefined>;

const httpServer = shouldServeHttp ? serveWithOptions(serverOptions) : undefined;
if (httpServer) {
  console.log(`Receipt server listening on http://localhost:${PORT}`);
} else {
  console.log(`Receipt ${PROCESS_ROLE} runtime connected to ${process.env.RESONATE_URL ?? "http://127.0.0.1:8001"}`);
}

scheduleObjectiveResume();
scheduleUiWarmup();

console.log(`Receipt runtime root: ${WORKSPACE_ROOT}`);
console.log(`Receipt data dir: ${DATA_DIR}${FACTORY_RUNTIME.configPath ? ` (from ${FACTORY_RUNTIME.configPath})` : ""}`);
console.log(`Receipt backend: ${JOB_BACKEND}${JOB_BACKEND === "resonate" ? ` (${PROCESS_ROLE})` : ""}`);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Receipt server shutting down (${signal})`);
  if (receiptWatcher) clearInterval(receiptWatcher);
  if (queueRefreshTimer) clearTimeout(queueRefreshTimer);
  for (const worker of workers) worker.stop();
  for (const hb of heartbeats) hb.stop();
  resonateRoleRuntime?.stop();
  const forceExit = setTimeout(() => {
    process.exit(0);
  }, 2_000);
  forceExit.unref();
  httpServer?.stop();
  clearTimeout(forceExit);
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

if (!httpServer) {
  await new Promise<void>(() => {});
}
