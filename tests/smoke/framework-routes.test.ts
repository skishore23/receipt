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
      IMPROVEMENT_VALIDATE_CMD: "echo validate-ok",
      IMPROVEMENT_HARNESS_CMD: "echo harness-ok",
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
    const inspectorFixture = "fixture-inspector.jsonl";
    await fs.writeFile(
      path.join(dataDir, inspectorFixture),
      `${JSON.stringify({
        id: "r1",
        ts: Date.now(),
        stream: "agents/theorem/runs/demo",
        prev: null,
        hash: "h1",
        body: { type: "problem.set", runId: "demo", problem: "hello", agentId: "orchestrator" },
      })}\n`,
      "utf-8"
    );

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

    const inspectPathTraversal = await fetch(`${base}/agents/inspector/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          kind: "inspector.run",
          source: { kind: "file", name: "../secret.jsonl" },
        },
      }),
    });
    assert.equal(inspectPathTraversal.status, 400);

    const inspectRunId = `inspect_${Date.now()}`;
    const inspectEnqueue = await fetch(`${base}/agents/inspector/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          kind: "inspector.run",
          stream: "agents/inspector",
          runId: inspectRunId,
          groupId: inspectRunId,
          agentId: "analyst",
          agentName: "Analyst",
          source: { kind: "file", name: inspectorFixture },
          order: "desc",
          limit: 200,
          depth: 2,
          question: "Inspector integration check",
          mode: "analyze",
          apiReady: true,
        },
      }),
    });
    assert.equal(inspectEnqueue.status, 202);
    const inspectQueued = await inspectEnqueue.json() as { job?: { id?: string } };
    assert.ok(inspectQueued.job?.id, "expected inspector job id");

    const inspectSettled = await fetch(`${base}/jobs/${encodeURIComponent(inspectQueued.job.id!)}/wait?timeoutMs=30000`);
    assert.equal(inspectSettled.status, 200);

    const inspectorDeadline = Date.now() + 10_000;
    let inspectorChat = "";
    while (Date.now() < inspectorDeadline) {
      const chatRes = await fetch(`${base}/receipt/island/chat?file=${encodeURIComponent(inspectorFixture)}`);
      inspectorChat = await chatRes.text();
      if (inspectorChat.includes("Inspector integration check")) break;
      await sleep(250);
    }
    assert.equal(inspectorChat.includes("Inspector integration check"), true, "expected inspector chat to reflect queued inspector run");

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

    const agentRemoved = await fetch(`${base}/autopilot?stream=agent`);
    assert.equal(agentRemoved.status, 404);

    const monitorBad = await fetch(`${base}/monitor/run?stream=agent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(monitorBad.status, 400);
    assert.equal(await monitorBad.text(), "problem required");

    const enqueue = await fetch(`${base}/agents/writer/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          kind: "writer.run",
          stream: "writer",
          runId: `route_${Date.now()}`,
          problem: "Test",
          config: { maxParallel: 1 },
        },
      }),
    });
    assert.equal(enqueue.status, 202);
    const queued = await enqueue.json() as { job?: { id?: string } };
    assert.ok(queued.job?.id, "expected job id");

    const agentEnqueue = await fetch(`${base}/agents/agent/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          kind: "agent.run",
          stream: "agent",
          runId: `route_${Date.now()}`,
          problem: "List src files and summarize.",
          config: { maxIterations: 2, maxToolOutputChars: 1200, memoryScope: "agent", workspace: "." },
        },
      }),
    });
    assert.equal(agentEnqueue.status, 202);
    const agentQueued = await agentEnqueue.json() as { job?: { id?: string } };
    assert.ok(agentQueued.job?.id, "expected agent job id");

    const jobsIsland = await fetch(`${base}/monitor/island/jobs?job=${encodeURIComponent(agentQueued.job.id!)}`);
    assert.equal(jobsIsland.status, 200);
    const jobsIslandHtml = await jobsIsland.text();
    assert.equal(jobsIslandHtml.includes("data-selected-job-id"), true);

    const jobIsland = await fetch(`${base}/monitor/island/job?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`);
    assert.equal(jobIsland.status, 200);
    const jobIslandHtml = await jobIsland.text();
    assert.equal(jobIslandHtml.includes("Steer Job"), true);

    const steerCmd = await fetch(`${base}/monitor/job/${encodeURIComponent(agentQueued.job.id!)}/steer?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "fetch",
      },
      body: "problem=Retarget+scope",
    });
    assert.equal(steerCmd.status, 202);

    const followUpCmd = await fetch(`${base}/monitor/job/${encodeURIComponent(agentQueued.job.id!)}/follow-up?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "fetch",
      },
      body: "note=Add+validation",
    });
    assert.equal(followUpCmd.status, 202);

    const abortCmd = await fetch(`${base}/monitor/job/${encodeURIComponent(agentQueued.job.id!)}/abort?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "fetch",
      },
      body: "reason=route+test",
    });
    assert.equal(abortCmd.status, 202);

    const jobStatus = await fetch(`${base}/jobs/${encodeURIComponent(queued.job!.id!)}`);
    assert.equal(jobStatus.status, 200);

    const memCommit = await fetch(`${base}/memory/test/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "remember this event", tags: ["test"] }),
    });
    assert.equal(memCommit.status, 201);

    const memSearch = await fetch(`${base}/memory/test/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "remember" }),
    });
    assert.equal(memSearch.status, 200);

    const proposal = await fetch(`${base}/improvement/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artifactType: "prompt_patch",
        target: "prompts/theorem.prompts.json",
        patch: "{\"note\":\"safe\"}",
      }),
    });
    assert.equal(proposal.status, 201);
    const proposalJson = await proposal.json() as { proposalId?: string };
    assert.ok(proposalJson.proposalId, "expected proposalId");

    const validate = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "passed", report: "ok" }),
    });
    assert.equal(validate.status, 200);

    const approve = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(approve.status, 200);

    const apply = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(apply.status, 200);

    const revert = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "test rollback" }),
    });
    assert.equal(revert.status, 200);
  } finally {
    await stopChild(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  assert.equal(stderr.includes("EADDRINUSE"), false, `server boot conflict: ${stderr}`);
});
