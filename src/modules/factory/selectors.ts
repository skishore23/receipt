import { FACTORY_TASK_WORKFLOW_BUCKETS } from "./defaults";
import {
  candidateOrderList,
  taskDepsSatisfied,
  taskHasStatus,
  taskStatusSet,
  workflowActiveTaskIds,
  workflowTaskList,
} from "./normalization";
import type {
  FactoryCandidateRecord,
  FactoryProjection,
  FactoryState,
  FactoryTaskRecord,
  FactoryTaskStatus,
} from "./types";

const FACTORY_TASK_STATUS_SETS = {
  planned: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.planned),
  ready: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.ready),
  active: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.active),
  completed: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.completed),
  blocked: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.blocked),
  terminal: taskStatusSet(FACTORY_TASK_WORKFLOW_BUCKETS.terminal),
} as const satisfies Readonly<Record<string, ReadonlySet<FactoryTaskStatus>>>;

export const factoryTaskList = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  workflowTaskList(state);

export const factoryReadyTasks = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  workflowTaskList(state).filter((task) =>
    !workflowActiveTaskIds(state).includes(task.taskId)
    && taskHasStatus(task, FACTORY_TASK_STATUS_SETS.ready)
    && taskDepsSatisfied(state, task, FACTORY_TASK_STATUS_SETS.completed)
  );

export const factoryActivatableTasks = (state: FactoryState): ReadonlyArray<FactoryTaskRecord> =>
  workflowTaskList(state).filter((task) =>
    !workflowActiveTaskIds(state).includes(task.taskId)
    && taskHasStatus(task, FACTORY_TASK_STATUS_SETS.planned)
    && taskDepsSatisfied(state, task, FACTORY_TASK_STATUS_SETS.completed)
  );

export const buildFactoryProjection = (state: FactoryState): FactoryProjection => {
  const tasks = workflowTaskList(state);
  const objectiveStopsLiveTaskCounts =
    state.status === "blocked"
    || state.status === "failed"
    || state.status === "canceled"
    || state.status === "completed";
  return {
    objectiveId: state.objectiveId,
    title: state.title,
    status: state.status,
    archivedAt: state.archivedAt,
    updatedAt: state.updatedAt,
    latestSummary: state.latestSummary,
    blockedReason: state.blockedReason,
    activeTasks: objectiveStopsLiveTaskCounts
      ? []
      : tasks.filter((task) =>
          workflowActiveTaskIds(state).includes(task.taskId) || taskHasStatus(task, FACTORY_TASK_STATUS_SETS.active)
        ),
    readyTasks: objectiveStopsLiveTaskCounts
      ? []
      : tasks.filter((task) => taskHasStatus(task, FACTORY_TASK_STATUS_SETS.ready)),
    pendingTasks: tasks.filter((task) => taskHasStatus(task, FACTORY_TASK_STATUS_SETS.planned)),
    completedTasks: tasks.filter((task) => taskHasStatus(task, FACTORY_TASK_STATUS_SETS.completed)),
    blockedTasks: tasks.filter((task) => taskHasStatus(task, FACTORY_TASK_STATUS_SETS.blocked)),
    tasks,
    candidates: candidateOrderList(state)
      .map((candidateId) => state.candidates[candidateId])
      .filter((candidate): candidate is FactoryCandidateRecord => Boolean(candidate)),
    integration: state.integration,
  };
};
