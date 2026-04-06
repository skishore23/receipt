import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntime } from "@receipt/core/runtime";
import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { runReceiptDstAudit } from "../../src/cli/dst";
import { resolveBunRuntime } from "../../src/lib/runtime-paths";
import {
  DEFAULT_FACTORY_OBJECTIVE_POLICY,
  DEFAULT_FACTORY_OBJECTIVE_PROFILE,
} from "../../src/modules/factory";
import { decide as decideJob, initial as initialJobState, reduce as reduceJob, type JobCmd, type JobEvent } from "../../src/modules/job";
import { buildFactoryMemoryScriptSource } from "../../src/services/factory-codex-artifacts";
import {
  archiveFactoryTaskPacketArtifacts,
  archiveFactoryTaskPrompt,
} from "../../src/services/factory-task-packet-archive";
import { buildTaskFilePaths } from "../../src/services/factory/task-packets";

type GenericEvent = Record<string, unknown> & {
  readonly type: string;
};

type GenericCmd = {
  readonly type: "emit";
  readonly event: GenericEvent;
  readonly eventId: string;
};

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(ROOT, "src", "cli.ts");
const BUN = resolveBunRuntime();

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const createGenericRuntime = (dataDir: string) =>
  createRuntime<GenericCmd, GenericEvent, { readonly ok: true }>(
    sqliteReceiptStore<GenericEvent>(dataDir),
    sqliteBranchStore(dataDir),
    (cmd) => [cmd.event],
    (state) => state,
    { ok: true },
  );

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, typeof initialJobState>(
    sqliteReceiptStore<JobEvent>(dataDir),
    sqliteBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJobState,
  );

const seedEvents = async (
  dataDir: string,
  stream: string,
  events: ReadonlyArray<GenericEvent>,
): Promise<void> => {
  const runtime = createGenericRuntime(dataDir);
  for (const [index, event] of events.entries()) {
    await runtime.execute(stream, {
      type: "emit",
      event,
      eventId: `${stream}:${index + 1}`,
    });
  }
};

const seedJobEvents = async (
  dataDir: string,
  stream: string,
  events: ReadonlyArray<JobEvent>,
): Promise<void> => {
  const runtime = createJobRuntime(dataDir);
  for (const [index, event] of events.entries()) {
    await runtime.execute(stream, {
      type: "emit",
      event,
      eventId: `${stream}:${index + 1}`,
    });
  }
};

