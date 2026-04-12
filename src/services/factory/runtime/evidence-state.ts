import fs from "node:fs/promises";
import path from "node:path";

import {
  createSingleStepExecutionGraph,
  finalizeEvidenceState as finalizeGenericEvidenceState,
  foldEvidenceDelta,
  refineExecutionGraph,
  type EvidenceSemanticStatus,
  type EvidenceState,
  type ExecutionGraph,
} from "@receipt/core/execution";

import type {
  FactoryEvidenceRecord,
  FactoryExecutionScriptRun,
} from "../../../modules/factory";
import type { FactoryEvidenceArtifact } from "../../factory-evidence-bundle";

export type FactoryExecutionEvidenceDelta = {
  readonly stepId: string;
  readonly evidence_records: ReadonlyArray<FactoryEvidenceRecord>;
  readonly scripts_run: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly artifacts: ReadonlyArray<FactoryEvidenceArtifact>;
  readonly observations: ReadonlyArray<string>;
  readonly summary?: string;
  readonly updated_at: number;
};

export type FactoryExecutionEvidenceState = {
  readonly objective_id: string;
  readonly task_id: string;
  readonly candidate_id: string;
  readonly graph: ExecutionGraph;
  readonly deltas: ReadonlyArray<FactoryExecutionEvidenceDelta>;
  readonly evidence_records: ReadonlyArray<FactoryEvidenceRecord>;
  readonly scripts_run: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly artifacts: ReadonlyArray<FactoryEvidenceArtifact>;
  readonly observations: ReadonlyArray<string>;
  readonly semantic_status: EvidenceSemanticStatus;
  readonly timestamps: {
    readonly created_at: number;
    readonly updated_at: number;
  };
};

const dedupeBy = <T>(
  items: ReadonlyArray<T>,
  keyOf: (value: T) => string,
): ReadonlyArray<T> => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

const evidenceRecordKey = (record: FactoryEvidenceRecord): string =>
  `${record.tool_name}::${record.command_or_api}::${record.timestamp}`;

const scriptRunKey = (script: FactoryExecutionScriptRun): string =>
  `${script.command}::${script.summary ?? ""}::${script.status ?? ""}`;

const artifactKey = (artifact: FactoryEvidenceArtifact): string =>
  `${artifact.label}::${artifact.path ?? ""}::${artifact.summary ?? ""}`;

const asRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`factory evidence state invalid ${label}`);
  }
  return value.trim();
};

const requireNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`factory evidence state invalid ${label}`);
  }
  return value;
};

const asEvidenceRecord = (value: unknown): FactoryEvidenceRecord => {
  if (!asRecord(value)) throw new Error("factory evidence state invalid evidence_records entry");
  return {
    objective_id: requireString(value.objective_id, "evidence_records.objective_id"),
    task_id: requireString(value.task_id, "evidence_records.task_id"),
    timestamp: requireNumber(value.timestamp, "evidence_records.timestamp"),
    tool_name: requireString(value.tool_name, "evidence_records.tool_name"),
    command_or_api: requireString(value.command_or_api, "evidence_records.command_or_api"),
    inputs: asRecord(value.inputs) ? value.inputs : {},
    outputs: asRecord(value.outputs) ? value.outputs : {},
    summary_metrics: asRecord(value.summary_metrics) ? value.summary_metrics as Record<string, number | string | boolean | null> : {},
  };
};

const asScriptRun = (value: unknown): FactoryExecutionScriptRun => {
  if (!asRecord(value)) throw new Error("factory evidence state invalid scripts_run entry");
  return {
    command: requireString(value.command, "scripts_run.command"),
    ...(typeof value.summary === "string" && value.summary.trim().length > 0 ? { summary: value.summary.trim() } : {}),
    ...(value.status === "ok" || value.status === "warning" || value.status === "error" ? { status: value.status } : {}),
  };
};

const asArtifact = (value: unknown): FactoryEvidenceArtifact => {
  if (!asRecord(value)) throw new Error("factory evidence state invalid artifacts entry");
  const label = requireString(value.label, "artifacts.label");
  const artifactPath = value.path === null ? null : requireString(value.path, "artifacts.path");
  const summary = value.summary === null
    ? null
    : typeof value.summary === "string"
      ? value.summary
      : (() => { throw new Error("factory evidence state invalid artifacts.summary"); })();
  return { label, path: artifactPath, summary };
};

