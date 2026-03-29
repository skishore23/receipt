import {
  asRecord,
  asString,
  escapeHtml,
  type FactoryComposeResponseBody,
  type FactoryLiveScopePayload,
  type LiveScope,
} from "./shared";

const normalizeLivePayload = (value: unknown): FactoryLiveScopePayload | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    profileId: asString(record.profileId),
    chatId: asString(record.chatId),
    objectiveId: asString(record.objectiveId),
    runId: asString(record.runId),
    jobId: asString(record.jobId),
  };
};

export const parseComposeResponse = (value: unknown): FactoryComposeResponseBody => {
  const record = asRecord(value);
  if (!record) return {};
  const selection = asRecord(record.selection);
  const chat = asRecord(record.chat);
  return {
    location: asString(record.location),
    error: asString(record.error),
    live: normalizeLivePayload(record.live),
    chat: chat
      ? {
          chatId: asString(chat.chatId),
        }
      : undefined,
    selection: selection
      ? {
          objectiveId: asString(selection.objectiveId),
          focusKind: selection.focusKind === "task" || selection.focusKind === "job"
            ? selection.focusKind
            : undefined,
          focusId: asString(selection.focusId),
        }
      : undefined,
  };
};

export const resolveFactoryUrl = (value: string | undefined): URL | null => {
  if (!value || typeof URL !== "function") return null;
  try {
    return new URL(value, String(window.location && window.location.href ? window.location.href : value));
  } catch (_err) {
    return null;
  }
};

export const shellPath = () => "/factory";

export const eventsUrl = (search: string) => "/factory/events" + (search || "");

export const islandUrl = (kind: "chat" | "sidebar" | "inspector", search: string) => shellPath() + "/island/" + kind + (search || "");

export const buildScope = (url: URL, live?: FactoryLiveScopePayload): LiveScope => ({
  profileId: live?.profileId || asString(url.searchParams.get("profile")) || undefined,
  chatId: live?.chatId || asString(url.searchParams.get("chat")) || undefined,
  objectiveId: live?.objectiveId || asString(url.searchParams.get("objective")) || asString(url.searchParams.get("thread")) || undefined,
  runId: live?.runId || asString(url.searchParams.get("run")) || undefined,
  jobId: live?.jobId || asString(url.searchParams.get("job")) || undefined,
  search: url.search || "",
});

export const isInlineFactoryLocation = (location: string): boolean => {
  const url = resolveFactoryUrl(location);
  if (!url) return false;
  if (window.location && window.location.origin && url.origin !== window.location.origin) return false;
  return url.pathname === shellPath();
};

export const factoryNavigationTarget = (event: Event): {
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
  if (!url || !isInlineFactoryLocation(url.href)) return null;
  return {
    location: url.href,
    historyMode: target.getAttribute("data-factory-history") === "replace" ? "replace" : "push",
  };
};

const leadingSlashCommand = (payload: string) => {
  const match = payload.trim().match(/^\/([^\s]+)/);
  if (!match || !match[1]) return null;
  return match[1] === "?" ? "help" : match[1].toLowerCase();
};

const renderOptimisticPrompt = (payload: string, mode: "thread" | "chat" | "workbench-chat") => {
  const title = mode === "thread"
    ? "Updating thread"
    : mode === "workbench-chat"
    ? "Sending to chat"
    : "Queued thread";
  const detail = mode === "thread"
    ? "Applying your note to this thread..."
    : mode === "workbench-chat"
    ? "Keeping the operator conversation moving..."
    : "Creating the thread and starting work...";
  const statusLabel = mode === "thread"
    ? "Updating"
    : mode === "workbench-chat"
    ? "Chat"
    : "Queued";
  const statusMeta = mode === "thread" ? "Updated just now" : "Queued just now";
  return '<section class="flex justify-end">' +
    '<div class="max-w-3xl space-y-1">' +
      '<div class="text-right text-[11px] text-muted-foreground">' + statusMeta + "</div>" +
      '<div class="rounded-xl border border-info/15 bg-info/10 px-4 py-2.5 text-sm leading-6 text-foreground">' + escapeHtml(payload) + "</div>" +
    "</div>" +
  "</section>" +
  '<section class="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">' +
    '<div class="flex min-w-0 items-center justify-between gap-2">' +
      '<div class="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">' +
        '<span class="text-xs font-semibold text-foreground">' + escapeHtml(title) + "</span>" +
        '<span class="min-w-0 text-xs leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:1] overflow-hidden">' + escapeHtml(detail) + "</span>" +
      "</div>" +
      '<span class="inline-flex shrink-0 items-center rounded-full border border-primary/20 bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">' + statusLabel + "</span>" +
    "</div>" +
  "</section>";
};

export const composerFeedback = (
  payload: string,
  formAction?: string,
  options?: {
    readonly currentObjectiveId?: string;
  },
) => {
  const isWorkbenchSurface = Boolean(
    formAction
    && (
      formAction.indexOf("/factory/compose") >= 0
      || formAction.indexOf("/factory/workbench") >= 0
    ),
  );
  const command = leadingSlashCommand(payload);
  if (command) {
    switch (command) {
      case "analyze":
        return { buttonLabel: "Opening...", status: "Opening analysis..." };
      case "help":
        return { buttonLabel: "Opening...", status: "Opening help..." };
      case "watch":
        return { buttonLabel: "Opening...", status: isWorkbenchSurface ? "Opening objective..." : "Opening thread..." };
      case "obj":
        return { buttonLabel: "Starting...", status: "Starting objective..." };
      case "new":
        return { buttonLabel: "Starting...", status: isWorkbenchSurface ? "Starting objective..." : "Starting a new thread..." };
      case "react":
        return { buttonLabel: "Updating...", status: isWorkbenchSurface ? "Updating the objective..." : "Updating the thread..." };
      case "promote":
        return { buttonLabel: "Promoting...", status: isWorkbenchSurface ? "Promoting the objective..." : "Promoting the thread..." };
      case "cancel":
        return { buttonLabel: "Stopping...", status: isWorkbenchSurface ? "Stopping the objective..." : "Stopping the thread..." };
      case "cleanup":
        return { buttonLabel: "Cleaning...", status: "Cleaning worktrees..." };
      case "archive":
        return { buttonLabel: "Archiving...", status: isWorkbenchSurface ? "Archiving the objective..." : "Archiving the thread..." };
      case "abort-job":
        return { buttonLabel: "Aborting...", status: "Requesting job abort..." };
      default:
        return { buttonLabel: "Running...", status: "Running command..." };
    }
  }
  if (isWorkbenchSurface) {
    return {
      buttonLabel: "Sending...",
      optimisticHtml: renderOptimisticPrompt(payload, "workbench-chat"),
      status: "Sending to chat...",
    };
  }
  const hasThread = Boolean(
    (formAction && formAction.indexOf("thread=") >= 0)
    || options?.currentObjectiveId,
  );
  return {
    buttonLabel: hasThread ? "Updating..." : "Starting...",
    optimisticHtml: renderOptimisticPrompt(payload, hasThread ? "thread" : "chat"),
    status: hasThread ? "Updating the thread..." : "Starting a new thread...",
  };
};
