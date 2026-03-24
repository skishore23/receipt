import type {
  FactoryBoardProjection,
  FactoryComposeModel,
  FactoryDebugProjection,
  FactoryLiveProjection,
  FactoryObjectiveDetail,
  FactoryTaskView,
} from "../services/factory-service";

export type FactoryObjectivePanel =
  | "overview"
  | "report"
  | "tasks"
  | "candidates"
  | "evidence"
  | "activity"
  | "live"
  | "debug"
  | "receipts";

export const PANEL_ORDER: readonly FactoryObjectivePanel[] = [
  "overview",
  "report",
  "tasks",
  "candidates",
  "evidence",
  "activity",
  "live",
  "debug",
  "receipts",
] as const;

export const PANEL_LABELS: Readonly<Record<FactoryObjectivePanel, string>> = {
  overview: "Overview",
  report: "Report",
  tasks: "Tasks",
  candidates: "Candidates",
  evidence: "Evidence",
  activity: "Activity",
  live: "Live",
  debug: "Debug",
  receipts: "Receipts",
};

export const BOARD_SECTION_META = {
  needs_attention: {
    title: "Needs Attention",
    description: "Blocked or conflicted objectives that need review.",
  },
  active: {
    title: "Active",
    description: "Objectives currently holding the repo execution slot.",
  },
  queued: {
    title: "Queued",
    description: "Objectives waiting for the repo execution slot.",
  },
  completed: {
    title: "Completed",
    description: "Recently finished, canceled, or archived objectives.",
  },
} satisfies Readonly<Record<keyof FactoryBoardProjection["sections"], { readonly title: string; readonly description: string }>>;

export const truncate = (value: string | undefined, max = 120): string => {
  const text = (value ?? "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
};

export const formatTime = (ts: number | undefined): string => {
  if (!ts) return "n/a";
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z").replace("T", " ");
};

export const shortHash = (value: string | undefined): string =>
  value ? value.slice(0, 8) : "none";

export const labelize = (value: string | undefined): string =>
  (value ?? "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

export const formatDuration = (ms: number | undefined): string => {
  if (!ms || ms < 1_000) return "<1s";
  const totalSeconds = Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
};

export const formatList = (values: ReadonlyArray<string>, fallback = "none"): string =>
  values.length ? values.join(" | ") : fallback;

export const flattenObjectives = (
  board: FactoryBoardProjection,
): ReadonlyArray<FactoryBoardProjection["objectives"][number]> => [
  ...board.sections.needs_attention,
  ...board.sections.active,
  ...board.sections.queued,
  ...board.sections.completed,
];

export const budgetPercent = (used: number | undefined, max: number | undefined): number => {
  if (!used || !max || max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / max) * 100)));
};

export const panelIndex = (panel: FactoryObjectivePanel): number =>
  PANEL_ORDER.indexOf(panel) + 1;

export type MissionControlFocusArea = "rail" | "timeline" | "composer";

export type TimelineEntry = {
  readonly id: string;
  readonly kind: "decision" | "task" | "candidate" | "integration" | "blocked" | "operator" | "log" | "system";
  readonly title: string;
  readonly summary: string;
  readonly meta: string;
  readonly at?: number;
  readonly emphasis?: "accent" | "warning" | "danger" | "success" | "muted";
  readonly body?: string;
};

export type MissionControlViewModel = {
  readonly header: {
    readonly repo: string;
    readonly dirty: boolean;
    readonly objectiveCount: number;
    readonly checks: string;
    readonly queueSummary: string;
    readonly profileSummary: string;
    readonly selectedObjectiveLabel: string;
  };
  readonly timeline: {
    readonly title: string;
    readonly subtitle: string;
    readonly entries: ReadonlyArray<TimelineEntry>;
    readonly emptyTitle: string;
    readonly emptyMessage: string;
  };
  readonly composer: {
    readonly title: string;
    readonly subtitle: string;
    readonly placeholder: string;
    readonly submitHint: string;
  };
};

const emphasisForReceipt = (type: string): TimelineEntry["emphasis"] => {
  if (type === "objective.operator.noted") return "accent";
  if (type.includes("blocked") || type.includes("conflicted")) return "warning";
  if (type.includes("failed") || type.includes("error")) return "danger";
  if (type.includes("promoted") || type.includes("ready_to_promote") || type.includes("completed")) return "success";
  if (type.includes("rebracket")) return "accent";
  return "muted";
};

