import { z } from "zod";

const MonitorSubtaskSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  dependsOn: z.array(z.string()).optional(),
});

export const MonitorCheckpointResultSchema = z.object({
  assessment: z.enum(["progressing", "stalled", "off_track", "failing"]),
  reasoning: z.string(),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("continue") }),
    z.object({ kind: z.literal("steer"), guidance: z.string() }),
    z.object({ kind: z.literal("split"), subtasks: z.array(MonitorSubtaskSchema).min(2).max(5) }),
    z.object({ kind: z.literal("abort"), reason: z.string() }),
  ]),
});

export type MonitorCheckpointResult = z.infer<typeof MonitorCheckpointResultSchema>;

export const buildMonitorCheckpointPrompt = (input: {
  readonly taskPrompt: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly elapsedMs: number;
  readonly checkpoint: number;
}): { readonly system: string; readonly user: string } => {
  const elapsedMinutes = (input.elapsedMs / 60_000).toFixed(1);
  return {
    system: [
      "You are a task progress monitor for an autonomous coding agent.",
      "Evaluate whether the worker is making meaningful progress on its assigned task.",
      "Respond with an assessment and an action.",
      "",
      "Assessment options:",
      "- progressing: Worker is actively making useful changes toward the goal.",
      "- stalled: Worker has stopped making meaningful progress (stuck in loops, no output).",
      "- off_track: Worker is editing unrelated code or drifting from the task scope.",
      "- failing: Worker is in a persistent error state with no recovery.",
      "",
      "Action options:",
      "- continue: Let the worker keep going for another checkpoint interval.",
      "- steer: Restart the worker with guidance to correct course. Use when off_track.",
      "- split: The task is too large for one worker. Provide 2-5 smaller subtasks that together accomplish the original task. Each subtask gets its own worker. Use dependsOn with the subtask's index (\"0\", \"1\", etc.) to express ordering.",
      "- abort: Stop the worker. The task needs human attention. Use only when recovery is impossible.",
      "",
      "Prefer continue when there is any sign of useful activity.",
      "Prefer steer over split when the worker just needs redirection.",
      "Prefer split over abort when the task is decomposable.",
    ].join("\n"),
    user: [
      `## Task (checkpoint ${input.checkpoint}, elapsed ${elapsedMinutes} minutes)`,
      "",
      input.taskPrompt,
      "",
      "## Recent stdout (last ~2000 chars)",
      "",
      input.stdoutTail || "(no output)",
      "",
      "## Recent stderr",
      "",
      input.stderrTail || "(no errors)",
    ].join("\n"),
  };
};
