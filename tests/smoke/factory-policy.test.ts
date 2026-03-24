import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue, type QueueJob } from "../../src/adapters/jsonl-queue";
import { createRuntime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import {
  DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  initialFactoryState,
  normalizeFactoryObjectivePolicy,
  reduceFactory,
  type FactoryEvent,
  type FactoryState,
} from "../../src/modules/factory";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import { FactoryService, type FactoryIntegrationJobPayload, type FactoryTaskJobPayload } from "../../src/services/factory-service";

const execFileAsync = promisify(execFile);

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
};

const createSourceRepo = async (): Promise<string> => {
  const repoDir = await createTempDir("receipt-factory-policy-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Factory Policy Test"]);
  await git(repoDir, ["config", "user.email", "factory-policy@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# factory policy test\n", "utf-8");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  return repoDir;
};

const runObjectiveStartup = async (service: FactoryService, objectiveId: string): Promise<void> => {
  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId,
    reason: "startup",
  });
};

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );

const latestFactoryJob = async (
  queue: ReturnType<typeof jsonlQueue>,
  objectiveId: string,
  kind: "factory.task.run" | "factory.integration.validate",
): Promise<QueueJob> => {
  const jobs = await queue.listJobs({ limit: 40 });
  const match = jobs
    .filter((job) => job.payload.kind === kind && job.payload.objectiveId === objectiveId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  expect(match).toBeTruthy();
  return match;
};

const createFactoryService = async (opts?: {
  readonly codexOutcome?: "approved" | "changes_requested" | "blocked";
}): Promise<{
  readonly service: FactoryService;
  readonly queue: ReturnType<typeof jsonlQueue>;
  readonly repoRoot: string;
}> => {
  const dataDir = await createTempDir("receipt-factory-policy");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const codexOutcome = opts?.codexOutcome ?? "approved";
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor: {
      run: async (input) => {
        await fs.writeFile(input.promptPath, input.prompt, "utf-8");
        await fs.writeFile(input.stdoutPath, "", "utf-8");
        await fs.writeFile(input.stderrPath, "", "utf-8");
        await fs.writeFile(path.join(input.workspacePath, "POLICY_TEST.txt"), `${codexOutcome}:${input.candidateId ?? "candidate"}\n`, "utf-8");
        const structured = {
          outcome: codexOutcome,
          summary: codexOutcome === "approved"
            ? "Approved output ready."
            : codexOutcome === "changes_requested"
              ? "Another pass is required."
              : "Task is blocked.",
          handoff: codexOutcome === "approved"
            ? "Candidate is ready for integration."
            : codexOutcome === "changes_requested"
              ? "Run another pass."
              : "Blocked.",
        };
        const raw = JSON.stringify(structured);
        await fs.writeFile(input.lastMessagePath, raw, "utf-8");
        return { exitCode: 0, signal: null, stdout: raw, stderr: "", lastMessage: raw };
      },
    },
    repoRoot,
  });
  return { service, queue, repoRoot };
};

const buildState = (events: ReadonlyArray<FactoryEvent>): FactoryState =>
  events.reduce(reduceFactory, initialFactoryState);

const inheritedFailureCommand =
  "printf 'ENOENT: no such file or directory, open %s/InfinitelyManyPrimes.lean\\n' \"$PWD\" >&2; exit 1";

test("factory policy: direct codex probes without an objective stay repo-scoped and avoid Factory worker bootstrap", async () => {
  const { service } = await createFactoryService();

  const packet = await service.prepareDirectCodexProbePacket({
    jobId: "job_repo_probe",
    prompt: "Inspect the current sidebar naming and summarize what needs to change.",
    profileId: "software",
    readOnly: true,
    parentRunId: "run_parent",
    parentStream: "agents/agent",
    stream: "agents/factory/demo",
    supervisorSessionId: "session_repo_probe",
  });

  const manifest = await fs.readFile(packet.artifactPaths.manifestPath, "utf-8");
  const contextPack = await fs.readFile(packet.artifactPaths.contextPackPath, "utf-8");
  const parsedManifest = JSON.parse(manifest) as {
    readonly repoSkillPaths?: ReadonlyArray<string>;
    readonly profile?: {
      readonly selectedSkills?: ReadonlyArray<string>;
    };
  };

  expect(packet.readOnly).toBe(true);
  expect(contextPack).toContain("\"mode\": \"read_only_repo_probe\"");
  expect(contextPack).toContain("\"probeId\": \"job_repo_probe\"");
  expect(contextPack).not.toContain("\"objectiveId\"");
  expect(manifest).toContain("\"objectiveBacked\": false");
  expect(parsedManifest.repoSkillPaths ?? []).not.toContain("skills/factory-receipt-worker/SKILL.md");
  expect(parsedManifest.repoSkillPaths ?? []).not.toContain("skills/factory-run-orchestrator/SKILL.md");
  expect(parsedManifest.profile?.selectedSkills ?? []).toContain("skills/factory-run-orchestrator/SKILL.md");
  expect(packet.renderedPrompt).toContain("This direct probe is not a Factory task worktree");
  expect(packet.renderedPrompt).toContain("should not call the objective inspect commands");
  expect(packet.renderedPrompt).toContain("Do not assume skills/factory-receipt-worker/SKILL.md applies unless a real objectiveId is present.");
});

