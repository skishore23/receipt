import type { FactoryObjectiveDetail } from "../../services/factory-types";
import type {
  FactoryWorkbenchFocus,
} from "../factory-workbench";
import type {
  FactorySelectedObjectiveCard,
  FactoryWorkbenchWorkspaceModel,
  WorkbenchVersionEnvelope,
} from "../factory-models";
import {
  compactStatusText,
  titleCaseLabel,
} from "./shared";
import {
  buildFactoryWorkbenchSearchParams,
  type FactoryWorkbenchShellBase,
} from "./workbench/route";
import type {
  FactoryWorkbenchHeaderIslandModel,
  FactoryWorkbenchRouteContext,
} from "./workbench/page";
import { formatTs, type Tone } from "../ui";

const NEEDS_INPUT_RE = /\b(waiting on (?:operator|human)|needs? input|need .*guidance|need .*clarification|choose|approval|permission denied|access denied|missing .*details?)\b/i;

export const headerRefreshOn = [
  { event: "profile-board-refresh", throttleMs: 180 },
  { event: "objective-runtime-refresh", throttleMs: 180 },
] as const;

export const railRefreshOn = [
  { event: "profile-board-refresh", throttleMs: 180 },
  { event: "objective-runtime-refresh", throttleMs: 220 },
] as const;

export const focusRefreshOn = [
  { event: "objective-runtime-refresh", throttleMs: 160 },
  { event: "profile-board-refresh", throttleMs: 220 },
] as const;

export const timelineRefreshOn = [
  { event: "agent-refresh", throttleMs: 160 },
  { event: "objective-runtime-refresh", throttleMs: 220 },
] as const;

export type FactoryPreviewDrawerSectionKey =
  | "properties"
  | "self-improvement"
  | "tasks"
  | "artifacts"
  | "receipts"
  | "execution";

export const drawerSectionRefreshOn = (
  section: FactoryPreviewDrawerSectionKey,
) => section === "execution"
  ? [
      { event: "objective-runtime-refresh", throttleMs: 220 },
      { event: "job-refresh", throttleMs: 220 },
    ] as const
  : [
      { event: "objective-runtime-refresh", throttleMs: 220 },
    ] as const;

export type FactoryPreviewRailSectionKey =
  | "active"
  | "needs_attention"
  | "completed"
  | "archived";

export type PreviewStatusKey =
  | "idle"
  | "queued"
  | "running"
  | "blocked"
  | "needs_input"
  | "completed"
  | "failed"
  | "stalled"
  | "archived";

export type PreviewStatusPresentation = {
  readonly key: PreviewStatusKey;
  readonly label: string;
  readonly tone: Tone;
};

export type PreviewStatusInput = {
  readonly displayState?: string;
  readonly status?: string;
  readonly slotState?: string;
  readonly blockedReason?: string;
  readonly blockedExplanation?: string;
  readonly summary?: string;
  readonly nextAction?: string;
  readonly archivedAt?: number;
};

export type PreviewSectionDescriptor = {
  readonly key: FactoryPreviewDrawerSectionKey;
  readonly label: string;
  readonly summary: string;
  readonly openByDefault: boolean;
};

export type PreviewRouteModel = {
  readonly shellBase: FactoryWorkbenchShellBase;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly chat: import("../factory-models").FactoryChatIslandModel;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly expandedRailSections?: ReadonlyArray<FactoryPreviewRailSectionKey>;
};

const PREVIEW_RAIL_SECTIONS: ReadonlyArray<FactoryPreviewRailSectionKey> = [
  "active",
  "needs_attention",
  "completed",
  "archived",
] as const;

