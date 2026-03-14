import assert from "node:assert/strict";
import { spawn, type ChildProcess, execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { promisify } from "node:util";
import test from "node:test";

import { jsonBranchStore, jsonlStore } from "../../src/adapters/jsonl.ts";
import { jsonlQueue } from "../../src/adapters/jsonl-queue.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job.ts";

const execFileAsync = promisify(execFile);
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
      // booting
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    sleep(5_000),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      once(child, "exit"),
      sleep(2_000),
    ]);
  }
};

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
};

const createSourceRepo = async (): Promise<string> => {
  const repoDir = await createTempDir("receipt-hub-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Hub Test"]);
  await git(repoDir, ["config", "user.email", "hub-test@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# hub test\n", "utf-8");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# hub test\n\nsecond\n", "utf-8");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "second commit"]);
  return repoDir;
};

type FakeCodexOptions = {
  readonly failFirstBuilderByRemovingWorkspace?: boolean;
};

const createFakeCodexBin = async (options: FakeCodexOptions = {}): Promise<string> => {
  const dir = await createTempDir("receipt-fake-codex");
  const bin = path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
  const failFirstBuilderByRemovingWorkspace = options.failFirstBuilderByRemovingWorkspace === true;
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const lastMessageIndex = args.indexOf("--output-last-message");
const lastMessagePath = lastMessageIndex >= 0 ? args[lastMessageIndex + 1] : "";
const hubDir = path.join(process.cwd(), ".receipt", "hub");
const passMeta = JSON.parse(fs.readFileSync(path.join(hubDir, "pass.json"), "utf-8"));
const stateDir = ${JSON.stringify(dir)};
const jobList = JSON.parse(execFileSync("receipt", ["jobs", "--limit", "20"], {
  cwd: process.cwd(),
  encoding: "utf-8",
}));
if (!Array.isArray(jobList.jobs) || !jobList.jobs.some((job) => job?.payload?.workspaceId === passMeta.workspaceId)) {
  throw new Error("hub worktree did not expose a usable receipt CLI");
}

if (${failFirstBuilderByRemovingWorkspace} && passMeta.phase === "builder" && passMeta.passNumber === 2) {
  const markerPath = path.join(stateDir, passMeta.passId + ".retry-marker");
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, "1", "utf-8");
    const workspacePath = process.cwd();
    process.chdir(path.dirname(workspacePath));
    fs.rmSync(workspacePath, { recursive: true, force: true });
    process.stderr.write("simulated workspace loss\\n");
    process.exit(1);
  }
}

let result;
if (passMeta.phase === "planner") {
  result = {
    outcome: "plan_ready",
    summary: "Plan ready for implementation.",
    handoff: "Implement the requested change and keep the tests green."
  };
} else if (passMeta.phase === "builder") {
  const target = path.join(process.cwd(), "OBJECTIVE_AUTOGEN.txt");
  const next = fs.existsSync(target)
    ? fs.readFileSync(target, "utf-8") + "\\nrefined pass " + passMeta.passNumber + "\\n"
    : "initial builder pass\\n";
  fs.writeFileSync(target, next, "utf-8");
  result = {
    outcome: "candidate_ready",
    summary: "Implemented builder pass " + passMeta.passNumber + ".",
    handoff: "Verify OBJECTIVE_AUTOGEN.txt and confirm the behavior is coherent."
  };
} else if (passMeta.phase === "reviewer" && passMeta.passNumber === 3) {
  result = {
    outcome: "changes_requested",
    summary: "One more builder pass is needed.",
    handoff: "Refine the generated file and then re-run the reviewer pass."
  };
} else {
  result = {
    outcome: "approved",
    summary: "The candidate looks good.",
    handoff: "Ready for human confirmation."
  };
}

