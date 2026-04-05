import type { FactoryEvidenceRecord } from "../../../modules/factory";
import {
  FACTORY_EVIDENCE_RECORD_MAP_SCHEMA,
} from "../result-contracts";

export const FACTORY_EVIDENCE_RECORD_SCHEMA = {
  type: "object",
  properties: {
    objective_id: { type: "string" },
    task_id: { type: "string" },
    timestamp: { type: "number" },
    tool_name: { type: "string" },
    command_or_api: { type: "string" },
    inputs: FACTORY_EVIDENCE_RECORD_MAP_SCHEMA,
    outputs: FACTORY_EVIDENCE_RECORD_MAP_SCHEMA,
    summary_metrics: FACTORY_EVIDENCE_RECORD_MAP_SCHEMA,
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
