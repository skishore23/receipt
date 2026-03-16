import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

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

test("framework routes: status parity for core endpoints", async () => {
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
  const child = spawn("bun", ["src/server.ts"], {
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
    expect(notFound.status).toBe(404);
    expect(await notFound.text()).toBe("Not found");

    const badCmd = await fetch(`${base}/cmd?stream=todo`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(badCmd.status).toBe(400);
    expect(await badCmd.text()).toBe("bad");

    const inspectMissingFile = await fetch(`${base}/receipt/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(inspectMissingFile.status).toBe(400);
    expect(await inspectMissingFile.text()).toBe("file required");

    const inspectUnknownFile = await fetch(`${base}/receipt/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "file=missing.jsonl",
    });
    expect(inspectUnknownFile.status).toBe(404);
    expect(await inspectUnknownFile.text()).toBe("file not found");

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
    expect(inspectPathTraversal.status).toBe(400);

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
    expect(inspectEnqueue.status).toBe(202);
    const inspectQueued = await inspectEnqueue.json() as { job?: { id?: string } };
    expect(inspectQueued.job?.id).toBeTruthy();

    const inspectSettled = await fetch(`${base}/jobs/${encodeURIComponent(inspectQueued.job.id!)}/wait?timeoutMs=30000`);
    expect(inspectSettled.status).toBe(200);

    const inspectorDeadline = Date.now() + 10_000;
    let inspectorChat = "";
    while (Date.now() < inspectorDeadline) {
      const chatRes = await fetch(`${base}/receipt/island/chat?file=${encodeURIComponent(inspectorFixture)}`);
      inspectorChat = await chatRes.text();
      if (inspectorChat.includes("Inspector integration check")) break;
      await sleep(250);
    }
    expect(inspectorChat.includes("Inspector integration check")).toBe(true);

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
    expect(axiomResume.status).toBe(200);
    expect(axiomResume.headers.get("HX-Redirect") ?? "").toMatch(
      new RegExp(`^/axiom\\?stream=agents%2Faxiom-guild&run=${encodeURIComponent(resumeRunId)}&branch=`)
    );

    const theoremBad = await fetch(`${base}/theorem/run?stream=theorem`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(theoremBad.status).toBe(400);
    expect(await theoremBad.text()).toBe("problem required");

    const writerBad = await fetch(`${base}/writer/run?stream=writer`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(writerBad.status).toBe(400);
    expect(await writerBad.text()).toBe("problem required");

    const axiomSimplePage = await fetch(`${base}/axiom-simple?stream=${encodeURIComponent("agents/axiom-simple")}`);
    expect(axiomSimplePage.status).toBe(200);

    const axiomSimpleBad = await fetch(`${base}/axiom-simple/run?stream=${encodeURIComponent("agents/axiom-simple")}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(axiomSimpleBad.status).toBe(400);
    expect(await axiomSimpleBad.text()).toBe("problem required");

    const axiomSimpleStream = await fetch(`${base}/axiom-simple/stream?stream=${encodeURIComponent("agents/axiom-simple")}`);
    expect(axiomSimpleStream.status).toBe(200);
    expect(axiomSimpleStream.headers.get("content-type")).toBe("text/event-stream");
    await axiomSimpleStream.body?.cancel();

    const agentRemoved = await fetch(`${base}/autopilot?stream=agent`);
    expect(agentRemoved.status).toBe(404);

    const monitorPage = await fetch(`${base}/monitor?stream=agent`);
    expect(monitorPage.status).toBe(200);
    const monitorHtml = await monitorPage.text();
    expect(monitorHtml).toMatch(/General Agent/);
    expect(monitorHtml).toMatch(/Infrastructure Agent/);
    expect(monitorHtml).toMatch(/Theorem Guild/);
    expect(monitorHtml).toMatch(/Proof Guild/);
    expect(monitorHtml).toMatch(/Axiom Simple/);
    expect(monitorHtml).toMatch(/Lean Worker/);

    const monitorStream = await fetch(`${base}/monitor/stream?stream=${encodeURIComponent("agents/axiom-guild")}`, {
    });
    expect(monitorStream.status).toBe(200);
    expect(monitorStream.headers.get("content-type")).toBe("text/event-stream");
    const monitorReader = monitorStream.body?.getReader();
    expect(monitorReader).toBeTruthy();
    const monitorInit = `${await readChunk(monitorReader!)}${await readChunk(monitorReader!)}${await readChunk(monitorReader!)}`;
    expect(monitorInit).toMatch(/event: theorem-refresh/);
    expect(monitorInit).toMatch(/event: receipt-refresh/);
    expect(monitorInit).toMatch(/event: job-refresh/);
    await monitorReader!.cancel();

    const monitorBad = await fetch(`${base}/monitor/run?stream=agent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(monitorBad.status).toBe(400);
    expect(await monitorBad.text()).toBe("problem required");

    const axiomBad = await fetch(`${base}/axiom/run?stream=axiom`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(axiomBad.status).toBe(400);
    expect(await axiomBad.text()).toBe("problem required");

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
    expect(enqueue.status).toBe(202);
    const queued = await enqueue.json() as { job?: { id?: string } };
    expect(queued.job?.id).toBeTruthy();

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
    expect(agentEnqueue.status).toBe(202);
    const agentQueued = await agentEnqueue.json() as { job?: { id?: string } };
    expect(agentQueued.job?.id).toBeTruthy();

    const infraEnqueue = await fetch(`${base}/agents/infra/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          kind: "infra.run",
          stream: "agents/infra",
          runId: `infra_${Date.now()}`,
          problem: "Inspect AWS caller identity.",
          config: { maxIterations: 2, maxToolOutputChars: 1200, memoryScope: "infra", workspace: "." },
        },
      }),
    });
    expect(infraEnqueue.status).toBe(202);
    const infraQueued = await infraEnqueue.json() as { job?: { id?: string } };
    expect(infraQueued.job?.id).toBeTruthy();

    const jobsIsland = await fetch(`${base}/monitor/island/jobs?job=${encodeURIComponent(agentQueued.job.id!)}`);
    expect(jobsIsland.status).toBe(200);
    const jobsIslandHtml = await jobsIsland.text();
    expect(jobsIslandHtml.includes("data-selected-job-id")).toBe(true);
    expect(jobsIslandHtml.includes("General Agent")).toBe(true);

    const infraJobsIsland = await fetch(`${base}/monitor/island/jobs?job=${encodeURIComponent(infraQueued.job.id!)}`);
    expect(infraJobsIsland.status).toBe(200);
    const infraJobsIslandHtml = await infraJobsIsland.text();
    expect(infraJobsIslandHtml.includes("Infrastructure Agent")).toBe(true);

    const jobIsland = await fetch(`${base}/monitor/island/job?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`);
    expect(jobIsland.status).toBe(200);
    const jobIslandHtml = await jobIsland.text();
    expect(jobIslandHtml.includes("Steer Job")).toBe(true);
    expect(jobIslandHtml.includes("General Agent")).toBe(true);

    const infraJobIsland = await fetch(`${base}/monitor/island/job?stream=agents/infra&job=${encodeURIComponent(infraQueued.job.id!)}`);
    expect(infraJobIsland.status).toBe(200);
    const infraJobIslandHtml = await infraJobIsland.text();
    expect(infraJobIslandHtml.includes("Infrastructure Agent")).toBe(true);

    const seededJobIsland = await fetch(`${base}/monitor/island/job?stream=agents/axiom-guild&job=${encodeURIComponent(seededFailedJob.id)}`);
    expect(seededJobIsland.status).toBe(200);
    const seededJobHtml = await seededJobIsland.text();
    expect(seededJobHtml.includes("Follow-up Job")).toBe(true);
    expect(seededJobHtml.includes("job_follow_up_seed")).toBe(true);
    expect(seededJobHtml.includes("Failure Class")).toBe(true);

    const steerCmd = await fetch(`${base}/monitor/job/${encodeURIComponent(agentQueued.job.id!)}/steer?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "fetch",
      },
      body: "problem=Retarget+scope",
    });
    expect(steerCmd.status).toBe(202);

    const followUpCmd = await fetch(`${base}/monitor/job/${encodeURIComponent(agentQueued.job.id!)}/follow-up?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "fetch",
      },
      body: "note=Add+validation",
    });
    expect(followUpCmd.status).toBe(202);

    const abortCmd = await fetch(`${base}/monitor/job/${encodeURIComponent(agentQueued.job.id!)}/abort?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "fetch",
      },
      body: "reason=route+test",
    });
    expect(abortCmd.status).toBe(202);

    const jobStatus = await fetch(`${base}/jobs/${encodeURIComponent(queued.job!.id!)}`);
    expect(jobStatus.status).toBe(200);

    const memCommit = await fetch(`${base}/memory/test/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "remember this event", tags: ["test"] }),
    });
    expect(memCommit.status).toBe(201);

    const memSearch = await fetch(`${base}/memory/test/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "remember" }),
    });
    expect(memSearch.status).toBe(200);

    const proposal = await fetch(`${base}/improvement/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artifactType: "prompt_patch",
        target: "prompts/theorem.prompts.json",
        patch: "{\"note\":\"safe\"}",
      }),
    });
    expect(proposal.status).toBe(201);
    const proposalJson = await proposal.json() as { proposalId?: string };
    expect(proposalJson.proposalId).toBeTruthy();

    const validate = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "passed", report: "ok" }),
    });
    expect(validate.status).toBe(200);

    const approve = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(approve.status).toBe(200);

    const apply = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(apply.status).toBe(200);

    const revert = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "test rollback" }),
    });
    expect(revert.status).toBe(200);
  } finally {
    await stopChild(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  expect(stderr.includes("EADDRINUSE")).toBe(false);
}, 120_000);
