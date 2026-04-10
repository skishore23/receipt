import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { QueueJob } from "../../src/adapters/sqlite-queue";
import { findActiveObjectiveJobId } from "../../src/factory-cli/experiment";
import { resolveBunRuntime } from "../../src/lib/runtime-paths";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(ROOT, "src", "cli.ts");
const BUN = resolveBunRuntime();

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
};

const createSourceRepo = async (): Promise<string> => {
  const repoDir = await createTempDir("receipt-factory-experiment-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Factory Experiment Test"]);
  await git(repoDir, ["config", "user.email", "factory-experiment@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# factory experiment source\n", "utf-8");
  await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({
    name: "factory-experiment-source",
    private: true,
    scripts: {
      build: "bun -e \"process.exit(0)\"",
    },
  }, null, 2), "utf-8");
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  return repoDir;
};

test("factory experiment: long-run bundle captures live intervention evidence", async () => {
  const sourceRepo = await createSourceRepo();
  const outputDir = await createTempDir("receipt-factory-experiment-output");

  const run = await execFileAsync(BUN, [
    CLI,
    "factory",
    "experiment",
    "long-run",
    "--json",
    "--repo-root",
    sourceRepo,
    "--output-dir",
    outputDir,
    "--keep-workdir",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });

  const report = JSON.parse(run.stdout) as {
    readonly evidenceDir: string;
    readonly transcriptPath: string;
    readonly investigateJsonPath: string;
    readonly investigateTextPath: string;
    readonly auditJsonPath: string;
    readonly auditTextPath: string;
    readonly summaryPath: string;
    readonly artifactsPath: string;
    readonly timelinePath: string;
    readonly changedFiles: ReadonlyArray<string>;
    readonly interventions: {
      readonly recommendationCount: number;
      readonly synthesisDispatchCount: number;
      readonly recommendationApplied: boolean;
      readonly controllerCorrectionWorked: boolean;
    };
    readonly assessment: {
      readonly verdict: string;
      readonly easyRouteRisk: string;
      readonly followUpValidation: string;
      readonly recommendationApplied: boolean;
      readonly controllerCorrectionWorked: boolean;
    };
  };

  expect(report.evidenceDir).toBe(outputDir);
  expect(report.changedFiles).toEqual(expect.arrayContaining(["README.md", "package.json"]));
  expect(report.interventions.recommendationCount).toBeGreaterThanOrEqual(0);
  expect(report.interventions.synthesisDispatchCount).toBeGreaterThanOrEqual(0);
  expect(report.assessment.followUpValidation).toBe("done");
  expect(report.assessment.easyRouteRisk).not.toBe("high");
  expect(report.assessment.verdict).toBe("strong");

  for (const targetPath of [
    report.transcriptPath,
    report.investigateJsonPath,
    report.investigateTextPath,
    report.auditJsonPath,
    report.auditTextPath,
    report.summaryPath,
    report.artifactsPath,
    report.timelinePath,
  ]) {
    await expect(fs.stat(targetPath)).resolves.toBeTruthy();
  }

  await expect(fs.readFile(report.transcriptPath, "utf-8")).resolves.toContain("factory steer");
  await expect(fs.readFile(report.transcriptPath, "utf-8")).resolves.toContain("factory follow-up");
  await expect(fs.readFile(report.investigateTextPath, "utf-8")).resolves.toContain("## Interventions");
  await expect(fs.readFile(report.auditTextPath, "utf-8")).resolves.toContain("controller_correction=");
}, 180_000);

test("factory experiment: active job discovery selects the active objective task job", () => {
  const activeJobId = findActiveObjectiveJobId([
    {
      id: "job_other",
      agentId: "codex",
      status: "running",
      payload: { kind: "factory.task.run", objectiveId: "objective_other", taskId: "task_99" },
    } as QueueJob,
    {
      id: "job_active",
      agentId: "codex",
      status: "leased",
      payload: { kind: "factory.task.run", objectiveId: "objective_demo", taskId: "task_01" },
    } as QueueJob,
  ], "objective_demo");

  expect(activeJobId).toBe("job_active");
});
