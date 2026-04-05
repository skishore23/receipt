import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const isGitRepo = async (cwd: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
};

const parentDir = (value: string): string => path.dirname(path.resolve(value));

export const assertGitRepo = async (workdir: string, expectedRemote?: string): Promise<string> => {
  let current = path.resolve(workdir);
  while (true) {
    if (await isGitRepo(current)) {
      if (current !== path.resolve(workdir)) {
        console.info(`[git-repo] re-rooted workdir`, { chosenWorkdir: current, from: path.resolve(workdir) });
      }
      return current;
    }
    const parent = parentDir(current);
    if (parent === current) break;
    current = parent;
  }
  const pwd = path.resolve(workdir);
  const ls = await fs.readdir(pwd, { withFileTypes: true }).then((entries) =>
    entries.map((entry) => `${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "-"} ${entry.name}`).join("\n")
  ).catch(() => "");
  const remoteMessage = expectedRemote ? `Expected repo URL: ${expectedRemote}` : "Expected repo URL: <unknown>";
  throw new Error([
    `Unable to locate a git repository for ${pwd}.`,
    remoteMessage,
    `pwd: ${pwd}`,
    "ls -la:",
    ls || "<unavailable>",
  ].join("\n"));
};
