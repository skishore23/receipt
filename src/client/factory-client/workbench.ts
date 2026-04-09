import {
  composerFeedback,
  parseComposeResponse,
  resolveFactoryUrl,
  shellPath,
} from "./compose-navigation";
import {
  parseTokenEventPayload,
  renderEphemeralTurn,
} from "./live-updates";
import {
  readReactiveRefreshPath,
} from "./reactive";
import {
  DEFAULT_COMMANDS,
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
  type FactoryWorkbenchEphemeralTurn,
  type FactoryWorkbenchRouteState,
  type FactoryWorkbenchUiState,
} from "./workbench-state";

type WorkbenchFragmentKind =
  | "header"
  | "chat-header"
  | "summary"
  | "activity"
  | "objectives"
  | "history";

type WorkbenchRefreshTargetKey = WorkbenchFragmentKind | "chat" | "workbench";

const isAbortError = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "name" in error && (error as { readonly name?: string }).name === "AbortError");

export const initFactoryWorkbenchBrowser = () => {
  let shouldStickToBottom = true;
  let isComposing = false;
  let activeCommandIndex = 0;
  let defaultSubmitLabel = "Send";
  let ephemeralTurn: FactoryWorkbenchEphemeralTurn | null = null;
  let overlayRenderQueued = false;
  let backgroundEvents: EventSource | null = null;
  let backgroundEventsUrl: string | null = null;
  let chatEvents: EventSource | null = null;
  let chatEventsUrl: string | null = null;
  const islandRefreshControllers = new Map<"chat" | "workbench", AbortController>();
  const fragmentRefreshControllers = new Map<WorkbenchFragmentKind, AbortController>();

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

  const composerShell = () => {
    const node = document.getElementById("factory-workbench-composer-shell");
    return node instanceof HTMLElement ? node : null;
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

  const ephemeralTranscript = () => {
    const node = document.getElementById("factory-chat-ephemeral");
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

  const workbenchRailShell = () => {
    const node = document.getElementById("factory-workbench-rail-shell");
    return node instanceof HTMLElement ? node : null;
  };

  const workbenchFocusShell = () => {
    const node = document.getElementById("factory-workbench-focus-shell");
    return node instanceof HTMLElement ? node : null;
  };

  const workbenchRailScroll = () => {
    const node = document.getElementById("factory-workbench-rail-scroll");
    return node instanceof HTMLElement ? node : null;
  };

  const workbenchFocusScroll = () => {
    const node = document.getElementById("factory-workbench-focus-scroll");
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

  const chatRegion = () => {
    const node = document.getElementById("factory-workbench-chat-region");
    return node instanceof HTMLElement ? node : null;
  };

  const chatBody = () => {
    const node = document.getElementById("factory-workbench-chat-body");
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
        transcriptSignature: "0:empty",
        lastItemKind: undefined,
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
      transcriptSignature: root.getAttribute("data-transcript-signature") || "0:empty",
      lastItemKind: asString(root.getAttribute("data-last-item-kind")) as "user" | "assistant" | "system" | "work" | "objective_event" | undefined,
    };
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
    page: asString(url?.searchParams.get("page")) ?? bodyRouteValue("data-page"),
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

  const processHtmx = (root?: Element | null) => {
    const scope = root instanceof Element ? root : document.body;
    const windowWithHtmx = window as unknown as { htmx?: { process?: (node: Element) => void } };
    const process = typeof window !== "undefined" && typeof windowWithHtmx.htmx?.process === "function"
      ? windowWithHtmx.htmx.process
      : undefined;
    if (scope && process) process(scope);
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
    if (target.closest("[hx-get]")) return null;
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

  const visiblePendingStatusLabel = (turn: FactoryWorkbenchEphemeralTurn): string => {
    if (turn.surface === "chat" && turn.statusLabel === "Queued") return "Thinking";
    return turn.phase === "streaming" ? "Streaming" : turn.statusLabel;
  };

  const scheduleOverlayRender = () => {
    if (overlayRenderQueued) return;
    overlayRenderQueued = true;
    window.requestAnimationFrame(() => {
      overlayRenderQueued = false;
      const tail = ephemeralTranscript();
      if (!tail) return;
      tail.innerHTML = ephemeralTurn
        ? renderEphemeralTurn({
            profileLabel: currentChatState().activeProfileLabel || "Assistant",
            surface: ephemeralTurn.surface,
            phase: ephemeralTurn.phase,
            statusLabel: visiblePendingStatusLabel(ephemeralTurn),
            summary: ephemeralTurn.summary,
            userText: ephemeralTurn.userText,
            assistantText: ephemeralTurn.assistantText,
            runId: ephemeralTurn.runId,
            jobId: ephemeralTurn.jobId,
          })
        : "";
      if (ephemeralTurn && shouldStickToBottom) {
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

  const updateEphemeralTurn = (
    nextTurn: FactoryWorkbenchEphemeralTurn | null,
    acknowledged?: {
      readonly runId?: string;
      readonly jobId?: string;
      readonly terminal?: boolean;
    },
  ) => {
    ephemeralTurn = nextTurn;
    if (nextTurn) {
      dispatchWorkbenchAction({
        type: "composer.queued",
        ephemeralTurn: {
          ...nextTurn,
          savedAt: Date.now(),
        },
      });
      scheduleOverlayRender();
      return;
    }
    dispatchWorkbenchAction({
      type: "composer.acknowledged",
      runId: acknowledged?.runId,
      jobId: acknowledged?.jobId,
      terminal: acknowledged?.terminal ?? true,
    });
    scheduleOverlayRender();
  };

  const reduceEphemeralTurnOnSubmit = (
    payload: string,
    feedback: ReturnType<typeof composerFeedback>,
  ): FactoryWorkbenchEphemeralTurn | null => {
    if (!("showPendingStream" in feedback) || !feedback.showPendingStream) return null;
    return {
      surface: "chat",
      phase: "pending",
      statusLabel: "Sending",
      summary: "Sending your message.",
      userText: "optimisticText" in feedback ? feedback.optimisticText : payload,
      transcriptSignature: currentChatState().transcriptSignature,
      savedAt: Date.now(),
    };
  };

  const reduceEphemeralTurnOnComposeResponse = (
    turn: FactoryWorkbenchEphemeralTurn | null,
    payload: string,
    body: ReturnType<typeof parseComposeResponse>,
  ): FactoryWorkbenchEphemeralTurn | null => {
    if (!turn) return null;
    if (body.selection?.objectiveId && /^\/(?:obj|new)\b/i.test(payload)) {
      return {
        ...turn,
        surface: "handoff",
        statusLabel: "Queued",
        summary: `Objective ${body.selection.objectiveId} is now running. You can ask the next question while it updates on the left.`,
        runId: body.live?.runId || turn.runId,
        jobId: body.live?.jobId || turn.jobId,
      };
    }
    return {
      ...turn,
      surface: "chat",
      phase: "pending",
      statusLabel: "Queued",
      summary: "Thinking about the reply.",
      runId: body.live?.runId || turn.runId,
      jobId: body.live?.jobId || turn.jobId,
    };
  };

  const reduceEphemeralTurnOnComposeRefresh = (
    turn: FactoryWorkbenchEphemeralTurn | null,
    eventName: string,
  ): FactoryWorkbenchEphemeralTurn | null => {
    if (!turn || turn.surface !== "chat" || turn.phase === "streaming") return turn;
    if (eventName !== "agent-refresh" && eventName !== "job-refresh") return turn;
    return {
      ...turn,
      statusLabel: "Starting",
      summary: "Starting the reply.",
    };
  };

  const reduceEphemeralTurnOnToken = (
    turn: FactoryWorkbenchEphemeralTurn | null,
    payload: { readonly runId?: string; readonly delta: string },
  ): FactoryWorkbenchEphemeralTurn => {
    const state = currentChatState();
    const runId = payload.runId || state.activeRunId || turn?.runId;
    return {
      surface: "chat",
      phase: "streaming",
      statusLabel: turn?.statusLabel ?? "Starting",
      summary: "Reply streaming live.",
      userText: turn?.userText,
      assistantText: `${turn?.runId === runId ? (turn.assistantText ?? "") : ""}${payload.delta}`,
      runId,
      jobId: turn?.jobId,
      transcriptSignature: turn?.transcriptSignature ?? state.transcriptSignature,
      savedAt: Date.now(),
    };
  };

  const captureChatScrollState = () => {
    const scroll = chatScroll();
    if (!scroll) return null;
    return {
      top: scroll.scrollTop,
      height: scroll.scrollHeight,
      bottomOffset: Math.max(0, scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight),
    };
  };

  const restoreChatScrollState = (state: { readonly top: number; readonly height: number; readonly bottomOffset: number }) => {
    const scroll = chatScroll();
    if (!scroll) return;
    const atBottom = state.bottomOffset < 120;
    const nextTop = atBottom
      ? scroll.scrollHeight
      : Math.max(0, scroll.scrollHeight - scroll.clientHeight - state.bottomOffset);
    if (typeof scroll.scrollTo === "function") {
      scroll.scrollTo({ top: nextTop, behavior: "auto" });
    } else {
      scroll.scrollTop = nextTop;
    }
    shouldStickToBottom = atBottom;
  };

  const captureDocumentScrollState = () => {
    const scrollingElement = document.scrollingElement;
    return {
      top: typeof window.scrollY === "number"
        ? window.scrollY
        : (scrollingElement instanceof HTMLElement ? scrollingElement.scrollTop : 0),
    };
  };

  const restoreDocumentScrollState = (state: { readonly top: number }) => {
    if (typeof window.scrollTo === "function") {
      window.scrollTo({ top: state.top, behavior: "auto" });
      return;
    }
    const scrollingElement = document.scrollingElement;
    if (scrollingElement instanceof HTMLElement) {
      scrollingElement.scrollTop = state.top;
    }
  };

  const captureWorkbenchPaneScrollState = () => {
    const panes = [workbenchRailScroll(), workbenchFocusScroll()]
      .filter((pane): pane is HTMLElement => Boolean(pane))
      .map((pane) => ({
        key: pane.getAttribute("data-preserve-scroll-key") || pane.id,
        top: pane.scrollTop,
        height: pane.scrollHeight,
        bottomOffset: Math.max(0, pane.scrollHeight - pane.scrollTop - pane.clientHeight),
      }));
    return panes.length > 0 ? panes : null;
  };

  const restoreWorkbenchPaneScrollState = (
    state: ReadonlyArray<{
      readonly key: string;
      readonly top: number;
      readonly height: number;
      readonly bottomOffset: number;
    }>,
  ) => {
    for (const paneState of state) {
      const selector = `[data-preserve-scroll-key="${paneState.key}"]`;
      const pane = document.querySelector(selector);
      if (!(pane instanceof HTMLElement)) continue;
      const atBottom = paneState.bottomOffset < 120;
      const nextTop = atBottom
        ? pane.scrollHeight
        : Math.max(0, pane.scrollHeight - pane.clientHeight - paneState.bottomOffset);
      if (typeof pane.scrollTo === "function") {
        pane.scrollTo({ top: nextTop, behavior: "auto" });
      } else {
        pane.scrollTop = nextTop;
      }
    }
  };

  const reconcileEphemeralTurn = () => {
    const state = currentChatState();
    if (!ephemeralTurn) return;
    let nextTurn = ephemeralTurn;
    if (
      nextTurn.userText
      && nextTurn.transcriptSignature
      && state.transcriptSignature !== nextTurn.transcriptSignature
    ) {
      nextTurn = {
        ...nextTurn,
        userText: undefined,
        transcriptSignature: state.transcriptSignature,
      };
    }
    if (
      nextTurn.surface !== "chat"
      && (
        (nextTurn.runId && (
          state.activeRunId === nextTurn.runId
          || state.knownRunIds.indexOf(nextTurn.runId) >= 0
          || state.terminalRunIds.indexOf(nextTurn.runId) >= 0
        ))
        || (!nextTurn.runId && Boolean(state.activeRunId))
      )
    ) {
      updateEphemeralTurn(null, {
        runId: nextTurn.runId,
        jobId: nextTurn.jobId,
      });
      return;
    }
    if (nextTurn.runId && state.terminalRunIds.indexOf(nextTurn.runId) >= 0) {
      updateEphemeralTurn(null, {
        runId: nextTurn.runId,
        jobId: nextTurn.jobId,
      });
      return;
    }
    if (
      nextTurn.runId
      && state.activeRunId !== nextTurn.runId
      && state.knownRunIds.indexOf(nextTurn.runId) < 0
      && state.terminalRunIds.indexOf(nextTurn.runId) < 0
    ) {
      updateEphemeralTurn(null, {
        runId: nextTurn.runId,
        jobId: nextTurn.jobId,
      });
      return;
    }
    ephemeralTurn = nextTurn;
    scheduleOverlayRender();
  };

  const acceptsStreamingRun = (runId: string | undefined): boolean => {
    if (!workbenchState.appliedRoute.objectiveId) return true;
    if (!runId) return false;
    if (ephemeralTurn?.runId === runId) return true;
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

  const prefillComposerCommand = (command: string) => {
    const input = chatInput();
    if (!input) return;
    input.value = command;
    const caret = command.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    autoResizeInput();
    setExpanded(false);
    setComposerStatus(command.trim() ? `Draft ready: ${command.trim()}` : "");
    const shell = composerShell();
    if (shell && typeof shell.scrollIntoView === "function") {
      shell.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    input.focus();
  };

  const consumeComposeCommandFromLocation = (location: string) => {
    const url = resolveFactoryUrl(location);
    if (!url) return;
    const command = asString(url.searchParams.get("compose"));
    if (!command) return;
    prefillComposerCommand(command);
    url.searchParams.delete("compose");
    setHistory(url, "replace");
  };

  type PendingHtmxSwapState = {
    readonly targetId: string;
    readonly documentScroll?: { readonly top: number } | null;
    readonly workbenchPanes?: ReadonlyArray<{
      readonly key: string;
      readonly top: number;
      readonly height: number;
      readonly bottomOffset: number;
    }> | null;
    readonly chat?: { readonly top: number; readonly height: number; readonly bottomOffset: number } | null;
  };

  const pendingHtmxSwapStates = new Map<string, PendingHtmxSwapState>();

  const syncWorkbenchStateFromLocation = () => {
    const url = currentUrl();
    if (!url) return;
    const nextRoute = routeStateFromLocation(url);
    dispatchWorkbenchAction({
      type: "route.applied",
      route: nextRoute,
    });
    applyRouteState(nextRoute, "none");
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

  const startRefreshController = <Key extends string>(
    controllers: Map<Key, AbortController>,
    key: Key,
    options?: {
      readonly replaceInFlight?: boolean;
    },
  ): AbortController | undefined => {
    if (typeof AbortController !== "function") return undefined;
    if (options?.replaceInFlight) controllers.get(key)?.abort();
    const controller = new AbortController();
    controllers.set(key, controller);
    return controller;
  };

  const finishRefreshController = <Key extends string>(
    controllers: Map<Key, AbortController>,
    key: Key,
    controller?: AbortController,
  ) => {
    if (!controller) return;
    if (controllers.get(key) === controller) controllers.delete(key);
  };

  const abortFragmentRefresh = (kind: WorkbenchFragmentKind) => {
    fragmentRefreshControllers.get(kind)?.abort();
  };

  const abortIslandRefresh = (kind: "chat" | "workbench") => {
    islandRefreshControllers.get(kind)?.abort();
  };

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

  const chatHeaderPathForRoute = (route: FactoryWorkbenchRouteState): string =>
    `/factory/island/chat/header${routeSearch(route)}`;

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
    if (route.objectiveId) params.set("objective", route.objectiveId);
    if (route.focusKind === "job" && route.focusId) params.set("job", route.focusId);
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
    const tail = ephemeralTranscript();
    if (tail) tail.classList.toggle("hidden", !isChatTab);
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
    const setRefreshPath = (element: HTMLElement | null, path: string) => {
      if (!element) return;
      element.setAttribute("data-refresh-path", path);
    };
    const currentWorkbenchHeader = workbenchHeader();
    setRefreshPath(currentWorkbenchHeader, workbenchHeaderPathForRoute(route));
    const currentChatHeader = chatHeader();
    setRefreshPath(currentChatHeader, chatHeaderPathForRoute(route));
    const currentWorkbench = workbenchContainer();
    setRefreshPath(currentWorkbench, workbenchIslandPathForRoute(route));
    const currentFocusShell = workbenchFocusShell();
    setRefreshPath(currentFocusShell, `/factory/island/workbench/focus${routeSearch(route)}`);
    const currentRailShell = workbenchRailShell();
    setRefreshPath(currentRailShell, `/factory/island/workbench/rail${routeSearch(route)}`);
    const currentChatRegion = chatRegion();
    setRefreshPath(currentChatRegion, `/factory/island/workbench/chat-shell${routeSearch(route)}`);
    const currentChatBody = chatBody();
    setRefreshPath(currentChatBody, `/factory/island/workbench/chat-body${routeSearch(route)}`);
    const currentChat = chatContainer();
    setRefreshPath(currentChat, chatIslandPathForRoute(route));
    const currentBackgroundRoot = backgroundRoot();
    if (currentBackgroundRoot) currentBackgroundRoot.setAttribute("data-events-path", backgroundEventsPathForRoute(route));
    const currentChatRoot = chatRoot();
    if (currentChatRoot) currentChatRoot.setAttribute("data-events-path", chatEventsPathForRoute(route));
    const form = composerForm();
    if (form) form.action = `/factory/compose${routeSearch(route)}`;
    const summary = workbenchSummaryBlock();
    setRefreshPath(summary, workbenchBlockPathForRoute(route, "summary"));
    const activity = workbenchActivityBlock();
    setRefreshPath(activity, workbenchBlockPathForRoute(route, "activity"));
    const objectives = workbenchObjectivesBlock();
    setRefreshPath(objectives, workbenchBlockPathForRoute(route, "objectives"));
    const history = workbenchHistoryBlock();
    setRefreshPath(history, workbenchBlockPathForRoute(route, "history"));
  };

  const applyRouteState = (
    route: FactoryWorkbenchRouteState,
    historyMode?: "replace" | "push" | "none",
  ) => {
    syncWorkbenchRouteData(route);
    syncRouteBindings(route);
    syncInspectorTabVisibility(route.inspectorTab);
    syncInspectorTabControls(route.inspectorTab);
    syncWorkbenchEventSources();
    const historyUrl = resolveFactoryUrl(route.routeKey);
    if (historyUrl) setHistory(historyUrl, historyMode);
  };

  const handleWorkbenchChatSwap = (_target: HTMLElement) => {
    const scrollState = captureChatScrollState();
    reconcileEphemeralTurn();
    if (!scrollState) return;
    window.requestAnimationFrame(() => {
      restoreChatScrollState(scrollState);
    });
  };

  const islandContainer = (kind: "chat" | "workbench") =>
    kind === "chat" ? chatContainer() : workbenchContainer();

  const workbenchFragment = (kind: WorkbenchFragmentKind) => {
    switch (kind) {
      case "header":
        return workbenchHeader();
      case "chat-header":
        return chatHeader();
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

  function refreshWorkbenchFragmentNow(
    kind: WorkbenchFragmentKind,
    expectedRouteKey: string,
    options?: {
      readonly replaceInFlight?: boolean;
    },
  ) {
    const target = workbenchFragment(kind);
    const path = readReactiveRefreshPath(target);
    if (!target || !path) return Promise.resolve();
    const documentScrollState = captureDocumentScrollState();
    const controller = startRefreshController(fragmentRefreshControllers, kind, options);
    return fetchHtml(path, controller?.signal).then((markup) => {
      if (expectedRouteKey !== currentRouteKey()) return;
      target.innerHTML = markup;
      processHtmx(target);
      window.requestAnimationFrame(() => {
        restoreDocumentScrollState(documentScrollState);
      });
    }).catch((error: unknown) => {
      if (isAbortError(error)) return;
      throw error;
    }).finally(() => {
      finishRefreshController(fragmentRefreshControllers, kind, controller);
    });
  }

  function refreshIslandNow(
    kind: "chat" | "workbench",
    expectedRouteKey: string,
    options?: {
      readonly replaceInFlight?: boolean;
    },
  ) {
    const target = islandContainer(kind);
    const path = readReactiveRefreshPath(target);
    if (!target || !path) return Promise.resolve();
    const documentScrollState = captureDocumentScrollState();
    const paneScrollState = kind === "workbench" ? captureWorkbenchPaneScrollState() : null;
    if (kind === "workbench" && options?.replaceInFlight) {
      abortFragmentRefresh("summary");
      abortFragmentRefresh("activity");
      abortFragmentRefresh("objectives");
      abortFragmentRefresh("history");
    }
    const controller = startRefreshController(islandRefreshControllers, kind, options);
    return fetchHtml(path, controller?.signal).then((markup) => {
      if (expectedRouteKey !== currentRouteKey()) return;
      target.innerHTML = markup;
      processHtmx(target);
      if (kind === "chat") handleWorkbenchChatSwap(target);
      if (kind === "workbench" && paneScrollState) {
        window.requestAnimationFrame(() => {
          restoreWorkbenchPaneScrollState(paneScrollState);
          restoreDocumentScrollState(documentScrollState);
        });
        return;
      }
      window.requestAnimationFrame(() => {
        restoreDocumentScrollState(documentScrollState);
      });
    }).catch((error: unknown) => {
      if (isAbortError(error)) return;
      throw error;
    }).finally(() => {
      finishRefreshController(islandRefreshControllers, kind, controller);
    });
  }

  const refreshRouteTargetsNow = (
    targets: ReadonlyArray<WorkbenchRefreshTargetKey>,
    routeKeyOverride?: string,
  ) => {
    const seen = new Set<WorkbenchRefreshTargetKey>();
    const refreshes: Array<Promise<void>> = [];
    for (const target of targets) {
      if (seen.has(target)) continue;
      seen.add(target);
      if (target === "chat" || target === "workbench") {
        abortIslandRefresh(target);
        refreshes.push(
          refreshIslandNow(target, routeKeyOverride ?? currentRouteKey(), { replaceInFlight: true }).then(() => undefined),
        );
        continue;
      }
      abortFragmentRefresh(target);
      refreshes.push(
        refreshWorkbenchFragmentNow(target, routeKeyOverride ?? currentRouteKey(), { replaceInFlight: true }).then(() => undefined),
      );
    }
    return Promise.all(refreshes).then(() => undefined);
  };

  const scopeRefreshTargets = (
    current: FactoryWorkbenchRouteState,
    next: FactoryWorkbenchRouteState,
  ): ReadonlyArray<WorkbenchRefreshTargetKey> => {
    if (
      current.profileId !== next.profileId
      || current.chatId !== next.chatId
      || current.objectiveId !== next.objectiveId
    ) {
      return ["header", "chat-header", "workbench", "chat"];
    }
    if (current.detailTab !== next.detailTab) {
      return ["chat-header", "workbench"];
    }
    return ["header", "chat-header", "workbench", "chat"];
  };

  const chatEventsPath = () => {
    const node = chatRoot();
    return node?.getAttribute("data-events-path") || null;
  };

  const backgroundEventsPath = () => {
    const node = backgroundRoot();
    return node?.getAttribute("data-events-path") || null;
  };

  const dispatchWorkbenchBodyEvent = (eventName: string) => {
    if (document.body && typeof document.body.dispatchEvent === "function") {
      document.body.dispatchEvent(new Event(eventName, { bubbles: true }));
      return;
    }
    if (typeof document.dispatchEvent === "function") {
      document.dispatchEvent(new Event(eventName, { bubbles: true }));
    }
  };

  const declaredBodyRefreshEvents = (
    elements: ReadonlyArray<HTMLElement | null>,
  ): ReadonlyArray<string> => {
    const events = new Set<string>();
    for (const element of elements) {
      const descriptor = element?.getAttribute("data-refresh-on") || "";
      for (const part of descriptor.split(",")) {
        const match = part.trim().match(/^body:([^@]+?)(?:@(\d+))?$/i);
        if (match && match[1]) events.add(match[1]);
      }
    }
    return Array.from(events);
  };

  const closeBackgroundEvents = () => {
    if (backgroundEvents && typeof backgroundEvents.close === "function") backgroundEvents.close();
    backgroundEvents = null;
    backgroundEventsUrl = null;
  };

  const closeChatEvents = () => {
    if (chatEvents && typeof chatEvents.close === "function") chatEvents.close();
    chatEvents = null;
    chatEventsUrl = null;
  };

  const connectBackgroundEvents = () => {
    const nextUrl = backgroundEventsPath();
    if (!nextUrl) {
      closeBackgroundEvents();
      return;
    }
    if (backgroundEvents && backgroundEventsUrl === nextUrl) return;
    closeBackgroundEvents();
    backgroundEvents = new EventSource(nextUrl);
    backgroundEventsUrl = nextUrl;
    for (const eventName of declaredBodyRefreshEvents([
      workbenchRailShell(),
      workbenchFocusShell(),
      chatBody(),
    ])) {
      backgroundEvents.addEventListener(eventName, () => {
        dispatchWorkbenchBodyEvent(eventName);
      });
    }
  };

  const connectChatEvents = () => {
    const nextUrl = workbenchState.appliedRoute.inspectorTab === "chat" ? chatEventsPath() : null;
    if (!nextUrl) {
      closeChatEvents();
      return;
    }
    if (chatEvents && chatEventsUrl === nextUrl) return;
    closeChatEvents();
    chatEvents = new EventSource(nextUrl);
    chatEventsUrl = nextUrl;
    for (const eventName of declaredBodyRefreshEvents([chatBody()])) {
      chatEvents.addEventListener(eventName, () => {
        const nextTurn = reduceEphemeralTurnOnComposeRefresh(ephemeralTurn, eventName);
        if (nextTurn !== ephemeralTurn) updateEphemeralTurn(nextTurn);
        dispatchWorkbenchBodyEvent(eventName);
      });
    }
    chatEvents.addEventListener("agent-token", (event) => {
      const payload = parseTokenEventPayload((event as MessageEvent<string>).data || "");
      if (!payload) return;
      const runId = payload.runId || currentChatState().activeRunId || ephemeralTurn?.runId;
      if (!acceptsStreamingRun(runId)) return;
      ephemeralTurn = reduceEphemeralTurnOnToken(ephemeralTurn, payload);
      scheduleOverlayRender();
    });
    chatEvents.addEventListener("factory-stream-reset", () => {
      reconcileEphemeralTurn();
    });
  };

  const syncWorkbenchEventSources = () => {
    connectBackgroundEvents();
    connectChatEvents();
  };

  const refreshVisibleWorkbench = () => {
    syncWorkbenchEventSources();
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
      page: asString(url.searchParams.get("page")),
      focusKind: asString(url.searchParams.get("focusKind")),
      focusId: asString(url.searchParams.get("focusId")),
    });

  const applyInlineLocation = (
    location: string,
    historyMode?: "replace" | "push" | "none",
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
    const currentRoute = workbenchState.desiredRoute;
    const changeKind = classifyWorkbenchRouteChange(workbenchState.desiredRoute, nextRoute);
    if (changeKind === "noop") return Promise.resolve(true);
    if (changeKind === "inspector") {
      dispatchWorkbenchAction({ type: "inspector.changed", route: nextRoute });
      applyRouteState(nextRoute, "replace");
      if (nextRoute.inspectorTab === "chat") {
        window.requestAnimationFrame(() => {
          const input = chatInput();
          if (input) input.focus();
        });
      }
      return refreshRouteTargetsNow(["chat"], nextRoute.routeKey).then(() => true).catch(() => true);
    }
    if (changeKind === "focus") {
      dispatchWorkbenchAction({ type: "focus.changed", route: nextRoute });
      applyRouteState(nextRoute, "replace");
      return refreshRouteTargetsNow(["summary", "activity"], nextRoute.routeKey).then(() => true).catch(() => true);
    }
    if (changeKind === "filter") {
      dispatchWorkbenchAction({ type: "filter.changed", route: nextRoute });
      applyRouteState(nextRoute, "push");
      return refreshRouteTargetsNow(["header", "chat-header", "workbench"], nextRoute.routeKey).then(() => true).catch(() => true);
    }
    dispatchWorkbenchAction({
      type: "route.applied",
      route: nextRoute,
    });
    applyRouteState(nextRoute, historyMode ?? "push");
    return refreshRouteTargetsNow(scopeRefreshTargets(currentRoute, nextRoute), nextRoute.routeKey).then(() => {
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
    }).catch(() => true);
  };

  const htmxSwapTarget = (event: Event): HTMLElement | null => {
    const detail = (event as Event & {
      readonly detail?: {
        readonly target?: EventTarget | null;
        readonly elt?: EventTarget | null;
      };
    }).detail;
    const candidate = detail?.target instanceof HTMLElement
      ? detail.target
      : detail?.elt instanceof HTMLElement
        ? detail.elt
        : event.target instanceof HTMLElement
          ? event.target
          : null;
    return candidate;
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
      updateEphemeralTurn(reduceEphemeralTurnOnSubmit(payload, feedback));
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
            updateEphemeralTurn(null);
            setComposerStatus(body.error || "Request failed.");
            return;
          }
          updateEphemeralTurn(reduceEphemeralTurnOnComposeResponse(ephemeralTurn, payload, body));
          if (body.location) {
            keepBusyForNavigation = true;
            return applyInlineLocation(body.location, "push").then((handledInline) => {
              if (!handledInline) return;
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
        updateEphemeralTurn(null);
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
    const commandTarget = event.target instanceof Element ? event.target.closest("[data-factory-command]") : null;
    if (commandTarget instanceof HTMLElement) {
      event.preventDefault();
      const command = commandTarget.getAttribute("data-factory-command") || "";
      const focusHref = commandTarget.getAttribute("data-factory-focus-href") || "";
      const applyCommand = () => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            prefillComposerCommand(command);
          });
        });
      };
      if (focusHref) {
        applyInlineLocation(focusHref, "push").catch(() => {
          // Keep the current shell usable even if the tab switch fails.
        }).finally(() => {
          applyCommand();
        });
        return;
      }
      applyCommand();
      return;
    }
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
    window.addEventListener("focus", refreshVisibleWorkbench);
    window.addEventListener("pageshow", refreshVisibleWorkbench);
  }

  if (typeof document.addEventListener === "function") {
    document.addEventListener("htmx:beforeRequest", (event) => {
      const target = htmxSwapTarget(event);
      if (!target) return;
      const isWorkbenchShellSwap =
        target.id === "factory-workbench-rail-shell"
        || target.id === "factory-workbench-focus-shell"
        || target.id === "factory-workbench-chat-pane"
        || target.id === "factory-workbench-chat-region"
        || target.id === "factory-workbench-chat-shell"
        || target.id === "factory-workbench-chat-body";
      pendingHtmxSwapStates.set(target.id, {
        targetId: target.id,
        documentScroll: isWorkbenchShellSwap ? null : captureDocumentScrollState(),
        workbenchPanes: target.id === "factory-workbench-rail-shell" || target.id === "factory-workbench-focus-shell"
          ? captureWorkbenchPaneScrollState()
          : null,
        chat: target.id === "factory-workbench-chat-pane" || target.id === "factory-workbench-chat-region" || target.id === "factory-workbench-chat-shell" || target.id === "factory-workbench-chat-body"
          ? captureChatScrollState()
          : null,
      });
    });
    document.addEventListener("htmx:afterSwap", (event) => {
      const target = htmxSwapTarget(event);
      if (!target) return;
      const swapState = pendingHtmxSwapStates.get(target.id) ?? null;
      pendingHtmxSwapStates.delete(target.id);
      processHtmx(target);
      syncWorkbenchStateFromLocation();
      if (ephemeralTurn) scheduleOverlayRender();
      if (target.id === "factory-workbench-chat-pane" || target.id === "factory-workbench-chat-region" || target.id === "factory-workbench-chat-shell" || target.id === "factory-workbench-chat-body") {
        if (swapState?.chat) {
          window.requestAnimationFrame(() => {
            restoreChatScrollState(swapState.chat!);
          });
        }
        reconcileEphemeralTurn();
      }
      if (target.id === "factory-workbench-rail-shell" || target.id === "factory-workbench-focus-shell") {
        if (swapState?.workbenchPanes) {
          window.requestAnimationFrame(() => {
            restoreWorkbenchPaneScrollState(swapState.workbenchPanes!);
          });
        }
      }
      const documentScroll = swapState?.documentScroll;
      if (documentScroll) {
        window.requestAnimationFrame(() => {
          restoreDocumentScrollState(documentScroll);
        });
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      refreshVisibleWorkbench();
    });
  }

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
  const bootUrl = currentUrl();
  const replayStorage = sessionStorageApi();
  const replay = parseWorkbenchReplay(
    replayStorage?.getItem(replayStorageKey(bootRoute)) ?? null,
  );
  dispatchWorkbenchAction({ type: "boot", route: bootRoute });
  const replayRoute = mergeReplayRoute(workbenchState.appliedRoute, replay, {
    preserveExplicitInspectorTab: Boolean(bootUrl?.searchParams.has("inspectorTab")),
    preserveExplicitDetailTab: Boolean(bootUrl?.searchParams.has("detailTab")),
    preserveExplicitFilter: Boolean(bootUrl?.searchParams.has("filter")),
    preserveExplicitPage: Boolean(bootUrl?.searchParams.has("page")),
    preserveExplicitFocus: Boolean(
      bootUrl?.searchParams.has("focusKind")
      || bootUrl?.searchParams.has("focusId"),
    ),
  });
  if (replay && (replayRoute.routeKey !== workbenchState.appliedRoute.routeKey || replay.ephemeralTurn)) {
    dispatchWorkbenchAction({
      type: "session.replayed",
      route: replayRoute,
      ephemeralTurn: replay.ephemeralTurn,
    });
    ephemeralTurn = replay.ephemeralTurn ?? null;
    applyRouteState(replayRoute, replayRoute.routeKey === bootRoute.routeKey ? "none" : "replace");
  } else {
    applyRouteState(workbenchState.appliedRoute, "none");
  }
  processHtmx(document.body);
  scheduleOverlayRender();
  syncWorkbenchEventSources();
  consumeComposeCommandFromLocation(String(window.location && window.location.href ? window.location.href : shellPath()));
};
