// ============================================================================
// Theorem Guild Module - LLM-only multi-agent proof receipts
// ============================================================================

import type { Decide, Reducer } from "../core/types.js";

export type AgentId = string;
export type ClaimId = string;

export type TheoremEvent =
  | {
      readonly type: "problem.set";
      readonly runId: string;
      readonly problem: string;
      readonly agentId?: AgentId;
    }
  | {
      readonly type: "run.configured";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly workflow: { id: string; version: string };
      readonly config: {
        readonly rounds: number;
        readonly depth: number;
        readonly memoryWindow: number;
        readonly branchThreshold: number;
      };
      readonly model: string;
      readonly promptHash?: string;
      readonly promptPath?: string;
    }
  | {
      readonly type: "run.status";
      readonly runId: string;
      readonly status: "running" | "failed" | "completed";
      readonly agentId?: AgentId;
      readonly note?: string;
    }
  | {
      readonly type: "attempt.proposed";
      readonly runId?: string;
      readonly claimId: ClaimId;
      readonly agentId: AgentId;
      readonly content: string;
      readonly uses?: ReadonlyArray<string>;
    }
  | {
      readonly type: "lemma.proposed";
      readonly runId?: string;
      readonly claimId: ClaimId;
      readonly agentId: AgentId;
      readonly content: string;
      readonly uses?: ReadonlyArray<string>;
    }
  | {
      readonly type: "critique.raised";
      readonly runId?: string;
      readonly claimId: ClaimId;
      readonly agentId: AgentId;
      readonly targetClaimId: ClaimId;
      readonly content: string;
      readonly uses?: ReadonlyArray<string>;
    }
  | {
      readonly type: "patch.applied";
      readonly runId?: string;
      readonly claimId: ClaimId;
      readonly agentId: AgentId;
      readonly targetClaimId: ClaimId;
      readonly content: string;
      readonly uses?: ReadonlyArray<string>;
    }
  | {
      readonly type: "branch.created";
      readonly runId?: string;
      readonly branchId: string;
      readonly forkAt: number;
      readonly note?: string;
    }
  | {
      readonly type: "summary.made";
      readonly runId?: string;
      readonly claimId: ClaimId;
      readonly agentId: AgentId;
      readonly bracket: string;
      readonly content: string;
      readonly uses?: ReadonlyArray<string>;
    }
  | {
      readonly type: "phase.parallel";
      readonly runId: string;
      readonly phase: "attempt" | "critique" | "patch";
      readonly agents: ReadonlyArray<AgentId>;
      readonly round?: number;
    }
  | {
      readonly type: "agent.status";
      readonly runId: string;
      readonly agentId: AgentId;
      readonly status: "running" | "idle" | "done";
      readonly phase?: string;
      readonly round?: number;
      readonly note?: string;
    }
  | {
      readonly type: "verification.report";
      readonly runId: string;
      readonly agentId: AgentId;
      readonly status: "valid" | "needs" | "false";
      readonly content: string;
    }
  | {
      readonly type: "rebracket.applied";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly bracket: string;
      readonly score: number;
      readonly note?: string;
    }
  | {
      readonly type: "solution.finalized";
      readonly runId?: string;
      readonly agentId: AgentId;
      readonly content: string;
      readonly confidence: number;
      readonly gaps?: ReadonlyArray<string>;
    };

export type TheoremCmd = {
  readonly type: "emit";
  readonly event: TheoremEvent;
};

export type ClaimRecord = {
  readonly id: ClaimId;
  readonly agentId: AgentId;
  readonly content: string;
  readonly uses: ReadonlyArray<string>;
  readonly targetClaimId?: ClaimId;
  readonly updatedAt: number;
};

export type SummaryRecord = {
  readonly id: ClaimId;
  readonly agentId: AgentId;
  readonly content: string;
  readonly bracket: string;
  readonly uses: ReadonlyArray<string>;
  readonly updatedAt: number;
};

export type SolutionRecord = {
  readonly agentId: AgentId;
  readonly content: string;
  readonly confidence: number;
  readonly gaps: ReadonlyArray<string>;
  readonly updatedAt: number;
};

export type RunConfigRecord = {
  readonly rounds: number;
  readonly depth: number;
  readonly memoryWindow: number;
  readonly branchThreshold: number;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly updatedAt: number;
};

