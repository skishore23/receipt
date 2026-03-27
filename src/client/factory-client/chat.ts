import {
  buildScope,
  composerFeedback,
  eventsUrl,
  factoryNavigationTarget,
  islandUrl,
  isInlineFactoryLocation,
  parseComposeResponse,
  resolveFactoryUrl,
  shellPath,
} from "./compose-navigation";
import { parseTokenEventPayload, renderStreamingReply } from "./live-updates";
import {
  CHAT_REFRESH_DELAY_MS,
  DEFAULT_COMMANDS,
  INSPECTOR_REFRESH_DELAY_MS,
  SIDEBAR_REFRESH_DELAY_MS,
  asString,
  parseCommands,
  splitDelimited,
  type FactoryCommand,
  type FactoryFetchResponse,
  type LiveScope,
  type PendingSubmission,
  type RefreshKind,
  type StreamingReply,
} from "./shared";

export const initFactoryChat = () => {
  let shouldStickToBottom = true;
  let isComposing = false;
  let activeCommandIndex = 0;
  let defaultSubmitLabel = "Send";
  let liveEventSource: EventSource | null = null;
  let liveEventSearch: string | null = null;
  let refreshTimers: Record<RefreshKind, number> = { chat: 0, sidebar: 0, inspector: 0 };
  let refreshInFlight: Record<RefreshKind, boolean> = { chat: false, sidebar: false, inspector: false };
  let refreshQueued: Record<RefreshKind, boolean> = { chat: false, sidebar: false, inspector: false };
  let navigationRevision = 0;
  let overlayRenderQueued = false;
  let pendingSubmission: PendingSubmission | null = null;
  let pendingScope: LiveScope | null = null;
  let currentScope: LiveScope | null = null;
  let lastReconciledRunId: string | undefined;
  let streamingReply: StreamingReply | null = null;

  const chatInput = () => {
    const input = document.getElementById("factory-prompt");
    return input instanceof HTMLTextAreaElement ? input : null;
  };

  const chatScroll = () => {
    const scroll = document.getElementById("factory-chat-scroll");
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

  const shellTitle = () => {
    const node = document.getElementById("factory-shell-title");
    return node instanceof HTMLElement ? node : null;
  };

  const shellStatusPills = () => {
    const node = document.getElementById("factory-shell-status-pills");
    return node instanceof HTMLElement ? node : null;
  };

  const chatContainer = () => {
    const node = document.getElementById("factory-chat");
    return node instanceof HTMLElement ? node : null;
  };

  const sidebarContainer = () => {
    const node = document.getElementById("factory-sidebar");
    return node instanceof HTMLElement ? node : null;
  };

  const inspectorContainer = () => {
    const node = document.getElementById("factory-inspector");
    return node instanceof HTMLElement ? node : null;
  };

  const composerCurrentJob = () => {
    const node = document.getElementById("factory-composer-current-job");
    return node instanceof HTMLInputElement ? node : null;
  };

  const composerCommands = () => {
    const form = composerForm();
    return parseCommands(form) || DEFAULT_COMMANDS;
  };

  const currentSearch = () => String(window.location && window.location.search ? window.location.search : "");

  const currentUrl = () =>
    resolveFactoryUrl(String(window.location && window.location.href ? window.location.href : shellPath()));

  const currentChatState = () => {
    const container = chatContainer();
    const root = container?.firstElementChild;
    if (!(root instanceof HTMLElement)) {
      return {
        knownRunIds: [],
        terminalRunIds: [],
      };
    }
    return {
      activeProfileLabel: root.getAttribute("data-active-profile-label") || undefined,
      chatId: root.getAttribute("data-chat-id") || undefined,
      objectiveId: root.getAttribute("data-objective-id") || undefined,
      activeRunId: root.getAttribute("data-active-run-id") || undefined,
      knownRunIds: splitDelimited(root.getAttribute("data-known-run-ids")),
      terminalRunIds: splitDelimited(root.getAttribute("data-terminal-run-ids")),
    };
  };

  const scrollChatToBottom = (behavior: ScrollBehavior | "auto") => {
    const scroll = chatScroll();
    if (!scroll) return;
    if (typeof scroll.scrollTo === "function") {
      scroll.scrollTo({ top: scroll.scrollHeight, behavior: behavior || "auto" });
    } else {
      scroll.scrollTop = scroll.scrollHeight;
    }
    shouldStickToBottom = true;
  };

  const scheduleOverlayRender = () => {
    if (overlayRenderQueued) return;
    overlayRenderQueued = true;
    window.requestAnimationFrame(() => {
      overlayRenderQueued = false;
      const optimistic = optimisticTranscript();
      if (optimistic) {
        optimistic.innerHTML = pendingSubmission ? pendingSubmission.optimisticHtml : "";
      }
      const streaming = streamingTranscript();
      if (streaming) {
        streaming.innerHTML = streamingReply ? renderStreamingReply(streamingReply) : "";
      }
      if ((pendingSubmission || streamingReply) && shouldStickToBottom) {
        window.requestAnimationFrame(() => {
          scrollChatToBottom("auto");
        });
      }
    });
  };

  const clearPendingSubmission = () => {
    pendingSubmission = null;
    pendingScope = null;
    scheduleOverlayRender();
  };

  const reconcileLiveTranscript = () => {
    const state = currentChatState();
    const pendingRunId = pendingSubmission?.scope?.runId;
    if (
      pendingRunId
      && (
        state.activeRunId === pendingRunId
        || state.knownRunIds.indexOf(pendingRunId) >= 0
        || state.terminalRunIds.indexOf(pendingRunId) >= 0
      )
    ) {
      lastReconciledRunId = pendingRunId;
      pendingSubmission = null;
      pendingScope = null;
    }
    const streamingRunId = streamingReply?.runId;
    if (streamingRunId && state.terminalRunIds.indexOf(streamingRunId) >= 0) {
      lastReconciledRunId = streamingRunId;
      streamingReply = null;
    }
    scheduleOverlayRender();
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

  const setExpanded = (expanded: boolean) => {
    const input = chatInput();
    if (input) input.setAttribute("aria-expanded", expanded ? "true" : "false");
    const popup = composerCompletions();
    if (popup) popup.classList.toggle("hidden", !expanded);
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
        '<span class="block text-sm font-medium">' + command.label + "</span>" +
        '<span class="block text-xs text-muted-foreground">' + command.description + "</span>" +
        "</span>" +
        '<span class="shrink-0 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">' + command.usage + "</span>" +
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

  const setComposerAction = (search: string) => {
    const form = composerForm();
    if (form) form.action = "/factory/compose" + (search || "");
  };

  const setComposerCurrentJob = (jobId: string) => {
    const input = composerCurrentJob();
    if (input) input.value = jobId || "";
  };

  const setFocusData = (url: URL) => {
    if (!document.body) return;
    document.body.setAttribute("data-focus-kind", url.searchParams.get("focusKind") || "");
    document.body.setAttribute("data-focus-id", url.searchParams.get("focusId") || "");
  };

  const syncShellRoute = (url: URL, historyMode?: "replace" | "push" | "none") => {
    const nextPath = url.pathname + (url.search || "") + (url.hash || "");
    if (window.history) {
      if (historyMode === "replace" && typeof window.history.replaceState === "function") {
        window.history.replaceState({}, "", nextPath);
      } else if (historyMode !== "none" && typeof window.history.pushState === "function") {
        window.history.pushState({}, "", nextPath);
      }
    }
    currentScope = buildScope(url);
    setFocusData(url);
    setComposerAction(url.search || "");
    setComposerCurrentJob(url.searchParams.get("job") || "");
  };

  const closeLiveUpdates = () => {
    if (!liveEventSource || typeof liveEventSource.close !== "function") return;
    liveEventSource.close();
    liveEventSource = null;
    liveEventSearch = null;
  };

  const fetchHtml = (url: string) =>
    window.fetch(url, {
      method: "GET",
      headers: { Accept: "text/html" },
      credentials: "same-origin",
    }).then((response: FactoryFetchResponse) => {
      if (!response.ok) throw new Error("Request failed.");
      return response.text();
    });

  const applyIslandMarkup = (kind: RefreshKind, markup: string) => {
    const target = kind === "chat"
      ? chatContainer()
      : kind === "sidebar"
        ? sidebarContainer()
        : inspectorContainer();
    if (!target) return;
    target.innerHTML = markup;
    if (kind === "chat") {
      reconcileScopeFromChatState(true);
      reconcileLiveTranscript();
      if (shouldStickToBottom) {
        window.requestAnimationFrame(() => {
          scrollChatToBottom("auto");
        });
      }
    }
  };

  const refreshIslandNow = (kind: RefreshKind, search: string) =>
    fetchHtml(islandUrl(kind, search)).then((markup) => {
      if (search !== currentSearch()) return;
      applyIslandMarkup(kind, markup);
    });

  const performIslandRefresh = (kind: RefreshKind, search: string) => {
    if (refreshInFlight[kind]) {
      refreshQueued[kind] = true;
      return;
    }
    refreshInFlight[kind] = true;
    refreshIslandNow(kind, search).catch(() => {
      // Ignore transient island refresh failures; the next event or navigation will retry.
    }).finally(() => {
      refreshInFlight[kind] = false;
      if (!refreshQueued[kind]) return;
      refreshQueued[kind] = false;
      queueIslandRefresh(kind, kind === "chat" ? CHAT_REFRESH_DELAY_MS : SIDEBAR_REFRESH_DELAY_MS);
    });
  };

  const queueIslandRefresh = (kind: RefreshKind, delay: number, searchOverride?: string) => {
    if (refreshTimers[kind]) window.clearTimeout(refreshTimers[kind]);
    refreshTimers[kind] = window.setTimeout(() => {
      refreshTimers[kind] = 0;
      const search = typeof searchOverride === "string" ? searchOverride : currentSearch();
      performIslandRefresh(kind, search);
    }, delay);
  };

  const refreshAllIslands = (search: string) =>
    Promise.all([
      refreshIslandNow("chat", search),
      refreshIslandNow("sidebar", search),
      refreshIslandNow("inspector", search),
    ]);

  const currentObjectiveScopeId = (): string | undefined =>
    currentChatState().objectiveId
    || pendingScope?.objectiveId
    || currentScope?.objectiveId
    || asString(currentUrl()?.searchParams.get("thread"));

  const hydrateShellFromDocument = (nextDocument: Document, url: URL) => {
    if (typeof nextDocument.title === "string" && nextDocument.title) {
      document.title = nextDocument.title;
    }
    setFocusData(url);
    const nextTitle = nextDocument.getElementById("factory-shell-title");
    const currentTitle = shellTitle();
    if (currentTitle && nextTitle && typeof nextTitle.textContent === "string") {
      currentTitle.textContent = nextTitle.textContent;
    }
    const nextPills = nextDocument.getElementById("factory-shell-status-pills");
    const currentPills = shellStatusPills();
    if (currentPills && nextPills && typeof nextPills.innerHTML === "string") {
      currentPills.innerHTML = nextPills.innerHTML;
    }
    const nextPrompt = nextDocument.getElementById("factory-prompt");
    const input = chatInput();
    if (input && nextPrompt && typeof nextPrompt.getAttribute === "function") {
      const placeholder = nextPrompt.getAttribute("placeholder");
      if (placeholder !== null) input.setAttribute("placeholder", placeholder);
    }
    const nextForm = nextDocument.getElementById("factory-composer");
    const form = composerForm();
    if (form && nextForm && typeof nextForm.getAttribute === "function") {
      const action = nextForm.getAttribute("action");
      if (action) form.action = action;
    }
    const nextCurrentJob = nextDocument.getElementById("factory-composer-current-job");
    const currentJob = composerCurrentJob();
    if (currentJob) {
      const nextValue = nextCurrentJob && typeof nextCurrentJob.getAttribute === "function"
        ? nextCurrentJob.getAttribute("value")
        : null;
      currentJob.value = nextValue !== null ? nextValue : "";
    }
    const nextChat = nextDocument.getElementById("factory-chat");
    const currentChat = chatContainer();
    if (currentChat && nextChat && typeof nextChat.innerHTML === "string") {
      currentChat.innerHTML = nextChat.innerHTML;
      const activeProfileLabel = typeof nextChat.getAttribute === "function"
        ? nextChat.getAttribute("data-active-profile-label")
        : null;
      if (activeProfileLabel !== null) currentChat.setAttribute("data-active-profile-label", activeProfileLabel);
    }
    const nextSidebar = nextDocument.getElementById("factory-sidebar");
    const currentSidebar = sidebarContainer();
    if (currentSidebar && nextSidebar && typeof nextSidebar.innerHTML === "string") {
      currentSidebar.innerHTML = nextSidebar.innerHTML;
    }
    const nextInspector = nextDocument.getElementById("factory-inspector");
    const currentInspector = inspectorContainer();
    if (currentInspector && nextInspector && typeof nextInspector.innerHTML === "string") {
      currentInspector.innerHTML = nextInspector.innerHTML;
    }
    reconcileScopeFromChatState(false);
    reconcileLiveTranscript();
    if (shouldStickToBottom) {
      window.requestAnimationFrame(() => {
        scrollChatToBottom("auto");
      });
    }
  };

  const connectLiveUpdates = (searchOverride?: string) => {
    if (typeof window.EventSource !== "function") return;
    const search = typeof searchOverride === "string" ? searchOverride : currentSearch();
    if (liveEventSource && liveEventSearch === search) return;
    closeLiveUpdates();
    liveEventSearch = search;
    liveEventSource = new window.EventSource(eventsUrl(search));
    const ignoreInit = (event: MessageEvent<string>) => event.data === "init";
    liveEventSource.addEventListener("agent-refresh", (event) => {
      const message = event as MessageEvent<string>;
      if (ignoreInit(message)) return;
      queueIslandRefresh("chat", CHAT_REFRESH_DELAY_MS, search);
    });
    liveEventSource.addEventListener("job-refresh", (event) => {
      const message = event as MessageEvent<string>;
      if (ignoreInit(message)) return;
      queueIslandRefresh("chat", CHAT_REFRESH_DELAY_MS, search);
      queueIslandRefresh("sidebar", SIDEBAR_REFRESH_DELAY_MS, search);
      queueIslandRefresh("inspector", INSPECTOR_REFRESH_DELAY_MS, search);
    });
    liveEventSource.addEventListener("factory-refresh", (event) => {
      const message = event as MessageEvent<string>;
      if (ignoreInit(message)) return;
      queueIslandRefresh("sidebar", SIDEBAR_REFRESH_DELAY_MS, search);
      const refreshedObjectiveId = asString(message.data);
      const activeObjectiveId = currentObjectiveScopeId();
      if (refreshedObjectiveId) {
        if (activeObjectiveId && refreshedObjectiveId !== activeObjectiveId) return;
        if (!activeObjectiveId && !pendingSubmission) return;
      }
      queueIslandRefresh("chat", CHAT_REFRESH_DELAY_MS, search);
      queueIslandRefresh("inspector", INSPECTOR_REFRESH_DELAY_MS, search);
    });
    liveEventSource.addEventListener("agent-token", (event) => {
      if (search !== currentSearch()) return;
      const payload = parseTokenEventPayload((event as MessageEvent<string>).data || "");
      if (!payload) return;
      const state = currentChatState();
      const runId = payload.runId || pendingScope?.runId || pendingSubmission?.scope?.runId || state.activeRunId || lastReconciledRunId;
      const previous = streamingReply && streamingReply.runId === runId ? streamingReply.text : "";
      streamingReply = {
        runId,
        profileLabel: state.activeProfileLabel || shellTitle()?.textContent || "Assistant",
        text: previous + payload.delta,
      };
      scheduleOverlayRender();
    });
  };

  const navigateWithFeedback = (location: string) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.location.assign(location);
      });
    });
  };

  const applyInlineLocation = (location: string, historyMode?: "replace" | "push" | "none", live?: { readonly profileId?: string; readonly chatId?: string; readonly objectiveId?: string; readonly runId?: string; readonly jobId?: string }) => {
    if (!isInlineFactoryLocation(location)) {
      navigateWithFeedback(location);
      return Promise.resolve(false);
    }
    const url = resolveFactoryUrl(location);
    if (!url) {
      navigateWithFeedback(location);
      return Promise.resolve(false);
    }
    const nextScope = buildScope(url, live);
    syncShellRoute(url, historyMode || "push");
    pendingScope = nextScope;
    if (pendingSubmission) {
      pendingSubmission = {
        prompt: pendingSubmission.prompt,
        optimisticHtml: pendingSubmission.optimisticHtml,
        scope: nextScope,
      };
      scheduleOverlayRender();
    }
    connectLiveUpdates(nextScope.search);
    const shellUrl = url.pathname + (url.search || "");
    const revision = ++navigationRevision;
    const hydrate = typeof window.DOMParser === "function"
      ? fetchHtml(shellUrl).then((markup) => {
          if (revision !== navigationRevision) return;
          const parser = new window.DOMParser();
          const nextDocument = parser.parseFromString(markup, "text/html");
          hydrateShellFromDocument(nextDocument, url);
        })
      : refreshAllIslands(url.search || "");
    return hydrate.then(() => {
      if (revision !== navigationRevision) return true;
      reconcileLiveTranscript();
      return true;
    }).catch((error: unknown) => {
      navigateWithFeedback(location);
      if (error instanceof Error) throw error;
      throw new Error("Request failed.");
    });
  };

  const reconcileScopeFromChatState = (refreshObjectiveIslands: boolean): boolean => {
    const url = currentUrl();
    if (!url) return false;
    const state = currentChatState();
    let changed = false;
    let objectiveChanged = false;
    if (!state.chatId && state.objectiveId && url.searchParams.has("chat")) {
      url.searchParams.delete("chat");
      changed = true;
    }
    if (state.chatId && url.searchParams.get("chat") !== state.chatId) {
      url.searchParams.set("chat", state.chatId);
      changed = true;
    }
    if (state.objectiveId && url.searchParams.get("thread") !== state.objectiveId) {
      url.searchParams.set("thread", state.objectiveId);
      changed = true;
      objectiveChanged = true;
    }
    if (!changed) return false;
    const previousSearch = currentSearch();
    syncShellRoute(url, "replace");
    const nextProfileId = asString(url.searchParams.get("profile")) || undefined;
    const nextChatId = asString(url.searchParams.get("chat")) || undefined;
    const nextObjectiveId = asString(url.searchParams.get("thread")) || undefined;
    if (pendingSubmission?.scope) {
      pendingSubmission = {
        prompt: pendingSubmission.prompt,
        optimisticHtml: pendingSubmission.optimisticHtml,
        scope: {
          ...pendingSubmission.scope,
          profileId: nextProfileId || pendingSubmission.scope.profileId,
          chatId: nextChatId,
          objectiveId: nextObjectiveId,
          search: url.search || "",
        },
      };
    }
    if (pendingScope) {
      pendingScope = {
        ...pendingScope,
        profileId: nextProfileId || pendingScope.profileId,
        chatId: nextChatId,
        objectiveId: nextObjectiveId,
        search: url.search || "",
      };
    }
    if ((url.search || "") !== previousSearch) {
      connectLiveUpdates(url.search || "");
    }
    if (objectiveChanged && refreshObjectiveIslands) {
      queueIslandRefresh("sidebar", 0, url.search || "");
      queueIslandRefresh("inspector", 0, url.search || "");
    }
    return true;
  };

  const autoResizeInput = () => {
    const input = chatInput();
    if (!input) return;
    input.style.height = "0px";
    input.style.height = Math.min(Math.max(input.scrollHeight, 132), 320) + "px";
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

  const isNearBottom = () => {
    const scroll = chatScroll();
    if (!scroll) return true;
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
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
        const submitForm = composerForm();
        if (submitForm) submitForm.requestSubmit();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
      event.preventDefault();
      const form = composerForm();
      if (form) form.requestSubmit();
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

    input.addEventListener("input", () => {
      refreshAutocomplete();
    });
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
      if ("optimisticHtml" in feedback && feedback.optimisticHtml) {
        pendingSubmission = {
          prompt: payload,
          optimisticHtml: feedback.optimisticHtml,
        };
        streamingReply = null;
        scheduleOverlayRender();
      } else {
        clearPendingSubmission();
      }
      if ("optimisticHtml" in feedback && feedback.optimisticHtml) {
        window.requestAnimationFrame(() => {
          scrollChatToBottom("auto");
        });
      }
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
            clearPendingSubmission();
            setComposerStatus(body.error || "Request failed.");
            return;
          }
          if (body.location) {
            keepBusyForNavigation = true;
            return applyInlineLocation(body.location, undefined, body.live).then((handledInline) => {
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
        clearPendingSubmission();
        setComposerStatus(error instanceof Error ? error.message : "Request failed.");
      }).finally(() => {
        if (!keepBusyForNavigation) setComposerBusy(false);
      });
    });
  }

  const scroll = chatScroll();
  if (scroll) {
    scroll.addEventListener("scroll", () => {
      shouldStickToBottom = isNearBottom();
    }, { passive: true });
  }
  window.requestAnimationFrame(() => {
    scrollChatToBottom("auto");
  });
  const initialUrl = currentUrl();
  if (initialUrl) currentScope = buildScope(initialUrl);
  reconcileScopeFromChatState(false);
  connectLiveUpdates();
  scheduleOverlayRender();

  if (typeof window.addEventListener === "function") {
    window.addEventListener("popstate", () => {
      applyInlineLocation(String(window.location && window.location.href ? window.location.href : shellPath()), "replace").catch(() => {
        // Fall through to the browser's current URL if inline hydration fails.
      });
    });
  }

  document.addEventListener("click", (event) => {
    const target = factoryNavigationTarget(event);
    if (!target) return;
    event.preventDefault();
    applyInlineLocation(target.location, target.historyMode).catch(() => {
      navigateWithFeedback(target.location);
    });
  });

  document.addEventListener("mousedown", (event) => {
    const form = composerForm();
    if (!form || !(event.target instanceof Node)) return;
    if (form.contains(event.target)) return;
    setExpanded(false);
  });

  document.addEventListener("htmx:afterSwap", (event) => {
    const target = event && "target" in event ? (event.target as EventTarget | null) : null;
    if (!(target instanceof HTMLElement)) return;
    if (target.id !== "factory-chat") return;
    reconcileLiveTranscript();
    if (!shouldStickToBottom) return;
    window.requestAnimationFrame(() => {
      scrollChatToBottom("auto");
    });
  });
};
