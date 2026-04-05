import type {
  FactoryPlanningAlignmentRecord,
  FactoryObjectiveProfileSnapshot,
  FactoryPlanningReceiptRecord,
  FactoryPlanningTaskRecord,
  FactoryTaskExecutionMode,
  FactoryTaskRecord,
  FactoryState,
} from "../../modules/factory";

const planningConstraintsForState = (
  state: FactoryState,
  profile: FactoryObjectiveProfileSnapshot,
): ReadonlyArray<string> => {
  const constraints = [
    `Objective mode: ${state.objectiveMode}.`,
    `Profile: ${profile.rootProfileLabel} (${profile.rootProfileId}).`,
    `Base commit: ${state.baseHash}.`,
  ];
  if (state.checks.length > 0) {
    constraints.push(`Validation commands are constrained to: ${state.checks.join(", ")}.`);
  } else if (state.objectiveMode === "investigation") {
    constraints.push("Validation is evidence-based for this investigation objective.");
  }
  return constraints;
};

const acceptanceCriteriaForState = (
  state: FactoryState,
): ReadonlyArray<string> => {
  if (state.objectiveMode === "investigation") {
    return [
      `Answer the stated investigation goal: ${state.title}.`,
      "Return a clear conclusion with supporting evidence and scripts run.",
      "Call out any disagreement, gap, or uncertainty that affects operator confidence.",
    ];
  }
  return [
    `Implement the requested delivery objective: ${state.title}.`,
    "Keep the shipped change aligned with the objective prompt and avoid unrelated scope.",
    "Leave the objective with no remaining delivery work in task completion reports.",
  ];
};

const validationPlanForState = (
  state: FactoryState,
): ReadonlyArray<string> => {
  if (state.checks.length > 0) return state.checks;
  if (state.objectiveMode === "investigation") {
    return [
      "Capture reproducible evidence with scripts, receipts, or structured artifacts.",
      "Summarize what proved the conclusion and what remains uncertain.",
    ];
  }
  return ["Run the relevant repo validation for the changed subsystem before promotion."];
};

const alignmentForState = (
  state: FactoryState,
): FactoryPlanningAlignmentRecord => {
  const acceptanceCriteria = acceptanceCriteriaForState(state);
  const constraints = planningConstraintsForState(state, state.profile);
  const plannedChecks = validationPlanForState(state);
  return {
    objective_id: state.objectiveId,
    interpretation: state.objectiveMode === "investigation"
      ? "Gather evidence to answer the objective with traceable scripts and receipts."
      : "Deliver the requested change while staying within the stated objective contract.",
    assumptions: state.objectiveMode === "investigation"
      ? ["The stated goal can be validated with repo evidence and recorded scripts."]
      : ["The requested delivery can be completed without expanding the objective scope."],
    success_criteria: acceptanceCriteria,
    constraints,
    planned_checks: plannedChecks,
  };
};

export const buildFactoryPlanningReceipt = (input: {
  readonly state: FactoryState;
  readonly profile: FactoryObjectiveProfileSnapshot;
  readonly resolveTaskExecutionMode: (
    task: FactoryTaskRecord,
  ) => FactoryTaskExecutionMode;
  readonly plannedAt?: number;
}): FactoryPlanningReceiptRecord => {
  const { state, profile, resolveTaskExecutionMode } = input;
  const taskGraph: ReadonlyArray<FactoryPlanningTaskRecord> = state.workflow.taskIds
    .map((taskId) => state.workflow.tasksById[taskId])
    .filter((task): task is FactoryTaskRecord => Boolean(task))
    .map((task) => ({
      taskId: task.taskId,
      title: task.title,
      dependsOn: task.dependsOn,
      workerType: task.workerType,
      executionMode: task.executionMode ?? resolveTaskExecutionMode(task),
      status: task.status,
    }));
  return {
    goal: state.prompt,
    constraints: planningConstraintsForState(state, profile),
    taskGraph,
    acceptanceCriteria: acceptanceCriteriaForState(state),
    validationPlan: validationPlanForState(state),
    alignment: alignmentForState(state),
    plannedAt: input.plannedAt ?? Date.now(),
  };
};

export const planningReceiptFingerprint = (
  plan: FactoryPlanningReceiptRecord,
): string =>
  JSON.stringify({
    ...plan,
    plannedAt: 0,
  });

export const renderPlanningReceiptLines = (
  planningReceipt: FactoryPlanningReceiptRecord,
): ReadonlyArray<string> => [
  `## Planning Receipt`,
  `Goal: ${planningReceipt.goal}`,
  `Constraints:`,
  planningReceipt.constraints.map((item) => `- ${item}`).join("\n") || "- none",
  `Task Graph:`,
  planningReceipt.taskGraph.map((item) =>
    `- ${item.taskId}: ${item.title} [${item.status}] dependsOn=${item.dependsOn.join(",") || "none"} worker=${item.workerType} mode=${item.executionMode}`
  ).join("\n") || "- none",
  `Acceptance Criteria:`,
  planningReceipt.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- none",
  `Validation Plan:`,
  planningReceipt.validationPlan.map((item) => `- ${item}`).join("\n") || "- none",
  `Alignment:`,
  [
    `Objective: ${planningReceipt.alignment.objective_id}`,
    `Interpretation: ${planningReceipt.alignment.interpretation}`,
    ...(planningReceipt.alignment.assumptions.length ? [`Assumptions: ${planningReceipt.alignment.assumptions.join(" | ")}`] : []),
    ...(planningReceipt.alignment.success_criteria.length ? [`Success criteria: ${planningReceipt.alignment.success_criteria.join(" | ")}`] : []),
    ...(planningReceipt.alignment.constraints.length ? [`Constraints: ${planningReceipt.alignment.constraints.join(" | ")}`] : []),
    ...(planningReceipt.alignment.planned_checks.length ? [`Planned checks: ${planningReceipt.alignment.planned_checks.join(" | ")}`] : []),
  ].join("\n"),
];
