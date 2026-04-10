import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sqliteQueue } from "../../src/adapters/sqlite-queue";
import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { createRuntime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import {
  FACTORY_MONITOR_AGENT_ID,
  FactoryService,
} from "../../src/services/factory-service";

const execFileAsync = promisify(execFile);

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], { cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
};

const createSourceRepo = async (): Promise<string> => {
  const repoDir = await createTempDir("receipt-monitor-dispatch-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Monitor Dispatch Test"]);
  await git(repoDir, ["config", "user.email", "monitor-dispatch@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# monitor dispatch test\n", "utf-8");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  return repoDir;
};

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, JobState>(
    sqliteReceiptStore<JobEvent>(dataDir),
    sqliteBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );

test("dispatching a codex task also enqueues a monitor job", async () => {
  const dataDir = await createTempDir("receipt-monitor-dispatch");
  const repoRoot = await createSourceRepo();
  const queue = sqliteQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor: {
      run: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    },
    repoRoot,
  });

  const objective = await service.createObjective({
    title: "Monitor dispatch test",
    prompt: "Do something",
    objectiveMode: "delivery",
    severity: 3,
    channel: "test",
  });

  // Run startup + reconcile to dispatch the task
  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId: objective.objectiveId,
    reason: "startup",
  });

  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId: objective.objectiveId,
    reason: "reconcile",
  });

  const jobs = await queue.listJobs({ limit: 20 });
  const monitorJobs = jobs.filter((job) => {
    const payload = job.payload as { readonly kind?: string };
    return payload.kind === "factory.task.monitor";
  });

  expect(monitorJobs.length).toBeGreaterThanOrEqual(1);
  expect(monitorJobs[0]?.agentId).toBe(FACTORY_MONITOR_AGENT_ID);
  const monitorPayload = monitorJobs[0].payload as {
    readonly kind: string;
    readonly objectiveId: string;
    readonly taskId: string;
    readonly codexJobId: string;
    readonly stdoutPath: string;
    readonly stderrPath: string;
    readonly taskPrompt: string;
    readonly splitDepth: number;
  };
  expect(monitorPayload.objectiveId).toBe(objective.objectiveId);
  expect(monitorPayload.codexJobId).toContain("job_factory_");
  expect(monitorPayload.stdoutPath).toContain(".stdout.log");
  expect(monitorPayload.splitDepth).toBe(0);
});
