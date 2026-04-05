import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HubGitError, type HubGit } from "../../src/adapters/hub-git";
import {
  ensureFactoryTaskRuntime,
  ensureFactoryTaskWorkspace,
  materializeFactoryIsolatedTaskSupportFiles,
  removeFactoryTaskRuntimeWorkspace,
} from "../../src/services/factory/task-runtime";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

test("factory task runtime: materialize isolated support files copies AGENTS and selected skills", async () => {
  const profileRoot = await createTempDir("receipt-factory-profile");
  const runtimePath = await createTempDir("receipt-factory-runtime");
  await fs.writeFile(path.join(profileRoot, "AGENTS.md"), "# factory\n", "utf-8");
  await fs.mkdir(path.join(profileRoot, "skills", "factory-receipt-worker"), { recursive: true });
  await fs.writeFile(path.join(profileRoot, "skills", "factory-receipt-worker", "SKILL.md"), "worker\n", "utf-8");
  await fs.mkdir(path.join(profileRoot, "skills", "custom-skill"), { recursive: true });
  await fs.writeFile(path.join(profileRoot, "skills", "custom-skill", "SKILL.md"), "custom\n", "utf-8");
  await fs.mkdir(path.join(profileRoot, "notes"), { recursive: true });
  await fs.writeFile(path.join(profileRoot, "notes", "ignore.txt"), "ignore\n", "utf-8");

  await materializeFactoryIsolatedTaskSupportFiles(runtimePath, profileRoot, {
    selectedSkills: [
      "skills/custom-skill/SKILL.md",
      "/tmp/absolute-skill/SKILL.md",
      "notes/ignore.txt",
    ],
  });

  expect(await pathExists(path.join(runtimePath, "AGENTS.md"))).toBe(true);
  expect(await pathExists(path.join(runtimePath, "skills", "factory-receipt-worker", "SKILL.md"))).toBe(true);
  expect(await pathExists(path.join(runtimePath, "skills", "custom-skill", "SKILL.md"))).toBe(true);
  expect(await pathExists(path.join(runtimePath, "notes", "ignore.txt"))).toBe(false);
});

test("factory task runtime: ensureFactoryTaskWorkspace resets mismatched existing worktrees", async () => {
  const calls: string[] = [];
  const git = {
    worktreesDir: "/tmp/worktrees",
    async worktreeStatus(workspacePath: string) {
      calls.push(`status:${workspacePath}`);
      return { exists: true, dirty: true, head: "old-head", branch: "hub/codex/demo" };
    },
    async resetWorkspace(workspacePath: string, baseHash: string) {
      calls.push(`reset:${workspacePath}:${baseHash}`);
      return { exists: true, dirty: false, head: baseHash, branch: "hub/codex/demo" };
    },
    async createWorkspace() {
      throw new Error("should not create");
    },
    async restoreWorkspace() {
      throw new Error("should not restore");
    },
    async removeWorkspace() {
      throw new Error("should not remove");
    },
  } satisfies Pick<HubGit, "createWorkspace" | "removeWorkspace" | "resetWorkspace" | "restoreWorkspace" | "worktreeStatus" | "worktreesDir">;

  const runtime = await ensureFactoryTaskWorkspace({
    git,
    workspaceId: "demo",
    workerType: "codex",
    baseHash: "new-head",
    resetIfBaseMismatch: true,
  });

  expect(runtime.path).toBe("/tmp/worktrees/demo");
  expect(runtime.baseHash).toBe("new-head");
  expect(calls).toEqual([
    "status:/tmp/worktrees/demo",
    "reset:/tmp/worktrees/demo:new-head",
  ]);
});

test("factory task runtime: ensureFactoryTaskWorkspace restores a conflicting workspace create", async () => {
  const calls: string[] = [];
  const git = {
    worktreesDir: "/tmp/worktrees",
    async worktreeStatus() {
      calls.push("status");
      return { exists: false, dirty: false };
    },
    async createWorkspace() {
      calls.push("create");
      throw new HubGitError(409, "exists");
    },
    async restoreWorkspace(input: Parameters<HubGit["restoreWorkspace"]>[0]) {
      calls.push(`restore:${input.workspacePath}:${input.baseHash}`);
      return {
        workspaceId: input.workspaceId,
        branchName: input.branchName,
        path: input.workspacePath,
        baseHash: input.baseHash,
      };
    },
    async resetWorkspace() {
      throw new Error("should not reset");
    },
    async removeWorkspace() {
      throw new Error("should not remove");
    },
  } satisfies Pick<HubGit, "createWorkspace" | "removeWorkspace" | "resetWorkspace" | "restoreWorkspace" | "worktreeStatus" | "worktreesDir">;

  const runtime = await ensureFactoryTaskWorkspace({
    git,
    workspaceId: "demo",
    workerType: "codex",
    baseHash: "base-123",
  });

  expect(runtime).toEqual({
    workspaceId: "demo",
    branchName: "hub/codex/demo",
    path: "/tmp/worktrees/demo",
    baseHash: "base-123",
  });
  expect(calls).toEqual([
    "status",
    "create",
    "restore:/tmp/worktrees/demo:base-123",
  ]);
});

