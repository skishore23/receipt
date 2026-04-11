import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { llmStructured } from "../../../adapters/openai";
import { optionalTrimmedString, trimmedString } from "../../../framework/http";
import type {
  FactoryArtifactIssue,
} from "../artifact-inspection";
import { readdirIfPresent } from "../artifact-inspection";
import {
  normalizeInvestigationReport,
  normalizeInvestigationSemanticResult,
  type FactoryInvestigationSemanticResult,
} from "../result-contracts";
import { parseJsonObjectCandidate } from "../worker-results";
import type {
  FactoryExecutionScriptRun,
  FactoryEvidenceRecord,
  FactoryInvestigationReport,
  FactoryState,
  FactoryTaskRecord,
} from "../../../modules/factory";

const InvestigationSemanticSynthesisSchema = z.object({
  status: z.enum(["answered", "partial", "blocked"]),
  conclusion: z.string().min(1),
  findings: z.array(z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    confidence: z.enum(["confirmed", "inferred", "uncertain"]),
    evidenceRefLabels: z.array(z.string()).default([]),
  })).default([]),
  uncertainties: z.array(z.string()).default([]),
  nextAction: z.string().min(1).nullable().optional(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const clipText = (value: string | undefined, max = 280): string | undefined => {
  if (!value) return undefined;
  const trimmed = trimmedString(value);
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const parseJsonObjectCandidates = (value: string | undefined): ReadonlyArray<Record<string, unknown>> => {
  const text = optionalTrimmedString(value);
  if (!text) return [];
  const direct = parseJsonObjectCandidate(text);
  if (direct) return [direct];
  const results: Array<Record<string, unknown>> = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== "}") continue;
    if (depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    const candidate = parseJsonObjectCandidate(text.slice(start, index + 1));
    if (candidate) results.push(candidate);
    start = -1;
  }
  return results;
};

export type FactoryInvestigationHelperEvidence = {
  readonly summary?: string;
  readonly evidence: ReadonlyArray<{ readonly title: string; readonly summary: string; readonly detail?: string }>;
  readonly evidenceRecords: ReadonlyArray<FactoryEvidenceRecord>;
  readonly artifacts: ReadonlyArray<{ readonly label: string; readonly path: string | null; readonly summary: string | null }>;
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
};

const summarizeHelperMetricCollections = (data: Record<string, unknown>): string | undefined => {
  const metrics = Object.entries(data)
    .flatMap(([key, value]) => Array.isArray(value) ? [`${key}=${String(value.length)}`] : [])
    .slice(0, 8);
  if (metrics.length === 0) return undefined;
  return clipText(`Captured collections: ${metrics.join(", ")}`, 500);
};

const summarizeMountedEvidenceMetrics = (
  data: Record<string, unknown>,
): Record<string, string | number | boolean | null> => {
  const summaryMetrics: Record<string, string | number | boolean | null> = {};
  if (typeof data.totalCount === "number") summaryMetrics.totalCount = data.totalCount;
  if (Array.isArray(data.regions)) summaryMetrics.regions = data.regions.length;
  if (isRecord(data.resultsByRegion)) summaryMetrics.resultsByRegion = Object.keys(data.resultsByRegion).length;
  if (isRecord(data.stateCounts)) summaryMetrics.stateCounts = Object.keys(data.stateCounts).length;
  if (Object.keys(summaryMetrics).length === 0) summaryMetrics.topLevelKeys = Object.keys(data).length;
  return summaryMetrics;
};

const DIRECT_EVIDENCE_COMMAND_RE = /\baws\b|python3 - <<['"]?PY['"]?|subprocess\.check_output\(\['aws'/i;
const BOOTSTRAP_COMMAND_RE = /sed -n|memory\.cjs|SKILL|CONTEXT PACK|TASK CONTEXT SUMMARY|find .*SKILL\.md|rg --files/i;

const isDirectEvidenceCommand = (command: string): boolean =>
  DIRECT_EVIDENCE_COMMAND_RE.test(command) && !BOOTSTRAP_COMMAND_RE.test(command);

const summarizeDirectCommandMetrics = (
  parsedOutput: unknown,
  outputText: string,
): Record<string, string | number | boolean | null> => {
  if (Array.isArray(parsedOutput)) {
    return { items: parsedOutput.length };
  }
  if (isRecord(parsedOutput)) {
    const metrics: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(parsedOutput)) {
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean" || value === null) {
        metrics[key] = value;
        continue;
      }
      if (Array.isArray(value)) {
        metrics[`${key}_count`] = value.length;
        continue;
      }
      if (isRecord(value)) {
        metrics[`${key}_count`] = Object.keys(value).length;
      }
    }
    if (Object.keys(metrics).length > 0) return metrics;
  }
  return {
    output_chars: outputText.length,
    output_lines: outputText.split("\n").filter((line) => line.length > 0).length,
  };
};

