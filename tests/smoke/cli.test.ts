import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { receipt } from "@receipt/core/chain";

import { sqliteReceiptStore } from "../../src/adapters/sqlite";
import { resolveBunRuntime } from "../../src/lib/runtime-paths";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(ROOT, "src", "cli.ts");
const BUN = resolveBunRuntime();

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const createExecutable = async (
  dir: string,
  name: string,
  lines: ReadonlyArray<string>,
): Promise<string> => {
  const scriptPath = path.join(dir, name);
  await fs.writeFile(scriptPath, lines.join("\n"), "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
};

const run = (
  args: ReadonlyArray<string>,
  envOverrides: Record<string, string> = {},
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(BUN, [CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATA_DIR: path.join(ROOT, "data"),
        RECEIPT_DATA_DIR: path.join(ROOT, "data"),
        ...envOverrides,
      },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("cli: help and jobs commands are available", async () => {
  const dataDir = await createTempDir("receipt-cli-help");
  try {
    const env = {
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
    };
    const help = await run(["help"], env);
    expect(help.code).toBe(0);
    expect(help.stdout.includes("receipt <command>")).toBe(true);
    expect(help.stdout.includes("use --output-file <path> on large read commands")).toBe(true);
    expect(help.stdout.includes("receipt doctor [--json] [--output-file <path>] [--repo-root <path>]")).toBe(true);
    expect(help.stdout.includes("factory [init|run|create|compose|watch|inspect|replay|replay-chat|analyze|parse|investigate|audit")).toBe(true);

    const jobs = await run(["jobs", "--limit", "1"], env);
    expect(jobs.code).toBe(0);
    expect(jobs.stdout.includes("\"jobs\"")).toBe(true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("cli: doctor reports binary and auth status in json", async () => {
  const dataDir = await createTempDir("receipt-cli-doctor");
  const binDir = await createTempDir("receipt-cli-doctor-bin");
  try {
    const ghStub = await createExecutable(binDir, "gh", [
      "#!/usr/bin/env bun",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('gh version 2.70.0'); process.exit(0); }",
      "if (args[0] === 'auth' && args[1] === 'status') { console.error('Logged in to github.com as receipt-test'); process.exit(0); }",
      "console.error('unexpected gh args');",
      "process.exit(1);",
    ]);
    const awsStub = await createExecutable(binDir, "aws", [
      "#!/usr/bin/env bun",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('aws-cli/2.17.0 Python/3.11.0'); process.exit(0); }",
      "if (args[0] === 'sts' && args[1] === 'get-caller-identity') {",
      "  console.log(JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/tester', UserId: 'AIDTEST' }));",
      "  process.exit(0);",
      "}",
      "console.error('unexpected aws args');",
      "process.exit(1);",
    ]);
    const codexStub = await createExecutable(binDir, "codex", [
      "#!/usr/bin/env bun",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('codex 1.2.3'); process.exit(0); }",
      "console.error('unexpected codex args');",
      "process.exit(1);",
    ]);

    const result = await run(["doctor", "--json"], {
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
      OPENAI_API_KEY: "test-key",
      RECEIPT_GH_BIN: ghStub,
      RECEIPT_AWS_BIN: awsStub,
      RECEIPT_CODEX_BIN: codexStub,
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      readonly ok: boolean;
      readonly openAiApiKey: { readonly present: boolean };
      readonly binaries: {
        readonly gh: { readonly ok: boolean; readonly path?: string };
        readonly aws: { readonly ok: boolean; readonly path?: string };
        readonly codex: { readonly ok: boolean; readonly path?: string };
      };
      readonly auth: {
        readonly github: { readonly ok: boolean; readonly summary?: string };
        readonly aws: { readonly ok: boolean; readonly accountId?: string; readonly arn?: string };
      };
      readonly repo: {
        readonly ok: boolean;
        readonly root?: string;
      };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.openAiApiKey.present).toBe(true);
    expect(parsed.binaries.gh.ok).toBe(true);
    expect(parsed.binaries.gh.path).toBe(ghStub);
    expect(parsed.binaries.aws.ok).toBe(true);
    expect(parsed.binaries.aws.path).toBe(awsStub);
    expect(parsed.binaries.codex.ok).toBe(true);
    expect(parsed.binaries.codex.path).toBe(codexStub);
    expect(parsed.auth.github.ok).toBe(true);
    expect(parsed.auth.github.summary).toContain("receipt-test");
    expect(parsed.auth.aws.ok).toBe(true);
    expect(parsed.auth.aws.accountId).toBe("123456789012");
    expect(parsed.auth.aws.arn).toContain("tester");
    expect(parsed.repo.ok).toBe(true);
    expect(parsed.repo.root).toBe(ROOT);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(binDir, { recursive: true, force: true });
  }
}, 60_000);

test("cli: read commands can export payloads to files", async () => {
  const dataDir = await createTempDir("receipt-cli-output-file");
  const store = sqliteReceiptStore<Record<string, unknown>>(dataDir);
  const stream = "agents/factory/runs/run_cli_output_file";
  const first = receipt(stream, undefined, { type: "task.requested", prompt: "probe" }, 1);
  const second = receipt(stream, first.hash, { type: "task.completed", output: "done" }, 2);
  const outputFile = path.join(dataDir, "trace.json");

  try {
    await store.append(first, undefined);
    await store.append(second, first.hash);

    const result = await run([
      "trace",
      "run_cli_output_file",
      "--json",
      "--output-file",
      outputFile,
    ], {
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      readonly ok: boolean;
      readonly outputFile?: string;
      readonly format?: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.outputFile).toBe(outputFile);
    expect(parsed.format).toBe("json");

    const trace = JSON.parse(await fs.readFile(outputFile, "utf-8")) as {
      readonly stream: string;
      readonly receipts: ReadonlyArray<{ readonly type: string }>;
    };
    expect(trace.stream).toBe(stream);
    expect(trace.receipts.map((entry) => entry.type)).toEqual(["task.requested", "task.completed"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("cli: run uses the Resonate backend and fails fast when dispatch is unavailable", async () => {
  const dataDir = await createTempDir("receipt-cli-run-resonate");
  try {
    const result = await run([
      "run",
      "agent",
      "--problem",
      "probe",
    ], {
      DATA_DIR: dataDir,
      RECEIPT_DATA_DIR: dataDir,
      JOB_BACKEND: "resonate",
      RESONATE_URL: "http://127.0.0.1:1",
    });

    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr.includes("error:")).toBe(true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);
