import type { FactoryParsedRun } from "../parse";

const formatDurationMs = (durationMs: number | undefined): string => {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "n/a";
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
};

export const renderFactoryParsedRunText = (parsed: FactoryParsedRun): string => {
  const lines = [
    `${parsed.resolved.kind}: ${parsed.resolved.stream}`,
    `Status: ${parsed.summary.status ?? "unknown"}${parsed.summary.title ? ` · ${parsed.summary.title}` : ""}`,
    parsed.summary.text ? `Summary: ${parsed.summary.text}` : undefined,
    parsed.window.durationMs !== undefined ? `Duration: ${formatDurationMs(parsed.window.durationMs)}` : undefined,
    parsed.links.objectiveId ? `Objective: ${parsed.links.objectiveId}` : undefined,
    parsed.links.chatId ? `Chat: ${parsed.links.chatId}` : undefined,
    parsed.links.runId ? `Run: ${parsed.links.runId}` : undefined,
    parsed.links.jobId ? `Job: ${parsed.links.jobId}` : undefined,
    parsed.links.taskId ? `Task: ${parsed.links.taskId}` : undefined,
    parsed.links.candidateId ? `Candidate: ${parsed.links.candidateId}` : undefined,
    "",
    "Timeline:",
    ...parsed.timeline.slice(0, 16).map((item) =>
      `- ${item.at ? new Date(item.at).toISOString() : "n/a"} [${item.source}] ${item.summary}`),
  ].filter((line): line is string => Boolean(line));

  if (parsed.taskRuns.length > 0) {
    lines.push("", "Task Runs:");
    for (const taskRun of parsed.taskRuns) {
      lines.push(`- ${taskRun.jobId} [${taskRun.status}] ${taskRun.summary ?? ""}`.trim());
      if (taskRun.resultFile.exists) lines.push(`  result: ${taskRun.resultFile.resolvedPath}`);
      if (taskRun.stdout.commands.length > 0) lines.push(`  stdout commands: ${taskRun.stdout.commands.length}`);
    }
  }

  if (parsed.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of parsed.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
};
