import type { GraphRef } from "@receipt/core/graph";
import { trimmedString } from "../../framework/http";
import type {
  FactoryCheckResult,
  FactoryExecutionScriptRun,
  FactoryInvestigationReport,
  FactoryTaskAlignmentRecord,
  FactoryTaskCompletionRecord,
} from "../../modules/factory";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const clipText = (value: string | undefined, max = 280): string | undefined => {
  if (!value) return undefined;
  const trimmed = trimmedString(value);
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
};

const asReadonlyStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];

const renderSection = (
  title: string,
  lines: ReadonlyArray<string>,
  bulletize: boolean,
): string =>
  [
    title,
    ...lines.map((line) => bulletize ? `- ${line}` : line),
  ].join("\n");

const artifactLines = (
  artifactRefs: ReadonlyArray<Readonly<Record<string, GraphRef>>>,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const refs of artifactRefs) {
    for (const ref of Object.values(refs)) {
      if (!ref?.ref) continue;
      const key = `${ref.kind}:${ref.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${ref.label ?? ref.kind}: ${ref.ref}`);
    }
  }
  return lines;
};

export const FACTORY_TASK_ARTIFACT_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    path: { type: ["string", "null"] },
    summary: { type: ["string", "null"] },
  },
  required: ["label", "path", "summary"],
  additionalProperties: false,
} as const;

export const FACTORY_TASK_SCRIPT_RUN_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string" },
    summary: { type: ["string", "null"] },
    status: { type: ["string", "null"], enum: ["ok", "warning", "error", null] },
  },
  required: ["command", "summary", "status"],
  additionalProperties: false,
} as const;

export const FACTORY_TASK_COMPLETION_SCHEMA = {
  type: "object",
  properties: {
    changed: {
      type: "array",
      items: { type: "string" },
    },
    proof: {
      type: "array",
      items: { type: "string" },
    },
    remaining: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["changed", "proof", "remaining"],
  additionalProperties: false,
} as const;

export const FACTORY_TASK_ALIGNMENT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["aligned", "uncertain", "drifted"] },
    satisfied: {
      type: "array",
      items: { type: "string" },
    },
    missing: {
      type: "array",
      items: { type: "string" },
    },
    outOfScope: {
      type: "array",
      items: { type: "string" },
    },
    rationale: { type: "string" },
  },
  required: ["verdict", "satisfied", "missing", "outOfScope", "rationale"],
  additionalProperties: false,
} as const;

export const FACTORY_TASK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["approved", "changes_requested", "blocked", "partial"] },
    summary: { type: "string" },
    handoff: { type: "string" },
    artifacts: {
      type: "array",
      items: FACTORY_TASK_ARTIFACT_SCHEMA,
    },
    scriptsRun: {
      type: "array",
      items: FACTORY_TASK_SCRIPT_RUN_SCHEMA,
    },
    completion: FACTORY_TASK_COMPLETION_SCHEMA,
    alignment: FACTORY_TASK_ALIGNMENT_SCHEMA,
    nextAction: { type: ["string", "null"] },
  },
  required: ["outcome", "summary", "handoff", "artifacts", "scriptsRun", "completion", "alignment", "nextAction"],
  additionalProperties: false,
} as const;

export const FACTORY_PUBLISH_RESULT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    handoff: { type: "string" },
    prUrl: { type: "string" },
    prNumber: { type: ["number", "null"] },
    headRefName: { type: ["string", "null"] },
    baseRefName: { type: ["string", "null"] },
  },
  required: ["summary", "handoff", "prUrl", "prNumber", "headRefName", "baseRefName"],
  additionalProperties: false,
} as const;

export const FACTORY_INVESTIGATION_REPORT_SCHEMA = {
  type: "object",
  properties: {
    conclusion: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          detail: { type: ["string", "null"] },
        },
        required: ["title", "summary", "detail"],
        additionalProperties: false,
      },
    },
    scriptsRun: {
      type: "array",
      items: FACTORY_TASK_SCRIPT_RUN_SCHEMA,
    },
    disagreements: {
      type: "array",
      items: { type: "string" },
    },
    nextSteps: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["conclusion", "evidence", "scriptsRun", "disagreements", "nextSteps"],
  additionalProperties: false,
} as const;

export const FACTORY_INVESTIGATION_TASK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    outcome: FACTORY_TASK_RESULT_SCHEMA.properties.outcome,
    summary: FACTORY_TASK_RESULT_SCHEMA.properties.summary,
    handoff: FACTORY_TASK_RESULT_SCHEMA.properties.handoff,
    artifacts: FACTORY_TASK_RESULT_SCHEMA.properties.artifacts,
    completion: FACTORY_TASK_RESULT_SCHEMA.properties.completion,
    nextAction: FACTORY_TASK_RESULT_SCHEMA.properties.nextAction,
    report: {
      ...FACTORY_INVESTIGATION_REPORT_SCHEMA,
      type: ["object", "null"],
    },
  },
  required: ["outcome", "summary", "handoff", "artifacts", "completion", "nextAction", "report"],
  additionalProperties: false,
} as const;

