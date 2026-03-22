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
