import {
  asRecord,
  asString,
  escapeHtml,
  type FactoryComposeResponseBody,
  type FactoryLiveScopePayload,
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

export const isInlineFactoryLocation = (location: string): boolean => {
  const url = resolveFactoryUrl(location);
  if (!url) return false;
  if (window.location && window.location.origin && url.origin !== window.location.origin) return false;
  return url.pathname === shellPath();
};

const leadingSlashCommand = (payload: string) => {
  const match = payload.trim().match(/^\/([^\s]+)/);
  if (!match || !match[1]) return null;
  return match[1] === "?" ? "help" : match[1].toLowerCase();
};

const renderOptimisticPrompt = (payload: string, mode: "thread" | "chat" | "workbench-chat") => {
  const statusMeta = mode === "thread" ? "Updated just now" : "Just now";
  const echo = '<section class="flex justify-end">' +
    '<div class="max-w-3xl space-y-1">' +
      '<div class="text-right text-[11px] text-muted-foreground">' + statusMeta + "</div>" +
      '<div class="border border-info/15 bg-info/10 px-4 py-2.5 text-sm leading-6 text-foreground">' + escapeHtml(payload) + "</div>" +
    "</div>" +
  "</section>";
  if (mode === "workbench-chat") return echo;
  const title = mode === "thread" ? "Updating thread" : "Queued thread";
  const detail = mode === "thread"
    ? "Applying your note to this thread..."
    : "Creating the thread and starting work...";
  const statusLabel = mode === "thread" ? "Updating" : "Queued";
  return echo +
  '<section class=" border border-primary/20 bg-primary/5 px-3 py-2">' +
    '<div class="flex min-w-0 items-center justify-between gap-2">' +
      '<div class="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">' +
        '<span class="text-xs font-semibold text-foreground">' + escapeHtml(title) + "</span>" +
        '<span class="min-w-0 text-xs leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:1] overflow-hidden">' + escapeHtml(detail) + "</span>" +
      "</div>" +
      '<span class="inline-flex shrink-0 items-center  border border-primary/20 bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">' + statusLabel + "</span>" +
    "</div>" +
  "</section>";
};

const workbenchOptimisticText = (payload: string) => payload;

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
  const hasThread = Boolean(
    (formAction && formAction.indexOf("objective=") >= 0)
    || options?.currentObjectiveId,
  );
  const command = leadingSlashCommand(payload);
  if (command) {
    switch (command) {
      case "analyze":
        return {
          buttonLabel: "Analyzing...",
          status: isWorkbenchSurface ? "Analyzing objective..." : "Analyzing thread...",
          ...(isWorkbenchSurface
            ? { optimisticText: workbenchOptimisticText(payload) }
            : { optimisticHtml: renderOptimisticPrompt(payload, hasThread ? "thread" : "chat") }),
          showPendingStream: true,
        };
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
      optimisticText: workbenchOptimisticText(payload),
      status: "",
      showPendingStream: true,
    };
  }
  return {
    buttonLabel: hasThread ? "Updating..." : "Starting...",
    optimisticHtml: renderOptimisticPrompt(payload, hasThread ? "thread" : "chat"),
    status: hasThread ? "Updating the thread..." : "Starting a new thread...",
    showPendingStream: true,
  };
};
