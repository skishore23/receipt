import type {
  FactoryObjectiveCard,
  FactoryObjectiveDetail,
  FactoryTaskView,
} from "../../services/factory-types";
import type {
  FactoryActionModel,
  FactoryDisplayState,
  FactoryEvidenceStatModel,
  FactoryLifecycleStepModel,
  FactorySelectedObjectiveCard,
  FactoryTimelineGroupModel,
  FactoryTimelineItemModel,
} from "../factory-models";
import { displayLabel } from "../ui";

const LIFE_STAGES = [
  { key: "brief", label: "Brief" },
  { key: "plan", label: "Plan" },
  { key: "execute", label: "Execute" },
  { key: "verify", label: "Verify" },
  { key: "review", label: "Review" },
  { key: "complete", label: "Complete" },
] as const;

const isObjectiveDetail = (
  value: FactoryObjectiveCard | FactoryObjectiveDetail,
): value is FactoryObjectiveDetail => "recentReceipts" in value;

const taskHasExecutionEvidence = (task: Pick<FactoryTaskView, "status">): boolean =>
  task.status !== "pending" && task.status !== "ready";

const countUnique = (items: ReadonlyArray<string | undefined>): number =>
  new Set(items.filter((item): item is string => typeof item === "string" && item.trim().length > 0)).size;

const compactValue = (value: string | number | undefined, fallback = "none"): string => {
  if (typeof value === "number") return String(value);
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
};

const investigationEvidenceCount = (objective: FactoryObjectiveDetail): number =>
  objective.investigation?.finalReport?.evidence?.length ?? 0;

const investigationScriptCount = (objective: FactoryObjectiveDetail): number =>
  objective.investigation?.finalReport?.scriptsRun?.length ?? 0;

export const displayStateTone = (value?: string): "neutral" | "info" | "success" | "warning" | "danger" => {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return "neutral";
  if (normalized === "completed" || normalized === "archived") return "success";
  if (normalized === "blocked" || normalized === "stalled") return "warning";
  if (normalized === "failed" || normalized === "canceled") return "danger";
  if (normalized === "running" || normalized === "awaiting review") {
    return "info";
  }
  if (normalized === "queued" || normalized === "draft" || normalized === "discussing") return "warning";
  return "neutral";
};

export const displayStateForObjectiveStatus = (
  status: FactoryObjectiveCard["status"] | FactoryObjectiveDetail["status"],
): FactoryDisplayState => {
  switch (status) {
    case "planning":
      return "Running";
    case "executing":
    case "integrating":
    case "promoting":
      return "Running";
    case "completed":
      return "Completed";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
  }
};

export const deriveObjectiveDisplayState = (
  objective: FactoryObjectiveCard | FactoryObjectiveDetail,
): FactoryDisplayState => {
  if (objective.displayState) return objective.displayState;
  if (objective.archivedAt) return "Archived";
  if (objective.status === "completed") return "Completed";
  if (objective.status === "blocked") return "Blocked";
  if (objective.status === "failed") return "Failed";
  if (objective.status === "canceled") return "Canceled";
  if (objective.executionStalled) return "Stalled";
  if (objective.integrationStatus === "ready_to_promote") return "Awaiting Review";
  if (isObjectiveDetail(objective)) {
    const hasReviewingTask = objective.tasks.some((task) => task.status === "reviewing");
    const hasAwaitingReviewCandidate = objective.candidates.some((candidate) => candidate.status === "awaiting_review");
    if (hasReviewingTask || hasAwaitingReviewCandidate) return "Awaiting Review";
  }
  if (objective.status === "planning" && objective.taskCount === 0) return "Draft";
  if (objective.scheduler.slotState === "queued") return "Queued";
  return displayStateForObjectiveStatus(objective.status);
};

