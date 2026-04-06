import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue, type QueueJob } from "../../src/adapters/jsonl-queue";
import { CodexControlSignalError, type CodexExecutorInput, type CodexRunControl } from "../../src/adapters/codex-executor";
import { createRuntime } from "@receipt/core/runtime";
import { getReceiptDb } from "../../src/db/client";
import { SseHub } from "../../src/framework/sse-hub";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import { readFactoryReceiptInvestigation } from "../../src/factory-cli/investigate";
import { FactoryService, type FactoryTaskJobPayload } from "../../src/services/factory-service";
import type { FactoryCloudExecutionContext } from "../../src/services/factory-cloud-context";

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

const createSourceRepo = async (opts?: {
  readonly seed?: (repoRoot: string) => Promise<void>;
}): Promise<string> => {
  const repoDir = await createTempDir("receipt-factory-investigation-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Factory Investigation Test"]);
  await git(repoDir, ["config", "user.email", "factory-investigation@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# factory investigation test\n", "utf-8");
  if (opts?.seed) await opts.seed(repoDir);
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  return repoDir;
};

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );

const runObjectiveStartup = async (service: FactoryService, objectiveId: string): Promise<void> => {
  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId,
    reason: "startup",
  });
};

const createFactoryService = async (opts: {
  readonly codexRun: (
    input: CodexExecutorInput,
    control?: CodexRunControl,
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly lastMessage?: string }>;
  readonly seedRepo?: (repoRoot: string) => Promise<void>;
  readonly cloudExecutionContextProvider?: () => Promise<FactoryCloudExecutionContext>;
}): Promise<{
  readonly service: FactoryService;
  readonly queue: ReturnType<typeof jsonlQueue>;
  readonly repoRoot: string;
  readonly dataDir: string;
}> => {
  const dataDir = await createTempDir("receipt-factory-investigation");
  const repoRoot = await createSourceRepo({ seed: opts.seedRepo });
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor: {
      run: async (input, control) => {
        await fs.writeFile(input.promptPath, input.prompt, "utf-8");
        const result = await opts.codexRun(input, control);
        await fs.writeFile(input.stdoutPath, result.stdout, "utf-8");
        await fs.writeFile(input.stderrPath, result.stderr, "utf-8");
        if (result.lastMessage) await fs.writeFile(input.lastMessagePath, result.lastMessage, "utf-8");
        return {
          exitCode: 0,
          signal: null,
          stdout: result.stdout,
          stderr: result.stderr,
          lastMessage: result.lastMessage,
        };
      },
    },
    repoRoot,
    profileRoot: process.cwd(),
    cloudExecutionContextProvider: opts.cloudExecutionContextProvider,
  });
  return { service, queue, repoRoot, dataDir };
};

const objectiveTaskJobs = async (
  queue: ReturnType<typeof jsonlQueue>,
  objectiveId: string,
): Promise<ReadonlyArray<QueueJob>> => {
  const jobs = await queue.listJobs({ limit: 80 });
  return jobs
    .filter((job) => job.payload.kind === "factory.task.run" && job.payload.objectiveId === objectiveId)
    .sort((a, b) => a.createdAt - b.createdAt);
};

test("factory investigation: no-diff reports complete without integration and synthesize a final report", async () => {
  const { service, queue } = await createFactoryService({
    codexRun: async (input) => {
      const schema = JSON.parse(await fs.readFile(input.outputSchemaPath!, "utf-8")) as Record<string, unknown>;
      expect(schema.required).toEqual(["outcome", "summary", "handoff", "artifacts", "completion", "nextAction", "report"]);
      const report = (schema.properties as Record<string, Record<string, unknown>>).report;
      expect(report.type).toEqual(["object", "null"]);
      expect(report.required).toEqual(["conclusion", "evidence", "evidenceRecords", "scriptsRun", "disagreements", "nextSteps"]);
      const evidenceItem = ((report.properties as Record<string, Record<string, unknown>>).evidence.items as Record<string, unknown>);
      expect(evidenceItem.required).toEqual(["title", "summary", "detail"]);
      const scriptItem = ((report.properties as Record<string, Record<string, unknown>>).scriptsRun.items as Record<string, unknown>);
      expect(scriptItem.required).toEqual(["command", "summary", "status"]);
      const structured = {
        outcome: "approved",
        summary: "Collected the current AWS access posture.",
        handoff: "Worker completed the access-posture investigation and is handing the report back for synthesis.",
        artifacts: [{ label: "AWS CLI inspection", path: "/tmp/aws-access-posture.json", summary: "Read-only identity details were collected successfully." }],
        completion: {
          changed: ["Captured a structured AWS access posture report."],
          proof: ["aws sts get-caller-identity confirmed the mounted principal."],
          remaining: [],
        },
        nextAction: "Investigation is ready for synthesis.",
        report: {
          conclusion: "The configured AWS identity has read access but no mutation path was exercised.",
          evidence: [{ title: "AWS CLI inspection", summary: "Read-only identity details were collected successfully.", detail: null }],
          evidenceRecords: [],
          scriptsRun: [{ command: "aws sts get-caller-identity", summary: "Confirmed the active principal.", status: "ok" }],
          disagreements: [],
          nextSteps: ["If mutation testing is required, create a higher-severity follow-up objective."],
        },
      };
      const raw = JSON.stringify(structured);
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
  });

  const created = await service.createObjective({
    title: "Investigate access posture",
    prompt: "Investigate the current AWS access posture without changing infrastructure.",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["true"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob).toBeTruthy();
  await service.runTask(taskJob!.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("completed");
  expect(detail.objectiveMode).toBe("investigation");
  expect(detail.integration.status).toBe("idle");
  expect(detail.investigation.synthesized?.report.conclusion).toContain("read access");
  expect(detail.investigation.synthesized?.report.scriptsRun).toHaveLength(1);
  expect(detail.investigation.synthesized?.report.evidence.some((item) => item.title === "Check failed" || item.title === "Check passed")).toBe(false);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "worker.handoff" && receipt.taskId === "task_01")).toBe(true);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "objective.handoff")).toBe(true);
  expect(detail.latestHandoff?.status).toBe("completed");
  expect(detail.recentReceipts.some((receipt) => receipt.type === "investigation.reported")).toBe(true);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "investigation.synthesized")).toBe(true);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "candidate.produced")).toBe(false);
  expect(detail.evidenceCards.some((card) => card.kind === "report" && card.receiptType === "investigation.synthesized")).toBe(true);
}, 120_000);

