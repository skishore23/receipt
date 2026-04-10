import { test, expect } from "bun:test";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { createRuntime } from "@receipt/core/runtime";
import { COMPOSER_COMMANDS, inferObjectiveProfileHint, parseComposerDraft } from "../../src/factory-cli/composer";
import { createObjectiveMutation } from "../../src/factory-cli/actions";
import { loadFactoryConfig, resolveFactoryRuntimeConfig } from "../../src/factory-cli/config";
import { renderObjectivePanelText } from "../../src/factory-cli/format";
import { createFactoryCliRuntime } from "../../src/factory-cli/runtime";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent, type AgentCmd, type AgentEvent } from "../../src/modules/agent";
import { decideFactory, initialFactoryState, reduceFactory, DEFAULT_FACTORY_OBJECTIVE_POLICY, type FactoryCmd, type FactoryEvent } from "../../src/modules/factory";
import { decide as decideJob, initial as initialJobState, reduce as reduceJob, type JobCmd, type JobEvent } from "../../src/modules/job";
import { buildFactoryWorkbench } from "../../src/views/factory-workbench";
import {
  historicalInfrastructureChatReceipts,
  historicalInfrastructureChatStream,
  historicalInfrastructureObjectiveId,
  historicalInfrastructureObjectiveReceipts,
  historicalInfrastructureStartupObjectiveId,
} from "../fixtures/factory-infrastructure-replay";
import { resolveBunRuntime } from "../../src/lib/runtime-paths";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(ROOT, "src", "cli.ts");
const BUN = resolveBunRuntime();
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

