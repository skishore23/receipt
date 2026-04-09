import type { Decide, Reducer } from "@receipt/core/types";

import { CONTROL_RECEIPT_TYPES } from "../../engine/runtime/control-receipts";
import { createFactoryWorkflowState, emptyIntegration } from "./defaults";
import type { FactoryCmd, FactoryEvent } from "./events";
import {
  candidateOrderList,
  normalizeFactoryObjectiveProfileSnapshot,
  normalizeFactoryState,
  normalizeTaskRecord,
  stringList,
  workflowTaskIds,
} from "./normalization";
import type {
  FactoryCandidateRecord,
  FactoryState,
  FactoryTaskRecord,
  FactoryTaskStatus,
  FactoryWorkflowStatus,
} from "./types";

const updateTask = (
  state: FactoryState,
  taskId: string,
  patch: Partial<FactoryTaskRecord>,
): FactoryState => {
  const current = state.workflow.tasksById[taskId];
  if (!current) return state;
  return {
    ...state,
    workflow: {
      ...state.workflow,
      tasksById: {
        ...state.workflow.tasksById,
        [taskId]: {
          ...current,
          ...patch,
        },
      },
    },
  };
};

const upsertTask = (
  state: FactoryState,
  task: FactoryTaskRecord,
): FactoryState => ({
  ...state,
  workflow: {
    ...state.workflow,
    taskIds: workflowTaskIds(state).includes(task.taskId)
      ? workflowTaskIds(state)
      : [...workflowTaskIds(state), task.taskId],
    tasksById: {
      ...state.workflow.tasksById,
      [task.taskId]: normalizeTaskRecord(task, state.profile.objectivePolicy.defaultTaskExecutionMode),
    },
  },
});

const updateCandidate = (
  state: FactoryState,
  candidateId: string,
  patch: Partial<FactoryCandidateRecord>,
): FactoryState => {
  const current = state.candidates[candidateId];
  if (!current) return state;
  return {
    ...state,
    candidates: {
      ...state.candidates,
      [candidateId]: {
        ...current,
        ...patch,
      },
    },
  };
};

const latestTaskCandidate = (
  state: FactoryState,
  taskId: string,
): FactoryCandidateRecord | undefined => {
  const orderedCandidates = candidateOrderList(state);
  for (let index = orderedCandidates.length - 1; index >= 0; index -= 1) {
    const candidateId = orderedCandidates[index];
    const candidate = state.candidates[candidateId];
    if (candidate?.taskId === taskId) return candidate;
  }
  return undefined;
};

const upsertCandidate = (
  state: FactoryState,
  candidate: FactoryCandidateRecord,
): FactoryState => ({
  ...state,
  candidates: {
    ...state.candidates,
    [candidate.candidateId]: candidate,
  },
  candidateOrder: candidateOrderList(state).includes(candidate.candidateId)
    ? candidateOrderList(state)
    : [...candidateOrderList(state), candidate.candidateId],
});

const setWorkflowStatus = (
  state: FactoryState,
  ts: number,
  status: FactoryWorkflowStatus = state.workflow.status,
): FactoryState => ({
  ...state,
  updatedAt: ts,
  workflow: {
    ...state.workflow,
    status,
    updatedAt: ts,
  },
});

const setActiveTaskIds = (state: FactoryState, activeTaskIds: ReadonlyArray<string>, ts: number): FactoryState => ({
  ...state,
  updatedAt: ts,
  workflow: {
    ...state.workflow,
    activeTaskIds: [...new Set(stringList(activeTaskIds).filter((taskId) => Boolean(state.workflow.tasksById[taskId])))],
    updatedAt: ts,
  },
});

export const decideFactory: Decide<FactoryCmd, FactoryEvent> = (cmd) => {
  if (cmd.events?.length) return [...cmd.events];
  return cmd.event ? [cmd.event] : [];
};

