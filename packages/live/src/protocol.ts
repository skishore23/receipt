export type Topic =
  | "agent"
  | "receipt"
  | "jobs"
  | "factory"
  | "profile-board"
  | "objective-runtime";

export type LiveSubscription = {
  readonly topic: Topic;
  readonly stream?: string;
};

export type LiveEventFrame = {
  readonly kind: "event";
  readonly topic: Topic;
  readonly event: string;
  readonly data: string;
  readonly stream?: string;
  readonly id?: string;
};

export type LivePingFrame = {
  readonly kind: "ping";
};

export type LiveFrame = LiveEventFrame | LivePingFrame;

export const topicEvent: Record<Topic, string> = {
  agent: "agent-refresh",
  receipt: "receipt-refresh",
  jobs: "job-refresh",
  factory: "factory-refresh",
  "profile-board": "profile-board-refresh",
  "objective-runtime": "objective-runtime-refresh",
};

export const globalTopicKey = (topic: Topic): string | undefined => (
  topic === "receipt"
    ? "receipt:*"
    : topic === "jobs"
      ? "jobs:*"
      : topic === "factory"
        ? "factory:*"
        : topic === "profile-board"
          ? "profile-board:*"
          : topic === "objective-runtime"
            ? "objective-runtime:*"
            : undefined
);

export const topicKey = (topic: Topic, stream?: string): string =>
  stream === undefined ? (globalTopicKey(topic) ?? `${topic}:`) : `${topic}:${stream}`;

export const encodeLiveFrame = (frame: LiveFrame): string => JSON.stringify(frame);

export const decodeLiveFrame = (value: string): LiveFrame | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LiveFrame> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.kind === "ping") return { kind: "ping" };
    if (
      parsed.kind === "event"
      && typeof parsed.topic === "string"
      && typeof parsed.event === "string"
      && typeof parsed.data === "string"
    ) {
      return {
        kind: "event",
        topic: parsed.topic as Topic,
        event: parsed.event,
        data: parsed.data,
        stream: typeof parsed.stream === "string" && parsed.stream.trim().length > 0
          ? parsed.stream
          : undefined,
        id: typeof parsed.id === "string" && parsed.id.trim().length > 0
          ? parsed.id
          : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
};
