import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntime } from "@receipt/core/runtime";
import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl";
import { runReceiptDstAudit } from "../../src/cli/dst";
import { resolveBunRuntime } from "../../src/lib/runtime-paths";
import { DEFAULT_FACTORY_OBJECTIVE_POLICY, DEFAULT_FACTORY_OBJECTIVE_PROFILE } from "../../src/modules/factory";

type GenericEvent = Record<string, unknown> & {
  readonly type: string;
};

type GenericCmd = {
  readonly type: "emit";
  readonly event: GenericEvent;
  readonly eventId: string;
};

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(ROOT, "src", "cli.ts");
const BUN = resolveBunRuntime();

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const createGenericRuntime = (dataDir: string) =>
  createRuntime<GenericCmd, GenericEvent, { readonly ok: true }>(
    jsonlStore<GenericEvent>(dataDir),
    jsonBranchStore(dataDir),
    (cmd) => [cmd.event],
    (state) => state,
    { ok: true },
  );

const seedEvents = async (
  dataDir: string,
  stream: string,
  events: ReadonlyArray<GenericEvent>,
): Promise<void> => {
  const runtime = createGenericRuntime(dataDir);
  for (const [index, event] of events.entries()) {
    await runtime.execute(stream, {
      type: "emit",
      event,
      eventId: `${stream}:${index + 1}`,
    });
  }
};

const runCli = (
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> =>
  new Promise((resolve) => {
    const child = spawn(BUN, [CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...env,
      },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("receipt dst audit summarizes mixed receipt streams deterministically", async () => {
  const dataDir = await createTempDir("receipt-dst-audit");
  try {
    await seedEvents(dataDir, "factory/objectives/objective_demo", [
      {
        type: "objective.created",
        objectiveId: "objective_demo",
        title: "DST objective",
        prompt: "Audit the receipt stream.",
        channel: "results",
        baseHash: "abc123",
        objectiveMode: "delivery",
        severity: 2,
        checks: ["bun run build"],
        checksSource: "explicit",
        profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
        policy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
        createdAt: 1,
      },
      {
        type: "objective.completed",
        objectiveId: "objective_demo",
        summary: "Completed by replay.",
        completedAt: 2,
      },
    ]);

    await seedEvents(dataDir, "jobs/job_demo", [
      {
        type: "job.enqueued",
        jobId: "job_demo",
        agentId: "factory-chat",
        lane: "collect",
        payload: { kind: "demo.run" },
        maxAttempts: 2,
      },
      {
        type: "job.leased",
        jobId: "job_demo",
        workerId: "worker_1",
        leaseMs: 10_000,
        attempt: 1,
      },
      {
        type: "job.completed",
        jobId: "job_demo",
        workerId: "worker_1",
        result: { ok: true },
      },
    ]);

    await seedEvents(dataDir, "agents/demo/runs/run_history", [
      {
        type: "problem.set",
        runId: "run_history",
        problem: "Summarize this run.",
      },
      {
        type: "run.status",
        runId: "run_history",
        status: "running",
      },
      {
        type: "tool.called",
        runId: "run_history",
        iteration: 1,
        tool: "receipt.trace",
        input: {},
      },
      {
        type: "response.finalized",
        runId: "run_history",
        content: "All done.",
      },
      {
        type: "run.status",
        runId: "run_history",
        status: "completed",
      },
    ]);

    await seedEvents(dataDir, "agents/demo/runs/run_control", [
      {
        type: "run.started",
        runId: "run_control",
        agentId: "demo",
        agentVersion: "1.0.0",
        runtimePolicyVersion: "runtime-policy-v1",
      },
      {
        type: "action.selected",
        runId: "run_control",
        actionIds: ["draft"],
        reason: "priority-order (scheduler-v2)",
        policyVersion: "scheduler-v2",
      },
      {
        type: "action.started",
        runId: "run_control",
        actionId: "draft",
        kind: "assistant",
      },
      {
        type: "action.completed",
        runId: "run_control",
        actionId: "draft",
        kind: "assistant",
      },
      {
        type: "goal.completed",
        runId: "run_control",
      },
      {
        type: "run.completed",
        runId: "run_control",
      },
    ]);

    const report = await runReceiptDstAudit(dataDir);

    expect(report.streamCount).toBe(4);
    expect(report.integrityFailures).toBe(0);
    expect(report.replayFailures).toBe(0);
    expect(report.deterministicFailures).toBe(0);
    expect(report.kinds["factory.objective"]).toBe(1);
    expect(report.kinds.job).toBe(1);
    expect(report.kinds["agent.history"]).toBe(1);
    expect(report.kinds["agent.control"]).toBe(1);
    expect(report.statusCounts["factory.objective"]?.completed).toBe(1);
    expect(report.statusCounts.job?.completed).toBe(1);
    expect(report.statusCounts["agent.history"]?.completed).toBe(1);
    expect(report.statusCounts["agent.control"]?.completed).toBe(1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("receipt dst --strict exits non-zero when replay issues are found", async () => {
  const dataDir = await createTempDir("receipt-dst-strict");
  try {
    await seedEvents(dataDir, "jobs/job_broken", [
      {
        type: "job.completed",
        jobId: "job_broken",
        workerId: "worker_1",
      },
    ]);

    const result = await runCli(["dst", "--json", "--strict"], {
      RECEIPT_DATA_DIR: dataDir,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DST audit found receipt issues");

    const payload = JSON.parse(result.stdout) as {
      readonly replayFailures: number;
      readonly streams: ReadonlyArray<{
        readonly stream: string;
        readonly replay: {
          readonly ok: boolean;
          readonly error?: string;
        };
      }>;
    };
    expect(payload.replayFailures).toBe(1);
    expect(payload.streams[0]?.stream).toBe("jobs/job_broken");
    expect(payload.streams[0]?.replay.ok).toBe(false);
    expect(payload.streams[0]?.replay.error).toContain("Invariant");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("receipt dst agent control summary uses the latest run start on repeated runs", async () => {
  const dataDir = await createTempDir("receipt-dst-control-latest");
  try {
    await seedEvents(dataDir, "agents/demo/runs/run_control", [
      {
        type: "run.started",
        runId: "run_1",
        agentId: "demo",
        agentVersion: "1.0.0",
        runtimePolicyVersion: "runtime-policy-v1",
      },
      {
        type: "run.failed",
        runId: "run_1",
        error: "first attempt failed",
      },
      {
        type: "run.started",
        runId: "run_2",
        agentId: "demo",
        agentVersion: "2.0.0",
        runtimePolicyVersion: "runtime-policy-v2",
      },
      {
        type: "run.completed",
        runId: "run_2",
      },
    ]);

    const report = await runReceiptDstAudit(dataDir);
    const stream = report.streams.find((entry) => entry.stream === "agents/demo/runs/run_control");
    expect(stream?.kind).toBe("agent.control");
    if (stream?.summary.kind !== "agent.control") {
      throw new Error("expected agent.control summary");
    }
    expect(stream.summary.runId).toBe("run_2");
    expect(stream.summary.agentVersion).toBe("2.0.0");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
