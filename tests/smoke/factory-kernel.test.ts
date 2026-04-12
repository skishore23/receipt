import { expect, test } from "bun:test";

import { createExecutionGraph } from "@receipt/core/execution";

import {
  buildFactoryEffectView,
  buildFactoryInitialExecutionGraph,
  createFactoryObjectiveState,
  decideFactoryObjective,
  deriveFactoryObjectivePhase,
  reduceFactoryObjective,
  type FactoryObjectiveEvent,
  type FactoryTaskSpec,
} from "../../src/modules/factory";

const profileSnapshot = {
  rootProfileId: "generalist",
  rootProfileLabel: "Generalist",
  resolvedProfileHash: "profile_hash",
  promptHash: "prompt_hash",
  promptPath: "profiles/generalist/PROFILE.md",
  selectedSkills: [],
  objectivePolicy: {
    allowedWorkerTypes: ["codex"],
    defaultWorkerType: "codex",
    defaultTaskExecutionMode: "worktree",
    defaultValidationMode: "repo_profile",
    defaultObjectiveMode: "delivery",
    defaultSeverity: 1 as const,
    maxParallelChildren: 1,
    allowObjectiveCreation: true,
  },
  actionPolicy: {
    allowedDispatchActions: ["create", "react", "promote", "cancel", "cleanup", "archive"],
    allowedCreateModes: ["delivery", "investigation"],
  },
} as const;

const buildTaskSpec = (
  effectPolicy: FactoryTaskSpec["effectPolicy"],
): FactoryTaskSpec => ({
  goal: "Refactor Factory to the canonical kernel.",
  constraints: ["Keep capabilities intact.", "Use one authoritative fold target."],
  acceptanceCriteria: ["Kernel owns the canonical state.", "Effect surfaces stay derivable."],
  proofPolicy: {
    summary: "Require evidence-backed completion.",
    requirements: ["Evidence delta replay is deterministic."],
  },
  effectPolicy,
  profileId: "generalist",
  profileSnapshot,
  operatorGuidance: ["Remove parallel Factory state machines."],
});

test("factory kernel: initial graph follows the effect policy", () => {
  const evidenceOnly = buildFactoryInitialExecutionGraph("objective_evidence", buildTaskSpec({
    mutate: false,
    validate: false,
    integrate: false,
    publish: false,
  }));
  const codeChange = buildFactoryInitialExecutionGraph("objective_code", buildTaskSpec({
    mutate: true,
    validate: true,
    integrate: true,
    publish: false,
  }));
  const publish = buildFactoryInitialExecutionGraph("objective_publish", buildTaskSpec({
    mutate: true,
    validate: true,
    integrate: true,
    publish: true,
  }));

  expect(evidenceOnly.steps.map((step) => step.kind)).toEqual([
    "collect",
    "analyze",
    "synthesize",
  ]);
  expect(codeChange.steps.map((step) => step.kind)).toEqual([
    "collect",
    "analyze",
    "mutate",
    "validate",
    "integrate",
    "synthesize",
  ]);
  expect(publish.steps.map((step) => step.kind)).toEqual([
    "collect",
    "analyze",
    "mutate",
    "validate",
    "integrate",
    "publish",
    "synthesize",
  ]);
});

