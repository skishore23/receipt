import {
  composerFeedback,
  parseComposeResponse,
  resolveFactoryUrl,
  shellPath,
} from "./compose-navigation";
import {
  parseTokenEventPayload,
  renderStreamingReply,
} from "./live-updates";
import {
  DEFAULT_COMMANDS,
  asRecord,
  asString,
  escapeHtml,
  parseCommands,
  type FactoryCommand,
  type FactoryFetchResponse,
} from "./shared";
import {
  classifyWorkbenchRouteChange,
  createWorkbenchRouteState,
  createWorkbenchUiState,
  mergeReplayRoute,
  parseWorkbenchReplay,
  replayStorageKey,
  routeSearch,
  serializeWorkbenchReplay,
  workbenchReducer,
  type FactoryWorkbenchAction,
  type FactoryWorkbenchRouteState,
  type FactoryWorkbenchUiState,
} from "./workbench-state";

type HtmxApi = {
  readonly process?: (elt: Element) => void;
};

type WorkbenchShellSnapshot = {
  readonly pageTitle?: string;
  readonly routeKey?: string;
  readonly location?: string;
  readonly route?: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly inspectorTab?: string;
    readonly detailTab?: string;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly filter?: string;
  };
  readonly backgroundEventsPath?: string;
  readonly chatEventsPath?: string;
  readonly workbenchHeaderPath?: string;
  readonly workbenchIslandPath?: string;
  readonly chatIslandPath?: string;
  readonly workbenchHeaderHtml?: string;
  readonly chatHeaderHtml?: string;
  readonly workbenchHtml?: string;
  readonly chatHtml?: string;
  readonly composeAction?: string;
  readonly composerPlaceholder?: string;
  readonly streamingLabel?: string;
};

type PendingLiveStatus = {
  readonly statusLabel: "Queued" | "Starting" | "Working";
  readonly summary: string;
  readonly runId?: string;
  readonly jobId?: string;
};

type WorkbenchFragmentKind =
  | "header"
  | "summary"
  | "activity"
  | "objectives"
  | "history";

type WorkbenchRefreshSpec = {
  readonly kind: "sse" | "body";
  readonly event: string;
  readonly throttleMs?: number;
};

type WorkbenchRefreshSource = "chat" | "background";

type WorkbenchRefreshTarget = {
  readonly source: WorkbenchRefreshSource;
  readonly element: () => HTMLElement | null;
  readonly queue: (delayMs: number, routeKeyOverride?: string) => void;
};

const parseWorkbenchRefreshSpec = (value: string): WorkbenchRefreshSpec | undefined => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "load") return undefined;
  const descriptorMatch = trimmed.match(/^(sse|body):([^@]+?)(?:@(\d+))?$/i);
  if (descriptorMatch && descriptorMatch[1] && descriptorMatch[2]) {
    const throttleMs = descriptorMatch[3] ? Number(descriptorMatch[3]) : undefined;
    return {
      kind: descriptorMatch[1].toLowerCase() === "body" ? "body" : "sse",
      event: descriptorMatch[2].trim(),
      throttleMs: typeof throttleMs === "number" && Number.isFinite(throttleMs) ? throttleMs : undefined,
    };
  }
  const triggerMatch = trimmed.match(/^sse:([a-z0-9:-]+)(?:\s+throttle:(\d+)ms)?$/i);
  if (triggerMatch && triggerMatch[1]) {
    const throttleMs = triggerMatch[2] ? Number(triggerMatch[2]) : undefined;
    return {
      kind: "sse",
      event: triggerMatch[1],
      throttleMs: typeof throttleMs === "number" && Number.isFinite(throttleMs) ? throttleMs : undefined,
    };
  }
  const bodyMatch = trimmed.match(/^([a-z0-9:-]+)\s+from:body$/i);
  if (bodyMatch && bodyMatch[1]) {
    return {
      kind: "body",
      event: bodyMatch[1],
    };
  }
  return undefined;
};

