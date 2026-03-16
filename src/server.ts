// ============================================================================
// Server - Hono transport + manifest-based routing
// ============================================================================

import fs from "node:fs";
import path from "node:path";

import { Hono } from "hono";

import { jsonlStore, jsonBranchStore } from "./adapters/jsonl.js";
import { jsonlIndexedStore } from "./adapters/jsonl-indexed.js";
import { jsonlQueue, type EnqueueJobInput } from "./adapters/jsonl-queue.js";
import { LocalCodexExecutor } from "./adapters/codex-executor.js";
import {
  createMemoryTools,
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
} from "./adapters/memory-tools.js";
import { createDelegationTools } from "./adapters/delegation.js";
import { createHeartbeat, type HeartbeatSpec } from "./adapters/heartbeat.js";
import { fold } from "./core/chain.js";
import { createRuntime } from "./core/runtime.js";
import type { TodoEvent } from "./modules/todo.js";
import { decide, reduce, initial } from "./modules/todo.js";
import type { JobCmd, JobEvent, JobState } from "./modules/job.js";
import { decide as decideJob, reduce as reduceJob, initial as initialJob } from "./modules/job.js";
import type { SelfImprovementCmd, SelfImprovementEvent, SelfImprovementState } from "./modules/self-improvement.js";
import {
  decide as decideSelfImprovement,
  reduce as reduceSelfImprovement,
  initial as initialSelfImprovement,
} from "./modules/self-improvement.js";
import type { InspectorEvent } from "./modules/inspector.js";
import { decide as decideInspector, reduce as reduceInspector, initial as initialInspector } from "./modules/inspector.js";
import type { TheoremEvent } from "./modules/theorem.js";
import { decide as decideTheorem, reduce as reduceTheorem, initial as initialTheorem } from "./modules/theorem.js";
import type { WriterEvent } from "./modules/writer.js";
import { decide as decideWriter, reduce as reduceWriter, initial as initialWriter } from "./modules/writer.js";
import type { AgentEvent } from "./modules/agent.js";
import { decide as decideAgent, reduce as reduceAgent, initial as initialAgent } from "./modules/agent.js";
import type {
  AxiomSimpleCmd,
  AxiomSimpleEvent,
  AxiomSimpleState,
  AxiomSimpleWorkerSnapshot,
  AxiomSimpleWorkerStatus,
  AxiomSimpleWorkerValidation,
} from "./modules/axiom-simple.js";
import {
  decide as decideAxiomSimple,
  reduce as reduceAxiomSimple,
  initial as initialAxiomSimple,
} from "./modules/axiom-simple.js";
import { llmStructured, llmText, embed } from "./adapters/openai.js";
import { loadTheoremPrompts, hashTheoremPrompts } from "./prompts/theorem.js";
import { loadWriterPrompts, hashWriterPrompts } from "./prompts/writer.js";
import { loadInspectorPrompts, hashInspectorPrompts } from "./prompts/inspector.js";
import { loadAgentPrompts, hashAgentPrompts } from "./prompts/agent.js";
import { loadInfraPrompts, hashInfraPrompts } from "./prompts/infra.js";
import { loadAxiomPrompts, hashAxiomPrompts } from "./prompts/axiom.js";
import { runTheoremGuild, normalizeTheoremConfig } from "./agents/theorem.js";
import { runWriterGuild, normalizeWriterConfig } from "./agents/writer.js";
import { runAgent, normalizeAgentConfig } from "./agents/agent.js";
import { runInfra, normalizeInfraConfig } from "./agents/infra.js";
import { runAxiom, normalizeAxiomConfig } from "./agents/axiom.js";
import { runAxiomSimple, normalizeAxiomSimpleConfig, type AxiomSimpleWorkerLauncher } from "./agents/axiom-simple.js";
import { theoremRunStream } from "./agents/theorem.streams.js";
import { writerRunStream } from "./agents/writer.streams.js";
import { agentRunStream } from "./agents/agent.streams.js";
import { axiomSimpleRunStream } from "./agents/axiom-simple.streams.js";
import { runReceiptInspector } from "./agents/inspector.js";
import { maybeQueueAxiomGuildVerifyFailureFollowUp } from "./agents/axiom-guild-recovery.js";
import { HubService } from "./services/hub-service.js";
import { HubServiceError } from "./services/hub-service.js";
import { createFactoryServiceRuntime, createFactoryWorkerHandlers } from "./services/factory-runtime.js";
import {
  assertReceiptFileName,
  listReceiptFiles,
  readReceiptFile,
  sliceReceiptRecords,
  buildReceiptContext,
  buildReceiptTimeline,
} from "./adapters/receipt-tools.js";
import { loadAgentRoutes } from "./framework/agent-loader.js";
import { SseHub } from "./framework/sse-hub.js";
import { makeEventId, text } from "./framework/http.js";
import { JobWorker, type JobHandler } from "./engine/runtime/job-worker.js";
import { evaluateImprovementProposal } from "./engine/runtime/improvement-harness.js";
import { resolveFactoryRuntimeConfig } from "./factory-cli/config.js";

// ============================================================================
// Config
// ============================================================================

const PORT = Number(process.env.PORT ?? 8787);
const FACTORY_RUNTIME = await resolveFactoryRuntimeConfig(process.cwd());
const WORKSPACE_ROOT = FACTORY_RUNTIME.repoRoot;
const DATA_DIR = FACTORY_RUNTIME.dataDir;
const USE_INDEXED_STORE = process.env.RECEIPT_INDEXED_STORE === "1";
const FACTORY_ORCHESTRATOR_MODE = FACTORY_RUNTIME.orchestratorMode;

// ============================================================================
// Composition: Store -> Runtime
// ============================================================================

const makeStore = <E,>() =>
  (USE_INDEXED_STORE ? jsonlIndexedStore<E>(DATA_DIR) : jsonlStore<E>(DATA_DIR));

const store = makeStore<TodoEvent>();
const branchStore = jsonBranchStore(DATA_DIR);
const runtime = createRuntime(store, branchStore, decide, reduce, initial);

const theoremStore = makeStore<TheoremEvent>();
const theoremRuntime = createRuntime(
  theoremStore,
  branchStore,
  decideTheorem,
  reduceTheorem,
  initialTheorem
);

const writerStore = makeStore<WriterEvent>();
const writerRuntime = createRuntime(
  writerStore,
  branchStore,
  decideWriter,
  reduceWriter,
  initialWriter
);

const axiomSimpleStore = makeStore<AxiomSimpleEvent>();
const axiomSimpleRuntime = createRuntime<AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState>(
  axiomSimpleStore,
  branchStore,
  decideAxiomSimple,
  reduceAxiomSimple,
  initialAxiomSimple
);

