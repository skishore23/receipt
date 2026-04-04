import {
  buildFactoryProjection,
  factoryActivatableTasks,
  factoryReadyTasks,
  type FactoryCandidateRecord,
  type FactoryState,
  type FactoryTaskRecord,
} from "../../modules/factory";

import type {
  FactoryObjectivePlannerInput,
  FactoryPlannerEffect,
  FactoryTaskResultPlannerInput,
} from "./effects";

const latestTaskCandidate = (
  state: FactoryState,
  taskId: string,
): FactoryCandidateRecord | undefined => {
  for (let index = state.candidateOrder.length - 1; index >= 0; index -= 1) {
    const candidateId = state.candidateOrder[index];
    const candidate = state.candidates[candidateId];
    if (candidate?.taskId === taskId) return candidate;
  }
  return undefined;
};

export const taskPromptIncludesObjectiveNote = (
  taskPrompt: string | undefined,
  note: string | undefined,
): boolean => {
  const normalizedPrompt = taskPrompt?.trim();
  const normalizedNote = note?.trim();
  if (!normalizedNote) return true;
  if (!normalizedPrompt) return false;
  return normalizedPrompt.includes(`Operator follow-up for this attempt:\n${normalizedNote}`);
};

const canResumeBlockedObjective = (
  state: FactoryState,
  latestObjectiveOperatorNote: string | undefined,
): boolean => {
  if (state.status !== "blocked") return false;
  if (latestObjectiveOperatorNote?.trim()) return true;
  return (state.blockedReason ?? "").startsWith("Policy blocked:");
};

const latestTask = (state: FactoryState): FactoryTaskRecord | undefined =>
  [...state.workflow.taskIds]
    .map((taskId) => state.workflow.tasksById[taskId])
    .filter((task): task is FactoryTaskRecord => Boolean(task))
    .at(-1);

const isNoopApprovedTask = (
  state: FactoryState,
  task: FactoryTaskRecord,
): boolean => {
  if (task.status !== "approved") return false;
  const candidate = latestTaskCandidate(state, task.taskId);
  return candidate?.status === "approved" && candidate.integrationDisposition === "noop";
};

const isDeliveryTerminalTask = (
  state: FactoryState,
  task: FactoryTaskRecord,
): boolean =>
  task.status === "integrated"
  || task.status === "superseded"
  || isNoopApprovedTask(state, task);

const nextApprovedIntegrationCandidate = (state: FactoryState): FactoryCandidateRecord | undefined => {
  for (const taskId of state.workflow.taskIds) {
    const task = state.workflow.tasksById[taskId];
    if (!task || task.status !== "approved") continue;
    const candidate = latestTaskCandidate(state, taskId);
    if (!candidate || candidate.status !== "approved") continue;
    if (candidate.integrationDisposition === "noop") continue;
    if (state.integration.activeCandidateId === candidate.candidateId) continue;
    if (state.integration.queuedCandidateIds.includes(candidate.candidateId)) continue;
    return candidate;
  }
  return undefined;
};

