type Topic = "theorem" | "writer" | "receipt";

type SseClient = {
  readonly send: (event: string, data: string) => void;
  readonly close: () => void;
};

const topicEvent: Record<Topic, string> = {
  theorem: "theorem-refresh",
  writer: "writer-refresh",
  receipt: "receipt-refresh",
};

const topicKey = (topic: Topic, stream?: string): string =>
  topic === "receipt" ? "receipt:*" : `${topic}:${stream ?? ""}`;

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
    const key = topicKey(topic, stream);
    if (!this.channels.has(key)) this.channels.set(key, new Set());
    const bucket = this.channels.get(key)!;
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
      bucket.delete(client);
      try {
        controller?.close();
      } catch {
        // ignore close-after-close
      }
    };

    const client: SseClient = { send, close };
    bucket.add(client);

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        send(topicEvent[topic], "init");
        ping = setInterval(() => {
          send("ping", "keepalive");
        }, 15000);
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
    this.sendToKey(topicKey(topic, stream), topicEvent[topic], String(Date.now()));
  }

  publishData(topic: Topic, stream: string | undefined, event: string, data: string): void {
    this.sendToKey(topicKey(topic, stream), event, data);
  }
}
