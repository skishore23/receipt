// ============================================================================
// Theorem Guild Module - LLM-only multi-agent proof receipts
// ============================================================================

import type { Decide, Reducer } from "../core/types.js";
import type { FailureRecord, FailureStateRecord } from "./failure.js";
import { cloneFailureRecord } from "./failure.js";

export type AgentId = string;
export type ClaimId = string;

export type MemorySliceItem = {
  readonly kind: TheoremEvent["type"];
  readonly claimId?: ClaimId;
  readonly targetClaimId?: ClaimId;
  readonly agentId?: AgentId;
};

export type TheoremAxiomEvidence = {
  readonly phase: "attempt" | "verify";
  readonly tool: string;
  readonly environment?: string;
  readonly candidateHash?: string;
  readonly formalStatementHash?: string;
  readonly candidateContent?: string;
  readonly formalStatement?: string;
  readonly ok: boolean;
  readonly failedDeclarations: ReadonlyArray<string>;
  readonly timings?: Readonly<Record<string, number>>;
  readonly subJobId?: string;
  readonly subRunId?: string;
};

export type TheoremEvent =
  | {
      readonly type: "problem.set";
      readonly runId: string;
      readonly problem: string;
      readonly agentId?: AgentId;
    }
  | {
      readonly type: "problem.appended";
      readonly runId: string;
      readonly append: string;
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
      readonly type: "failure.report";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly failure: FailureRecord;
    }
  | {
      readonly type: "attempt.proposed";
      readonly runId: string;
      readonly claimId: ClaimId;
      readonly agentId: AgentId;
      readonly content: string;
      readonly uses?: ReadonlyArray<string>;
    }
  | {
      readonly type: "lemma.proposed";
      readonly runId: string;
      readonly claimId: ClaimId;
      readonly agentId: AgentId;
      readonly content: string;
      readonly uses?: ReadonlyArray<string>;
    }
  | {
      readonly type: "critique.raised";
      readonly runId: string;
      readonly claimId: ClaimId;
      readonly agentId: AgentId;
      readonly targetClaimId: ClaimId;
      readonly content: string;
      readonly uses?: ReadonlyArray<string>;
    }
  | {
      readonly type: "patch.applied";
      readonly runId: string;
      readonly claimId: ClaimId;
      readonly agentId: AgentId;
      readonly targetClaimId: ClaimId;
      readonly content: string;
      readonly uses?: ReadonlyArray<string>;
    }
  | {
      readonly type: "branch.created";
      readonly runId: string;
      readonly branchId: string;
      readonly forkAt: number;
      readonly note?: string;
    }
  | {
      readonly type: "summary.made";
      readonly runId: string;
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
      readonly type: "prompt.context";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly phase: "attempt" | "lemma" | "critique" | "patch" | "merge" | "verify" | "final" | "revise" | "orchestrate";
      readonly title?: string;
      readonly content: string;
      readonly round?: number;
      readonly claimId?: ClaimId;
      readonly targetClaimId?: ClaimId;
    }
  | {
      readonly type: "orchestrator.decision";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly round?: number;
      readonly action: "continue" | "done";
      readonly reason?: string;
      readonly skipLemma?: boolean;
      readonly skipCritique?: boolean;
      readonly skipPatch?: boolean;
      readonly skipMerge?: boolean;
      readonly focus?: Readonly<Record<string, string>>;
      readonly raw?: string;
    }
  | {
      readonly type: "memory.slice";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly phase: "attempt" | "lemma" | "critique" | "patch" | "merge";
      readonly window: number;
      readonly bracket?: string;
      readonly maxChars: number;
      readonly chars: number;
      readonly itemCount: number;
      readonly items?: ReadonlyArray<MemorySliceItem>;
      readonly truncated?: boolean;
      readonly targetClaimId?: ClaimId;
    }
  | {
      readonly type: "context.pruned";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly stage: string;
      readonly mode: "soft" | "hard";
      readonly before: number;
      readonly after: number;
      readonly note?: string;
    }
  | {
      readonly type: "context.compacted";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly stage: string;
      readonly reason: "threshold" | "overflow";
      readonly before: number;
      readonly after: number;
      readonly note?: string;
    }
  | {
      readonly type: "overflow.recovered";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly stage: string;
      readonly note?: string;
    }
  | {
      readonly type: "tool.called";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly tool: string;
      readonly input?: Record<string, unknown>;
      readonly summary?: string;
      readonly durationMs?: number;
      readonly error?: string;
    }
  | {
      readonly type: "subagent.merged";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly subJobId: string;
      readonly subRunId: string;
      readonly task: string;
      readonly summary: string;
      readonly outcome?: string;
      readonly evidence?: ReadonlyArray<TheoremAxiomEvidence>;
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
      readonly evidence?: TheoremAxiomEvidence;
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
      readonly type: "merge.evidence.computed";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly mergePolicyId: string;
      readonly mergePolicyVersion: string;
      readonly note?: string;
    }
  | {
      readonly type: "merge.candidate.scored";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly mergePolicyId: string;
      readonly candidateId: string;
      readonly score: Readonly<Record<string, number>>;
    }
  | {
      readonly type: "merge.applied";
      readonly runId: string;
      readonly agentId?: AgentId;
      readonly mergePolicyId: string;
      readonly mergePolicyVersion: string;
      readonly candidateId: string;
      readonly reason?: string;
    }
  | {
      readonly type: "solution.finalized";
      readonly runId: string;
      readonly agentId: AgentId;
      readonly content: string;
      readonly confidence: number;
      readonly gaps?: ReadonlyArray<string>;
    };

export type TheoremCmd = {
  readonly type: "emit";
  readonly event: TheoremEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
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
  readonly verification?: {
    status: "valid" | "needs" | "false";
    content: string;
    evidence?: TheoremAxiomEvidence;
    updatedAt: number;
  };
  readonly failure?: FailureStateRecord;
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
    case "problem.appended": {
      const append = event.append.trim();
      if (!append) return state;
      const base = state.problem.trim();
      const problem = base ? `${base}\n\n${append}` : append;
      return { ...state, problem };
    }
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
    case "failure.report":
      return {
        ...state,
        failure: {
          ...cloneFailureRecord(event.failure),
          updatedAt: ts,
        },
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
          evidence: event.evidence,
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
    case "merge.evidence.computed":
    case "merge.candidate.scored":
      return state;
    case "merge.applied":
      return {
        ...state,
        rebracket: {
          bracket: event.candidateId,
          score: state.rebracket?.score ?? 0,
          note: event.reason ?? state.rebracket?.note,
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
    case "phase.parallel":
    case "prompt.context":
    case "orchestrator.decision":
    case "memory.slice":
    case "context.pruned":
    case "context.compacted":
    case "overflow.recovered":
    case "tool.called":
    case "subagent.merged":
      return state;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
};
