import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { jsonlQueue, type QueueJob } from "../../src/adapters/jsonl-queue";
import { createMemoryTools, decideMemory, initialMemoryState, reduceMemory, type MemoryCmd, type MemoryEvent, type MemoryState } from "../../src/adapters/memory-tools";
import type { CodexExecutorInput, CodexRunControl } from "../../src/adapters/codex-executor";
import { createRuntime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import { runFactoryObjectiveAudit } from "../../src/services/factory-runtime";
import { FactoryService, type FactoryTaskJobPayload } from "../../src/services/factory-service";
import { resolveBunRuntime } from "../../src/lib/runtime-paths";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI_PATH = path.join(ROOT, "src", "cli.ts");
const SCRIPT_PATH = path.join(ROOT, "scripts", "factory-investigate.ts");
const BUN = resolveBunRuntime();

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
  const repoDir = await createTempDir("receipt-investigate-script-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Factory Investigate Script Test"]);
  await git(repoDir, ["config", "user.email", "factory-investigate@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# investigate script test\n", "utf-8");
  await git(repoDir, ["add", "README.md"]);
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

const createMemoryRuntime = (dataDir: string) =>
  createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    jsonlStore<MemoryEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideMemory,
    reduceMemory,
    initialMemoryState,
  );

const runObjectiveStartup = async (service: FactoryService, objectiveId: string): Promise<void> => {
  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId,
    reason: "startup",
  });
};

