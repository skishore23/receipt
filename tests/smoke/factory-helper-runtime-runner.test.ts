import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("factory helper runner: attaches scriptsRun and evidenceRecords to helper output", async () => {
  const runnerPath = path.resolve("skills/factory-helper-runtime/runner.py");
  const domainRoot = path.resolve("skills/factory-helper-runtime/catalog/test-runtime");
  const helperRoot = path.join(domainRoot, "emit_evidence");

  await fs.rm(domainRoot, { recursive: true, force: true });
  await fs.mkdir(helperRoot, { recursive: true });
  await fs.writeFile(path.join(helperRoot, "manifest.json"), JSON.stringify({
    id: "emit_evidence",
    version: "1.0.0",
    provider: "test",
    tags: ["test"],
    description: "Emit deterministic helper output for smoke tests.",
    entrypoint: "run.py",
  }, null, 2), "utf-8");
  await fs.writeFile(path.join(helperRoot, "run.py"), [
    "#!/usr/bin/env python3",
    "import json",
    "print(json.dumps({",
    '  "status": "ok",',
    '  "summary": "Collected deterministic helper evidence.",',
    '  "artifacts": [],',
    '  "data": {"instances": [1, 2], "profile": "test-profile", "region": "us-test-1"},',
    '  "capturedAt": "2026-04-11T00:00:00Z",',
    '  "errors": []',
    "}))",
    "",
  ].join("\n"), "utf-8");

  try {
    const { stdout } = await execFileAsync("python3", [
      runnerPath,
      "run",
      "--domain",
      "test-runtime",
      "--provider",
      "test",
      "--json",
      "emit_evidence",
      "--",
      "--flag",
      "demo",
    ], {
      cwd: path.resolve("."),
      encoding: "utf-8",
      env: {
        ...process.env,
        RECEIPT_FACTORY_OBJECTIVE_ID: "objective_demo",
        RECEIPT_FACTORY_TASK_ID: "task_01",
      },
    });

    const parsed = JSON.parse(stdout) as {
      readonly scriptsRun?: ReadonlyArray<{ readonly command: string; readonly status?: string }>;
      readonly evidenceRecords?: ReadonlyArray<{
        readonly objective_id: string;
        readonly task_id: string;
        readonly tool_name: string;
        readonly inputs: Record<string, unknown>;
        readonly summary_metrics: Record<string, unknown>;
      }>;
    };

    expect(parsed.scriptsRun?.[0]?.command).toContain("emit_evidence");
    expect(parsed.scriptsRun?.[0]?.status).toBe("ok");
    expect(parsed.evidenceRecords?.[0]?.objective_id).toBe("objective_demo");
    expect(parsed.evidenceRecords?.[0]?.task_id).toBe("task_01");
    expect(parsed.evidenceRecords?.[0]?.tool_name).toBe("factory_helper_runner");
    expect(parsed.evidenceRecords?.[0]?.inputs.helper_id).toBe("emit_evidence");
    expect(parsed.evidenceRecords?.[0]?.summary_metrics.instances).toBe(2);
  } finally {
    await fs.rm(domainRoot, { recursive: true, force: true });
  }
});

test("factory helper runner: fails without runtime identity", async () => {
  const runnerPath = path.resolve("skills/factory-helper-runtime/runner.py");
  const domainRoot = path.resolve("skills/factory-helper-runtime/catalog/test-runtime");
  const helperRoot = path.join(domainRoot, "emit_evidence");

  await fs.rm(domainRoot, { recursive: true, force: true });
  await fs.mkdir(helperRoot, { recursive: true });
  await fs.writeFile(path.join(helperRoot, "manifest.json"), JSON.stringify({
    id: "emit_evidence",
    version: "1.0.0",
    provider: "test",
    tags: ["test"],
    description: "Emit deterministic helper output for smoke tests.",
    entrypoint: "run.py",
  }, null, 2), "utf-8");
  await fs.writeFile(path.join(helperRoot, "run.py"), [
    "#!/usr/bin/env python3",
    "import json",
    "print(json.dumps({",
    '  "status": "ok",',
    '  "summary": "Collected deterministic helper evidence.",',
    '  "artifacts": [],',
    '  "data": {},',
    '  "capturedAt": "2026-04-11T00:00:00Z",',
    '  "errors": []',
    "}))",
    "",
  ].join("\n"), "utf-8");

  try {
    await expect(execFileAsync("python3", [
      runnerPath,
      "run",
      "--domain",
      "test-runtime",
      "--provider",
      "test",
      "--json",
      "emit_evidence",
    ], {
      cwd: path.resolve("."),
      encoding: "utf-8",
      env: { ...process.env },
    })).rejects.toMatchObject({
      stdout: expect.stringContaining("missing required runtime identity"),
    });
  } finally {
    await fs.rm(domainRoot, { recursive: true, force: true });
  }
});
