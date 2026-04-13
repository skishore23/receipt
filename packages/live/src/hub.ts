import {
  globalTopicKey,
  topicEvent,
  topicKey,
  type LiveEventFrame,
  type LiveFrame,
  type LiveSubscription,
  type Topic,
} from "./protocol";

type LiveSink = {
  readonly send: (frame: LiveFrame) => number | void;
  readonly close: () => void;
};

const SSE_KEEPALIVE_MS = 5_000;

const eventFrame = (
  topic: Topic,
  stream: string | undefined,
  event: string,
  data: string,
): LiveEventFrame => ({
  kind: "event",
  topic,
  stream,
  event,
  data,
});

export class LiveHub {
  private readonly channels = new Map<string, Set<LiveSink>>();

  private sendToKey(key: string, frame: LiveFrame): void {
    const bucket = this.channels.get(key);
    if (!bucket) return;

    for (const client of [...bucket]) {
      try {
        const result = client.send(frame);
        if (typeof result === "number" && result <= 0) client.close();
      } catch {
        client.close();
      }
    }
  }

  connect(
    subscriptions: ReadonlyArray<LiveSubscription>,
    sink: LiveSink,
    options: {
      readonly signal?: AbortSignal;
      readonly emitInit?: boolean;
    } = {},
  ): { readonly close: () => void } {
    const unique = new Map<string, LiveSubscription>();
    for (const subscription of subscriptions) {
      unique.set(topicKey(subscription.topic, subscription.stream), subscription);
    }
    const targets = [...unique.entries()].map(([key, subscription]) => {
      if (!this.channels.has(key)) this.channels.set(key, new Set());
      return {
        topic: subscription.topic,
        stream: subscription.stream,
        bucket: this.channels.get(key)!,
      };
    });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const target of targets) target.bucket.delete(sink);
      sink.close();
    };

    for (const target of targets) target.bucket.add(sink);
    options.signal?.addEventListener("abort", close, { once: true });

    if (options.emitInit !== false) {
      for (const target of targets) {
        sink.send(eventFrame(target.topic, target.stream, topicEvent[target.topic], "init"));
      }
    }

    return { close };
  }

  subscribe(topic: Topic, stream: string | undefined, signal?: AbortSignal): Response {
    return this.subscribeMany([{ topic, stream }], signal);
  }

  subscribeMany(subscriptions: ReadonlyArray<LiveSubscription>, signal?: AbortSignal): Response {
    const encoder = new TextEncoder();

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let ping: NodeJS.Timeout | undefined;
    let closed = false;

    const connectSink = () => this.connect(subscriptions, sink, { signal });

    const sink: LiveSink = {
      send: (frame) => {
        if (!controller || closed) return 0;
        if (frame.kind === "ping") {
          controller.enqueue(encoder.encode("event: ping\ndata: keepalive\n\n"));
          return 1;
        }
        controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${frame.data}\n\n`));
        return 1;
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        try {
          controller?.close();
        } catch {
          // ignore close-after-close
        }
      },
    };

    let connection: { readonly close: () => void } | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        connection = connectSink();
        ping = setInterval(() => {
          sink.send({ kind: "ping" });
        }, SSE_KEEPALIVE_MS);
      },
      cancel() {
        connection?.close();
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
      },
    });
  }

  publish(topic: Topic, stream?: string): void {
    const event = topicEvent[topic];
    const data = topic === "factory" && typeof stream === "string" && stream.trim().length > 0
      ? stream
      : String(Date.now());
    this.publishFrame(eventFrame(topic, stream, event, data));
  }

  publishData(topic: Topic, stream: string | undefined, event: string, data: string): void {
    this.publishFrame(eventFrame(topic, stream, event, data));
  }

  private publishFrame(frame: LiveEventFrame): void {
    const key = topicKey(frame.topic, frame.stream);
    this.sendToKey(key, frame);
    const globalKey = globalTopicKey(frame.topic);
    if (globalKey && globalKey !== key) {
      this.sendToKey(globalKey, frame);
    }
  }
}
