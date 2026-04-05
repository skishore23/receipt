import fs from "node:fs/promises";
import path from "node:path";

import type { FactoryExecutionScriptRun, FactoryTaskAlignmentRecord } from "../../modules/factory";

export type FactoryAuditBundleRegion = {
  readonly name: string;
  readonly path?: string;
  readonly summary?: string;
};

export type FactoryAuditBundleFinding = {
  readonly title: string;
  readonly summary: string;
  readonly detail?: string;
};

export type FactoryAuditBundleTimestamps = {
  readonly startedAt: number;
  readonly completedAt: number;
};

export type FactoryAuditBundle = {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly alignment_reported: true;
  readonly alignment: FactoryTaskAlignmentRecord;
  readonly scripts_run: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly structured_evidence: ReadonlyArray<FactoryAuditBundleFinding>;
  readonly proof: ReadonlyArray<string>;
  readonly regions: ReadonlyArray<FactoryAuditBundleRegion>;
  readonly timestamps: FactoryAuditBundleTimestamps;
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value && value.trim().length > 0 ? value.trim() : undefined;

export const buildAuditBundle = (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly regions: ReadonlyArray<FactoryAuditBundleRegion>;
  readonly commandsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly findings: ReadonlyArray<FactoryAuditBundleFinding>;
  readonly timestamps: FactoryAuditBundleTimestamps;
  readonly alignment: FactoryTaskAlignmentRecord;
  readonly proof: ReadonlyArray<string>;
}): FactoryAuditBundle => ({
  objectiveId: input.objectiveId,
  taskId: input.taskId,
  alignment_reported: true,
  alignment: input.alignment,
  scripts_run: input.commandsRun.length > 0
    ? input.commandsRun
    : [{ command: "n/a", summary: "No commands were recorded.", status: "warning" }],
  structured_evidence: input.findings.length > 0
    ? input.findings
    : [{ title: "No structured evidence", summary: "The run did not record structured evidence." }],
  proof: input.proof.map((item) => nonEmpty(item)).filter((item): item is string => Boolean(item)),
  regions: input.regions,
  timestamps: input.timestamps,
});

export const emitAuditBundle = async (bundle: FactoryAuditBundle, outDir: string): Promise<string> => {
  const artifactsDir = path.join(outDir, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  const bundlePath = path.join(artifactsDir, "audit_bundle.json");
  await fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2), "utf-8");
  return bundlePath;
};