test("factory investigation: blocked structured reports stay non-approvable and do not synthesize", async () => {
  const { service, queue } = await createFactoryService({
    codexRun: async () => {
      const structured = {
        outcome: "blocked",
        summary: "Inventory is incomplete because some AWS read APIs were denied.",
        handoff: "Worker is handing back a partial investigation with explicit permission gaps for the operator.",
        artifacts: [],
        completion: {
          changed: ["Collected partial AWS inventory findings."],
          proof: ["The inventory script captured the denied APIs and the successful EC2 reads."],
          remaining: ["Summarize the confirmed findings and the access gaps for the operator."],
        },
        nextAction: "Summarize the confirmed findings and the access gaps for the operator.",
        report: {
          conclusion: "Partial AWS evidence was collected, but ELB and CloudWatch access gaps left the inventory incomplete.",
          evidence: [{ title: "EC2 inventory", summary: "Instance and EBS counts were collected successfully.", detail: null }],
          evidenceRecords: [],
          scriptsRun: [{ command: "bash .receipt/factory/task_01_inventory.sh", summary: "Collected partial AWS inventory and captured denied APIs.", status: "warning" }],
          disagreements: [],
          nextSteps: ["Grant read-only access for the denied services and rerun the inventory if deeper attribution is required."],
        },
      };
      const raw = JSON.stringify(structured);
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
  });

  const created = await service.createObjective({
    title: "Investigate spend drivers with partial AWS access",
    prompt: "Investigate the likely AWS spend drivers and summarize any permission gaps.",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["true"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob).toBeTruthy();
  await service.runTask(taskJob!.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("blocked");
  expect(detail.tasks[0]?.status).toBe("blocked");
  expect(detail.investigation.reports[0]?.outcome).toBe("blocked");
  expect(detail.investigation.synthesized).toBeUndefined();
  expect(detail.recentReceipts.some((receipt) => receipt.type === "objective.blocked")).toBe(true);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "objective.handoff")).toBe(true);
  expect(detail.latestHandoff?.status).toBe("blocked");
  expect(detail.recentReceipts.some((receipt) => receipt.type === "investigation.reported")).toBe(true);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "investigation.synthesized")).toBe(false);
}, 120_000);

