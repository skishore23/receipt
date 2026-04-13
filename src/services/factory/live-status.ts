import type {
  FactoryLiveProjection,
  FactoryObjectiveDetail,
  FactoryTaskView,
} from "../factory-types";

type FactoryLoadingTone = "info" | "warning" | "danger" | "success";

export type FactoryObjectiveLoadingState = {
  readonly label: string;
  readonly summary: string;
  readonly detail?: string;
  readonly highlights?: ReadonlyArray<string>;
  readonly nextAction?: string;
  readonly tone: FactoryLoadingTone;
};

const normalizeInline = (value: string | undefined): string | undefined =>
  value?.replace(/\s+/g, " ").trim() || undefined;

const truncateText = (value: string | undefined, max = 140): string | undefined => {
  const text = normalizeInline(value);
  if (!text) return undefined;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
};

const labelize = (value: string | undefined): string =>
  (value ?? "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

const formatDuration = (ms: number | undefined): string | undefined => {
  if (!ms || ms < 1_000) return undefined;
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
};

const extractCommand = (value: string): string | undefined => {
  const runningPrefix = "Running command:";
  const completedPrefix = "Command completed:";
  if (value.startsWith(runningPrefix)) return value.slice(runningPrefix.length).trim();
  if (value.startsWith(completedPrefix)) return value.slice(completedPrefix.length).trim();
  return undefined;
};

const summarizeCommand = (command: string | undefined): string | undefined => {
  if (!command) return undefined;
  if (/runner\.py list\b/.test(command)) return "Inspecting available helpers";
  if (/runner\.py run\b/.test(command) && /--service ec2\b/.test(command) && /--resource instances\b/.test(command)) {
    return /--all-regions\b/.test(command)
      ? "Querying EC2 instances across regions"
      : "Querying EC2 instances";
  }
  const service = command.match(/--service\s+([a-z0-9-]+)/i)?.[1];
  const resource = command.match(/--resource\s+([a-z0-9-]+)/i)?.[1];
  if (service && resource) return `Querying AWS ${service} ${resource}`;
  if (/\baws\b/.test(command)) return "Running AWS command";
  if (/\b(bun|node|python3?|ruby)\b/.test(command)) return "Running repo command";
  return undefined;
};

const sentenceFromPhrase = (value: string): string => {
  const trimmed = value.trim().replace(/[.]+$/, "");
  if (!trimmed) return "";
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
};

const summarizeSignal = (value: string | undefined): string | undefined => {
  const text = normalizeInline(value);
  if (!text) return undefined;
  if (text.startsWith("{\"type\":") || text.includes("\"type\":\"item.")) return undefined;
  if (text.startsWith("{") || text.startsWith("[") || text.includes("\"completion\":")) {
    return "Preparing the final result.";
  }
  const command = extractCommand(text);
  if (command) {
    const summary = summarizeCommand(command);
    if (text.startsWith("Running command:")) return summary ? sentenceFromPhrase(summary) : "Running a command.";
    return summary ? `Finished ${summary.toLowerCase()}.` : "Finished the previous step.";
  }
  if (text.startsWith("Recent task artifact:")) return "Writing evidence artifacts.";
  const boldHeading = text.match(/^\*\*(.+?)\*\*/)?.[1];
  if (boldHeading) return sentenceFromPhrase(boldHeading);
  const firstSentence = text.match(/^(.{1,160}?[.!?])(?:\s|$)/)?.[1];
  return truncateText(firstSentence ?? text, 160);
};

const taskDetail = (task: Pick<FactoryTaskView, "taskId" | "status" | "jobStatus" | "elapsedMs"> | undefined): string | undefined => {
  if (!task) return undefined;
  const rawStatus = task.jobStatus ?? task.status;
  const status = rawStatus === "leased"
    ? "running"
    : labelize(rawStatus).toLowerCase();
  const elapsed = formatDuration(task.elapsedMs);
  return [task.taskId, status, elapsed].filter(Boolean).join(" · ");
};

const summarizeArtifactActivity = (
  activity: ReadonlyArray<Pick<FactoryTaskView["artifactActivity"][number], "label" | "updatedAt">> | undefined,
): string | undefined => {
  if (!activity?.length) return undefined;
  const latest = [...activity].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!latest) return undefined;
  return activity.length === 1
    ? `Artifact updated: ${latest.label}`
    : `${activity.length} artifacts updated · latest ${latest.label}`;
};

const summarizeRecentReceipt = (
  detail: Pick<FactoryObjectiveDetail, "recentReceipts" | "latestDecision">,
): string | undefined => {
  const latestReceipt = [...detail.recentReceipts]
    .reverse()
    .find((receipt) => !receipt.type.startsWith("objective.control."));
  if (!latestReceipt) return undefined;
  const summary = truncateText(latestReceipt.summary, 96) ?? latestReceipt.type;
  return `Recent receipt: ${summary}`;
};