const summarizeDirectCommandOutput = (
  parsedOutput: unknown,
  outputText: string,
): string => {
  if (isRecord(parsedOutput)) {
    if (typeof parsedOutput.regionCount === "number" && typeof parsedOutput.instanceCount === "number" && typeof parsedOutput.clusterCount === "number") {
      return `Scanned ${parsedOutput.regionCount} region(s); found ${parsedOutput.instanceCount} RDS instance(s) and ${parsedOutput.clusterCount} cluster(s).`;
    }
    if (typeof parsedOutput.regionCount === "number" && typeof parsedOutput.rdsAlarmCount === "number") {
      return `Scanned ${parsedOutput.regionCount} region(s); found ${parsedOutput.rdsAlarmCount} AWS/RDS alarm(s).`;
    }
    if (Array.isArray(parsedOutput.instances) && Array.isArray(parsedOutput.clusters) && Array.isArray(parsedOutput.alarm_checks)) {
      return `Collected direct RDS inventory: ${parsedOutput.instances.length} instance(s), ${parsedOutput.clusters.length} cluster(s), ${parsedOutput.alarm_checks.length} alarm check set(s).`;
    }
  }
  return clipText(outputText.replace(/\s+/g, " "), 280) ?? "Captured direct command output.";
};

export const hasHelperEvidence = (input: {
  readonly summary?: string;
  readonly evidence: ReadonlyArray<unknown>;
  readonly evidenceRecords?: ReadonlyArray<unknown>;
  readonly artifacts: ReadonlyArray<unknown>;
  readonly scriptsRun: ReadonlyArray<unknown>;
}): boolean =>
  Boolean(
    input.summary
    || input.evidence.length > 0
    || (input.evidenceRecords?.length ?? 0) > 0
    || input.artifacts.length > 0
    || input.scriptsRun.length > 0,
  );

export const buildInvestigationTelemetryScriptsRun = (
  telemetry: Record<string, unknown> | undefined,
): ReadonlyArray<FactoryExecutionScriptRun> => {
  const command = clipText(optionalTrimmedString(telemetry?.command), 220);
  if (!command) return [];
  const exitCode = typeof telemetry?.exitCode === "number" ? telemetry.exitCode : undefined;
  return [{
    command,
    summary: clipText(
      exitCode === undefined
        ? "Preserved controller-side task telemetry."
        : exitCode === 0
          ? "Telemetry captured the task command successfully."
          : `Telemetry captured task command exit ${exitCode}.`,
      280,
    ),
    status: exitCode === undefined ? "warning" : exitCode === 0 ? "ok" : "error",
  }];
};

export const buildFallbackInvestigationSemanticResult = (input: {
  readonly helperEvidence: FactoryInvestigationHelperEvidence;
  readonly rawResult: Record<string, unknown>;
  readonly errorDetail?: string;
}): FactoryInvestigationSemanticResult => {
  const fallbackRecord = isRecord(input.rawResult.controllerFallback)
    ? input.rawResult.controllerFallback
    : undefined;
  const fallbackSummary = clipText(
    optionalTrimmedString(fallbackRecord?.summary)
      ?? input.helperEvidence.summary
      ?? "Captured investigation evidence without a semantic worker result.",
    400,
  ) ?? "Captured investigation evidence without a semantic worker result.";
  const fallbackNextAction = clipText(optionalTrimmedString(fallbackRecord?.nextAction), 280);
  const helperLabels = input.helperEvidence.artifacts.map((item) => item.label);
  return {
    status: hasHelperEvidence(input.helperEvidence) ? "answered" : "partial",
    conclusion: fallbackSummary,
    findings: input.helperEvidence.evidence
      .slice(0, 6)
      .map((item) => ({
        title: item.title,
        summary: item.summary,
        confidence: "confirmed" as const,
        evidenceRefLabels: helperLabels.slice(0, 4),
      })),
    uncertainties: [
      ...(input.errorDetail ? [input.errorDetail] : []),
      ...(!hasHelperEvidence(input.helperEvidence)
        ? ["No helper-backed evidence was captured before the worker stopped."]
        : []),
    ],
    ...(fallbackNextAction ? { nextAction: fallbackNextAction } : {}),
  };
};