fs.mkdirSync(hubDir, { recursive: true });
fs.writeFileSync(path.join(hubDir, "result.json"), JSON.stringify(result, null, 2), "utf-8");
if (lastMessagePath) {
  fs.mkdirSync(path.dirname(lastMessagePath), { recursive: true });
  fs.writeFileSync(lastMessagePath, result.summary, "utf-8");
}
process.stdout.write(result.summary + "\\n");
`;
  await fs.writeFile(bin, script, "utf-8");
  await fs.chmod(bin, 0o755);
  return bin;
};

const waitForObjectiveStatus = async (
  base: string,
  objectiveId: string,
  statuses: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<{
  objective: {
    status: string;
    passes: Array<{
      phase: string;
      passNumber: number;
      outcome?: string;
      workspaceId?: string;
      jobId: string;
    }>;
    latestCommitHash?: string;
    latestReviewOutcome?: string;
    graph: {
      currentNodeId?: string;
      nodeOrder: string[];
      nodes: Array<{ nodeId: string; kind: string; status: string; dependsOn: string[] }>;
    };
  };
}> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/hub/api/objectives/${objectiveId}`);
    if (res.ok) {
      const payload = await res.json() as {
        objective: {
          status: string;
          passes: Array<{
            phase: string;
            passNumber: number;
            outcome?: string;
            workspaceId?: string;
            jobId: string;
          }>;
          latestCommitHash?: string;
          latestReviewOutcome?: string;
          graph: {
            currentNodeId?: string;
            nodeOrder: string[];
            nodes: Array<{ nodeId: string; kind: string; status: string; dependsOn: string[] }>;
          };
        };
      };
      if (statuses.includes(payload.objective.status)) return payload;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for objective ${objectiveId} to reach ${statuses.join(", ")}`);
};

const makeQueue = (dataDir: string) => {
  const runtime = createRuntime<JobCmd, JobEvent, JobState>(
    jsonlStore<JobEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob
  );
  return jsonlQueue({ runtime, stream: "jobs" });
};

test("hub: bootstraps, manages workspaces, board, graph, and tasks", { timeout: 120_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-hub-data");
  const repoDir = await createSourceRepo();
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
      HUB_REPO_ROOT: repoDir,
      OPENAI_API_KEY: "",
      JOB_POLL_MS: "60000",
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
    await waitForHttpOk(`${base}/hub`, 30_000);

    const shellRes = await fetch(`${base}/hub`);
    assert.equal(shellRes.status, 200);
    assert.match(await shellRes.text(), /Receipt Hub/);

    const stateRes = await fetch(`${base}/hub/api/state`);
    assert.equal(stateRes.status, 200);
    const initialState = await stateRes.json() as {
      channels: string[];
      graph: { recentCommits: Array<{ subject: string }> };
    };
    assert.deepEqual(initialState.channels, ["failures", "general", "results"]);
    assert.ok(initialState.graph.recentCommits.some((commit) => commit.subject === "second commit"));

    const agentCreate = await fetch(`${base}/hub/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "debugger-1",
        displayName: "Debugger 1",
      }),
    });
    assert.equal(agentCreate.status, 201);
    const agent = await agentCreate.json() as { agent: { agentId: string; memoryScope: string } };
    assert.equal(agent.agent.agentId, "debugger-1");
    assert.equal(agent.agent.memoryScope, "hub/agents/debugger-1");

    const dupAgent = await fetch(`${base}/hub/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "debugger-1" }),
    });
    assert.equal(dupAgent.status, 409);

    const workspaceCreate = await fetch(`${base}/hub/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "debugger-1" }),
    });
    assert.equal(workspaceCreate.status, 201);
    const workspacePayload = await workspaceCreate.json() as {
      workspace: { workspaceId: string; path: string; branchName: string; baseHash: string };
    };
    const workspace = workspacePayload.workspace;
    assert.match(workspace.branchName, /^hub\/debugger-1\//);
    await fs.access(workspace.path);

    const workspaceRes = await fetch(`${base}/hub/api/workspaces/${workspace.workspaceId}`);
    assert.equal(workspaceRes.status, 200);
    const workspaceDetail = await workspaceRes.json() as {
      workspace: { exists: boolean; dirty: boolean; head?: string };
    };
    assert.equal(workspaceDetail.workspace.exists, true);
    assert.equal(workspaceDetail.workspace.dirty, false);
    assert.ok(workspaceDetail.workspace.head);

    await fs.writeFile(path.join(workspace.path, "hub.txt"), "hello hub\n", "utf-8");
    await git(workspace.path, ["add", "hub.txt"]);
    await git(workspace.path, ["commit", "-m", "hub workspace commit"]);

    const commitsRes = await fetch(`${base}/hub/api/commits`);
    assert.equal(commitsRes.status, 200);
    const commitsPayload = await commitsRes.json() as { commits: Array<{ hash: string; subject: string; parents: string[] }> };
    const workspaceCommit = commitsPayload.commits.find((commit) => commit.subject === "hub workspace commit");
    assert.ok(workspaceCommit);

    const leavesRes = await fetch(`${base}/hub/api/leaves`);
    assert.equal(leavesRes.status, 200);
    const leavesPayload = await leavesRes.json() as { commits: Array<{ hash: string }> };
    assert.ok(leavesPayload.commits.some((commit) => commit.hash === workspaceCommit?.hash));

    const lineageRes = await fetch(`${base}/hub/api/commits/${workspaceCommit?.hash}/lineage`);
    assert.equal(lineageRes.status, 200);
    const lineagePayload = await lineageRes.json() as { commits: Array<{ hash: string }> };
    assert.ok(lineagePayload.commits.length >= 2);

    const diffRes = await fetch(`${base}/hub/api/diff/${workspaceCommit?.parents[0]}/${workspaceCommit?.hash}`);
    assert.equal(diffRes.status, 200);
    const diffPayload = await diffRes.json() as { diff: string };
    assert.match(diffPayload.diff, /hub\.txt/);

    const commitRes = await fetch(`${base}/hub/api/commits/${workspaceCommit?.hash}`);
    assert.equal(commitRes.status, 200);
    const commitPayload = await commitRes.json() as { commit: { touchedFiles?: string[] } };
    assert.deepEqual(commitPayload.commit.touchedFiles, ["hub.txt"]);

    const channelCreate = await fetch(`${base}/hub/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "reviews" }),
    });
    assert.equal(channelCreate.status, 201);

    const dupChannel = await fetch(`${base}/hub/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "reviews" }),
    });
    assert.equal(dupChannel.status, 409);

    const postCreate = await fetch(`${base}/hub/api/channels/reviews/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "debugger-1",
        content: "Looks good.",
      }),
    });
    assert.equal(postCreate.status, 201);
    const createdPost = await postCreate.json() as { post: { postId: string } };

    const replyCreate = await fetch(`${base}/hub/api/posts/${createdPost.post.postId}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "debugger-1",
        content: "Adding one more note.",
      }),
    });
    assert.equal(replyCreate.status, 201);

    const postsRes = await fetch(`${base}/hub/api/channels/reviews/posts`);
    assert.equal(postsRes.status, 200);
    const postsPayload = await postsRes.json() as { posts: Array<{ parentId?: string }> };
    assert.equal(postsPayload.posts.length, 2);
    assert.ok(postsPayload.posts.some((post) => post.parentId === createdPost.post.postId));

    const announceRes = await fetch(`${base}/hub/api/workspaces/${workspace.workspaceId}/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "debugger-1",
        channel: "results",
        content: "ready for inspection",
      }),
    });
    assert.equal(announceRes.status, 201);
    const announcePayload = await announceRes.json() as {
      announcement: { commitHash: string; postId: string };
    };
    assert.equal(announcePayload.announcement.commitHash, workspaceCommit?.hash);
    assert.ok(announcePayload.announcement.postId);

    const dirtyWorkspaceRes = await fetch(`${base}/hub/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "debugger-1", workspaceId: "dirty-space" }),
    });
    assert.equal(dirtyWorkspaceRes.status, 201);
    const dirtyWorkspace = await dirtyWorkspaceRes.json() as { workspace: { workspaceId: string; path: string } };
    await fs.writeFile(path.join(dirtyWorkspace.workspace.path, "dirty.txt"), "uncommitted\n", "utf-8");

    const dirtyAnnounce = await fetch(`${base}/hub/api/workspaces/${dirtyWorkspace.workspace.workspaceId}/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "debugger-1", channel: "results" }),
    });
    assert.equal(dirtyAnnounce.status, 409);

    const dirtyTask = await fetch(`${base}/hub/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "debugger-1",
        workspaceId: dirtyWorkspace.workspace.workspaceId,
        prompt: "Do not run",
      }),
    });
    assert.equal(dirtyTask.status, 409);

    const taskCreate = await fetch(`${base}/hub/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "debugger-1",
        workspaceId: workspace.workspaceId,
        prompt: "Inspect the hub workspace",
        maxIterations: 3,
      }),
    });
    assert.equal(taskCreate.status, 201);
    const taskPayload = await taskCreate.json() as { task: { taskId: string; jobId: string } };
    assert.ok(taskPayload.task.jobId);

    const queuedTaskRes = await fetch(`${base}/hub/api/tasks/${taskPayload.task.taskId}`);
    assert.equal(queuedTaskRes.status, 200);
    const queuedTask = await queuedTaskRes.json() as { task: { status: string } };
    assert.equal(queuedTask.task.status, "queued");

    const queue = makeQueue(dataDir);
    const completed = await queue.complete(taskPayload.task.jobId, "test-worker", { ok: true });
    assert.equal(completed?.status, "completed");

    const completedTaskRes = await fetch(`${base}/hub/api/tasks/${taskPayload.task.taskId}`);
    assert.equal(completedTaskRes.status, 200);
    const completedTask = await completedTaskRes.json() as { task: { status: string } };
    assert.equal(completedTask.task.status, "completed");

    const failedTaskCreate = await fetch(`${base}/hub/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "debugger-1",
        workspaceId: workspace.workspaceId,
        prompt: "Fail this task",
      }),
    });
    assert.equal(failedTaskCreate.status, 201);
    const failedTaskPayload = await failedTaskCreate.json() as { task: { taskId: string; jobId: string } };
    const failed = await queue.fail(failedTaskPayload.task.jobId, "test-worker", "expected failure", true, { ok: false });
    assert.equal(failed?.status, "failed");

    const failedTaskRes = await fetch(`${base}/hub/api/tasks/${failedTaskPayload.task.taskId}`);
    assert.equal(failedTaskRes.status, 200);
    const failedTask = await failedTaskRes.json() as { task: { status: string } };
    assert.equal(failedTask.task.status, "failed");

    const invalidHash = await fetch(`${base}/hub/api/commits/not-a-hash`);
    assert.equal(invalidHash.status, 400);

    const missingWorkspace = await fetch(`${base}/hub/api/workspaces/nope`);
    assert.equal(missingWorkspace.status, 404);

    const missingChannel = await fetch(`${base}/hub/api/channels/unknown/posts`);
    assert.equal(missingChannel.status, 404);

    const missingPost = await fetch(`${base}/hub/api/posts/post_missing/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "debugger-1", content: "nope" }),
    });
    assert.equal(missingPost.status, 404);

    const removeWorkspaceRes = await fetch(`${base}/hub/api/workspaces/${workspace.workspaceId}/remove`, {
      method: "POST",
    });
    assert.equal(removeWorkspaceRes.status, 200);

    const workspacesAfterRemove = await fetch(`${base}/hub/api/workspaces`);
    assert.equal(workspacesAfterRemove.status, 200);
    const activeAfterRemove = await workspacesAfterRemove.json() as { workspaces: Array<{ workspaceId: string }> };
    assert.ok(!activeAfterRemove.workspaces.some((item) => item.workspaceId === workspace.workspaceId));
  } finally {
    await stopChild(child);
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
});

test("hub: objectives auto-run with codex and require human merge to finish the loop", { timeout: 180_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-hub-objective-data");
  const repoDir = await createSourceRepo();
  const fakeCodex = await createFakeCodexBin();
  const tsxBin = path.join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx"
  );

  const startServer = (nextPort: number) => spawn(tsxBin, ["src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(nextPort),
      DATA_DIR: dataDir,
      HUB_REPO_ROOT: repoDir,
      HUB_CODEX_BIN: fakeCodex,
      OPENAI_API_KEY: "",
      IMPROVEMENT_VALIDATE_CMD: "echo validate-ok",
      IMPROVEMENT_HARNESS_CMD: "echo harness-ok",
    },
    stdio: "pipe",
  });

  let child = startServer(port);

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${base}/hub`, 30_000);

    const shellRes = await fetch(`${base}/hub`);
    assert.equal(shellRes.status, 200);
    const shellHtml = await shellRes.text();
    assert.match(shellHtml, /Receipt Hub/);
    assert.match(shellHtml, /id="hub-compose"/);
    assert.match(shellHtml, /id="hub-summary"/);
    assert.match(shellHtml, /id="hub-board"/);
    assert.match(shellHtml, /id="hub-objective"/);
    assert.match(shellHtml, /id="hub-live"/);
    assert.match(shellHtml, /<body hx-ext="sse" sse-connect="\/hub\/stream">/);
    assert.doesNotMatch(shellHtml, /EventSource\(/);
    assert.doesNotMatch(shellHtml, /id="hub-dashboard"/);
    assert.doesNotMatch(shellHtml, /load, sse:receipt-refresh/);
    assert.doesNotMatch(shellHtml, /Manual Tasks/);
    assert.doesNotMatch(shellHtml, /Recent Commits/);
    assert.match(shellHtml, /Load debug surfaces/);
    assert.match(shellHtml, /Load commit explorer/);

    const composeRes = await fetch(`${base}/hub/island/compose`);
    assert.equal(composeRes.status, 200);
    assert.match(composeRes.headers.get("server-timing") ?? "", /hub-compose/);
    const composeHtml = await composeRes.text();
    assert.match(composeHtml, /Create Objective/);
    assert.match(composeHtml, /id="hub-compose"/);
    assert.doesNotMatch(composeHtml, /load, hub-compose-refresh/);
    assert.doesNotMatch(composeHtml, /Advanced/);
    assert.doesNotMatch(composeHtml, /name="baseHash"/);
    assert.doesNotMatch(composeHtml, /name="checks"/);

    const summaryRes = await fetch(`${base}/hub/island/summary`);
    assert.equal(summaryRes.status, 200);
    assert.match(summaryRes.headers.get("server-timing") ?? "", /hub-summary/);
    const summaryHtml = await summaryRes.text();
    assert.match(summaryHtml, /id="hub-summary"/);
    assert.match(summaryHtml, /mirror/i);
    assert.doesNotMatch(summaryHtml, /sse-connect=/);

    const boardRes = await fetch(`${base}/hub/island/board`);
    assert.equal(boardRes.status, 200);
    assert.match(boardRes.headers.get("server-timing") ?? "", /hub-board/);
    const boardHtml = await boardRes.text();
    assert.match(boardHtml, /id="hub-board"/);
    assert.match(boardHtml, /sse:receipt-refresh/);
    assert.match(boardHtml, /sse:job-refresh/);
    assert.doesNotMatch(boardHtml, /sse-connect=/);
    assert.doesNotMatch(boardHtml, /load, sse:receipt-refresh/);
    assert.match(boardHtml, /Objective Grid/);
    assert.match(boardHtml, /Ready To Merge/);
    assert.doesNotMatch(boardHtml, /npm run build/);
    assert.doesNotMatch(boardHtml, /Create Objective/);
    assert.doesNotMatch(boardHtml, /href="\/hub\?objective=/);

    const objectiveRes = await fetch(`${base}/hub/island/objective`);
    assert.equal(objectiveRes.status, 200);
    assert.match(objectiveRes.headers.get("server-timing") ?? "", /hub-objective/);
    const objectiveHtml = await objectiveRes.text();
    assert.match(objectiveHtml, /id="hub-objective"/);
    assert.doesNotMatch(objectiveHtml, /sse-connect=/);
    assert.doesNotMatch(objectiveHtml, /load, sse:receipt-refresh/);

    const liveRes = await fetch(`${base}/hub/island/live`);
    assert.equal(liveRes.status, 200);
    assert.match(liveRes.headers.get("server-timing") ?? "", /hub-live/);
    const liveHtml = await liveRes.text();
    assert.match(liveHtml, /id="hub-live"/);
    assert.doesNotMatch(liveHtml, /sse-connect=/);
    assert.match(liveHtml, /select an objective|has no active Codex pass/i);

    const debugRes = await fetch(`${base}/hub/island/debug`);
    assert.equal(debugRes.status, 200);
    const debugHtml = await debugRes.text();
    assert.match(debugHtml, /Workspaces/);
    assert.match(debugHtml, /Manual Tasks/);

    const commitsRes = await fetch(`${base}/hub/island/commits`);
    assert.equal(commitsRes.status, 200);
    const commitsHtml = await commitsRes.text();
    assert.match(commitsHtml, /Recent Commits/);
    assert.match(commitsHtml, /Selected Commit/);

    const objectiveCreate = await fetch(`${base}/hub/api/objectives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Exercise the codex-powered hub flow",
        prompt: "Create a tiny tracked file so the hub can verify planner, builder, reviewer, and approval.",
        checks: ["git rev-parse HEAD"],
        channel: "results",
      }),
    });
    assert.equal(objectiveCreate.status, 201);
    const created = await objectiveCreate.json() as { objective: { objectiveId: string } };

    const awaiting = await waitForObjectiveStatus(base, created.objective.objectiveId, ["awaiting_confirmation"], 120_000);
    assert.equal(awaiting.objective.status, "awaiting_confirmation");
    assert.equal(awaiting.objective.latestReviewOutcome, "approved");
    assert.ok(awaiting.objective.latestCommitHash);
    assert.equal(awaiting.objective.passes.length, 5);
    assert.deepEqual(
      awaiting.objective.passes.map((pass) => `${pass.phase}:${pass.outcome ?? "queued"}`),
      [
        "planner:plan_ready",
        "builder:candidate_ready",
        "reviewer:changes_requested",
        "builder:candidate_ready",
        "reviewer:approved",
      ],
    );
    assert.equal(awaiting.objective.graph.currentNodeId, undefined);
    assert.deepEqual(awaiting.objective.graph.nodeOrder, awaiting.objective.passes.map((pass) => `${created.objective.objectiveId}_${pass.phase}_${String(pass.passNumber).padStart(2, "0")}`));
    assert.deepEqual(
      awaiting.objective.graph.nodes.map((node) => `${node.kind}:${node.status}`),
      [
        "planner:completed",
        "builder:completed",
        "reviewer:completed",
        "builder:completed",
        "reviewer:completed",
      ],
    );
    assert.deepEqual(
      awaiting.objective.graph.nodes.map((node) => node.dependsOn.length),
      [0, 1, 1, 1, 1],
    );

    const objectiveDetailRes = await fetch(`${base}/hub/api/objectives/${created.objective.objectiveId}`);
    assert.equal(objectiveDetailRes.status, 200);
    const objectiveDetailPayload = await objectiveDetailRes.json() as {
      objective: {
        latestPlanSummary?: string;
        latestPlanHandoff?: string;
        latestBuildSummary?: string;
        latestBuildHandoff?: string;
        latestReviewSummary?: string;
        latestReviewHandoff?: string;
        nextHandoff?: string;
      };
    };
    assert.equal(objectiveDetailPayload.objective.latestPlanSummary, "Plan ready for implementation.");
    assert.match(objectiveDetailPayload.objective.latestPlanHandoff ?? "", /Implement the requested change/i);
    assert.equal(objectiveDetailPayload.objective.latestBuildSummary, "Implemented builder pass 4.");
    assert.match(objectiveDetailPayload.objective.latestBuildHandoff ?? "", /Verify OBJECTIVE_AUTOGEN\.txt/i);
    assert.equal(objectiveDetailPayload.objective.latestReviewSummary, "The candidate looks good.");
    assert.match(objectiveDetailPayload.objective.latestReviewHandoff ?? "", /human confirmation/i);
    assert.match(objectiveDetailPayload.objective.nextHandoff ?? "", /human confirmation|merge/i);

    const selectedBoardRes = await fetch(`${base}/hub/island/board?objective=${created.objective.objectiveId}`);
    assert.equal(selectedBoardRes.status, 200);
    const selectedBoardHtml = await selectedBoardRes.text();
    assert.match(selectedBoardHtml, /id="hub-objective"/);
    assert.match(selectedBoardHtml, /hx-swap-oob="outerHTML"/);
    assert.match(selectedBoardHtml, /id="hub-live"/);
    assert.match(selectedBoardHtml, new RegExp(`/hub/ui/objectives/${created.objective.objectiveId}/archive`));
    assert.match(selectedBoardHtml, /aria-label="Archive objective/);

    const selectedObjectiveRes = await fetch(`${base}/hub/island/objective?objective=${created.objective.objectiveId}`);
    assert.equal(selectedObjectiveRes.status, 200);
    const selectedObjectiveHtml = await selectedObjectiveRes.text();
    assert.match(selectedObjectiveHtml, /Planned/);
    assert.match(selectedObjectiveHtml, /Built/);
    assert.match(selectedObjectiveHtml, /Review/);
    assert.match(selectedObjectiveHtml, /Next Handoff/);
    assert.match(selectedObjectiveHtml, /Implemented builder pass 4\./);

    const sourceHeadBeforeMerge = await git(repoDir, ["rev-parse", "HEAD"]);

    const mergeRes = await fetch(`${base}/hub/api/objectives/${created.objective.objectiveId}/merge`, {
      method: "POST",
    });
    assert.equal(mergeRes.status, 200);

    const completed = await waitForObjectiveStatus(base, created.objective.objectiveId, ["completed"], 15_000);
    assert.equal(completed.objective.status, "completed");
    assert.equal(completed.objective.latestCommitHash, awaiting.objective.latestCommitHash);

    const sourceHeadAfterMerge = await git(repoDir, ["rev-parse", "HEAD"]);
    assert.notEqual(sourceHeadAfterMerge, sourceHeadBeforeMerge);
    assert.equal(sourceHeadAfterMerge, awaiting.objective.latestCommitHash);

    const workspacesRes = await fetch(`${base}/hub/api/workspaces`);
    assert.equal(workspacesRes.status, 200);
    const workspacesPayload = await workspacesRes.json() as { workspaces: Array<{ workspaceId: string }> };
    const objectiveWorkspaceIds = awaiting.objective.passes.map((pass) => pass.workspaceId);
    for (const workspaceId of objectiveWorkspaceIds) {
      assert.ok(!workspacesPayload.workspaces.some((workspace) => workspace.workspaceId === workspaceId));
    }

    const stateRes = await fetch(`${base}/hub/api/state`);
    assert.equal(stateRes.status, 200);
    const statePayload = await stateRes.json() as {
      lanes: Record<string, Array<{ objectiveId: string }>>;
    };
    assert.ok(statePayload.lanes.completed.some((item) => item.objectiveId === created.objective.objectiveId));

    const archiveUiRes = await fetch(`${base}/hub/ui/objectives/${created.objective.objectiveId}/archive`, {
      method: "POST",
    });
    assert.equal(archiveUiRes.status, 200);
    assert.match(archiveUiRes.headers.get("hx-trigger") ?? "", /hub-board-refresh/);
    assert.match(archiveUiRes.headers.get("hx-trigger") ?? "", /hub-compose-refresh/);

    const archiveApiRes = await fetch(`${base}/hub/api/objectives/${created.objective.objectiveId}/archive`, {
      method: "POST",
    });
    assert.equal(archiveApiRes.status, 200);
    const archiveApiPayload = await archiveApiRes.json() as {
      objective: {
        objectiveId: string;
        archivedAt?: number;
      };
    };
    assert.equal(archiveApiPayload.objective.objectiveId, created.objective.objectiveId);
    assert.ok(archiveApiPayload.objective.archivedAt);

    const listAfterArchiveRes = await fetch(`${base}/hub/api/objectives`);
    assert.equal(listAfterArchiveRes.status, 200);
    const listAfterArchivePayload = await listAfterArchiveRes.json() as {
      objectives: Array<{ objectiveId: string }>;
    };
    assert.ok(!listAfterArchivePayload.objectives.some((item) => item.objectiveId === created.objective.objectiveId));

    const composeAfterArchiveRes = await fetch(`${base}/hub/island/compose`);
    assert.equal(composeAfterArchiveRes.status, 200);
    assert.match(await composeAfterArchiveRes.text(), /0 tracked/);

    const hiddenStateRes = await fetch(`${base}/hub/api/state?objective=${created.objective.objectiveId}`);
    assert.equal(hiddenStateRes.status, 200);
    const hiddenStatePayload = await hiddenStateRes.json() as {
      objectives: Array<{ objectiveId: string }>;
      lanes: Record<string, Array<{ objectiveId: string }>>;
      selectedObjective?: { objectiveId: string };
    };
    assert.equal(hiddenStatePayload.objectives.length, 0);
    assert.ok(Object.values(hiddenStatePayload.lanes).every((lane) => !lane.some((item) => item.objectiveId === created.objective.objectiveId)));
    assert.equal(hiddenStatePayload.selectedObjective, undefined);

    const hiddenBoardRes = await fetch(`${base}/hub/island/board?objective=${created.objective.objectiveId}`);
    assert.equal(hiddenBoardRes.status, 200);
    const hiddenBoardHtml = await hiddenBoardRes.text();
    assert.match(hiddenBoardHtml, /No objectives\./);
    assert.match(hiddenBoardHtml, /Select a card/);
    assert.doesNotMatch(hiddenBoardHtml, new RegExp(created.objective.objectiveId));
  } finally {
    await stopChild(child);
  }
});

test("hub: objective pass retries after sandbox loss and restores the worktree from durable state", { timeout: 180_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-hub-objective-retry-data");
  const repoDir = await createSourceRepo();
  const fakeCodex = await createFakeCodexBin({ failFirstBuilderByRemovingWorkspace: true });
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
      HUB_REPO_ROOT: repoDir,
      HUB_CODEX_BIN: fakeCodex,
      OPENAI_API_KEY: "",
      JOB_POLL_MS: "150",
      IMPROVEMENT_VALIDATE_CMD: "echo validate-ok",
      IMPROVEMENT_HARNESS_CMD: "echo harness-ok",
    },
    stdio: "pipe",
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${base}/hub`, 30_000);

    const objectiveCreate = await fetch(`${base}/hub/api/objectives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Recover from builder workspace loss",
        prompt: "Exercise queue retry and workspace restoration in the hub objective flow.",
        checks: ["git rev-parse HEAD"],
      }),
    });
    assert.equal(objectiveCreate.status, 201);
    const created = await objectiveCreate.json() as { objective: { objectiveId: string } };

    const awaiting = await waitForObjectiveStatus(base, created.objective.objectiveId, ["awaiting_confirmation"], 120_000);
    assert.equal(awaiting.objective.status, "awaiting_confirmation");

    const firstBuilder = awaiting.objective.passes.find((pass) => pass.phase === "builder" && pass.passNumber === 2);
    assert.ok(firstBuilder);

    const queue = makeQueue(dataDir);
    const builderJob = await queue.getJob(firstBuilder.jobId);
    assert.equal(builderJob?.status, "completed");
    assert.equal(builderJob?.attempt, 2);

    const restoredWorkspaceRes = await fetch(`${base}/hub/api/workspaces/${firstBuilder.workspaceId}`);
    assert.equal(restoredWorkspaceRes.status, 200);
    const restoredWorkspacePayload = await restoredWorkspaceRes.json() as {
      workspace: { exists: boolean; dirty: boolean; head?: string };
    };
    assert.equal(restoredWorkspacePayload.workspace.exists, true);
    assert.equal(restoredWorkspacePayload.workspace.dirty, false);
    assert.ok(restoredWorkspacePayload.workspace.head);

    const firstBuilderNodeId = `${created.objective.objectiveId}_builder_02`;
    const firstBuilderNode = awaiting.objective.graph.nodes.find((node) => node.nodeId === firstBuilderNodeId);
    assert.equal(firstBuilderNode?.status, "completed");
  } finally {
    await stopChild(child);
  }
});

test("hub: merge is blocked when the source repo is dirty", { timeout: 180_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-hub-objective-merge-guard-data");
  const repoDir = await createSourceRepo();
  const fakeCodex = await createFakeCodexBin();
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
      HUB_REPO_ROOT: repoDir,
      HUB_CODEX_BIN: fakeCodex,
      OPENAI_API_KEY: "",
      IMPROVEMENT_VALIDATE_CMD: "echo validate-ok",
      IMPROVEMENT_HARNESS_CMD: "echo harness-ok",
    },
    stdio: "pipe",
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${base}/hub`, 30_000);

    const objectiveCreate = await fetch(`${base}/hub/api/objectives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Exercise merge guard",
        prompt: "Create a tiny tracked file so the hub can verify merge blocking.",
        checks: ["git rev-parse HEAD"],
      }),
    });
    assert.equal(objectiveCreate.status, 201);
    const created = await objectiveCreate.json() as { objective: { objectiveId: string; latestCommitHash?: string } };

    const awaiting = await waitForObjectiveStatus(base, created.objective.objectiveId, ["awaiting_confirmation"], 120_000);
    assert.equal(awaiting.objective.status, "awaiting_confirmation");
    assert.ok(awaiting.objective.latestCommitHash);

    await fs.writeFile(path.join(repoDir, "DIRTY_MERGE_GUARD.txt"), "uncommitted\n", "utf-8");

    const mergeRes = await fetch(`${base}/hub/api/objectives/${created.objective.objectiveId}/merge`, {
      method: "POST",
    });
    assert.equal(mergeRes.status, 409);
    assert.match(await mergeRes.text(), /source repository has uncommitted changes/i);

    const sourceHead = await git(repoDir, ["rev-parse", "HEAD"]);
    assert.notEqual(sourceHead, awaiting.objective.latestCommitHash);

    const stillAwaiting = await fetch(`${base}/hub/api/objectives/${created.objective.objectiveId}`);
    assert.equal(stillAwaiting.status, 200);
    const stillAwaitingPayload = await stillAwaiting.json() as { objective: { status: string } };
    assert.equal(stillAwaitingPayload.objective.status, "awaiting_confirmation");
  } finally {
    await stopChild(child);
  }
});

test("hub: divergent merge auto-queues a reconciliation pass instead of failing", { timeout: 180_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-hub-objective-diverge-data");
  const repoDir = await createSourceRepo();
  const fakeCodex = await createFakeCodexBin();
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
      HUB_REPO_ROOT: repoDir,
      HUB_CODEX_BIN: fakeCodex,
      OPENAI_API_KEY: "",
      IMPROVEMENT_VALIDATE_CMD: "echo validate-ok",
      IMPROVEMENT_HARNESS_CMD: "echo harness-ok",
    },
    stdio: "pipe",
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${base}/hub`, 30_000);

    const objectiveCreate = await fetch(`${base}/hub/api/objectives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Auto reconcile stale merge",
        prompt: "Create a tiny tracked file so the hub can reconcile an approved candidate after main moves.",
        checks: ["git rev-parse HEAD"],
      }),
    });
    assert.equal(objectiveCreate.status, 201);
    const created = await objectiveCreate.json() as { objective: { objectiveId: string } };

    const firstAwaiting = await waitForObjectiveStatus(base, created.objective.objectiveId, ["awaiting_confirmation"], 120_000);
    assert.equal(firstAwaiting.objective.passes.length, 5);
    const firstCandidate = firstAwaiting.objective.latestCommitHash;
    assert.ok(firstCandidate);

    await fs.writeFile(path.join(repoDir, "MAIN_MOVED.txt"), "main moved forward\n", "utf-8");
    await git(repoDir, ["add", "MAIN_MOVED.txt"]);
    await git(repoDir, ["commit", "-m", "advance main before merge"]);

    const reconcileRes = await fetch(`${base}/hub/api/objectives/${created.objective.objectiveId}/merge`, {
      method: "POST",
    });
    assert.equal(reconcileRes.status, 200);
    const reconcilePayload = await reconcileRes.json() as {
      objective: {
        status: string;
        latestSummary?: string;
        passes: Array<{ phase: string; passNumber: number }>;
      };
    };
    assert.equal(reconcilePayload.objective.status, "building");
    assert.match(reconcilePayload.objective.latestSummary ?? "", /queued a reconciliation builder pass/i);
    assert.equal(reconcilePayload.objective.passes.at(-1)?.phase, "builder");

    const secondAwaiting = await waitForObjectiveStatus(base, created.objective.objectiveId, ["awaiting_confirmation"], 120_000);
    assert.equal(secondAwaiting.objective.passes.length, 7);
    assert.notEqual(secondAwaiting.objective.latestCommitHash, firstCandidate);
    assert.deepEqual(
      secondAwaiting.objective.passes.slice(-2).map((pass) => `${pass.phase}:${pass.outcome ?? "queued"}`),
      ["builder:candidate_ready", "reviewer:approved"],
    );

    const mergeRes = await fetch(`${base}/hub/api/objectives/${created.objective.objectiveId}/merge`, {
      method: "POST",
    });
    assert.equal(mergeRes.status, 200);

    const completed = await waitForObjectiveStatus(base, created.objective.objectiveId, ["completed"], 20_000);
    assert.equal(completed.objective.latestCommitHash, secondAwaiting.objective.latestCommitHash);
    const sourceHead = await git(repoDir, ["rev-parse", "HEAD"]);
    assert.equal(sourceHead, secondAwaiting.objective.latestCommitHash);
  } finally {
    await stopChild(child);
  }
});

test("hub: failed objective pass is reconciled to blocked on the next read", { timeout: 120_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-hub-objective-fail-data");
  const repoDir = await createSourceRepo();
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
      HUB_REPO_ROOT: repoDir,
      OPENAI_API_KEY: "",
      JOB_POLL_MS: "60000",
      IMPROVEMENT_VALIDATE_CMD: "echo validate-ok",
      IMPROVEMENT_HARNESS_CMD: "echo harness-ok",
    },
    stdio: "pipe",
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${base}/hub`, 30_000);

    const objectiveCreate = await fetch(`${base}/hub/api/objectives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Reconcile failed planner",
        prompt: "This pass will be failed directly through the queue.",
      }),
    });
    assert.equal(objectiveCreate.status, 201);
    const created = await objectiveCreate.json() as {
      objective: {
        objectiveId: string;
        passes: Array<{ jobId: string }>;
      };
    };
    const plannerJobId = created.objective.passes[0]?.jobId;
    assert.ok(plannerJobId);

    const queue = makeQueue(dataDir);
    const failed = await queue.fail(plannerJobId, "test-worker", "forced failure", true, { ok: false });
    assert.equal(failed?.status, "failed");

    const detailRes = await fetch(`${base}/hub/api/objectives/${created.objective.objectiveId}`);
    assert.equal(detailRes.status, 200);
    const detailPayload = await detailRes.json() as {
      objective: {
        status: string;
        lane: string;
        latestSummary?: string;
        passes: Array<{ workspaceId: string }>;
      };
    };
    assert.equal(detailPayload.objective.status, "blocked");
    assert.equal(detailPayload.objective.lane, "blocked");
    assert.match(detailPayload.objective.latestSummary ?? "", /forced failure/i);

    const cleanupRes = await fetch(`${base}/hub/api/objectives/${created.objective.objectiveId}/cleanup`, {
      method: "POST",
    });
    assert.equal(cleanupRes.status, 200);

    const workspacesRes = await fetch(`${base}/hub/api/workspaces`);
    assert.equal(workspacesRes.status, 200);
    const workspacesPayload = await workspacesRes.json() as { workspaces: Array<{ workspaceId: string }> };
    for (const pass of detailPayload.objective.passes) {
      assert.ok(!workspacesPayload.workspaces.some((workspace) => workspace.workspaceId === pass.workspaceId));
    }
  } finally {
    await stopChild(child);
  }
});

test("hub: dirty source repo blocks new objectives unless baseHash is provided", { timeout: 120_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-hub-dirty-objective-data");
  const repoDir = await createSourceRepo();
  const tsxBin = path.join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx"
  );

  await fs.writeFile(path.join(repoDir, "LOCAL_ONLY.txt"), "dirty working tree\n", "utf-8");

  const child = spawn(tsxBin, ["src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      HUB_REPO_ROOT: repoDir,
      OPENAI_API_KEY: "",
      JOB_POLL_MS: "60000",
      IMPROVEMENT_VALIDATE_CMD: "echo validate-ok",
      IMPROVEMENT_HARNESS_CMD: "echo harness-ok",
    },
    stdio: "pipe",
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${base}/hub`, 30_000);

    const stateRes = await fetch(`${base}/hub/api/state`);
    assert.equal(stateRes.status, 200);
    const statePayload = await stateRes.json() as {
      repo: { dirty: boolean; changedFiles: string[]; sourceHead?: string };
    };
    assert.equal(statePayload.repo.dirty, true);
    assert.ok(statePayload.repo.changedFiles.includes("LOCAL_ONLY.txt"));

    const blockedCreate = await fetch(`${base}/hub/api/objectives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Should fail on dirty source",
        prompt: "This should not start without an explicit base commit.",
      }),
    });
    assert.equal(blockedCreate.status, 409);
    assert.match(await blockedCreate.text(), /Objectives only see committed Git history/i);

    const explicitBase = await git(repoDir, ["rev-parse", "HEAD"]);
    const allowedCreate = await fetch(`${base}/hub/api/objectives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Allowed with explicit base",
        prompt: "Use the pinned base hash.",
        baseHash: explicitBase,
      }),
    });
    assert.equal(allowedCreate.status, 201);
    const created = await allowedCreate.json() as { objective: { baseHash: string; status: string } };
    assert.equal(created.objective.baseHash, explicitBase);
    assert.equal(created.objective.status, "planning");
  } finally {
    await stopChild(child);
  }
});

