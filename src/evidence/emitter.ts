import fs from "node:fs/promises";
import path from "node:path";

import type { FactoryCheckResult, FactoryExecutionScriptRun } from "../modules/factory";

export type EvidenceCommandRecord = {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: number;
  readonly finishedAt: number;
};

export type EvidenceRecord = {
  readonly orderedCommands: ReadonlyArray<EvidenceCommandRecord>;
  readonly artifactPaths: ReadonlyArray<string>;
  readonly verdict: "passed" | "failed" | "not_run";
};

export type ExecutionSignalsRecord = {
  readonly scriptsRun: ReadonlyArray<FactoryExecutionScriptRun>;
  readonly verdict: EvidenceRecord["verdict"];
  readonly artifactPaths: ReadonlyArray<string>;
};

export const EVIDENCE_RECORD_SCHEMA = {
  type: "object",
  properties: {
    orderedCommands: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          exitCode: { type: ["number", "null"] },
          stdout: { type: "string" },
          stderr: { type: "string" },
          startedAt: { type: "number" },
          finishedAt: { type: "number" },
        },
        required: ["command", "exitCode", "stdout", "stderr", "startedAt", "finishedAt"],
        additionalProperties: false,
      },
    },
    artifactPaths: { type: "array", items: { type: "string" } },
    verdict: { type: "string", enum: ["passed", "failed", "not_run"] },
  },
  required: ["orderedCommands", "artifactPaths", "verdict"],
  additionalProperties: false,
} as const;

const DEFAULT_TAIL_CHARS = 4_000;

const clipText = (value: string, maxChars = DEFAULT_TAIL_CHARS): string =>
  value.length <= maxChars ? value : value.slice(value.length - maxChars);

export const evidenceDirForWorkspace = (workspacePath: string): string =>
  path.join(workspacePath, ".receipt", "factory");

export const buildEvidenceRecord = (input: {
  readonly checkResults: ReadonlyArray<FactoryCheckResult>;
  readonly artifactPaths?: ReadonlyArray<string>;
}): EvidenceRecord => {
  const orderedCommands = input.checkResults.map((check) => ({
    command: check.command,
    exitCode: check.exitCode,
    stdout: clipText(check.stdout),
    stderr: clipText(check.stderr),
    startedAt: check.startedAt,
    finishedAt: check.finishedAt,
  }));
  const failed = input.checkResults.find((check) => !check.ok);
  return {
    orderedCommands,
    artifactPaths: [...new Set(input.artifactPaths ?? [])],
    verdict: failed ? "failed" : (orderedCommands.length > 0 ? "passed" : "not_run"),
  };
};

export const buildExecutionSignalsRecord = (input: {
  readonly checkResults: ReadonlyArray<FactoryCheckResult>;
  readonly artifactPaths?: ReadonlyArray<string>;
}): ExecutionSignalsRecord => ({
  scriptsRun: input.checkResults.map((check) => ({
    command: check.command,
    summary: check.ok ? "Passed." : `Failed with exit ${String(check.exitCode ?? "unknown")}.`,
    status: check.ok ? "ok" : "error",
  })),
  verdict: buildEvidenceRecord(input).verdict,
  artifactPaths: [...new Set(input.artifactPaths ?? [])],
});

export const writeEvidenceArtifacts = async (input: {
  readonly workspacePath: string;
  readonly checkResults: ReadonlyArray<FactoryCheckResult>;
  readonly artifactPaths?: ReadonlyArray<string>;
}): Promise<{ readonly evidencePath: string; readonly executionSignalsPath: string }> => {
  const root = evidenceDirForWorkspace(input.workspacePath);
  await fs.mkdir(root, { recursive: true });
  const evidencePath = path.join(root, "evidence.json");
  const executionSignalsPath = path.join(root, "execution_signals.json");
  const evidence = buildEvidenceRecord(input);
  const executionSignals = buildExecutionSignalsRecord(input);
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");
  await fs.writeFile(executionSignalsPath, `${JSON.stringify(executionSignals, null, 2)}\n`, "utf-8");
  return { evidencePath, executionSignalsPath };
};