const createCodexStub = async (opts: {
  readonly taskDelayMs?: number;
} = {}): Promise<string> => {
  const dir = await createTempDir("receipt-factory-cli-codex");
  const nodeBody = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
    "(async () => {",
    "  const workspace = args[args.indexOf('--cd') + 1];",
    "  const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "  const prompt = await readAll();",
    "  const taskIdMatch = prompt.match(/^Task ID:\\s*(\\S+)/m);",
    "  const taskId = taskIdMatch ? taskIdMatch[1].trim() : '';",
    "  if (!workspace || !lastMessagePath) throw new Error('codex stub missing required args');",
    "  const isPublish = prompt.includes('# Factory Integration Publish');",
    "  if (!taskId && !isPublish) throw new Error('codex stub missing task or publish flag');",
    "  if (isPublish) {",
    "    const publishResult = {",
    "      summary: 'Published PR #17.',",
    "      prUrl: 'https://github.com/example/factory-cli-test/pull/17',",
    "      prNumber: 17,",
    "      headRefName: 'codex/factory-cli-test',",
    "      baseRefName: 'main',",
    "    };",
    "    const raw = JSON.stringify(publishResult);",
    "    fs.writeFileSync(lastMessagePath, raw, 'utf8');",
    "    process.stdout.write(`${raw}\\n`);",
    "    return;",
    "  }",
    `  if (${Math.max(0, opts.taskDelayMs ?? 0)} > 0) await sleep(${Math.max(0, opts.taskDelayMs ?? 0)});`,
    "  if (taskId === 'task_02') {",
    "    const packageJsonPath = path.join(workspace, 'package.json');",
    "    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));",
    "    packageJson.scripts = { ...(packageJson.scripts || {}), smoke: 'bun run build' };",
    "    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\\n', 'utf8');",
    "  } else if (taskId === 'task_03') {",
    "    const readmePath = path.join(workspace, 'README.md');",
    "    const existing = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';",
    "    if (!existing.includes('Smoke validation checked.')) {",
    "      fs.writeFileSync(readmePath, `${existing.trimEnd()}\\n\\nSmoke validation checked.\\n`, 'utf8');",
    "    }",
    "  } else {",
    "    fs.writeFileSync(path.join(workspace, 'CLI_SMOKE.txt'), 'created by stub\\n', 'utf8');",
    "  }",
    "  const taskResult = {",
    "    outcome: 'approved',",
    "    summary: 'Stub approved result.',",
    "    artifacts: [],",
    "    scriptsRun: [{",
    "      command: 'bun run build',",
    "      summary: 'Validated the stub workspace after applying the change.',",
    "      status: 'ok',",
    "    }],",
    "    completion: {",
    "      changed: taskId === 'task_02' ? ['package.json'] : taskId === 'task_03' ? ['README.md'] : ['CLI_SMOKE.txt'],",
    "      proof: ['Stub workspace mutation applied.'],",
    "      remaining: [],",
    "    },",
    "    alignment: {",
    "      verdict: 'aligned',",
    "      satisfied: ['Applied the requested delivery change and kept the repository build green.'],",
    "      missing: [],",
    "      outOfScope: [],",
    "      rationale: 'The stub applied the requested change and ran bun run build successfully.',",
    "    },",
    "    nextAction: null,",
    "  };",
    "  const raw = JSON.stringify(taskResult);",
    "  fs.writeFileSync(lastMessagePath, raw, 'utf8');",
    "  process.stdout.write(`${raw}\\n`);",
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
  await fs.writeFile(scriptPath, `#!${BUN}\n${nodeBody}`, "utf-8");
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
  await fs.writeFile(scriptPath, `#!${BUN}\n${nodeBody}`, "utf-8");
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

test("receipt wrapper resolves the repo root when invoked through a symlink", async () => {
  const tempDir = await createTempDir("receipt-cli-wrapper");
  const repoRoot = path.join(tempDir, "repo");
  const sourceWrapper = await fs.readFile(path.join(ROOT, ".receipt", "bin", "receipt"), "utf-8");
  const fakeBinDir = path.join(tempDir, "bin");
  const fakeBun = path.join(fakeBinDir, "bun");
  const outPath = path.join(tempDir, "bun-argv.json");
  const linkPath = path.join(tempDir, "usr", "local", "bin", "receipt");

  await fs.mkdir(path.join(repoRoot, ".receipt", "bin"), { recursive: true });
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.mkdir(fakeBinDir, { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".receipt", "bin", "receipt"), sourceWrapper, "utf-8");
  await fs.chmod(path.join(repoRoot, ".receipt", "bin", "receipt"), 0o755);
  await fs.writeFile(path.join(repoRoot, "src", "cli.ts"), "export {};\n", "utf-8");
  await fs.writeFile(
    fakeBun,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(outPath)}\n`,
    "utf-8",
  );
  await fs.chmod(fakeBun, 0o755);
  await fs.symlink(path.join(repoRoot, ".receipt", "bin", "receipt"), linkPath);

  await execFileAsync(linkPath, ["--help"], {
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
    },
  });

  const recorded = (await fs.readFile(outPath, "utf-8")).trim().split("\n");
  expect(recorded[0]).toBe(path.join(repoRoot, "src", "cli.ts"));
  expect(recorded[1]).toBe("--help");
});

const createAwsStub = async (): Promise<string> => {
  const dir = await createTempDir("receipt-factory-cli-aws");
  const nodeBody = [
    "const args = process.argv.slice(2);",
    "const emit = (value) => process.stdout.write(value);",
    "if (args[0] === 'configure' && args[1] === 'list-profiles') {",
    "  emit('default\\nsandbox\\n');",
    "  process.exit(0);",
    "}",
    "const filtered = [];",
    "for (let index = 0; index < args.length; index += 1) {",
    "  const value = args[index];",
    "  if (value === '--output' || value === '--profile' || value === '--region') { index += 1; continue; }",
    "  if (value === 'json') continue;",
    "  filtered.push(value);",
    "}",
    "if (filtered[0] === 'sts' && filtered[1] === 'get-caller-identity') {",
    "  emit(JSON.stringify({ Account: '445567089271', Arn: 'arn:aws:iam::445567089271:user/test', UserId: 'AIDATEST' }));",
    "  process.exit(0);",
    "}",
    "console.error(`unsupported aws stub command: ${args.join(' ')}`);",
    "process.exit(1);",
    "",
  ].join("\n");
  if (process.platform === "win32") {
    const jsPath = path.join(dir, "aws-stub.js");
    const cmdPath = path.join(dir, "aws.cmd");
    await fs.writeFile(jsPath, nodeBody, "utf-8");
    await fs.writeFile(cmdPath, `@echo off\r\n"${BUN.replace(/\//g, "\\")}" "%~dp0\\aws-stub.js" %*\r\n`, "utf-8");
    return dir;
  }
  const scriptPath = path.join(dir, "aws");
  await fs.writeFile(scriptPath, `#!${BUN}\n${nodeBody}`, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return dir;
};

const seedObjectiveReplay = async (
  dataDir: string,
  objectiveId: string,
  receipts: ReadonlyArray<FactoryEvent>,
): Promise<void> => {
  const runtime = createRuntime<FactoryCmd, FactoryEvent, typeof initialFactoryState>(
    sqliteReceiptStore<FactoryEvent>(dataDir),
    sqliteBranchStore(dataDir),
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
    sqliteReceiptStore<AgentEvent>(dataDir),
    sqliteBranchStore(dataDir),
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

const seedJobReplay = async (
  dataDir: string,
  stream: string,
  receipts: ReadonlyArray<JobEvent>,
): Promise<void> => {
  const runtime = createRuntime<JobCmd, JobEvent, typeof initialJobState>(
    sqliteReceiptStore<JobEvent>(dataDir),
    sqliteBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJobState,
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

test("receipt cli: dst and jobs help return usage without executing the command", async () => {
  const [dstHelp, jobsHelp] = await Promise.all([
    runCli(["dst", "--help"]),
    runCli(["jobs", "--help"]),
  ]);

  expect(dstHelp.code).toBe(0);
  expect(dstHelp.stdout).toContain("receipt <command> [args]");
  expect(dstHelp.stdout).toContain("receipt dst");

  expect(jobsHelp.code).toBe(0);
  expect(jobsHelp.stdout).toContain("receipt <command> [args]");
  expect(jobsHelp.stdout).toContain("receipt jobs");
  expect(jobsHelp.stdout).not.toContain("\"jobs\":");
});

test("factory cli: investigate and audit help return usage without executing the analysis", async () => {
  const [investigateHelp, auditHelp] = await Promise.all([
    runCli(["factory", "investigate", "--help"]),
    runCli(["factory", "audit", "--help"]),
  ]);

  expect(investigateHelp.code).toBe(0);
  expect(investigateHelp.stdout).toContain("receipt factory investigate");
  expect(investigateHelp.stdout).toContain("--as-of-ts");

  expect(auditHelp.code).toBe(0);
  expect(auditHelp.stdout).toContain("receipt factory audit");
  expect(auditHelp.stdout).toContain("--limit");
});

const makeWorkbenchSnapshot = () => {
  const detail = {
    objectiveId: "objective_demo",
    title: "CLI workbench objective",
    status: "executing",
    phase: "collecting_evidence",
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
      promptPath: "profiles/generalist/PROFILE.md",
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
    selfImprovement: {
      auditedAt: 6,
      auditStatus: "ready",
      stale: false,
      recommendationStatus: "ready",
      recommendations: [{
        summary: "Expose self-improvement recommendations in the CLI overview.",
        anomalyPatterns: ["missing-cli-visibility"],
        scope: "cli",
        confidence: "high",
        suggestedFix: "Render the latest audit recommendations in the objective overview panel.",
      }],
      autoFixObjectiveId: "objective_auto_fix",
      recurringPatterns: [{
        pattern: "missing-cli-visibility",
        count: 3,
      }],
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

test("factory cli: text panels lead with active and next task summaries", () => {
  const snapshot = makeWorkbenchSnapshot();
  const tasksText = renderObjectivePanelText(snapshot.detail as never, snapshot.live as never, snapshot.debug as never, "tasks");
  const liveText = renderObjectivePanelText(snapshot.detail as never, snapshot.live as never, snapshot.debug as never, "live");

  expect(tasksText).toContain("active=task_01 [running] Implement workbench shell");
  expect(tasksText).toContain("next=task_02 [ready] Follow-up validation");
  expect(tasksText).toContain("counts=total:2 active:1 ready:1 blocked:0");
  expect(liveText).toContain("focus=task_01 [running] Implement workbench shell");
  expect(liveText).toContain("signal=Rendering the CLI workbench.");
});

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

test("factory cli: audit supports a targeted objective without changing the recent-window flow", async () => {
  const repoDir = await createRepo();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);

  const runtimeConfig = await resolveFactoryRuntimeConfig(repoDir);
  const olderObjectiveId = "objective_audit_older";
  const targetedObjectiveId = "objective_audit_targeted";
  await seedObjectiveReplay(runtimeConfig.dataDir, olderObjectiveId, [
    {
      type: "objective.created",
      objectiveId: olderObjectiveId,
      title: "Older audit objective",
      prompt: "Older objective for audit sampling.",
      channel: "results",
      baseHash: "old-base",
      objectiveMode: "investigation",
      severity: 2,
      checks: [],
      checksSource: "default",
      profile: {
        rootProfileId: "generalist",
        rootProfileLabel: "Generalist",
        resolvedProfileHash: "hash-old",
        promptHash: "prompt-old",
        promptPath: "profiles/software/PROFILE.md",
        selectedSkills: [],
        objectivePolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      },
      policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      createdAt: 1_000,
      updatedAt: 1_000,
    } as FactoryEvent,
  ]);
  await seedObjectiveReplay(runtimeConfig.dataDir, targetedObjectiveId, [
    {
      type: "objective.created",
      objectiveId: targetedObjectiveId,
      title: "Targeted audit objective",
      prompt: "Targeted objective for audit selection.",
      channel: "results",
      baseHash: "target-base",
      objectiveMode: "investigation",
      severity: 2,
      checks: [],
      checksSource: "default",
      profile: {
        rootProfileId: "generalist",
        rootProfileLabel: "Generalist",
        resolvedProfileHash: "hash-target",
        promptHash: "prompt-target",
        promptPath: "profiles/software/PROFILE.md",
        selectedSkills: [],
        objectivePolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      },
      policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      createdAt: 2_000,
      updatedAt: 2_000,
    } as FactoryEvent,
  ]);

  const recent = await runCli(["factory", "audit", "--limit", "1", "--json", "--repo-root", repoDir]);
  expect(recent.code).toBe(0);
  const recentPayload = JSON.parse(recent.stdout) as {
    readonly summary: { readonly objectivesAudited: number; readonly sampledObjectiveIds: ReadonlyArray<string> };
  };
  expect(recentPayload.summary.objectivesAudited).toBe(1);
  expect(recentPayload.summary.sampledObjectiveIds).toEqual([targetedObjectiveId]);

  const targeted = await runCli([
    "factory",
    "audit",
    "--objective",
    targetedObjectiveId,
    "--json",
    "--repo-root",
    repoDir,
  ]);
  expect(targeted.code).toBe(0);
  const targetedPayload = JSON.parse(targeted.stdout) as {
    readonly summary: { readonly objectivesAudited: number; readonly sampledObjectiveIds: ReadonlyArray<string> };
    readonly objectives: ReadonlyArray<{ readonly objectiveId: string }>;
  };
  expect(targetedPayload.summary.objectivesAudited).toBe(1);
  expect(targetedPayload.summary.sampledObjectiveIds).toEqual([targetedObjectiveId]);
  expect(targetedPayload.objectives.map((objective) => objective.objectiveId)).toEqual([targetedObjectiveId]);

  const targetedText = await runCli([
    "factory",
    "audit",
    "--objective",
    targetedObjectiveId,
    "--repo-root",
    repoDir,
  ]);
  expect(targetedText.code).toBe(0);
  expect(targetedText.stdout).toContain(`Targeted objective: ${targetedObjectiveId}`);
  expect(targetedText.stdout).toContain("Objectives audited: 1");
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

test("factory cli: analyze summarizes run sequence, job control noise, and agent tool errors", async () => {
  const repoDir = await createRepo();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);

  const runtimeConfig = await resolveFactoryRuntimeConfig(repoDir);
  const objectiveId = "objective_test_analysis_01";
  const task01JobId = `job_factory_${objectiveId}_task_01_task_01_candidate_01`;
  const task02JobId = `job_factory_${objectiveId}_task_02_task_02_candidate_01`;
  const controlJob1 = "job_test_control_01";
  const controlJob2 = "job_test_control_02";
  const agentRunStream = `agents/factory/test/infrastructure/objectives/${objectiveId}/runs/run_analysis_01`;

  await seedObjectiveReplay(runtimeConfig.dataDir, objectiveId, [
    {
      type: "objective.created",
      objectiveId,
      title: "Analyze a flaky infrastructure run",
      prompt: "Inspect the run and explain what went wrong.",
      channel: "results",
      baseHash: "abc123",
      objectiveMode: "investigation",
      severity: 2,
      checks: [],
      checksSource: "default",
      profile: {
        rootProfileId: "infrastructure",
        rootProfileLabel: "Infrastructure",
        resolvedProfileHash: "profile-hash",
        promptHash: "prompt-hash",
        promptPath: "profiles/infrastructure/PROFILE.md",
        selectedSkills: ["skills/factory-infrastructure-aws/SKILL.md"],
        objectivePolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      },
      policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      createdAt: 1_000,
    },
    {
      type: "task.added",
      objectiveId,
      createdAt: 1_100,
      task: {
        nodeId: "task_01",
        taskId: "task_01",
        taskKind: "planned",
        title: "list ec2 containers",
        prompt: "Inspect ECS and EKS resources.",
        workerType: "codex",
        baseCommit: "abc123",
        dependsOn: [],
        status: "pending",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: 1_100,
      },
    },
    {
      type: "task.ready",
      objectiveId,
      taskId: "task_01",
      readyAt: 1_200,
    },
    {
      type: "candidate.created",
      objectiveId,
      createdAt: 1_250,
      candidate: {
        candidateId: "task_01_candidate_01",
        taskId: "task_01",
        status: "planned",
        baseCommit: "abc123",
        checkResults: [],
        artifactRefs: {},
        createdAt: 1_250,
        updatedAt: 1_250,
      },
    },
    {
      type: "task.dispatched",
      objectiveId,
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
      jobId: task01JobId,
      workspaceId: "workspace_task_01",
      workspacePath: "/tmp/workspace_task_01",
      skillBundlePaths: [],
      contextRefs: [],
      startedAt: 1_300,
    },
    {
      type: "objective.operator.noted",
      objectiveId,
      message: "Current run failed with `Module not found \"/usr/src/cli.ts\"`.",
      notedAt: 1_500,
    },
    {
      type: "task.blocked",
      objectiveId,
      taskId: "task_01",
      reason: "Module not found \"/usr/src/cli.ts\"",
      blockedAt: 1_600,
    },
    {
      type: "task.superseded",
      objectiveId,
      taskId: "task_01",
      reason: "Superseded by operator follow-up.",
      supersededAt: 1_700,
    },
    {
      type: "task.added",
      objectiveId,
      createdAt: 1_800,
      task: {
        nodeId: "task_02",
        taskId: "task_02",
        taskKind: "planned",
        title: "list ec2 containers",
        prompt: "Use AWS CLI directly and report concrete evidence.",
        workerType: "codex",
        baseCommit: "abc123",
        dependsOn: [],
        status: "pending",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: 1_800,
      },
    },
    {
      type: "task.ready",
      objectiveId,
      taskId: "task_02",
      readyAt: 1_850,
    },
    {
      type: "candidate.created",
      objectiveId,
      createdAt: 1_875,
      candidate: {
        candidateId: "task_02_candidate_01",
        taskId: "task_02",
        status: "planned",
        baseCommit: "abc123",
        checkResults: [],
        artifactRefs: {},
        createdAt: 1_875,
        updatedAt: 1_875,
      },
    },
    {
      type: "task.dispatched",
      objectiveId,
      taskId: "task_02",
      candidateId: "task_02_candidate_01",
      jobId: task02JobId,
      workspaceId: "workspace_task_02",
      workspacePath: "/tmp/workspace_task_02",
      skillBundlePaths: [],
      contextRefs: [],
      startedAt: 1_900,
    },
    {
      type: "investigation.reported",
      objectiveId,
      taskId: "task_02",
      candidateId: "task_02_candidate_01",
      outcome: "approved",
      summary: "Used AWS CLI directly and confirmed the workload is Fargate-only.",
      handoff: "Ready for synthesis.",
      completion: {
        changed: [],
        proof: ["aws ecs list-clusters", "aws ecs describe-tasks"],
        remaining: [],
      },
      report: {
        conclusion: "No EC2-backed container workloads found.",
        evidence: [{
          title: "ECS result",
          summary: "The only running tasks were Fargate.",
        }],
        scriptsRun: [{
          command: "aws ecs list-clusters",
          status: "ok",
          summary: "Enumerated ECS clusters.",
        }],
        disagreements: [],
        nextSteps: [],
      },
      artifactRefs: {},
      reportedAt: 2_500,
    },
    {
      type: "objective.completed",
      objectiveId,
      summary: "Used AWS CLI directly and confirmed the workload is Fargate-only.",
      completedAt: 2_600,
    },
  ]);

  await seedAgentReplay(runtimeConfig.dataDir, agentRunStream, [
    {
      type: "problem.set",
      runId: "run_analysis_01",
      problem: "analyze the latest run and identify what should improve",
      agentId: "orchestrator",
    },
    {
      type: "run.configured",
      runId: "run_analysis_01",
      agentId: "orchestrator",
      workflow: { id: "factory-chat-v1", version: "1.0.0" },
      config: {
        maxIterations: 4,
        maxToolOutputChars: 6_000,
        memoryScope: `repos/test/profiles/infrastructure/objectives/${objectiveId}`,
        workspace: ".",
        extra: {
          profileId: "infrastructure",
          objectiveId,
          stream: `agents/factory/test/infrastructure/objectives/${objectiveId}`,
        },
      },
      model: "gpt-5.2",
      promptHash: "prompt-hash",
      promptPath: "profiles/infrastructure/PROFILE.md",
    },
    {
      type: "thread.bound",
      runId: "run_analysis_01",
      agentId: "orchestrator",
      objectiveId,
      reason: "startup",
    },
    {
      type: "run.status",
      runId: "run_analysis_01",
      status: "running",
      agentId: "orchestrator",
    },
    {
      type: "iteration.started",
      runId: "run_analysis_01",
      iteration: 1,
      agentId: "orchestrator",
    },
    {
      type: "thought.logged",
      runId: "run_analysis_01",
      iteration: 1,
      agentId: "orchestrator",
      content: "Need the concrete task output before proposing fixes.",
    },
    {
      type: "action.planned",
      runId: "run_analysis_01",
      iteration: 1,
      agentId: "orchestrator",
      actionType: "tool",
      name: "factory.output",
      input: { objectiveId },
    },
    {
      type: "tool.called",
      runId: "run_analysis_01",
      iteration: 1,
      agentId: "orchestrator",
      tool: "factory.output",
      input: { objectiveId },
      summary: "failed",
      durationMs: 3,
      error: "factory.output requires focusKind/focusId, taskId/jobId, or an objective with exactly one task",
    },
    {
      type: "iteration.started",
      runId: "run_analysis_01",
      iteration: 2,
      agentId: "orchestrator",
    },
    {
      type: "action.planned",
      runId: "run_analysis_01",
      iteration: 2,
      agentId: "orchestrator",
      actionType: "tool",
      name: "factory.output",
      input: { objectiveId, taskId: "task_02" },
    },
    {
      type: "tool.called",
      runId: "run_analysis_01",
      iteration: 2,
      agentId: "orchestrator",
      tool: "factory.output",
      input: { objectiveId, taskId: "task_02" },
      summary: "task output",
      durationMs: 12,
    },
    {
      type: "tool.observed",
      runId: "run_analysis_01",
      iteration: 2,
      agentId: "orchestrator",
      tool: "factory.output",
      output: "{\"status\":\"completed\"}",
      truncated: false,
    },
    {
      type: "validation.report",
      runId: "run_analysis_01",
      iteration: 2,
      agentId: "orchestrator",
      gate: "model_json",
      ok: true,
      summary: "native structured action parsed",
    },
    {
      type: "response.finalized",
      runId: "run_analysis_01",
      agentId: "orchestrator",
      content: "Task 01 failed due to the CLI path assumption, then task 02 recovered with direct AWS CLI evidence.",
    },
    {
      type: "run.status",
      runId: "run_analysis_01",
      status: "completed",
      agentId: "orchestrator",
    },
  ]);

  await seedJobReplay(runtimeConfig.dataDir, `jobs/${task01JobId}`, [
    {
      type: "job.enqueued",
      jobId: task01JobId,
      agentId: "codex",
      lane: "collect",
      payload: {
        kind: "factory.task.run",
        objectiveId,
        taskId: "task_01",
        candidateId: "task_01_candidate_01",
      },
      maxAttempts: 2,
      sessionKey: `factory:${objectiveId}:task_01`,
      singletonMode: "allow",
      createdAt: 1_300,
    },
    {
      type: "job.leased",
      jobId: task01JobId,
      workerId: "worker-codex",
      leaseMs: 900_000,
      attempt: 1,
    },
    {
      type: "job.progress",
      jobId: task01JobId,
      workerId: "worker-codex",
      result: {
        summary: "Codex started working.",
        progressAt: 1_320,
        eventType: "turn.started",
      },
    },
    {
      type: "queue.command",
      jobId: task01JobId,
      commandId: "cmd_abort_01",
      command: "abort",
      lane: "steer",
      payload: { reason: "rerun without relying on /usr/src/cli.ts" },
      by: "factory.chat",
      createdAt: 1_550,
    },
    {
      type: "job.canceled",
      jobId: task01JobId,
      reason: "abort requested",
      by: "worker-codex",
    },
  ]);

  await seedJobReplay(runtimeConfig.dataDir, `jobs/${task02JobId}`, [
    {
      type: "job.enqueued",
      jobId: task02JobId,
      agentId: "codex",
      lane: "collect",
      payload: {
        kind: "factory.task.run",
        objectiveId,
        taskId: "task_02",
        candidateId: "task_02_candidate_01",
      },
      maxAttempts: 2,
      sessionKey: `factory:${objectiveId}:task_02`,
      singletonMode: "allow",
      createdAt: 1_900,
    },
    {
      type: "job.leased",
      jobId: task02JobId,
      workerId: "worker-codex",
      leaseMs: 900_000,
      attempt: 1,
    },
    {
      type: "job.progress",
      jobId: task02JobId,
      workerId: "worker-codex",
      result: {
        summary: "Codex completed the turn.",
        progressAt: 2_480,
        eventType: "turn.completed",
        tokensUsed: 456,
      },
    },
    {
      type: "job.completed",
      jobId: task02JobId,
      workerId: "worker-codex",
      result: {
        objectiveId,
        taskId: "task_02",
        candidateId: "task_02_candidate_01",
        summary: "Used AWS CLI directly.",
        tokensUsed: 456,
      },
    },
  ]);

  for (const controlJobId of [controlJob1, controlJob2]) {
    await seedJobReplay(runtimeConfig.dataDir, `jobs/${controlJobId}`, [
      {
        type: "job.enqueued",
        jobId: controlJobId,
        agentId: "factory",
        lane: "steer",
        payload: {
          kind: "factory.objective.control",
          objectiveId,
        },
        maxAttempts: 1,
        sessionKey: `factory:objective:${objectiveId}`,
        singletonMode: "allow",
        createdAt: 2_700,
      },
      {
        type: "job.leased",
        jobId: controlJobId,
        workerId: "worker-factory",
        leaseMs: 60_000,
        attempt: 1,
      },
      {
        type: "job.completed",
        jobId: controlJobId,
        workerId: "worker-factory",
        result: {
          objectiveId,
          summary: "control reconcile complete",
        },
      },
    ]);
  }

  const analyze = await runCli([
    "factory",
    "analyze",
    objectiveId,
    "--json",
    "--repo-root",
    repoDir,
  ]);
  expect(analyze.code).toBe(0);
  const payload = JSON.parse(analyze.stdout) as {
    readonly objectiveId: string;
    readonly metrics: {
      readonly objective: {
        readonly maxObservedActiveTasks: number;
        readonly eventCounts: Readonly<Record<string, number>>;
      };
      readonly tasks: {
        readonly total: number;
      };
      readonly jobs: {
        readonly total: number;
        readonly controlJobs: number;
      };
      readonly agent: {
        readonly runCount: number;
        readonly toolCalls: number;
        readonly toolErrors: number;
        readonly topTools: ReadonlyArray<{
          readonly tool: string;
          readonly count: number;
          readonly errorCount: number;
        }>;
      };
    };
    readonly anomalies: ReadonlyArray<{
      readonly kind: string;
      readonly summary: string;
    }>;
    readonly recommendations: ReadonlyArray<{
      readonly summary: string;
    }>;
  };

  expect(payload.objectiveId).toBe(objectiveId);
  expect(payload.metrics.objective.maxObservedActiveTasks).toBe(1);
  expect(payload.metrics.objective.eventCounts["task.dispatched"]).toBe(2);
  expect(payload.metrics.tasks.total).toBe(2);
  expect(payload.metrics.jobs.total).toBe(4);
  expect(payload.metrics.jobs.controlJobs).toBe(2);
  expect(payload.metrics.agent.runCount).toBe(1);
  expect(payload.metrics.agent.toolCalls).toBe(2);
  expect(payload.metrics.agent.toolErrors).toBe(1);
  expect(payload.metrics.agent.topTools[0]).toMatchObject({
    tool: "factory.output",
    count: 2,
    errorCount: 1,
  });
  expect(payload.anomalies.some((anomaly) => anomaly.kind === "tool_error")).toBe(true);
  expect(payload.anomalies.some((anomaly) => anomaly.kind === "repeated_control_job")).toBe(true);
  expect(payload.recommendations).toEqual([]);
}, 120_000);

test("factory cli: parse stitches chat, objective, job, and task artifact data into one bundle", async () => {
  const repoDir = await createRepo();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);

  const runtimeConfig = await resolveFactoryRuntimeConfig(repoDir);
  const chatId = "chat_parse_bundle_01";
  const objectiveId = "objective_parse_bundle_01";
  const runId = "run_parse_bundle_01";
  const taskJobId = `job_factory_${objectiveId}_task_01_task_01_candidate_01`;
  const sessionStream = `agents/factory/test/infrastructure/sessions/${chatId}`;
  const runStream = `${sessionStream}/runs/${runId}`;

  const containerRoot = path.posix.join("/workspace", path.basename(repoDir));
  const workspaceId = `${objectiveId}_task_01_task_01_candidate_01`;
  const localFactoryDir = path.join(repoDir, ".receipt", "data", "hub", "worktrees", workspaceId, ".receipt", "factory");
  const containerFactoryDir = path.posix.join(containerRoot, ".receipt", "data", "hub", "worktrees", workspaceId, ".receipt", "factory");

  await fs.mkdir(localFactoryDir, { recursive: true });
  await fs.writeFile(path.join(localFactoryDir, "task_01.manifest.json"), JSON.stringify({
    objective: {
      objectiveId,
      title: "Check last month AWS spend",
      prompt: "What was my AWS bill last month?",
    },
    task: {
      taskId: "task_01",
      title: "Collect AWS billing evidence",
      prompt: "Use Cost Explorer and return the monthly total with evidence.",
    },
    candidate: {
      candidateId: "task_01_candidate_01",
    },
  }, null, 2), "utf-8");
  await fs.writeFile(path.join(localFactoryDir, "task_01.context-pack.json"), JSON.stringify({
    objectiveId,
    title: "Check last month AWS spend",
    task: {
      taskId: "task_01",
      title: "Collect AWS billing evidence",
      prompt: "Use Cost Explorer and return the monthly total with evidence.",
      candidateId: "task_01_candidate_01",
      status: "running",
    },
    recentReceipts: [
      {
        type: "task.dispatched",
        at: 2_220,
        taskId: "task_01",
        candidateId: "task_01_candidate_01",
        summary: "task.dispatched",
      },
    ],
  }, null, 2), "utf-8");
  await fs.writeFile(path.join(localFactoryDir, "task_01.result.json"), JSON.stringify({
    outcome: "approved",
    summary: "Reported total cost of 42.42 USD for the previous month.",
    tokensUsed: 3210,
    report: {
      conclusion: "Total cost was 42.42 USD for 2026-02-01 through 2026-03-01.",
    },
  }, null, 2), "utf-8");
  await fs.writeFile(
    path.join(localFactoryDir, "task_01.last-message.md"),
    "{\"outcome\":\"approved\",\"summary\":\"Reported total cost of 42.42 USD for the previous month.\"}\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(localFactoryDir, "task_01.stdout.log"),
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread_parse_bundle_01" }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "python3 tools/billing.py --month previous",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "python3 tools/billing.py --month previous",
          aggregated_output: "{\"total\":\"42.42\",\"currency\":\"USD\"}",
          exit_code: 0,
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_2",
          type: "agent_message",
          text: "{\"outcome\":\"approved\",\"summary\":\"Reported total cost of 42.42 USD for the previous month.\"}",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 111,
          cached_input_tokens: 22,
          output_tokens: 33,
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
  await fs.writeFile(path.join(localFactoryDir, "task_01.stderr.log"), "", "utf-8");

  await seedObjectiveReplay(runtimeConfig.dataDir, objectiveId, [
    {
      type: "objective.created",
      objectiveId,
      title: "Check last month AWS spend",
      prompt: "What was my AWS bill last month?",
      channel: "results",
      baseHash: "abc123",
      objectiveMode: "investigation",
      severity: 2,
      checks: [],
      checksSource: "default",
      profile: {
        rootProfileId: "infrastructure",
        rootProfileLabel: "Infrastructure",
        resolvedProfileHash: "profile-hash",
        promptHash: "prompt-hash",
        promptPath: "profiles/infrastructure/PROFILE.md",
        selectedSkills: ["skills/factory-infrastructure-aws/SKILL.md"],
        objectivePolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      },
      policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      createdAt: 2_000,
    },
    {
      type: "task.added",
      objectiveId,
      createdAt: 2_100,
      task: {
        nodeId: "task_01",
        taskId: "task_01",
        taskKind: "planned",
        title: "Collect AWS billing evidence",
        prompt: "Use Cost Explorer and return the monthly total with evidence.",
        workerType: "codex",
        baseCommit: "abc123",
        dependsOn: [],
        status: "pending",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: 2_100,
      },
    },
    {
      type: "task.ready",
      objectiveId,
      taskId: "task_01",
      readyAt: 2_150,
    },
    {
      type: "candidate.created",
      objectiveId,
      createdAt: 2_180,
      candidate: {
        candidateId: "task_01_candidate_01",
        taskId: "task_01",
        status: "planned",
        baseCommit: "abc123",
        checkResults: [],
        artifactRefs: {},
        createdAt: 2_180,
        updatedAt: 2_180,
      },
    },
    {
      type: "task.dispatched",
      objectiveId,
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
      jobId: taskJobId,
      workspaceId,
      workspacePath: path.posix.join(containerRoot, ".receipt", "data", "hub", "worktrees", workspaceId),
      skillBundlePaths: [],
      contextRefs: [],
      startedAt: 2_220,
    },
    {
      type: "investigation.reported",
      objectiveId,
      taskId: "task_01",
      candidateId: "task_01_candidate_01",
      outcome: "approved",
      summary: "Reported total cost of 42.42 USD for the previous month.",
      handoff: "Ready to answer the operator.",
      completion: {
        changed: [],
        proof: ["Cost Explorer returned 42.42 USD."],
        remaining: [],
      },
      report: {
        conclusion: "Total cost was 42.42 USD for 2026-02-01 through 2026-03-01.",
        evidence: [{
          title: "Cost Explorer total",
          summary: "Returned 42.42 USD.",
        }],
        scriptsRun: [{
          command: "python3 tools/billing.py --month previous",
          status: "ok",
          summary: "Queried Cost Explorer.",
        }],
        disagreements: [],
        nextSteps: [],
      },
      artifactRefs: {
        result: {
          kind: "file",
          ref: path.posix.join(containerFactoryDir, "task_01.result.json"),
          label: "task result",
        },
      },
      reportedAt: 2_900,
    },
    {
      type: "objective.completed",
      objectiveId,
      summary: "Reported total cost of 42.42 USD for the previous month.",
      completedAt: 2_950,
    },
  ]);

  await seedJobReplay(runtimeConfig.dataDir, `jobs/${taskJobId}`, [
    {
      type: "job.enqueued",
      jobId: taskJobId,
      agentId: "codex",
      lane: "collect",
      payload: {
        kind: "factory.task.run",
        objectiveId,
        taskId: "task_01",
        candidateId: "task_01_candidate_01",
        workspaceId,
        workspacePath: path.posix.join(containerRoot, ".receipt", "data", "hub", "worktrees", workspaceId),
        promptPath: path.posix.join(containerFactoryDir, "task_01.prompt.md"),
        resultPath: path.posix.join(containerFactoryDir, "task_01.result.json"),
        stdoutPath: path.posix.join(containerFactoryDir, "task_01.stdout.log"),
        stderrPath: path.posix.join(containerFactoryDir, "task_01.stderr.log"),
        lastMessagePath: path.posix.join(containerFactoryDir, "task_01.last-message.md"),
        manifestPath: path.posix.join(containerFactoryDir, "task_01.manifest.json"),
        contextPackPath: path.posix.join(containerFactoryDir, "task_01.context-pack.json"),
      },
      maxAttempts: 1,
      sessionKey: `factory:${objectiveId}:task_01`,
      singletonMode: "allow",
      createdAt: 2_220,
    },
    {
      type: "job.leased",
      jobId: taskJobId,
      workerId: "worker-codex",
      leaseMs: 900_000,
      attempt: 1,
    },
    {
      type: "job.progress",
      jobId: taskJobId,
      workerId: "worker-codex",
      result: {
        status: "running",
        summary: "Running billing query.",
        progressAt: 2_400,
        eventType: "item.started",
      },
    },
    {
      type: "job.progress",
      jobId: taskJobId,
      workerId: "worker-codex",
      result: {
        status: "running",
        summary: "Codex completed the turn.",
        progressAt: 2_880,
        eventType: "turn.completed",
        lastMessage: "{\"outcome\":\"approved\",\"summary\":\"Reported total cost of 42.42 USD for the previous month.\"}",
        tokensUsed: 3210,
      },
    },
    {
      type: "job.completed",
      jobId: taskJobId,
      workerId: "worker-codex",
      result: {
        objectiveId,
        taskId: "task_01",
        candidateId: "task_01_candidate_01",
        summary: "Reported total cost of 42.42 USD for the previous month.",
      },
    },
  ]);

  await seedAgentReplay(runtimeConfig.dataDir, sessionStream, [
    {
      type: "problem.set",
      runId,
      problem: "what was my AWS bill last month?",
      agentId: "orchestrator",
    },
    {
      type: "run.configured",
      runId,
      agentId: "orchestrator",
      workflow: { id: "factory-chat-v1", version: "1.0.0" },
      config: {
        maxIterations: 8,
        maxToolOutputChars: 6_000,
        memoryScope: `repos/test/profiles/infrastructure/objectives/${objectiveId}`,
        workspace: ".",
        extra: {
          profileId: "infrastructure",
          objectiveId,
          stream: sessionStream,
        },
      },
      model: "gpt-5.2",
      promptHash: "prompt-hash",
      promptPath: "profiles/infrastructure/PROFILE.md",
    },
    {
      type: "thread.bound",
      runId,
      agentId: "orchestrator",
      objectiveId,
      chatId,
      reason: "startup",
    },
    {
      type: "response.finalized",
      runId,
      agentId: "orchestrator",
      content: "Your AWS bill last month was $42.42 USD.",
    },
    {
      type: "run.status",
      runId,
      agentId: "orchestrator",
      status: "completed",
    },
  ]);

  await seedAgentReplay(runtimeConfig.dataDir, runStream, [
    {
      type: "problem.set",
      runId,
      problem: "what was my AWS bill last month?",
      agentId: "orchestrator",
    },
    {
      type: "run.configured",
      runId,
      agentId: "orchestrator",
      workflow: { id: "factory-chat-v1", version: "1.0.0" },
      config: {
        maxIterations: 8,
        maxToolOutputChars: 6_000,
        memoryScope: `repos/test/profiles/infrastructure/objectives/${objectiveId}`,
        workspace: ".",
        extra: {
          profileId: "infrastructure",
          objectiveId,
          stream: sessionStream,
        },
      },
      model: "gpt-5.2",
      promptHash: "prompt-hash",
      promptPath: "profiles/infrastructure/PROFILE.md",
    },
    {
      type: "thread.bound",
      runId,
      agentId: "orchestrator",
      objectiveId,
      chatId,
      reason: "startup",
    },
    {
      type: "run.status",
      runId,
      agentId: "orchestrator",
      status: "running",
    },
    {
      type: "iteration.started",
      runId,
      iteration: 1,
      agentId: "orchestrator",
    },
    {
      type: "thought.logged",
      runId,
      iteration: 1,
      agentId: "orchestrator",
      content: "Wait for the task output, then answer with the total.",
    },
    {
      type: "action.planned",
      runId,
      iteration: 1,
      agentId: "orchestrator",
      actionType: "tool",
      name: "factory.output",
      input: { objectiveId, taskId: "task_01" },
    },
    {
      type: "tool.called",
      runId,
      iteration: 1,
      agentId: "orchestrator",
      tool: "factory.output",
      input: { objectiveId, taskId: "task_01" },
      summary: "task output",
      durationMs: 14,
    },
    {
      type: "tool.observed",
      runId,
      iteration: 1,
      agentId: "orchestrator",
      tool: "factory.output",
      output: "{\"summary\":\"Reported total cost of 42.42 USD for the previous month.\"}",
      truncated: false,
    },
    {
      type: "response.finalized",
      runId,
      agentId: "orchestrator",
      content: "Your AWS bill last month was $42.42 USD.",
    },
    {
      type: "run.status",
      runId,
      agentId: "orchestrator",
      status: "completed",
    },
  ]);

  const parse = await runCli([
    "factory",
    "parse",
    chatId,
    "--json",
    "--repo-root",
    repoDir,
  ]);

  expect(parse.code).toBe(0);
  const payload = JSON.parse(parse.stdout) as {
    readonly resolved: {
      readonly kind: string;
    };
    readonly links: {
      readonly objectiveId?: string;
      readonly chatId?: string;
      readonly jobId?: string;
      readonly runId?: string;
    };
    readonly outputs: {
      readonly finalResponse?: string;
      readonly result?: {
        readonly summary?: string;
      };
    };
    readonly taskRuns: ReadonlyArray<{
      readonly jobId: string;
      readonly resultFile: {
        readonly exists: boolean;
        readonly resolvedPath?: string;
      };
      readonly stdout: {
        readonly commands: ReadonlyArray<{
          readonly command: string;
          readonly exitCode?: number | null;
          readonly status: string;
        }>;
        readonly usage?: {
          readonly outputTokens?: number;
        };
      };
    }>;
    readonly timeline: ReadonlyArray<{
      readonly source: string;
      readonly type: string;
    }>;
  };

  expect(payload.resolved.kind).toBe("chat");
  expect(payload.links.objectiveId).toBe(objectiveId);
  expect(payload.links.chatId).toBe(chatId);
  expect(payload.links.jobId).toBe(taskJobId);
  expect(payload.links.runId).toBe(runId);
  expect(payload.outputs.finalResponse).toBe("Your AWS bill last month was $42.42 USD.");
  expect(payload.outputs.result?.summary).toBe("Reported total cost of 42.42 USD for the previous month.");
  expect(payload.taskRuns).toHaveLength(1);
  expect(payload.taskRuns[0]?.jobId).toBe(taskJobId);
  expect(payload.taskRuns[0]?.resultFile.exists).toBe(true);
  expect(payload.taskRuns[0]?.resultFile.resolvedPath).toBe(path.join(localFactoryDir, "task_01.result.json"));
  expect(payload.taskRuns[0]?.stdout.commands[0]).toMatchObject({
    command: "python3 tools/billing.py --month previous",
    exitCode: 0,
    status: "completed",
  });
  expect(payload.taskRuns[0]?.stdout.usage?.outputTokens).toBe(33);
  expect(payload.timeline.some((entry) => entry.source === "objective" && entry.type === "objective.completed")).toBe(true);
  expect(payload.timeline.some((entry) => entry.source === "run" && entry.type === "response.finalized")).toBe(true);

  const parseCandidate = await runCli([
    "factory",
    "parse",
    "task_01_candidate_01",
    "--json",
    "--repo-root",
    repoDir,
  ]);

  expect(parseCandidate.code).toBe(0);
  const candidatePayload = JSON.parse(parseCandidate.stdout) as {
    readonly resolved: {
      readonly kind: string;
      readonly focusKind?: string;
      readonly focusId?: string;
    };
    readonly links: {
      readonly objectiveId?: string;
      readonly taskId?: string;
      readonly candidateId?: string;
      readonly jobId?: string;
    };
    readonly outputs: {
      readonly result?: {
        readonly summary?: string;
      };
    };
  };

  expect(candidatePayload.resolved.kind).toBe("objective");
  expect(candidatePayload.resolved.focusKind).toBe("candidate");
  expect(candidatePayload.resolved.focusId).toBe("task_01_candidate_01");
  expect(candidatePayload.links.objectiveId).toBe(objectiveId);
  expect(candidatePayload.links.taskId).toBe("task_01");
  expect(candidatePayload.links.candidateId).toBe("task_01_candidate_01");
  expect(candidatePayload.links.jobId).toBe(taskJobId);
  expect(candidatePayload.outputs.result?.summary).toBe("Reported total cost of 42.42 USD for the previous month.");
}, 120_000);

test("factory runtime config: shared resolver follows .receipt/config.json", async () => {
  const repoDir = await createRepo();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);
  const resolved = await resolveFactoryRuntimeConfig(repoDir);
  expect(resolved.repoRoot).toBe(repoDir);
  expect(resolved.dataDir).toBe(path.join(repoDir, ".receipt", "data"));
  expect(resolved.repoSlotConcurrency).toBe(20);
  expect(resolved.configPath).toBe(path.join(repoDir, ".receipt", "config.json"));
}, 120_000);

test("factory runtime config: parses recurring schedules from .receipt/config.json", async () => {
  const repoDir = await createRepo();
  const configDir = path.join(repoDir, ".receipt");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), `${JSON.stringify({
    repoRoot: ".",
    dataDir: ".receipt/data",
    codexBin: "codex",
    repoSlotConcurrency: 5,
    schedules: [
      {
        id: "software-improver",
        agentId: "factory",
        intervalMs: 21_600_000,
        lane: "chat",
        payload: {
          kind: "factory.run",
          stream: "agents/factory/sessions/software-improver",
          profileId: "software",
          problem: "Review recent repo memory and create or react a scoped delivery objective.",
          config: {
            maxIterations: 6,
          },
        },
      },
      {
        id: "disabled-example",
        enabled: false,
        agentId: "agent",
        intervalMs: 10_000,
        payload: {
          kind: "agent.run",
          problem: "should not load",
        },
      },
    ],
  }, null, 2)}\n`, "utf-8");

  const resolved = await resolveFactoryRuntimeConfig(repoDir);
  expect(resolved.repoSlotConcurrency).toBe(5);
  expect(resolved.schedules).toEqual([
    {
      id: "software-improver",
      agentId: "factory",
      intervalMs: 21_600_000,
      lane: "chat",
      sessionKey: "schedule:software-improver",
      singletonMode: "cancel",
      maxAttempts: 1,
      payload: {
        kind: "factory.run",
        stream: "agents/factory/sessions/software-improver",
        profileId: "software",
        problem: "Review recent repo memory and create or react a scoped delivery objective.",
        config: {
          maxIterations: 6,
        },
      },
    },
  ]);
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
  expect(resolved.repoSlotConcurrency).toBe(20);
  expect(resolved.configPath).toBeUndefined();
}, 120_000);

test("factory cli: codex-probe runs direct and queue status probes without init", async () => {
  const repoDir = await createRepo();
  const codexStub = await createCodexReplyStub();
  const wrapperPath = path.join(repoDir, ".receipt", "bin", process.platform === "win32" ? "receipt.cmd" : "receipt");
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
  await expect(fs.access(wrapperPath)).rejects.toThrow();
}, 120_000);

test("factory cli: helper list surfaces the checked-in helper catalog without init", async () => {
  const listed = await runCli(["factory", "helper", "list", "--json"]);
  expect(listed.code).toBe(0);
  const parsed = JSON.parse(listed.stdout) as ReadonlyArray<{
    readonly id?: string;
    readonly provider?: string;
  }>;
  expect(parsed.some((item) => item.id === "aws_account_scope" && item.provider === "aws")).toBe(true);
  expect(parsed.some((item) => item.id === "aws_resource_inventory" && item.provider === "aws")).toBe(true);
  expect(parsed.some((item) => item.id === "nat_gateway_cost_spike" && item.provider === "aws")).toBe(true);
}, 120_000);

test("factory cli: helper run executes a checked-in helper through the shared runner", async () => {
  const awsDir = await createAwsStub();
  const result = await runCli([
    "factory",
    "helper",
    "run",
    "aws_account_scope",
    "--provider",
    "aws",
    "--json",
  ], {
    PATH: `${awsDir}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as {
    readonly status?: string;
    readonly summary?: string;
    readonly data?: {
      readonly availableProfiles?: ReadonlyArray<string>;
      readonly callerIdentity?: {
        readonly Account?: string;
      };
    };
  };
  expect(parsed.status).toBe("ok");
  expect(parsed.summary).toContain("AWS caller identity");
  expect(parsed.data?.availableProfiles).toEqual(["default", "sandbox"]);
  expect(parsed.data?.callerIdentity?.Account).toBe("445567089271");
}, 120_000);

test("factory cli: helper run rejects placeholder resource ids before it hits AWS", async () => {
  const result = await runCli([
    "factory",
    "helper",
    "run",
    "aws_policy_or_exposure_check",
    "--provider",
    "aws",
    "--json",
    "--helper-arg=--service",
    "--helper-arg=s3",
    "--helper-arg=--check",
    "--helper-arg=public-access",
    "--helper-arg=--resource-id",
    "--helper-arg=__placeholder__",
  ]);
  expect(result.code).toBe(1);
  const parsed = JSON.parse(result.stdout) as {
    readonly status?: string;
    readonly summary?: string;
    readonly errors?: ReadonlyArray<string>;
  };
  expect(parsed.status).toBe("error");
  expect(parsed.summary).toContain("requires a real AWS resource identifier");
  expect(parsed.errors?.[0] ?? "").toContain("Do not use placeholders such as __placeholder__");
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
  expect(run.stdout).not.toContain("obj=");
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
  const objectiveAuditPath = path.join(repoDir, ".receipt", "data", "factory", "artifacts", runPayload.objectiveId, "objective.audit.json");
  const objectiveAudit = JSON.parse(await fs.readFile(objectiveAuditPath, "utf-8")) as {
    readonly requestedId?: string;
    readonly links?: {
      readonly objectiveId?: string;
    };
    readonly summary?: {
      readonly status?: string;
    };
  };
  expect(objectiveAudit.requestedId ?? objectiveAudit.links?.objectiveId).toBe(runPayload.objectiveId);
  expect(objectiveAudit.summary?.status).toBe("completed");

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

test("factory cli: attached run prints compact progress without waiting spam", async () => {
  const repoDir = await createRepo();
  const codexStub = await createCodexStub({ taskDelayMs: 2_200 });
  const env = {
    RECEIPT_CODEX_BIN: codexStub,
  };

  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir], env);
  expect(init.code).toBe(0);

  const run = await runCli([
    "factory",
    "run",
    "--repo-root",
    repoDir,
    "--title",
    "Slow smoke file",
    "--prompt",
    "Create a smoke file and keep the repository green.",
  ], env);

  expect(run.code).toBe(0);
  expect(run.stdout).not.toContain("waiting...");
  expect(run.stdout).toContain("phase=");
  expect(run.stdout).toContain("task=");
}, 30_000);

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

test("factory cli: profile validation defaults suppress repo checks for infrastructure investigations", async () => {
  const repoDir = await createRepo();

  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);

  const infrastructureCreate = await runCli([
    "factory",
    "create",
    "--json",
    "--repo-root",
    repoDir,
    "--profile",
    "infrastructure",
    "--objective-mode",
    "investigation",
    "--title",
    "Infra investigation",
    "--prompt",
    "Investigate the active AWS estate and summarize findings.",
  ]);
  expect(infrastructureCreate.code).toBe(0);
  const infrastructurePayload = JSON.parse(infrastructureCreate.stdout) as {
    readonly objective: {
      readonly checks: ReadonlyArray<string>;
      readonly profile: { readonly rootProfileId: string };
    };
  };
  expect(infrastructurePayload.objective.profile.rootProfileId).toBe("infrastructure");
  expect(infrastructurePayload.objective.checks).toEqual([]);

  const softwareCreate = await runCli([
    "factory",
    "create",
    "--json",
    "--repo-root",
    repoDir,
    "--profile",
    "software",
    "--title",
    "Software delivery",
    "--prompt",
    "Add a small software change and validate it.",
  ]);
  expect(softwareCreate.code).toBe(0);
  const softwarePayload = JSON.parse(softwareCreate.stdout) as {
    readonly objective: {
      readonly checks: ReadonlyArray<string>;
      readonly profile: { readonly rootProfileId: string };
    };
  };
  expect(softwarePayload.objective.profile.rootProfileId).toBe("software");
  expect(softwarePayload.objective.checks).toEqual(["bun run build"]);
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

test("factory cli: steer and follow-up queue structured live guidance commands", async () => {
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
        kind: "factory.task.run",
        objectiveId: "objective_demo",
        taskId: "task_01",
        candidateId: "task_01_candidate_01",
        stream: "factory/objectives/objective_demo",
        runId: "run_factory_cli_live_guidance",
      },
      maxAttempts: 1,
    });

    const steer = await runCli([
      "factory",
      "steer",
      job.id,
      "--json",
      "--repo-root",
      repoDir,
      "--message",
      "Tighten the scope and make the real repo change.",
    ]);
    expect(steer.code).toBe(0);
    const steerPayload = JSON.parse(steer.stdout) as {
      readonly action: string;
      readonly jobId: string;
      readonly commandId: string;
      readonly job: {
        readonly commands: ReadonlyArray<{ readonly command: string; readonly payload?: Record<string, unknown> }>;
      };
    };
    expect(steerPayload.action).toBe("steer");
    expect(steerPayload.jobId).toBe(job.id);
    expect(steerPayload.commandId.length).toBeGreaterThan(0);
    expect(steerPayload.job.commands.some((command) =>
      command.command === "steer" && command.payload?.message === "Tighten the scope and make the real repo change.")).toBe(true);

    const followUp = await runCli([
      "factory",
      "follow-up",
      job.id,
      "--json",
      "--repo-root",
      repoDir,
      "--message",
      "Run validation and include proof in the handoff.",
    ]);
    expect(followUp.code).toBe(0);
    const followPayload = JSON.parse(followUp.stdout) as {
      readonly action: string;
      readonly jobId: string;
      readonly commandId: string;
      readonly job: {
        readonly commands: ReadonlyArray<{ readonly command: string; readonly payload?: Record<string, unknown> }>;
      };
    };
    expect(followPayload.action).toBe("follow_up");
    expect(followPayload.jobId).toBe(job.id);
    expect(followPayload.commandId.length).toBeGreaterThan(0);
    expect(followPayload.job.commands.some((command) =>
      command.command === "follow_up" && command.payload?.message === "Run validation and include proof in the handoff.")).toBe(true);
  } finally {
    runtime.stop();
  }
}, 120_000);

test("factory cli runtime does not fail unsupported factory chat jobs", async () => {
  const repoDir = await createRepo();

  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);

  const config = await loadFactoryConfig(repoDir);
  expect(config).toBeDefined();
  const runtime = createFactoryCliRuntime(config!);
  try {
    await runtime.start();
    const job = await runtime.queue.enqueue({
      agentId: "factory",
      lane: "chat",
      payload: {
        kind: "factory.run",
        stream: "agents/factory/test",
        runId: "run_factory_cli_unsupported_chat",
        problem: "How is it today?",
        profileId: "generalist",
        chatId: "chat_demo",
      },
      maxAttempts: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    await runtime.queue.refresh();
    const current = await runtime.queue.getJob(job.id);
    expect(current).toBeDefined();
    expect(current?.status).toBe("queued");
    expect(current?.error ?? "").not.toContain("No handler for agent 'factory'");
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
  expect(parseComposerDraft("/steer Tighten the scope", "obj_123")).toEqual({
    ok: true,
    command: {
      type: "steer",
      message: "Tighten the scope",
    },
  });
  expect(parseComposerDraft("/follow-up Run validation and include proof", "obj_123")).toEqual({
    ok: true,
    command: {
      type: "follow-up",
      message: "Run validation and include proof",
    },
  });
});

test("factory cli actions: create retries optimistic mutation conflicts", async () => {
  let attempts = 0;
  const runtime = {
    service: {
      createObjective: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Expected prev hash stale-prev but head is fresh-prev");
        }
        return {
          objectiveId: "objective_retry_create_01",
        };
      },
    },
  } as unknown as Parameters<typeof createObjectiveMutation>[0];

  const result = await createObjectiveMutation(runtime, {
    prompt: "Investigate the latest issue.",
    title: "Retry create",
    objectiveMode: "investigation",
  });

  expect(result.objectiveId).toBe("objective_retry_create_01");
  expect(attempts).toBe(2);
});

test("factory cli: composer parser marks diagnostic prompts as investigations and adds root-cause guidance", () => {
  expect(parseComposerDraft("why is build failing")).toEqual({
    ok: true,
    command: {
      type: "new",
      prompt: [
        "why is build failing",
        "",
        "Treat this as an investigation request. Determine the concrete root cause from evidence before proposing or applying fixes.",
      ].join("\n"),
      title: "Investigate: why is build failing",
      objectiveMode: "investigation",
    },
  });
});

test("factory cli: composer prompt classifier steers implementation, infra, and QA intake from Tech Lead", () => {
  expect(inferObjectiveProfileHint("show me ec2 list")).toBe("infrastructure");
  expect(inferObjectiveProfileHint("how many iam roles do we have")).toBe("infrastructure");
  expect(inferObjectiveProfileHint("fix the ec2 dashboard widget")).toBe("software");
  expect(inferObjectiveProfileHint("why is build failing")).toBe("software");
  expect(inferObjectiveProfileHint("review the current patch for regression risk")).toBe("qa");
});

test("factory cli: composer parser rejects job commands without a selected objective", () => {
  expect(parseComposerDraft("/abort-job stop the current worker")).toEqual({
    ok: false,
    error: "Select an objective before aborting its active job.",
  });
  expect(parseComposerDraft("/steer tighten the scope")).toEqual({
    ok: false,
    error: "Select an objective before steering its active job.",
  });
  expect(parseComposerDraft("/follow-up add proof")).toEqual({
    ok: false,
    error: "Select an objective before sending follow-up guidance.",
  });
});

test("factory cli: composer metadata exposes steer and follow-up commands in help surfaces", () => {
  expect(COMPOSER_COMMANDS.some((command) => command.name === "steer" && command.usage === "/steer <message>")).toBe(true);
  expect(COMPOSER_COMMANDS.some((command) => command.name === "follow-up" && command.usage === "/follow-up <message>")).toBe(true);
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