const agentStore = makeStore<AgentEvent>();
const agentRuntime = createRuntime(
  agentStore,
  branchStore,
  decideAgent,
  reduceAgent,
  initialAgent
);

const inspectorStore = makeStore<InspectorEvent>();
const inspectorRuntime = createRuntime(
  inspectorStore,
  branchStore,
  decideInspector,
  reduceInspector,
  initialInspector
);

const jobStore = makeStore<JobEvent>();
const jobRuntime = createRuntime<JobCmd, JobEvent, JobState>(
  jobStore,
  branchStore,
  decideJob,
  reduceJob,
  initialJob
);

const selfImprovementStore = makeStore<SelfImprovementEvent>();
const selfImprovementRuntime = createRuntime<SelfImprovementCmd, SelfImprovementEvent, SelfImprovementState>(
  selfImprovementStore,
  branchStore,
  decideSelfImprovement,
  reduceSelfImprovement,
  initialSelfImprovement
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

const THEOREM_PROMPTS = loadTheoremPrompts();
const THEOREM_PROMPTS_HASH = hashTheoremPrompts(THEOREM_PROMPTS);
const THEOREM_PROMPTS_PATH = "prompts/theorem.prompts.json";
const THEOREM_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

const AXIOM_GUILD_PROMPTS = loadTheoremPrompts({ name: "axiom-guild", tag: "axiom-guild" });
const AXIOM_GUILD_PROMPTS_HASH = hashTheoremPrompts(AXIOM_GUILD_PROMPTS);
const AXIOM_GUILD_PROMPTS_PATH = "prompts/axiom-guild.prompts.json";
const AXIOM_GUILD_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

const WRITER_PROMPTS = loadWriterPrompts();
const WRITER_PROMPTS_HASH = hashWriterPrompts(WRITER_PROMPTS);
const WRITER_PROMPTS_PATH = "prompts/writer.prompts.json";
const WRITER_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

const INSPECTOR_PROMPTS = loadInspectorPrompts();
const INSPECTOR_PROMPTS_HASH = hashInspectorPrompts(INSPECTOR_PROMPTS);
const INSPECTOR_PROMPTS_PATH = "prompts/inspector.prompts.json";
const INSPECTOR_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

const AGENT_PROMPTS = loadAgentPrompts();
const AGENT_PROMPTS_HASH = hashAgentPrompts(AGENT_PROMPTS);
const AGENT_PROMPTS_PATH = "prompts/agent.prompts.json";
const AGENT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

const INFRA_PROMPTS = loadInfraPrompts();
const INFRA_PROMPTS_HASH = hashInfraPrompts(INFRA_PROMPTS);
const INFRA_PROMPTS_PATH = "prompts/infra.prompts.json";
const INFRA_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

const AXIOM_PROMPTS = loadAxiomPrompts();
const AXIOM_PROMPTS_HASH = hashAxiomPrompts(AXIOM_PROMPTS);
const AXIOM_PROMPTS_PATH = "prompts/axiom.prompts.json";
const AXIOM_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

const JOB_STREAM = "jobs";
const IMPROVEMENT_STREAM = "improvement";
const INSPECTOR_STREAM = "agents/inspector";
const jobWorkerId = process.env.JOB_WORKER_ID ?? `worker_${process.pid}`;
const jobPollMs = Number(process.env.JOB_POLL_MS ?? 250);
const jobLeaseMs = Number(process.env.JOB_LEASE_MS ?? 30_000);
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
const eventId = (stream: string): string => makeEventId(stream);

const queue = jsonlQueue({
  runtime: jobRuntime,
  stream: JOB_STREAM,
  onJobChange: async (jobIds) => {
    for (const jobId of jobIds) {
      sse.publish("jobs", jobId);
    }
    sse.publish("receipt");
  },
});

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
  readonly defaultStream: string;
  readonly sseTopic: "theorem" | "writer" | "agent";
  readonly sseTokenEvent: string;
  readonly normalizeConfig: (input: Record<string, unknown>) => unknown;
  readonly runtime: unknown;
  readonly prompts: unknown;
  readonly model: string;
  readonly promptHash: string;
  readonly promptPath: string;
  readonly runFn: (input: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  readonly extras?: Record<string, unknown>;
};

const createAgentRunner = (spec: AgentRunnerSpec): AgentRunner =>
  async (payload, control) => {
    const { stream, runId, runStream, problem } = extractRunPayload(payload, spec.defaultStream);
    const configInput = typeof payload.config === "object" && payload.config
      ? payload.config as Record<string, unknown> : {};
    const config = spec.normalizeConfig(configInput);
    const { apiReady, apiNote } = apiStatus();
    const runnerResult = await spec.runFn({
      stream, runId, runStream, problem, config,
      runtime: spec.runtime, prompts: spec.prompts,
      llmText: (opts: Record<string, unknown>) => llmText({
        ...(opts as { system?: string; user: string }),
        onDelta: async (delta) => {
          if (!delta) return;
          sse.publishData(spec.sseTopic, stream, spec.sseTokenEvent, JSON.stringify({ runId, delta }));
        },
      }),
      model: spec.model, promptHash: spec.promptHash, promptPath: spec.promptPath,
      apiReady, apiNote, control,
      broadcast: () => { sse.publish(spec.sseTopic, stream); sse.publish("receipt"); },
      ...(spec.extras ?? {}),
    });
    return {
      runId,
      stream,
      ...(runnerResult ?? {}),
    };
  };

let theoremRunner: AgentRunner;
let axiomGuildRunner: AgentRunner;
let axiomSimpleRunner: AgentRunner;

const writerRunner = createAgentRunner({
  defaultStream: "agents/writer", sseTopic: "writer", sseTokenEvent: "writer-token",
  normalizeConfig: normalizeWriterConfig, runtime: writerRuntime,
  prompts: WRITER_PROMPTS, model: WRITER_MODEL,
  promptHash: WRITER_PROMPTS_HASH, promptPath: WRITER_PROMPTS_PATH,
  runFn: runWriterGuild as (input: Record<string, unknown>) => Promise<void>,
});

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

const hubCodexExecutor = new LocalCodexExecutor();
const { service: factoryService } = createFactoryServiceRuntime({
  dataDir: DATA_DIR,
  queue,
  jobRuntime,
  sse,
  repoRoot: WORKSPACE_ROOT,
  codexBin: FACTORY_RUNTIME.codexBin,
  orchestratorMode: FACTORY_ORCHESTRATOR_MODE,
  memoryTools,
});
const hubService = new HubService({
  dataDir: DATA_DIR,
  queue,
  jobRuntime,
  sse,
  codexExecutor: hubCodexExecutor,
  memoryTools,
});

const agentRunner = createAgentRunner({
  defaultStream: "agents/agent", sseTopic: "agent", sseTokenEvent: "agent-token",
  normalizeConfig: normalizeAgentConfig, runtime: agentRuntime,
  prompts: AGENT_PROMPTS, model: AGENT_MODEL,
  promptHash: AGENT_PROMPTS_HASH, promptPath: AGENT_PROMPTS_PATH,
  runFn: runAgent as unknown as (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  extras: { memoryTools, delegationTools, workspaceRoot: WORKSPACE_ROOT, llmStructured },
});

const infraRunner = createAgentRunner({
  defaultStream: "agents/infra", sseTopic: "agent", sseTokenEvent: "agent-token",
  normalizeConfig: normalizeInfraConfig, runtime: agentRuntime,
  prompts: INFRA_PROMPTS, model: INFRA_MODEL,
  promptHash: INFRA_PROMPTS_HASH, promptPath: INFRA_PROMPTS_PATH,
  runFn: runInfra as unknown as (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  extras: { memoryTools, delegationTools, workspaceRoot: WORKSPACE_ROOT, llmStructured },
});

const axiomRunner = createAgentRunner({
  defaultStream: "agents/axiom", sseTopic: "agent", sseTokenEvent: "agent-token",
  normalizeConfig: normalizeAxiomConfig, runtime: agentRuntime,
  prompts: AXIOM_PROMPTS, model: AXIOM_MODEL,
  promptHash: AXIOM_PROMPTS_HASH, promptPath: AXIOM_PROMPTS_PATH,
  runFn: runAxiom as unknown as (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  extras: { memoryTools, delegationTools, workspaceRoot: WORKSPACE_ROOT, llmStructured },
});

const clipText = (value: string | undefined, max = 280): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const mapAxiomSimpleWorkerStatus = (status?: string): AxiomSimpleWorkerStatus => {
  switch (status) {
    case "queued":
      return "queued";
    case "leased":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "missing";
  }
};

const latestToolPath = (input: Record<string, unknown>): string | undefined => {
  const keys = [
    "path",
    "outputPath",
    "output_path",
    "formalStatementPath",
    "formal_statement_path",
    "outputDir",
    "output_dir",
  ] as const;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
};

const reverseFind = <T,>(items: ReadonlyArray<T>, pred: (item: T) => boolean): T | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && pred(item)) return item;
  }
  return undefined;
};

const toAxiomSimpleWorkerValidation = (
  receipt: { readonly body: Extract<AgentEvent, { readonly type: "validation.report" }> } | undefined,
): AxiomSimpleWorkerValidation | undefined => {
  if (!receipt) return undefined;
  const evidence = receipt.body.evidence;
  return {
    gate: receipt.body.gate,
    ok: receipt.body.ok,
    summary: receipt.body.summary,
    tool: evidence?.tool,
    candidateHash: evidence?.candidateHash,
    formalStatementHash: evidence?.formalStatementHash,
    candidateContent: evidence?.candidateContent,
    formalStatement: evidence?.formalStatement,
    failedDeclarations: evidence?.failedDeclarations ?? [],
  };
};

const extractAxiomSimpleWorkerData = (opts: {
  readonly runChain: Awaited<ReturnType<typeof agentRuntime.chain>>;
  readonly childRunId: string;
  readonly childStream: string;
  readonly jobId: string;
  readonly queueStatus?: string;
  readonly queueError?: string;
}) => {
  const runState = fold(opts.runChain, reduceAgent, initialAgent);
  const validations = opts.runChain.filter((receipt): receipt is typeof receipt & {
    readonly body: Extract<AgentEvent, { readonly type: "validation.report" }>;
  } => receipt.body.type === "validation.report");
  const toolCalls = opts.runChain.filter((receipt): receipt is typeof receipt & {
    readonly body: Extract<AgentEvent, { readonly type: "tool.called" }>;
  } => receipt.body.type === "tool.called");
  const toolObservations = opts.runChain.filter((receipt): receipt is typeof receipt & {
    readonly body: Extract<AgentEvent, { readonly type: "tool.observed" }>;
  } => receipt.body.type === "tool.observed");
  const failureReports = opts.runChain.filter((receipt): receipt is typeof receipt & {
    readonly body: Extract<AgentEvent, { readonly type: "failure.report" }>;
  } => receipt.body.type === "failure.report");
  const finalResponse = reverseFind(opts.runChain, (receipt) => receipt.body.type === "response.finalized") as
    | (typeof opts.runChain[number] & { readonly body: Extract<AgentEvent, { readonly type: "response.finalized" }> })
    | undefined;
  const finalStatus = reverseFind(opts.runChain, (receipt) => receipt.body.type === "run.status") as
    | (typeof opts.runChain[number] & { readonly body: Extract<AgentEvent, { readonly type: "run.status" }> })
    | undefined;
  const latestValidation = validations[validations.length - 1];
  const successfulVerifyReceipt = reverseFind(validations, (receipt) => {
    const evidence = receipt.body.evidence;
    if (!receipt.body.ok) return false;
    if (!evidence?.candidateHash || !evidence.formalStatementHash) return false;
    return evidence.tool === "lean.verify" || evidence.tool === "lean.verify_file";
  });
  const latestObservation = toolObservations[toolObservations.length - 1];
  const latestTool = toolCalls[toolCalls.length - 1];
  const touchedPaths = [...new Set(toolCalls
    .map((receipt) => latestToolPath(receipt.body.input))
    .filter((value): value is string => Boolean(value)))];

  let status = mapAxiomSimpleWorkerStatus(opts.queueStatus);
  if ((status === "queued" || status === "running" || status === "missing") && runState.status === "completed") status = "completed";
  if ((status === "queued" || status === "running" || status === "missing") && runState.status === "failed") status = "failed";

  const validation = toAxiomSimpleWorkerValidation(latestValidation);
  const successfulVerify = toAxiomSimpleWorkerValidation(successfulVerifyReceipt);
  const candidateHash = successfulVerify?.candidateHash ?? validation?.candidateHash;
  const formalStatementHash = successfulVerify?.formalStatementHash ?? validation?.formalStatementHash;
  const failedDeclarations = successfulVerify?.failedDeclarations ?? validation?.failedDeclarations ?? [];
  const failureMessage = failureReports[failureReports.length - 1]?.body.failure.message
    ?? finalStatus?.body.note
    ?? opts.queueError;
  const failureCount = toolCalls.filter((receipt) => Boolean(receipt.body.error)).length
    + validations.filter((receipt) => !receipt.body.ok).length
    + failureReports.length;
  const outputExcerpt = clipText(
    finalResponse?.body.content
    ?? latestValidation?.body.summary
    ?? finalStatus?.body.note
    ?? failureMessage,
  );
  const summary = [
    status === "missing" ? `status: ${opts.queueStatus ?? "missing"}` : `status: ${status}`,
    latestValidation?.body.summary ? `validation: ${latestValidation.body.summary}` : "",
    finalStatus?.body.note ? `note: ${finalStatus.body.note}` : "",
    failureMessage && failureMessage !== finalStatus?.body.note ? `failure: ${failureMessage}` : "",
    clipText(finalResponse?.body.content, 400) ?? "",
  ].filter(Boolean).join("\n");

  const snapshot: AxiomSimpleWorkerSnapshot = {
    childRunId: opts.childRunId,
    jobId: opts.jobId,
    childStream: opts.childStream,
    status,
    iteration: runState.iteration,
    lastTool: latestTool?.body.tool,
    lastToolSummary: latestTool?.body.summary ?? latestTool?.body.error,
    validationGate: latestValidation?.body.gate,
    validationSummary: latestValidation?.body.summary,
    validationOk: latestValidation?.body.ok,
    verifyTool: successfulVerify?.tool,
    verified: successfulVerify?.ok,
    outputExcerpt,
    observationExcerpt: clipText(latestObservation?.body.output),
    touchedPath: touchedPaths[touchedPaths.length - 1],
    candidateHash,
    formalStatementHash,
    failedDeclarations,
    failureCount,
  };

  return {
    status,
    snapshot,
    summary: summary || `Axiom worker ${opts.childRunId} produced no receipts yet.`,
    finalResponse: finalResponse?.body.content,
    validation,
    successfulVerify,
    candidateContent: successfulVerify?.candidateContent ?? validation?.candidateContent ?? finalResponse?.body.content,
    formalStatement: successfulVerify?.formalStatement ?? validation?.formalStatement,
    failureMessage,
    touchedPaths,
    signature: JSON.stringify({
      status,
      iteration: runState.iteration,
      tool: latestTool?.body.tool,
      validation: latestValidation?.body.summary,
      response: finalResponse?.body.content,
      failure: failureMessage,
      candidateHash,
      formalStatementHash,
      touchedPath: touchedPaths[touchedPaths.length - 1],
    }),
  };
};

const launchAxiomSimpleWorker: AxiomSimpleWorkerLauncher = async (input) => {
  const childRunId = `${input.parentRunId}_${input.workerId}_${Date.now().toString(36)}`;
  const childStream = "agents/axiom";
  const created = await queue.enqueue({
    agentId: "axiom",
    lane: "follow_up",
    sessionKey: `axiom-simple:${input.parentRunId}:${input.workerId}`,
    singletonMode: "allow",
    maxAttempts: 2,
    payload: {
      kind: "axiom.run",
      stream: childStream,
      runId: childRunId,
      problem: input.task,
      config: {
        maxIterations: 12,
        maxToolOutputChars: 6_000,
        memoryScope: "axiom",
        workspace: ".",
        leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
        leanTimeoutSeconds: 120,
        autoRepair: true,
        ...(input.config ?? {}),
      },
      isSubAgent: true,
    },
  });
  sse.publish("jobs", created.id);

  await input.onStarted?.({
    jobId: created.id,
    childRunId,
    childStream,
    status: "queued",
  });

  const timeoutMs = input.timeoutMs ?? subJobJoinWaitMs;
  const deadline = Date.now() + timeoutMs;
  let lastSignature = "";

  while (Date.now() <= deadline) {
    const job = await queue.getJob(created.id);
    const runChain = await agentRuntime.chain(agentRunStream(childStream, childRunId));
    const data = extractAxiomSimpleWorkerData({
      runChain,
      childRunId,
      childStream,
      jobId: created.id,
      queueStatus: job?.status,
      queueError: job?.lastError,
    });

    if (data.signature !== lastSignature) {
      lastSignature = data.signature;
      await input.onProgress?.(data.snapshot);
    }

    if (job && (job.status === "completed" || job.status === "failed" || job.status === "canceled")) {
      return {
        workerId: input.workerId,
        label: input.label,
        strategy: input.strategy,
        phase: input.phase,
        sourceWorkerId: input.sourceWorkerId,
        status: data.status,
        jobId: created.id,
        childRunId,
        childStream,
        snapshot: data.snapshot,
        summary: data.summary,
        finalResponse: data.finalResponse,
        validation: data.validation,
        successfulVerify: data.successfulVerify,
        candidateContent: data.candidateContent,
        formalStatement: data.formalStatement,
        failureMessage: data.failureMessage,
        touchedPaths: data.touchedPaths,
      };
    }

    await delay(subJobPollMs);
  }

  const timedJob = await queue.getJob(created.id);
  const timedRunChain = await agentRuntime.chain(agentRunStream(childStream, childRunId));
  const timedData = extractAxiomSimpleWorkerData({
    runChain: timedRunChain,
    childRunId,
    childStream,
    jobId: created.id,
    queueStatus: timedJob?.status,
    queueError: timedJob?.lastError,
  });
  const timeoutNote = `timed out after ${timeoutMs}ms`;
  const timeoutSummary = [
    timeoutNote,
    timedData.validation?.summary ? `validation: ${timedData.validation.summary}` : "",
    timedData.failureMessage ? `failure: ${timedData.failureMessage}` : "",
    clipText(timedData.finalResponse, 400) ?? "",
  ].filter(Boolean).join("\n");

  return {
    workerId: input.workerId,
    label: input.label,
    strategy: input.strategy,
    phase: input.phase,
    sourceWorkerId: input.sourceWorkerId,
    status: "failed",
    jobId: created.id,
    childRunId,
    childStream,
    snapshot: timedData.snapshot,
    summary: timeoutSummary || timeoutNote,
    finalResponse: timedData.finalResponse,
    validation: timedData.validation,
    successfulVerify: timedData.successfulVerify,
    candidateContent: timedData.candidateContent,
    formalStatement: timedData.formalStatement,
    failureMessage: [timeoutNote, timedData.failureMessage].filter(Boolean).join("; "),
    touchedPaths: timedData.touchedPaths,
  };
};

const delegateAxiomForTheorem = async (input: {
  readonly task: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}) => {
  const runId = `theorem_axiom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const stream = "agents/axiom";
  const created = await queue.enqueue({
    agentId: "axiom",
    lane: "follow_up",
    sessionKey: `theorem:axiom:${runId}`,
    singletonMode: "allow",
    maxAttempts: 2,
    payload: {
      kind: "axiom.run",
      stream,
      runId,
      problem: input.task,
      config: {
        maxIterations: 12,
        maxToolOutputChars: 6_000,
        memoryScope: "axiom",
        workspace: ".",
        leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
        leanTimeoutSeconds: 120,
        autoRepair: true,
        ...(input.config ?? {}),
      },
      isSubAgent: true,
    },
  });
  sse.publish("jobs", created.id);

  const settled = await queue.waitForJob(created.id, input.timeoutMs ?? 180_000, subJobPollMs);
  if (!settled) {
    return {
      jobId: created.id,
      runId,
      stream,
      status: "missing",
      summary: `Axiom subjob missing (${created.id}).`,
    };
  }

  const runChain = await agentRuntime.chain(agentRunStream(stream, runId));
  const finalResponse = [...runChain].reverse().find((receipt) => receipt.body.type === "response.finalized") as
    | { body: Extract<AgentEvent, { type: "response.finalized" }> }
    | undefined;
  const finalStatus = [...runChain].reverse().find((receipt) => receipt.body.type === "run.status") as
    | { body: Extract<AgentEvent, { type: "run.status" }> }
    | undefined;
  const validations = runChain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
    receipt.body.type === "validation.report"
  );
  const toolCalls = runChain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.called" }> } =>
    receipt.body.type === "tool.called"
  );
  const leanTools = [...new Set(toolCalls
    .map((receipt) => receipt.body.tool)
    .filter((tool) => tool.startsWith("lean.")))];
  const axleValidations = validations.filter((receipt) =>
    receipt.body.gate.startsWith("axle")
    && receipt.body.evidence
  );
  const verifyValidations = axleValidations.filter((receipt) => {
    const tool = receipt.body.evidence?.tool;
    return tool === "lean.verify" || tool === "lean.verify_file";
  });
  const successfulFinalVerify = [...verifyValidations].reverse().find((receipt) =>
    receipt.body.ok
    && receipt.body.evidence?.candidateHash
    && receipt.body.evidence?.formalStatementHash
  );
  const theoremToSorryFailure = [...toolCalls].reverse().find((receipt) =>
    (receipt.body.tool === "lean.theorem2sorry" || receipt.body.tool === "lean.theorem2sorry_file")
    && Boolean(receipt.body.error)
  );
  const latestValidation = validations[validations.length - 1];

  const validationEvidence = axleValidations
    .map((receipt) => {
      const evidence = receipt.body.evidence;
      if (!evidence?.tool) return undefined;
      return {
        tool: evidence.tool,
        environment: evidence.environment,
        candidateHash: evidence.candidateHash,
        formalStatementHash: evidence.formalStatementHash,
        candidateContent: evidence.candidateContent,
        formalStatement: evidence.formalStatement,
        ok: receipt.body.ok,
        failedDeclarations: evidence.failedDeclarations ?? [],
        timings: evidence.timings,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const outcome = (() => {
    if (finalStatus?.body.status === "failed") return "delegate_failed";
    if (theoremToSorryFailure) return "theorem2sorry_failed";
    if (verifyValidations.length === 0 && axleValidations.length === 0) return "no_axle_validation";
    if (verifyValidations.length === 0) return "no_final_verify";
    if (!successfulFinalVerify) return "axle_verify_failed";
    return "verified";
  })();

  const summary = [
    `status: ${settled.status}`,
    `outcome: ${outcome}`,
    leanTools.length > 0 ? `AXLE tools: ${leanTools.join(", ")}` : "",
    finalStatus?.body.note ? `note: ${finalStatus.body.note}` : "",
    latestValidation?.body.summary ? `validation: ${latestValidation.body.summary}` : "",
    finalResponse?.body.content ?? "",
  ].filter(Boolean).join("\n");

  return {
    jobId: created.id,
    runId,
    stream,
    status: settled.status,
    outcome,
    evidence: validationEvidence,
    verifiedCandidateContent: successfulFinalVerify?.body.evidence?.candidateContent,
    verifiedCandidateHash: successfulFinalVerify?.body.evidence?.candidateHash,
    verifiedFormalStatementHash: successfulFinalVerify?.body.evidence?.formalStatementHash,
    summary: summary || JSON.stringify(settled.result ?? { status: settled.status }),
  };
};

theoremRunner = createAgentRunner({
  defaultStream: "agents/theorem", sseTopic: "theorem", sseTokenEvent: "theorem-token",
  normalizeConfig: normalizeTheoremConfig, runtime: theoremRuntime,
  prompts: THEOREM_PROMPTS, model: THEOREM_MODEL,
  promptHash: THEOREM_PROMPTS_HASH, promptPath: THEOREM_PROMPTS_PATH,
  runFn: runTheoremGuild as unknown as (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  extras: { axiomDelegate: delegateAxiomForTheorem },
});

axiomGuildRunner = async (payload, control) => {
  const { stream, runId, runStream, problem } = extractRunPayload(payload, "agents/axiom-guild");
  const configInput = typeof payload.config === "object" && payload.config
    ? payload.config as Record<string, unknown>
    : {};
  const config = normalizeTheoremConfig(configInput);
  const { apiReady, apiNote } = apiStatus();
  const result = await runTheoremGuild({
    stream,
    runId,
    runStream,
    problem,
    config,
    runtime: theoremRuntime,
    prompts: AXIOM_GUILD_PROMPTS,
    llmText: (opts) => llmText({
      ...opts,
      onDelta: async (delta) => {
        if (!delta) return;
        sse.publishData("theorem", stream, "theorem-token", JSON.stringify({ runId, delta }));
      },
    }),
    model: AXIOM_GUILD_MODEL,
    promptHash: AXIOM_GUILD_PROMPTS_HASH,
    promptPath: AXIOM_GUILD_PROMPTS_PATH,
    apiReady,
    apiNote,
    control,
    broadcast: () => { sse.publish("theorem", stream); sse.publish("receipt"); },
    axiomDelegate: delegateAxiomForTheorem,
    axiomPolicy: "required",
    axiomConfig: {
      maxIterations: 12,
      leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
      autoRepair: true,
    },
  });
  const recovery = control?.jobId
    ? await maybeQueueAxiomGuildVerifyFailureFollowUp({
        queue,
        theoremRuntime,
        payload,
        result,
        jobId: control.jobId,
        onJobQueued: (jobId) => sse.publish("jobs", jobId),
        onReceipt: () => {
          sse.publish("theorem", stream);
          sse.publish("receipt");
        },
  })
    : {};
  return { ...result, ...recovery };
};

axiomSimpleRunner = async (payload, control) => {
  const { stream, runId, runStream, problem } = extractRunPayload(payload, "agents/axiom-simple");
  const configInput = typeof payload.config === "object" && payload.config
    ? payload.config as Record<string, unknown>
    : {};
  const config = normalizeAxiomSimpleConfig(configInput);
  const result = await runAxiomSimple({
    stream,
    runId,
    runStream,
    problem,
    config,
    runtime: axiomSimpleRuntime,
    control,
    launchWorker: launchAxiomSimpleWorker,
    broadcast: () => {
      sse.publish("theorem", stream);
      sse.publish("receipt");
    },
  });
  return result as unknown as Record<string, unknown>;
};

const inspectorRunner = async (payload: Record<string, unknown>): Promise<void> => {
  const runId = typeof payload.runId === "string" && payload.runId.trim()
    ? payload.runId
    : `inspect_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const groupId = typeof payload.groupId === "string" ? payload.groupId : undefined;
  const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
  const agentName = typeof payload.agentName === "string" ? payload.agentName : undefined;
  const sourceName = typeof payload.source === "object" && payload.source && typeof (payload.source as Record<string, unknown>).name === "string"
    ? String((payload.source as Record<string, unknown>).name)
    : "";
  const mode = typeof payload.mode === "string"
    && ["analyze", "improve", "timeline", "qa"].includes(payload.mode)
    ? payload.mode as "analyze" | "improve" | "timeline" | "qa"
    : "analyze";
  const order = payload.order === "asc" ? "asc" : "desc";
  const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit)
    ? Math.max(10, Math.min(Math.floor(payload.limit), 5000))
    : 200;
  const depth = typeof payload.depth === "number" && Number.isFinite(payload.depth)
    ? Math.max(1, Math.min(Math.floor(payload.depth), 3))
    : 2;
  const question = typeof payload.question === "string" && payload.question.trim() ? payload.question : "Analyze this run.";
  const apiReady = typeof payload.apiReady === "boolean" ? payload.apiReady : Boolean(process.env.OPENAI_API_KEY);
  const apiNote = typeof payload.apiNote === "string" ? payload.apiNote : (apiReady ? undefined : "OPENAI_API_KEY not set");
  if (!sourceName) throw new Error("inspector source file required");
  const safeSourceName = await ensureInspectorSourceExists(sourceName);

  await runReceiptInspector({
    stream: INSPECTOR_STREAM,
    runId,
    groupId,
    agentId,
    agentName,
    source: { kind: "file", name: safeSourceName },
    dataDir: DATA_DIR,
    order,
    limit,
    question,
    mode,
    depth,
    runtime: inspectorRuntime,
    prompts: INSPECTOR_PROMPTS,
    llmText: (opts) => llmText({
      ...opts,
      onDelta: async (delta) => {
        if (!delta) return;
        sse.publishData(
          "receipt",
          undefined,
          "receipt-token",
          JSON.stringify({ groupId, runId, agentId, file: safeSourceName, delta })
        );
      },
    }),
    model: INSPECTOR_MODEL,
    promptHash: INSPECTOR_PROMPTS_HASH,
    promptPath: INSPECTOR_PROMPTS_PATH,
    apiReady,
    apiNote,
    tools: {
      readFile: readReceiptFile,
      sliceRecords: sliceReceiptRecords,
      buildContext: buildReceiptContext,
      buildTimeline: buildReceiptTimeline,
    },
    broadcast: () => sse.publish("receipt"),
  });
};

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
  readonly subJobId: string;
  readonly subRunId: string;
  readonly emitMerged: (summary: string) => Promise<void>;
}) => {
  void (async () => {
    const settled = await summarizeSubJob(opts.subJobId, subJobJoinWaitMs);
    if (!settled.done) return;

    await opts.emitMerged(settled.summary);
    sse.publish("receipt");

    const parent = await queue.getJob(opts.parentJobId);
    if (!parent) return;
    if (parent.status === "queued" || parent.status === "leased" || parent.status === "running") {
      await queue.queueCommand({
        jobId: opts.parentJobId,
        command: "follow_up",
        payload: { note: `Sub-agent summary (${opts.subRunId}):\n${settled.summary}` },
        by: "subagent-join",
      });
      sse.publish("jobs", opts.parentJobId);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly runtime: { execute: (stream: string, cmd: any) => Promise<unknown> };
  readonly runStreamFn: (base: string, runId: string) => string;
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

    const rs = typeof merged.runStream === "string" && merged.runStream.trim().length > 0
      ? merged.runStream
      : spec.runStreamFn(parentStream, parentRunId);

    const mergedEvent = {
      type: "subagent.merged", runId: parentRunId, agentId: "orchestrator",
      subJobId: subJob.id, subRunId, task: delegate.task,
      ...(spec.mergeEventExtras ?? {}),
    };

    const emitMerged = async (summary: string) => {
      await spec.runtime.execute(rs, {
        type: "emit", eventId: makeEventId(rs),
        event: { ...mergedEvent, summary },
      });
    };

    await emitMerged(summaryNow.summary);
    sse.publish("receipt");

    if (!summaryNow.done) {
      scheduleSubJobJoin({ parentJobId: job.id, subJobId: subJob.id, subRunId, emitMerged });
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
      const failure = typeof normalizedResult.failure === "object" && normalizedResult.failure && !Array.isArray(normalizedResult.failure)
        ? normalizedResult.failure as Record<string, unknown>
        : undefined;
      const failureMessage = typeof failure?.message === "string" && failure.message.trim()
        ? failure.message
        : undefined;
      return {
        ok: false,
        error: typeof normalizedResult.note === "string" && normalizedResult.note.trim()
          ? normalizedResult.note
          : failureMessage
            ? failureMessage
          : "run failed",
        result: normalizedResult,
        noRetry: true,
      };
    }
    if (job.payload.kind === "factory.task.run") {
      await factoryService.applyTaskWorkerResult(job.payload as never, normalizedResult);
      await factoryService.reactObjective(String(job.payload.objectiveId ?? ""));
    }
    return { ok: true, result: normalizedResult };
  };

const worker = new JobWorker({
  queue,
  workerId: jobWorkerId,
  pollMs: jobPollMs,
  leaseMs: jobLeaseMs,
  concurrency: Math.max(1, Number(process.env.JOB_CONCURRENCY ?? 2)),
  handlers: {
    theorem: createWorkerHandler({
      defaultStream: "agents/theorem", defaultAgentId: "theorem", kind: "theorem.run",
      defaultSubConfig: { rounds: 1, maxDepth: 1, memoryWindow: 40, branchThreshold: 2 },
      runtime: theoremRuntime, runStreamFn: theoremRunStream, runner: theoremRunner,
    }),
    "axiom-guild": createWorkerHandler({
      defaultStream: "agents/axiom-guild", defaultAgentId: "axiom-guild", kind: "axiom-guild.run",
      defaultSubConfig: { rounds: 2, maxDepth: 2, memoryWindow: 60, branchThreshold: 2 },
      runtime: theoremRuntime, runStreamFn: theoremRunStream, runner: axiomGuildRunner,
    }),
    "axiom-simple": createWorkerHandler({
      defaultStream: "agents/axiom-simple", defaultAgentId: "axiom-simple", kind: "axiom-simple.run",
      defaultSubConfig: { workerCount: 3, repairMode: "auto" },
      runtime: axiomSimpleRuntime, runStreamFn: axiomSimpleRunStream, runner: axiomSimpleRunner,
    }),
    writer: createWorkerHandler({
      defaultStream: "agents/writer", defaultAgentId: "writer", kind: "writer.run",
      defaultSubConfig: { maxParallel: 1 },
      runtime: writerRuntime, runStreamFn: writerRunStream, runner: writerRunner,
      mergeEventExtras: { stepId: "delegate_task" },
    }),
    agent: createWorkerHandler({
      defaultStream: "agents/agent", defaultAgentId: "agent", kind: "agent.run",
      defaultSubConfig: { maxIterations: 3, maxToolOutputChars: 2500, memoryScope: "agent", workspace: "." },
      runtime: agentRuntime, runStreamFn: agentRunStream, runner: agentRunner,
    }),
    infra: createWorkerHandler({
      defaultStream: "agents/infra", defaultAgentId: "infra", kind: "infra.run",
      defaultSubConfig: { maxIterations: 4, maxToolOutputChars: 2500, memoryScope: "infra", workspace: "." },
      runtime: agentRuntime, runStreamFn: agentRunStream, runner: infraRunner,
    }),
    axiom: createWorkerHandler({
      defaultStream: "agents/axiom", defaultAgentId: "axiom", kind: "axiom.run",
      defaultSubConfig: {
        maxIterations: 12,
        maxToolOutputChars: 6000,
        memoryScope: "axiom",
        workspace: ".",
        leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
        leanTimeoutSeconds: 120,
        autoRepair: true,
      },
      runtime: agentRuntime, runStreamFn: agentRunStream, runner: axiomRunner,
    }),
    inspector: async (job, ctx) => {
      await ctx.pullCommands(["steer", "follow_up"]);
      await inspectorRunner(job.payload);
      return { ok: true, result: { runId: job.payload.runId as string | undefined, stream: INSPECTOR_STREAM } };
    },
    ...createFactoryWorkerHandlers(factoryService),
  },
});
worker.start();

// ============================================================================
// Heartbeat
// ============================================================================

const parseHeartbeatSpecs = (): ReadonlyArray<HeartbeatSpec> => {
  const specs: HeartbeatSpec[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^HEARTBEAT_(\w+)_INTERVAL_MS$/);
    if (!match || !value) continue;
    const agentId = match[1].toLowerCase();
    const intervalMs = Number(value);
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000) continue;
    specs.push({
      id: `heartbeat:${agentId}`,
      agentId,
      intervalMs,
      payload: { kind: `${agentId}.heartbeat` },
    });
  }
  return specs;
};

const heartbeats = parseHeartbeatSpecs().map((spec) =>
  createHeartbeat(spec, {
    enqueue: async (opts) => {
      const created = await queue.enqueue({
        agentId: opts.agentId,
        payload: opts.payload,
        lane: "collect",
        singletonMode: "cancel",
        sessionKey: `heartbeat:${opts.agentId}`,
        maxAttempts: 1,
      });
      sse.publish("jobs", created.id);
      return { id: created.id };
    },
  })
);
for (const hb of heartbeats) hb.start();

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
    todo: runtime,
    theorem: theoremRuntime,
    "axiom-simple": axiomSimpleRuntime,
    writer: writerRuntime,
    agent: agentRuntime,
    infra: agentRuntime,
    axiom: agentRuntime,
    inspector: inspectorRuntime,
    selfImprovement: selfImprovementRuntime,
    memory: memoryRuntime,
  },
  prompts: {
    theorem: THEOREM_PROMPTS,
    writer: WRITER_PROMPTS,
    inspector: INSPECTOR_PROMPTS,
    agent: AGENT_PROMPTS,
    infra: INFRA_PROMPTS,
    axiom: AXIOM_PROMPTS,
  },
  promptHashes: {
    theorem: THEOREM_PROMPTS_HASH,
    writer: WRITER_PROMPTS_HASH,
    inspector: INSPECTOR_PROMPTS_HASH,
    agent: AGENT_PROMPTS_HASH,
    infra: INFRA_PROMPTS_HASH,
    axiom: AXIOM_PROMPTS_HASH,
  },
  promptPaths: {
    theorem: THEOREM_PROMPTS_PATH,
    writer: WRITER_PROMPTS_PATH,
    inspector: INSPECTOR_PROMPTS_PATH,
    agent: AGENT_PROMPTS_PATH,
    infra: INFRA_PROMPTS_PATH,
    axiom: AXIOM_PROMPTS_PATH,
  },
  models: {
    theorem: THEOREM_MODEL,
    writer: WRITER_MODEL,
    inspector: INSPECTOR_MODEL,
    agent: AGENT_MODEL,
    infra: INFRA_MODEL,
    axiom: AXIOM_MODEL,
  },
  helpers: {
    memoryTools,
    delegationTools,
    factoryService,
    hubService,
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

const extractInspectorSourceName = (payload: Record<string, unknown>): string => {
  const source = payload.source;
  if (!source || typeof source !== "object") return "";
  const name = (source as Record<string, unknown>).name;
  return typeof name === "string" ? name : "";
};

const ensureInspectorSourceExists = async (rawSourceName: string): Promise<string> => {
  const sourceName = assertReceiptFileName(rawSourceName);
  const files = await listReceiptFiles(DATA_DIR);
  if (!files.some((file) => file.name === sourceName)) {
    throw new Error("inspector source file not found");
  }
  return sourceName;
};

app.post("/agents/:id/jobs", async (c) => {
  const agentId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  let payload = (typeof body.payload === "object" && body.payload)
    ? body.payload as Record<string, unknown>
    : body;
  const lane = body.lane === "steer" || body.lane === "follow_up" || body.lane === "collect"
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

  const payloadKind = typeof payload.kind === "string" ? payload.kind : "";
  const isInspector = agentId === "inspector" || payloadKind === "inspector.run";
  if (isInspector) {
    const sourceName = extractInspectorSourceName(payload);
    if (!sourceName) return text(400, "inspector source file required");
    let safeSourceName: string;
    try {
      safeSourceName = await ensureInspectorSourceExists(sourceName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) return text(404, "inspector source file not found");
      return text(400, message);
    }
    payload = {
      ...payload,
      stream: INSPECTOR_STREAM,
      source: { kind: "file", name: safeSourceName },
    };
  }

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
  const entries = await memoryTools.read({ scope, limit });
  return jsonResponse(200, { entries });
});

app.post("/memory/:scope/search", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const query = typeof body.query === "string" ? body.query : "";
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const entries = await memoryTools.search({ scope, query, limit });
  return jsonResponse(200, { entries });
});

