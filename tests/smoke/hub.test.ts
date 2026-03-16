import { test, expect } from "bun:test";
import { spawn, type ChildProcess, execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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
      // booting
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  if (typeof child.pid === "number") {
    await execFileAsync("pkill", ["-TERM", "-P", String(child.pid)]).catch(() => undefined);
  }
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(5_000)]);
  if (child.exitCode === null) {
    if (typeof child.pid === "number") {
      await execFileAsync("pkill", ["-KILL", "-P", String(child.pid)]).catch(() => undefined);
    }
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), sleep(2_000)]);
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
  await git(repoDir, ["config", "user.name", "Hub Route Test"]);
  await git(repoDir, ["config", "user.email", "hub-route@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# hub route test\n", "utf-8");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  return repoDir;
};

const createFakeCodexBin = async (): Promise<string> => {
  const dir = await createTempDir("receipt-fake-codex");
  const bin = path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
  const script = `#!/usr/bin/env bun
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const lastMessageIndex = args.indexOf("--output-last-message");
const lastMessagePath = lastMessageIndex >= 0 ? args[lastMessageIndex + 1] : "";
const stdin = fs.readFileSync(0, "utf-8");
const factoryDir = path.join(process.cwd(), ".receipt", "factory");
const manifestName = fs.readdirSync(factoryDir).filter((name) => name.endsWith(".manifest.json")).sort()[0];
const manifest = JSON.parse(fs.readFileSync(path.join(factoryDir, manifestName), "utf-8"));
const taskId = String(manifest.task.taskId);
const resultPath = (stdin.match(/Write JSON to (.+?) with:/) || [])[1];
fs.writeFileSync(path.join(process.cwd(), "FACTORY_ROUTE_TEST.txt"), "factory route test\\n", "utf-8");
const result = {
  outcome: "approved",
  summary: "Completed " + taskId + " and prepared a candidate commit.",
  handoff: "Merge the candidate into the objective integration branch and validate it."
};
if (lastMessagePath) {
  fs.mkdirSync(path.dirname(lastMessagePath), { recursive: true });
  fs.writeFileSync(lastMessagePath, result.summary, "utf-8");
}
fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf-8");
process.stdout.write(result.summary + "\\n");
`;
  await fs.writeFile(bin, script, "utf-8");
  await fs.chmod(bin, 0o755);
  return bin;
};

const waitForFactoryObjective = async (
  base: string,
  objectiveId: string,
  predicate: (objective: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/factory/api/objectives/${objectiveId}`);
    if (res.ok) {
      const payload = await res.json() as { objective: Record<string, unknown> };
      if (predicate(payload.objective)) return payload.objective;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for factory objective ${objectiveId}`);
};

const startServer = async (): Promise<{
  readonly base: string;
  readonly child: ChildProcess;
}> => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-hub-route-data");
  const repoDir = await createSourceRepo();
  const fakeCodex = await createFakeCodexBin();
  const child = spawn(BUN, ["src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${path.dirname(fakeCodex)}${path.delimiter}${process.env.PATH ?? ""}`,
      PORT: String(port),
      DATA_DIR: dataDir,
      HUB_REPO_ROOT: repoDir,
      OPENAI_API_KEY: "",
      JOB_POLL_MS: "50",
      IMPROVEMENT_VALIDATE_CMD: "echo validate-ok",
      IMPROVEMENT_HARNESS_CMD: "echo harness-ok",
    },
    stdio: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForHttpOk(`${base}/factory`, 30_000);
  return { base, child };
};

