import {
  createEvidenceState,
  createExecutionGraph,
  foldEvidenceDelta,
  selectNextRunnableExecutionStep,
  type EvidenceDelta,
  type EvidenceSemanticStatus,
  type EvidenceState,
  type ExecutionGraph,
  type ExecutionStepKind,
  type ExecutionStepStatus,
} from "@receipt/core/execution";
import type { Decide, Reducer } from "@receipt/core/types";

import type {
  FactoryEvidenceRecord,
  FactoryExecutionScriptRun,
  FactoryObjectiveProfileSnapshot,
} from "./types";

export type FactoryTaskProofPolicy = {
  readonly summary: string;
  readonly requirements: ReadonlyArray<string>;
};

export type FactoryTaskEffectPolicy = {
  readonly mutate: boolean;
  readonly validate: boolean;
  readonly integrate: boolean;
  readonly publish: boolean;
};

export type FactoryTaskSpec = {
  readonly goal: string;
  readonly constraints: ReadonlyArray<string>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly proofPolicy: FactoryTaskProofPolicy;
  readonly effectPolicy: FactoryTaskEffectPolicy;
  readonly profileId: string;
  readonly profileSnapshot: FactoryObjectiveProfileSnapshot;
  readonly operatorGuidance?: ReadonlyArray<string>;
};

export type FactoryEffectArtifact = {
  readonly label: string;
  readonly stepId?: string;
  readonly effectKind?: Extract<ExecutionStepKind, "validate" | "integrate" | "publish">;
  readonly path?: string;
  readonly summary?: string;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly producedAt?: number;
};

export type FactoryObjectiveEvidenceState = EvidenceState<
  FactoryEvidenceRecord,
  FactoryExecutionScriptRun,
  FactoryEffectArtifact
>;

export type FactoryEffectSummary = {
  readonly mutate?: string;
  readonly validate?: string;
  readonly integrate?: string;
  readonly publish?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
};

export type FactoryObjectiveFinalization = {
  readonly status: "completed" | "blocked" | "failed" | "canceled";
  readonly summary: string;
  readonly result: unknown;
  readonly blocker?: string;
  readonly effectSummary: FactoryEffectSummary;
  readonly finalizedAt: number;
};

export type FactoryObjectiveState = {
  readonly objectiveId: string;
  readonly profileSnapshot: FactoryObjectiveProfileSnapshot;
  readonly taskSpec: FactoryTaskSpec;
  readonly evidenceState: FactoryObjectiveEvidenceState;
  readonly finalization?: FactoryObjectiveFinalization;
  readonly updatedAt: number;
  readonly archivedAt?: number;
};

export type FactoryObjectiveGuidance = {
  readonly source: "operator" | "monitor" | "controller" | string;
  readonly message: string;
  readonly addedAt: number;
};

export type FactoryObjectiveEvent =
  | {
      readonly type: "objective.created";
      readonly objectiveId: string;
      readonly taskSpec: FactoryTaskSpec;
      readonly createdAt: number;
    }
  | {
      readonly type: "objective.guidance.added";
      readonly objectiveId: string;
      readonly guidance: FactoryObjectiveGuidance;
    }
  | {
      readonly type: "graph.set";
      readonly objectiveId: string;
      readonly graph: ExecutionGraph<string, string, string>;
      readonly setAt: number;
    }
  | {
      readonly type: "evidence.delta.recorded";
      readonly objectiveId: string;
      readonly delta: EvidenceDelta<
        FactoryEvidenceRecord,
        FactoryExecutionScriptRun,
        FactoryEffectArtifact
      >;
      readonly semanticStatus?: EvidenceSemanticStatus;
      readonly recordedAt: number;
    }
  | {
      readonly type: "objective.finalized";
      readonly objectiveId: string;
      readonly finalization: FactoryObjectiveFinalization;
    }
  | {
      readonly type: "objective.archived";
      readonly objectiveId: string;
      readonly archivedAt: number;
    };

export type FactoryObjectiveCmd = {
  readonly event?: FactoryObjectiveEvent;
  readonly events?: ReadonlyArray<FactoryObjectiveEvent>;
};

export type FactoryObjectiveDerivedPhase =
  | ExecutionStepKind
  | "finalized"
  | "archived"
  | "idle";

