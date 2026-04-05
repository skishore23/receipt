import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { HubGit } from "../../src/adapters/hub-git";

const execFileAsync = promisify(execFile);

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
};

test("hub git canonicalizes local source paths and serializes concurrent remote setup", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-source");
  const dataDir = await mkTmp("receipt-hub-git-data");
  const aliasRoot = `${repoRoot}-alias`;
  const configuredRepoRoot = path.resolve(repoRoot);

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);
  await fs.symlink(repoRoot, aliasRoot);

  const bootstrap = new HubGit({ dataDir, repoRoot });
  await bootstrap.ensureReady();

  const viaAlias = new HubGit({ dataDir, repoRoot: aliasRoot });
  const viaReal = new HubGit({ dataDir, repoRoot });
  await Promise.all([viaAlias.ensureReady(), viaReal.ensureReady()]);

  const bareDir = path.join(dataDir, "hub", "repo.git");
  const remoteUrl = await execFileAsync("git", ["remote", "get-url", "source"], {
    cwd: bareDir,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  }).then((result) => result.stdout.trim());

  expect(remoteUrl).toBe(configuredRepoRoot);

  await fs.rm(aliasRoot, { force: true });
});

test("hub git mirrors source publish remotes into factory worktrees", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-publish-remote-source");
  const dataDir = await mkTmp("receipt-hub-git-publish-remote-data");
  const configuredRepoRoot = path.resolve(repoRoot);

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git publish remote test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);
  await git(repoRoot, ["remote", "add", "origin", "https://github.com/example/receipt.git"]);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  const workspace = await hub.ensureIntegrationWorkspace("objective-publish-remote", await git(repoRoot, ["rev-parse", "HEAD"]));
  const bareDir = path.join(dataDir, "hub", "repo.git");

  await expect(git(bareDir, ["remote", "get-url", "origin"])).resolves.toBe("https://github.com/example/receipt.git");
  await expect(git(workspace.path, ["remote", "get-url", "origin"])).resolves.toBe("https://github.com/example/receipt.git");
  await expect(git(workspace.path, ["remote", "get-url", "source"])).resolves.toBe(configuredRepoRoot);
});

test("hub git reaps a stale remote config lock during bootstrap", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-stale-lock-source");
  const dataDir = await mkTmp("receipt-hub-git-stale-lock-data");

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git stale lock test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);

  const bareDir = path.join(dataDir, "hub", "repo.git");
  await fs.mkdir(bareDir, { recursive: true });
  const lockPath = path.join(bareDir, ".receipt-remote.lock");
  await fs.writeFile(lockPath, "stale lock\n", "utf-8");
  const staleAt = new Date(Date.now() - 120_000);
  await fs.utimes(lockPath, staleAt, staleAt);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  await expect(fs.access(lockPath)).rejects.toThrow();
  await expect(git(bareDir, ["remote", "get-url", "source"])).resolves.toBe(path.resolve(repoRoot));
});

test("hub git rewrites an inaccessible source remote to the current repo root", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-source-remote-source");
  const dataDir = await mkTmp("receipt-hub-git-source-remote-data");
  const bareDir = path.join(dataDir, "hub", "repo.git");

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git source remote test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);

  await git(dataDir, ["init", "--bare", bareDir]);
  await git(bareDir, ["remote", "add", "source", path.join(repoRoot, "..", "missing-source-repo")]);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  await expect(git(bareDir, ["remote", "get-url", "source"])).resolves.toBe(repoRoot);
});

test("hub git revalidates the source remote on sync for long-lived instances", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-sync-remote-source");
  const dataDir = await mkTmp("receipt-hub-git-sync-remote-data");
  const bareDir = path.join(dataDir, "hub", "repo.git");

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git sync remote test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  await git(bareDir, ["remote", "set-url", "source", path.join(repoRoot, "..", "missing-source-repo")]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git sync remote test\nsecond line\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "update readme"]);
  const sourceHead = await git(repoRoot, ["rev-parse", "HEAD"]);

  await hub.syncFromSource();

  await expect(git(bareDir, ["remote", "get-url", "source"])).resolves.toBe(repoRoot);
  await expect(hub.sourceHead()).resolves.toBe(sourceHead);
});

test("hub git sync prefers the configured source remote when repoRoot becomes stale", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-sync-prefers-remote-source");
  const dataDir = await mkTmp("receipt-hub-git-sync-prefers-remote-data");
  const bareDir = path.join(dataDir, "hub", "repo.git");

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git preferred remote test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  const mutableHub = hub as unknown as {
    repoRoot: string;
    ensureRemote: () => Promise<void>;
  };
  mutableHub.repoRoot = path.join(path.dirname(repoRoot), "missing-source-repo");
  mutableHub.ensureRemote = async () => undefined;

  await expect(hub.syncFromSource()).resolves.toBeUndefined();
  await expect(git(bareDir, ["rev-parse", "--verify", "refs/remotes/source/main"])).resolves.toMatch(/[0-9a-f]{40}/);
});

test("hub git sync falls back to repoRoot when the configured source remote is stale", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-sync-fallback-source");
  const dataDir = await mkTmp("receipt-hub-git-sync-fallback-data");
  const bareDir = path.join(dataDir, "hub", "repo.git");

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git fallback test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  await git(bareDir, ["remote", "set-url", "source", path.join(path.dirname(repoRoot), "missing-source-remote")]);
  const mutableHub = hub as unknown as {
    ensureRemote: () => Promise<void>;
  };
  mutableHub.ensureRemote = async () => undefined;

  await expect(hub.syncFromSource()).resolves.toBeUndefined();
  await expect(git(bareDir, ["rev-parse", "--verify", "refs/remotes/source/main"])).resolves.toMatch(/[0-9a-f]{40}/);
});

