import type { QueueJob } from "../../adapters/sqlite-queue";
import type { FactoryEvent, FactoryState, FactoryTaskRecord } from "../../modules/factory";
import { CONTROL_RECEIPT_TYPES } from "../../engine/runtime/control-receipts";
import type {
  FactoryObjectiveAlignmentSummary,
  FactoryObjectiveCard,
  FactoryObjectiveDetail,
  FactoryObjectiveReceiptSummary,
  FactoryTaskView,
} from "../factory-types";

type ObjectiveReceiptChainEntry = {
  readonly body: FactoryEvent;
  readonly hash: string;
  readonly ts: number;
};

export const summarizeObjectiveReceipts = (
  chain: ReadonlyArray<ObjectiveReceiptChainEntry>,
  input: {
    readonly limit?: number;
    readonly summarizeReceipt: (event: FactoryEvent) => string;
    readonly receiptTaskOrCandidateId: (event: FactoryEvent) => { readonly taskId?: string; readonly candidateId?: string };
  },
): ReadonlyArray<FactoryObjectiveReceiptSummary> =>
  [...chain]
    .filter((receipt) => !CONTROL_RECEIPT_TYPES.has(receipt.body.type as never))
    .slice(-Math.max(1, Math.min(input.limit ?? 40, 200)))
    .map((receipt) => {
      const ref = input.receiptTaskOrCandidateId(receipt.body);
      return {
        type: receipt.body.type,
        hash: receipt.hash,
        ts: receipt.ts,
        summary: input.summarizeReceipt(receipt.body),
        taskId: ref.taskId,
        candidateId: ref.candidateId,
      };
    });

export const buildBlockedDependentSummary = (state: FactoryState): string | undefined => {
  const blockedTaskIds = new Set(
    state.workflow.taskIds
      .map((taskId) => state.workflow.tasksById[taskId])
      .filter((task): task is FactoryTaskRecord => Boolean(task) && task.status === "blocked")
      .map((task) => task.taskId),
  );
  if (blockedTaskIds.size === 0) return undefined;
  const waiting = state.workflow.taskIds
    .map((taskId) => state.workflow.tasksById[taskId])
    .filter((task): task is FactoryTaskRecord => Boolean(task) && task.status === "pending")
    .map((task) => ({
      taskId: task.taskId,
      blockedBy: task.dependsOn.filter((depId) => blockedTaskIds.has(depId)),
    }))
    .filter((task) => task.blockedBy.length > 0);
  if (waiting.length === 0) return undefined;
  const preview = waiting
    .slice(0, 3)
    .map((task) => `${task.taskId} depends on ${task.blockedBy.join(", ")}`)
    .join("; ");
  const extra = waiting.length > 3 ? ` (+${waiting.length - 3} more)` : "";
  return `Waiting tasks: ${preview}${extra}.`;
};

export const buildBlockedExplanation = (
  state: FactoryState,
  receipts: ReadonlyArray<FactoryObjectiveReceiptSummary>,
): FactoryObjectiveCard["blockedExplanation"] | undefined => {
  const dependentSummary = buildBlockedDependentSummary(state);
  if (!state.blockedReason && state.status !== "blocked" && state.integration.status !== "conflicted") return undefined;
  const match = [...receipts]
    .reverse()
    .find((receipt) =>
      receipt.type === "objective.handoff"
      || receipt.type === "objective.blocked"
      || receipt.type === "task.blocked"
      || receipt.type === "integration.conflicted"
      || receipt.type === "candidate.conflicted",
    );
  if (!match) {
    return state.blockedReason
      ? { summary: [state.blockedReason, dependentSummary].filter(Boolean).join(" ") }
      : undefined;
  }
  return {
    summary: [match.summary, dependentSummary].filter(Boolean).join(" "),
    taskId: match.taskId,
    candidateId: match.candidateId,
    receiptType: match.type,
    receiptHash: match.hash,
  };
};

export const buildObjectiveEvidenceCards = (
  receipts: ReadonlyArray<FactoryObjectiveReceiptSummary>,
): FactoryObjectiveDetail["evidenceCards"] =>
  receipts
    .filter((receipt) =>
      receipt.type === "rebracket.applied"
      || receipt.type === "worker.handoff"
      || receipt.type === "objective.handoff"
      || receipt.type === "investigation.reported"
      || receipt.type === "investigation.synthesized"
      || receipt.type === "task.noop_completed"
      || receipt.type === "objective.blocked"
      || receipt.type === "task.blocked"
      || receipt.type === "integration.conflicted"
      || receipt.type === "merge.applied"
      || receipt.type === "integration.ready_to_promote"
      || receipt.type === "integration.promoted",
    )
    .slice(-12)
    .map((receipt) => ({
      kind:
        receipt.type === "rebracket.applied" ? "decision"
        : receipt.type === "worker.handoff" || receipt.type === "objective.handoff" ? "decision"
        : receipt.type.startsWith("investigation.") ? "report"
        : receipt.type === "task.noop_completed" ? "report"
        : receipt.type === "merge.applied" ? "merge"
        : receipt.type === "integration.ready_to_promote" || receipt.type === "integration.promoted" ? "promotion"
        : "blocked",
      title:
        receipt.type === "rebracket.applied" ? "Latest decision"
        : receipt.type === "worker.handoff" ? "Worker handoff"
        : receipt.type === "objective.handoff" ? "Objective handoff"
        : receipt.type === "investigation.reported" ? "Investigation report"
        : receipt.type === "investigation.synthesized" ? "Investigation synthesis"
        : receipt.type === "task.noop_completed" ? "No-op completion"
        : receipt.type === "merge.applied" ? "Integration merge"
        : receipt.type === "integration.ready_to_promote" ? "Ready to promote"
        : receipt.type === "integration.promoted" ? "Promoted"
        : "Blocked or conflicted",
      summary: receipt.summary,
      at: receipt.ts,
      taskId: receipt.taskId,
      candidateId: receipt.candidateId,
      receiptHash: receipt.hash,
      receiptType: receipt.type,
    }));