const createFactoryService = async (): Promise<{
  readonly service: FactoryService;
  readonly queue: ReturnType<typeof jsonlQueue>;
  readonly repoRoot: string;
  readonly dataDir: string;
}> => {
  const dataDir = await createTempDir("receipt-investigate-script");
  const repoRoot = await createSourceRepo();
  const queue = jsonlQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const memoryTools = createMemoryTools({
    dir: dataDir,
    runtime: createMemoryRuntime(dataDir),
  });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor: {
      run: async (input: CodexExecutorInput, _control?: CodexRunControl) => {
        await fs.writeFile(input.promptPath, input.prompt, "utf-8");
        await fs.writeFile(input.stdoutPath, "", "utf-8");
        await fs.writeFile(input.stderrPath, "", "utf-8");
        const raw = JSON.stringify({
          outcome: "approved",
          summary: "Investigated the receipt flow and recorded a focused handoff.",
          handoff: "Use the generated packet summary first, then inspect the timeline if you need finer evidence.",
          artifacts: [],
          completion: {
            status: "done",
            outcome: "complete",
            remainingWork: [],
          },
          report: {
            conclusion: "The script test objective completed with a structured investigation result.",
            evidence: [],
            scriptsRun: [],
            disagreements: [],
            nextSteps: [],
          },
        });
        await fs.writeFile(input.lastMessagePath, raw, "utf-8");
        return {
          exitCode: 0,
          signal: null,
          stdout: raw,
          stderr: "",
          lastMessage: raw,
        };
      },
    },
    repoRoot,
    profileRoot: ROOT,
    memoryTools,
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

test("factory investigate script resolves task ids and prints summary, context, and dag flow", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService();
  const created = await service.createObjective({
    title: "Investigate receipt script output",
    prompt: "Explain what happened in this objective using receipts and packet context.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, created.objectiveId);
  const [job] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(job).toBeTruthy();
  await service.runTask(job!.payload as FactoryTaskJobPayload);

  const textRun = await execFileAsync(BUN, [
    SCRIPT_PATH,
    "task_01",
    "--data-dir",
    dataDir,
    "--repo-root",
    repoRoot,
    "--timeline-limit",
    "8",
    "--context-chars",
    "800",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });

  expect(textRun.stdout).toContain("# Factory Receipt Investigation");
  expect(textRun.stdout).toContain("Resolved: objective via task-id");
  expect(textRun.stdout).toContain("## What Happened");
  expect(textRun.stdout).toContain("## Assessment");
  expect(textRun.stdout).toContain("## Context");
  expect(textRun.stdout).toContain("## DAG Flow");
  expect(textRun.stdout).toContain("## Timeline");
  expect(textRun.stdout).toContain("Investigate receipt script output");
  expect(textRun.stdout).toContain("Context summary path:");
  expect(textRun.stdout).toContain("task_01 (root)");

  const jsonRun = await execFileAsync(BUN, [
    SCRIPT_PATH,
    created.objectiveId,
    "--data-dir",
    dataDir,
    "--repo-root",
    repoRoot,
    "--json",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });

  const payload = JSON.parse(jsonRun.stdout) as {
    readonly resolved: { readonly kind: string };
    readonly links: { readonly objectiveId?: string; readonly taskId?: string };
    readonly packetContext?: { readonly summaryPath?: string; readonly summaryText?: string };
    readonly dag: { readonly lines: ReadonlyArray<string> };
    readonly summary: { readonly whatHappened: ReadonlyArray<string> };
    readonly assessment: { readonly verdict: string; readonly easyRouteRisk: string };
  };
  expect(payload.resolved.kind).toBe("objective");
  expect(payload.links.objectiveId).toBe(created.objectiveId);
  expect(payload.links.taskId).toBe("task_01");
  expect(payload.packetContext?.summaryPath).toContain(".receipt/factory/task_01.context.md");
  expect(payload.packetContext?.summaryText).toContain("Factory Task Context Summary");
  expect(payload.dag.lines.some((line) => line.includes("task_01"))).toBe(true);
  expect(payload.summary.whatHappened.length).toBeGreaterThan(0);
  expect(payload.assessment.verdict).toBeTruthy();
  expect(payload.assessment.easyRouteRisk).toBeTruthy();
}, 120_000);

test("factory CLI investigate exposes the same investigation flow for repair/debug work", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService();
  const created = await service.createObjective({
    title: "Investigate via factory CLI",
    prompt: "Use factory investigate to reconstruct the task context and failure flow.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, created.objectiveId);
  const [job] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(job).toBeTruthy();
  await service.runTask(job!.payload as FactoryTaskJobPayload);

  const textRun = await execFileAsync(BUN, [
    CLI_PATH,
    "factory",
    "investigate",
    "task_01",
    "--data-dir",
    dataDir,
    "--repo-root",
    repoRoot,
    "--timeline-limit",
    "6",
    "--context-chars",
    "700",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });

  expect(textRun.stdout).toContain("# Factory Receipt Investigation");
  expect(textRun.stdout).toContain("Resolved: objective via task-id");
  expect(textRun.stdout).toContain("## Assessment");
  expect(textRun.stdout).toContain("## Context");
  expect(textRun.stdout).toContain("## DAG Flow");

  const jsonRun = await execFileAsync(BUN, [
    CLI_PATH,
    "factory",
    "investigate",
    created.objectiveId,
    "--data-dir",
    dataDir,
    "--repo-root",
    repoRoot,
    "--json",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });

  const payload = JSON.parse(jsonRun.stdout) as {
    readonly links: { readonly objectiveId?: string; readonly taskId?: string };
    readonly packetContext?: { readonly contextPackPath?: string };
    readonly summary: { readonly whatHappened: ReadonlyArray<string> };
    readonly assessment: { readonly verdict: string; readonly efficiency: string };
  };
  expect(payload.links.objectiveId).toBe(created.objectiveId);
  expect(payload.links.taskId).toBe("task_01");
  expect(payload.packetContext?.contextPackPath).toContain(".receipt/factory/task_01.context-pack.json");
  expect(payload.summary.whatHappened.length).toBeGreaterThan(0);
  expect(payload.assessment.verdict).toBeTruthy();
  expect(payload.assessment.efficiency).toBeTruthy();
}, 120_000);

test("factory CLI investigate compact keeps repair sections while dropping verbose agent-run detail", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService();
  const created = await service.createObjective({
    title: "Investigate compact CLI output",
    prompt: "Use factory investigate compact mode to summarize the task context and repair path.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, created.objectiveId);
  const [job] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(job).toBeTruthy();
  await service.runTask(job!.payload as FactoryTaskJobPayload);

  const fullRun = await execFileAsync(BUN, [
    CLI_PATH,
    "factory",
    "investigate",
    created.objectiveId,
    "--data-dir",
    dataDir,
    "--repo-root",
    repoRoot,
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const compactRun = await execFileAsync(BUN, [
    CLI_PATH,
    "factory",
    "investigate",
    created.objectiveId,
    "--compact",
    "--data-dir",
    dataDir,
    "--repo-root",
    repoRoot,
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });

  expect(compactRun.stdout).toContain("## What Happened");
  expect(compactRun.stdout).toContain("## Assessment");
  expect(compactRun.stdout).toContain("## DAG Flow");
  expect(compactRun.stdout).not.toContain("## Agent Runs");
  expect(compactRun.stdout.length).toBeLessThan(fullRun.stdout.length);
}, 120_000);

test("factory CLI investigate keeps large JSON reports parseable when stdout is piped", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService();
  const longPrompt = `Explain the objective in detail.\n${"Long context line.\n".repeat(12_000)}`;
  const created = await service.createObjective({
    title: "Investigate large CLI JSON output",
    prompt: longPrompt,
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, created.objectiveId);
  const [job] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(job).toBeTruthy();
  await service.runTask(job!.payload as FactoryTaskJobPayload);

  const jsonRun = await execFileAsync(BUN, [
    CLI_PATH,
    "factory",
    "investigate",
    created.objectiveId,
    "--data-dir",
    dataDir,
    "--repo-root",
    repoRoot,
    "--json",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });

  const payload = JSON.parse(jsonRun.stdout) as {
    readonly links: { readonly objectiveId?: string };
    readonly inputs: { readonly objectivePrompt?: string };
    readonly assessment: { readonly verdict: string };
  };
  expect(payload.links.objectiveId).toBe(created.objectiveId);
  expect(payload.inputs.objectivePrompt).toContain("Long context line.");
  expect(payload.assessment.verdict).toBeTruthy();
}, 120_000);

test("factory CLI audit aggregates recent objective assessments and memory hygiene", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService();
  const first = await service.createObjective({
    title: "Audit weak investigation",
    prompt: "Investigate the receipt flow with enough structure for the audit to classify the run.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, first.objectiveId);
  const [firstJob] = await objectiveTaskJobs(queue, first.objectiveId);
  expect(firstJob).toBeTruthy();
  await service.runTask(firstJob!.payload as FactoryTaskJobPayload);

  const second = await service.createObjective({
    title: "Audit second investigation",
    prompt: "Create another recent objective so the audit has more than one objective to scan.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, second.objectiveId);
  const [secondJob] = await objectiveTaskJobs(queue, second.objectiveId);
  expect(secondJob).toBeTruthy();
  await service.runTask(secondJob!.payload as FactoryTaskJobPayload);

  const textRun = await execFileAsync(BUN, [
    CLI_PATH,
    "factory",
    "audit",
    "--data-dir",
    dataDir,
    "--repo-root",
    repoRoot,
    "--limit",
    "5",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });

  expect(textRun.stdout).toContain("# Factory Receipt Audit");
  expect(textRun.stdout).toContain("## Summary");
  expect(textRun.stdout).toContain("## Improvement Signals");
  expect(textRun.stdout).toContain("## Memory Hygiene");
  expect(textRun.stdout).toContain(first.objectiveId);
  expect(textRun.stdout).toContain(second.objectiveId);

  const jsonRun = await execFileAsync(BUN, [
    CLI_PATH,
    "factory",
    "audit",
    "--data-dir",
    dataDir,
    "--repo-root",
    repoRoot,
    "--limit",
    "5",
    "--json",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });

  const payload = JSON.parse(jsonRun.stdout) as {
    readonly summary: {
      readonly objectivesAudited: number;
      readonly verdicts: Readonly<Record<string, number>>;
    };
    readonly memoryHygiene: {
      readonly totalFactoryEntries: number;
      readonly repoSharedRunScopedEntries: number;
    };
    readonly objectives: ReadonlyArray<{
      readonly objectiveId: string;
      readonly verdict: string;
    }>;
    readonly improvements: ReadonlyArray<string>;
  };
  expect(payload.summary.objectivesAudited).toBeGreaterThanOrEqual(2);
  expect((payload.summary.verdicts.weak ?? 0) >= 1).toBe(true);
  expect(payload.memoryHygiene.totalFactoryEntries).toBeGreaterThan(0);
  expect(payload.memoryHygiene.repoSharedRunScopedEntries).toBe(0);
  expect(payload.objectives.some((objective) => objective.objectiveId === first.objectiveId)).toBe(true);
  expect(payload.improvements.length).toBeGreaterThan(0);
}, 120_000);

test("factory objective audit persists objective snapshots into dedicated audit memory", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService();
  const created = await service.createObjective({
    title: "Persist background objective audit",
    prompt: "Finish an investigation so the background audit can snapshot the full receipt history.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, created.objectiveId);
  const [job] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(job).toBeTruthy();
  await service.runTask(job!.payload as FactoryTaskJobPayload);

  const result = await runFactoryObjectiveAudit({
    dataDir,
    repoRoot,
    memoryTools: service.memoryTools!,
    payload: {
      kind: "factory.objective.audit",
      objectiveId: created.objectiveId,
      objectiveStatus: "completed",
      objectiveUpdatedAt: Date.now(),
    },
  }) as {
    readonly objectiveId: string;
    readonly verdict: string;
    readonly jsonPath: string;
    readonly textPath: string;
  };

  expect(result.objectiveId).toBe(created.objectiveId);
  expect(result.verdict).toBeTruthy();
  expect(await fs.stat(result.jsonPath).then(() => true).catch(() => false)).toBe(true);
  expect(await fs.stat(result.textPath).then(() => true).catch(() => false)).toBe(true);

  const objectiveAuditMemory = await service.memoryTools!.read({
    scope: `factory/audits/objectives/${created.objectiveId}`,
    limit: 5,
  });
  const repoAuditMemory = await service.memoryTools!.read({
    scope: "factory/audits/repo",
    limit: 5,
  });

  expect(objectiveAuditMemory.some((entry) =>
    entry.text.includes("Assessment")
    && entry.text.includes("Recommendations")
    && entry.text.includes(result.textPath)
  )).toBe(true);
  expect(repoAuditMemory.some((entry) =>
    entry.text.includes(`[${created.objectiveId}]`)
    && entry.text.includes("Summary")
  )).toBe(true);
}, 120_000);
