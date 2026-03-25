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
  const canonicalRepoRoot = await fs.realpath(repoRoot);

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

  expect(remoteUrl).toBe(canonicalRepoRoot);

  await fs.rm(aliasRoot, { force: true });
});

test("hub git mirrors source publish remotes into factory worktrees", async () => {
  const repoRoot = await mkTmp("receipt-hub-git-publish-remote-source");
  const dataDir = await mkTmp("receipt-hub-git-publish-remote-data");
  const canonicalRepoRoot = await fs.realpath(repoRoot);

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
  await expect(git(workspace.path, ["remote", "get-url", "source"])).resolves.toBe(canonicalRepoRoot);
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
