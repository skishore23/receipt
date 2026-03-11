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
import { jsonlQueue } from "../../src/adapters/jsonl-queue.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job.ts";

import { createStreamLocator } from "../../src/adapters/jsonl.ts";
import { theoremRunStream } from "../../src/agents/theorem.streams.ts";
import { receipt } from "../../src/core/chain.ts";
import type { TheoremEvent } from "../../src/modules/theorem.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const readChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const chunk = await reader.read();
  if (chunk.done || !chunk.value) return "";
  return new TextDecoder().decode(chunk.value);
};

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
  const seedRuntime = createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob
  );
  const seedQueue = jsonlQueue({ runtime: seedRuntime, stream: "jobs" });
  const seededFailedJob = await seedQueue.enqueue({
    agentId: "axiom-guild",
    payload: {
      kind: "axiom-guild.run",
      stream: "agents/axiom-guild",
      runId: "seed_axiom_failed",
      problem: "Retry Hall-style proof after final verification failure.",
    },
    maxAttempts: 1,
  });
  await seedQueue.leaseNext({ workerId: "seed-worker", leaseMs: 5_000, agentId: "axiom-guild" });
  await seedQueue.fail(seededFailedJob.id, "seed-worker", "final verify failed", true, {
    runId: "seed_axiom_failed",
    stream: "agents/axiom-guild",
    status: "failed",
    followUpJobId: "job_follow_up_seed",
    followUpRunId: "run_follow_up_seed",
    failureClass: "axle_verify_failed",
  });
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
    const locator = createStreamLocator(dataDir);
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

    const resumeRunId = `resume_${Date.now()}`;
    const resumeStream = theoremRunStream("agents/axiom-guild", resumeRunId);
    const seededProblem = receipt<TheoremEvent>(
      resumeStream,
      undefined,
      { type: "problem.set", runId: resumeRunId, problem: "Resume seeded theorem.", agentId: "orchestrator" },
      Date.now()
    );
    await fs.writeFile(await locator.fileFor(resumeStream), `${JSON.stringify(seededProblem)}\n`, "utf-8");

    const axiomResume = await fetch(`${base}/axiom/run?stream=${encodeURIComponent("agents/axiom-guild")}&run=${encodeURIComponent(resumeRunId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "append=Continue",
    });
    assert.equal(axiomResume.status, 200);
    assert.match(
      axiomResume.headers.get("HX-Redirect") ?? "",
      new RegExp(`^/axiom\\?stream=agents%2Faxiom-guild&run=${encodeURIComponent(resumeRunId)}&branch=`)
    );

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

    const axiomSimplePage = await fetch(`${base}/axiom-simple?stream=${encodeURIComponent("agents/axiom-simple")}`);
    assert.equal(axiomSimplePage.status, 200);

    const axiomSimpleBad = await fetch(`${base}/axiom-simple/run?stream=${encodeURIComponent("agents/axiom-simple")}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(axiomSimpleBad.status, 400);
    assert.equal(await axiomSimpleBad.text(), "problem required");

    const axiomSimpleStream = await fetch(`${base}/axiom-simple/stream?stream=${encodeURIComponent("agents/axiom-simple")}`);
    assert.equal(axiomSimpleStream.status, 200);
    assert.equal(axiomSimpleStream.headers.get("content-type"), "text/event-stream");
    await axiomSimpleStream.body?.cancel();

    const agentRemoved = await fetch(`${base}/autopilot?stream=agent`);
    assert.equal(agentRemoved.status, 404);

    const monitorPage = await fetch(`${base}/monitor?stream=agent`);
    assert.equal(monitorPage.status, 200);
    const monitorHtml = await monitorPage.text();
    assert.match(monitorHtml, /General Agent/);
    assert.match(monitorHtml, /Theorem Guild/);
    assert.match(monitorHtml, /Proof Guild/);
    assert.match(monitorHtml, /Axiom Simple/);
    assert.match(monitorHtml, /Lean Worker/);

    const monitorStream = await fetch(`${base}/monitor/stream?stream=${encodeURIComponent("agents/axiom-guild")}`, {
    });
    assert.equal(monitorStream.status, 200);
    assert.equal(monitorStream.headers.get("content-type"), "text/event-stream");
    const monitorReader = monitorStream.body?.getReader();
    assert.ok(monitorReader, "expected monitor stream reader");
    const monitorInit = `${await readChunk(monitorReader!)}${await readChunk(monitorReader!)}${await readChunk(monitorReader!)}`;
    assert.match(monitorInit, /event: theorem-refresh/);
    assert.match(monitorInit, /event: receipt-refresh/);
    assert.match(monitorInit, /event: job-refresh/);
    await monitorReader!.cancel();

    const monitorBad = await fetch(`${base}/monitor/run?stream=agent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(monitorBad.status, 400);
    assert.equal(await monitorBad.text(), "problem required");

    const axiomBad = await fetch(`${base}/axiom/run?stream=axiom`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(axiomBad.status, 400);
    assert.equal(await axiomBad.text(), "problem required");

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
    assert.equal(jobsIslandHtml.includes("General Agent"), true);

    const jobIsland = await fetch(`${base}/monitor/island/job?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`);
    assert.equal(jobIsland.status, 200);
    const jobIslandHtml = await jobIsland.text();
    assert.equal(jobIslandHtml.includes("Steer Job"), true);
    assert.equal(jobIslandHtml.includes("General Agent"), true);

    const seededJobIsland = await fetch(`${base}/monitor/island/job?stream=agents/axiom-guild&job=${encodeURIComponent(seededFailedJob.id)}`);
    assert.equal(seededJobIsland.status, 200);
    const seededJobHtml = await seededJobIsland.text();
    assert.equal(seededJobHtml.includes("Follow-up Job"), true);
    assert.equal(seededJobHtml.includes("job_follow_up_seed"), true);
    assert.equal(seededJobHtml.includes("Failure Class"), true);

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
