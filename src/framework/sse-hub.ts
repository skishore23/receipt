export type Topic = "agent" | "receipt" | "jobs" | "factory";
export type SseSubscription = {
  readonly topic: Topic;
  readonly stream?: string;
};

type SseClient = {
  readonly send: (event: string, data: string) => void;
  readonly close: () => void;
};

const topicEvent: Record<Topic, string> = {
  agent: "agent-refresh",
  receipt: "receipt-refresh",
  jobs: "job-refresh",
  factory: "factory-refresh",
};

const globalTopicKey = (topic: Topic): string | undefined => (
  topic === "receipt"
    ? "receipt:*"
    : topic === "jobs"
      ? "jobs:*"
      : undefined
);

const topicKey = (topic: Topic, stream?: string): string =>
  stream === undefined ? (globalTopicKey(topic) ?? `${topic}:`) : `${topic}:${stream}`;

const SSE_KEEPALIVE_MS = 5_000;

export class SseHub {
  private readonly channels = new Map<string, Set<SseClient>>();

  private sendToKey(key: string, event: string, data: string): void {
    const bucket = this.channels.get(key);
    if (!bucket) return;

    for (const client of [...bucket]) {
      try {
        client.send(event, data);
      } catch {
        client.close();
      }
    }
  }

  subscribe(topic: Topic, stream: string | undefined, signal?: AbortSignal): Response {
    return this.subscribeMany([{ topic, stream }], signal);
  }

  subscribeMany(subscriptions: ReadonlyArray<SseSubscription>, signal?: AbortSignal): Response {
    const unique = new Map<string, SseSubscription>();
    for (const subscription of subscriptions) {
      unique.set(topicKey(subscription.topic, subscription.stream), subscription);
    }
    const targets = [...unique.entries()].map(([key, subscription]) => {
      if (!this.channels.has(key)) this.channels.set(key, new Set());
      return {
        topic: subscription.topic,
        bucket: this.channels.get(key)!,
      };
    });
    const encoder = new TextEncoder();

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let ping: NodeJS.Timeout | undefined;
    let closed = false;

    const send = (event: string, data: string) => {
      if (!controller || closed) return;
      try {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      } catch {
        close();
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      if (ping) clearInterval(ping);
      for (const target of targets) target.bucket.delete(client);
      try {
        controller?.close();
      } catch {
        // ignore close-after-close
      }
    };

    const client: SseClient = { send, close };
    for (const target of targets) target.bucket.add(client);

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        for (const target of targets) send(topicEvent[target.topic], "init");
        ping = setInterval(() => {
          send("ping", "keepalive");
        }, SSE_KEEPALIVE_MS);
      },
      cancel() {
        close();
      },
    });

    signal?.addEventListener("abort", close, { once: true });

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
    const data = String(Date.now());
    const key = topicKey(topic, stream);
    this.sendToKey(key, event, data);
    const globalKey = globalTopicKey(topic);
    if (globalKey && globalKey !== key) {
      this.sendToKey(globalKey, event, data);
    }
  }

  publishData(topic: Topic, stream: string | undefined, event: string, data: string): void {
    this.sendToKey(topicKey(topic, stream), event, data);
  }
}
