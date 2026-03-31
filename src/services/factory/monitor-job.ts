import fsp from "node:fs/promises";
import {
  buildMonitorCheckpointPrompt,
  type MonitorCheckpointResult,
} from "./monitor-checkpoint";

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

export type MonitorJobContext = {
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly taskPrompt: string;
  readonly elapsedMs: number;
  readonly checkpoint: number;
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
  });

  return ctx.evaluateLlm(prompt);
};
