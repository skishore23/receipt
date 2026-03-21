import { test, expect } from "bun:test";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import React from "react";
import { renderToString } from "ink";

import { FactoryBoardScreen, FactoryObjectiveScreen } from "../../src/factory-cli/app.tsx";
import { COMPOSER_COMMANDS, filterComposerCommands, findComposerSlashContext, parseComposerDraft, replaceComposerSlashContext } from "../../src/factory-cli/composer";
import { loadFactoryConfig, resolveFactoryRuntimeConfig } from "../../src/factory-cli/config";
import { createFactoryCliRuntime } from "../../src/factory-cli/runtime";
import { FactoryThemeProvider } from "../../src/factory-cli/theme.tsx";

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
    "  const isPublish = prompt.includes('Publish the completed objective:');",
    "  if (!match && !isPublish) throw new Error('codex stub missing match or publish flag');",
    "  fs.writeFileSync(path.join(workspace, 'CLI_SMOKE.txt'), 'created by stub\\n', 'utf8');",
    "  if (match) {",
    "    const resultPath = match[1].trim();",
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

test("factory cli: init writes config and board snapshot stays clean", async () => {
  const repoDir = await createRepo();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);
  const initPayload = JSON.parse(init.stdout) as {
    readonly config: { readonly configPath: string; readonly defaultChecks: ReadonlyArray<string> };
    readonly repoProfile: { readonly summary: string };
  };
  expect(initPayload.repoProfile.summary.length).toBeGreaterThan(0);
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

test("factory runtime config: shared resolver follows .receipt/config.json", async () => {
  const repoDir = await createRepo();
  const init = await runCli(["factory", "init", "--yes", "--force", "--json", "--repo-root", repoDir]);
  expect(init.code).toBe(0);
  const resolved = await resolveFactoryRuntimeConfig(repoDir);
  expect(resolved.repoRoot).toBe(repoDir);
  expect(resolved.dataDir).toBe(path.join(repoDir, ".receipt", "data"));
  expect(resolved.configPath).toBe(path.join(repoDir, ".receipt", "config.json"));
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

test("factory cli: steer, follow-up, and abort-job queue structured job commands", async () => {
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

    const steer = await runCli([
      "factory",
      "steer",
      job.id,
      "--json",
      "--repo-root",
      repoDir,
      "--problem",
      "Retarget the current job.",
    ]);
    expect(steer.code).toBe(0);
    const steerPayload = JSON.parse(steer.stdout) as {
      readonly kind: string;
      readonly action: string;
      readonly jobId: string;
      readonly commandId: string;
    };
    expect(steerPayload.kind).toBe("job");
    expect(steerPayload.action).toBe("steer");
    expect(steerPayload.jobId).toBe(job.id);
    expect(steerPayload.commandId.length).toBeGreaterThan(0);

    const followUp = await runCli([
      "factory",
      "follow-up",
      job.id,
      "--json",
      "--repo-root",
      repoDir,
      "--note",
      "Keep the objective context attached.",
    ]);
    expect(followUp.code).toBe(0);
    const followUpPayload = JSON.parse(followUp.stdout) as {
      readonly action: string;
      readonly jobId: string;
      readonly commandId: string;
    };
    expect(followUpPayload.action).toBe("follow_up");
    expect(followUpPayload.jobId).toBe(job.id);
    expect(followUpPayload.commandId.length).toBeGreaterThan(0);

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
    expect(refreshed?.commands.some((command) => command.command === "steer")).toBe(true);
    expect(refreshed?.commands.some((command) => command.command === "follow_up")).toBe(true);
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
  expect(parseComposerDraft("/steer tighten the current plan", "obj_123")).toEqual({
    ok: true,
    command: {
      type: "steer",
      problem: "tighten the current plan",
    },
  });
  expect(parseComposerDraft("/follow-up keep the logs attached", "obj_123")).toEqual({
    ok: true,
    command: {
      type: "follow-up",
      note: "keep the logs attached",
    },
  });
  expect(parseComposerDraft("/followup keep the logs attached", "obj_123")).toEqual({
    ok: true,
    command: {
      type: "follow-up",
      note: "keep the logs attached",
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

test("factory cli: slash command autocomplete helpers filter and replace token text", () => {
  expect(filterComposerCommands("rea").map((command) => command.name)).toContain("react");
  expect(filterComposerCommands("follow").map((command) => command.name)).toContain("follow-up");
  const context = findComposerSlashContext("keep /ste", "keep /ste".length);
  expect(context).toBeDefined();
  const inserted = replaceComposerSlashContext("keep /ste", context!, "/steer ");
  expect(inserted.value).toBe("keep /steer ");
  expect(inserted.caret).toBe(inserted.value.length);
  expect(COMPOSER_COMMANDS.map((command) => command.name)).toContain("help");
});

test("factory cli: composer parser rejects job commands without a selected objective", () => {
  expect(parseComposerDraft("/steer tighten the current plan")).toEqual({
    ok: false,
    error: "Select an objective before steering its active job.",
  });
  expect(parseComposerDraft("/follow-up keep the logs attached")).toEqual({
    ok: false,
    error: "Select an objective before sending a follow-up note.",
  });
  expect(parseComposerDraft("/abort-job stop the current worker")).toEqual({
    ok: false,
    error: "Select an objective before aborting its active job.",
  });
});
