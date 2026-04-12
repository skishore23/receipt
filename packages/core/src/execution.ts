import type { GraphRef } from "./graph";

export type ExecutionStepKind =
  | "collect"
  | "analyze"
  | "mutate"
  | "synthesize"
  | "validate"
  | "integrate"
  | "publish";

export type ExecutionStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type ExecutionStepContract = {
  readonly inputs: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
};

export type ExecutionStep<
  TEvidence = string,
  TScript = string,
  TArtifact = string,
> = {
  readonly id: string;
  readonly kind: ExecutionStepKind;
  readonly goal: string;
  readonly scopeKey: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly inputs: ReadonlyArray<GraphRef>;
  readonly completionSignal: string;
  readonly expectedEvidence: ReadonlyArray<TEvidence>;
  readonly expectedScripts: ReadonlyArray<TScript>;
  readonly expectedArtifacts: ReadonlyArray<TArtifact>;
  readonly contract: ExecutionStepContract;
  readonly status: ExecutionStepStatus;
};

export type ExecutionGraph<
  TEvidence = string,
  TScript = string,
  TArtifact = string,
> = {
  readonly graphId: string;
  readonly graphVersion: number;
  readonly taskRef: GraphRef;
  readonly allowsParallelRunnableLeaves?: boolean;
  readonly activeFrontier: ReadonlyArray<string>;
  readonly completedStepIds: ReadonlyArray<string>;
  readonly pendingStepIds: ReadonlyArray<string>;
  readonly failedStepIds: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<ExecutionStep<TEvidence, TScript, TArtifact>>;
};

export type EvidenceDelta<
  TEvidence = Record<string, unknown>,
  TScript = Record<string, unknown>,
  TArtifact = Record<string, unknown>,
> = {
  readonly stepId: string;
  readonly evidenceRecords: ReadonlyArray<TEvidence>;
  readonly scriptsRun: ReadonlyArray<TScript>;
  readonly artifacts: ReadonlyArray<TArtifact>;
  readonly observations: ReadonlyArray<string>;
  readonly summary?: string;
  readonly updatedAt: number;
};

export type EvidenceSemanticStatus =
  | "empty"
  | "partial"
  | "sufficient"
  | "final";

export type EvidenceState<
  TEvidence = Record<string, unknown>,
  TScript = Record<string, unknown>,
  TArtifact = Record<string, unknown>,
> = {
  readonly graph: ExecutionGraph<TEvidence, TScript, TArtifact>;
  readonly deltas: ReadonlyArray<EvidenceDelta<TEvidence, TScript, TArtifact>>;
  readonly evidenceRecords: ReadonlyArray<TEvidence>;
  readonly scriptsRun: ReadonlyArray<TScript>;
  readonly artifacts: ReadonlyArray<TArtifact>;
  readonly observations: ReadonlyArray<string>;
  readonly semanticStatus: EvidenceSemanticStatus;
  readonly updatedAt: number;
};

const stableStringify = (value: unknown): string => {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
};

