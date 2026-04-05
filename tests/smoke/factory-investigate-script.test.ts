import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import { readFactoryReceiptInvestigation } from "../../src/factory-cli/investigate";
import { runFactoryObjectiveAudit } from "../../src/services/factory-runtime";
import { FactoryService, type FactoryTaskJobPayload } from "../../src/services/factory-service";
import { resolveBunRuntime } from "../../src/lib/runtime-paths";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI_PATH = path.join(ROOT, "src", "cli.ts");
const BUN = resolveBunRuntime();

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const autoFixRecommendationKey = (input: {
  readonly summary: string;
  readonly scope: string;
  readonly anomalyPatterns: ReadonlyArray<string>;
}): string =>
  createHash("sha1")
    .update(JSON.stringify({
      summary: input.summary.trim().toLowerCase().replace(/\s+/g, " "),
      scope: input.scope.trim().toLowerCase().replace(/\s+/g, " "),
      anomalyPatterns: [...new Set(input.anomalyPatterns.map((pattern) =>
        pattern.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))).values()].sort(),
    }))
    .digest("hex")
    .slice(0, 16);

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

const createFactoryService = async (opts?: {
  readonly taskMode?: "investigation" | "delivery";
  readonly taskResult?: Record<string, unknown>;
  readonly alignment?: {
    readonly verdict: "aligned" | "uncertain" | "drifted";
    readonly satisfied?: ReadonlyArray<string>;
    readonly missing?: ReadonlyArray<string>;
    readonly outOfScope?: ReadonlyArray<string>;
    readonly rationale?: string;
  };
}): Promise<{
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
        const raw = JSON.stringify(opts?.taskResult ?? (opts?.taskMode === "delivery"
          ? {
              outcome: "approved",
              summary: "Delivered the requested change and reported the alignment result.",
              handoff: "The delivery task completed with an explicit alignment report for the controller.",
              artifacts: [],
              scriptsRun: [],
              completion: {
                changed: ["Updated README.md in the task workspace."],
                proof: ["README.md was updated by the worker stub."],
                remaining: [],
              },
              alignment: {
                verdict: opts?.alignment?.verdict ?? "aligned",
                satisfied: opts?.alignment?.satisfied ? [...opts.alignment.satisfied] : ["Implemented the requested delivery change."],
                missing: opts?.alignment?.missing ? [...opts.alignment.missing] : [],
                outOfScope: opts?.alignment?.outOfScope ? [...opts.alignment.outOfScope] : [],
                rationale: opts?.alignment?.rationale ?? "The worker explicitly mapped the delivery result back to the objective contract.",
              },
              nextAction: null,
            }
          : {
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
            }));
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

test("factory CLI investigate prefers real task artifacts over stale repo-root collisions", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService();
  const created = await service.createObjective({
    title: "Investigate artifact resolution",
    prompt: "Use factory investigate to reconstruct the task context and result from the live task packet.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, created.objectiveId);
  const [job] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(job).toBeTruthy();
  await service.runTask(job!.payload as FactoryTaskJobPayload);

  const staleArtifactDir = path.join(repoRoot, ".receipt", "factory");
  await fs.mkdir(staleArtifactDir, { recursive: true });
  await fs.writeFile(path.join(staleArtifactDir, "task_01.result.json"), JSON.stringify({
    outcome: "approved",
    summary: "stale repo-root artifact",
    artifacts: [],
    completion: {
      changed: ["wrong"],
      proof: ["wrong"],
      remaining: [],
    },
    nextAction: null,
  }, null, 2), "utf-8");

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
    readonly outputs: {
      readonly result?: {
        readonly summary?: string;
      };
    };
    readonly packetContext?: {
      readonly manifestPath?: string;
      readonly contextPackPath?: string;
      readonly resultPath?: string;
      readonly contractCriteria: ReadonlyArray<string>;
    };
  };
  expect(payload.outputs.result?.summary).toBe("Investigated the receipt flow and recorded a focused handoff.");
  expect(payload.packetContext?.manifestPath?.startsWith(dataDir)).toBe(true);
  expect(payload.packetContext?.contextPackPath?.startsWith(dataDir)).toBe(true);
  expect(payload.packetContext?.resultPath?.startsWith(dataDir)).toBe(true);
  expect(payload.packetContext?.contractCriteria.length).toBeGreaterThan(0);
}, 120_000);

test("factory task packets omit live cloud context for local repo investigations", async () => {
  const { service, queue } = await createFactoryService();
  const created = await service.createObjective({
    title: "Inspect local repo state",
    prompt: "Inspect only the local git repository state. Do not use network.",
    objectiveMode: "investigation",
    severity: 1,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, created.objectiveId);
  const [job] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(job).toBeTruthy();
  await service.runTask(job!.payload as FactoryTaskJobPayload);

  const payload = job!.payload as FactoryTaskJobPayload;
  const contextPack = JSON.parse(await fs.readFile(payload.contextPackPath, "utf-8")) as {
    readonly cloudExecutionContext?: unknown;
  };
  const prompt = await fs.readFile(payload.promptPath, "utf-8");

  expect(contextPack.cloudExecutionContext).toBeUndefined();
  expect(prompt).not.toContain("## Live Cloud Context");
}, 120_000);

test("factory CLI investigate surfaces contract and alignment state for delivery objectives", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService({
    taskMode: "delivery",
    alignment: {
      verdict: "uncertain",
      satisfied: ["Updated the requested file."],
      missing: ["Confirm the shipped behavior fully satisfies the delivery objective."],
      outOfScope: [],
      rationale: "The worker changed the file but left contract satisfaction uncertain.",
    },
  });
  const created = await service.createObjective({
    title: "Investigate delivery alignment",
    prompt: "Apply a small delivery change and record alignment against the objective contract.",
    severity: 2,
    checks: [],
    profileId: "software",
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
    maxBuffer: 16 * 1024 * 1024,
  });

  const payload = JSON.parse(jsonRun.stdout) as {
    readonly packetContext?: {
      readonly summaryText?: string;
    };
    readonly assessment: {
      readonly correctiveSteerIssued?: boolean;
    };
  };
  expect(payload.packetContext?.summaryText).toContain("Objective Contract");
  expect(payload.assessment.correctiveSteerIssued).toBe(true);
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
    recommendationGenerator: async () => [{
      summary: "Persist structured investigation evidence in the audit artifact and memory surfaces.",
      anomalyPatterns: ["missing_structured_evidence"],
      scope: "src/services/factory-runtime.ts",
      confidence: "medium",
      suggestedFix: "Persist audit-generated recommendations in objective.audit.json and render them back through investigation and audit readers.",
    }],
  }) as {
    readonly objectiveId: string;
    readonly verdict: string;
    readonly jsonPath: string;
    readonly textPath: string;
    readonly recommendations: number;
  };

  expect(result.objectiveId).toBe(created.objectiveId);
  expect(result.verdict).toBeTruthy();
  expect(result.recommendations).toBe(1);
  expect(await fs.stat(result.jsonPath).then(() => true).catch(() => false)).toBe(true);
  expect(await fs.stat(result.textPath).then(() => true).catch(() => false)).toBe(true);

  const persistedAudit = JSON.parse(await fs.readFile(result.jsonPath, "utf-8")) as {
    readonly audit?: {
      readonly recommendations?: ReadonlyArray<{
        readonly summary: string;
      }>;
    };
  };
  expect(persistedAudit.audit?.recommendations?.[0]?.summary ?? "").toContain("Persist structured investigation evidence");

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
  expect(objectiveAuditMemory.some((entry) => entry.text.includes("alignment="))).toBe(true);

  const reloaded = await readFactoryReceiptInvestigation(dataDir, repoRoot, created.objectiveId);
  expect(reloaded.recommendations[0]?.summary ?? "").toContain("Persist structured investigation evidence");
}, 120_000);