const lifecycleStageKey = (
  objective: FactoryObjectiveCard | FactoryObjectiveDetail,
): typeof LIFE_STAGES[number]["key"] => {
  if (objective.status === "completed" || objective.archivedAt) return "complete";
  const hasPlan = objective.taskCount > 0 || (isObjectiveDetail(objective) && (objective.planning?.taskGraph?.length ?? 0) > 0);
  const hasExecution = isObjectiveDetail(objective)
    ? objective.tasks.some((task) => taskHasExecutionEvidence(task))
    : objective.activeTaskCount > 0;
  const hasVerify = objective.integrationStatus === "queued"
    || objective.integrationStatus === "merging"
    || objective.integrationStatus === "validating"
    || objective.integrationStatus === "validated"
    || objective.integrationStatus === "ready_to_promote"
    || objective.integrationStatus === "promoting"
    || objective.integrationStatus === "promoted"
    || (isObjectiveDetail(objective) && hasExecution && investigationEvidenceCount(objective) > 0);
  const hasReview = objective.integrationStatus === "ready_to_promote"
    || (isObjectiveDetail(objective) && (
      objective.tasks.some((task) => task.status === "reviewing")
      || objective.candidates.some((candidate) => candidate.status === "awaiting_review")
    ));
  if (objective.status === "blocked" || objective.status === "failed" || objective.status === "canceled") {
    if (hasReview) return "review";
    if (hasVerify) return "verify";
    if (hasExecution) return "execute";
    if (hasPlan) return "plan";
    return "brief";
  }
  if (hasReview) return "review";
  if (hasVerify) return "verify";
  if (hasExecution) return "execute";
  if (hasPlan) return "plan";
  return "brief";
};

export const deriveObjectiveLifecycleSteps = (
  objective: FactoryObjectiveCard | FactoryObjectiveDetail,
): ReadonlyArray<FactoryLifecycleStepModel> => {
  const currentKey = lifecycleStageKey(objective);
  const currentIndex = LIFE_STAGES.findIndex((stage) => stage.key === currentKey);
  const paused = objective.status === "blocked" || objective.status === "failed" || objective.status === "canceled";
  return LIFE_STAGES.map((stage, index) => ({
    key: stage.key,
    label: stage.label,
    state: index < currentIndex
      ? "done"
      : index === currentIndex
        ? (paused && stage.key !== "complete" ? "paused" : "current")
        : "upcoming",
  }));
};

export const deriveObjectiveReviewStatus = (
  objective: FactoryObjectiveCard | FactoryObjectiveDetail,
): string => {
  if (objective.status === "completed" || objective.archivedAt) return "completed";
  if (objective.status === "blocked") return "blocked";
  if (objective.status === "failed") return "failed";
  if (objective.status === "canceled") return "canceled";
  if (objective.integrationStatus === "ready_to_promote") return "awaiting review";
  if (isObjectiveDetail(objective)) {
    if (objective.tasks.some((task) => task.status === "reviewing")) return "awaiting review";
    if (objective.candidates.some((candidate) => candidate.status === "awaiting_review")) return "awaiting review";
  }
  if (objective.integrationStatus === "validating" || objective.integrationStatus === "validated") return "verifying";
  return "in progress";
};

const evidenceStat = (
  key: string,
  label: string,
  value: string,
  tone?: FactoryEvidenceStatModel["tone"],
): FactoryEvidenceStatModel => ({ key, label, value, ...(tone ? { tone } : {}) });

const artifactCountForDetail = (detail: FactoryObjectiveDetail): number =>
  detail.tasks.reduce((count, task) => count + (task.artifactActivity?.length ?? 0), 0);

export const buildObjectiveEvidenceStats = (
  objective: FactoryObjectiveCard | FactoryObjectiveDetail,
): ReadonlyArray<FactoryEvidenceStatModel> => {
  if (!isObjectiveDetail(objective)) {
    return [
      evidenceStat("sessions", "Sessions", compactValue(objective.activeTaskCount + objective.readyTaskCount, "0")),
      evidenceStat("tasks", "Tasks", `${objective.activeTaskCount}/${objective.taskCount}`),
      evidenceStat("blockers", "Blockers", objective.blockedReason ? "1" : "0", objective.blockedReason ? "warning" : "neutral"),
    ];
  }
  const sessionCount = Math.max(
    countUnique(objective.tasks.map((task) => task.jobId)),
    countUnique(objective.tasks.map((task) => task.candidateId)),
    objective.candidates.length,
  );
  const completedTasks = objective.tasks.filter((task) =>
    task.status === "approved" || task.status === "integrated" || task.status === "superseded",
  ).length;
  const reportEvidenceCount = investigationEvidenceCount(objective);
  const scriptCount = investigationScriptCount(objective)
    || objective.candidates.reduce((count, candidate) => count + (candidate.scriptsRun?.length ?? 0), 0);
  const artifactCount = artifactCountForDetail(objective);
  return [
    evidenceStat("sessions", "Sessions", String(sessionCount), sessionCount > 0 ? "info" : "neutral"),
    evidenceStat("tasks", "Tasks", `${completedTasks}/${objective.taskCount}`),
    evidenceStat("evidence", "Report Evidence", String(reportEvidenceCount), reportEvidenceCount > 0 ? "success" : "neutral"),
    evidenceStat("scripts", "Scripts Run", String(scriptCount), scriptCount > 0 ? "info" : "neutral"),
    evidenceStat("checks", "Checks", String(objective.checks.length), objective.checks.length > 0 ? "info" : "neutral"),
    evidenceStat("artifacts", "Artifacts", String(artifactCount), artifactCount > 0 ? "success" : "neutral"),
    evidenceStat("blockers", "Blockers", objective.blockedReason ? "1" : "0", objective.blockedReason ? "warning" : "neutral"),
  ];
};