test("factory investigation: approved results downgrade to partial when captured evidence artifacts record errors", async () => {
  const { service, queue } = await createFactoryService({
    codexRun: async (input) => {
      const artifactName = "task_01.evidence.json";
      const artifactDir = path.join(input.workspacePath, ".receipt", "factory");
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(
        path.join(artifactDir, artifactName),
        JSON.stringify({
          status: "ok",
          summary: "Collected mixed AWS evidence.",
          errors: [{
            error: "aws logs describe-log-groups failed: Unknown options: --order-by, --descending, LastEventTime",
          }],
        }, null, 2),
        "utf-8",
      );
      const structured = {
        outcome: "approved",
        summary: "No alarming signals were detected in the sampled AWS services.",
        handoff: "Worker completed the helper-backed investigation and is handing the findings back to the controller.",
        artifacts: [{
          label: "AWS evidence snapshot",
          path: `/workspace/receipt/.receipt/factory/${artifactName}`,
          summary: "Structured evidence from the helper run.",
        }],
        completion: {
          changed: [],
          proof: ["Helper run completed."],
          remaining: [],
        },
        nextAction: "Share the findings with the operator.",
        report: {
          conclusion: "The sampled AWS services look healthy.",
          evidence: [{ title: "Alarm scan", summary: "No alarms were in ALARM state.", detail: null }],
          evidenceRecords: [],
          scriptsRun: [{ command: "python3 skills/factory-helper-runtime/runner.py run --provider aws --json aws_alarm_summary", summary: "Collected alarm state.", status: "ok" }],
          disagreements: [],
          nextSteps: [],
        },
      };
      const raw = JSON.stringify(structured);
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
  });

  const created = await service.createObjective({
    title: "Investigate live AWS health",
    prompt: "Investigate current AWS health signals without making changes.",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["true"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob).toBeTruthy();
  await service.runTask(taskJob!.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("blocked");
  expect(detail.tasks[0]?.status).toBe("blocked");
  expect(detail.investigation.reports[0]?.outcome).toBe("partial");
  expect(detail.investigation.reports[0]?.summary).toContain("remains partial");
  expect(detail.investigation.reports[0]?.report.scriptsRun.some((item) => item.command === "artifact:task_01.evidence.json" && item.status === "error")).toBe(true);
  expect(detail.investigation.synthesized).toBeUndefined();
}, 120_000);

test("factory investigation: missing final JSON fails instead of falling back to stdout", async () => {
  const { service, queue } = await createFactoryService({
    codexRun: async () => ({
      stdout: JSON.stringify({
        outcome: "approved",
        summary: "stdout looked structured but no final message was produced",
        artifacts: [],
        nextAction: null,
        report: null,
      }),
      stderr: "",
    }),
  });

  const created = await service.createObjective({
    title: "Reject unstructured investigation completion",
    prompt: "Require the worker to finish with the structured final JSON contract.",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["true"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob).toBeTruthy();
  await expect(service.runTask(taskJob!.payload as FactoryTaskJobPayload))
    .rejects
    .toThrow("missing structured factory task result from codex");
}, 120_000);

test("factory investigation: live output surfaces extra task artifacts before final handoff", async () => {
  const { service, queue } = await createFactoryService({
    codexRun: async () => {
      throw new Error("task execution should not be needed for artifact visibility");
    },
  });

  const created = await service.createObjective({
    title: "Inspect billing context",
    prompt: "Inspect billing context and collect any side artifacts.",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["true"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob).toBeTruthy();
  const payload = taskJob!.payload as FactoryTaskJobPayload;
  const sideArtifactPath = path.join(payload.workspacePath, ".receipt", "factory", `${payload.taskId}.billing_context.json`);
  await fs.mkdir(path.dirname(sideArtifactPath), { recursive: true });
  await fs.writeFile(sideArtifactPath, JSON.stringify({ buckets: 3 }, null, 2), "utf-8");

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.tasks[0]?.artifactActivity?.some((artifact) => artifact.label === `${payload.taskId}.billing_context.json`)).toBe(true);

  const live = await service.getObjectiveLiveOutput(created.objectiveId, "task", payload.taskId);
  expect(live.summary).toContain("Recent task artifact");
  expect(live.artifactActivity?.some((artifact) => artifact.label === `${payload.taskId}.billing_context.json`)).toBe(true);
});

test("factory investigation: infrastructure objectives keep explicit empty checks and use fixed repo profile defaults", async () => {
  const { service, queue } = await createFactoryService({
    codexRun: async () => {
      throw new Error("task execution should not be needed for the checks regression");
    },
    seedRepo: async (repoRoot) => {
      await fs.writeFile(
        path.join(repoRoot, "package.json"),
        JSON.stringify({
          name: "factory-infra-checks-test",
          packageManager: "bun@1.2.0",
          scripts: {
            build: "tsc -p tsconfig.json",
            test: "bun test",
            lint: "eslint .",
          },
        }, null, 2),
        "utf-8",
      );
    },
  });

  const created = await service.createObjective({
    title: "Investigate infrastructure inventory",
    prompt: "Investigate the current infrastructure inventory without changing code.",
    profileId: "infrastructure",
    objectiveMode: "investigation",
    severity: 2,
  });
  expect(created.checks).toEqual([]);

  await runObjectiveStartup(service, created.objectiveId);

  const detail = await service.getObjective(created.objectiveId);
  const compose = await service.buildComposeModel();
  expect(detail.checks).toEqual([]);
  expect(compose.profileSummary).toContain("checked-in Factory profiles and skills only");

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob).toBeTruthy();
  const manifestPath = String((taskJob!.payload as FactoryTaskJobPayload).manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
    readonly objective?: {
      readonly checks?: ReadonlyArray<string>;
    };
  };
  expect(manifest.objective?.checks).toEqual([]);
}, 120_000);

test("factory investigation: react with a note supersedes the pending attempt and appends operator guidance", async () => {
  const { service, queue } = await createFactoryService({
    codexRun: async () => {
      throw new Error("task execution should not be needed for react note coverage");
    },
  });

  const created = await service.createObjective({
    title: "Investigate scoped inventory",
    prompt: "Investigate the current inventory and summarize the result.",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["true"],
  });
  await service.reactObjectiveWithNote(
    created.objectiveId,
    "Focus only on the inventory task and return the structured result now.",
  );

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.tasks).toHaveLength(2);
  expect(detail.tasks[0]?.status).toBe("superseded");
  expect(detail.tasks[1]?.prompt).toContain("Operator follow-up for this attempt:");
  expect(detail.tasks[1]?.prompt).toContain("Focus only on the inventory task and return the structured result now.");
  expect(detail.recentReceipts.some((receipt) => receipt.type === "objective.operator.noted")).toBe(true);
  const taskJobs = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJobs).toHaveLength(1);
}, 120_000);

test("factory investigation: multiple reported tasks synthesize directly without reconciliation fan-out", async () => {
  const { service } = await createFactoryService({
    codexRun: async () => {
      throw new Error("task execution should not be needed for synthesis coverage");
    },
  });

  const created = await service.createObjective({
    title: "Investigate conflicting signals",
    prompt: "Investigate a multi-signal incident and reconcile conflicting findings.",
    objectiveMode: "investigation",
    severity: 3,
    checks: ["true"],
  });
  const detail = await service.getObjective(created.objectiveId);
  const firstTask = detail.tasks[0]!;
  const secondTask = {
    ...firstTask,
    nodeId: "task_02",
    taskId: "task_02",
    title: "Signal B",
    prompt: "Collect signal B from deployment evidence.",
    status: "pending" as const,
    candidateId: undefined,
    sourceTaskId: firstTask.taskId,
    createdAt: firstTask.createdAt + 1,
  };
  const now = Date.now();
  await (service as unknown as {
    emitObjectiveBatch(objectiveId: string, events: ReadonlyArray<Record<string, unknown>>): Promise<void>;
  }).emitObjectiveBatch(created.objectiveId, [
    {
      type: "task.added",
      objectiveId: created.objectiveId,
      task: secondTask,
      createdAt: secondTask.createdAt,
    },
    {
      type: "candidate.created",
      objectiveId: created.objectiveId,
      createdAt: now,
      candidate: {
        candidateId: "task_01_candidate_01",
        taskId: firstTask.taskId,
        status: "running",
        baseCommit: created.baseHash,
        checkResults: [],
        artifactRefs: {},
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      type: "candidate.created",
      objectiveId: created.objectiveId,
      createdAt: now + 1,
      candidate: {
        candidateId: "task_02_candidate_01",
        taskId: secondTask.taskId,
        status: "running",
        baseCommit: created.baseHash,
        checkResults: [],
        artifactRefs: {},
        createdAt: now + 1,
        updatedAt: now + 1,
      },
    },
    {
      type: "investigation.reported",
      objectiveId: created.objectiveId,
      taskId: firstTask.taskId,
      candidateId: "task_01_candidate_01",
      outcome: "approved",
      summary: "Signal A implicates service health.",
      handoff: "First report complete.",
      completion: {
        changed: ["Captured the first investigation report."],
        proof: ["Health checks degraded before the deployment change."],
        remaining: [],
      },
      report: {
        conclusion: "Service health evidence points to an application-side fault.",
        evidence: [{ title: "Health checks", summary: "Service health degraded before the deployment change.", detail: null }],
        evidenceRecords: [],
        scriptsRun: [{ command: "cat health-check-summary.json", summary: "Reviewed the captured health-check evidence.", status: "ok" }],
        disagreements: ["Initial attribution differed across observed signals."],
        nextSteps: [],
      },
      artifactRefs: {},
      reportedAt: now + 2,
    },
    {
      type: "investigation.reported",
      objectiveId: created.objectiveId,
      taskId: secondTask.taskId,
      candidateId: "task_02_candidate_01",
      outcome: "approved",
      summary: "Signal B implicates deployment drift.",
      handoff: "Second report complete.",
      completion: {
        changed: ["Captured the second investigation report."],
        proof: ["The deployment diff changed core infrastructure settings."],
        remaining: ["Validate the application fix path before any infra rollback."],
      },
      report: {
        conclusion: "Deployment evidence points to an infrastructure-side drift.",
        evidence: [{ title: "Deployment diff", summary: "The latest rollout changed core infrastructure settings.", detail: null }],
        evidenceRecords: [],
        scriptsRun: [{ command: "git diff --stat HEAD~1 HEAD", summary: "Reviewed the deployment change set.", status: "ok" }],
        disagreements: [],
        nextSteps: ["Validate the application fix path before any infra rollback."],
      },
      artifactRefs: {},
      reportedAt: now + 3,
    },
  ]);
  await service.reactObjective(created.objectiveId);

  const after = await service.getObjective(created.objectiveId);
  expect(after.status).toBe("completed");
  expect(after.tasks.some((task) => task.taskKind === "reconciliation")).toBe(false);
  expect(after.investigation.synthesized?.taskIds).toEqual([firstTask.taskId, secondTask.taskId]);
  expect(after.investigation.synthesized?.report.conclusion).toContain("task_01");
  expect(after.recentReceipts.some((receipt) => receipt.type === "investigation.synthesized")).toBe(true);
}, 120_000);

test("factory profile summary: init stays fixed and does not mount generated repo-profile artifacts", async () => {
  const { service } = await createFactoryService({
    codexRun: async () => {
      const raw = JSON.stringify({ outcome: "approved", summary: "noop", handoff: "noop" });
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
    seedRepo: async (repoRoot) => {
      await fs.mkdir(path.join(repoRoot, ".aws"), { recursive: true });
      await fs.mkdir(path.join(repoRoot, "terraform"), { recursive: true });
      await fs.writeFile(path.join(repoRoot, ".aws", "config"), "[default]\nregion=us-west-2\n", "utf-8");
      await fs.writeFile(path.join(repoRoot, "terraform", "main.tf"), "terraform {}\n", "utf-8");
    },
  });

  const compose = await service.buildComposeModel();
  expect(compose.profileSummary).toContain("checked-in Factory profiles and skills only");

  const packet = await service.prepareDirectCodexProbePacket({
    jobId: "job_landscape_probe",
    prompt: "Inspect the repo access landscape.",
    profileId: "infrastructure",
    readOnly: true,
    parentRunId: "run_parent",
    parentStream: "agents/factory",
    stream: "agents/factory/infrastructure",
    supervisorSessionId: "session_landscape_probe",
  });
  const contextPack = await fs.readFile(packet.artifactPaths.contextPackPath, "utf-8");
  expect(contextPack).not.toContain("\"repoExecutionLandscape\"");
}, 120_000);

test("factory cloud context: infrastructure packets mount AWS-first context and skills even when multiple providers are active locally", async () => {
  const mixedContext: FactoryCloudExecutionContext = {
    summary: "AWS CLI is available via profile default; active identity arn:aws:iam::445567089271:user/csagent-api-service in account 445567089271 with region us-west-2. gcloud is available with account kishore@comfy.org and project comfy-cloud-dev. Multiple cloud providers are active locally. Confirm the intended provider before using high-confidence counts.",
    availableProviders: ["aws", "gcp"],
    activeProviders: ["aws", "gcp"],
    guidance: ["Multiple cloud providers are active locally. Confirm the intended provider before using high-confidence counts."],
    aws: {
      cliPath: "/opt/homebrew/bin/aws",
      version: "aws-cli/2.34.14",
      profiles: ["default", "localstack"],
      selectedProfile: "default",
      defaultRegion: "us-west-2",
      callerIdentity: {
        accountId: "445567089271",
        arn: "arn:aws:iam::445567089271:user/csagent-api-service",
        userId: "AIDATEST",
      },
      ec2RegionScope: {
        regions: [
          { regionName: "us-west-2", optInStatus: "opt-in-not-required", endpoint: "ec2.us-west-2.amazonaws.com", queryable: true },
          { regionName: "us-east-1", optInStatus: "opt-in-not-required", endpoint: "ec2.us-east-1.amazonaws.com", queryable: true },
          { regionName: "af-south-1", optInStatus: "not-opted-in", endpoint: "ec2.af-south-1.amazonaws.com", queryable: false },
        ],
        queryableRegions: ["us-west-2", "us-east-1"],
        skippedRegions: [
          { regionName: "af-south-1", optInStatus: "not-opted-in", endpoint: "ec2.af-south-1.amazonaws.com" },
        ],
      },
    },
    gcp: {
      cliPath: "/opt/homebrew/bin/gcloud",
      version: "Google Cloud SDK 559.0.0",
      activeAccount: "kishore@comfy.org",
      activeProject: "comfy-cloud-dev",
    },
  };
  const { service } = await createFactoryService({
    codexRun: async () => {
      const raw = JSON.stringify({
        outcome: "approved",
        summary: "Confirmed the infrastructure helper-first prompt guidance.",
        handoff: "Worker reviewed the mounted AWS helper guidance and is handing the prompt validation back.",
        artifacts: [],
        completion: {
          changed: ["Captured the helper-first prompt validation result."],
          proof: ["The rendered prompt included the expected AWS helper-first guidance and packet instructions."],
          remaining: [],
        },
        nextAction: null,
        report: {
          conclusion: "The infrastructure prompt enforces helper-first AWS investigation guidance.",
          evidence: [{ title: "Rendered prompt", summary: "The prompt included the expected helper-first AWS instructions.", detail: null }],
          evidenceRecords: [],
          scriptsRun: [{ command: "cat .receipt/factory/task_01.prompt.md", summary: "Reviewed the rendered investigation prompt.", status: "ok" }],
          disagreements: [],
          nextSteps: [],
        },
      });
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
    cloudExecutionContextProvider: async () => mixedContext,
  });

  const packet = await service.prepareDirectCodexProbePacket({
    jobId: "job_cloud_context_probe",
    prompt: "Count my buckets.",
    profileId: "infrastructure",
    readOnly: true,
    parentRunId: "run_parent",
    parentStream: "agents/factory",
    stream: "agents/factory/infrastructure",
    supervisorSessionId: "session_cloud_context_probe",
  });
  const manifest = await fs.readFile(packet.artifactPaths.manifestPath, "utf-8");
  const contextPack = await fs.readFile(packet.artifactPaths.contextPackPath, "utf-8");
  const parsedContextPack = JSON.parse(contextPack) as {
    readonly cloudExecutionContext?: {
      readonly preferredProvider?: string;
      readonly availableProviders?: ReadonlyArray<string>;
      readonly activeProviders?: ReadonlyArray<string>;
      readonly aws?: {
        readonly callerIdentity?: {
          readonly accountId?: string;
        };
        readonly ec2RegionScope?: {
          readonly queryableRegions?: ReadonlyArray<string>;
          readonly skippedRegions?: ReadonlyArray<{
            readonly regionName?: string;
            readonly optInStatus?: string;
          }>;
        };
      };
      readonly gcp?: unknown;
      readonly azure?: unknown;
    };
  };
  expect(parsedContextPack.cloudExecutionContext?.preferredProvider).toBe("aws");
  expect(parsedContextPack.cloudExecutionContext?.availableProviders).toEqual(["aws"]);
  expect(parsedContextPack.cloudExecutionContext?.activeProviders).toEqual(["aws"]);
  expect(parsedContextPack.cloudExecutionContext?.aws?.callerIdentity?.accountId).toBe("445567089271");
  expect(parsedContextPack.cloudExecutionContext?.aws?.ec2RegionScope?.queryableRegions).toEqual(["us-west-2", "us-east-1"]);
  expect(parsedContextPack.cloudExecutionContext?.aws?.ec2RegionScope?.skippedRegions?.[0]?.regionName).toBe("af-south-1");
  expect(parsedContextPack.cloudExecutionContext?.aws?.ec2RegionScope?.skippedRegions?.[0]?.optInStatus).toBe("not-opted-in");
  expect(parsedContextPack.cloudExecutionContext?.gcp).toBeUndefined();
  expect(parsedContextPack.cloudExecutionContext?.azure).toBeUndefined();
  expect(contextPack).not.toContain('"regions"');
  expect(contextPack).toContain("Infrastructure profile is AWS-only for now");
  expect(contextPack).toContain("skip 1 not-opted-in regions");
  expect(contextPack).not.toContain("gcloud is available");
  expect(manifest).toContain("skills/factory-infrastructure-aws/SKILL.md");
  expect(packet.renderedPrompt).toContain("AWS CLI is available via profile default");
  expect(packet.renderedPrompt).toContain("Infrastructure profile is AWS-only for now");
  expect(packet.renderedPrompt).toContain("skip 1 not-opted-in regions");
  expect(packet.renderedPrompt).not.toContain("Multiple cloud providers are active locally");
  expect(packet.renderedPrompt).not.toContain("gcloud is available");
}, 120_000);

test("factory investigation: infrastructure task prompts require helper-first AWS CLI guidance", async () => {
  const mixedContext: FactoryCloudExecutionContext = {
    summary: "AWS CLI is available via profile default; active identity arn:aws:iam::445567089271:user/csagent-api-service in account 445567089271 with region us-west-2.",
    availableProviders: ["aws"],
    activeProviders: ["aws"],
    guidance: ["One provider is clearly usable from the local CLI context (aws). Use it by default instead of asking the user to restate provider or scope."],
    aws: {
      cliPath: "/opt/homebrew/bin/aws",
      version: "aws-cli/2.34.14",
      profiles: ["default"],
      selectedProfile: "default",
      defaultRegion: "us-west-2",
      callerIdentity: {
        accountId: "445567089271",
        arn: "arn:aws:iam::445567089271:user/csagent-api-service",
        userId: "AIDATEST",
      },
      ec2RegionScope: {
        regions: [
          { regionName: "us-west-2", optInStatus: "opt-in-not-required", endpoint: "ec2.us-west-2.amazonaws.com", queryable: true },
          { regionName: "us-east-1", optInStatus: "opt-in-not-required", endpoint: "ec2.us-east-1.amazonaws.com", queryable: true },
          { regionName: "af-south-1", optInStatus: "not-opted-in", endpoint: "ec2.af-south-1.amazonaws.com", queryable: false },
        ],
        queryableRegions: ["us-west-2", "us-east-1"],
        skippedRegions: [
          { regionName: "af-south-1", optInStatus: "not-opted-in", endpoint: "ec2.af-south-1.amazonaws.com" },
        ],
      },
    },
  };
  let capturedSandboxMode: CodexExecutorInput["sandboxMode"];
  let capturedCompletionSignalPath: CodexExecutorInput["completionSignalPath"];
  let capturedReasoningEffort: CodexExecutorInput["reasoningEffort"];
  const { service, queue } = await createFactoryService({
    codexRun: async (input) => {
      capturedSandboxMode = input.sandboxMode;
      capturedCompletionSignalPath = input.completionSignalPath;
      capturedReasoningEffort = input.reasoningEffort;
      const raw = JSON.stringify({
        outcome: "approved",
        summary: "Confirmed the infrastructure helper-first prompt guidance.",
        handoff: "Worker reviewed the mounted AWS helper guidance and is handing the prompt validation back.",
        artifacts: [],
        completion: {
          changed: ["Captured the helper-first prompt validation result."],
          proof: ["The rendered prompt included the expected AWS helper-first guidance and packet instructions."],
          remaining: [],
        },
        nextAction: null,
        report: {
          conclusion: "The infrastructure prompt enforces helper-first AWS investigation guidance.",
          evidence: [{ title: "Rendered prompt", summary: "The prompt included the expected helper-first AWS instructions.", detail: null }],
          evidenceRecords: [],
          scriptsRun: [{ command: "cat .receipt/factory/task_01.prompt.md", summary: "Reviewed the rendered investigation prompt.", status: "ok" }],
          disagreements: [],
          nextSteps: [],
        },
      });
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
    cloudExecutionContextProvider: async () => mixedContext,
  });

  const created = await service.createObjective({
    title: "Count buckets",
    prompt: "how many buckets do i have",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["true"],
    profileId: "infrastructure",
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob).toBeTruthy();
  const payload = taskJob!.payload as FactoryTaskJobPayload;
  await service.runTask(payload);
  const prompt = await fs.readFile(payload.promptPath, "utf-8");
  const manifest = JSON.parse(await fs.readFile(payload.manifestPath, "utf-8")) as {
    readonly profile?: {
      readonly selectedSkills?: ReadonlyArray<string>;
    };
  };
  expect(capturedSandboxMode).toBeUndefined();
  expect(capturedCompletionSignalPath).toBe(payload.lastMessagePath);
  expect(capturedReasoningEffort).toBe("high");
  expect(prompt).toContain("## Helper-First Execution");
  expect(prompt).toContain("Profile Cloud Provider: aws");
  expect(prompt).toContain("prefer a checked-in helper over ad hoc one-off commands or a task-local script");
  expect(prompt).toContain("If the task prompt is broad, first narrow it to one concrete investigation question, one primary evidence path, and one stop condition");
  expect(prompt).toContain("decide one concrete selection rule, one primary evidence source, and one stop condition before the first AWS command");
  expect(prompt).toContain("stop bootstrap and run the best matching checked-in helper");
  expect(prompt).toContain("python3 skills/factory-helper-runtime/runner.py run --provider aws --json <helper-id> -- ...");
  expect(prompt).toContain("Helper manifests list required args, required context, and example invocations");
  expect(prompt).toContain("Use one primary evidence path. Only widen the investigation to a second AWS service when the first path is empty, contradictory, or permission-blocked.");
  expect(prompt).toContain("If the helper succeeds and gives enough evidence to answer the task, stop immediately and return the final JSON result");
  expect(prompt).toContain("Only rerun a helper or switch helpers to fix a concrete scope, auth, parsing, or redaction issue.");
  expect(prompt).toContain("Treat successful helper JSON output as sufficient machine-readable evidence");
  expect(prompt).toContain("Record the helper runner command in report.scriptsRun");
  expect(prompt).toContain("create or extend a checked-in helper in the repo");
  expect(prompt).toContain("use the mounted helper authoring skill to add or extend a checked-in helper");
  expect(prompt).toContain("prefer the checked-in `aws_account_scope` and `aws_region_scope` helpers");
  expect(prompt).toContain("Make a short internal plan before the first tool");
  expect(prompt).toContain("Tool discipline: emit at most one tool call in each response, then wait for that tool result before issuing the next call.");
  expect(prompt).toContain("If you need several nearby packet or repo reads, combine them into one shell command instead of batching separate tool calls.");
  expect(prompt).toContain("Use Codex subagents only for bounded sidecar work");
  expect(prompt).toContain("Keep this task session as the single owner of the final JSON result.");
  expect(prompt).toContain("Any delegated ask must restate the objective ID, task ID, candidate ID, and exact artifact or question it owns.");
  expect(prompt).toContain("Do not fan out broad parallel exploration");
  expect(prompt).toContain("Local execution context already indicates aws. Use that provider");
  expect(prompt).toContain("Infrastructure profile is AWS-only for now");
  expect(prompt).toContain("AWS_MAX_ATTEMPTS=1");
  expect(prompt).toContain("do not blindly loop raw `aws ec2 describe-regions --all-regions` output");
  expect(prompt).toContain("run the checked-in `aws_region_scope` helper first");
  expect(prompt).toContain("Treat `not-opted-in` regions as skipped scope, not as a global credential failure");
  expect(payload.executionMode).toBe("worktree");
  expect(payload.workspacePath).toContain("/hub/worktrees/");
  expect(prompt).toContain("from inside this task worktree. The packet already mounts recent objective receipts and state");
  expect(prompt).toContain("Do not emit commentary-style progress updates in this child session.");
  expect(prompt).toContain("Never print or persist raw secret, token, password, API key, or credential values in stdout, stderr, artifacts, or the final JSON.");
  expect(prompt).toContain("Do not load unrelated global skills from ~/.codex");
  expect(prompt).toContain("Helper evidence files written under .receipt/ do not count as repo changes");
  expect(prompt).toContain("skills/factory-helper-runtime/SKILL.md");
  expect(prompt).toContain("skills/factory-helper-authoring/SKILL.md");
  expect(prompt).toContain("skills/factory-aws-cli-cookbook/SKILL.md");
  expect(prompt).toContain("skills/factory-infrastructure-aws/SKILL.md");
  expect(prompt).not.toContain("skills/factory-run-orchestrator/SKILL.md");
  expect(manifest.profile?.selectedSkills ?? []).toContain("skills/factory-helper-runtime/SKILL.md");
  expect(manifest.profile?.selectedSkills ?? []).toContain("skills/factory-helper-authoring/SKILL.md");
  expect(manifest.profile?.selectedSkills ?? []).toContain("skills/factory-aws-cli-cookbook/SKILL.md");
  expect(manifest.profile?.selectedSkills ?? []).toContain("skills/factory-infrastructure-aws/SKILL.md");
  expect(manifest.profile?.selectedSkills ?? []).not.toContain("skills/factory-run-orchestrator/SKILL.md");
}, 120_000);

test("factory investigation: infrastructure task packets mount selected checked-in helpers for matching AWS prompts", async () => {
  const awsContext: FactoryCloudExecutionContext = {
    summary: "AWS CLI is available via profile default; active identity arn:aws:iam::445567089271:user/csagent-api-service in account 445567089271 with region us-west-2.",
    availableProviders: ["aws"],
    activeProviders: ["aws"],
    preferredProvider: "aws",
    guidance: ["One provider is clearly usable from the local CLI context (aws). Use it by default instead of asking the user to restate provider or scope."],
    aws: {
      cliPath: "/opt/homebrew/bin/aws",
      version: "aws-cli/2.34.14",
      profiles: ["default"],
      selectedProfile: "default",
      defaultRegion: "us-west-2",
      callerIdentity: {
        accountId: "445567089271",
        arn: "arn:aws:iam::445567089271:user/csagent-api-service",
        userId: "AIDATEST",
      },
    },
  };
  const { service, queue } = await createFactoryService({
    codexRun: async () => {
      const raw = JSON.stringify({
        outcome: "approved",
        summary: "Checked-in helpers were available in the task packet.",
        handoff: "Worker confirmed the helper catalog was mounted and is handing the result back.",
        artifacts: [],
        completion: {
          changed: ["Confirmed the selected AWS helper catalog for the task packet."],
          proof: ["The context pack included the checked-in helper runner and the aws_resource_inventory helper."],
          remaining: [],
        },
        nextAction: null,
        report: {
          conclusion: "The task packet mounted checked-in helper metadata for the AWS bucket prompt.",
          evidence: [],
          evidenceRecords: [],
          scriptsRun: [{ command: "cat .receipt/factory/task_01.context-pack.json", summary: "Reviewed the mounted helper catalog for the task packet.", status: "ok" }],
          disagreements: [],
          nextSteps: [],
        },
      });
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
    cloudExecutionContextProvider: async () => awsContext,
  });

  const objective = await service.createObjective({
    title: "List buckets",
    prompt: "show me the aws list of buckets",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["true"],
    profileId: "infrastructure",
  });
  await runObjectiveStartup(service, objective.objectiveId);
  const [job] = await objectiveTaskJobs(queue, objective.objectiveId);
  expect(job).toBeTruthy();
  const secondPayload = job!.payload as FactoryTaskJobPayload;
  const contextPack = JSON.parse(await fs.readFile(secondPayload.contextPackPath, "utf-8")) as {
    readonly helperCatalog?: {
      readonly runnerPath?: string;
      readonly selectedHelpers?: ReadonlyArray<{
        readonly id?: string;
        readonly manifestPath?: string;
        readonly entrypointPath?: string;
        readonly requiredArgs?: ReadonlyArray<string>;
        readonly requiredContext?: ReadonlyArray<string>;
      }>;
    };
    readonly contextSources?: {
      readonly sharedArtifactRefs?: ReadonlyArray<{
        readonly ref?: string;
        readonly label?: string;
      }>;
    };
  };
  expect(contextPack.helperCatalog?.runnerPath).toContain("/skills/factory-helper-runtime/runner.py");
  expect(contextPack.helperCatalog?.selectedHelpers?.some((helper) => helper.id === "aws_resource_inventory")).toBe(true);
  expect(contextPack.helperCatalog?.selectedHelpers?.some((helper) =>
    helper.id === "aws_resource_inventory"
    && helper.requiredArgs?.includes("--service")
    && helper.requiredContext?.some((item) => item.includes("service/resource pair"))
  )).toBe(true);
  expect(contextPack.contextSources?.sharedArtifactRefs?.some((ref) => ref.label === "checked-in helper manifest")).toBe(true);
  expect(contextPack.contextSources?.sharedArtifactRefs?.some((ref) => ref.label === "checked-in helper entrypoint")).toBe(true);

  await service.runTask(secondPayload);
  const prompt = await fs.readFile(secondPayload.promptPath, "utf-8");
  expect(prompt).toContain("Use the checked-in helper runner");
  expect(prompt).toContain("Selected helpers for this scope:");
  expect(prompt).toContain("aws_resource_inventory");
}, 120_000);

test("factory investigation: IAM user count prompts select the checked-in IAM helper", async () => {
  const awsContext: FactoryCloudExecutionContext = {
    summary: "AWS CLI is available via profile default; active identity arn:aws:iam::445567089271:user/csagent-api-service in account 445567089271 with region us-west-2.",
    availableProviders: ["aws"],
    activeProviders: ["aws"],
    preferredProvider: "aws",
    guidance: ["One provider is clearly usable from the local CLI context (aws). Use it by default instead of asking the user to restate provider or scope."],
    aws: {
      cliPath: "/opt/homebrew/bin/aws",
      version: "aws-cli/2.34.14",
      profiles: ["default"],
      selectedProfile: "default",
      defaultRegion: "us-west-2",
      callerIdentity: {
        accountId: "445567089271",
        arn: "arn:aws:iam::445567089271:user/csagent-api-service",
        userId: "AIDATEST",
      },
    },
  };
  const { service, queue } = await createFactoryService({
    codexRun: async () => {
      const raw = JSON.stringify({
        outcome: "approved",
        summary: "IAM helper was selected.",
        handoff: "Worker confirmed the IAM helper selection and is handing the result back.",
        artifacts: [],
        completion: {
          changed: ["Confirmed the selected IAM helper metadata for the task packet."],
          proof: ["The context pack selected aws_iam_user_inventory for the IAM user count prompt."],
          remaining: [],
        },
        nextAction: null,
        report: {
          conclusion: "The task packet mounted the IAM user helper for the count prompt.",
          evidence: [],
          evidenceRecords: [],
          scriptsRun: [{ command: "cat .receipt/factory/task_01.context-pack.json", summary: "Reviewed the IAM helper selection in the mounted task packet.", status: "ok" }],
          disagreements: [],
          nextSteps: [],
        },
      });
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
    cloudExecutionContextProvider: async () => awsContext,
  });

  const objective = await service.createObjective({
    title: "Count IAM users",
    prompt: "how many iam users do i have",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["true"],
    profileId: "infrastructure",
  });
  await runObjectiveStartup(service, objective.objectiveId);

  const [job] = await objectiveTaskJobs(queue, objective.objectiveId);
  expect(job).toBeTruthy();
  const payload = job!.payload as FactoryTaskJobPayload;
  const contextPack = JSON.parse(await fs.readFile(payload.contextPackPath, "utf-8")) as {
    readonly helperCatalog?: {
      readonly selectedHelpers?: ReadonlyArray<{
        readonly id?: string;
        readonly requiredContext?: ReadonlyArray<string>;
      }>;
    };
  };

  expect(contextPack.helperCatalog?.selectedHelpers?.some((helper) => helper.id === "aws_iam_user_inventory")).toBe(true);
  expect(contextPack.helperCatalog?.selectedHelpers?.some((helper) =>
    helper.id === "aws_iam_user_inventory"
    && helper.requiredContext?.some((item) => item.includes("account-global"))
  )).toBe(true);

  await service.runTask(payload);
  const prompt = await fs.readFile(payload.promptPath, "utf-8");
  expect(prompt).toContain("Selected helpers for this scope:");
  expect(prompt).toContain("aws_iam_user_inventory");
  expect(prompt).toContain("--profile default");
}, 120_000);

test("factory investigation: resource-specific helper prompts tell Codex to use real identifiers instead of placeholders", async () => {
  const awsContext: FactoryCloudExecutionContext = {
    summary: "AWS CLI is available via profile default; active identity arn:aws:iam::445567089271:user/test in account 445567089271 with region us-west-2.",
    availableProviders: ["aws"],
    activeProviders: ["aws"],
    preferredProvider: "aws",
    guidance: ["Use the mounted AWS context."],
    aws: {
      cliPath: "/opt/homebrew/bin/aws",
      version: "aws-cli/2.34.14",
      profiles: ["default"],
      selectedProfile: "default",
      defaultRegion: "us-west-2",
      callerIdentity: {
        accountId: "445567089271",
        arn: "arn:aws:iam::445567089271:user/test",
        userId: "AIDATEST",
      },
    },
  };
  const { service, queue } = await createFactoryService({
    codexRun: async (input) => {
      const raw = JSON.stringify({
        outcome: "approved",
        summary: "Confirmed the prompt uses real resource identifiers for helper-backed checks.",
        handoff: "Worker verified the resource-specific helper guidance and is handing the prompt validation back.",
        artifacts: [],
        completion: {
          changed: ["Captured the resource-specific helper prompt validation result."],
          proof: ["The rendered prompt included the concrete S3 public-access helper invocation guidance."],
          remaining: [],
        },
        nextAction: null,
        report: {
          conclusion: "The resource-specific helper prompt tells Codex to use real identifiers instead of placeholders.",
          evidence: [{ title: "Rendered prompt", summary: "The prompt included the expected concrete helper invocation template.", detail: null }],
          evidenceRecords: [],
          scriptsRun: [{ command: "cat .receipt/factory/task_01.prompt.md", summary: "Reviewed the rendered prompt for concrete helper arguments.", status: "ok" }],
          disagreements: [],
          nextSteps: [],
        },
      });
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
    cloudExecutionContextProvider: async () => awsContext,
  });

  const created = await service.createObjective({
    title: "Bucket exposure",
    prompt: "check whether the customer-uploads bucket is public",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["true"],
    profileId: "infrastructure",
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob).toBeTruthy();
  const payload = taskJob!.payload as FactoryTaskJobPayload;
  await service.runTask(payload);
  const prompt = await fs.readFile(payload.promptPath, "utf-8");

  expect(prompt).toContain("aws_policy_or_exposure_check");
  expect(prompt).toContain("required args: --service, --check, --resource-id");
  expect(prompt).toContain("Do not invent placeholder identifiers such as __placeholder__.");
  expect(prompt).toContain("--service s3 --check public-access --resource-id my-bucket");
}, 120_000);

test("factory investigation: infrastructure objectives can start from a dirty source repo with an explicit baseHash", async () => {
  const { service, queue, repoRoot } = await createFactoryService({
    codexRun: async () => {
      const raw = JSON.stringify({
        outcome: "approved",
        summary: "Collected bucket count.",
        handoff: "Worker completed the bucket inventory and is handing the report back.",
        artifacts: [],
        completion: {
          changed: ["Captured the bucket inventory summary."],
          proof: ["The worker recorded the bucket inventory result against the pinned base hash."],
          remaining: [],
        },
        nextAction: null,
        report: {
          conclusion: "Bucket inventory completed.",
          evidence: [],
          evidenceRecords: [],
          scriptsRun: [{ command: "aws s3api list-buckets", summary: "Collected the bucket inventory from the mounted AWS context.", status: "ok" }],
          disagreements: [],
          nextSteps: [],
        },
      });
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
  });

  await fs.writeFile(path.join(repoRoot, "DIRTY_NOTE.txt"), "local change\n", "utf-8");
  const baseHash = await git(repoRoot, ["rev-parse", "HEAD"]);

  const created = await service.createObjective({
    title: "Dirty repo infra objective",
    prompt: "Count buckets in the mounted AWS account.",
    profileId: "infrastructure",
    baseHash,
  });

  expect(created.baseHash).toBeTruthy();
  await runObjectiveStartup(service, created.objectiveId);
  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect((taskJob?.payload as FactoryTaskJobPayload | undefined)?.executionMode).toBe("worktree");
});

test("factory investigation: live guidance restarts once, rewrites the prompt, and preserves workspace changes", async () => {
  let attempts = 0;
  let guidancePending = true;
  const { service, queue, repoRoot, dataDir } = await createFactoryService({
    seedRepo: async (repoRoot) => {
      await fs.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
        name: "factory-investigation-live-guidance",
        private: true,
        scripts: {
          build: "bun -e \"process.exit(0)\"",
        },
      }, null, 2), "utf-8");
    },
    codexRun: async (input, control) => {
      attempts += 1;
      if (attempts === 1) {
        await fs.writeFile(path.join(input.workspacePath, "RESTART_MARKER.txt"), "created before restart\n", "utf-8");
        const signal = await control?.pollSignal?.();
        expect(signal?.kind).toBe("restart");
        throw new CodexControlSignalError(signal!, {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          lastMessage: "Restarting after live guidance.",
        });
      }
      expect(await fs.readFile(path.join(input.workspacePath, "RESTART_MARKER.txt"), "utf-8")).toContain("created before restart");
      expect(input.prompt).toContain("## Live Operator Guidance");
      expect(input.prompt).toContain("Do not take the easy route.");
      expect(input.prompt).toContain("Run validation and include proof.");
      const raw = JSON.stringify({
        outcome: "approved",
        summary: "Applied the live-guided investigation fix.",
        handoff: "Live guidance narrowed the task and the rerun completed with proof.",
        artifacts: [],
        completion: {
          changed: ["README.md", "package.json"],
          proof: [
            "Workspace marker survived the restart.",
            "Ran bun run receipt:long-run-evidence successfully as a wrapper around bun run build.",
          ],
          remaining: [],
        },
        nextAction: null,
        report: {
          conclusion: "The rerun completed after live operator guidance was applied.",
          evidence: [{ title: "Restart marker", summary: "The workspace marker survived the restart boundary.", detail: null }],
          evidenceRecords: [],
          scriptsRun: [{ command: "bun run receipt:long-run-evidence", summary: "Validation passed by delegating to bun run build.", status: "ok" }],
          disagreements: [],
          nextSteps: [],
        },
      });
      return {
        stdout: raw,
        stderr: "",
        lastMessage: raw,
      };
    },
  });

  const created = await service.createObjective({
    title: "Investigate live guidance restart",
    prompt: "Investigate and implement a small repo fix without losing context across restarts.",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["bun run build"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob).toBeTruthy();
  await service.runTask(taskJob!.payload as FactoryTaskJobPayload, {
    pollSignal: async () => {
      if (!guidancePending) return undefined;
      guidancePending = false;
      return {
          kind: "restart",
          note: "Do not take the easy route.\n\nRun validation and include proof.",
          meta: {
            jobId: taskJob!.id,
            guidance: "Do not take the easy route.\n\nRun validation and include proof.",
            guidanceKind: "mixed",
            sourceCommandIds: ["cmd_steer_01", "cmd_follow_up_01"],
            appliedAt: 1_234,
          },
        };
    },
  });

  expect(attempts).toBe(2);
  const detail = await service.getObjective(created.objectiveId);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "task.intervention.applied")).toBe(true);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "task.intervention.restarted")).toBe(true);
  const payload = taskJob!.payload as FactoryTaskJobPayload;
  await expect(fs.readFile(payload.promptPath, "utf-8")).resolves.toContain("## Live Operator Guidance");
  await expect(fs.readFile(payload.resultPath, "utf-8")).resolves.toContain("Applied the live-guided investigation fix.");
  await expect(fs.readFile(path.join(payload.workspacePath, "RESTART_MARKER.txt"), "utf-8")).resolves.toContain("created before restart");

  const report = await readFactoryReceiptInvestigation(dataDir, repoRoot, created.objectiveId);
  expect(report.assessment.verdict).toBe("strong");
  expect(report.assessment.followUpValidation).toBe("done");
  expect(report.assessment.operatorGuidanceApplied).toBe(true);
  expect(report.assessment.courseCorrectionWorked).toBe(true);
}, 120_000);

test("factory investigation: prefers terminal job projection over stale receipt-only job state", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService({
    codexRun: async () => ({ stdout: "", stderr: "" }),
  });

  const created = await service.createObjective({
    title: "Projection drift investigation",
    prompt: "Keep investigation job state aligned with the current queue projection.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob?.status).toBe("queued");
  if (!taskJob) throw new Error("expected dispatched task job");

  const db = getReceiptDb(dataDir);
  db.write(() => {
    db.sqlite.query(`
      INSERT INTO job_projection (
        job_id,
        stream,
        agent_id,
        lane,
        session_key,
        singleton_mode,
        payload_json,
        status,
        attempt,
        max_attempts,
        created_at,
        updated_at,
        lease_owner,
        lease_until,
        last_error,
        result_json,
        canceled_reason,
        abort_requested,
        commands_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        canceled_reason = excluded.canceled_reason,
        payload_json = excluded.payload_json,
        commands_json = excluded.commands_json
    `).run(
      taskJob.id,
      `jobs/${taskJob.id}`,
      taskJob.agentId,
      taskJob.lane,
      taskJob.sessionKey ?? null,
      taskJob.singletonMode ?? null,
      JSON.stringify(taskJob.payload),
      "canceled",
      taskJob.attempt,
      taskJob.maxAttempts,
      taskJob.createdAt,
      taskJob.updatedAt + 5_000,
      "local db cleanup",
      taskJob.abortRequested ? 1 : 0,
      JSON.stringify(taskJob.commands),
    );
  });

  const report = await readFactoryReceiptInvestigation(dataDir, repoRoot, created.objectiveId);
  const correctedJob = report.jobs.find((job) => job.jobId === taskJob.id);
  expect(correctedJob?.status).toBe("canceled");
  expect(correctedJob?.canceledReason).toBe("local db cleanup");
  expect(report.warnings.some((warning) =>
    warning.includes(taskJob.id) && warning.includes("projection status canceled") && warning.includes("local db cleanup"))).toBe(true);
}, 120_000);

test("factory investigation: stale queued execution is downgraded to stalled", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService({
    codexRun: async () => ({ stdout: "", stderr: "" }),
  });

  const created = await service.createObjective({
    title: "Queued execution without a consumer",
    prompt: "Detect when active execution has gone stale instead of presenting it as healthy.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob?.status).toBe("queued");
  if (!taskJob) throw new Error("expected dispatched task job");

  const report = await readFactoryReceiptInvestigation(dataDir, repoRoot, created.objectiveId, {
    asOfTs: taskJob.updatedAt + 120_000,
  });
  const stalledJob = report.jobs.find((job) => job.jobId === taskJob.id);
  expect(stalledJob?.status).toBe("stalled");
  expect(report.anomalies.some((anomaly) =>
    anomaly.kind === "job_stalled" && anomaly.jobId === taskJob.id)).toBe(true);
  expect(report.assessment.verdict).toBe("weak");
  expect(report.assessment.notes.some((note) => note.includes("Live execution stalled"))).toBe(true);
}, 120_000);

test("factory investigation: abort signals win over restart handling", async () => {
  const { service, queue } = await createFactoryService({
    codexRun: async (_input, control) => {
      const signal = await control?.pollSignal?.();
      expect(signal?.kind).toBe("abort");
      throw new CodexControlSignalError(signal!, {
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        lastMessage: "Aborted by operator.",
      });
    },
  });

  const created = await service.createObjective({
    title: "Abort live guidance attempt",
    prompt: "Abort before any restart guidance is applied.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [taskJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(taskJob).toBeTruthy();
  await expect(service.runTask(taskJob!.payload as FactoryTaskJobPayload, {
    pollSignal: async () => ({ kind: "abort" }),
  })).rejects.toThrow("codex exec aborted");

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "task.intervention.applied")).toBe(false);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "task.intervention.restarted")).toBe(false);
}, 120_000);
