// ============================================================================
// Axiom Simple Module - deterministic multi-worker AXLE orchestration receipts
// ============================================================================

import type { Decide, Reducer } from "../core/types.js";
import type { FailureRecord, FailureStateRecord } from "./failure.js";
import { cloneFailureRecord } from "./failure.js";

export type AxiomSimpleWorkerStrategy =
  | "direct"
  | "decompose"
  | "adversarial"
  | "repair"
  | "final_verify";

export type AxiomSimpleWorkerPhase =
  | "initial"
  | "repair"
  | "final_verify";

export type AxiomSimpleWorkerStatus =
  | "planned"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "missing";

export type AxiomSimpleVerificationStatus =
  | "verified"
  | "needs"
  | "false"
  | "failed";

export type AxiomSimpleWorkerSnapshot = {
  readonly childRunId: string;
  readonly jobId: string;
  readonly childStream: string;
  readonly status: AxiomSimpleWorkerStatus;
  readonly iteration: number;
  readonly lastTool?: string;
  readonly lastToolSummary?: string;
  readonly validationGate?: string;
  readonly validationSummary?: string;
  readonly validationOk?: boolean;
  readonly verifyTool?: string;
  readonly verified?: boolean;
  readonly outputExcerpt?: string;
  readonly observationExcerpt?: string;
  readonly touchedPath?: string;
  readonly candidateHash?: string;
  readonly formalStatementHash?: string;
  readonly failedDeclarations: ReadonlyArray<string>;
  readonly failureCount: number;
};

export type AxiomSimpleWorkerValidation = {
  readonly gate: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly tool?: string;
  readonly candidateHash?: string;
  readonly formalStatementHash?: string;
  readonly candidateContent?: string;
  readonly formalStatement?: string;
  readonly failedDeclarations: ReadonlyArray<string>;
};

export type AxiomSimpleEvent =
  | {
      readonly type: "problem.set";
      readonly runId: string;
      readonly problem: string;
      readonly agentId?: string;
    }
  | {
      readonly type: "run.configured";
      readonly runId: string;
      readonly agentId?: string;
      readonly workflow: { id: string; version: string };
      readonly config: {
        readonly workerCount: 2 | 3;
        readonly repairMode: "auto" | "off";
      };
      readonly updatedAt?: number;
    }
  | {
      readonly type: "run.status";
      readonly runId: string;
      readonly status: "running" | "failed" | "completed";
      readonly agentId?: string;
      readonly note?: string;
    }
  | {
      readonly type: "failure.report";
      readonly runId: string;
      readonly agentId?: string;
      readonly failure: FailureRecord;
    }
  | {
      readonly type: "worker.planned";
      readonly runId: string;
      readonly workerId: string;
      readonly label: string;
      readonly strategy: AxiomSimpleWorkerStrategy;
      readonly phase: AxiomSimpleWorkerPhase;
      readonly sourceWorkerId?: string;
      readonly order: number;
    }
  | {
      readonly type: "worker.started";
      readonly runId: string;
      readonly workerId: string;
      readonly jobId: string;
      readonly childRunId: string;
      readonly childStream: string;
      readonly status: AxiomSimpleWorkerStatus;
    }
  | {
      readonly type: "worker.progressed";
      readonly runId: string;
      readonly workerId: string;
      readonly snapshot: AxiomSimpleWorkerSnapshot;
    }
  | {
      readonly type: "worker.completed";
      readonly runId: string;
      readonly workerId: string;
      readonly status: AxiomSimpleWorkerStatus;
      readonly snapshot: AxiomSimpleWorkerSnapshot;
      readonly summary?: string;
    }
  | {
      readonly type: "candidate.scored";
      readonly runId: string;
      readonly workerId: string;
      readonly score: number;
      readonly reason: string;
      readonly verified: boolean;
      readonly failureCount: number;
      readonly repairDepth: number;
      readonly validationGate?: string;
      readonly validationSummary?: string;
    }
  | {
      readonly type: "winner.selected";
      readonly runId: string;
      readonly workerId: string;
      readonly score: number;
      readonly reason: string;
    }
  | {
      readonly type: "repair.started";
      readonly runId: string;
      readonly sourceWorkerId: string;
      readonly workerId: string;
      readonly note?: string;
    }
  | {
      readonly type: "repair.completed";
      readonly runId: string;
      readonly sourceWorkerId: string;
      readonly workerId: string;
      readonly status: AxiomSimpleWorkerStatus;
      readonly summary?: string;
    }
  | {
      readonly type: "final.verify.started";
      readonly runId: string;
      readonly sourceWorkerId: string;
      readonly workerId: string;
      readonly note?: string;
    }
  | {
      readonly type: "final.verify.completed";
      readonly runId: string;
      readonly sourceWorkerId: string;
      readonly workerId: string;
      readonly status: AxiomSimpleVerificationStatus;
      readonly summary: string;
      readonly validation?: AxiomSimpleWorkerValidation;
      readonly snapshot: AxiomSimpleWorkerSnapshot;
    }
  | {
      readonly type: "solution.finalized";
      readonly runId: string;
      readonly workerId: string;
      readonly childRunId?: string;
      readonly verificationStatus: AxiomSimpleVerificationStatus;
      readonly content: string;
      readonly summary: string;
      readonly gaps?: ReadonlyArray<string>;
    };

