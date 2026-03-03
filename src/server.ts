// ============================================================================
// Server - Hono transport + manifest-based routing
// ============================================================================

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { Hono } from "hono";
import { serve } from "@hono/node-server";

import { jsonlStore, jsonBranchStore } from "./adapters/jsonl.js";
import { jsonlIndexedStore } from "./adapters/jsonl-indexed.js";
import { createRuntime } from "./core/runtime.js";
import type { TodoEvent } from "./modules/todo.js";
import { decide, reduce, initial } from "./modules/todo.js";
import type { InspectorEvent } from "./modules/inspector.js";
import { decide as decideInspector, reduce as reduceInspector, initial as initialInspector } from "./modules/inspector.js";
import type { TheoremEvent } from "./modules/theorem.js";
import { decide as decideTheorem, reduce as reduceTheorem, initial as initialTheorem } from "./modules/theorem.js";
import type { WriterEvent } from "./modules/writer.js";
import { decide as decideWriter, reduce as reduceWriter, initial as initialWriter } from "./modules/writer.js";
import { llmText } from "./adapters/openai.js";
import { loadTheoremPrompts, hashTheoremPrompts } from "./prompts/theorem.js";
import { loadWriterPrompts, hashWriterPrompts } from "./prompts/writer.js";
import { loadInspectorPrompts, hashInspectorPrompts } from "./prompts/inspector.js";
import { createAgentRegistry } from "./framework/registry.js";
import { compileRoutes } from "./framework/route-compiler.js";
import { SseHub } from "./framework/sse-hub.js";
import { text } from "./framework/http.js";
import { createTodoManifest } from "./agents/todo.manifest.js";
import { createTheoremManifest } from "./agents/theorem.manifest.js";
import { createWriterManifest } from "./agents/writer.manifest.js";
import { createInspectorManifest } from "./agents/inspector.manifest.js";

// ============================================================================
// Config
// ============================================================================

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const USE_INDEXED_STORE = process.env.RECEIPT_INDEXED_STORE === "1";

// ============================================================================
// Composition: Store -> Runtime
// ============================================================================

const makeStore = <E,>() =>
  (USE_INDEXED_STORE ? jsonlIndexedStore<E>(DATA_DIR) : jsonlStore<E>(DATA_DIR));

const store = makeStore<TodoEvent>();
const branchStore = jsonBranchStore(DATA_DIR);
const runtime = createRuntime(store, branchStore, decide, reduce, initial);

const theoremStore = makeStore<TheoremEvent>();
const theoremRuntime = createRuntime(
  theoremStore,
  branchStore,
  decideTheorem,
  reduceTheorem,
  initialTheorem
);

const writerStore = makeStore<WriterEvent>();
const writerRuntime = createRuntime(
  writerStore,
  branchStore,
  decideWriter,
  reduceWriter,
  initialWriter
);

const inspectorStore = makeStore<InspectorEvent>();
const inspectorRuntime = createRuntime(
  inspectorStore,
  branchStore,
  decideInspector,
  reduceInspector,
  initialInspector
);

// ============================================================================
// Prompts + Models
// ============================================================================

const THEOREM_PROMPTS = loadTheoremPrompts();
const THEOREM_PROMPTS_HASH = hashTheoremPrompts(THEOREM_PROMPTS);
const THEOREM_PROMPTS_PATH = process.env.THEOREM_PROMPTS_PATH ?? "prompts/theorem.prompts.json";
const THEOREM_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

const WRITER_PROMPTS = loadWriterPrompts();
const WRITER_PROMPTS_HASH = hashWriterPrompts(WRITER_PROMPTS);
const WRITER_PROMPTS_PATH = process.env.WRITER_PROMPTS_PATH ?? "prompts/writer.prompts.json";
const WRITER_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

const INSPECTOR_PROMPTS = loadInspectorPrompts();
const INSPECTOR_PROMPTS_HASH = hashInspectorPrompts(INSPECTOR_PROMPTS);
const INSPECTOR_PROMPTS_PATH = process.env.INSPECTOR_PROMPTS_PATH ?? "prompts/inspector.prompts.json";
const INSPECTOR_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.2";

// ============================================================================
// Manifest Registry + Routes
// ============================================================================

const sse = new SseHub();

const registry = createAgentRegistry([
  createTodoManifest({ runtime, sse }),
  createTheoremManifest({
    runtime: theoremRuntime,
    llmText,
    prompts: THEOREM_PROMPTS,
    promptHash: THEOREM_PROMPTS_HASH,
    promptPath: THEOREM_PROMPTS_PATH,
    model: THEOREM_MODEL,
    sse,
  }),
  createWriterManifest({
    runtime: writerRuntime,
    llmText,
    prompts: WRITER_PROMPTS,
    promptHash: WRITER_PROMPTS_HASH,
    promptPath: WRITER_PROMPTS_PATH,
    model: WRITER_MODEL,
    sse,
  }),
  createInspectorManifest({
    runtime: inspectorRuntime,
    dataDir: DATA_DIR,
    llmText,
    prompts: INSPECTOR_PROMPTS,
    promptHash: INSPECTOR_PROMPTS_HASH,
    promptPath: INSPECTOR_PROMPTS_PATH,
    model: INSPECTOR_MODEL,
    sse,
  }),
]);

const app = new Hono();

app.onError((err) => {
  console.error(err);
  return text(500, "Server error");
});

compileRoutes(app, registry);

app.notFound(() => text(404, "Not found"));

try {
  fs.watch(DATA_DIR, { persistent: false }, () => {
    sse.publish("receipt");
  });
} catch (err) {
  console.warn("Receipt watcher failed:", err);
}

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Receipt server listening on http://localhost:${PORT}`);
});
