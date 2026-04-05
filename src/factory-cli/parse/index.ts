import fs from "node:fs/promises";
import path from "node:path";

import { fold } from "@receipt/core/chain";
import type { Receipt } from "@receipt/core/types";
import { desc } from "drizzle-orm";

import { jsonlStore } from "../../adapters/jsonl";
import { getReceiptDb } from "../../db/client";
import * as schema from "../../db/schema";
import type { AgentEvent } from "../../modules/agent";
import { initial as initialAgent, reduce as reduceAgent } from "../../modules/agent";
import type { FactoryEvent } from "../../modules/factory";
import type { JobEvent } from "../../modules/job";
import { initial as initialJob, reduce as reduceJob } from "../../modules/job";
import {
  filterReceiptsAsOf,
  readObjectiveReplaySnapshot,
} from "../../services/factory/objective-replay";
import { readObjectiveAnalysis, type ObjectiveAnalysis } from "../analyze";
export { renderFactoryParsedRunText } from "./render";

type ParseTargetKind = "objective" | "chat" | "run" | "job";
type ParseFocusKind = "task" | "candidate";

type StreamEntry = {
  readonly stream: string;
  readonly mtimeMs: number;
};

type ParseResolution = {
  readonly kind: ParseTargetKind;
  readonly id: string;
  readonly stream: string;
  readonly latest: boolean;
  readonly matchedBy: string;
  readonly ambiguousMatches: ReadonlyArray<string>;
  readonly focusKind?: ParseFocusKind;
  readonly focusId?: string;
};

type ParseTimelineItem = {
  readonly at?: number;
  readonly source: "objective" | "chat" | "run" | "job";
  readonly type: string;
  readonly summary: string;
  readonly stream?: string;
  readonly runId?: string;
  readonly objectiveId?: string;
  readonly jobId?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
};

type FactoryChatReplayRun = {
  readonly runId: string;
  readonly problem: string;
  readonly status: string;
  readonly finalResponse?: string;
  readonly startupObjectiveId?: string;
  readonly latestBoundObjectiveId?: string;
  readonly bindings: ReadonlyArray<{
    readonly at: number;
    readonly objectiveId: string;
    readonly reason: string;
    readonly created?: boolean;
  }>;
  readonly continuation?: {
    readonly objectiveId?: string;
    readonly nextRunId: string;
    readonly nextJobId: string;
    readonly summary: string;
  };
};

type FactoryChatReplay = {
  readonly stream: string;
  readonly receiptCount: number;
  readonly latestObjectiveId?: string;
  readonly runs: ReadonlyArray<FactoryChatReplayRun>;
  readonly threadTimeline: ReadonlyArray<{
    readonly at: number;
    readonly type: "thread.bound" | "run.continued";
    readonly runId: string;
    readonly objectiveId?: string;
    readonly reason?: string;
    readonly created?: boolean;
    readonly nextRunId?: string;
    readonly nextJobId?: string;
  }>;
};

type ParsedAgentRunEvent = {
  readonly at: number;
  readonly type: AgentEvent["type"];
  readonly summary: string;
  readonly iteration?: number;
  readonly tool?: string;
};

type ParsedAgentToolMetric = {
  readonly tool: string;
  readonly count: number;
  readonly errorCount: number;
  readonly totalDurationMs: number;
};

type ParsedAgentToolMetricAccumulator = {
  tool: string;
  count: number;
  errorCount: number;
  totalDurationMs: number;
};

type ParsedAgentRun = {
  readonly stream: string;
  readonly runId: string;
  readonly problem: string;
  readonly status: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly objectiveId?: string;
  readonly chatId?: string;
  readonly receiptCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly durationMs: number;
  readonly finalResponse?: string;
  readonly metrics: {
    readonly iterations: number;
    readonly thoughts: number;
    readonly actionPlans: number;
    readonly toolCalls: number;
    readonly toolErrors: number;
    readonly memorySlices: number;
    readonly memoryChars: number;
    readonly validationsOk: number;
    readonly validationsFailed: number;
    readonly contextPrunes: number;
    readonly contextCompactions: number;
    readonly overflowRecoveries: number;
    readonly delegated: number;
    readonly mergedSubagents: number;
    readonly continuations: number;
  };
  readonly topTools: ReadonlyArray<ParsedAgentToolMetric>;
  readonly sequence: ReadonlyArray<ParsedAgentRunEvent>;
};

type ParsedJobProgress = {
  readonly at: number;
  readonly eventType?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly progressAt?: number;
  readonly tokensUsed?: number;
  readonly lastMessage?: string;
};

type ParsedJobCommand = {
  readonly at: number;
  readonly commandId: string;
  readonly command: string;
  readonly by?: string;
  readonly consumedAt?: number;
  readonly payload?: Record<string, unknown>;
};

type ParsedJobEvent = {
  readonly at: number;
  readonly type: JobEvent["type"];
  readonly summary: string;
  readonly workerId?: string;
  readonly commandId?: string;
  readonly status?: string;
};

type ParsedTaskCommandEvent = {
  readonly id: string;
  readonly orderStarted?: number;
  readonly orderCompleted?: number;
  readonly command: string;
  readonly status: string;
  readonly exitCode?: number | null;
  readonly outputPreview?: string;
};

type ParsedTaskCommandAccumulator = {
  id: string;
  orderStarted?: number;
  orderCompleted?: number;
  command: string;
  status: string;
  exitCode?: number | null;
  outputPreview?: string;
};

type ParsedTaskLog = {
  readonly exists: boolean;
  readonly originalPath?: string;
  readonly resolvedPath?: string;
  readonly sizeBytes?: number;
  readonly modifiedAt?: number;
  readonly format?: "jsonl" | "text" | "mixed";
  readonly preview?: string;
  readonly commands: ReadonlyArray<ParsedTaskCommandEvent>;
  readonly agentMessages: ReadonlyArray<string>;
  readonly eventTypes: ReadonlyArray<string>;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
  };
};

type ParsedFileArtifact = {
  readonly exists: boolean;
  readonly originalPath?: string;
  readonly resolvedPath?: string;
  readonly sizeBytes?: number;
  readonly modifiedAt?: number;
  readonly preview?: string;
  readonly json?: unknown;
};

type ParsedTaskRun = {
  readonly jobId: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly objectiveId?: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly durationMs?: number;
  readonly summary?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly progress: ReadonlyArray<ParsedJobProgress>;
  readonly commands: ReadonlyArray<ParsedJobCommand>;
  readonly manifest: ParsedFileArtifact;
  readonly contextPack: ParsedFileArtifact;
  readonly resultFile: ParsedFileArtifact;
  readonly lastMessage: ParsedFileArtifact;
  readonly stdout: ParsedTaskLog;
  readonly stderr: ParsedTaskLog;
};

