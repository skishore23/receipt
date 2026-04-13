import { expect, test } from "bun:test";

import {
  buildFactoryObjectiveLoadingState,
  summarizeFactoryTaskSignal,
} from "../../src/services/factory/live-status";

test("factory live status: summarizes active EC2 evidence collection for loading states", () => {
  const activeTask = {
    taskId: "task_01",
    status: "running",
    jobStatus: "running",
    elapsedMs: 22_000,
    lastMessage: "Running command: python3 skills/factory-helper-runtime/runner.py run --provider aws --json aws_resource_inventory -- --service ec2 --resource instances --all-regions --profile default",
    stdoutTail: undefined,
    stderrTail: undefined,
    artifactSummary: undefined,
    latestSummary: undefined,
    artifactActivity: [{
      path: "/tmp/aws_resource_inventory_ec2_instances.json",
      label: "EC2 inventory artifact",
      updatedAt: 123,
      bytes: 42,
    }],
  };
  const state = buildFactoryObjectiveLoadingState({
    detail: {
      displayState: "Running",
      status: "executing",
      phase: "collecting_evidence",
      phaseDetail: "collecting_evidence",
      nextAction: "Wait for the EC2 inventory to finish.",
      latestSummary: "Live collection in progress.",
      tasks: [activeTask],
      recentReceipts: [{
        type: "task.dispatched",
        hash: "hash",
        ts: 1,
        summary: "task_01 dispatched as task_01_candidate_01",
      }],
      latestDecision: {
        summary: "Dispatch ready task task_01.",
        at: 1,
        source: "runtime",
      },
    } as never,
    live: {
      activeTasks: [activeTask],
      recentJobs: [{
        id: "job_01",
        status: "running",
        agentId: "codex",
      }],
    } as never,
  });

  expect(state.label).toBe("Collecting evidence");
  expect(state.summary).toBe("Querying EC2 instances across regions.");
  expect(state.detail).toBe("task_01 · running · 22s");
  expect(state.highlights).toEqual([
    "Active jobs: codex running",
    "Artifact updated: EC2 inventory artifact",
    "Recent receipt: task_01 dispatched as task_01_candidate_01",
  ]);
});

test("factory live status: turns command-ish task output into readable UI copy", () => {
  const summary = summarizeFactoryTaskSignal({
    lastMessage: "Running command: bun run build",
    stdoutTail: undefined,
    stderrTail: undefined,
    artifactSummary: undefined,
    latestSummary: undefined,
  } as never);

  expect(summary).toBe("Running repo command.");
});

test("factory live status: tolerates missing recent jobs during objective startup", () => {
  const state = buildFactoryObjectiveLoadingState({
    detail: {
      displayState: "Running",
      status: "executing",
      phase: "collecting_evidence",
      phaseDetail: "collecting_evidence",
      nextAction: "Wait for evidence collection to finish.",
      latestSummary: "Live collection in progress.",
      tasks: [],
      recentReceipts: [],
      latestDecision: undefined,
    } as never,
    live: {
      activeTasks: [],
    } as never,
  });

  expect(state.label).toBe("Collecting evidence");
  expect(state.summary).toBe("Live collection in progress.");
  expect(state.highlights).toBeUndefined();
});