export const planTaskResult = (
  input: FactoryTaskResultPlannerInput,
): ReadonlyArray<FactoryPlannerEffect> => {
  if (input.blockedReason) {
    return [{
      type: "task.block",
      taskId: input.taskId,
      reason: input.blockedReason,
    }];
  }

  const effects: FactoryPlannerEffect[] = [{
    type: "candidate.produce",
    candidateId: input.candidateId,
    taskId: input.taskId,
    headCommit: input.candidate.headCommit,
    summary: input.candidate.summary,
    handoff: input.candidate.handoff,
    completion: input.candidate.completion,
    alignment: input.candidate.alignment,
    checkResults: input.candidate.checkResults,
    scriptsRun: input.candidate.scriptsRun,
    artifactRefs: input.candidate.artifactRefs,
    tokensUsed: input.candidate.tokensUsed,
    producedAt: input.candidate.producedAt,
  }, {
    type: "task.review.request",
    taskId: input.taskId,
    reviewRequestedAt: input.candidate.producedAt,
  }, {
    type: "candidate.review",
    candidateId: input.candidateId,
    taskId: input.taskId,
    status: input.review.status,
    summary: input.review.summary,
    handoff: input.review.handoff,
    reviewedAt: input.review.reviewedAt,
  }];

  if (
    !input.workspaceDirty
    && input.outcome === "approved"
    && input.review.status === "approved"
    && !input.hasFailedCheck
  ) {
    effects.push({
      type: "task.noop_complete",
      taskId: input.taskId,
      candidateId: input.candidateId,
      summary: input.review.summary,
      completedAt: input.review.reviewedAt,
    });
  }

  if (input.reworkBlockedReason) {
    effects.push({
      type: "task.block",
      taskId: input.taskId,
      reason: input.reworkBlockedReason,
    });
  }

  return effects;
};

