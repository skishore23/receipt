import { test, expect } from "bun:test";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import React from "react";
import { renderToString } from "ink";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { createRuntime } from "@receipt/core/runtime";
import { FactoryBoardScreen, FactoryObjectiveScreen } from "../../src/factory-cli/app.tsx";
import { parseComposerDraft } from "../../src/factory-cli/composer";
import { loadFactoryConfig, resolveFactoryRuntimeConfig } from "../../src/factory-cli/config";
import { createFactoryCliRuntime } from "../../src/factory-cli/runtime";
import { FactoryThemeProvider } from "../../src/factory-cli/theme.tsx";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent, type AgentCmd, type AgentEvent } from "../../src/modules/agent";
import { decideFactory, initialFactoryState, reduceFactory, DEFAULT_FACTORY_OBJECTIVE_POLICY, type FactoryCmd, type FactoryEvent } from "../../src/modules/factory";
import { buildFactoryWorkbench } from "../../src/views/factory-workbench";
import {
  historicalInfrastructureChatReceipts,
  historicalInfrastructureChatStream,
  historicalInfrastructureObjectiveId,
  historicalInfrastructureObjectiveReceipts,
  historicalInfrastructureStartupObjectiveId,
} from "../fixtures/factory-infrastructure-replay";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(ROOT, "src", "cli.ts");
const BUN = process.env.BUN_BIN?.trim() || "bun";
const execFileAsync = promisify(execFile);
const stripAnsi = (value: string): string =>
  value.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");

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

const createRepo = async (opts: {
  readonly packageManager?: string;
  readonly withBunLock?: boolean;
} = {}): Promise<string> => {
  const repoDir = await createTempDir("receipt-factory-cli-repo");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Factory CLI Test"]);
  await git(repoDir, ["config", "user.email", "factory-cli@example.com"]);
  await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({
    name: "factory-cli-test",
    ...(opts.packageManager ? { packageManager: opts.packageManager } : {}),
    private: true,
    scripts: {
      build: "bun -e \"process.exit(0)\"",
    },
  }, null, 2), "utf-8");
  if (opts.withBunLock) {
    await fs.writeFile(path.join(repoDir, "bun.lock"), "{}", "utf-8");
  }
  await fs.writeFile(path.join(repoDir, "README.md"), "# factory cli test\n", "utf-8");
  await git(repoDir, ["add", "package.json", "README.md", ...(opts.withBunLock ? ["bun.lock"] : [])]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  return repoDir;
};

