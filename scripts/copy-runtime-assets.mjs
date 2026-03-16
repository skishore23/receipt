import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, "prompts");
const DEST = path.join(ROOT, "dist", "prompts");

const shouldCopy = (file) =>
  file.endsWith(".json") || file.endsWith(".md");

const walk = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(dir, entry.name);
    const relativePath = path.relative(SOURCE, sourcePath);
    const destPath = path.join(DEST, relativePath);
    if (entry.isDirectory()) {
      await walk(sourcePath);
      continue;
    }
    if (!entry.isFile() || !shouldCopy(entry.name)) continue;
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(sourcePath, destPath);
  }
};

await walk(SOURCE);
