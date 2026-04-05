import type { FactoryEvidenceRecord } from "../../../modules/factory";

export const FACTORY_EVIDENCE_RECORD_SCHEMA = {
  type: "object",
  properties: {
    objective_id: { type: "string" },
    task_id: { type: "string" },
    timestamp: { type: "number" },
    tool_name: { type: "string" },
    command_or_api: { type: "string" },
    inputs: { type: "object" },
    outputs: { type: "object" },
    summary_metrics: { type: "object" },
  },
  required: ["objective_id", "task_id", "timestamp", "tool_name", "command_or_api", "inputs", "outputs", "summary_metrics"],
  additionalProperties: false,
} as const;

export const sanitizeEvidenceRecord = (record: FactoryEvidenceRecord): FactoryEvidenceRecord => ({
  objective_id: record.objective_id,
  task_id: record.task_id,
  timestamp: record.timestamp,
  tool_name: record.tool_name,
  command_or_api: record.command_or_api,
  inputs: record.inputs,
  outputs: record.outputs,
  summary_metrics: record.summary_metrics,
});

export const hasRequiredEvidence = (records: ReadonlyArray<FactoryEvidenceRecord>): boolean => {
  const metricKeys = new Set(records.flatMap((record) => Object.keys(record.summary_metrics ?? {})));
  return metricKeys.has("regions_scanned") && metricKeys.has("instance_inventory");
};

export const buildEvidenceGateMessage = (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly missing: ReadonlyArray<string>;
}): string =>
  `Evidence gate failed for ${input.objectiveId}/${input.taskId}: missing required evidence keys: ${input.missing.join(", ")}.`;