const asExecutionGraph = (value: unknown): ExecutionGraph => {
  if (!asRecord(value)) throw new Error("factory evidence state invalid graph");
  const taskRef = asRecord(value.taskRef) ? value.taskRef : undefined;
  if (!taskRef || typeof taskRef.kind !== "string" || typeof taskRef.ref !== "string") {
    throw new Error("factory evidence state invalid graph.taskRef");
  }
  if (!Array.isArray(value.steps)) throw new Error("factory evidence state invalid graph.steps");
  return {
    graphId: requireString(value.graphId, "graph.graphId"),
    graphVersion: requireNumber(value.graphVersion, "graph.graphVersion"),
    taskRef: {
      kind: taskRef.kind,
      ref: taskRef.ref,
      ...(typeof taskRef.label === "string" ? { label: taskRef.label } : {}),
    },
    activeFrontier: Array.isArray(value.activeFrontier) ? value.activeFrontier.map((item) => requireString(item, "graph.activeFrontier")) : [],
    completedStepIds: Array.isArray(value.completedStepIds) ? value.completedStepIds.map((item) => requireString(item, "graph.completedStepIds")) : [],
    pendingStepIds: Array.isArray(value.pendingStepIds) ? value.pendingStepIds.map((item) => requireString(item, "graph.pendingStepIds")) : [],
    failedStepIds: Array.isArray(value.failedStepIds) ? value.failedStepIds.map((item) => requireString(item, "graph.failedStepIds")) : [],
    steps: value.steps.map((step) => {
      if (!asRecord(step)) throw new Error("factory evidence state invalid graph.steps entry");
      if (
        step.kind !== "collect"
        && step.kind !== "analyze"
        && step.kind !== "mutate"
        && step.kind !== "synthesize"
        && step.kind !== "validate"
        && step.kind !== "integrate"
        && step.kind !== "publish"
      ) throw new Error("factory evidence state invalid graph.steps.kind");
      if (
        step.status !== "pending"
        && step.status !== "running"
        && step.status !== "completed"
        && step.status !== "failed"
        && step.status !== "canceled"
      ) throw new Error("factory evidence state invalid graph.steps.status");
      return {
        id: requireString(step.id, "graph.steps.id"),
        kind: step.kind,
        goal: requireString(step.goal, "graph.steps.goal"),
        scopeKey: requireString(step.scopeKey, "graph.steps.scopeKey"),
        inputs: Array.isArray(step.inputs)
          ? step.inputs.flatMap((item) =>
            asRecord(item) && typeof item.kind === "string" && typeof item.ref === "string"
      ? [{
                  kind: item.kind,
                  ref: item.ref,
                  ...(typeof item.label === "string" ? { label: item.label } : {}),
                }]
              : [])
          : [],
        dependsOn: Array.isArray(step.dependsOn)
          ? step.dependsOn.map((item) => requireString(item, "graph.steps.dependsOn"))
          : [],
        completionSignal: requireString(step.completionSignal, "graph.steps.completionSignal"),
        expectedEvidence: Array.isArray(step.expectedEvidence)
          ? step.expectedEvidence.map((item) => requireString(item, "graph.steps.expectedEvidence"))
          : [],
        expectedScripts: Array.isArray(step.expectedScripts)
          ? step.expectedScripts.map((item) => requireString(item, "graph.steps.expectedScripts"))
          : [],
        expectedArtifacts: Array.isArray(step.expectedArtifacts)
          ? step.expectedArtifacts.map((item) => requireString(item, "graph.steps.expectedArtifacts"))
          : [],
        contract: asRecord(step.contract)
          ? {
              inputs: Array.isArray(step.contract.inputs)
                ? step.contract.inputs.map((item) => requireString(item, "graph.steps.contract.inputs"))
                : [],
              outputs: Array.isArray(step.contract.outputs)
                ? step.contract.outputs.map((item) => requireString(item, "graph.steps.contract.outputs"))
                : [],
            }
          : {
              inputs: [],
              outputs: [],
            },
        status: step.status,
      };
    }),
    ...(typeof value.allowsParallelRunnableLeaves === "boolean"
      ? { allowsParallelRunnableLeaves: value.allowsParallelRunnableLeaves }
      : {}),
  };
};

