import fs from "node:fs/promises";
import path from "node:path";

import type {
  FactoryExecutionScriptRun,
  FactoryTaskAlignmentRecord,
  FactoryTaskCompletionRecord,
} from "../../modules/factory";

export type FactoryAlignmentReport = {
  readonly objective_id: string;
  readonly task_id: string;
  readonly planned_steps: ReadonlyArray<string>;
  readonly actual_steps: ReadonlyArray<string>;
  readonly evidence_refs: ReadonlyArray<string>;
  readonly aligned: boolean;
  readonly rationale: string;
  readonly alignment: FactoryTaskAlignmentRecord;
  readonly completion?: FactoryTaskCompletionRecord;
  readonly created_at: number;
};

const uniqueStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))];

export const buildFactoryAlignmentReport = (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly plannedSteps: ReadonlyArray<string>;
  readonly actualSteps: ReadonlyArray<string>;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly completion?: FactoryTaskCompletionRecord;
  readonly alignment?: FactoryTaskAlignmentRecord;
}): FactoryAlignmentReport => {
  if (!input.completion && !input.alignment) {
    return {
      objective_id: input.objectiveId,
      task_id: input.taskId,
      planned_steps: uniqueStrings(input.plannedSteps),
      actual_steps: uniqueStrings(input.actualSteps),
      evidence_refs: uniqueStrings(input.evidenceRefs),
      aligned: false,
      rationale: "The task exited before a structured result was produced.",
      alignment: {
        verdict: "drifted",
        satisfied: [],
        missing: ["Structured result not produced."],
        outOfScope: [],
        rationale: "The task exited before a structured result was produced.",
      },
      created_at: Date.now(),
    };
  }
  const alignment = input.alignment ?? {
    verdict: "aligned",
    satisfied: [],
    missing: [],
    outOfScope: [],
    rationale: "The task completed with an explicit alignment report.",
  };
  const aligned = alignment.verdict === "aligned" && alignment.missing.length === 0;
  const rationale = aligned
    ? alignment.rationale
    : `Reported verdict ${alignment.verdict}; ${alignment.missing.length > 0 ? `missing ${alignment.missing.join(" | ")}.` : alignment.rationale}`;
  return {
    objective_id: input.objectiveId,
    task_id: input.taskId,
    planned_steps: uniqueStrings(input.plannedSteps),
    actual_steps: uniqueStrings(input.actualSteps),
    evidence_refs: uniqueStrings(input.evidenceRefs),
    aligned,
    rationale,
    alignment,
    completion: input.completion,
    created_at: Date.now(),
  };
};

export const writeFactoryAlignmentReport = async (input: {
  readonly reportPath: string;
  readonly report: FactoryAlignmentReport;
}): Promise<void> => {
  await fs.mkdir(path.dirname(input.reportPath), { recursive: true });
  await fs.writeFile(input.reportPath, `${JSON.stringify(input.report, null, 2)}\n`, "utf-8");
};
