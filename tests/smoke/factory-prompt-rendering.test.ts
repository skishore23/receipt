import { expect, test } from "bun:test";

import type {
  FactoryObjectiveContractRecord,
  FactoryPlanningReceiptRecord,
  FactoryState,
  FactoryTaskRecord,
} from "../../src/modules/factory";
import type { FactoryCloudExecutionContext } from "../../src/services/factory-cloud-context";
import {
  renderFactoryDirectCodexProbePrompt,
  renderFactoryTaskPrompt,
  renderFactoryTaskValidationSection,
} from "../../src/services/factory/prompt-rendering";
import type { FactoryTaskJobPayload } from "../../src/services/factory-types";

const cloudExecutionContext = {
  summary: "AWS CLI available.",
  guidance: ["Use the detected AWS context by default."],
  availableProviders: ["aws"],
  activeProviders: ["aws"],
  preferredProvider: "aws",
} satisfies FactoryCloudExecutionContext;

const planningReceipt = {
  goal: "Refactor Factory prompt helpers.",
  constraints: ["Keep prompt contracts stable."],
  taskGraph: [{
    taskId: "task_01",
    title: "Refactor prompt rendering",
    dependsOn: [],
    workerType: "codex",
    executionMode: "worktree",
    status: "running",
  }],
  acceptanceCriteria: ["Preserve the worker prompt contract."],
  validationPlan: ["bun test tests/smoke/factory-prompt-rendering.test.ts"],
  plannedAt: 1,
} satisfies FactoryPlanningReceiptRecord;

const objectiveContract = {
  acceptanceCriteria: ["Prompt still contains the worker guardrails."],
  allowedScope: ["Prompt rendering helpers."],
  disallowedScope: ["Orchestration changes."],
  requiredChecks: ["bun test tests/smoke/factory-prompt-rendering.test.ts"],
  proofExpectation: "Keep the prompt text stable for the worker runtime.",
} satisfies FactoryObjectiveContractRecord;

test("factory prompt rendering: delivery tasks defer broad validation to later validation owners", () => {
  const currentTask = {
    taskId: "task_01",
    title: "Refactor prompt rendering",
    prompt: "Move rendering helpers into a module.",
  } as FactoryTaskRecord;
  const validationTask = {
    taskId: "task_02",
    title: "Run validation suite",
    prompt: "Run validation suite and record results.",
  } as FactoryTaskRecord;
  const state = {
    objectiveMode: "delivery",
    checks: ["bun run verify"],
    workflow: {
      taskIds: ["task_01", "task_02"],
      tasksById: {
        task_01: currentTask,
        task_02: validationTask,
      },
    },
  } as FactoryState;

  const section = renderFactoryTaskValidationSection(state, currentTask);

  expect(section).toEqual([
    "## Validation Guidance",
    "A later task in this objective owns the broad repo validation suite.",
    "Do not run the full repo checks here unless this task is itself the validation pass or a tiny targeted check is strictly needed to de-risk the change.",
    "Reserved full-suite commands for later:",
    "- bun run verify",
  ]);
});

