import fs from "node:fs";
import path from "node:path";

type ResolveAssetDirOptions = {
  readonly cwd?: string;
  readonly existsSync?: (path: string) => boolean;
};

const uniquePaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(paths.map((value) => path.resolve(value)))];

export const resolveAssetDir = (
  runtimeDir: string,
  options: ResolveAssetDirOptions = {},
): string => {
  const cwd = options.cwd ?? process.cwd();
  const existsSync = options.existsSync ?? fs.existsSync;
  const candidates = uniquePaths([
    path.resolve(runtimeDir, "..", "assets"),
    path.resolve(runtimeDir, "..", "..", "dist", "assets"),
    path.resolve(cwd, "dist", "assets"),
  ]);
  return candidates.find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  }) ?? candidates.at(-1)!;
};
