import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

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
      // server booting
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

const isTerminal = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

test("job worker: delegated follow-up does not stall parent when concurrency=1", async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-job-delegate-join");
  const child = spawn(BUN, ["src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      OPENAI_API_KEY: "",
      JOB_CONCURRENCY: "1",
      JOB_POLL_MS: "1000",
      SUBJOB_WAIT_MS: "0",
      SUBJOB_JOIN_WAIT_MS: "10000",
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

    const runId = `delegate_${Date.now()}`;
    const enqueue = await fetch(`${base}/agents/theorem/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          kind: "theorem.run",
          stream: "theorem",
          runId,
          problem: "Prove x = x.",
          config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
        },
      }),
    });
    expect(enqueue.status).toBe(202);
    const queued = await enqueue.json() as { job?: { id?: string } };
    const parentJobId = queued.job?.id;
    expect(parentJobId).toBeTruthy();

    const followUp = await fetch(`${base}/jobs/${encodeURIComponent(parentJobId!)}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          note: "Delegate a quick helper proof.",
          delegate_task: {
            task: "Show that 1 = 1.",
            agentId: "theorem",
          },
        },
      }),
    });
    expect(followUp.status).toBe(202);

    const parentWait = await fetch(`${base}/jobs/${encodeURIComponent(parentJobId!)}/wait?timeoutMs=20000`);
    expect(parentWait.status).toBe(200);
    const parentJob = await parentWait.json() as { status: string };
    expect(parentJob.status).toBe("completed");

    const deadline = Date.now() + 20_000;
    let subJobSeenTerminal = false;
    let lastJobs: Array<{ id: string; lane: string; status: string }> = [];
    while (Date.now() < deadline) {
      const jobsRes = await fetch(`${base}/jobs?limit=100`);
      expect(jobsRes.status).toBe(200);
      const jobsJson = await jobsRes.json() as { jobs: Array<{ id: string; lane: string; status: string }> };
      lastJobs = jobsJson.jobs;
      subJobSeenTerminal = jobsJson.jobs.some((job) =>
        job.id !== parentJobId
        && job.lane === "follow_up"
        && isTerminal(job.status)
      );
      if (subJobSeenTerminal) break;
      await sleep(250);
    }

    expect(
      subJobSeenTerminal,
    ).toBe(
      true,
    );
  } finally {
    await stopChild(child);
    await fs.rm(dataDir, { recursive: true, force: true });
    if (stderr.trim().length > 0 && !/EADDRINUSE/.test(stderr)) {
      // keep stderr available when test fails unexpectedly
      console.error(stderr);
    }
  }
}, 120_000);
