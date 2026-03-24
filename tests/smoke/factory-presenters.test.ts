import { expect, test } from "bun:test";

import type { QueueJob } from "../../src/adapters/jsonl-queue";
import {
  initialFactoryState,
  normalizeFactoryState,
  type FactoryState,
} from "../../src/modules/factory";
import type { FactoryObjectiveDetail } from "../../src/services/factory-types";
import {
  buildFactoryQueueJobSnapshot,
  summarizeFactoryQueueJob,
} from "../../src/views/factory/job-presenters";
import {
  summarizeFactoryObjective,
  toFactorySelectedObjectiveCard,
  toFactoryStateSelectedObjectiveCard,
} from "../../src/views/factory/objective-presenters";

const makeObjectiveDetail = (): FactoryObjectiveDetail => ({
  objectiveId: "objective_demo",
  title: "Demo objective",
  status: "executing",
  phase: "executing",
  objectiveMode: "delivery",
  severity: 1,
  scheduler: { slotState: "active" },
  updatedAt: 5,
  latestSummary: "Demo summary",
  blockedReason: undefined,
  blockedExplanation: undefined,
  latestDecision: {
    summary: "Keep the active task running.",
    at: 4,
    source: "runtime",
  },
  nextAction: "Wait for the active task pass to finish.",
  activeTaskCount: 1,
  readyTaskCount: 0,
  taskCount: 1,
  integrationStatus: "validated",
  latestCommitHash: "abc12345",
  prUrl: "https://example.com/pr/42",
  prNumber: 42,
  headRefName: "feature/demo",
  baseRefName: "main",
  profile: {
    ...initialFactoryState.profile,
    rootProfileId: "software",
    rootProfileLabel: "Software",
  },
  prompt: "Implement the feature.",
  channel: "results",
  baseHash: "base1234",
  checks: ["bun test"],
  policy: initialFactoryState.policy,
  contextSources: {
    repoSharedMemoryScope: "factory/repo/shared",
    objectiveMemoryScope: "factory/objectives/objective_demo",
    integrationMemoryScope: "factory/objectives/objective_demo/integration",
    profileSkillRefs: [],
    repoSkillPaths: [],
    sharedArtifactRefs: [],
  },
  budgetState: {
    taskRunsUsed: 1,
    candidatePassesByTask: {},
    consecutiveFailuresByTask: {},
    elapsedMinutes: 2,
  },
  createdAt: 1,
  investigation: {
    reports: [],
    finalReport: {
      conclusion: "done",
      evidence: [],
      scriptsRun: [],
      disagreements: [],
      nextSteps: [],
    },
  },
  tasks: [],
  candidates: [],
  integration: {
    ...initialFactoryState.integration,
    status: "validated",
    headCommit: "abc12345",
    prUrl: "https://example.com/pr/42",
    prNumber: 42,
  },
  recentReceipts: [],
  evidenceCards: [],
  activity: [],
}) as FactoryObjectiveDetail;

const makeState = (): FactoryState => normalizeFactoryState({
  ...initialFactoryState,
  objectiveId: "objective_demo",
  title: "Demo objective",
  status: "executing",
  latestSummary: "State summary",
  checks: ["bun test"],
  workflow: {
    ...initialFactoryState.workflow,
    objectiveId: "objective_demo",
    taskIds: ["task_01"],
    tasksById: {
      task_01: {
        nodeId: "task_01",
        taskId: "task_01",
        taskKind: "planned",
        title: "Demo task",
        prompt: "Implement it.",
        workerType: "codex",
        baseCommit: "base1234",
        dependsOn: [],
        status: "running",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: 1,
        startedAt: 2,
      },
    },
    activeTaskIds: ["task_01"],
  },
  candidates: {
    candidate_01: {
      candidateId: "candidate_01",
      taskId: "task_01",
      status: "running",
      baseCommit: "base1234",
      headCommit: "def67890",
      checkResults: [],
      artifactRefs: {},
      tokensUsed: 123,
      createdAt: 2,
      updatedAt: 2,
    },
  },
  candidateOrder: ["candidate_01"],
  integration: {
    ...initialFactoryState.integration,
    status: "validated",
    headCommit: "fedcba98",
    prUrl: "https://example.com/pr/99",
    prNumber: 99,
  },
});

const makeJob = (overrides: Partial<QueueJob> = {}): QueueJob => ({
  id: "job_demo",
  agentId: "codex",
  lane: "default",
  singletonMode: "allow",
  status: "running",
  attempt: 1,
  maxAttempts: 1,
  createdAt: 1,
  updatedAt: 2,
  payload: {
    kind: "factory.task.run",
    task: "Implement the feature",
    problem: "Implement the feature end to end.",
  },
  result: {
    summary: "Worker is applying the patch.",
    note: "note wins when requested",
    changedFiles: ["src/app.ts"],
  },
  commands: [],
  ...overrides,
}) as QueueJob;

test("factory presenters: summarize objective uses the shared objective summary shape", () => {
  const summary = summarizeFactoryObjective(makeObjectiveDetail());

  expect(summary).toEqual({
    objectiveId: "objective_demo",
    title: "Demo objective",
    status: "executing",
    phase: "executing",
    summary: "Demo summary",
    integrationStatus: "validated",
    latestCommitHash: "abc12345",
    prUrl: "https://example.com/pr/42",
    prNumber: 42,
    link: "/factory?objective=objective_demo",
  });
});

test("factory presenters: selected objective card keeps detail-only fields intact", () => {
  const card = toFactorySelectedObjectiveCard(makeObjectiveDetail());

  expect(card.debugLink).toBe("/factory/api/objectives/objective_demo/debug");
  expect(card.receiptsLink).toBe("/receipt");
  expect(card.latestDecisionSummary).toBe("Keep the active task running.");
  expect(card.checks).toEqual(["bun test"]);
  expect(card.prUrl).toBe("https://example.com/pr/42");
});

test("factory presenters: state-selected card derives counts, latest commit, and token totals", () => {
  const card = toFactoryStateSelectedObjectiveCard(makeState());

  expect(card.integrationStatus).toBe("validated");
  expect(card.activeTaskCount).toBe(1);
  expect(card.readyTaskCount).toBe(0);
  expect(card.taskCount).toBe(1);
  expect(card.latestCommitHash).toBe("fedcba98");
  expect(card.tokensUsed).toBe(123);
  expect(card.prNumber).toBe(99);
});

test("factory presenters: shared queue job helpers preserve snapshot and summary behavior", () => {
  const runningJob = makeJob();
  const failedJob = makeJob({
    status: "failed",
    lastError: "Worker failed hard.",
    result: {
      summary: "Should not win over the terminal error.",
      note: "failure note",
    },
  });

  expect(summarizeFactoryQueueJob(runningJob)).toBe("Worker is applying the patch.");
  expect(summarizeFactoryQueueJob(runningJob, { preferNoteBeforeMessage: true })).toBe("Worker is applying the patch.");
  expect(summarizeFactoryQueueJob(failedJob, { preferTerminalSummary: true })).toBe("Worker failed hard.");

  const snapshot = buildFactoryQueueJobSnapshot(runningJob);
  expect(snapshot.summary).toBe("Worker is applying the patch.");
  expect(snapshot.task).toBe("Implement the feature");
  expect(snapshot.changedFiles).toEqual(["src/app.ts"]);
});