const uniqueStrings = (
  items: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => [...new Set((items ?? []).map((item) => item.trim()).filter((item) => item.length > 0))];

const dedupeItems = <T>(
  items: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = stableStringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

const sameStringSet = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean => {
  const leftSet = new Set(uniqueStrings(left));
  const rightSet = new Set(uniqueStrings(right));
  if (leftSet.size !== rightSet.size) return false;
  for (const value of leftSet) {
    if (!rightSet.has(value)) return false;
  }
  return true;
};

const contractTokensFromExpected = <T>(
  items: ReadonlyArray<T>,
  fallbackPrefix: string,
): ReadonlyArray<string> => items.map((item, index) =>
  typeof item === "string" && item.trim().length > 0
    ? item.trim()
    : `${fallbackPrefix}:${index}:${stableStringify(item)}`);

const normalizeStep = <
  TEvidence,
  TScript,
  TArtifact,
>(
  step: Omit<ExecutionStep<TEvidence, TScript, TArtifact>, "status" | "dependsOn" | "expectedEvidence" | "expectedScripts" | "expectedArtifacts" | "contract"> & {
    readonly status?: ExecutionStepStatus;
    readonly dependsOn?: ReadonlyArray<string>;
    readonly expectedEvidence?: ReadonlyArray<TEvidence>;
    readonly expectedScripts?: ReadonlyArray<TScript>;
    readonly expectedArtifacts?: ReadonlyArray<TArtifact>;
    readonly contract?: ExecutionStepContract;
  },
): ExecutionStep<TEvidence, TScript, TArtifact> => {
  const expectedEvidence = dedupeItems(step.expectedEvidence ?? []);
  const expectedScripts = dedupeItems(step.expectedScripts ?? []);
  const expectedArtifacts = dedupeItems(step.expectedArtifacts ?? []);
  return {
    ...step,
    dependsOn: uniqueStrings(step.dependsOn),
    expectedEvidence,
    expectedScripts,
    expectedArtifacts,
    contract: {
      inputs: uniqueStrings(step.contract?.inputs ?? step.inputs.map((item) => item.ref)),
      outputs: uniqueStrings(step.contract?.outputs ?? [
        ...contractTokensFromExpected(expectedEvidence, "evidence"),
        ...contractTokensFromExpected(expectedArtifacts, "artifact"),
      ]),
    },
    status: step.status ?? "pending",
  };
};

const indexByStepId = <
  TEvidence,
  TScript,
  TArtifact,
>(
  steps: ReadonlyArray<ExecutionStep<TEvidence, TScript, TArtifact>>,
): Map<string, ExecutionStep<TEvidence, TScript, TArtifact>> => {
  const map = new Map<string, ExecutionStep<TEvidence, TScript, TArtifact>>();
  for (const step of steps) {
    if (map.has(step.id)) {
      throw new Error(`execution graph contains duplicate step id ${step.id}`);
    }
    map.set(step.id, step);
  }
  return map;
};

const validateExecutionGraph = <
  TEvidence,
  TScript,
  TArtifact,
>(
  graph: {
    readonly graphId: string;
    readonly graphVersion: number;
    readonly taskRef: GraphRef;
    readonly allowsParallelRunnableLeaves?: boolean;
    readonly steps: ReadonlyArray<ExecutionStep<TEvidence, TScript, TArtifact>>;
  },
): void => {
  if (graph.graphId.trim().length === 0) {
    throw new Error("execution graph requires a graphId");
  }
  if (!Number.isFinite(graph.graphVersion) || graph.graphVersion < 1) {
    throw new Error("execution graph requires a monotonic graphVersion");
  }
  const stepsById = indexByStepId(graph.steps);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) {
      throw new Error(`execution graph contains a cycle at ${stepId}`);
    }
    visiting.add(stepId);
    const step = stepsById.get(stepId);
    if (!step) throw new Error(`execution graph missing step ${stepId}`);
    for (const dependencyId of step.dependsOn) {
      if (!stepsById.has(dependencyId)) {
        throw new Error(`execution graph step ${step.id} depends on missing step ${dependencyId}`);
      }
      if (dependencyId === step.id) {
        throw new Error(`execution graph step ${step.id} cannot depend on itself`);
      }
      visit(dependencyId);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of graph.steps) {
    visit(step.id);
  }
  const completed = new Set(
    graph.steps
      .filter((step) => step.status === "completed")
      .map((step) => step.id),
  );
  const running = graph.steps.filter((step) => step.status === "running");
  if (!graph.allowsParallelRunnableLeaves && running.length > 1) {
    throw new Error("execution graph only allows one active frontier without explicit parallel leaves");
  }
  for (const step of running) {
    if (!step.dependsOn.every((dependencyId) => completed.has(dependencyId))) {
      throw new Error(`execution graph running step ${step.id} is not runnable`);
    }
  }
};

const materializeExecutionGraph = <
  TEvidence,
  TScript,
  TArtifact,
>(
  graph: {
    readonly graphId: string;
    readonly graphVersion: number;
    readonly taskRef: GraphRef;
    readonly allowsParallelRunnableLeaves?: boolean;
    readonly steps: ReadonlyArray<ExecutionStep<TEvidence, TScript, TArtifact>>;
  },
): ExecutionGraph<TEvidence, TScript, TArtifact> => {
  validateExecutionGraph(graph);
  return {
    ...graph,
    activeFrontier: graph.steps
      .filter((step) => step.status === "running")
      .map((step) => step.id),
    completedStepIds: graph.steps
      .filter((step) => step.status === "completed")
      .map((step) => step.id),
    pendingStepIds: graph.steps
      .filter((step) => step.status === "pending")
      .map((step) => step.id),
    failedStepIds: graph.steps
      .filter((step) => step.status === "failed" || step.status === "canceled")
      .map((step) => step.id),
  };
};

export const selectRunnableExecutionSteps = <
  TEvidence,
  TScript,
  TArtifact,
>(
  graph: ExecutionGraph<TEvidence, TScript, TArtifact>,
): ReadonlyArray<ExecutionStep<TEvidence, TScript, TArtifact>> => {
  const completed = new Set(graph.completedStepIds);
  return graph.steps.filter((step) =>
    step.status === "pending"
    && step.dependsOn.every((dependencyId) => completed.has(dependencyId)));
};

export const selectNextRunnableExecutionStep = <
  TEvidence,
  TScript,
  TArtifact,
>(
  graph: ExecutionGraph<TEvidence, TScript, TArtifact>,
): ExecutionStep<TEvidence, TScript, TArtifact> | undefined => selectRunnableExecutionSteps(graph)[0];

export const createExecutionGraph = <
  TEvidence = string,
  TScript = string,
  TArtifact = string,
>(input: {
  readonly graphId: string;
  readonly graphVersion?: number;
  readonly taskRef: GraphRef;
  readonly allowsParallelRunnableLeaves?: boolean;
  readonly steps: ReadonlyArray<
    Omit<ExecutionStep<TEvidence, TScript, TArtifact>, "status" | "dependsOn" | "expectedEvidence" | "expectedScripts" | "expectedArtifacts" | "contract">
    & {
      readonly status?: ExecutionStepStatus;
      readonly dependsOn?: ReadonlyArray<string>;
      readonly expectedEvidence?: ReadonlyArray<TEvidence>;
      readonly expectedScripts?: ReadonlyArray<TScript>;
      readonly expectedArtifacts?: ReadonlyArray<TArtifact>;
      readonly contract?: ExecutionStepContract;
    }
  >;
}): ExecutionGraph<TEvidence, TScript, TArtifact> => materializeExecutionGraph({
  graphId: input.graphId,
  graphVersion: Math.max(1, input.graphVersion ?? 1),
  taskRef: input.taskRef,
  allowsParallelRunnableLeaves: input.allowsParallelRunnableLeaves,
  steps: input.steps.map((step) => normalizeStep(step)),
});

export const createSingleStepExecutionGraph = <
  TEvidence = string,
  TScript = string,
  TArtifact = string,
>(input: {
  readonly graphId: string;
  readonly taskRef: GraphRef;
  readonly stepId: string;
  readonly kind: ExecutionStepKind;
  readonly goal: string;
  readonly scopeKey: string;
  readonly inputs?: ReadonlyArray<GraphRef>;
  readonly completionSignal: string;
  readonly expectedEvidence?: ReadonlyArray<TEvidence>;
  readonly expectedScripts?: ReadonlyArray<TScript>;
  readonly expectedArtifacts?: ReadonlyArray<TArtifact>;
  readonly contract?: ExecutionStepContract;
  readonly status?: ExecutionStepStatus;
}): ExecutionGraph<TEvidence, TScript, TArtifact> => createExecutionGraph({
  graphId: input.graphId,
  taskRef: input.taskRef,
  steps: [{
    id: input.stepId,
    kind: input.kind,
    goal: input.goal,
    scopeKey: input.scopeKey,
    dependsOn: [],
    inputs: input.inputs ?? [],
    completionSignal: input.completionSignal,
    expectedEvidence: input.expectedEvidence ?? [],
    expectedScripts: input.expectedScripts ?? [],
    expectedArtifacts: input.expectedArtifacts ?? [],
    contract: input.contract,
    status: input.status ?? "running",
  }],
});

const updateExecutionStepStatus = <
  TEvidence,
  TScript,
  TArtifact,
>(
  graph: ExecutionGraph<TEvidence, TScript, TArtifact>,
  stepId: string,
  status: ExecutionStepStatus,
): ExecutionGraph<TEvidence, TScript, TArtifact> => {
  const current = graph.steps.find((step) => step.id === stepId);
  if (!current || current.status === status) return graph;
  return materializeExecutionGraph({
    ...graph,
    graphVersion: graph.graphVersion + 1,
    steps: graph.steps.map((step) => step.id === stepId ? { ...step, status } : step),
  });
};

export const refineExecutionGraph = <
  TEvidence = string,
  TScript = string,
  TArtifact = string,
>(input: {
  readonly graph: ExecutionGraph<TEvidence, TScript, TArtifact>;
  readonly replaceStepId: string;
  readonly replacementSteps: ReadonlyArray<
    Omit<ExecutionStep<TEvidence, TScript, TArtifact>, "status" | "dependsOn" | "expectedEvidence" | "expectedScripts" | "expectedArtifacts" | "contract">
    & {
      readonly status?: ExecutionStepStatus;
      readonly dependsOn?: ReadonlyArray<string>;
      readonly expectedEvidence?: ReadonlyArray<TEvidence>;
      readonly expectedScripts?: ReadonlyArray<TScript>;
      readonly expectedArtifacts?: ReadonlyArray<TArtifact>;
      readonly contract?: ExecutionStepContract;
    }
  >;
}): ExecutionGraph<TEvidence, TScript, TArtifact> => {
  const replaceIndex = input.graph.steps.findIndex((step) => step.id === input.replaceStepId);
  if (replaceIndex < 0) {
    throw new Error(`execution graph cannot refine missing step ${input.replaceStepId}`);
  }
  if (input.graph.steps.some((step) => step.dependsOn.includes(input.replaceStepId))) {
    throw new Error(`execution graph can only refine leaf step ${input.replaceStepId}`);
  }
  if (input.replacementSteps.length === 0) {
    throw new Error(`execution graph refinement for ${input.replaceStepId} requires a bounded subgraph`);
  }
  const replaced = input.graph.steps[replaceIndex]!;
  const replacementSteps = input.replacementSteps.map((step) => normalizeStep(step));
  const replacementIds = new Set(replacementSteps.map((step) => step.id));
  if (replacementIds.has(input.replaceStepId)) {
    throw new Error(`execution graph refinement for ${input.replaceStepId} must replace the leaf with new step ids`);
  }
  for (const step of replacementSteps) {
    if (step.dependsOn.includes(input.replaceStepId)) {
      throw new Error(`execution graph refinement for ${input.replaceStepId} cannot depend on the replaced leaf`);
    }
    if (input.graph.steps.some((current) => current.id !== input.replaceStepId && current.id === step.id)) {
      throw new Error(`execution graph refinement introduces duplicate step id ${step.id}`);
    }
  }
  const replacementRoots = replacementSteps.filter((step) =>
    step.dependsOn.every((dependencyId) => !replacementIds.has(dependencyId)));
  const replacementLeaves = replacementSteps.filter((step) =>
    !replacementSteps.some((candidate) => candidate.dependsOn.includes(step.id)));
  if (!sameStringSet(
    replacementRoots.flatMap((step) => step.contract.inputs),
    replaced.contract.inputs,
  )) {
    throw new Error(`execution graph refinement for ${input.replaceStepId} changed the input contract`);
  }
  if (!sameStringSet(
    replacementLeaves.flatMap((step) => step.contract.outputs),
    replaced.contract.outputs,
  )) {
    throw new Error(`execution graph refinement for ${input.replaceStepId} changed the output contract`);
  }
  return createExecutionGraph({
    graphId: input.graph.graphId,
    graphVersion: input.graph.graphVersion + 1,
    taskRef: input.graph.taskRef,
    allowsParallelRunnableLeaves: input.graph.allowsParallelRunnableLeaves,
    steps: [
      ...input.graph.steps.slice(0, replaceIndex),
      ...replacementSteps,
      ...input.graph.steps.slice(replaceIndex + 1),
    ],
  });
};

export const createEvidenceState = <
  TEvidence = Record<string, unknown>,
  TScript = Record<string, unknown>,
  TArtifact = Record<string, unknown>,
>(input: {
  readonly graph: ExecutionGraph<TEvidence, TScript, TArtifact>;
  readonly semanticStatus?: EvidenceSemanticStatus;
  readonly updatedAt?: number;
}): EvidenceState<TEvidence, TScript, TArtifact> => ({
  graph: input.graph,
  deltas: [],
  evidenceRecords: [],
  scriptsRun: [],
  artifacts: [],
  observations: [],
  semanticStatus: input.semanticStatus ?? "empty",
  updatedAt: input.updatedAt ?? Date.now(),
});

export const mergeEvidenceDelta = <
  TEvidence = Record<string, unknown>,
  TScript = Record<string, unknown>,
  TArtifact = Record<string, unknown>,
>(
  left: EvidenceDelta<TEvidence, TScript, TArtifact>,
  right: EvidenceDelta<TEvidence, TScript, TArtifact>,
): EvidenceDelta<TEvidence, TScript, TArtifact> => {
  if (left.stepId !== right.stepId) {
    throw new Error(`cannot merge evidence deltas for different steps: ${left.stepId} and ${right.stepId}`);
  }
  return {
    stepId: left.stepId,
    evidenceRecords: dedupeItems([...left.evidenceRecords, ...right.evidenceRecords]),
    scriptsRun: dedupeItems([...left.scriptsRun, ...right.scriptsRun]),
    artifacts: dedupeItems([...left.artifacts, ...right.artifacts]),
    observations: uniqueStrings([...left.observations, ...right.observations]),
    summary: right.summary?.trim() || left.summary?.trim(),
    updatedAt: Math.max(left.updatedAt, right.updatedAt),
  };
};

const materializeEvidenceCollections = <
  TEvidence,
  TScript,
  TArtifact,
>(
  deltas: ReadonlyArray<EvidenceDelta<TEvidence, TScript, TArtifact>>,
): {
  readonly deltas: ReadonlyArray<EvidenceDelta<TEvidence, TScript, TArtifact>>;
  readonly evidenceRecords: ReadonlyArray<TEvidence>;
  readonly scriptsRun: ReadonlyArray<TScript>;
  readonly artifacts: ReadonlyArray<TArtifact>;
  readonly observations: ReadonlyArray<string>;
} => {
  const orderedDeltas = [...deltas].sort((left, right) => left.stepId.localeCompare(right.stepId));
  return {
    deltas: orderedDeltas,
    evidenceRecords: orderedDeltas.reduce<ReadonlyArray<TEvidence>>(
      (current, delta) => dedupeItems([...current, ...delta.evidenceRecords]),
      [],
    ),
    scriptsRun: orderedDeltas.reduce<ReadonlyArray<TScript>>(
      (current, delta) => dedupeItems([...current, ...delta.scriptsRun]),
      [],
    ),
    artifacts: orderedDeltas.reduce<ReadonlyArray<TArtifact>>(
      (current, delta) => dedupeItems([...current, ...delta.artifacts]),
      [],
    ),
    observations: orderedDeltas.reduce<ReadonlyArray<string>>(
      (current, delta) => uniqueStrings([...current, ...delta.observations]),
      [],
    ),
  };
};

export const foldEvidenceDelta = <
  TEvidence = Record<string, unknown>,
  TScript = Record<string, unknown>,
  TArtifact = Record<string, unknown>,
>(
  state: EvidenceState<TEvidence, TScript, TArtifact>,
  delta: EvidenceDelta<TEvidence, TScript, TArtifact>,
  semanticStatus?: EvidenceSemanticStatus,
): EvidenceState<TEvidence, TScript, TArtifact> => {
  if (!state.graph.steps.some((step) => step.id === delta.stepId)) {
    throw new Error(`evidence delta references unknown step ${delta.stepId}`);
  }
  const deltaByStep = new Map(state.deltas.map((item) => [item.stepId, item] as const));
  const existing = deltaByStep.get(delta.stepId);
  deltaByStep.set(
    delta.stepId,
    existing ? mergeEvidenceDelta(existing, delta) : {
      ...delta,
      evidenceRecords: dedupeItems(delta.evidenceRecords),
      scriptsRun: dedupeItems(delta.scriptsRun),
      artifacts: dedupeItems(delta.artifacts),
      observations: uniqueStrings(delta.observations),
      summary: delta.summary?.trim(),
    },
  );
  const materialized = materializeEvidenceCollections([...deltaByStep.values()]);
  const mergedDelta = deltaByStep.get(delta.stepId)!;
  const currentStep = state.graph.steps.find((step) => step.id === delta.stepId);
  const hasRecordedSignal =
    mergedDelta.evidenceRecords.length > 0
    || mergedDelta.scriptsRun.length > 0
    || mergedDelta.artifacts.length > 0
    || mergedDelta.observations.length > 0
    || Boolean(mergedDelta.summary);
  const nextSemanticStatus = semanticStatus ?? (
    materialized.evidenceRecords.length > 0
    || materialized.scriptsRun.length > 0
    || materialized.artifacts.length > 0
    || materialized.observations.length > 0
      ? "partial"
      : "empty"
  );
  const nextStepStatus: ExecutionStepStatus =
    semanticStatus === "final"
      ? "completed"
      : currentStep?.status === "completed"
        ? "completed"
        : hasRecordedSignal
          ? "running"
          : currentStep?.status ?? "pending";
  const deltaUnchanged = existing
    ? stableStringify(existing) === stableStringify(mergedDelta)
    : false;
  if (
    deltaUnchanged
    && nextSemanticStatus === state.semanticStatus
    && nextStepStatus === currentStep?.status
  ) {
    return state;
  }
  return {
    graph: updateExecutionStepStatus(
      state.graph,
      delta.stepId,
      nextStepStatus,
    ),
    deltas: materialized.deltas,
    evidenceRecords: materialized.evidenceRecords,
    scriptsRun: materialized.scriptsRun,
    artifacts: materialized.artifacts,
    observations: materialized.observations,
    semanticStatus: nextSemanticStatus,
    updatedAt: Math.max(state.updatedAt, delta.updatedAt),
  };
};

export const finalizeEvidenceState = <
  TEvidence = Record<string, unknown>,
  TScript = Record<string, unknown>,
  TArtifact = Record<string, unknown>,
>(
  state: EvidenceState<TEvidence, TScript, TArtifact>,
  stepId: string,
  summary?: string,
): EvidenceState<TEvidence, TScript, TArtifact> => {
  const currentDelta = state.deltas.find((item) => item.stepId === stepId);
  const nextState = currentDelta
    ? foldEvidenceDelta(
      state,
      {
        ...currentDelta,
        ...(summary?.trim() ? { summary: summary.trim() } : {}),
        updatedAt: Date.now(),
      },
      "final",
    )
    : state;
  const dependencyClosure = new Set<string>();
  const visit = (currentStepId: string): void => {
    if (dependencyClosure.has(currentStepId)) return;
    dependencyClosure.add(currentStepId);
    const currentStep = nextState.graph.steps.find((step) => step.id === currentStepId);
    for (const dependencyId of currentStep?.dependsOn ?? []) {
      visit(dependencyId);
    }
  };
  visit(stepId);
  let graph = nextState.graph;
  for (const completedStepId of dependencyClosure) {
    graph = updateExecutionStepStatus(graph, completedStepId, "completed");
  }
  return {
    ...nextState,
    graph,
    semanticStatus: "final",
    updatedAt: Date.now(),
  };
};