export const buildObjectiveTimelineGroups = (
  objective: FactoryObjectiveCard | FactoryObjectiveDetail,
): ReadonlyArray<FactoryTimelineGroupModel> => {
  if (!isObjectiveDetail(objective)) return [];
  const outcomeItems = objective.evidenceCards.map((card) => ({
    key: `outcome:${card.receiptHash ?? `${card.title}:${card.at}`}`,
    title: card.title,
    summary: card.summary,
    meta: [card.receiptType, card.taskId, card.candidateId].filter(Boolean).join(" · "),
    at: card.at,
    emphasis:
      card.kind === "blocked" ? "warning"
      : card.kind === "merge" || card.kind === "promotion" ? "success"
      : card.kind === "decision" ? "accent"
      : "muted",
  } satisfies FactoryTimelineItemModel));

  const workItems: FactoryTimelineItemModel[] = objective.activity
    .filter((entry) => entry.kind !== "receipt")
    .map((entry) => ({
      key: `work:${entry.kind}:${entry.at}:${entry.title}`,
      title: entry.title,
      summary: entry.summary,
      meta: [entry.kind, entry.taskId, entry.candidateId].filter(Boolean).join(" · "),
      at: entry.at,
      emphasis: entry.kind === "job" ? "accent" : "muted",
    }));
  const artifactCount = artifactCountForDetail(objective);
  if (artifactCount > 0) {
    workItems.unshift({
      key: "work:artifacts",
      title: "Artifacts attached",
      summary: artifactCount === 1 ? "1 artifact attached to the objective." : `${artifactCount} artifacts attached to the objective.`,
      meta: "artifacts",
      at: objective.updatedAt,
      emphasis: "success",
    });
  }

  const outcomeKeys = new Set(objective.evidenceCards.map((card) => card.receiptHash).filter(Boolean));
  const outcomeSummaries = new Set(outcomeItems.map((item) => `${item.title}:${item.summary}`));
  const systemItems = objective.recentReceipts
    .filter((receipt) =>
      !outcomeKeys.has(receipt.hash)
      && !outcomeSummaries.has(`${receipt.type}:${receipt.summary}`),
    )
    .map((receipt) => ({
      key: `receipt:${receipt.hash}`,
      title: receipt.type,
      summary: receipt.summary,
      meta: [receipt.taskId, receipt.candidateId].filter(Boolean).join(" · "),
      at: receipt.ts,
      emphasis: "muted",
    } satisfies FactoryTimelineItemModel));

  return [
    { key: "outcome", title: "Outcome", items: outcomeItems.slice(0, 6) },
    { key: "work", title: "Work Performed", items: workItems.slice(0, 8) },
    { key: "receipts", title: "System Receipts", collapsedByDefault: true, items: systemItems.slice(0, 12) },
  ].filter((group) => group.items.length > 0);
};

const objectivePrimaryAction = (objective: FactorySelectedObjectiveCard): FactoryActionModel => {
  const displayState = objective.displayState
    ?? displayStateForObjectiveStatus(objective.status as FactoryObjectiveCard["status"]);
  const currentLifecycle = objective.lifecycleSteps?.find((step) => step.state === "current" || step.state === "paused")?.key;
  if (displayState === "Completed" || displayState === "Archived" || displayState === "Failed" || displayState === "Canceled") {
    return { label: "Start follow-up", command: "/obj ", tone: "primary" };
  }
  if (displayState === "Blocked") {
    return { label: "Resolve blocker", command: "/react ", tone: "primary" };
  }
  if (currentLifecycle === "plan") {
    return { label: "Review plan", command: "/analyze", tone: "primary" };
  }
  return { label: "Message engineer", focusOnly: true, tone: "primary" };
};

