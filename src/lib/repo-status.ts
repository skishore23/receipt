import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertGitRepo } from "./git-repo";

const execFileAsync = promisify(execFile);

export type RepoStatusSnapshot = {
  readonly baseHash: string;
  readonly branch: string;
  readonly dirty: boolean;
  readonly porcelain: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly changedCount: number;
};

const parseChangedFiles = (porcelain: string): ReadonlyArray<string> =>
  porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith("?? ")) return line.slice(3).trim();
      if (line.length >= 4) return line.slice(3).trim();
      return line.trim();
    })
    .filter(Boolean);

const git = async (repoRoot: string, args: ReadonlyArray<string>): Promise<string> => {
  const cwd = await assertGitRepo(repoRoot);
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
};

export const readRepoStatus = async (repoRoot: string): Promise<RepoStatusSnapshot> => {
  const [baseHash, branch, porcelain] = await Promise.all([
    git(repoRoot, ["rev-parse", "HEAD"]),
    git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD"),
    git(repoRoot, ["status", "--porcelain"]),
  ]);
  const changedFiles = parseChangedFiles(porcelain);
  return {
    baseHash,
    branch,
    dirty: changedFiles.length > 0,
    porcelain,
    changedFiles,
    changedCount: changedFiles.length,
  };
};