test("hub git promotes disjoint worktree commits into a dirty source repo", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-dirty-source");
  const dataDir = await mkTmp("receipt-hub-git-dirty-data");

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  const workspace = await hub.createWorkspace({
    workspaceId: "disjoint-promote",
    agentId: "codex",
  });
  await fs.writeFile(path.join(workspace.path, "PROFILE.txt"), "profile rename\n", "utf-8");
  const committed = await hub.commitWorkspace(workspace.path, "add profile file");
  const sourceHeadBefore = await git(repoRoot, ["rev-parse", "HEAD"]);
  const integration = await hub.ensureIntegrationWorkspace("objective-disjoint-promote", sourceHeadBefore);
  const merged = await hub.mergeCommitIntoWorkspace(integration.path, committed.hash, "integrate profile rename");

  await fs.writeFile(path.join(repoRoot, "LOCAL_NOTES.md"), "keep my draft\n", "utf-8");

  const promoted = await hub.promoteCommit(merged.hash);

  expect(promoted.previousHead).toBe(sourceHeadBefore);
  expect(promoted.mergedHead).not.toBe(sourceHeadBefore);
  await expect(fs.readFile(path.join(repoRoot, "PROFILE.txt"), "utf-8")).resolves.toBe("profile rename\n");
  await expect(fs.readFile(path.join(repoRoot, "LOCAL_NOTES.md"), "utf-8")).resolves.toBe("keep my draft\n");
  const status = await hub.sourceStatus();
  expect(status.dirty).toBe(true);
  expect(status.changedFiles).toContain("LOCAL_NOTES.md");
});

test("hub git repairs orphaned worktree directories whose admin metadata was pruned", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-orphan-source");
  const dataDir = await mkTmp("receipt-hub-git-orphan-data");

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git orphan test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  const workspace = await hub.createWorkspace({
    workspaceId: "orphaned-worktree",
    agentId: "codex",
  });
  const adminDir = path.join(dataDir, "hub", "repo.git", "worktrees", workspace.workspaceId);
  await fs.rm(adminDir, { recursive: true, force: true });

  await expect(hub.worktreeStatus(workspace.path)).resolves.toEqual({ exists: false, dirty: false });

  const restored = await hub.restoreWorkspace({
    workspaceId: workspace.workspaceId,
    branchName: workspace.branchName,
    workspacePath: workspace.path,
    baseHash: workspace.baseHash,
  });

  expect(restored.path).toBe(workspace.path);
  await expect(git(restored.path, ["rev-parse", "--abbrev-ref", "HEAD"])).resolves.toBe(workspace.branchName);
  await expect(hub.worktreeStatus(restored.path)).resolves.toMatchObject({
    exists: true,
    branch: workspace.branchName,
  });
});

test("hub git reuses an existing workspace branch without failing on repeat provisioning", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-reuse-source");
  const dataDir = await mkTmp("receipt-hub-git-reuse-data");

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git reuse test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  const first = await hub.createWorkspace({
    workspaceId: "repeat-provision",
    agentId: "codex",
  });
  const firstBranch = first.branchName;
  await hub.removeWorkspace(first.path);

  const second = await hub.createWorkspace({
    workspaceId: "repeat-provision",
    agentId: "codex",
  });

  expect(second.branchName).toBe(firstBranch);
  await expect(git(path.join(dataDir, "hub", "repo.git"), ["show-ref", "--verify", "--quiet", `refs/heads/${firstBranch}`])).resolves.toBe("");
});

test("hub git still blocks promotion when dirty source changes overlap promoted files", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-overlap-source");
  const dataDir = await mkTmp("receipt-hub-git-overlap-data");

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  const workspace = await hub.createWorkspace({
    workspaceId: "overlap-promote",
    agentId: "codex",
  });
  await fs.writeFile(path.join(workspace.path, "README.md"), "# promoted change\n", "utf-8");
  const committed = await hub.commitWorkspace(workspace.path, "update readme");

  await fs.writeFile(path.join(repoRoot, "README.md"), "# local draft\n", "utf-8");

  await expect(hub.promoteCommit(committed.hash)).rejects.toThrow(/uncommitted changes overlapping promoted files/i);
});

test("hub git commits overlapping dirty files when the source already matches the promoted content", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-overlap-matching-source");
  const dataDir = await mkTmp("receipt-hub-git-overlap-matching-data");

  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Hub Git Test"]);
  await git(repoRoot, ["config", "user.email", "hub-git@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# hub git test\n", "utf-8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  await git(repoRoot, ["branch", "-M", "main"]);

  const hub = new HubGit({ dataDir, repoRoot });
  await hub.ensureReady();

  const sourceHeadBefore = await git(repoRoot, ["rev-parse", "HEAD"]);
  const workspace = await hub.createWorkspace({
    workspaceId: "overlap-matching",
    agentId: "codex",
  });
  await fs.writeFile(path.join(workspace.path, "README.md"), "# profile rename\n", "utf-8");
  const committed = await hub.commitWorkspace(workspace.path, "update readme");
  const integration = await hub.ensureIntegrationWorkspace("objective-overlap-matching", sourceHeadBefore);
  const merged = await hub.mergeCommitIntoWorkspace(integration.path, committed.hash, "integrate readme update");

  await fs.writeFile(path.join(repoRoot, "README.md"), "# profile rename\n", "utf-8");

  const promoted = await hub.promoteCommit(merged.hash);

  expect(promoted.previousHead).toBe(sourceHeadBefore);
  expect(promoted.mergedHead).not.toBe(sourceHeadBefore);
  await expect(fs.readFile(path.join(repoRoot, "README.md"), "utf-8")).resolves.toBe("# profile rename\n");
});
