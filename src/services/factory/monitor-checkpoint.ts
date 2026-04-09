import { z } from "zod";
import type { FactoryObjectiveMode } from "../../modules/factory";
import type { MonitorCheckpointAction } from "../../modules/factory/events";

const MonitorSubtaskSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  dependsOn: z.array(z.string()).nullable(),
});

export const MonitorCheckpointResultSchema = z.object({
  assessment: z.enum(["progressing", "stalled", "off_track", "failing"]),
  reasoning: z.string(),
  action: z.object({
    kind: z.enum(["continue", "steer", "split", "abort"]),
    guidance: z.string().nullable(),
    subtasks: z.array(MonitorSubtaskSchema).min(2).max(5).nullable(),
    reason: z.string().nullable(),
  }),
});

export type MonitorCheckpointResult = {
  readonly assessment: "progressing" | "stalled" | "off_track" | "failing";
  readonly reasoning: string;
  readonly action: MonitorCheckpointAction;
};

export const parseMonitorCheckpointAction = (
  flat: z.infer<typeof MonitorCheckpointResultSchema>["action"],
): MonitorCheckpointAction => {
  switch (flat.kind) {
    case "continue": return { kind: "continue" };
    case "steer": return { kind: "steer", guidance: flat.guidance ?? "" };
    case "split": return {
      kind: "split",
      subtasks: (flat.subtasks ?? []).map((subtask) => ({
        title: subtask.title,
        prompt: subtask.prompt,
        ...(subtask.dependsOn ? { dependsOn: subtask.dependsOn } : {}),
      })),
    };
    case "abort": return { kind: "abort", reason: flat.reason ?? "" };
  }
};

const PROPORTIONALITY_RULES = [
  "Proportionality: for investigation tasks, the worker should answer the question as fast as possible.",
  "If the worker is building new scripts, helpers, or infrastructure instead of running existing tools or raw CLI commands, that is off_track.",
  "If evidence artifacts already exist (evidencePresent=true) but the worker is still running commands instead of producing its final JSON result, steer it to finish immediately.",
  "A worker that reads 3+ files or runs 5+ commands before attempting the primary evidence query is over-engineering.",
];

const EVIDENCE_STEER_GUIDANCE = [
  "Evidence artifacts already exist. Stop all further tool calls.",
  "Produce your final structured JSON result immediately using the evidence you have collected.",
  "Do not refine, re-run, or polish. Synthesize what you have into the result contract now.",
].join(" ");

export const buildMonitorCheckpointPrompt = (input: {
  readonly taskPrompt: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly elapsedMs: number;
  readonly checkpoint: number;
  readonly evidencePresent?: boolean;
  readonly objectiveMode?: FactoryObjectiveMode;
}): { readonly system: string; readonly user: string } => {
  const elapsedMinutes = (input.elapsedMs / 60_000).toFixed(1);
  const isInvestigation = input.objectiveMode === "investigation";

  const systemLines = [
    "You are a task progress monitor for an autonomous coding agent.",
    "Evaluate whether the worker is making meaningful progress on its assigned task.",
    "Respond with an assessment and an action.",
    "",
    "Assessment options:",
    "- progressing: Worker is actively making useful changes toward the goal.",
    "- stalled: Worker has stopped making meaningful progress (stuck in loops, no output).",
    "- off_track: Worker is editing unrelated code or drifting from the task scope. This includes over-engineering: building new tooling, scripts, or helpers when existing ones or raw CLI would suffice.",
    "- failing: Worker is in a persistent error state with no recovery.",
    "",
    "Action options:",
    "- continue: Let the worker keep going for another checkpoint interval.",
    "- steer: Restart the worker with guidance to correct course. Provide clear, actionable guidance. Use when off_track or when evidence is ready but the worker keeps churning.",
    "- split: The task is too large for one worker. Provide 2-5 smaller subtasks that together accomplish the original task. Each subtask gets its own worker. Use dependsOn with the subtask's index (\"0\", \"1\", etc.) to express ordering.",
    "- abort: Stop the worker. The task needs human attention. Use only when recovery is impossible.",
    "",
    "Prefer steer over continue when the worker has evidence but is not synthesizing.",
    "Prefer steer over split when the worker just needs redirection.",
    "Prefer split over abort when the task is decomposable.",
  ];

  if (isInvestigation) {
    systemLines.push("", "## Investigation-Mode Rules", ...PROPORTIONALITY_RULES);
  }

  const userLines = [
    `## Task (checkpoint ${input.checkpoint}, elapsed ${elapsedMinutes} minutes, mode: ${input.objectiveMode ?? "unknown"})`,
    "",
    input.taskPrompt,
    "",
  ];

  if (input.evidencePresent) {
    userLines.push(
      "## Evidence Status",
      "Evidence artifacts are PRESENT in the evidence directory. The worker has collected data.",
      isInvestigation
        ? `If the worker is still running commands or building tooling, steer it with: "${EVIDENCE_STEER_GUIDANCE}"`
        : "The worker should be moving toward producing its final result.",
      "",
    );
  }

  userLines.push(
    "## Recent stdout (last ~2000 chars)",
    "",
    input.stdoutTail || "(no output)",
    "",
    "## Recent stderr",
    "",
    input.stderrTail || "(no errors)",
  );

  return { system: systemLines.join("\n"), user: userLines.join("\n") };
};
