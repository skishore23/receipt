import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("factory helper runner: emits evidenceRecords for successful helper runs", async () => {
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
        readonly command: string;
        readonly argv: ReadonlyArray<string>;
        readonly cwd: string;
        readonly start_time: number;
        readonly end_time: number;
        readonly exit_code: number | null;
        readonly signal?: number | null;
        readonly stdout_path?: string | null;
        readonly stderr_path?: string | null;
        readonly record_id: string;
      }>;
    };

    expect(parsed.scriptsRun?.[0]?.command).toContain("emit_evidence");
    expect(parsed.scriptsRun?.[0]?.status).toBe("ok");
    expect(parsed.evidenceRecords?.length).toBeGreaterThanOrEqual(1);
    expect(parsed.evidenceRecords?.[0]).toMatchObject({
      command: expect.stringContaining("runner.py"),
      cwd: path.resolve("."),
      exit_code: 0,
      signal: null,
      stdout_path: null,
      stderr_path: null,
    });
    expect(parsed.evidenceRecords?.[0]?.argv?.[0]).toBe("python3");
    expect(parsed.evidenceRecords?.[0]?.record_id).toHaveLength(64);
  } finally {
    await fs.rm(domainRoot, { recursive: true, force: true });
  }
});

test("factory helper runner: emits evidenceRecords for failing helper runs", async () => {
  const runnerPath = path.resolve("skills/factory-helper-runtime/runner.py");
  const domainRoot = path.resolve("skills/factory-helper-runtime/catalog/test-runtime");
  const helperRoot = path.join(domainRoot, "fail_evidence");

  await fs.rm(domainRoot, { recursive: true, force: true });
  await fs.mkdir(helperRoot, { recursive: true });
  await fs.writeFile(path.join(helperRoot, "manifest.json"), JSON.stringify({
    id: "fail_evidence",
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
    '  "status": "error",',
    '  "summary": "Helper failed after spawn.",',
    '  "artifacts": [],',
    '  "data": {},',
    '  "capturedAt": "2026-04-11T00:00:00Z",',
    '  "errors": []',
    "}))",
    "raise SystemExit(2)",
    "",
  ].join("\n"), "utf-8");

  try {
    let stdout = "";
    try {
      await execFileAsync("python3", [
        runnerPath,
        "run",
        "--domain",
        "test-runtime",
        "--provider",
        "test",
        "--json",
        "fail_evidence",
      ], {
        cwd: path.resolve("."),
        encoding: "utf-8",
        env: {
          ...process.env,
          RECEIPT_FACTORY_OBJECTIVE_ID: "objective_demo",
          RECEIPT_FACTORY_TASK_ID: "task_01",
        },
      });
    } catch (error) {
      stdout = (error as { stdout?: string }).stdout ?? "";
    }

    const parsed = JSON.parse(stdout) as {
      readonly evidenceRecords?: ReadonlyArray<{
        readonly command: string;
        readonly argv: ReadonlyArray<string>;
        readonly cwd: string;
        readonly start_time: number;
        readonly end_time: number;
        readonly exit_code: number | null;
        readonly error?: string;
        readonly record_id: string;
      }>;
    };

    expect(parsed.evidenceRecords?.length).toBeGreaterThanOrEqual(1);
    expect(parsed.evidenceRecords?.[0]).toMatchObject({
      cwd: path.resolve("."),
      exit_code: 2,
    });
    expect(parsed.evidenceRecords?.[0]?.command).toContain("runner.py");
    expect(parsed.evidenceRecords?.[0]?.error).toBeUndefined();
    expect(parsed.evidenceRecords?.[0]?.record_id).toHaveLength(64);
  } finally {
    await fs.rm(domainRoot, { recursive: true, force: true });
  }
});

test("factory helper runner: injects a factory evidence output dir for helpers that support it", async () => {
  const runnerPath = path.resolve("skills/factory-helper-runtime/runner.py");
  const domainRoot = path.resolve("skills/factory-helper-runtime/catalog/test-runtime");
  const helperRoot = path.join(domainRoot, "emit_artifact");
  const workspaceRoot = await fs.mkdtemp(path.join(process.cwd(), ".tmp-factory-helper-runner-"));

  await fs.rm(domainRoot, { recursive: true, force: true });
  await fs.mkdir(helperRoot, { recursive: true });
  await fs.writeFile(path.join(helperRoot, "manifest.json"), JSON.stringify({
    id: "emit_artifact",
    version: "1.0.0",
    provider: "test",
    tags: ["test"],
    description: "Emit a helper artifact when output-dir is supplied.",
    entrypoint: "run.py",
  }, null, 2), "utf-8");
  await fs.writeFile(path.join(helperRoot, "run.py"), [
    "#!/usr/bin/env python3",
    "import argparse",
    "import json",
    "from pathlib import Path",
    "parser = argparse.ArgumentParser()",
    "parser.add_argument('--output-dir')",
    "args = parser.parse_args()",
    "artifact = []",
    "if args.output_dir:",
    "    target = Path(args.output_dir)",
    "    target.mkdir(parents=True, exist_ok=True)",
    "    payload = target / 'helper-artifact.json'",
    "    payload.write_text(json.dumps({'ok': True}) + '\\n', encoding='utf-8')",
    "    artifact = [{'label': 'artifact', 'path': str(payload), 'summary': 'wrote artifact'}]",
    "print(json.dumps({",
    "  'status': 'ok',",
    "  'summary': 'Helper completed.',",
    "  'artifacts': artifact,",
    "  'data': {'wroteArtifact': bool(artifact)},",
    "  'capturedAt': '2026-04-11T00:00:00Z',",
    "  'errors': []",
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
      "emit_artifact",
    ], {
      cwd: workspaceRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        RECEIPT_FACTORY_OBJECTIVE_ID: "objective_demo",
        RECEIPT_FACTORY_TASK_ID: "task_01",
      },
    });
    const parsed = JSON.parse(stdout) as {
      readonly artifacts?: ReadonlyArray<{ readonly path?: string }>;
      readonly data?: { readonly wroteArtifact?: boolean };
    };
    expect(parsed.data?.wroteArtifact).toBe(true);
    const artifactPath = path.join(workspaceRoot, ".receipt", "factory", "evidence", "helper-artifact.json");
    await expect(fs.readFile(artifactPath, "utf-8")).resolves.toContain("\"ok\": true");
    expect(parsed.artifacts?.some((artifact) => artifact.path === artifactPath)).toBe(true);
  } finally {
    await fs.rm(domainRoot, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
