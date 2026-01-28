// ============================================================================
// Server - HTTP layer (thin routing)
// ============================================================================

import "dotenv/config";

import http from "node:http";
import { URL } from "node:url";
import path from "node:path";

import { jsonlStore, jsonBranchStore } from "./adapters/jsonl.js";
import { createRuntime } from "./core/runtime.js";

import type { TodoCmd, TodoEvent, TodoState } from "./modules/todo.js";
import { decide, reduce, initial } from "./modules/todo.js";
import type { TheoremEvent } from "./modules/theorem.js";
import { decide as decideTheorem, reduce as reduceTheorem, initial as initialTheorem } from "./modules/theorem.js";

import { llmText } from "./adapters/openai.js";
import { fold } from "./core/chain.js";
import { loadTheoremPrompts } from "./prompts/theorem.js";

import { shell, stateHtml, timelineHtml, timeHtml, verifyHtml, oobAll, lineageHtml } from "./views/html.js";
import {
  theoremShell,
  theoremFoldsHtml,
  theoremChatHtml,
  theoremSideHtml,
} from "./views/theorem.js";
import {
  THEOREM_TEAM,
  THEOREM_EXAMPLES,
  buildTheoremRuns,
  buildTheoremSteps,
  getLatestTheoremRunId,
  hashTheoremPrompts,
  runTheoremGuild,
  sliceTheoremChain,
  sliceTheoremChainByStep,
} from "./agents/theorem.js";

// ============================================================================
// Config
// ============================================================================

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

// ============================================================================
// Composition: Store -> Runtime
// ============================================================================

const store = jsonlStore<TodoEvent>(DATA_DIR);
const branchStore = jsonBranchStore(DATA_DIR);
const runtime = createRuntime(store, branchStore, decide, reduce, initial);

const theoremStore = jsonlStore<TheoremEvent>(DATA_DIR);
const theoremRuntime = createRuntime(
  theoremStore,
  branchStore,
  decideTheorem,
  reduceTheorem,
  initialTheorem
);

// ============================================================================
// Theorem prompts + team
// ============================================================================

const THEOREM_PROMPTS = loadTheoremPrompts(DATA_DIR);
const THEOREM_PROMPTS_HASH = hashTheoremPrompts(THEOREM_PROMPTS);
const THEOREM_PROMPTS_PATH = process.env.THEOREM_PROMPTS_PATH ?? "prompts/theorem.prompts.json";
const THEOREM_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

// ============================================================================
// Helpers
// ============================================================================

const parseAt = (s: string | null): number | null => {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
};

const parseDepth = (s: string | null): number | null => {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
};

