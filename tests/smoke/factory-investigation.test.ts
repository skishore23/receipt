import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ZodTypeAny, infer as ZodInfer } from "zod";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue, type QueueJob } from "../../src/adapters/jsonl-queue";
import type { CodexExecutorInput } from "../../src/adapters/codex-executor";
import { createRuntime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
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
  readonly llmStructured: <Schema extends ZodTypeAny>(input: {
    readonly schemaName: string;
    readonly schema: Schema;
  }) => Promise<{ readonly parsed: ZodInfer<Schema>; readonly raw: string }>;
  readonly codexRun: (input: CodexExecutorInput) => Promise<{ readonly stdout: string; readonly stderr: string; readonly lastMessage?: string }>;
  readonly seedRepo?: (repoRoot: string) => Promise<void>;
  readonly cloudExecutionContextProvider?: () => Promise<FactoryCloudExecutionContext>;
}): Promise<{
  readonly service: FactoryService;
  readonly queue: ReturnType<typeof jsonlQueue>;
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
      run: async (input) => {
        await fs.writeFile(input.promptPath, input.prompt, "utf-8");
        const result = await opts.codexRun(input);
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
    llmStructured: opts.llmStructured,
    repoRoot,
    profileRoot: process.cwd(),
    cloudExecutionContextProvider: opts.cloudExecutionContextProvider,
  });
  return { service, queue };
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
    llmStructured: async <Schema extends ZodTypeAny>(input: { readonly schema: Schema }) => ({
      parsed: input.schema.parse({
        tasks: [
          { title: "Inspect permissions", prompt: "Inspect AWS permissions and summarize the current access posture.", workerType: "codex", dependsOn: [] },
        ],
      }),
      raw: "",
    }),
    codexRun: async (input) => {
      const schema = JSON.parse(await fs.readFile(input.outputSchemaPath!, "utf-8")) as Record<string, unknown>;
      expect(schema.required).toEqual(["outcome", "summary", "handoff", "report"]);
      const report = (schema.properties as Record<string, Record<string, unknown>>).report;
      expect(report.required).toEqual(["conclusion", "evidence", "scriptsRun", "disagreements", "nextSteps"]);
      const evidenceItem = ((report.properties as Record<string, Record<string, unknown>>).evidence.items as Record<string, unknown>);
      expect(evidenceItem.required).toEqual(["title", "summary", "detail"]);
      const scriptItem = ((report.properties as Record<string, Record<string, unknown>>).scriptsRun.items as Record<string, unknown>);
      expect(scriptItem.required).toEqual(["command", "summary", "status"]);
      const structured = {
        outcome: "approved",
        summary: "Collected the current AWS access posture.",
        handoff: "Investigation is ready for synthesis.",
        report: {
          conclusion: "The configured AWS identity has read access but no mutation path was exercised.",
          evidence: [{ title: "AWS CLI inspection", summary: "Read-only identity details were collected successfully.", detail: null }],
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
  expect(detail.recentReceipts.some((receipt) => receipt.type === "investigation.reported")).toBe(true);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "investigation.synthesized")).toBe(true);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "candidate.produced")).toBe(false);
  expect(detail.evidenceCards.some((card) => card.kind === "report" && card.receiptType === "investigation.synthesized")).toBe(true);
}, 120_000);