export const planObjectiveReact = (
  input: FactoryObjectivePlannerInput,
): ReadonlyArray<FactoryPlannerEffect> => {
  const { state, facts } = input;
  if (state.scheduler.slotState === "queued") return [];
  if (state.status === "completed" || state.status === "failed" || state.status === "canceled") return [];

  if (state.workflow.taskIds.length === 0) {
    if (state.status === "blocked") return [];
    return [{ type: "objective.add_initial_task" }];
  }

  const effects: FactoryPlannerEffect[] = [];
  const latest = latestTask(state);
  const latestNoteSatisfied = taskPromptIncludesObjectiveNote(latest?.prompt, facts.latestObjectiveOperatorNote);
  const resumeBlockedObjective = canResumeBlockedObjective(state, facts.latestObjectiveOperatorNote);

  if (
    state.workflow.activeTaskIds.length === 0
    && facts.latestObjectiveOperatorNote
    && !latestNoteSatisfied
  ) {
    effects.push({
      type: "objective.queue_follow_up_task",
      sourceTaskId: latest?.taskId,
      supersedeTaskId: latest && latest.status !== "integrated" && latest.status !== "superseded"
        ? latest.taskId
        : undefined,
      });
  }

  if (state.status === "blocked" && !resumeBlockedObjective) return effects;

  if (state.status === "blocked") {
    const blockedTaskIds = state.workflow.taskIds
      .map((taskId) => state.workflow.tasksById[taskId])
      .filter((task): task is FactoryTaskRecord => Boolean(task) && task.status === "blocked")
      .map((task) => task.taskId);
    blockedTaskIds.forEach((taskId) => effects.push({ type: "task.unblock", taskId }));
  }

  factoryActivatableTasks(state).forEach((task) => {
    effects.push({
      type: "task.ready",
      taskId: task.taskId,
    });
  });

  const blockedReadyTaskIds = new Set<string>();
  facts.taskReworkBlocks.forEach((block) => {
    blockedReadyTaskIds.add(block.taskId);
    effects.push({
      type: "task.block",
      taskId: block.taskId,
      reason: block.reason,
    });
  });

  const readyTasks = factoryReadyTasks(state)
    .filter((task) => !blockedReadyTaskIds.has(task.taskId));
  if (facts.policyBlockedReason && state.workflow.activeTaskIds.length === 0 && readyTasks.length > 0) {
    effects.push({
      type: "objective.block",
      reason: facts.policyBlockedReason,
      summary: facts.policyBlockedReason,
    });
    return effects;
  }

  if (readyTasks.length > 0 && facts.dispatchCapacity > 0) {
    readyTasks
      .slice(0, facts.dispatchCapacity)
      .forEach((task) => effects.push({
        type: "task.dispatch",
        taskId: task.taskId,
      }));
  }

  const projection = buildFactoryProjection(state);
  if (state.objectiveMode === "investigation") {
    const investigationReady = (
      projection.tasks.length > 0
      && projection.readyTasks.length === 0
      && projection.activeTasks.length === 0
      && projection.tasks.every((task) => ["approved", "superseded"].includes(task.status))
      && facts.hasInvestigationReports
    );
    const investigationBlocked = (
      projection.tasks.length > 0
      && projection.readyTasks.length === 0
      && projection.activeTasks.length === 0
      && factoryActivatableTasks(state).length === 0
      && projection.tasks.some((task) => task.status === "blocked")
    );

    if (investigationReady) {
      effects.push({
        type: "objective.complete",
        summary: facts.investigationSynthesisSummary
          ?? state.latestSummary
          ?? "Investigation objective completed.",
      });
    } else if (investigationBlocked && state.status !== "blocked") {
      effects.push({
        type: "objective.block",
        reason: "No runnable investigation tasks remained.",
        summary: "Investigation objective is blocked with no runnable tasks.",
        allowAutonomousNextStep: true,
      });
    }

    return effects;
  }

  const deliveryTasks = projection.tasks;
  const allDeliveryTasksTerminal = (
    deliveryTasks.length > 0
    && deliveryTasks.every((task) => isDeliveryTerminalTask(state, task))
  );
  const hasIntegratedTask = deliveryTasks.some((task) => task.status === "integrated");
  const noRunnableTasksRemain = (
    deliveryTasks.length > 0
    && projection.readyTasks.length === 0
    && projection.activeTasks.length === 0
    && (state.integration.status === "idle" || state.integration.status === "promoted")
    && deliveryTasks.every((task) =>
      task.status === "blocked"
      || task.status === "superseded"
      || task.status === "integrated"
      || isNoopApprovedTask(state, task)
    )
    && !allDeliveryTasksTerminal
    && state.status !== "blocked"
  );

  const integrationCandidate = (
    projection.activeTasks.length === 0
    && (state.integration.status === "idle" || state.integration.status === "conflicted")
  )
    ? nextApprovedIntegrationCandidate(state)
    : undefined;
  if (integrationCandidate) {
    effects.push({
      type: "integration.queue",
      candidateId: integrationCandidate.candidateId,
      taskId: integrationCandidate.taskId,
    });
  }

  const readyToPromoteBase = (
    allDeliveryTasksTerminal
    && hasIntegratedTask
    && state.integration.status === "validated"
  );
  if (readyToPromoteBase && facts.readyToPromoteBlockedReason) {
    effects.push({
      type: "objective.block",
      reason: facts.readyToPromoteBlockedReason,
      summary: facts.readyToPromoteBlockedReason,
    });
    return effects;
  }

  if (readyToPromoteBase && state.integration.activeCandidateId) {
    effects.push({
      type: "integration.ready_to_promote",
      candidateId: state.integration.activeCandidateId,
      headCommit: state.integration.headCommit ?? state.baseHash,
      summary: state.integration.lastSummary ?? "All tasks integrated and validated. Ready to promote.",
    });
    return effects;
  }

  if (
    allDeliveryTasksTerminal
    && hasIntegratedTask
    && state.integration.status === "ready_to_promote"
    && state.integration.activeCandidateId
    && state.policy.promotion.autoPromote
  ) {
    effects.push({
      type: "integration.promote",
      candidateId: state.integration.activeCandidateId,
    });
    return effects;
  }

  const completionReady = (
    allDeliveryTasksTerminal
    && latestNoteSatisfied
    && (
      hasIntegratedTask
        ? state.integration.status === "promoted"
        : state.integration.status === "idle"
    )
  );
  if (completionReady) {
    effects.push({
      type: "objective.complete",
      summary: state.integration.lastSummary ?? state.latestSummary ?? "Factory objective completed.",
    });
  } else if (noRunnableTasksRemain) {
    effects.push({
      type: "objective.block",
      reason: "No runnable tasks remained.",
      summary: "Factory objective is blocked with no runnable tasks.",
      allowAutonomousNextStep: true,
    });
  }

  return effects;
};
