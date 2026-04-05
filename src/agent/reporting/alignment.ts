import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type AlignmentReportPayload = {
  readonly objective_id?: string;
  readonly task_id?: string;
  readonly job_id: string;
  readonly decision_summary: string;
  readonly constraints_checked: ReadonlyArray<string>;
  readonly evidence_refs: ReadonlyArray<string>;
  readonly timestamp: string;
};

export type AlignmentReporter = {
  readonly record: (kind: "alignment", payload: AlignmentReportPayload) => Promise<void> | void;
};

export type AlignmentEmitInput = AlignmentReportPayload & {
  readonly reporter?: AlignmentReporter;
  readonly bufferPath?: string;
};

const defaultBufferPath = (): string =>
  path.join(os.tmpdir(), "receipt-alignment-events.ndjson");

const appendBufferedEvent = async (bufferPath: string | undefined, payload: AlignmentReportPayload): Promise<void> => {
  const target = bufferPath ?? defaultBufferPath();
  const line = `${JSON.stringify({ kind: "alignment", payload })}\n`;
  await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => undefined);
  await fs.appendFile(target, line, "utf-8").catch(() => undefined);
};

export const emitAlignmentEvent = async (input: AlignmentEmitInput): Promise<void> => {
  try {
    await input.reporter?.record("alignment", {
      objective_id: input.objective_id,
      task_id: input.task_id,
      job_id: input.job_id,
      decision_summary: input.decision_summary,
      constraints_checked: input.constraints_checked,
      evidence_refs: input.evidence_refs,
      timestamp: input.timestamp,
    });
  } catch {
    await appendBufferedEvent(input.bufferPath, input);
  }
};

export const makeAlignmentPayload = (input: {
  readonly jobId: string;
  readonly objectiveId?: string;
  readonly taskId?: string;
  readonly decisionSummary: string;
  readonly constraintsChecked?: ReadonlyArray<string>;
  readonly evidenceRefs?: ReadonlyArray<string>;
}): AlignmentReportPayload => ({
  objective_id: input.objectiveId,
  task_id: input.taskId,
  job_id: input.jobId,
  decision_summary: input.decisionSummary,
  constraints_checked: input.constraintsChecked ?? [],
  evidence_refs: input.evidenceRefs ?? [],
  timestamp: new Date().toISOString(),
});
