// ============================================================================
// Agent Module - think/act/observe run receipts
// ============================================================================

import type { Decide, Reducer } from "../core/types.js";
import type { FailureRecord, FailureStateRecord } from "./failure.js";
import { cloneFailureRecord } from "./failure.js";

export type AgentToolName = string;

export type AgentValidationEvidence = {
  readonly tool?: string;
  readonly environment?: string;
  readonly candidateHash?: string;
  readonly formalStatementHash?: string;
  readonly failedDeclarations?: ReadonlyArray<string>;
  readonly timings?: Readonly<Record<string, number>>;
  readonly candidateContent?: string;
  readonly formalStatement?: string;
};

export type AgentEvent =
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
        readonly maxIterations: number;
        readonly maxToolOutputChars: number;
        readonly memoryScope: string;
        readonly workspace: string;
        readonly extra?: Readonly<Record<string, unknown>>;
      };
      readonly model: string;
      readonly promptHash?: string;
      readonly promptPath?: string;
    }
  | {
      readonly type: "config.updated";
      readonly runId: string;
      readonly agentId?: string;
      readonly config: {
        readonly maxIterations?: number;
        readonly memoryScope?: string;
      };
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
      readonly type: "iteration.started";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
    }
  | {
      readonly type: "thought.logged";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
      readonly content: string;
    }
  | {
      readonly type: "action.planned";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
      readonly actionType: "tool" | "final";
      readonly name?: string;
      readonly input?: Record<string, unknown>;
    }
  | {
      readonly type: "tool.called";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
      readonly tool: string;
      readonly input: Record<string, unknown>;
      readonly summary?: string;
      readonly durationMs?: number;
      readonly error?: string;
    }
  | {
      readonly type: "tool.observed";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
      readonly tool: string;
      readonly output: string;
      readonly truncated: boolean;
    }
  | {
      readonly type: "memory.slice";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
      readonly scope: string;
      readonly query?: string;
      readonly chars: number;
      readonly itemCount: number;
      readonly truncated: boolean;
    }
  | {
      readonly type: "validation.report";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
      readonly gate: string;
      readonly ok: boolean;
      readonly summary: string;
      readonly target?: string;
      readonly details?: string;
      readonly evidence?: AgentValidationEvidence;
    }
  | {
      readonly type: "response.finalized";
      readonly runId: string;
      readonly agentId?: string;
      readonly content: string;
    }
  | {
      readonly type: "run.continued";
      readonly runId: string;
      readonly agentId?: string;
      readonly nextRunId: string;
      readonly nextJobId: string;
      readonly profileId?: string;
      readonly objectiveId?: string;
      readonly previousMaxIterations: number;
      readonly nextMaxIterations: number;
      readonly continuationDepth: number;
      readonly summary: string;
    }
  | {
      readonly type: "context.pruned";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
      readonly mode: "soft" | "hard";
      readonly before: number;
      readonly after: number;
      readonly note?: string;
    }
  | {
      readonly type: "context.compacted";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
      readonly reason: "threshold" | "overflow";
      readonly before: number;
      readonly after: number;
      readonly note?: string;
    }
  | {
      readonly type: "overflow.recovered";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
      readonly note?: string;
    }
  | {
      readonly type: "subagent.merged";
      readonly runId: string;
      readonly agentId?: string;
      readonly subJobId: string;
      readonly subRunId: string;
      readonly task: string;
      readonly summary: string;
    }
  | {
      readonly type: "agent.delegated";
      readonly runId: string;
      readonly agentId?: string;
      readonly subJobId: string;
      readonly delegatedTo: string;
      readonly task: string;
      readonly summary: string;
    }
  | {
      readonly type: "memory.flushed";
      readonly runId: string;
      readonly iteration: number;
      readonly agentId?: string;
      readonly scope: string;
      readonly chars: number;
    }
  | {
      readonly type: "profile.selected";
      readonly runId: string;
      readonly agentId?: string;
      readonly profileId: string;
      readonly reason: string;
    }
  | {
      readonly type: "profile.resolved";
      readonly runId: string;
      readonly agentId?: string;
      readonly rootProfileId: string;
      readonly importedProfileIds: ReadonlyArray<string>;
      readonly profilePaths: ReadonlyArray<string>;
      readonly fileHashes: Readonly<Record<string, string>>;
      readonly resolvedHash: string;
    }
  | {
      readonly type: "profile.handoff";
      readonly runId: string;
      readonly agentId?: string;
      readonly fromProfileId: string;
      readonly toProfileId: string;
      readonly reason: string;
    };

