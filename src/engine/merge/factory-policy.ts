import { compareScoreVectors } from "./policy.js";
import { merge, type MergePolicy } from "../../sdk/merge.js";
import {
  buildFactoryProjection,
  factoryReadyTasks,
  type FactoryCandidateRecord,
  type FactoryCheckResult,
  type FactoryScoreVector,
  type FactoryState,
  type FactoryTaskRecord,
  type FactoryWorkerType,
} from "../../modules/factory.js";

export type FactoryActionType =
  | "dispatch_child"
  | "split_task"
  | "reassign_task"
  | "update_dependencies"
  | "unblock_task"
  | "supersede_task"
  | "queue_integration"
  | "promote_integration"
  | "block_objective";

export type FactoryActionTaskDraft = {
  readonly title: string;
  readonly prompt: string;
  readonly workerType: FactoryWorkerType;
};

export type FactoryAction = {
  readonly actionId: string;
  readonly type: FactoryActionType;
  readonly label: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly workerType?: FactoryWorkerType;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly tasks?: ReadonlyArray<FactoryActionTaskDraft>;
  readonly summary?: string;
};

export type FactoryDecisionSet = {
  readonly frontierTaskIds: ReadonlyArray<string>;
  readonly actions: ReadonlyArray<FactoryAction>;
  readonly summary: string;
};

export type FactoryMergeView = {
  readonly state: FactoryState;
  readonly decisionSet: FactoryDecisionSet;
  readonly headHash?: string;
};

export type FactoryMergeEvidence = {
  readonly frontierTaskIds: ReadonlyArray<string>;
  readonly actionIds: ReadonlyArray<string>;
  readonly summary: string;
};

const DISCOVERY_ONLY_RE = /\b(search|locate|identify|inspect|find|trace|look\s+for|determine|record)\b/i;
const DIFF_PRODUCING_RE = /\b(edit|change|update|remove|add|implement|write|modify|refactor|fix|test|verify|run|create)\b/i;
const NEEDS_SPLIT_RE = /\b(split|smaller|unblock task|before implementation can continue|missing dependency|missing detail|missing details)\b/i;
const NEEDS_REASSIGN_RE = /\b(worker|specialist|codex|ownership)\b/i;

const actionPriority = (action: FactoryAction): number => {
  switch (action.type) {
    case "promote_integration":
      return 90;
    case "queue_integration":
      return 80;
    case "dispatch_child":
      return 70;
    case "split_task":
      return 65;
    case "reassign_task":
      return 60;
    case "update_dependencies":
      return 55;
    case "unblock_task":
      return 50;
    case "supersede_task":
      return 45;
    case "block_objective":
      return 10;
    default:
      return 0;
  }
};

const isTerminalTaskStatus = (status: FactoryTaskRecord["status"]): boolean =>
  status === "approved" || status === "integrated" || status === "superseded" || status === "blocked";

const latestTaskCandidate = (state: FactoryState, taskId: string): FactoryCandidateRecord | undefined => {
  for (let index = state.candidateOrder.length - 1; index >= 0; index -= 1) {
    const candidateId = state.candidateOrder[index];
    const candidate = state.candidates[candidateId];
    if (candidate?.taskId === taskId) return candidate;
  }
  return undefined;
};

const directDependents = (
  state: FactoryState,
  taskId: string,
): ReadonlyArray<FactoryTaskRecord> => state.taskOrder
  .map((id) => state.graph.nodes[id])
  .filter((task): task is FactoryTaskRecord => Boolean(task))
  .filter((task) => task.dependsOn.includes(taskId));

const dependsTransitivelyOn = (
  state: FactoryState,
  taskId: string,
  targetTaskId: string,
  seen = new Set<string>(),
): boolean => {
  if (seen.has(taskId)) return false;
  seen.add(taskId);
  const task = state.graph.nodes[taskId];
  if (!task) return false;
  if (task.dependsOn.includes(targetTaskId)) return true;
  return task.dependsOn.some((depId) => dependsTransitivelyOn(state, depId, targetTaskId, seen));
};

