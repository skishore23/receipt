import fs from "node:fs";
import path from "node:path";

export type FactoryBootstrapContext = {
  readonly objectiveId?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
};

export type FactoryBootstrapFinalizerInput = {
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly phase: "bootstrap";
  readonly status: "succeeded" | "failed_or_exiting";
  readonly error?: unknown;
  readonly context?: FactoryBootstrapContext;
};

export type FactoryBootstrapArtifact = {
  readonly root: string;
  readonly jsonPath: string;
  readonly textPath: string;
};

const stringifyError = (error: unknown): string | undefined => {
  if (error == null) return undefined;
  if (error instanceof Error) return error.stack ?? error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
};

export const readBootstrapContext = (): FactoryBootstrapContext => ({
  objectiveId: process.env.FACTORY_OBJECTIVE_ID?.trim() || process.env.RECEIPT_OBJECTIVE_ID?.trim() || undefined,
  taskId: process.env.FACTORY_TASK_ID?.trim() || process.env.RECEIPT_TASK_ID?.trim() || undefined,
  candidateId: process.env.FACTORY_CANDIDATE_ID?.trim() || process.env.RECEIPT_CANDIDATE_ID?.trim() || undefined,
});

export const bootstrapArtifactPaths = (repoRoot: string, dataDir: string): FactoryBootstrapArtifact => {
  const root = path.join(repoRoot, ".receipt", "factory", "spool");
  return {
    root,
    jsonPath: path.join(root, `bootstrap-${path.basename(dataDir)}-${process.pid}.json`),
    textPath: path.join(root, `bootstrap-${path.basename(dataDir)}-${process.pid}.md`),
  };
};

export const writeBootstrapSpool = (input: FactoryBootstrapFinalizerInput): FactoryBootstrapArtifact => {
  const artifact = bootstrapArtifactPaths(input.repoRoot, input.dataDir);
  fs.mkdirSync(artifact.root, { recursive: true });
  const payload = {
    phase: input.phase,
    status: input.status,
    at: new Date().toISOString(),
    pid: process.pid,
    context: input.context ?? readBootstrapContext(),
    error: stringifyError(input.error),
  };
  fs.writeFileSync(artifact.jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  fs.writeFileSync(
    artifact.textPath,
    [
      `phase: ${payload.phase}`,
      `status: ${payload.status}`,
      `at: ${payload.at}`,
      `pid: ${payload.pid}`,
      payload.context.objectiveId ? `objectiveId: ${payload.context.objectiveId}` : undefined,
      payload.context.taskId ? `taskId: ${payload.context.taskId}` : undefined,
      payload.context.candidateId ? `candidateId: ${payload.context.candidateId}` : undefined,
      payload.error ? `error: ${payload.error}` : undefined,
    ].filter(Boolean).join("\n") + "\n",
    "utf-8",
  );
  return artifact;
};

export const emitBootstrapFinalizer = async (input: FactoryBootstrapFinalizerInput): Promise<FactoryBootstrapArtifact> => {
  const artifact = writeBootstrapSpool(input);
  await Promise.resolve();
  return artifact;
};
