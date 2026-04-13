import { escapeHtml } from "./factory-client/shared";
import type { AgentPhasePayload } from "./factory-client/live-updates";
import type { FactoryComposeResponseBody } from "./factory-client/shared";

export type FactoryPreviewLiveState =
  | { readonly tag: "idle" }
  | {
      readonly tag: "sending" | "waiting" | "streaming" | "stalled";
      readonly turn: FactoryPreviewLiveTurn;
    };

export type FactoryPreviewLiveTurn = {
  readonly profileLabel: string;
  readonly statusLabel: string;
  readonly summary: string;
  readonly userText?: string;
  readonly assistantText?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly startedAt: number;
  readonly lastEventAt: number;
};

const IDLE_STATE: FactoryPreviewLiveState = { tag: "idle" };

const titleCase = (value: string): string =>
  value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());

const statusLabelForTag = (tag: Exclude<FactoryPreviewLiveState["tag"], "idle">): string => {
  switch (tag) {
    case "sending":
      return "Sending";
    case "waiting":
      return "Working";
    case "streaming":
      return "Streaming";
    case "stalled":
      return "Stalled";
  }
};

const summaryForTag = (
  tag: Exclude<FactoryPreviewLiveState["tag"], "idle">,
  previous?: string,
): string => {
  if (previous?.trim()) return previous.trim();
  switch (tag) {
    case "sending":
      return "Sending your message to Factory.";
    case "waiting":
      return "Factory accepted the message and is preparing the next update.";
    case "streaming":
      return "Factory is streaming the latest response.";
    case "stalled":
      return "No recent Factory update arrived. Waiting for the next meaningful event.";
  }
};

const preserveOrReplaceSummary = (
  nextTag: "waiting" | "streaming",
  previous: string,
): string => {
  const trimmed = previous.trim();
  if (!trimmed) return summaryForTag(nextTag);
  if (trimmed === summaryForTag("sending")) return summaryForTag(nextTag);
  return trimmed;
};

const withTurn = (
  tag: Exclude<FactoryPreviewLiveState["tag"], "idle">,
  turn: FactoryPreviewLiveTurn,
): FactoryPreviewLiveState => ({ tag, turn });

// Closed sum type + total reducers keep loader rendering consistent across every transition.
export const createFactoryPreviewLiveState = (input: {
  readonly profileLabel: string;
  readonly userText: string;
  readonly statusLabel?: string;
  readonly summary?: string;
  readonly now: number;
}): FactoryPreviewLiveState =>
  withTurn("sending", {
    profileLabel: input.profileLabel,
    userText: input.userText,
    statusLabel: input.statusLabel?.trim() || statusLabelForTag("sending"),
    summary: input.summary?.trim() || summaryForTag("sending"),
    startedAt: input.now,
    lastEventAt: input.now,
  });

export const clearFactoryPreviewLiveState = (): FactoryPreviewLiveState => IDLE_STATE;

export const acknowledgeFactoryPreviewLiveState = (
  state: FactoryPreviewLiveState,
  response: FactoryComposeResponseBody,
  now: number,
): FactoryPreviewLiveState => {
  if (state.tag === "idle") return state;
  return withTurn("waiting", {
    ...state.turn,
    runId: response.live?.runId ?? state.turn.runId,
    jobId: response.live?.jobId ?? state.turn.jobId,
    statusLabel: statusLabelForTag("waiting"),
    summary: preserveOrReplaceSummary("waiting", state.turn.summary),
    lastEventAt: now,
  });
};

export const applyFactoryPreviewPhase = (
  state: FactoryPreviewLiveState,
  payload: AgentPhasePayload,
  now: number,
): FactoryPreviewLiveState => {
  if (state.tag === "idle") return state;
  return withTurn("waiting", {
    ...state.turn,
    runId: payload.runId ?? state.turn.runId,
    statusLabel: titleCase(payload.phase) || statusLabelForTag("waiting"),
    summary: payload.summary?.trim() || preserveOrReplaceSummary("waiting", state.turn.summary),
    lastEventAt: now,
  });
};

