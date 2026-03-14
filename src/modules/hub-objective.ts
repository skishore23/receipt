import type { Decide, Reducer } from "../core/types.js";
import {
  createGraphState,
  type GraphNodeStatus,
  type GraphRef,
  type GraphRunStatus,
  type GraphState,
} from "../core/graph.js";

export type ObjectivePhase = "planner" | "builder" | "reviewer";

export type ObjectiveStatus =
  | "planning"
  | "building"
  | "reviewing"
  | "awaiting_confirmation"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled";

export type ObjectiveLane =
  | "planner"
  | "builder"
  | "reviewer"
  | "awaiting_confirmation"
  | "blocked"
  | "completed";

export type ObjectiveApprovalState =
  | "pending"
  | "awaiting_confirmation"
  | "approved";

export type ObjectiveCheckResult = {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: number;
  readonly finishedAt: number;
};

export type ObjectivePassStatus =
  | "queued"
  | "completed"
  | "blocked"
  | "failed"
  | "canceled";

export type ObjectivePassOutcome =
  | "plan_ready"
  | "candidate_ready"
  | "approved"
  | "changes_requested"
  | "blocked";

export type ObjectivePassRecord = {
  readonly passId: string;
  readonly phase: ObjectivePhase;
  readonly passNumber: number;
  readonly agentId: string;
  readonly jobId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly status: ObjectivePassStatus;
  readonly dispatchedAt: number;
  readonly completedAt?: number;
  readonly summary?: string;
  readonly handoff?: string;
  readonly outcome?: ObjectivePassOutcome;
  readonly commitHash?: string;
  readonly checkResults?: ReadonlyArray<ObjectiveCheckResult>;
  readonly error?: string;
  readonly promptPath?: string;
  readonly resultPath?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly lastMessagePath?: string;
};

export type ObjectiveGraphNodeRecord = {
  readonly nodeId: string;
  readonly kind: ObjectivePhase;
  readonly title: string;
  readonly passId: string;
  readonly passNumber: number;
  readonly agentId: string;
  readonly jobId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly inputRefs: Readonly<Record<string, GraphRef>>;
  readonly outputRefs: Readonly<Record<string, GraphRef>>;
  readonly status: GraphNodeStatus;
  readonly createdAt: number;
  readonly readyAt?: number;
  readonly dispatchedAt?: number;
  readonly completedAt?: number;
  readonly error?: string;
};

export type ObjectiveGraphState = GraphState<ObjectiveGraphNodeRecord>;

