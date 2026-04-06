import { isDeepStrictEqual } from "node:util";

import { fold } from "@receipt/core/chain";
import { createRuntime } from "@receipt/core/runtime";
import type { Chain } from "@receipt/core/types";
import { sqliteBranchStore, sqliteReceiptStore } from "../adapters/sqlite";
import { CONTROL_RECEIPT_TYPES } from "../engine/runtime/control-receipts";
import {
  renderReceiptContextDstAuditText,
  runReceiptContextDstAudit,
  type ReceiptDstContextAuditReport,
} from "./dst-context";
import { initial as initialAgent, reduce as reduceAgent, type AgentEvent } from "../modules/agent";
import { buildFactoryProjection, initialFactoryState, reduceFactory, type FactoryEvent } from "../modules/factory";
import { initial as initialJobState, reduce as reduceJob, type JobEvent, type JobStatus } from "../modules/job";

type GenericEvent = Record<string, unknown>;
type GenericCmd = {
  readonly type: "emit";
  readonly event: GenericEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

type StreamKind =
  | "factory.objective"
  | "job"
  | "agent.history"
  | "agent.control"
  | "generic";

type SummaryStatusMap = Readonly<Record<string, number>>;

type StreamSummary =
  | {
      readonly kind: "factory.objective";
      readonly status: string;
      readonly taskCount: number;
      readonly candidateCount: number;
      readonly integrationStatus?: string;
      readonly blockedReason?: string;
      readonly latestSummary?: string;
    }
  | {
      readonly kind: "job";
      readonly jobCount: number;
      readonly statusCounts: SummaryStatusMap;
      readonly latestJobId?: string;
      readonly latestStatus?: JobStatus;
    }
  | {
      readonly kind: "agent.history";
      readonly runCount: number;
      readonly statusCounts: SummaryStatusMap;
      readonly toolCalls: number;
      readonly finalResponses: number;
      readonly latestRunId?: string;
      readonly latestObjectiveId?: string;
    }
  | {
      readonly kind: "agent.control";
      readonly runCount: number;
      readonly status: "running" | "completed" | "failed";
      readonly runId?: string;
      readonly agentId?: string;
      readonly agentVersion?: string;
      readonly actionSelections: number;
      readonly actionStarted: number;
      readonly actionCompleted: number;
      readonly actionFailed: number;
      readonly goalCompleted: boolean;
      readonly lastError?: string;
    }
  | {
      readonly kind: "generic";
      readonly runCount: number;
      readonly topEventTypes: ReadonlyArray<{
        readonly type: string;
        readonly count: number;
      }>;
    };

export type ReceiptDstStreamReport = {
  readonly stream: string;
  readonly kind: StreamKind;
  readonly receiptCount: number;
  readonly branch?: {
    readonly parent?: string;
    readonly forkAt?: number;
  };
  readonly integrity: {
    readonly ok: boolean;
    readonly error?: string;
  };
  readonly replay: {
    readonly ok: boolean;
    readonly error?: string;
  };
  readonly deterministic: {
    readonly ok: boolean;
    readonly error?: string;
  };
  readonly eventTypes: Readonly<Record<string, number>>;
  readonly summary: StreamSummary;
};

export type ReceiptDstAuditReport = {
  readonly scannedAt: string;
  readonly dataDir: string;
  readonly streamCount: number;
  readonly kinds: Readonly<Record<StreamKind, number>>;
  readonly statusCounts: Readonly<Record<string, SummaryStatusMap>>;
  readonly integrityFailures: number;
  readonly replayFailures: number;
  readonly deterministicFailures: number;
  readonly streams: ReadonlyArray<ReceiptDstStreamReport>;
  readonly context?: ReceiptDstContextAuditReport;
};

type ReceiptDstAuditOptions = {
  readonly prefix?: string;
  readonly includeContext?: boolean;
  readonly repoRoot?: string;
};

const AGENT_EVENT_TYPES = new Set<string>([
  "problem.set",
  "run.configured",
  "config.updated",
  "run.status",
  "failure.report",
  "iteration.started",
  "thought.logged",
  "action.planned",
  "tool.called",
  "tool.observed",
  "memory.slice",
  "validation.report",
  "response.finalized",
  "run.continued",
  "thread.bound",
  "objective.handoff",
  "context.pruned",
  "context.compacted",
  "overflow.recovered",
  "subagent.merged",
  "agent.delegated",
  "memory.flushed",
  "profile.selected",
  "profile.resolved",
  "profile.handoff",
]);

const EMPTY_STATUS_COUNTS: SummaryStatusMap = {};

const createGenericRuntime = (dataDir: string) =>
  createRuntime<GenericCmd, GenericEvent, { readonly ok: true }>(
    sqliteReceiptStore<GenericEvent>(dataDir),
    sqliteBranchStore(dataDir),
    (cmd) => [cmd.event],
    (state) => state,
    { ok: true },
  );

type StreamPass = {
  readonly chain: Chain<GenericEvent>;
  readonly branch: Awaited<ReturnType<ReturnType<typeof createGenericRuntime>["branch"]>>;
  readonly integrity: Awaited<ReturnType<ReturnType<typeof createGenericRuntime>["verify"]>>;
  readonly eventTypes: Readonly<Record<string, number>>;
  readonly kind: StreamKind;
  readonly summary: StreamSummary;
};

const eventTypeOf = (event: GenericEvent): string =>
  typeof event.type === "string" ? event.type : "unknown";

const countBy = (values: ReadonlyArray<string>): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};

