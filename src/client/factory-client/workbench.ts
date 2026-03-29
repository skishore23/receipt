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
  dispatchBodyEvent,
  escapeHtml,
  parseCommands,
  queueBodyEvent,
  type FactoryCommand,
  type FactoryFetchResponse,
} from "./shared";

type HtmxApi = {
  readonly process?: (elt: Element) => void;
};

type WorkbenchShellSnapshot = {
  readonly pageTitle?: string;
  readonly location?: string;
  readonly route?: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
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
  | "objectives"
  | "activity"
  | "history";

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
    objectives: 0,
    activity: 0,
    history: 0,
  };
  let fragmentRefreshInFlight: Record<WorkbenchFragmentKind, boolean> = {
    header: false,
    summary: false,
    objectives: false,
    activity: false,
    history: false,
  };
  let fragmentRefreshQueued: Record<WorkbenchFragmentKind, boolean> = {
    header: false,
    summary: false,
    objectives: false,
    activity: false,
    history: false,
  };
  let pendingOverlayHtml = "";
  let pendingLiveStatus: PendingLiveStatus | null = null;
  let navigationRevision = 0;
  let overlayRenderQueued = false;
  let inlineNavigationTarget = "";
  let inlineNavigationAbortController: AbortController | null = null;

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

  const currentSearch = () => String(window.location && window.location.search ? window.location.search : "");

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

  const renderPendingLiveStatus = (status: PendingLiveStatus): string => '<section class="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">' +
    '<div class="flex min-w-0 items-start justify-between gap-2">' +
      '<div class="min-w-0 flex-1">' +
        '<div class="flex flex-wrap items-center gap-2">' +
          '<span class="text-xs font-semibold text-foreground">Live status</span>' +
          '<span class="inline-flex shrink-0 items-center rounded-full border border-primary/20 bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">' + escapeHtml(status.statusLabel) + "</span>" +
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
      pendingLiveStatus = null;
    }
    const runId = streamingReply?.runId;
    if (runId && state.terminalRunIds.indexOf(runId) >= 0) {
      streamingReply = null;
    }
    scheduleOverlayRender();
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
      location: asString(record.location),
      route: routeRecord
        ? {
            profileId: asString(routeRecord.profileId),
            chatId: asString(routeRecord.chatId),
            objectiveId: asString(routeRecord.objectiveId),
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

  const syncWorkbenchRouteData = (input: {
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly focusKind?: string;
    readonly focusId?: string;
  }) => {
    if (!document.body) return;
    document.body.setAttribute("data-chat-id", input.chatId ?? "");
    document.body.setAttribute("data-objective-id", input.objectiveId ?? "");
    document.body.setAttribute("data-focus-kind", input.focusKind ?? "");
    document.body.setAttribute("data-focus-id", input.focusId ?? "");
  };

  const applyWorkbenchShellSnapshot = (snapshot: WorkbenchShellSnapshot, url: URL) => {
    if (snapshot.pageTitle) document.title = snapshot.pageTitle;
    if (document.body) document.body.removeAttribute("data-workbench-shell-lazy");
    syncWorkbenchRouteData({
      chatId: snapshot.route?.chatId ?? asString(url.searchParams.get("chat")) ?? undefined,
      objectiveId: snapshot.route?.objectiveId ?? asString(url.searchParams.get("objective")) ?? undefined,
      focusKind: snapshot.route?.focusKind,
      focusId: snapshot.route?.focusId,
    });
    const currentWorkbenchHeader = workbenchHeader();
    if (currentWorkbenchHeader && snapshot.workbenchHeaderPath) {
      currentWorkbenchHeader.setAttribute("hx-get", snapshot.workbenchHeaderPath);
    }
    if (currentWorkbenchHeader && typeof snapshot.workbenchHeaderHtml === "string") {
      currentWorkbenchHeader.innerHTML = snapshot.workbenchHeaderHtml;
    }

    const currentChatHeader = chatHeader();
    if (currentChatHeader && typeof snapshot.chatHeaderHtml === "string") {
      currentChatHeader.innerHTML = snapshot.chatHeaderHtml;
    }

    const currentWorkbench = workbenchContainer();
    if (currentWorkbench && snapshot.workbenchIslandPath) currentWorkbench.setAttribute("hx-get", snapshot.workbenchIslandPath);
    if (currentWorkbench && typeof snapshot.workbenchHtml === "string") currentWorkbench.innerHTML = snapshot.workbenchHtml;

    const currentChat = chatContainer();
    if (currentChat && snapshot.chatIslandPath) currentChat.setAttribute("hx-get", snapshot.chatIslandPath);
    if (currentChat && typeof snapshot.chatHtml === "string") currentChat.innerHTML = snapshot.chatHtml;

    const currentBackgroundRoot = backgroundRoot();
    if (currentBackgroundRoot && snapshot.backgroundEventsPath) currentBackgroundRoot.setAttribute("data-events-path", snapshot.backgroundEventsPath);

    const currentChatRoot = chatRoot();
    if (currentChatRoot && snapshot.chatEventsPath) currentChatRoot.setAttribute("data-events-path", snapshot.chatEventsPath);

    const input = chatInput();
    if (input && snapshot.composerPlaceholder) {
      input.setAttribute("placeholder", snapshot.composerPlaceholder);
    }
    const form = composerForm();
    if (form && snapshot.composeAction) {
      form.action = snapshot.composeAction;
    }
    const currentStreamingLabel = streamingLabel();
    if (currentStreamingLabel && snapshot.streamingLabel) {
      currentStreamingLabel.textContent = snapshot.streamingLabel;
    }
    connectLiveUpdates();
    htmx()?.process?.(currentWorkbenchHeader ?? document.body);
    htmx()?.process?.(currentBackgroundRoot ?? document.body);
    htmx()?.process?.(currentChatRoot ?? document.body);
    scheduleOverlayRender();
  };

  const handleWorkbenchChatSwap = (target: HTMLElement) => {
    const currentObjectiveId = document.body.getAttribute("data-objective-id") || "";
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
        dispatchBodyEvent("factory:scope-changed", {
          objectiveId: discoveredObjectiveId,
          chatId: document.body.getAttribute("data-chat-id") || undefined,
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
      case "objectives":
        return workbenchObjectivesBlock();
      case "activity":
        return workbenchActivityBlock();
      case "history":
        return workbenchHistoryBlock();
      default:
        return null;
    }
  };

  const refreshWorkbenchFragmentNow = (kind: WorkbenchFragmentKind, expectedSearch: string) => {
    const target = workbenchFragment(kind);
    const path = target?.getAttribute("hx-get");
    if (!target || !path) return Promise.resolve();
    return fetchHtml(path).then((markup) => {
      if (expectedSearch !== currentSearch()) return;
      target.innerHTML = markup;
      htmx()?.process?.(target);
    });
  };

  const queueWorkbenchFragmentRefresh = (
    kind: WorkbenchFragmentKind,
    delayMs: number,
    searchOverride?: string,
  ) => {
    if (fragmentRefreshTimers[kind]) window.clearTimeout(fragmentRefreshTimers[kind]);
    fragmentRefreshTimers[kind] = window.setTimeout(() => {
      fragmentRefreshTimers[kind] = 0;
      const expectedSearch = typeof searchOverride === "string" ? searchOverride : currentSearch();
      if (fragmentRefreshInFlight[kind]) {
        fragmentRefreshQueued[kind] = true;
        return;
      }
      fragmentRefreshInFlight[kind] = true;
      refreshWorkbenchFragmentNow(kind, expectedSearch).catch(() => {
        // Ignore transient fragment failures; the full panel refresh path still exists.
      }).finally(() => {
        fragmentRefreshInFlight[kind] = false;
        if (!fragmentRefreshQueued[kind]) return;
        fragmentRefreshQueued[kind] = false;
        queueWorkbenchFragmentRefresh(kind, delayMs, expectedSearch);
      });
    }, Math.max(0, delayMs));
  };

  const queueProfileBoardRefresh = (delayMs: number, searchOverride?: string) => {
    queueWorkbenchFragmentRefresh("header", delayMs, searchOverride);
    queueWorkbenchFragmentRefresh("summary", delayMs, searchOverride);
    queueWorkbenchFragmentRefresh("objectives", delayMs, searchOverride);
    queueWorkbenchFragmentRefresh("history", delayMs, searchOverride);
  };

  const queueObjectiveRuntimeRefresh = (delayMs: number, searchOverride?: string) => {
    queueWorkbenchFragmentRefresh("header", delayMs, searchOverride);
    queueWorkbenchFragmentRefresh("summary", delayMs, searchOverride);
    queueWorkbenchFragmentRefresh("activity", delayMs, searchOverride);
  };

  const refreshIslandNow = (kind: "chat" | "workbench", expectedSearch: string) => {
    const target = islandContainer(kind);
    const path = target?.getAttribute("hx-get");
    if (!target || !path) return Promise.resolve();
    return fetchHtml(path).then((markup) => {
      if (expectedSearch !== currentSearch()) return;
      target.innerHTML = markup;
      htmx()?.process?.(target);
      if (kind === "chat") handleWorkbenchChatSwap(target);
    });
  };

  const queueIslandRefresh = (kind: "chat" | "workbench", delayMs: number, searchOverride?: string) => {
    if (refreshTimers[kind]) window.clearTimeout(refreshTimers[kind]);
    refreshTimers[kind] = window.setTimeout(() => {
      refreshTimers[kind] = 0;
      const expectedSearch = typeof searchOverride === "string" ? searchOverride : currentSearch();
      if (refreshInFlight[kind]) {
        refreshQueued[kind] = true;
        return;
      }
      refreshInFlight[kind] = true;
      refreshIslandNow(kind, expectedSearch).catch(() => {
        // Ignore transient refresh failures; the next navigation or SSE update can retry.
      }).finally(() => {
        refreshInFlight[kind] = false;
        if (!refreshQueued[kind]) return;
        refreshQueued[kind] = false;
        queueIslandRefresh(kind, delayMs, expectedSearch);
      });
    }, Math.max(0, delayMs));
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
      chatEventSource.addEventListener("agent-refresh", (event) => {
        const message = event as MessageEvent<string>;
        if (ignoreInit(message)) return;
        if (pendingLiveStatus && !streamingReply) {
          pendingLiveStatus = {
            ...pendingLiveStatus,
            statusLabel: "Working",
            summary: "Factory is running tools and preparing the reply.",
          };
          scheduleOverlayRender();
        }
        queueIslandRefresh("chat", 180);
      });
      chatEventSource.addEventListener("job-refresh", (event) => {
        const message = event as MessageEvent<string>;
        if (ignoreInit(message)) return;
        if (pendingLiveStatus && !streamingReply && pendingLiveStatus.statusLabel === "Queued") {
          pendingLiveStatus = {
            ...pendingLiveStatus,
            statusLabel: "Starting",
            summary: "A worker picked up the run and is preparing the first response.",
          };
          scheduleOverlayRender();
        }
        queueIslandRefresh("chat", 180);
        queueIslandRefresh("workbench", 220);
      });
      chatEventSource.addEventListener("factory-refresh", (event) => {
        const message = event as MessageEvent<string>;
        if (ignoreInit(message)) return;
        queueIslandRefresh("chat", 180);
        queueIslandRefresh("workbench", 220);
      });
      chatEventSource.addEventListener("objective-runtime-refresh", (event) => {
        const message = event as MessageEvent<string>;
        if (ignoreInit(message)) return;
        queueIslandRefresh("chat", 180);
      });
      chatEventSource.addEventListener("agent-token", (event) => {
        const payload = parseTokenEventPayload((event as MessageEvent<string>).data || "");
        if (!payload) return;
        pendingLiveStatus = null;
        const state = currentChatState();
        const runId = payload.runId || state.activeRunId || streamingReply?.runId;
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
      backgroundEventSource.addEventListener("job-refresh", (event) => {
        const message = event as MessageEvent<string>;
        if (ignoreInit(message)) return;
        queueIslandRefresh("workbench", 220);
      });
      backgroundEventSource.addEventListener("factory-refresh", (event) => {
        const message = event as MessageEvent<string>;
        if (ignoreInit(message)) return;
        queueIslandRefresh("workbench", 220);
      });
      backgroundEventSource.addEventListener("profile-board-refresh", (event) => {
        const message = event as MessageEvent<string>;
        if (ignoreInit(message)) return;
        queueProfileBoardRefresh(220);
      });
      backgroundEventSource.addEventListener("objective-runtime-refresh", (event) => {
        const message = event as MessageEvent<string>;
        if (ignoreInit(message)) return;
        queueObjectiveRuntimeRefresh(220);
      });
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
    const nextPath = url.pathname + (url.search || "") + (url.hash || "");
    const current = currentUrl();
    const currentPath = current ? `${current.pathname}${current.search || ""}${current.hash || ""}` : "";
    if (historyMode !== "replace" && inlineNavigationTarget === nextPath) return Promise.resolve(true);
    if (historyMode !== "replace" && !inlineNavigationAbortController && nextPath === currentPath) return Promise.resolve(true);
    inlineNavigationAbortController?.abort();
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    inlineNavigationAbortController = abortController;
    inlineNavigationTarget = nextPath;
    const revision = ++navigationRevision;
    return fetchWorkbenchShell(url.search || "", abortController?.signal).then((snapshot) => {
      if (revision !== navigationRevision) return true;
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

  const hydrateLazyWorkbenchShell = () => {
    if (!document.body || document.body.getAttribute("data-workbench-shell-lazy") !== "true") return;
    const current = currentUrl();
    if (!current) return;
    const requestUrl = new URL(current.href);
    if (!requestUrl.searchParams.get("chat")) {
      const chatId = document.body.getAttribute("data-chat-id") || "";
      if (chatId) requestUrl.searchParams.set("chat", chatId);
    }
    applyInlineLocation(requestUrl.href, "replace", current.href).catch(() => {
      navigateWithFeedback(current.href);
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
      pendingLiveStatus = "optimisticHtml" in feedback && feedback.optimisticHtml
        ? {
            statusLabel: "Queued",
            summary: "Saving your message and queuing the Factory run.",
          }
        : null;
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
            pendingLiveStatus = null;
            scheduleOverlayRender();
            setComposerStatus(body.error || "Request failed.");
            return;
          }
          if (pendingLiveStatus) {
            pendingLiveStatus = {
              ...pendingLiveStatus,
              runId: body.live?.runId || pendingLiveStatus.runId,
              jobId: body.live?.jobId || pendingLiveStatus.jobId,
              summary: body.live?.jobId
                ? "Run queued. Waiting for a worker to pick it up."
                : pendingLiveStatus.summary,
            };
            scheduleOverlayRender();
          }
          if (body.selection?.objectiveId && /^\/(?:obj|new)\b/i.test(payload)) {
            pendingOverlayHtml = `<section class="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2">
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
              queueBodyEvent("factory:chat-refresh", 120, {
                chatId: document.body.getAttribute("data-chat-id") || undefined,
                objectiveId: document.body.getAttribute("data-objective-id") || undefined,
              });
              queueBodyEvent("factory:workbench-refresh", 180, {
                objectiveId: document.body.getAttribute("data-objective-id") || undefined,
              });
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
        pendingLiveStatus = null;
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

  if (document.body) {
    document.body.addEventListener("factory:chat-refresh", () => {
      queueIslandRefresh("chat", 0);
    });
    document.body.addEventListener("factory:workbench-refresh", () => {
      queueIslandRefresh("workbench", 0);
    });
    document.body.addEventListener("factory:scope-changed", () => {
      queueIslandRefresh("workbench", 0);
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
  scheduleOverlayRender();
  connectLiveUpdates();
  hydrateLazyWorkbenchShell();
};