export type TheoremState = {
  readonly runId?: string;
  readonly problem: string;
  readonly status: "idle" | "running" | "failed" | "completed";
  readonly statusNote?: string;
  readonly config?: RunConfigRecord;
  readonly attempts: Readonly<Record<ClaimId, ClaimRecord>>;
  readonly lemmas: Readonly<Record<ClaimId, ClaimRecord>>;
  readonly critiques: Readonly<Record<ClaimId, ClaimRecord>>;
  readonly patches: Readonly<Record<ClaimId, ClaimRecord>>;
  readonly summaries: Readonly<Record<ClaimId, SummaryRecord>>;
  readonly branches: ReadonlyArray<{ id: string; forkAt: number; note?: string }>; 
  readonly agentStatus: Readonly<Record<AgentId, { status: "running" | "idle" | "done"; phase?: string; round?: number; note?: string; updatedAt: number }>>;
  readonly verification?: { status: "valid" | "needs" | "false"; content: string; updatedAt: number };
  readonly rebracket?: { bracket: string; score: number; note?: string; updatedAt: number };
  readonly solution?: SolutionRecord;
};

export const initial: TheoremState = {
  problem: "",
  status: "idle",
  attempts: {},
  lemmas: {},
  critiques: {},
  patches: {},
  summaries: {},
  branches: [],
  agentStatus: {},
};

export const decide: Decide<TheoremCmd, TheoremEvent> = (cmd) => [cmd.event];

const upsertClaim = (
  map: Readonly<Record<ClaimId, ClaimRecord>>,
  event: {
    readonly claimId: ClaimId;
    readonly agentId: AgentId;
    readonly content: string;
    readonly uses?: ReadonlyArray<string>;
    readonly targetClaimId?: ClaimId;
  },
  ts: number
): Readonly<Record<ClaimId, ClaimRecord>> => {
  const existing = map[event.claimId];
  const content = existing ? existing.content + event.content : event.content;
  return {
    ...map,
    [event.claimId]: {
      id: event.claimId,
      agentId: event.agentId,
      content,
      uses: event.uses ?? existing?.uses ?? [],
      targetClaimId: event.targetClaimId ?? existing?.targetClaimId,
      updatedAt: ts,
    },
  };
};

const upsertSummary = (
  map: Readonly<Record<ClaimId, SummaryRecord>>,
  event: {
    readonly claimId: ClaimId;
    readonly agentId: AgentId;
    readonly content: string;
    readonly bracket: string;
    readonly uses?: ReadonlyArray<string>;
  },
  ts: number
): Readonly<Record<ClaimId, SummaryRecord>> => {
  const existing = map[event.claimId];
  const content = existing ? existing.content + event.content : event.content;
  return {
    ...map,
    [event.claimId]: {
      id: event.claimId,
      agentId: event.agentId,
      content,
      bracket: event.bracket,
      uses: event.uses ?? existing?.uses ?? [],
      updatedAt: ts,
    },
  };
};

export const reduce: Reducer<TheoremState, TheoremEvent> = (state, event, ts) => {
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
          rounds: event.config.rounds,
          depth: event.config.depth,
          memoryWindow: event.config.memoryWindow,
          branchThreshold: event.config.branchThreshold,
          model: event.model,
          promptHash: event.promptHash,
          promptPath: event.promptPath,
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
    case "attempt.proposed":
      return { ...state, attempts: upsertClaim(state.attempts, event, ts) };
    case "lemma.proposed":
      return { ...state, lemmas: upsertClaim(state.lemmas, event, ts) };
    case "critique.raised":
      return { ...state, critiques: upsertClaim(state.critiques, event, ts) };
    case "patch.applied":
      return { ...state, patches: upsertClaim(state.patches, event, ts) };
    case "summary.made":
      return { ...state, summaries: upsertSummary(state.summaries, event, ts) };
    case "agent.status":
      return {
        ...state,
        agentStatus: {
          ...state.agentStatus,
          [event.agentId]: {
            status: event.status,
            phase: event.phase,
            round: event.round,
            note: event.note,
            updatedAt: ts,
          },
        },
      };
    case "verification.report":
      return {
        ...state,
        verification: {
          status: event.status,
          content: event.content,
          updatedAt: ts,
        },
      };
    case "rebracket.applied":
      return {
        ...state,
        rebracket: {
          bracket: event.bracket,
          score: event.score,
          note: event.note,
          updatedAt: ts,
        },
      };
    case "branch.created":
      return { ...state, branches: [...state.branches, { id: event.branchId, forkAt: event.forkAt, note: event.note }] };
    case "solution.finalized":
      return {
        ...state,
        status: "completed",
        solution: {
          agentId: event.agentId,
          content: event.content,
          confidence: event.confidence,
          gaps: event.gaps ?? [],
          updatedAt: ts,
        },
      };
    default:
      return state;
  }
};
