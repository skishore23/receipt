import { createHash } from "node:crypto";

import type {
  FactoryCheckResult,
  FactoryExecutionScriptRun,
  FactoryEvidenceRecord,
  FactoryObjectiveHandoffStatus,
  FactoryState,
  FactoryTaskCompletionRecord,
  FactoryWorkerHandoffOutcome,
  FactoryWorkerHandoffScope,
  FactoryWorkerType,
} from "../../../modules/factory";
import type { FactoryEvent } from "../../../modules/factory";
import { optionalTrimmedString } from "../../../framework/http";

export const canAutonomouslyResolveDeliveryPartial = (input: {
  readonly completion: FactoryTaskCompletionRecord;
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly nextAction?: string;
  readonly failedCheck?: FactoryCheckResult;
  readonly controllerResolvableDeliveryPartialRe: RegExp;
}): boolean => {
  if (input.failedCheck) return false;
  if (input.completion.changed.length === 0) return false;
  if (input.completion.proof.length === 0) return false;
  if (input.scriptsRun.length === 0) return false;
  if (input.scriptsRun.some((item) => item.status === "error")) return false;
  const unresolved = [
    ...input.completion.remaining,
    ...(input.nextAction ? [input.nextAction] : []),
  ]
    .map((item) => optionalTrimmedString(item))
    .filter((item): item is string => Boolean(item));
  return unresolved.every((item) => input.controllerResolvableDeliveryPartialRe.test(item));
};

export const validateTaskEvidence = (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly objectiveMode?: "delivery" | "investigation";
  readonly outcome?: "approved" | "changes_requested" | "blocked" | "partial";
  readonly completion?: FactoryTaskCompletionRecord;
  readonly scriptsRun?: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly hasAlignment?: boolean;
  readonly hasStructuredReport?: boolean;
  readonly reportIncludesEvidenceRecords: boolean;
  readonly reportEvidenceRecords?: ReadonlyArray<FactoryEvidenceRecord>;
}): string | undefined => {
  const successOutcome = input.outcome === "approved";
  if (successOutcome) {
    if ((input.completion?.proof.length ?? 0) === 0) {
      return `factory task ${input.taskId} completed without proof items`;
    }
    if ((input.scriptsRun?.length ?? 0) === 0) {
      return `factory task ${input.taskId} completed without scriptsRun evidence`;
    }
    if (input.objectiveMode === "delivery" && input.hasAlignment === false) {
      return `factory task ${input.taskId} completed without an explicit alignment report`;
    }
    if (input.objectiveMode === "investigation" && input.hasStructuredReport === false) {
      return `factory task ${input.taskId} completed without a structured investigation report`;
    }
  }
  if (!input.reportIncludesEvidenceRecords) return undefined;
  return undefined;
};

export const buildWorkerHandoffEvent = (input: {
  readonly objectiveId: string;
  readonly scope: FactoryWorkerHandoffScope;
  readonly workerType: FactoryWorkerType;
  readonly outcome: FactoryWorkerHandoffOutcome;
  readonly summary: string;
  readonly handoff: string;
  readonly handedOffAt: number;
  readonly taskId?: string;
  readonly candidateId?: string;
}): Extract<FactoryEvent, { readonly type: "worker.handoff" }> => ({
  type: "worker.handoff",
  objectiveId: input.objectiveId,
  scope: input.scope,
  workerType: input.workerType,
  outcome: input.outcome,
  summary: input.summary,
  handoff: input.handoff,
  handedOffAt: input.handedOffAt,
  ...(input.taskId ? { taskId: input.taskId } : {}),
  ...(input.candidateId ? { candidateId: input.candidateId } : {}),
});

export const defaultObjectiveHandoffNextAction = (
  state: FactoryState,
  status: FactoryObjectiveHandoffStatus,
): string | undefined => {
  if (status === "completed" || status === "canceled") return undefined;
  if (status === "failed") return "Inspect the failure details, react with guidance, or cancel the objective.";
  return state.objectiveMode === "investigation"
    ? "Review the blocking receipt, adjust the investigation, or cancel the objective."
    : "Review the blocking receipt and react or cancel the objective.";
};

export const buildObjectiveHandoffEvent = (input: {
  readonly state: FactoryState;
  readonly status: FactoryObjectiveHandoffStatus;
  readonly summary: string;
  readonly renderedBody?: string;
  readonly renderSourceHash?: string;
  readonly renderedAt?: number;
  readonly renderedBy?: "orchestrator_llm" | "fallback";
  readonly output?: string;
  readonly sourceUpdatedAt: number;
  readonly blocker?: string;
  readonly nextAction?: string;
}): Extract<FactoryEvent, { readonly type: "objective.handoff" }> => {
  const effectiveNextAction = optionalTrimmedString(input.nextAction)
    ?? defaultObjectiveHandoffNextAction(input.state, input.status);
  const handoffKey = createHash("sha1")
    .update(JSON.stringify({
      objectiveId: input.state.objectiveId,
      status: input.status,
      summary: input.summary,
      renderedBody: input.renderedBody ?? input.output ?? input.summary,
      renderSourceHash: input.renderSourceHash,
      renderedAt: input.renderedAt ?? input.sourceUpdatedAt,
      renderedBy: input.renderedBy,
      blocker: input.blocker,
      nextAction: effectiveNextAction,
      sourceUpdatedAt: input.sourceUpdatedAt,
    }))
    .digest("hex")
    .slice(0, 16);
  return {
    type: "objective.handoff",
    objectiveId: input.state.objectiveId,
    title: input.state.title,
    status: input.status,
    summary: input.summary,
    renderedBody: input.renderedBody ?? input.output ?? input.summary,
    ...(input.renderSourceHash ? { renderSourceHash: input.renderSourceHash } : {}),
    ...(input.renderedAt ? { renderedAt: input.renderedAt } : {}),
    ...(input.renderedBy ? { renderedBy: input.renderedBy } : {}),
    ...(input.output ? { output: input.output } : {}),
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(effectiveNextAction ? { nextAction: effectiveNextAction } : {}),
    handoffKey,
    sourceUpdatedAt: input.sourceUpdatedAt,
  };
};

export const taskResultSchemaPath = (resultPath: string): string =>
  resultPath.replace(/\.json$/i, ".schema.json");

export const isRetryablePublishFailureMessage = (
  message: string,
  input: {
    readonly humanInputBlockReasonRe: RegExp;
    readonly publishTransientFailureRe: RegExp;
  },
): boolean => {
  const normalized = message.trim();
  if (!normalized) return false;
  if (input.humanInputBlockReasonRe.test(normalized)) return false;
  return input.publishTransientFailureRe.test(normalized);
};