export const describeMissingDeliveryFinalizationEvidence = (input: {
  readonly alignment: unknown;
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly completion: FactoryTaskCompletionRecord;
}): ReadonlyArray<string> => {
  const missing: string[] = [];
  const alignment = isRecord(input.alignment);
  const hasAlignmentArtifact = alignment && typeof input.alignment === "object";
  if (!hasAlignmentArtifact) missing.push("alignment.json");
  if (input.scriptsRun.length === 0) missing.push("scripts_run.log");
  if (input.completion.proof.length === 0) missing.push("evidence/index.json");
  return [...new Set(missing)];
};

export const renderMissingDeliveryFinalizationEvidenceError = (missing: ReadonlyArray<string>): string =>
  `Delivery finalization blocked: missing required alignment/evidence artifact(s): ${missing.join(", ")}. Generate an alignment.json with verdict/satisfied/missing/outOfScope/rationale and record at least one structured proof item plus scripts_run.log before finalizing the task.`;

export const normalizeExecutionScriptsRun = (
  value: unknown,
): ReadonlyArray<FactoryExecutionScriptRun> =>
  Array.isArray(value)
    ? value
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        command: clipText(typeof item.command === "string" ? item.command : undefined, 220) ?? "command",
        summary: clipText(typeof item.summary === "string" ? item.summary : undefined, 280),
        status: item.status === "ok" || item.status === "warning" || item.status === "error"
          ? item.status
          : undefined,
      } satisfies FactoryExecutionScriptRun))
    : [];

export const normalizeTaskCompletionRecord = (
  value: unknown,
  fallback?: FactoryTaskCompletionRecord,
): FactoryTaskCompletionRecord => {
  const record = isRecord(value) ? value : {};
  const changed = asReadonlyStringArray(record.changed).map((item) => clipText(item, 280) ?? item);
  const proof = asReadonlyStringArray(record.proof).map((item) => clipText(item, 280) ?? item);
  const remaining = asReadonlyStringArray(record.remaining).map((item) => clipText(item, 280) ?? item);
  return {
    changed: changed.length > 0 ? changed : (fallback?.changed ?? []),
    proof: proof.length > 0 ? proof : (fallback?.proof ?? []),
    remaining: remaining.length > 0 ? remaining : (fallback?.remaining ?? []),
  };
};

export const normalizeTaskAlignmentRecord = (
  value: unknown,
  fallback?: FactoryTaskAlignmentRecord,
): FactoryTaskAlignmentRecord => {
  const record = isRecord(value) ? value : {};
  const verdict = record.verdict === "uncertain" || record.verdict === "drifted"
    ? record.verdict
    : record.verdict === "aligned"
      ? "aligned"
      : (fallback?.verdict ?? "aligned");
  const satisfied = asReadonlyStringArray(record.satisfied).map((item) => clipText(item, 280) ?? item);
  const missing = asReadonlyStringArray(record.missing).map((item) => clipText(item, 280) ?? item);
  const outOfScope = asReadonlyStringArray(record.outOfScope).map((item) => clipText(item, 280) ?? item);
  return {
    verdict,
    satisfied: satisfied.length > 0 ? satisfied : (fallback?.satisfied ?? []),
    missing: missing.length > 0 ? missing : (fallback?.missing ?? []),
    outOfScope: outOfScope.length > 0 ? outOfScope : (fallback?.outOfScope ?? []),
    rationale: clipText(typeof record.rationale === "string" ? record.rationale : undefined, 500)
      ?? fallback?.rationale
      ?? "Alignment was not explicitly reported.",
  };
};

export const normalizeInvestigationReport = (
  value: unknown,
  summary: string,
): FactoryInvestigationReport => {
  const record = isRecord(value) ? value : {};
  const evidence = Array.isArray(record.evidence)
    ? record.evidence
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        title: clipText(typeof item.title === "string" ? item.title : undefined, 140) ?? "Evidence",
        summary: clipText(typeof item.summary === "string" ? item.summary : undefined, 280) ?? "Evidence captured.",
        detail: clipText(typeof item.detail === "string" ? item.detail : undefined, 600),
      }))
    : [];
  const scriptsRun = normalizeExecutionScriptsRun(record.scriptsRun);
  return {
    conclusion: clipText(typeof record.conclusion === "string" ? record.conclusion : undefined, 400) ?? summary,
    evidence,
    scriptsRun,
    disagreements: asReadonlyStringArray(record.disagreements).map((item) => clipText(item, 280) ?? item),
    nextSteps: asReadonlyStringArray(record.nextSteps).map((item) => clipText(item, 280) ?? item),
  };
};

