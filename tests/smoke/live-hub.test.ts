import { expect, test } from "bun:test";

import { createLiveEventSource } from "@receipt/live/browser";
import { LiveHub, type LiveFrame } from "@receipt/live";

test("live hub: websocket-style sinks receive init and custom event frames", () => {
  const hub = new LiveHub();
  const frames: LiveFrame[] = [];

  const connection = hub.connect(
    [{ topic: "agent", stream: "demo" }],
    {
      send: (frame) => {
        frames.push(frame);
        return 1;
      },
      close: () => {
        // no-op
      },
    },
  );

  expect(frames[0]).toEqual({
    kind: "event",
    topic: "agent",
    stream: "demo",
    event: "agent-refresh",
    data: "init",
  });

  hub.publishData("agent", "demo", "agent-token", "{\"delta\":\"hi\"}");

  expect(frames.at(-1)).toEqual({
    kind: "event",
    topic: "agent",
    stream: "demo",
    event: "agent-token",
    data: "{\"delta\":\"hi\"}",
  });

  connection.close();
});

test("live browser transport: websocket messages dispatch named events", () => {
  const sockets: MockWebSocket[] = [];

  class MockWebSocket {
    readonly listeners = new Map<string, Array<(event: Event | MessageEvent<string>) => void>>();

    constructor(readonly url: string) {
      sockets.push(this);
    }

    addEventListener(type: string, handler: (event: Event | MessageEvent<string>) => void) {
      const handlers = this.listeners.get(type) ?? [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    emit(type: string, data?: string) {
      const event = type === "message"
        ? new MessageEvent<string>("message", { data: data ?? "" })
        : new Event(type);
      for (const handler of this.listeners.get(type) ?? []) handler(event);
    }

    close() {
      // no-op
    }
  }

  const browser = {
    location: {
      href: "http://receipt.test/factory?profile=generalist",
      protocol: "http:",
      host: "receipt.test",
    },
    WebSocket: MockWebSocket,
  };

  const source = createLiveEventSource("/factory/live?profile=generalist", browser);
  let received = "";

  source.addEventListener("agent-token", (event) => {
    received = (event as MessageEvent<string>).data;
  });

  expect(sockets).toHaveLength(1);
  expect(sockets[0]?.url).toBe("ws://receipt.test/factory/live?profile=generalist");

  sockets[0]?.emit("message", JSON.stringify({
    kind: "event",
    topic: "agent",
    event: "agent-token",
    data: "{\"delta\":\"hello\"}",
  }));

  expect(received).toBe("{\"delta\":\"hello\"}");
  source.close();
});
