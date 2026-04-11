import fs from "node:fs/promises";
import path from "node:path";

import type {
  FactoryEvidenceRecord,
  FactoryExecutionScriptRun,
  FactoryInvestigationReport,
  FactoryTaskAlignmentRecord,
  FactoryTaskCompletionRecord,
} from "../modules/factory";

export type FactoryEvidenceArtifact = {
  readonly label: string;
  readonly path: string | null;
  readonly summary: string | null;
};

export type FactoryEvidenceBundle = {
  readonly objective_id: string;
  readonly task_id: string;
  readonly candidate_id: string;
  readonly plan_summary: string;
  readonly alignment: FactoryTaskAlignmentRecord;
  readonly completion: FactoryTaskCompletionRecord;
  readonly scripts_run: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly artifacts: ReadonlyArray<FactoryEvidenceArtifact>;
  readonly links: ReadonlyArray<string>;
  readonly timestamps: {
    readonly created_at: number;
    readonly updated_at: number;
  };
};

export type FactoryInvestigationEvidenceBundle = {
  readonly objective_id: string;
  readonly task_id: string;
  readonly candidate_id: string;
  readonly evidence_records: ReadonlyArray<FactoryEvidenceRecord>;
  readonly scripts_run: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly artifacts: ReadonlyArray<FactoryEvidenceArtifact>;
  readonly timestamps: {
    readonly created_at: number;
    readonly updated_at: number;
  };
};

const tail = (value: string | undefined, max = 800): string | undefined => {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length <= max ? text : `...${text.slice(text.length - max)}`;
};

const readTextIfPresent = async (filePath: string): Promise<string | undefined> =>
  fs.readFile(filePath, "utf-8").catch(() => undefined);

const requireNonEmpty = (value: string | undefined, label: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`factory evidence bundle missing ${label}`);
  return trimmed;
};

const normalizeArtifact = async (
  artifact: { readonly label: string; readonly path: string },
): Promise<FactoryEvidenceArtifact> => ({
  label: requireNonEmpty(artifact.label, "artifact label"),
  path: artifact.path,
  summary: tail(await readTextIfPresent(artifact.path)) ?? null,
});

const normalizeScriptsRun = (
  scriptsRun: ReadonlyArray<FactoryExecutionScriptRun> | undefined,
): ReadonlyArray<FactoryExecutionScriptRun> =>
  (scriptsRun ?? []).map((item) => ({
    command: requireNonEmpty(item.command, "scripts_run.command"),
    ...(item.summary?.trim() ? { summary: item.summary.trim() } : {}),
    ...(item.status ? { status: item.status } : {}),
  }));

const assertEvidenceRecord = (record: FactoryEvidenceRecord): FactoryEvidenceRecord => ({
  objective_id: requireNonEmpty(record.objective_id, "evidence_records.objective_id"),
  task_id: requireNonEmpty(record.task_id, "evidence_records.task_id"),
  timestamp: Number.isFinite(record.timestamp) ? record.timestamp : (() => {
    throw new Error("factory evidence bundle missing evidence_records.timestamp");
  })(),
  tool_name: requireNonEmpty(record.tool_name, "evidence_records.tool_name"),
  command_or_api: requireNonEmpty(record.command_or_api, "evidence_records.command_or_api"),
  inputs: record.inputs,
  outputs: record.outputs,
  summary_metrics: record.summary_metrics,
});

export const writeAlignmentMarkdown = async (input: {
  readonly rootDir: string;
  readonly goal: string;
  readonly constraints: ReadonlyArray<string>;
  readonly definitionOfDone: ReadonlyArray<string>;
  readonly assumptions: ReadonlyArray<string>;
}): Promise<string> => {
  const alignmentPath = path.join(input.rootDir, "alignment.md");
  const lines = [
    "# Alignment",
    "",
    "## Goal",
    input.goal,
    "",
    "## Constraints",
    ...input.constraints.map((item) => `- ${item}`),
    "",
    "## Definition of Done",
    ...input.definitionOfDone.map((item) => `- ${item}`),
    "",
    "## Assumptions",
    ...input.assumptions.map((item) => `- ${item}`),
    "",
  ];
  await fs.writeFile(alignmentPath, lines.join("\n"), "utf-8");
  return alignmentPath;
};

export const buildEvidenceBundle = async (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly planSummary: string;
  readonly alignment: FactoryTaskAlignmentRecord;
  readonly completion: FactoryTaskCompletionRecord;
  readonly scriptsRun?: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly artifactPaths?: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  readonly links?: ReadonlyArray<string>;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}): Promise<FactoryEvidenceBundle> => {
  const artifacts = await Promise.all((input.artifactPaths ?? []).map(normalizeArtifact));
  return {
    objective_id: requireNonEmpty(input.objectiveId, "objective_id"),
    task_id: requireNonEmpty(input.taskId, "task_id"),
    candidate_id: requireNonEmpty(input.candidateId, "candidate_id"),
    plan_summary: requireNonEmpty(input.planSummary, "plan_summary"),
    alignment: input.alignment,
    completion: input.completion,
    scripts_run: normalizeScriptsRun(input.scriptsRun),
    artifacts,
    links: input.links ?? [],
    timestamps: {
      created_at: input.createdAt ?? Date.now(),
      updated_at: input.updatedAt ?? Date.now(),
    },
  };
};

