import fs from "node:fs/promises";
import path from "node:path";

import { HubGitError, type HubGit } from "../../adapters/hub-git";
import type { FactoryObjectiveProfileSnapshot, FactoryTaskExecutionMode, FactoryWorkerType } from "../../modules/factory";

type FactoryRuntimeGit = Pick<
  HubGit,
  "createWorkspace" | "removeWorkspace" | "resetWorkspace" | "restoreWorkspace" | "worktreeStatus" | "worktreesDir"
>;

export const factoryTaskRuntimeDir = (dataDir: string, workspaceId: string): string =>
  path.join(dataDir, "factory", "runtimes", workspaceId);

export const factoryTaskRuntimesRoot = (dataDir: string): string =>
  path.join(dataDir, "factory", "runtimes");

export const materializeFactoryIsolatedTaskSupportFiles = async (
  runtimePath: string,
  profileRoot: string,
  profile: Pick<FactoryObjectiveProfileSnapshot, "selectedSkills">,
): Promise<void> => {
  const copyRoot = async (relativePath: string): Promise<void> => {
    const sourcePath = path.join(profileRoot, relativePath);
    const targetPath = path.join(runtimePath, relativePath);
    const stat = await fs.stat(sourcePath).catch(() => undefined);
    if (!stat) return;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (stat.isDirectory()) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
      return;
    }
    await fs.copyFile(sourcePath, targetPath);
  };

  const copiedSkillRoots = new Set<string>(["skills/factory-receipt-worker"]);
  for (const skillPath of profile.selectedSkills) {
    const trimmed = skillPath.trim();
    if (!trimmed || path.isAbsolute(trimmed)) continue;
    const normalized = trimmed.replace(/\\/g, "/");
    if (!normalized.startsWith("skills/")) continue;
    const segments = normalized.split("/").slice(0, 2);
    if (segments.length === 2) copiedSkillRoots.add(segments.join("/"));
  }

  await copyRoot("AGENTS.md");
  for (const skillRoot of copiedSkillRoots) {
    await copyRoot(skillRoot);
  }
};

export const ensureFactoryTaskWorkspace = async (input: {
  readonly git: FactoryRuntimeGit;
  readonly workspaceId: string;
  readonly workerType: FactoryWorkerType;
  readonly baseHash: string;
  readonly resetIfBaseMismatch?: boolean;
}): Promise<{ readonly path: string; readonly branchName: string; readonly baseHash: string }> => {
  const { git, workspaceId, workerType, baseHash } = input;
  const workspacePath = path.join(git.worktreesDir, workspaceId);
  const branchName = `hub/${workerType}/${workspaceId}`;
  const existing = await git.worktreeStatus(workspacePath);
  if (existing.exists) {
    if (input.resetIfBaseMismatch && existing.head && existing.head !== baseHash) {
      const restored = await git.resetWorkspace(workspacePath, baseHash);
      return {
        path: workspacePath,
        branchName: restored.branch ?? existing.branch ?? branchName,
        baseHash: restored.head ?? baseHash,
      };
    }
    return {
      path: workspacePath,
      branchName: existing.branch ?? branchName,
      baseHash: existing.head ?? baseHash,
    };
  }
  try {
    return await git.createWorkspace({
      workspaceId,
      agentId: workerType,
      baseHash,
    });
  } catch (err) {
    if (!(err instanceof HubGitError) || err.status !== 409) throw err;
    return git.restoreWorkspace({
      workspaceId,
      branchName,
      workspacePath,
      baseHash,
    });
  }
};

export const ensureFactoryTaskRuntime = async (input: {
  readonly dataDir: string;
  readonly executionMode: FactoryTaskExecutionMode;
  readonly git: FactoryRuntimeGit;
  readonly profile: Pick<FactoryObjectiveProfileSnapshot, "selectedSkills">;
  readonly profileRoot: string;
  readonly workspaceId: string;
  readonly workerType: FactoryWorkerType;
  readonly baseHash: string;
  readonly resetIfBaseMismatch?: boolean;
}): Promise<{ readonly path: string; readonly branchName: string; readonly baseHash: string }> => {
  if (input.executionMode === "isolated") {
    const runtimePath = factoryTaskRuntimeDir(input.dataDir, input.workspaceId);
    await fs.mkdir(runtimePath, { recursive: true });
    await materializeFactoryIsolatedTaskSupportFiles(runtimePath, input.profileRoot, input.profile);
    return {
      path: runtimePath,
      branchName: `factory/isolated/${input.workspaceId}`,
      baseHash: input.baseHash,
    };
  }
  return ensureFactoryTaskWorkspace({
    git: input.git,
    workspaceId: input.workspaceId,
    workerType: input.workerType,
    baseHash: input.baseHash,
    resetIfBaseMismatch: input.resetIfBaseMismatch,
  });
};

export const removeFactoryTaskRuntimeWorkspace = async (input: {
  readonly git: Pick<HubGit, "removeWorkspace">;
  readonly workspacePath: string;
  readonly worktreesDir: string;
}): Promise<void> => {
  if (input.workspacePath.startsWith(input.worktreesDir)) {
    await input.git.removeWorkspace(input.workspacePath).catch(() => undefined);
    return;
  }
  await fs.rm(input.workspacePath, { recursive: true, force: true }).catch(() => undefined);
};