const genericEvidenceStateFromFactory = (
  state: FactoryExecutionEvidenceState,
): EvidenceState => ({
  graph: state.graph,
  deltas: state.deltas.map((delta) => ({
    stepId: delta.stepId,
    evidenceRecords: delta.evidence_records as ReadonlyArray<Record<string, unknown>>,
    scriptsRun: delta.scripts_run as ReadonlyArray<Record<string, unknown>>,
    artifacts: delta.artifacts as ReadonlyArray<Record<string, unknown>>,
    observations: delta.observations,
    ...(delta.summary ? { summary: delta.summary } : {}),
    updatedAt: delta.updated_at,
  })),
  evidenceRecords: state.evidence_records as ReadonlyArray<Record<string, unknown>>,
  scriptsRun: state.scripts_run as ReadonlyArray<Record<string, unknown>>,
  artifacts: state.artifacts as ReadonlyArray<Record<string, unknown>>,
  observations: state.observations,
  semanticStatus: state.semantic_status,
  updatedAt: state.timestamps.updated_at,
});

const factoryEvidenceStateFromGeneric = (
  template: FactoryExecutionEvidenceState,
  generic: EvidenceState,
): FactoryExecutionEvidenceState => {
  const deltas = dedupeBy(
    generic.deltas.map((delta) => ({
      stepId: delta.stepId,
      evidence_records: dedupeBy(
        delta.evidenceRecords.map(asEvidenceRecord),
        evidenceRecordKey,
      ),
      scripts_run: dedupeBy(
        delta.scriptsRun.map(asScriptRun),
        scriptRunKey,
      ),
      artifacts: dedupeBy(
        delta.artifacts.map(asArtifact),
        artifactKey,
      ),
      observations: [...new Set(delta.observations)],
      ...(delta.summary ? { summary: delta.summary } : {}),
      updated_at: delta.updatedAt,
    })),
    (delta) => delta.stepId,
  );
  return {
    ...template,
    graph: generic.graph,
    deltas,
    evidence_records: dedupeBy(generic.evidenceRecords.map(asEvidenceRecord), evidenceRecordKey),
    scripts_run: dedupeBy(generic.scriptsRun.map(asScriptRun), scriptRunKey),
    artifacts: dedupeBy(generic.artifacts.map(asArtifact), artifactKey),
    observations: [...new Set(generic.observations)],
    semantic_status: generic.semanticStatus,
    timestamps: {
      created_at: template.timestamps.created_at,
      updated_at: generic.updatedAt,
    },
  };
};

export const factoryExecutionEvidenceStatePath = (resultPath: string): string =>
  resultPath.replace(/\.result\.json$/i, ".evidence-state.json");

export const createFactoryExecutionEvidenceState = (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly goal: string;
  readonly scopeKey?: string;
  readonly createdAt?: number;
}): FactoryExecutionEvidenceState => {
  const createdAt = input.createdAt ?? Date.now();
  return {
    objective_id: input.objectiveId,
    task_id: input.taskId,
    candidate_id: input.candidateId,
    graph: createSingleStepExecutionGraph({
      graphId: `${input.objectiveId}:${input.taskId}`,
      taskRef: {
        kind: "state",
        ref: `factory/objectives/${input.objectiveId}/steps/${input.taskId}`,
        label: input.taskId,
      },
      stepId: "solve_task",
      kind: "collect",
      goal: input.goal,
      scopeKey: input.scopeKey ?? input.taskId,
      inputs: [{
        kind: "state",
        ref: `factory/objectives/${input.objectiveId}/steps/${input.taskId}`,
        label: input.taskId,
      }],
      completionSignal: "Emit final structured result JSON.",
      expectedEvidence: ["final_result"],
      contract: {
        inputs: [`factory/objectives/${input.objectiveId}/steps/${input.taskId}`],
        outputs: ["final_result"],
      },
    }),
    deltas: [],
    evidence_records: [],
    scripts_run: [],
    artifacts: [],
    observations: [],
    semantic_status: "empty",
    timestamps: {
      created_at: createdAt,
      updated_at: createdAt,
    },
  };
};