type ParsedJob = {
  readonly stream: string;
  readonly jobId: string;
  readonly status: string;
  readonly agentId: string;
  readonly lane: string;
  readonly payloadKind?: string;
  readonly objectiveId?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly runId?: string;
  readonly sessionKey?: string;
  readonly singletonMode?: string;
  readonly receiptCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly durationMs?: number;
  readonly retryCount: number;
  readonly abortRequested: boolean;
  readonly lastError?: string;
  readonly canceledReason?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly events: ReadonlyArray<ParsedJobEvent>;
  readonly progress: ReadonlyArray<ParsedJobProgress>;
  readonly queueCommands: ReadonlyArray<ParsedJobCommand>;
  readonly taskRun?: ParsedTaskRun;
};

export type FactoryParsedRun = {
  readonly requestedId?: string;
  readonly resolved: ParseResolution;
  readonly warnings: ReadonlyArray<string>;
  readonly links: {
    readonly objectiveId?: string;
    readonly chatId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly taskId?: string;
    readonly candidateId?: string;
    readonly streams: ReadonlyArray<string>;
  };
  readonly summary: {
    readonly title?: string;
    readonly status?: string;
    readonly text?: string;
    readonly blockedReason?: string;
  };
  readonly window: {
    readonly createdAt?: number;
    readonly updatedAt?: number;
    readonly durationMs?: number;
  };
  readonly inputs: {
    readonly userPrompt?: string;
    readonly objectivePrompt?: string;
    readonly taskPrompt?: string;
    readonly problem?: string;
    readonly checks?: ReadonlyArray<string>;
    readonly payload?: Readonly<Record<string, unknown>>;
  };
  readonly outputs: {
    readonly finalResponse?: string;
    readonly latestSummary?: string;
    readonly lastMessage?: string;
    readonly result?: Readonly<Record<string, unknown>>;
  };
  readonly timeline: ReadonlyArray<ParseTimelineItem>;
  readonly objectiveAnalysis?: ObjectiveAnalysis;
  readonly chatReplay?: FactoryChatReplay;
  readonly run?: ParsedAgentRun;
  readonly job?: ParsedJob;
  readonly relatedRuns: ReadonlyArray<ParsedAgentRun>;
  readonly relatedJobs: ReadonlyArray<ParsedJob>;
  readonly taskRuns: ReadonlyArray<ParsedTaskRun>;
};

type ParseReadOptions = {
  readonly asOfTs?: number;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const truncateInline = (value: string | undefined, max = 180): string | undefined => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}\u2026`;
};

const truncateBlock = (value: string | undefined, max = 1_400): string | undefined => {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}\u2026`;
};

