// ============================================================================
// Server - HTTP layer (thin routing)
// ============================================================================

import "dotenv/config";

import http from "node:http";
import { URL } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { jsonlStore, jsonBranchStore } from "./adapters/jsonl.js";
import { jsonlIndexedStore } from "./adapters/jsonl-indexed.js";
import { createRuntime } from "./core/runtime.js";

import type { TodoCmd, TodoEvent } from "./modules/todo.js";
import { decide, reduce, initial } from "./modules/todo.js";
import type { InspectorEvent, InspectorMode } from "./modules/inspector.js";
import { decide as decideInspector, reduce as reduceInspector, initial as initialInspector } from "./modules/inspector.js";
import type { TheoremEvent } from "./modules/theorem.js";
import { decide as decideTheorem, reduce as reduceTheorem, initial as initialTheorem } from "./modules/theorem.js";
import type { WriterEvent } from "./modules/writer.js";
import { decide as decideWriter, reduce as reduceWriter, initial as initialWriter } from "./modules/writer.js";

import { llmText } from "./adapters/openai.js";
import { fold } from "./core/chain.js";
import { loadTheoremPrompts, hashTheoremPrompts } from "./prompts/theorem.js";
import { loadWriterPrompts, hashWriterPrompts } from "./prompts/writer.js";
import { loadInspectorPrompts, hashInspectorPrompts } from "./prompts/inspector.js";

import { shell, stateHtml, timelineHtml, timeHtml, verifyHtml, oobAll, branchSelectorHtml } from "./views/html.js";
import {
  theoremShell,
  theoremFoldsHtml,
  theoremTravelHtml,
  theoremChatHtml,
  theoremSideHtml,
} from "./views/theorem.js";
import { writerShell, writerFoldsHtml, writerTravelHtml, writerChatHtml, writerSideHtml } from "./views/writer.js";
import {
  receiptShell,
  receiptFoldsHtml,
  receiptChatHtml,
  receiptSideHtml,
  type ReceiptChatItem,
  type ReceiptInspectorSnapshot,
} from "./views/receipt.js";
import { runReceiptInspector } from "./agents/inspector.js";
import { INSPECTOR_TEAM } from "./agents/inspector.constants.js";
import {
  listReceiptFiles,
  readReceiptFile,
  sliceReceiptRecords,
  buildReceiptContext,
  buildReceiptTimeline,
} from "./adapters/receipt-tools.js";
import {
  THEOREM_TEAM,
  THEOREM_EXAMPLES,
  buildTheoremRuns,
  buildTheoremSteps,
  getLatestTheoremRunId,
  normalizeTheoremConfig,
  parseTheoremConfig,
  runTheoremGuild,
  sliceTheoremChainByStep,
} from "./agents/theorem.js";
import { theoremRunStream } from "./agents/theorem.streams.js";
import { writerRunStream } from "./agents/writer.streams.js";
import {
  WRITER_TEAM,
  WRITER_EXAMPLES,
  runWriterGuild,
  normalizeWriterConfig,
  parseWriterConfig,
} from "./agents/writer.js";
import {
  buildWriterRuns,
  buildWriterSteps,
  getLatestWriterRunId,
  sliceWriterChainByStep,
} from "./agents/writer.runs.js";

// ============================================================================
// Config
// ============================================================================

const PORT = Number(process.env.PORT ?? 8787);
// All run/stream files and branch metadata receipts live here.
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
// Theorem prompts + team
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

const parseOrder = (s: string | null): "asc" | "desc" => (s === "asc" ? "asc" : "desc");

const parseLimit = (s: string | null): number => {
  if (!s) return 200;
  const n = parseInt(s, 10);
  if (Number.isNaN(n)) return 200;
  return Math.max(10, Math.min(n, 5000));
};

const parseInspectorDepth = (s: string | null): number => {
  const n = parseDepth(s);
  if (n === null) return 2;
  return Math.max(1, Math.min(n, 3));
};

const parseBranch = (s: string | null): string | null => {
  if (!s) return null;
  const trimmed = s.trim();
  return trimmed.length ? trimmed : null;
};

