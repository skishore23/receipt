import assert from "node:assert/strict";
import test from "node:test";

import { SseHub } from "../../src/framework/sse-hub.ts";

const readChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const chunk = await reader.read();
  if (chunk.done || !chunk.value) return "";
  return new TextDecoder().decode(chunk.value);
};

test("framework sse: subscribe sends init and publish emits topic event", async () => {
  const hub = new SseHub();
  const abort = new AbortController();
  const response = hub.subscribe("theorem", "demo", abort.signal);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");

  const reader = response.body?.getReader();
  assert.ok(reader, "sse stream reader missing");
  const streamReader = reader!;

  const init = await readChunk(streamReader);
  assert.match(init, /event: theorem-refresh/);
  assert.match(init, /data: init/);

  hub.publish("theorem", "demo");
  const published = await readChunk(streamReader);
  assert.match(published, /event: theorem-refresh/);
  assert.match(published, /data: \d+/);

  abort.abort();
  await streamReader.cancel();
});

test("framework sse: receipt topic is global", async () => {
  const hub = new SseHub();
  const abort = new AbortController();
  const response = hub.subscribe("receipt", undefined, abort.signal);
  const reader = response.body?.getReader();
  assert.ok(reader, "sse stream reader missing");
  const streamReader = reader!;

  const init = await readChunk(streamReader);
  assert.match(init, /event: receipt-refresh/);

  hub.publish("receipt");
  const published = await readChunk(streamReader);
  assert.match(published, /event: receipt-refresh/);

  abort.abort();
  await streamReader.cancel();
});

test("framework sse: publishData forwards custom event payload", async () => {
  const hub = new SseHub();
  const abort = new AbortController();
  const response = hub.subscribe("writer", "demo", abort.signal);
  const reader = response.body?.getReader();
  assert.ok(reader, "sse stream reader missing");
  const streamReader = reader!;

  await readChunk(streamReader); // init
  hub.publishData("writer", "demo", "writer-token", "{\"delta\":\"hi\"}");
  const published = await readChunk(streamReader);
  assert.match(published, /event: writer-token/);
  assert.match(published, /data: \{\"delta\":\"hi\"\}/);

  abort.abort();
  await streamReader.cancel();
});
