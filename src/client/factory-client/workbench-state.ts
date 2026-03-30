import {
  DEFAULT_FACTORY_WORKBENCH_FILTER,
  type FactoryWorkbenchFilterKey,
} from "../../views/factory-models";

export type { FactoryWorkbenchFilterKey };

export type FactoryWorkbenchInspectorTab = "overview" | "chat" | "notes";
export type FactoryWorkbenchDetailTab = "action" | "review" | "queue";

export type FactoryWorkbenchFocusKind = "task" | "job";

export type FactoryWorkbenchRouteState = {
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly inspectorTab: FactoryWorkbenchInspectorTab;
  readonly detailTab: FactoryWorkbenchDetailTab;
  readonly filter: FactoryWorkbenchFilterKey;
  readonly focusKind?: FactoryWorkbenchFocusKind;
  readonly focusId?: string;
  readonly routeKey: string;
};

export type FactoryWorkbenchLiveOverlay = {
  readonly statusLabel: "Queued" | "Starting" | "Working";
  readonly summary: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly savedAt: number;
};

export type FactoryWorkbenchUiState = {
  readonly desiredRoute: FactoryWorkbenchRouteState;
  readonly appliedRoute: FactoryWorkbenchRouteState;
  readonly liveOverlay?: FactoryWorkbenchLiveOverlay;
};

export type FactoryWorkbenchAction =
  | { readonly type: "boot"; readonly route: FactoryWorkbenchRouteState }
  | {
      readonly type: "session.replayed";
      readonly route: FactoryWorkbenchRouteState;
      readonly liveOverlay?: FactoryWorkbenchLiveOverlay;
    }
  | { readonly type: "route.requested"; readonly route: FactoryWorkbenchRouteState }
  | { readonly type: "route.applied"; readonly route: FactoryWorkbenchRouteState }
  | { readonly type: "inspector.changed"; readonly route: FactoryWorkbenchRouteState }
  | { readonly type: "filter.changed"; readonly route: FactoryWorkbenchRouteState }
  | { readonly type: "focus.changed"; readonly route: FactoryWorkbenchRouteState }
  | { readonly type: "composer.queued"; readonly liveOverlay: FactoryWorkbenchLiveOverlay }
  | {
      readonly type: "composer.acknowledged";
      readonly runId?: string;
      readonly jobId?: string;
      readonly terminal?: boolean;
    };

export type FactoryWorkbenchReplaySnapshot = {
  readonly savedAt: number;
  readonly route: {
    readonly profileId: string;
    readonly chatId: string;
    readonly objectiveId?: string;
    readonly inspectorTab?: FactoryWorkbenchInspectorTab;
    readonly detailTab?: FactoryWorkbenchDetailTab;
    readonly filter?: FactoryWorkbenchFilterKey;
    readonly focusKind?: FactoryWorkbenchFocusKind;
    readonly focusId?: string;
  };
  readonly liveOverlay?: FactoryWorkbenchLiveOverlay;
};

const DEFAULT_PROFILE = "generalist";
const DEFAULT_INSPECTOR_TAB: FactoryWorkbenchInspectorTab = "overview";
const DEFAULT_DETAIL_TAB: FactoryWorkbenchDetailTab = "action";
const DEFAULT_FILTER = DEFAULT_FACTORY_WORKBENCH_FILTER;
const REPLAY_TTL_MS = 30 * 60_000;
const LIVE_OVERLAY_TTL_MS = 60_000;

const isInspectorTab = (value: unknown): value is FactoryWorkbenchInspectorTab =>
  value === "overview" || value === "chat" || value === "notes";

const normalizeWorkbenchInspectorTab = (
  value: FactoryWorkbenchInspectorTab | string | undefined,
): FactoryWorkbenchInspectorTab =>
  value === "chat" ? "chat" : "overview";

const isDetailTab = (value: unknown): value is FactoryWorkbenchDetailTab =>
  value === "action" || value === "review" || value === "queue";

const isFilter = (value: unknown): value is FactoryWorkbenchFilterKey =>
  value === "objective.running"
  || value === "objective.needs_attention"
  || value === "objective.queued"
  || value === "objective.completed";