export const normalizePreviewRailSections = (
  input: ReadonlyArray<string | FactoryPreviewRailSectionKey> | undefined,
): ReadonlyArray<FactoryPreviewRailSectionKey> => {
  const allowed = new Set<string>(PREVIEW_RAIL_SECTIONS);
  const seen = new Set<string>();
  const normalized: FactoryPreviewRailSectionKey[] = [];
  for (const value of input ?? []) {
    const trimmed = String(value).trim();
    if (!allowed.has(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed as FactoryPreviewRailSectionKey);
  }
  return normalized;
};

export const DRAWER_SECTIONS: ReadonlyArray<PreviewSectionDescriptor> = [
  {
    key: "properties",
    label: "Properties",
    summary: "Owner, phase, status, and compact engineer context.",
    openByDefault: true,
  },
  {
    key: "self-improvement",
    label: "Self Improvement",
    summary: "Current audit recommendation, linked fix state, and apply action.",
    openByDefault: true,
  },
  {
    key: "tasks",
    label: "Tasks",
    summary: "Task state, dependencies, and the current active focus.",
    openByDefault: false,
  },
  {
    key: "artifacts",
    label: "Artifacts",
    summary: "Recent artifacts produced by the current objective.",
    openByDefault: false,
  },
  {
    key: "receipts",
    label: "Recent Receipts",
    summary: "Recent receipt-backed events for the selected objective.",
    openByDefault: false,
  },
  {
    key: "execution",
    label: "Execution Details",
    summary: "Current execution focus, logs, and live output tails.",
    openByDefault: false,
  },
] as const;

export const buildPreviewRouteContext = (input: {
  readonly shellBase: FactoryWorkbenchShellBase;
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly inspectorTab?: "overview" | "chat";
  readonly detailTab: "action" | "review" | "queue";
  readonly page: number;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly filter: FactoryWorkbenchWorkspaceModel["filter"];
}): FactoryWorkbenchRouteContext => ({
  shellBase: input.shellBase,
  profileId: input.profileId,
  chatId: input.chatId,
  objectiveId: input.objectiveId,
  inspectorTab: input.inspectorTab,
  detailTab: input.detailTab,
  page: input.page,
  focusKind: input.focusKind,
  focusId: input.focusId,
  filter: input.filter,
});

export const previewRouteContext = (input: PreviewRouteModel): FactoryWorkbenchRouteContext => buildPreviewRouteContext({
  shellBase: input.shellBase,
  profileId: input.workspace.activeProfileId,
  chatId: input.workspace.chatId,
  objectiveId: input.workspace.objectiveId,
  inspectorTab: input.workspace.inspectorTab,
  detailTab: input.workspace.detailTab,
  page: input.workspace.page,
  focusKind: input.workspace.focusKind,
  focusId: input.workspace.focusId,
  filter: input.workspace.filter,
});

export const buildPreviewSearch = (
  routeContext: FactoryWorkbenchRouteContext,
  expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey> = [],
): string => {
  const params = buildFactoryWorkbenchSearchParams(routeContext);
  const normalizedExpanded = normalizePreviewRailSections(expandedRailSections);
  if (normalizedExpanded.length > 0) {
    params.set("railExpanded", normalizedExpanded.join(","));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
};

export const routeHref = (
  routeContext: FactoryWorkbenchRouteContext,
  overrides: Partial<FactoryWorkbenchRouteContext>,
  expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey> = [],
): string => {
  const nextRouteContext = {
    ...routeContext,
    ...overrides,
    basePath: routeContext.shellBase,
  };
  return `${routeContext.shellBase}${buildPreviewSearch(nextRouteContext, expandedRailSections)}`;
};

export const objectiveHref = (
  routeContext: FactoryWorkbenchRouteContext,
  objectiveId?: string,
  profileId?: string,
  expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey> = [],
): string => routeHref(routeContext, {
  profileId: profileId ?? routeContext.profileId,
  objectiveId,
  focusKind: undefined,
  focusId: undefined,
  page: 1,
}, expandedRailSections);

export const previewHeaderPath = (
  routeContext: FactoryWorkbenchRouteContext,
  expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey> = [],
): string => `${routeContext.shellBase}/island/header${buildPreviewSearch(routeContext, expandedRailSections)}`;

export const previewRailPath = (
  routeContext: FactoryWorkbenchRouteContext,
  expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey> = [],
): string => `${routeContext.shellBase}/island/rail${buildPreviewSearch(routeContext, expandedRailSections)}`;

export const previewFocusPath = (
  routeContext: FactoryWorkbenchRouteContext,
  expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey> = [],
): string => `${routeContext.shellBase}/island/focus${buildPreviewSearch(routeContext, expandedRailSections)}`;

export const previewTimelinePath = (
  routeContext: FactoryWorkbenchRouteContext,
  expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey> = [],
): string => `${routeContext.shellBase}/island/timeline${buildPreviewSearch(routeContext, expandedRailSections)}`;

export const previewDrawerSectionPath = (
  section: FactoryPreviewDrawerSectionKey,
  routeContext: FactoryWorkbenchRouteContext,
  expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey> = [],
): string => `${routeContext.shellBase}/island/drawer/${section}${buildPreviewSearch(routeContext, expandedRailSections)}`;

export const composeAction = (
  routeContext: FactoryWorkbenchRouteContext,
  expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey> = [],
): string => `${routeContext.shellBase}/compose${buildPreviewSearch(routeContext, expandedRailSections)}`;

// Server truth is mapped into a closed presentation algebra before rendering.
// The browser composes these total functions but never owns objective truth.
export const previewStatus = (input?: PreviewStatusInput): PreviewStatusPresentation => {
  if (!input) return { key: "idle", label: "Idle", tone: "neutral" };
  const displayState = input.displayState?.trim().toLowerCase();
  const status = input.status?.trim().toLowerCase();
  const blockedText = [
    input.blockedExplanation,
    input.blockedReason,
    input.summary,
    input.nextAction,
  ].filter((value): value is string => Boolean(value)).join(" ");
  if (input.archivedAt || displayState === "archived") {
    return { key: "archived", label: "Archived", tone: "neutral" };
  }
  if (displayState === "stalled") return { key: "stalled", label: "Stalled", tone: "warning" };
  if (displayState === "failed" || status === "failed") return { key: "failed", label: "Failed", tone: "danger" };
  if (displayState === "completed" || status === "completed" || displayState === "canceled" || status === "canceled") {
    return { key: "completed", label: "Completed", tone: "success" };
  }
  if (displayState === "blocked" || status === "blocked") {
    if (NEEDS_INPUT_RE.test(blockedText)) {
      return { key: "needs_input", label: "Needs Input", tone: "warning" };
    }
    return { key: "blocked", label: "Blocked", tone: "warning" };
  }
  if (displayState === "queued" || input.slotState === "queued") return { key: "queued", label: "Queued", tone: "warning" };
  if (displayState === "draft") return { key: "idle", label: "Idle", tone: "neutral" };
  return { key: "running", label: "Running", tone: "info" };
};

export const previewStatusForObjective = (
  objective?: Pick<
    FactorySelectedObjectiveCard,
    "displayState" | "status" | "slotState" | "blockedReason" | "blockedExplanation" | "summary" | "nextAction"
  >,
): PreviewStatusPresentation => previewStatus(objective
  ? {
      displayState: objective.displayState,
      status: objective.status,
      slotState: objective.slotState,
      blockedReason: objective.blockedReason,
      blockedExplanation: objective.blockedExplanation,
      summary: objective.summary,
      nextAction: objective.nextAction,
    }
  : undefined);

export const previewStatusForBoardObjective = (
  objective: FactoryWorkbenchWorkspaceModel["board"]["objectives"][number],
): PreviewStatusPresentation => previewStatus({
  displayState: objective.displayState,
  status: objective.status,
  slotState: objective.scheduler.slotState,
  blockedReason: objective.blockedReason,
  blockedExplanation: objective.blockedExplanation?.summary,
  summary: objective.latestSummary,
  nextAction: objective.nextAction,
  archivedAt: objective.archivedAt,
});

const STRUCTURED_PAYLOAD_RE = /(^\s*[{[]|"(command|stderr|stdout|aggregated_output|payload|json|args)"\s*:|\\n|\\")/i;

const readableSummary = (value?: string): string => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (!STRUCTURED_PAYLOAD_RE.test(trimmed)) return trimmed;
  const summaryMatch = trimmed.match(/"(summary|message|latestNote|note|text)"\s*:\s*"([^"]+)"/i);
  if (summaryMatch?.[2]) return summaryMatch[2];
  return "";
};

const firstReadableSummary = (...values: ReadonlyArray<string | undefined>): string => {
  for (const value of values) {
    const readable = readableSummary(value);
    if (readable) return readable;
  }
  return "";
};

export const latestObjectiveSummary = (
  objective?: Pick<
    FactorySelectedObjectiveCard,
    "bottomLine" | "summary" | "nextAction" | "blockedExplanation" | "blockedReason"
  >,
): string => {
  const value = firstReadableSummary(
    objective?.bottomLine,
    objective?.summary,
    objective?.nextAction,
    objective?.blockedExplanation,
    objective?.blockedReason,
  );
  return compactStatusText(value || "No summary yet.", 180) || "No summary yet.";
};

export const objectiveRowSummary = (
  objective: FactoryWorkbenchWorkspaceModel["board"]["objectives"][number],
): string => {
  const value = firstReadableSummary(
    objective.latestSummary,
    objective.nextAction,
    objective.blockedExplanation?.summary,
    objective.blockedReason,
    objective.title,
  );
  return compactStatusText(value || "No summary yet.", 120) || "No summary yet.";
};

export const engineerInitials = (label?: string): string => {
  const parts = (label ?? "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "RF";
  const initials = parts.slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
  return initials || "RF";
};

export const relativeTime = (ts?: number, now = Date.now()): string => {
  if (!ts || !Number.isFinite(ts)) return "";
  const deltaMs = now - ts;
  const seconds = Math.max(1, Math.floor(Math.abs(deltaMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatTs(ts);
};

export const activeJobCount = (workspace: FactoryWorkbenchWorkspaceModel): number => {
  const fromWorkbench = workspace.workbench?.jobs.filter((job) =>
    job.running || job.status === "queued" || job.status === "running"
  ).length;
  if (typeof fromWorkbench === "number" && fromWorkbench > 0) return fromWorkbench;
  return [
    workspace.activeCodex,
    ...(workspace.liveChildren ?? []),
  ].filter((item) => Boolean(item?.running || item?.status === "queued" || item?.status === "running")).length;
};

export const currentComposerJobId = (workspace: FactoryWorkbenchWorkspaceModel): string =>
  workspace.workbench?.focus?.jobId
    ?? workspace.activeCodex?.jobId
    ?? workspace.liveChildren?.find((child) => child.running || child.status === "queued" || child.status === "running")?.jobId
    ?? "";

export const latestProgressSummary = (workspace: FactoryWorkbenchWorkspaceModel): string => {
  const value = firstReadableSummary(
    workspace.workbench?.focus?.summary,
    workspace.activeRun?.summary,
    workspace.activeCodex?.latestNote,
    latestObjectiveSummary(workspace.selectedObjective),
  );
  return compactStatusText(value || "Waiting for the next meaningful update.", 140)
    || "Waiting for the next meaningful update.";
};

export const latestHeartbeatAt = (workspace: FactoryWorkbenchWorkspaceModel): number | undefined => {
  const values = [
    workspace.workbench?.focus?.updatedAt,
    workspace.activeRun?.updatedAt,
    workspace.activeCodex?.updatedAt,
    ...(workspace.liveChildren ?? []).map((child) => child.updatedAt),
    workspace.selectedObjective?.updatedAt,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return undefined;
  return Math.max(...values);
};

export const previewPaneTitle = (workspace: FactoryWorkbenchWorkspaceModel): string =>
  workspace.selectedObjective?.title ?? "Select an objective";

export const ribbonSegments = (workspace: FactoryWorkbenchWorkspaceModel): ReadonlyArray<string> => {
  const presentation = previewStatusForObjective(workspace.selectedObjective);
  const segments = [presentation.label];
  const jobs = activeJobCount(workspace);
  if (jobs > 0) segments.push(`${jobs} job${jobs === 1 ? "" : "s"} active`);
  segments.push(`latest: ${latestProgressSummary(workspace)}`);
  if (presentation.key === "stalled") {
    segments.push("no recent worker heartbeat");
  } else {
    const heartbeatAt = latestHeartbeatAt(workspace);
    if (heartbeatAt) segments.push(`updated ${relativeTime(heartbeatAt)}`);
  }
  return segments;
};

export const sortByUpdatedAtDesc = <T extends { readonly updatedAt?: number }>(
  entries: ReadonlyArray<T> | undefined,
): ReadonlyArray<T> => [...(entries ?? [])].sort((left, right) =>
  (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

export const executionSummary = (focus?: FactoryWorkbenchFocus): string =>
  compactStatusText(focus?.summary ?? focus?.lastMessage ?? "No execution summary yet.", 180)
  || "No execution summary yet.";

export const detailPresentationStatus = (
  objective?: FactoryObjectiveDetail | FactorySelectedObjectiveCard,
): PreviewStatusPresentation => previewStatus(objective
  ? {
      displayState: objective.displayState,
      status: objective.status,
      slotState: "scheduler" in objective ? objective.scheduler.slotState : objective.slotState,
      blockedReason: objective.blockedReason,
      blockedExplanation: "blockedExplanation" in objective
        ? typeof objective.blockedExplanation === "string"
          ? objective.blockedExplanation
          : objective.blockedExplanation?.summary
        : undefined,
      summary: "summary" in objective ? objective.summary : objective.latestSummary,
      nextAction: objective.nextAction,
      archivedAt: "archivedAt" in objective ? objective.archivedAt : undefined,
    }
  : undefined);