test("factory routes: shell, policy, debug, and explicit promote work end to end", async () => {
  const { base, child } = await startServer();
  try {
    const shellRes = await fetch(`${base}/factory`);
    expect(shellRes.status).toBe(200);
    const shellBody = await shellRes.text();
    expect(shellBody).toMatch(/<script src="\/assets\/htmx\.min\.js"><\/script>/);
    expect(shellBody).toMatch(/id="factory-compose"/);
    expect(shellBody).toMatch(/id="factory-board"/);
    expect(shellBody).toMatch(/id="factory-objective"/);
    expect(shellBody).toMatch(/id="factory-live"/);
    expect(shellBody).toMatch(/id="factory-debug"/);
    expect(shellBody).toMatch(/new EventSource\("\/factory\/events"\)/);
    expect(shellBody).toMatch(/action="\/factory\/ui\/objectives"/);
    expect(shellBody).toMatch(/method="post"/);

    const htmxRes = await fetch(`${base}/assets/htmx.min.js`);
    expect(htmxRes.status).toBe(200);
    expect(htmxRes.headers.get("content-type") ?? "").toMatch(/application\/javascript/);

    const createRes = await fetch(`${base}/factory/api/objectives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Route objective",
        prompt: "Exercise the factory-first API surface.",
        checks: ["git status --short"],
        policy: {
          promotion: { autoPromote: false },
          throttles: { maxDispatchesPerReact: 1 },
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as {
      objective: {
        objectiveId: string;
        policy: {
          promotion: { autoPromote: boolean };
          throttles: { maxDispatchesPerReact: number };
          concurrency: { maxActiveTasks: number };
        };
      };
    };
    expect(created.objective.policy.promotion.autoPromote).toBe(false);
    expect(created.objective.policy.throttles.maxDispatchesPerReact).toBe(1);
    expect(created.objective.policy.concurrency.maxActiveTasks).toBe(4);

    const readyToPromote = await waitForFactoryObjective(
      base,
      created.objective.objectiveId,
      (objective) => objective.integration && (objective.integration as { status?: string }).status === "ready_to_promote",
      60_000,
    );
    expect(readyToPromote.status).not.toBe("completed");

    const debugRes = await fetch(`${base}/factory/api/objectives/${created.objective.objectiveId}/debug`);
    expect(debugRes.status).toBe(200);
    const debugPayload = await debugRes.json() as {
      debug: {
        policy: { promotion: { autoPromote: boolean } };
        budgetState: { taskRunsUsed: number };
        recentReceipts: Array<{ type: string }>;
      };
    };
    expect(debugPayload.debug.policy.promotion.autoPromote).toBe(false);
    expect(debugPayload.debug.budgetState.taskRunsUsed).toBe(1);
    expect(debugPayload.debug.recentReceipts.some((receipt) => receipt.type === "integration.ready_to_promote")).toBeTruthy();

    const receiptsRes = await fetch(`${base}/factory/api/objectives/${created.objective.objectiveId}/receipts?limit=50`);
    expect(receiptsRes.status).toBe(200);
    const receiptsPayload = await receiptsRes.json() as { receipts: Array<{ type: string }> };
    expect(receiptsPayload.receipts.some((receipt) => receipt.type === "objective.created")).toBeTruthy();

    const promoteFormRes = await fetch(`${base}/factory/ui/objectives/${created.objective.objectiveId}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(promoteFormRes.status).toBe(303);
    expect(
      promoteFormRes.headers.get("location"),
    ).toBe(
      `/factory?objective=${created.objective.objectiveId}`,
    );

    const completed = await waitForFactoryObjective(
      base,
      created.objective.objectiveId,
      (objective) => objective.status === "completed",
      30_000,
    );
    expect((completed.integration as { status?: string }).status).toBe("promoted");
  } finally {
    await stopChild(child);
  }
}, 120_000);

test("hub routes: objective APIs are removed while repo, workspace, and manual task APIs remain", async () => {
  const { base, child } = await startServer();
  try {
    const shellRes = await fetch(`${base}/hub`);
    expect(shellRes.status).toBe(200);
    const shellBody = await shellRes.text();
    expect(shellBody).toMatch(/Open Factory/);

    const legacyObjectiveShellRes = await fetch(`${base}/hub?objective=objective_legacy`, {
      redirect: "manual",
    });
    expect(legacyObjectiveShellRes.status).toBe(302);
    expect(
      legacyObjectiveShellRes.headers.get("location"),
    ).toBe(
      "/factory?objective=objective_legacy",
    );

    const objectiveApiRes = await fetch(`${base}/hub/api/objectives`);
    expect(objectiveApiRes.status).toBe(404);
    const objectiveIslandRes = await fetch(`${base}/hub/island/objective`);
    expect(objectiveIslandRes.status).toBe(404);

    const stateRes = await fetch(`${base}/hub/api/state`);
    expect(stateRes.status).toBe(200);
    const statePayload = await stateRes.json() as Record<string, unknown>;
    expect(!("objectives" in statePayload)).toBeTruthy();

    const workspacesRes = await fetch(`${base}/hub/api/workspaces`);
    expect(workspacesRes.status).toBe(200);

    const workspaceCreateRes = await fetch(`${base}/hub/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "builder-1",
      }),
    });
    expect(workspaceCreateRes.status).toBe(201);
    const workspaceCreate = await workspaceCreateRes.json() as {
      workspace: { workspaceId: string };
    };

    const taskCreateRes = await fetch(`${base}/hub/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "builder-1",
        workspaceId: workspaceCreate.workspace.workspaceId,
        prompt: "Inspect the workspace and report its status.",
      }),
    });
    expect(taskCreateRes.status).toBe(201);
  } finally {
    await stopChild(child);
  }
}, 120_000);