export type AgentCmd = {
  readonly type: "emit";
  readonly event: AgentEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type AgentState = {
  readonly runId?: string;
  readonly problem: string;
  readonly status: "idle" | "running" | "failed" | "completed";
  readonly statusNote?: string;
  readonly iteration: number;
  readonly thought?: string;
  readonly finalResponse?: string;
  readonly lastTool?: {
    readonly name: string;
    readonly summary?: string;
    readonly error?: string;
    readonly updatedAt: number;
  };
  readonly failure?: FailureStateRecord;
  readonly config?: {
    readonly maxIterations: number;
    readonly maxToolOutputChars: number;
    readonly memoryScope: string;
    readonly workspace: string;
    readonly extra?: Readonly<Record<string, unknown>>;
    readonly model: string;
    readonly promptHash?: string;
    readonly promptPath?: string;
    readonly workflowId: string;
    readonly workflowVersion: string;
    readonly updatedAt: number;
  };
  readonly profile?: {
    readonly profileId: string;
    readonly importedProfileIds: ReadonlyArray<string>;
    readonly resolvedHash?: string;
    readonly handoffTarget?: string;
    readonly updatedAt: number;
  };
};

export const initial: AgentState = {
  problem: "",
  status: "idle",
  iteration: 0,
};

export const decide: Decide<AgentCmd, AgentEvent> = (cmd) => [cmd.event];

export const reduce: Reducer<AgentState, AgentEvent> = (state, event, ts) => {
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
          maxIterations: event.config.maxIterations,
          maxToolOutputChars: event.config.maxToolOutputChars,
          memoryScope: event.config.memoryScope,
          workspace: event.config.workspace,
          extra: event.config.extra,
          model: event.model,
          promptHash: event.promptHash,
          promptPath: event.promptPath,
          workflowId: event.workflow.id,
          workflowVersion: event.workflow.version,
          updatedAt: ts,
        },
      };
    case "config.updated": {
      if (!state.config) {
        throw new Error(`Invariant: config missing for ${event.type}`);
      }
      return {
        ...state,
        config: {
          ...state.config,
          maxIterations: event.config.maxIterations ?? state.config.maxIterations,
          memoryScope: event.config.memoryScope ?? state.config.memoryScope,
          updatedAt: ts,
        },
      };
    }
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
    case "iteration.started":
      return {
        ...state,
        iteration: Math.max(state.iteration, event.iteration),
      };
    case "thought.logged":
      return {
        ...state,
        thought: event.content,
      };
    case "tool.called":
      return {
        ...state,
        lastTool: {
          name: event.tool,
          summary: event.summary,
          error: event.error,
          updatedAt: ts,
        },
      };
    case "response.finalized":
      return {
        ...state,
        status: "completed",
        finalResponse: event.content,
      };
    case "profile.selected":
      return {
        ...state,
        profile: {
          profileId: event.profileId,
          importedProfileIds: state.profile?.importedProfileIds ?? [],
          resolvedHash: state.profile?.resolvedHash,
          handoffTarget: state.profile?.handoffTarget,
          updatedAt: ts,
        },
      };
    case "profile.resolved":
      return {
        ...state,
        profile: {
          profileId: event.rootProfileId,
          importedProfileIds: [...event.importedProfileIds],
          resolvedHash: event.resolvedHash,
          handoffTarget: state.profile?.handoffTarget,
          updatedAt: ts,
        },
      };
    case "profile.handoff":
      return {
        ...state,
        profile: {
          profileId: event.fromProfileId,
          importedProfileIds: state.profile?.importedProfileIds ?? [],
          resolvedHash: state.profile?.resolvedHash,
          handoffTarget: event.toProfileId,
          updatedAt: ts,
        },
      };
    case "action.planned":
    case "tool.observed":
    case "memory.slice":
    case "validation.report":
    case "run.continued":
    case "context.pruned":
    case "context.compacted":
    case "overflow.recovered":
    case "subagent.merged":
    case "agent.delegated":
    case "memory.flushed":
      return state;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
};