export const buildDefaultTaskCompletion = (input: {
  readonly summary: string;
  readonly workerArtifacts?: ReadonlyArray<{
    readonly label: string;
    readonly path: string | null | undefined;
    readonly summary: string | null | undefined;
  }>;
  readonly scriptsRun?: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly report?: FactoryInvestigationReport;
  readonly checkResults?: ReadonlyArray<FactoryCheckResult>;
}): FactoryTaskCompletionRecord => {
  const changed = (input.workerArtifacts ?? [])
    .map((item) => item.summary ?? item.path ?? item.label)
    .map((item) => clipText(item ?? undefined, 280))
    .filter((item): item is string => Boolean(item));
  const scriptProof = (input.scriptsRun ?? [])
    .map((item) => clipText(item.summary ?? item.command, 280))
    .filter((item): item is string => Boolean(item));
  const reportProof = input.report
    ? input.report.evidence
      .map((item) => clipText(item.summary ?? item.title, 280))
      .filter((item): item is string => Boolean(item))
    : [];
  const validationProof = (input.checkResults ?? [])
    .map((item) => clipText(`${item.command} exited ${String(item.exitCode ?? 0)}`, 280))
    .filter((item): item is string => Boolean(item));
  return {
    changed: changed.length > 0 ? changed : [input.summary],
    proof: [...new Set([...scriptProof, ...reportProof, ...validationProof])],
    remaining: [],
  };
};

export const renderDeliveryResultText = (input: {
  readonly summary: string;
  readonly handoff: string;
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly completion?: FactoryTaskCompletionRecord;
  readonly alignment?: FactoryTaskAlignmentRecord;
}): string =>
  [
    renderSection("Summary", [input.summary || "No summary recorded."], false),
    renderSection("Handoff", [input.handoff || input.summary || "No handoff recorded."], false),
    renderSection(
      "Scripts Run",
      input.scriptsRun.length
        ? input.scriptsRun.map((item) =>
          `${item.status ?? "ok"}: ${item.command}${item.summary ? ` | ${item.summary}` : ""}`)
        : ["none recorded"],
      true,
    ),
    renderSection(
      "Changed",
      input.completion?.changed.length
        ? input.completion.changed
        : ["none recorded"],
      true,
    ),
    renderSection(
      "Proof",
      input.completion?.proof.length
        ? input.completion.proof
        : ["none recorded"],
      true,
    ),
    renderSection(
      "Remaining",
      input.completion?.remaining.length
        ? input.completion.remaining
        : ["none"],
      true,
    ),
    renderSection(
      "Alignment",
      [
        `Verdict: ${input.alignment?.verdict ?? "aligned"}`,
        ...(input.alignment?.satisfied.length
          ? [`Satisfied: ${input.alignment.satisfied.join(" | ")}`]
          : []),
        ...(input.alignment?.missing.length
          ? [`Missing: ${input.alignment.missing.join(" | ")}`]
          : []),
        ...(input.alignment?.outOfScope.length
          ? [`Out of scope: ${input.alignment.outOfScope.join(" | ")}`]
          : []),
        input.alignment?.rationale ?? "No explicit alignment rationale recorded.",
      ],
      false,
    ),
  ].join("\n\n");

export const renderWorkerHandoffText = (input: {
  readonly summary: string;
  readonly handoff: string;
  readonly details?: ReadonlyArray<string>;
}): string =>
  [
    renderSection("Summary", [input.summary || "No summary recorded."], false),
    renderSection("Handoff", [input.handoff || input.summary || "No handoff recorded."], false),
    ...(input.details?.length
      ? [renderSection("Details", input.details, true)]
      : []),
  ].join("\n\n");

export const renderInvestigationReportText = (
  summary: string,
  report: FactoryInvestigationReport,
  completion?: FactoryTaskCompletionRecord,
  artifactRefs: ReadonlyArray<Readonly<Record<string, GraphRef>>> = [],
  handoff?: string,
): string =>
  [
    renderSection("Conclusion", [report.conclusion || summary || "No conclusion recorded."], false),
    renderSection("Handoff", [handoff || report.conclusion || summary || "No handoff recorded."], false),
    renderSection(
      "Changed",
      completion?.changed.length
        ? completion.changed
        : ["none recorded"],
      true,
    ),
    renderSection(
      "Evidence",
      report.evidence.length
        ? report.evidence.map((item) =>
          `${item.title}: ${item.summary}${item.detail ? ` | ${item.detail}` : ""}`)
        : ["none recorded"],
      true,
    ),
    renderSection(
      "Proof",
      completion?.proof.length
        ? completion.proof
        : ["none recorded"],
      true,
    ),
    renderSection(
      "Disagreements",
      report.disagreements.length ? report.disagreements : ["none"],
      true,
    ),
    renderSection(
      "Scripts Run",
      report.scriptsRun.length
        ? report.scriptsRun.map((item) =>
          `${item.status ?? "ok"}: ${item.command}${item.summary ? ` | ${item.summary}` : ""}`)
        : ["none recorded"],
      true,
    ),
    renderSection(
      "Artifacts",
      artifactLines(artifactRefs).length
        ? artifactLines(artifactRefs)
        : ["none recorded"],
      true,
    ),
    renderSection(
      "Next Steps",
      report.nextSteps.length ? report.nextSteps : ["none"],
      true,
    ),
    renderSection(
      "Remaining",
      completion?.remaining.length
        ? completion.remaining
        : ["none"],
      true,
    ),
  ].join("\n\n");
