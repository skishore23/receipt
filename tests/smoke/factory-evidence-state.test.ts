import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  checkpointFactoryExecutionEvidenceState,
  createFactoryExecutionEvidenceState,
  factoryExecutionEvidenceStatePath,
  finalizeFactoryExecutionEvidenceState,
  readFactoryExecutionEvidenceState,
  refineFactoryExecutionEvidenceStateForHardness,
  writeFactoryExecutionEvidenceState,
} from "../../src/services/factory/runtime/evidence-state";

test("factory evidence state: checkpoints, refines, and finalizes deterministically", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-factory-evidence-state-"));
  try {
    const resultPath = path.join(dir, "task_01.result.json");
    const statePath = factoryExecutionEvidenceStatePath(resultPath);
    const initial = createFactoryExecutionEvidenceState({
      objectiveId: "objective_1",
      taskId: "task_1",
      candidateId: "candidate_1",
      goal: "Investigate the current posture.",
    });
    const refined = refineFactoryExecutionEvidenceStateForHardness(
      initial,
      "Runtime observed repeated command churn.",
    );
    const checkpointed = checkpointFactoryExecutionEvidenceState({
      current: refined,
      stepId: "collect_primary_evidence",
      evidenceRecords: [{
        objective_id: "objective_1",
        task_id: "task_1",
        timestamp: 123,
        tool_name: "aws_cli_command",
        command_or_api: "aws ec2 describe-security-groups",
        inputs: { region: "us-east-1" },
        outputs: { status: "ok" },
        summary_metrics: { offendingRules: 1 },
      }],
      scriptsRun: [{
        command: "aws ec2 describe-security-groups --group-ids sg-123",
        summary: "captured SG evidence",
        status: "ok",
      }],
      artifacts: [{
        label: "sg.json",
        path: "/tmp/sg.json",
        summary: "structured SG evidence",
      }],
      observations: ["Primary evidence captured."],
      summary: "Captured the primary evidence path.",
    });
    const finalized = finalizeFactoryExecutionEvidenceState({
      current: checkpointed,
      stepId: "synthesize_result",
      summary: "Finalized from checkpointed evidence.",
    });

    await writeFactoryExecutionEvidenceState(statePath, finalized);
    const reloaded = await readFactoryExecutionEvidenceState(statePath);

    expect(reloaded.graph.steps.length).toBe(3);
    expect(reloaded.semantic_status).toBe("final");
    expect(reloaded.evidence_records).toHaveLength(1);
    expect(reloaded.scripts_run).toHaveLength(1);
    expect(reloaded.artifacts).toHaveLength(1);
    expect(reloaded.observations).toContain("Primary evidence captured.");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
