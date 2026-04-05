import fs from "node:fs/promises";
import path from "node:path";

import type { FactoryCheckResult, FactoryExecutionScriptRun, FactoryTaskAlignmentRecord, FactoryTaskCompletionRecord } from "../../modules/factory";

export type FactoryTaskRunManifest = {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly validationOutputs: ReadonlyArray<FactoryCheckResult>;
  readonly proof: ReadonlyArray<string>;
  readonly alignment?: FactoryTaskAlignmentRecord;
  readonly completion?: FactoryTaskCompletionRecord;
  readonly diagnostics?: ReadonlyArray<string>;
};

export const factoryRunManifestPath = (dataDir: string, objectiveId: string, taskId: string): string =>
  path.join(dataDir, "factory", "artifacts", objectiveId, taskId, "run_manifest.json");

export const createFactoryTaskRunManifest = (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly scriptsRun?: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly validationOutputs?: ReadonlyArray<FactoryCheckResult>;
  readonly proof?: ReadonlyArray<string>;
  readonly alignment?: FactoryTaskAlignmentRecord;
  readonly completion?: FactoryTaskCompletionRecord;
  readonly diagnostics?: ReadonlyArray<string>;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}): FactoryTaskRunManifest => ({
  objectiveId: input.objectiveId,
  taskId: input.taskId,
  candidateId: input.candidateId,
  createdAt: input.createdAt ?? Date.now(),
  updatedAt: input.updatedAt ?? Date.now(),
  scriptsRun: input.scriptsRun ?? [],
  validationOutputs: input.validationOutputs ?? [],
  proof: input.proof ?? [],
  alignment: input.alignment,
  completion: input.completion,
  diagnostics: input.diagnostics ?? [],
});

export const ensureFactoryTaskRunManifest = async (input: {
  readonly path: string;
  readonly manifest: FactoryTaskRunManifest;
}): Promise<void> => {
  await fs.mkdir(path.dirname(input.path), { recursive: true });
  await fs.writeFile(input.path, JSON.stringify(input.manifest, null, 2), "utf-8");
};

export const validateFactoryTaskRunManifest = (manifest: FactoryTaskRunManifest): ReadonlyArray<string> => {
  const errors: string[] = [];
  if (manifest.scriptsRun.length === 0) errors.push("scriptsRun is empty");
  if (!manifest.alignment) errors.push("alignment is missing");
  if (manifest.proof.length === 0) errors.push("proof is missing");
  return errors;
};