const normalizeFilterInput = (value: unknown): FactoryWorkbenchFilterKey => {
  if (value === "all") return DEFAULT_FILTER;
  return isFilter(value) ? value : DEFAULT_FILTER;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const createSearchParams = (input?: string): {
  set: (key: string, value: string) => void;
  toString: () => string;
} => {
  if (typeof URLSearchParams !== "undefined") return new URLSearchParams(input);
  const entries = new Map<string, string>();
  const source = typeof input === "string" ? input.replace(/^\?/, "") : "";
  for (const chunk of source.split("&")) {
    if (!chunk) continue;
    const [rawKey, rawValue = ""] = chunk.split("=");
    entries.set(decodeURIComponent(rawKey), decodeURIComponent(rawValue));
  }
  return {
    set(key: string, value: string) {
      entries.set(key, value);
    },
    toString() {
      return Array.from(entries.entries())
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
    },
  };
};

export const workbenchRouteKey = (input: {
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly inspectorTab?: FactoryWorkbenchInspectorTab;
  readonly detailTab?: FactoryWorkbenchDetailTab;
  readonly filter?: FactoryWorkbenchFilterKey;
  readonly focusKind?: FactoryWorkbenchFocusKind;
  readonly focusId?: string;
}): string => {
  const params = createSearchParams();
  params.set("profile", input.profileId);
  params.set("chat", input.chatId);
  if (input.objectiveId) params.set("objective", input.objectiveId);
  if (input.inspectorTab && input.inspectorTab !== DEFAULT_INSPECTOR_TAB) params.set("inspectorTab", input.inspectorTab);
  if (input.detailTab) params.set("detailTab", input.detailTab);
  if (input.filter && input.filter !== DEFAULT_FILTER) params.set("filter", input.filter);
  if (input.focusKind && input.focusId) {
    params.set("focusKind", input.focusKind);
    params.set("focusId", input.focusId);
  }
  const query = params.toString();
  return `/factory${query ? `?${query}` : ""}`;
};

export const createWorkbenchRouteState = (input: {
  readonly profileId?: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly inspectorTab?: FactoryWorkbenchInspectorTab | string;
  readonly detailTab?: FactoryWorkbenchDetailTab | string;
  readonly filter?: FactoryWorkbenchFilterKey | string;
  readonly focusKind?: FactoryWorkbenchFocusKind | string;
  readonly focusId?: string;
}): FactoryWorkbenchRouteState => {
  const focusKind = input.focusKind === "task" || input.focusKind === "job"
    ? input.focusKind
    : undefined;
  const focusId = focusKind ? asString(input.focusId) : undefined;
  const routeInput: Omit<FactoryWorkbenchRouteState, "routeKey"> = {
    profileId: asString(input.profileId) ?? DEFAULT_PROFILE,
    chatId: asString(input.chatId) ?? "",
    objectiveId: asString(input.objectiveId),
    inspectorTab: isInspectorTab(input.inspectorTab)
      ? normalizeWorkbenchInspectorTab(input.inspectorTab)
      : DEFAULT_INSPECTOR_TAB,
    detailTab: isDetailTab(input.detailTab) ? input.detailTab : DEFAULT_DETAIL_TAB,
    filter: normalizeFilterInput(input.filter),
    focusKind: focusKind && focusId ? focusKind : undefined,
    focusId: focusKind && focusId ? focusId : undefined,
  };
  return {
    ...routeInput,
    routeKey: workbenchRouteKey(routeInput),
  };
};

export const routeStateFromUrl = (url: URL): FactoryWorkbenchRouteState =>
  createWorkbenchRouteState({
    profileId: asString(url.searchParams.get("profile")) ?? DEFAULT_PROFILE,
    chatId: asString(url.searchParams.get("chat")) ?? "",
    objectiveId: asString(url.searchParams.get("objective")),
    inspectorTab: asString(url.searchParams.get("inspectorTab")),
    detailTab: asString(url.searchParams.get("detailTab")),
    filter: asString(url.searchParams.get("filter")),
    focusKind: asString(url.searchParams.get("focusKind")),
    focusId: asString(url.searchParams.get("focusId")),
  });

export const routeSearch = (route: FactoryWorkbenchRouteState): string => {
  const key = route.routeKey;
  const queryIndex = key.indexOf("?");
  return queryIndex >= 0 ? key.slice(queryIndex) : "";
};

export const classifyWorkbenchRouteChange = (
  current: FactoryWorkbenchRouteState,
  next: FactoryWorkbenchRouteState,
): "noop" | "scope" | "filter" | "focus" | "inspector" => {
  if (current.routeKey === next.routeKey) return "noop";
  if (
    current.profileId !== next.profileId
    || current.chatId !== next.chatId
    || current.objectiveId !== next.objectiveId
  ) {
    return "scope";
  }
  if (current.detailTab !== next.detailTab) return "scope";
  if (current.filter !== next.filter) return "filter";
  if (current.focusKind !== next.focusKind || current.focusId !== next.focusId) return "focus";
  if (current.inspectorTab !== next.inspectorTab) return "inspector";
  return "scope";
};

export const createWorkbenchUiState = (route: FactoryWorkbenchRouteState): FactoryWorkbenchUiState => ({
  desiredRoute: route,
  appliedRoute: route,
});

export const workbenchReducer = (
  state: FactoryWorkbenchUiState,
  action: FactoryWorkbenchAction,
): FactoryWorkbenchUiState => {
  switch (action.type) {
    case "boot":
      return createWorkbenchUiState(action.route);
    case "session.replayed":
      return {
        ...state,
        desiredRoute: action.route,
        appliedRoute: action.route,
        liveOverlay: action.liveOverlay,
      };
    case "route.requested":
      return {
        ...state,
        desiredRoute: action.route,
      };
    case "route.applied":
      return {
        ...state,
        desiredRoute: action.route,
        appliedRoute: action.route,
      };
    case "inspector.changed":
    case "filter.changed":
    case "focus.changed":
      return {
        ...state,
        desiredRoute: action.route,
        appliedRoute: action.route,
      };
    case "composer.queued":
      return {
        ...state,
        liveOverlay: action.liveOverlay,
      };
    case "composer.acknowledged": {
      if (!state.liveOverlay) return state;
      if (action.terminal) {
        return {
          ...state,
          liveOverlay: undefined,
        };
      }
      const runMatches = state.liveOverlay.runId && action.runId && state.liveOverlay.runId === action.runId;
      const jobMatches = state.liveOverlay.jobId && action.jobId && state.liveOverlay.jobId === action.jobId;
      const unlabeledAck = !state.liveOverlay.runId && !state.liveOverlay.jobId && (action.runId || action.jobId);
      if (!runMatches && !jobMatches && !unlabeledAck) return state;
      return {
        ...state,
        liveOverlay: undefined,
      };
    }
    default:
      return state;
  }
};

export const replayStorageKey = (route: Pick<FactoryWorkbenchRouteState, "profileId" | "chatId">): string =>
  `receipt.factory.workbench.v1:${route.profileId}:${route.chatId}`;

export const serializeWorkbenchReplay = (
  state: FactoryWorkbenchUiState,
  now = Date.now(),
): FactoryWorkbenchReplaySnapshot => ({
  savedAt: now,
  route: {
    profileId: state.appliedRoute.profileId,
    chatId: state.appliedRoute.chatId,
    objectiveId: state.appliedRoute.objectiveId,
    inspectorTab: state.appliedRoute.inspectorTab,
    detailTab: state.appliedRoute.detailTab,
    filter: state.appliedRoute.filter,
    focusKind: state.appliedRoute.focusKind,
    focusId: state.appliedRoute.focusId,
  },
  liveOverlay: state.liveOverlay
    ? {
        ...state.liveOverlay,
        savedAt: state.liveOverlay.savedAt || now,
      }
    : undefined,
});

export const parseWorkbenchReplay = (
  raw: string | null | undefined,
  now = Date.now(),
): FactoryWorkbenchReplaySnapshot | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as FactoryWorkbenchReplaySnapshot;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (typeof parsed.savedAt !== "number" || now - parsed.savedAt > REPLAY_TTL_MS) return undefined;
    const route = createWorkbenchRouteState(parsed.route ?? {});
    const liveOverlay = parsed.liveOverlay && typeof parsed.liveOverlay.savedAt === "number"
      && now - parsed.liveOverlay.savedAt <= LIVE_OVERLAY_TTL_MS
      ? {
          statusLabel: parsed.liveOverlay.statusLabel,
          summary: parsed.liveOverlay.summary,
          runId: asString(parsed.liveOverlay.runId),
          jobId: asString(parsed.liveOverlay.jobId),
          savedAt: parsed.liveOverlay.savedAt,
        } satisfies FactoryWorkbenchLiveOverlay
      : undefined;
    return {
      savedAt: parsed.savedAt,
      route: {
        profileId: route.profileId,
        chatId: route.chatId,
        objectiveId: route.objectiveId,
        inspectorTab: route.inspectorTab,
        detailTab: route.detailTab,
        filter: route.filter,
        focusKind: route.focusKind,
        focusId: route.focusId,
      },
      liveOverlay,
    };
  } catch {
    return undefined;
  }
};