test("factory prompt rendering: task prompt keeps live guidance and worktree inspect guardrails", () => {
  const state = {
    objectiveId: "objective_demo",
    title: "Refactor prompt helpers",
    prompt: "Organize Factory prompt rendering.",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["bun run verify"],
  } as FactoryState;
  const task = {
    taskId: "task_01",
    title: "Refactor prompt rendering",
    prompt: "Extract the rendering helpers.",
    workerType: "codex",
    executionPhase: "synthesizing",
  } as FactoryTaskRecord;
  const payload = {
    executionMode: "worktree",
    baseCommit: "abc123",
    candidateId: "task_01_candidate_01",
    taskPhase: "synthesizing",
    repoSkillPaths: [
      "/Users/kishore/receipt/skills/factory-receipt-worker/SKILL.md",
    ],
    profile: {
      rootProfileLabel: "Default",
      rootProfileId: "default",
      cloudProvider: "aws",
      selectedSkills: ["skills/factory-receipt-worker/SKILL.md"],
    },
  } as FactoryTaskJobPayload;

  const prompt = renderFactoryTaskPrompt({
    state,
    task,
    payload,
    taskPrompt: "Extract the rendering helpers.",
    planningReceipt,
    objectiveContract: {
      ...objectiveContract,
      requiredChecks: [],
    },
    cloudExecutionContext,
    helperCatalog: {
      runnerPath: "/Users/kishore/receipt/skills/factory-helper-runtime/runner.py",
      selectedHelpers: [{
        id: "aws_alarm_summary",
        description: "Summarize CloudWatch alarms.",
        provider: "aws",
        examples: ["--all-regions --output-dir .receipt/factory/evidence"],
      }],
    } as never,
    infrastructureTaskGuidance: [],
    dependencySummaries: "- none",
    downstreamSummaries: "- none",
    memorySummary: "Prior note",
    validationSection: renderFactoryTaskValidationSection(state, task),
    manifestPathForPrompt: ".receipt/factory/task_01.manifest.json",
    contextSummaryPathForPrompt: ".receipt/factory/task_01.context.md",
    contextPackPathForPrompt: ".receipt/factory/task_01.context-pack.json",
    memoryScriptPathForPrompt: ".receipt/factory/task_01.memory.cjs",
    resultPathForPrompt: ".receipt/factory/task_01.result.json",
    liveGuidanceSection: "## Live Operator Guidance\nTreat this section as highest priority. Apply it before any new inspection, parsing, or external command.\n1. Live steer at 2026-03-30T12:00:00.000Z\nStay focused on prompt rendering.\n",
    factoryCliPrefix: "receipt",
  });

  expect(prompt).toContain("## Live Operator Guidance");
  expect(prompt).toContain("Treat this section as highest priority.");
  expect(prompt).toContain("Stay focused on prompt rendering.");
  expect(prompt).toContain("The controller already prepared a task context summary from the manifest, context pack, scoped memory, receipts, and mounted evidence.");
  expect(prompt).toContain("Start with the task context summary.");
  expect(prompt).toContain("Do not reread the full bootstrap stack unless that summary leaves an exact field, path, or contradiction unresolved.");
  expect(prompt).toContain("Checked-in repo skill files for this task:");
  expect(prompt).toContain("/Users/kishore/receipt/skills/factory-receipt-worker/SKILL.md");
  expect(prompt).toContain("Do not substitute CODEX_HOME, ~/.codex, or .receipt/codex-home-runtime skill paths");
  expect(prompt).toContain("Do not call `receipt factory inspect` from inside this task worktree.");
  expect(prompt).toContain("### Synthesis-Only Mode");
  expect(prompt).toContain("Do not rerun helpers, design new scripts, rediscover the packet stack, or launch new external queries.");
  expect(prompt).toContain("Ignore any Required checks listed above unless live operator guidance explicitly asks for repo validation.");
  expect(prompt).toContain("Do not inspect JSON structure repeatedly.");
  expect(prompt).toContain("Do not open the receipt CLI surface, memory script, or manifest in synth mode unless the context summary points to a missing or contradictory artifact path.");
  expect(prompt).toContain("Do not run timestamp-only or bookkeeping commands such as `date`, `pwd`, or extra file listings just to pad report fields.");
  expect(prompt).toContain("For synth-only investigation results, prefer `report.evidenceRecords: []` unless the mounted evidence already contains exact structured records with stable timestamps.");
  expect(prompt).toContain("Set `report.scriptsRun` to null unless you already have a concrete command log you can cite without more inspection.");
  expect(prompt).toContain("For synth-only investigation tasks, prioritize completion from mounted artifacts.");
  expect(prompt).not.toContain("## Memory Access");
  expect(prompt).not.toContain("aws_alarm_summary");
  expect(prompt).not.toContain("Receipt CLI Surface (fallback only when packet surfaces are insufficient)");
  expect(prompt).toContain("Return exactly one JSON object matching this schema:");
});

test("factory prompt rendering: direct probe prompt includes objective inspection commands and receipt evidence", () => {
  const prompt = renderFactoryDirectCodexProbePrompt({
    prompt: "Investigate the latest Factory run.",
    readOnly: true,
    artifactPaths: {
      root: ".receipt/factory/probe",
      lastMessagePath: ".receipt/factory/probe.last-message.txt",
      stdoutPath: ".receipt/factory/probe.stdout.log",
      stderrPath: ".receipt/factory/probe.stderr.log",
      manifestPath: ".receipt/factory/probe.manifest.json",
      contextPackPath: ".receipt/factory/probe.context-pack.json",
      memoryScriptPath: ".receipt/factory/probe.memory.cjs",
      memoryConfigPath: ".receipt/factory/probe.memory-scopes.json",
      resultPath: ".receipt/factory/probe.result.json",
      promptPath: ".receipt/factory/probe.prompt.md",
    },
    objective: {
      objectiveId: "objective_demo",
      title: "Refactor prompt helpers",
      status: "running",
      phase: "collecting_evidence",
      latestDecision: { summary: "Dispatched the next task." },
      blockedExplanation: { summary: "Waiting on evidence." },
    },
    cloudExecutionContext,
    helperCatalog: undefined,
    repoSkillPaths: ["/repo/skills/factory-receipt-worker/SKILL.md"],
    recentReceipts: [
      {
        type: "worker.handoff",
        hash: "hash_01",
        ts: 1,
        summary: "Worker handed off the prompt update.",
      },
    ],
    profileSelectedSkills: ["skills/factory-receipt-worker/SKILL.md"],
    repoRoot: "/Users/kishore/receipt",
    factoryCliPrefix: "receipt",
  });

  expect(prompt).toContain("receipt factory inspect 'objective_demo' --json --panel receipts");
  expect(prompt).toContain("receipt trace 'factory/objectives/objective_demo'");
  expect(prompt).toContain("## Recent Receipt Evidence");
  expect(prompt).toContain("- worker.handoff: Worker handed off the prompt update.");
});
