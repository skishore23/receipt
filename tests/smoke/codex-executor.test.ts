import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalCodexExecutor } from "../../src/adapters/codex-executor";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const createHungCodexStub = async (): Promise<string> => {
  const dir = await mkTmp("receipt-codex-executor");
  const scriptPath = path.join(dir, "codex-hang-stub");
  const body = [
    "#!/usr/bin/env bun",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "(async () => {",
    "  const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "  const prompt = await readAll();",
    "  const match = prompt.match(/Write JSON to (.+?) with:/);",
    "  if (!lastMessagePath || !match) throw new Error('missing result contract');",
    "  const resultPath = match[1].trim();",
    "  fs.mkdirSync(path.dirname(resultPath), { recursive: true });",
    "  fs.writeFileSync(resultPath, JSON.stringify({ outcome: 'approved', summary: 'stub approved', handoff: 'stub handoff' }), 'utf8');",
    "  process.stderr.write('result written\\n');",
    "  setInterval(() => {}, 1000);",
    "})().catch((err) => {",
    "  console.error(err instanceof Error ? err.message : String(err));",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
};

const createSchemaCodexStub = async (): Promise<string> => {
  const dir = await mkTmp("receipt-codex-executor-schema");
  const scriptPath = path.join(dir, "codex-schema-stub");
  const body = [
    "#!/usr/bin/env bun",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "(async () => {",
    "  const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "  const schemaPath = args[args.indexOf('--output-schema') + 1];",
    "  const effortArg = args[args.indexOf('-c') + 1];",
    "  if (!lastMessagePath || !schemaPath) throw new Error('missing schema output contract');",
    "  if (!effortArg || !effortArg.includes('model_reasoning_effort')) throw new Error('missing reasoning effort override');",
    "  await readAll();",
    "  const payload = { outcome: 'approved', summary: 'schema approved', handoff: 'schema handoff' };",
    "  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));",
    "  if (schema.required?.join(',') !== 'outcome,summary,handoff') throw new Error('unexpected schema');",
    "  fs.writeFileSync(lastMessagePath, JSON.stringify(payload), 'utf8');",
    "  process.stdout.write(JSON.stringify(payload));",
    "})().catch((err) => {",
    "  console.error(err instanceof Error ? err.message : String(err));",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
};

const createSandboxBootstrapFailureCodexStub = async (): Promise<{
  readonly scriptPath: string;
  readonly attemptsPath: string;
}> => {
  const dir = await mkTmp("receipt-codex-executor-sandbox-fallback");
  const scriptPath = path.join(dir, "codex-sandbox-fallback-stub");
  const attemptsPath = path.join(dir, "attempts.log");
  const body = [
    "#!/usr/bin/env bun",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const sandboxMode = args[args.indexOf('--sandbox') + 1];",
    "const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "const attemptsPath = process.env.SANDBOX_ATTEMPTS_PATH;",
    "if (!sandboxMode || !lastMessagePath || !attemptsPath) throw new Error('missing sandbox test args');",
    "fs.appendFileSync(attemptsPath, `${sandboxMode}\\n`, 'utf8');",
    "process.stderr.write('bwrap: Unknown option --argv0\\n');",
    "process.exit(1);",
    "",
  ].join("\n");
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return { scriptPath, attemptsPath };
};

const createLastMessageHungCodexStub = async (): Promise<string> => {
  const dir = await mkTmp("receipt-codex-executor-last-message");
  const scriptPath = path.join(dir, "codex-last-message-hang-stub");
  const body = [
    "#!/usr/bin/env bun",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "(async () => {",
    "  if (!lastMessagePath) throw new Error('missing last message path');",
    "  await readAll();",
    "  fs.writeFileSync(lastMessagePath, JSON.stringify({ outcome: 'approved', summary: 'last-message approved', handoff: 'last-message handoff' }), 'utf8');",
    "  process.stderr.write('last message written\\n');",
    "  setInterval(() => {}, 1000);",
    "})().catch((err) => {",
    "  console.error(err instanceof Error ? err.message : String(err));",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
};

const createStructuredLastMessageStreamingCodexStub = async (): Promise<string> => {
  const dir = await mkTmp("receipt-codex-executor-structured-stream");
  const scriptPath = path.join(dir, "codex-structured-stream-stub");
  const body = [
    "#!/usr/bin/env bun",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "(async () => {",
    "  if (!lastMessagePath) throw new Error('missing last message path');",
    "  await readAll();",
    "  fs.writeFileSync(lastMessagePath, JSON.stringify({ outcome: 'blocked', summary: 'structured completion', handoff: 'partial inventory captured' }), 'utf8');",
    "  process.stderr.write('structured last message written\\n');",
    "  setInterval(() => { process.stderr.write('still streaming\\n'); }, 100);",
    "})().catch((err) => {",
    "  console.error(err instanceof Error ? err.message : String(err));",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
};

const createRepeatableLoggingCodexStub = async (): Promise<string> => {
  const dir = await mkTmp("receipt-codex-executor-repeatable");
  const scriptPath = path.join(dir, "codex-repeatable-log-stub");
  const body = [
    "#!/usr/bin/env bun",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "(async () => {",
    "  if (!lastMessagePath) throw new Error('missing last message path');",
    "  const prompt = await readAll();",
    "  const label = prompt.includes('second-run') ? 'second-run' : 'first-run';",
    "  fs.writeFileSync(lastMessagePath, JSON.stringify({ outcome: 'approved', summary: `${label} approved`, handoff: `${label} handoff` }), 'utf8');",
    "  process.stdout.write(`${label}-stdout\\n`);",
    "  process.stderr.write(`${label}-stderr\\n`);",
    "})().catch((err) => {",
    "  console.error(err instanceof Error ? err.message : String(err));",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
};

const createBootstrapThenHangCodexStub = async (): Promise<string> => {
  const dir = await mkTmp("receipt-codex-executor-stall");
  const scriptPath = path.join(dir, "codex-bootstrap-hang-stub");
  const body = [
    "#!/usr/bin/env bun",
    "const args = process.argv.slice(2);",
    "const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "(async () => {",
    "  if (!lastMessagePath) throw new Error('missing last message path');",
    "  await readAll();",
    "  process.stderr.write('bootstrap complete\\n');",
    "  setInterval(() => {}, 1000);",
    "})().catch((err) => {",
    "  console.error(err instanceof Error ? err.message : String(err));",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
};

const createJsonProgressCodexStub = async (): Promise<string> => {
  const dir = await mkTmp("receipt-codex-executor-json-progress");
  const scriptPath = path.join(dir, "codex-json-progress-stub");
  const body = [
    "#!/usr/bin/env bun",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "const emit = (payload) => process.stdout.write(`${JSON.stringify(payload)}\\n`);",
    "(async () => {",
    "  if (!args.includes('--json')) throw new Error('missing --json');",
    "  if (!lastMessagePath) throw new Error('missing last message path');",
    "  await readAll();",
    "  emit({ type: 'turn.started' });",
    "  emit({ type: 'item.started', item: { type: 'command_execution', command: 'rg --files', status: 'in_progress' } });",
    "  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Inventory captured.' } });",
    "  emit({ type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 34 } });",
    "  fs.writeFileSync(lastMessagePath, 'Final answer', 'utf8');",
    "})().catch((err) => {",
    "  console.error(err instanceof Error ? err.message : String(err));",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
};

test("local codex executor completes once a task result file exists and output goes quiet", async () => {
  const root = await mkTmp("receipt-codex-executor-workspace");
  const stub = await createHungCodexStub();
  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const resultPath = path.join(artifactDir, "task.result.json");
  const executor = new LocalCodexExecutor({
    bin: stub,
    timeoutMs: 60_000,
  });

  const startedAt = Date.now();
  const result = await executor.run({
    prompt: `# Task\nWrite JSON to ${resultPath} with:\n{ "outcome": "approved" | "changes_requested" | "blocked", "summary": string, "handoff": string }\n`,
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    completionSignalPath: resultPath,
    completionQuietMs: 300,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  });
  const elapsed = Date.now() - startedAt;

  expect(elapsed).toBeLessThan(5_000);
  expect(result.exitCode).toBe(0);
  expect(result.signal).toBeNull();
  await expect(fs.readFile(resultPath, "utf-8")).resolves.toContain("\"outcome\":\"approved\"");
  await expect(fs.readFile(stderrPath, "utf-8")).resolves.toContain("result written");
}, 15_000);

test("local codex executor extracts tokens used from stdout", async () => {
  const root = await mkTmp("receipt-codex-executor-tokens-workspace");
  const scriptPath = path.join(root, "codex-tokens-stub");
  const body = [
    "#!/usr/bin/env bun",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "fs.writeFileSync(lastMessagePath, 'done', 'utf8');",
    "process.stdout.write('some output\\ntokens used\\n1,234\\nmore output');",
  ].join("\n");
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);

  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const executor = new LocalCodexExecutor({
    bin: scriptPath,
    timeoutMs: 60_000,
  });

  const result = await executor.run({
    prompt: "# Task\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  });

  expect(result.exitCode).toBe(0);
  expect(result.tokensUsed).toBe(1234);
});

test("local codex executor extracts tokens used from stderr", async () => {
  const root = await mkTmp("receipt-codex-executor-stderr-tokens-workspace");
  const scriptPath = path.join(root, "codex-stderr-tokens-stub");
  const body = [
    "#!/usr/bin/env bun",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "fs.writeFileSync(lastMessagePath, 'done', 'utf8');",
    "process.stderr.write('progress\\ntokens used\\n9,876\\nfinal stderr');",
  ].join("\n");
  await fs.writeFile(scriptPath, body, "utf-8");
  await fs.chmod(scriptPath, 0o755);

  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const executor = new LocalCodexExecutor({
    bin: scriptPath,
    timeoutMs: 60_000,
  });

  const result = await executor.run({
    prompt: "# Task\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  });

  expect(result.exitCode).toBe(0);
  expect(result.tokensUsed).toBe(9876);
});

test("local codex executor completes once a structured last message exists and output goes quiet", async () => {
  const root = await mkTmp("receipt-codex-executor-last-message-workspace");
  const stub = await createLastMessageHungCodexStub();
  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const executor = new LocalCodexExecutor({
    bin: stub,
    timeoutMs: 60_000,
  });

  const startedAt = Date.now();
  const result = await executor.run({
    prompt: "# Task\nReturn the final JSON only.\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    completionSignalPath: lastMessagePath,
    completionQuietMs: 300,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  });
  const elapsed = Date.now() - startedAt;

  expect(elapsed).toBeLessThan(5_000);
  expect(result.exitCode).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.lastMessage).toContain("\"summary\":\"last-message approved\"");
  await expect(fs.readFile(stderrPath, "utf-8")).resolves.toContain("last message written");
});

test("local codex executor completes once a structured last message stabilizes even if stderr keeps streaming", async () => {
  const root = await mkTmp("receipt-codex-executor-structured-stream-workspace");
  const stub = await createStructuredLastMessageStreamingCodexStub();
  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const outputSchemaPath = path.join(artifactDir, "task.schema.json");
  await fs.mkdir(path.dirname(outputSchemaPath), { recursive: true });
  await fs.writeFile(outputSchemaPath, JSON.stringify({
    type: "object",
    required: ["outcome", "summary", "handoff"],
  }), "utf-8");
  const executor = new LocalCodexExecutor({
    bin: stub,
    timeoutMs: 60_000,
  });

  const startedAt = Date.now();
  const result = await executor.run({
    prompt: "# Task\nReturn the final JSON only.\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    outputSchemaPath,
    completionSignalPath: lastMessagePath,
    completionQuietMs: 300,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  });
  const elapsed = Date.now() - startedAt;

  expect(elapsed).toBeLessThan(5_000);
  expect(result.exitCode).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.lastMessage).toContain("\"summary\":\"structured completion\"");
  await expect(fs.readFile(stderrPath, "utf-8")).resolves.toContain("still streaming");
}, 15_000);

test("local codex executor aborts a wedged codex child after the stall timeout", async () => {
  const root = await mkTmp("receipt-codex-executor-stall-workspace");
  const stub = await createBootstrapThenHangCodexStub();
  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const executor = new LocalCodexExecutor({
    bin: stub,
    timeoutMs: 60_000,
    stallTimeoutMs: 1_000,
  });

  const startedAt = Date.now();
  await expect(executor.run({
    prompt: "# Task\nReturn the final JSON only.\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  })).rejects.toThrow(/stalled/);
  const elapsed = Date.now() - startedAt;

  expect(elapsed).toBeLessThan(10_000);
  await expect(fs.readFile(stderrPath, "utf-8")).resolves.toContain("bootstrap complete");
}, 15_000);

test("local codex executor parses JSON progress events and token usage", async () => {
  const root = await mkTmp("receipt-codex-executor-json-progress-workspace");
  const stub = await createJsonProgressCodexStub();
  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const executor = new LocalCodexExecutor({
    bin: stub,
    timeoutMs: 60_000,
  });
  const progress: string[] = [];

  const result = await executor.run({
    prompt: "# Task\nReturn the final answer.\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    jsonOutput: true,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  }, {
    onProgress: async (update) => {
      progress.push(update.summary ?? update.lastMessage ?? "progress");
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.lastMessage).toBe("Final answer");
  expect(result.tokensUsed).toBe(154);
  expect(result.latestEventType).toBe("turn.completed");
  expect(result.latestEventText).toBe("Inventory captured.");
  expect(progress).toContain("Codex started working.");
  expect(progress).toContain("Running command: rg --files");
  expect(progress).toContain("Inventory captured.");
}, 15_000);

test("local codex executor preserves stdout and stderr breadcrumbs across consecutive runs", async () => {
  const root = await mkTmp("receipt-codex-executor-repeatable-workspace");
  const stub = await createRepeatableLoggingCodexStub();
  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const outputSchemaPath = path.join(artifactDir, "task.schema.json");
  await fs.mkdir(path.dirname(outputSchemaPath), { recursive: true });
  await fs.writeFile(outputSchemaPath, JSON.stringify({
    type: "object",
    required: ["outcome", "summary", "handoff"],
  }), "utf-8");

  const executor = new LocalCodexExecutor({
    bin: stub,
    timeoutMs: 60_000,
  });

  await executor.run({
    prompt: "# Task\nfirst-run\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    outputSchemaPath,
    completionSignalPath: lastMessagePath,
    completionQuietMs: 300,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  });

  await executor.run({
    prompt: "# Task\nsecond-run\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    outputSchemaPath,
    completionSignalPath: lastMessagePath,
    completionQuietMs: 300,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  });

  const stdoutLog = await fs.readFile(stdoutPath, "utf-8");
  const stderrLog = await fs.readFile(stderrPath, "utf-8");
  expect(stdoutLog).toContain("first-run-stdout");
  expect(stdoutLog).toContain("second-run-stdout");
  expect(stdoutLog).toContain("[factory] codex restart");
  expect(stderrLog).toContain("first-run-stderr");
  expect(stderrLog).toContain("second-run-stderr");
  expect(stderrLog).toContain("[factory] codex restart");
}, 15_000);

test("local codex executor passes output schema and reasoning effort through to codex", async () => {
  const root = await mkTmp("receipt-codex-executor-schema-workspace");
  const stub = await createSchemaCodexStub();
  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const outputSchemaPath = path.join(artifactDir, "task.schema.json");
  await fs.mkdir(path.dirname(outputSchemaPath), { recursive: true });
  await fs.writeFile(outputSchemaPath, JSON.stringify({
    type: "object",
    required: ["outcome", "summary", "handoff"],
  }), "utf-8");
  const executor = new LocalCodexExecutor({
    bin: stub,
    timeoutMs: 60_000,
  });

  const result = await executor.run({
    prompt: "# Task\nReturn the final JSON only.\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    outputSchemaPath,
    reasoningEffort: "medium",
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  });

  expect(result.exitCode).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.lastMessage).toContain("\"summary\":\"schema approved\"");
  expect(result.stdout).toContain("\"handoff\":\"schema handoff\"");
}, 15_000);

test("local codex executor can isolate CODEX_HOME while preserving auth/config files", async () => {
  const root = await mkTmp("receipt-codex-executor-isolated-home-workspace");
  const sourceCodexHome = await mkTmp("receipt-codex-home-source");
  await fs.writeFile(path.join(sourceCodexHome, "auth.json"), "{\"token\":\"test\"}\n", "utf-8");
  await fs.writeFile(path.join(sourceCodexHome, "config.toml"), "model = \"gpt-5.4\"\n", "utf-8");
  await fs.mkdir(path.join(sourceCodexHome, "skills", "unwanted"), { recursive: true });
  await fs.writeFile(path.join(sourceCodexHome, "skills", "unwanted", "SKILL.md"), "# should not be copied\n", "utf-8");

  const stubPath = path.join(root, "codex-isolated-home-stub");
  const body = [
    "#!/usr/bin/env bun",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "const codexHome = process.env.CODEX_HOME;",
    "if (!codexHome) throw new Error('missing CODEX_HOME');",
    "if (!fs.existsSync(path.join(codexHome, 'auth.json'))) throw new Error('missing auth.json');",
    "if (!fs.existsSync(path.join(codexHome, 'config.toml'))) throw new Error('missing config.toml');",
    "if (fs.existsSync(path.join(codexHome, 'skills'))) throw new Error('skills directory should be absent');",
    "fs.writeFileSync(lastMessagePath, JSON.stringify({ outcome: 'approved', summary: 'isolated', handoff: 'ok' }), 'utf8');",
    "process.stdout.write('isolated-home-ok');",
  ].join("\n");
  await fs.writeFile(stubPath, body, "utf-8");
  await fs.chmod(stubPath, 0o755);

  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const executor = new LocalCodexExecutor({
    bin: stubPath,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      CODEX_HOME: sourceCodexHome,
    },
  });

  const result = await executor.run({
    prompt: "# Task\nReturn the final JSON only.\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    isolateCodexHome: true,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("isolated-home-ok");
  expect(result.lastMessage).toContain("\"summary\":\"isolated\"");
}, 15_000);

test("local codex executor fails closed when sandbox bootstrap fails", async () => {
  const root = await mkTmp("receipt-codex-executor-sandbox-retry-workspace");
  const { scriptPath, attemptsPath } = await createSandboxBootstrapFailureCodexStub();
  const artifactDir = path.join(root, ".receipt", "factory");
  const promptPath = path.join(artifactDir, "task.prompt.md");
  const lastMessagePath = path.join(artifactDir, "task.last-message.md");
  const stdoutPath = path.join(artifactDir, "task.stdout.log");
  const stderrPath = path.join(artifactDir, "task.stderr.log");
  const executor = new LocalCodexExecutor({
    bin: scriptPath,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      SANDBOX_ATTEMPTS_PATH: attemptsPath,
    },
  });

  await expect(executor.run({
    prompt: "# Task\nReturn the final JSON only.\n",
    workspacePath: root,
    promptPath,
    lastMessagePath,
    stdoutPath,
    stderrPath,
    sandboxMode: "workspace-write",
    mutationPolicy: "workspace_edit",
  })).rejects.toThrow(/Unknown option --argv0|codex exited with 1/);

  await expect(fs.readFile(attemptsPath, "utf-8")).resolves.toBe("workspace-write\n");
  const stderrLog = await fs.readFile(stderrPath, "utf-8");
  expect(stderrLog).toContain("bwrap: Unknown option --argv0");
  expect(stderrLog).not.toContain("retrying with danger-full-access");
}, 15_000);