export const synthesizeInvestigationSemanticResult = async (input: {
  readonly state: FactoryState;
  readonly task: FactoryTaskRecord;
  readonly rawResult: Record<string, unknown>;
  readonly helperEvidence: FactoryInvestigationHelperEvidence;
  readonly telemetry: Record<string, unknown> | undefined;
}): Promise<FactoryInvestigationSemanticResult> => {
  const errorDetail = clipText(
    optionalTrimmedString(isRecord(input.rawResult.controllerFallback) ? input.rawResult.controllerFallback.error : undefined),
    280,
  );
  const fallback = buildFallbackInvestigationSemanticResult({
    helperEvidence: input.helperEvidence,
    rawResult: input.rawResult,
    errorDetail,
  });
  if (!hasHelperEvidence(input.helperEvidence)) return fallback;
  try {
    const llmResult = await llmStructured({
      system: [
        "You are finalizing an investigation from already-captured evidence.",
        "Use only the supplied evidence. Do not invent metrics or identifiers.",
        "Prefer concise findings tied to artifact labels or command labels already present in the evidence.",
        "Use status=answered only when the evidence directly answers the question.",
      ].join("\n"),
      user: [
        `Objective: ${input.state.title}`,
        `Objective prompt: ${input.state.prompt}`,
        `Task prompt: ${input.task.prompt}`,
        `Helper summary: ${input.helperEvidence.summary ?? "none"}`,
        `Evidence items:`,
        ...input.helperEvidence.evidence.map((item) =>
          `- ${item.title}: ${item.summary}${item.detail ? ` | ${item.detail}` : ""}`),
        `Artifacts:`,
        ...(input.helperEvidence.artifacts.length > 0
          ? input.helperEvidence.artifacts.map((item) =>
            `- ${item.label}${item.path ? ` (${item.path})` : ""}${item.summary ? `: ${item.summary}` : ""}`)
          : ["- none"]),
        `Commands:`,
        ...(input.helperEvidence.scriptsRun.length > 0
          ? input.helperEvidence.scriptsRun.map((item) =>
            `- ${item.command}${item.summary ? ` | ${item.summary}` : ""}`)
          : ["- none"]),
        `Telemetry: ${clipText(optionalTrimmedString(input.telemetry?.command), 220) ?? "none"}`,
      ].join("\n"),
      schema: InvestigationSemanticSynthesisSchema,
      schemaName: "FactoryInvestigationSemanticSynthesis",
    });
    const parsed = normalizeInvestigationSemanticResult({
      ...llmResult.parsed,
      nextAction: llmResult.parsed.nextAction,
    });
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

export const buildInvestigationReport = (input: {
  readonly semantic: FactoryInvestigationSemanticResult;
  readonly helperEvidence: FactoryInvestigationHelperEvidence;
  readonly telemetry: Record<string, unknown> | undefined;
  readonly artifactIssues: ReadonlyArray<FactoryArtifactIssue>;
}): FactoryInvestigationReport => {
  const telemetryScriptsRun = buildInvestigationTelemetryScriptsRun(input.telemetry);
  return {
    conclusion: input.semantic.conclusion,
    evidence: [
      ...input.semantic.findings.map((item) => ({
        title: item.title,
        summary: item.summary,
        detail: item.evidenceRefLabels.length > 0
          ? `Evidence refs: ${item.evidenceRefLabels.join(", ")}. Confidence: ${item.confidence}.`
          : `Confidence: ${item.confidence}.`,
      })),
      ...input.helperEvidence.evidence.filter((item) =>
        !input.semantic.findings.some((finding) => finding.title === item.title && finding.summary === item.summary)),
      ...(input.artifactIssues.length > 0
        ? [{
            title: "Captured artifact warnings",
            summary: clipText(input.artifactIssues.map((issue) => issue.summary).join(" "), 280)
              ?? "Captured evidence artifacts recorded command errors.",
            detail: clipText(
              input.artifactIssues
                .map((issue) => issue.detail ?? issue.path)
                .filter(Boolean)
                .join("\n"),
              600,
            ),
          }]
        : []),
    ],
    ...(input.helperEvidence.evidenceRecords.length > 0 ? { evidenceRecords: input.helperEvidence.evidenceRecords } : {}),
    scriptsRun: [
      ...input.helperEvidence.scriptsRun,
      ...telemetryScriptsRun.filter((item) =>
        !input.helperEvidence.scriptsRun.some((existing) => existing.command === item.command)),
      ...input.artifactIssues.map((issue) => ({
        command: `artifact:${path.basename(issue.path)}`,
        summary: issue.summary,
        status: issue.status,
      } satisfies FactoryInvestigationReport["scriptsRun"][number])),
    ],
    disagreements: [],
    nextSteps: [
      ...input.semantic.uncertainties,
      ...(input.semantic.nextAction ? [input.semantic.nextAction] : []),
    ],
  };
};

export const extractInvestigationHelperEvidence = async (input: {
  readonly workspacePath: string;
  readonly telemetry: Record<string, unknown> | undefined;
  readonly objectiveId?: string;
  readonly taskId?: string;
  readonly strictHelperEvidence?: boolean;
}): Promise<FactoryInvestigationHelperEvidence> => {
  const evidence: Array<{ readonly title: string; readonly summary: string; readonly detail?: string }> = [];
  const evidenceRecords: Array<FactoryEvidenceRecord> = [];
  const artifacts: Array<{ readonly label: string; readonly path: string | null; readonly summary: string | null }> = [];
  const scriptsRun: Array<FactoryExecutionScriptRun> = [];
  let summary: string | undefined;
  const seenStdout = new Set<string>();
  const seenArtifacts = new Set<string>();
  const seenScripts = new Set<string>();
  const seenEvidence = new Set<string>();
  const seenEvidenceRecords = new Set<string>();

  const addHelperOutput = (helperOutput: Record<string, unknown>, command: string): void => {
    const helperSummary = optionalTrimmedString(helperOutput.summary);
    if (helperSummary && !summary) summary = helperSummary;
    const normalizedHelperReport = normalizeInvestigationReport({
      conclusion: helperSummary ?? "Captured helper evidence.",
      evidence: [],
      evidenceRecords: helperOutput.evidenceRecords,
      scriptsRun: helperOutput.scriptsRun,
      disagreements: [],
      nextSteps: [],
    }, helperSummary ?? "Captured helper evidence.");
    const helperData = isRecord(helperOutput.data) ? helperOutput.data : undefined;
    const metricSummary = helperData ? summarizeHelperMetricCollections(helperData) : undefined;
    const evidenceKey = `${helperSummary ?? "helper"}::${metricSummary ?? ""}`;
    if (!seenEvidence.has(evidenceKey)) {
      seenEvidence.add(evidenceKey);
      evidence.push({
        title: "Checked-in helper output",
        summary: helperSummary ?? "Captured machine-readable helper output.",
        detail: metricSummary,
      });
    }
    const normalizedEvidenceRecords = normalizedHelperReport.evidenceRecords?.length
      ? normalizedHelperReport.evidenceRecords
      : [];
    const strictHelperEvidence = input.strictHelperEvidence === true;
    if (strictHelperEvidence && (!Array.isArray(helperOutput.evidenceRecords) || normalizedEvidenceRecords.length !== helperOutput.evidenceRecords.length)) {
      throw new Error(`checked-in helper output missing strict evidenceRecords for command: ${clipText(command, 160) ?? command}`);
    }
    for (const record of normalizedEvidenceRecords) {
      const recordKey = `${record.tool_name}::${record.command_or_api}::${record.timestamp}`;
      if (seenEvidenceRecords.has(recordKey)) continue;
      seenEvidenceRecords.add(recordKey);
      evidenceRecords.push(record);
    }
    const normalizedScripts = normalizedHelperReport.scriptsRun.length > 0
      ? normalizedHelperReport.scriptsRun
      : [];
    if (strictHelperEvidence && (!Array.isArray(helperOutput.scriptsRun) || normalizedScripts.length !== helperOutput.scriptsRun.length)) {
      throw new Error(`checked-in helper output missing strict scriptsRun for command: ${clipText(command, 160) ?? command}`);
    }
    const effectiveScripts = normalizedScripts.length > 0
      ? normalizedScripts
      : [{
          command: clipText(command, 280) ?? command,
          summary: helperSummary ?? "Captured checked-in helper output.",
          status: "ok" as const,
        }];
    for (const script of effectiveScripts) {
      const commandKey = clipText(script.command, 280) ?? script.command;
      if (seenScripts.has(commandKey)) continue;
      seenScripts.add(commandKey);
      scriptsRun.push({
        command: commandKey,
        summary: script.summary,
        status: script.status,
      });
    }
    const helperArtifacts = Array.isArray(helperOutput.artifacts)
      ? helperOutput.artifacts
      : [];
    for (const artifact of helperArtifacts) {
      if (typeof artifact === "string") {
        if (seenArtifacts.has(artifact)) continue;
        seenArtifacts.add(artifact);
        artifacts.push({
          label: path.basename(artifact),
          path: artifact,
          summary: helperSummary ?? null,
        });
        continue;
      }
      if (!isRecord(artifact)) continue;
      const artifactPath = optionalTrimmedString(artifact.path);
      const artifactKey = artifactPath ?? `${optionalTrimmedString(artifact.label) ?? "artifact"}::${optionalTrimmedString(artifact.summary) ?? ""}`;
      if (seenArtifacts.has(artifactKey)) continue;
      seenArtifacts.add(artifactKey);
      artifacts.push({
        label: optionalTrimmedString(artifact.label) ?? path.basename(artifactPath ?? "artifact"),
        path: artifactPath ?? null,
        summary: optionalTrimmedString(artifact.summary) ?? helperSummary ?? null,
      });
    }
  };

  const addDirectCommandOutput = (
    command: string,
    aggregatedOutput: string,
    exitCode: number | undefined,
  ): void => {
    if (!isDirectEvidenceCommand(command)) return;
    const parsedOutput = parseJsonObjectCandidate(aggregatedOutput);
    const summary = summarizeDirectCommandOutput(parsedOutput, aggregatedOutput);
    const commandKey = clipText(command, 280) ?? command;
    if (!seenScripts.has(commandKey)) {
      seenScripts.add(commandKey);
      scriptsRun.push({
        command: commandKey,
        summary,
        status: exitCode === undefined ? "warning" : exitCode === 0 ? "ok" : "error",
      });
    }
    const evidenceKey = `direct::${commandKey}`;
    if (!seenEvidence.has(evidenceKey)) {
      seenEvidence.add(evidenceKey);
      evidence.push({
        title: "Direct command output",
        summary,
        detail: clipText(`Command: ${commandKey}`, 280),
      });
    }
    const record = {
      objective_id: input.objectiveId ?? (() => { throw new Error("direct command evidence requires objectiveId"); })(),
      task_id: input.taskId ?? (() => { throw new Error("direct command evidence requires taskId"); })(),
      timestamp: Date.now(),
      tool_name: command.includes("python3 - <<") ? "python3_subprocess_aws" : "aws_cli_command",
      command_or_api: command,
      inputs: {
        source: "command_execution",
        command_kind: command.includes("python3 - <<") ? "python" : "shell",
      },
      outputs: {
        status: exitCode === undefined ? "warning" : exitCode === 0 ? "ok" : "error",
        output_format: parsedOutput ? "json" : "text",
        output_preview: clipText(aggregatedOutput.replace(/\s+/g, " "), 280) ?? "",
      },
      summary_metrics: summarizeDirectCommandMetrics(parsedOutput, aggregatedOutput),
    } satisfies FactoryEvidenceRecord;
    const recordKey = `${record.tool_name}::${record.command_or_api}`;
    if (seenEvidenceRecords.has(recordKey)) return;
    seenEvidenceRecords.add(recordKey);
    evidenceRecords.push(record);
  };

  const visitStdout = (stdout: string | undefined): void => {
    const normalized = optionalTrimmedString(stdout);
    if (!normalized || seenStdout.has(normalized)) return;
    seenStdout.add(normalized);
    for (const rawLine of normalized.split("\n")) {
      const event = parseJsonObjectCandidate(rawLine);
      if (!event) continue;
      const item = isRecord(event.item) ? event.item : undefined;
      const command = optionalTrimmedString(item?.command);
      const aggregatedOutput = optionalTrimmedString(item?.aggregated_output);
      const exitCode = typeof item?.exit_code === "number" ? item.exit_code : undefined;
      if (command && aggregatedOutput && command.includes("factory-helper-runtime/runner.py run")) {
        for (const helperOutput of parseJsonObjectCandidates(aggregatedOutput)) {
          addHelperOutput(helperOutput, command);
        }
      } else if (command && aggregatedOutput) {
        addDirectCommandOutput(command, aggregatedOutput, exitCode);
      }
      const nestedStdout = optionalTrimmedString(event.stdout);
      if (nestedStdout) visitStdout(nestedStdout);
      for (const nestedAggregated of parseJsonObjectCandidates(aggregatedOutput)) {
        const nestedAggregatedStdout = optionalTrimmedString(nestedAggregated.stdout);
        if (nestedAggregatedStdout) visitStdout(nestedAggregatedStdout);
      }
    }
  };

  visitStdout(optionalTrimmedString(input.telemetry?.stdout));

  const packetDir = path.join(input.workspacePath, ".receipt", "factory");
  const siblingEvidenceFiles = (await readdirIfPresent(packetDir, { withFileTypes: true }))
    .filter((entry) => /^task_\d+\.evidence\.json$/i.test(entry.name))
    .map((entry) => path.join(packetDir, entry.name));
  for (const evidencePath of siblingEvidenceFiles) {
    const raw = await fs.readFile(evidencePath, "utf-8").catch(() => "");
    const parsed = parseJsonObjectCandidate(raw);
    visitStdout(optionalTrimmedString(parsed?.stdout));
  }

  if (evidenceRecords.length === 0) {
    const mountedEvidenceDir = path.join(packetDir, "evidence");
    const mountedEvidenceFiles = (await readdirIfPresent(mountedEvidenceDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(mountedEvidenceDir, entry.name));
    for (const artifactPath of mountedEvidenceFiles) {
      const raw = await fs.readFile(artifactPath, "utf-8").catch(() => "");
      const parsed = parseJsonObjectCandidate(raw);
      if (!parsed) continue;
      const stats = await fs.stat(artifactPath).catch(() => undefined);
      const label = path.basename(artifactPath);
      const summaryMetrics = summarizeMountedEvidenceMetrics(parsed);
      const summaryText = clipText(
        typeof summaryMetrics.totalCount === "number"
          ? `${label} reported totalCount=${summaryMetrics.totalCount}.`
          : `Mounted evidence artifact ${label} was available for synthesis.`,
        280,
      ) ?? `Mounted evidence artifact ${label} was available for synthesis.`;
      const artifactKey = artifactPath;
      if (!seenArtifacts.has(artifactKey)) {
        seenArtifacts.add(artifactKey);
        artifacts.push({
          label,
          path: artifactPath,
          summary: summaryText,
        });
      }
      const evidenceKey = `${label}::${JSON.stringify(summaryMetrics)}`;
      if (!seenEvidence.has(evidenceKey)) {
        seenEvidence.add(evidenceKey);
        evidence.push({
          title: "Mounted evidence artifact",
          summary: summaryText,
          detail: clipText(`Artifact path: ${artifactPath}`, 280),
        });
      }
      const record = {
        objective_id: input.objectiveId ?? (() => { throw new Error("mounted evidence requires objectiveId"); })(),
        task_id: input.taskId ?? (() => { throw new Error("mounted evidence requires taskId"); })(),
        timestamp: stats?.mtimeMs ?? Date.now(),
        tool_name: "mounted_evidence_artifact",
        command_or_api: `artifact:${artifactPath}`,
        inputs: {
          artifact_path: artifactPath,
          artifact_label: label,
        },
        outputs: {
          summary: summaryText,
        },
        summary_metrics: summaryMetrics,
      } satisfies FactoryEvidenceRecord;
      const recordKey = `${record.tool_name}::${record.command_or_api}::${record.timestamp}`;
      if (!seenEvidenceRecords.has(recordKey)) {
        seenEvidenceRecords.add(recordKey);
        evidenceRecords.push(record);
      }
    }
  }

  return {
    summary,
    evidence,
    evidenceRecords,
    artifacts,
    scriptsRun,
  };
};