export const buildObjectiveActivity = (
  tasks: ReadonlyArray<FactoryTaskView>,
  jobs: ReadonlyArray<QueueJob>,
  receipts: ReadonlyArray<FactoryObjectiveReceiptSummary>,
): FactoryObjectiveDetail["activity"] => {
  const taskEntries = tasks
    .filter((task) => task.startedAt || task.reviewingAt || task.completedAt)
    .map((task) => ({
      kind: "task" as const,
      title: task.taskId,
      summary: `${task.title} [${task.status}]`,
      at: task.completedAt ?? task.reviewingAt ?? task.startedAt ?? task.createdAt,
      taskId: task.taskId,
      candidateId: task.candidateId,
    }));
  const jobEntries = jobs.slice(0, 10).map((job) => ({
    kind: "job" as const,
    title: job.id,
    summary: `${job.agentId} ${job.status}`,
    at: job.updatedAt,
    taskId: typeof (job.payload as Record<string, unknown>).taskId === "string" ? String((job.payload as Record<string, unknown>).taskId) : undefined,
    candidateId: typeof (job.payload as Record<string, unknown>).candidateId === "string" ? String((job.payload as Record<string, unknown>).candidateId) : undefined,
  }));
  const receiptEntries = receipts.slice(-12).map((receipt) => ({
    kind: "receipt" as const,
    title: receipt.type,
    summary: receipt.summary,
    at: receipt.ts,
    taskId: receipt.taskId,
    candidateId: receipt.candidateId,
  }));
  return [...taskEntries, ...jobEntries, ...receiptEntries]
    .sort((a, b) => b.at - a.at)
    .slice(0, 24);
};

export const buildObjectiveCardRecord = (input: {
  readonly state: FactoryState;
  readonly queuePosition?: number;
  readonly slotState: FactoryObjectiveCard["scheduler"]["slotState"];
  readonly displayState?: FactoryObjectiveCard["displayState"];
  readonly phaseDetail?: FactoryObjectiveCard["phaseDetail"];
  readonly statusAuthority?: FactoryObjectiveCard["statusAuthority"];
  readonly hasAuthoritativeLiveJob?: FactoryObjectiveCard["hasAuthoritativeLiveJob"];
  readonly executionStalled?: boolean;
  readonly blockedExplanation?: FactoryObjectiveCard["blockedExplanation"];
  readonly latestDecision?: FactoryObjectiveCard["latestDecision"];
  readonly nextAction?: string;
  readonly activeTaskCount: number;
  readonly readyTaskCount: number;
  readonly taskCount: number;
  readonly latestCommitHash?: string;
  readonly contract?: FactoryObjectiveCard["contract"];
  readonly alignment?: FactoryObjectiveAlignmentSummary;
  readonly tokensUsed?: number;
  readonly profile: FactoryObjectiveCard["profile"];
  readonly phase: FactoryObjectiveCard["phase"];
}): FactoryObjectiveCard => ({
  objectiveId: input.state.objectiveId,
  title: input.state.title,
  status: input.state.status,
  phase: input.phase,
  displayState: input.displayState,
  phaseDetail: input.phaseDetail,
  statusAuthority: input.statusAuthority,
  hasAuthoritativeLiveJob: input.hasAuthoritativeLiveJob,
  objectiveMode: input.state.objectiveMode,
  severity: input.state.severity,
  scheduler: {
    slotState: input.slotState,
    queuePosition: input.queuePosition,
  },
  archivedAt: input.state.archivedAt,
  updatedAt: input.state.updatedAt,
  latestSummary: input.state.latestSummary,
  latestHandoff: input.state.latestHandoff,
  executionStalled: input.executionStalled,
  blockedReason: input.state.blockedReason,
  sourceWarnings: input.state.sourceWarnings,
  blockedExplanation: input.blockedExplanation,
  latestDecision: input.latestDecision,
  nextAction: input.nextAction,
  activeTaskCount: input.activeTaskCount,
  readyTaskCount: input.readyTaskCount,
  taskCount: input.taskCount,
  integrationStatus: input.state.integration.status,
  latestCommitHash: input.latestCommitHash,
  prUrl: input.state.integration.prUrl,
  prNumber: input.state.integration.prNumber,
  headRefName: input.state.integration.headRefName,
  baseRefName: input.state.integration.baseRefName,
  contract: input.contract,
  alignment: input.alignment,
  tokensUsed: input.tokensUsed,
  profile: input.profile,
});