test("factory kernel: only canonical events fold into the objective state", () => {
  const taskSpec = buildTaskSpec({
    mutate: true,
    validate: true,
    integrate: true,
    publish: false,
  });
  const created = createFactoryObjectiveState({
    objectiveId: "objective_kernel",
    taskSpec,
    createdAt: 10,
  });
  const events = decideFactoryObjective({
    events: [
      {
        type: "objective.guidance.added",
        objectiveId: created.objectiveId,
        guidance: {
          source: "monitor",
          message: "Refine one leaf at a time.",
          addedAt: 11,
        },
      },
      {
        type: "evidence.delta.recorded",
        objectiveId: created.objectiveId,
        delta: {
          stepId: "collect",
          evidenceRecords: [{
            objective_id: created.objectiveId,
            task_id: "collect",
            timestamp: 12,
            tool_name: "factory_runtime",
            command_or_api: "collect",
            inputs: {},
            outputs: { status: "ok" },
            summary_metrics: {},
          }],
          scriptsRun: [],
          artifacts: [],
          observations: ["Collected the canonical inputs."],
          summary: "Collected inputs.",
          updatedAt: 12,
        },
        semanticStatus: "partial",
        recordedAt: 12,
      },
      {
        type: "objective.finalized",
        objectiveId: created.objectiveId,
        finalization: {
          status: "completed",
          summary: "Canonical kernel finalized.",
          result: { ok: true },
          effectSummary: {
            validate: "Validation grouped through effect view.",
          },
          finalizedAt: 13,
        },
      },
    ] satisfies ReadonlyArray<FactoryObjectiveEvent>,
  });
  const finalState = events.reduce(
    (current, event) => reduceFactoryObjective(current, event, event.type === "objective.finalized" ? event.finalization.finalizedAt : 0),
    created,
  );

  expect(finalState.taskSpec.operatorGuidance).toContain("Refine one leaf at a time.");
  expect(finalState.finalization?.status).toBe("completed");
  expect(deriveFactoryObjectivePhase(finalState)).toBe("finalized");
  expect("workflow" in (finalState as Record<string, unknown>)).toBe(false);
  expect("candidates" in (finalState as Record<string, unknown>)).toBe(false);
  expect("integration" in (finalState as Record<string, unknown>)).toBe(false);
  expect("scheduler" in (finalState as Record<string, unknown>)).toBe(false);
});

test("factory kernel: effect view groups validate, integrate, and publish outputs", () => {
  const created = createFactoryObjectiveState({
    objectiveId: "objective_effects",
    taskSpec: buildTaskSpec({
      mutate: true,
      validate: true,
      integrate: true,
      publish: true,
    }),
    createdAt: 1,
  });
  const graphReadyForValidate = createExecutionGraph({
    graphId: created.evidenceState.graph.graphId,
    graphVersion: created.evidenceState.graph.graphVersion + 1,
    taskRef: created.evidenceState.graph.taskRef,
    steps: created.evidenceState.graph.steps.map((step) => ({
      ...step,
      status:
        step.id === "collect" || step.id === "analyze" || step.id === "mutate"
          ? "completed"
          : step.id === "validate"
            ? "pending"
            : "pending",
    })),
  });
  const withRunnableValidate = reduceFactoryObjective(created, {
    type: "graph.set",
    objectiveId: created.objectiveId,
    graph: graphReadyForValidate,
    setAt: 2,
  }, 2);
  const withEffects = reduceFactoryObjective(withRunnableValidate, {
    type: "evidence.delta.recorded",
    objectiveId: created.objectiveId,
    delta: {
      stepId: "validate",
      evidenceRecords: [],
      scriptsRun: [{ command: "bun test", summary: "tests passed", status: "ok" }],
      artifacts: [{
        label: "validate.log",
        effectKind: "validate",
        stepId: "validate",
        summary: "Validation passed.",
      }],
      observations: ["Validation completed."],
      summary: "Validation passed.",
      updatedAt: 3,
    },
    semanticStatus: "partial",
    recordedAt: 3,
  }, 3);
  const finalized = reduceFactoryObjective(withEffects, {
    type: "objective.finalized",
    objectiveId: created.objectiveId,
    finalization: {
      status: "completed",
      summary: "Published the canonical result.",
      result: { ok: true },
      effectSummary: {
        integrate: "Integrated cleanly.",
        publish: "Published cleanly.",
      },
      finalizedAt: 4,
    },
  }, 4);

  const view = buildFactoryEffectView(finalized);

  expect(view.validate[0]?.summary).toBe("Validation passed.");
  expect(view.validate[0]?.artifacts).toHaveLength(1);
  expect(view.integrate[0]?.summary).toBe("Integrated cleanly.");
  expect(view.publish[0]?.summary).toBe("Published cleanly.");
});