const objectiveSecondaryActions = (objective: FactorySelectedObjectiveCard): ReadonlyArray<FactoryActionModel> => {
  const displayState = objective.displayState
    ?? displayStateForObjectiveStatus(objective.status as FactoryObjectiveCard["status"]);
  if (displayState === "Completed" || displayState === "Archived" || displayState === "Failed" || displayState === "Canceled") {
    return [
      { label: "Ask engineer", focusOnly: true, tone: "secondary" },
      { label: "Archive", command: "/archive", tone: "secondary" },
    ];
  }
  if (displayState === "Blocked") {
    return [
      { label: "Message engineer", focusOnly: true, tone: "secondary" },
      { label: "Archive", command: "/archive", tone: "secondary" },
    ];
  }
  return [
    { label: "Ask engineer", focusOnly: true, tone: "secondary" },
    { label: "Archive", command: "/archive", tone: "secondary" },
  ];
};

export const buildObjectiveActionSet = (
  objective: FactorySelectedObjectiveCard,
): {
  readonly primaryAction: FactoryActionModel;
  readonly secondaryActions: ReadonlyArray<FactoryActionModel>;
} => ({
  primaryAction: objectivePrimaryAction(objective),
  secondaryActions: objectiveSecondaryActions(objective),
});

export const buildObjectiveBottomLine = (
  objective: FactoryObjectiveCard | FactoryObjectiveDetail,
): string => objective.latestSummary
  ?? objective.blockedExplanation?.summary
  ?? objective.blockedReason
  ?? objective.latestDecision?.summary
  ?? objective.nextAction
  ?? `${objective.title} is ${displayLabel(objective.status).toLowerCase() || "active"}.`;

export const buildEngineerPerspectiveOverview = (input: {
  readonly engineerLabel: string;
  readonly role?: string;
  readonly status: string;
  readonly load: string;
  readonly objective?: Pick<FactorySelectedObjectiveCard, "title" | "displayState" | "status" | "bottomLine" | "summary" | "nextAction">;
}): {
  readonly focus: string;
  readonly need: string;
  readonly operating: string;
} => {
  const objective = input.objective;
  const displayState = objective?.displayState ?? objective?.status;
  const phaseDetail = "phaseDetail" in (objective ?? {}) && typeof objective?.phaseDetail === "string"
    ? objective.phaseDetail
    : undefined;
  const bottomLine = objective?.bottomLine ?? objective?.summary;
  const focus = !objective
    ? "I'm available for a new objective. Start in chat if you want to talk through the work first, or promote a concrete request into tracked execution."
    : displayState === "Blocked"
      ? `I'm blocked on "${objective.title}". ${bottomLine ?? "I need guidance or better evidence to continue."}`
      : displayState === "Stalled"
        ? `Execution stalled on "${objective.title}". ${bottomLine ?? "The current run stopped making visible progress and needs intervention."}`
      : displayState === "Completed" || displayState === "Archived"
        ? `I finished "${objective.title}". ${bottomLine ?? "The work is wrapped and ready for follow-up or archive."}`
        : displayState === "Awaiting Review"
          ? `I've completed the main pass on "${objective.title}" and I'm ready for review. ${bottomLine ?? ""}`.trim()
          : displayState === "Failed" || displayState === "Canceled"
            ? `I had to stop "${objective.title}". ${bottomLine ?? "The current run is stopped and needs a follow-up decision."}`
            : phaseDetail === "reconciling"
              ? `I'm reconciling "${objective.title}" after a worker handoff. ${bottomLine ?? "The controller is deciding the next step."}`
              : phaseDetail === "cleaning_up"
                ? `I'm closing out "${objective.title}". ${bottomLine ?? "The result is terminal and the controller is retiring leftover jobs."}`
            : `I'm working on "${objective.title}". ${bottomLine ?? "The objective is moving through execution."}`;
  const need = objective?.nextAction
    ? `Next, I need: ${objective.nextAction}`
    : !objective
      ? "Give me a clear objective when you want durable work tracked."
      : displayState === "Blocked"
        ? "I need a decision, more evidence, or a revised direction before I continue."
        : displayState === "Stalled"
          ? "I need you to review the stalled execution, react with guidance, or cancel the current pass."
        : displayState === "Completed" || displayState === "Archived"
          ? "I can take a follow-up objective or help you review the result."
          : phaseDetail === "reconciling"
            ? "I need the controller reconcile pass to finish before I know whether to resume or stop."
          : "I can keep going without interruption unless you want to change direction.";
  const operating = `I'm operating as ${input.role ?? input.engineerLabel}. Current status: ${input.status}. Current load: ${input.load}.`;
  return { focus, need, operating };
};