const createCodexStub = async (): Promise<string> => {
  const dir = await createTempDir("receipt-factory-cli-codex");
  const nodeBody = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "(async () => {",
    "  const workspace = args[args.indexOf('--cd') + 1];",
    "  const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "  const prompt = await readAll();",
    "  const match = prompt.match(/Write JSON to (.+?) with:/);",
    "  if (!workspace || !lastMessagePath) throw new Error('codex stub missing required args');",
    "  const resultPath = match ? match[1].trim() : '';",
    "  const isPublish = prompt.includes('Publish the completed objective:');",
    "  if (!match && !isPublish) throw new Error('codex stub missing match or publish flag');",
    "  if (resultPath.includes('task_02')) {",
    "    const packageJsonPath = path.join(workspace, 'package.json');",
    "    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));",
    "    packageJson.scripts = { ...(packageJson.scripts || {}), smoke: 'bun run build' };",
    "    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\\n', 'utf8');",
    "  } else if (resultPath.includes('task_03')) {",
    "    const readmePath = path.join(workspace, 'README.md');",
    "    const existing = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';",
    "    if (!existing.includes('Smoke validation checked.')) {",
    "      fs.writeFileSync(readmePath, `${existing.trimEnd()}\\n\\nSmoke validation checked.\\n`, 'utf8');",
    "    }",
    "  } else {",
    "    fs.writeFileSync(path.join(workspace, 'CLI_SMOKE.txt'), 'created by stub\\n', 'utf8');",
    "  }",
    "  if (match) {",
    "    fs.writeFileSync(resultPath, JSON.stringify({ outcome: 'approved', summary: 'Stub approved result.', handoff: 'Ready for integration.' }, null, 2));",
    "  }",
    "  fs.writeFileSync(lastMessagePath, 'stub completed\\n', 'utf8');",
    "})().catch((err) => {",
    "  console.error(err instanceof Error ? err.message : String(err));",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
  if (process.platform === "win32") {
    const jsPath = path.join(dir, "codex-stub.js");
    const cmdPath = path.join(dir, "codex-stub.cmd");
    await fs.writeFile(jsPath, nodeBody, "utf-8");
    await fs.writeFile(cmdPath, `@echo off\r\n"${BUN.replace(/\//g, "\\")}" "%~dp0\\codex-stub.js" %*\r\n`, "utf-8");
    return cmdPath;
  }
  const scriptPath = path.join(dir, "codex-stub");
  await fs.writeFile(scriptPath, `#!/usr/bin/env bun\n${nodeBody}`, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
};

const createCodexReplyStub = async (delayMs = 1_100): Promise<string> => {
  const dir = await createTempDir("receipt-factory-cli-codex-reply");
  const nodeBody = [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "(async () => {",
    "  const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "  if (!lastMessagePath) throw new Error('codex reply stub missing required args');",
    "  const prompt = await readAll();",
    "  const match = prompt.match(/Reply with exactly:\\s*(.+)/i);",
    "  const reply = match ? match[1].split(/\\r?\\n/)[0].trim() : 'reply-missing';",
    "  process.stdout.write('stub-start\\n');",
    "  fs.writeFileSync(lastMessagePath, 'stub running\\n', 'utf8');",
    `  await sleep(${delayMs});`,
    "  fs.writeFileSync(lastMessagePath, `${reply}\\n`, 'utf8');",
    "  process.stdout.write(`${reply}\\n`);",
    "})().catch((err) => {",
    "  console.error(err instanceof Error ? err.message : String(err));",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
  if (process.platform === "win32") {
    const jsPath = path.join(dir, "codex-reply-stub.js");
    const cmdPath = path.join(dir, "codex-reply-stub.cmd");
    await fs.writeFile(jsPath, nodeBody, "utf-8");
    await fs.writeFile(cmdPath, `@echo off\r\n"${BUN.replace(/\//g, "\\")}" "%~dp0\\codex-reply-stub.js" %*\r\n`, "utf-8");
    return cmdPath;
  }
  const scriptPath = path.join(dir, "codex-reply-stub");
  await fs.writeFile(scriptPath, `#!/usr/bin/env bun\n${nodeBody}`, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
};

const createPathCodexStub = async (): Promise<string> => {
  const dir = await createTempDir("receipt-factory-cli-codex-path");
  if (process.platform === "win32") {
    const cmdPath = path.join(dir, "codex.cmd");
    await fs.writeFile(cmdPath, "@echo off\r\nexit /b 0\r\n", "utf-8");
    return dir;
  }
  const scriptPath = path.join(dir, "codex");
  await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n", "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return dir;
};

const seedObjectiveReplay = async (
  dataDir: string,
  objectiveId: string,
  receipts: ReadonlyArray<FactoryEvent>,
): Promise<void> => {
  const runtime = createRuntime<FactoryCmd, FactoryEvent, typeof initialFactoryState>(
    jsonlStore<FactoryEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideFactory,
    reduceFactory,
    initialFactoryState,
  );
  const stream = `factory/objectives/${objectiveId}`;
  for (const [index, event] of receipts.entries()) {
    await runtime.execute(stream, {
      type: "emit",
      event,
      eventId: `${stream}:${index + 1}`,
    });
  }
};

const seedAgentReplay = async (
  dataDir: string,
  stream: string,
  receipts: ReadonlyArray<AgentEvent>,
): Promise<void> => {
  const runtime = createRuntime<AgentCmd, AgentEvent, typeof initialAgent>(
    jsonlStore<AgentEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideAgent,
    reduceAgent,
    initialAgent,
  );
  for (const [index, event] of receipts.entries()) {
    await runtime.execute(stream, {
      type: "emit",
      event,
      eventId: `${stream}:${index + 1}`,
    });
  }
};

  const runCli = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(BUN, [CLI, ...args], {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        process.stdout.write(chunk);
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        process.stderr.write(chunk);
        stderr += chunk;
      });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const makeWorkbenchSnapshot = () => {
  const detail = {
    objectiveId: "objective_demo",
    title: "CLI workbench objective",
    status: "executing",
    phase: "executing",
    objectiveMode: "delivery",
    severity: 2,
    scheduler: { slotState: "active" },
    updatedAt: 2,
    latestSummary: "The workbench task is still running.",
    nextAction: "Keep the focused task visible.",
    activeTaskCount: 1,
    readyTaskCount: 1,
    taskCount: 2,
    integrationStatus: "idle",
    prompt: "Implement the running task workbench.",
    channel: "results",
    baseHash: "abc123",
    checks: ["bun test"],
    profile: {
      rootProfileLabel: "Generalist",
      rootProfileId: "generalist",
      promptPath: "prompts/factory/orchestrator.md",
      selectedSkills: [],
    },
    policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
    contextSources: {
      repoSharedMemoryScope: "factory/repo/shared",
      objectiveMemoryScope: "factory/objectives/objective_demo",
      integrationMemoryScope: "factory/objectives/objective_demo/integration",
      profileSkillRefs: [],
      repoSkillPaths: [],
      sharedArtifactRefs: [],
    },
    budgetState: {
      elapsedMinutes: 7,
      taskRunsUsed: 2,
      candidatePassesByTask: {},
    },
    createdAt: 1,
    latestDecision: {
      summary: "Focus task_01 until the logs settle.",
      at: 3,
      source: "runtime",
    },
    investigation: {
      reports: [],
      finalReport: {
        conclusion: "",
        evidence: [],
        scriptsRun: [],
        disagreements: [],
        nextSteps: [],
      },
    },
    tasks: [{
      taskId: "task_01",
      title: "Implement workbench shell",
      prompt: "Render the running task workbench in the CLI rail.",
      workerType: "codex",
      taskKind: "planned",
      status: "running",
      dependsOn: [],
      workspaceExists: true,
      workspaceDirty: true,
      workspaceHead: "abc12345",
      jobId: "job_01",
      jobStatus: "running",
      candidateId: "candidate_01",
      candidate: {
        candidateId: "candidate_01",
        taskId: "task_01",
        status: "running",
        summary: "Applying the CLI workbench patch.",
        tokensUsed: 144,
      },
      manifestPath: "/tmp/task_01.manifest.json",
      contextPackPath: "/tmp/task_01.context-pack.json",
      promptPath: "/tmp/task_01.prompt.md",
      memoryScriptPath: "/tmp/task_01.memory.cjs",
      stdoutPath: "/tmp/task_01.stdout.log",
      stderrPath: "/tmp/task_01.stderr.log",
      lastMessagePath: "/tmp/task_01.last-message.md",
      lastMessage: "Rendering the CLI workbench.",
      stdoutTail: "build ok",
      stderrTail: "",
    }, {
      taskId: "task_02",
      title: "Follow-up validation",
      prompt: "Run the validation follow-up after task_01.",
      workerType: "codex",
      taskKind: "planned",
      status: "ready",
      dependsOn: ["task_01"],
      workspaceExists: true,
      workspaceDirty: false,
      workspaceHead: "abc12345",
      jobStatus: "queued",
      latestSummary: "Waiting on task_01.",
    }],
    candidates: [],
    integration: {
      status: "idle",
      queuedCandidateIds: [],
    },
    recentReceipts: [{
      type: "rebracket.applied",
      hash: "hash_live_01",
      ts: 4,
      summary: "Stayed on task_01.",
      taskId: "task_01",
    }],
    evidenceCards: [],
    activity: [{
      kind: "job",
      title: "Worker running",
      summary: "Codex is still streaming logs for task_01.",
      at: 5,
      taskId: "task_01",
    }],
  } as const;
  const live = {
    selectedObjectiveId: "objective_demo",
    objectiveTitle: detail.title,
    objectiveStatus: detail.status,
    phase: detail.phase,
    activeTasks: detail.tasks.slice(0, 1),
    recentJobs: [{
      id: "job_01",
      agentId: "codex",
      lane: "collect",
      singletonMode: "allow",
      payload: {
        kind: "factory.task.run",
        objectiveId: "objective_demo",
        taskId: "task_01",
        candidateId: "candidate_01",
      },
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 1,
      updatedAt: 2,
      commands: [],
    }],
  } as const;
  return {
    compose: {
      defaultBranch: "main",
      sourceDirty: false,
      sourceBranch: "main",
      objectiveCount: 1,
      defaultPolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      profileSummary: "Using checked-in Factory profiles and skills only.",
      defaultValidationCommands: ["bun test"],
    },
    board: {
      objectives: [{
        objectiveId: detail.objectiveId,
        title: detail.title,
        status: detail.status,
        phase: detail.phase,
        objectiveMode: detail.objectiveMode,
        severity: detail.severity,
        scheduler: detail.scheduler,
        updatedAt: detail.updatedAt,
        latestSummary: detail.latestSummary,
        latestDecision: detail.latestDecision,
        nextAction: detail.nextAction,
        activeTaskCount: detail.activeTaskCount,
        readyTaskCount: detail.readyTaskCount,
        taskCount: detail.taskCount,
        integrationStatus: detail.integration.status,
        profile: detail.profile,
        section: "active",
      }],
      sections: {
        needs_attention: [],
        active: [{
          objectiveId: detail.objectiveId,
          title: detail.title,
          status: detail.status,
          phase: detail.phase,
          objectiveMode: detail.objectiveMode,
          severity: detail.severity,
          scheduler: detail.scheduler,
          updatedAt: detail.updatedAt,
          latestSummary: detail.latestSummary,
          latestDecision: detail.latestDecision,
          nextAction: detail.nextAction,
          activeTaskCount: detail.activeTaskCount,
          readyTaskCount: detail.readyTaskCount,
          taskCount: detail.taskCount,
          integrationStatus: detail.integration.status,
          profile: detail.profile,
          section: "active",
        }],
        queued: [],
        completed: [],
      },
      selectedObjectiveId: detail.objectiveId,
    },
    detail,
    live,
    debug: {
      objectiveId: detail.objectiveId,
      title: detail.title,
      status: detail.status,
      phase: detail.phase,
      scheduler: detail.scheduler,
      latestDecision: detail.latestDecision,
      nextAction: detail.nextAction,
      profile: detail.profile,
      policy: detail.policy,
      contextSources: detail.contextSources,
      budgetState: detail.budgetState,
      recentReceipts: detail.recentReceipts,
      evidenceCards: detail.evidenceCards,
      activeJobs: live.recentJobs,
      lastJobs: live.recentJobs,
      latestContextPacks: [],
      taskWorktrees: [],
      integrationWorktree: undefined,
    },
  };
};

test("factory cli: init writes config and board snapshot stays clean", async () => {
  const repoDir = await createRepo();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);
  const initPayload = JSON.parse(init.stdout) as {
    readonly config: { readonly configPath: string; readonly defaultChecks: ReadonlyArray<string> };
    readonly profileSummary: string;
  };
  expect(initPayload.profileSummary.length).toBeGreaterThan(0);
  expect(initPayload.config.defaultChecks).toContain("bun run build");
  await fs.access(initPayload.config.configPath);

  const board = await runCli(["factory", "--json", "--repo-root", repoDir]);
  expect(board.code).toBe(0);
  const boardPayload = JSON.parse(board.stdout) as {
    readonly compose: { readonly sourceDirty: boolean; readonly objectiveCount: number };
    readonly board: { readonly objectives: ReadonlyArray<unknown> };
  };
  expect(boardPayload.compose.sourceDirty).toBe(false);
  expect(boardPayload.compose.objectiveCount).toBe(0);
  expect(boardPayload.board.objectives.length).toBe(0);
}, 120_000);

test("factory cli: bun repos infer bun validation commands", async () => {
  const repoDir = await createRepo({ packageManager: "bun@1.3.8", withBunLock: true });
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);
  const initPayload = JSON.parse(init.stdout) as {
    readonly config: { readonly defaultChecks: ReadonlyArray<string> };
    readonly environment: { readonly sourceDirty: boolean };
  };
  expect(initPayload.config.defaultChecks).toContain("bun run build");
  expect(initPayload.environment.sourceDirty).toBe(false);
}, 120_000);

test("factory cli: replay folds a historical infrastructure objective into the current workflow projection", async () => {
  const repoDir = await createRepo();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);

  const runtimeConfig = await resolveFactoryRuntimeConfig(repoDir);
  await seedObjectiveReplay(runtimeConfig.dataDir, historicalInfrastructureObjectiveId, historicalInfrastructureObjectiveReceipts);

  const replay = await runCli([
    "factory",
    "replay",
    historicalInfrastructureObjectiveId,
    "--json",
    "--repo-root",
    repoDir,
  ]);
  expect(replay.code).toBe(0);
  const payload = JSON.parse(replay.stdout) as {
    readonly objectiveId: string;
    readonly receiptCount: number;
    readonly status: string;
    readonly workflow: {
      readonly pendingTaskIds: ReadonlyArray<string>;
      readonly blockedTaskIds: ReadonlyArray<string>;
    };
    readonly tasks: ReadonlyArray<{
      readonly taskId: string;
      readonly blockedReason?: string;
    }>;
  };
  expect(payload.objectiveId).toBe(historicalInfrastructureObjectiveId);
  expect(payload.receiptCount).toBe(historicalInfrastructureObjectiveReceipts.length);
  expect(payload.status).toBe("canceled");
  expect(payload.workflow.blockedTaskIds).toEqual(["task_01"]);
  expect(payload.workflow.pendingTaskIds).toEqual(["task_02"]);
  expect(payload.tasks.find((task) => task.taskId === "task_01")?.blockedReason).toContain("AccessDeniedException");
}, 120_000);