export const investigationEvidenceBundlePath = (resultPath: string): string =>
  resultPath.replace(/\.result\.json$/i, ".evidence-bundle.json");

export const buildInvestigationEvidenceBundle = async (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly report: FactoryInvestigationReport;
  readonly artifactPaths?: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}): Promise<FactoryInvestigationEvidenceBundle> => ({
  objective_id: requireNonEmpty(input.objectiveId, "objective_id"),
  task_id: requireNonEmpty(input.taskId, "task_id"),
  candidate_id: requireNonEmpty(input.candidateId, "candidate_id"),
  evidence_records: (input.report.evidenceRecords ?? []).map(assertEvidenceRecord),
  scripts_run: normalizeScriptsRun(input.report.scriptsRun),
  artifacts: await Promise.all((input.artifactPaths ?? []).map(normalizeArtifact)),
  timestamps: {
    created_at: input.createdAt ?? Date.now(),
    updated_at: input.updatedAt ?? Date.now(),
  },
});

export const writeInvestigationEvidenceBundle = async (input: {
  readonly bundlePath: string;
  readonly objectiveId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly report: FactoryInvestigationReport;
  readonly artifactPaths?: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}): Promise<FactoryInvestigationEvidenceBundle> => {
  const bundle = await buildInvestigationEvidenceBundle(input);
  await fs.mkdir(path.dirname(input.bundlePath), { recursive: true });
  await fs.writeFile(input.bundlePath, JSON.stringify(bundle, null, 2), "utf-8");
  return bundle;
};

const asRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asStringRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!asRecord(value)) throw new Error(`factory evidence bundle invalid ${label}`);
  return value;
};

const asScriptsRun = (value: unknown): ReadonlyArray<FactoryExecutionScriptRun> => {
  if (!Array.isArray(value)) throw new Error("factory evidence bundle invalid scripts_run");
  return normalizeScriptsRun(value as ReadonlyArray<FactoryExecutionScriptRun>);
};

const asEvidenceRecords = (value: unknown): ReadonlyArray<FactoryEvidenceRecord> => {
  if (!Array.isArray(value)) throw new Error("factory evidence bundle invalid evidence_records");
  return value.map((item) => {
    if (!asRecord(item)) throw new Error("factory evidence bundle invalid evidence_records entry");
    return assertEvidenceRecord(item as FactoryEvidenceRecord);
  });
};

const asArtifacts = (value: unknown): ReadonlyArray<FactoryEvidenceArtifact> => {
  if (!Array.isArray(value)) throw new Error("factory evidence bundle invalid artifacts");
  return value.map((item) => {
    const record = asStringRecord(item, "artifact");
    const label = requireNonEmpty(typeof record.label === "string" ? record.label : undefined, "artifact.label");
    const artifactPath = record.path === null
      ? null
      : requireNonEmpty(typeof record.path === "string" ? record.path : undefined, "artifact.path");
    const summary = record.summary === null
      ? null
      : typeof record.summary === "string"
        ? record.summary
        : undefined;
    if (summary === undefined) throw new Error("factory evidence bundle invalid artifact.summary");
    return {
      label,
      path: artifactPath,
      summary,
    };
  });
};

export const readInvestigationEvidenceBundle = async (
  bundlePath: string,
): Promise<FactoryInvestigationEvidenceBundle> => {
  const raw = JSON.parse(await fs.readFile(bundlePath, "utf-8")) as Record<string, unknown>;
  const timestamps = asStringRecord(raw.timestamps, "timestamps");
  const createdAt = typeof timestamps.created_at === "number" ? timestamps.created_at : undefined;
  const updatedAt = typeof timestamps.updated_at === "number" ? timestamps.updated_at : undefined;
  if (createdAt === undefined || updatedAt === undefined) {
    throw new Error("factory evidence bundle invalid timestamps");
  }
  return {
    objective_id: requireNonEmpty(typeof raw.objective_id === "string" ? raw.objective_id : undefined, "objective_id"),
    task_id: requireNonEmpty(typeof raw.task_id === "string" ? raw.task_id : undefined, "task_id"),
    candidate_id: requireNonEmpty(typeof raw.candidate_id === "string" ? raw.candidate_id : undefined, "candidate_id"),
    evidence_records: asEvidenceRecords(raw.evidence_records),
    scripts_run: asScriptsRun(raw.scripts_run),
    artifacts: asArtifacts(raw.artifacts),
    timestamps: {
      created_at: createdAt,
      updated_at: updatedAt,
    },
  };
};
