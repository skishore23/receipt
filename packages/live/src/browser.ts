import { decodeLiveFrame } from "./protocol";

type Listener = (event: Event | MessageEvent<string>) => void;

type LiveSourceLike = {
  readonly url: string;
  addEventListener: (type: string, handler: Listener) => void;
  removeEventListener?: (type: string, handler: Listener) => void;
  close: () => void;
};

type BrowserLike = {
  readonly location?: {
    readonly href: string;
    readonly protocol?: string;
    readonly host?: string;
  };
  readonly WebSocket?: {
    new(url: string): {
      addEventListener: (type: string, handler: (event: Event | MessageEvent<string>) => void) => void;
      close: () => void;
      send?: (value: string) => void;
    };
  };
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
};

const dispatchTo = (
  handlers: ReadonlyArray<Listener>,
  event: Event | MessageEvent<string>,
): void => {
  for (const handler of handlers) handler(event);
};

const eventListeners = (listeners: Map<string, Array<Listener>>, type: string): ReadonlyArray<Listener> =>
  listeners.get(type) ?? [];

export const resolveWebSocketUrl = (path: string, browser: BrowserLike = window): string => {
  if (/^wss?:\/\//u.test(path)) return path;
  const baseHref = browser.location?.href ?? "http://localhost/";
  const resolved = new URL(path, baseHref);
  resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
  return resolved.toString();
};

export const createLiveEventSource = (
  path: string,
  browser: BrowserLike = window,
): LiveSourceLike => {
  const WebSocketCtor = browser.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new Error("Live transport requires WebSocket support.");
  }

  const listeners = new Map<string, Array<Listener>>();
  const reconnectDelayMs = 1_000;
  const url = resolveWebSocketUrl(path, browser);
  let socket: InstanceType<NonNullable<BrowserLike["WebSocket"]>> | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const dispatch = (type: string, data?: string) => {
    const event = typeof data === "string"
      ? new MessageEvent<string>(type, { data })
      : new Event(type);
    dispatchTo(eventListeners(listeners, type), event);
  };

  const connect = () => {
    if (closed) return;
    socket = new WebSocketCtor(url);
    socket.addEventListener("open", () => {
      dispatch("open");
    });
    socket.addEventListener("error", () => {
      dispatch("error");
    });
    socket.addEventListener("close", () => {
      dispatch("error");
      if (closed) return;
      const setReconnect = browser.setTimeout ?? setTimeout;
      reconnectTimer = setReconnect(() => {
        reconnectTimer = undefined;
        connect();
      }, reconnectDelayMs);
    });
    socket.addEventListener("message", (event) => {
      const message = event as MessageEvent<string>;
      const payload = typeof message.data === "string" ? message.data : "";
      const frame = decodeLiveFrame(payload);
      if (!frame || frame.kind !== "event") return;
      dispatch(frame.event, frame.data);
    });
  };

  connect();

  return {
    url,
    addEventListener(type: string, handler: Listener) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type: string, handler: Listener) {
      const handlers = listeners.get(type);
      if (!handlers) return;
      listeners.set(type, handlers.filter((candidate) => candidate !== handler));
    },
    close() {
      if (closed) return;
      closed = true;
      const clearReconnect = browser.clearTimeout ?? clearTimeout;
      if (reconnectTimer) clearReconnect(reconnectTimer);
      socket?.close();
    },
  };
};