const sortedCounts = (counts: Readonly<Record<string, number>>): ReadonlyArray<{
  readonly type: string;
  readonly count: number;
}> =>
  Object.entries(counts)
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));

const uniqueRunIds = (chain: Chain<GenericEvent>): ReadonlyArray<string> =>
  [...new Set(chain
    .map((receipt) => receipt.body.runId)
    .filter((runId): runId is string => typeof runId === "string" && runId.trim().length > 0))];

const asStatusCounts = (counts: Readonly<Record<string, number>>): SummaryStatusMap =>
  Object.keys(counts).length > 0 ? counts : EMPTY_STATUS_COUNTS;

const summarizeFactoryObjective = (chain: Chain<GenericEvent>): StreamSummary => {
  const state = fold(chain as Chain<FactoryEvent>, reduceFactory, initialFactoryState);
  const projection = buildFactoryProjection(state);
  return {
    kind: "factory.objective",
    status: projection.status,
    taskCount: projection.tasks.length,
    candidateCount: projection.candidates.length,
    integrationStatus: projection.integration.status,
    blockedReason: projection.blockedReason,
    latestSummary: projection.latestSummary,
  };
};

const summarizeJobStream = (chain: Chain<GenericEvent>): StreamSummary => {
  const state = fold(chain as Chain<JobEvent>, reduceJob, initialJobState);
  const jobs = Object.values(state.jobs).sort((left, right) =>
    right.updatedAt - left.updatedAt || right.id.localeCompare(left.id),
  );
  const statusCounts = countBy(jobs.map((job) => job.status));
  return {
    kind: "job",
    jobCount: jobs.length,
    statusCounts: asStatusCounts(statusCounts),
    latestJobId: jobs[0]?.id,
    latestStatus: jobs[0]?.status,
  };
};

