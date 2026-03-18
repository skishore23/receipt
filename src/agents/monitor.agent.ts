import type { Context, Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import { fold } from "../core/chain.js";
import type { Runtime } from "../core/runtime.js";
import type { AgentCmd, AgentEvent, AgentState } from "../modules/agent.js";
import { initial as initialAgent, reduce as reduceAgent } from "../modules/agent.js";
import { html, text, toFormRecord } from "../framework/http.js";
import { agentRunFormSchema } from "../framework/schemas.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import type { RuntimeOp } from "../framework/translators.js";
import { executeRuntimeOps } from "../framework/translators.js";
import { SseHub, type Topic } from "../framework/sse-hub.js";
import type { EnqueueJobInput, QueueCommandInput, QueueJob } from "../adapters/jsonl-queue.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import { esc as escapeHtml, truncate } from "../views/agent-framework.js";
import { getAgentDisplayMeta, getAgentDisplayName, MONITOR_AGENT_IDS } from "./agent-display.js";
import { agentRunStream } from "./agent.streams.js";
import { getLatestAgentRunId, parseAgentConfig } from "./agent.js";

type MonitorRouteDeps = {
  readonly runtime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly sse: SseHub;
  readonly enqueueJob: (job: EnqueueJobInput) => Promise<void>;
  readonly listJobs: (opts?: { readonly status?: QueueJob["status"]; readonly limit?: number }) => Promise<ReadonlyArray<QueueJob>>;
  readonly getJob: (jobId: string) => Promise<QueueJob | undefined>;
  readonly queueCommand: (input: QueueCommandInput) => Promise<{ readonly id: string } | undefined>;
  readonly memoryTools?: MemoryTools;
};

type AgentRunStartIntent = {
  readonly agentId: string;
  readonly stream: string;
  readonly runId: string;
  readonly problem: string;
  readonly config: ReturnType<typeof parseAgentConfig>;
};

const summarizeEvent = (event: AgentEvent): string => {
  switch (event.type) {
    case "problem.set":
      return `problem.set ${event.problem.slice(0, 140)}`;
    case "failure.report":
      return `failure ${event.failure.failureClass} - ${event.failure.message}`;
    case "run.status":
      return `run.status ${event.status}${event.note ? ` - ${event.note}` : ""}`;
    case "iteration.started":
      return `iteration.started #${event.iteration}`;
    case "thought.logged":
      return `thought ${event.content.slice(0, 160)}`;
    case "action.planned":
      return event.actionType === "tool"
        ? `action tool ${event.name ?? "unknown"}`
        : "action final";
    case "tool.called":
      return `tool ${event.tool}${event.error ? ` error=${event.error}` : ""}`;
    case "response.finalized":
      return `final ${event.content.slice(0, 160)}`;
    case "run.continued":
      return `continued ${event.nextRunId} job=${event.nextJobId}`;
    case "memory.slice":
      return `memory.slice scope=${event.scope} items=${event.itemCount}`;
    case "context.pruned":
      return `context.pruned ${event.mode} ${event.before}->${event.after}`;
    case "context.compacted":
      return `context.compacted ${event.reason} ${event.before}->${event.after}`;
    case "overflow.recovered":
      return "overflow.recovered";
    case "tool.observed":
      return `tool.observed ${event.tool}${event.truncated ? " (truncated)" : ""}`;
    case "run.configured":
      return `run.configured iters=${event.config.maxIterations}`;
    case "subagent.merged":
      return `subagent.merged ${event.subRunId}`;
    case "agent.delegated":
      return `agent.delegated to=${event.delegatedTo} task=${event.task.slice(0, 80)}`;
    case "memory.flushed":
      return `memory.flushed scope=${event.scope} chars=${event.chars}`;
    default:
      return "event";
  }
};

const TERMINAL_JOB_STATUS = new Set<QueueJob["status"]>(["completed", "failed", "canceled"]);

const parseJobStatus = (value: string | undefined): QueueJob["status"] | undefined => (
  value === "queued" || value === "leased" || value === "running" || value === "completed" || value === "failed" || value === "canceled"
    ? value
    : undefined
);

const readJobFollowUpMeta = (job: QueueJob): {
  readonly followUpJobId?: string;
  readonly followUpRunId?: string;
  readonly failureClass?: string;
  readonly failure?: Record<string, unknown>;
} => ({
  followUpJobId: typeof job.result?.followUpJobId === "string" ? job.result.followUpJobId : undefined,
  followUpRunId: typeof job.result?.followUpRunId === "string" ? job.result.followUpRunId : undefined,
  failureClass: typeof job.result?.failureClass === "string" ? job.result.failureClass : undefined,
  failure: typeof job.result?.failure === "object" && job.result.failure && !Array.isArray(job.result.failure)
    ? job.result.failure as Record<string, unknown>
    : undefined,
});

const summarizeJobPayload = (job: QueueJob): string => {
  const kind = typeof job.payload.kind === "string" ? job.payload.kind : "";
  const problemRaw = typeof job.payload.problem === "string" ? job.payload.problem : "";
  const problem = problemRaw.replace(/\s+/g, " ").trim();
  const { followUpJobId } = readJobFollowUpMeta(job);
  const followUpSuffix = followUpJobId ? ` [next: ${followUpJobId}]` : "";
  if (problem) return `${problem.slice(0, 100)}${followUpSuffix}`;
  if (kind.endsWith(".run")) return `${getAgentDisplayName(job.agentId)} run`;
  if (kind) return kind;
  return "(no summary)";
};

const formatClock = (ts: number): string => new Date(ts).toLocaleTimeString();
const formatDateTime = (ts: number): string => new Date(ts).toLocaleString();

const classForStatus = (status: QueueJob["status"]): string => `status-${status}`;

const MONITOR_BASE_PATH = "/monitor";
const monitorPrimaryTopic = (stream: string): Extract<Topic, "agent" | "theorem" | "writer"> => {
  const normalized = stream.trim().toLowerCase();
  if (normalized.includes("axiom-guild") || normalized.includes("theorem")) return "theorem";
  if (normalized.includes("writer")) return "writer";
  return "agent";
};

const monitorSseSubscriptions = (stream: string): ReadonlyArray<{ topic: Topic; stream?: string }> => [
  { topic: monitorPrimaryTopic(stream), stream },
  { topic: "receipt" },
  { topic: "jobs" },
];

const buildShellUrl = (
  stream: string,
  runId?: string,
  jobId?: string
): string => {
  const params = new URLSearchParams();
  params.set("stream", stream);
  if (runId) params.set("run", runId);
  if (jobId) params.set("job", jobId);
  return `${MONITOR_BASE_PATH}?${params.toString()}`;
};

const parseJsonObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const redirectResponse = (
  url: string,
  header: "HX-Redirect" | "HX-Push-Url" = "HX-Redirect"
): Response =>
  new Response("", {
    status: 303,
    headers: {
      "Location": url,
      [header]: url,
      "Cache-Control": "no-store",
    },
  });

const agentShell = (opts: { stream: string; runId?: string; jobId?: string }): string => {
  const currentStreamAgent = opts.stream.replace(/^agents\//, "");
  const activeAgentId = MONITOR_AGENT_IDS.find((agentId) => agentId === currentStreamAgent) ?? "agent";
  const agentOptions = MONITOR_AGENT_IDS
    .map((agentId) => `<option value="${escapeHtml(agentId)}"${agentId === activeAgentId ? " selected" : ""}>${escapeHtml(getAgentDisplayName(agentId))}</option>`)
    .join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Command Center</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #0a0b0f;
      --ink: #f3f5f7;
      --muted: #9aa0ab;
      --line: rgba(255,255,255,0.08);
      --panel: rgba(16,18,24,0.9);
      --accent: #79e3bf;
      --accent-2: #a4ccff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--ink);
      background: radial-gradient(920px 560px at 62% 0%, rgba(52,80,65,0.24), transparent),
                  radial-gradient(760px 440px at 18% 80%, rgba(46,64,86,0.2), transparent),
                  var(--bg);
      min-height: 100vh;
      overflow-x: hidden;
    }
    .app {
      display: block;
      min-height: 100vh;
    }
    .main {
      padding: 22px 24px;
      max-width: 1320px;
      margin: 0 auto;
    }
    .main, .panel { min-width: 0; }
    .panel {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      padding: 14px;
    }
    .panel h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    .mono {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
    }
    .api {
      margin: 0;
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      color: rgba(243,245,247,0.86);
    }
    .log-wrap { display: grid; gap: 10px; }
    .log-meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 12px;
      color: rgba(243,245,247,0.86);
    }
    .chip {
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.04);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
    }
    .log-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 8px;
    }
    .log-list li {
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      border-radius: 10px;
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.45;
    }
    .log-list code {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      color: var(--accent);
    }
    pre {
      white-space: pre-wrap;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      padding: 10px;
      border-radius: 10px;
      margin: 0;
      font-size: 12px;
      max-width: 100%;
      overflow-x: auto;
      overflow-wrap: anywhere;
    }
    .jobs-wrap { display: grid; gap: 10px; }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      background: rgba(255,255,255,0.02);
    }
    .jobs-toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 92px auto auto auto auto;
      gap: 8px;
      align-items: end;
      margin-bottom: 10px;
    }
    .jobs-toolbar label {
      display: grid;
      gap: 4px;
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .jobs-toolbar select,
    .jobs-toolbar input {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 8px;
      color: var(--ink);
      padding: 7px 8px;
      font-size: 12px;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
    }
    .jobs-toolbar button {
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(255,255,255,0.05);
      color: var(--ink);
      padding: 7px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .jobs-toolbar button.warn {
      border-color: rgba(255,140,140,0.45);
      background: rgba(255,140,140,0.18);
    }
    .global-status {
      min-height: 1.2em;
      margin-top: 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .jobs-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 11px;
      color: rgba(255,255,255,0.78);
    }
    .jobs-table {
      width: 100%;
      min-width: 860px;
      border-collapse: collapse;
      font-size: 11px;
    }
    .jobs-table thead th {
      text-align: left;
      color: var(--muted);
      font-weight: 600;
      padding: 6px 6px;
      border-bottom: 1px solid rgba(255,255,255,0.12);
      letter-spacing: 0.04em;
    }
    .jobs-table td {
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding: 6px 6px;
      vertical-align: top;
    }
    .job-row.is-selected td {
      background: rgba(121,227,191,0.14);
    }
    .job-select {
      display: block;
      width: 100%;
      text-align: left;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      background: rgba(255,255,255,0.03);
      color: var(--ink);
      cursor: pointer;
      padding: 5px 7px;
      font-size: 11px;
    }
    .job-select:hover { border-color: rgba(121,227,191,0.45); }
    .status-pill {
      display: inline-block;
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .status-pill.status-queued {
      color: #d2e9ff;
      border-color: rgba(164,204,255,0.55);
      background: rgba(164,204,255,0.2);
    }
    .status-pill.status-leased,
    .status-pill.status-running {
      color: #ffecc2;
      border-color: rgba(255,212,127,0.55);
      background: rgba(255,212,127,0.2);
    }
    .status-pill.status-completed {
      color: #caf6e6;
      border-color: rgba(121,227,191,0.55);
      background: rgba(121,227,191,0.2);
    }
    .status-pill.status-failed,
    .status-pill.status-canceled {
      color: #ffd0d0;
      border-color: rgba(255,140,140,0.55);
      background: rgba(255,140,140,0.18);
    }
    .small {
      font-size: 11px;
      color: rgba(255,255,255,0.78);
      line-height: 1.4;
    }
    .k {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    .job-detail {
      display: grid;
      gap: 10px;
    }
    .job-detail .detail-grid {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .detail-card {
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      background: rgba(255,255,255,0.03);
      padding: 8px;
      font-size: 11px;
      line-height: 1.45;
    }
    .detail-card .k {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .detail-card .v { margin-top: 3px; overflow-wrap: anywhere; }
    .command-form {
      display: grid;
      gap: 8px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      background: rgba(255,255,255,0.03);
      padding: 10px;
    }
    .command-form label {
      display: grid;
      gap: 4px;
      font-size: 11px;
      color: rgba(255,255,255,0.8);
    }
    .command-form textarea,
    .command-form input {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 8px;
      color: var(--ink);
      padding: 7px 8px;
      font-size: 12px;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
    }
    .command-form textarea {
      min-height: 62px;
      resize: vertical;
    }
    .command-form button {
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 8px;
      padding: 7px 10px;
      background: rgba(255,255,255,0.05);
      color: var(--ink);
      font-weight: 600;
      cursor: pointer;
    }
    .command-form button.warn {
      border-color: rgba(255,140,140,0.45);
      background: rgba(255,140,140,0.16);
    }
    .command-status {
      min-height: 1.2em;
      font-size: 11px;
      color: var(--muted);
    }
    .drawer {
      position: fixed;
      inset: 0;
      z-index: 40;
      pointer-events: none;
    }
    .drawer-backdrop {
      position: absolute;
      inset: 0;
      border: 0;
      width: 100%;
      padding: 0;
      cursor: pointer;
      background: rgba(0,0,0,0.55);
      opacity: 0;
      transition: opacity 180ms ease;
    }
    .drawer-panel {
      position: absolute;
      top: 0;
      right: 0;
      height: 100%;
      width: 100vw;
      background: linear-gradient(180deg, rgba(12,16,24,0.98), rgba(8,10,15,0.98));
      border-left: 1px solid rgba(255,255,255,0.12);
      transform: translateX(100%);
      transition: transform 220ms ease;
      display: grid;
      grid-template-rows: auto 1fr;
      min-width: 0;
    }
    .drawer-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.02);
    }
    .drawer-head h2 {
      margin: 0;
      font-size: 14px;
    }
    .drawer-close {
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(255,255,255,0.05);
      color: var(--ink);
      padding: 7px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .drawer-body {
      overflow: auto;
      padding: 14px 16px 24px;
    }
    .drawer.is-open {
      pointer-events: auto;
    }
    .drawer.is-open .drawer-backdrop {
      opacity: 1;
    }
    .drawer.is-open .drawer-panel {
      transform: translateX(0);
    }
    .dash-header { margin-bottom: 16px; }
    .dash-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .dash-title {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .dash-accent { color: var(--accent); }
    .dash-status-pills { display: flex; gap: 6px; flex-wrap: wrap; }
    .dash-grid-2 {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 14px;
    }
    .submit-form {
      display: grid;
      gap: 8px;
    }
    .submit-form label {
      display: grid;
      gap: 4px;
      font-size: 11px;
      color: rgba(255,255,255,0.8);
    }
    .submit-form select,
    .submit-form textarea,
    .submit-form input {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 8px;
      color: var(--ink);
      padding: 7px 8px;
      font-size: 12px;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
    }
    .submit-form textarea {
      min-height: 54px;
      resize: vertical;
    }
    .submit-form button {
      border: 1px solid rgba(121,227,191,0.4);
      border-radius: 8px;
      background: rgba(121,227,191,0.14);
      color: var(--accent);
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .submit-form button:hover {
      background: rgba(121,227,191,0.22);
    }
    .agents-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .agent-card {
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      background: rgba(255,255,255,0.03);
      padding: 10px;
      display: grid;
      gap: 4px;
    }
    .agent-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .agent-card-name {
      font-size: 12px;
      font-weight: 600;
    }
    .agent-card-stat {
      font-size: 10px;
      color: var(--muted);
    }
    .activity-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 6px;
      max-height: 320px;
      overflow-y: auto;
    }
    .activity-list li {
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.02);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11px;
      line-height: 1.4;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
    }
    .activity-ts {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      color: var(--muted);
      font-size: 10px;
      white-space: nowrap;
    }
    .activity-body { color: rgba(255,255,255,0.86); }
    .activity-agent {
      color: var(--accent);
      font-weight: 600;
    }
    .memory-toolbar {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 8px;
      align-items: end;
      margin-bottom: 10px;
    }
    .memory-toolbar label {
      display: grid;
      gap: 4px;
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .memory-toolbar input {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 8px;
      color: var(--ink);
      padding: 7px 8px;
      font-size: 12px;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
    }
    .memory-toolbar button {
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      background: rgba(255,255,255,0.05);
      color: var(--ink);
      padding: 7px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .memory-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 6px;
      max-height: 280px;
      overflow-y: auto;
    }
    .memory-list li {
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.02);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11px;
      line-height: 1.4;
    }
    .memory-tags {
      display: flex;
      gap: 4px;
      margin-top: 3px;
    }
    .memory-tag {
      font-size: 9px;
      border: 1px solid rgba(121,227,191,0.3);
      background: rgba(121,227,191,0.08);
      color: var(--accent);
      border-radius: 999px;
      padding: 1px 6px;
    }
    .memory-ts {
      font-size: 10px;
      color: var(--muted);
    }
    @media (max-width: 1360px) {
      .main { padding: 14px 16px; }
      .jobs-toolbar { grid-template-columns: 1fr; }
      .dash-grid-2 { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
<div id="monitor-app" class="app">
  <main class="main">
    <header class="dash-header">
      <div class="dash-title-row">
        <h1 class="dash-title">Receipt <span class="dash-accent">Command Center</span></h1>
        <div class="dash-status-pills">
          <span class="chip" id="monitor-clock"></span>
        </div>
      </div>
    </header>

    <div class="dash-grid-2">
      <section class="panel" id="monitor-submit-panel">
        <h2>Submit Task</h2>
        <form id="monitor-submit-form" class="submit-form" method="post" action="/monitor/run">
          <label>Agent
            <select name="agentId" id="monitor-submit-agent">
              ${agentOptions}
            </select>
          </label>
          <label>Task
            <textarea name="problem" placeholder="Describe the task..." required rows="3"></textarea>
          </label>
          <label>Max iterations
            <input name="maxIterations" type="number" min="1" max="80" value="20" />
          </label>
          <button type="submit">Dispatch</button>
          <div id="monitor-submit-status" class="command-status"></div>
        </form>
      </section>

      <section class="panel">
        <h2>Agents</h2>
        <div id="monitor-agents" class="agents-grid">Loading...</div>
      </section>
    </div>

    <section class="panel">
      <h2>Queue Jobs</h2>
      <div class="jobs-toolbar">
        <label>Status
          <select id="monitor-jobs-status">
            <option value="">all</option>
            <option value="queued">queued</option>
            <option value="leased">leased</option>
            <option value="running">running</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
            <option value="canceled">canceled</option>
          </select>
        </label>
        <label>Limit
          <input id="monitor-jobs-limit" type="number" min="10" max="240" value="80" />
        </label>
        <button id="monitor-jobs-refresh" type="button">Refresh</button>
        <button id="monitor-jobs-clear" type="button">Clear Selected</button>
        <button id="monitor-jobs-wait" type="button">Wait Selected</button>
        <button id="monitor-jobs-abort" class="warn" type="button">Abort Selected</button>
      </div>
      <div id="monitor-jobs">Loading...</div>
      <div id="monitor-global-status" class="global-status"></div>
    </section>

    <div class="dash-grid-2">
      <section class="panel">
        <h2>Recent Activity</h2>
        <div id="monitor-activity">Loading...</div>
      </section>

      <section class="panel">
        <h2>Memory</h2>
        <div class="memory-toolbar">
          <label>Scope
            <input id="monitor-memory-scope" type="text" value="agent" placeholder="scope" />
          </label>
          <label>Query
            <input id="monitor-memory-query" type="text" placeholder="search..." />
          </label>
          <button id="monitor-memory-search" type="button">Search</button>
        </div>
        <div id="monitor-memory">
          <p class="small muted">Enter a scope and query to search memory.</p>
        </div>
      </section>
    </div>
  </main>
  <div id="monitor-detail-drawer" class="drawer" aria-hidden="true">
    <button id="monitor-detail-backdrop" class="drawer-backdrop" type="button" aria-label="Close selected job details"></button>
    <section class="drawer-panel" role="dialog" aria-modal="true" aria-label="Selected job details">
      <div class="drawer-head">
        <h2>Selected Job</h2>
        <button id="monitor-detail-close" class="drawer-close" type="button">Close</button>
      </div>
      <div class="drawer-body">
        <div id="monitor-job-detail"><p class="small muted">Select a job to inspect details and commands.</p></div>
      </div>
    </section>
  </div>
</div>
<script>
  const basePath = "/monitor";
  const stream = ${JSON.stringify(opts.stream)};
  let run = ${JSON.stringify(opts.runId ?? "")};
  let job = ${JSON.stringify(opts.jobId ?? "")};
  let drawerOpen = Boolean(job);
  const drawerEl = document.getElementById("monitor-detail-drawer");
  const drawerBackdrop = document.getElementById("monitor-detail-backdrop");
  const drawerClose = document.getElementById("monitor-detail-close");
  const detailBox = document.getElementById("monitor-job-detail");
  const DETAIL_PLACEHOLDER = '<p class="small muted">Select a job to inspect details and commands.</p>';
  const setDrawerOpen = (next) => {
    drawerOpen = Boolean(next) && Boolean(job);
    if (!drawerEl) return;
    drawerEl.classList.toggle("is-open", drawerOpen);
    drawerEl.setAttribute("aria-hidden", drawerOpen ? "false" : "true");
  };
  const clearDetail = () => {
    if (detailBox) detailBox.innerHTML = DETAIL_PLACEHOLDER;
  };
  const clearSelection = () => {
    job = "";
    run = "";
    clearDetail();
    setDrawerOpen(false);
  };
  const openDrawer = () => {
    if (!job) return;
    setDrawerOpen(true);
  };
  const closeDrawer = () => {
    clearSelection();
  };
  const pageParams = new URLSearchParams(window.location.search);
  let jobsStatus = pageParams.get("status") || "";
  const parsedLimit = Number(pageParams.get("limit") || "80");
  let jobsLimit = Number.isFinite(parsedLimit) ? Math.max(10, Math.min(Math.floor(parsedLimit), 240)) : 80;
  const jobsStatusInput = document.getElementById("monitor-jobs-status");
  const jobsLimitInput = document.getElementById("monitor-jobs-limit");
  const jobsRefreshButton = document.getElementById("monitor-jobs-refresh");
  const jobsClearButton = document.getElementById("monitor-jobs-clear");
  const jobsWaitButton = document.getElementById("monitor-jobs-wait");
  const jobsAbortButton = document.getElementById("monitor-jobs-abort");
  const globalStatus = document.getElementById("monitor-global-status");
  let refreshing = false;
  let refreshPending = false;
  let detailRefreshing = false;
  let detailRefreshPending = false;
  const setGlobalStatus = (message) => {
    if (!globalStatus) return;
    globalStatus.textContent = message || "";
  };
  const syncUrl = () => {
    const params = new URLSearchParams({ stream });
    if (run) params.set("run", run);
    if (job) params.set("job", job);
    if (jobsStatus) params.set("status", jobsStatus);
    if (jobsLimit !== 80) params.set("limit", String(jobsLimit));
    window.history.replaceState(null, "", basePath + "?" + params.toString());
  };
  const refreshJobs = async () => {
    const params = new URLSearchParams({ stream });
    if (job) params.set("job", job);
    if (jobsStatus) params.set("status", jobsStatus);
    params.set("limit", String(jobsLimit));
    const res = await fetch(basePath + "/island/jobs?" + params.toString(), { cache: "no-store" });
    const text = await res.text();
    const box = document.getElementById("monitor-jobs");
    if (box) box.innerHTML = text;
    const nextJob = box?.querySelector("[data-selected-job-id]")?.getAttribute("data-selected-job-id");
    if (nextJob !== null && nextJob !== undefined) job = nextJob;
    const nextRun = box?.querySelector("[data-selected-job-id]")?.getAttribute("data-selected-run-id");
    if (nextRun !== null && nextRun !== undefined) run = nextRun;
  };
  if (jobsStatusInput instanceof HTMLSelectElement) jobsStatusInput.value = jobsStatus;
  if (jobsLimitInput instanceof HTMLInputElement) jobsLimitInput.value = String(jobsLimit);
  jobsStatusInput?.addEventListener("change", () => {
    if (!(jobsStatusInput instanceof HTMLSelectElement)) return;
    jobsStatus = jobsStatusInput.value;
    void refreshAll();
  });
  jobsLimitInput?.addEventListener("change", () => {
    if (!(jobsLimitInput instanceof HTMLInputElement)) return;
    const raw = Number(jobsLimitInput.value || "80");
    jobsLimit = Number.isFinite(raw) ? Math.max(10, Math.min(Math.floor(raw), 240)) : 80;
    jobsLimitInput.value = String(jobsLimit);
    void refreshAll();
  });
  jobsRefreshButton?.addEventListener("click", () => { void refreshAll(); });
  jobsClearButton?.addEventListener("click", () => {
    clearSelection();
    setGlobalStatus("Selection cleared.");
    void refreshAll();
  });
  jobsWaitButton?.addEventListener("click", async () => {
    if (!job) {
      setGlobalStatus("Select a job first.");
      return;
    }
    setGlobalStatus("Waiting for selected job...");
    try {
      const res = await fetch("/jobs/" + encodeURIComponent(job) + "/wait?timeoutMs=12000", { cache: "no-store" });
      if (!res.ok) {
        setGlobalStatus("Wait failed.");
        return;
      }
      const body = await res.json();
      const status = body?.status ? String(body.status) : "updated";
      setGlobalStatus("Selected job status: " + status);
      await refreshAll();
    } catch {
      setGlobalStatus("Wait request failed.");
    }
  });
  jobsAbortButton?.addEventListener("click", async () => {
    if (!job) {
      setGlobalStatus("Select a job first.");
      return;
    }
    setGlobalStatus("Queuing abort for selected job...");
    try {
      const params = new URLSearchParams({ stream });
      if (run) params.set("run", run);
      params.set("job", job);
      const body = new URLSearchParams({ reason: "monitor abort selected" });
      const res = await fetch(basePath + "/job/" + encodeURIComponent(job) + "/abort?" + params.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "fetch",
        },
        body: body.toString(),
      });
      const message = await res.text();
      setGlobalStatus(message || (res.ok ? "Abort queued." : "Abort failed."));
      if (res.ok) await refreshAll();
    } catch {
      setGlobalStatus("Abort request failed.");
    }
  });
  const refreshJobDetail = async () => {
    if (detailRefreshing) {
      detailRefreshPending = true;
      return;
    }
    detailRefreshing = true;
    try {
      if (!detailBox) return;
      if (!job) {
        clearDetail();
        setDrawerOpen(false);
        return;
      }
      if (!drawerOpen) return;
      const params = new URLSearchParams({ stream });
      if (run) params.set("run", run);
      if (job) params.set("job", job);
      const res = await fetch(basePath + "/island/job?" + params.toString(), { cache: "no-store" });
      const text = await res.text();
      detailBox.innerHTML = text;
      setDrawerOpen(true);
    } finally {
      detailRefreshing = false;
      if (detailRefreshPending) {
        detailRefreshPending = false;
        setTimeout(() => { void refreshJobDetail(); }, 0);
      }
    }
  };
  const scheduleRefreshAll = () => { void refreshAll(); };
  const scheduleRefreshJobDetail = () => { void refreshJobDetail(); };
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-job-select]");
    if (!button) return;
    const next = button.getAttribute("data-job-select");
    if (!next) return;
    job = next;
    const nextRun = button.getAttribute("data-job-run");
    run = nextRun || "";
    if (detailBox) detailBox.innerHTML = '<p class="small muted">Loading selected job...</p>';
    openDrawer();
    scheduleRefreshAll();
  });
  drawerBackdrop?.addEventListener("click", () => {
    closeDrawer();
    scheduleRefreshAll();
  });
  drawerClose?.addEventListener("click", () => {
    closeDrawer();
    scheduleRefreshAll();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !drawerOpen) return;
    closeDrawer();
    scheduleRefreshAll();
  });
  document.addEventListener("submit", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLFormElement)) return;
    if (!target.hasAttribute("data-monitor-command-form")) return;
    event.preventDefault();
    const status = document.getElementById("monitor-command-status");
    try {
      const res = await fetch(target.action, {
        method: "POST",
        body: new FormData(target),
        headers: { "X-Requested-With": "fetch" },
      });
      const message = (await res.text()) || (res.ok ? "Command queued." : "Command failed.");
      if (status) status.textContent = message;
      if (!res.ok) return;
      target.reset();
      await refreshAll();
    } catch {
      if (status) status.textContent = "Failed to send command.";
    }
  });
  // Submit task form
  const submitForm = document.getElementById("monitor-submit-form");
  const submitStatus = document.getElementById("monitor-submit-status");
  const submitAgent = document.getElementById("monitor-submit-agent");
  submitForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!(submitForm instanceof HTMLFormElement)) return;
    const formData = new FormData(submitForm);
    const agentId = formData.get("agentId") || "agent";
    const problem = formData.get("problem");
    if (!problem || !String(problem).trim()) {
      if (submitStatus) submitStatus.textContent = "Task description required.";
      return;
    }
    if (submitStatus) submitStatus.textContent = "Dispatching...";
    try {
      const config = {};
      const rawMaxIterations = Number(formData.get("maxIterations"));
      if (Number.isFinite(rawMaxIterations)) {
        config.maxIterations = Math.max(1, Math.min(Math.floor(rawMaxIterations), 80));
      }
      const res = await fetch("/agents/" + encodeURIComponent(String(agentId)) + "/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: agentId + ".run",
          agentName: submitAgent instanceof HTMLSelectElement ? submitAgent.selectedOptions[0]?.textContent?.trim() : undefined,
          problem: String(problem).trim(),
          ...(Object.keys(config).length > 0 ? { config } : {}),
        }),
      });
      const body = await res.json();
      if (res.ok && body.job) {
        job = body.job.id || "";
        if (submitStatus) submitStatus.textContent = "Task dispatched: " + (body.job.id || "ok");
        submitForm.reset();
        openDrawer();
        await refreshAll();
      } else {
        if (submitStatus) submitStatus.textContent = "Failed: " + (body.error || res.statusText);
      }
    } catch {
      if (submitStatus) submitStatus.textContent = "Failed to dispatch task.";
    }
  });

  // Agents overview
  const refreshAgents = async () => {
    const box = document.getElementById("monitor-agents");
    if (!box) return;
    const res = await fetch(basePath + "/island/agents", { cache: "no-store" });
    box.innerHTML = await res.text();
  };

  // Activity feed
  const refreshActivity = async () => {
    const box = document.getElementById("monitor-activity");
    if (!box) return;
    const res = await fetch(basePath + "/island/activity?stream=" + encodeURIComponent(stream), { cache: "no-store" });
    box.innerHTML = await res.text();
  };

  // Memory search
  const memScopeInput = document.getElementById("monitor-memory-scope");
  const memQueryInput = document.getElementById("monitor-memory-query");
  const memSearchBtn = document.getElementById("monitor-memory-search");
  const doMemorySearch = async () => {
    const box = document.getElementById("monitor-memory");
    if (!box) return;
    const scope = (memScopeInput instanceof HTMLInputElement ? memScopeInput.value : "agent") || "agent";
    const query = memQueryInput instanceof HTMLInputElement ? memQueryInput.value : "";
    const params = new URLSearchParams({ scope });
    if (query.trim()) params.set("query", query.trim());
    const res = await fetch(basePath + "/island/memory?" + params.toString(), { cache: "no-store" });
    box.innerHTML = await res.text();
  };
  memSearchBtn?.addEventListener("click", () => { void doMemorySearch(); });
  memQueryInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { void doMemorySearch(); }
  });

  // Clock
  const clockEl = document.getElementById("monitor-clock");
  const updateClock = () => {
    if (clockEl) clockEl.textContent = new Date().toLocaleTimeString();
  };
  updateClock();
  setInterval(updateClock, 1000);

  async function refreshAll() {
    if (refreshing) {
      refreshPending = true;
      return;
    }
    refreshing = true;
    try {
      await Promise.all([refreshJobs(), refreshAgents(), refreshActivity()]);
      await refreshJobDetail();
      syncUrl();
    } finally {
      refreshing = false;
      if (refreshPending) {
        refreshPending = false;
        setTimeout(() => { void refreshAll(); }, 0);
      }
    }
  }

  const es = new EventSource(basePath + "/stream?stream=" + encodeURIComponent(stream));
  ["agent-refresh", "theorem-refresh", "writer-refresh", "receipt-refresh", "job-refresh"].forEach((eventName) => {
    es.addEventListener(eventName, scheduleRefreshAll);
  });
  ["agent-token", "theorem-token", "writer-token"].forEach((eventName) => {
    es.addEventListener(eventName, scheduleRefreshJobDetail);
  });
  if (!drawerOpen) setDrawerOpen(false);
  void refreshAll();
  setInterval(() => { void refreshAll(); }, 3000);