const fileExists = async (filePath: string | undefined): Promise<boolean> => {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readJsonIfExists = async (filePath: string | undefined): Promise<unknown | undefined> => {
  if (!filePath || !await fileExists(filePath)) return undefined;
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as unknown;
};

const readTextIfExists = async (filePath: string | undefined): Promise<string | undefined> => {
  if (!filePath || !await fileExists(filePath)) return undefined;
  const raw = await fs.readFile(filePath, "utf-8");
  return raw;
};

const normalizePosix = (value: string): string =>
  value.replace(/\\/g, "/").replace(/\/+$/u, "");

const pathRootHint = (value: string | undefined): string | undefined => {
  const normalized = normalizePosix(value ?? "");
  if (!normalized.startsWith("/")) return undefined;
  for (const marker of ["/.receipt/", "/skills/", "/profiles/", "/src/", "/package.json", "/README.md", "/node_modules/"]) {
    const index = normalized.indexOf(marker);
    if (index > 0) return normalized.slice(0, index);
  }
  return undefined;
};

const rewriteRepoPath = (
  repoRoot: string,
  originalPath: string | undefined,
  candidateRoots: ReadonlyArray<string>,
): {
  readonly originalPath?: string;
  readonly resolvedPath?: string;
} => {
  const original = originalPath?.trim();
  if (!original) return {};
  const normalized = normalizePosix(original);
  for (const root of candidateRoots) {
    const normalizedRoot = normalizePosix(root);
    if (!(normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`))) continue;
    const relative = path.posix.relative(normalizedRoot, normalized);
    const resolvedPath = path.join(repoRoot, ...relative.split("/").filter(Boolean));
    return { originalPath: original, resolvedPath };
  }
  return { originalPath: original, resolvedPath: original };
};

const uniqueStrings = (values: ReadonlyArray<string | undefined>): ReadonlyArray<string> =>
  [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];

const parseChatIdFromStream = (stream: string | undefined): string | undefined => {
  const match = stream?.match(/\/sessions\/([^/]+)/u);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
};

const parseRunIdFromStream = (stream: string | undefined): string | undefined => {
  const match = stream?.match(/\/runs\/([^/]+)/u);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
};

const readStreamEntries = async (dataDir: string): Promise<ReadonlyArray<StreamEntry>> => {
  const db = getReceiptDb(dataDir);
  const rows = db.orm.select({
    name: schema.streams.name,
    updatedAt: schema.streams.updatedAt,
    lastTs: schema.streams.lastTs,
  })
    .from(schema.streams)
    .orderBy(desc(schema.streams.updatedAt), desc(schema.streams.name))
    .all();
  return rows.map((row) => ({
    stream: row.name,
    mtimeMs: Math.max(Number(row.updatedAt), Number(row.lastTs ?? 0)),
  }));
};

const streamKind = (stream: string): ParseTargetKind | undefined => {
  if (stream.startsWith("factory/objectives/")) return "objective";
  if (stream.startsWith("jobs/")) return "job";
  if (stream.includes("/runs/")) return "run";
  if (stream.includes("/sessions/")) return "chat";
  return undefined;
};

const pickLatest = (entries: ReadonlyArray<StreamEntry>): StreamEntry | undefined =>
  [...entries].sort((left, right) => right.mtimeMs - left.mtimeMs || right.stream.localeCompare(left.stream))[0];

const findObjectiveByFocus = async (
  dataDir: string,
  entries: ReadonlyArray<StreamEntry>,
  focusId: string,
): Promise<ReadonlyArray<StreamEntry>> => {
  const objectiveEntries = [...entries]
    .filter((entry) => entry.stream.startsWith("factory/objectives/"))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.stream.localeCompare(left.stream));
  const store = jsonlStore<FactoryEvent>(dataDir);
  const matches: StreamEntry[] = [];
  for (const entry of objectiveEntries) {
    const chain = await store.read(entry.stream);
    const found = chain.some((receipt) => {
      const event = receipt.body;
      if ("taskId" in event && event.taskId === focusId) return true;
      if ("candidateId" in event && event.candidateId === focusId) return true;
      if (event.type === "task.added" && event.task.taskId === focusId) return true;
      if (event.type === "candidate.created" && event.candidate.candidateId === focusId) return true;
      if (event.type === "task.dispatched" && event.jobId === focusId) return true;
      return false;
    });
    if (found) matches.push(entry);
  }
  return matches;
};

const resolveParseTarget = async (
  dataDir: string,
  requestedId: string | undefined,
): Promise<ParseResolution> => {
  const entries = await readStreamEntries(dataDir);
  const trimmed = requestedId?.trim();
  if (!trimmed || trimmed === "latest") {
    const latestObjective = pickLatest(entries.filter((entry) => entry.stream.startsWith("factory/objectives/")));
    if (!latestObjective) throw new Error(`No objective receipt streams found under ${dataDir}`);
    return {
      kind: "objective",
      id: latestObjective.stream.replace(/^factory\/objectives\//u, ""),
      stream: latestObjective.stream,
      latest: true,
      matchedBy: "latest",
      ambiguousMatches: [],
    };
  }

  const exactStream = entries.find((entry) => entry.stream === trimmed);
  if (exactStream) {
    return {
      kind: streamKind(exactStream.stream) ?? "objective",
      id: trimmed,
      stream: exactStream.stream,
      latest: false,
      matchedBy: "exact-stream",
      ambiguousMatches: [],
    };
  }

  const objectiveStream = trimmed.startsWith("factory/objectives/") ? trimmed : `factory/objectives/${trimmed}`;
  const exactObjective = entries.find((entry) => entry.stream === objectiveStream);
  if (exactObjective) {
    return {
      kind: "objective",
      id: exactObjective.stream.replace(/^factory\/objectives\//u, ""),
      stream: exactObjective.stream,
      latest: false,
      matchedBy: "objective-id",
      ambiguousMatches: [],
    };
  }

  const jobStream = trimmed.startsWith("jobs/") ? trimmed : `jobs/${trimmed}`;
  const exactJob = entries.find((entry) => entry.stream === jobStream);
  if (exactJob) {
    return {
      kind: "job",
      id: exactJob.stream.replace(/^jobs\//u, ""),
      stream: exactJob.stream,
      latest: false,
      matchedBy: "job-id",
      ambiguousMatches: [],
    };
  }

  const runMatches = [...entries]
    .filter((entry) => entry.stream.includes("/runs/") && entry.stream.endsWith(`/runs/${trimmed}`))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.stream.localeCompare(left.stream));
  if (runMatches.length > 0) {
    return {
      kind: "run",
      id: parseRunIdFromStream(runMatches[0]!.stream) ?? trimmed,
      stream: runMatches[0]!.stream,
      latest: false,
      matchedBy: "run-id",
      ambiguousMatches: runMatches.slice(1).map((entry) => entry.stream),
    };
  }

  const chatMatches = [...entries]
    .filter((entry) => entry.stream.includes("/sessions/") && !entry.stream.includes("/runs/") && entry.stream.endsWith(`/sessions/${encodeURIComponent(trimmed)}`))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.stream.localeCompare(left.stream));
  if (chatMatches.length > 0) {
    return {
      kind: "chat",
      id: parseChatIdFromStream(chatMatches[0]!.stream) ?? trimmed,
      stream: chatMatches[0]!.stream,
      latest: false,
      matchedBy: "chat-id",
      ambiguousMatches: chatMatches.slice(1).map((entry) => entry.stream),
    };
  }

  if (trimmed.startsWith("task_") || trimmed.includes("_candidate_")) {
    const focusKind: ParseFocusKind = trimmed.includes("_candidate_") ? "candidate" : "task";
    const matches = await findObjectiveByFocus(dataDir, entries, trimmed);
    if (matches.length > 0) {
      return {
        kind: "objective",
        id: matches[0]!.stream.replace(/^factory\/objectives\//u, ""),
        stream: matches[0]!.stream,
        latest: false,
        matchedBy: `${focusKind}-id`,
        ambiguousMatches: matches.slice(1).map((entry) => entry.stream),
        focusKind,
        focusId: trimmed,
      };
    }
  }

  const fuzzy = [...entries]
    .filter((entry) => entry.stream.includes(trimmed))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.stream.localeCompare(left.stream));
  if (fuzzy.length > 0) {
    return {
      kind: streamKind(fuzzy[0]!.stream) ?? "objective",
      id: trimmed,
      stream: fuzzy[0]!.stream,
      latest: false,
      matchedBy: "fuzzy-stream",
      ambiguousMatches: fuzzy.slice(1).map((entry) => entry.stream),
    };
  }

  throw new Error(`Unable to resolve factory receipt target '${trimmed}'`);
};

const isThreadBoundEvent = (
  event: AgentEvent,
): event is Extract<AgentEvent, { readonly type: "thread.bound" }> =>
  event.type === "thread.bound";

const isRunContinuedEvent = (
  event: AgentEvent,
): event is Extract<AgentEvent, { readonly type: "run.continued" }> =>
  event.type === "run.continued";

const readChatReplay = async (dataDir: string, stream: string): Promise<FactoryChatReplay> => {
  const chain = await jsonlStore<AgentEvent>(dataDir).read(stream);
  if (chain.length === 0) {
    throw new Error(`No receipts found for ${stream}`);
  }
  const runChains = new Map<string, Array<(typeof chain)[number]>>();
  for (const receipt of chain) {
    const runId = typeof receipt.body.runId === "string" ? receipt.body.runId : undefined;
    if (!runId) continue;
    const existing = runChains.get(runId);
    if (existing) existing.push(receipt);
    else runChains.set(runId, [receipt]);
  }
  const runs = [...runChains.entries()].map(([runId, runChain]) => {
    const state = fold(runChain, reduceAgent, initialAgent);
    const bindings = runChain
      .filter((receipt): receipt is typeof receipt & { readonly body: Extract<AgentEvent, { readonly type: "thread.bound" }> } =>
        isThreadBoundEvent(receipt.body))
      .map((receipt) => ({
        at: receipt.ts,
        objectiveId: receipt.body.objectiveId,
        reason: receipt.body.reason,
        created: receipt.body.created,
      }));
    const continuationReceipt = [...runChain].reverse()
      .map((receipt) => receipt.body)
      .find(isRunContinuedEvent);
    const continuation = continuationReceipt
      ? {
          objectiveId: continuationReceipt.objectiveId,
          nextRunId: continuationReceipt.nextRunId,
          nextJobId: continuationReceipt.nextJobId,
          summary: continuationReceipt.summary,
        }
      : undefined;
    return {
      runId,
      problem: state.problem,
      status: state.status,
      finalResponse: state.finalResponse,
      startupObjectiveId: bindings.find((binding) => binding.reason === "startup")?.objectiveId,
      latestBoundObjectiveId: bindings.at(-1)?.objectiveId,
      bindings,
      continuation,
    } satisfies FactoryChatReplayRun;
  });
  const threadTimeline = chain
    .filter((receipt): receipt is typeof receipt & {
      readonly body: Extract<AgentEvent, { readonly type: "thread.bound" | "run.continued" }>;
    } => isThreadBoundEvent(receipt.body) || isRunContinuedEvent(receipt.body))
    .map((receipt) => {
      const body = receipt.body;
      if (body.type === "thread.bound") {
        return {
          at: receipt.ts,
          type: body.type,
          runId: body.runId,
          objectiveId: body.objectiveId,
          reason: body.reason,
          created: body.created,
        } satisfies FactoryChatReplay["threadTimeline"][number];
      }
      return {
        at: receipt.ts,
        type: body.type,
        runId: body.runId,
        objectiveId: body.objectiveId,
        nextRunId: body.nextRunId,
        nextJobId: body.nextJobId,
      } satisfies FactoryChatReplay["threadTimeline"][number];
    });
  return {
    stream,
    receiptCount: chain.length,
    latestObjectiveId: [...threadTimeline].reverse().find((entry) => entry.type === "thread.bound")?.objectiveId,
    runs,
    threadTimeline,
  };
};

const runEventSummary = (event: AgentEvent): string => {
  switch (event.type) {
    case "problem.set":
      return `Problem: ${truncateInline(event.problem, 220)}`;
    case "run.configured":
      return `Configured ${event.model} (${event.workflow.id})`;
    case "profile.selected":
      return `Profile selected: ${event.profileId}`;
    case "profile.resolved":
      return `Profile resolved: ${event.rootProfileId}`;
    case "thread.bound":
      return `Bound to ${event.objectiveId} (${event.reason})`;
    case "objective.handoff":
      return `Objective ${event.status}: ${truncateInline(event.summary, 220)}`;
    case "profile.handoff":
      return `Handed off from ${event.fromProfileId} to ${event.toProfileId}: ${truncateInline([
        event.goal,
        event.reason,
        event.currentState ? `state ${event.currentState}` : undefined,
        event.nextRunId ? `next run ${event.nextRunId}` : undefined,
        event.nextJobId ? `next job ${event.nextJobId}` : undefined,
      ].filter(Boolean).join(" · "), 220)}`;
    case "run.status":
      return `Run ${event.status}${event.note ? `: ${truncateInline(event.note, 220)}` : ""}`;
    case "iteration.started":
      return `Iteration ${event.iteration} started`;
    case "thought.logged":
      return `Thought: ${truncateInline(event.content, 220)}`;
    case "action.planned":
      return event.actionType === "tool"
        ? `Planned tool: ${event.name ?? "unknown"}`
        : "Planned final response";
    case "tool.called":
      return event.error
        ? `${event.tool} failed: ${truncateInline(event.error, 220)}`
        : `${event.tool} called${event.summary ? `: ${truncateInline(event.summary, 220)}` : ""}`;
    case "tool.observed":
      return `${event.tool} observed: ${truncateInline(event.output, 220) ?? "output"}`;
    case "memory.slice":
      return `Memory slice: ${event.scope} (${event.chars} chars)`;
    case "validation.report":
      return `${event.gate}: ${event.ok ? "ok" : "failed"}${event.summary ? ` (${truncateInline(event.summary, 220)})` : ""}`;
    case "response.finalized":
      return `Final response: ${truncateInline(event.content, 220)}`;
    case "run.continued":
      return `Continued as ${event.nextRunId}: ${truncateInline(event.summary, 220)}`;
    case "context.pruned":
      return `Context pruned (${event.mode}): ${event.before} -> ${event.after}`;
    case "context.compacted":
      return `Context compacted (${event.reason}): ${event.before} -> ${event.after}`;
    case "overflow.recovered":
      return `Overflow recovered${event.note ? `: ${truncateInline(event.note, 220)}` : ""}`;
    case "subagent.merged":
      return `Merged subagent ${event.subRunId}: ${truncateInline(event.summary, 220)}`;
    case "agent.delegated":
      return `Delegated to ${event.delegatedTo}: ${truncateInline(event.summary, 220)}`;
    case "failure.report":
      return `Failure: ${truncateInline(event.failure.message, 220)}`;
    default:
      return event.type;
  }
};

const incrementMetric = (counts: Map<string, number>, key: string, delta = 1): void => {
  counts.set(key, (counts.get(key) ?? 0) + delta);
};

const readAgentRun = async (
  dataDir: string,
  stream: string,
  options: {
    readonly runId?: string;
    readonly asOfTs?: number;
  } = {},
): Promise<ParsedAgentRun | undefined> => {
  const streamChain = filterReceiptsAsOf(
    await jsonlStore<AgentEvent>(dataDir).read(stream),
    options.asOfTs,
  );
  const chain = options.runId
    ? streamChain.filter((receipt) => receipt.body.runId === options.runId)
    : streamChain;
  if (chain.length === 0) return undefined;
  const state = fold(chain, reduceAgent, initialAgent);
  const runId = options.runId ?? state.runId ?? asString(chain[0]?.body.runId);
  if (!runId) return undefined;

  let model: string | undefined;
  let profileId: string | undefined;
  let objectiveId: string | undefined;
  let chatId: string | undefined;
  let iterations = 0;
  let thoughts = 0;
  let actionPlans = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let memorySlices = 0;
  let memoryChars = 0;
  let validationsOk = 0;
  let validationsFailed = 0;
  let contextPrunes = 0;
  let contextCompactions = 0;
  let overflowRecoveries = 0;
  let delegated = 0;
  let mergedSubagents = 0;
  let continuations = 0;
  const toolMetrics = new Map<string, ParsedAgentToolMetricAccumulator>();
  const sequence: ParsedAgentRunEvent[] = [];

  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type === "run.configured") {
      model = event.model;
      const extra = asRecord(event.config.extra);
      profileId = asString(extra?.profileId) ?? profileId;
      objectiveId = asString(extra?.objectiveId) ?? objectiveId;
      chatId = parseChatIdFromStream(asString(extra?.stream)) ?? chatId;
    }
    if (event.type === "thread.bound") {
      objectiveId = event.objectiveId;
      chatId = event.chatId ?? chatId;
    }
    if (event.type === "iteration.started") iterations = Math.max(iterations, event.iteration);
    if (event.type === "thought.logged") thoughts += 1;
    if (event.type === "action.planned") actionPlans += 1;
    if (event.type === "tool.called") {
      toolCalls += 1;
      const current = toolMetrics.get(event.tool) ?? {
        tool: event.tool,
        count: 0,
        errorCount: 0,
        totalDurationMs: 0,
      };
      current.count += 1;
      current.totalDurationMs += Math.max(0, event.durationMs ?? 0);
      if (event.error) {
        current.errorCount += 1;
        toolErrors += 1;
      }
      toolMetrics.set(event.tool, current);
    }
    if (event.type === "memory.slice") {
      memorySlices += 1;
      memoryChars += event.chars;
    }
    if (event.type === "validation.report") {
      if (event.ok) validationsOk += 1;
      else validationsFailed += 1;
    }
    if (event.type === "context.pruned") contextPrunes += 1;
    if (event.type === "context.compacted") contextCompactions += 1;
    if (event.type === "overflow.recovered") overflowRecoveries += 1;
    if (event.type === "agent.delegated") delegated += 1;
    if (event.type === "subagent.merged") mergedSubagents += 1;
    if (event.type === "run.continued") continuations += 1;

    sequence.push({
      at: receipt.ts,
      type: event.type,
      summary: runEventSummary(event),
      iteration: "iteration" in event ? event.iteration : undefined,
      tool: event.type === "tool.called" || event.type === "tool.observed" ? event.tool : undefined,
    });
  }

  return {
    stream,
    runId,
    problem: state.problem,
    status: state.status,
    model,
    profileId,
    objectiveId,
    chatId,
    receiptCount: chain.length,
    createdAt: chain[0]!.ts,
    updatedAt: chain.at(-1)!.ts,
    durationMs: Math.max(0, chain.at(-1)!.ts - chain[0]!.ts),
    finalResponse: state.finalResponse,
    metrics: {
      iterations,
      thoughts,
      actionPlans,
      toolCalls,
      toolErrors,
      memorySlices,
      memoryChars,
      validationsOk,
      validationsFailed,
      contextPrunes,
      contextCompactions,
      overflowRecoveries,
      delegated,
      mergedSubagents,
      continuations,
    },
    topTools: [...toolMetrics.values()].sort((left, right) =>
      right.count - left.count
      || right.errorCount - left.errorCount
      || left.tool.localeCompare(right.tool)),
    sequence,
  };
};

const jobEventSummary = (event: JobEvent): string => {
  switch (event.type) {
    case "job.enqueued":
      return `${event.agentId} enqueued (${event.lane})`;
    case "job.leased":
      return `Leased to ${event.workerId} (attempt ${event.attempt})`;
    case "job.heartbeat":
      return `Heartbeat from ${event.workerId}`;
    case "job.progress": {
      const result = asRecord(event.result);
      const status = asString(result?.status);
      const summary = truncateInline(asString(result?.summary), 220);
      return `${status ? `${status}: ` : ""}${summary ?? "progress"}`;
    }
    case "job.completed":
      return `Completed`;
    case "job.failed":
      return `Failed: ${truncateInline(event.error, 220)}`;
    case "job.canceled":
      return `Canceled${event.reason ? `: ${truncateInline(event.reason, 220)}` : ""}`;
    case "queue.command":
      return `Command ${event.command}${event.by ? ` by ${event.by}` : ""}`;
    case "queue.command.consumed":
      return `Command ${event.commandId} consumed`;
    case "job.lease_expired":
      return event.willRetry ? "Lease expired; retrying" : "Lease expired";
    default:
      return "unknown";
  }
};

const parseStructuredLog = async (
  originalPath: string | undefined,
  resolvedPath: string | undefined,
): Promise<ParsedTaskLog> => {
  if (!resolvedPath || !await fileExists(resolvedPath)) {
    return {
      exists: false,
      originalPath,
      resolvedPath,
      commands: [],
      agentMessages: [],
      eventTypes: [],
    };
  }
  const stat = await fs.stat(resolvedPath).catch(() => undefined);
  const raw = await fs.readFile(resolvedPath, "utf-8");
  const lines = raw.split(/\r?\n/u).filter(Boolean);
  const commands = new Map<string, ParsedTaskCommandAccumulator>();
  const agentMessages: string[] = [];
  const eventTypes: string[] = [];
  let format: ParsedTaskLog["format"] = "jsonl";
  let usage: ParsedTaskLog["usage"];
  let preview = truncateBlock(raw, 1_400);

  for (const [index, line] of lines.entries()) {
    const order = index + 1;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      format = format === "jsonl" ? "mixed" : "text";
      continue;
    }
    const type = asString(parsed.type);
    if (!type) continue;
    eventTypes.push(type);
    if (type === "turn.completed") {
      const parsedUsage = asRecord(parsed.usage);
      usage = {
        inputTokens: asNumber(parsedUsage?.input_tokens),
        cachedInputTokens: asNumber(parsedUsage?.cached_input_tokens),
        outputTokens: asNumber(parsedUsage?.output_tokens),
      };
      continue;
    }
    if (!type.startsWith("item.")) continue;
    const item = asRecord(parsed.item);
    const itemId = asString(item?.id);
    const itemType = asString(item?.type);
    if (itemType === "agent_message") {
      const text = truncateBlock(asString(item?.text), 1_200);
      if (text) agentMessages.push(text);
      continue;
    }
    if (itemType !== "command_execution" || !itemId) continue;
    const current: ParsedTaskCommandAccumulator = commands.get(itemId) ?? {
      id: itemId,
      command: asString(item?.command) ?? "unknown",
      status: asString(item?.status) ?? "unknown",
    };
    current.command = asString(item?.command) ?? current.command;
    current.status = asString(item?.status) ?? current.status;
    const exitCode = item?.exit_code;
    current.exitCode = typeof exitCode === "number" || exitCode === null
      ? exitCode
      : current.exitCode;
    const outputPreview = truncateBlock(asString(item?.aggregated_output), 1_200);
    current.outputPreview = outputPreview ?? current.outputPreview;
    if (type === "item.started") current.orderStarted = order;
    if (type === "item.completed") current.orderCompleted = order;
    commands.set(itemId, current);
  }

  if (format === "jsonl" && !lines.every((line) => line.trim().startsWith("{"))) {
    format = "mixed";
  }

  return {
    exists: true,
    originalPath,
    resolvedPath,
    sizeBytes: stat?.size,
    modifiedAt: stat?.mtimeMs,
    format,
    preview,
    commands: [...commands.values()].sort((left, right) =>
      (left.orderStarted ?? left.orderCompleted ?? Number.MAX_SAFE_INTEGER)
      - (right.orderStarted ?? right.orderCompleted ?? Number.MAX_SAFE_INTEGER)),
    agentMessages,
    eventTypes: uniqueStrings(eventTypes),
    usage,
  };
};

const readFileArtifact = async (
  originalPath: string | undefined,
  resolvedPath: string | undefined,
  options: {
    readonly parseJson?: boolean;
    readonly previewChars?: number;
  } = {},
): Promise<ParsedFileArtifact> => {
  if (!resolvedPath || !await fileExists(resolvedPath)) {
    return {
      exists: false,
      originalPath,
      resolvedPath,
    };
  }
  const stat = await fs.stat(resolvedPath);
  const raw = await fs.readFile(resolvedPath, "utf-8");
  return {
    exists: true,
    originalPath,
    resolvedPath,
    sizeBytes: stat.size,
    modifiedAt: stat.mtimeMs,
    preview: truncateBlock(raw, options.previewChars ?? 1_200),
    json: options.parseJson ? JSON.parse(raw) as unknown : undefined,
  };
};

const readJob = async (
  dataDir: string,
  repoRoot: string,
  stream: string,
  options: ParseReadOptions = {},
): Promise<ParsedJob | undefined> => {
  const chain = filterReceiptsAsOf(
    await jsonlStore<JobEvent>(dataDir).read(stream),
    options.asOfTs,
  );
  if (chain.length === 0) return undefined;
  const state = fold(chain, reduceJob, initialJob);
  const jobId = stream.replace(/^jobs\//u, "");
  const job = state.jobs[jobId];
  if (!job) return undefined;

  const enqueued = chain.find((receipt) => receipt.body.type === "job.enqueued")?.body;
  const payload = asRecord(enqueued && enqueued.type === "job.enqueued" ? enqueued.payload : undefined) ?? {};
  const result = asRecord(job.result);
  const progress = chain
    .filter((receipt): receipt is Receipt<Extract<JobEvent, { readonly type: "job.progress" }>> =>
      receipt.body.type === "job.progress")
    .map((receipt) => {
      const progressResult = asRecord(receipt.body.result);
      return {
        at: receipt.ts,
        eventType: asString(progressResult?.eventType),
        status: asString(progressResult?.status),
        summary: truncateInline(asString(progressResult?.summary), 220),
        progressAt: asNumber(progressResult?.progressAt),
        tokensUsed: asNumber(progressResult?.tokensUsed),
        lastMessage: truncateBlock(asString(progressResult?.lastMessage), 1_200),
      } satisfies ParsedJobProgress;
    });
  const queueCommands = chain
    .filter((receipt): receipt is Receipt<Extract<JobEvent, { readonly type: "queue.command" | "queue.command.consumed" }>> =>
      receipt.body.type === "queue.command" || receipt.body.type === "queue.command.consumed")
    .map((receipt) => {
      if (receipt.body.type === "queue.command") {
        return {
          at: receipt.ts,
          commandId: receipt.body.commandId,
          command: receipt.body.command,
          by: receipt.body.by,
          payload: asRecord(receipt.body.payload),
        } satisfies ParsedJobCommand;
      }
      return {
        at: receipt.ts,
        commandId: receipt.body.commandId,
        command: "consumed",
        consumedAt: receipt.body.consumedAt,
      } satisfies ParsedJobCommand;
    });
  const events = chain.map((receipt) => {
    const event = receipt.body;
    return {
      at: receipt.ts,
      type: event.type,
      summary: jobEventSummary(event),
      workerId: "workerId" in event ? event.workerId : undefined,
      commandId: "commandId" in event ? event.commandId : undefined,
      status: event.type === "job.progress" ? asString(asRecord(event.result)?.status) : undefined,
    } satisfies ParsedJobEvent;
  });

  const payloadRoots = uniqueStrings([
    pathRootHint(asString(payload.workspacePath)),
    pathRootHint(asString(payload.promptPath)),
    pathRootHint(asString(payload.resultPath)),
    pathRootHint(asString(payload.stdoutPath)),
    pathRootHint(asString(payload.stderrPath)),
    pathRootHint(asString(payload.lastMessagePath)),
    pathRootHint(asString(payload.manifestPath)),
    pathRootHint(asString(payload.contextPackPath)),
    pathRootHint(asString(payload.memoryScriptPath)),
    asString(asRecord(asRecord(payload.profile)?.objectivePolicy)?.repoRoot),
    `/workspace/${path.basename(repoRoot)}`,
  ]);
  const resolvePath = async (candidate: string | undefined): Promise<{
    readonly originalPath?: string;
    readonly resolvedPath?: string;
  }> => {
    const original = candidate?.trim();
    if (!original) return {};
    if (path.isAbsolute(original) && await fileExists(original)) {
      return { originalPath: original, resolvedPath: original };
    }
    return rewriteRepoPath(repoRoot, original, payloadRoots);
  };

  const [
    manifestPath,
    contextPackPath,
    resultPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
  ] = await Promise.all([
    resolvePath(asString(payload.manifestPath)),
    resolvePath(asString(payload.contextPackPath)),
    resolvePath(asString(payload.resultPath)),
    resolvePath(asString(payload.lastMessagePath)),
    resolvePath(asString(payload.stdoutPath)),
    resolvePath(asString(payload.stderrPath)),
  ]);

  const taskRun = asString(payload.kind) === "factory.task.run"
    ? {
        jobId: job.id,
        taskId: asString(payload.taskId),
        candidateId: asString(payload.candidateId),
        objectiveId: asString(payload.objectiveId),
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        durationMs: Math.max(0, chain.at(-1)!.ts - job.createdAt),
        summary: progress.at(-1)?.summary ?? truncateInline(asString(result?.summary) ?? job.lastError ?? job.canceledReason, 220),
        payload,
        result,
        progress,
        commands: queueCommands,
        manifest: await readFileArtifact(manifestPath.originalPath, manifestPath.resolvedPath, { parseJson: true }),
        contextPack: await readFileArtifact(contextPackPath.originalPath, contextPackPath.resolvedPath, { parseJson: true }),
        resultFile: await readFileArtifact(resultPath.originalPath, resultPath.resolvedPath, { parseJson: true }),
        lastMessage: await readFileArtifact(lastMessagePath.originalPath, lastMessagePath.resolvedPath, { parseJson: false }),
        stdout: await parseStructuredLog(stdoutPath.originalPath, stdoutPath.resolvedPath),
        stderr: await parseStructuredLog(stderrPath.originalPath, stderrPath.resolvedPath),
      } satisfies ParsedTaskRun
    : undefined;

  return {
    stream,
    jobId: job.id,
    status: job.status,
    agentId: job.agentId,
    lane: job.lane,
    payloadKind: asString(payload.kind),
    objectiveId: asString(payload.objectiveId) ?? asString(result?.objectiveId),
    taskId: asString(payload.taskId) ?? asString(result?.taskId),
    candidateId: asString(payload.candidateId) ?? asString(result?.candidateId),
    runId: asString(payload.runId) ?? asString(payload.parentRunId),
    sessionKey: job.sessionKey,
    singletonMode: job.singletonMode,
    receiptCount: chain.length,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    durationMs: Math.max(0, chain.at(-1)!.ts - job.createdAt),
    retryCount: Math.max(0, job.attempt - 1),
    abortRequested: Boolean(job.abortRequested),
    lastError: job.lastError,
    canceledReason: job.canceledReason,
    payload,
    result,
    events,
    progress,
    queueCommands,
    taskRun,
  };
};

const objectiveTimelineItems = (analysis: ObjectiveAnalysis): ReadonlyArray<ParseTimelineItem> =>
  analysis.sequence.map((item) => ({
    at: item.at,
    source: "objective",
    type: item.type,
    summary: item.summary,
    stream: analysis.stream,
    objectiveId: analysis.objectiveId,
    taskId: item.taskId,
    candidateId: item.candidateId,
    jobId: item.jobId,
  }));

const chatTimelineItems = (replay: FactoryChatReplay): ReadonlyArray<ParseTimelineItem> =>
  replay.threadTimeline.map((item) => ({
    at: item.at,
    source: "chat",
    type: item.type,
    summary: item.type === "thread.bound"
      ? `Chat bound to ${item.objectiveId ?? "unknown"} (${item.reason ?? "unknown"})`
      : `Run ${item.runId} continued as ${item.nextRunId ?? "unknown"}`,
    stream: replay.stream,
    runId: item.runId,
    objectiveId: item.objectiveId,
  }));

const runTimelineItems = (run: ParsedAgentRun): ReadonlyArray<ParseTimelineItem> =>
  run.sequence.map((item) => ({
    at: item.at,
    source: "run",
    type: item.type,
    summary: item.summary,
    stream: run.stream,
    runId: run.runId,
    objectiveId: run.objectiveId,
  }));

const jobTimelineItems = (job: ParsedJob): ReadonlyArray<ParseTimelineItem> => {
  return job.events.map((event) => ({
    at: event.at,
    source: "job",
    type: event.type,
    summary: event.summary,
    stream: job.stream,
    objectiveId: job.objectiveId,
    jobId: job.jobId,
    taskId: job.taskId,
    candidateId: job.candidateId,
  }));
};

const sortTimeline = (items: ReadonlyArray<ParseTimelineItem>): ReadonlyArray<ParseTimelineItem> =>
  [...items].sort((left, right) =>
    (left.at ?? Number.MAX_SAFE_INTEGER) - (right.at ?? Number.MAX_SAFE_INTEGER)
    || left.source.localeCompare(right.source)
    || left.type.localeCompare(right.type));

const loadObjectiveContext = async (
  dataDir: string,
  objectiveStream: string,
  options: ParseReadOptions = {},
): Promise<{
  readonly analysis: ObjectiveAnalysis;
  readonly prompt?: string;
  readonly checks: ReadonlyArray<string>;
  readonly taskPrompt?: string;
  readonly latestReportSummary?: string;
  readonly tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly prompt: string;
    readonly candidateId?: string;
    readonly latestSummary?: string;
  }>;
}> => {
  const analysis = await readObjectiveAnalysis(dataDir, objectiveStream, options);
  const {
    chain,
    state,
    projection,
  } = await readObjectiveReplaySnapshot(dataDir, objectiveStream, {
    asOfTs: options.asOfTs,
  });
  const latestTask = [...projection.tasks]
    .sort((left, right) =>
      (right.startedAt ?? right.createdAt) - (left.startedAt ?? left.createdAt)
      || right.taskId.localeCompare(left.taskId))[0];
  const latestReport = [...chain].reverse().map((receipt) => receipt.body)
    .find((event) => event.type === "investigation.reported" || event.type === "objective.completed");
  return {
    analysis,
    prompt: state.prompt,
    checks: state.checks,
    taskPrompt: latestTask?.prompt,
    tasks: projection.tasks.map((task) => ({
      taskId: task.taskId,
      prompt: task.prompt,
      candidateId: task.candidateId,
      latestSummary: task.latestSummary,
    })),
    latestReportSummary: latestReport
      ? latestReport.type === "investigation.reported"
        ? latestReport.summary
        : latestReport.summary
      : undefined,
  };
};

const resolveFocusedTaskId = (
  objectiveContext: Awaited<ReturnType<typeof loadObjectiveContext>>,
  resolved: ParseResolution,
): string | undefined => {
  if (resolved.focusKind === "task") return resolved.focusId;
  if (resolved.focusKind === "candidate") {
    return objectiveContext.tasks.find((task) => task.candidateId === resolved.focusId)?.taskId;
  }
  return undefined;
};

const selectFocusedTaskRun = (
  taskRuns: ReadonlyArray<ParsedTaskRun>,
  taskId: string | undefined,
  candidateId: string | undefined,
): ParsedTaskRun | undefined => {
  const runs = [...taskRuns].reverse();
  if (candidateId) {
    const match = runs.find((taskRun) => taskRun.candidateId === candidateId);
    if (match) return match;
  }
  if (taskId) {
    const match = runs.find((taskRun) => taskRun.taskId === taskId);
    if (match) return match;
  }
  return taskRuns.at(-1);
};

const resolveRunStreamForChatRun = async (
  dataDir: string,
  chatStream: string,
  runId: string,
): Promise<string> => {
  const direct = `${chatStream}/runs/${runId}`;
  const directChain = await jsonlStore<AgentEvent>(dataDir).count(direct);
  return directChain > 0 ? direct : chatStream;
};

export const readFactoryParsedRun = async (
  dataDir: string,
  repoRoot: string,
  requestedId?: string,
  options: ParseReadOptions = {},
): Promise<FactoryParsedRun> => {
  const resolved = await resolveParseTarget(dataDir, requestedId);
  const warnings = [...resolved.ambiguousMatches].map((stream) => `Additional match: ${stream}`);

  if (resolved.kind === "objective") {
    const objectiveContext = await loadObjectiveContext(dataDir, resolved.stream, options);
    const relatedRuns = (await Promise.all(
      objectiveContext.analysis.agentRuns.map((run) => readAgentRun(dataDir, run.stream, { asOfTs: options.asOfTs })),
    )).filter((run): run is ParsedAgentRun => Boolean(run));
    const relatedJobs = (await Promise.all(
      objectiveContext.analysis.jobs.map((job) => readJob(dataDir, repoRoot, job.stream, options)),
    )).filter((job): job is ParsedJob => Boolean(job));
    const taskRuns = relatedJobs
      .map((job) => job.taskRun)
      .filter((taskRun): taskRun is ParsedTaskRun => Boolean(taskRun));
    const latestRun = relatedRuns.at(-1);
    const focusedTaskId = resolveFocusedTaskId(objectiveContext, resolved);
    const focusedTask = objectiveContext.tasks.find((task) => task.taskId === focusedTaskId);
    const focusedCandidateId = resolved.focusKind === "candidate" ? resolved.focusId : undefined;
    const latestTaskRun = selectFocusedTaskRun(taskRuns, focusedTaskId, focusedCandidateId);
    const latestSummary = latestTaskRun?.summary
      ?? focusedTask?.latestSummary
      ?? objectiveContext.analysis.latestSummary
      ?? objectiveContext.latestReportSummary;
    return {
      requestedId,
      resolved,
      warnings,
      links: {
        objectiveId: objectiveContext.analysis.objectiveId,
        chatId: uniqueStrings(relatedRuns.map((run) => run.chatId))[0],
        runId: latestRun?.runId,
        jobId: latestTaskRun?.jobId ?? relatedJobs.at(-1)?.jobId,
        taskId: focusedTaskId ?? latestTaskRun?.taskId,
        candidateId: focusedCandidateId ?? latestTaskRun?.candidateId,
        streams: uniqueStrings([
          objectiveContext.analysis.stream,
          ...relatedRuns.map((run) => run.stream),
          ...relatedJobs.map((job) => job.stream),
        ]),
      },
      summary: {
        title: objectiveContext.analysis.title,
        status: objectiveContext.analysis.status,
        text: latestSummary,
        blockedReason: objectiveContext.analysis.blockedReason,
      },
      window: {
        createdAt: objectiveContext.analysis.createdAt,
        updatedAt: objectiveContext.analysis.updatedAt,
        durationMs: objectiveContext.analysis.durationMs,
      },
      inputs: {
        objectivePrompt: objectiveContext.prompt,
        taskPrompt: focusedTask?.prompt ?? objectiveContext.taskPrompt,
        checks: objectiveContext.checks,
      },
      outputs: {
        finalResponse: latestRun?.finalResponse,
        latestSummary,
        lastMessage: latestTaskRun?.lastMessage.preview,
        result: asRecord(latestTaskRun?.resultFile.json),
      },
      timeline: sortTimeline([
        ...objectiveTimelineItems(objectiveContext.analysis),
        ...relatedRuns.flatMap(runTimelineItems),
        ...relatedJobs.flatMap(jobTimelineItems),
      ]),
      objectiveAnalysis: objectiveContext.analysis,
      relatedRuns,
      relatedJobs,
      taskRuns,
    };
  }

  if (resolved.kind === "chat") {
    const chatReplay = await readChatReplay(dataDir, resolved.stream);
    const relatedRuns = (await Promise.all(
      chatReplay.runs.map(async (run) =>
        readAgentRun(
          dataDir,
          await resolveRunStreamForChatRun(dataDir, resolved.stream, run.runId),
          { runId: run.runId, asOfTs: options.asOfTs },
        )),
    )).filter((run): run is ParsedAgentRun => Boolean(run));
    const latestObjectiveId = chatReplay.latestObjectiveId ?? relatedRuns.map((run) => run.objectiveId).find(Boolean);
    const objectiveContext = latestObjectiveId
      ? await loadObjectiveContext(dataDir, `factory/objectives/${latestObjectiveId}`, options).catch(() => undefined)
      : undefined;
    const relatedJobs = objectiveContext
      ? (await Promise.all(
          objectiveContext.analysis.jobs.map((job) => readJob(dataDir, repoRoot, job.stream, options)),
        )).filter((job): job is ParsedJob => Boolean(job))
      : [];
    const taskRuns = relatedJobs
      .map((job) => job.taskRun)
      .filter((taskRun): taskRun is ParsedTaskRun => Boolean(taskRun));
    const latestRun = relatedRuns.at(-1);
    const latestTaskRun = taskRuns.at(-1);
    return {
      requestedId,
      resolved,
      warnings,
      links: {
        objectiveId: latestObjectiveId,
        chatId: parseChatIdFromStream(resolved.stream),
        runId: latestRun?.runId,
        jobId: latestTaskRun?.jobId ?? relatedJobs.at(-1)?.jobId,
        taskId: latestTaskRun?.taskId,
        candidateId: latestTaskRun?.candidateId,
        streams: uniqueStrings([
          resolved.stream,
          ...relatedRuns.map((run) => run.stream),
          ...relatedJobs.map((job) => job.stream),
          objectiveContext?.analysis.stream,
        ]),
      },
      summary: {
        title: objectiveContext?.analysis.title,
        status: latestRun?.status,
        text: latestRun?.finalResponse ?? objectiveContext?.analysis.latestSummary,
        blockedReason: objectiveContext?.analysis.blockedReason,
      },
      window: {
        createdAt: relatedRuns[0]?.createdAt,
        updatedAt: latestRun?.updatedAt,
        durationMs: latestRun?.durationMs,
      },
      inputs: {
        userPrompt: relatedRuns[0]?.problem ?? chatReplay.runs[0]?.problem,
        objectivePrompt: objectiveContext?.prompt,
        taskPrompt: objectiveContext?.taskPrompt,
        checks: objectiveContext?.checks,
      },
      outputs: {
        finalResponse: latestRun?.finalResponse ?? chatReplay.runs.at(-1)?.finalResponse,
        latestSummary: objectiveContext?.analysis.latestSummary,
        lastMessage: latestTaskRun?.lastMessage.preview,
        result: asRecord(latestTaskRun?.resultFile.json),
      },
      timeline: sortTimeline([
        ...chatTimelineItems(chatReplay),
        ...relatedRuns.flatMap(runTimelineItems),
        ...relatedJobs.flatMap(jobTimelineItems),
        ...(objectiveContext ? objectiveTimelineItems(objectiveContext.analysis) : []),
      ]),
      objectiveAnalysis: objectiveContext?.analysis,
      chatReplay,
      relatedRuns,
      relatedJobs,
      taskRuns,
    };
  }

  if (resolved.kind === "run") {
    const run = await readAgentRun(dataDir, resolved.stream, { asOfTs: options.asOfTs });
    if (!run) throw new Error(`No receipts found for ${resolved.stream}`);
    const chatStream = resolved.stream.replace(/\/runs\/[^/]+$/u, "");
    const chatReplay = chatStream.includes("/sessions/")
      ? await readChatReplay(dataDir, chatStream).catch(() => undefined)
      : undefined;
    const objectiveContext = run.objectiveId
      ? await loadObjectiveContext(dataDir, `factory/objectives/${run.objectiveId}`, options).catch(() => undefined)
      : undefined;
    const relatedJobs = objectiveContext
      ? (await Promise.all(
          objectiveContext.analysis.jobs.map((job) => readJob(dataDir, repoRoot, job.stream, options)),
        )).filter((job): job is ParsedJob => Boolean(job))
      : [];
    const taskRuns = relatedJobs
      .map((job) => job.taskRun)
      .filter((taskRun): taskRun is ParsedTaskRun => Boolean(taskRun));
    const latestTaskRun = taskRuns.at(-1);
    return {
      requestedId,
      resolved,
      warnings,
      links: {
        objectiveId: run.objectiveId,
        chatId: run.chatId ?? parseChatIdFromStream(resolved.stream),
        runId: run.runId,
        jobId: latestTaskRun?.jobId ?? relatedJobs.at(-1)?.jobId,
        taskId: latestTaskRun?.taskId,
        candidateId: latestTaskRun?.candidateId,
        streams: uniqueStrings([
          resolved.stream,
          chatReplay?.stream,
          objectiveContext?.analysis.stream,
          ...relatedJobs.map((job) => job.stream),
        ]),
      },
      summary: {
        title: objectiveContext?.analysis.title,
        status: run.status,
        text: run.finalResponse ?? objectiveContext?.analysis.latestSummary,
        blockedReason: objectiveContext?.analysis.blockedReason,
      },
      window: {
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        durationMs: run.durationMs,
      },
      inputs: {
        userPrompt: run.problem,
        objectivePrompt: objectiveContext?.prompt,
        taskPrompt: objectiveContext?.taskPrompt,
        checks: objectiveContext?.checks,
      },
      outputs: {
        finalResponse: run.finalResponse,
        latestSummary: objectiveContext?.analysis.latestSummary,
        lastMessage: latestTaskRun?.lastMessage.preview,
        result: asRecord(latestTaskRun?.resultFile.json),
      },
      timeline: sortTimeline([
        ...runTimelineItems(run),
        ...(chatReplay ? chatTimelineItems(chatReplay) : []),
        ...(objectiveContext ? objectiveTimelineItems(objectiveContext.analysis) : []),
        ...relatedJobs.flatMap(jobTimelineItems),
      ]),
      objectiveAnalysis: objectiveContext?.analysis,
      chatReplay,
      run,
      relatedRuns: [],
      relatedJobs,
      taskRuns,
    };
  }

  const job = await readJob(dataDir, repoRoot, resolved.stream, options);
  if (!job) throw new Error(`No receipts found for ${resolved.stream}`);
  return {
    requestedId,
    resolved,
    warnings,
    links: {
      objectiveId: job.objectiveId,
      runId: job.runId,
      jobId: job.jobId,
      taskId: job.taskId,
      candidateId: job.candidateId,
      streams: uniqueStrings([job.stream]),
    },
    summary: {
      status: job.status,
      text: job.taskRun?.summary ?? job.progress.at(-1)?.summary,
      blockedReason: job.lastError ?? job.canceledReason,
    },
    window: {
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      durationMs: job.durationMs,
    },
    inputs: {
      problem: job.taskRun?.taskId,
      payload: job.payload,
    },
    outputs: {
      latestSummary: job.taskRun?.summary ?? job.progress.at(-1)?.summary,
      lastMessage: job.taskRun?.lastMessage.preview,
      result: job.result,
    },
    timeline: sortTimeline(jobTimelineItems(job)),
    job,
    relatedRuns: [],
    relatedJobs: [],
    taskRuns: job.taskRun ? [job.taskRun] : [],
  };
};