test("factory cli: replay-chat exposes the historical infrastructure binding path", async () => {
  const repoDir = await createRepo();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);

  const runtimeConfig = await resolveFactoryRuntimeConfig(repoDir);
  await seedAgentReplay(runtimeConfig.dataDir, historicalInfrastructureChatStream, historicalInfrastructureChatReceipts);

  const replay = await runCli([
    "factory",
    "replay-chat",
    historicalInfrastructureChatStream,
    "--json",
    "--repo-root",
    repoDir,
  ]);
  expect(replay.code).toBe(0);
  const payload = JSON.parse(replay.stdout) as {
    readonly stream: string;
    readonly receiptCount: number;
    readonly latestObjectiveId?: string;
    readonly runs: ReadonlyArray<{
      readonly runId: string;
      readonly startupObjectiveId?: string;
      readonly latestBoundObjectiveId?: string;
      readonly continuation?: {
        readonly objectiveId?: string;
      };
      readonly bindings: ReadonlyArray<{
        readonly objectiveId: string;
        readonly reason: string;
      }>;
    }>;
    readonly threadTimeline: ReadonlyArray<{
      readonly type: string;
      readonly objectiveId?: string;
      readonly reason?: string;
    }>;
  };
  expect(payload.stream).toBe(historicalInfrastructureChatStream);
  expect(payload.receiptCount).toBe(historicalInfrastructureChatReceipts.length);
  expect(payload.latestObjectiveId).toBe(historicalInfrastructureStartupObjectiveId);

  const run = payload.runs[0];
  expect(run?.startupObjectiveId).toBe(historicalInfrastructureStartupObjectiveId);
  expect(run?.latestBoundObjectiveId).toBe(historicalInfrastructureStartupObjectiveId);
  expect(run?.continuation?.objectiveId).toBe(historicalInfrastructureStartupObjectiveId);
  expect(run?.bindings.map((binding) => `${binding.reason}:${binding.objectiveId}`)).toEqual([
    `startup:${historicalInfrastructureStartupObjectiveId}`,
    `dispatch_create:${historicalInfrastructureObjectiveId}`,
    `dispatch_reuse:${historicalInfrastructureObjectiveId}`,
    `dispatch_update:${historicalInfrastructureStartupObjectiveId}`,
  ]);
  expect(payload.threadTimeline.map((entry) => `${entry.type}:${entry.reason ?? ""}:${entry.objectiveId ?? ""}`)).toEqual([
    `thread.bound:startup:${historicalInfrastructureStartupObjectiveId}`,
    `thread.bound:dispatch_create:${historicalInfrastructureObjectiveId}`,
    `thread.bound:dispatch_reuse:${historicalInfrastructureObjectiveId}`,
    `thread.bound:dispatch_update:${historicalInfrastructureStartupObjectiveId}`,
    `run.continued::${historicalInfrastructureStartupObjectiveId}`,
  ]);
}, 120_000);

