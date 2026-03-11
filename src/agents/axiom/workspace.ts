import fs from "node:fs/promises";
import path from "node:path";

export const resolveWorkspacePath = (root: string, rawPath: string): string => {
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, rawPath);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`path escapes workspace: ${rawPath}`);
  }
  return resolved;
};

export const exists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

export const readWorkspaceFile = async (workspaceRoot: string, rawPath: string): Promise<string> =>
  fs.readFile(resolveWorkspacePath(workspaceRoot, rawPath), "utf-8");

export const writeWorkspaceFile = async (workspaceRoot: string, rawPath: string, content: string): Promise<string> => {
  const abs = resolveWorkspacePath(workspaceRoot, rawPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  return abs;
};

export const writeScratchFile = async (
  workspaceRoot: string,
  scratchDir: string,
  content: string
): Promise<{ readonly abs: string; readonly rel: string }> => {
  const scratchRoot = resolveWorkspacePath(workspaceRoot, scratchDir);
  await fs.mkdir(scratchRoot, { recursive: true });
  const rel = path.join(scratchDir, `scratch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.lean`);
  const abs = resolveWorkspacePath(workspaceRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  return { abs, rel };
};