test("factory objective audit records recommendation generation failures instead of silently dropping them", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService();
  const created = await service.createObjective({
    title: "Record recommendation generation failures",
    prompt: "Finish an investigation so audit failures are visible to operators instead of silently disappearing.",
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
    recommendationGenerator: async () => {
      throw new Error("LLM offline during recommendation generation");
    },
  }) as {
    readonly recommendationStatus: string;
    readonly recommendationError?: string;
    readonly jsonPath: string;
  };

  expect(result.recommendationStatus).toBe("failed");
  expect(result.recommendationError).toContain("LLM offline during recommendation generation");

  const persistedAudit = JSON.parse(await fs.readFile(result.jsonPath, "utf-8")) as {
    readonly audit?: {
      readonly recommendationStatus?: string;
      readonly recommendationError?: string;
    };
  };
  expect(persistedAudit.audit?.recommendationStatus).toBe("failed");
  expect(persistedAudit.audit?.recommendationError ?? "").toContain("LLM offline during recommendation generation");

  const objectiveAuditMemory = await service.memoryTools!.read({
    scope: `factory/audits/objectives/${created.objectiveId}`,
    limit: 5,
  });
  expect(objectiveAuditMemory.some((entry) =>
    entry.text.includes("generation_failed")
    && entry.text.includes("LLM offline during recommendation generation")
  )).toBe(true);

  const reloaded = await readFactoryReceiptInvestigation(dataDir, repoRoot, created.objectiveId);
  expect(reloaded.audit?.recommendationStatus).toBe("failed");
  expect(reloaded.warnings.some((warning) => warning.includes("LLM offline during recommendation generation"))).toBe(true);
  expect(reloaded.recommendations).toEqual([]);
}, 120_000);

