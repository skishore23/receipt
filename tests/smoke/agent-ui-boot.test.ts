import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

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
const BUN = process.env.BUN_BIN?.trim() || "bun";

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

test("smoke: theorem/writer runs boot without API key", async () => {
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
    expect(theoremChain.some((r) => r.body.type === "run.configured")).toBeTruthy();
    expect(
      theoremChain.some((r) => r.body.type === "run.status" && r.body.status === "failed")
    ).toBeTruthy();

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
    expect(writerChain.some((r) => r.body.type === "run.configured")).toBeTruthy();
    expect(
      writerChain.some((r) => r.body.type === "run.status" && r.body.status === "failed")
    ).toBeTruthy();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);

test("smoke: theorem/writer/axiom/receipt UI routes boot", async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-smoke-ui");
  const child = spawn(BUN, ["src/server.ts"], {
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
    expect(theoremRes.status).toBe(200);
    const theoremHtml = await theoremRes.text();
    expect(theoremHtml).toMatch(/Receipt - Theorem Guild/);

    const writerRes = await fetch(`${base}/writer`);
    expect(writerRes.status).toBe(200);
    const writerHtml = await writerRes.text();
    expect(writerHtml).toMatch(/Receipt - Writer Guild/);

    const axiomRes = await fetch(`${base}/axiom`);
    expect(axiomRes.status).toBe(200);
    const axiomHtml = await axiomRes.text();
    expect(axiomHtml).toMatch(/Receipt - Axiom Guild/);
    expect(axiomHtml).toMatch(/Run Axiom Guild/);
    expect(axiomHtml).toMatch(/agents%2Faxiom-guild|agents\/axiom-guild/);

    const receiptRes = await fetch(`${base}/receipt`);
    expect(receiptRes.status).toBe(200);
    const receiptHtml = await receiptRes.text();
    expect(receiptHtml).toMatch(/Receipt Inspector/);
  } finally {
    await stopChild(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  expect(stderr.includes("EADDRINUSE")).toBe(false);
}, 120_000);
