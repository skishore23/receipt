import {
  composerFeedback,
  parseComposeResponse,
  resolveFactoryUrl,
  shellPath,
} from "./compose-navigation";
import {
  parseAgentPhasePayload,
  parseTokenEventPayload,
  renderEphemeralTurn,
} from "./live-updates";
import {
  createQueuedRefreshRunner,
  createReactivePushRouter,
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

type LiveRefreshSourceKey = "background" | "chat";
type WorkbenchRefreshTargetKey = "board" | "focus" | "chat";
type WorkbenchEnvelopeTargetKey = "board" | "focus" | "chat";

type WorkbenchVersionEnvelope = {
  readonly routeKey: string;
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly boardVersion: string;
  readonly focusVersion: string;
  readonly chatVersion: string;
};

const EPHEMERAL_PENDING_GRACE_MS = 1800;

const isAbortError = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "name" in error && (error as { readonly name?: string }).name === "AbortError");

export const initFactoryWorkbenchBrowser = () => {
  let shouldStickToBottom = true;
  let isComposing = false;
  let activeCommandIndex = 0;
  let defaultSubmitLabel = "Send";
  let ephemeralTurn: FactoryWorkbenchEphemeralTurn | null = null;
  let overlayRenderQueued = false;
  const refreshControllers = new Map<WorkbenchRefreshTargetKey, AbortController>();

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

  const workbenchHeader = () => {
    const node = document.getElementById("factory-workbench-header");
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

  const chatHeader = () => {
    const node = document.getElementById("factory-workbench-chat-header");
    return node instanceof HTMLElement ? node : null;
  };

  const chatRegion = () => {
    const node = document.getElementById("factory-workbench-chat-region");
    return node instanceof HTMLElement ? node : null;
  };

  const chatPane = () => {
    const node = document.getElementById("factory-workbench-chat-pane");
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

  const documentShellBase = (): "/factory" | "/factory-new" => {
    const value = document.body?.getAttribute("data-shell-base");
    return value === "/factory-new" ? "/factory-new" : "/factory";
  };

  const routeBasePath = (route: FactoryWorkbenchRouteState): "/factory" | "/factory-new" => {
    const url = resolveFactoryUrl(route.routeKey);
    if (!url) return documentShellBase();
    return url.pathname.startsWith("/factory-new") ? "/factory-new" : "/factory";
  };

  const bodyRouteValue = (name: string): string | undefined => {
    const value = document.body?.getAttribute(name);
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };

  const readEnvelopeFromElement = (element: Element | null): WorkbenchVersionEnvelope | null => {
    if (!(element instanceof HTMLElement)) return null;
    const routeKey = asString(element.getAttribute("data-workbench-route-key"));
    const profileId = asString(element.getAttribute("data-workbench-profile-id"));
    const chatId = asString(element.getAttribute("data-workbench-chat-id"));
    const boardVersion = asString(element.getAttribute("data-workbench-board-version"));
    const focusVersion = asString(element.getAttribute("data-workbench-focus-version"));
    const chatVersion = asString(element.getAttribute("data-workbench-chat-version"));
    if (!routeKey || !profileId || !chatId || !boardVersion || !focusVersion || !chatVersion) return null;
    return {
      routeKey,
      profileId,
      chatId,
      objectiveId: asString(element.getAttribute("data-workbench-objective-id")),
      boardVersion,
      focusVersion,
      chatVersion,
    };
  };

  const readDocumentEnvelope = (): WorkbenchVersionEnvelope | null =>
    readEnvelopeFromElement(document.body);

  const setDocumentEnvelopeTarget = (
    target: WorkbenchEnvelopeTargetKey,
    envelope: WorkbenchVersionEnvelope,
  ) => {
    if (!document.body) return;
    document.body.setAttribute("data-workbench-route-key", envelope.routeKey);
    document.body.setAttribute("data-workbench-profile-id", envelope.profileId);
    document.body.setAttribute("data-workbench-chat-id", envelope.chatId);
    document.body.setAttribute("data-workbench-objective-id", envelope.objectiveId ?? "");
    if (target === "board") document.body.setAttribute("data-workbench-board-version", envelope.boardVersion);
    if (target === "focus") document.body.setAttribute("data-workbench-focus-version", envelope.focusVersion);
    if (target === "chat") document.body.setAttribute("data-workbench-chat-version", envelope.chatVersion);
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
    basePath: url?.pathname ?? documentShellBase(),
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
  let appliedEnvelope: WorkbenchVersionEnvelope | null = readDocumentEnvelope();

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
    return url.pathname === "/factory"
      || url.pathname === "/factory/workbench"
      || url.pathname === "/factory/new-chat"
      || url.pathname === "/factory-new"
      || url.pathname === "/factory-new/workbench"
      || url.pathname === "/factory-new/new-chat";
  };

  const resolveInlineWorkbenchLocation = (location: string): Promise<string | null> => {
    const url = resolveFactoryUrl(location);
    if (!url) return Promise.resolve(null);
    if (!url.pathname.endsWith("/new-chat")) return Promise.resolve(url.href);
    return window.fetch(url.href, {
      method: "GET",
      headers: { Accept: "text/html" },
      credentials: "same-origin",
    }).then((response: FactoryFetchResponse) => {
      if (!response.ok) throw new Error("Request failed.");
      const resolved = typeof response.url === "string" ? resolveFactoryUrl(response.url) : null;
      return resolved ? resolved.href : null;
    });
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
        surface: "chat",
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

  const reduceEphemeralTurnOnPhase = (
    turn: FactoryWorkbenchEphemeralTurn | null,
    payload: {
      readonly runId?: string;
      readonly phase: string;
      readonly summary: string;
    },
  ): FactoryWorkbenchEphemeralTurn | null => {
    const state = currentChatState();
    const runId = payload.runId || state.activeRunId || turn?.runId;
    if (!acceptsStreamingRun(runId)) return turn;
    const phase = payload.phase.trim().toLowerCase();
    const statusLabel: FactoryWorkbenchEphemeralTurn["statusLabel"] = phase === "generating"
      ? "Generating"
      : phase === "starting"
        ? "Starting"
        : phase === "queued"
          ? "Queued"
          : "Processing";
    const summary = payload.summary.trim() || (
      statusLabel === "Generating"
        ? "Generating a response."
        : statusLabel === "Starting"
          ? "Starting the reply."
          : statusLabel === "Queued"
            ? "Queued for execution."
            : "Preparing context and tools."
    );
    return {
      surface: "chat",
      phase: turn?.runId === runId && turn?.assistantText ? "streaming" : "pending",
      statusLabel,
      summary,
      userText: turn?.userText,
      assistantText: turn?.runId === runId ? turn?.assistantText : undefined,
      runId,
      jobId: turn?.jobId,
      transcriptSignature: turn?.transcriptSignature ?? state.transcriptSignature,
      savedAt: Date.now(),
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
      assistantText: `${turn?.runId === runId ? (turn?.assistantText ?? "") : ""}${payload.delta}`,
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
    const ageMs = Math.max(0, Date.now() - (nextTurn.savedAt || 0));
    const withinPendingGrace = nextTurn.phase !== "streaming" && ageMs < EPHEMERAL_PENDING_GRACE_MS;
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
      if (withinPendingGrace) {
        ephemeralTurn = nextTurn;
        scheduleOverlayRender();
        return;
      }
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
    appliedEnvelope = readDocumentEnvelope();
  };

  const fetchHtml = (url: string, signal?: AbortSignal) =>
    window.fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html",
        "HX-Request": "true",
      },
      credentials: "same-origin",
      signal,
    }).then((response: FactoryFetchResponse) => {
      if (!response.ok) throw new Error("Request failed.");
      return response.text();
    });

  const parseMarkupDocument = (markup: string): DocumentFragment => {
    const template = document.createElement("template");
    template.innerHTML = markup.trim();
    return template.content;
  };

  const envelopeVersionForTarget = (
    envelope: WorkbenchVersionEnvelope | null,
    target: WorkbenchEnvelopeTargetKey,
  ): string | null => {
    if (!envelope) return null;
    if (target === "board") return envelope.boardVersion;
    if (target === "focus") return envelope.focusVersion;
    return envelope.chatVersion;
  };

  const shouldApplyEnvelope = (input: {
    readonly target: WorkbenchEnvelopeTargetKey;
    readonly baseline: WorkbenchVersionEnvelope | null;
    readonly next: WorkbenchVersionEnvelope | null;
    readonly expectedRouteKey: string;
  }): boolean => {
    if (!input.next) return false;
    if (input.next.routeKey !== input.expectedRouteKey) return false;
    if (currentRouteKey() !== input.expectedRouteKey) return false;
    const currentVersion = envelopeVersionForTarget(appliedEnvelope, input.target);
    const baselineVersion = envelopeVersionForTarget(input.baseline, input.target);
    return currentVersion === baselineVersion;
  };

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

  const abortRefresh = (target: WorkbenchRefreshTargetKey) => {
    refreshControllers.get(target)?.abort();
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

  const workbenchBackgroundRootPathForRoute = (route: FactoryWorkbenchRouteState): string =>
    `${routeBasePath(route)}/island/workbench/background-root${routeSearch(route)}`;

  const workbenchBoardPathForRoute = (route: FactoryWorkbenchRouteState): string =>
    `${routeBasePath(route)}/island/workbench/board${routeSearch(route)}`;

  const chatIslandPathForRoute = (route: FactoryWorkbenchRouteState): string =>
    `${routeBasePath(route)}/island/chat${routeSearch(route)}`;

  const backgroundEventsPathForRoute = (route: FactoryWorkbenchRouteState): string =>
    `${routeBasePath(route)}/background/events${routeSearch(route)}`;

  const chatEventsPathForRoute = (route: FactoryWorkbenchRouteState): string => {
    const params = new URLSearchParams();
    params.set("profile", route.profileId);
    if (route.chatId) params.set("chat", route.chatId);
    if (route.objectiveId) params.set("objective", route.objectiveId);
    if (route.focusKind === "job" && route.focusId) params.set("job", route.focusId);
    return `${routeBasePath(route)}/chat/events?${params.toString()}`;
  };

  const workbenchBackgroundDescriptor = "sse:profile-board-refresh@320,sse:objective-runtime-refresh@320";

  const workbenchBoardDescriptor = "sse:profile-board-refresh@220,sse:objective-runtime-refresh@220";

  const workbenchFocusDescriptor = "sse:profile-board-refresh@180,sse:objective-runtime-refresh@180";

  const workbenchChatDescriptorForRoute = (route: FactoryWorkbenchRouteState): string => route.inspectorTab === "chat"
    ? [
        "sse:agent-refresh@180",
        "sse:job-refresh@180",
        ...(route.objectiveId ? ["sse:objective-runtime-refresh@180"] : []),
      ].join(",")
    : [
        "sse:profile-board-refresh@300",
        ...(route.objectiveId ? ["sse:objective-runtime-refresh@300"] : []),
      ].join(",");

  const syncWorkbenchRouteData = (route: FactoryWorkbenchRouteState) => {
    if (!document.body) return;
    document.body.setAttribute("data-shell-base", routeBasePath(route));
    document.body.setAttribute("data-route-key", route.routeKey);
    document.body.setAttribute("data-profile-id", route.profileId);
    document.body.setAttribute("data-chat-id", route.chatId ?? "");
    document.body.setAttribute("data-objective-id", route.objectiveId ?? "");
    document.body.setAttribute("data-inspector-tab", route.inspectorTab ?? "overview");
    document.body.setAttribute("data-detail-tab", route.detailTab ?? "action");
    document.body.setAttribute("data-page", String(route.page ?? 1));
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
    for (const link of Array.from(querySelectorAll.call(header, 'a[href*="inspectorTab="], a[href^="/factory"], a[href^="/factory-new"]'))) {
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
      if (element.getAttribute("hx-get") !== null) element.setAttribute("hx-get", path);
    };
    const setRefreshDescriptor = (element: HTMLElement | null, descriptor: string) => {
      if (!element) return;
      element.setAttribute("data-refresh-on", descriptor);
    };
    const currentBackgroundRoot = backgroundRoot();
    setRefreshPath(currentBackgroundRoot, workbenchBackgroundRootPathForRoute(route));
    setRefreshDescriptor(currentBackgroundRoot, workbenchBackgroundDescriptor);
    if (currentBackgroundRoot) currentBackgroundRoot.setAttribute("data-events-path", backgroundEventsPathForRoute(route));
    const currentFocusShell = workbenchFocusShell();
    setRefreshDescriptor(currentFocusShell, workbenchFocusDescriptor);
    setRefreshPath(currentFocusShell, `${routeBasePath(route)}/island/workbench/focus${routeSearch(route)}`);
    const currentRailShell = workbenchRailShell();
    setRefreshPath(currentRailShell, workbenchBoardPathForRoute(route));
    setRefreshDescriptor(currentRailShell, workbenchBoardDescriptor);
    const currentWorkbench = workbenchContainer();
    setRefreshPath(currentWorkbench, `${routeBasePath(route)}/island/workbench${routeSearch(route)}`);
    const currentChatPane = chatPane();
    setRefreshPath(currentChatPane, `${routeBasePath(route)}/island/workbench/chat-pane${routeSearch(route)}`);
    const currentChatRegion = chatRegion();
    setRefreshPath(currentChatRegion, `${routeBasePath(route)}/island/workbench/chat-shell${routeSearch(route)}`);
    const currentChatBody = chatBody();
    setRefreshPath(currentChatBody, `${routeBasePath(route)}/island/workbench/chat-body${routeSearch(route)}`);
    setRefreshDescriptor(currentChatBody, workbenchChatDescriptorForRoute(route));
    const currentChat = chatContainer();
    setRefreshPath(currentChat, chatIslandPathForRoute(route));
    const currentChatRoot = chatRoot();
    if (currentChatRoot) currentChatRoot.setAttribute("data-events-path", chatEventsPathForRoute(route));
    const form = composerForm();
    if (form) form.action = `${routeBasePath(route)}/compose${routeSearch(route)}`;
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

  function refreshBoardNow(
    expectedRouteKey: string,
    options?: {
      readonly replaceInFlight?: boolean;
    },
  ) {
    const target = workbenchRailShell();
    const path = readReactiveRefreshPath(target);
    if (!target || !path) return Promise.resolve();
    const documentScrollState = captureDocumentScrollState();
    const paneScrollState = captureWorkbenchPaneScrollState();
    const baselineEnvelope = appliedEnvelope;
    const controller = startRefreshController(refreshControllers, "board", options);
    return fetchHtml(path, controller?.signal).then((markup) => {
      const fragment = parseMarkupDocument(markup);
      const wrapper = fragment.firstElementChild;
      const nextEnvelope = readEnvelopeFromElement(wrapper);
      if (!shouldApplyEnvelope({
        target: "board",
        baseline: baselineEnvelope,
        next: nextEnvelope,
        expectedRouteKey,
      })) {
        return;
      }
      if (!nextEnvelope) return;
      const nextHeader = wrapper?.querySelector("#factory-workbench-header");
      const nextRail = wrapper?.querySelector("#factory-workbench-rail-shell");
      const currentHeader = workbenchHeader();
      const currentRail = workbenchRailShell();
      if (!(nextHeader instanceof HTMLElement) || !(nextRail instanceof HTMLElement) || !currentHeader || !currentRail) return;
      currentHeader.outerHTML = nextHeader.outerHTML;
      currentRail.outerHTML = nextRail.outerHTML;
      setDocumentEnvelopeTarget("board", nextEnvelope);
      appliedEnvelope = readDocumentEnvelope();
      processHtmx(document.body);
      window.requestAnimationFrame(() => {
        if (paneScrollState) restoreWorkbenchPaneScrollState(paneScrollState);
        restoreDocumentScrollState(documentScrollState);
      });
    }).catch((error: unknown) => {
      if (isAbortError(error)) return;
      throw error;
    }).finally(() => {
      finishRefreshController(refreshControllers, "board", controller);
    });
  }

  function refreshFocusNow(
    expectedRouteKey: string,
    options?: {
      readonly replaceInFlight?: boolean;
    },
  ) {
    const target = workbenchFocusShell();
    const path = readReactiveRefreshPath(target);
    if (!target || !path) return Promise.resolve();
    const documentScrollState = captureDocumentScrollState();
    const paneScrollState = captureWorkbenchPaneScrollState();
    const baselineEnvelope = appliedEnvelope;
    const controller = startRefreshController(refreshControllers, "focus", options);
    return fetchHtml(path, controller?.signal).then((markup) => {
      const fragment = parseMarkupDocument(markup);
      const nextTarget = fragment.firstElementChild;
      const nextEnvelope = readEnvelopeFromElement(nextTarget);
      if (!shouldApplyEnvelope({
        target: "focus",
        baseline: baselineEnvelope,
        next: nextEnvelope,
        expectedRouteKey,
      })) {
        return;
      }
      if (!nextEnvelope) return;
      const currentTarget = workbenchFocusShell();
      if (!(nextTarget instanceof HTMLElement) || !currentTarget) return;
      currentTarget.outerHTML = nextTarget.outerHTML;
      setDocumentEnvelopeTarget("focus", nextEnvelope);
      appliedEnvelope = readDocumentEnvelope();
      processHtmx(document.body);
      window.requestAnimationFrame(() => {
        if (paneScrollState) restoreWorkbenchPaneScrollState(paneScrollState);
        restoreDocumentScrollState(documentScrollState);
      });
    }).catch((error: unknown) => {
      if (isAbortError(error)) return;
      throw error;
    }).finally(() => {
      finishRefreshController(refreshControllers, "focus", controller);
    });
  }

  function refreshChatNow(
    expectedRouteKey: string,
    options?: {
      readonly replaceInFlight?: boolean;
      readonly shell?: "body" | "region";
    },
  ) {
    const refreshScope = options?.shell ?? "body";
    const target = refreshScope === "region" ? chatRegion() : chatBody();
    const path = readReactiveRefreshPath(target);
    if (!target || !path) return Promise.resolve();
    const documentScrollState = captureDocumentScrollState();
    const chatScrollState = captureChatScrollState();
    const baselineEnvelope = appliedEnvelope;
    const controller = startRefreshController(refreshControllers, "chat", options);
    return fetchHtml(path, controller?.signal).then((markup) => {
      const fragment = parseMarkupDocument(markup);
      const nextTarget = fragment.firstElementChild;
      const nextEnvelope = readEnvelopeFromElement(nextTarget)
        ?? (nextTarget instanceof HTMLElement
          ? readEnvelopeFromElement(nextTarget.querySelector("#factory-workbench-chat-body"))
          : null);
      if (!shouldApplyEnvelope({
        target: "chat",
        baseline: baselineEnvelope,
        next: nextEnvelope,
        expectedRouteKey,
      })) {
        return;
      }
      if (!nextEnvelope) return;
      const currentTarget = refreshScope === "region" ? chatRegion() : chatBody();
      if (!(nextTarget instanceof HTMLElement) || !currentTarget) return;
      currentTarget.outerHTML = nextTarget.outerHTML;
      setDocumentEnvelopeTarget("chat", nextEnvelope);
      appliedEnvelope = readDocumentEnvelope();
      const updatedTarget = refreshScope === "region" ? chatRegion() : chatBody();
      processHtmx(updatedTarget ?? document.body);
      if (updatedTarget) handleWorkbenchChatSwap(updatedTarget);
      window.requestAnimationFrame(() => {
        if (chatScrollState) restoreChatScrollState(chatScrollState);
        restoreDocumentScrollState(documentScrollState);
      });
    }).catch((error: unknown) => {
      if (isAbortError(error)) return;
      throw error;
    }).finally(() => {
      finishRefreshController(refreshControllers, "chat", controller);
    });
  }

  const refreshRouteTargetsNow = (
    targets: ReadonlyArray<WorkbenchRefreshTargetKey>,
    routeKeyOverride?: string,
    chatRefreshScope: "body" | "region" = "body",
  ) => {
    const seen = new Set<WorkbenchRefreshTargetKey>();
    const refreshes: Array<Promise<void>> = [];
    for (const target of targets) {
      if (seen.has(target)) continue;
      seen.add(target);
      abortRefresh(target);
      if (target === "board") {
        refreshes.push(refreshBoardNow(routeKeyOverride ?? currentRouteKey(), {
          replaceInFlight: true,
        }).then(() => undefined));
      } else if (target === "focus") {
        refreshes.push(refreshFocusNow(routeKeyOverride ?? currentRouteKey(), {
          replaceInFlight: true,
        }).then(() => undefined));
      } else {
        refreshes.push(refreshChatNow(routeKeyOverride ?? currentRouteKey(), {
          replaceInFlight: true,
          shell: chatRefreshScope,
        }).then(() => undefined));
      }
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
      || current.detailTab !== next.detailTab
      || current.filter !== next.filter
      || current.page !== next.page
      || current.focusKind !== next.focusKind
      || current.focusId !== next.focusId
    ) {
      return ["board", "focus", "chat"];
    }
    if (current.inspectorTab !== next.inspectorTab) return ["chat"];
    return ["board", "focus", "chat"];
  };

  const backgroundEventsPath = () => {
    const node = backgroundRoot();
    return node?.getAttribute("data-events-path") || null;
  };

  const chatEventsPath = () => {
    const node = chatRoot();
    return node?.getAttribute("data-events-path") || null;
  };

  const liveRefreshRunner = createQueuedRefreshRunner<WorkbenchRefreshTargetKey, string>((targetKey, scopeKey) => {
    const expectedRouteKey = scopeKey ?? currentRouteKey();
    switch (targetKey) {
      case "board":
        return refreshBoardNow(expectedRouteKey);
      case "focus":
        return refreshFocusNow(expectedRouteKey);
      case "chat":
      default:
        return refreshChatNow(expectedRouteKey);
    }
  });

  const liveRefreshRouter = createReactivePushRouter<LiveRefreshSourceKey, WorkbenchRefreshTargetKey, string>({
    sources: ["background", "chat"],
    targets: () => [
      {
        key: "board",
        source: "background",
        element: workbenchRailShell,
        queue: (delayMs, scopeKey) => liveRefreshRunner.queue("board", delayMs, scopeKey),
      },
      {
        key: "focus",
        source: "background",
        element: workbenchFocusShell,
        queue: (delayMs, scopeKey) => liveRefreshRunner.queue("focus", delayMs, scopeKey),
      },
      {
        key: "chat",
        source: workbenchState.appliedRoute.inspectorTab === "chat" ? "chat" : "background",
        element: chatBody,
        queue: (delayMs, scopeKey) => liveRefreshRunner.queue("chat", delayMs, scopeKey),
      },
    ],
    eventPath: (sourceKey) => sourceKey === "background"
      ? backgroundEventsPath()
      : workbenchState.appliedRoute.inspectorTab === "chat"
        ? chatEventsPath()
        : null,
    getScopeKey: currentRouteKey,
    onSseEvent: ({ sourceKey, eventName }) => {
      if (sourceKey !== "chat") return;
      if (eventName !== "agent-refresh" && eventName !== "job-refresh") return;
      const nextTurn = reduceEphemeralTurnOnComposeRefresh(ephemeralTurn, eventName);
      if (nextTurn !== ephemeralTurn) updateEphemeralTurn(nextTurn);
    },
    onEventSourceConnected: ({ sourceKey, eventSource }) => {
      if (sourceKey !== "chat") return;
      eventSource.addEventListener("agent-phase", (event) => {
        const payload = parseAgentPhasePayload((event as MessageEvent<string>).data || "");
        if (!payload) return;
        const nextTurn = reduceEphemeralTurnOnPhase(ephemeralTurn, payload);
        if (nextTurn !== ephemeralTurn) updateEphemeralTurn(nextTurn);
      });
      eventSource.addEventListener("agent-token", (event) => {
        const payload = parseTokenEventPayload((event as MessageEvent<string>).data || "");
        if (!payload) return;
        const runId = payload.runId || currentChatState().activeRunId || ephemeralTurn?.runId;
        if (!acceptsStreamingRun(runId)) return;
        ephemeralTurn = reduceEphemeralTurnOnToken(ephemeralTurn, payload);
        scheduleOverlayRender();
      });
      eventSource.addEventListener("factory-stream-reset", () => {
        reconcileEphemeralTurn();
      });
    },
  });

  const syncWorkbenchEventSources = () => {
    liveRefreshRouter.sync();
  };

  const refreshVisibleWorkbench = () => {
    syncWorkbenchEventSources();
    return refreshRouteTargetsNow(["board", "focus", "chat"]).catch(() => undefined);
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
      basePath: url.pathname,
    });

  const applyInlineLocation = (
    location: string,
    historyMode?: "replace" | "push" | "none",
  ) => {
    if (!isInlineWorkbenchLocation(location)) {
      navigateWithFeedback(location);
      return Promise.resolve(false);
    }
    return resolveInlineWorkbenchLocation(location).then((resolvedLocation) => {
      if (!resolvedLocation || !isInlineWorkbenchLocation(resolvedLocation)) {
        navigateWithFeedback(location);
        return false;
      }
      const url = resolveFactoryUrl(resolvedLocation);
      if (!url) {
        navigateWithFeedback(location);
        return false;
      }
      const nextRoute = routeStateFromLocation(url);
      const currentRoute = workbenchState.desiredRoute;
      const changeKind = classifyWorkbenchRouteChange(workbenchState.desiredRoute, nextRoute);
      if (changeKind === "noop") return true;
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
        return refreshRouteTargetsNow(["board", "focus", "chat"], nextRoute.routeKey, "region").then(() => true).catch(() => true);
      }
      if (changeKind === "filter") {
        dispatchWorkbenchAction({ type: "filter.changed", route: nextRoute });
        applyRouteState(nextRoute, "push");
        return refreshRouteTargetsNow(["board", "focus", "chat"], nextRoute.routeKey, "region").then(() => true).catch(() => true);
      }
      dispatchWorkbenchAction({
        type: "route.applied",
        route: nextRoute,
      });
      applyRouteState(nextRoute, historyMode ?? "push");
      return refreshRouteTargetsNow(scopeRefreshTargets(currentRoute, nextRoute), nextRoute.routeKey, "region").then(() => {
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
    });
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
        target.id === "factory-workbench-background-root"
        || target.id === "factory-workbench-rail-shell"
        || target.id === "factory-workbench-focus-shell"
        || target.id === "factory-workbench-chat-pane"
        || target.id === "factory-workbench-chat-region"
        || target.id === "factory-workbench-chat-shell"
        || target.id === "factory-workbench-chat-body";
      pendingHtmxSwapStates.set(target.id, {
        targetId: target.id,
        documentScroll: isWorkbenchShellSwap ? null : captureDocumentScrollState(),
        workbenchPanes: target.id === "factory-workbench-background-root" || target.id === "factory-workbench-rail-shell" || target.id === "factory-workbench-focus-shell"
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
      const nextEnvelope = readEnvelopeFromElement(target);
      if (target.id === "factory-workbench-background-root" && nextEnvelope) {
        setDocumentEnvelopeTarget("board", nextEnvelope);
        setDocumentEnvelopeTarget("focus", nextEnvelope);
        setDocumentEnvelopeTarget("chat", nextEnvelope);
      } else if (target.id === "factory-workbench-rail-shell" && nextEnvelope) {
        setDocumentEnvelopeTarget("board", nextEnvelope);
      } else if (target.id === "factory-workbench-focus-shell" && nextEnvelope) {
        setDocumentEnvelopeTarget("focus", nextEnvelope);
      } else if (target.id === "factory-workbench-chat-body" && nextEnvelope) {
        setDocumentEnvelopeTarget("chat", nextEnvelope);
      }
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
      if (target.id === "factory-workbench-background-root" || target.id === "factory-workbench-rail-shell" || target.id === "factory-workbench-focus-shell") {
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
    Date.now(),
    bootRoute.routeKey,
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
  appliedEnvelope = readDocumentEnvelope();
  processHtmx(document.body);
  scheduleOverlayRender();
  syncWorkbenchEventSources();
  consumeComposeCommandFromLocation(String(window.location && window.location.href ? window.location.href : shellPath()));
};