export const mergeReplayRoute = (
  route: FactoryWorkbenchRouteState,
  replay?: FactoryWorkbenchReplaySnapshot,
  options?: {
    readonly preserveExplicitInspectorTab?: boolean;
    readonly preserveExplicitDetailTab?: boolean;
    readonly preserveExplicitFilter?: boolean;
    readonly preserveExplicitFocus?: boolean;
  },
): FactoryWorkbenchRouteState => {
  if (!replay) return route;
  return createWorkbenchRouteState({
    profileId: route.profileId,
    chatId: route.chatId,
    objectiveId: route.objectiveId,
    inspectorTab: options?.preserveExplicitInspectorTab || route.inspectorTab !== DEFAULT_INSPECTOR_TAB
      ? route.inspectorTab
      : replay.route.inspectorTab,
    detailTab: options?.preserveExplicitDetailTab || route.detailTab !== DEFAULT_DETAIL_TAB
      ? route.detailTab
      : replay.route.detailTab,
    filter: options?.preserveExplicitFilter || route.filter !== DEFAULT_FILTER
      ? route.filter
      : replay.route.filter,
    focusKind: options?.preserveExplicitFocus
      ? route.focusKind
      : route.focusKind ?? replay.route.focusKind,
    focusId: options?.preserveExplicitFocus
      ? route.focusId
      : route.focusId ?? replay.route.focusId,
  });
};
