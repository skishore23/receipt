import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readTaskEvidenceContents } from "../../src/services/factory/task-packets";

const createTempWorkspace = async (): Promise<{ readonly workspacePath: string; readonly cleanup: () => Promise<void> }> => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-evidence-test-"));
  return {
    workspacePath,
    cleanup: async () => { await fs.rm(workspacePath, { recursive: true, force: true }); },
  };
};

const writeEvidenceFile = async (workspacePath: string, name: string, content: string): Promise<void> => {
  const evidenceDir = path.join(workspacePath, ".receipt", "factory", "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, name), content, "utf-8");
};

test("readTaskEvidenceContents returns empty when no evidence directory exists", async () => {
  const { workspacePath, cleanup } = await createTempWorkspace();
  try {
    const result = await readTaskEvidenceContents(workspacePath, []);
    expect(result).toEqual([]);
  } finally {
    await cleanup();
  }
});

test("readTaskEvidenceContents reads markdown files from evidence directory", async () => {
  const { workspacePath, cleanup } = await createTempWorkspace();
  try {
    const tableContent = "| Instance | Region |\n| i-abc | us-east-1 |\n| i-def | us-east-1 |";
    await writeEvidenceFile(workspacePath, "ec2_instances_table.md", tableContent);

    const result = await readTaskEvidenceContents(workspacePath, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe("ec2_instances_table.md");
    expect(result[0]!.content).toBe(tableContent);
    expect(result[0]!.truncated).toBe(false);
  } finally {
    await cleanup();
  }
});

test("readTaskEvidenceContents reads json files from evidence directory", async () => {
  const { workspacePath, cleanup } = await createTempWorkspace();
  try {
    const jsonContent = JSON.stringify({ instances: [{ id: "i-abc" }] });
    await writeEvidenceFile(workspacePath, "inventory.json", jsonContent);

    const result = await readTaskEvidenceContents(workspacePath, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe("inventory.json");
    expect(result[0]!.content).toBe(jsonContent);
  } finally {
    await cleanup();
  }
});

test("readTaskEvidenceContents ignores non-readable file types in evidence directory", async () => {
  const { workspacePath, cleanup } = await createTempWorkspace();
  try {
    await writeEvidenceFile(workspacePath, "binary.bin", "not readable");
    await writeEvidenceFile(workspacePath, "report.md", "readable report");

    const result = await readTaskEvidenceContents(workspacePath, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe("report.md");
  } finally {
    await cleanup();
  }
});

test("readTaskEvidenceContents combines evidence dir and artifact activity entries", async () => {
  const { workspacePath, cleanup } = await createTempWorkspace();
  try {
    await writeEvidenceFile(workspacePath, "dir_evidence.md", "from evidence dir");
    const artifactPath = path.join(workspacePath, ".receipt", "factory", "task_01.extra.md");
    await fs.writeFile(artifactPath, "from artifact activity", "utf-8");

    const result = await readTaskEvidenceContents(workspacePath, [
      { path: artifactPath, label: "task_01.extra.md", updatedAt: Date.now(), bytes: 21 },
    ]);
    expect(result).toHaveLength(2);
    const labels = result.map((entry) => entry.label);
    expect(labels).toContain("dir_evidence.md");
    expect(labels).toContain("task_01.extra.md");
  } finally {
    await cleanup();
  }
});

test("readTaskEvidenceContents truncates files exceeding per-file limit", async () => {
  const { workspacePath, cleanup } = await createTempWorkspace();
  try {
    const largeContent = "x".repeat(40_000);
    await writeEvidenceFile(workspacePath, "large.md", largeContent);

    const result = await readTaskEvidenceContents(workspacePath, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.truncated).toBe(true);
    expect(result[0]!.content.length).toBeLessThan(largeContent.length);
    expect(result[0]!.bytes).toBe(largeContent.length);
  } finally {
    await cleanup();
  }
});

test("readTaskEvidenceContents respects total byte budget across files", async () => {
  const { workspacePath, cleanup } = await createTempWorkspace();
  try {
    await writeEvidenceFile(workspacePath, "a.md", "a".repeat(30_000));
    await writeEvidenceFile(workspacePath, "b.md", "b".repeat(30_000));
    await writeEvidenceFile(workspacePath, "c.md", "c".repeat(30_000));

    const result = await readTaskEvidenceContents(workspacePath, []);
    const totalContentBytes = result.reduce((sum, entry) => sum + entry.content.length, 0);
    expect(totalContentBytes).toBeLessThanOrEqual(65_536);
  } finally {
    await cleanup();
  }
});
