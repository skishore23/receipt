import fsp from "node:fs/promises";
import {
  buildMonitorCheckpointPrompt,
  type MonitorCheckpointResult,
} from "./monitor-checkpoint";
import type { FactoryObjectiveMode, FactoryObjectiveSeverity, FactoryTaskExecutionPhase } from "../../modules/factory";

const LOG_TAIL_CHARS = 2_000;

const readTail = async (filePath: string, maxChars: number): Promise<string> => {
  try {
    const content = await fsp.readFile(filePath, "utf-8");
    if (content.length <= maxChars) return content;
    return content.slice(content.length - maxChars);
  } catch {
    return "";
  }
};

const INVESTIGATION_CHECKPOINT_MS = 6 * 60 * 1_000;
const DELIVERY_CHECKPOINT_MS = 10 * 60 * 1_000;
const HIGH_SEVERITY_CHECKPOINT_MS = 90 * 1_000;

export const monitorCheckpointIntervalMs = (
  objectiveMode: FactoryObjectiveMode,
  severity: FactoryObjectiveSeverity,
): number => {
  if (severity <= 1) return HIGH_SEVERITY_CHECKPOINT_MS;
  if (objectiveMode === "investigation") return INVESTIGATION_CHECKPOINT_MS;
  return DELIVERY_CHECKPOINT_MS;
};

export const monitorDetectEvidence = async (evidenceDir: string): Promise<boolean> => {
  try {
    const entries = await fsp.readdir(evidenceDir);
    return entries.some((entry) => entry.endsWith(".json") || entry.endsWith(".md"));
  } catch {
    return false;
  }
};

export type MonitorJobContext = {
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly taskPrompt: string;
  readonly elapsedMs: number;
  readonly checkpoint: number;
  readonly evidencePresent?: boolean;
  readonly objectiveMode?: FactoryObjectiveMode;
  readonly taskExecutionPhase?: FactoryTaskExecutionPhase;
  readonly evaluateLlm: (prompt: { system: string; user: string }) => Promise<MonitorCheckpointResult>;
};

export const runMonitorCheckpoint = async (
  ctx: MonitorJobContext,
): Promise<MonitorCheckpointResult> => {
  const stdoutTail = await readTail(ctx.stdoutPath, LOG_TAIL_CHARS);
  const stderrTail = await readTail(ctx.stderrPath, LOG_TAIL_CHARS);

  const prompt = buildMonitorCheckpointPrompt({
    taskPrompt: ctx.taskPrompt,
    stdoutTail,
    stderrTail,
    elapsedMs: ctx.elapsedMs,
    checkpoint: ctx.checkpoint,
    evidencePresent: ctx.evidencePresent,
    objectiveMode: ctx.objectiveMode,
    taskExecutionPhase: ctx.taskExecutionPhase,
  });

  return ctx.evaluateLlm(prompt);
};