test("factory task runtime: ensureFactoryTaskWorkspace reclones invalid workspace paths before git operations", async () => {
  const calls: string[] = [];
  const git = {
    repoRoot: "/tmp/source-repo",
    worktreesDir: "/tmp/worktrees",
    async validateWorkspacePath() {
      calls.push("validate");
      return { valid: false, originUrl: "file:///tmp/wrong-repo" };
    },
    async worktreeStatus() {
      calls.push("status");
      return { exists: true, dirty: false, head: "old-head", branch: "hub/codex/demo" };
    },
    async removeWorkspace(workspacePath: string) {
      calls.push(`remove:${workspacePath}`);
    },
    async createWorkspace(input: Parameters<HubGit["createWorkspace"]>[0]) {
      calls.push(`create:${input.workspaceId}:${input.agentId}:${input.baseHash}`);
      return {
        workspaceId: input.workspaceId,
        branchName: `hub/${input.agentId}/${input.workspaceId}`,
        path: path.join("/tmp/worktrees", input.workspaceId),
        baseHash: input.baseHash ?? "new-head",
      };
    },
    async resetWorkspace() {
      throw new Error("should not reset");
    },
    async restoreWorkspace() {
      throw new Error("should not restore");
    },
  } satisfies Pick<HubGit, "createWorkspace" | "removeWorkspace" | "resetWorkspace" | "restoreWorkspace" | "validateWorkspacePath" | "worktreeStatus" | "worktreesDir" | "repoRoot">;

  const runtime = await ensureFactoryTaskWorkspace({
    git,
    workspaceId: "demo",
    workerType: "codex",
    baseHash: "new-head",
  });

  expect(runtime.path).toBe("/tmp/worktrees/demo");
  expect(calls).toEqual([
    "validate",
    "remove:/tmp/worktrees/demo",
    "create:demo:codex:new-head",
  ]);
});

test("factory task runtime: isolated runtimes copy support files and cleanup respects worktree ownership", async () => {
  const dataDir = await createTempDir("receipt-factory-data");
  const profileRoot = await createTempDir("receipt-factory-profile");
  const isolatedRuntimePath = path.join(dataDir, "factory", "runtimes", "demo");
  await fs.writeFile(path.join(profileRoot, "AGENTS.md"), "# factory\n", "utf-8");
  await fs.mkdir(path.join(profileRoot, "skills", "factory-receipt-worker"), { recursive: true });
  await fs.writeFile(path.join(profileRoot, "skills", "factory-receipt-worker", "SKILL.md"), "worker\n", "utf-8");

  let removedWorkspace: string | undefined;
  const git = {
    worktreesDir: path.join(dataDir, "hub", "worktrees"),
    async worktreeStatus() {
      return { exists: false, dirty: false };
    },
    async createWorkspace() {
      throw new Error("should not create");
    },
    async restoreWorkspace() {
      throw new Error("should not restore");
    },
    async resetWorkspace() {
      throw new Error("should not reset");
    },
    async removeWorkspace(workspacePath: string) {
      removedWorkspace = workspacePath;
    },
  } satisfies Pick<HubGit, "createWorkspace" | "removeWorkspace" | "resetWorkspace" | "restoreWorkspace" | "worktreeStatus" | "worktreesDir">;

  const runtime = await ensureFactoryTaskRuntime({
    dataDir,
    executionMode: "isolated",
    git,
    profile: { selectedSkills: [] },
    profileRoot,
    workspaceId: "demo",
    workerType: "codex",
    baseHash: "base-123",
  });

  expect(runtime).toEqual({
    path: isolatedRuntimePath,
    branchName: "factory/isolated/demo",
    baseHash: "base-123",
  });
  expect(await pathExists(path.join(isolatedRuntimePath, "AGENTS.md"))).toBe(true);

  await removeFactoryTaskRuntimeWorkspace({
    workspacePath: isolatedRuntimePath,
    worktreesDir: git.worktreesDir,
    git,
  });
  expect(await pathExists(isolatedRuntimePath)).toBe(false);

  await removeFactoryTaskRuntimeWorkspace({
    workspacePath: path.join(git.worktreesDir, "task-demo"),
    worktreesDir: git.worktreesDir,
    git,
  });
  expect(removedWorkspace).toBe(path.join(git.worktreesDir, "task-demo"));
});
