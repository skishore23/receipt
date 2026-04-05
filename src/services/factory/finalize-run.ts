import fs from "node:fs/promises";
import path from "node:path";

import { FACTORY_TASK_RESULT_SCHEMA, normalizeTaskAlignmentRecord, normalizeTaskCompletionRecord } from "./result-contracts";
import type {
  FactoryExecutionScriptRun,
  FactoryTaskAlignmentRecord,
  FactoryTaskCompletionRecord,
  FactoryTaskResultOutcome,
} from "../../modules/factory";

export type FactoryTaskFinalizationArtifact = {
  readonly outcome: FactoryTaskResultOutcome;
  readonly summary: string;
  readonly handoff: string;
  readonly artifacts: ReadonlyArray<{
    readonly label: string;
    readonly path: string | null;
    readonly summary: string | null;
  }>;
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly completion: FactoryTaskCompletionRecord;
  readonly alignment: FactoryTaskAlignmentRecord;
  readonly nextAction: string | null;
};

export const buildFactoryTaskFinalizationArtifact = (input: {
  readonly outcome: FactoryTaskResultOutcome;
  readonly summary: string;
  readonly handoff: string;
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly completion?: Partial<FactoryTaskCompletionRecord>;
  readonly alignment?: Partial<FactoryTaskAlignmentRecord>;
  readonly nextAction?: string | null;
  readonly artifacts?: ReadonlyArray<{
    readonly label: string;
    readonly path: string | null;
    readonly summary: string | null;
  }>;
}): FactoryTaskFinalizationArtifact => ({
  outcome: input.outcome,
  summary: input.summary,
  handoff: input.handoff,
  artifacts: input.artifacts ?? [],
  scriptsRun: input.scriptsRun,
  completion: normalizeTaskCompletionRecord(input.completion ?? {}, {
    changed: [],
    proof: [],
    remaining: [],
  }),
  alignment: normalizeTaskAlignmentRecord(input.alignment ?? {}, {
    verdict: "uncertain",
    satisfied: [],
    missing: [],
    outOfScope: [],
    rationale: "Finalization completed without an explicit alignment report.",
  }),
  nextAction: input.nextAction ?? null,
});

export const finalizeFactoryTaskRunArtifact = async (input: {
  readonly resultPath: string;
  readonly schemaPath: string;
  readonly artifact: FactoryTaskFinalizationArtifact;
}): Promise<void> => {
  await fs.mkdir(path.dirname(input.resultPath), { recursive: true });
  await fs.writeFile(input.schemaPath, JSON.stringify(FACTORY_TASK_RESULT_SCHEMA, null, 2), "utf-8");
  await fs.writeFile(input.resultPath, JSON.stringify(input.artifact, null, 2), "utf-8");
};