export const refineFactoryExecutionEvidenceStateForHardness = (
  state: FactoryExecutionEvidenceState,
  reason: string,
): FactoryExecutionEvidenceState => {
  if (state.graph.steps.length > 1) return state;
  const refinedGraph = refineExecutionGraph({
    graph: state.graph,
    replaceStepId: "solve_task",
    replacementSteps: [
      {
        id: "collect_primary_evidence",
        kind: "collect",
        goal: "Collect the primary evidence path for the task.",
        scopeKey: `${state.task_id}:primary`,
        dependsOn: [],
        inputs: [state.graph.taskRef],
        completionSignal: "Primary evidence exists in canonical artifacts or evidence records.",
        expectedEvidence: ["primary_evidence"],
        contract: {
          inputs: [state.graph.taskRef.ref],
          outputs: ["primary_evidence"],
        },
        status: "running",
      },
      {
        id: "capture_supporting_signal",
        kind: "analyze",
        goal: "Capture the smallest additional signal that could change the conclusion.",
        scopeKey: `${state.task_id}:supporting`,
        dependsOn: ["collect_primary_evidence"],
        inputs: [state.graph.taskRef],
        completionSignal: "Either the supporting signal is captured or explicitly deemed unnecessary.",
        expectedEvidence: ["supporting_evidence"],
        contract: {
          inputs: ["primary_evidence"],
          outputs: ["supporting_evidence"],
        },
        status: "pending",
      },
      {
        id: "synthesize_result",
        kind: "synthesize",
        goal: "Synthesize the final evidence-backed answer.",
        scopeKey: `${state.task_id}:synthesis`,
        dependsOn: ["collect_primary_evidence", "capture_supporting_signal"],
        inputs: [state.graph.taskRef],
        completionSignal: "Final structured result emitted.",
        expectedEvidence: ["final_result"],
        contract: {
          inputs: ["primary_evidence", "supporting_evidence"],
          outputs: ["final_result"],
        },
        status: "pending",
      },
    ],
  });
  return {
    ...state,
    graph: refinedGraph,
    observations: [...new Set([...state.observations, reason])],
    timestamps: {
      ...state.timestamps,
      updated_at: Date.now(),
    },
  };
};

export const checkpointFactoryExecutionEvidenceState = (input: {
  readonly current: FactoryExecutionEvidenceState;
  readonly stepId?: string;
  readonly evidenceRecords: ReadonlyArray<FactoryEvidenceRecord>;
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly artifacts: ReadonlyArray<FactoryEvidenceArtifact>;
  readonly observations?: ReadonlyArray<string>;
  readonly summary?: string;
  readonly semanticStatus?: Exclude<EvidenceSemanticStatus, "final">;
  readonly updatedAt?: number;
}): FactoryExecutionEvidenceState => {
  const stepId = input.stepId
    ?? input.current.graph.activeFrontier[0]
    ?? input.current.graph.pendingStepIds[0]
    ?? input.current.graph.steps[0]?.id
    ?? "solve_task";
  const updatedAt = input.updatedAt ?? Date.now();
  const nextGeneric = foldEvidenceDelta(
    genericEvidenceStateFromFactory(input.current),
    {
      stepId,
      evidenceRecords: input.evidenceRecords as ReadonlyArray<Record<string, unknown>>,
      scriptsRun: input.scriptsRun as ReadonlyArray<Record<string, unknown>>,
      artifacts: input.artifacts as ReadonlyArray<Record<string, unknown>>,
      observations: [...(input.observations ?? [])],
      ...(input.summary ? { summary: input.summary } : {}),
      updatedAt,
    },
    input.semanticStatus,
  );
  return factoryEvidenceStateFromGeneric({
    ...input.current,
    observations: [...new Set([...input.current.observations, ...(input.observations ?? [])])],
    timestamps: {
      ...input.current.timestamps,
      updated_at: updatedAt,
    },
  }, nextGeneric);
};

