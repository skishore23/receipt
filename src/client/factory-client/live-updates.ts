import {
  ASSISTANT_RESPONSE_BODY_CLASS,
  ASSISTANT_RESPONSE_CARD_CLASS,
  asRecord,
  asString,
  escapeHtml,
  type StreamingReply,
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

export const renderStreamingReply = (reply: StreamingReply): string => {
  const label = reply.profileLabel || "Assistant";
  return '<section class="flex justify-start">' +
    '<div class="w-full max-w-3xl space-y-2">' +
      '<div class="flex flex-wrap items-center justify-between gap-2">' +
        '<div class="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">' + escapeHtml(label) + "</div>" +
        '<span class="text-[11px] text-muted-foreground">Streaming</span>' +
      "</div>" +
      '<div class="' + ASSISTANT_RESPONSE_CARD_CLASS + '">' +
        '<div class="' + ASSISTANT_RESPONSE_BODY_CLASS + '">' +
          '<div class="whitespace-pre-wrap text-sm leading-6 text-foreground">' + escapeHtml(reply.text) + "</div>" +
        "</div>" +
      "</div>" +
    "</div>" +
  "</section>";
};
