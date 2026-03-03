import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

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
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 5_000);

  await exitPromise;
  clearTimeout(killTimer);
};

test("framework routes: status parity for core endpoints", { timeout: 120_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-framework-routes");
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
    await waitForHttpOk(`${base}/`, 30_000);

    const notFound = await fetch(`${base}/not-real`);
    assert.equal(notFound.status, 404);
    assert.equal(await notFound.text(), "Not found");

    const badCmd = await fetch(`${base}/cmd?stream=todo`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(badCmd.status, 400);
    assert.equal(await badCmd.text(), "bad");

    const inspectMissingFile = await fetch(`${base}/receipt/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(inspectMissingFile.status, 400);
    assert.equal(await inspectMissingFile.text(), "file required");

    const inspectUnknownFile = await fetch(`${base}/receipt/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "file=missing.jsonl",
    });
    assert.equal(inspectUnknownFile.status, 404);
    assert.equal(await inspectUnknownFile.text(), "file not found");

    const theoremBad = await fetch(`${base}/theorem/run?stream=theorem`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(theoremBad.status, 400);
    assert.equal(await theoremBad.text(), "problem required");

    const writerBad = await fetch(`${base}/writer/run?stream=writer`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(writerBad.status, 400);
    assert.equal(await writerBad.text(), "problem required");
  } finally {
    await stopChild(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  assert.equal(stderr.includes("EADDRINUSE"), false, `server boot conflict: ${stderr}`);
});