export type ObjectiveRecord = {
  readonly objectiveId: string;
  readonly title: string;
  readonly prompt: string;
  readonly channel: string;
  readonly baseHash: string;
  readonly checks: ReadonlyArray<string>;
  readonly status: ObjectiveStatus;
  readonly lane: ObjectiveLane;
  readonly archivedAt?: number;
  readonly currentPhase?: ObjectivePhase;
  readonly assignedAgentId?: string;
  readonly latestCommitHash?: string;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly approvalState: ObjectiveApprovalState;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ObjectiveState = ObjectiveRecord & {
  readonly currentPassId?: string;
  readonly passOrder: ReadonlyArray<string>;
  readonly passes: Readonly<Record<string, ObjectivePassRecord>>;
  readonly latestCheckResults: ReadonlyArray<ObjectiveCheckResult>;
  readonly graph: ObjectiveGraphState;
};

export type ObjectiveEvent =
  | {
      readonly type: "objective.created";
      readonly objectiveId: string;
      readonly title: string;
      readonly prompt: string;
      readonly channel: string;
      readonly baseHash: string;
      readonly checks: ReadonlyArray<string>;
      readonly createdAt: number;
    }
  | {
      readonly type: "phase.dispatched";
      readonly objectiveId: string;
      readonly pass: Omit<ObjectivePassRecord, "status">;
      readonly dispatchedAt: number;
    }
  | {
      readonly type: "graph.node.planned";
      readonly objectiveId: string;
      readonly node: Omit<ObjectiveGraphNodeRecord, "status" | "outputRefs">;
      readonly plannedAt: number;
    }
  | {
      readonly type: "graph.node.ready";
      readonly objectiveId: string;
      readonly nodeId: string;
      readonly readyAt: number;
    }
  | {
      readonly type: "graph.node.dispatched";
      readonly objectiveId: string;
      readonly nodeId: string;
      readonly jobId: string;
      readonly dispatchedAt: number;
    }
  | {
      readonly type: "graph.node.completed";
      readonly objectiveId: string;
      readonly nodeId: string;
      readonly outputRefs: Readonly<Record<string, GraphRef>>;
      readonly completedAt: number;
    }
  | {
      readonly type: "graph.node.terminal";
      readonly objectiveId: string;
      readonly nodeId: string;
      readonly status: Extract<GraphNodeStatus, "blocked" | "failed" | "canceled">;
      readonly reason: string;
      readonly completedAt: number;
    }
  | {
      readonly type: "plan.ready";
      readonly objectiveId: string;
      readonly passId: string;
      readonly summary: string;
      readonly handoff: string;
      readonly completedAt: number;
    }
  | {
      readonly type: "candidate.ready";
      readonly objectiveId: string;
      readonly passId: string;
      readonly summary: string;
      readonly handoff: string;
      readonly commitHash: string;
      readonly checkResults: ReadonlyArray<ObjectiveCheckResult>;
      readonly completedAt: number;
    }
  | {
      readonly type: "review.approved";
      readonly objectiveId: string;
      readonly passId: string;
      readonly summary: string;
      readonly handoff: string;
      readonly commitHash: string;
      readonly completedAt: number;
    }
  | {
      readonly type: "review.changes_requested";
      readonly objectiveId: string;
      readonly passId: string;
      readonly summary: string;
      readonly handoff: string;
      readonly commitHash: string;
      readonly completedAt: number;
    }
  | {
      readonly type: "blocked";
      readonly objectiveId: string;
      readonly phase?: ObjectivePhase;
      readonly passId?: string;
      readonly summary: string;
      readonly reason: string;
      readonly completedAt: number;
    }
  | {
      readonly type: "objective.resumed";
      readonly objectiveId: string;
      readonly phase: ObjectivePhase;
      readonly summary?: string;
      readonly resumedAt: number;
    }
  | {
      readonly type: "objective.awaiting_confirmation";
      readonly objectiveId: string;
      readonly summary: string;
      readonly createdAt: number;
    }
  | {
      readonly type: "objective.approved";
      readonly objectiveId: string;
      readonly approvedAt: number;
    }
  | {
      readonly type: "objective.completed";
      readonly objectiveId: string;
      readonly summary: string;
      readonly completedAt: number;
    }
  | {
      readonly type: "objective.failed";
      readonly objectiveId: string;
      readonly reason: string;
      readonly failedAt: number;
    }
  | {
      readonly type: "objective.canceled";
      readonly objectiveId: string;
      readonly canceledAt: number;
      readonly reason?: string;
    }
  | {
      readonly type: "objective.archived";
      readonly objectiveId: string;
      readonly archivedAt: number;
    };

export type ObjectiveCmd = {
  readonly type: "emit";
  readonly event: ObjectiveEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export const objectiveLaneForStatus = (status: ObjectiveStatus): ObjectiveLane => {
  switch (status) {
    case "planning":
      return "planner";
    case "building":
      return "builder";
    case "reviewing":
      return "reviewer";
    case "awaiting_confirmation":
      return "awaiting_confirmation";
    case "completed":
      return "completed";
    case "blocked":
    case "failed":
    case "canceled":
      return "blocked";
    default: {
      const _never: never = status;
      return _never;
    }
  }
};

const initialRecord = (event: Extract<ObjectiveEvent, { type: "objective.created" }>): ObjectiveState => ({
  objectiveId: event.objectiveId,
  title: event.title,
  prompt: event.prompt,
  channel: event.channel,
  baseHash: event.baseHash,
  checks: event.checks,
  status: "planning",
  lane: "planner",
  approvalState: "pending",
  createdAt: event.createdAt,
  updatedAt: event.createdAt,
  passOrder: [],
  passes: {},
  latestCheckResults: [],
  graph: createGraphState<ObjectiveGraphNodeRecord>(event.objectiveId, event.createdAt),
});

const statusForPhase = (phase: ObjectivePhase): ObjectiveStatus =>
  phase === "planner"
    ? "planning"
    : phase === "builder"
      ? "building"
      : "reviewing";

const updatePass = (
  state: ObjectiveState,
  passId: string,
  patch: Partial<ObjectivePassRecord>,
): ObjectiveState => {
  const current = state.passes[passId];
  if (!current) return state;
  return {
    ...state,
    passes: {
      ...state.passes,
      [passId]: {
        ...current,
        ...patch,
      },
    },
  };
};

const updateGraphNode = (
  state: ObjectiveState,
  nodeId: string,
  patch: Partial<ObjectiveGraphNodeRecord>,
): ObjectiveState => {
  const current = state.graph.nodes[nodeId];
  if (!current) return state;
  return {
    ...state,
    graph: {
      ...state.graph,
      nodes: {
        ...state.graph.nodes,
        [nodeId]: {
          ...current,
          ...patch,
        },
      },
    },
  };
};

const updateGraphStatus = (
  state: ObjectiveState,
  updatedAt: number,
  status: GraphRunStatus,
): ObjectiveState => ({
  ...state,
  graph: {
    ...state.graph,
    status,
    updatedAt,
  },
});

export const initialObjectiveState: ObjectiveState = {
  objectiveId: "",
  title: "",
  prompt: "",
  channel: "results",
  baseHash: "",
  checks: [],
  status: "planning",
  lane: "planner",
  approvalState: "pending",
  createdAt: 0,
  updatedAt: 0,
  passOrder: [],
  passes: {},
  latestCheckResults: [],
  graph: createGraphState<ObjectiveGraphNodeRecord>("", 0),
};

export const decideObjective: Decide<ObjectiveCmd, ObjectiveEvent> = (cmd) => [cmd.event];

export const reduceObjective: Reducer<ObjectiveState, ObjectiveEvent> = (state, event) => {
  switch (event.type) {
    case "objective.created":
      return initialRecord(event);
    case "phase.dispatched": {
      const pass: ObjectivePassRecord = {
        ...event.pass,
        status: "queued",
      };
      const nextStatus = statusForPhase(pass.phase);
      return {
        ...state,
        status: nextStatus,
        lane: objectiveLaneForStatus(nextStatus),
        currentPhase: pass.phase,
        assignedAgentId: pass.agentId,
        currentPassId: pass.passId,
        updatedAt: event.dispatchedAt,
        passOrder: state.passOrder.includes(pass.passId)
          ? state.passOrder
          : [...state.passOrder, pass.passId],
        passes: {
          ...state.passes,
          [pass.passId]: pass,
        },
      };
    }
    case "graph.node.planned":
      return {
        ...state,
        graph: {
          ...state.graph,
          updatedAt: event.plannedAt,
          order: state.graph.order.includes(event.node.nodeId)
            ? state.graph.order
            : [...state.graph.order, event.node.nodeId],
          nodes: {
            ...state.graph.nodes,
            [event.node.nodeId]: {
              ...event.node,
              outputRefs: {},
              status: "planned",
            },
          },
        },
      };
    case "graph.node.ready":
      return updateGraphStatus(
        updateGraphNode(state, event.nodeId, {
          status: "ready",
          readyAt: event.readyAt,
        }),
        event.readyAt,
        state.graph.status,
      );
    case "graph.node.dispatched":
      return {
        ...updateGraphNode(state, event.nodeId, {
          status: "dispatched",
          jobId: event.jobId,
          dispatchedAt: event.dispatchedAt,
        }),
        graph: {
          ...state.graph,
          currentNodeId: event.nodeId,
          updatedAt: event.dispatchedAt,
          nodes: {
            ...state.graph.nodes,
            [event.nodeId]: {
              ...state.graph.nodes[event.nodeId],
              status: "dispatched",
              jobId: event.jobId,
              dispatchedAt: event.dispatchedAt,
            },
          },
        },
      };
    case "graph.node.completed": {
      const next = updateGraphNode(state, event.nodeId, {
        status: "completed",
        outputRefs: event.outputRefs,
        completedAt: event.completedAt,
        error: undefined,
      });
      return {
        ...next,
        graph: {
          ...next.graph,
          currentNodeId: next.graph.currentNodeId === event.nodeId
            ? undefined
            : next.graph.currentNodeId,
          updatedAt: event.completedAt,
        },
      };
    }
    case "graph.node.terminal": {
      const next = updateGraphNode(state, event.nodeId, {
        status: event.status,
        completedAt: event.completedAt,
        error: event.reason,
      });
      return {
        ...next,
        graph: {
          ...next.graph,
          currentNodeId: next.graph.currentNodeId === event.nodeId
            ? undefined
            : next.graph.currentNodeId,
          updatedAt: event.completedAt,
        },
      };
    }
    case "plan.ready": {
      const next = updatePass(state, event.passId, {
        status: "completed",
        outcome: "plan_ready",
        summary: event.summary,
        handoff: event.handoff,
        completedAt: event.completedAt,
      });
      return {
        ...updateGraphStatus(next, event.completedAt, next.graph.status),
        latestSummary: event.summary,
        updatedAt: event.completedAt,
      };
    }
    case "candidate.ready": {
      const next = updatePass(state, event.passId, {
        status: "completed",
        outcome: "candidate_ready",
        summary: event.summary,
        handoff: event.handoff,
        commitHash: event.commitHash,
        checkResults: event.checkResults,
        completedAt: event.completedAt,
      });
      return {
        ...updateGraphStatus(next, event.completedAt, next.graph.status),
        latestCommitHash: event.commitHash,
        latestSummary: event.summary,
        latestCheckResults: event.checkResults,
        updatedAt: event.completedAt,
      };
    }
    case "review.approved": {
      const next = updatePass(state, event.passId, {
        status: "completed",
        outcome: "approved",
        summary: event.summary,
        handoff: event.handoff,
        commitHash: event.commitHash,
        completedAt: event.completedAt,
      });
      return {
        ...updateGraphStatus(next, event.completedAt, next.graph.status),
        latestCommitHash: event.commitHash,
        latestSummary: event.summary,
        updatedAt: event.completedAt,
      };
    }
    case "review.changes_requested": {
      const next = updatePass(state, event.passId, {
        status: "completed",
        outcome: "changes_requested",
        summary: event.summary,
        handoff: event.handoff,
        commitHash: event.commitHash,
        completedAt: event.completedAt,
      });
      return {
        ...updateGraphStatus(next, event.completedAt, next.graph.status),
        latestCommitHash: event.commitHash,
        latestSummary: event.summary,
        updatedAt: event.completedAt,
      };
    }
    case "blocked": {
      const next = event.passId
        ? updatePass(state, event.passId, {
          status: "blocked",
          outcome: "blocked",
          summary: event.summary,
          error: event.reason,
          completedAt: event.completedAt,
        })
        : state;
      return {
        ...next,
        status: "blocked",
        lane: "blocked",
        latestSummary: event.summary,
        blockedReason: event.reason,
        updatedAt: event.completedAt,
        graph: {
          ...next.graph,
          status: "blocked",
          updatedAt: event.completedAt,
        },
      };
    }
    case "objective.resumed": {
      const nextStatus = statusForPhase(event.phase);
      return {
        ...state,
        status: nextStatus,
        lane: objectiveLaneForStatus(nextStatus),
        currentPhase: event.phase,
        blockedReason: undefined,
        latestSummary: event.summary ?? `Resumed ${event.phase} pass.`,
        updatedAt: event.resumedAt,
        graph: {
          ...state.graph,
          status: "active",
          updatedAt: event.resumedAt,
        },
      };
    }
    case "objective.awaiting_confirmation":
      return {
        ...state,
        status: "awaiting_confirmation",
        lane: "awaiting_confirmation",
        approvalState: "awaiting_confirmation",
        latestSummary: event.summary,
        updatedAt: event.createdAt,
        graph: {
          ...state.graph,
          status: "awaiting_confirmation",
          updatedAt: event.createdAt,
        },
      };
    case "objective.approved":
      return {
        ...state,
        approvalState: "approved",
        updatedAt: event.approvedAt,
        graph: {
          ...state.graph,
          updatedAt: event.approvedAt,
        },
      };
    case "objective.completed":
      return {
        ...state,
        status: "completed",
        lane: "completed",
        latestSummary: event.summary,
        updatedAt: event.completedAt,
        graph: {
          ...state.graph,
          status: "completed",
          updatedAt: event.completedAt,
        },
      };
    case "objective.failed":
      return {
        ...state,
        status: "failed",
        lane: "blocked",
        blockedReason: event.reason,
        latestSummary: event.reason,
        updatedAt: event.failedAt,
        graph: {
          ...state.graph,
          status: "failed",
          updatedAt: event.failedAt,
        },
      };
    case "objective.canceled":
      return {
        ...state,
        status: "canceled",
        lane: "blocked",
        blockedReason: event.reason ?? "canceled",
        latestSummary: event.reason ?? "canceled",
        updatedAt: event.canceledAt,
        graph: {
          ...state.graph,
          status: "canceled",
          updatedAt: event.canceledAt,
        },
      };
    case "objective.archived": {
      const archivedAt = state.archivedAt ?? event.archivedAt;
      return {
        ...state,
        archivedAt,
        updatedAt: archivedAt,
      };
    }
    default: {
      const _never: never = event;
      return _never;
    }
  }
};
