import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import {
  runTheoremGuild,
  THEOREM_DEFAULT_CONFIG,
} from "../../src/agents/theorem.ts";
import {
  runWriterGuild,
  WRITER_DEFAULT_CONFIG,
} from "../../src/agents/writer.ts";
import { theoremRunStream } from "../../src/agents/theorem.streams.ts";
import { writerRunStream } from "../../src/agents/writer.streams.ts";
import {
  decide as decideTheorem,
  reduce as reduceTheorem,
  initial as initialTheorem,
  type TheoremCmd,
  type TheoremEvent,
  type TheoremState,
} from "../../src/modules/theorem.ts";
import {
  decide as decideWriter,
  reduce as reduceWriter,
  initial as initialWriter,
  type WriterCmd,
  type WriterEvent,
  type WriterState,
} from "../../src/modules/writer.ts";
import { loadTheoremPrompts } from "../../src/prompts/theorem.ts";
import { loadWriterPrompts } from "../../src/prompts/writer.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const getFreePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("unable to resolve free port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });

const waitForHttpOk = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server still booting
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  const exitPromise = once(child, "exit");
  child.kill("SIGTERM");

  const killTimer = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }, 5_000);

  await exitPromise;
  clearTimeout(killTimer);
};

test("smoke: theorem/writer runs boot without API key", { timeout: 120_000 }, async () => {
  const dataDir = await createTempDir("receipt-smoke-agent-boot");

  try {
    const branchStore = jsonBranchStore(dataDir);
    const theoremRuntime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      jsonlStore<TheoremEvent>(dataDir),
      branchStore,
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const writerRuntime = createRuntime<WriterCmd, WriterEvent, WriterState>(
      jsonlStore<WriterEvent>(dataDir),
      branchStore,
      decideWriter,
      reduceWriter,
      initialWriter
    );

    const theoremRunId = `run_${Date.now()}_theorem`;
    await runTheoremGuild({
      stream: "theorem",
      runId: theoremRunId,
      problem: "Prove x = x",
      config: THEOREM_DEFAULT_CONFIG,
      runtime: theoremRuntime,
      prompts: loadTheoremPrompts(),
      llmText: async () => "",
      model: "gpt-4o",
      apiReady: false,
      apiNote: "OPENAI_API_KEY not set",
    });

    const theoremChain = await theoremRuntime.chain(theoremRunStream("theorem", theoremRunId));
    assert.ok(theoremChain.some((r) => r.body.type === "run.configured"), "theorem run.configured missing");
    assert.ok(
      theoremChain.some((r) => r.body.type === "run.status" && r.body.status === "failed"),
      "theorem failed status missing"
    );

    const writerRunId = `run_${Date.now()}_writer`;
    await runWriterGuild({
      stream: "writer",
      runId: writerRunId,
      problem: "Write a short brief",
      config: WRITER_DEFAULT_CONFIG,
      runtime: writerRuntime,
      prompts: loadWriterPrompts(),
      llmText: async () => "",
      model: "gpt-4o",
      apiReady: false,
      apiNote: "OPENAI_API_KEY not set",
    });

    const writerChain = await writerRuntime.chain(writerRunStream("writer", writerRunId));
    assert.ok(writerChain.some((r) => r.body.type === "run.configured"), "writer run.configured missing");
    assert.ok(
      writerChain.some((r) => r.body.type === "run.status" && r.body.status === "failed"),
      "writer failed status missing"
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("smoke: theorem/writer/axiom/receipt UI routes boot", { timeout: 120_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-smoke-ui");
  const tsxBin = path.join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx"
  );

  const child = spawn(tsxBin, ["src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      OPENAI_API_KEY: "",
    },
    stdio: "pipe",
  });

  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${base}/receipt`, 30_000);

    const theoremRes = await fetch(`${base}/theorem`);
    assert.equal(theoremRes.status, 200, `GET /theorem failed: ${theoremRes.status}`);
    const theoremHtml = await theoremRes.text();
    assert.match(theoremHtml, /Receipt - Theorem Guild/);

    const writerRes = await fetch(`${base}/writer`);
    assert.equal(writerRes.status, 200, `GET /writer failed: ${writerRes.status}`);
    const writerHtml = await writerRes.text();
    assert.match(writerHtml, /Receipt - Writer Guild/);

    const axiomRes = await fetch(`${base}/axiom`);
    assert.equal(axiomRes.status, 200, `GET /axiom failed: ${axiomRes.status}`);
    const axiomHtml = await axiomRes.text();
    assert.match(axiomHtml, /Receipt - Axiom Guild/);
    assert.match(axiomHtml, /Run Axiom Guild/);
    assert.match(axiomHtml, /agents%2Faxiom-guild|agents\/axiom-guild/);

    const receiptRes = await fetch(`${base}/receipt`);
    assert.equal(receiptRes.status, 200, `GET /receipt failed: ${receiptRes.status}`);
    const receiptHtml = await receiptRes.text();
    assert.match(receiptHtml, /Receipt Inspector/);
  } finally {
    await stopChild(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  assert.equal(stderr.includes("EADDRINUSE"), false, `server boot conflict: ${stderr}`);
});
