// ============================================================================
// Server — HTTP layer (thin, just routing)
// 
// The server is just a thin layer that:
// 1. Routes requests
// 2. Calls runtime/views
// 3. Returns responses
// ============================================================================

import http from "node:http";
import { URL } from "node:url";
import path from "node:path";

import { jsonlStore, jsonBranchStore } from "./adapters/jsonl.js";
import { createRuntime } from "./core/runtime.js";
import { fold } from "./core/chain.js";

import type { TodoCmd, TodoEvent, TodoState } from "./modules/todo.js";
import { decide, reduce, initial } from "./modules/todo.js";

import { shell, stateHtml, timelineHtml, timeHtml, verifyHtml, oobAll, branchSelectorHtml } from "./views/html.js";

// ============================================================================
// Config
// ============================================================================

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

// ============================================================================
// Composition: Store → Runtime
// ============================================================================

const store = jsonlStore<TodoEvent>(DATA_DIR);
const branchStore = jsonBranchStore(DATA_DIR);
const runtime = createRuntime(store, branchStore, decide, reduce, initial);

// ============================================================================
// Helpers
// ============================================================================

const parseAt = (s: string | null): number | null => {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf-8");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const parseForm = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of raw.split("&")) {
    const [k, v] = part.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent((v ?? "").replace(/\+/g, " "));
  }
  return out;
};

const toCmd = (f: Record<string, string>): TodoCmd | null => {
  if (f.text?.trim()) return { type: "add", text: f.text };
  if (f.type === "toggle" && f.id) return { type: "toggle", id: f.id };
  if (f.type === "delete" && f.id) return { type: "delete", id: f.id };
  return null;
};

type Res = { code: number; body: string; type: string; headers?: Record<string, string> };

const html = (body: string, headers?: Record<string, string>): Res =>
  ({ code: 200, body, type: "text/html; charset=utf-8", headers });

const send = (res: http.ServerResponse, r: Res) => {
  res.statusCode = r.code;
  res.setHeader("Content-Type", r.type);
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
  res.end(r.body);
};

// ============================================================================
// Routes
// ============================================================================

type Route = (u: URL, req: http.IncomingMessage) => Promise<Res | null>;

const routes: Route[] = [
  // Shell
  async (u) => {
    if (u.pathname !== "/") return null;
    return html(shell(u.searchParams.get("stream") ?? "todo"));
  },

  // Island: state
  async (u) => {
    if (u.pathname !== "/island/state") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const chain = at === null ? await runtime.chain(stream) : await runtime.chainAt(stream, at);
    const total = (await runtime.chain(stream)).length;
    const state = fold(chain, reduce, initial);
    return html(stateHtml(stream, chain, state, at, total));
  },

  // Island: timeline
  async (u) => {
    if (u.pathname !== "/island/timeline") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const chain = await runtime.chain(stream);
    return html(timelineHtml(stream, chain, at));
  },

  // Island: time
  async (u) => {
    if (u.pathname !== "/island/time") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const total = (await runtime.chain(stream)).length;
    return html(timeHtml(stream, at, total));
  },

  // Island: verify
  async (u) => {
    if (u.pathname !== "/island/verify") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const chain = at === null ? await runtime.chain(stream) : await runtime.chainAt(stream, at);
    return html(verifyHtml(chain));
  },

  // Time travel (OOB swap all islands)
  async (u) => {
    if (u.pathname !== "/travel") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const fullChain = await runtime.chain(stream);
    const total = fullChain.length;
    const chain = at === null ? fullChain : fullChain.slice(0, at);
    const state = fold(chain, reduce, initial);
    const branches = await runtime.branches();
    const children = await runtime.children(stream);
    const current = await runtime.branch(stream);
    return html(oobAll(stream, chain, state, at, total, branches, children, current));
  },

  // Command (execute + trigger refresh)
  async (u, req) => {
    if (u.pathname !== "/cmd" || req.method !== "POST") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const body = await readBody(req);
    const cmd = toCmd(parseForm(body));
    if (!cmd) return { code: 400, body: "bad", type: "text/plain" };
    await runtime.execute(stream, cmd);
    return html("", { "HX-Trigger": "refresh" });
  },

  // Island: branches
  async (u) => {
    if (u.pathname !== "/island/branches") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const branches = await runtime.branches();
    const children = await runtime.children(stream);
    const current = await runtime.branch(stream);
    return html(branchSelectorHtml(stream, branches, children, current, at));
  },

  // Fork (create a new branch from a stream at a given point)
  async (u, req) => {
    if (u.pathname !== "/fork" || req.method !== "POST") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const body = await readBody(req);
    const form = parseForm(body);
    const at = parseInt(form.at ?? "0", 10);
    const name = form.name?.trim();
    if (!name) return { code: 400, body: "branch name required", type: "text/plain" };
    
    await runtime.fork(stream, at, name);
    
    // Redirect to the new branch
    const location = `/?stream=${encodeURIComponent(name)}`;
    return {
      code: 303,
      body: "",
      type: "text/plain",
      headers: { "Location": location, "HX-Redirect": location },
    };
  },
];

// ============================================================================
// Server
// ============================================================================

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", `http://${req.headers.host}`);
    for (const route of routes) {
      const r = await route(u, req);
      if (r) return send(res, r);
    }
    send(res, { code: 404, body: "not found", type: "text/plain" });
  } catch (e) {
    send(res, { code: 500, body: String(e), type: "text/plain" });
  }
}).listen(PORT, () => {
  console.log(`Receipt: http://localhost:${PORT}`);
});
