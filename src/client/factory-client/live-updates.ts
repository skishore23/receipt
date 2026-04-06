import {
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
  return '<div class="factory-stream-text whitespace-pre-wrap text-sm leading-6 text-foreground">' +
    escapeHtml(reply.text) +
    '<span class="factory-stream-cursor" aria-hidden="true"></span>' +
  "</div>";
};