const summarizeAgentHistory = (chain: Chain<GenericEvent>): StreamSummary => {
  const runs = new Map<string, Chain<GenericEvent>>();
  for (const receipt of chain) {
    const runId = typeof receipt.body.runId === "string" ? receipt.body.runId : undefined;
    if (!runId) continue;
    const existing = runs.get(runId);
    if (existing) {
      (existing as Array<(typeof chain)[number]>).push(receipt);
    } else {
      runs.set(runId, [receipt]);
    }
  }

  const states = [...runs.entries()].map(([runId, runChain]) => {
    const state = fold(runChain as Chain<AgentEvent>, reduceAgent, initialAgent);
    const latestAt = runChain[runChain.length - 1]?.ts ?? 0;
    return { runId, state, latestAt };
  }).sort((left, right) => right.latestAt - left.latestAt || left.runId.localeCompare(right.runId));

  const latestObjectiveId = [...chain]
    .reverse()
    .map((receipt) => receipt.body.objectiveId)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);

  return {
    kind: "agent.history",
    runCount: states.length,
    statusCounts: asStatusCounts(countBy(states.map(({ state }) => state.status))),
    toolCalls: chain.filter((receipt) => receipt.body.type === "tool.called").length,
    finalResponses: chain.filter((receipt) => receipt.body.type === "response.finalized").length,
    latestRunId: states[0]?.runId,
    latestObjectiveId,
  };
};

const summarizeAgentControl = (chain: Chain<GenericEvent>): StreamSummary => {
  const starts = chain.filter((receipt) => receipt.body.type === "run.started");
  const completed = chain.filter((receipt) => receipt.body.type === "run.completed");
  const failed = chain.filter((receipt) => receipt.body.type === "run.failed");
  const lastStart = starts.at(-1)?.body;
  const lastFailure = failed.at(-1)?.body;
  return {
    kind: "agent.control",
    runCount: uniqueRunIds(chain).length || starts.length,
    status: failed.length > 0 ? "failed" : completed.length > 0 ? "completed" : "running",
    runId: typeof lastStart?.runId === "string" ? lastStart.runId : undefined,
    agentId: typeof lastStart?.agentId === "string" ? lastStart.agentId : undefined,
    agentVersion: typeof lastStart?.agentVersion === "string" ? lastStart.agentVersion : undefined,
    actionSelections: chain.filter((receipt) => receipt.body.type === "action.selected").length,
    actionStarted: chain.filter((receipt) => receipt.body.type === "action.started").length,
    actionCompleted: chain.filter((receipt) => receipt.body.type === "action.completed").length,
    actionFailed: chain.filter((receipt) => receipt.body.type === "action.failed").length,
    goalCompleted: chain.some((receipt) => receipt.body.type === "goal.completed"),
    lastError: typeof lastFailure?.error === "string" ? lastFailure.error : undefined,
  };
};

const summarizeGeneric = (chain: Chain<GenericEvent>, eventTypes: Readonly<Record<string, number>>): StreamSummary => ({
  kind: "generic",
  runCount: uniqueRunIds(chain).length,
  topEventTypes: sortedCounts(eventTypes).slice(0, 5),
});

const classifyStream = (stream: string, eventTypes: Readonly<Record<string, number>>): StreamKind => {
  const types = Object.keys(eventTypes);
  if (stream.startsWith("factory/objectives/")) return "factory.objective";
  if (stream === "jobs" || stream.startsWith("jobs/")) return "job";
  if (types.some((type) => CONTROL_RECEIPT_TYPES.has(type as never))) return "agent.control";
  if (types.length > 0 && types.every((type) => AGENT_EVENT_TYPES.has(type))) return "agent.history";
  return "generic";
};

const statusCountsForSummary = (summary: StreamSummary): SummaryStatusMap => {
  switch (summary.kind) {
    case "factory.objective":
      return { [summary.status]: 1 };
    case "job":
      return summary.statusCounts;
    case "agent.history":
      return summary.statusCounts;
    case "agent.control":
      return { [summary.status]: 1 };
    case "generic":
    default:
      return EMPTY_STATUS_COUNTS;
  }
};