const createFactoryTaskPacketFixture = async (opts: {
  readonly objectiveId?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly jobId?: string;
  readonly guidanceMessage?: string;
  readonly promptOverrides?: {
    readonly omitManifestPath?: boolean;
    readonly omitContextPackPath?: boolean;
    readonly omitMemoryScriptPath?: boolean;
    readonly omitGuidanceSection?: boolean;
  };
  readonly skipMemoryScript?: boolean;
} = {}): Promise<{
  readonly workspacePath: string;
  readonly payload: Record<string, unknown>;
}> => {
  const objectiveId = opts.objectiveId ?? "objective_context_dst";
  const taskId = opts.taskId ?? "task_01";
  const candidateId = opts.candidateId ?? "candidate_01";
  const jobId = opts.jobId ?? "job_context_dst";
  const workspacePath = await createTempDir("receipt-dst-context-workspace");
  const files = buildTaskFilePaths(workspacePath, taskId);
  await fs.mkdir(path.dirname(files.manifestPath), { recursive: true });
  await fs.writeFile(files.skillBundlePath, JSON.stringify({ skills: [] }, null, 2), "utf-8");

  const memoryScopes = [
    { key: "agent", scope: "factory/agents/codex", label: "Agent memory", defaultQuery: "context", readOnly: true },
    { key: "repo", scope: "factory/repo/shared", label: "Repo shared memory", defaultQuery: "context", readOnly: true },
    { key: "objective", scope: `factory/objectives/${objectiveId}`, label: "Objective memory", defaultQuery: objectiveId },
    { key: "task", scope: `factory/objectives/${objectiveId}/tasks/${taskId}`, label: "Task memory", defaultQuery: taskId },
    { key: "candidate", scope: `factory/objectives/${objectiveId}/candidates/${candidateId}`, label: "Candidate memory", defaultQuery: candidateId },
    { key: "integration", scope: `factory/objectives/${objectiveId}/integration`, label: "Integration memory", defaultQuery: "integration" },
  ];
  const profile = {
    ...DEFAULT_FACTORY_OBJECTIVE_PROFILE,
    rootProfileId: "generalist",
    rootProfileLabel: "Generalist",
    promptPath: "profiles/generalist/PROFILE.md",
    selectedSkills: ["skills/factory-receipt-worker/SKILL.md"],
    objectivePolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
    cloudProvider: "aws",
  };
  const sharedArtifactRefs = [{ kind: "artifact", ref: "README.md", label: "readme" }];
  const contextRefs = [{ kind: "artifact", ref: files.contextPackPath, label: "context pack" }];
  const payload = {
    kind: "factory.task.run",
    objectiveId,
    taskId,
    workerType: "codex",
    objectiveMode: "delivery",
    severity: 2,
    candidateId,
    baseCommit: "abc123",
    executionMode: "worktree",
    workspaceId: "workspace_01",
    workspacePath,
    promptPath: files.promptPath,
    resultPath: files.resultPath,
    stdoutPath: files.stdoutPath,
    stderrPath: files.stderrPath,
    lastMessagePath: files.lastMessagePath,
    evidencePath: files.evidencePath,
    manifestPath: files.manifestPath,
    contextSummaryPath: files.contextSummaryPath,
    contextPackPath: files.contextPackPath,
    memoryScriptPath: files.memoryScriptPath,
    memoryConfigPath: files.memoryConfigPath,
    repoSkillPaths: ["skills/factory-receipt-worker/SKILL.md"],
    skillBundlePaths: [files.skillBundlePath],
    profile,
    profilePromptHash: "prompt_hash_01",
    profileSkillRefs: ["skills/factory-receipt-worker/SKILL.md"],
    sharedArtifactRefs,
    contextRefs,
    problem: "Audit whether the worker packet has the right context.",
    config: {},
  } satisfies Record<string, unknown>;
  const contextSources = {
    repoSharedMemoryScope: "factory/repo/shared",
    objectiveMemoryScope: `factory/objectives/${objectiveId}`,
    integrationMemoryScope: `factory/objectives/${objectiveId}/integration`,
    profileSkillRefs: payload.profileSkillRefs,
    repoSkillPaths: payload.repoSkillPaths,
    sharedArtifactRefs,
  };
  const manifest = {
    objective: {
      objectiveId,
      title: "Context DST objective",
      prompt: "Confirm the worker bootstrap packet stays aligned.",
      baseHash: "abc123",
      objectiveMode: "delivery",
      severity: 2,
      checks: ["bun run verify"],
    },
    profile,
    task: {
      taskId,
      title: "Check worker context",
      prompt: "Read the packet before acting.",
      workerType: "codex",
      executionMode: "worktree",
      baseCommit: "abc123",
      dependsOn: [],
    },
    candidate: {
      candidateId,
      taskId,
    },
    integration: {
      status: "idle",
    },
    contract: {
      acceptanceCriteria: ["worker packet is self-consistent"],
      allowedScope: ["receipt context audit"],
      disallowedScope: ["unbounded repo exploration"],
      requiredChecks: ["bun run verify"],
      proofExpectation: "packet artifacts",
    },
    memory: {
      scriptPath: files.memoryScriptPath,
      configPath: files.memoryConfigPath,
      scopes: memoryScopes,
    },
    context: {
      summaryPath: files.contextSummaryPath,
      packPath: files.contextPackPath,
    },
    contextSources,
    contextRefs,
    sharedArtifactRefs,
    repoSkillPaths: payload.repoSkillPaths,
    skillBundlePaths: payload.skillBundlePaths,
    traceRefs: [],
  };
  const contextPack = {
    objectiveId,
    title: "Context DST objective",
    prompt: "Confirm the worker bootstrap packet stays aligned.",
    objectiveMode: "delivery",
    severity: 2,
    contract: manifest.contract,
    profile,
    task: {
      taskId,
      title: "Check worker context",
      prompt: "Read the packet before acting.",
      workerType: "codex",
      executionMode: "worktree",
      status: "running",
      candidateId,
    },
    integration: {
      status: "idle",
    },
    dependencyTree: [],
    relatedTasks: [{
      taskId,
      taskKind: "planned",
      title: "Check worker context",
      status: "running",
      workerType: "codex",
      relations: ["focus"],
    }],
    candidateLineage: [{
      candidateId,
      status: "running",
      summary: "First pass",
    }],
    recentReceipts: [{
      type: "task.dispatched",
      at: 1,
      taskId,
      candidateId,
      summary: "Task dispatched for execution.",
    }],
    objectiveSlice: {
      frontierTasks: [{
        taskId,
        taskKind: "planned",
        title: "Check worker context",
        status: "running",
        workerType: "codex",
        relations: ["focus"],
      }],
      recentCompletedTasks: [],
      integrationTasks: [],
      recentObjectiveReceipts: [{
        type: "objective.created",
        at: 1,
        summary: "Objective created.",
      }],
      objectiveMemorySummary: "Objective memory summary.",
      integrationMemorySummary: "Integration memory summary.",
    },
    memory: {
      overview: "Use the packet before broader memory.",
      objective: "Objective memory summary.",
      integration: "Integration memory summary.",
      repoAudit: "No known repo-wide audit issue.",
    },
    investigation: {
      reports: [],
    },
    helperCatalog: {
      runnerPath: "skills/factory-helper-runtime/runner.py",
      guidance: ["Prefer checked-in helpers when repeated CLI steps would be lossy."],
      selectedHelpers: [{
        id: "aws_resource_inventory",
        description: "Collect AWS inventory evidence.",
        tags: ["aws", "inventory"],
        manifestPath: "skills/factory-helper-runtime/catalog/aws_resource_inventory/manifest.json",
        entrypointPath: "skills/factory-helper-runtime/catalog/aws_resource_inventory/run.py",
        requiredArgs: ["--region"],
        requiredContext: ["aws credentials"],
        examples: ["--region us-west-2"],
      }],
    },
    contextSources,
    cloudExecutionContext: {
      preferredProvider: "aws",
      availableProviders: ["aws"],
      activeProviders: ["aws"],
      summary: "AWS credentials are mounted for this profile.",
    },
  };
  const memoryConfig = {
    objectiveId,
    taskId,
    candidateId,
    contextSummaryPath: path.basename(files.contextSummaryPath),
    contextPackPath: path.basename(files.contextPackPath),
    defaultQuery: "Context DST objective\nCheck worker context\nRead the packet before acting.",
    defaultLimit: 6,
    defaultMaxChars: 2400,
    scopes: memoryScopes,
  };
  const promptLines = [
    "# Factory Task",
    "",
    "## Helper-First Execution",
    "Use the checked-in helper runner at skills/factory-helper-runtime/runner.py.",
    "- helper: aws_resource_inventory | Collect AWS inventory evidence. | tags aws, inventory",
    "",
    "## Live Cloud Context",
    "AWS credentials are mounted for this profile.",
    "",
    "## Bootstrap Context",
    "The prompt is bootstrap only.",
    "Follow the checked-in worker bootstrap order: manifest, context pack, then memory script.",
    "Read, in order:",
    "1. AGENTS.md and skills/factory-receipt-worker/SKILL.md",
    ...(opts.promptOverrides?.omitManifestPath ? [] : [`2. Manifest: ${files.manifestPath}`]),
    ...(opts.promptOverrides?.omitContextPackPath ? [] : [`3. Context Pack: ${files.contextPackPath}`]),
    ...(opts.promptOverrides?.omitMemoryScriptPath ? [] : [`4. Memory Script: ${files.memoryScriptPath}`]),
    `5. Task Context Summary (quick overview derived from the packet): ${files.contextSummaryPath}`,
    "Do not call `receipt factory inspect` from inside this task worktree.",
    ...(opts.guidanceMessage && !opts.promptOverrides?.omitGuidanceSection
      ? ["", "## Live Operator Guidance", "", `1. ${opts.guidanceMessage}`]
      : []),
  ];

  await fs.writeFile(files.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  await fs.writeFile(files.contextPackPath, JSON.stringify(contextPack, null, 2), "utf-8");
  await fs.writeFile(files.contextSummaryPath, [
    "# Factory Task Context Summary",
    "",
    "## Packet Usage",
    "Use the packet before broader exploration.",
  ].join("\n"), "utf-8");
  await fs.writeFile(files.promptPath, promptLines.join("\n"), "utf-8");
  await fs.writeFile(files.memoryConfigPath, JSON.stringify(memoryConfig, null, 2), "utf-8");
  if (!opts.skipMemoryScript) {
    await fs.writeFile(files.memoryScriptPath, buildFactoryMemoryScriptSource(files.memoryConfigPath), "utf-8");
  }
  await fs.writeFile(files.lastMessagePath, "Structured result pending.", "utf-8");

  return {
    workspacePath,
    payload,
  };
};

const runCli = (
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> =>
  new Promise((resolve) => {
    const child = spawn(BUN, [CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...env,
      },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("receipt dst audit summarizes mixed receipt streams deterministically", async () => {
  const dataDir = await createTempDir("receipt-dst-audit");
  try {
    await seedEvents(dataDir, "factory/objectives/objective_demo", [
      {
        type: "objective.created",
        objectiveId: "objective_demo",
        title: "DST objective",
        prompt: "Audit the receipt stream.",
        channel: "results",
        baseHash: "abc123",
        objectiveMode: "delivery",
        severity: 2,
        checks: ["bun run build"],
        checksSource: "explicit",
        profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
        policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
        createdAt: 1,
      },
      {
        type: "objective.completed",
        objectiveId: "objective_demo",
        summary: "Completed by replay.",
        completedAt: 2,
      },
    ]);

    await seedEvents(dataDir, "jobs/job_demo", [
      {
        type: "job.enqueued",
        jobId: "job_demo",
        agentId: "factory-chat",
        lane: "collect",
        payload: { kind: "demo.run" },
        maxAttempts: 2,
      },
      {
        type: "job.leased",
        jobId: "job_demo",
        workerId: "worker_1",
        leaseMs: 10_000,
        attempt: 1,
      },
      {
        type: "job.completed",
        jobId: "job_demo",
        workerId: "worker_1",
        result: { ok: true },
      },
    ]);

    await seedEvents(dataDir, "agents/demo/runs/run_history", [
      {
        type: "problem.set",
        runId: "run_history",
        problem: "Summarize this run.",
      },
      {
        type: "run.status",
        runId: "run_history",
        status: "running",
      },
      {
        type: "tool.called",
        runId: "run_history",
        iteration: 1,
        tool: "receipt.trace",
        input: {},
      },
      {
        type: "response.finalized",
        runId: "run_history",
        content: "All done.",
      },
      {
        type: "run.status",
        runId: "run_history",
        status: "completed",
      },
    ]);

    await seedEvents(dataDir, "agents/demo/runs/run_control", [
      {
        type: "run.started",
        runId: "run_control",
        agentId: "demo",
        agentVersion: "1.0.0",
        runtimePolicyVersion: "runtime-policy-v1",
      },
      {
        type: "action.selected",
        runId: "run_control",
        actionIds: ["draft"],
        reason: "priority-order (scheduler-v2)",
        policyVersion: "scheduler-v2",
      },
      {
        type: "action.started",
        runId: "run_control",
        actionId: "draft",
        kind: "assistant",
      },
      {
        type: "action.completed",
        runId: "run_control",
        actionId: "draft",
        kind: "assistant",
      },
      {
        type: "goal.completed",
        runId: "run_control",
      },
      {
        type: "run.completed",
        runId: "run_control",
      },
    ]);

    const report = await runReceiptDstAudit(dataDir);

    expect(report.streamCount).toBe(4);
    expect(report.integrityFailures).toBe(0);
    expect(report.replayFailures).toBe(0);
    expect(report.deterministicFailures).toBe(0);
    expect(report.kinds["factory.objective"]).toBe(1);
    expect(report.kinds.job).toBe(1);
    expect(report.kinds["agent.history"]).toBe(1);
    expect(report.kinds["agent.control"]).toBe(1);
    expect(report.statusCounts["factory.objective"]?.completed).toBe(1);
    expect(report.statusCounts.job?.completed).toBe(1);
    expect(report.statusCounts["agent.history"]?.completed).toBe(1);
    expect(report.statusCounts["agent.control"]?.completed).toBe(1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("receipt dst --strict exits non-zero when replay issues are found", async () => {
  const dataDir = await createTempDir("receipt-dst-strict");
  try {
    await seedEvents(dataDir, "jobs/job_broken", [
      {
        type: "job.completed",
        jobId: "job_broken",
        workerId: "worker_1",
      },
    ]);

    const result = await runCli(["dst", "--json", "--strict"], {
      RECEIPT_DATA_DIR: dataDir,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DST audit found receipt issues");

    const payload = JSON.parse(result.stdout) as {
      readonly replayFailures: number;
      readonly streams: ReadonlyArray<{
        readonly stream: string;
        readonly replay: {
          readonly ok: boolean;
          readonly error?: string;
        };
      }>;
    };
    expect(payload.replayFailures).toBe(1);
    expect(payload.streams[0]?.stream).toBe("jobs/job_broken");
    expect(payload.streams[0]?.replay.ok).toBe(false);
    expect(payload.streams[0]?.replay.error).toContain("Invariant");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("receipt dst agent control summary uses the latest run start on repeated runs", async () => {
  const dataDir = await createTempDir("receipt-dst-control-latest");
  try {
    await seedEvents(dataDir, "agents/demo/runs/run_control", [
      {
        type: "run.started",
        runId: "run_1",
        agentId: "demo",
        agentVersion: "1.0.0",
        runtimePolicyVersion: "runtime-policy-v1",
      },
      {
        type: "run.failed",
        runId: "run_1",
        error: "first attempt failed",
      },
      {
        type: "run.started",
        runId: "run_2",
        agentId: "demo",
        agentVersion: "2.0.0",
        runtimePolicyVersion: "runtime-policy-v2",
      },
      {
        type: "run.completed",
        runId: "run_2",
      },
    ]);

    const report = await runReceiptDstAudit(dataDir);
    const stream = report.streams.find((entry) => entry.stream === "agents/demo/runs/run_control");
    expect(stream?.kind).toBe("agent.control");
    if (stream?.summary.kind !== "agent.control") {
      throw new Error("expected agent.control summary");
    }
    expect(stream.summary.runId).toBe("run_2");
    expect(stream.summary.agentVersion).toBe("2.0.0");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("receipt dst context audit summarizes historical factory task packets deterministically", async () => {
  const dataDir = await createTempDir("receipt-dst-context");
  const { workspacePath, payload } = await createFactoryTaskPacketFixture({
    objectiveId: "objective_context_ok",
    taskId: "task_context_ok",
    candidateId: "candidate_context_ok",
    jobId: "job_context_ok",
    guidanceMessage: "Stay inside the packet and validate the bootstrap order before any broader search.",
  });
  try {
    await seedJobEvents(dataDir, "jobs/job_context_ok", [
      {
        type: "job.enqueued",
        jobId: "job_context_ok",
        agentId: "codex",
        lane: "collect",
        payload,
        maxAttempts: 2,
        sessionKey: "factory:objective_context_ok:task_context_ok",
        singletonMode: "allow",
        createdAt: 1,
      },
      {
        type: "job.leased",
        jobId: "job_context_ok",
        workerId: "worker_1",
        leaseMs: 60_000,
        attempt: 1,
      },
      {
        type: "queue.command",
        jobId: "job_context_ok",
        commandId: "cmd_steer_01",
        command: "steer",
        lane: "steer",
        payload: {
          message: "Stay inside the packet and validate the bootstrap order before any broader search.",
        },
        by: "factory-cli",
        createdAt: 2,
      },
      {
        type: "job.progress",
        jobId: "job_context_ok",
        workerId: "worker_1",
        result: {
          status: "running",
          summary: "Worker is reading the packet.",
          eventType: "turn.started",
        },
      },
      {
        type: "job.completed",
        jobId: "job_context_ok",
        workerId: "worker_1",
        result: {
          ok: true,
        },
      },
    ]);

    const report = await runReceiptDstAudit(dataDir, {
      includeContext: true,
      repoRoot: ROOT,
    });

    expect(report.context?.runCount).toBe(1);
    expect(report.context?.integrityFailures).toBe(0);
    expect(report.context?.replayFailures).toBe(0);
    expect(report.context?.deterministicFailures).toBe(0);
    expect(report.context?.runs[0]?.artifacts.prompt).toBe(true);
    expect(report.context?.runs[0]?.summary.profileId).toBe("generalist");
    expect(report.context?.runs[0]?.summary.cloudProvider).toBe("aws");
    expect(report.context?.runs[0]?.summary.helperCount).toBe(1);
    expect(report.context?.runs[0]?.summary.liveGuidanceCount).toBe(1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("receipt dst context audit falls back to archived task packets after workspace cleanup", async () => {
  const dataDir = await createTempDir("receipt-dst-context-archive");
  const { workspacePath, payload } = await createFactoryTaskPacketFixture({
    objectiveId: "objective_context_archive",
    taskId: "task_context_archive",
    candidateId: "candidate_context_archive",
    jobId: "job_context_archive",
  });
  try {
    await archiveFactoryTaskPacketArtifacts({
      dataDir,
      jobId: "job_context_archive",
      manifestPath: String(payload.manifestPath),
      contextSummaryPath: String(payload.contextSummaryPath),
      contextPackPath: String(payload.contextPackPath),
      memoryConfigPath: String(payload.memoryConfigPath),
      memoryScriptPath: String(payload.memoryScriptPath),
    });
    await archiveFactoryTaskPrompt({
      dataDir,
      jobId: "job_context_archive",
      prompt: await fs.readFile(String(payload.promptPath), "utf-8"),
    });
    await fs.rm(workspacePath, { recursive: true, force: true });

    await seedJobEvents(dataDir, "jobs/job_context_archive", [
      {
        type: "job.enqueued",
        jobId: "job_context_archive",
        agentId: "codex",
        lane: "collect",
        payload,
        maxAttempts: 1,
        sessionKey: "factory:objective_context_archive:task_context_archive",
        singletonMode: "allow",
        createdAt: 1,
      },
      {
        type: "job.leased",
        jobId: "job_context_archive",
        workerId: "worker_1",
        leaseMs: 60_000,
        attempt: 1,
      },
      {
        type: "job.completed",
        jobId: "job_context_archive",
        workerId: "worker_1",
      },
    ]);

    const report = await runReceiptDstAudit(dataDir, {
      includeContext: true,
      repoRoot: ROOT,
    });

    expect(report.context?.runCount).toBe(1);
    expect(report.context?.integrityFailures).toBe(0);
    expect(report.context?.runs[0]?.artifacts.manifest).toBe(true);
    expect(report.context?.runs[0]?.artifacts.prompt).toBe(true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("receipt dst --context --strict exits non-zero when packet context is out of sync", async () => {
  const dataDir = await createTempDir("receipt-dst-context-strict");
  const { workspacePath, payload } = await createFactoryTaskPacketFixture({
    objectiveId: "objective_context_bad",
    taskId: "task_context_bad",
    candidateId: "candidate_context_bad",
    jobId: "job_context_bad",
    skipMemoryScript: true,
  });
  try {
    await seedJobEvents(dataDir, "jobs/job_context_bad", [
      {
        type: "job.enqueued",
        jobId: "job_context_bad",
        agentId: "codex",
        lane: "collect",
        payload,
        maxAttempts: 1,
        sessionKey: "factory:objective_context_bad:task_context_bad",
        singletonMode: "allow",
        createdAt: 1,
      },
      {
        type: "job.leased",
        jobId: "job_context_bad",
        workerId: "worker_1",
        leaseMs: 60_000,
        attempt: 1,
      },
      {
        type: "job.completed",
        jobId: "job_context_bad",
        workerId: "worker_1",
      },
    ]);

    const result = await runCli(["dst", "--context", "--json", "--strict"], {
      RECEIPT_DATA_DIR: dataDir,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DST audit found receipt issues");

    const parsed = JSON.parse(result.stdout) as {
      readonly context?: {
        readonly integrityFailures: number;
        readonly runs: ReadonlyArray<{
          readonly integrity: {
            readonly ok: boolean;
            readonly error?: string;
          };
        }>;
      };
    };
    expect(parsed.context?.integrityFailures).toBe(1);
    expect(parsed.context?.runs[0]?.integrity.ok).toBe(false);
    expect(parsed.context?.runs[0]?.integrity.error).toContain("missing memory script");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