test("hub: invalid source repo returns 503 without breaking core endpoints", { timeout: 120_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-hub-invalid-data");
  const nonRepoDir = await createTempDir("receipt-hub-not-repo");
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
      HUB_REPO_ROOT: nonRepoDir,
      OPENAI_API_KEY: "",
      IMPROVEMENT_VALIDATE_CMD: "echo validate-ok",
      IMPROVEMENT_HARNESS_CMD: "echo harness-ok",
    },
    stdio: "pipe",
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${base}/jobs`, 30_000);

    const hubRes = await fetch(`${base}/hub/api/state`);
    assert.equal(hubRes.status, 503);

    const jobsRes = await fetch(`${base}/jobs`);
    assert.equal(jobsRes.status, 200);
  } finally {
    await stopChild(child);
  }
});

test("hub: onboarding script registers default agents idempotently", { timeout: 120_000 }, async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-hub-onboard-data");
  const repoDir = await createSourceRepo();
  const configDir = await createTempDir("receipt-hub-onboard-config");
  const configPath = path.join(configDir, "hub-agents.json");
  const tsxBin = path.join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx"
  );

  await fs.writeFile(configPath, JSON.stringify({
    agents: [
      {
        agentId: "planner-1",
        displayName: "Planner 1",
        memoryScope: "hub/agents/planner-1",
      },
      {
        agentId: "builder-1",
        displayName: "Builder 1",
        memoryScope: "hub/agents/builder-1",
      },
      {
        agentId: "reviewer-1",
        displayName: "Reviewer 1",
        memoryScope: "hub/agents/reviewer-1",
      },
    ],
  }, null, 2), "utf-8");

  const child = spawn(tsxBin, ["src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      HUB_REPO_ROOT: repoDir,
      OPENAI_API_KEY: "",
      JOB_POLL_MS: "60000",
      IMPROVEMENT_VALIDATE_CMD: "echo validate-ok",
      IMPROVEMENT_HARNESS_CMD: "echo harness-ok",
    },
    stdio: "pipe",
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${base}/hub`, 30_000);

    const runOnboard = async (): Promise<string> => {
      const result = await execFileAsync(tsxBin, ["scripts/hub-onboard.ts", "--url", base, "--file", configPath], {
        cwd: ROOT,
        encoding: "utf-8",
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
      });
      return result.stdout;
    };

    const firstRun = await runOnboard();
    assert.match(firstRun, /hub onboarding complete: 0 created, 3 already present/);

    const agentsAfterFirstRun = await fetch(`${base}/hub/api/agents`);
    assert.equal(agentsAfterFirstRun.status, 200);
    const firstPayload = await agentsAfterFirstRun.json() as { agents: Array<{ agentId: string; memoryScope: string }> };
    assert.deepEqual(
      firstPayload.agents.map((agent) => agent.agentId),
      ["builder-1", "planner-1", "reviewer-1"]
    );
    assert.equal(firstPayload.agents[0]?.memoryScope, "hub/agents/builder-1");

    const secondRun = await runOnboard();
    assert.match(secondRun, /hub onboarding complete: 0 created, 3 already present/);

    const agentsAfterSecondRun = await fetch(`${base}/hub/api/agents`);
    assert.equal(agentsAfterSecondRun.status, 200);
    const secondPayload = await agentsAfterSecondRun.json() as { agents: Array<{ agentId: string }> };
    assert.equal(secondPayload.agents.length, 3);
  } finally {
    await stopChild(child);
  }
});
