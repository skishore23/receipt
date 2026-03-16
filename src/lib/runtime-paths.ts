import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PACKAGE_MARKER = "package.json";

const walkUpToPackageRoot = (start: string): string => {
  let current = path.resolve(start);
  while (true) {
    const marker = path.join(current, PACKAGE_MARKER);
    if (fs.existsSync(marker)) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate package root from ${start}`);
    }
    current = parent;
  }
};

export const moduleDir = (importMetaUrl: string): string =>
  path.dirname(fileURLToPath(importMetaUrl));

export const packageRoot = (importMetaUrl: string): string =>
  walkUpToPackageRoot(moduleDir(importMetaUrl));

export const packagePath = (importMetaUrl: string, ...segments: ReadonlyArray<string>): string =>
  path.join(packageRoot(importMetaUrl), ...segments);

export const siblingPath = (importMetaUrl: string, relativePath: string): string =>
  fileURLToPath(new URL(relativePath, importMetaUrl));

export const resolveDependencyPath = (importMetaUrl: string, specifier: string): string =>
  createRequire(importMetaUrl).resolve(specifier);

const BUN_EXECUTABLE_RE = /^bun(?:\.exe)?$/i;

export const resolveBunRuntime = (): string => {
  const execPath = process.execPath?.trim();
  if (execPath && BUN_EXECUTABLE_RE.test(path.basename(execPath))) {
    return execPath;
  }
  return process.env.BUN_BIN?.trim() || "bun";
};

export const bunWhich = (command: string): string | undefined => {
  if (typeof Bun === "undefined" || typeof Bun.which !== "function") return undefined;
  const resolved = Bun.which(command.trim());
  return resolved?.trim() || undefined;
};

export const resolveCliEntry = (importMetaUrl: string): {
  readonly entryPath: string;
} => {
  const root = packageRoot(importMetaUrl);
  const compiledCli = path.join(root, "dist", "cli.js");
  if (fs.existsSync(compiledCli)) {
    return { entryPath: compiledCli };
  }
  return { entryPath: path.join(root, "src", "cli.ts") };
};

export const resolveCliInvocation = (importMetaUrl: string): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly entryPath: string;
} => {
  const { entryPath } = resolveCliEntry(importMetaUrl);
  return {
    command: resolveBunRuntime(),
    args: [entryPath],
    entryPath,
  };
};
