import type {
  FactoryEvidencePackFinding,
  FactoryEvidencePackMetric,
  FactoryEvidencePackRecord,
  FactoryEvidencePackSource,
  FactoryTaskAlignmentRecord,
  FactoryTaskCompletionRecord,
  FactoryExecutionScriptRun,
  FactoryCheckResult,
} from "../../modules/factory";

const stringArray = (items: ReadonlyArray<string>): ReadonlyArray<string> =>
  items.filter((item) => item.trim().length > 0).map((item) => item.trim());

export const FACTORY_EVIDENCE_PACK_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "integer", const: 1 },
    objectiveId: { type: "string" },
    taskId: { type: "string" },
    candidateId: { type: "string" },
    generatedAt: { type: "number" },
    normalizedFindings: {
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
    metrics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "string" },
          unit: { type: ["string", "null"] },
          timeRange: { type: ["string", "null"] },
        },
        required: ["name", "value", "unit", "timeRange"],
        additionalProperties: false,
      },
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["query_id", "file_path", "aws_api", "other"] },
          ref: { type: "string" },
          summary: { type: ["string", "null"] },
        },
        required: ["kind", "ref", "summary"],
        additionalProperties: false,
      },
    },
    conclusion: {
      type: "object",
      properties: {
        summary: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        alignmentVerdict: { type: "string", enum: ["aligned", "uncertain", "drifted"] },
      },
      required: ["summary", "confidence", "alignmentVerdict"],
      additionalProperties: false,
    },
    openQuestions: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["version", "objectiveId", "taskId", "candidateId", "generatedAt", "normalizedFindings", "metrics", "sources", "conclusion", "openQuestions"],
  additionalProperties: false,
} as const;

export const buildFactoryEvidencePack = (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly summary: string;
  readonly completion: FactoryTaskCompletionRecord;
  readonly alignment: FactoryTaskAlignmentRecord;
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly checkResults: ReadonlyArray<FactoryCheckResult>;
  readonly artifactRefs: ReadonlyArray<Readonly<Record<string, { readonly kind: string; readonly ref: string; readonly label?: string }>>>;
  readonly generatedAt: number;
}): FactoryEvidencePackRecord => {
  const normalizedFindings: FactoryEvidencePackFinding[] = [
    {
      title: "Run summary",
      summary: input.summary,
      detail: input.alignment.rationale,
    },
    ...input.completion.changed.map((item) => ({
      title: "Changed path",
      summary: item,
      detail: "Reported as changed in completion.",
    })),
  ];

  const metrics: FactoryEvidencePackMetric[] = [
    {
      name: "changed_items",
      value: String(input.completion.changed.length),
      unit: "items",
      timeRange: "task completion",
    },
    {
      name: "proof_items",
      value: String(input.completion.proof.length),
      unit: "items",
      timeRange: "task completion",
    },
    {
      name: "script_runs",
      value: String(input.scriptsRun.length),
      unit: "runs",
      timeRange: "task execution",
    },
    {
      name: "checks",
      value: String(input.checkResults.length),
      unit: "checks",
      timeRange: "task validation",
    },
  ];

  const sources: FactoryEvidencePackSource[] = [
    ...input.artifactRefs.flatMap((refs) =>
      Object.values(refs).flatMap((ref) => ref.ref ? [{
        kind: ref.kind === "aws_api" || ref.kind === "query_id" || ref.kind === "file_path" ? ref.kind : "other",
        ref: ref.ref,
        summary: ref.label ?? null,
      }] : [])
    ),
  ];

  return {
    version: 1,
    objectiveId: input.objectiveId,
    taskId: input.taskId,
    candidateId: input.candidateId,
    generatedAt: input.generatedAt,
    normalizedFindings,
    metrics,
    sources: sources.length > 0 ? sources : [{ kind: "other", ref: "task-result", summary: "No granular source refs were available." }],
    conclusion: {
      summary: input.summary,
      confidence: input.alignment.verdict === "aligned" ? "high" : "medium",
      alignmentVerdict: input.alignment.verdict,
    },
    openQuestions: stringArray(input.completion.remaining),
  };
};
