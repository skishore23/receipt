import { createLiveEventSource } from "@receipt/live/browser";
import {
  composerFeedback,
  parseComposeResponse,
} from "./factory-client/compose-navigation";
import {
  parseAgentPhasePayload,
  parseTokenEventPayload,
} from "./factory-client/live-updates";
import {
  acknowledgeFactoryPreviewLiveState,
  appendFactoryPreviewToken,
  applyFactoryPreviewPhase,
  clearFactoryPreviewLiveState,
  createFactoryPreviewLiveState,
  markFactoryPreviewStalled,
  renderFactoryPreviewLiveState,
  resetFactoryPreviewStream,
  shouldClearFactoryPreviewLiveState,
  type FactoryPreviewLiveState,
} from "./factory-preview-live-state";
import {
  createQueuedRefreshRunner,
  readReactiveRefreshPath,
  readReactiveRefreshSpecs,
} from "./factory-client/reactive";

const DRAWER_WIDTH = "420px";
const LOADER_STALL_MS = 12_000;

type PreviewIsland = {
  readonly key: string;
  readonly element: HTMLElement;
};

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const etagForVersion = (version: string): string => `W/"${escapeAttribute(version)}"`;

const sessionStorageApi = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

export const initFactoryPreviewBrowser = () => {
  const body = document.body;
  if (!body?.hasAttribute("data-factory-preview")) return;

  let liveState: FactoryPreviewLiveState = clearFactoryPreviewLiveState();
  let liveSource: {
    addEventListener: (type: string, handler: (event: Event | MessageEvent<string>) => void) => void;
    close: () => void;
  } | null = null;
  let connectedEvents = new Set<string>();
  let hasConnectedOnce = false;
  let stallTimer: number | null = null;

  const shellBase = () => body.getAttribute("data-shell-base") || "/factory-preview";
  const routePart = (name: string) => body.getAttribute(name)?.trim() || "";
  const loaderStallMs = () => {
    const raw = body.getAttribute("data-loader-stall-ms");
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(1_000, parsed) : LOADER_STALL_MS;
  };
  const draftStorageKey = () =>
    `factory-preview:draft:${routePart("data-profile-id")}:${routePart("data-chat-id")}:${routePart("data-objective-id")}`;

  const profileSelect = () => {
    const node = document.getElementById("factory-preview-profile-select");
    return node instanceof HTMLSelectElement ? node : null;
  };

  const drawer = () => {
    const node = document.getElementById("factory-preview-drawer");
    return node instanceof HTMLElement ? node : null;
  };

  const drawerBackdrop = () => {
    const node = document.getElementById("factory-preview-drawer-backdrop");
    return node instanceof HTMLElement ? node : null;
  };

  const liveEventsPath = () => {
    const params = new URLSearchParams();
    const profileId = routePart("data-profile-id");
    const chatId = routePart("data-chat-id");
    const objectiveId = routePart("data-objective-id");
    if (profileId) params.set("profile", profileId);
    if (chatId) params.set("chat", chatId);
    if (objectiveId) params.set("objective", objectiveId);
    return `${shellBase()}/live${params.toString() ? `?${params.toString()}` : ""}`;
  };

  let drawerState = false;

  const layout = () => {
    const node = document.getElementById("factory-preview-layout");
    return node instanceof HTMLElement ? node : null;
  };

  const composerForm = () => {
    const node = document.getElementById("factory-preview-composer");
    return node instanceof HTMLFormElement ? node : null;
  };

  const composerInput = () => {
    const node = document.getElementById("factory-preview-prompt");
    return node instanceof HTMLTextAreaElement ? node : null;
  };

  const composerStatus = () => {
    const node = document.getElementById("factory-preview-composer-status");
    return node instanceof HTMLElement ? node : null;
  };

  const composerSubmit = () => {
    const node = document.getElementById("factory-preview-composer-submit");
    return node instanceof HTMLButtonElement ? node : null;
  };

  const composerCurrentJob = () => {
    const node = document.getElementById("factory-preview-current-job");
    return node instanceof HTMLInputElement ? node : null;
  };

  const ephemeralContainer = () => {
    const node = document.getElementById("factory-preview-ephemeral");
    return node instanceof HTMLElement ? node : null;
  };

  const liveFeedContainer = () => {
    const node = document.getElementById("factory-preview-live-feed");
    return node instanceof HTMLElement ? node : null;
  };

  const timelineRoot = () => {
    const node = document.getElementById("factory-preview-timeline-root");
    return node instanceof HTMLElement ? node : null;
  };

  const captureTimelineScrollState = () => {
    const scroll = timelineRoot();
    if (!scroll) return null;
    return {
      top: scroll.scrollTop,
      bottomOffset: Math.max(0, scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight),
    };
  };

  const restoreTimelineScrollState = (state: { readonly top: number; readonly bottomOffset: number }) => {
    const scroll = timelineRoot();
    if (!scroll) return;
    const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const atBottom = state.bottomOffset < 120;
    const nextTop = atBottom ? maxTop : Math.min(maxTop, Math.max(0, state.top));
    if (typeof scroll.scrollTo === "function") {
      scroll.scrollTo({ top: nextTop, behavior: "auto" });
    } else {
      scroll.scrollTop = nextTop;
    }
  };

  const scheduleAfterSwap = (run: () => void) => {
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => run());
      return;
    }
    window.setTimeout(run, 0);
  };

  const currentProfileLabel = () =>
    timelineRoot()?.getAttribute("data-active-profile-label")
    || profileSelect()?.selectedOptions?.[0]?.textContent?.trim()
    || routePart("data-profile-id")
    || "Factory";

  const islands = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-refresh-on][data-refresh-path][id]"))
      .map((element) => ({ key: element.id, element }));

  const currentIsland = (key: string): PreviewIsland | null => {
    const element = document.getElementById(key);
    if (!(element instanceof HTMLElement)) return null;
    return { key, element };
  };

  const drawerOpen = (): boolean => drawerState;

  const disclosureForSection = (section: string): HTMLDetailsElement | null => {
    const node = document.getElementById(`factory-preview-drawer-shell-${section}`);
    return node instanceof HTMLDetailsElement ? node : null;
  };

  const sectionOpen = (section: string): boolean => {
    const disclosure = disclosureForSection(section);
    return Boolean(disclosure?.open);
  };

  const shouldRefreshIsland = (element: HTMLElement): boolean => {
    const drawerSection = element.getAttribute("data-preview-drawer-section");
    if (!drawerSection) return true;
    return drawerOpen() && sectionOpen(drawerSection);
  };

  const syncCurrentJob = () => {
    const target = composerCurrentJob();
    if (!target) return;
    const replacement = document.getElementById("factory-preview-current-job");
    if (replacement instanceof HTMLInputElement && replacement !== target) {
      target.value = replacement.value;
    }
  };

  const renderEphemeral = () => {
    const container = ephemeralContainer();
    if (!container) return;
    container.innerHTML = renderFactoryPreviewLiveState(liveState);
  };

  const renderLiveFeedEvent = (eventName: string, payload?: string) => {
    const container = liveFeedContainer();
    if (!container) return;
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const summary = payload?.trim() ? payload.trim() : "received";
    const chip = `<span class="inline-flex items-center gap-1.5 border border-border bg-background px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">${eventName}</span>`;
    const body = `<span class="min-w-0 truncate text-[11px] leading-5 text-muted-foreground">${summary}</span>`;
    container.insertAdjacentHTML(
      "afterbegin",
      `<div class="flex flex-wrap items-center justify-between gap-2 border border-border bg-muted/20 px-3 py-2">${chip}<div class="flex min-w-0 items-center gap-2">${body}<span class="shrink-0 text-[10px] text-muted-foreground">${time}</span></div></div>`,
    );
    while (container.childElementCount > 8) {
      container.lastElementChild?.remove();
    }
  };

  const syncStallTimer = () => {
    if (stallTimer !== null) {
      window.clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (liveState.tag === "idle") return;
    stallTimer = window.setTimeout(() => {
      liveState = markFactoryPreviewStalled(liveState, Date.now(), loaderStallMs());
      renderEphemeral();
      syncStallTimer();
    }, loaderStallMs());
  };

  const setLiveState = (next: FactoryPreviewLiveState) => {
    liveState = next;
    renderEphemeral();
    syncStallTimer();
  };

  const acceptsStreamingRun = (runId?: string): boolean =>
    liveState.tag === "idle"
      ? false
      : !runId || !liveState.turn.runId || liveState.turn.runId === runId;

  const setComposerStatus = (message: string) => {
    const node = composerStatus();
    if (!node) return;
    node.textContent = message;
    if (message.trim()) {
      node.classList.remove("hidden");
    } else {
      node.classList.add("hidden");
    }
  };

  const setComposerBusy = (busy: boolean, label?: string) => {
    const button = composerSubmit();
    if (!button) return;
    if (!button.dataset.factoryDefaultLabel) {
      button.dataset.factoryDefaultLabel = button.textContent || "Send";
    }
    button.disabled = busy;
    button.textContent = busy
      ? (label || "Sending...")
      : (button.dataset.factoryDefaultLabel || "Send");
  };

  const saveDraft = () => {
    const storage = sessionStorageApi();
    const input = composerInput();
    if (!storage || !input) return;
    const value = input.value.trim();
    if (!value) {
      storage.removeItem(draftStorageKey());
      return;
    }
    storage.setItem(draftStorageKey(), input.value);
  };

  const restoreDraft = () => {
    const storage = sessionStorageApi();
    const input = composerInput();
    if (!storage || !input || input.value.trim()) return;
    const value = storage.getItem(draftStorageKey());
    if (!value) return;
    input.value = value;
  };

  const clearDraft = () => {
    const storage = sessionStorageApi();
    if (!storage) return;
    storage.removeItem(draftStorageKey());
  };

  const insertCommand = (command: string) => {
    const input = composerInput();
    if (!input) return;
    const current = input.value;
    const needsSpacer = current.trim().length > 0 && !/\s$/.test(current);
    input.value = current
      ? `${current}${needsSpacer ? "\n" : ""}${command}`
      : command;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    saveDraft();
  };

  const setDrawerOpen = (open: boolean) => {
    drawerState = open;
    const drawerNode = drawer();
    const backdrop = drawerBackdrop();
    const layoutNode = layout();
    if (drawerNode) drawerNode.style.display = open ? "block" : "none";
    if (backdrop) backdrop.style.display = open && window.innerWidth < 1280 ? "block" : "none";
    if (layoutNode) layoutNode.style.setProperty("--factory-preview-drawer-width", open ? DRAWER_WIDTH : "0px");
    for (const toggle of Array.from(document.querySelectorAll<HTMLElement>("[data-preview-drawer-toggle='true']"))) {
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      const closedLabel = toggle.getAttribute("data-preview-drawer-toggle-label") || "Inspector";
      const openLabel = toggle.getAttribute("data-preview-drawer-toggle-open-label") || "Hide inspector";
      toggle.textContent = open ? openLabel : closedLabel;
    }
    if (open) queueVisibleDrawerSections(0);
  };

  const refreshIslandNow = async (key: string) => {
    const island = currentIsland(key);
    if (!island || !shouldRefreshIsland(island.element)) return;
    const path = readReactiveRefreshPath(island.element);
    if (!path) return;
    const version = island.element.getAttribute("data-island-version");
    const timelineScrollState = key === "factory-preview-timeline"
      ? captureTimelineScrollState()
      : null;
    const previousTranscriptSignature = key === "factory-preview-timeline"
      ? timelineRoot()?.getAttribute("data-transcript-signature") || ""
      : "";
    const response = await fetch(path, {
      headers: {
        ...(version ? { "If-None-Match": etagForVersion(version) } : {}),
      },
      credentials: "same-origin",
    });
    if (response.status === 304) return;
    if (!response.ok) return;
    const markup = (await response.text()).trim();
    if (!markup) return;
    const swap = island.element.getAttribute("data-refresh-swap") || "outerHTML";
    if (swap === "innerHTML") {
      island.element.innerHTML = markup;
    } else {
      island.element.outerHTML = markup;
    }
    if (key === "factory-preview-timeline") {
      const nextSignature = timelineRoot()?.getAttribute("data-transcript-signature") || "";
      const lastItemKind = timelineRoot()?.getAttribute("data-last-item-kind") || "";
      if (shouldClearFactoryPreviewLiveState({
        state: liveState,
        previousTranscriptSignature,
        nextTranscriptSignature: nextSignature,
        lastItemKind,
      })) {
        setLiveState(clearFactoryPreviewLiveState());
      }
      if (timelineScrollState) {
        scheduleAfterSwap(() => {
          restoreTimelineScrollState(timelineScrollState);
        });
      }
    }
    syncCurrentJob();
  };

  const refreshRunner = createQueuedRefreshRunner<string>((targetKey) =>
    refreshIslandNow(targetKey));

  const queueAll = (delayMs: number) => {
    for (const island of islands()) {
      if (!shouldRefreshIsland(island.element)) continue;
      refreshRunner.queue(island.key, delayMs);
    }
  };

  const queueVisibleDrawerSections = (delayMs: number) => {
    for (const island of islands()) {
      if (!island.element.getAttribute("data-preview-drawer-section")) continue;
      if (!shouldRefreshIsland(island.element)) continue;
      refreshRunner.queue(island.key, delayMs);
    }
  };

  const handleLiveEvent = (eventName: string) => {
    renderLiveFeedEvent(eventName);
    for (const island of islands()) {
      if (!shouldRefreshIsland(island.element)) continue;
      const match = readReactiveRefreshSpecs(island.element)
        .find((spec) => spec.kind === "live" && spec.event === eventName);
      if (!match) continue;
      refreshRunner.queue(island.key, match.throttleMs ?? 0);
    }
  };

  const syncLiveSourceListeners = () => {
    if (!liveSource) return;
    const eventNames = new Set<string>();
    for (const island of islands()) {
      for (const spec of readReactiveRefreshSpecs(island.element)) {
        if (spec.kind === "live") eventNames.add(spec.event);
      }
    }
    for (const eventName of eventNames) {
      if (connectedEvents.has(eventName)) continue;
      liveSource.addEventListener(eventName, (event) => {
        if ("data" in event && event.data === "init") return;
        handleLiveEvent(eventName);
      });
      connectedEvents.add(eventName);
    }
  };

  const connect = () => {
    const livePath = liveEventsPath();
    if (!livePath) return;
    liveSource?.close();
    connectedEvents = new Set<string>();
    liveSource = createLiveEventSource(livePath);
    liveSource.addEventListener("open", () => {
      syncLiveSourceListeners();
      if (hasConnectedOnce) queueAll(0);
      hasConnectedOnce = true;
    });
    liveSource.addEventListener("error", () => {
      syncLiveSourceListeners();
    });
    liveSource.addEventListener("agent-phase", (event) => {
      const payload = parseAgentPhasePayload((event as MessageEvent<string>).data || "");
      if (!payload || !acceptsStreamingRun(payload.runId)) return;
      renderLiveFeedEvent("agent-phase", payload.summary || payload.phase);
      setLiveState(applyFactoryPreviewPhase(liveState, payload, Date.now()));
    });
    liveSource.addEventListener("agent-token", (event) => {
      const payload = parseTokenEventPayload((event as MessageEvent<string>).data || "");
      if (!payload || !acceptsStreamingRun(payload.runId)) return;
      renderLiveFeedEvent("agent-token", payload.delta.slice(0, 80));
      setLiveState(appendFactoryPreviewToken(liveState, payload, Date.now()));
    });
    liveSource.addEventListener("factory-stream-reset", () => {
      renderLiveFeedEvent("factory-stream-reset");
      setLiveState(resetFactoryPreviewStream(liveState));
    });
    syncLiveSourceListeners();
  };

  restoreDraft();
  syncCurrentJob();
  connect();
  setDrawerOpen(false);

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.getAttribute("data-factory-profile-select") !== "true") return;
    const nextLocation = target instanceof HTMLSelectElement
      ? target.value.trim()
      : "";
    if (!nextLocation) return;
    saveDraft();
    window.location.assign(nextLocation);
  });

  composerInput()?.addEventListener("input", saveDraft, { passive: true });

  composerForm()?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = composerForm();
    const input = composerInput();
    if (!form || !input) return;
    const payload = input.value.trim();
    if (!payload) {
      setComposerStatus("Enter a chat message or slash command.");
      return;
    }
    const formData = new window.FormData(form);
    const feedback = composerFeedback(payload, form.action, {
      currentObjectiveId: routePart("data-objective-id") || undefined,
    });
    setComposerBusy(true, feedback.buttonLabel);
    setComposerStatus("");
    setLiveState(createFactoryPreviewLiveState({
      profileLabel: currentProfileLabel(),
      userText: payload,
      statusLabel: feedback.buttonLabel?.replace(/\.\.\.$/, "") || undefined,
      summary: feedback.status || undefined,
      now: Date.now(),
    }));
    fetch(form.action, {
      method: form.method || "POST",
      body: formData,
      headers: {
        Accept: "application/json",
      },
      credentials: "same-origin",
    }).then((response) => {
      const contentType = response.headers.get("content-type") || "";
      const bodyPromise = contentType.includes("application/json")
        ? response.json().catch(() => ({}))
        : response.text().catch(() => "").then((text) => ({ error: text }));
      return bodyPromise.then((payloadBody) => ({ response, body: parseComposeResponse(payloadBody) }));
    }).then(({ response, body }) => {
      if (!response.ok) {
        setLiveState(clearFactoryPreviewLiveState());
        setComposerStatus(body.error || "Request failed.");
        return;
      }
      clearDraft();
      input.value = "";
      saveDraft();
      setLiveState(acknowledgeFactoryPreviewLiveState(liveState, body, Date.now()));
      if (body.location) {
        window.location.assign(body.location);
        return;
      }
      setComposerStatus("");
      queueAll(0);
    }).catch((error: unknown) => {
      setLiveState(clearFactoryPreviewLiveState());
      setComposerStatus(error instanceof Error ? error.message : "Request failed.");
    }).finally(() => {
      setComposerBusy(false);
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-preview-command],[data-preview-drawer-toggle],[data-preview-drawer-close]") : null;
    if (!target) return;
    if (target.hasAttribute("data-preview-command")) {
      event.preventDefault();
      insertCommand(target.getAttribute("data-preview-command") || "");
      return;
    }
    if (target.hasAttribute("data-preview-drawer-toggle")) {
      event.preventDefault();
      setDrawerOpen(!drawerOpen());
      return;
    }
    if (target.hasAttribute("data-preview-drawer-close")) {
      event.preventDefault();
      setDrawerOpen(false);
    }
  });

  drawerBackdrop()?.addEventListener("click", () => {
    setDrawerOpen(false);
  });

  document.addEventListener("toggle", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLDetailsElement)) return;
    const sectionMatch = target.id.match(/^factory-preview-drawer-shell-(.+)$/);
    if (!sectionMatch?.[1] || !target.open) return;
    queueVisibleDrawerSections(0);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawerOpen()) {
      setDrawerOpen(false);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") queueAll(0);
  });
  window.addEventListener("focus", () => {
    if (document.visibilityState === "visible") queueAll(0);
  });
  window.addEventListener("pageshow", () => {
    if (document.visibilityState === "visible") queueAll(0);
  });
  window.addEventListener("online", () => {
    connect();
    queueAll(0);
  });
  window.addEventListener("resize", () => {
    if (drawerOpen()) setDrawerOpen(true);
  });
};

export const bootFactoryPreviewBrowser = () => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFactoryPreviewBrowser);
  } else {
    initFactoryPreviewBrowser();
  }
};
