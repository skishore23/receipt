import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntime } from "@receipt/core/runtime";
import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { getReceiptDb } from "../../src/db/client";
import { runReceiptDstAudit } from "../../src/cli/dst";
import { resolveBunRuntime } from "../../src/lib/runtime-paths";
import {
  DEFAULT_FACTORY_OBJECTIVE_POLICY,
  DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  type FactoryObjectiveContractRecord,
  type FactoryPlanningReceiptRecord,
  type FactoryState,
  type FactoryTaskRecord,
} from "../../src/modules/factory";
import { decide as decideJob, initial as initialJobState, reduce as reduceJob, type JobCmd, type JobEvent } from "../../src/modules/job";
import { buildFactoryMemoryScriptSource } from "../../src/services/factory-codex-artifacts";
import type { FactoryCloudExecutionContext } from "../../src/services/factory-cloud-context";
import type { FactoryHelperContext } from "../../src/services/factory-helper-catalog";
import {
  archiveFactoryTaskPacketArtifacts,
  archiveFactoryTaskPrompt,
} from "../../src/services/factory-task-packet-archive";
import type { FactoryTaskJobPayload } from "../../src/services/factory-types";
import {
  renderFactoryTaskPrompt,
  renderFactoryTaskValidationSection,
} from "../../src/services/factory/prompt-rendering";
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
    receiptCliPath: files.receiptCliPath,
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
    receiptCli: {
      surfacePath: files.receiptCliPath,
      factoryCliPrefix: "receipt",
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
    `5. Receipt CLI Surface: ${files.receiptCliPath}`,
    `6. Task Context Summary (quick overview derived from the packet): ${files.contextSummaryPath}`,
    `Use the generated Receipt CLI surface at ${files.receiptCliPath} before ad-hoc \`receipt ...\` commands.`,
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
  await fs.writeFile(files.receiptCliPath, [
    "# Factory Receipt CLI Surface",
    "",
    "Use this bounded CLI surface before broader receipt exploration.",
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

test("receipt dst audit tolerates empty historical objective streams", async () => {
  const dataDir = await createTempDir("receipt-dst-empty-objective");
  try {
    const db = getReceiptDb(dataDir);
    db.sqlite.query(`
      INSERT INTO streams (name, head_hash, receipt_count, updated_at, last_ts)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "factory/objectives/objective_empty_dst",
      null,
      0,
      Date.now(),
      null,
    );

    const report = await runReceiptDstAudit(dataDir, {
      prefix: "factory/objectives/",
    });
    const stream = report.streams.find((entry) => entry.stream === "factory/objectives/objective_empty_dst");

    expect(stream).toBeTruthy();
    expect(stream?.kind).toBe("factory.objective");
    expect(stream?.receiptCount).toBe(0);
    expect(stream?.replay.ok).toBe(true);
    expect(stream?.deterministic.ok).toBe(true);
    expect(stream?.summary.kind).toBe("factory.objective");
    expect(stream?.summary.taskCount).toBe(0);
    expect(stream?.summary.candidateCount).toBe(0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("receipt dst audit tolerates historical objective events unknown to the current reducer", async () => {
  const dataDir = await createTempDir("receipt-dst-historical-objective");
  try {
    await seedEvents(dataDir, "factory/objectives/objective_historical_dst", [
      {
        type: "objective.created",
        objectiveId: "objective_historical_dst",
        title: "Historical objective",
        prompt: "Investigate a historical stream.",
        channel: "results",
        baseHash: "abc123",
        objectiveMode: "investigation",
        severity: 1,
        checks: [],
        checksSource: "default",
        profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
        policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
        createdAt: 1,
      },
      {
        type: "task.added",
        objectiveId: "objective_historical_dst",
        task: {
          nodeId: "task_01",
          taskId: "task_01",
          taskKind: "planned",
          title: "Historical task",
          prompt: "Inspect the old packet.",
          workerType: "codex",
          executionMode: "worktree",
          baseCommit: "abc123",
          dependsOn: [],
          status: "pending",
          skillBundlePaths: [],
          contextRefs: [],
          artifactRefs: {},
          createdAt: 2,
        } satisfies FactoryTaskRecord,
        createdAt: 2,
      },
      {
        type: "monitor.intervention",
        objectiveId: "objective_historical_dst",
        taskId: "task_01",
        jobId: "job_historical_dst",
        interventionKind: "steer",
        detail: "Finish with the evidence already captured.",
        interventionAt: 3,
      },
    ]);

    const report = await runReceiptDstAudit(dataDir, {
      prefix: "factory/objectives/",
    });
    const stream = report.streams.find((entry) => entry.stream === "factory/objectives/objective_historical_dst");

    expect(stream).toBeTruthy();
    expect(stream?.replay.ok).toBe(true);
    expect(stream?.deterministic.ok).toBe(true);
    expect(stream?.summary.kind).toBe("factory.objective");
    expect(stream?.summary.taskCount).toBe(1);
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

test("receipt dst context audit tolerates historical prompt contract wording drift", async () => {
  const dataDir = await createTempDir("receipt-dst-context-prompt-compat");
  const { workspacePath, payload } = await createFactoryTaskPacketFixture({
    objectiveId: "objective_context_prompt_compat",
    taskId: "task_context_prompt_compat",
    candidateId: "candidate_context_prompt_compat",
    jobId: "job_context_prompt_compat",
    guidanceMessage: "Use the packet before broader memory.",
  });
  try {
    const promptPath = String(payload.promptPath);
    const prompt = await fs.readFile(promptPath, "utf-8");
    await fs.writeFile(
      promptPath,
      prompt
        .replace("manifest, context pack, then memory script", "manifest and recursive packet files")
        .replace("\n## Live Operator Guidance\n", "\n## Operator Notes\n"),
      "utf-8",
    );

    await seedJobEvents(dataDir, "jobs/job_context_prompt_compat", [
      {
        type: "job.enqueued",
        jobId: "job_context_prompt_compat",
        agentId: "codex",
        lane: "collect",
        payload,
        maxAttempts: 1,
        sessionKey: "factory:objective_context_prompt_compat:task_context_prompt_compat",
        singletonMode: "allow",
        createdAt: 1,
      },
      {
        type: "queue.command",
        jobId: "job_context_prompt_compat",
        commandId: "cmd_follow_up_01",
        command: "follow_up",
        lane: "follow_up",
        payload: {
          note: "Use the packet before broader memory.",
        },
        by: "factory-cli",
        createdAt: 2,
      },
    ]);

    const report = await runReceiptDstAudit(dataDir, {
      includeContext: true,
      repoRoot: ROOT,
    });

    expect(report.context?.integrityFailures).toBe(0);
    expect(report.context?.runs[0]?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("prompt missing"),
    ]));
    expect(report.context?.runs[0]?.issues).toEqual([]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("receipt dst context audit tolerates historical absolute packet paths in memory config", async () => {
  const dataDir = await createTempDir("receipt-dst-context-memory-path-compat");
  const { workspacePath, payload } = await createFactoryTaskPacketFixture({
    objectiveId: "objective_context_memory_path_compat",
    taskId: "task_context_memory_path_compat",
    candidateId: "candidate_context_memory_path_compat",
    jobId: "job_context_memory_path_compat",
  });
  try {
    const memoryConfigPath = String(payload.memoryConfigPath);
    const memoryConfig = JSON.parse(await fs.readFile(memoryConfigPath, "utf-8")) as Record<string, unknown>;
    memoryConfig.contextPackPath = String(payload.contextPackPath);
    memoryConfig.contextSummaryPath = String(payload.contextSummaryPath);
    await fs.writeFile(memoryConfigPath, JSON.stringify(memoryConfig, null, 2), "utf-8");

    await seedJobEvents(dataDir, "jobs/job_context_memory_path_compat", [
      {
        type: "job.enqueued",
        jobId: "job_context_memory_path_compat",
        agentId: "codex",
        lane: "collect",
        payload,
        maxAttempts: 1,
        sessionKey: "factory:objective_context_memory_path_compat:task_context_memory_path_compat",
        singletonMode: "allow",
        createdAt: 1,
      },
    ]);

    const report = await runReceiptDstAudit(dataDir, {
      includeContext: true,
      repoRoot: ROOT,
    });

    expect(report.context?.integrityFailures).toBe(0);
    expect(report.context?.runs[0]?.issues).toEqual([]);
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
      receiptCliPath: String(payload.receiptCliPath),
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

test("receipt dst context audit: investigation-mode AWS ECS question renders with proportionality ladder and passes integrity", async () => {
  const dataDir = await createTempDir("receipt-dst-investigation-ecs");
  const objectiveId = "objective_ecs_investigation";
  const taskId = "task_01";
  const candidateId = "task_01_candidate_01";
  const jobId = "job_ecs_investigation";
  const workspacePath = await createTempDir("receipt-dst-investigation-ecs-ws");
  const files = buildTaskFilePaths(workspacePath, taskId);
  await fs.mkdir(path.dirname(files.manifestPath), { recursive: true });
  await fs.writeFile(files.skillBundlePath, JSON.stringify({ skills: [] }, null, 2), "utf-8");

  const objectivePrompt =
    "User wants a table of 'ec2 containers'. Interpret as ECS containers running on EC2 (not Fargate). " +
    "Query all regions for ECS clusters -> list-tasks RUNNING -> describe-tasks; filter launchType=EC2. " +
    "Output a markdown table and top-line counts.";

  const profile = {
    ...DEFAULT_FACTORY_OBJECTIVE_PROFILE,
    rootProfileId: "infrastructure",
    rootProfileLabel: "Infrastructure",
    promptPath: "profiles/infrastructure/PROFILE.md",
    selectedSkills: ["skills/factory-receipt-worker/SKILL.md", "skills/factory-infrastructure-aws/SKILL.md"],
    objectivePolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
    cloudProvider: "aws",
  };

  const state = {
    objectiveId,
    title: "List EC2 containers (ECS on EC2) as table",
    prompt: objectivePrompt,
    objectiveMode: "investigation",
    severity: 1,
    checks: [],
  } as FactoryState;

  const task = {
    taskId,
    title: "List EC2 containers (ECS on EC2) as table",
    prompt: objectivePrompt,
    workerType: "codex",
  } as FactoryTaskRecord;

  const taskPayload = {
    executionMode: "worktree",
    baseCommit: "abc123",
    candidateId,
    profile,
  } as FactoryTaskJobPayload;

  const planningReceipt = {
    goal: "List EC2 containers (ECS on EC2) as table.",
    constraints: [],
    taskGraph: [{
      taskId,
      title: "List EC2 containers (ECS on EC2) as table",
      dependsOn: [],
      workerType: "codex",
      executionMode: "worktree",
      status: "running",
    }],
    acceptanceCriteria: [
      "Answer the stated investigation goal: List EC2 containers (ECS on EC2) as table.",
      "Return a clear conclusion with supporting evidence and scripts run.",
      "Call out any disagreement, gap, or uncertainty that affects operator confidence.",
    ],
    validationPlan: [],
    plannedAt: 1,
  } satisfies FactoryPlanningReceiptRecord;

  const objectiveContract = {
    acceptanceCriteria: [
      "Answer the stated investigation goal: List EC2 containers (ECS on EC2) as table.",
      "Return a clear conclusion with supporting evidence and scripts run.",
      "Call out any disagreement, gap, or uncertainty that affects operator confidence.",
    ],
    allowedScope: ["ECS investigation across all AWS regions"],
    disallowedScope: [],
    requiredChecks: [],
    proofExpectation: "Return concrete evidence and a clear conclusion with any uncertainty called out.",
  } satisfies FactoryObjectiveContractRecord;

  const cloudExecutionContext: FactoryCloudExecutionContext = {
    summary: "AWS credentials are mounted for this profile.",
    guidance: ["Use the detected AWS context by default."],
    availableProviders: ["aws"],
    activeProviders: ["aws"],
    preferredProvider: "aws",
  };

  const helperCatalog: FactoryHelperContext = {
    runnerPath: "skills/factory-helper-runtime/runner.py",
    guidance: ["Prefer checked-in helpers when repeated CLI steps would be lossy."],
    selectedHelpers: [{
      id: "aws_resource_inventory",
      version: "1.1.0",
      provider: "aws",
      tags: ["inventory", "count", "list", "resource", "ecs", "clusters", "tasks", "services"],
      description: "List or count common AWS resources by service and resource type.",
      manifestPath: "skills/factory-helper-runtime/catalog/infrastructure/aws_resource_inventory/manifest.json",
      entrypointPath: "skills/factory-helper-runtime/catalog/infrastructure/aws_resource_inventory/run.py",
      requiredArgs: ["--service", "--resource"],
      requiredContext: ["Requires an explicit service/resource pair such as ecs/clusters, ecs/tasks, ecs/services."],
      examples: ["--service ecs --resource clusters --all-regions", "--service ecs --resource tasks --region us-east-1"],
      score: 12,
    }],
  };

  const prompt = renderFactoryTaskPrompt({
    state,
    task,
    payload: taskPayload,
    taskPrompt: objectivePrompt,
    planningReceipt,
    objectiveContract,
    cloudExecutionContext,
    helperCatalog,
    infrastructureTaskGuidance: [],
    dependencySummaries: "- none",
    downstreamSummaries: "- none",
    validationSection: renderFactoryTaskValidationSection(state, task),
    manifestPathForPrompt: files.manifestPath,
    contextSummaryPathForPrompt: files.contextSummaryPath,
    contextPackPathForPrompt: files.contextPackPath,
    memoryScriptPathForPrompt: files.memoryScriptPath,
    receiptCliPathForPrompt: files.receiptCliPath,
    resultPathForPrompt: files.resultPath,
    factoryCliPrefix: "receipt",
  });

  expect(prompt).toContain("Proportionality Ladder");
  expect(prompt).toContain("Investigation Budget");
  expect(prompt).toContain("## Helper-First Execution");
  expect(prompt).toContain("Helper runner: skills/factory-helper-runtime/runner.py");
  expect(prompt).toContain("aws_resource_inventory");
  expect(prompt).toContain("Escalation order");
  expect(prompt).toContain("investigation-first");

  const memoryScopes = [
    { key: "agent", scope: "factory/agents/codex", label: "Agent memory", defaultQuery: "context", readOnly: true },
    { key: "repo", scope: "factory/repo/shared", label: "Repo shared memory", defaultQuery: "context", readOnly: true },
    { key: "objective", scope: `factory/objectives/${objectiveId}`, label: "Objective memory", defaultQuery: objectiveId },
    { key: "task", scope: `factory/objectives/${objectiveId}/tasks/${taskId}`, label: "Task memory", defaultQuery: taskId },
    { key: "candidate", scope: `factory/objectives/${objectiveId}/candidates/${candidateId}`, label: "Candidate memory", defaultQuery: candidateId },
    { key: "integration", scope: `factory/objectives/${objectiveId}/integration`, label: "Integration memory", defaultQuery: "integration" },
  ];
  const sharedArtifactRefs = [{ kind: "artifact", ref: "README.md", label: "readme" }];
  const contextRefs = [{ kind: "artifact", ref: files.contextPackPath, label: "context pack" }];
  const contextSources = {
    repoSharedMemoryScope: "factory/repo/shared",
    objectiveMemoryScope: `factory/objectives/${objectiveId}`,
    integrationMemoryScope: `factory/objectives/${objectiveId}/integration`,
    profileSkillRefs: profile.selectedSkills,
    repoSkillPaths: profile.selectedSkills,
    sharedArtifactRefs,
  };
  const manifest = {
    objective: {
      objectiveId,
      title: "List EC2 containers (ECS on EC2) as table",
      prompt: objectivePrompt,
      baseHash: "abc123",
      objectiveMode: "investigation",
      severity: 1,
      checks: [],
    },
    profile,
    task: {
      taskId,
      title: "List EC2 containers (ECS on EC2) as table",
      prompt: objectivePrompt,
      workerType: "codex",
      executionMode: "worktree",
      baseCommit: "abc123",
      dependsOn: [],
    },
    candidate: { candidateId, taskId },
    integration: { status: "idle" },
    contract: objectiveContract,
    memory: {
      scriptPath: files.memoryScriptPath,
      configPath: files.memoryConfigPath,
      scopes: memoryScopes,
    },
    receiptCli: { surfacePath: files.receiptCliPath, factoryCliPrefix: "receipt" },
    context: { summaryPath: files.contextSummaryPath, packPath: files.contextPackPath },
    contextSources,
    contextRefs,
    sharedArtifactRefs,
    repoSkillPaths: profile.selectedSkills,
    skillBundlePaths: [files.skillBundlePath],
    traceRefs: [],
  };
  const contextPack = {
    objectiveId,
    title: "List EC2 containers (ECS on EC2) as table",
    prompt: objectivePrompt,
    objectiveMode: "investigation",
    severity: 1,
    contract: objectiveContract,
    profile,
    task: {
      taskId,
      title: "List EC2 containers (ECS on EC2) as table",
      prompt: objectivePrompt,
      workerType: "codex",
      executionMode: "worktree",
      status: "running",
      candidateId,
    },
    integration: { status: "idle" },
    dependencyTree: [],
    relatedTasks: [{ taskId, taskKind: "planned", title: "List EC2 containers (ECS on EC2) as table", status: "running", workerType: "codex", relations: ["focus"] }],
    candidateLineage: [{ candidateId, status: "running", summary: "First pass" }],
    recentReceipts: [{ type: "task.dispatched", at: 1, taskId, candidateId, summary: "Task dispatched for execution." }],
    objectiveSlice: {
      frontierTasks: [{ taskId, taskKind: "planned", title: "List EC2 containers (ECS on EC2) as table", status: "running", workerType: "codex", relations: ["focus"] }],
      recentCompletedTasks: [],
      integrationTasks: [],
      recentObjectiveReceipts: [{ type: "objective.created", at: 1, summary: "Objective created." }],
      objectiveMemorySummary: "Investigation objective for ECS on EC2.",
      integrationMemorySummary: "No integration yet.",
    },
    memory: {
      overview: "Use the packet before broader memory.",
      objective: "Investigation objective for ECS on EC2.",
      integration: "No integration yet.",
      repoAudit: "No known repo-wide audit issue.",
    },
    investigation: { reports: [] },
    helperCatalog: {
      runnerPath: helperCatalog.runnerPath,
      guidance: helperCatalog.guidance,
      selectedHelpers: helperCatalog.selectedHelpers.map((h) => ({
        id: h.id,
        description: h.description,
        tags: [...h.tags],
        manifestPath: h.manifestPath,
        entrypointPath: h.entrypointPath,
        requiredArgs: [...h.requiredArgs],
        requiredContext: [...h.requiredContext],
        examples: [...h.examples],
      })),
    },
    contextSources,
    cloudExecutionContext,
  };
  const memoryConfig = {
    objectiveId,
    taskId,
    candidateId,
    contextSummaryPath: path.basename(files.contextSummaryPath),
    contextPackPath: path.basename(files.contextPackPath),
    defaultQuery: `${objectivePrompt}\n${task.title}`,
    defaultLimit: 6,
    defaultMaxChars: 2400,
    scopes: memoryScopes,
  };

  const jobPayload = {
    kind: "factory.task.run",
    objectiveId,
    taskId,
    workerType: "codex",
    objectiveMode: "investigation",
    severity: 1,
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
    receiptCliPath: files.receiptCliPath,
    repoSkillPaths: profile.selectedSkills,
    skillBundlePaths: [files.skillBundlePath],
    profile,
    profilePromptHash: "prompt_hash_ecs",
    profileSkillRefs: profile.selectedSkills,
    sharedArtifactRefs,
    contextRefs,
    problem: objectivePrompt,
    config: {},
  } satisfies Record<string, unknown>;

  await fs.writeFile(files.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  await fs.writeFile(files.contextPackPath, JSON.stringify(contextPack, null, 2), "utf-8");
  await fs.writeFile(files.contextSummaryPath, [
    "# Factory Task Context Summary",
    "",
    "## Packet Usage",
    "Use the packet before broader exploration.",
  ].join("\n"), "utf-8");
  await fs.writeFile(files.receiptCliPath, [
    "# Factory Receipt CLI Surface",
    "",
    "Use this bounded CLI surface before broader receipt exploration.",
  ].join("\n"), "utf-8");
  await fs.writeFile(files.promptPath, prompt, "utf-8");
  await fs.writeFile(files.memoryConfigPath, JSON.stringify(memoryConfig, null, 2), "utf-8");
  await fs.writeFile(files.memoryScriptPath, buildFactoryMemoryScriptSource(files.memoryConfigPath), "utf-8");
  await fs.writeFile(files.lastMessagePath, "Structured result pending.", "utf-8");

  try {
    await seedJobEvents(dataDir, `jobs/${jobId}`, [
      {
        type: "job.enqueued",
        jobId,
        agentId: "codex",
        lane: "collect",
        payload: jobPayload,
        maxAttempts: 2,
        sessionKey: `factory:${objectiveId}:${taskId}`,
        singletonMode: "allow",
        createdAt: 1,
      },
      {
        type: "job.leased",
        jobId,
        workerId: "worker_1",
        leaseMs: 300_000,
        attempt: 1,
      },
      {
        type: "job.completed",
        jobId,
        workerId: "worker_1",
        result: { ok: true },
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

    const run = report.context?.runs[0];
    expect(run?.artifacts.prompt).toBe(true);
    expect(run?.artifacts.manifest).toBe(true);
    expect(run?.artifacts.contextPack).toBe(true);
    expect(run?.artifacts.memoryScript).toBe(true);
    expect(run?.summary.profileId).toBe("infrastructure");
    expect(run?.summary.cloudProvider).toBe("aws");
    expect(run?.summary.helperCount).toBe(1);
    expect(run?.integrity.ok).toBe(true);
    expect(run?.issues).toEqual([]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