export const initFactoryWorkbenchBrowser = () => {
  let shouldStickToBottom = true;
  let isComposing = false;
  let activeCommandIndex = 0;
  let defaultSubmitLabel = "Send";
  let chatEventSource: EventSource | null = null;
  let chatEventPath: string | null = null;
  let backgroundEventSource: EventSource | null = null;
  let backgroundEventPath: string | null = null;
  let streamingReply: { readonly runId?: string; readonly profileLabel?: string; readonly text: string } | null = null;
  let refreshTimers: Record<"chat" | "workbench", number> = { chat: 0, workbench: 0 };
  let refreshInFlight: Record<"chat" | "workbench", boolean> = { chat: false, workbench: false };
  let refreshQueued: Record<"chat" | "workbench", boolean> = { chat: false, workbench: false };
  let fragmentRefreshTimers: Record<WorkbenchFragmentKind, number> = {
    header: 0,
    summary: 0,
    activity: 0,
    objectives: 0,
    history: 0,
  };
  let fragmentRefreshInFlight: Record<WorkbenchFragmentKind, boolean> = {
    header: false,
    summary: false,
    activity: false,
    objectives: false,
    history: false,
  };
  let fragmentRefreshQueued: Record<WorkbenchFragmentKind, boolean> = {
    header: false,
    summary: false,
    activity: false,
    objectives: false,
    history: false,
  };
  let pendingOverlayHtml = "";
  let pendingLiveStatus: PendingLiveStatus | null = null;
  let navigationRevision = 0;
  let overlayRenderQueued = false;
  let inlineNavigationTarget = "";
  let inlineNavigationAbortController: AbortController | null = null;
  const bodyRefreshHandlers = new Map<string, (event: Event) => void>();

  const chatInput = () => {
    const input = document.getElementById("factory-prompt");
    return input instanceof HTMLTextAreaElement ? input : null;
  };

  const chatScroll = () => {
    const scroll = document.getElementById("factory-workbench-chat-scroll");
    return scroll instanceof HTMLElement ? scroll : null;
  };

  const composerForm = () => {
    const form = document.getElementById("factory-composer");
    return form instanceof HTMLFormElement ? form : null;
  };

  const composerStatus = () => {
    const node = document.getElementById("factory-composer-status");
    return node instanceof HTMLElement ? node : null;
  };

  const composerSubmit = () => {
    const button = document.getElementById("factory-composer-submit");
    return button instanceof HTMLButtonElement ? button : null;
  };

  const composerCompletions = () => {
    const node = document.getElementById("factory-composer-completions");
    return node instanceof HTMLElement ? node : null;
  };

  const optimisticTranscript = () => {
    const node = document.getElementById("factory-chat-optimistic");
    return node instanceof HTMLElement ? node : null;
  };

  const streamingTranscript = () => {
    const node = document.getElementById("factory-chat-streaming");
    return node instanceof HTMLElement ? node : null;
  };

  const workbenchContainer = () => {
    const node = document.getElementById("factory-workbench-panel");
    return node instanceof HTMLElement ? node : null;
  };

  const chatContainer = () => {
    const node = document.getElementById("factory-workbench-chat");
    return node instanceof HTMLElement ? node : null;
  };

  const backgroundRoot = () => {
    const node = document.getElementById("factory-workbench-background-root");
    return node instanceof HTMLElement ? node : null;
  };

  const chatRoot = () => {
    const node = document.getElementById("factory-workbench-chat-root");
    return node instanceof HTMLElement ? node : null;
  };

  const workbenchHeader = () => {
    const node = document.getElementById("factory-workbench-header");
    return node instanceof HTMLElement ? node : null;
  };

  const workbenchSummaryBlock = () => {
    const node = document.getElementById("factory-workbench-block-summary");
    return node instanceof HTMLElement ? node : null;
  };

  const workbenchObjectivesBlock = () => {
    const node = document.getElementById("factory-workbench-block-objectives");
    return node instanceof HTMLElement ? node : null;
  };

  const workbenchActivityBlock = () => {
    const node = document.getElementById("factory-workbench-block-activity");
    return node instanceof HTMLElement ? node : null;
  };


  const workbenchHistoryBlock = () => {
    const node = document.getElementById("factory-workbench-block-history");
    return node instanceof HTMLElement ? node : null;
  };

  const chatHeader = () => {
    const node = document.getElementById("factory-workbench-chat-header");
    return node instanceof HTMLElement ? node : null;
  };

  const streamingLabel = () => {
    const node = document.getElementById("factory-chat-streaming-label-text");
    return node instanceof HTMLElement ? node : null;
  };

  const currentChatState = () => {
    const container = chatContainer();
    const root = container?.firstElementChild;
    if (!(root instanceof HTMLElement)) {
      return {
        activeProfileLabel: undefined,
        activeRunId: undefined,
        knownRunIds: [],
        terminalRunIds: [],
      };
    }
    const splitDelimited = (value: string | null) =>
      value
        ? value.split(",").map((entry) => entry.trim()).filter(Boolean)
        : [];
    return {
      activeProfileLabel: root.getAttribute("data-active-profile-label") || undefined,
      activeRunId: root.getAttribute("data-active-run-id") || undefined,
      knownRunIds: splitDelimited(root.getAttribute("data-known-run-ids")),
      terminalRunIds: splitDelimited(root.getAttribute("data-terminal-run-ids")),
    };
  };

  const htmx = (): HtmxApi | undefined => {
    const candidate = (window as unknown as { readonly htmx?: HtmxApi }).htmx;
    return candidate && typeof candidate.process === "function" ? candidate : undefined;
  };

  const currentUrl = () =>
    resolveFactoryUrl(String(window.location && window.location.href ? window.location.href : "/factory"));

  const bodyRouteValue = (name: string): string | undefined => {
    const value = document.body?.getAttribute(name);
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };

  const readDocumentRouteState = (url = currentUrl()): FactoryWorkbenchRouteState => createWorkbenchRouteState({
    profileId: asString(url?.searchParams.get("profile")) ?? bodyRouteValue("data-profile-id") ?? "generalist",
    chatId: asString(url?.searchParams.get("chat")) ?? bodyRouteValue("data-chat-id") ?? "",
    objectiveId: asString(url?.searchParams.get("objective")) ?? bodyRouteValue("data-objective-id"),
    inspectorTab: asString(url?.searchParams.get("inspectorTab")) ?? bodyRouteValue("data-inspector-tab"),
    detailTab: asString(url?.searchParams.get("detailTab")) ?? bodyRouteValue("data-detail-tab"),
    filter: asString(url?.searchParams.get("filter")) ?? "objective.running",
    focusKind: asString(url?.searchParams.get("focusKind")) ?? bodyRouteValue("data-focus-kind"),
    focusId: asString(url?.searchParams.get("focusId")) ?? bodyRouteValue("data-focus-id"),
  });

  const sessionStorageApi = (): Storage | null => {
    try {
      const storage = window.sessionStorage;
      return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function"
        ? storage
        : null;
    } catch {
      return null;
    }
  };

  let workbenchState: FactoryWorkbenchUiState = createWorkbenchUiState(readDocumentRouteState());

  const persistWorkbenchReplay = () => {
    const storage = sessionStorageApi();
    if (!storage) return;
    try {
      storage.setItem(
        replayStorageKey(workbenchState.appliedRoute),
        JSON.stringify(serializeWorkbenchReplay(workbenchState)),
      );
    } catch {
      // Ignore storage failures and keep the workbench usable.
    }
  };

  const dispatchWorkbenchAction = (action: FactoryWorkbenchAction): FactoryWorkbenchUiState => {
    workbenchState = workbenchReducer(workbenchState, action);
    persistWorkbenchReplay();
    return workbenchState;
  };

  const currentRouteKey = () => workbenchState.desiredRoute.routeKey;

  const composerShell = () => {
    const node = document.getElementById("factory-workbench-composer-shell");
    return node instanceof HTMLElement ? node : null;
  };

  const liveShell = () => {
    const node = document.getElementById("factory-chat-live");
    return node instanceof HTMLElement ? node : null;
  };

  const isInlineWorkbenchLocation = (location: string): boolean => {
    const url = resolveFactoryUrl(location);
    if (!url) return false;
    if (window.location && window.location.origin && url.origin !== window.location.origin) return false;
    return url.pathname === "/factory" || url.pathname === "/factory/workbench";
  };

  const workbenchNavigationTarget = (event: Event): {
    readonly location: string;
    readonly historyMode: "replace" | "push";
  } | null => {
    if (event.defaultPrevented) return null;
    const pointerEvent = event as Event & {
      readonly button?: number;
      readonly metaKey?: boolean;
      readonly ctrlKey?: boolean;
      readonly shiftKey?: boolean;
      readonly altKey?: boolean;
    };
    if (
      pointerEvent.metaKey
      || pointerEvent.ctrlKey
      || pointerEvent.shiftKey
      || pointerEvent.altKey
      || (typeof pointerEvent.button === "number" && pointerEvent.button !== 0)
    ) {
      return null;
    }
    const target = event.target instanceof Element ? event.target.closest("[data-factory-href],a[href]") : null;
    if (!(target instanceof Element)) return null;
    if (target.getAttribute("download") !== null) return null;
    const linkTarget = (target.getAttribute("target") || "").toLowerCase();
    if (linkTarget && linkTarget !== "_self") return null;
    const href = target.getAttribute("data-factory-href") || target.getAttribute("href");
    if (!href) return null;
    const url = resolveFactoryUrl(href);
    if (!url || !isInlineWorkbenchLocation(url.href)) return null;
    return {
      location: url.href,
      historyMode: target.getAttribute("data-factory-history") === "replace" ? "replace" : "push",
    };
  };

  const composerCommands = () => {
    const form = composerForm();
    return parseCommands(form) || DEFAULT_COMMANDS;
  };

  const renderPendingLiveStatus = (status: PendingLiveStatus): string => '<section class=" border border-primary/20 bg-primary/5 px-3 py-2">' +
    '<div class="flex min-w-0 items-start justify-between gap-2">' +
      '<div class="min-w-0 flex-1">' +
        '<div class="flex flex-wrap items-center gap-2">' +
          '<span class="text-xs font-semibold text-foreground">Live status</span>' +
          '<span class="inline-flex shrink-0 items-center  border border-primary/20 bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">' + escapeHtml(status.statusLabel) + "</span>" +
        "</div>" +
        '<div class="mt-1 text-xs leading-5 text-muted-foreground">' + escapeHtml(status.summary) + "</div>" +
        ((status.jobId || status.runId)
          ? '<div class="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">' +
              (status.jobId ? '<span>Job ' + escapeHtml(status.jobId) + "</span>" : "") +
              (status.runId ? '<span>Run ' + escapeHtml(status.runId) + "</span>" : "") +
            "</div>"
          : "") +
      "</div>" +
    "</div>" +
  "</section>";

  const updatePendingLiveStatus = (
    status: PendingLiveStatus | null,
    acknowledged?: {
      readonly runId?: string;
      readonly jobId?: string;
      readonly terminal?: boolean;
    },
  ) => {
    pendingLiveStatus = status;
    if (status) {
      dispatchWorkbenchAction({
        type: "composer.queued",
        liveOverlay: {
          ...status,
          savedAt: Date.now(),
        },
      });
      return;
    }
    dispatchWorkbenchAction({
      type: "composer.acknowledged",
      runId: acknowledged?.runId,
      jobId: acknowledged?.jobId,
      terminal: acknowledged?.terminal ?? true,
    });
  };

  const scheduleOverlayRender = () => {
    if (overlayRenderQueued) return;
    overlayRenderQueued = true;
    window.requestAnimationFrame(() => {
      overlayRenderQueued = false;
      const optimistic = optimisticTranscript();
      if (!optimistic) return;
      optimistic.innerHTML = pendingOverlayHtml + (pendingLiveStatus ? renderPendingLiveStatus(pendingLiveStatus) : "");
      const streaming = streamingTranscript();
      if (streaming) {
        streaming.innerHTML = streamingReply ? renderStreamingReply(streamingReply) : "";
      }
      if ((pendingOverlayHtml || pendingLiveStatus || streamingReply) && shouldStickToBottom) {
        window.requestAnimationFrame(() => {
          const scroll = chatScroll();
          if (!scroll) return;
          if (typeof scroll.scrollTo === "function") {
            scroll.scrollTo({ top: scroll.scrollHeight, behavior: "auto" });
          } else {
            scroll.scrollTop = scroll.scrollHeight;
          }
        });
      }
    });
  };

  const clearStreamingReply = () => {
    streamingReply = null;
    scheduleOverlayRender();
  };

  const reconcileLiveTranscript = () => {
    const state = currentChatState();
    const pendingRunId = pendingLiveStatus?.runId;
    if (
      pendingLiveStatus
      && (
        (pendingRunId && (
          state.activeRunId === pendingRunId
          || state.knownRunIds.indexOf(pendingRunId) >= 0
          || state.terminalRunIds.indexOf(pendingRunId) >= 0
        ))
        || (!pendingRunId && Boolean(state.activeRunId))
      )
    ) {
      updatePendingLiveStatus(null, {
        runId: pendingLiveStatus.runId,
        jobId: pendingLiveStatus.jobId,
      });
    }
    const runId = streamingReply?.runId;
    if (runId && state.terminalRunIds.indexOf(runId) >= 0) {
      streamingReply = null;
    } else if (
      runId
      && pendingRunId !== runId
      && state.activeRunId !== runId
      && state.knownRunIds.indexOf(runId) < 0
      && state.terminalRunIds.indexOf(runId) < 0
    ) {
      streamingReply = null;
    }
    scheduleOverlayRender();
  };

  const acceptsStreamingRun = (runId: string | undefined): boolean => {
    if (!workbenchState.appliedRoute.objectiveId) return true;
    if (!runId) return false;
    if (pendingLiveStatus?.runId === runId) return true;
    const state = currentChatState();
    return state.activeRunId === runId
      || state.knownRunIds.indexOf(runId) >= 0
      || state.terminalRunIds.indexOf(runId) >= 0;
  };

  const setComposerStatus = (message: string) => {
    const node = composerStatus();
    if (!node) return;
    if (!message) {
      node.textContent = "";
      node.classList.add("hidden");
      return;
    }
    node.textContent = message;
    node.classList.remove("hidden");
  };

  const setComposerBusy = (busy: boolean, label?: string) => {
    const input = chatInput();
    const submit = composerSubmit();
    if (input) input.disabled = busy;
    if (submit) {
      if (!submit.disabled && submit.textContent) defaultSubmitLabel = submit.textContent;
      submit.disabled = busy;
      submit.textContent = busy ? (label || "Sending...") : defaultSubmitLabel;
    }
  };

  const setExpanded = (expanded: boolean) => {
    const input = chatInput();
    if (input) input.setAttribute("aria-expanded", expanded ? "true" : "false");
    const popup = composerCompletions();
    if (popup) popup.classList.toggle("hidden", !expanded);
  };

  const getSlashContext = (value: string, caret: number) => {
    const safeCaret = Math.max(0, Math.min(caret, value.length));
    const start = value.lastIndexOf("/", safeCaret - 1);
    if (start < 0) return null;
    const before = value.slice(0, start);
    if (before && !/\s$/.test(before)) return null;
    const tokenEnd = value.indexOf(" ", start + 1);
    const end = tokenEnd === -1 ? value.length : tokenEnd;
    if (safeCaret < start + 1 || safeCaret > end) return null;
    return {
      before,
      after: value.slice(end),
      query: value.slice(start + 1, safeCaret),
    };
  };

  const filterCommands = (query: string) => {
    const normalized = query.trim().toLowerCase();
    const commands = composerCommands();
    if (!normalized) return commands;
    return commands.filter((command) =>
      [command.name, command.label, command.usage, command.description].concat(command.aliases || []).join(" ").toLowerCase().indexOf(normalized) >= 0
    );
  };

  const renderCommands = (query: string, selectedIndex: number) => {
    const popup = composerCompletions();
    if (!popup) return [];
    const matches = filterCommands(query);
    activeCommandIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, matches.length - 1)));
    if (!matches.length) {
      popup.innerHTML = '<div class="px-3 py-2 text-xs text-muted-foreground">No matching commands.</div>';
      setExpanded(true);
      return matches;
    }
    popup.innerHTML = matches.map((command, index) => {
      const active = index === activeCommandIndex;
      return '<button type="button" role="option" aria-selected="' + (active ? "true" : "false") + '" data-command-index="' + index + '" class="flex w-full items-start gap-3 px-3 py-2 text-left transition ' + (active ? "bg-primary/10 text-foreground" : "hover:bg-muted text-foreground") + '">' +
        '<span class="min-w-0 flex-1">' +
        '<span class="block text-sm font-medium">' + escapeHtml(command.label) + "</span>" +
        '<span class="block text-xs text-muted-foreground">' + escapeHtml(command.description) + "</span>" +
        "</span>" +
        '<span class="shrink-0 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">' + escapeHtml(command.usage) + "</span>" +
      "</button>";
    }).join("");
    setExpanded(true);
    return matches;
  };

  const insertCommand = (command: FactoryCommand) => {
    const input = chatInput();
    if (!input) return;
    const context = getSlashContext(input.value, input.selectionStart || 0);
    if (!context) return;
    const replacement = "/" + command.name + " ";
    input.value = context.before + replacement + context.after;
    const caret = (context.before + replacement).length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    setExpanded(false);
  };

  const autoResizeInput = () => {
    const input = chatInput();
    if (!input) return;
    input.style.height = "0px";
    input.style.height = Math.min(Math.max(input.scrollHeight, 120), 260) + "px";
  };

  const fetchHtml = (url: string, signal?: AbortSignal) =>
    window.fetch(url, {
      method: "GET",
      headers: { Accept: "text/html" },
      credentials: "same-origin",
      signal,
    }).then((response: FactoryFetchResponse) => {
      if (!response.ok) throw new Error("Request failed.");
      return response.text();
    });

  const workbenchShellUrl = (search: string) => "/factory/api/workbench-shell" + (search || "");

  const parseWorkbenchShellSnapshot = (value: unknown): WorkbenchShellSnapshot | null => {
    const record = asRecord(value);
    if (!record) return null;
    const routeRecord = asRecord(record.route);
    return {
      pageTitle: asString(record.pageTitle),
      routeKey: asString(record.routeKey),
      location: asString(record.location),
      route: routeRecord
        ? {
            profileId: asString(routeRecord.profileId),
            chatId: asString(routeRecord.chatId),
            objectiveId: asString(routeRecord.objectiveId),
            inspectorTab: asString(routeRecord.inspectorTab),
            detailTab: asString(routeRecord.detailTab),
            focusKind: routeRecord.focusKind === "task" || routeRecord.focusKind === "job"
              ? routeRecord.focusKind
              : undefined,
            focusId: asString(routeRecord.focusId),
            filter: asString(routeRecord.filter),
          }
        : undefined,
      backgroundEventsPath: asString(record.backgroundEventsPath),
      chatEventsPath: asString(record.chatEventsPath),
      workbenchHeaderPath: asString(record.workbenchHeaderPath),
      workbenchIslandPath: asString(record.workbenchIslandPath),
      chatIslandPath: asString(record.chatIslandPath),
      workbenchHeaderHtml: asString(record.workbenchHeaderHtml),
      chatHeaderHtml: asString(record.chatHeaderHtml),
      workbenchHtml: asString(record.workbenchHtml),
      chatHtml: asString(record.chatHtml),
      composeAction: asString(record.composeAction),
      composerPlaceholder: asString(record.composerPlaceholder),
      streamingLabel: asString(record.streamingLabel),
    };
  };

  const fetchWorkbenchShell = (search: string, signal?: AbortSignal) =>
    window.fetch(workbenchShellUrl(search), {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      signal,
    }).then((response: FactoryFetchResponse) => {
      if (!response.ok) throw new Error("Request failed.");
      return response.json();
    }).then((payload) => {
      const snapshot = parseWorkbenchShellSnapshot(payload);
      if (!snapshot) throw new Error("Invalid workbench shell response.");
      return snapshot;
    });

  const isAbortError = (error: unknown): boolean =>
    Boolean(error && typeof error === "object" && "name" in error && (error as { readonly name?: string }).name === "AbortError");

  const setHistory = (url: URL, historyMode?: "replace" | "push" | "none") => {
    const nextPath = url.pathname + (url.search || "") + (url.hash || "");
    if (!window.history) return;
    if (historyMode === "replace" && typeof window.history.replaceState === "function") {
      window.history.replaceState({}, "", nextPath);
    } else if (historyMode !== "none" && typeof window.history.pushState === "function") {
      window.history.pushState({}, "", nextPath);
    }
  };

  const workbenchHeaderPathForRoute = (route: FactoryWorkbenchRouteState): string =>
    `/factory/island/workbench/header${routeSearch(route)}`;

  const workbenchIslandPathForRoute = (route: FactoryWorkbenchRouteState): string =>
    `/factory/island/workbench${routeSearch(route)}`;

  const chatIslandPathForRoute = (route: FactoryWorkbenchRouteState): string =>
    `/factory/island/chat${routeSearch(route)}`;

  const workbenchBlockPathForRoute = (
    route: FactoryWorkbenchRouteState,
    block: WorkbenchFragmentKind,
  ): string => {
    const url = resolveFactoryUrl(route.routeKey) ?? new URL(route.routeKey, "http://receipt.local");
    const params = new URLSearchParams(url.search);
    params.set("block", block);
    const query = params.toString();
    return `/factory/island/workbench/block${query ? `?${query}` : ""}`;
  };

  const backgroundEventsPathForRoute = (route: FactoryWorkbenchRouteState): string =>
    `/factory/background/events${routeSearch(route)}`;

  const chatEventsPathForRoute = (route: FactoryWorkbenchRouteState): string => {
    const params = new URLSearchParams();
    params.set("profile", route.profileId);
    if (route.chatId) params.set("chat", route.chatId);
    return `/factory/chat/events?${params.toString()}`;
  };

  const syncWorkbenchRouteData = (route: FactoryWorkbenchRouteState) => {
    if (!document.body) return;
    document.body.setAttribute("data-route-key", route.routeKey);
    document.body.setAttribute("data-chat-id", route.chatId ?? "");
    document.body.setAttribute("data-objective-id", route.objectiveId ?? "");
    document.body.setAttribute("data-inspector-tab", route.inspectorTab ?? "overview");
    document.body.setAttribute("data-detail-tab", route.detailTab ?? "action");
    document.body.setAttribute("data-focus-kind", route.focusKind ?? "");
    document.body.setAttribute("data-focus-id", route.focusId ?? "");
  };

  const syncInspectorTabVisibility = (inspectorTab?: string) => {
    const isChatTab = inspectorTab === "chat";
    const composer = composerShell();
    if (composer) composer.classList.toggle("hidden", !isChatTab);
    const live = liveShell();
    if (live) live.classList.toggle("hidden", !isChatTab);
  };

  const syncInspectorTabControls = (inspectorTab?: string) => {
    const header = chatHeader();
    const activeTab = inspectorTab ?? "overview";
    const querySelectorAll = header && "querySelectorAll" in header
      ? (header.querySelectorAll as ((selector: string) => NodeListOf<Element>) | undefined)
      : undefined;
    if (!header || typeof querySelectorAll !== "function") return;
    for (const link of Array.from(querySelectorAll.call(header, 'a[href*="inspectorTab="], a[href="/factory"], a[href^="/factory?"]'))) {
      if (!(link instanceof HTMLElement)) continue;
      const href = link.getAttribute("href") || "";
      const url = resolveFactoryUrl(href);
      const linkTab = url
        ? (asString(url.searchParams.get("inspectorTab")) ?? "overview")
        : "overview";
      const isActive = linkTab === activeTab;
      link.classList.toggle("border-primary/20", isActive);
      link.classList.toggle("bg-primary/10", isActive);
      link.classList.toggle("text-primary", isActive);
      link.classList.toggle("border-border", !isActive);
      link.classList.toggle("bg-background", !isActive);
      link.classList.toggle("text-muted-foreground", !isActive);
      link.classList.toggle("hover:bg-accent", !isActive);
      link.classList.toggle("hover:text-foreground", !isActive);
      if (isActive) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  };

  const syncRouteBindings = (route: FactoryWorkbenchRouteState) => {
    const currentWorkbenchHeader = workbenchHeader();
    if (currentWorkbenchHeader) currentWorkbenchHeader.setAttribute("hx-get", workbenchHeaderPathForRoute(route));
    const currentWorkbench = workbenchContainer();
    if (currentWorkbench) currentWorkbench.setAttribute("hx-get", workbenchIslandPathForRoute(route));
    const currentChat = chatContainer();
    if (currentChat) currentChat.setAttribute("hx-get", chatIslandPathForRoute(route));
    const currentBackgroundRoot = backgroundRoot();
    if (currentBackgroundRoot) currentBackgroundRoot.setAttribute("data-events-path", backgroundEventsPathForRoute(route));
    const currentChatRoot = chatRoot();
    if (currentChatRoot) currentChatRoot.setAttribute("data-events-path", chatEventsPathForRoute(route));
    const form = composerForm();
    if (form) form.action = `/factory/compose${routeSearch(route)}`;
    const summary = workbenchSummaryBlock();
    if (summary) summary.setAttribute("hx-get", workbenchBlockPathForRoute(route, "summary"));
    const activity = workbenchActivityBlock();
    if (activity) activity.setAttribute("hx-get", workbenchBlockPathForRoute(route, "activity"));
    const objectives = workbenchObjectivesBlock();
    if (objectives) objectives.setAttribute("hx-get", workbenchBlockPathForRoute(route, "objectives"));
    const history = workbenchHistoryBlock();
    if (history) history.setAttribute("hx-get", workbenchBlockPathForRoute(route, "history"));
  };

  const applyRouteState = (
    route: FactoryWorkbenchRouteState,
    historyMode?: "replace" | "push" | "none",
  ) => {
    syncWorkbenchRouteData(route);
    syncRouteBindings(route);
    syncInspectorTabVisibility(route.inspectorTab);
    syncInspectorTabControls(route.inspectorTab);
    syncBodyRefreshListeners();
    const historyUrl = resolveFactoryUrl(route.routeKey);
    if (historyUrl) setHistory(historyUrl, historyMode);
  };

  const routeStateFromSnapshot = (snapshot: WorkbenchShellSnapshot, fallbackUrl: URL): FactoryWorkbenchRouteState =>
    createWorkbenchRouteState({
      profileId: snapshot.route?.profileId ?? asString(fallbackUrl.searchParams.get("profile")) ?? workbenchState.appliedRoute.profileId,
      chatId: snapshot.route?.chatId ?? asString(fallbackUrl.searchParams.get("chat")) ?? workbenchState.appliedRoute.chatId,
      objectiveId: snapshot.route?.objectiveId ?? asString(fallbackUrl.searchParams.get("objective")) ?? undefined,
      inspectorTab: snapshot.route?.inspectorTab ?? asString(fallbackUrl.searchParams.get("inspectorTab")) ?? undefined,
      detailTab: snapshot.route?.detailTab ?? asString(fallbackUrl.searchParams.get("detailTab")) ?? undefined,
      filter: snapshot.route?.filter ?? asString(fallbackUrl.searchParams.get("filter")) ?? "objective.running",
      focusKind: snapshot.route?.focusKind,
      focusId: snapshot.route?.focusId,
    });

  const applyWorkbenchShellSnapshot = (snapshot: WorkbenchShellSnapshot, url: URL) => {
    if (snapshot.pageTitle) document.title = snapshot.pageTitle;
    const nextRoute = routeStateFromSnapshot(snapshot, url);
    dispatchWorkbenchAction({ type: "route.applied", route: nextRoute });
    applyRouteState(nextRoute, "none");
    const currentWorkbenchHeader = workbenchHeader();
    if (currentWorkbenchHeader && typeof snapshot.workbenchHeaderHtml === "string") {
      currentWorkbenchHeader.innerHTML = snapshot.workbenchHeaderHtml;
    }

    const currentChatHeader = chatHeader();
    if (currentChatHeader && typeof snapshot.chatHeaderHtml === "string") {
      currentChatHeader.innerHTML = snapshot.chatHeaderHtml;
    }

    const currentWorkbench = workbenchContainer();
    if (currentWorkbench && typeof snapshot.workbenchHtml === "string") currentWorkbench.innerHTML = snapshot.workbenchHtml;

    const currentChat = chatContainer();
    if (currentChat && typeof snapshot.chatHtml === "string") currentChat.innerHTML = snapshot.chatHtml;

    const input = chatInput();
    if (input && snapshot.composerPlaceholder) {
      input.setAttribute("placeholder", snapshot.composerPlaceholder);
    }
    const currentStreamingLabel = streamingLabel();
    if (currentStreamingLabel && snapshot.streamingLabel) {
      currentStreamingLabel.textContent = snapshot.streamingLabel;
    }
    const currentBackgroundRoot = backgroundRoot();
    const currentChatRoot = chatRoot();
    connectLiveUpdates();
    htmx()?.process?.(currentWorkbenchHeader ?? document.body);
    htmx()?.process?.(currentBackgroundRoot ?? document.body);
    htmx()?.process?.(currentChatRoot ?? document.body);
    scheduleOverlayRender();
  };

  const handleWorkbenchChatSwap = (target: HTMLElement) => {
    const currentObjectiveId = workbenchState.appliedRoute.objectiveId ?? "";
    const discoveredObjectiveId = target.getAttribute("data-objective-id") || "";
    if (!currentObjectiveId && discoveredObjectiveId) {
      const url = currentUrl();
      if (url) {
        url.searchParams.set("objective", discoveredObjectiveId);
        url.searchParams.delete("thread");
        url.searchParams.delete("focusKind");
        url.searchParams.delete("focusId");
        applyInlineLocation(url.href, "replace").catch(() => {
          navigateWithFeedback(url.href);
        });
      }
    }
    if (pendingOverlayHtml) {
      pendingOverlayHtml = "";
      scheduleOverlayRender();
    }
    reconcileLiveTranscript();
    if (!shouldStickToBottom) return;
    window.requestAnimationFrame(() => {
      const nextScroll = chatScroll();
      if (!nextScroll) return;
      if (typeof nextScroll.scrollTo === "function") {
        nextScroll.scrollTo({ top: nextScroll.scrollHeight, behavior: "auto" });
      } else {
        nextScroll.scrollTop = nextScroll.scrollHeight;
      }
    });
  };

  const islandContainer = (kind: "chat" | "workbench") =>
    kind === "chat" ? chatContainer() : workbenchContainer();

  const workbenchFragment = (kind: WorkbenchFragmentKind) => {
    switch (kind) {
      case "header":
        return workbenchHeader();
      case "summary":
        return workbenchSummaryBlock();
      case "activity":
        return workbenchActivityBlock();
      case "objectives":
        return workbenchObjectivesBlock();
      case "history":
        return workbenchHistoryBlock();
      default:
        return null;
    }
  };

  const refreshWorkbenchFragmentNow = (kind: WorkbenchFragmentKind, expectedRouteKey: string) => {
    const target = workbenchFragment(kind);
    const path = target?.getAttribute("hx-get");
    if (!target || !path) return Promise.resolve();
    return fetchHtml(path).then((markup) => {
      if (expectedRouteKey !== currentRouteKey()) return;
      target.innerHTML = markup;
      htmx()?.process?.(target);
    });
  };

  const queueWorkbenchFragmentRefresh = (
    kind: WorkbenchFragmentKind,
    delayMs: number,
    routeKeyOverride?: string,
  ) => {
    if (fragmentRefreshTimers[kind]) window.clearTimeout(fragmentRefreshTimers[kind]);
    fragmentRefreshTimers[kind] = window.setTimeout(() => {
      fragmentRefreshTimers[kind] = 0;
      const expectedRouteKey = typeof routeKeyOverride === "string" ? routeKeyOverride : currentRouteKey();
      if (fragmentRefreshInFlight[kind]) {
        fragmentRefreshQueued[kind] = true;
        return;
      }
      fragmentRefreshInFlight[kind] = true;
      refreshWorkbenchFragmentNow(kind, expectedRouteKey).catch(() => {
        // Ignore transient fragment failures; the full panel refresh path still exists.
      }).finally(() => {
        fragmentRefreshInFlight[kind] = false;
        if (!fragmentRefreshQueued[kind]) return;
        fragmentRefreshQueued[kind] = false;
        queueWorkbenchFragmentRefresh(kind, delayMs, expectedRouteKey);
      });
    }, Math.max(0, delayMs));
  };

  const refreshIslandNow = (kind: "chat" | "workbench", expectedRouteKey: string) => {
    const target = islandContainer(kind);
    const path = target?.getAttribute("hx-get");
    if (!target || !path) return Promise.resolve();
    return fetchHtml(path).then((markup) => {
      if (expectedRouteKey !== currentRouteKey()) return;
      target.innerHTML = markup;
      htmx()?.process?.(target);
      if (kind === "chat") handleWorkbenchChatSwap(target);
    });
  };

  const queueIslandRefresh = (kind: "chat" | "workbench", delayMs: number, routeKeyOverride?: string) => {
    if (refreshTimers[kind]) window.clearTimeout(refreshTimers[kind]);
    refreshTimers[kind] = window.setTimeout(() => {
      refreshTimers[kind] = 0;
      const expectedRouteKey = typeof routeKeyOverride === "string" ? routeKeyOverride : currentRouteKey();
      if (refreshInFlight[kind]) {
        refreshQueued[kind] = true;
        return;
      }
      refreshInFlight[kind] = true;
      refreshIslandNow(kind, expectedRouteKey).catch(() => {
        // Ignore transient refresh failures; the next navigation or SSE update can retry.
      }).finally(() => {
        refreshInFlight[kind] = false;
        if (!refreshQueued[kind]) return;
        refreshQueued[kind] = false;
        queueIslandRefresh(kind, delayMs, expectedRouteKey);
      });
    }, Math.max(0, delayMs));
  };

  const readWorkbenchRefreshSpecs = (target: Element | null): ReadonlyArray<WorkbenchRefreshSpec> => {
    if (!(target instanceof HTMLElement)) return [];
    const descriptor = target.getAttribute("data-refresh-on");
    const raw = descriptor !== null ? descriptor : target.getAttribute("hx-trigger");
    if (!raw) return [];
    return raw
      .split(",")
      .map((part) => parseWorkbenchRefreshSpec(part))
      .flatMap((spec) => spec ? [spec] : []);
  };

  const workbenchRefreshTargets = (): ReadonlyArray<WorkbenchRefreshTarget> => [
    {
      source: "background",
      element: workbenchHeader,
      queue: (delayMs, routeKeyOverride) => queueWorkbenchFragmentRefresh("header", delayMs, routeKeyOverride),
    },
    {
      source: "background",
      element: workbenchContainer,
      queue: (delayMs, routeKeyOverride) => queueIslandRefresh("workbench", delayMs, routeKeyOverride),
    },
    {
      source: "background",
      element: workbenchSummaryBlock,
      queue: (delayMs, routeKeyOverride) => queueWorkbenchFragmentRefresh("summary", delayMs, routeKeyOverride),
    },
    {
      source: "background",
      element: workbenchActivityBlock,
      queue: (delayMs, routeKeyOverride) => queueWorkbenchFragmentRefresh("activity", delayMs, routeKeyOverride),
    },
    {
      source: "background",
      element: workbenchObjectivesBlock,
      queue: (delayMs, routeKeyOverride) => queueWorkbenchFragmentRefresh("objectives", delayMs, routeKeyOverride),
    },
    {
      source: "background",
      element: workbenchHistoryBlock,
      queue: (delayMs, routeKeyOverride) => queueWorkbenchFragmentRefresh("history", delayMs, routeKeyOverride),
    },
    {
      source: "chat",
      element: chatContainer,
      queue: (delayMs, routeKeyOverride) => queueIslandRefresh("chat", delayMs, routeKeyOverride),
    },
  ];

  const declaredRefreshEvents = (
    source: WorkbenchRefreshSource,
    kind: WorkbenchRefreshSpec["kind"],
  ): ReadonlyArray<string> => {
    const events = new Set<string>();
    for (const target of workbenchRefreshTargets()) {
      if (target.source !== source) continue;
      for (const spec of readWorkbenchRefreshSpecs(target.element())) {
        if (spec.kind !== kind) continue;
        events.add(spec.event);
      }
    }
    return Array.from(events);
  };

  const queueDeclaredRefreshes = (
    source: WorkbenchRefreshSource,
    eventName: string,
    kind: WorkbenchRefreshSpec["kind"],
    routeKeyOverride?: string,
  ) => {
    for (const target of workbenchRefreshTargets()) {
      if (target.source !== source) continue;
      const spec = readWorkbenchRefreshSpecs(target.element()).find((entry) =>
        entry.kind === kind && entry.event === eventName);
      if (!spec) continue;
      target.queue(spec.throttleMs ?? 0, routeKeyOverride);
    }
  };

  const syncBodyRefreshListeners = () => {
    if (!document.body) return;
    const activeEvents = new Set<string>();
    for (const source of ["background", "chat"] as const) {
      for (const eventName of declaredRefreshEvents(source, "body")) activeEvents.add(eventName);
    }
    for (const eventName of activeEvents) {
      if (bodyRefreshHandlers.has(eventName)) continue;
      const handler = () => {
        queueDeclaredRefreshes("background", eventName, "body");
        queueDeclaredRefreshes("chat", eventName, "body");
      };
      document.body.addEventListener(eventName, handler);
      bodyRefreshHandlers.set(eventName, handler);
    }
    for (const [eventName, handler] of Array.from(bodyRefreshHandlers.entries())) {
      if (activeEvents.has(eventName)) continue;
      document.body.removeEventListener(eventName, handler);
      bodyRefreshHandlers.delete(eventName);
    }
  };

  const resolvedHistoryUrl = (snapshot: WorkbenchShellSnapshot, fallbackUrl: URL): URL => {
    const canonical = snapshot.location ? resolveFactoryUrl(snapshot.location) : null;
    return canonical ?? fallbackUrl;
  };

  const closeEventSource = (source: EventSource | null) => {
    if (!source || typeof source.close !== "function") return;
    source.close();
  };

  const chatEventsPath = () => {
    const node = chatRoot();
    return node?.getAttribute("data-events-path") || null;
  };

  const backgroundEventsPath = () => {
    const node = backgroundRoot();
    return node?.getAttribute("data-events-path") || null;
  };

  const ignoreInit = (event: MessageEvent<string>) => event.data === "init";

  const connectLiveUpdates = () => {
    if (typeof window.EventSource !== "function") return;

    const nextChatEventsPath = chatEventsPath();
    if (nextChatEventsPath && (!chatEventSource || chatEventPath !== nextChatEventsPath)) {
      closeEventSource(chatEventSource);
      chatEventSource = new window.EventSource(nextChatEventsPath);
      chatEventPath = nextChatEventsPath;
      for (const eventName of declaredRefreshEvents("chat", "sse")) {
        chatEventSource.addEventListener(eventName, (event) => {
          const message = event as MessageEvent<string>;
          if (ignoreInit(message)) return;
          if (eventName === "agent-refresh" && pendingLiveStatus && !streamingReply) {
            updatePendingLiveStatus({
              ...pendingLiveStatus,
              statusLabel: "Working",
              summary: "Factory is running tools and preparing the reply.",
            });
          }
          if (eventName === "job-refresh" && pendingLiveStatus && !streamingReply && pendingLiveStatus.statusLabel === "Queued") {
            updatePendingLiveStatus({
              ...pendingLiveStatus,
              statusLabel: "Starting",
              summary: "A worker picked up the run and is preparing the first response.",
            });
          }
          queueDeclaredRefreshes("chat", eventName, "sse");
        });
      }
      chatEventSource.addEventListener("agent-token", (event) => {
        const payload = parseTokenEventPayload((event as MessageEvent<string>).data || "");
        if (!payload) return;
        const state = currentChatState();
        const runId = payload.runId || state.activeRunId || streamingReply?.runId;
        if (!acceptsStreamingRun(runId)) return;
        updatePendingLiveStatus(null, { runId: payload.runId });
        const previous = streamingReply && streamingReply.runId === runId ? streamingReply.text : "";
        streamingReply = {
          runId,
          profileLabel: state.activeProfileLabel || streamingLabel()?.textContent || "Assistant",
          text: previous + payload.delta,
        };
        scheduleOverlayRender();
      });
      chatEventSource.addEventListener("factory-stream-reset", () => {
        clearStreamingReply();
      });
    } else if (!nextChatEventsPath) {
      closeEventSource(chatEventSource);
      chatEventSource = null;
      chatEventPath = null;
    }

    const nextBackgroundEventsPath = backgroundEventsPath();
    if (nextBackgroundEventsPath && (!backgroundEventSource || backgroundEventPath !== nextBackgroundEventsPath)) {
      closeEventSource(backgroundEventSource);
      backgroundEventSource = new window.EventSource(nextBackgroundEventsPath);
      backgroundEventPath = nextBackgroundEventsPath;
      for (const eventName of declaredRefreshEvents("background", "sse")) {
        backgroundEventSource.addEventListener(eventName, (event) => {
          const message = event as MessageEvent<string>;
          if (ignoreInit(message)) return;
          queueDeclaredRefreshes("background", eventName, "sse");
        });
      }
    } else if (!nextBackgroundEventsPath) {
      closeEventSource(backgroundEventSource);
      backgroundEventSource = null;
      backgroundEventPath = null;
    }
  };

  const navigateWithFeedback = (location: string) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.location.assign(location);
      });
    });
  };

  const routeStateFromLocation = (url: URL): FactoryWorkbenchRouteState =>
    createWorkbenchRouteState({
      profileId: asString(url.searchParams.get("profile")) ?? workbenchState.appliedRoute.profileId,
      chatId: asString(url.searchParams.get("chat")) ?? workbenchState.appliedRoute.chatId,
      objectiveId: asString(url.searchParams.get("objective")),
      inspectorTab: asString(url.searchParams.get("inspectorTab")),
      detailTab: asString(url.searchParams.get("detailTab")),
      filter: asString(url.searchParams.get("filter")),
      focusKind: asString(url.searchParams.get("focusKind")),
      focusId: asString(url.searchParams.get("focusId")),
    });

  const applyInlineLocation = (
    location: string,
    historyMode?: "replace" | "push" | "none",
    historyLocation?: string,
  ) => {
    if (!isInlineWorkbenchLocation(location)) {
      navigateWithFeedback(location);
      return Promise.resolve(false);
    }
    const url = resolveFactoryUrl(location);
    if (!url) {
      navigateWithFeedback(location);
      return Promise.resolve(false);
    }
    const nextRoute = routeStateFromLocation(url);
    const changeKind = classifyWorkbenchRouteChange(workbenchState.desiredRoute, nextRoute);
    const nextPath = url.pathname + (url.search || "") + (url.hash || "");
    if (changeKind === "noop") return Promise.resolve(true);
    if (historyMode !== "replace" && inlineNavigationTarget === nextPath) return Promise.resolve(true);
    if (changeKind === "inspector") {
      dispatchWorkbenchAction({ type: "inspector.changed", route: nextRoute });
      applyRouteState(nextRoute, "replace");
      if (nextRoute.inspectorTab === "chat") {
        window.requestAnimationFrame(() => {
          const input = chatInput();
          if (input) input.focus();
        });
      }
      queueIslandRefresh("chat", 90, nextRoute.routeKey);
      return Promise.resolve(true);
    }
    if (changeKind === "focus") {
      dispatchWorkbenchAction({ type: "focus.changed", route: nextRoute });
      applyRouteState(nextRoute, "replace");
      queueWorkbenchFragmentRefresh("summary", 90, nextRoute.routeKey);
      queueWorkbenchFragmentRefresh("activity", 90, nextRoute.routeKey);
      return Promise.resolve(true);
    }
    if (changeKind === "filter") {
      dispatchWorkbenchAction({ type: "filter.changed", route: nextRoute });
      applyRouteState(nextRoute, "push");
      queueWorkbenchFragmentRefresh("header", 90, nextRoute.routeKey);
      queueIslandRefresh("workbench", 120, nextRoute.routeKey);
      return Promise.resolve(true);
    }
    inlineNavigationAbortController?.abort();
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    inlineNavigationAbortController = abortController;
    inlineNavigationTarget = nextPath;
    const requestedState = dispatchWorkbenchAction({
      type: "route.requested",
      route: nextRoute,
    });
    const revision = ++navigationRevision;
    return fetchWorkbenchShell(url.search || "", abortController?.signal).then((snapshot) => {
      if (revision !== navigationRevision) return true;
      if (requestedState.desiredRoute.routeKey !== currentRouteKey()) return true;
      applyWorkbenchShellSnapshot(snapshot, url);
      const fallbackHistoryUrl = historyLocation ? resolveFactoryUrl(historyLocation) ?? url : url;
      setHistory(resolvedHistoryUrl(snapshot, fallbackHistoryUrl), historyMode ?? "push");
      if (shouldStickToBottom) {
        window.requestAnimationFrame(() => {
          const scroll = chatScroll();
          if (!scroll) return;
          if (typeof scroll.scrollTo === "function") {
            scroll.scrollTo({ top: scroll.scrollHeight, behavior: "auto" });
          } else {
            scroll.scrollTop = scroll.scrollHeight;
          }
        });
      }
      return true;
    }).catch((error: unknown) => {
      if (abortController?.signal.aborted || isAbortError(error)) return true;
      navigateWithFeedback(location);
      if (error instanceof Error) throw error;
      throw new Error("Request failed.");
    }).finally(() => {
      if (inlineNavigationAbortController === abortController) inlineNavigationAbortController = null;
      if (inlineNavigationTarget === nextPath) inlineNavigationTarget = "";
    });
  };

  const resetComposerAfterSuccess = () => {
    const input = chatInput();
    if (input) {
      input.value = "";
      autoResizeInput();
      input.focus();
    }
    setExpanded(false);
    setComposerStatus("");
    setComposerBusy(false);
  };

  const input = chatInput();
  if (input) {
    input.addEventListener("input", autoResizeInput, { passive: true });
    input.addEventListener("compositionstart", () => { isComposing = true; });
    input.addEventListener("compositionend", () => { isComposing = false; refreshAutocomplete(); });
    input.addEventListener("click", () => { refreshAutocomplete(); });
    input.addEventListener("keyup", () => { refreshAutocomplete(); });
    input.addEventListener("keydown", (event) => {
      if (isComposing) return;
      const popup = composerCompletions();
      const matches = filterCommands((getSlashContext(input.value, input.selectionStart || 0) || { query: "" }).query);
      if (popup && !popup.classList.contains("hidden") && matches.length) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          activeCommandIndex = (activeCommandIndex + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
          renderCommands((getSlashContext(input.value, input.selectionStart || 0) || { query: "" }).query, activeCommandIndex);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          insertCommand(matches[activeCommandIndex] || matches[0]!);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setExpanded(false);
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const form = composerForm();
        if (form) form.requestSubmit();
      }
    });
    autoResizeInput();

    const refreshAutocomplete = () => {
      const context = getSlashContext(input.value, input.selectionStart || 0);
      if (!context) {
        setExpanded(false);
        return;
      }
      renderCommands(context.query, 0);
    };

    input.addEventListener("input", refreshAutocomplete);
    input.addEventListener("blur", () => {
      window.setTimeout(() => { setExpanded(false); }, 100);
    });
    input.addEventListener("focus", refreshAutocomplete);

    const popup = composerCompletions();
    if (popup) {
      popup.addEventListener("mousedown", (event) => {
        const button = event.target instanceof Element ? event.target.closest("[data-command-index]") : null;
        if (!button) return;
        event.preventDefault();
        const index = Number(button.getAttribute("data-command-index") || "0");
        const matches = renderCommands((getSlashContext(input.value, input.selectionStart || 0) || { query: "" }).query, index);
        if (matches[index]) insertCommand(matches[index]!);
      });
      popup.addEventListener("mousemove", (event) => {
        const button = event.target instanceof Element ? event.target.closest("[data-command-index]") : null;
        if (!button) return;
        const index = Number(button.getAttribute("data-command-index") || "0");
        activeCommandIndex = index;
        renderCommands((getSlashContext(input.value, input.selectionStart || 0) || { query: "" }).query, index);
      });
    }
  }

  const form = composerForm();
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const activeForm = composerForm();
      if (!activeForm) return;
      const activeInput = chatInput();
      const payload = activeInput && activeInput.value ? activeInput.value.trim() : "";
      if (!payload) {
        setComposerStatus("Enter a chat message or slash command.");
        return;
      }
      const formData = new window.FormData(activeForm);
      const feedback = composerFeedback(payload, activeForm.action);
      let keepBusyForNavigation = false;
      setComposerBusy(true, feedback.buttonLabel);
      setComposerStatus(feedback.status || "");
      clearStreamingReply();
      pendingOverlayHtml = "optimisticHtml" in feedback && feedback.optimisticHtml ? feedback.optimisticHtml : "";
      updatePendingLiveStatus("optimisticHtml" in feedback && feedback.optimisticHtml
        ? {
            statusLabel: "Queued",
            summary: "Saving your message and queuing the Factory run.",
          }
        : null);
      scheduleOverlayRender();
      window.fetch(activeForm.action, {
        method: activeForm.method || "POST",
        body: formData,
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      }).then((response: FactoryFetchResponse) => {
        const contentType = response.headers.get("content-type") || "";
        const bodyPromise = contentType.indexOf("application/json") >= 0
          ? response.json().catch(() => ({}))
          : response.text().catch(() => "Request failed.").then((text) => ({ error: text }));
        return bodyPromise.then((payloadBody) => {
          const body = parseComposeResponse(payloadBody);
          if (!response.ok) {
            pendingOverlayHtml = "";
            updatePendingLiveStatus(null);
            scheduleOverlayRender();
            setComposerStatus(body.error || "Request failed.");
            return;
          }
          if (pendingLiveStatus) {
            updatePendingLiveStatus({
              ...pendingLiveStatus,
              runId: body.live?.runId || pendingLiveStatus.runId,
              jobId: body.live?.jobId || pendingLiveStatus.jobId,
              summary: body.live?.jobId
                ? "Run queued. Waiting for a worker to pick it up."
                : pendingLiveStatus.summary,
            });
            scheduleOverlayRender();
          }
          if (body.selection?.objectiveId && /^\/(?:obj|new)\b/i.test(payload)) {
            pendingOverlayHtml = `<section class=" border border-primary/30 bg-primary/10 px-3 py-2">
              <div class="text-xs font-semibold text-primary">Objective started</div>
              <div class="mt-1 text-xs text-foreground">${escapeHtml(body.selection.objectiveId)}</div>
            </section>`;
            scheduleOverlayRender();
          }
          if (body.location) {
            keepBusyForNavigation = true;
            return applyInlineLocation(body.location, "push").then((handledInline) => {
              if (!handledInline) return;
              queueIslandRefresh("chat", 60);
              queueIslandRefresh("workbench", 90);
              keepBusyForNavigation = false;
              resetComposerAfterSuccess();
            });
          }
          keepBusyForNavigation = true;
          if (typeof window.location.reload === "function") {
            window.location.reload();
            return;
          }
          throw new Error("Request failed.");
        });
      }).catch((error: unknown) => {
        pendingOverlayHtml = "";
        updatePendingLiveStatus(null);
        scheduleOverlayRender();
        setComposerStatus(error instanceof Error ? error.message : "Request failed.");
      }).finally(() => {
        if (!keepBusyForNavigation) setComposerBusy(false);
      });
    });
  }

  const scroll = chatScroll();
  if (scroll) {
    scroll.addEventListener("scroll", () => {
      shouldStickToBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
    }, { passive: true });
  }

  document.addEventListener("click", (event) => {
    const target = workbenchNavigationTarget(event);
    if (!target || !isInlineWorkbenchLocation(target.location)) return;
    event.preventDefault();
    applyInlineLocation(target.location, target.historyMode).catch(() => {
      navigateWithFeedback(target.location);
    });
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.getAttribute("data-factory-profile-select") !== "true") return;
    const location = typeof (target as HTMLInputElement).value === "string"
      ? (target as HTMLInputElement).value
      : "";
    if (!location) return;
    applyInlineLocation(location, "push").catch(() => {
      navigateWithFeedback(location);
    });
  });

  if (typeof window.addEventListener === "function") {
    window.addEventListener("popstate", () => {
      applyInlineLocation(String(window.location && window.location.href ? window.location.href : shellPath()), "replace").catch(() => {
        // Fall through to browser URL if inline hydration fails.
      });
    });
  }

  document.addEventListener("htmx:afterSwap", (event) => {
    const target = event && "target" in event ? (event.target as EventTarget | null) : null;
    if (!(target instanceof HTMLElement)) return;
    if (target.id !== "factory-workbench-chat") return;
    handleWorkbenchChatSwap(target);
  });

  window.requestAnimationFrame(() => {
    const nextScroll = chatScroll();
    if (!nextScroll) return;
    if (typeof nextScroll.scrollTo === "function") {
      nextScroll.scrollTo({ top: nextScroll.scrollHeight, behavior: "auto" });
    } else {
      nextScroll.scrollTop = nextScroll.scrollHeight;
    }
  });
  const bootRoute = readDocumentRouteState();
  const replayStorage = sessionStorageApi();
  const replay = parseWorkbenchReplay(
    replayStorage?.getItem(replayStorageKey(bootRoute)) ?? null,
  );
  dispatchWorkbenchAction({ type: "boot", route: bootRoute });
  const replayRoute = mergeReplayRoute(workbenchState.appliedRoute, replay);
  if (replay && (replayRoute.routeKey !== workbenchState.appliedRoute.routeKey || replay.liveOverlay)) {
    dispatchWorkbenchAction({
      type: "session.replayed",
      route: replayRoute,
      liveOverlay: replay.liveOverlay,
    });
    pendingLiveStatus = replay.liveOverlay
      ? {
          statusLabel: replay.liveOverlay.statusLabel,
          summary: replay.liveOverlay.summary,
          runId: replay.liveOverlay.runId,
          jobId: replay.liveOverlay.jobId,
        }
      : null;
    applyRouteState(replayRoute, replayRoute.routeKey === bootRoute.routeKey ? "none" : "replace");
  } else {
    applyRouteState(workbenchState.appliedRoute, "none");
  }
  scheduleOverlayRender();
  connectLiveUpdates();
};