const normalizeDependencies = (
  state: FactoryState,
  taskId: string,
  requested: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const taskIndex = state.taskOrder.indexOf(taskId);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const depId of requested) {
    const trimmed = depId.trim();
    if (!trimmed || trimmed === taskId || seen.has(trimmed)) continue;
    const dep = state.graph.nodes[trimmed];
    if (!dep || dep.status === "superseded") continue;
    const depIndex = state.taskOrder.indexOf(trimmed);
    if (taskIndex >= 0 && depIndex >= taskIndex) continue;
    if (dependsTransitivelyOn(state, trimmed, taskId)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
};

const isDiscoveryOnlyTask = (task: Pick<FactoryTaskRecord, "title" | "prompt">): boolean => {
  const text = `${task.title}\n${task.prompt}`;
  return DISCOVERY_ONLY_RE.test(text) && !DIFF_PRODUCING_RE.test(text);
};

const completedDependencyRatio = (state: FactoryState, task: FactoryTaskRecord): number => {
  if (task.dependsOn.length === 0) return 1;
  const completed = task.dependsOn
    .map((depId) => state.graph.nodes[depId])
    .filter((dep): dep is FactoryTaskRecord => Boolean(dep))
    .filter((dep) => isTerminalTaskStatus(dep.status))
    .length;
  return completed / task.dependsOn.length;
};

const checkScore = (results: ReadonlyArray<FactoryCheckResult>): number => {
  if (results.length === 0) return 0.4;
  const passed = results.filter((result) => result.ok).length;
  return passed / results.length;
};

const freshnessScore = (updatedAt: number | undefined, now: number): number => {
  if (!updatedAt) return 0;
  const ageHours = Math.max(0, now - updatedAt) / 3_600_000;
  return Number((1 / (1 + ageHours)).toFixed(4));
};

const workerFit = (task: FactoryTaskRecord | undefined): number => {
  if (!task) return 0.5;
  const text = `${task.title}\n${task.prompt}`.toLowerCase();
  const worker = String(task.workerType);
  if (/\b(infra|deploy|docker|terraform|k8s|kubernetes|pipeline|ci)\b/.test(text)) return worker === "infra" ? 1 : 0.3;
  return worker === "codex" ? 0.8 : 0.6;
};

const sortedByScore = (
  scored: ReadonlyArray<{ readonly candidate: { readonly id: string }; readonly score: FactoryScoreVector }>,
): ReadonlyArray<{ readonly candidate: { readonly id: string }; readonly score: FactoryScoreVector }> =>
  [...scored].sort((left, right) => {
    const scoreCmp = compareScoreVectors(right.score, left.score);
    if (scoreCmp !== 0) return scoreCmp;
    return left.candidate.id.localeCompare(right.candidate.id);
  });

const actionById = (
  actions: ReadonlyArray<FactoryAction>,
  actionId: string,
): FactoryAction | undefined => actions.find((action) => action.actionId === actionId);

const blockReason = (task: FactoryTaskRecord): string =>
  task.blockedReason ?? task.latestSummary ?? `Task ${task.taskId} is blocked.`;

const buildMutationActions = (
  state: FactoryState,
  now: number,
): ReadonlyArray<FactoryAction> => {
  if (state.policy.mutation.aggressiveness === "off") return [];
  if (
    state.lastMutationAt
    && now - state.lastMutationAt < state.policy.throttles.mutationCooldownMs
  ) {
    return [];
  }

  const allTasks = state.taskOrder
    .map((taskId) => state.graph.nodes[taskId])
    .filter((task): task is FactoryTaskRecord => Boolean(task));
  const blockedTasks = allTasks.filter((task) => task.status === "blocked");
  const pendingTasks = allTasks.filter((task) => task.status === "pending");
  const readyTasks = allTasks.filter((task) => task.status === "ready");
  const mutableTasks = (() => {
    switch (state.policy.mutation.aggressiveness) {
      case "conservative":
        return blockedTasks;
      case "aggressive":
        return [...blockedTasks, ...readyTasks.slice(0, 2), ...pendingTasks.slice(0, 2)];
      case "balanced":
      default:
        return blockedTasks.length > 0 ? [...blockedTasks, ...pendingTasks.slice(0, 2)] : [];
    }
  })();

  const actions: FactoryAction[] = [];
  for (const task of mutableTasks) {
    if (task.status === "blocked") {
      const reason = blockReason(task);
      if (
        task.blockedReason?.startsWith("factory task produced no tracked diff")
        && isDiscoveryOnlyTask(task)
        && directDependents(state, task.taskId).some((dependent) => ["pending", "ready", "blocked"].includes(dependent.status))
      ) {
        actions.push({
          actionId: `action_supersede_${task.taskId}_no_diff`,
          type: "supersede_task",
          label: `Bypass ${task.taskId}`,
          taskId: task.taskId,
          summary: `${task.taskId} only produced analysis with no tracked diff. Supersede it and let downstream implementation continue.`,
        });
        continue;
      }
      if (NEEDS_SPLIT_RE.test(reason)) {
        actions.push({
          actionId: `action_split_${task.taskId}`,
          type: "split_task",
          label: `Split ${task.taskId}`,
          taskId: task.taskId,
          summary: reason,
          tasks: [
            {
              title: `Unblock ${task.title}`,
              prompt: `Investigate the blocker for "${task.title}" and capture the missing details needed before implementation can continue.\n\nBlocker: ${reason}`,
              workerType: "codex",
            },
            {
              title: `Finish ${task.title}`,
              prompt: `Resume "${task.title}" using the unblock task output.\n\nOriginal task: ${task.prompt}`,
              workerType: task.workerType,
            },
          ],
        });
        continue;
      }
      if (NEEDS_REASSIGN_RE.test(reason) && task.workerType !== "codex") {
        actions.push({
          actionId: `action_reassign_${task.taskId}_codex`,
          type: "reassign_task",
          label: `Reassign ${task.taskId} to codex`,
          taskId: task.taskId,
          workerType: "codex",
          summary: reason,
        });
        continue;
      }
      if (task.blockedReason?.startsWith("Policy blocked:")) continue;
      actions.push({
        actionId: `action_unblock_${task.taskId}`,
        type: "unblock_task",
        label: `Unblock ${task.taskId}`,
        taskId: task.taskId,
        summary: reason,
      });
      continue;
    }

    if (state.policy.mutation.aggressiveness === "aggressive" && task.status === "ready" && task.dependsOn.length > 0) {
      const satisfiedDependencies = task.dependsOn
        .map((depId) => state.graph.nodes[depId])
        .filter((dep): dep is FactoryTaskRecord => Boolean(dep))
        .every((dep) => dep.status === "integrated" || dep.status === "superseded");
      if (satisfiedDependencies) {
        const dependsOn = normalizeDependencies(state, task.taskId, []);
        actions.push({
          actionId: `action_deps_${task.taskId}`,
          type: "update_dependencies",
          label: `Flatten ${task.taskId} dependencies`,
          taskId: task.taskId,
          dependsOn,
          summary: `${task.taskId} can proceed without waiting on already-settled dependencies.`,
        });
      }
    }
  }

  return actions;
};

export const buildFactoryDecisionSet = (
  state: FactoryState,
  opts: {
    readonly now?: number;
    readonly dispatchLimit?: number;
    readonly policyBlockedReason?: string;
  } = {},
): FactoryDecisionSet => {
  const now = opts.now ?? Date.now();
  const actions: FactoryAction[] = [];
  const projection = buildFactoryProjection(state);
  const approvedCandidates = state.candidateOrder
    .map((candidateId) => state.candidates[candidateId])
    .filter((candidate): candidate is FactoryCandidateRecord => Boolean(candidate))
    .filter((candidate) => candidate.status === "approved");

  if ((state.integration.status === "idle" || state.integration.status === "conflicted" || state.integration.status === "validated") && approvedCandidates.length > 0) {
    for (const candidate of approvedCandidates) {
      if (state.integration.queuedCandidateIds.includes(candidate.candidateId) || state.integration.activeCandidateId === candidate.candidateId) continue;
      actions.push({
        actionId: `action_queue_${candidate.candidateId}`,
        type: "queue_integration",
        label: `Queue ${candidate.candidateId} for integration`,
        candidateId: candidate.candidateId,
        taskId: candidate.taskId,
        summary: candidate.summary,
      });
    }
  }

  //   // console.log(`[DEBUG buildFactoryDecisionSet] objective: ${state.objectiveId}, integrationStatus: ${state.integration.status}, approvedCandidates: ${approvedCandidates.map(c => c.candidateId).join(",")}, actions:`, actions.map(a => a.type));

  if (state.integration.status === "validated" && state.integration.activeCandidateId && state.policy.promotion.autoPromote) {
    const allDone = state.taskOrder.every((taskId) => {
      const task = state.graph.nodes[taskId];
      return task?.status === "integrated" || task?.status === "superseded" || task?.status === "blocked";
    });
    const someIntegrated = state.taskOrder.some((taskId) => state.graph.nodes[taskId]?.status === "integrated");
    if (allDone && someIntegrated) {
      actions.push({
        actionId: `action_promote_${state.integration.activeCandidateId}`,
        type: "promote_integration",
        label: `Promote integrated candidate ${state.integration.activeCandidateId}`,
        candidateId: state.integration.activeCandidateId,
      });
    }
  }

  const dispatchLimit = Math.max(0, opts.dispatchLimit ?? 0);
  if (dispatchLimit > 0 && state.taskRunsUsed < state.policy.budgets.maxTaskRuns) {
    for (const task of factoryReadyTasks(state).slice(0, dispatchLimit)) {
      actions.push({
        actionId: `action_dispatch_${task.taskId}`,
        type: "dispatch_child",
        label: `Dispatch ${task.taskId}`,
        taskId: task.taskId,
        workerType: task.workerType,
        summary: task.latestSummary ?? task.prompt,
      });
    }
  }

  actions.push(...buildMutationActions(state, now));

  if (
    opts.policyBlockedReason
    && projection.readyTasks.length > 0
    && projection.activeTasks.length === 0
    && state.integration.status === "idle"
  ) {
    actions.push({
      actionId: "action_block_policy",
      type: "block_objective",
      label: "Block objective on policy budget",
      summary: opts.policyBlockedReason,
    });
  } else if (
    projection.tasks.length > 0
    && projection.readyTasks.length === 0
    && projection.activeTasks.length === 0
    && state.integration.status === "idle"
    && projection.tasks.every((task) => ["blocked", "superseded"].includes(task.status))
  ) {
    const blocked = state.taskOrder
      .map((taskId) => state.graph.nodes[taskId])
      .find((task) => task?.status === "blocked");
    actions.push({
      actionId: `action_block_${blocked?.taskId ?? "objective"}`,
      type: "block_objective",
      label: blocked ? `Block objective on ${blocked.taskId}` : "Block objective",
      taskId: blocked?.taskId,
      summary: blocked?.blockedReason ?? "No runnable tasks remained.",
    });
  }

  const frontierTaskIds = [...new Set(actions
    .flatMap((action) => action.taskId ? [action.taskId] : action.candidateId ? [state.candidates[action.candidateId]?.taskId].filter((value): value is string => Boolean(value)) : []))];
  return {
    frontierTaskIds,
    actions,
    summary: actions.length === 0
      ? "No frontier actions available."
      : actions.map((action) => `${action.type}:${action.taskId ?? action.candidateId ?? action.actionId}`).join(", "),
  };
};

const scoreAction = (state: FactoryState, action: FactoryAction, now: number): FactoryScoreVector => {
  const task = action.taskId ? state.graph.nodes[action.taskId] : action.candidateId ? state.graph.nodes[state.candidates[action.candidateId]?.taskId ?? ""] : undefined;
  const candidate = action.candidateId ? state.candidates[action.candidateId] : action.taskId ? latestTaskCandidate(state, action.taskId) : undefined;
  const integrationResults = action.type === "promote_integration" ? state.integration.validationResults : [];
  const results = candidate?.checkResults ?? integrationResults;
  const dependencyCoverage = task ? completedDependencyRatio(state, task) : candidate ? completedDependencyRatio(state, state.graph.nodes[candidate.taskId] ?? {
    nodeId: candidate.taskId,
    taskId: candidate.taskId,
    taskKind: "planned",
    title: candidate.taskId,
    prompt: candidate.summary ?? "",
    workerType: "codex",
    dependsOn: [],
    status: "approved",
    baseCommit: candidate.baseCommit,
    skillBundlePaths: [],
    contextRefs: [],
    artifactRefs: {},
    createdAt: candidate.createdAt,
  }) : 0;

  const reviewScore = action.type === "queue_integration"
    ? candidate?.status === "approved" ? 1 : 0
    : action.type === "promote_integration"
      ? state.integration.status === "ready_to_promote" ? 1 : 0
      : action.type === "dispatch_child"
        ? task?.status === "ready" ? 0.8 : 0
        : action.type === "block_objective"
          ? 0.2
          : task?.status === "blocked" || task?.status === "ready" ? 0.6 : 0.3;
  const freshness = freshnessScore(candidate?.updatedAt ?? task?.createdAt, now);
  const validation = checkScore(results);
  const conflictRisk = candidate?.status === "conflicted" || state.integration.status === "conflicted" ? -1 : 0.5;
  const frontier = task
    ? (task.status === "ready" ? 1 : task.status === "blocked" ? 0.7 : task.status === "approved" ? 0.9 : 0.4)
    : candidate?.status === "approved"
      ? 1
      : 0.4;

  return {
    "01_action_priority": actionPriority(action),
    "02_review": reviewScore,
    "03_validation": validation,
    "04_frontier": frontier,
    "05_dependency_coverage": dependencyCoverage,
    "06_conflict_risk": conflictRisk,
    "07_freshness": freshness,
    "08_worker_fit": workerFit(task),
  };
};

export const factoryActionScoreScalar = (score: FactoryScoreVector): number =>
  Number(Object.values(score).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0).toFixed(4));