const summarizeActiveJobs = (
  live: Pick<FactoryLiveProjection, "recentJobs"> | undefined,
): string | undefined => {
  const activeJobs = (live?.recentJobs ?? []).filter((job) =>
    job.status === "running" || job.status === "queued" || job.status === "leased");
  if (!activeJobs.length) return undefined;
  const labels = activeJobs
    .slice(0, 2)
    .map((job) => `${job.agentId} ${labelize(job.status).toLowerCase()}`);
  const extra = activeJobs.length > labels.length ? ` +${activeJobs.length - labels.length}` : "";
  return `Active jobs: ${labels.join(" · ")}${extra}`;
};

const phaseMeta = (
  detail: Pick<FactoryObjectiveDetail, "displayState" | "phase" | "phaseDetail" | "status">,
): { readonly label: string; readonly summary: string; readonly tone: FactoryLoadingTone } => {
  switch (detail.phaseDetail ?? detail.phase) {
    case "draft":
      return { label: "Drafting objective", summary: "Preparing the objective before dispatch.", tone: "info" };
    case "waiting_for_slot":
      return { label: "Queued", summary: "Waiting for the repo execution slot.", tone: "info" };
    case "waiting_for_control":
      return { label: "Reconciling", summary: "Controller is deciding the next step.", tone: "info" };
    case "collecting_evidence":
      return { label: "Collecting evidence", summary: "Gathering evidence for the active task.", tone: "info" };
    case "evidence_ready":
      return { label: "Evidence ready", summary: "Evidence is ready and synthesis is next.", tone: "success" };
    case "synthesizing":
      return { label: "Synthesizing", summary: "Turning evidence into a final answer.", tone: "info" };
    case "integrating":
      return { label: "Integrating", summary: "Applying the approved changes and validating them.", tone: "info" };
    case "waiting_for_promotion":
      return { label: "Waiting for promotion", summary: "Approved work is queued for promotion.", tone: "info" };
    case "promoting":
      return { label: "Publishing", summary: "Publishing the promoted result.", tone: "info" };
    case "awaiting_review":
      return { label: "Awaiting review", summary: "Waiting for the current pass to be reviewed.", tone: "warning" };
    case "blocked":
      return { label: "Blocked", summary: "Waiting for operator guidance before continuing.", tone: "warning" };
    case "stalled":
      return { label: "Stalled", summary: "Execution stopped making visible progress.", tone: "danger" };
    case "cleaning_up":
      return { label: "Cleaning up", summary: "Retiring lingering jobs and workspaces.", tone: "info" };
    case "completed":
      return { label: "Completed", summary: "Objective finished successfully.", tone: "success" };
    case "failed":
      return { label: "Failed", summary: "Objective failed.", tone: "danger" };
    case "canceled":
      return { label: "Canceled", summary: "Objective was canceled.", tone: "warning" };
    default:
      return { label: labelize(detail.displayState ?? detail.phase ?? detail.status), summary: "Objective state updated.", tone: "info" };
  }
};

export const summarizeFactoryTaskSignal = (
  task: Pick<FactoryTaskView, "lastMessage" | "stdoutTail" | "stderrTail" | "artifactSummary" | "latestSummary">,
): string => {
  return (
    summarizeSignal(task.lastMessage)
    ?? summarizeSignal(task.artifactSummary)
    ?? summarizeSignal(task.latestSummary)
    ?? summarizeSignal(task.stdoutTail)
    ?? summarizeSignal(task.stderrTail)
    ?? "Waiting for visible task output."
  );
};

export const buildFactoryObjectiveLoadingState = (input: {
  readonly detail: Pick<
    FactoryObjectiveDetail,
    "displayState" | "status" | "phase" | "phaseDetail" | "nextAction" | "latestSummary" | "tasks" | "recentReceipts" | "latestDecision"
  >;
  readonly live?: Pick<FactoryLiveProjection, "activeTasks" | "recentJobs">;
}): FactoryObjectiveLoadingState => {
  const meta = phaseMeta(input.detail);
  const activeTask = input.live?.activeTasks[0]
    ?? input.detail.tasks.find((task) => task.status === "running" || task.status === "reviewing");
  const signal = activeTask ? summarizeFactoryTaskSignal(activeTask) : summarizeSignal(input.detail.latestSummary);
  const nextAction = truncateText(input.detail.nextAction, 180);
  const detail = taskDetail(activeTask);
  const shouldPreferSignal = (input.detail.phaseDetail ?? input.detail.phase) === "collecting_evidence"
    || (input.detail.phaseDetail ?? input.detail.phase) === "synthesizing"
    || (input.detail.phaseDetail ?? input.detail.phase) === "integrating"
    || (input.detail.phaseDetail ?? input.detail.phase) === "promoting";
  const summary = shouldPreferSignal && signal ? signal : meta.summary;
  const highlights = [
    summarizeActiveJobs(input.live),
    summarizeArtifactActivity(activeTask?.artifactActivity),
    summarizeRecentReceipt(input.detail),
  ].filter((value): value is string => Boolean(value && value !== summary));
  return {
    label: meta.label,
    summary,
    detail,
    ...(highlights.length > 0 ? { highlights } : {}),
    nextAction: nextAction && nextAction !== summary ? nextAction : undefined,
    tone: meta.tone,
  };
};
