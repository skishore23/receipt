import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sqliteBranchStore, sqliteReceiptStore } from "../adapters/sqlite";
import { sqliteQueue, type SqliteQueue, type QueueJob } from "../adapters/sqlite-queue";
import { isSqliteLockError } from "../db/client";
import type { FactoryReceiptAuditReport } from "./audit";
import { readFactoryReceiptInvestigation, type FactoryReceiptInvestigation } from "./investigate";
import { resolveBunRuntime } from "../lib/runtime-paths";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../modules/job";
import { createRuntime } from "@receipt/core/runtime";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_PATH = path.join(ROOT, "src", "cli.ts");
const BUN = resolveBunRuntime();

type TranscriptEntry = {
  readonly label: string;
  readonly argv: ReadonlyArray<string>;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type LongRunExperimentOptions = {
  readonly sourceRepoRoot: string;
  readonly outputDir?: string;
  readonly codexBin?: string;
  readonly keepWorkdir?: boolean;
};

type ExecFileFailure = Error & {
  readonly code?: number | string | null;
  readonly stdout?: string;
  readonly stderr?: string;
};

export type FactoryLongRunExperimentReport = {
  readonly experimentId: string;
  readonly sourceRepoRoot: string;
  readonly workRepoRoot: string;
  readonly evidenceDir: string;
  readonly transcriptPath: string;
  readonly objectiveId: string;
  readonly activeJobId?: string;
  readonly status?: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly diffStat?: string;
  readonly interventions: {
    readonly recommendationCount: number;
    readonly synthesisDispatchCount: number;
    readonly recommendationApplied: boolean;
    readonly controllerCorrectionWorked: boolean;
  };
  readonly assessment: FactoryReceiptInvestigation["assessment"];
  readonly summaryPath: string;
  readonly artifactsPath: string;
  readonly timelinePath: string;
  readonly investigateJsonPath: string;
  readonly investigateTextPath: string;
  readonly auditJsonPath: string;
  readonly auditTextPath: string;
  readonly transcript: ReadonlyArray<TranscriptEntry>;
};

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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const RESUME_TIMEOUT_MS = 120_000;
const ACTIVE_JOB_WAIT_TIMEOUT_MS = RESUME_TIMEOUT_MS;
const ACTIVE_JOB_WAIT_POLL_MS = 400;
const LIVE_GUIDANCE_WINDOW_MS = 20_000;
const OBJECTIVE_SETTLE_TIMEOUT_MS = 15_000;
const OBJECTIVE_SETTLE_POLL_MS = 250;
const OBJECTIVE_SETTLE_QUIET_MS = 750;

const isActiveJobStatus = (status?: string): boolean =>
  status === "queued" || status === "leased" || status === "running";

const isTerminalObjectiveStatus = (status?: string): boolean =>
  status === "completed" || status === "blocked" || status === "failed" || status === "canceled";

const createExperimentQueue = (dataDir: string): SqliteQueue =>
  sqliteQueue({
    runtime: createRuntime<JobCmd, JobEvent, JobState>(
      sqliteReceiptStore<JobEvent>(dataDir),
      sqliteBranchStore(dataDir),
      decideJob,
      reduceJob,
      initialJob,
    ),
    stream: "jobs",
    watchDir: dataDir,
  });

const isObjectiveTaskJob = (job: QueueJob, objectiveId: string): boolean =>
  job.payload.kind === "factory.task.run" && job.payload.objectiveId === objectiveId;

export const findActiveObjectiveJobId = (
  jobs: ReadonlyArray<QueueJob>,
  objectiveId: string,
): string | undefined =>
  jobs.find((job) => isObjectiveTaskJob(job, objectiveId) && isActiveJobStatus(job.status))?.id;

const summarizeRecentObjectiveJobs = (
  jobs: ReadonlyArray<QueueJob>,
  objectiveId: string,
): string | undefined => {
  const recent = jobs
    .filter((job) => isObjectiveTaskJob(job, objectiveId))
    .slice(0, 4)
    .map((job) => `${job.id}:${job.status}`);
  return recent.length > 0 ? recent.join(", ") : undefined;
};

const transcriptLabelForAttempt = (label: string, attempt: number): string =>
  attempt > 1 ? `${label} (attempt ${attempt})` : label;

const isRetryableDbLockFailure = (error: unknown): error is ExecFileFailure => {
  if (!(error instanceof Error)) return false;
  const execError = error as ExecFileFailure;
  const haystacks = [
    error.message,
    typeof execError.stdout === "string" ? execError.stdout : "",
    typeof execError.stderr === "string" ? execError.stderr : "",
  ];
  return haystacks.some((value) => isSqliteLockError(value));
};

const runCli = async (
  transcript: TranscriptEntry[],
  label: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<TranscriptEntry> => {
  let attempt = 0;
  while (true) {
    attempt += 1;
    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(BUN, [CLI_PATH, ...args], {
        cwd: ROOT,
        env,
        encoding: "utf-8",
        maxBuffer: 32 * 1024 * 1024,
      });
      const entry: TranscriptEntry = {
        label: transcriptLabelForAttempt(label, attempt),
        argv: args,
        startedAt,
        endedAt: Date.now(),
        exitCode: 0,
        stdout,
        stderr,
      };
      transcript.push(entry);
      return entry;
    } catch (error) {
      const execError = error as ExecFileFailure;
      const entry: TranscriptEntry = {
        label: transcriptLabelForAttempt(label, attempt),
        argv: args,
        startedAt,
        endedAt: Date.now(),
        exitCode: typeof execError.code === "number" ? execError.code : null,
        stdout: typeof execError.stdout === "string" ? execError.stdout : "",
        stderr: typeof execError.stderr === "string" ? execError.stderr : "",
      };
      transcript.push(entry);
      if (attempt >= 5 || !isRetryableDbLockFailure(error)) throw error;
      await sleep(attempt * 250);
    }
  }
};

const spawnCli = (
  label: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): {
  readonly child: ReturnType<typeof spawn>;
  readonly entry: Promise<TranscriptEntry>;
} => {
  const startedAt = Date.now();
  const child = spawn(BUN, [CLI_PATH, ...args], {
    cwd: ROOT,
    env,
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const entry = new Promise<TranscriptEntry>((resolve) => {
    child.on("close", (exitCode) => {
      resolve({
        label,
        argv: args,
        startedAt,
        endedAt: Date.now(),
        exitCode,
        stdout,
        stderr,
      });
    });
  });
  return { child, entry };
};

const createLongRunCodexStub = async (root: string): Promise<string> => {
  const dir = path.join(root, "stub");
  await fs.mkdir(dir, { recursive: true });
  const scriptPath = path.join(dir, process.platform === "win32" ? "codex-long-run-stub.cmd" : "codex-long-run-stub");
  const jsPath = path.join(dir, "codex-long-run-stub.js");
  const body = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawnSync } = require('node:child_process');",
    "const args = process.argv.slice(2);",
    "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
    "const readAll = async () => { let data = ''; for await (const chunk of process.stdin) data += chunk; return data; };",
    "(async () => {",
    "  const workspace = args[args.indexOf('--cd') + 1];",
    "  const lastMessagePath = args[args.indexOf('--output-last-message') + 1];",
    "  if (!workspace || !lastMessagePath) throw new Error('stub missing workspace or last-message path');",
    "  const prompt = await readAll();",
    "  const taskIdMatch = prompt.match(/^Task ID:\\s*(\\S+)/m);",
    "  const taskId = taskIdMatch ? taskIdMatch[1].trim() : 'task_unknown';",
    "  const hasLiveGuidance = prompt.includes('## Live Operator Guidance');",
    "  if (!hasLiveGuidance) {",
    "    fs.writeFileSync(lastMessagePath, 'Waiting for live operator guidance.\\n', 'utf8');",
    "    process.stdout.write(JSON.stringify({ type: 'turn.started', taskId, summary: 'Waiting for live operator guidance.' }) + '\\n');",
    `    await sleep(${LIVE_GUIDANCE_WINDOW_MS});`,
    "    const fallback = {",
    "      outcome: 'blocked',",
    "      summary: 'Live operator guidance did not arrive before the attempt ended.',",
    "      handoff: 'Apply a live steer or follow-up note and restart this task.',",
    "      artifacts: [],",
    "      completion: { changed: [], proof: [], remaining: ['Need live guidance.'] },",
    "      nextAction: 'Send a live steer note to narrow the fix.',",
    "      report: {",
    "        conclusion: 'The task stayed broad until live operator guidance arrived.',",
    "        evidence: [{ title: 'Live guidance missing', summary: 'The prompt did not include the live operator guidance section.', detail: null }],",
    "        scriptsRun: [],",
    "        disagreements: [],",
    "        nextSteps: ['Send a live steer note.'],",
    "      },",
    "    };",
    "    const raw = JSON.stringify(fallback);",
    "    fs.writeFileSync(lastMessagePath, raw, 'utf8');",
    "    process.stdout.write(raw + '\\n');",
    "    return;",
    "  }",
    "  const readmePath = path.join(workspace, 'README.md');",
    "  const packageJsonPath = path.join(workspace, 'package.json');",
    "  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '# Long-run experiment\\n';",
    "  const note = 'Long-run experiment exercised live operator guidance.';",
    "  if (!readme.includes(note)) {",
    "    fs.writeFileSync(readmePath, `${readme.trimEnd()}\\n\\n${note}\\n`, 'utf8');",
    "  }",
    "  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));",
    "  const scripts = packageJson.scripts || {};",
    "  const buildCommand = typeof scripts.build === 'string' && scripts.build.trim() ? scripts.build.trim() : 'bun -e \"process.exit(0)\"';",
    "  packageJson.scripts = { ...scripts, 'receipt:long-run-evidence': buildCommand };",
    "  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\\n', 'utf8');",
    "  fs.writeFileSync(lastMessagePath, 'Applying live-guided repo fix.\\n', 'utf8');",
    "  const validation = spawnSync(process.execPath, ['run', 'receipt:long-run-evidence'], { cwd: workspace, encoding: 'utf8' });",
    "  const summary = validation.status === 0",
    "    ? 'Applied the README/package.json fix after live operator guidance and validated the repo script.'",
    "    : 'Applied the README/package.json fix after live operator guidance, but validation failed.';",
    "  const report = {",
    "    conclusion: summary,",
    "    evidence: [",
    "      { title: 'Live guidance', summary: 'The restarted prompt contained live operator guidance before the fix was applied.', detail: null },",
    "      { title: 'Changed files', summary: 'Updated README.md and package.json in the sandbox repo.', detail: null },",
    "    ],",
    "    scriptsRun: [{",
    "      command: 'bun run receipt:long-run-evidence',",
    "      summary: validation.status === 0 ? 'Validation passed by delegating to bun run build.' : ((validation.stderr || validation.stdout || 'Validation failed.').trim().slice(0, 240) || 'Validation failed.'),",
    "      status: validation.status === 0 ? 'ok' : 'error',",
    "    }],",
    "    disagreements: [],",
    "    nextSteps: [],",
    "  };",
    "  const result = {",
    "    outcome: validation.status === 0 ? 'approved' : 'partial',",
    "    summary,",
    "    handoff: 'Live operator guidance narrowed the change to README.md and package.json, then the task ran bun run receipt:long-run-evidence.',",
    "    artifacts: [],",
    "    completion: {",
    "      changed: ['README.md', 'package.json'],",
    "      proof: validation.status === 0",
    "        ? ['Added receipt:long-run-evidence script.', 'Appended the README experiment note.', 'Ran bun run receipt:long-run-evidence successfully as a wrapper around bun run build.']",
    "        : ['Added receipt:long-run-evidence script.', 'Appended the README experiment note.'],",
    "      remaining: validation.status === 0 ? [] : ['Review validation output.'],",
    "    },",
    "    nextAction: validation.status === 0 ? null : 'Inspect the validation output.',",
    "    report,",
    "  };",
    "  const raw = JSON.stringify(result);",
    "  fs.writeFileSync(lastMessagePath, raw, 'utf8');",
    "  process.stdout.write(raw + '\\n');",
    "})().catch((err) => {",
    "  console.error(err instanceof Error ? err.message : String(err));",
    "  process.exit(1);",
    "});",
  ].join("\n");
  await fs.writeFile(jsPath, body, "utf-8");
  if (process.platform === "win32") {
    await fs.writeFile(
      scriptPath,
      `@echo off\r\n"${BUN.replace(/\//g, "\\")}" "%~dp0\\codex-long-run-stub.js" %*\r\n`,
      "utf-8",
    );
  } else {
    await fs.writeFile(scriptPath, `#!${BUN}\n${body}\n`, "utf-8");
    await fs.chmod(scriptPath, 0o755);
  }
  return scriptPath;
};

const waitForActiveJobId = async (
  queue: SqliteQueue,
  objectiveId: string,
): Promise<string> => {
  const startedAt = Date.now();
  let recentSummary: string | undefined;
  while (Date.now() - startedAt < ACTIVE_JOB_WAIT_TIMEOUT_MS) {
    const jobs = await queue.listJobs({ limit: 100 });
    recentSummary = summarizeRecentObjectiveJobs(jobs, objectiveId);
    const activeJobId = findActiveObjectiveJobId(jobs, objectiveId);
    if (activeJobId) return activeJobId;
    await sleep(ACTIVE_JOB_WAIT_POLL_MS);
  }
  throw new Error(`Timed out waiting for an active Factory job for ${objectiveId}${recentSummary ? ` (${recentSummary})` : ""}`);
};

const waitForObjectiveSnapshotTs = async (
  dataDir: string,
  repoRoot: string,
  objectiveId: string,
): Promise<number> => {
  const startedAt = Date.now();
  let recentStatus: string | undefined;
  let stableUpdatedAt: number | undefined;
  let stableSince: number | undefined;
  while (Date.now() - startedAt < OBJECTIVE_SETTLE_TIMEOUT_MS) {
    const report = await readFactoryReceiptInvestigation(dataDir, repoRoot, objectiveId);
    recentStatus = report.summary.status;
    if (isTerminalObjectiveStatus(recentStatus) && typeof report.window.updatedAt === "number") {
      if (stableUpdatedAt !== report.window.updatedAt) {
        stableUpdatedAt = report.window.updatedAt;
        stableSince = Date.now();
      } else if (stableSince !== undefined && Date.now() - stableSince >= OBJECTIVE_SETTLE_QUIET_MS) {
        return report.window.updatedAt;
      }
    } else {
      stableUpdatedAt = undefined;
      stableSince = undefined;
    }
    await sleep(OBJECTIVE_SETTLE_POLL_MS);
  }
  throw new Error(
    `Timed out waiting for ${objectiveId} to reach a terminal snapshot${recentStatus ? ` (${recentStatus})` : ""}`,
  );
};

const renderExperimentSummaryText = (report: FactoryLongRunExperimentReport): string => {
  const lines = [
    "# Factory Long-Run Experiment",
    "",
    `Experiment: ${report.experimentId}`,
    `Source repo: ${report.sourceRepoRoot}`,
    `Work repo: ${report.workRepoRoot}`,
    `Objective: ${report.objectiveId}`,
    report.activeJobId ? `Active job: ${report.activeJobId}` : undefined,
    report.status ? `Status: ${report.status}` : undefined,
    `Changed files: ${report.changedFiles.join(", ") || "none"}`,
    report.diffStat ? `Diff stat: ${report.diffStat}` : undefined,
    "",
    "## Assessment",
    `Verdict: ${report.assessment.verdict}`,
    `Easy route risk: ${report.assessment.easyRouteRisk}`,
    `Efficiency: ${report.assessment.efficiency}`,
    `Control churn: ${report.assessment.controlChurn}`,
    `Recommendation applied: ${report.assessment.recommendationApplied ? "yes" : "no"}`,
    `Controller correction worked: ${report.assessment.controllerCorrectionWorked ? "yes" : "no"}`,
    "",
    "## Bundle",
    `Summary: ${report.summaryPath}`,
    `Transcript: ${report.transcriptPath}`,
    `Artifacts: ${report.artifactsPath}`,
    `Timeline: ${report.timelinePath}`,
    `Investigate JSON: ${report.investigateJsonPath}`,
    `Investigate Text: ${report.investigateTextPath}`,
    `Audit JSON: ${report.auditJsonPath}`,
    `Audit Text: ${report.auditTextPath}`,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
};

export const runFactoryLongRunExperiment = async (
  opts: LongRunExperimentOptions,
): Promise<FactoryLongRunExperimentReport> => {
  const experimentId = `long-run-${Date.now().toString(36)}`;
  const evidenceDir = path.resolve(opts.outputDir ?? await createTempDir(`receipt-${experimentId}`));
  const sandboxRoot = path.join(evidenceDir, "sandbox");
  const transcript: TranscriptEntry[] = [];
  await fs.mkdir(evidenceDir, { recursive: true });
  await git(ROOT, ["clone", "--quiet", "--no-hardlinks", opts.sourceRepoRoot, sandboxRoot]);
  await git(sandboxRoot, ["checkout", "-b", `codex/${experimentId}`]);
  const stubPath = opts.codexBin ?? await createLongRunCodexStub(evidenceDir);
  const dataDir = path.join(sandboxRoot, ".receipt", "data");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RECEIPT_CLI_NO_FORCE_EXIT: "1",
    RECEIPT_EXPERIMENT_REPO_ROOT: sandboxRoot,
    DATA_DIR: dataDir,
    RECEIPT_DATA_DIR: dataDir,
  };

  await runCli(transcript, "factory init", [
    "factory",
    "init",
    "--yes",
    "--force",
    "--json",
    "--repo-root",
    sandboxRoot,
    "--data-dir",
    dataDir,
    "--codex-bin",
    stubPath,
  ], env);

  const create = await runCli(transcript, "factory create", [
    "factory",
    "create",
    "--json",
    "--repo-root",
    sandboxRoot,
    "--title",
    "Long-run intervention evidence",
    "--objective-mode",
    "investigation",
    "--check",
    "bun run build",
    "--prompt",
    "Implement a minimal safe repo fix in this sandbox. Update README.md with a short long-run experiment note, add a package.json script named receipt:long-run-evidence that runs the existing build command, keep the change scoped to those files, and capture proof of validation.",
  ], env);
  const created = JSON.parse(create.stdout) as {
    readonly objectiveId: string;
    readonly objective?: { readonly objectiveId?: string };
  };
  const objectiveId = created.objectiveId || created.objective?.objectiveId;
  if (!objectiveId) throw new Error("factory create did not return an objectiveId");
  const queue = createExperimentQueue(dataDir);

  const resume = spawnCli("factory resume", [
    "factory",
    "resume",
    objectiveId,
    "--json",
    "--repo-root",
    sandboxRoot,
  ], env);

  const activeJobId = await waitForActiveJobId(queue, objectiveId);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await runCli(transcript, "factory steer", [
    "factory",
    "steer",
    activeJobId,
    "--json",
    "--repo-root",
    sandboxRoot,
    "--message",
    "Do not take the easy route. Apply the real README.md and package.json fix, then capture proof.",
  ], env);
  await runCli(transcript, "factory follow-up", [
    "factory",
    "follow-up",
    activeJobId,
    "--json",
    "--repo-root",
    sandboxRoot,
    "--message",
    "After the fix, run the repo validation command and include the result in the proof.",
  ], env);

  const resumeEntry = await Promise.race([
    resume.entry,
    new Promise<TranscriptEntry>((_, reject) => {
      const timer = setTimeout(() => {
        resume.child.kill("SIGTERM");
        reject(new Error(`factory resume timed out after ${RESUME_TIMEOUT_MS}ms`));
      }, RESUME_TIMEOUT_MS);
      resume.child.on("close", () => clearTimeout(timer));
    }),
  ]);
  transcript.push(resumeEntry);
  if (resumeEntry.exitCode !== 0 && resumeEntry.exitCode !== 2) {
    throw new Error(`factory resume exited with ${resumeEntry.exitCode}`);
  }
  const settledAsOfTs = await waitForObjectiveSnapshotTs(dataDir, sandboxRoot, objectiveId);

  const investigateJson = await runCli(transcript, "factory investigate json", [
    "factory",
    "investigate",
    objectiveId,
    "--json",
    "--as-of-ts",
    String(settledAsOfTs),
    "--repo-root",
    sandboxRoot,
  ], env);
  const investigateText = await runCli(transcript, "factory investigate text", [
    "factory",
    "investigate",
    objectiveId,
    "--as-of-ts",
    String(settledAsOfTs),
    "--repo-root",
    sandboxRoot,
    "--timeline-limit",
    "20",
    "--context-chars",
    "1600",
  ], env);
  const auditJson = await runCli(transcript, "factory audit json", [
    "factory",
    "audit",
    "--limit",
    "1",
    "--json",
    "--repo-root",
    sandboxRoot,
  ], env);
  const auditText = await runCli(transcript, "factory audit text", [
    "factory",
    "audit",
    "--limit",
    "1",
    "--repo-root",
    sandboxRoot,
  ], env);
  const finalInspect = await runCli(transcript, "factory inspect overview", [
    "factory",
    "inspect",
    objectiveId,
    "--json",
    "--panel",
    "overview",
    "--repo-root",
    sandboxRoot,
  ], env);

  const investigation = JSON.parse(investigateJson.stdout) as FactoryReceiptInvestigation;
  const audit = JSON.parse(auditJson.stdout) as FactoryReceiptAuditReport;
  const auditObjective = audit.objectives.find((item) => item.objectiveId === objectiveId);
  const inspectPayload = JSON.parse(finalInspect.stdout) as {
    readonly data?: {
      readonly status?: string;
    };
  };
  const resultRecord = investigation.outputs.result && typeof investigation.outputs.result === "object" && !Array.isArray(investigation.outputs.result)
    ? investigation.outputs.result as Record<string, unknown>
    : undefined;
  const completion = resultRecord?.completion && typeof resultRecord.completion === "object" && !Array.isArray(resultRecord.completion)
    ? resultRecord.completion as Record<string, unknown>
    : undefined;
  const changedFiles = Array.isArray(completion?.changed)
    ? completion.changed.filter((item): item is string => typeof item === "string")
    : [];
  const diffStat = changedFiles.length > 0 ? changedFiles.join(", ") : undefined;

  const summaryPath = path.join(evidenceDir, "summary.json");
  const summaryTextPath = path.join(evidenceDir, "summary.md");
  const transcriptPath = path.join(evidenceDir, "transcript.log");
  const artifactsPath = path.join(evidenceDir, "artifacts.json");
  const timelinePath = path.join(evidenceDir, "timeline.json");
  const investigateJsonPath = path.join(evidenceDir, "investigate.json");
  const investigateTextPath = path.join(evidenceDir, "investigate.md");
  const auditJsonPath = path.join(evidenceDir, "audit.json");
  const auditTextPath = path.join(evidenceDir, "audit.md");
  const effectiveInterventions = auditObjective
    ? {
        recommendationCount: auditObjective.interventions,
        synthesisDispatchCount: auditObjective.synthesisDispatchCount,
        recommendationApplied: auditObjective.interventions > 0 || investigation.interventions.recommendationApplied,
        controllerCorrectionWorked: auditObjective.controllerCorrectionWorked,
      }
    : {
        recommendationCount: investigation.interventions.recommendationCount,
        synthesisDispatchCount: investigation.interventions.synthesisDispatchCount,
        recommendationApplied: investigation.interventions.recommendationApplied,
        controllerCorrectionWorked: investigation.interventions.controllerCorrectionWorked,
      };
  const effectiveAssessment = auditObjective
    ? {
        ...investigation.assessment,
        verdict: auditObjective.verdict,
        easyRouteRisk: auditObjective.easyRouteRisk,
        efficiency: auditObjective.efficiency,
        controlChurn: auditObjective.controlChurn,
        controllerCorrectionWorked: auditObjective.controllerCorrectionWorked,
      }
    : investigation.assessment;

  const report: FactoryLongRunExperimentReport = {
    experimentId,
    sourceRepoRoot: opts.sourceRepoRoot,
    workRepoRoot: sandboxRoot,
    evidenceDir,
    transcriptPath,
    objectiveId,
    activeJobId,
    status: inspectPayload.data?.status,
    changedFiles,
    diffStat,
    interventions: effectiveInterventions,
    assessment: effectiveAssessment,
    summaryPath,
    artifactsPath,
    timelinePath,
    investigateJsonPath,
    investigateTextPath,
    auditJsonPath,
    auditTextPath,
    transcript,
  };

  await Promise.all([
    fs.writeFile(summaryPath, JSON.stringify(report, null, 2), "utf-8"),
    fs.writeFile(summaryTextPath, renderExperimentSummaryText(report), "utf-8"),
    fs.writeFile(
      transcriptPath,
      transcript.map((entry) => [
        `$ ${entry.argv.join(" ")}`,
        `exit=${entry.exitCode}`,
        entry.stdout ? entry.stdout.trimEnd() : "",
        entry.stderr ? `[stderr]\n${entry.stderr.trimEnd()}` : "",
        "",
      ].filter(Boolean).join("\n")).join("\n"),
      "utf-8",
    ),
    fs.writeFile(
      artifactsPath,
      JSON.stringify({
        packetContext: investigation.packetContext,
        objectiveId,
        changedFiles,
        diffStat,
      }, null, 2),
      "utf-8",
    ),
    fs.writeFile(
      timelinePath,
      JSON.stringify({
        transcript,
        receiptTimeline: investigation.timeline,
        interventionTimeline: investigation.interventions.timeline,
      }, null, 2),
      "utf-8",
    ),
    fs.writeFile(investigateJsonPath, JSON.stringify(investigation, null, 2), "utf-8"),
    fs.writeFile(investigateTextPath, investigateText.stdout, "utf-8"),
    fs.writeFile(auditJsonPath, JSON.stringify(audit, null, 2), "utf-8"),
    fs.writeFile(auditTextPath, auditText.stdout, "utf-8"),
  ]);

  if (!opts.keepWorkdir) {
    await fs.rm(sandboxRoot, { recursive: true, force: true });
  }

  return report;
};

export const renderFactoryLongRunExperimentText = (
  report: FactoryLongRunExperimentReport,
): string => renderExperimentSummaryText(report);
