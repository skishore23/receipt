// ============================================================================
// Receipt tools - reusable helpers for JSONL runs
// ============================================================================

import fs from "node:fs";
import path from "node:path";

export type ReceiptFileInfo = {
  readonly name: string;
  readonly size: number;
  readonly mtime: number;
};

export type ReceiptRecord = {
  readonly raw: string;
  readonly data?: Record<string, unknown>;
};

const hasPathSeparator = (name: string): boolean =>
  name.includes("/") || name.includes("\\");

export const assertReceiptFileName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("receipt file name required");
  if (path.isAbsolute(trimmed)) throw new Error("absolute receipt file paths are not allowed");
  if (trimmed.includes("..")) throw new Error("parent traversal is not allowed for receipt file names");
  if (hasPathSeparator(trimmed)) throw new Error("receipt file name must not include path separators");
  if (!trimmed.endsWith(".jsonl")) throw new Error("receipt file must end with .jsonl");
  return trimmed;
};

const resolveReceiptFilePath = (dir: string, name: string): string => {
  const safeName = assertReceiptFileName(name);
  const baseDir = path.resolve(dir);
  const file = path.resolve(baseDir, safeName);
  if (!file.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error("receipt file path escapes data directory");
  }
  return file;
};

export const listReceiptFiles = async (dir: string): Promise<ReceiptFileInfo[]> => {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => e.name);
  const stats = await Promise.all(
    files.map(async (name) => {
      const stat = await fs.promises.stat(path.join(dir, name));
      return { name, size: stat.size, mtime: stat.mtimeMs } as ReceiptFileInfo;
    })
  );
  return stats.sort((a, b) => b.mtime - a.mtime);
};

export const readReceiptFile = async (dir: string, name: string): Promise<ReceiptRecord[]> => {
  const file = resolveReceiptFilePath(dir, name);
  const raw = await fs.promises.readFile(file, "utf-8");
  return raw.split("\n").filter(Boolean).map((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { raw: line, data: parsed as Record<string, unknown> };
      }
      return { raw: line };
    } catch {
      return { raw: line };
    }
  });
};

export const sliceReceiptRecords = (
  records: ReadonlyArray<ReceiptRecord>,
  order: "asc" | "desc",
  limit: number
): ReceiptRecord[] => {
  if (limit <= 0) return [];
  if (order === "desc") return records.slice(-limit).reverse();
  return records.slice(0, limit);
};

export const buildReceiptContext = (records: ReadonlyArray<ReceiptRecord>, maxChars: number): string => {
  let out = "";
  for (const r of records) {
    const line = r.raw.trim();
    if (!line) continue;
    if (out.length + line.length + 1 > maxChars) break;
    out += line + "\n";
  }
  return out.trim();
};

export const buildReceiptTimeline = (
  records: ReadonlyArray<ReceiptRecord>,
  depth: number
): Array<{ label: string; count: number }> => {
  const level = Math.max(1, Math.min(depth, 3));
  const buckets: Array<{ label: string; count: number }> = [];
  const index = new Map<string, number>();
  for (const r of records) {
    const rawBody = r.data?.body;
    const body = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody))
      ? rawBody as Record<string, unknown>
      : undefined;
    const type = typeof body?.type === "string" ? body.type : "receipt";
    const prefix = type.split(".")[0] || type;
    const agentId = typeof body?.agentId === "string"
      ? body.agentId
      : typeof body?.agent === "string"
        ? body.agent
        : typeof body?.role === "string"
          ? body.role
          : "";
    let label = "run";
    if (level === 2) label = prefix;
    if (level >= 3) label = agentId ? `${prefix}/${agentId}` : prefix;
    const idx = index.get(label);
    if (idx === undefined) {
      index.set(label, buckets.length);
      buckets.push({ label, count: 1 });
    } else {
      buckets[idx] = { ...buckets[idx], count: buckets[idx].count + 1 };
    }
  }
  return buckets;
};
