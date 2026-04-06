import fs from "node:fs/promises";
import path from "node:path";

import type { FactoryExecutionScriptRun, FactoryTaskAlignmentRecord, FactoryTaskCompletionRecord } from "../modules/factory";

export type FactoryEvidenceArtifact = {
  readonly label: string;
  readonly path: string | null;
  readonly summary: string | null;
};

export type FactoryEvidenceCommand = {
  readonly command: string;
  readonly summary?: string;
  readonly status?: FactoryExecutionScriptRun["status"];
};

export type FactoryEvidenceBundle = {
  readonly objective_id: string;
  readonly task_id: string;
  readonly candidate_id: string;
  readonly plan_summary: string;
  readonly alignment: FactoryTaskAlignmentRecord;
  readonly completion: FactoryTaskCompletionRecord;
  readonly commands_run: ReadonlyArray<FactoryEvidenceCommand>;
  readonly artifacts: ReadonlyArray<FactoryEvidenceArtifact>;
  readonly links: ReadonlyArray<string>;
  readonly timestamps: {
    readonly created_at: number;
    readonly updated_at: number;
  };
};

const tail = (value: string | undefined, max = 800): string | undefined => {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length <= max ? text : `...${text.slice(text.length - max)}`;
};

const readTextIfPresent = async (filePath: string): Promise<string | undefined> =>
  fs.readFile(filePath, "utf-8").catch(() => undefined);

export const writeAlignmentMarkdown = async (input: {
  readonly rootDir: string;
  readonly goal: string;
  readonly constraints: ReadonlyArray<string>;
  readonly definitionOfDone: ReadonlyArray<string>;
  readonly assumptions: ReadonlyArray<string>;
}): Promise<string> => {
  const alignmentPath = path.join(input.rootDir, "alignment.md");
  const lines = [
    "# Alignment",
    "",
    `## Goal`,
    input.goal,
    "",
    `## Constraints`,
    ...input.constraints.map((item) => `- ${item}`),
    "",
    `## Definition of Done`,
    ...input.definitionOfDone.map((item) => `- ${item}`),
    "",
    `## Assumptions`,
    ...input.assumptions.map((item) => `- ${item}`),
    "",
  ];
  await fs.writeFile(alignmentPath, lines.join("\n"), "utf-8");
  return alignmentPath;
};

export const readCommandsRun = async (commandsRunPath: string): Promise<ReadonlyArray<FactoryEvidenceCommand>> => {
  const raw = await readTextIfPresent(commandsRunPath);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.command !== "string") return [];
        return [{
          command: parsed.command,
          summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
          status: parsed.status === "ok" || parsed.status === "warning" || parsed.status === "error" ? parsed.status : undefined,
        }];
      } catch {
        return [];
      }
    });
};

export const buildEvidenceBundle = async (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly planSummary: string;
  readonly alignment: FactoryTaskAlignmentRecord;
  readonly completion: FactoryTaskCompletionRecord;
  readonly commandsRunPath?: string;
  readonly artifactPaths?: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  readonly links?: ReadonlyArray<string>;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}): Promise<FactoryEvidenceBundle> => {
  const commands_run = input.commandsRunPath ? await readCommandsRun(input.commandsRunPath) : [];
  const artifacts = await Promise.all((input.artifactPaths ?? []).map(async (artifact) => ({
    label: artifact.label,
    path: artifact.path,
    summary: tail(await readTextIfPresent(artifact.path)) ?? null,
  })));
  return {
    objective_id: input.objectiveId,
    task_id: input.taskId,
    candidate_id: input.candidateId,
    plan_summary: input.planSummary,
    alignment: input.alignment,
    completion: input.completion,
    commands_run,
    artifacts,
    links: input.links ?? [],
    timestamps: {
      created_at: input.createdAt ?? Date.now(),
      updated_at: input.updatedAt ?? Date.now(),
    },
  };
};