</script>
</body>
</html>`;
};

export const translateAgentRunStartIntent = (
  intent: AgentRunStartIntent
): ReadonlyArray<RuntimeOp<AgentCmd>> => {
  const queueJobId = `${intent.agentId}_${intent.runId}_${Date.now().toString(36)}`;
  return [
    {
      type: "enqueue_job",
      job: {
        jobId: queueJobId,
        agentId: intent.agentId,
        lane: "collect",
        sessionKey: `${intent.agentId}:${intent.stream}`,
        singletonMode: "cancel",
        maxAttempts: 2,
        payload: {
          kind: `${intent.agentId}.run`,
          stream: intent.stream,
          runId: intent.runId,
          problem: intent.problem,
          config: intent.config,
        },
      },
    },
    {
      type: "redirect",
      header: "HX-Redirect",
      url: `/monitor?stream=${encodeURIComponent(intent.stream)}&run=${encodeURIComponent(intent.runId)}&job=${encodeURIComponent(queueJobId)}`,
    },
  ];
};

export const createMonitorRoute = (deps: MonitorRouteDeps): AgentRouteModule => {
  const { runtime, sse, enqueueJob, listJobs, getJob, queueCommand } = deps;

  return {
    id: "agent",
    kind: "run",
    paths: {
      shell: "/monitor",
      run: "/monitor/run",
      stream: "/monitor/stream",
      log: "/monitor/island/log",
      jobs: "/monitor/island/jobs",
      job: "/monitor/island/job",
      agents: "/monitor/island/agents",
      activity: "/monitor/island/activity",
      memory: "/monitor/island/memory",
      steer: "/monitor/job/:id/steer",
      followUp: "/monitor/job/:id/follow-up",
      abort: "/monitor/job/:id/abort",
    },
    register: (app: Hono) => {
      const shellHandler = async (c: Context) => {
        const stream = c.req.query("stream") ?? "agents/agent";
        const runParam = c.req.query("run");
        const jobParam = c.req.query("job");
        const chain = await runtime.chain(stream);
        const latest = getLatestAgentRunId(chain);
        const runId = runParam?.trim().length ? runParam.trim() : latest;
        const jobId = jobParam?.trim().length ? jobParam.trim() : undefined;
        return html(agentShell({ stream, runId, jobId }));
      };

      const logIslandHandler = async (c: Context) => {
        const stream = c.req.query("stream") ?? "agents/agent";
        const runParam = c.req.query("run");
        const indexChain = await runtime.chain(stream);
        const latest = getLatestAgentRunId(indexChain);
        const runId = runParam?.trim().length ? runParam.trim() : latest;
        if (!runId) return html("<p data-run-id=\"\">No runs yet.</p>");

        const runStream = agentRunStream(stream, runId);
        const runChain = await runtime.chain(runStream);
        const state = fold(runChain, reduceAgent, initialAgent);

        const lines = runChain
          .slice(-180)
          .map((receipt) => {
            const stamp = new Date(receipt.ts).toLocaleTimeString();
            return `<li><code>${escapeHtml(stamp)}</code> ${escapeHtml(summarizeEvent(receipt.body))}</li>`;
          })
          .join("");

        const finalResponse = state.finalResponse
          ? `<h3>Final Response</h3><pre>${escapeHtml(state.finalResponse)}</pre>`
          : "";

        return html(
          `<div class="log-wrap" data-run-id="${escapeHtml(runId)}">
            <div class="log-meta">
              <span class="chip">Status: ${escapeHtml(state.status)}${state.statusNote ? ` (${escapeHtml(state.statusNote)})` : ""}</span>
              <span class="chip">Iteration: ${state.iteration}</span>
            </div>
            ${finalResponse}
            <ul class="log-list">${lines || "<li>(no receipts)</li>"}</ul>
          </div>`
        );
      };

      const jobsIslandHandler = async (c: Context) => {
        const selectedParam = c.req.query("job")?.trim();
        const status = parseJobStatus(c.req.query("status"));
        const limitRaw = Number(c.req.query("limit") ?? 80);
        const limit = Number.isFinite(limitRaw)
          ? Math.max(1, Math.min(Math.floor(limitRaw), 240))
          : 80;
        const jobs = await listJobs({ status, limit });
        let selected = (
          selectedParam && jobs.some((job) => job.id === selectedParam)
            ? selectedParam
            : ""
        );
        const selectedJob = jobs.find((job) => job.id === selected);
        const selectedFollowUpJobId = selectedJob ? readJobFollowUpMeta(selectedJob).followUpJobId : undefined;
        if (selectedFollowUpJobId && jobs.some((job) => job.id === selectedFollowUpJobId)) {
          selected = selectedFollowUpJobId;
        }
        if (jobs.length === 0) {
          return html(`<div class="jobs-wrap" data-selected-job-id=""><p class="small muted">No jobs enqueued yet.</p></div>`);
        }
        const activeCount = jobs.filter((job) => !TERMINAL_JOB_STATUS.has(job.status)).length;
        const terminalCount = jobs.length - activeCount;
        const selectedActiveJob = jobs.find((job) => job.id === selected);
        const selectedRun = (
          selectedActiveJob && typeof selectedActiveJob.payload.runId === "string"
            ? selectedActiveJob.payload.runId
            : ""
        );
        const selectedStream = (
          selectedActiveJob && typeof selectedActiveJob.payload.stream === "string"
            ? selectedActiveJob.payload.stream
            : ""
        );
        const rows = jobs.map((job) => {
          const selectedClass = job.id === selected ? " is-selected" : "";
          const summary = summarizeJobPayload(job);
          const updatedLabel = formatClock(job.updatedAt);
          const statusClass = classForStatus(job.status);
          const idLabel = truncate(job.id, 28);
          const rowRun = typeof job.payload.runId === "string" ? job.payload.runId : "";
          const rowStream = typeof job.payload.stream === "string" ? job.payload.stream : "";
          const agentName = typeof job.payload.agentName === "string" ? job.payload.agentName : undefined;
          const agent = getAgentDisplayMeta(job.agentId, agentName);
          return `<tr class="job-row${selectedClass}">
            <td><button class="job-select mono" type="button" data-job-select="${escapeHtml(job.id)}" data-job-run="${escapeHtml(rowRun)}" data-job-stream="${escapeHtml(rowStream)}" title="${escapeHtml(job.id)}">${escapeHtml(idLabel)}</button></td>
            <td><span class="status-pill ${statusClass}">${escapeHtml(job.status)}</span></td>
            <td title="${escapeHtml(agent.rawId ?? agent.label)}">${escapeHtml(agent.label)}</td>
            <td class="mono">${job.attempt}/${job.maxAttempts}</td>
            <td class="mono" title="${escapeHtml(formatDateTime(job.updatedAt))}">${escapeHtml(updatedLabel)}</td>
            <td>${escapeHtml(truncate(summary, 72))}</td>
          </tr>`;
        }).join("");
        return html(`
          <div class="jobs-wrap" data-selected-job-id="${escapeHtml(selected)}" data-selected-run-id="${escapeHtml(selectedRun)}" data-selected-stream="${escapeHtml(selectedStream)}">
            <div class="jobs-meta">
              <span class="chip">Total: ${jobs.length}</span>
              <span class="chip">Active: ${activeCount}</span>
              <span class="chip">Terminal: ${terminalCount}</span>
            </div>
            <div class="table-wrap">
              <table class="jobs-table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Status</th>
                    <th>Agent</th>
                    <th>Attempt</th>
                    <th>Updated</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        `);
      };

      const jobIslandHandler = async (c: Context) => {
        const stream = c.req.query("stream") ?? "agents/agent";
        const run = c.req.query("run")?.trim();
        const requested = c.req.query("job")?.trim();
        const uiBase = "/monitor";
        let jobId = requested;
        if (!jobId) {
          const jobs = await listJobs({ limit: 80 });
          jobId = jobs.find((job) => !TERMINAL_JOB_STATUS.has(job.status))?.id ?? jobs[0]?.id;
        }
        if (!jobId) return html("<p class=\"small muted\">Select a job to inspect details and commands.</p>");
        const job = await getJob(jobId);
        if (!job) return html(`<p class="small muted">Job not found: <span class="mono">${escapeHtml(jobId)}</span></p>`);

        const params = new URLSearchParams({ stream });
        if (run) params.set("run", run);
        params.set("job", job.id);
        const commandQuery = `?${params.toString()}`;
        const steerUrl = `${uiBase}/job/${encodeURIComponent(job.id)}/steer${commandQuery}`;
        const followUpUrl = `${uiBase}/job/${encodeURIComponent(job.id)}/follow-up${commandQuery}`;
        const abortUrl = `${uiBase}/job/${encodeURIComponent(job.id)}/abort${commandQuery}`;

        const commandRows = job.commands.length > 0
          ? job.commands
            .slice(-12)
            .reverse()
            .map((cmd) => {
              const payload = cmd.payload ? truncate(JSON.stringify(cmd.payload), 140) : "";
              const consumed = cmd.consumedAt ? ` consumed ${formatClock(cmd.consumedAt)}` : " pending";
              return `<li><code>${escapeHtml(formatClock(cmd.createdAt))}</code> ${escapeHtml(cmd.command)} (${escapeHtml(cmd.lane)})${escapeHtml(consumed)}${payload ? ` - ${escapeHtml(payload)}` : ""}</li>`;
            })
            .join("")
          : "<li>(no queued commands)</li>";

        const payloadJson = escapeHtml(JSON.stringify(job.payload, null, 2));
        const resultJson = job.result ? escapeHtml(JSON.stringify(job.result, null, 2)) : "";
        const { followUpJobId, followUpRunId, failureClass, failure } = readJobFollowUpMeta(job);
        const lastError = job.lastError ? `<div class="detail-card"><div class="k">Last Error</div><div class="v mono">${escapeHtml(job.lastError)}</div></div>` : "";
        const failureJson = failure ? `<div><div class="k">Failure</div><pre>${escapeHtml(JSON.stringify(failure, null, 2))}</pre></div>` : "";
        const canceled = job.canceledReason
          ? `<div class="detail-card"><div class="k">Cancel Reason</div><div class="v">${escapeHtml(job.canceledReason)}</div></div>`
          : "";
        const followUpCards = [
          failureClass
            ? `<div class="detail-card"><div class="k">Failure Class</div><div class="v mono">${escapeHtml(failureClass)}</div></div>`
            : "",
          followUpJobId
            ? `<div class="detail-card"><div class="k">Follow-up Job</div><div class="v mono">${escapeHtml(followUpJobId)}</div></div>`
            : "",
          followUpRunId
            ? `<div class="detail-card"><div class="k">Follow-up Run</div><div class="v mono">${escapeHtml(followUpRunId)}</div></div>`
            : "",
        ].filter(Boolean).join("");
        const agentName = typeof job.payload.agentName === "string" ? job.payload.agentName : undefined;
        const agent = getAgentDisplayMeta(job.agentId, agentName);
        const agentValue = agent.rawId
          ? `${escapeHtml(agent.label)}<div class="small mono">${escapeHtml(agent.rawId)}</div>`
          : escapeHtml(agent.label);

        return html(`
          <div class="job-detail" data-job-id="${escapeHtml(job.id)}">
            <div class="detail-grid">
              <div class="detail-card"><div class="k">Job Id</div><div class="v mono">${escapeHtml(job.id)}</div></div>
              <div class="detail-card"><div class="k">Status</div><div class="v"><span class="status-pill ${classForStatus(job.status)}">${escapeHtml(job.status)}</span></div></div>
              <div class="detail-card"><div class="k">Agent</div><div class="v">${agentValue}</div></div>
              <div class="detail-card"><div class="k">Lane</div><div class="v mono">${escapeHtml(job.lane)}</div></div>
              <div class="detail-card"><div class="k">Attempt</div><div class="v mono">${job.attempt}/${job.maxAttempts}</div></div>
              <div class="detail-card"><div class="k">Updated</div><div class="v mono">${escapeHtml(formatDateTime(job.updatedAt))}</div></div>
              <div class="detail-card"><div class="k">Session</div><div class="v mono">${escapeHtml(job.sessionKey ?? "(none)")}</div></div>
              <div class="detail-card"><div class="k">Abort Requested</div><div class="v mono">${job.abortRequested ? "yes" : "no"}</div></div>
              ${followUpCards}
              ${lastError}
              ${canceled}
            </div>
            <div>
              <div class="k">Payload</div>
              <pre>${payloadJson}</pre>
            </div>
            ${resultJson
              ? `<div><div class="k">Result</div><pre>${resultJson}</pre></div>`
              : ""}
            ${failureJson}
            <div>
              <div class="k">Commands</div>
              <ul class="log-list">${commandRows}</ul>
            </div>
            <div id="monitor-command-status" class="command-status"></div>
            <form class="command-form" method="post" action="${steerUrl}" data-monitor-command-form>
              <strong>Steer Job</strong>
              <label>Problem override
                <textarea name="problem" placeholder="Replace the current problem statement"></textarea>
              </label>
              <label>Config JSON (optional)
                <textarea name="config" placeholder='{"maxIterations":4}'></textarea>
              </label>
              <button type="submit">Queue Steer</button>
            </form>
            <form class="command-form" method="post" action="${followUpUrl}" data-monitor-command-form>
              <strong>Follow-up</strong>
              <label>Note
                <textarea name="note" placeholder="Add follow-up guidance" required></textarea>
              </label>
              <button type="submit">Queue Follow-up</button>
            </form>
            <form class="command-form" method="post" action="${abortUrl}" data-monitor-command-form>
              <strong>Abort</strong>
              <label>Reason
                <input name="reason" value="abort requested" />
              </label>
              <button type="submit" class="warn">Abort Job</button>
            </form>
          </div>
        `);
      };

      const agentsIslandHandler = async (_c: Context) => {
        const jobs = await listJobs({ limit: 40 });
        const cards = MONITOR_AGENT_IDS.map((agentId) => {
          const agentJobs = jobs.filter((j) => j.agentId === agentId);
          const active = agentJobs.filter((j) => !TERMINAL_JOB_STATUS.has(j.status)).length;
          const total = agentJobs.length;
          const lastJob = agentJobs[0];
          const lastStatus = lastJob ? lastJob.status : "idle";
          const statusClass = lastJob ? classForStatus(lastJob.status) : "";
          const agent = getAgentDisplayMeta(agentId);
          return `<div class="agent-card">
            <div class="agent-card-head">
              <span class="agent-card-name">${escapeHtml(agent.label)}</span>
              <span class="status-pill ${statusClass}">${escapeHtml(active > 0 ? "active" : lastStatus)}</span>
            </div>
            ${agent.rawId ? `<div class="agent-card-stat mono">${escapeHtml(agent.rawId)}</div>` : ""}
            <div class="agent-card-stat">${total} jobs · ${active} active</div>
          </div>`;
        });
        return html(cards.join(""));
      };

      const activityIslandHandler = async (c: Context) => {
        const stream = c.req.query("stream") ?? "agents/agent";
        const chain = await runtime.chain(stream);
        const recent = chain.slice(-40).reverse();
        if (recent.length === 0) {
          return html(`<p class="small muted">No recent events.</p>`);
        }
        const items = recent.map((receipt) => {
          const ts = new Date(receipt.ts).toLocaleTimeString();
          const agentId = (receipt.body as { agentId?: string }).agentId ?? "";
          const agent = getAgentDisplayMeta(agentId);
          const summary = summarizeEvent(receipt.body);
          return `<li>
            <span class="activity-ts">${escapeHtml(ts)}</span>
            <span class="activity-body">${agentId ? `<span class="activity-agent" title="${escapeHtml(agent.rawId ?? agent.label)}">${escapeHtml(agent.label)}</span> ` : ""}${escapeHtml(summary)}</span>
          </li>`;
        }).join("");
        return html(`<ul class="activity-list">${items}</ul>`);
      };

      const memoryIslandHandler = async (c: Context) => {
        const scope = c.req.query("scope") ?? "agents/agent";
        const query = c.req.query("query")?.trim();
        const memory = deps.memoryTools;
        if (!memory) {
          return html(`<p class="small muted">Memory tools not available.</p>`);
        }
        const entries = query
          ? await memory.search({ scope, query, limit: 20 })
          : await memory.read({ scope, limit: 20 });
        if (entries.length === 0) {
          return html(`<p class="small muted">No entries${query ? ` matching "${escapeHtml(query)}"` : ""} in scope "${escapeHtml(scope)}".</p>`);
        }
        const items = entries.map((entry) => {
          const ts = new Date(entry.ts).toLocaleTimeString();
          const tagsHtml = entry.tags?.length
            ? `<div class="memory-tags">${entry.tags.map((t) => `<span class="memory-tag">${escapeHtml(t)}</span>`).join("")}</div>`
            : "";
          return `<li>
            <span class="memory-ts">${escapeHtml(ts)}</span>
            ${escapeHtml(truncate(entry.text, 200))}
            ${tagsHtml}
          </li>`;
        }).join("");
        return html(`<ul class="memory-list">${items}</ul>`);
      };

      const runHandler = async (c: Context) => {
        const formRaw = toFormRecord(await c.req.parseBody());
        const agentId = formRaw.agentId?.trim() || "agent";
        const stream = c.req.query("stream") ?? `agents/${agentId}`;
        const problem = formRaw.problem?.trim() ?? "";
        if (!problem) return text(400, "problem required");
        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const config = parseAgentConfig(formRaw);

        const ops = translateAgentRunStartIntent({
          agentId,
          stream,
          runId,
          problem,
          config,
        });

        const redirect = await executeRuntimeOps(ops, {
          fork: async () => {},
          emit: async () => {},
          startRun: async () => {},
          enqueueJob: async (op) => {
            await enqueueJob(op.job);
            sse.publish("jobs", op.job.jobId);
            sse.publish("receipt");
          },
          broadcast: async (op) => {
            sse.publish(op.topic, op.stream);
          },
        });

        if (!redirect) {
          return redirectResponse(buildShellUrl(stream, runId));
        }
        return redirectResponse(redirect.url, redirect.header);
      };

      const steerHandler = async (c: Context) => {
        const stream = c.req.query("stream") ?? "agents/agent";
        const run = c.req.query("run")?.trim();
        const viaFetch = c.req.header("X-Requested-With") === "fetch";
        const form = toFormRecord(await c.req.parseBody());
        const payload: Record<string, unknown> = {};
        const problem = form.problem?.trim();
        const configRaw = form.config?.trim();
        if (problem) payload.problem = problem;
        if (configRaw) {
          const parsed = parseJsonObject(configRaw);
          if (!parsed) return text(400, "config must be valid JSON object");
          payload.config = parsed;
        }
        if (Object.keys(payload).length === 0) return text(400, "provide problem and/or config");

        const jobId = c.req.param("id");
        if (!jobId) return text(400, "job id required");
        const queued = await queueCommand({
          jobId,
          command: "steer",
          payload,
          by: "agent.ui",
        });
        if (!queued) return text(404, "job not found");
        sse.publish("jobs", jobId);
        sse.publish("agent", stream);
        sse.publish("receipt");
        if (viaFetch) return text(202, "Steer command queued.");
        return redirectResponse(buildShellUrl(stream, run, jobId));
      };

      const followUpHandler = async (c: Context) => {
        const stream = c.req.query("stream") ?? "agents/agent";
        const run = c.req.query("run")?.trim();
        const viaFetch = c.req.header("X-Requested-With") === "fetch";
        const form = toFormRecord(await c.req.parseBody());
        const note = form.note?.trim();
        if (!note) return text(400, "note required");
        const jobId = c.req.param("id");
        if (!jobId) return text(400, "job id required");
        const queued = await queueCommand({
          jobId,
          command: "follow_up",
          payload: { note },
          by: "agent.ui",
        });
        if (!queued) return text(404, "job not found");
        sse.publish("jobs", jobId);
        sse.publish("agent", stream);
        sse.publish("receipt");
        if (viaFetch) return text(202, "Follow-up queued.");
        return redirectResponse(buildShellUrl(stream, run, jobId));
      };

      const abortHandler = async (c: Context) => {
        const stream = c.req.query("stream") ?? "agents/agent";
        const run = c.req.query("run")?.trim();
        const viaFetch = c.req.header("X-Requested-With") === "fetch";
        const form = toFormRecord(await c.req.parseBody());
        const reason = form.reason?.trim() || "abort requested";
        const jobId = c.req.param("id");
        if (!jobId) return text(400, "job id required");
        const queued = await queueCommand({
          jobId,
          command: "abort",
          payload: { reason },
          by: "agent.ui",
        });
        if (!queued) return text(404, "job not found");
        sse.publish("jobs", jobId);
        sse.publish("agent", stream);
        sse.publish("receipt");
        if (viaFetch) return text(202, "Abort command queued.");
        return redirectResponse(buildShellUrl(stream, run, jobId));
      };

      const streamHandler = async (c: Context) => {
        const stream = c.req.query("stream") ?? "agents/agent";
        return sse.subscribeMany(monitorSseSubscriptions(stream), c.req.raw.signal);
      };

      app.get("/monitor", shellHandler);
      app.get("/monitor/island/log", logIslandHandler);
      app.get("/monitor/island/jobs", jobsIslandHandler);
      app.get("/monitor/island/job", jobIslandHandler);
      app.get("/monitor/island/agents", agentsIslandHandler);
      app.get("/monitor/island/activity", activityIslandHandler);
      app.get("/monitor/island/memory", memoryIslandHandler);
      app.post(
        "/monitor/run",
        zValidator("form", agentRunFormSchema, (result) => {
          if (!result.success) return text(400, "problem required");
        }),
        runHandler
      );
      app.post("/monitor/job/:id/steer", steerHandler);
      app.post("/monitor/job/:id/follow-up", followUpHandler);
      app.post("/monitor/job/:id/abort", abortHandler);
      app.get("/monitor/stream", streamHandler);
    },
  };
};

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createMonitorRoute({
    runtime: ctx.runtimes.agent as Runtime<AgentCmd, AgentEvent, AgentState>,
    sse: ctx.sse,
    enqueueJob: ctx.enqueueJob,
    listJobs: ctx.queue.listJobs,
    getJob: ctx.queue.getJob,
    queueCommand: ctx.queue.queueCommand,
    memoryTools: ctx.helpers?.memoryTools as MemoryTools | undefined,
  });

export default factory;
