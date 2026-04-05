import fs from "node:fs/promises";
import path from "node:path";

import type { FactoryExecutionScriptRun, FactoryTaskCompletionRecord } from "../../modules/factory";

export type FactoryAlignmentEvidenceRef = {
  readonly kind: string;
  readonly ref: string;
  readonly label?: string;
  readonly region?: string[];
  readonly capturedAt: number;
};

export type FactoryAlignmentReport = {
  readonly objective_id: string;
  readonly claims: ReadonlyArray<string>;
  readonly evidence_refs: ReadonlyArray<FactoryAlignmentEvidenceRef>;
  readonly scripts_run: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly verdict_rationale: string;
};

class EvidenceRegistry {
  private readonly items: FactoryAlignmentEvidenceRef[] = [];

  add(item: FactoryAlignmentEvidenceRef): void {
    this.items.push(item);
  }

  all(): ReadonlyArray<FactoryAlignmentEvidenceRef> {
    return this.items;
  }
}

export const finalizeAlignment = async (input: {
  readonly objectiveId: string;
  readonly workspacePath: string;
  readonly taskId: string;
  readonly completion: FactoryTaskCompletionRecord;
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly evidenceRefs: ReadonlyArray<{ readonly kind: string; readonly ref: string; readonly label?: string; readonly region?: string[] }>;
  readonly verdictRationale: string;
}): Promise<FactoryAlignmentReport> => {
  const claims = [
    ...input.completion.changed,
    ...input.completion.proof,
  ].map((item) => item.trim()).filter(Boolean);
  const registry = new EvidenceRegistry();
  for (const ref of input.evidenceRefs) {
    registry.add({ ...ref, capturedAt: Date.now() });
  }
  if (claims.length > 0 && registry.all().length === 0) {
    throw new Error(`finalize_alignment() produced no evidence for ${input.objectiveId}`);
  }
  const report: FactoryAlignmentReport = {
    objective_id: input.objectiveId,
    claims,
    evidence_refs: registry.all(),
    scripts_run: [...input.scriptsRun],
    verdict_rationale: input.verdictRationale,
  };
  const reportDir = path.join(input.workspacePath, ".receipt", "factory");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, `${input.taskId}.alignment.json`), JSON.stringify(report, null, 2), "utf-8");
  return report;
};
