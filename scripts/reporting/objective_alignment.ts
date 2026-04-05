#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ValidationResult = Record<string, unknown>;

type ReportData = {
  objective: string;
  changedFiles: ReadonlyArray<{ file: string; note: string }>;
  validation: {
    status: string;
    resultsPath: string | null;
    logs: ReadonlyArray<string>;
    notes: ReadonlyArray<string>;
    raw: ValidationResult | null;
  };
  risks: ReadonlyArray<string>;
};

const repoRoot = process.cwd();
const artifactsDir = path.join(repoRoot, "artifacts", "alignment");
const outputMd = path.join(artifactsDir, "alignment.md");
const outputJson = path.join(artifactsDir, "alignment.json");

const readTextIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
};

const loadObjective = async (): Promise<string> => {
  const envObjective = process.env.OBJECTIVE?.trim();
  if (envObjective) return envObjective;
  const objectiveMd = await readTextIfExists(path.join(repoRoot, "objective.md"));
  if (objectiveMd?.trim()) return objectiveMd.trim();
  return "Objective text unavailable.";
};

const runGit = async (args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
};

const loadChangedFiles = async (): Promise<ReadonlyArray<string>> => {
  const diffFiles = new Set<string>();
  for (const args of [["diff", "--name-only", "origin/main...HEAD"], ["diff", "--name-only", "HEAD"]] as const) {
    try {
      const stdout = await runGit(args);
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) diffFiles.add(trimmed);
      }
      break;
    } catch {
      continue;
    }
  }

  try {
    const stdout = await runGit(["ls-files", "--others", "--exclude-standard"]);
    for (const line of stdout.split(/\r?\n/)) {
      const file = line.trim();
      if (file) diffFiles.add(file);
    }
  } catch {
    // Ignore untracked-file lookup failures and fall back to diff-only paths.
  }

  return [...diffFiles].filter((file) => !file.startsWith(".receipt/") && !file.startsWith("artifacts/"));
};

const classifyFile = (file: string): string => {
  if (file.startsWith("scripts/reporting/objective_alignment.")) {
    return "Added the alignment report generator used by delivery automation.";
  }
  if (file.includes("factory/runtime/base-service.ts")) {
    return "Updated the publish workflow instructions so delivery requires the alignment artifact.";
  }
  if (file.includes("result-contracts.ts")) {
    return "Extended structured delivery contracts to carry the alignment report shape.";
  }
  if (file.includes("factory-pr-publisher")) {
    return "Updated the publisher contract so PR notes can include the generated alignment report.";
  }
  return "Changed as part of the delivery alignment update.";
};

const loadValidation = async (): Promise<ReportData["validation"]> => {
  const resultsPath = path.join(repoRoot, "artifacts", "validation", "results.json");
  const rawText = await readTextIfExists(resultsPath);
  if (!rawText) {
    return {
      status: "missing",
      resultsPath: null,
      logs: [],
      notes: ["Validation results were not present in artifacts/validation/results.json."],
      raw: null,
    };
  }

  let parsed: ValidationResult | null = null;
  try {
    parsed = JSON.parse(rawText) as ValidationResult;
  } catch {
    return {
      status: "unparseable",
      resultsPath,
      logs: [],
      notes: ["Validation results existed but could not be parsed as JSON."],
      raw: null,
    };
  }

  const logs = [
    ...(Array.isArray(parsed.logs) ? parsed.logs.filter((item): item is string => typeof item === "string") : []),
    ...(typeof parsed.logPath === "string" ? [parsed.logPath] : []),
    ...(typeof parsed.stdoutPath === "string" ? [parsed.stdoutPath] : []),
    ...(typeof parsed.stderrPath === "string" ? [parsed.stderrPath] : []),
  ].filter(Boolean);
  const status = typeof parsed.status === "string"
    ? parsed.status
    : typeof parsed.outcome === "string"
      ? parsed.outcome
      : typeof parsed.passed === "boolean"
        ? (parsed.passed ? "passed" : "failed")
        : "unknown";
  const notes = [
    typeof parsed.summary === "string" ? parsed.summary : "Validation data was captured from results.json.",
  ];

  return { status, resultsPath, logs: [...new Set(logs)], notes, raw: parsed };
};

const buildReport = async (): Promise<ReportData> => {
  const [objective, changedFiles, validation] = await Promise.all([
    loadObjective(),
    loadChangedFiles(),
    loadValidation(),
  ]);

  const changed = changedFiles.map((file) => ({ file, note: classifyFile(file) }));
  const risks = [
    validation.status === "failed" ? "Validation results indicate the delivery did not pass cleanly." : "",
    changed.length === 0 ? "No changed files were detected from git diff; the report may be incomplete." : "",
    !validation.resultsPath ? "No validation results artifact was available at generation time." : "",
  ].filter(Boolean);

  return {
    objective,
    changedFiles: changed,
    validation,
    risks: risks.length > 0 ? risks : ["The report is generated from the current workspace and validation artifact state."],
  };
};

const renderMarkdown = (report: ReportData): string => {
  const changedLines = report.changedFiles.length > 0
    ? report.changedFiles.map((item) => `- ${item.file}: ${item.note}`)
    : ["- No changed files were detected."];
  const validationLines = [
    `- Status: ${report.validation.status}`,
    ...(report.validation.resultsPath ? [`- Results: ${report.validation.resultsPath}`] : []),
    ...(report.validation.logs.length > 0 ? report.validation.logs.map((log) => `- Log: ${log}`) : ["- Logs: none recorded"]),
    ...report.validation.notes.map((note) => `- Note: ${note}`),
  ];
  const riskLines = report.risks.map((risk) => `- ${risk}`);

  return [
    "# Objective Alignment Report",
    "",
    "## Objective statement",
    report.objective,
    "",
    "## Implemented changes",
    ...changedLines,
    "",
    "## Validation performed",
    ...validationLines,
    "",
    "## Risk / assumptions",
    ...riskLines,
    "",
  ].join("\n");
};

const main = async (): Promise<void> => {
  const report = await buildReport();
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await writeFile(outputMd, `${renderMarkdown(report)}\n`, "utf-8");
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