test("factory policy: task packets tell workers to inspect objective receipts sequentially", async () => {
  const { service, queue } = await createFactoryService();

  const created = await service.createObjective({
    title: "Sequential inspect prompt",
    prompt: "Rename the sidebar label and keep receipt bootstrap reliable.",
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as Record<string, unknown>);
  const promptPath = String(taskJob.payload.promptPath);
  const prompt = await fs.readFile(promptPath, "utf-8");

  expect(prompt).toMatch(/Do not call `.+ factory inspect` from inside this task worktree\./);
  expect(prompt).not.toContain(`factory inspect '${created.objectiveId}' --json --panel receipts`);
  expect(prompt).not.toContain(`factory inspect '${created.objectiveId}' --json --panel debug`);
  expect(prompt).toContain("Do not absorb downstream work");
  expect(prompt).toContain("Do not write this file yourself.");
  expect(prompt).toContain("## Checks");
  expect(prompt).toContain("Run the relevant repo validation for this task");
  expect(prompt).not.toContain("A later task in this objective owns the broad repo validation suite.");
});

test("factory policy: validation-owned task packets include the full repo checks", async () => {
  const { service, queue } = await createFactoryService();

  const created = await service.createObjective({
    title: "Validation prompt owner",
    prompt: "Run the final validation suite.",
    checks: ["git status --short", "bun test"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const prompt = await fs.readFile(String(taskJob.payload.promptPath), "utf-8");

  expect(prompt).toContain("## Checks");
  expect(prompt).toContain("- git status --short");
  expect(prompt).toContain("- bun test");
  expect(prompt).toContain("Run the relevant repo validation for this task");
});

test("factory policy: objectives stay single-task by default and still normalize dispatch policy", async () => {
  const { service } = await createFactoryService();

  const created = await service.createObjective({
    title: "Dispatch cap objective",
    prompt: "Create three independent tasks.",
    policy: {
      throttles: { maxDispatchesPerReact: 1 },
    },
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);
  const ready = await service.getObjective(created.objectiveId);

  expect(ready.policy.concurrency.maxActiveTasks).toBe(4);
  expect(ready.policy.throttles.maxDispatchesPerReact).toBe(1);
  expect(ready.activeTaskCount).toBe(1);
  expect(ready.readyTaskCount).toBe(0);
  expect(ready.taskCount).toBe(1);
});

test("factory policy: maxTaskRuns blocks further dispatch and surfaces a deterministic reason", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "changes_requested" });

  const created = await service.createObjective({
    title: "Task run cap objective",
    prompt: "Keep iterating until approved.",
    policy: {
      budgets: { maxTaskRuns: 1 },
    },
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const job = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(job.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("blocked");
  expect(detail.budgetState.policyBlockedReason ?? "").toMatch(/maxTaskRuns/);
});

test("factory policy: maxCandidatePassesPerTask blocks rework after the configured cap", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "changes_requested" });

  const created = await service.createObjective({
    title: "Candidate pass cap objective",
    prompt: "Keep revising until approved.",
    policy: {
      budgets: { maxCandidatePassesPerTask: 1 },
    },
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const job = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(job.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.tasks[0]?.status).toBe("blocked");
  expect(detail.tasks[0]?.blockedReason ?? "").toMatch(/maxCandidatePassesPerTask/);
});

test("factory objective detail: blocked explanations stay focused on the current blocker without downstream workflow text", async () => {
  const { service, queue } = await createFactoryService({
    codexOutcome: "blocked",
  });

  const created = await service.createObjective({
    title: "Blocked dependency summary objective",
    prompt: "Investigate AWS spend drivers and summarize the blockers.",
    objectiveMode: "investigation",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const job = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(job.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("blocked");
  expect(detail.blockedExplanation?.receiptType).toBe("objective.blocked");
  expect(detail.blockedExplanation?.summary ?? "").not.toContain("Waiting tasks:");
});

test("factory policy: base-commit check failures are treated as inherited on the first candidate pass", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });

  const created = await service.createObjective({
    title: "Inherited failure objective",
    prompt: "Keep progress moving when verify only reproduces the same inherited failure.",
    checks: [inheritedFailureCommand],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(firstJob.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  const approved = detail.candidates.find((candidate) => candidate.candidateId === "task_01_candidate_01");
  expect(["approved", "integrated"]).toContain(approved?.status);
  expect(approved?.summary ?? "").toMatch(/inherited failure/i);
});

test("factory policy: autoPromote false stops at ready_to_promote until promotion is explicit", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });

  const created = await service.createObjective({
    title: "Manual promotion objective",
    prompt: "Require an explicit source promotion step.",
    policy: {
      promotion: { autoPromote: false },
    },
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const validateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(validateJob.payload as FactoryIntegrationJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.integration.status).toBe("ready_to_promote");
  expect(detail.status).not.toBe("completed");

  const promoted = await service.promoteObjective(created.objectiveId);
  expect(promoted.status).toBe("promoting");
  expect(promoted.integration.status).toBe("promoting");

  const publishJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.publish");
  await service.runIntegrationPublish(publishJob.payload as FactoryIntegrationPublishJobPayload);

  const published = await service.getObjective(created.objectiveId);
  expect(published.status).toBe("completed");
  expect(published.integration.status).toBe("promoted");
});

test("factory policy: integration validation can pass through inherited failures without reconciliation churn", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });

  const created = await service.createObjective({
    title: "Inherited integration failure objective",
    prompt: "Do not spawn reconciliation work when integration only reproduces inherited failures.",
    policy: {
      promotion: { autoPromote: false },
    },
    checks: [inheritedFailureCommand],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstTaskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(firstTaskJob.payload as FactoryTaskJobPayload);

  const firstValidateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(firstValidateJob.payload as FactoryIntegrationJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.integration.status).toBe("ready_to_promote");
  expect(detail.integration.lastSummary ?? "").toMatch(/inherited failures/i);
  expect(detail.tasks.some((task) => task.taskKind === "reconciliation")).toBe(false);
});

test("factory policy: integration validation failures block the objective instead of spawning reconciliation work", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });
  const created = await service.createObjective({
    title: "Validation failure objective",
    prompt: "Block on failing integration validation and wait for react.",
    checks: ["true"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstTaskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(firstTaskJob.payload as FactoryTaskJobPayload);
  const validateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  const validatePayload = validateJob.payload as FactoryIntegrationJobPayload;
  await fs.writeFile(path.join(validatePayload.workspacePath, "INTEGRATION_ONLY"), "marker\n", "utf-8");
  await service.runIntegrationValidation({
    ...validatePayload,
    checks: ["sh -lc '[ ! -f INTEGRATION_ONLY ]'"],
  });

  const after = await service.getObjective(created.objectiveId);
  expect(after.status).toBe("blocked");
  expect(after.blockedReason ?? "").toMatch(/Integration validation failed/i);
  expect(after.tasks.some((task) => task.taskKind === "reconciliation")).toBe(false);
});

test("factory reducer: blocked task clears the latest running candidate status", () => {
  const baseCreatedAt = Date.now();
  const state = buildState([
    {
      type: "objective.created",
      objectiveId: "objective_candidate_block",
      title: "Candidate blocker",
      prompt: "Investigate spend drivers.",
      channel: "results",
      baseHash: "abc1234",
      checks: ["bun run build"],
      checksSource: "explicit",
      profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
      policy: normalizeFactoryObjectivePolicy(),
      createdAt: baseCreatedAt,
    },
    {
      type: "task.added",
      objectiveId: "objective_candidate_block",
      createdAt: baseCreatedAt + 1,
      task: {
        nodeId: "task_03",
        taskId: "task_03",
        taskKind: "planned",
        title: "Inventory spend drivers",
        prompt: "Query ELB, EBS, NAT, and CloudWatch.",
        workerType: "codex",
        baseCommit: "abc1234",
        dependsOn: [],
        status: "pending",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: baseCreatedAt + 1,
      },
    },
    {
      type: "candidate.created",
      objectiveId: "objective_candidate_block",
      createdAt: baseCreatedAt + 2,
      candidate: {
        candidateId: "task_03_candidate_01",
        taskId: "task_03",
        status: "planned",
        baseCommit: "abc1234",
        checkResults: [],
        artifactRefs: {},
        createdAt: baseCreatedAt + 2,
        updatedAt: baseCreatedAt + 2,
      },
    },
    {
      type: "task.dispatched",
      objectiveId: "objective_candidate_block",
      taskId: "task_03",
      candidateId: "task_03_candidate_01",
      jobId: "job_task_03",
      workspaceId: "ws_task_03",
      workspacePath: "/tmp/ws_task_03",
      skillBundlePaths: [],
      contextRefs: [],
      startedAt: baseCreatedAt + 3,
    },
    {
      type: "task.blocked",
      objectiveId: "objective_candidate_block",
      taskId: "task_03",
      reason: "AccessDenied: User is not authorized to perform elasticloadbalancing:DescribeLoadBalancers because no identity-based policy allows the action.",
      blockedAt: baseCreatedAt + 4,
    },
  ]);

  expect(state.workflow.tasksById.task_03?.status).toBe("blocked");
  expect(state.candidates.task_03_candidate_01?.status).toBe("changes_requested");
  expect(state.candidates.task_03_candidate_01?.latestReason).toContain("DescribeLoadBalancers");
});