export const factoryActionConfidence = (
  scored: ReadonlyArray<{ readonly candidate: { readonly id: string }; readonly score: FactoryScoreVector }>,
  selectedActionId: string,
): number => {
  const ordered = sortedByScore(scored);
  const best = ordered.find((entry) => entry.candidate.id === selectedActionId) ?? ordered[0];
  const runnerUp = ordered.find((entry) => entry.candidate.id !== selectedActionId);
  if (!best) return 0.5;
  const bestScore = factoryActionScoreScalar(best.score);
  const secondScore = runnerUp ? factoryActionScoreScalar(runnerUp.score) : bestScore - 2;
  return Math.max(0.55, Math.min(0.99, Number((0.55 + Math.max(0, bestScore - secondScore) / 20).toFixed(2))));
};

export const summarizeFactoryAction = (action: FactoryAction): string =>
  action.summary?.trim()
  || action.label
  || `${action.type}:${action.taskId ?? action.candidateId ?? action.actionId}`;

export const describeFactoryDecision = (
  action: FactoryAction,
  score: FactoryScoreVector,
): string => {
  const factors = Object.entries(score)
    .filter(([, value]) => typeof value === "number" && value > 0)
    .slice(0, 3)
    .map(([key]) => key.replace(/^\d+_/, "").replace(/_/g, " "));
  const tail = factors.length > 0 ? ` using ${factors.join(", ")}` : "";
  return `Runtime selected ${action.type} for ${action.taskId ?? action.candidateId ?? action.actionId}${tail}.`;
};

export const factoryMergePolicy: MergePolicy<{ readonly view: FactoryMergeView; readonly chain: ReadonlyArray<unknown>; readonly runId: string }, FactoryMergeEvidence> = merge({
  id: "factory-frontier",
  version: "1.0.0",
  shouldRecompute: ({ view }) => view.decisionSet.actions.length > 0,
  candidates: ({ view }) => view.decisionSet.actions.map((action) => ({ id: action.actionId })),
  evidence: ({ view }) => ({
    frontierTaskIds: view.decisionSet.frontierTaskIds,
    actionIds: [...view.decisionSet.actions.map((action) => action.actionId)] as ReadonlyArray<string>,
    summary: view.decisionSet.summary,
  }),
  score: (candidate, _evidence, { view }) =>
    scoreAction(view.state, actionById(view.decisionSet.actions, candidate.id) ?? {
      actionId: candidate.id,
      type: "block_objective",
      label: candidate.id,
    }, view.state.updatedAt || Date.now()),
  choose: (scored) => {
    const ordered = sortedByScore(scored);
    return {
      candidateId: ordered[0]?.candidate.id ?? "",
      reason: "Selected the highest-scoring runtime frontier action.",
    };
  },
});
