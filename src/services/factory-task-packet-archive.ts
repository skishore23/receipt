import fs from "node:fs/promises";
import path from "node:path";

export type FactoryTaskPacketArchivePaths = {
  readonly root: string;
  readonly manifestPath: string;
  readonly contextSummaryPath: string;
  readonly contextPackPath: string;
  readonly promptPath: string;
  readonly memoryConfigPath: string;
  readonly memoryScriptPath: string;
};

export const factoryTaskPacketArchivePaths = (
  dataDir: string,
  jobId: string,
): FactoryTaskPacketArchivePaths => {
  const root = path.join(dataDir, "factory", "task-packets", jobId);
  return {
    root,
    manifestPath: path.join(root, "manifest.json"),
    contextSummaryPath: path.join(root, "context.md"),
    contextPackPath: path.join(root, "context-pack.json"),
    promptPath: path.join(root, "prompt.md"),
    memoryConfigPath: path.join(root, "memory-scopes.json"),
    memoryScriptPath: path.join(root, "memory.cjs"),
  };
};

const copyIfExists = async (
  sourcePath: string | undefined,
  targetPath: string,
): Promise<void> => {
  if (!sourcePath) return;
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return;
    throw error;
  }
};

export const archiveFactoryTaskPacketArtifacts = async (input: {
  readonly dataDir: string;
  readonly jobId: string;
  readonly manifestPath: string;
  readonly contextSummaryPath?: string;
  readonly contextPackPath: string;
  readonly memoryConfigPath: string;
  readonly memoryScriptPath: string;
}): Promise<FactoryTaskPacketArchivePaths> => {
  const archive = factoryTaskPacketArchivePaths(input.dataDir, input.jobId);
  await fs.mkdir(archive.root, { recursive: true });
  await Promise.all([
    copyIfExists(input.manifestPath, archive.manifestPath),
    copyIfExists(input.contextSummaryPath, archive.contextSummaryPath),
    copyIfExists(input.contextPackPath, archive.contextPackPath),
    copyIfExists(input.memoryConfigPath, archive.memoryConfigPath),
    copyIfExists(input.memoryScriptPath, archive.memoryScriptPath),
  ]);
  return archive;
};

export const archiveFactoryTaskPrompt = async (input: {
  readonly dataDir: string;
  readonly jobId: string;
  readonly prompt: string;
}): Promise<string> => {
  const archive = factoryTaskPacketArchivePaths(input.dataDir, input.jobId);
  await fs.mkdir(archive.root, { recursive: true });
  await fs.writeFile(archive.promptPath, input.prompt, "utf-8");
  return archive.promptPath;
};
