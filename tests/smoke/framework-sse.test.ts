import { test, expect } from "bun:test";

import { SseHub } from "../../src/framework/sse-hub";

const readChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const chunk = await reader.read();
  if (chunk.done || !chunk.value) return "";
  return new TextDecoder().decode(chunk.value);
};

test("framework sse: subscribe sends init and publish emits topic event", async () => {
  const hub = new SseHub();
  const abort = new AbortController();
  const response = hub.subscribe("agent", "demo", abort.signal);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");

  const reader = response.body?.getReader();
  expect(reader).toBeTruthy();
  const streamReader = reader!;

  const init = await readChunk(streamReader);
  expect(init).toMatch(/event: agent-refresh/);
  expect(init).toMatch(/data: init/);

  hub.publish("agent", "demo");
  const published = await readChunk(streamReader);
  expect(published).toMatch(/event: agent-refresh/);
  expect(published).toMatch(/data: \d+/);

  abort.abort();
  await streamReader.cancel();
});

test("framework sse: receipt topic is global", async () => {
  const hub = new SseHub();
  const abort = new AbortController();
  const response = hub.subscribe("receipt", undefined, abort.signal);
  const reader = response.body?.getReader();
  expect(reader).toBeTruthy();
  const streamReader = reader!;

  const init = await readChunk(streamReader);
  expect(init).toMatch(/event: receipt-refresh/);

  hub.publish("receipt");
  const published = await readChunk(streamReader);
  expect(published).toMatch(/event: receipt-refresh/);

  abort.abort();
  await streamReader.cancel();
});

test("framework sse: publishData forwards custom event payload", async () => {
  const hub = new SseHub();
  const abort = new AbortController();
  const response = hub.subscribe("agent", "demo", abort.signal);
  const reader = response.body?.getReader();
  expect(reader).toBeTruthy();
  const streamReader = reader!;

  await readChunk(streamReader); // init
  hub.publishData("agent", "demo", "agent-token", "{\"delta\":\"hi\"}");
  const published = await readChunk(streamReader);
  expect(published).toMatch(/event: agent-token/);
  expect(published).toMatch(/data: \{\"delta\":\"hi\"\}/);

  abort.abort();
  await streamReader.cancel();
});

test("framework sse: subscribeMany fans in multiple topics", async () => {
  const hub = new SseHub();
  const abort = new AbortController();
  const response = hub.subscribeMany([
    { topic: "agent", stream: "demo" },
    { topic: "receipt" },
  ], abort.signal);
  const reader = response.body?.getReader();
  expect(reader).toBeTruthy();
  const streamReader = reader!;

  const init = `${await readChunk(streamReader)}${await readChunk(streamReader)}`;
  expect(init).toMatch(/event: agent-refresh/);
  expect(init).toMatch(/event: receipt-refresh/);

  hub.publish("agent", "demo");
  hub.publish("receipt");
  const published = `${await readChunk(streamReader)}${await readChunk(streamReader)}`;
  expect(published).toMatch(/event: agent-refresh/);
  expect(published).toMatch(/event: receipt-refresh/);

  abort.abort();
  await streamReader.cancel();
});

test("framework sse: global jobs subscription receives job-specific publishes", async () => {
  const hub = new SseHub();
  const abort = new AbortController();
  const response = hub.subscribe("jobs", undefined, abort.signal);
  const reader = response.body?.getReader();
  expect(reader).toBeTruthy();
  const streamReader = reader!;

  const init = await readChunk(streamReader);
  expect(init).toMatch(/event: job-refresh/);

  hub.publish("jobs", "job_demo");
  const published = await readChunk(streamReader);
  expect(published).toMatch(/event: job-refresh/);

  abort.abort();
  await streamReader.cancel();
});

test("framework sse: factory topic publishes objective-scoped refresh events", async () => {
  const hub = new SseHub();
  const abort = new AbortController();
  const response = hub.subscribe("factory", "objective_demo", abort.signal);
  const reader = response.body?.getReader();
  expect(reader).toBeTruthy();
  const streamReader = reader!;

  const init = await readChunk(streamReader);
  expect(init).toMatch(/event: factory-refresh/);

  hub.publish("factory", "objective_demo");
  const published = await readChunk(streamReader);
  expect(published).toMatch(/event: factory-refresh/);
  expect(published).toMatch(/data: objective_demo/);

  abort.abort();
  await streamReader.cancel();
});

test("framework sse: global factory subscription receives objective-specific publishes", async () => {
  const hub = new SseHub();
  const abort = new AbortController();
  const response = hub.subscribe("factory", undefined, abort.signal);
  const reader = response.body?.getReader();
  expect(reader).toBeTruthy();
  const streamReader = reader!;

  const init = await readChunk(streamReader);
  expect(init).toMatch(/event: factory-refresh/);

  hub.publish("factory", "objective_demo");
  const published = await readChunk(streamReader);
  expect(published).toMatch(/event: factory-refresh/);
  expect(published).toMatch(/data: objective_demo/);

  abort.abort();
  await streamReader.cancel();
});