export const appendFactoryPreviewToken = (
  state: FactoryPreviewLiveState,
  payload: { readonly runId?: string; readonly delta: string },
  now: number,
): FactoryPreviewLiveState => {
  if (state.tag === "idle") return state;
  return withTurn("streaming", {
    ...state.turn,
    runId: payload.runId ?? state.turn.runId,
    statusLabel: statusLabelForTag("streaming"),
    summary: preserveOrReplaceSummary("streaming", state.turn.summary),
    assistantText: `${state.turn.assistantText ?? ""}${payload.delta}`,
    lastEventAt: now,
  });
};

export const resetFactoryPreviewStream = (
  state: FactoryPreviewLiveState,
): FactoryPreviewLiveState => {
  if (state.tag === "idle") return state;
  return withTurn(state.tag === "stalled" ? "waiting" : state.tag, {
    ...state.turn,
    assistantText: "",
  });
};

export const markFactoryPreviewStalled = (
  state: FactoryPreviewLiveState,
  now: number,
  stallMs: number,
): FactoryPreviewLiveState => {
  if (state.tag === "idle" || state.tag === "stalled") return state;
  if (now - state.turn.lastEventAt < stallMs) return state;
  return withTurn("stalled", {
    ...state.turn,
    statusLabel: statusLabelForTag("stalled"),
    summary: state.turn.assistantText?.trim()
      ? "Streaming paused before the final server-rendered update arrived."
      : "No recent Factory update arrived. Waiting for the next meaningful event.",
    lastEventAt: now,
  });
};

export const shouldClearFactoryPreviewLiveState = (input: {
  readonly state: FactoryPreviewLiveState;
  readonly previousTranscriptSignature: string;
  readonly nextTranscriptSignature: string;
  readonly lastItemKind: string;
}): boolean =>
  input.state.tag !== "idle"
  && Boolean(input.previousTranscriptSignature)
  && input.nextTranscriptSignature !== input.previousTranscriptSignature
  && Boolean(input.lastItemKind)
  && input.lastItemKind !== "user";

const renderUserBubble = (text?: string): string =>
  text
    ? `<section class="flex justify-end">
        <div class="max-w-3xl space-y-1">
          <div class="text-right text-[11px] text-muted-foreground">Just now</div>
          <div class="border border-border bg-muted/45 px-4 py-2.5 text-sm leading-6 text-foreground">${escapeHtml(text)}</div>
        </div>
      </section>`
    : "";

const renderMetadata = (turn: FactoryPreviewLiveTurn): string => {
  const values = [
    turn.runId ? `Run ${turn.runId}` : "",
    turn.jobId ? `Job ${turn.jobId}` : "",
  ].filter(Boolean);
  if (values.length === 0) return "";
  return `<div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
    ${values.map((value) => `<span class="border border-border bg-background px-2 py-1">${escapeHtml(value)}</span>`).join("")}
  </div>`;
};

export const renderFactoryPreviewLiveState = (state: FactoryPreviewLiveState): string => {
  if (state.tag === "idle") return "";
  const user = renderUserBubble(state.turn.userText);
  const isStalled = state.tag === "stalled";
  const toneClass = isStalled
    ? "border-warning/30 bg-warning/5"
    : "border-border bg-background/90";
  const indicatorClass = isStalled
    ? "factory-preview-loader-indicator factory-preview-loader-indicator--stalled"
    : "factory-preview-loader-indicator";
  const body = state.turn.assistantText?.trim()
    ? `<div class="whitespace-pre-wrap text-sm leading-6 text-foreground">${escapeHtml(state.turn.assistantText)}</div>`
    : `<div class="text-sm leading-6 text-foreground">${escapeHtml(state.turn.summary)}</div>`;
  const supportingCopy = state.turn.assistantText?.trim()
    ? `<div class="mt-1 text-xs leading-5 text-muted-foreground">${escapeHtml(state.turn.summary)}</div>`
    : "";
  return `${user}<section class="flex justify-start">
    <div class="w-full max-w-3xl space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          <span>${escapeHtml(state.turn.profileLabel)}</span>
        </div>
        <span class="text-[11px] text-muted-foreground">${escapeHtml(state.turn.statusLabel)}</span>
      </div>
      <div class="border px-4 py-3 ${toneClass}">
        <div class="flex items-start gap-3">
          <span class="${indicatorClass}" aria-hidden="true"></span>
          <div class="min-w-0 flex-1">
            ${body}
            ${supportingCopy}
            ${renderMetadata(state.turn)}
          </div>
        </div>
      </div>
    </div>
  </section>`;
};
