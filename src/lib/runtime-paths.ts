import fs from "node:fs";
import path from "node:path";
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



const BUN_EXECUTABLE_RE = /^bun(?:\.exe)?$/i;

export const resolveBunRuntime = (): string => {
  const execPath = process.execPath?.trim();
  if (execPath && BUN_EXECUTABLE_RE.test(path.basename(execPath))) {
    return execPath;
  }
  const candidates = [
    process.env.BUN_BIN?.trim(),
    process.env.RECEIPT_BUN_BIN?.trim(),
    process.env.BUN_INSTALL?.trim() ? path.join(process.env.BUN_INSTALL.trim(), "bin", "bun") : undefined,
    process.env.HOME?.trim() ? path.join(process.env.HOME.trim(), ".bun", "bin", "bun") : undefined,
  ];
  const resolved = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (resolved) return resolved;
  const discovered = bunWhich("bun");
  return discovered || "bun";
};

export const bunWhich = (command: string): string | undefined => {
  if (typeof Bun === "undefined" || typeof Bun.which !== "function") return undefined;
  const resolved = Bun.which(command.trim());
  return resolved?.trim() || undefined;
};

export const resolveCliInvocation = (importMetaUrl: string): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly entryPath: string;
} => {
  const entryPath = packagePath(importMetaUrl, "src", "cli.ts");
  return {
    command: resolveBunRuntime(),
    args: [entryPath],
    entryPath,
  };
};