export type AxiomSimpleCmd = {
  readonly type: "emit";
  readonly event: AxiomSimpleEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type AxiomSimpleWorkerRecord = {
  readonly workerId: string;
  readonly label: string;
  readonly strategy: AxiomSimpleWorkerStrategy;
  readonly phase: AxiomSimpleWorkerPhase;
  readonly sourceWorkerId?: string;
  readonly order: number;
  readonly status: AxiomSimpleWorkerStatus;
  readonly jobId?: string;
  readonly childRunId?: string;
  readonly childStream?: string;
  readonly snapshot?: AxiomSimpleWorkerSnapshot;
  readonly summary?: string;
  readonly score?: {
    readonly score: number;
    readonly reason: string;
    readonly verified: boolean;
    readonly failureCount: number;
    readonly repairDepth: number;
    readonly validationGate?: string;
    readonly validationSummary?: string;
    readonly updatedAt: number;
  };
  readonly updatedAt: number;
};

export type AxiomSimpleState = {
  readonly runId?: string;
  readonly problem: string;
  readonly status: "idle" | "running" | "failed" | "completed";
  readonly statusNote?: string;
  readonly config?: {
    readonly workerCount: 2 | 3;
    readonly repairMode: "auto" | "off";
    readonly workflowId: string;
    readonly workflowVersion: string;
    readonly updatedAt: number;
  };
  readonly workers: Readonly<Record<string, AxiomSimpleWorkerRecord>>;
  readonly workerOrder: ReadonlyArray<string>;
  readonly winner?: {
    readonly workerId: string;
    readonly score: number;
    readonly reason: string;
    readonly updatedAt: number;
  };
  readonly finalVerification?: {
    readonly sourceWorkerId: string;
    readonly workerId: string;
    readonly status: AxiomSimpleVerificationStatus;
    readonly summary: string;
    readonly validation?: AxiomSimpleWorkerValidation;
    readonly snapshot: AxiomSimpleWorkerSnapshot;
    readonly updatedAt: number;
  };
  readonly solution?: {
    readonly workerId: string;
    readonly childRunId?: string;
    readonly verificationStatus: AxiomSimpleVerificationStatus;
    readonly content: string;
    readonly summary: string;
    readonly gaps: ReadonlyArray<string>;
    readonly updatedAt: number;
  };
  readonly failure?: FailureStateRecord;
};

export const initial: AxiomSimpleState = {
  problem: "",
  status: "idle",
  workers: {},
  workerOrder: [],
};

export const decide: Decide<AxiomSimpleCmd, AxiomSimpleEvent> = (cmd) => [cmd.event];

const upsertWorker = (
  workers: Readonly<Record<string, AxiomSimpleWorkerRecord>>,
  patch: Omit<AxiomSimpleWorkerRecord, "updatedAt"> & { readonly updatedAt?: number },
  ts: number,
): Readonly<Record<string, AxiomSimpleWorkerRecord>> => {
  const existing = workers[patch.workerId];
  return {
    ...workers,
    [patch.workerId]: {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? ts,
    },
  };
};

export const reduce: Reducer<AxiomSimpleState, AxiomSimpleEvent> = (state, event, ts) => {
  switch (event.type) {
    case "problem.set":
      return {
        ...initial,
        runId: event.runId,
        problem: event.problem,
        status: "running",
      };
    case "run.configured":
      return {
        ...state,
        config: {
          workerCount: event.config.workerCount,
          repairMode: event.config.repairMode,
          workflowId: event.workflow.id,
          workflowVersion: event.workflow.version,
          updatedAt: ts,
        },
      };
    case "run.status":
      return {
        ...state,
        status: event.status,
        statusNote: event.note ?? state.statusNote,
      };
    case "failure.report":
      return {
        ...state,
        failure: {
          ...cloneFailureRecord(event.failure),
          updatedAt: ts,
        },
      };
    case "worker.planned":
      return {
        ...state,
        workers: upsertWorker(state.workers, {
          workerId: event.workerId,
          label: event.label,
          strategy: event.strategy,
          phase: event.phase,
          sourceWorkerId: event.sourceWorkerId,
          order: event.order,
          status: "planned",
        }, ts),
        workerOrder: state.workerOrder.includes(event.workerId)
          ? state.workerOrder
          : [...state.workerOrder, event.workerId],
      };
    case "worker.started": {
      const existing = state.workers[event.workerId];
      if (!existing) return state;
      return {
        ...state,
        workers: upsertWorker(state.workers, {
          ...existing,
          status: event.status,
          jobId: event.jobId,
          childRunId: event.childRunId,
          childStream: event.childStream,
        }, ts),
      };
    }
    case "worker.progressed": {
      const existing = state.workers[event.workerId];
      if (!existing) return state;
      return {
        ...state,
        workers: upsertWorker(state.workers, {
          ...existing,
          status: event.snapshot.status,
          jobId: event.snapshot.jobId,
          childRunId: event.snapshot.childRunId,
          childStream: event.snapshot.childStream,
          snapshot: event.snapshot,
        }, ts),
      };
    }
    case "worker.completed": {
      const existing = state.workers[event.workerId];
      if (!existing) return state;
      return {
        ...state,
        workers: upsertWorker(state.workers, {
          ...existing,
          status: event.status,
          snapshot: event.snapshot,
          summary: event.summary ?? existing.summary,
          jobId: event.snapshot.jobId,
          childRunId: event.snapshot.childRunId,
          childStream: event.snapshot.childStream,
        }, ts),
      };
    }
    case "candidate.scored": {
      const existing = state.workers[event.workerId];
      if (!existing) return state;
      return {
        ...state,
        workers: upsertWorker(state.workers, {
          ...existing,
          score: {
            score: event.score,
            reason: event.reason,
            verified: event.verified,
            failureCount: event.failureCount,
            repairDepth: event.repairDepth,
            validationGate: event.validationGate,
            validationSummary: event.validationSummary,
            updatedAt: ts,
          },
        }, ts),
      };
    }
    case "winner.selected":
      return {
        ...state,
        winner: {
          workerId: event.workerId,
          score: event.score,
          reason: event.reason,
          updatedAt: ts,
        },
      };
    case "repair.started":
    case "repair.completed":
      return state;
    case "final.verify.started":
      return state;
    case "final.verify.completed":
      return {
        ...state,
        finalVerification: {
          sourceWorkerId: event.sourceWorkerId,
          workerId: event.workerId,
          status: event.status,
          summary: event.summary,
          validation: event.validation,
          snapshot: event.snapshot,
          updatedAt: ts,
        },
      };
    case "solution.finalized":
      return {
        ...state,
        solution: {
          workerId: event.workerId,
          childRunId: event.childRunId,
          verificationStatus: event.verificationStatus,
          content: event.content,
          summary: event.summary,
          gaps: event.gaps ?? [],
          updatedAt: ts,
        },
        status: event.verificationStatus === "verified" ? "completed" : state.status,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
};
