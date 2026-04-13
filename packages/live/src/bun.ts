import type { LiveHub } from "./hub";
import type { LiveSubscription } from "./protocol";

type BunWebSocketLike = {
  readonly raw?: {
    send: (value: string) => number;
  };
  send: (value: string) => void;
  close: (code?: number, reason?: string) => void;
};

export const bindBunWebSocketToLiveHub = (
  hub: LiveHub,
  subscriptions: ReadonlyArray<LiveSubscription>,
  ws: BunWebSocketLike,
): { readonly close: () => void } =>
  hub.connect(subscriptions, {
    send: (frame) => {
      const payload = JSON.stringify(frame);
      if (typeof ws.raw?.send === "function") return ws.raw.send(payload);
      ws.send(payload);
      return 1;
    },
    close: () => {
      ws.close(1000, "closing");
    },
  });