const clampDepth = (total: number, requested: number | null): number => {
  if (total === 0) return 0;
  const base = requested ?? Math.min(30, total);
  return Math.max(1, Math.min(base, total));
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

// ============================================================================
// SSE
// ============================================================================

const theoremSubscribers = new Map<string, Set<http.ServerResponse>>();

const broadcastTheoremRefresh = (stream: string) => {
  const subs = theoremSubscribers.get(stream);
  if (!subs) return;
  const stamp = Date.now();
  for (const res of subs) {
    if (res.writableEnded) {
      subs.delete(res);
      continue;
    }
    try {
      res.write(`event: theorem-refresh\ndata: ${stamp}\n\n`);
    } catch {
      subs.delete(res);
    }
  }
};

// ============================================================================
// Routes
// ============================================================================

type Route = (u: URL, req: http.IncomingMessage) => Promise<Res | null>;

const routes: Route[] = [
  // Todo shell
  async (u) => {
    if (u.pathname !== "/") return null;
    return html(shell(u.searchParams.get("stream") ?? "todo"));
  },

  // Todo: state island
  async (u) => {
    if (u.pathname !== "/island/state") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const fullChain = await runtime.chain(stream);
    const chain = at === null ? fullChain : fullChain.slice(0, at);
    const total = fullChain.length;
    const state = at === null ? await runtime.state(stream) : await runtime.stateAt(stream, at);
    return html(stateHtml(stream, chain, state, at, total));
  },

  // Todo: timeline island
  async (u) => {
    if (u.pathname !== "/island/timeline") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const requestedDepth = parseDepth(u.searchParams.get("depth"));
    const chain = await runtime.chain(stream);
    const total = chain.length;
    const depth = clampDepth(total, requestedDepth);
    const slice = depth === total ? chain : chain.slice(total - depth);
    return html(timelineHtml(stream, slice, at, depth, total));
  },

  // Todo: time island
  async (u) => {
    if (u.pathname !== "/island/time") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const total = (await runtime.chain(stream)).length;
    return html(timeHtml(stream, at, total));
  },

  // Todo: verify island
  async (u) => {
    if (u.pathname !== "/island/verify") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const chain = at === null ? await runtime.chain(stream) : await runtime.chainAt(stream, at);
    return html(verifyHtml(chain));
  },

  // Todo: lineage island
  async (u) => {
    if (u.pathname !== "/island/lineage") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const chain = await runtime.chain(stream);
    const total = chain.length;
    const selectedAt = at === null ? total : Math.min(Math.max(0, at), total);
    const branches = await runtime.branches();
    const current = await runtime.branch(stream);
    return html(lineageHtml(stream, branches, current, selectedAt, total));
  },

  // Todo: travel (OOB)
  async (u) => {
    if (u.pathname !== "/travel") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const fullChain = await runtime.chain(stream);
    const total = fullChain.length;
    const chain = at === null ? fullChain : fullChain.slice(0, at);
    const state = at === null ? await runtime.state(stream) : await runtime.stateAt(stream, at);
    const branches = await runtime.branches();
    const current = await runtime.branch(stream);
    return html(oobAll(stream, chain, state, at, total, branches, current));
  },

  // Todo: command
  async (u, req) => {
    if (u.pathname !== "/cmd" || req.method !== "POST") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const body = await readBody(req);
    const cmd = toCmd(parseForm(body));
    if (!cmd) return { code: 400, body: "bad", type: "text/plain" };
    await runtime.execute(stream, cmd);
    return html("", { "HX-Trigger": "refresh" });
  },

  // Theorem shell
  async (u) => {
    if (u.pathname !== "/theorem") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const chain = await theoremRuntime.chain(stream);
    const latest = getLatestTheoremRunId(chain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    return html(theoremShell(stream, THEOREM_EXAMPLES, activeRun, wantsEmpty ? null : at));
  },

  // Theorem folds
  async (u) => {
    if (u.pathname !== "/theorem/island/folds") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const chain = await theoremRuntime.chain(stream);
    const latest = getLatestTheoremRunId(chain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    const runs = buildTheoremRuns(chain);
    return html(theoremFoldsHtml(stream, runs, activeRun, wantsEmpty ? null : at));
  },

  // Theorem chat
  async (u) => {
    if (u.pathname !== "/theorem/island/chat") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const chain = await theoremRuntime.chain(stream);
    const latest = getLatestTheoremRunId(chain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    const slice = wantsEmpty ? [] : sliceTheoremChain(chain, activeRun);
    const viewChain = at === null ? slice : sliceTheoremChainByStep(slice, at);
    return html(theoremChatHtml(viewChain));
  },

  // Theorem side panel
  async (u) => {
    if (u.pathname !== "/theorem/island/side") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const chain = await theoremRuntime.chain(stream);
    const latest = getLatestTheoremRunId(chain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    const slice = wantsEmpty ? [] : sliceTheoremChain(chain, activeRun);
    const viewChain = at === null ? slice : sliceTheoremChainByStep(slice, at);
    const state = fold(viewChain, reduceTheorem, initialTheorem);
    const team = THEOREM_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));
    const steps = buildTheoremSteps(slice);
    return html(theoremSideHtml(state, viewChain, wantsEmpty ? null : at, steps.length, stream, activeRun, team));
  },

  // Run theorem guild
  async (u, req) => {
    if (u.pathname !== "/theorem/run" || req.method !== "POST") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const body = await readBody(req);
    const form = parseForm(body);
    const problem = form.problem?.trim();
    if (!problem) return { code: 400, body: "problem required", type: "text/plain" };
    const roundsRaw = Number(form.rounds ?? "2");
    const rounds = Number.isFinite(roundsRaw) ? Math.max(1, Math.min(5, roundsRaw)) : 2;
    const depthRaw = Number(form.depth ?? "2");
    const maxDepth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(4, depthRaw)) : 2;
    const memoryRaw = Number(form.memory ?? "60");
    const memoryWindow = Number.isFinite(memoryRaw) ? Math.max(5, Math.min(200, memoryRaw)) : 60;
    const branchRaw = Number(form.branch ?? "2");
    const branchThreshold = Number.isFinite(branchRaw) ? Math.max(1, Math.min(6, branchRaw)) : 2;

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const apiReady = Boolean(process.env.OPENAI_API_KEY);
    const apiNote = apiReady ? undefined : "OPENAI_API_KEY not set";
    void runTheoremGuild({
      stream,
      runId,
      problem,
      config: { rounds, maxDepth, memoryWindow, branchThreshold },
      runtime: theoremRuntime,
      prompts: THEOREM_PROMPTS,
      llmText,
      model: THEOREM_MODEL,
      promptHash: THEOREM_PROMPTS_HASH,
      promptPath: THEOREM_PROMPTS_PATH,
      apiReady,
      apiNote,
      broadcast: () => broadcastTheoremRefresh(stream),
    });

    return html("", { "HX-Redirect": `/theorem?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(runId)}` });
  },
];

// ============================================================================
// Server
// ============================================================================

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const u = new URL(req.url, `http://${req.headers.host}`);

  // SSE stream
  if (u.pathname === "/theorem/stream") {
    const stream = u.searchParams.get("stream") ?? "theorem";
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    });
    res.write("event: theorem-refresh\ndata: init\n\n");
    if (!theoremSubscribers.has(stream)) {
      theoremSubscribers.set(stream, new Set());
    }
    theoremSubscribers.get(stream)!.add(res);
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write("event: ping\ndata: keepalive\n\n");
    }, 15000);
    req.on("close", () => {
      clearInterval(ping);
      theoremSubscribers.get(stream)?.delete(res);
    });
    return;
  }

  try {
    for (const route of routes) {
      const result = await route(u, req);
      if (result) {
        res.statusCode = result.code;
        res.setHeader("Content-Type", result.type);
        res.setHeader("Cache-Control", "no-store");
        for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
        res.end(result.body);
        return;
      }
    }
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end("Server error");
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Receipt server listening on http://localhost:${PORT}`);
});
