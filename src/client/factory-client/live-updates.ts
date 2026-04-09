import {
  asRecord,
  asString,
  escapeHtml,
  type TokenEventPayload,
} from "./shared";

export const parseTokenEventPayload = (value: string): TokenEventPayload | null => {
  if (!value) return null;
  try {
    const record = asRecord(JSON.parse(value));
    const delta = asString(record?.delta);
    if (!delta) return null;
    return {
      runId: asString(record?.runId),
      delta,
    };
  } catch (_err) {
    return null;
  }
};

export type AgentPhasePayload = {
  readonly runId?: string;
  readonly phase: string;
  readonly summary: string;
};

export const parseAgentPhasePayload = (value: string): AgentPhasePayload | null => {
  if (!value) return null;
  try {
    const record = asRecord(JSON.parse(value));
    const phase = asString(record?.phase);
    if (!phase) return null;
    return {
      runId: asString(record?.runId),
      phase,
      summary: asString(record?.summary) ?? "",
    };
  } catch {
    return null;
  }
};

type RenderEphemeralTurnInput = {
  readonly profileLabel: string;
  readonly surface?: "chat" | "handoff";
  readonly phase: "pending" | "streaming";
  readonly statusLabel: string;
  readonly summary: string;
  readonly userText?: string;
  readonly assistantText?: string;
  readonly runId?: string;
  readonly jobId?: string;
};

const renderEphemeralUserTurn = (text: string): string =>
  '<section class="flex justify-end">' +
    '<div class="max-w-3xl space-y-1">' +
      '<div class="text-right text-[11px] text-muted-foreground">Just now</div>' +
      '<div class="border border-border bg-muted/45 px-4 py-2.5 text-sm leading-6 text-foreground">' +
        escapeHtml(text) +
      "</div>" +
    "</div>" +
  "</section>";

const renderEphemeralStatusMeta = (input: Pick<RenderEphemeralTurnInput, "statusLabel" | "summary" | "runId" | "jobId">): string => {
  const metadata = [
    input.runId ? `Run ${input.runId}` : "",
    input.jobId ? `Job ${input.jobId}` : "",
  ].filter(Boolean).map((value) =>
    '<span class="border border-border bg-background px-2 py-1">' + escapeHtml(value) + "</span>"
  ).join("");
  return '<div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">' +
    '<span class="factory-ephemeral-status-badge">' + escapeHtml(input.statusLabel) + "</span>" +
    '<span class="min-w-0">' + escapeHtml(input.summary) + "</span>" +
    metadata +
  "</div>";
};

const renderEphemeralAssistantTurn = (input: RenderEphemeralTurnInput): string => {
  const hasText = Boolean(input.assistantText);
  return '<section class="flex justify-start">' +
    '<div class="w-full max-w-3xl space-y-2">' +
      '<div class="flex flex-wrap items-center justify-between gap-2">' +
        '<div class="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">' +
          '<span>' + escapeHtml(input.profileLabel) + "</span>" +
        "</div>" +
        '<span class="text-[11px] text-muted-foreground">' + escapeHtml(hasText ? "Streaming" : input.statusLabel) + "</span>" +
      "</div>" +
      '<div class="border border-border bg-background/85 px-4 py-3 shadow-sm">' +
        (hasText
          ? '<div class="factory-stream-text whitespace-pre-wrap text-sm leading-6 text-foreground">' +
              escapeHtml(input.assistantText || "") +
              '<span class="factory-stream-cursor" aria-hidden="true"></span>' +
            "</div>"
          : '<div class="factory-ephemeral-placeholder" aria-hidden="true">' +
              '<div class="factory-ephemeral-placeholder-line factory-ephemeral-placeholder-line--long"></div>' +
              '<div class="factory-ephemeral-placeholder-line factory-ephemeral-placeholder-line--medium"></div>' +
              '<div class="factory-ephemeral-placeholder-line factory-ephemeral-placeholder-line--short"></div>' +
            "</div>") +
        renderEphemeralStatusMeta(input) +
      "</div>" +
    "</div>" +
  "</section>";
};

export const renderEphemeralTurn = (input: RenderEphemeralTurnInput): string => {
  const user = input.userText ? renderEphemeralUserTurn(input.userText) : "";
  return user + renderEphemeralAssistantTurn(input);
};