const describeSummary = (summary: StreamSummary): string => {
  switch (summary.kind) {
    case "factory.objective":
      return `status=${summary.status} tasks=${summary.taskCount} candidates=${summary.candidateCount}${summary.integrationStatus ? ` integration=${summary.integrationStatus}` : ""}`;
    case "job":
      return `jobs=${summary.jobCount} statuses=${sortedCounts(summary.statusCounts).map((entry) => `${entry.type}:${entry.count}`).join(",") || "none"}`;
    case "agent.history":
      return `runs=${summary.runCount} statuses=${sortedCounts(summary.statusCounts).map((entry) => `${entry.type}:${entry.count}`).join(",") || "none"} tools=${summary.toolCalls} finals=${summary.finalResponses}`;
    case "agent.control":
      return `status=${summary.status} selections=${summary.actionSelections} completed=${summary.actionCompleted} failed=${summary.actionFailed}`;
    case "generic":
    default:
      return `runIds=${summary.runCount} types=${summary.topEventTypes.map((entry) => `${entry.type}:${entry.count}`).join(",") || "none"}`;
  }
};

const summarizeStream = (
  kind: StreamKind,
  chain: Chain<GenericEvent>,
  eventTypes: Readonly<Record<string, number>>,
): StreamSummary => {
  switch (kind) {
    case "factory.objective":
      return summarizeFactoryObjective(chain);
    case "job":
      return summarizeJobStream(chain);
    case "agent.history":
      return summarizeAgentHistory(chain);
    case "agent.control":
      return summarizeAgentControl(chain);
    case "generic":
    default:
      return summarizeGeneric(chain, eventTypes);
  }
};

const loadStreamPass = async (dataDir: string, stream: string): Promise<StreamPass> => {
  const runtime = createGenericRuntime(dataDir);
  const [chain, branch, integrity] = await Promise.all([
    runtime.chain(stream),
    runtime.branch(stream),
    runtime.verify(stream),
  ]);
  const eventTypes = countBy(chain.map((receipt) => eventTypeOf(receipt.body)));
  const kind = classifyStream(stream, eventTypes);
  return {
    chain,
    branch,
    integrity,
    eventTypes,
    kind,
    summary: summarizeStream(kind, chain, eventTypes),
  };
};

const analyzeStream = async (
  dataDir: string,
  stream: string,
): Promise<ReceiptDstStreamReport> => {
  let firstPass: StreamPass | undefined;
  let secondPass: StreamPass | undefined;
  let replay: ReceiptDstStreamReport["replay"] = { ok: true };
  let deterministic: ReceiptDstStreamReport["deterministic"] = { ok: true };

  try {
    firstPass = await loadStreamPass(dataDir, stream);
    secondPass = await loadStreamPass(dataDir, stream);
    if (!isDeepStrictEqual(
      {
        branch: firstPass.branch,
        eventTypes: firstPass.eventTypes,
        summary: firstPass.summary,
      },
      {
        branch: secondPass.branch,
        eventTypes: secondPass.eventTypes,
        summary: secondPass.summary,
      },
    )) {
      deterministic = { ok: false, error: "stream replay changed between fresh audit passes" };
    }
  } catch (err) {
    replay = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    deterministic = {
      ok: false,
      error: replay.error,
    };
  }

  const primaryPass = firstPass ?? secondPass;
  const chain = primaryPass?.chain ?? [];
  const branch = primaryPass?.branch;
  const eventTypes = primaryPass?.eventTypes ?? EMPTY_STATUS_COUNTS;
  const kind = primaryPass?.kind ?? classifyStream(stream, eventTypes);
  const integrityResult = primaryPass?.integrity ?? { ok: true as const };
  const integrity = integrityResult.ok
    ? { ok: true as const }
    : { ok: false as const, error: `${integrityResult.reason} at receipt ${integrityResult.at}` };
  const summary = primaryPass?.summary;

  return {
    stream,
    kind,
    receiptCount: chain.length,
    branch: branch?.parent || typeof branch?.forkAt === "number"
      ? {
          parent: branch.parent,
          forkAt: branch.forkAt,
        }
      : undefined,
    integrity,
    replay,
    deterministic,
    eventTypes,
    summary: summary ?? summarizeGeneric(chain, eventTypes),
  };
};