const makeEventId = (stream: string): string =>
  `${stream}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

const clampDepth = (total: number, requested: number | null): number => {
  if (total === 0) return 0;
  const base = requested ?? Math.min(30, total);
  return Math.max(1, Math.min(base, total));
};

const formatInspectorAgentName = (agentName?: string, mode?: InspectorMode): string => {
  if (agentName?.trim()) return agentName.trim();
  if (mode === "qa") return "Q&A";
  if (mode === "improve") return "Improver";
  if (mode === "timeline") return "Chronologist";
  if (mode === "analyze") return "Analyst";
  return "Inspector";
};

const mapInspectorAgentId = (agentId?: string, mode?: InspectorMode, runId?: string): string => {
  if (agentId) return agentId;
  if (mode === "analyze") return "analyst";
  if (mode === "improve") return "improver";
  if (mode === "timeline") return "chronologist";
  if (mode === "qa") return "respondent";
  return runId ?? "inspector";
};

const INSPECTOR_KIND = new Map(INSPECTOR_TEAM.map((agent) => [agent.id, agent.kind]));

const loadTheoremRunChain = async (
  baseStream: string,
  runId: string,
  branchStream?: string | null
) => {
  const runStream = theoremRunStream(baseStream, runId);
  const branchPrefix = `${runStream}/branches/`;
  const canUseBranch = branchStream && branchStream.startsWith(branchPrefix);

  if (canUseBranch) {
    const branchChain = await theoremRuntime.chain(branchStream);
    if (branchChain.length > 0) {
      return { chain: branchChain, chainStream: branchStream, isBranch: true };
    }
  }

  const runChain = await theoremRuntime.chain(runStream);
  if (runChain.length > 0) {
    return { chain: runChain, chainStream: runStream, isBranch: false };
  }

  return { chain: [], chainStream: runStream, isBranch: false };
};

const loadWriterRunChain = async (
  baseStream: string,
  runId: string,
  branchStream?: string | null
) => {
  const runStream = writerRunStream(baseStream, runId);
  const branchPrefix = `${runStream}/branches/`;
  const canUseBranch = branchStream && branchStream.startsWith(branchPrefix);

  if (canUseBranch) {
    const branchChain = await writerRuntime.chain(branchStream);
    if (branchChain.length > 0) {
      return { chain: branchChain, chainStream: branchStream, isBranch: true };
    }
  }

  const runChain = await writerRuntime.chain(runStream);
  if (runChain.length > 0) {
    return { chain: runChain, chainStream: runStream, isBranch: false };
  }

  return { chain: [], chainStream: runStream, isBranch: false };
};

const mergeTimelineChains = <T extends { readonly id: string; readonly ts: number; readonly stream: string }>(
  chains: ReadonlyArray<ReadonlyArray<T>>
) => {
  const merged = chains.flatMap((chain) => chain);
  merged.sort((a, b) => a.ts - b.ts || a.stream.localeCompare(b.stream) || a.id.localeCompare(b.id));
  return merged;
};

const loadTheoremDescendantChains = async (rootStream: string) => {
  const out: Array<{ readonly name: string; readonly forkAt: number; readonly chain: Awaited<ReturnType<typeof theoremRuntime.chain>> }> = [];
  const queue: string[] = [rootStream];

  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent) break;
    const children = await theoremRuntime.children(parent);
    for (const child of children) {
      const chain = await theoremRuntime.chain(child.name);
      out.push({
        name: child.name,
        forkAt: Math.max(0, child.forkAt ?? 0),
        chain,
      });
      queue.push(child.name);
    }
  }

  return out;
};

const buildTheoremDisplayChain = async (
  baseStream: string,
  runId: string
): Promise<Awaited<ReturnType<typeof theoremRuntime.chain>>> => {
  const runStream = theoremRunStream(baseStream, runId);
  const runChain = await theoremRuntime.chain(runStream);
  const descendants = await loadTheoremDescendantChains(runStream);
  const branchDeltas = descendants.map((desc) => desc.chain.slice(desc.forkAt));
  return mergeTimelineChains([runChain, ...branchDeltas]);
};

const buildTheoremRunReceiptCount = async (
  baseStream: string,
  runId: string,
  runChainLength: number,
  fallback: number
): Promise<number> => {
  const runStream = theoremRunStream(baseStream, runId);
  const descendants = await loadTheoremDescendantChains(runStream);
  const deltaCount = descendants.reduce((sum, desc) => sum + desc.chain.slice(desc.forkAt).length, 0);
  return Math.max(fallback, runChainLength + deltaCount);
};

const loadWriterDescendantChains = async (rootStream: string) => {
  const out: Array<{ readonly name: string; readonly forkAt: number; readonly chain: Awaited<ReturnType<typeof writerRuntime.chain>> }> = [];
  const queue: string[] = [rootStream];

  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent) break;
    const children = await writerRuntime.children(parent);
    for (const child of children) {
      const chain = await writerRuntime.chain(child.name);
      out.push({
        name: child.name,
        forkAt: Math.max(0, child.forkAt ?? 0),
        chain,
      });
      queue.push(child.name);
    }
  }

  return out;
};

const isResumeBranch = (branchName: string): boolean => {
  const segment = branchName.split("/").pop() ?? "";
  return segment.startsWith("resume_");
};

const buildWriterRunReceiptCount = async (
  baseStream: string,
  runId: string,
  runChainLength: number,
  fallback: number
): Promise<number> => {
  const runStream = writerRunStream(baseStream, runId);
  const descendants = await loadWriterDescendantChains(runStream);
  const resumeDeltaCount = descendants
    .filter((desc) => isResumeBranch(desc.name))
    .reduce((sum, desc) => sum + desc.chain.slice(desc.forkAt).length, 0);
  return Math.max(fallback, runChainLength + resumeDeltaCount);
};

const buildInspectorSnapshot = (
  chain: Awaited<ReturnType<typeof inspectorRuntime.chain>>,
  file: string
): ReceiptInspectorSnapshot => {
  let latestContext: (InspectorEvent & { type: "context.set" }) | null = null;
  for (const r of chain) {
    const e = r.body;
    if (e.type === "context.set" && e.source.kind === "file" && e.source.name === file) {
      latestContext = e;
    }
  }
  if (!latestContext) {
    return { status: "idle" };
  }

  const runId = latestContext.runId;
  const groupId = latestContext.groupId ?? latestContext.runId;
  const snapshot: {
    status: ReceiptInspectorSnapshot["status"];
    runId?: string;
    context?: ReceiptInspectorSnapshot["context"];
    question?: string;
    mode?: string;
    analysis?: string;
    note?: string;
    timeline?: ReceiptInspectorSnapshot["timeline"];
    tools?: ReceiptInspectorSnapshot["tools"];
    agents?: ReceiptInspectorSnapshot["agents"];
  } = {
    status: "idle",
    runId,
    context: {
      name: latestContext.source.name,
      total: latestContext.total,
      shown: latestContext.shown,
      order: latestContext.order,
      limit: latestContext.limit,
    },
  };

  const tools: Array<{ name: string; summary?: string; durationMs?: number; error?: string }> = [];
  const agentStates = new Map<string, { id: string; name: string; status?: ReceiptInspectorSnapshot["status"]; note?: string }>();

  for (const r of chain) {
    const e = r.body;
    if (!("runId" in e)) continue;
    const eventGroupId = e.groupId ?? e.runId;
    if (eventGroupId !== groupId) continue;
    const mode = "mode" in e ? e.mode : undefined;
    const agentId = mapInspectorAgentId(e.agentId, mode, e.runId);
    const agentName = formatInspectorAgentName(e.agentName, mode);
    const agent = agentStates.get(agentId) ?? { id: agentId, name: agentName };
    switch (e.type) {
      case "question.set":
        snapshot.question ??= e.question;
        snapshot.mode ??= e.mode;
        break;
      case "analysis.set":
        snapshot.analysis ??= e.content;
        break;
      case "run.status":
        agent.status = e.status;
        if (e.note) agent.note = e.note;
        break;
      case "timeline.set":
        snapshot.timeline = { depth: e.depth, buckets: e.buckets.map((b) => ({ label: b.label, count: b.count })) };
        break;
      case "tool.called":
        tools.push({
          name: e.tool,
          summary: e.summary,
          durationMs: e.durationMs,
          error: e.error,
        });
        break;
      default:
        break;
    }
    agentStates.set(agentId, agent);
  }

  if (tools.length) snapshot.tools = tools;
  if (agentStates.size) {
    const statuses = [...agentStates.values()].map((a) => a.status).filter(Boolean) as Array<ReceiptInspectorSnapshot["status"]>;
    if (statuses.includes("running")) snapshot.status = "running";
    else if (statuses.includes("failed")) snapshot.status = "failed";
    else if (statuses.includes("completed")) snapshot.status = "completed";
  }
  if (snapshot.status === "idle" && snapshot.analysis) snapshot.status = "completed";
  if (agentStates.size) {
    snapshot.agents = INSPECTOR_TEAM.map((agent) => agentStates.get(agent.id) ?? { id: agent.id, name: agent.name })
      .concat([...agentStates.values()].filter((agent) => !INSPECTOR_TEAM.some((t) => t.id === agent.id)));
  }
  if (snapshot.status === "failed" && !snapshot.note) {
    const failed = [...agentStates.values()].find((agent) => agent.status === "failed" && agent.note);
    if (failed?.note) snapshot.note = failed.note;
  }
  return snapshot;
};

const buildReceiptChatItems = (
  chain: Awaited<ReturnType<typeof inspectorRuntime.chain>>,
  file: string,
  maxRuns = 6
): ReceiptChatItem[] => {
  type AgentState = {
    agentId: string;
    agentName: string;
    mode?: InspectorMode;
    analysis?: string;
    status?: "running" | "failed" | "completed";
    note?: string;
    kind?: ReceiptChatItem["kind"];
    updatedAt: number;
  };

  type GroupState = {
    groupId: string;
    file?: string;
    question?: string;
    createdAt: number;
    updatedAt: number;
    agents: Map<string, AgentState>;
  };

  const groups = new Map<string, GroupState>();

  for (const r of chain) {
    const e = r.body;
    if (!("runId" in e)) continue;
    const groupId = e.groupId ?? e.runId;
    const ts = typeof r.ts === "number" ? r.ts : Date.now();
    const group = groups.get(groupId) ?? {
      groupId,
      createdAt: ts,
      updatedAt: ts,
      agents: new Map<string, AgentState>(),
    };
    group.createdAt = Math.min(group.createdAt, ts);
    group.updatedAt = Math.max(group.updatedAt, ts);

    if (e.type === "context.set") group.file = e.source.name;
    if (e.type === "question.set") group.question = e.question;

    const mode = "mode" in e ? e.mode : undefined;
    const agentId = mapInspectorAgentId(e.agentId, mode, e.runId);
    const agentName = formatInspectorAgentName(e.agentName, mode);
    const agent = group.agents.get(agentId) ?? {
      agentId,
      agentName,
      mode,
      kind: INSPECTOR_KIND.get(agentId) ?? (mode as ReceiptChatItem["kind"]),
      updatedAt: ts,
    };
    agent.updatedAt = Math.max(agent.updatedAt, ts);
    if (e.type === "analysis.set") agent.analysis = e.content;
    if (e.type === "run.status") {
      agent.status = e.status;
      if (e.note) agent.note = e.note;
    }
    if (e.type === "question.set") agent.mode = e.mode;

    group.agents.set(agentId, agent);
    groups.set(groupId, group);
  }

  const filtered = [...groups.values()].filter((group) => group.file === file);
  const recent = filtered.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxRuns);
  const items: ReceiptChatItem[] = [];

  for (const group of recent) {
    if (group.question) {
      items.push({
        id: `${group.groupId}-q`,
        role: "user",
        label: "You",
        content: group.question,
        groupId: group.groupId,
      });
    }

    const orderedAgents = INSPECTOR_TEAM
      .map((agent) => group.agents.get(agent.id))
      .filter((agent): agent is AgentState => Boolean(agent));
    const extraAgents = [...group.agents.values()].filter(
      (agent) => !INSPECTOR_TEAM.some((team) => team.id === agent.agentId)
    );
    const allAgents = [...orderedAgents, ...extraAgents];

    for (const agent of allAgents) {
      const response = agent.analysis
        ?? (agent.status === "running" ? "Inspector is working..." : agent.note ?? "No response yet.");
      items.push({
        id: `${group.groupId}-${agent.agentId}`,
        role: "agent",
        label: agent.agentName,
        content: response,
        status: agent.status,
        kind: agent.kind,
        groupId: group.groupId,
      });
    }
  }

  return items;
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
const writerSubscribers = new Map<string, Set<http.ServerResponse>>();
const receiptSubscribers = new Set<http.ServerResponse>();

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

const broadcastWriterRefresh = (stream: string) => {
  const subs = writerSubscribers.get(stream);
  if (!subs) return;
  const stamp = Date.now();
  for (const res of subs) {
    if (res.writableEnded) {
      subs.delete(res);
      continue;
    }
    try {
      res.write(`event: writer-refresh\ndata: ${stamp}\n\n`);
    } catch {
      subs.delete(res);
    }
  }
};

const broadcastReceiptRefresh = () => {
  const stamp = Date.now();
  for (const res of receiptSubscribers) {
    if (res.writableEnded) {
      receiptSubscribers.delete(res);
      continue;
    }
    try {
      res.write(`event: receipt-refresh\ndata: ${stamp}\n\n`);
    } catch {
      receiptSubscribers.delete(res);
    }
  }
};

// ============================================================================
// Routes
// ============================================================================

type Route = (u: URL, req: http.IncomingMessage) => Promise<Res | null>;

const routes: Route[] = [
  // Receipt browser
  async (u) => {
    if (u.pathname !== "/receipt") return null;
    const file = u.searchParams.get("file") ?? "";
    const order = parseOrder(u.searchParams.get("order"));
    const limit = parseLimit(u.searchParams.get("limit"));
    const depth = parseInspectorDepth(u.searchParams.get("depth"));
    const files = await listReceiptFiles(DATA_DIR);
    const selected = files.find((f) => f.name === file)?.name ?? files[0]?.name;
    return html(receiptShell({ selected, limit, order, depth }));
  },
  // Receipt: folds island
  async (u) => {
    if (u.pathname !== "/receipt/island/folds") return null;
    const selected = u.searchParams.get("selected") ?? "";
    const order = parseOrder(u.searchParams.get("order"));
    const limit = parseLimit(u.searchParams.get("limit"));
    const depth = parseInspectorDepth(u.searchParams.get("depth"));
    const files = await listReceiptFiles(DATA_DIR);
    return html(receiptFoldsHtml(files, selected, order, limit, depth));
  },
  // Receipt: chat island
  async (u) => {
    if (u.pathname !== "/receipt/island/chat") return null;
    const file = u.searchParams.get("file") ?? "";
    if (!file) return html(receiptChatHtml({ selected: undefined, items: [] }));
    const inspectorChain = await inspectorRuntime.chain("inspector");
    const items = buildReceiptChatItems(inspectorChain, file);
    return html(receiptChatHtml({ selected: file, items }));
  },
  // Receipt: side island
  async (u) => {
    if (u.pathname !== "/receipt/island/side") return null;
    const file = u.searchParams.get("file") ?? "";
    const order = parseOrder(u.searchParams.get("order"));
    const limit = parseLimit(u.searchParams.get("limit"));
    const depth = parseInspectorDepth(u.searchParams.get("depth"));
    if (!file) {
      return html(receiptSideHtml({
        selected: undefined,
        order,
        limit,
        depth,
        snapshot: { status: "idle" },
      }));
    }
    const files = await listReceiptFiles(DATA_DIR);
    const selected = files.find((f) => f.name === file);
    if (!selected) {
      return html(receiptSideHtml({
        selected: file,
        order,
        limit,
        depth,
        snapshot: { status: "failed", note: "File not found." },
      }));
    }
    try {
      const records = await readReceiptFile(DATA_DIR, selected.name);
      const slice = sliceReceiptRecords(records, order, limit);
      const inspectorChain = await inspectorRuntime.chain("inspector");
      const snapshot = buildInspectorSnapshot(inspectorChain, selected.name);
      const timeline = buildReceiptTimeline(records, depth);
      const context = snapshot.context ?? {
        name: selected.name,
        total: records.length,
        shown: slice.length,
        order,
        limit,
      };
      const timelineDepthMatches = snapshot.timeline?.depth === depth;
      const resolvedTimeline = timelineDepthMatches
        ? snapshot.timeline
        : { depth, buckets: timeline };
      return html(receiptSideHtml({
        selected: selected.name,
        order,
        limit,
        depth,
        snapshot: {
          ...snapshot,
          context,
          timeline: resolvedTimeline,
        },
        fileMeta: { size: selected.size, mtime: selected.mtime },
      }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return html(receiptSideHtml({
        selected: selected.name,
        order,
        limit,
        depth,
        snapshot: { status: "failed", note: error },
      }));
    }
  },
  // Receipt: run inspector
  async (u, req) => {
    if (u.pathname !== "/receipt/inspect" || req.method !== "POST") return null;
    const body = await readBody(req);
    const form = parseForm(body);
    const file = (form.file ?? "").trim();
    const order = parseOrder(form.order ?? null);
    const limit = parseLimit(form.limit ?? null);
    const depth = parseInspectorDepth(form.depth ?? null);
    const question = form.question?.trim() || "Analyze this run.";

    if (!file) return { code: 400, body: "file required", type: "text/plain" };
    const files = await listReceiptFiles(DATA_DIR);
    const selected = files.find((f) => f.name === file);
    if (!selected) return { code: 404, body: "file not found", type: "text/plain" };

    const groupId = `inspect_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const apiReady = Boolean(process.env.OPENAI_API_KEY);
    const apiNote = apiReady ? undefined : "OPENAI_API_KEY not set";

    for (const agent of INSPECTOR_TEAM) {
      const runId = `${groupId}_${agent.id}`;
      void runReceiptInspector({
        stream: "inspector",
        runId,
        groupId,
        agentId: agent.id,
        agentName: agent.name,
        source: { kind: "file", name: selected.name },
        dataDir: DATA_DIR,
        order,
        limit,
        question,
        mode: agent.mode,
        depth,
        runtime: inspectorRuntime,
        prompts: INSPECTOR_PROMPTS,
        llmText,
        model: INSPECTOR_MODEL,
        promptHash: INSPECTOR_PROMPTS_HASH,
        promptPath: INSPECTOR_PROMPTS_PATH,
        apiReady,
        apiNote,
        tools: {
          readFile: readReceiptFile,
          sliceRecords: sliceReceiptRecords,
          buildContext: buildReceiptContext,
          buildTimeline: buildReceiptTimeline,
        },
        broadcast: broadcastReceiptRefresh,
      });
    }

    return html("", { "HX-Trigger": "receipt-refresh" });
  },
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
    return html(timelineHtml(stream, slice, at));
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

  // Todo: branches island
  async (u) => {
    if (u.pathname !== "/island/branches") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const at = parseAt(u.searchParams.get("at"));
    const branches = await runtime.branches();
    const children = await runtime.children(stream);
    const current = await runtime.branch(stream);
    return html(branchSelectorHtml(stream, branches, children, current, at));
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
    const children = await runtime.children(stream);
    const current = await runtime.branch(stream);
    return html(oobAll(stream, chain, state, at, total, branches, children, current));
  },

  // Todo: command
  async (u, req) => {
    if (u.pathname !== "/cmd" || req.method !== "POST") return null;
    const stream = u.searchParams.get("stream") ?? "todo";
    const body = await readBody(req);
    const cmd = toCmd(parseForm(body));
    if (!cmd) return { code: 400, body: "bad", type: "text/plain" };
    await runtime.execute(stream, cmd);
    broadcastReceiptRefresh();
    return html("", { "HX-Trigger": "refresh" });
  },

  // Theorem shell
  async (u) => {
    if (u.pathname !== "/theorem") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const chain = await theoremRuntime.chain(stream);
    const latest = getLatestTheoremRunId(chain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    return html(theoremShell(stream, THEOREM_EXAMPLES, activeRun, wantsEmpty ? null : at, branchParam ?? undefined));
  },

  // Theorem folds
  async (u) => {
    if (u.pathname !== "/theorem/island/folds") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const indexChain = await theoremRuntime.chain(stream);
    const latest = getLatestTheoremRunId(indexChain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    const runs = buildTheoremRuns(indexChain);
    const runsWithCounts = await Promise.all(runs.map(async (run) => {
      const runStream = theoremRunStream(stream, run.runId);
      const runChain = await theoremRuntime.chain(runStream);
      const count = await buildTheoremRunReceiptCount(stream, run.runId, runChain.length, run.count);
      const startedAt = runChain.length > 0 ? runChain[0]?.ts : run.startedAt;
      return { ...run, count, startedAt };
    }));
    return html(theoremFoldsHtml(stream, runsWithCounts, activeRun, wantsEmpty ? null : at));
  },

  // Theorem time travel
  async (u) => {
    if (u.pathname !== "/theorem/island/travel") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const indexChain = await theoremRuntime.chain(stream);
    const latest = getLatestTheoremRunId(indexChain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    if (!activeRun) {
      return html(theoremTravelHtml({ stream, at: null, total: 0 }));
    }
    const runData = await loadTheoremRunChain(stream, activeRun, branchParam);
    const displayChain = !runData.isBranch
      ? await buildTheoremDisplayChain(stream, activeRun)
      : runData.chain;
    const steps = buildTheoremSteps(displayChain);
    const totalSteps = Math.max(steps.length, displayChain.length);
    return html(theoremTravelHtml({
      stream,
      runId: activeRun,
      branch: runData.isBranch ? runData.chainStream : undefined,
      at: wantsEmpty ? null : at,
      total: totalSteps,
    }));
  },

  // Theorem travel scrub (OOB islands + URL push)
  async (u) => {
    if (u.pathname !== "/theorem/travel") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const at = parseAt(u.searchParams.get("at"));
    const indexChain = await theoremRuntime.chain(stream);
    const latest = getLatestTheoremRunId(indexChain);
    const activeRun = runParam?.trim() ? runParam : (latest ?? undefined);
    if (!activeRun) {
      return html("", { "HX-Push-Url": `/theorem?stream=${encodeURIComponent(stream)}&run=new` });
    }

    const runs = buildTheoremRuns(indexChain);
    const runsWithCounts = await Promise.all(runs.map(async (run) => {
      const runStream = theoremRunStream(stream, run.runId);
      const runChain = await theoremRuntime.chain(runStream);
      const count = await buildTheoremRunReceiptCount(stream, run.runId, runChain.length, run.count);
      const startedAt = runChain.length > 0 ? runChain[0]?.ts : run.startedAt;
      return { ...run, count, startedAt };
    }));

    const runData = await loadTheoremRunChain(stream, activeRun, branchParam);
    const displayChain = !runData.isBranch
      ? await buildTheoremDisplayChain(stream, activeRun)
      : runData.chain;
    const steps = buildTheoremSteps(displayChain);
    const totalSteps = Math.max(steps.length, displayChain.length);
    const normalizedAt = at === null ? null : Math.max(0, Math.min(at, totalSteps));
    const viewAt = normalizedAt !== null && normalizedAt < totalSteps ? normalizedAt : null;
    const viewChain = viewAt === null ? displayChain : sliceTheoremChainByStep(displayChain, viewAt);
    const stateFromView = fold(viewChain, reduceTheorem, initialTheorem);
    const stateResolved =
      runData.isBranch
        ? await (async () => {
            const runStream = theoremRunStream(stream, activeRun);
            const mainChain = await theoremRuntime.chain(runStream);
            const mainState = fold(mainChain, reduceTheorem, initialTheorem);
            return { ...stateFromView, branches: mainState.branches };
          })()
        : stateFromView;
    const team = THEOREM_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));
    const activeBranch = runData.isBranch ? runData.chainStream : undefined;

    const urlParams = new URLSearchParams({ stream, run: activeRun });
    if (activeBranch) urlParams.set("branch", activeBranch);
    if (viewAt !== null) urlParams.set("at", String(viewAt));
    const nextUrl = `/theorem?${urlParams.toString()}`;
    const atParam = String(viewAt ?? "");
    const branchParamForQuery = activeBranch ?? "";

    return html(`
<div id="tg-folds" class="folds" hx-swap-oob="outerHTML"
     hx-get="/theorem/island/folds?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:800ms" hx-swap="innerHTML">${theoremFoldsHtml(stream, runsWithCounts, activeRun, viewAt)}</div>
<div id="tg-travel" class="travel-island" hx-swap-oob="outerHTML"
     hx-get="/theorem/island/travel?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:700ms" hx-swap="innerHTML">${theoremTravelHtml({ stream, runId: activeRun, branch: activeBranch, at: viewAt, total: totalSteps })}</div>
<div id="tg-chat" class="run-area" hx-swap-oob="outerHTML"
     hx-get="/theorem/island/chat?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:1200ms" hx-swap="innerHTML">${theoremChatHtml(viewChain)}</div>
<div id="tg-side" class="activity" hx-swap-oob="outerHTML"
     hx-get="/theorem/island/side?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:800ms" hx-swap="innerHTML">${theoremSideHtml(
      stateResolved,
      viewChain,
      viewAt,
      totalSteps,
      stream,
      activeRun,
      team,
      runData.chainStream,
      activeBranch,
      viewChain
    )}</div>`, { "HX-Push-Url": nextUrl });
  },

  // Theorem chat
  async (u) => {
    if (u.pathname !== "/theorem/island/chat") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const indexChain = await theoremRuntime.chain(stream);
    const latest = getLatestTheoremRunId(indexChain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    const runData = (!wantsEmpty && activeRun)
      ? await loadTheoremRunChain(stream, activeRun, branchParam)
      : { chain: [], chainStream: stream, isBranch: false };
    const displayChain = (!wantsEmpty && activeRun && !runData.isBranch)
      ? await buildTheoremDisplayChain(stream, activeRun)
      : runData.chain;
    const viewChain = at === null ? displayChain : sliceTheoremChainByStep(displayChain, at);
    return html(theoremChatHtml(viewChain));
  },

  // Theorem side panel
  async (u) => {
    if (u.pathname !== "/theorem/island/side") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const indexChain = await theoremRuntime.chain(stream);
    const latest = getLatestTheoremRunId(indexChain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    const runData = (!wantsEmpty && activeRun)
      ? await loadTheoremRunChain(stream, activeRun, branchParam)
      : { chain: [], chainStream: stream, isBranch: false };
    const displayChain = (!wantsEmpty && activeRun && !runData.isBranch)
      ? await buildTheoremDisplayChain(stream, activeRun)
      : runData.chain;
    const viewChain = at === null ? displayChain : sliceTheoremChainByStep(displayChain, at);
    const stateFromView = fold(viewChain, reduceTheorem, initialTheorem);
    // When viewing a branch, branch chain has no branch.created events; use main run state for branches list
    const state =
      runData.isBranch && activeRun
        ? (() => {
            const runStream = theoremRunStream(stream, activeRun);
            return theoremRuntime.chain(runStream).then((mainChain) => {
              const mainState = fold(mainChain, reduceTheorem, initialTheorem);
              return { ...stateFromView, branches: mainState.branches };
            });
          })()
        : Promise.resolve(stateFromView);
    const stateResolved = await state;
    const team = THEOREM_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));
    const steps = buildTheoremSteps(displayChain);
    const totalSteps = Math.max(steps.length, displayChain.length);
    return html(theoremSideHtml(
      stateResolved,
      viewChain,
      wantsEmpty ? null : at,
      totalSteps,
      stream,
      activeRun,
      team,
      runData.chainStream,
      runData.isBranch ? runData.chainStream : undefined,
      viewChain
    ));
  },

  // Run theorem guild
  async (u, req) => {
    if (u.pathname !== "/theorem/run" || req.method !== "POST") return null;
    const stream = u.searchParams.get("stream") ?? "theorem";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const at = parseAt(u.searchParams.get("at"));
    const body = await readBody(req);
    const form = parseForm(body);
    const problem = form.problem?.trim();
    const append = form.append?.trim();
    const runId = runParam?.trim().length ? runParam.trim() : `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const runStream = theoremRunStream(stream, runId);
    const branchPrefix = `${runStream}/branches/`;
    let sourceStream = runStream;
    let sourceChain = await theoremRuntime.chain(runStream);
    if (branchParam && branchParam.startsWith(branchPrefix)) {
      const branchChain = await theoremRuntime.chain(branchParam);
      if (branchChain.length > 0) {
        sourceStream = branchParam;
        sourceChain = branchChain;
      }
    }
    const existingState = sourceChain.length > 0 ? fold(sourceChain, reduceTheorem, initialTheorem) : undefined;
    const resolvedProblem = existingState?.problem || problem || "";
    if (!resolvedProblem) return { code: 400, body: "problem required", type: "text/plain" };
    const hasConfigInput = form.rounds !== undefined || form.depth !== undefined || form.memory !== undefined || form.branch !== undefined;
    let config = parseTheoremConfig(form);
    if (!hasConfigInput && existingState?.config) {
      config = normalizeTheoremConfig({
        rounds: existingState.config.rounds,
        maxDepth: existingState.config.depth,
        memoryWindow: existingState.config.memoryWindow,
        branchThreshold: existingState.config.branchThreshold,
      });
    }

    const apiReady = Boolean(process.env.OPENAI_API_KEY);
    const apiNote = apiReady ? undefined : "OPENAI_API_KEY not set";
    let runStreamOverride: string | undefined;
    let forkedBranch: string | undefined;
    if (runParam?.trim().length && sourceChain.length > 0) {
      const forkSlice = at === null ? sourceChain : sliceTheoremChainByStep(sourceChain, at);
      const forkAt = forkSlice.length;
      const branchId = `resume_${Date.now().toString(36)}_${forkAt}`;
      const branchStream = `${runStream}/branches/${branchId}`;
      await theoremRuntime.fork(sourceStream, forkAt, branchStream);
      const noteBits = [
        "resume fork",
        sourceStream !== runStream ? `from ${sourceStream}` : "",
        at !== null ? `at step ${at}` : "",
      ].filter(Boolean);
      await theoremRuntime.execute(runStream, {
        type: "emit",
        eventId: makeEventId(runStream),
        event: {
          type: "branch.created",
          runId,
          branchId: branchStream,
          forkAt,
          note: noteBits.join(" "),
        },
      });
      runStreamOverride = branchStream;
      forkedBranch = branchStream;
    }
    if (append && runStreamOverride) {
      await theoremRuntime.execute(runStreamOverride, {
        type: "emit",
        eventId: makeEventId(runStreamOverride),
        event: { type: "problem.appended", runId, append, agentId: "orchestrator" },
      });
    }
    void runTheoremGuild({
      stream,
      runId,
      runStream: runStreamOverride,
      problem: append ? `${resolvedProblem}\n\n${append}` : resolvedProblem,
      config,
      runtime: theoremRuntime,
      prompts: THEOREM_PROMPTS,
      llmText,
      model: THEOREM_MODEL,
      promptHash: THEOREM_PROMPTS_HASH,
      promptPath: THEOREM_PROMPTS_PATH,
      apiReady,
      apiNote,
      broadcast: () => {
        broadcastTheoremRefresh(stream);
        broadcastReceiptRefresh();
      },
    });

    const redirectParams = new URLSearchParams({ stream, run: runId });
    if (forkedBranch) redirectParams.set("branch", forkedBranch);
    return html("", { "HX-Redirect": `/theorem?${redirectParams.toString()}` });
  },

  // Writer shell
  async (u) => {
    if (u.pathname !== "/writer") return null;
    const stream = u.searchParams.get("stream") ?? "writer";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const chain = await writerRuntime.chain(stream);
    const latest = getLatestWriterRunId(chain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    return html(writerShell(stream, WRITER_EXAMPLES, activeRun, wantsEmpty ? null : at, branchParam ?? undefined));
  },

  // Writer folds
  async (u) => {
    if (u.pathname !== "/writer/island/folds") return null;
    const stream = u.searchParams.get("stream") ?? "writer";
    const runParam = u.searchParams.get("run");
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const indexChain = await writerRuntime.chain(stream);
    const latest = getLatestWriterRunId(indexChain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    const runs = buildWriterRuns(indexChain);
    const runsWithCounts = await Promise.all(runs.map(async (run) => {
      const runStream = writerRunStream(stream, run.runId);
      const runChain = await writerRuntime.chain(runStream);
      const count = await buildWriterRunReceiptCount(stream, run.runId, runChain.length, run.count);
      const startedAt = runChain.length > 0 ? runChain[0]?.ts : run.startedAt;
      return { ...run, count, startedAt };
    }));
    return html(writerFoldsHtml(stream, runsWithCounts, activeRun, wantsEmpty ? null : at));
  },

  // Writer time travel
  async (u) => {
    if (u.pathname !== "/writer/island/travel") return null;
    const stream = u.searchParams.get("stream") ?? "writer";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const indexChain = await writerRuntime.chain(stream);
    const latest = getLatestWriterRunId(indexChain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    if (!activeRun) {
      return html(writerTravelHtml({ stream, at: null, total: 0 }));
    }
    const runData = await loadWriterRunChain(stream, activeRun, branchParam);
    const steps = buildWriterSteps(runData.chain);
    const totalSteps = Math.max(steps.length, runData.chain.length);
    return html(writerTravelHtml({
      stream,
      runId: activeRun,
      branch: runData.isBranch ? runData.chainStream : undefined,
      at: wantsEmpty ? null : at,
      total: totalSteps,
    }));
  },

  // Writer travel scrub (OOB islands + URL push)
  async (u) => {
    if (u.pathname !== "/writer/travel") return null;
    const stream = u.searchParams.get("stream") ?? "writer";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const at = parseAt(u.searchParams.get("at"));
    const indexChain = await writerRuntime.chain(stream);
    const latest = getLatestWriterRunId(indexChain);
    const activeRun = runParam?.trim() ? runParam : (latest ?? undefined);
    if (!activeRun) {
      return html("", { "HX-Push-Url": `/writer?stream=${encodeURIComponent(stream)}&run=new` });
    }

    const runs = buildWriterRuns(indexChain);
    const runsWithCounts = await Promise.all(runs.map(async (run) => {
      const runStream = writerRunStream(stream, run.runId);
      const runChain = await writerRuntime.chain(runStream);
      const count = await buildWriterRunReceiptCount(stream, run.runId, runChain.length, run.count);
      const startedAt = runChain.length > 0 ? runChain[0]?.ts : run.startedAt;
      return { ...run, count, startedAt };
    }));

    const runData = await loadWriterRunChain(stream, activeRun, branchParam);
    const steps = buildWriterSteps(runData.chain);
    const totalSteps = Math.max(steps.length, runData.chain.length);
    const normalizedAt = at === null ? null : Math.max(0, Math.min(at, totalSteps));
    const viewAt = normalizedAt !== null && normalizedAt < totalSteps ? normalizedAt : null;
    const viewChain = viewAt === null ? runData.chain : sliceWriterChainByStep(runData.chain, viewAt);
    const state = fold(viewChain, reduceWriter, initialWriter);
    const team = WRITER_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));
    const branches = await writerRuntime.branches();
    const activeBranch = runData.isBranch ? runData.chainStream : undefined;

    const urlParams = new URLSearchParams({ stream, run: activeRun });
    if (activeBranch) urlParams.set("branch", activeBranch);
    if (viewAt !== null) urlParams.set("at", String(viewAt));
    const nextUrl = `/writer?${urlParams.toString()}`;
    const atParam = String(viewAt ?? "");
    const branchParamForQuery = activeBranch ?? "";

    return html(`
<div id="wg-folds" class="folds" hx-swap-oob="outerHTML"
     hx-get="/writer/island/folds?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:writer-refresh throttle:800ms" hx-swap="innerHTML">${writerFoldsHtml(stream, runsWithCounts, activeRun, viewAt)}</div>
<div id="wg-travel" class="travel-island" hx-swap-oob="outerHTML"
     hx-get="/writer/island/travel?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:writer-refresh throttle:700ms" hx-swap="innerHTML">${writerTravelHtml({ stream, runId: activeRun, branch: activeBranch, at: viewAt, total: totalSteps })}</div>
<div id="wg-chat" class="run-area" hx-swap-oob="outerHTML"
     hx-get="/writer/island/chat?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:writer-refresh throttle:1200ms" hx-swap="innerHTML">${writerChatHtml(viewChain)}</div>
<div id="wg-side" class="activity" hx-swap-oob="outerHTML"
     hx-get="/writer/island/side?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:writer-refresh throttle:800ms" hx-swap="innerHTML">${writerSideHtml(
      state,
      viewChain,
      viewAt,
      totalSteps,
      stream,
      activeRun,
      team,
      runData.chainStream,
      activeBranch,
      branches,
      viewChain
    )}</div>`, { "HX-Push-Url": nextUrl });
  },

  // Writer chat
  async (u) => {
    if (u.pathname !== "/writer/island/chat") return null;
    const stream = u.searchParams.get("stream") ?? "writer";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const indexChain = await writerRuntime.chain(stream);
    const latest = getLatestWriterRunId(indexChain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    const runData = (!wantsEmpty && activeRun)
      ? await loadWriterRunChain(stream, activeRun, branchParam)
      : { chain: [], chainStream: stream, isBranch: false };
    const viewChain = at === null ? runData.chain : sliceWriterChainByStep(runData.chain, at);
    return html(writerChatHtml(viewChain));
  },

  // Writer side panel
  async (u) => {
    if (u.pathname !== "/writer/island/side") return null;
    const stream = u.searchParams.get("stream") ?? "writer";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const wantsEmpty = runParam !== null && (runParam.trim() === "" || runParam === "new" || runParam === "none");
    const at = parseAt(u.searchParams.get("at"));
    const indexChain = await writerRuntime.chain(stream);
    const latest = getLatestWriterRunId(indexChain);
    const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
    const runData = (!wantsEmpty && activeRun)
      ? await loadWriterRunChain(stream, activeRun, branchParam)
      : { chain: [], chainStream: stream, isBranch: false };
    const viewChain = at === null ? runData.chain : sliceWriterChainByStep(runData.chain, at);
    const state = fold(viewChain, reduceWriter, initialWriter);
    const team = WRITER_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));
    const steps = buildWriterSteps(runData.chain);
    const totalSteps = Math.max(steps.length, runData.chain.length);
    const branches = await writerRuntime.branches();
    const activityChain = viewChain;
    return html(writerSideHtml(
      state,
      viewChain,
      wantsEmpty ? null : at,
      totalSteps,
      stream,
      activeRun,
      team,
      runData.chainStream,
      runData.isBranch ? runData.chainStream : undefined,
      branches,
      activityChain
    ));
  },

  // Run writer guild
  async (u, req) => {
    if (u.pathname !== "/writer/run" || req.method !== "POST") return null;
    const stream = u.searchParams.get("stream") ?? "writer";
    const runParam = u.searchParams.get("run");
    const branchParam = parseBranch(u.searchParams.get("branch"));
    const at = parseAt(u.searchParams.get("at"));
    const body = await readBody(req);
    const form = parseForm(body);
    const problem = form.problem?.trim();
    const append = form.append?.trim();
    const runId = runParam?.trim().length ? runParam.trim() : `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const runStream = writerRunStream(stream, runId);
    const branchPrefix = `${runStream}/branches/`;
    let sourceStream = runStream;
    let sourceChain = await writerRuntime.chain(runStream);
    if (branchParam && branchParam.startsWith(branchPrefix)) {
      const branchChain = await writerRuntime.chain(branchParam);
      if (branchChain.length > 0) {
        sourceStream = branchParam;
        sourceChain = branchChain;
      }
    }
    const existingState = sourceChain.length > 0 ? fold(sourceChain, reduceWriter, initialWriter) : undefined;
    const resolvedProblem = existingState?.problem || problem || "";
    if (!resolvedProblem) return { code: 400, body: "problem required", type: "text/plain" };
    const hasConfigInput = form.parallel !== undefined;
    let config = parseWriterConfig(form);
    if (!hasConfigInput && existingState?.config) {
      config = normalizeWriterConfig({ maxParallel: existingState.config.maxParallel });
    }

    const apiReady = Boolean(process.env.OPENAI_API_KEY);
    const apiNote = apiReady ? undefined : "OPENAI_API_KEY not set";
    let runStreamOverride: string | undefined;
    let forkedBranch: string | undefined;
    if (runParam?.trim().length && sourceChain.length > 0) {
      const forkSlice = at === null ? sourceChain : sliceWriterChainByStep(sourceChain, at);
      const forkAt = forkSlice.length;
      const branchId = `resume_${Date.now().toString(36)}_${forkAt}`;
      const branchStream = `${runStream}/branches/${branchId}`;
      await writerRuntime.fork(sourceStream, forkAt, branchStream);
      runStreamOverride = branchStream;
      forkedBranch = branchStream;
    }
    if (append && runStreamOverride) {
      await writerRuntime.execute(runStreamOverride, {
        type: "emit",
        eventId: makeEventId(runStreamOverride),
        event: { type: "problem.appended", runId, append, agentId: "orchestrator" },
      });
    }
    void runWriterGuild({
      stream,
      runId,
      runStream: runStreamOverride,
      problem: append ? `${resolvedProblem}\n\n${append}` : resolvedProblem,
      config,
      runtime: writerRuntime,
      prompts: WRITER_PROMPTS,
      llmText,
      model: WRITER_MODEL,
      promptHash: WRITER_PROMPTS_HASH,
      promptPath: WRITER_PROMPTS_PATH,
      apiReady,
      apiNote,
      broadcast: () => {
        broadcastWriterRefresh(stream);
        broadcastReceiptRefresh();
      },
    });

    const redirectParams = new URLSearchParams({ stream, run: runId });
    if (forkedBranch) redirectParams.set("branch", forkedBranch);
    return html("", { "HX-Redirect": `/writer?${redirectParams.toString()}` });
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

  if (u.pathname === "/writer/stream") {
    const stream = u.searchParams.get("stream") ?? "writer";
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    });
    res.write("event: writer-refresh\ndata: init\n\n");
    if (!writerSubscribers.has(stream)) {
      writerSubscribers.set(stream, new Set());
    }
    writerSubscribers.get(stream)!.add(res);
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write("event: ping\ndata: keepalive\n\n");
    }, 15000);
    req.on("close", () => {
      clearInterval(ping);
      writerSubscribers.get(stream)?.delete(res);
    });
    return;
  }

  if (u.pathname === "/receipt/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    });
    res.write("event: receipt-refresh\ndata: init\n\n");
    receiptSubscribers.add(res);
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write("event: ping\ndata: keepalive\n\n");
    }, 15000);
    req.on("close", () => {
      clearInterval(ping);
      receiptSubscribers.delete(res);
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

try {
  fs.watch(DATA_DIR, { persistent: false }, () => {
    broadcastReceiptRefresh();
  });
} catch (err) {
  console.warn("Receipt watcher failed:", err);
}

server.listen(PORT, () => {
  console.log(`Receipt server listening on http://localhost:${PORT}`);
});