test("factory investigation: conflicting reports spawn reconciliation and complete from the reconciled result", async () => {
  const { service, queue } = await createFactoryService({
    llmStructured: async <Schema extends ZodTypeAny>(input: { readonly schema: Schema }) => ({
      parsed: input.schema.parse({
        tasks: [
          { title: "Signal A", prompt: "Collect signal A from service health evidence.", workerType: "codex", dependsOn: [] },
          { title: "Signal B", prompt: "Collect signal B from deployment evidence.", workerType: "codex", dependsOn: [] },
        ],
      }),
      raw: "",
    }),
    codexRun: async (input) => {
      const structured = input.prompt.includes("Collect signal A")
        ? {
            outcome: "approved",
            summary: "Signal A implicates service health.",
            handoff: "First report complete.",
            report: {
              conclusion: "Service health evidence points to an application-side fault.",
              evidence: [{ title: "Health checks", summary: "Service health degraded before the deployment change." }],
            },
          }
        : input.prompt.includes("Collect signal B")
          ? {
              outcome: "approved",
              summary: "Signal B implicates deployment drift.",
              handoff: "Second report complete.",
              report: {
                conclusion: "Deployment evidence points to an infrastructure-side drift.",
                evidence: [{ title: "Deployment diff", summary: "The latest rollout changed core infrastructure settings." }],
              },
            }
          : {
              outcome: "approved",
              summary: "Reconciled the conflicting signals.",
              handoff: "Reconciliation complete.",
              report: {
                conclusion: "The rollout exposed an application defect; infrastructure drift was not causal.",
                evidence: [{ title: "Reconciled evidence", summary: "The deployment change coincided with, but did not cause, the outage." }],
                disagreements: ["Initial signal attribution differed across task_01 and task_02."],
                nextSteps: ["Validate the application fix path before any infra rollback."],
              },
            };
      const raw = JSON.stringify(structured);
      return { stdout: raw, stderr: "", lastMessage: raw };
    },
  });

  const created = await service.createObjective({
    title: "Investigate conflicting signals",
    prompt: "Investigate a multi-signal incident and reconcile conflicting findings.",
    objectiveMode: "investigation",
    severity: 3,
    checks: ["true"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const [firstJob] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(firstJob).toBeTruthy();
  const firstTaskId = (firstJob!.payload as FactoryTaskJobPayload).taskId;
  await service.runTask(firstJob!.payload as FactoryTaskJobPayload);

  const secondJob = (await objectiveTaskJobs(queue, created.objectiveId))
    .find((job) => (job.payload as FactoryTaskJobPayload).taskId !== firstTaskId);
  expect(secondJob).toBeTruthy();
  await service.runTask(secondJob!.payload as FactoryTaskJobPayload);

  const afterConflict = await service.getObjective(created.objectiveId);
  expect(afterConflict.reconciliationStatus).not.toBe("none");
  const reconciliationTask = afterConflict.tasks.find((task) => task.taskKind === "reconciliation");
  expect(reconciliationTask).toBeTruthy();

  const reconciliationJob = (await objectiveTaskJobs(queue, created.objectiveId))
    .find((job) => (job.payload as FactoryTaskJobPayload).taskId === reconciliationTask?.taskId);
  expect(reconciliationJob).toBeTruthy();
  await service.runTask(reconciliationJob!.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("completed");
  expect(detail.reconciliationStatus).toBe("completed");
  expect(detail.investigation.synthesized?.report.conclusion).toContain("application defect");
  expect(detail.recentReceipts.some((receipt) => receipt.type === "investigation.synthesized")).toBe(true);
}, 120_000);

test("factory repo profile: init emits an execution landscape skill and mounts it into codex packets", async () => {
  const { service } = await createFactoryService({
    llmStructured: async <Schema extends ZodTypeAny>(input: { readonly schema: Schema }) => ({
      parsed: input.schema.parse({
        tasks: [
          { title: "Inspect repo profile", prompt: "Inspect the generated repo profile.", workerType: "codex", dependsOn: [] },
        ],
      }),
      raw: "",
    }),
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

  const profile = await service.prepareRepoProfile();
  const landscapeSkillRef = profile.generatedSkillRefs.find((ref) => ref.label === "Repo Execution And Permission Landscape");
  expect(landscapeSkillRef).toBeTruthy();
  const landscapeSkill = await fs.readFile(String(landscapeSkillRef!.ref), "utf-8");
  expect(landscapeSkill).toContain("aws-cli");
  expect(landscapeSkill).toContain("terraform");
  expect(landscapeSkill).toContain(".aws");

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
  expect(contextPack).toContain("\"repoExecutionLandscape\"");
  expect(contextPack).toContain("\"tooling\": [");
  expect(packet.renderedPrompt).toContain("execution landscape, permissions, or infrastructure guardrails");
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
    },
    gcp: {
      cliPath: "/opt/homebrew/bin/gcloud",
      version: "Google Cloud SDK 559.0.0",
      activeAccount: "kishore@comfy.org",
      activeProject: "comfy-cloud-dev",
    },
  };
  const { service } = await createFactoryService({
    llmStructured: async <Schema extends ZodTypeAny>(input: { readonly schema: Schema }) => ({
      parsed: input.schema.parse({
        tasks: [
          { title: "Inspect bucket posture", prompt: "Use the local cloud context and report the active bucket scope.", workerType: "codex", dependsOn: [] },
        ],
      }),
      raw: "",
    }),
    codexRun: async () => {
      const raw = JSON.stringify({ outcome: "approved", summary: "noop", handoff: "noop", report: { conclusion: "noop", evidence: [], scriptsRun: [], disagreements: [], nextSteps: [] } });
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
  expect(contextPack).toContain("\"cloudExecutionContext\"");
  expect(contextPack).toContain("\"preferredProvider\": \"aws\"");
  expect(contextPack).toContain("\"accountId\": \"445567089271\"");
  expect(contextPack).toContain("Infrastructure profile currently defaults to AWS");
  expect(manifest).toContain("skills/factory-infrastructure-aws/SKILL.md");
  expect(packet.renderedPrompt).toContain("AWS CLI is available via profile default");
  expect(packet.renderedPrompt).toContain("Infrastructure profile currently defaults to AWS");
}, 120_000);

test("factory investigation: infrastructure task prompts require deterministic scripts for AWS CLI work", async () => {
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
    },
  };
  let capturedSandboxMode: CodexExecutorInput["sandboxMode"];
  const { service, queue } = await createFactoryService({
    llmStructured: async <Schema extends ZodTypeAny>(input: { readonly schema: Schema }) => ({
      parsed: input.schema.parse({
        tasks: [
          { title: "List buckets", prompt: "Use AWS CLI to list S3 buckets.", workerType: "codex", dependsOn: [] },
        ],
      }),
      raw: "",
    }),
    codexRun: async (input) => {
      capturedSandboxMode = input.sandboxMode;
      const raw = JSON.stringify({ outcome: "approved", summary: "noop", handoff: "noop", report: { conclusion: "noop", evidence: [], scriptsRun: [], disagreements: [], nextSteps: [] } });
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
  expect(capturedSandboxMode).toBe("danger-full-access");
  expect(prompt).toContain("## Script-First Execution");
  expect(prompt).toContain("prefer a deterministic shell script over ad hoc one-off commands");
  expect(prompt).toContain("Record the script path and invocation in report.scriptsRun");
  expect(prompt).toContain("capture `aws sts get-caller-identity` in the script first");
  expect(prompt).toContain("use AWS only");
  expect(prompt).toContain("AWS_MAX_ATTEMPTS=1");
  expect(prompt).toMatch(/Do not call `.+ factory inspect` from inside this task worktree\./);
}, 120_000);