const kindForReceipt = (type: string): TimelineEntry["kind"] =>
  type === "rebracket.applied" ? "decision"
  : type === "objective.operator.noted" ? "operator"
  : type.startsWith("task.") ? "task"
  : type.startsWith("candidate.") ? "candidate"
  : type.startsWith("integration.") || type.startsWith("merge.") ? "integration"
  : type.includes("blocked") || type.includes("failed") ? "blocked"
  : "system";

const liveLogEntries = (tasks: ReadonlyArray<FactoryTaskView>): ReadonlyArray<TimelineEntry> =>
  tasks.flatMap((task) => {
    const entries: TimelineEntry[] = [];
    if (task.lastMessage?.trim()) {
      entries.push({
        id: `${task.taskId}:last`,
        kind: "log",
        title: `${task.taskId} last message`,
        summary: truncate(task.lastMessage, 220),
        body: truncate(task.lastMessage, 460),
        meta: `${labelize(task.jobStatus ?? task.status)} · live`,
        emphasis: "accent",
      });
    }
    if (task.stdoutTail?.trim()) {
      entries.push({
        id: `${task.taskId}:stdout`,
        kind: "log",
        title: `${task.taskId} stdout`,
        summary: truncate(task.stdoutTail, 220),
        body: truncate(task.stdoutTail, 460),
        meta: `${labelize(task.jobStatus ?? task.status)} · stdout`,
        emphasis: "muted",
      });
    }
    if (task.stderrTail?.trim()) {
      entries.push({
        id: `${task.taskId}:stderr`,
        kind: "log",
        title: `${task.taskId} stderr`,
        summary: truncate(task.stderrTail, 220),
        body: truncate(task.stderrTail, 460),
        meta: `${labelize(task.jobStatus ?? task.status)} · stderr`,
        emphasis: "danger",
      });
    }
    return entries;
  });

export const buildMissionControlViewModel = (opts: {
  readonly compose: FactoryComposeModel;
  readonly board: FactoryBoardProjection;
  readonly detail?: FactoryObjectiveDetail;
  readonly live?: FactoryLiveProjection;
  readonly debug?: FactoryDebugProjection;
}): MissionControlViewModel => {
  const selected = opts.detail;
  const live = opts.live;
  const receiptEntries = selected?.recentReceipts.map((receipt) => ({
    id: receipt.hash,
    kind: kindForReceipt(receipt.type),
    title: labelize(receipt.type),
    summary: truncate(receipt.summary, 220),
    body: truncate(receipt.summary, 420),
    meta: [
      formatTime(receipt.ts),
      receipt.taskId,
      receipt.candidateId,
      shortHash(receipt.hash),
    ].filter(Boolean).join(" · "),
    at: receipt.ts,
    emphasis: emphasisForReceipt(receipt.type),
  })) ?? [];
  const logEntries = live ? liveLogEntries(live.activeTasks).map((entry, index) => ({
    ...entry,
    id: `${entry.id}:${index}`,
  })) : [];
  const queueSummary = `${opts.board.sections.active.length} active · ${opts.board.sections.queued.length} queued`;
  const selectedObjectiveLabel = selected
    ? `${selected.title} · ${labelize(selected.phase)}`
    : opts.board.selectedObjectiveId
      ? opts.board.selectedObjectiveId
      : "No objective selected";
  return {
    header: {
      repo: opts.compose.sourceBranch ?? opts.compose.defaultBranch,
      dirty: opts.compose.sourceDirty,
      objectiveCount: opts.compose.objectiveCount,
      checks: formatList(opts.compose.defaultValidationCommands, "none"),
      queueSummary,
      profileSummary: opts.compose.profileSummary,
      selectedObjectiveLabel,
    },
    timeline: {
      title: selected ? selected.title : "Factory timeline",
      subtitle: selected?.nextAction ?? selected?.latestSummary ?? "Select an objective or describe a new one below.",
      entries: [...receiptEntries, ...logEntries].slice(-18),
      emptyTitle: opts.compose.objectiveCount === 0 ? "No objectives yet" : "No timeline yet",
      emptyMessage: opts.compose.objectiveCount === 0
        ? (opts.compose.sourceDirty
          ? "Commit or stash changes first, then describe the objective in the composer below."
          : "Describe the first objective in the composer below or use /new.")
        : "Select an objective from the rail to see its timeline.",
    },
    composer: {
      title: selected ? `React to ${selected.objectiveId}` : "Create a new objective",
      subtitle: selected ? "Plain text reacts to the selected objective. Use /help for commands." : "Plain text creates a new objective.",
      placeholder: selected
        ? "Write guidance for the selected objective or type /help"
        : "Describe the change you want Factory to make",
      submitHint: selected ? "Enter send · Shift+Enter newline" : "Enter create objective · Shift+Enter newline",
    },
  };
};