test("factory runtime config: shared resolver follows .receipt/config.json", async () => {
  const repoDir = await createRepo();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);
  const resolved = await resolveFactoryRuntimeConfig(repoDir);
  expect(resolved.repoRoot).toBe(repoDir);
  expect(resolved.dataDir).toBe(path.join(repoDir, ".receipt", "data"));
  expect(resolved.configPath).toBe(path.join(repoDir, ".receipt", "config.json"));
}, 120_000);

test("factory cli: init stores portable codex command when codex is auto-detected on PATH", async () => {
  const repoDir = await createRepo();
  const codexPathDir = await createPathCodexStub();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir], {
    PATH: `${codexPathDir}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  expect(init.code).toBe(0);
  const config = JSON.parse(await fs.readFile(path.join(repoDir, ".receipt", "config.json"), "utf-8")) as {
    readonly codexBin?: string;
  };
  expect(config.codexBin).toBe("codex");
}, 120_000);

test("factory runtime config: repo default data dir is .receipt/data before init", async () => {
  const repoDir = await createRepo();
  const resolved = await resolveFactoryRuntimeConfig(repoDir, repoDir);
  expect(resolved.repoRoot).toBe(repoDir);
  expect(resolved.dataDir).toBe(path.join(repoDir, ".receipt", "data"));
  expect(resolved.configPath).toBeUndefined();
}, 120_000);

test("factory cli: codex-probe runs direct and queue status probes without init", async () => {
  const repoDir = await createRepo();
  const codexStub = await createCodexReplyStub();
  const probe = await runCli([
    "factory",
    "codex-probe",
    "--json",
    "--repo-root",
    repoDir,
    "--mode",
    "both",
    "--reply",
    "probe-ok",
    "--timeout-ms",
    "30000",
    "--poll-ms",
    "100",
  ], {
    RECEIPT_CODEX_BIN: codexStub,
  });
  expect(probe.code).toBe(0);
  const payload = JSON.parse(probe.stdout) as {
    readonly ok: boolean;
    readonly dataDir: string;
    readonly direct?: {
      readonly finalStatus: string;
      readonly snapshots: ReadonlyArray<{ readonly status: string }>;
      readonly artifacts: { readonly lastMessagePath: string };
    };
    readonly queue?: {
      readonly finalStatus: string;
      readonly snapshots: ReadonlyArray<{ readonly status: string }>;
      readonly artifacts: { readonly lastMessagePath: string };
    };
  };
  expect(payload.ok).toBe(true);
  expect(payload.dataDir).toContain(path.join(".receipt", "data", "probes"));
  expect(payload.direct?.finalStatus).toBe("completed");
  expect(payload.queue?.finalStatus).toBe("completed");
  expect(payload.direct?.snapshots.some((snapshot) => snapshot.status === "running")).toBe(true);
  expect(payload.queue?.snapshots.some((snapshot) => snapshot.status === "queued")).toBe(true);
  expect(payload.queue?.snapshots.some((snapshot) => snapshot.status === "completed")).toBe(true);

  const directLastMessage = await fs.readFile(payload.direct!.artifacts.lastMessagePath, "utf-8");
  const queueLastMessage = await fs.readFile(payload.queue!.artifacts.lastMessagePath, "utf-8");
  expect(directLastMessage.trim()).toBe("probe-ok");
  expect(queueLastMessage.trim()).toBe("probe-ok");
}, 120_000);

test("factory cli: run promotes changes and inspect exposes debug data", async () => {
  const repoDir = await createRepo();
  const codexStub = await createCodexStub();
  const env = {
    RECEIPT_CODEX_BIN: codexStub,
  };

  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir], env);
  expect(init.code).toBe(0);

  const run = await runCli([
    "factory",
    "run",
    "--json",
    "--repo-root",
    repoDir,
    "--title",
    "Add smoke file",
    "--prompt",
    "Create a smoke file and keep the repository green.",
  ], env);
  if (run.code !== 0) {
    console.log("RUN FAILED");
    console.log(run.stdout);
    console.log(run.stderr);
  }
  expect(run.code).toBe(0);
  const lines = run.stdout.split("\n");
  const jsonString = lines.slice(lines.findIndex(line => line.trim() === "{")).join("\n");
  let runPayload;
  try {
      runPayload = JSON.parse(jsonString || "{}") as {
        readonly objectiveId: string;
        readonly panel: string;
        readonly data: {
          readonly header: ReadonlyArray<string>;
          readonly latestDecision?: { readonly summary: string };
        };
      };
  } catch (e) {
      console.log("Failed to parse JSON", jsonString);
      throw e;
  }
  expect(runPayload.panel).toBe("overview");
  expect(runPayload.data.header.join("\n")).toMatch(/integration=promoted/);
  expect(runPayload.data.latestDecision?.summary ?? "").toMatch(/promote/i);

  const promotedFile = await fs.readFile(path.join(repoDir, ".receipt", "data", "hub", "worktrees", `factory_integration_${runPayload.objectiveId}`, "CLI_SMOKE.txt"), "utf-8");
  expect(promotedFile).toMatch(/created by stub/);

  const inspect = await runCli([
    "factory",
    "inspect",
    runPayload.objectiveId,
    "--panel",
    "debug",
    "--json",
    "--repo-root",
    repoDir,
  ], env);
  expect(inspect.code).toBe(0);
  const inspectPayload = JSON.parse(inspect.stdout) as {
    readonly objectiveId: string;
    readonly panel: string;
    readonly data: {
      readonly activeJobs: ReadonlyArray<unknown>;
      readonly lastJobs: ReadonlyArray<unknown>;
    };
  };
  expect(inspectPayload.objectiveId).toBe(runPayload.objectiveId);
  expect(inspectPayload.panel).toBe("debug");
  expect(inspectPayload.data.lastJobs.length >= 1).toBeTruthy();
}, 120_000);

test("factory cli: create, compose, and react expose structured mutation results", async () => {
  const repoDir = await createRepo();

  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);

  const created = await runCli([
    "factory",
    "create",
    "--json",
    "--repo-root",
    repoDir,
    "--title",
    "CLI-first objective",
    "--prompt",
    "Create a CLI-first Factory objective.",
  ]);
  expect(created.code).toBe(0);
  const createdPayload = JSON.parse(created.stdout) as {
    readonly ok: boolean;
    readonly kind: string;
    readonly action: string;
    readonly objectiveId: string;
    readonly objective: {
      readonly objectiveId: string;
      readonly title: string;
      readonly recentReceipts: ReadonlyArray<{ readonly type: string }>;
    };
  };
  expect(createdPayload.ok).toBe(true);
  expect(createdPayload.kind).toBe("objective");
  expect(createdPayload.action).toBe("create");
  expect(createdPayload.objectiveId).toBe(createdPayload.objective.objectiveId);
  expect(createdPayload.objective.title).toBe("CLI-first objective");

  const composed = await runCli([
    "factory",
    "compose",
    "--json",
    "--repo-root",
    repoDir,
    "--objective",
    createdPayload.objectiveId,
    "--prompt",
    "Tighten the next pass and keep receipts concise.",
  ]);
  expect(composed.code).toBe(0);
  const composedPayload = JSON.parse(composed.stdout) as {
    readonly action: string;
    readonly note?: string;
    readonly objective: {
      readonly recentReceipts: ReadonlyArray<{ readonly type: string }>;
    };
  };
  expect(composedPayload.action).toBe("compose");
  expect(composedPayload.note).toMatch(/Tighten the next pass/);
  expect(composedPayload.objective.recentReceipts.some((receipt) => receipt.type === "objective.operator.noted")).toBe(true);

  const reacted = await runCli([
    "factory",
    "react",
    createdPayload.objectiveId,
    "--json",
    "--repo-root",
    repoDir,
    "--message",
    "Continue with the operator guidance.",
  ]);
  expect(reacted.code).toBe(0);
  const reactedPayload = JSON.parse(reacted.stdout) as {
    readonly action: string;
    readonly note?: string;
    readonly objectiveId: string;
    readonly objective: {
      readonly objectiveId: string;
      readonly recentReceipts: ReadonlyArray<{ readonly type: string }>;
    };
  };
  expect(reactedPayload.action).toBe("react");
  expect(reactedPayload.note).toBe("Continue with the operator guidance.");
  expect(reactedPayload.objectiveId).toBe(createdPayload.objectiveId);
  expect(reactedPayload.objective.recentReceipts.some((receipt) => receipt.type === "objective.operator.noted")).toBe(true);
}, 120_000);

test("factory cli: abort-job queues a structured abort command", async () => {
  const repoDir = await createRepo();

  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);

  const config = await loadFactoryConfig(repoDir);
  expect(config).toBeDefined();
  const runtime = createFactoryCliRuntime(config!);
  try {
    const job = await runtime.queue.enqueue({
      agentId: "codex",
      lane: "collect",
      payload: {
        kind: "factory.codex.run",
        objectiveId: "objective_demo",
        stream: "factory-chat:test",
        runId: "run_factory_cli_mutation",
        prompt: "Seed the queue for CLI mutation tests.",
      },
      maxAttempts: 1,
    });

    const abort = await runCli([
      "factory",
      "abort-job",
      job.id,
      "--json",
      "--repo-root",
      repoDir,
      "--reason",
      "stop queued cli test job",
    ]);
    expect(abort.code).toBe(0);
    const abortPayload = JSON.parse(abort.stdout) as {
      readonly action: string;
      readonly jobId: string;
      readonly commandId: string;
      readonly job: {
        readonly status: string;
        readonly abortRequested?: boolean;
        readonly commands: ReadonlyArray<{ readonly command: string }>;
      };
    };
    expect(abortPayload.action).toBe("abort");
    expect(abortPayload.jobId).toBe(job.id);
    expect(abortPayload.commandId.length).toBeGreaterThan(0);
    expect(abortPayload.job.status === "canceled" || abortPayload.job.abortRequested === true).toBe(true);

    await runtime.queue.refresh();
    const refreshed = await runtime.queue.getJob(job.id);
    expect(refreshed).toBeDefined();
    expect(refreshed?.commands.some((command) => command.command === "abort")).toBe(true);
  } finally {
    runtime.stop();
  }
}, 120_000);

test("factory cli: composer parser handles plain text and slash commands", () => {
  expect(parseComposerDraft("Ship a better objective flow")).toEqual({
    ok: true,
    command: {
      type: "new",
      prompt: "Ship a better objective flow",
      title: "Ship a better objective flow",
    },
  });
  expect(parseComposerDraft("Need a tighter validation pass", "obj_123")).toEqual({
    ok: true,
    command: {
      type: "react",
      message: "Need a tighter validation pass",
    },
  });
  expect(parseComposerDraft("/watch obj_123", "obj_456")).toEqual({
    ok: true,
    command: {
      type: "watch",
      objectiveId: "obj_123",
    },
  });
  expect(parseComposerDraft("/help", "obj_123")).toEqual({
    ok: true,
    command: {
      type: "help",
    },
  });
  expect(parseComposerDraft("   /help   ", "obj_123")).toEqual({
    ok: true,
    command: {
      type: "help",
    },
  });
  expect(parseComposerDraft("/abort-job stop the current worker", "obj_123")).toEqual({
    ok: true,
    command: {
      type: "abort-job",
      reason: "stop the current worker",
    },
  });
});

test("factory cli: composer parser rejects job commands without a selected objective", () => {
  expect(parseComposerDraft("/abort-job stop the current worker")).toEqual({
    ok: false,
    error: "Select an objective before aborting its active job.",
  });
});

test("factory workbench: shared projection keeps rich task data and defaults focus to the active task", () => {
  const snapshot = makeWorkbenchSnapshot();
  const workbench = buildFactoryWorkbench({
    detail: snapshot.detail as never,
    recentJobs: snapshot.live.recentJobs as never,
  });

  expect(workbench?.focus).toMatchObject({
    focusKind: "task",
    focusId: "task_01",
    taskId: "task_01",
  });
  expect(workbench?.focusedTask).toMatchObject({
    prompt: "Render the running task workbench in the CLI rail.",
    workspaceDirty: true,
    workspaceHead: "abc12345",
    candidateTokensUsed: 144,
    manifestPath: "/tmp/task_01.manifest.json",
    contextPackPath: "/tmp/task_01.context-pack.json",
    memoryScriptPath: "/tmp/task_01.memory.cjs",
  });
});

test("factory cli: objective screen renders the running task workbench", () => {
  const snapshot = makeWorkbenchSnapshot();
  const output = stripAnsi(renderToString(
    React.createElement(FactoryThemeProvider, undefined,
      React.createElement(FactoryObjectiveScreen, { snapshot: snapshot as never }),
    ),
  ));

  expect(output).toContain("Running Task");
  expect(output).toContain("Focus Detail");
  expect(output).toContain("Recent Activity");
  expect(output).toContain("Render the running task");
});
