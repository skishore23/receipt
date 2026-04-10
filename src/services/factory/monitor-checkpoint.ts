import { z } from "zod";
import type { FactoryObjectiveMode, FactoryTaskExecutionPhase } from "../../modules/factory";
import type { MonitorRecommendation } from "../../modules/factory/events";

const MonitorSubtaskSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  dependsOn: z.array(z.string()).nullable(),
});

export const MonitorCheckpointResultSchema = z.object({
  assessment: z.enum(["progressing", "stalled", "off_track", "failing"]),
  reasoning: z.string(),
  recommendation: z.object({
    kind: z.enum(["continue", "recommend_steer", "recommend_split", "recommend_abort", "recommend_enter_synthesizing"]),
    guidance: z.string().nullable(),
    subtasks: z.array(MonitorSubtaskSchema).min(2).max(5).nullable(),
    reason: z.string().nullable(),
  }),
});

export type MonitorCheckpointResult = {
  readonly assessment: "progressing" | "stalled" | "off_track" | "failing";
  readonly reasoning: string;
  readonly recommendation: MonitorRecommendation;
};

export const parseMonitorRecommendation = (
  flat: z.infer<typeof MonitorCheckpointResultSchema>["recommendation"],
): MonitorRecommendation => {
  switch (flat.kind) {
    case "continue": return { kind: "continue" };
    case "recommend_steer": return { kind: "recommend_steer", guidance: flat.guidance ?? "" };
    case "recommend_split": return {
      kind: "recommend_split",
      subtasks: (flat.subtasks ?? []).map((subtask) => ({
        title: subtask.title,
        prompt: subtask.prompt,
        ...(subtask.dependsOn ? { dependsOn: subtask.dependsOn } : {}),
      })),
    };
    case "recommend_abort": return { kind: "recommend_abort", reason: flat.reason ?? "" };
    case "recommend_enter_synthesizing": return { kind: "recommend_enter_synthesizing", reason: flat.reason ?? "" };
  }
};

const PROPORTIONALITY_RULES = [
  "Proportionality: for investigation tasks, the worker should answer the question as fast as possible.",
  "If the worker is building new scripts, helpers, or infrastructure instead of running existing tools or raw CLI commands, that is off_track.",
  "If evidence artifacts already exist (evidencePresent=true) but the worker is still running commands instead of producing its final JSON result, recommend entering synthesizing immediately.",
  "A worker that reads 3+ files or runs 5+ commands before attempting the primary evidence query is over-engineering.",
];

const EVIDENCE_STEER_GUIDANCE = [
  "Evidence artifacts already exist. Do not rerun helpers or launch new external queries.",
  "You may inspect the local evidence files already present under .receipt/factory/evidence and the task packet.",
  "Produce your final structured JSON result immediately using that evidence.",
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
  readonly taskExecutionPhase?: FactoryTaskExecutionPhase;
}): { readonly system: string; readonly user: string } => {
  const elapsedMinutes = (input.elapsedMs / 60_000).toFixed(1);
  const isInvestigation = input.objectiveMode === "investigation";

  const systemLines = [
    "You are a task progress monitor for an autonomous coding agent.",
    "Evaluate whether the worker is making meaningful progress on its assigned task.",
    "Respond with an assessment and a recommendation.",
    "",
    "Assessment options:",
    "- progressing: Worker is actively making useful changes toward the goal.",
    "- stalled: Worker has stopped making meaningful progress (stuck in loops, no output).",
    "- off_track: Worker is editing unrelated code or drifting from the task scope. This includes over-engineering: building new tooling, scripts, or helpers when existing ones or raw CLI would suffice.",
    "- failing: Worker is in a persistent error state with no recovery.",
    "",
    "Recommendation options:",
    "- continue: Let the worker keep going for another checkpoint interval.",
    "- recommend_steer: Recommend a one-time control-owned correction with clear guidance. Use when the worker is off_track before evidence is sufficient.",
    "- recommend_split: Recommend splitting the task into 2-5 smaller subtasks. Use dependsOn with the subtask's index (\"0\", \"1\", etc.) to express ordering.",
    "- recommend_abort: Recommend stopping the worker because recovery appears impossible without operator intervention.",
    "- recommend_enter_synthesizing: Evidence is already sufficient or likely sufficient; recommend that control stop evidence collection and dispatch a bounded synthesize-only pass.",
    "",
    "Prefer recommend_enter_synthesizing over continue when the worker has evidence but is not finalizing.",
    "If the task execution phase is already synthesizing, do not recommend another redirect just to repeat the same finish-now guidance.",
    "Prefer recommend_steer over recommend_split when the worker just needs redirection.",
    "Prefer recommend_split over recommend_abort when the task is decomposable.",
  ];

  if (isInvestigation) {
    systemLines.push("", "## Investigation-Mode Rules", ...PROPORTIONALITY_RULES);
  }

  const userLines = [
    `## Task (checkpoint ${input.checkpoint}, elapsed ${elapsedMinutes} minutes, mode: ${input.objectiveMode ?? "unknown"}, execution phase: ${input.taskExecutionPhase ?? "collecting_evidence"})`,
    "",
    input.taskPrompt,
    "",
  ];

  if (input.evidencePresent) {
    userLines.push(
      "## Evidence Status",
      "Evidence artifacts are PRESENT in the evidence directory. The worker has collected data.",
      isInvestigation
        ? `If the worker is still running commands or building tooling, recommend entering synthesizing with: "${EVIDENCE_STEER_GUIDANCE}"`
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