test("factory objective audit creates an auto-fix objective for recurring high-confidence patterns", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService();
  const created = await service.createObjective({
    title: "Create auto-fix from recurring audit pattern",
    prompt: "Finish an investigation so the audit job can decide whether to trigger a follow-up objective.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, created.objectiveId);
  const [job] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(job).toBeTruthy();
  await service.runTask(job!.payload as FactoryTaskJobPayload);

  for (let index = 0; index < 5; index += 1) {
    const historicalObjectiveId = `objective_hist_audit_${index + 1}`;
    const historicalArtifactDir = path.join(dataDir, "factory", "artifacts", historicalObjectiveId);
    await fs.mkdir(historicalArtifactDir, { recursive: true });
    await fs.writeFile(path.join(historicalArtifactDir, "objective.audit.json"), JSON.stringify({
      requestedId: historicalObjectiveId,
      links: { objectiveId: historicalObjectiveId },
      summary: { status: "completed" },
      audit: {
        generatedAt: Date.now() - (index + 1) * 1_000,
        recommendationStatus: "ready",
        recommendations: [{
          summary: "Stabilize lease handling for long-running Factory work.",
          anomalyPatterns: ["lease_expired"],
          scope: "src/services/factory-runtime.ts",
          confidence: "high",
          suggestedFix: "Add progress heartbeats and split long-running work into bounded steps so leases do not expire.",
        }],
        recurringPatterns: [{ pattern: "lease_expired", count: 1 }],
      },
    }, null, 2), "utf-8");
    await service.memoryTools!.commit({
      scope: "factory/audits/repo",
      text: `[${historicalObjectiveId}] Summary\n${historicalObjectiveId} finished completed with verdict=weak.\n\nRecommendations\n- [high] scope=src/services/factory-runtime.ts patterns=lease_expired Stabilize lease handling for long-running Factory work.`,
      tags: ["factory", "audit", "repo", "completed", "weak"],
    });
  }

  const result = await runFactoryObjectiveAudit({
    dataDir,
    repoRoot,
    memoryTools: service.memoryTools!,
    factoryService: service,
    payload: {
      kind: "factory.objective.audit",
      objectiveId: created.objectiveId,
      objectiveStatus: "completed",
      objectiveUpdatedAt: Date.now(),
    },
    recommendationGenerator: async () => [{
      summary: "Reduce lease expiry during long-running Factory jobs.",
      anomalyPatterns: ["lease_expired"],
      scope: "src/services/factory-runtime.ts",
      confidence: "high",
      suggestedFix: "Add periodic heartbeats or progress updates for long-running worker steps and break large operations into smaller bounded units.",
    }],
  }) as {
    readonly autoFixObjectiveId?: string;
    readonly recommendations: number;
  };

  expect(result.recommendations).toBe(1);
  expect(result.autoFixObjectiveId).toBeTruthy();
  const autoFixObjective = await service.getObjective(result.autoFixObjectiveId!);
  expect(autoFixObjective.channel).toBe("auto-fix");
  expect(autoFixObjective.objectiveMode).toBe("delivery");
  expect(autoFixObjective.prompt).toContain("lease_expired");

  const objectiveAuditMemory = await service.memoryTools!.read({
    scope: `factory/audits/objectives/${created.objectiveId}`,
    limit: 5,
  });
  expect(objectiveAuditMemory.some((entry) =>
    entry.text.includes("Auto-fix")
    && entry.text.includes(result.autoFixObjectiveId!)
  )).toBe(true);
}, 120_000);

test("factory objective audit reuses an existing open auto-fix objective for the same recurring pattern", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService();
  const created = await service.createObjective({
    title: "Reuse auto-fix objective",
    prompt: "Finish an investigation so the audit can reuse an existing follow-up objective instead of creating duplicates.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, created.objectiveId);
  const [job] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(job).toBeTruthy();
  await service.runTask(job!.payload as FactoryTaskJobPayload);

  for (let index = 0; index < 5; index += 1) {
    const historicalObjectiveId = `objective_hist_reuse_${index + 1}`;
    const historicalArtifactDir = path.join(dataDir, "factory", "artifacts", historicalObjectiveId);
    await fs.mkdir(historicalArtifactDir, { recursive: true });
    await fs.writeFile(path.join(historicalArtifactDir, "objective.audit.json"), JSON.stringify({
      requestedId: historicalObjectiveId,
      links: { objectiveId: historicalObjectiveId },
      summary: { status: "completed" },
      audit: {
        generatedAt: Date.now() - (index + 1) * 1_000,
        recommendationStatus: "ready",
        recommendations: [{
          summary: "Reduce lease expiry during long-running Factory jobs.",
          anomalyPatterns: ["lease_expired"],
          scope: "src/services/factory-runtime.ts",
          confidence: "high",
          suggestedFix: "Add periodic heartbeats or progress updates for long-running worker steps and break large operations into smaller bounded units.",
        }],
        recurringPatterns: [{ pattern: "lease_expired", count: 1 }],
      },
    }, null, 2), "utf-8");
    await service.memoryTools!.commit({
      scope: "factory/audits/repo",
      text: `[${historicalObjectiveId}] Summary\n${historicalObjectiveId} finished completed with verdict=weak.\n\nRecommendations\n- [high] scope=src/services/factory-runtime.ts patterns=lease_expired Reduce lease expiry during long-running Factory jobs.`,
      tags: ["factory", "audit", "repo", "completed", "weak"],
    });
  }

  const existingAutoFixKey = autoFixRecommendationKey({
    summary: "Reduce lease expiry during long-running Factory jobs.",
    scope: "src/services/factory-runtime.ts",
    anomalyPatterns: ["lease_expired"],
  });
  const existingAutoFix = await service.createObjective({
    title: "Reduce lease expiry during long-running Factory jobs.",
    prompt: [
      "Auto-fix triggered by recurring audit recommendation.",
      "",
      "## Recommendation",
      "Add periodic heartbeats or progress updates for long-running worker steps and break large operations into smaller bounded units.",
      "",
      "## Scope",
      "src/services/factory-runtime.ts",
      "",
      "## Recurring Patterns (lease_expired)",
      "- lease_expired: 5 occurrence(s)",
      "",
      "## Audit Deduplication",
      `factory_auto_fix_key:${existingAutoFixKey}`,
    ].join("\n"),
    objectiveMode: "delivery",
    severity: 1,
    channel: "auto-fix",
    startImmediately: false,
  });
  const beforeObjectiveIds = (await service.listObjectives()).map((objective) => objective.objectiveId).sort();

  const result = await runFactoryObjectiveAudit({
    dataDir,
    repoRoot,
    memoryTools: service.memoryTools!,
    factoryService: service,
    payload: {
      kind: "factory.objective.audit",
      objectiveId: created.objectiveId,
      objectiveStatus: "completed",
      objectiveUpdatedAt: Date.now(),
    },
    recommendationGenerator: async () => [{
      summary: "Reduce lease expiry during long-running Factory jobs.",
      anomalyPatterns: ["lease_expired"],
      scope: "src/services/factory-runtime.ts",
      confidence: "high",
      suggestedFix: "Add periodic heartbeats or progress updates for long-running worker steps and break large operations into smaller bounded units.",
    }],
  }) as {
    readonly autoFixObjectiveId?: string;
  };

  const afterObjectiveIds = (await service.listObjectives()).map((objective) => objective.objectiveId).sort();
  expect(result.autoFixObjectiveId).toBe(existingAutoFix.objectiveId);
  expect(afterObjectiveIds).toEqual(beforeObjectiveIds);
}, 120_000);

test("factory objective audit ignores late sidecar failures that happen after objective completion", async () => {
  const { service, queue, repoRoot, dataDir } = await createFactoryService({
    taskResult: {
      outcome: "approved",
      summary: "Investigated the receipt flow with concrete evidence and a clean handoff.",
      handoff: "Use the captured commands and evidence bundle for any follow-up.",
      artifacts: [],
      completion: {
        status: "done",
        outcome: "complete",
        remainingWork: [],
      },
      report: {
        conclusion: "The objective completed with direct evidence and validation signal.",
        evidence: [{ kind: "command", summary: "git status --short stayed clean." }],
        scriptsRun: [{ command: "git status --short", exitCode: 0 }],
        disagreements: [],
        nextSteps: [],
      },
    },
  });
  const created = await service.createObjective({
    title: "Snapshot audit objective",
    prompt: "Finish an investigation with enough evidence to score as a strong run.",
    objectiveMode: "investigation",
    severity: 2,
    checks: [],
    profileId: "generalist",
  });
  await runObjectiveStartup(service, created.objectiveId);
  const [job] = await objectiveTaskJobs(queue, created.objectiveId);
  expect(job).toBeTruthy();
  await service.runTask(job!.payload as FactoryTaskJobPayload);

  const completed = await service.getObjective(created.objectiveId);
  expect(completed.status).toBe("completed");

  const lateJob = await queue.enqueue({
    agentId: "codex",
    lane: "collect",
    payload: {
      kind: "factory.task.monitor",
      objectiveId: created.objectiveId,
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
      stream: `factory/objectives/${created.objectiveId}`,
    },
    maxAttempts: 1,
  });
  expect(await queue.leaseJob(lateJob.id, "audit-test-worker", 60_000)).toBeTruthy();
  await queue.fail(
    lateJob.id,
    "audit-test-worker",
    "lease expired after completion",
    true,
    { summary: "lease expired after completion" },
  );

  const liveReport = await readFactoryReceiptInvestigation(dataDir, repoRoot, created.objectiveId);
  expect(liveReport.assessment.verdict).toBe("mixed");
  expect(liveReport.jobs.some((entry) => entry.jobId === lateJob.id)).toBe(true);

  const snapshotReport = await readFactoryReceiptInvestigation(
    dataDir,
    repoRoot,
    created.objectiveId,
    { asOfTs: completed.updatedAt },
  );
  expect(snapshotReport.assessment.verdict).toBe("strong");
  expect(snapshotReport.jobs.some((entry) => entry.jobId === lateJob.id)).toBe(false);

  const result = await runFactoryObjectiveAudit({
    dataDir,
    repoRoot,
    memoryTools: service.memoryTools!,
    payload: {
      kind: "factory.objective.audit",
      objectiveId: created.objectiveId,
      objectiveStatus: completed.status,
      objectiveUpdatedAt: completed.updatedAt,
    },
  }) as {
    readonly verdict: string;
  };
  expect(result.verdict).toBe("strong");
}, 120_000);