export type FactoryEffectEntry = {
  readonly stepId: string;
  readonly status: ExecutionStepStatus;
  readonly summary?: string;
  readonly artifacts: ReadonlyArray<FactoryEffectArtifact>;
  readonly observations: ReadonlyArray<string>;
};

export type FactoryEffectView = {
  readonly validate: ReadonlyArray<FactoryEffectEntry>;
  readonly integrate: ReadonlyArray<FactoryEffectEntry>;
  readonly publish: ReadonlyArray<FactoryEffectEntry>;
};

const FACTORY_EFFECT_STEP_KINDS = [
  "validate",
  "integrate",
  "publish",
] as const satisfies ReadonlyArray<Extract<ExecutionStepKind, "validate" | "integrate" | "publish">>;

const uniqueStrings = (
  items: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => [...new Set((items ?? []).map((item) => item.trim()).filter((item) => item.length > 0))];

const normalizeTaskSpec = (taskSpec: FactoryTaskSpec): FactoryTaskSpec => ({
  ...taskSpec,
  goal: taskSpec.goal.trim(),
  constraints: uniqueStrings(taskSpec.constraints),
  acceptanceCriteria: uniqueStrings(taskSpec.acceptanceCriteria),
  proofPolicy: {
    summary: taskSpec.proofPolicy.summary.trim(),
    requirements: uniqueStrings(taskSpec.proofPolicy.requirements),
  },
  effectPolicy: {
    mutate: Boolean(taskSpec.effectPolicy.mutate),
    validate: Boolean(taskSpec.effectPolicy.validate),
    integrate: Boolean(taskSpec.effectPolicy.integrate),
    publish: Boolean(taskSpec.effectPolicy.publish),
  },
  profileId: taskSpec.profileId.trim(),
  operatorGuidance: uniqueStrings(taskSpec.operatorGuidance),
});

const initialGraphKindsForTaskSpec = (
  taskSpec: FactoryTaskSpec,
): ReadonlyArray<ExecutionStepKind> => {
  if (taskSpec.effectPolicy.publish) {
    return ["collect", "analyze", "mutate", "validate", "integrate", "publish", "synthesize"];
  }
  if (
    taskSpec.effectPolicy.mutate
    || taskSpec.effectPolicy.validate
    || taskSpec.effectPolicy.integrate
  ) {
    return ["collect", "analyze", "mutate", "validate", "integrate", "synthesize"];
  }
  return ["collect", "analyze", "synthesize"];
};

const outputTokenForKind = (
  kind: ExecutionStepKind,
): string => {
  switch (kind) {
    case "collect":
      return "collected_evidence";
    case "analyze":
      return "analysis";
    case "mutate":
      return "mutation";
    case "validate":
      return "validation";
    case "integrate":
      return "integration";
    case "publish":
      return "publication";
    case "synthesize":
      return "result";
  }
};

export const buildFactoryInitialExecutionGraph = (
  objectiveId: string,
  taskSpec: FactoryTaskSpec,
): ExecutionGraph<string, string, string> => {
  const taskRef = {
    kind: "state",
    ref: `factory/objectives/${objectiveId}`,
    label: objectiveId,
  } as const;
  const stepKinds = initialGraphKindsForTaskSpec(taskSpec);
  const steps = stepKinds.map((kind, index) => {
    const dependency = stepKinds[index - 1];
    const inputToken = dependency ? outputTokenForKind(dependency) : taskRef.ref;
    const outputToken = outputTokenForKind(kind);
    return {
      id: kind,
      kind,
      goal: index === stepKinds.length - 1
        ? `Satisfy objective goal: ${taskSpec.goal}`
        : `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)} for objective goal: ${taskSpec.goal}`,
      scopeKey: `${objectiveId}:${kind}`,
      dependsOn: dependency ? [dependency] : [],
      inputs: [taskRef],
      completionSignal: `Record ${kind} evidence for ${objectiveId}.`,
      expectedEvidence: [outputToken],
      expectedScripts: [],
      expectedArtifacts: FACTORY_EFFECT_STEP_KINDS.includes(kind as never) ? [kind] : [],
      contract: {
        inputs: [inputToken],
        outputs: [outputToken],
      },
      status: "pending" as const,
    };
  });
  return createExecutionGraph({
    graphId: objectiveId,
    taskRef,
    steps,
  });
};

export const createFactoryObjectiveState = (input: {
  readonly objectiveId: string;
  readonly taskSpec: FactoryTaskSpec;
  readonly createdAt?: number;
}): FactoryObjectiveState => {
  const createdAt = input.createdAt ?? Date.now();
  const taskSpec = normalizeTaskSpec(input.taskSpec);
  return {
    objectiveId: input.objectiveId,
    profileSnapshot: taskSpec.profileSnapshot,
    taskSpec,
    evidenceState: createEvidenceState({
      graph: buildFactoryInitialExecutionGraph(input.objectiveId, taskSpec),
      semanticStatus: "empty",
      updatedAt: createdAt,
    }),
    finalization: undefined,
    updatedAt: createdAt,
    archivedAt: undefined,
  };
};

export const deriveFactoryObjectivePhase = (
  state: FactoryObjectiveState,
): FactoryObjectiveDerivedPhase => {
  if (typeof state.archivedAt === "number") return "archived";
  if (state.finalization) return "finalized";
  const activeStep = state.evidenceState.graph.steps.find((step) =>
    state.evidenceState.graph.activeFrontier.includes(step.id));
  if (activeStep) return activeStep.kind;
  const nextStep = selectNextRunnableExecutionStep(state.evidenceState.graph);
  return nextStep?.kind ?? "idle";
};

export const buildFactoryEffectView = (
  state: FactoryObjectiveState,
): FactoryEffectView => {
  const entries = FACTORY_EFFECT_STEP_KINDS.map((kind) => [
    kind,
    state.evidenceState.graph.steps
      .filter((step) => step.kind === kind)
      .map((step) => {
        const delta = state.evidenceState.deltas.find((item) => item.stepId === step.id);
        const artifacts = (delta?.artifacts ?? []).filter((artifact) =>
          artifact.stepId === step.id
          || artifact.effectKind === kind
          || typeof artifact.effectKind === "undefined");
        return {
          stepId: step.id,
          status: step.status,
          summary: delta?.summary ?? state.finalization?.effectSummary[kind],
          artifacts,
          observations: delta?.observations ?? [],
        } satisfies FactoryEffectEntry;
      }),
  ] as const);
  return Object.fromEntries(entries) as FactoryEffectView;
};

export const decideFactoryObjective: Decide<FactoryObjectiveCmd, FactoryObjectiveEvent> = (cmd) => {
  if (cmd.events?.length) return [...cmd.events];
  return cmd.event ? [cmd.event] : [];
};

export const reduceFactoryObjective: Reducer<FactoryObjectiveState, FactoryObjectiveEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "objective.created":
      return createFactoryObjectiveState({
        objectiveId: event.objectiveId,
        taskSpec: event.taskSpec,
        createdAt: event.createdAt,
      });
    case "objective.guidance.added":
      return {
        ...state,
        taskSpec: {
          ...state.taskSpec,
          operatorGuidance: uniqueStrings([
            ...(state.taskSpec.operatorGuidance ?? []),
            event.guidance.message,
          ]),
        },
        updatedAt: event.guidance.addedAt,
      };
    case "graph.set":
      if (event.graph.graphVersion <= state.evidenceState.graph.graphVersion) {
        throw new Error(
          `factory objective ${state.objectiveId} received non-monotonic graph version ${event.graph.graphVersion}`,
        );
      }
      return {
        ...state,
        evidenceState: {
          ...state.evidenceState,
          graph: event.graph,
          updatedAt: event.setAt,
        },
        updatedAt: event.setAt,
      };
    case "evidence.delta.recorded":
      return {
        ...state,
        evidenceState: foldEvidenceDelta(
          state.evidenceState,
          event.delta,
          event.semanticStatus,
        ),
        updatedAt: event.recordedAt,
      };
    case "objective.finalized":
      return {
        ...state,
        finalization: event.finalization,
        updatedAt: event.finalization.finalizedAt,
      };
    case "objective.archived":
      return {
        ...state,
        archivedAt: event.archivedAt,
        updatedAt: event.archivedAt,
      };
  }
};
