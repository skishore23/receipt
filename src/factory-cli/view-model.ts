import type { FactoryBoardProjection } from "../services/factory-service.js";

export type FactoryObjectivePanel =
  | "overview"
  | "tasks"
  | "candidates"
  | "evidence"
  | "activity"
  | "live"
  | "debug"
  | "receipts";

export const PANEL_ORDER: readonly FactoryObjectivePanel[] = [
  "overview",
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