export const runReceiptDstAudit = async (
  dataDir: string,
  opts: ReceiptDstAuditOptions = {},
): Promise<ReceiptDstAuditReport> => {
  const streams = await createGenericRuntime(dataDir).listStreams(opts.prefix);
  const reports = await Promise.all(streams.map((stream) => analyzeStream(dataDir, stream)));

  const ordered = [...reports].sort((left, right) =>
    Number(left.integrity.ok) - Number(right.integrity.ok)
    || Number(left.replay.ok) - Number(right.replay.ok)
    || Number(left.deterministic.ok) - Number(right.deterministic.ok)
    || right.receiptCount - left.receiptCount
    || left.stream.localeCompare(right.stream),
  );

  const kinds: Record<StreamKind, number> = {
    "factory.objective": 0,
    job: 0,
    "agent.history": 0,
    "agent.control": 0,
    generic: 0,
  };
  const statusCounts: Record<string, Record<string, number>> = {};

  for (const report of ordered) {
    kinds[report.kind] += 1;
    const summaryStatuses = statusCountsForSummary(report.summary);
    if (!statusCounts[report.kind]) statusCounts[report.kind] = {};
    for (const [status, count] of Object.entries(summaryStatuses)) {
      statusCounts[report.kind]![status] = (statusCounts[report.kind]![status] ?? 0) + count;
    }
  }

  const context = opts.includeContext && opts.repoRoot
    ? await runReceiptContextDstAudit(dataDir, {
        prefix: opts.prefix,
        repoRoot: opts.repoRoot,
      })
    : undefined;

  return {
    scannedAt: new Date().toISOString(),
    dataDir,
    streamCount: ordered.length,
    kinds,
    statusCounts,
    integrityFailures: ordered.filter((report) => !report.integrity.ok).length,
    replayFailures: ordered.filter((report) => !report.replay.ok).length,
    deterministicFailures: ordered.filter((report) => !report.deterministic.ok).length,
    streams: ordered,
    context,
  };
};

export const renderReceiptDstAuditText = (
  report: ReceiptDstAuditReport,
  opts: {
    readonly limit?: number;
  } = {},
): string => {
  const limit = Math.max(1, opts.limit ?? 20);
  const lines = [
    "Receipt DST Audit",
    `Data dir: ${report.dataDir}`,
    `Scanned: ${report.streamCount} streams`,
    `Integrity failures: ${report.integrityFailures}`,
    `Replay failures: ${report.replayFailures}`,
    `Deterministic failures: ${report.deterministicFailures}`,
    "",
    "Kinds:",
    ...Object.entries(report.kinds)
      .filter((entry) => entry[1] > 0)
      .map(([kind, count]) => {
        const statuses = report.statusCounts[kind];
        const suffix = statuses && Object.keys(statuses).length > 0
          ? ` (${sortedCounts(statuses).map((entry) => `${entry.type}:${entry.count}`).join(", ")})`
          : "";
        return `- ${kind}: ${count}${suffix}`;
      }),
  ];

  const failures = report.streams.filter((stream) => !stream.integrity.ok || !stream.replay.ok || !stream.deterministic.ok);
  if (failures.length > 0) {
    lines.push("", "Issues:");
    for (const stream of failures.slice(0, limit)) {
      const problems = [
        !stream.integrity.ok ? `integrity=${stream.integrity.error}` : undefined,
        !stream.replay.ok ? `replay=${stream.replay.error}` : undefined,
        !stream.deterministic.ok ? `deterministic=${stream.deterministic.error}` : undefined,
      ].filter((value): value is string => Boolean(value));
      lines.push(`- ${stream.stream} [${stream.kind}] ${problems.join(" | ")}`);
    }
  }

  lines.push("", "Streams:");
  for (const stream of report.streams.slice(0, limit)) {
    lines.push(`- ${stream.stream} [${stream.kind}] receipts=${stream.receiptCount} ${describeSummary(stream.summary)}`);
  }

  if (report.streams.length > limit) {
    lines.push(`- ... ${report.streams.length - limit} more stream(s) omitted`);
  }

  if (report.context) {
    lines.push("", renderReceiptContextDstAuditText(report.context, opts));
  }

  return lines.join("\n");
};
