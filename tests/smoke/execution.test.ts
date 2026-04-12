import { expect, test } from "bun:test";

import {
  createEvidenceState,
  createSingleStepExecutionGraph,
  foldEvidenceDelta,
  mergeEvidenceDelta,
  refineExecutionGraph,
} from "@receipt/core/execution";

test("execution algebra: replaying the same delta is idempotent", () => {
  const graph = createSingleStepExecutionGraph({
    graphId: "graph_idempotent",
    taskRef: { kind: "state", ref: "factory/objectives/objective_1", label: "objective_1" },
    stepId: "collect",
    kind: "collect",
    goal: "Collect proof.",
    scopeKey: "objective_1:collect",
    completionSignal: "Evidence recorded.",
    expectedEvidence: ["collected_evidence"],
    contract: {
      inputs: ["factory/objectives/objective_1"],
      outputs: ["collected_evidence"],
    },
  });
  const initial = createEvidenceState({
    graph,
    semanticStatus: "empty",
    updatedAt: 1,
  });
  const delta = {
    stepId: "collect",
    evidenceRecords: [{ id: "evidence_1", status: "ok" }],
    scriptsRun: [{ command: "collect.sh", status: "ok" }],
    artifacts: [{ label: "collect.log" }],
    observations: ["Collected primary evidence."],
    summary: "Collected proof.",
    updatedAt: 2,
  } as const;

  const once = foldEvidenceDelta(initial, delta, "partial");
  const twice = foldEvidenceDelta(once, delta, "partial");

  expect(twice).toEqual(once);
  expect(twice.evidenceRecords).toHaveLength(1);
  expect(twice.scriptsRun).toHaveLength(1);
  expect(twice.artifacts).toHaveLength(1);
});

test("execution algebra: delta merge is associative", () => {
  const left = {
    stepId: "validate",
    evidenceRecords: [{ id: "evidence_a" }],
    scriptsRun: [{ command: "validate-a" }],
    artifacts: [{ label: "validate-a.log" }],
    observations: ["validated a"],
    summary: "left",
    updatedAt: 1,
  } as const;
  const middle = {
    stepId: "validate",
    evidenceRecords: [{ id: "evidence_b" }],
    scriptsRun: [{ command: "validate-b" }],
    artifacts: [{ label: "validate-b.log" }],
    observations: ["validated b"],
    summary: "middle",
    updatedAt: 2,
  } as const;
  const right = {
    stepId: "validate",
    evidenceRecords: [{ id: "evidence_a" }, { id: "evidence_c" }],
    scriptsRun: [{ command: "validate-c" }],
    artifacts: [{ label: "validate-c.log" }],
    observations: ["validated c"],
    summary: "right",
    updatedAt: 3,
  } as const;

  const mergedLeft = mergeEvidenceDelta(mergeEvidenceDelta(left, middle), right);
  const mergedRight = mergeEvidenceDelta(left, mergeEvidenceDelta(middle, right));

  expect(mergedLeft).toEqual(mergedRight);
  expect(mergedLeft.evidenceRecords).toHaveLength(3);
  expect(mergedLeft.summary).toBe("right");
});

test("execution algebra: refinement preserves the leaf contract", () => {
  const graph = createSingleStepExecutionGraph({
    graphId: "graph_refine",
    taskRef: { kind: "state", ref: "factory/objectives/objective_2", label: "objective_2" },
    stepId: "solve_task",
    kind: "collect",
    goal: "Solve the objective.",
    scopeKey: "objective_2:solve",
    completionSignal: "Final result emitted.",
    expectedEvidence: ["final_result"],
    contract: {
      inputs: ["factory/objectives/objective_2"],
      outputs: ["final_result"],
    },
  });

  const refined = refineExecutionGraph({
    graph,
    replaceStepId: "solve_task",
    replacementSteps: [
      {
        id: "collect_primary_evidence",
        kind: "collect",
        goal: "Collect the primary evidence.",
        scopeKey: "objective_2:collect",
        dependsOn: [],
        inputs: [graph.taskRef],
        completionSignal: "Primary evidence captured.",
        expectedEvidence: ["primary_evidence"],
        contract: {
          inputs: ["factory/objectives/objective_2"],
          outputs: ["primary_evidence"],
        },
      },
      {
        id: "synthesize_result",
        kind: "synthesize",
        goal: "Synthesize the final result.",
        scopeKey: "objective_2:synthesize",
        dependsOn: ["collect_primary_evidence"],
        inputs: [graph.taskRef],
        completionSignal: "Final result emitted.",
        expectedEvidence: ["final_result"],
        contract: {
          inputs: ["primary_evidence"],
          outputs: ["final_result"],
        },
      },
    ],
  });

  expect(refined.graphVersion).toBeGreaterThan(graph.graphVersion);
  expect(refined.steps.map((step) => step.id)).toEqual([
    "collect_primary_evidence",
    "synthesize_result",
  ]);
  expect(refined.pendingStepIds).toContain("synthesize_result");
});
