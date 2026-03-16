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
import { parseComposerDraft } from "../../src/factory-cli/composer.ts";
import { loadFactoryConfig, resolveFactoryRuntimeConfig } from "../../src/factory-cli/config.ts";
import { createFactoryCliRuntime } from "../../src/factory-cli/runtime.ts";
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
      build: "node -e \"process.exit(0)\"",
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
    "  if (!workspace || !lastMessagePath || !match) throw new Error('codex stub missing required args');",
    "  const resultPath = match[1].trim();",
    "  fs.writeFileSync(path.join(workspace, 'CLI_SMOKE.txt'), 'created by stub\\n', 'utf8');",
    "  fs.writeFileSync(resultPath, JSON.stringify({ outcome: 'approved', summary: 'Stub approved result.', handoff: 'Ready for integration.' }, null, 2));",
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
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
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
  expect(initPayload.config.defaultChecks).toContain("npm run build");
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
  expect(run.code).toBe(0);
  const runPayload = JSON.parse(run.stdout) as {
    readonly objectiveId: string;
    readonly panel: string;
    readonly data: {
      readonly header: ReadonlyArray<string>;
      readonly latestDecision?: { readonly summary: string };
    };
  };
  expect(runPayload.panel).toBe("overview");
  expect(runPayload.data.header.join("\n")).toMatch(/integration=promoted/);
  expect(runPayload.data.latestDecision?.summary ?? "").toMatch(/promote/i);

  const promotedFile = await fs.readFile(path.join(repoDir, "CLI_SMOKE.txt"), "utf-8");
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
});

test("factory cli: mission control screens render from shared projections", async () => {
  const repoDir = await createRepo();
  const codexStub = await createCodexStub();
  const env = {
    RECEIPT_CODEX_BIN: codexStub,
  };

  const init = await runCli(["factory", "init", "--yes", "--force", "--repo-root", repoDir], env);
  expect(init.code).toBe(0);

  const run = await runCli([
    "factory",
    "run",
    "--json",
    "--repo-root",
    repoDir,
    "--title",
    "Mission control objective",
    "--prompt",
    "Create a smoke file and keep the repository green.",
  ], env);
  expect(run.code).toBe(0);
  const runPayload = JSON.parse(run.stdout) as { readonly objectiveId: string };

  const config = await loadFactoryConfig(repoDir);
  expect(config).toBeDefined();
  const runtime = createFactoryCliRuntime(config!);
  await runtime.start();
  try {
    const board = await runtime.service.buildBoardProjection(runPayload.objectiveId);
    const compose = await runtime.service.buildComposeModel();
    const detail = await runtime.service.getObjective(runPayload.objectiveId);
    const live = await runtime.service.buildLiveProjection(runPayload.objectiveId);
    const debug = await runtime.service.getObjectiveDebug(runPayload.objectiveId);

    const boardScreen = stripAnsi(renderToString(
      React.createElement(FactoryThemeProvider, undefined,
        React.createElement(FactoryBoardScreen, {
          state: { compose, board, selected: detail, live },
          selectedObjectiveId: runPayload.objectiveId,
          compact: false,
          stacked: false,
          message: "Factory ready.",
        }),
      ),
    ));
    const normalizedBoard = boardScreen.toLowerCase();
    expect(normalizedBoard).toContain("mission control");
    expect(normalizedBoard).toContain("factory");
    expect(normalizedBoard).toContain("objective stream");
    expect(normalizedBoard).toContain("objective rail");
    expect(normalizedBoard).toContain("control rail");

    const objectiveScreen = stripAnsi(renderToString(
      React.createElement(FactoryThemeProvider, undefined,
        React.createElement(FactoryObjectiveScreen, {
          state: { detail, live, debug },
          panel: "overview",
          compact: true,
          stacked: true,
          message: "Watching objective.",
        }),
      ),
    ));
    const normalizedObjective = objectiveScreen.toLowerCase();
    expect(normalizedObjective).toContain("objective stream");
    expect(normalizedObjective).toContain("control rail");
    expect(normalizedObjective).toContain("objective budget");
    expect(normalizedObjective).toContain("objective prompt");
  } finally {
    runtime.stop();
  }
}, 120_000);