export const finalizeFactoryExecutionEvidenceState = (input: {
  readonly current: FactoryExecutionEvidenceState;
  readonly stepId?: string;
  readonly summary?: string;
  readonly evidenceRecords?: ReadonlyArray<FactoryEvidenceRecord>;
  readonly scriptsRun?: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly artifacts?: ReadonlyArray<FactoryEvidenceArtifact>;
  readonly observations?: ReadonlyArray<string>;
}): FactoryExecutionEvidenceState => {
  const stepId = input.stepId
    ?? input.current.graph.activeFrontier[0]
    ?? input.current.graph.pendingStepIds[0]
    ?? input.current.graph.steps.at(-1)?.id
    ?? "solve_task";
  const updatedAt = Date.now();
  const checkpointed = foldEvidenceDelta(
    genericEvidenceStateFromFactory(input.current),
    {
      stepId,
      evidenceRecords: (input.evidenceRecords ?? input.current.evidence_records) as ReadonlyArray<Record<string, unknown>>,
      scriptsRun: (input.scriptsRun ?? input.current.scripts_run) as ReadonlyArray<Record<string, unknown>>,
      artifacts: (input.artifacts ?? input.current.artifacts) as ReadonlyArray<Record<string, unknown>>,
      observations: [...(input.observations ?? [])],
      ...(input.summary ? { summary: input.summary } : {}),
      updatedAt,
    },
    "final",
  );
  const finalized = finalizeGenericEvidenceState(
    checkpointed,
    stepId,
    input.summary,
  );
  return factoryEvidenceStateFromGeneric({
    ...input.current,
    observations: [...new Set([...input.current.observations, ...(input.observations ?? [])])],
    timestamps: {
      ...input.current.timestamps,
      updated_at: updatedAt,
    },
  }, finalized);
};

export const writeFactoryExecutionEvidenceState = async (
  statePath: string,
  state: FactoryExecutionEvidenceState,
): Promise<FactoryExecutionEvidenceState> => {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  return state;
};

export const readFactoryExecutionEvidenceState = async (
  statePath: string,
): Promise<FactoryExecutionEvidenceState> => {
  const raw = JSON.parse(await fs.readFile(statePath, "utf-8")) as Record<string, unknown>;
  if (!asRecord(raw.timestamps)) throw new Error("factory evidence state invalid timestamps");
  const timestamps = raw.timestamps;
  const createdAt = requireNumber(timestamps.created_at, "timestamps.created_at");
  const updatedAt = requireNumber(timestamps.updated_at, "timestamps.updated_at");
  const semanticStatus = raw.semantic_status;
  if (
    semanticStatus !== "empty"
    && semanticStatus !== "partial"
    && semanticStatus !== "sufficient"
    && semanticStatus !== "final"
  ) {
    throw new Error("factory evidence state invalid semantic_status");
  }
  const state: FactoryExecutionEvidenceState = {
    objective_id: requireString(raw.objective_id, "objective_id"),
    task_id: requireString(raw.task_id, "task_id"),
    candidate_id: requireString(raw.candidate_id, "candidate_id"),
    graph: asExecutionGraph(raw.graph),
    deltas: Array.isArray(raw.deltas)
      ? raw.deltas.map((delta) => {
        if (!asRecord(delta)) throw new Error("factory evidence state invalid deltas entry");
        return {
          stepId: requireString(delta.stepId, "deltas.stepId"),
          evidence_records: Array.isArray(delta.evidence_records) ? delta.evidence_records.map(asEvidenceRecord) : [],
          scripts_run: Array.isArray(delta.scripts_run) ? delta.scripts_run.map(asScriptRun) : [],
          artifacts: Array.isArray(delta.artifacts) ? delta.artifacts.map(asArtifact) : [],
          observations: Array.isArray(delta.observations) ? delta.observations.map((item) => requireString(item, "deltas.observations")) : [],
          ...(typeof delta.summary === "string" && delta.summary.trim().length > 0 ? { summary: delta.summary.trim() } : {}),
          updated_at: requireNumber(delta.updated_at, "deltas.updated_at"),
        };
      })
      : [],
    evidence_records: Array.isArray(raw.evidence_records) ? raw.evidence_records.map(asEvidenceRecord) : [],
    scripts_run: Array.isArray(raw.scripts_run) ? raw.scripts_run.map(asScriptRun) : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(asArtifact) : [],
    observations: Array.isArray(raw.observations) ? raw.observations.map((item) => requireString(item, "observations")) : [],
    semantic_status: semanticStatus,
    timestamps: {
      created_at: createdAt,
      updated_at: updatedAt,
    },
  };
  return state;
};
