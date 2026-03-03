import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import type { LlmTextOptions } from "../adapters/openai.js";
import type { Runtime } from "../core/runtime.js";
import type { InspectorCmd, InspectorEvent, InspectorMode, InspectorState } from "../modules/inspector.js";
import { runReceiptInspector } from "./inspector.js";
import { INSPECTOR_TEAM } from "./inspector.constants.js";
import {
  receiptShell,
  receiptFoldsHtml,
  receiptChatHtml,
  receiptSideHtml,
  type ReceiptChatItem,
  type ReceiptInspectorSnapshot,
} from "../views/receipt.js";
import {
  listReceiptFiles,
  readReceiptFile,
  sliceReceiptRecords,
  buildReceiptContext,
  buildReceiptTimeline,
} from "../adapters/receipt-tools.js";
import { html, parseInspectorDepth, parseLimit, parseOrder, text, toFormRecord } from "../framework/http.js";
import { receiptInspectFormSchema } from "../framework/schemas.js";
import type { InspectorAgentManifest } from "../framework/manifest.js";
import { SseHub } from "../framework/sse-hub.js";

type InspectorManifestDeps = {
  readonly runtime: Runtime<InspectorCmd, InspectorEvent, InspectorState>;
  readonly dataDir: string;
  readonly llmText: (opts: LlmTextOptions) => Promise<string>;
  readonly prompts: Parameters<typeof runReceiptInspector>[0]["prompts"];
  readonly promptHash: string;
  readonly promptPath: string;
  readonly model: string;
  readonly sse: SseHub;
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

const buildInspectorSnapshot = (
  chain: Awaited<ReturnType<Runtime<InspectorCmd, InspectorEvent, InspectorState>["chain"]>>,
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
        snapshot.timeline ??= { depth: e.depth, buckets: [...e.buckets] };
        break;
      case "tool.called":
        tools.push({ name: e.tool, summary: e.summary, durationMs: e.durationMs, error: e.error });
        break;
      default:
        break;
    }
    agentStates.set(agentId, agent);
  }

  if (tools.length) snapshot.tools = tools;
  if (agentStates.size) {
    const statuses = [...agentStates.values()].map((agent) => agent.status);
    if (statuses.includes("running")) snapshot.status = "running";
    else if (statuses.includes("failed")) snapshot.status = "failed";
    else if (statuses.includes("completed")) snapshot.status = "completed";
  }
  if (snapshot.status === "idle" && snapshot.analysis) snapshot.status = "completed";
  if (agentStates.size) {
    snapshot.agents = INSPECTOR_TEAM.map((agent) => agentStates.get(agent.id) ?? { id: agent.id, name: agent.name })
      .map((agent) => ({ ...agent, kind: INSPECTOR_KIND.get(agent.id) }));
  }
  if (snapshot.status === "failed" && !snapshot.note) {
    const failed = [...agentStates.values()].find((agent) => agent.status === "failed");
    if (failed?.note) snapshot.note = failed.note;
  }

  return snapshot;
};

const buildReceiptChatItems = (
  chain: Awaited<ReturnType<Runtime<InspectorCmd, InspectorEvent, InspectorState>["chain"]>>,
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

export const createInspectorManifest = (deps: InspectorManifestDeps): InspectorAgentManifest => {
  const { runtime, dataDir, llmText, prompts, promptHash, promptPath, model, sse } = deps;

  return {
    id: "receipt-inspector",
    kind: "inspector",
    paths: {
      shell: "/receipt",
      folds: "/receipt/island/folds",
      chat: "/receipt/island/chat",
      side: "/receipt/island/side",
      inspect: "/receipt/inspect",
      stream: "/receipt/stream",
    },
    register: (app: Hono) => {
      app.get("/receipt", async (c) => {
        const file = c.req.query("file") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        const files = await listReceiptFiles(dataDir);
        const selected = files.find((f) => f.name === file)?.name ?? files[0]?.name;
        return html(receiptShell({ selected, limit, order, depth }));
      });

      app.get("/receipt/island/folds", async (c) => {
        const selected = c.req.query("selected") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        const files = await listReceiptFiles(dataDir);
        return html(receiptFoldsHtml(files, selected, order, limit, depth));
      });

      app.get("/receipt/island/chat", async (c) => {
        const file = c.req.query("file") ?? "";
        if (!file) return html(receiptChatHtml({ selected: undefined, items: [] }));
        const inspectorChain = await runtime.chain("inspector");
        const items = buildReceiptChatItems(inspectorChain, file);
        return html(receiptChatHtml({ selected: file, items }));
      });

      app.get("/receipt/island/side", async (c) => {
        const file = c.req.query("file") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        if (!file) {
          return html(receiptSideHtml({
            selected: undefined,
            order,
            limit,
            depth,
            snapshot: { status: "idle" },
          }));
        }
        const files = await listReceiptFiles(dataDir);
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
          const records = await readReceiptFile(dataDir, selected.name);
          const slice = sliceReceiptRecords(records, order, limit);
          const inspectorChain = await runtime.chain("inspector");
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
      });

      app.post(
        "/receipt/inspect",
        zValidator("form", receiptInspectFormSchema, (result) => {
          if (!result.success) return text(400, "file required");
        }),
        async (c) => {
        const formRaw = toFormRecord(c.req.valid("form"));

        const file = (formRaw.file ?? "").trim();
        const order = parseOrder(formRaw.order ?? null);
        const limit = parseLimit(formRaw.limit ?? null);
        const depth = parseInspectorDepth(formRaw.depth ?? null);
        const question = formRaw.question?.trim() || "Analyze this run.";

        if (!file) return text(400, "file required");
        const files = await listReceiptFiles(dataDir);
        const selected = files.find((f) => f.name === file);
        if (!selected) return text(404, "file not found");

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
            dataDir,
            order,
            limit,
            question,
            mode: agent.mode,
            depth,
            runtime,
            prompts,
            llmText: (opts) => llmText({
              ...opts,
              onDelta: async (delta) => {
                if (!delta) return;
                sse.publishData(
                  "receipt",
                  undefined,
                  "receipt-token",
                  JSON.stringify({ groupId, runId, agentId: agent.id, file: selected.name, delta })
                );
              },
            }),
            model,
            promptHash,
            promptPath,
            apiReady,
            apiNote,
            tools: {
              readFile: readReceiptFile,
              sliceRecords: sliceReceiptRecords,
              buildContext: buildReceiptContext,
              buildTimeline: buildReceiptTimeline,
            },
            broadcast: () => sse.publish("receipt"),
          });
        }

        return html("", { "HX-Trigger": "receipt-refresh" });
        }
      );

      app.get("/receipt/stream", async (c) => sse.subscribe("receipt", undefined, c.req.raw.signal));
    },
  };
};