export const reduceFactory: Reducer<FactoryState, FactoryEvent> = (state, event) => {
  state = normalizeFactoryState(state);
  if (CONTROL_RECEIPT_TYPES.has(event.type as never)) return state;
  switch (event.type) {
    case "objective.created":
      return {
        objectiveId: event.objectiveId,
        title: event.title,
        prompt: event.prompt,
        channel: event.channel,
        baseHash: event.baseHash,
        sourceWarnings: event.sourceWarnings,
        objectiveMode: event.objectiveMode,
        severity: event.severity,
        checks: event.checks,
        checksSource: event.checksSource,
        profile: normalizeFactoryObjectiveProfileSnapshot(event.profile),
        policy: event.policy,
        status: "planning",
        archivedAt: undefined,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        latestHandoff: undefined,
        taskRunsUsed: 0,
        candidatePassesByTask: {},
        consecutiveFailuresByTask: {},
        lastDispatchAt: undefined,
        candidates: {},
        candidateOrder: [],
        workflow: createFactoryWorkflowState(event.objectiveId, event.createdAt),
        integration: emptyIntegration(event.createdAt),
        scheduler: {},
        investigation: {
          reports: {},
          reportOrder: [],
        },
      };
    case "objective.operator.noted":
      return {
        ...state,
        latestSummary: event.message,
        updatedAt: event.notedAt,
      };
    case "planning.receipt":
      return {
        ...state,
        planning: event.plan,
        updatedAt: event.plannedAt,
      };
    case "objective.slot.queued":
      return {
        ...state,
        updatedAt: event.queuedAt,
        scheduler: {
          slotState: "queued",
          queuedAt: event.queuedAt,
          admittedAt: state.scheduler.admittedAt,
          releasedAt: state.scheduler.releasedAt,
          releaseReason: state.scheduler.releaseReason,
        },
      };
    case "objective.slot.admitted":
      return {
        ...state,
        updatedAt: event.admittedAt,
        scheduler: {
          slotState: "active",
          queuedAt: state.scheduler.queuedAt,
          admittedAt: event.admittedAt,
          releasedAt: undefined,
          releaseReason: undefined,
        },
      };
    case "objective.slot.released":
      return {
        ...state,
        updatedAt: event.releasedAt,
        scheduler: {
          slotState: state.scheduler.slotState,
          queuedAt: state.scheduler.queuedAt,
          admittedAt: state.scheduler.admittedAt,
          releasedAt: event.releasedAt,
          releaseReason: event.reason,
        },
      };
    case "task.added": {
      const nextStatus =
        state.workflow.taskIds.length === 0 || state.status === "blocked"
          ? "planning"
          : state.status;
      const next = upsertTask(state, event.task);
      return {
        ...next,
        blockedReason: nextStatus === "planning" ? undefined : state.blockedReason,
        status: nextStatus,
        updatedAt: event.createdAt,
        workflow: {
          ...next.workflow,
          updatedAt: event.createdAt,
        },
      };
    }
    case "task.ready":
      return {
        ...setWorkflowStatus(updateTask(state, event.taskId, {
          status: "ready",
          readyAt: event.readyAt,
        }), event.readyAt),
        status: state.status === "blocked" ? "planning" : state.status,
        blockedReason: state.status === "blocked" ? undefined : state.blockedReason,
        latestHandoff: undefined,
      };
    case "task.dispatched": {
      const currentActive = new Set(state.workflow.activeTaskIds);
      currentActive.add(event.taskId);
      let next = updateTask(state, event.taskId, {
        status: "running",
        candidateId: event.candidateId,
        jobId: event.jobId,
        workspaceId: event.workspaceId,
        workspacePath: event.workspacePath,
        skillBundlePaths: event.skillBundlePaths,
        contextRefs: event.contextRefs,
        startedAt: event.startedAt,
      });
      next = updateCandidate(next, event.candidateId, {
        status: "running",
        updatedAt: event.startedAt,
      });
      return {
        ...setActiveTaskIds(next, [...currentActive], event.startedAt),
        status: "executing",
        blockedReason: undefined,
        latestHandoff: undefined,
        taskRunsUsed: state.taskRunsUsed + 1,
        lastDispatchAt: event.startedAt,
      };
    }
    case "task.intervention.applied":
      return {
        ...updateTask(state, event.taskId, {
          latestTraceSummary: event.guidance,
        }),
        latestSummary: event.guidance,
        updatedAt: event.appliedAt,
      };
    case "task.intervention.restarted":
      return {
        ...updateTask(state, event.taskId, {
          latestTraceSummary: event.guidance,
        }),
        latestSummary: event.guidance,
        updatedAt: event.restartedAt,
      };
    case "worker.handoff":
      return event.taskId
        ? {
            ...updateTask(state, event.taskId, {
              latestTraceSummary: event.handoff,
            }),
            updatedAt: event.handedOffAt,
          }
        : {
            ...state,
            updatedAt: event.handedOffAt,
          };
    case "objective.handoff":
      return {
        ...state,
        updatedAt: Math.max(state.updatedAt, event.sourceUpdatedAt),
        latestHandoff: {
          status: event.status,
          summary: event.summary,
          renderedBody: event.renderedBody ?? event.output ?? event.summary,
          renderSourceHash: event.renderSourceHash,
          renderedAt: event.renderedAt,
          renderedBy: event.renderedBy,
          output: event.output,
          blocker: event.blocker,
          nextAction: event.nextAction,
          handoffKey: event.handoffKey,
          sourceUpdatedAt: event.sourceUpdatedAt,
        },
      };
    case "task.review.requested":
      return setActiveTaskIds(updateTask(state, event.taskId, {
        status: "reviewing",
        reviewingAt: event.reviewRequestedAt,
      }), state.workflow.activeTaskIds, event.reviewRequestedAt);
    case "task.approved": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      const { [event.taskId]: _, ...remainingFailures } = state.consecutiveFailuresByTask;
      return {
        ...setActiveTaskIds(updateTask(state, event.taskId, {
          status: "approved",
          latestSummary: event.summary,
          completedAt: event.approvedAt,
        }), active, event.approvedAt),
        latestSummary: event.summary,
        consecutiveFailuresByTask: remainingFailures,
      };
    }
    case "task.integrated": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      const { [event.taskId]: _, ...remainingFailures } = state.consecutiveFailuresByTask;
      let next = updateTask(state, event.taskId, {
        status: "integrated",
        latestSummary: event.summary,
        completedAt: event.integratedAt,
      });
      const candidate = latestTaskCandidate(next, event.taskId);
      if (candidate && (candidate.status === "approved" || candidate.status === "integrated")) {
        next = updateCandidate(next, candidate.candidateId, {
          status: "integrated",
          latestReason: event.summary,
          integratedAt: event.integratedAt,
          updatedAt: event.integratedAt,
        });
      }
      return {
        ...setActiveTaskIds(next, active, event.integratedAt),
        latestSummary: event.summary,
        consecutiveFailuresByTask: remainingFailures,
      };
    }
    case "task.noop_completed": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      const { [event.taskId]: _, ...remainingFailures } = state.consecutiveFailuresByTask;
      let next = updateTask(state, event.taskId, {
        status: "approved",
        latestSummary: event.summary,
        completedAt: event.completedAt,
      });
      next = updateCandidate(next, event.candidateId, {
        status: "approved",
        integrationDisposition: "noop",
        latestReason: event.summary,
        updatedAt: event.completedAt,
      });
      return {
        ...setActiveTaskIds(next, active, event.completedAt),
        latestSummary: event.summary,
        consecutiveFailuresByTask: remainingFailures,
      };
    }
    case "task.blocked": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      const prev = state.workflow.tasksById[event.taskId];
      const wasDispatch = prev?.status === "running" || prev?.status === "reviewing";
      const prevFailures = state.consecutiveFailuresByTask[event.taskId] ?? 0;
      let next = updateTask(state, event.taskId, {
        status: "blocked",
        blockedReason: event.reason,
        completedAt: event.blockedAt,
      });
      const candidate = latestTaskCandidate(next, event.taskId);
      if (candidate && (candidate.status === "running" || candidate.status === "awaiting_review")) {
        next = updateCandidate(next, candidate.candidateId, {
          status: "changes_requested",
          latestReason: event.reason,
          updatedAt: event.blockedAt,
        });
      }
      return {
        ...setActiveTaskIds(next, active, event.blockedAt),
        latestSummary: event.reason,
        consecutiveFailuresByTask: wasDispatch
          ? { ...state.consecutiveFailuresByTask, [event.taskId]: prevFailures + 1 }
          : state.consecutiveFailuresByTask,
      };
    }
    case "task.unblocked":
      return {
        ...setWorkflowStatus(updateTask(state, event.taskId, {
          status: "ready",
          readyAt: event.readyAt,
          blockedReason: undefined,
        }), event.readyAt),
        status: state.status === "blocked" ? "planning" : state.status,
        blockedReason: state.status === "blocked" ? undefined : state.blockedReason,
        latestHandoff: undefined,
      };
    case "task.superseded": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      return {
        ...setActiveTaskIds(updateTask(state, event.taskId, {
          status: "superseded",
          latestSummary: event.reason,
          completedAt: event.supersededAt,
        }), active, event.supersededAt),
      };
    }
    case "candidate.created":
      return {
        ...upsertCandidate(state, event.candidate),
        updatedAt: event.createdAt,
        candidatePassesByTask: {
          ...state.candidatePassesByTask,
          [event.candidate.taskId]: (state.candidatePassesByTask[event.candidate.taskId] ?? 0) + 1,
        },
      };
    case "candidate.produced": {
      let next = updateCandidate(state, event.candidateId, {
        status: "awaiting_review",
        headCommit: event.headCommit,
        summary: event.summary,
        handoff: event.handoff,
        presentation: event.presentation,
        completion: event.completion,
        alignment: event.alignment,
        checkResults: event.checkResults,
        scriptsRun: event.scriptsRun,
        artifactRefs: event.artifactRefs,
        tokensUsed: event.tokensUsed,
        latestReason: event.summary,
        updatedAt: event.producedAt,
      });
      next = updateTask(next, event.taskId, {
        candidateId: event.candidateId,
        latestSummary: event.summary,
        artifactRefs: event.artifactRefs,
      });
      return {
        ...next,
        latestSummary: event.summary,
        updatedAt: event.producedAt,
      };
    }
    case "candidate.reviewed": {
      const taskStatus: FactoryTaskStatus =
        event.status === "approved" ? "approved" : event.status === "changes_requested" ? "ready" : "superseded";
      let next = updateCandidate(state, event.candidateId, {
        status: event.status,
        summary: event.summary,
        handoff: event.handoff,
        presentation: event.presentation,
        latestReason: event.summary,
        approvedAt: event.status === "approved" ? event.reviewedAt : undefined,
        updatedAt: event.reviewedAt,
      });
      next = updateTask(next, event.taskId, {
        status: taskStatus,
        latestSummary: event.summary,
        completedAt: event.status === "approved" ? event.reviewedAt : undefined,
      });
      return {
        ...setActiveTaskIds(next, state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId), event.reviewedAt),
        latestSummary: event.summary,
      };
    }
    case "investigation.reported": {
      const active = state.workflow.activeTaskIds.filter((taskId) => taskId !== event.taskId);
      const taskStatus: FactoryTaskStatus = event.outcome === "approved"
        ? "approved"
        : "blocked";
      let next = updateCandidate(state, event.candidateId, {
        status: event.outcome === "approved" ? "approved" : "changes_requested",
        summary: event.summary,
        handoff: event.handoff,
        presentation: event.presentation,
        artifactRefs: event.artifactRefs,
        headCommit: event.evidenceCommit,
        latestReason: event.summary,
        approvedAt: event.outcome === "approved" ? event.reportedAt : undefined,
        updatedAt: event.reportedAt,
      });
      next = updateTask(next, event.taskId, {
        status: taskStatus,
        candidateId: event.candidateId,
        latestSummary: event.summary,
        artifactRefs: event.artifactRefs,
        blockedReason: taskStatus === "blocked" ? event.handoff : undefined,
        completedAt: taskStatus === "approved" ? event.reportedAt : undefined,
      });
      return {
        ...setActiveTaskIds(next, active, event.reportedAt),
        latestSummary: event.summary,
        investigation: {
          reports: {
            ...state.investigation.reports,
            [event.taskId]: {
              taskId: event.taskId,
              candidateId: event.candidateId,
              outcome: event.outcome,
              summary: event.summary,
              handoff: event.handoff,
              presentation: event.presentation,
              completion: event.completion,
              report: event.report,
              artifactRefs: event.artifactRefs,
              evidenceCommit: event.evidenceCommit,
              reportedAt: event.reportedAt,
            },
          },
          reportOrder: state.investigation.reportOrder.includes(event.taskId)
            ? state.investigation.reportOrder
            : [...state.investigation.reportOrder, event.taskId],
          synthesized: undefined,
        },
      };
    }
    case "investigation.synthesized":
      return {
        ...state,
        latestSummary: event.summary,
        updatedAt: event.synthesizedAt,
        investigation: {
          ...state.investigation,
          synthesized: {
            summary: event.summary,
            report: event.report,
            taskIds: event.taskIds,
            synthesizedAt: event.synthesizedAt,
          },
        },
      };
    case "candidate.conflicted":
      return {
        ...updateCandidate(state, event.candidateId, {
          status: "conflicted",
          conflictReason: event.reason,
          latestReason: event.reason,
          updatedAt: event.conflictedAt,
        }),
        updatedAt: event.conflictedAt,
      };
    case "rebracket.applied":
      return {
        ...state,
        latestRebracket: {
          frontierTaskIds: event.frontierTaskIds,
          selectedActionId: event.selectedActionId,
          reason: event.reason,
          confidence: event.confidence,
          source: event.source,
          basedOn: event.basedOn,
          appliedAt: event.appliedAt,
        },
        updatedAt: event.appliedAt,
      };
    case "merge.applied":
      return {
        ...updateCandidate(state, event.candidateId, {
          status: "integrated",
          latestReason: event.summary,
          integratedAt: event.appliedAt,
          updatedAt: event.appliedAt,
        }),
        updatedAt: event.appliedAt,
        latestSummary: event.summary,
      };
    case "integration.queued":
      return {
        ...state,
        status: "integrating",
        updatedAt: event.queuedAt,
        integration: {
          ...state.integration,
          status: "queued",
          branchName: event.branchName,
          branchRef: event.branchRef,
          queuedCandidateIds: [...new Set([...state.integration.queuedCandidateIds, event.candidateId])],
          activeCandidateId: state.integration.activeCandidateId,
          updatedAt: event.queuedAt,
        },
      };
    case "integration.merging":
      return {
        ...state,
        status: "integrating",
        updatedAt: event.startedAt,
        integration: {
          ...state.integration,
          status: "merging",
          activeCandidateId: event.candidateId,
          updatedAt: event.startedAt,
        },
      };
    case "integration.validating":
      return {
        ...state,
        status: "integrating",
        updatedAt: event.startedAt,
        integration: {
          ...state.integration,
          status: "validating",
          activeCandidateId: event.candidateId,
          updatedAt: event.startedAt,
        },
      };
    case "integration.validated":
      return {
        ...state,
        status: "integrating",
        updatedAt: event.validatedAt,
        latestSummary: event.summary,
        integration: {
          ...state.integration,
          status: "validated",
          activeCandidateId: event.candidateId,
          headCommit: event.headCommit,
          validationResults: event.validationResults,
          lastSummary: event.summary,
          updatedAt: event.validatedAt,
        },
      };
    case "integration.ready_to_promote":
      return {
        ...state,
        status: "promoting",
        updatedAt: event.readyAt,
        latestSummary: event.summary,
        integration: {
          ...state.integration,
          status: "ready_to_promote",
          headCommit: event.headCommit,
          lastSummary: event.summary,
          updatedAt: event.readyAt,
        },
      };
    case "integration.promoting":
      return {
        ...state,
        status: "promoting",
        updatedAt: event.startedAt,
        integration: {
          ...state.integration,
          status: "promoting",
          activeCandidateId: event.candidateId,
          updatedAt: event.startedAt,
        },
      };
    case "integration.promoted":
      return {
        ...state,
        status: "completed",
        updatedAt: event.promotedAt,
        latestSummary: event.summary,
        blockedReason: undefined,
        integration: {
          ...state.integration,
          status: "promoted",
          promotedCommit: event.promotedCommit,
          lastSummary: event.summary,
          prUrl: event.prUrl ?? state.integration.prUrl,
          prNumber: event.prNumber ?? state.integration.prNumber,
          headRefName: event.headRefName ?? state.integration.headRefName,
          baseRefName: event.baseRefName ?? state.integration.baseRefName,
          conflictReason: undefined,
          updatedAt: event.promotedAt,
        },
      };
    case "integration.conflicted":
      return {
        ...state,
        status: "integrating",
        updatedAt: event.conflictedAt,
        blockedReason: event.reason,
        integration: {
          ...state.integration,
          status: "conflicted",
          activeCandidateId: event.candidateId,
          headCommit: event.headCommit ?? state.integration.headCommit,
          conflictReason: event.reason,
          updatedAt: event.conflictedAt,
        },
      };
    case "objective.completed":
      return {
        ...state,
        status: "completed",
        latestSummary: event.summary,
        blockedReason: undefined,
        updatedAt: event.completedAt,
        workflow: {
          ...state.workflow,
          status: "completed",
          updatedAt: event.completedAt,
        },
      };
    case "objective.blocked":
      return {
        ...state,
        status: "blocked",
        blockedReason: event.reason,
        latestSummary: event.summary,
        updatedAt: event.blockedAt,
        workflow: {
          ...state.workflow,
          status: "blocked",
          updatedAt: event.blockedAt,
        },
      };
    case "objective.failed":
      return {
        ...state,
        status: "failed",
        blockedReason: event.reason,
        latestSummary: event.reason,
        updatedAt: event.failedAt,
        workflow: {
          ...state.workflow,
          status: "failed",
          updatedAt: event.failedAt,
        },
      };
    case "objective.canceled":
      return {
        ...state,
        status: "canceled",
        blockedReason: event.reason,
        latestSummary: event.reason ?? "canceled",
        updatedAt: event.canceledAt,
        workflow: {
          ...state.workflow,
          status: "canceled",
          updatedAt: event.canceledAt,
        },
      };
    case "objective.archived":
      return {
        ...state,
        archivedAt: state.archivedAt ?? event.archivedAt,
        updatedAt: event.archivedAt,
      };
    case "monitor.checkpoint":
      return {
        ...state,
        updatedAt: event.evaluatedAt,
      };
    case "monitor.intervention":
      return {
        ...state,
        updatedAt: event.interventionAt,
      };
    default: {
      const _never: never = event;
      return _never;
    }
  }
};