app.post("/memory/:scope/summarize", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const query = typeof body.query === "string" ? body.query : undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const maxChars = typeof body.maxChars === "number" ? body.maxChars : undefined;
  const result = await memoryTools.summarize({ scope, query, limit, maxChars });
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
  const entries = await memoryTools.diff({ scope, fromTs, toTs });
  return jsonResponse(200, { entries });
});

const proposalState = async () => selfImprovementRuntime.state(IMPROVEMENT_STREAM);

app.post("/improvement/proposals", async (c) => {
  const body = await readJsonBody(c.req.raw);
  const artifactType = body.artifactType === "prompt_patch"
    || body.artifactType === "policy_patch"
    || body.artifactType === "harness_patch"
    ? body.artifactType
    : null;
  if (!artifactType) return text(400, "artifactType required");
  const target = typeof body.target === "string" ? body.target.trim() : "";
  const patch = typeof body.patch === "string" ? body.patch : "";
  if (!target) return text(400, "target required");
  if (!patch.trim()) return text(400, "patch required");
  const proposalId = typeof body.proposalId === "string" && body.proposalId.trim()
    ? body.proposalId
    : `proposal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  await selfImprovementRuntime.execute(IMPROVEMENT_STREAM, {
    type: "emit",
    eventId: eventId(IMPROVEMENT_STREAM),
    event: {
      type: "proposal.created",
      proposalId,
      artifactType,
      target,
      patch,
      createdBy: typeof body.createdBy === "string" ? body.createdBy : undefined,
    },
  });
  sse.publish("receipt");
  return jsonResponse(201, { ok: true, proposalId });
});

app.post("/improvement/:id/validate", async (c) => {
  const proposalId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const state = await proposalState();
  const proposal = state.proposals[proposalId];
  if (!proposal) return text(404, "proposal not found");
  const harness = await evaluateImprovementProposal({
    artifactType: proposal.artifactType,
    target: proposal.target,
    patch: proposal.patch,
    cwd: process.cwd(),
  });
  const status = harness.status;
  const report = harness.report;
  await selfImprovementRuntime.execute(IMPROVEMENT_STREAM, {
    type: "emit",
    eventId: eventId(IMPROVEMENT_STREAM),
    event: {
      type: "proposal.validated",
      proposalId,
      status,
      report,
      validatedBy: typeof body.validatedBy === "string" ? body.validatedBy : undefined,
    },
  });
  sse.publish("receipt");
  return jsonResponse(200, {
    ok: true,
    proposalId,
    status,
    report,
    checks: harness.checks,
    requestedBy: typeof body.validatedBy === "string" ? body.validatedBy : undefined,
  });
});

app.post("/improvement/:id/approve", async (c) => {
  const proposalId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const state = await proposalState();
  const proposal = state.proposals[proposalId];
  if (!proposal) return text(404, "proposal not found");
  if (proposal.status !== "validated" || proposal.validation?.status !== "passed") {
    return text(409, "proposal must be validated and passed before approval");
  }
  await selfImprovementRuntime.execute(IMPROVEMENT_STREAM, {
    type: "emit",
    eventId: eventId(IMPROVEMENT_STREAM),
    event: {
      type: "proposal.approved",
      proposalId,
      approvedBy: typeof body.approvedBy === "string" ? body.approvedBy : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
    },
  });
  sse.publish("receipt");
  return jsonResponse(200, { ok: true, proposalId, status: "approved" });
});

app.post("/improvement/:id/apply", async (c) => {
  const proposalId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const state = await proposalState();
  const proposal = state.proposals[proposalId];
  if (!proposal) return text(404, "proposal not found");
  if (proposal.status !== "approved") return text(409, "proposal must be approved before apply");
  await selfImprovementRuntime.execute(IMPROVEMENT_STREAM, {
    type: "emit",
    eventId: eventId(IMPROVEMENT_STREAM),
    event: {
      type: "proposal.applied",
      proposalId,
      appliedBy: typeof body.appliedBy === "string" ? body.appliedBy : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
    },
  });
  sse.publish("receipt");
  return jsonResponse(200, { ok: true, proposalId, status: "applied" });
});

app.post("/improvement/:id/revert", async (c) => {
  const proposalId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const state = await proposalState();
  const proposal = state.proposals[proposalId];
  if (!proposal) return text(404, "proposal not found");
  if (proposal.status !== "applied") return text(409, "proposal must be applied before revert");
  await selfImprovementRuntime.execute(IMPROVEMENT_STREAM, {
    type: "emit",
    eventId: eventId(IMPROVEMENT_STREAM),
    event: {
      type: "proposal.reverted",
      proposalId,
      revertedBy: typeof body.revertedBy === "string" ? body.revertedBy : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    },
  });
  sse.publish("receipt");
  return jsonResponse(200, { ok: true, proposalId, status: "reverted" });
});

app.get("/improvement/:id", async (c) => {
  const proposalId = c.req.param("id");
  const state = await proposalState();
  const proposal = state.proposals[proposalId];
  if (!proposal) return text(404, "proposal not found");
  return jsonResponse(200, proposal);
});

app.get("/improvement", async () => {
  const state = await proposalState();
  const proposals = Object.values(state.proposals).sort((a, b) => b.updatedAt - a.updatedAt);
  return jsonResponse(200, { proposals });
});

app.notFound(() => text(404, "Not found"));

const receiptWatcher = (() => {
  try {
    return fs.watch(DATA_DIR, { persistent: false }, () => {
      sse.publish("receipt");
    });
  } catch (err) {
    console.warn("Receipt watcher failed:", err);
    return undefined;
  }
})();

const httpServer = Bun.serve({
  fetch: app.fetch,
  port: PORT,
});
console.log(`Receipt server listening on http://localhost:${PORT}`);
console.log(`Receipt runtime root: ${WORKSPACE_ROOT}`);
console.log(`Receipt data dir: ${DATA_DIR}${FACTORY_RUNTIME.configPath ? ` (from ${FACTORY_RUNTIME.configPath})` : ""}`);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Receipt server shutting down (${signal})`);
  receiptWatcher?.close();
  worker.stop();
  for (const hb of heartbeats) hb.stop();
  const forceExit = setTimeout(() => {
    process.exit(0);
  }, 2_000);
  forceExit.unref();
  httpServer.stop();
  clearTimeout(forceExit);
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
