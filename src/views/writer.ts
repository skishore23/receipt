// ============================================================================
// Writer Guild UI - receipts only
// ============================================================================

import type { Branch, Chain } from "../core/types.js";
import { verify, computeHash } from "../core/chain.js";
import { formatLensMemory } from "../lib/memory.js";
import type { WriterEvent, WriterState } from "../modules/writer.js";
import { reduce as reduceWriter, initial as initialWriter } from "../modules/writer.js";
import { fold } from "../core/chain.js";
import { MiniGFM } from "@oblivionocean/minigfm";
import type { WriterRunSummary } from "../agents/writer.runs.js";
import {
  esc,
  truncate,
  frameworkCoordinationHtml,
  type FrameworkContextRow,
  type FrameworkLaneRow,
  type FrameworkTrailRow,
} from "./agent-framework.js";

const prettyKey = (key: string): string =>
  key.replace(/^[a-z]+\./, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

const md = new MiniGFM();

const renderMarkdown = (raw: string): string => {
  const text = raw.trim();
  if (!text) return `<div class="empty">Waiting for output...</div>`;
  return md.parse(text);
};

const contextWindowRows = (chain: Chain<WriterEvent>): ReadonlyArray<FrameworkContextRow> => {
  const promptEvents = chain
    .filter((r) => r.body.type === "prompt.context")
    .filter((r, idx, arr) => arr.findIndex((x) => x.hash === r.hash) === idx) as Array<{
      ts: number;
      body: Extract<WriterEvent, { type: "prompt.context" }>;
    }>;
  const recent = promptEvents.slice(-8).reverse();
  return recent.map((row, idx) => {
    const e = row.body;
    const title = e.title ?? (e.stepId ? `${prettyKey(e.stepId)} prompt` : "Prompt");
    const metaParts = [
      e.agentId ? prettyKey(e.agentId) : "System",
      e.stepId ? prettyKey(e.stepId) : "",
    ].filter(Boolean);
    const body = e.content.trim() || "No prompt content.";
    return {
      step: recent.length - idx,
      title,
      meta: metaParts.join(" · "),
      content: body,
      ts: row.ts,
    };
  });
};

// ============================================================================
// Shell
// ============================================================================

export const writerShell = (
  stream: string,
  examples: ReadonlyArray<{ id: string; label: string; problem: string }>,
  activeRun?: string,
  at?: number | null,
  branch?: string
): string => {
  const resumeQuery = activeRun
    ? [
        `stream=${encodeURIComponent(stream)}`,
        `run=${encodeURIComponent(activeRun)}`,
        branch ? `branch=${encodeURIComponent(branch)}` : "",
        at !== null && at !== undefined ? `at=${encodeURIComponent(String(at))}` : "",
      ].filter(Boolean).join("&")
    : "";
  const resumeUrl = activeRun ? `/writer/run?${resumeQuery}` : "";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt - Writer Guild</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
  <script src="/assets/htmx.min.js"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.1/sse.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
  <script>
    (function () {
      const renderMath = function (root) {
        const target = root instanceof HTMLElement ? root : document.body;
        const renderMathInElement = window.renderMathInElement;
        if (typeof renderMathInElement !== "function") return;

        target.querySelectorAll(".result-body, .chat-bubble").forEach(function (node) {
          if (!(node instanceof HTMLElement)) return;
          try {
            renderMathInElement(node, {
              delimiters: [
                { left: "$$", right: "$$", display: true },
                { left: "\\\\[", right: "\\\\]", display: true },
                { left: "$", right: "$", display: false },
                { left: "\\\\(", right: "\\\\)", display: false },
              ],
              throwOnError: false,
            });
          } catch (_err) {}
        });
      };

      window.receiptRenderMath = renderMath;
      document.addEventListener("DOMContentLoaded", function () {
        renderMath(document.body);
      });
      document.addEventListener("htmx:afterSwap", function (evt) {
        const target = evt && evt.target instanceof HTMLElement ? evt.target : document.body;
        renderMath(target);
      });
    })();
  </script>
  <style>
    :root {
      --bg: #0a0b0f;
      --ink: #f3f5f7;
      --muted: #9aa0ab;
      --line: rgba(255,255,255,0.08);
      --panel: rgba(16,18,24,0.9);
      --accent: #ffcc80;
      --accent-2: #8ddcff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--ink);
      background: radial-gradient(800px 520px at 70% 0%, rgba(80,70,40,0.2), transparent),
                  radial-gradient(700px 420px at 20% 80%, rgba(40,70,100,0.18), transparent),
                  var(--bg);
      min-height: 100vh;
    }
    .app {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr) 320px;
      min-height: 100vh;
    }
    .sidebar {
      padding: 18px 16px;
      border-right: 1px solid var(--line);
      background: rgba(10,12,18,0.85);
    }
    .brand { font-weight: 700; margin-bottom: 8px; }
    .brand-tag {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,204,128,0.5);
      color: rgba(255,204,128,0.9);
      background: rgba(255,204,128,0.12);
      margin-left: 6px;
    }
    .brand-sub { font-size: 11px; color: var(--muted); margin-bottom: 16px; }
    .nav-title {
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 10px 0;
    }
    .new-chat {
      width: 100%;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      color: var(--ink);
      border-radius: 10px;
      padding: 10px 12px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: 16px;
    }
    .folds { display: grid; gap: 10px; }
    .main { padding: 22px 24px; }
    .controls {
      display: grid;
      gap: 10px;
      padding: 16px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: var(--panel);
    }
    .controls-title { font-weight: 600; font-size: 13px; }
    .controls-sub { font-size: 11px; color: rgba(255,255,255,0.55); }
    .controls form { display: grid; gap: 10px; }
    .controls form.resume-form { display: flex; justify-content: flex-end; align-items: center; }
    .controls textarea {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 12px 14px;
      color: var(--ink);
      font-size: 14px;
      min-height: 72px;
      resize: vertical;
    }
    .run-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
    .run-controls label { font-size: 11px; color: rgba(255,255,255,0.6); display: grid; gap: 4px; }
    .run-controls input {
      width: 86px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      padding: 6px 8px;
      color: var(--ink);
      font-size: 12px;
    }
    .run-controls button {
      border: none;
      background: linear-gradient(120deg, rgba(255,204,128,0.35), rgba(141,220,255,0.35));
      color: var(--ink);
      border-radius: 10px;
      padding: 8px 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .resume-form button {
      border: none;
      background: rgba(255,255,255,0.08);
      color: var(--ink);
      border-radius: 10px;
      padding: 8px 14px;
      font-weight: 600;
      cursor: pointer;
      width: fit-content;
    }
    .resume-form { margin-top: 4px; }
    .examples { display: flex; flex-wrap: wrap; gap: 8px; }
    .examples button {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      color: var(--muted);
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      cursor: pointer;
    }
    .run-area { margin-top: 16px; display: grid; gap: 16px; }
    .travel-island {
      margin-top: 16px;
      margin-bottom: 20px;
      min-height: 90px;
      border-radius: 14px;
      border: 1px solid rgba(255,204,128,0.3);
      background: linear-gradient(120deg, rgba(255,204,128,0.16), rgba(141,220,255,0.12));
      padding: 14px;
    }
    .travel-hero { display: grid; gap: 10px; }
    .travel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .travel-title { font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
    .travel-pill {
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.22);
      padding: 3px 8px;
      color: rgba(255,255,255,0.8);
      background: rgba(255,255,255,0.06);
    }
    .travel-pill.live {
      border-color: rgba(110,243,160,0.55);
      color: rgba(110,243,160,0.95);
      background: rgba(110,243,160,0.12);
    }
    .travel-pill.past {
      border-color: rgba(255,211,106,0.55);
      color: rgba(255,211,106,0.95);
      background: rgba(255,211,106,0.12);
    }
    .travel-meta { font-size: 12px; color: rgba(255,255,255,0.72); }
    .travel-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
    }
    .travel-actions { display: inline-flex; gap: 8px; }
    .travel-btn {
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 9px;
      padding: 6px 10px;
      font-size: 11px;
      color: var(--ink);
      background: rgba(255,255,255,0.08);
      white-space: nowrap;
      cursor: pointer;
    }
    .travel-btn[disabled],
    .travel-btn.disabled {
      pointer-events: none;
      opacity: 0.35;
    }
    .travel-scrub { min-width: 0; }
    .travel-slider {
      width: 100%;
      accent-color: #ffcc80;
    }
    .travel-step { font-size: 11px; color: rgba(255,255,255,0.75); white-space: nowrap; }
    .activity { padding: 18px 16px; border-left: 1px solid var(--line); background: rgba(10,12,18,0.85); }
    .empty { color: var(--muted); font-size: 12px; }
    @media (max-width: 1100px) {
      .app { grid-template-columns: 220px minmax(0, 1fr); }
      .activity { display: none; }
    }
    @media (max-width: 860px) {
      .app { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--line); }
    }
  </style>
</head>
<body hx-ext="sse" sse-connect="/writer/stream?stream=${encodeURIComponent(stream)}">
  <div class="app">
    <aside class="sidebar">
      <div class="brand">Writer Guild <span class="brand-tag">multi-agent</span></div>
      <div class="brand-sub">Planner-driven writing, receipts only.</div>
      <div class="nav-title">Runs</div>
      <button class="new-chat" type="button" onclick="window.location.href='/writer?stream=${encodeURIComponent(stream)}&run=new'">+ New Run</button>
      <div id="wg-folds"
           class="folds"
           hx-get="/writer/island/folds?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:writer-refresh throttle:800ms"
           hx-swap="innerHTML">
        <div class="empty">Loading runs...</div>
      </div>
    </aside>

    <main class="main">
      <div id="wg-travel"
           class="travel-island"
           hx-get="/writer/island/travel?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&branch=${encodeURIComponent(branch ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:writer-refresh throttle:700ms"
           hx-swap="innerHTML">
        <div class="empty">Loading time travel...</div>
      </div>

      <div class="controls">
        <div class="controls-title">Multi-agent writing run</div>
        <div class="controls-sub">Parallel research, critique, and revision are planned via receipts.</div>
        <form hx-post="/writer/run?stream=${encodeURIComponent(stream)}" hx-swap="none">
          <textarea name="problem" id="wg-problem" placeholder="Paste a brief or writing task for the guild..." required></textarea>
          <div class="run-controls">
            <label>
              <span>Parallel</span>
              <input type="number" name="parallel" min="1" max="6" value="3" />
            </label>
            <button>Run writer guild</button>
          </div>
        </form>
        <div class="examples">
          ${examples.map(ex => `<button type="button" data-problem="${esc(ex.problem)}">${esc(ex.label)}</button>`).join("")}
        </div>
        ${activeRun
          ? `<form class="resume-form" hx-post="${resumeUrl}" hx-swap="none">
              <input type="hidden" name="append" id="wg-resume-append" />
              <button type="submit">Resume current run</button>
            </form>`
          : ""}
      </div>

      <div class="run-area" id="wg-chat"
           hx-get="/writer/island/chat?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&branch=${encodeURIComponent(branch ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:writer-refresh throttle:1200ms"
           hx-swap="innerHTML">
        <div class="empty">Loading run...</div>
      </div>
    </main>

    <aside class="activity" id="wg-side"
           hx-get="/writer/island/side?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&branch=${encodeURIComponent(branch ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:writer-refresh throttle:800ms"
           hx-swap="innerHTML">
      <div class="empty">Loading panels...</div>
    </aside>
  </div>

  <script>
    (() => {
      const input = document.getElementById("wg-problem");
      document.querySelectorAll(".examples button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const problem = btn.getAttribute("data-problem");
          if (problem && input) input.value = problem;
        });
      });
      const resumeForm = document.querySelector(".resume-form");
      const resumeAppend = document.getElementById("wg-resume-append");
      if (resumeForm && input && resumeAppend) {
        resumeForm.addEventListener("submit", () => {
          resumeAppend.value = input.value || "";
        });
      }
    })();
  </script>
</body>
</html>`;
};

// ============================================================================
// Folds
// ============================================================================

export const writerFoldsHtml = (
  stream: string,
  runs: ReadonlyArray<WriterRunSummary>,
  activeRun?: string,
  at?: number | null
): string => {
  if (runs.length === 0) return `<div class="empty">No runs yet.</div>`;

  const items = runs.map((run) => {
    const active = run.runId === activeRun;
    const statusClass = run.status === "done"
      ? "done"
      : run.status === "failed"
        ? "failed"
        : "running";
    const when = run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "-";
    return `<a class="fold-item ${active ? "active" : ""} ${statusClass}"
      href="/writer?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(run.runId)}&at=${encodeURIComponent(String(at ?? ""))}">
      <div class="fold-head">
        <span class="fold-dot ${statusClass}"></span>
        <span class="fold-title">${esc(truncate(run.problem || run.runId, 30))}</span>
      </div>
      <div class="fold-meta">${esc(when)} - ${run.count} receipts</div>
    </a>`;
  }).join("");

  return `<div class="fold-list">${items}</div>
  <style>
    .fold-list { display: grid; gap: 10px; }
    .fold-item {
      display: grid;
      gap: 6px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.7);
      text-decoration: none;
      color: inherit;
    }
    .fold-item.active { border-color: rgba(255,204,128,0.55); }
    .fold-head { display: flex; align-items: center; gap: 8px; }
    .fold-dot { width: 8px; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.2); }
    .fold-dot.done { background: rgba(110,243,160,0.8); }
    .fold-dot.running { background: rgba(255,204,128,0.8); }
    .fold-dot.failed { background: rgba(255,107,107,0.85); }
    .fold-title { font-size: 12px; font-weight: 600; }
    .fold-meta { font-size: 11px; color: rgba(255,255,255,0.5); }
  </style>`;
};

export const writerTravelHtml = (opts: {
  readonly stream: string;
  readonly runId?: string;
  readonly branch?: string;
  readonly at: number | null | undefined;
  readonly total: number;
}): string => {
  const { stream, runId, branch, at, total } = opts;
  if (!runId) {
    return `<div class="travel-hero">
      <div class="travel-head">
        <div class="travel-title">Time travel</div>
        <div class="travel-pill">idle</div>
      </div>
      <div class="travel-meta">Select a run to replay how planner and agents produced the draft.</div>
    </div>`;
  }

  const maxAt = Math.max(0, total);
  const currentAt = at === null || at === undefined ? maxAt : Math.max(0, Math.min(at, maxAt));
  const isPast = currentAt < maxAt;
  const params = (nextAt?: number | null): string => {
    const q = new URLSearchParams({ stream, run: runId });
    if (branch) q.set("branch", branch);
    if (nextAt !== undefined && nextAt !== null && nextAt < maxAt) q.set("at", String(nextAt));
    return `/writer/travel?${q.toString()}`;
  };
  const atStart = currentAt <= 0;
  const atHead = currentAt >= maxAt;

  return `<div class="travel-hero">
    <div class="travel-head">
      <div class="travel-title">Time travel</div>
      <div class="travel-pill ${isPast ? "past" : "live"}">${isPast ? "past view" : "live head"}</div>
    </div>
    <div class="travel-meta">Scrub the receipt chain to inspect exactly when planner decisions, context slices, and revisions were emitted.</div>
    <div class="travel-row">
      <div class="travel-actions">
        <button type="button" class="travel-btn" ${atStart ? "disabled" : ""}
          hx-get="${params(0)}" hx-swap="none">Start</button>
        <button type="button" class="travel-btn" ${atStart ? "disabled" : ""}
          hx-get="${params(Math.max(0, currentAt - 1))}" hx-swap="none">Back</button>
        <button type="button" class="travel-btn" ${atHead ? "disabled" : ""}
          hx-get="${params(Math.min(maxAt, currentAt + 1))}" hx-swap="none">Forward</button>
        <button type="button" class="travel-btn" ${atHead ? "disabled" : ""}
          hx-get="${params(null)}" hx-swap="none">Live</button>
      </div>
      <form class="travel-scrub">
        <input type="hidden" name="stream" value="${esc(stream)}" />
        <input type="hidden" name="run" value="${esc(runId)}" />
        ${branch ? `<input type="hidden" name="branch" value="${esc(branch)}" />` : ""}
        <input class="travel-slider" type="range" min="0" max="${maxAt}" value="${currentAt}" name="at"
          hx-get="/writer/travel" hx-include="closest form" hx-trigger="change delay:90ms" hx-swap="none" />
      </form>
      <div class="travel-step">Step ${currentAt} / ${maxAt}</div>
    </div>
  </div>`;
};

// ============================================================================
// Chat
// ============================================================================

export const writerChatHtml = (chain: Chain<WriterEvent>): string => {
  if (chain.length === 0) return `<div class="empty">No run selected.</div>`;

  const state = fold(chain, reduceWriter, initialWriter);
  const seenHashes = new Set<string>();
  type LaneSnapshot = {
    status?: "running" | "idle" | "done" | "failed";
    phase?: string;
    action?: string;
    updatedAt: number;
  };
  const lanes = new Map<string, LaneSnapshot>();
  const trail: FrameworkTrailRow[] = [];
  const stepAgent = new Map((state.planner.plan ?? []).map((step) => [step.id, step.agentId]));
  let problemText = "";
  let latestFinal: { content: string; confidence: number } | null = null;
  let runStatus: "running" | "failed" | "completed" | null = null;
  let runNote: string | undefined;
  let lastEventTs = 0;

  const laneName = (id: string): string => prettyKey(id);
  const touchLane = (id: string, patch: Partial<LaneSnapshot>, ts: number) => {
    const prev = lanes.get(id) ?? { updatedAt: ts };
    lanes.set(id, { ...prev, ...patch, updatedAt: Math.max(prev.updatedAt, ts) });
  };
  const pushTrail = (next: FrameworkTrailRow) => {
    const prev = trail[trail.length - 1];
    if (prev && prev.body === next.body && prev.agent === next.agent) return;
    trail.push(next);
  };

  for (const r of chain) {
    if (seenHashes.has(r.hash)) continue;
    seenHashes.add(r.hash);
    lastEventTs = r.ts;

    const e = r.body;
    switch (e.type) {
      case "problem.set":
        problemText = e.problem;
        pushTrail({ kind: "status", agent: "Orchestrator", body: "Run initialized with brief.", ts: r.ts });
        touchLane("orchestrator", { status: "running", phase: "planning", action: "Initialized run" }, r.ts);
        break;
      case "problem.appended":
        pushTrail({ kind: "status", agent: "Orchestrator", body: "Appended extra context to brief.", ts: r.ts });
        break;
      case "state.patch":
        const patchKeys = Object.keys(e.patch).filter((key) => key !== "problem");
        if (patchKeys.length > 0) {
          const owner = e.stepId ? (stepAgent.get(e.stepId) ?? e.stepId) : "orchestrator";
          touchLane(owner, {
            status: "running",
            phase: e.stepId ? prettyKey(e.stepId) : "working",
            action: `Produced ${patchKeys.map(prettyKey).join(", ")}`,
          }, r.ts);
          pushTrail({
            kind: "patch",
            agent: laneName(owner),
            body: `Updated state: ${patchKeys.map(prettyKey).join(", ")}.`,
            ts: r.ts,
          });
        }
        break;
      case "solution.finalized":
        latestFinal = { content: e.content, confidence: e.confidence };
        touchLane(e.agentId, {
          status: "done",
          phase: "finalize",
          action: `Finalized output (${e.confidence.toFixed(2)})`,
        }, r.ts);
        pushTrail({
          kind: "summary",
          agent: laneName(e.agentId),
          body: `Final draft emitted (confidence ${e.confidence.toFixed(2)}).`,
          ts: r.ts,
        });
        break;
      case "run.status":
        runStatus = e.status;
        runNote = e.note;
        touchLane("orchestrator", {
          status: e.status === "failed" ? "failed" : e.status === "completed" ? "done" : "running",
          phase: "orchestration",
          action: e.note ?? `Run marked ${e.status}`,
        }, r.ts);
        pushTrail({
          kind: "status",
          agent: "Orchestrator",
          body: `Run marked ${e.status}${e.note ? ` (${e.note})` : ""}.`,
          ts: r.ts,
        });
        break;
      case "step.ready": {
        const owner = stepAgent.get(e.stepId) ?? e.stepId;
        touchLane(owner, { status: "idle", phase: prettyKey(e.stepId), action: "Ready to run" }, r.ts);
        pushTrail({ kind: "status", agent: laneName(owner), body: `${prettyKey(e.stepId)} ready.`, ts: r.ts });
        break;
      }
      case "step.started": {
        const owner = e.agentId ?? stepAgent.get(e.stepId) ?? e.stepId;
        touchLane(owner, { status: "running", phase: prettyKey(e.stepId), action: "Running step" }, r.ts);
        pushTrail({ kind: "status", agent: laneName(owner), body: `Started ${prettyKey(e.stepId)}.`, ts: r.ts });
        break;
      }
      case "step.completed": {
        const owner = e.agentId ?? stepAgent.get(e.stepId) ?? e.stepId;
        touchLane(owner, {
          status: "done",
          phase: prettyKey(e.stepId),
          action: e.outputs.length ? `Outputs: ${e.outputs.map(prettyKey).join(", ")}` : "Step completed",
        }, r.ts);
        pushTrail({
          kind: "summary",
          agent: laneName(owner),
          body: `${prettyKey(e.stepId)} completed${e.outputs.length ? ` (${e.outputs.map(prettyKey).join(", ")})` : ""}.`,
          ts: r.ts,
        });
        break;
      }
      case "step.failed": {
        const owner = e.agentId ?? stepAgent.get(e.stepId) ?? e.stepId;
        touchLane(owner, {
          status: "failed",
          phase: prettyKey(e.stepId),
          action: e.error ?? "Step failed",
        }, r.ts);
        pushTrail({
          kind: "status",
          agent: laneName(owner),
          body: `${prettyKey(e.stepId)} failed${e.error ? ` (${e.error})` : ""}.`,
          ts: r.ts,
        });
        break;
      }
      case "plan.configured":
        pushTrail({
          kind: "parallel",
          agent: "Planner",
          body: `Plan configured with ${e.steps.length} steps.`,
          ts: r.ts,
        });
        break;
      case "plan.completed":
        pushTrail({ kind: "summary", agent: "Planner", body: "Planner marked run complete.", ts: r.ts });
        break;
      case "plan.failed":
        pushTrail({
          kind: "status",
          agent: "Planner",
          body: `Planner failed${e.note ? ` (${e.note})` : ""}.`,
          ts: r.ts,
        });
        break;
      default:
        break;
    }
  }

  const resultStatus = runStatus === "failed"
    ? "Failed"
    : latestFinal || runStatus === "completed"
      ? "Completed"
      : "Running";
  const resultBody = latestFinal?.content?.trim()
    || (runStatus === "failed" ? (runNote ?? "Run failed.") : "Waiting for final output...");
  const resultBodyHtml = latestFinal
    ? renderMarkdown(resultBody)
    : `<div class="empty">${esc(resultBody)}</div>`;
  const contextRows = contextWindowRows(chain);
  const contextCount = contextRows.length;
  const coordCount = trail.length;
  const activeLane = [...lanes.entries()]
    .sort((a, b) => {
      const aRunning = a[1].status === "running" ? 1 : 0;
      const bRunning = b[1].status === "running" ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return b[1].updatedAt - a[1].updatedAt;
    })[0];
  const nowLabel = activeLane
    ? `${laneName(activeLane[0])} · ${activeLane[1].phase ?? "working"}`
    : runStatus === "failed"
      ? (runNote ?? "Run failed")
      : resultStatus === "Completed"
        ? "Run completed"
        : "Waiting for planner receipt";
  const laneRows: ReadonlyArray<FrameworkLaneRow> = [...lanes.entries()]
    .sort((a, b) => {
      const aRunning = a[1].status === "running" ? 1 : 0;
      const bRunning = b[1].status === "running" ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return b[1].updatedAt - a[1].updatedAt;
    })
    .map(([id, lane]) => ({
      agent: laneName(id),
      phase: lane.phase,
      status: lane.status ?? "idle",
      action: lane.action ?? "Waiting for assignment.",
    }));
  const trailRows: ReadonlyArray<FrameworkTrailRow> = trail.slice(-14).map((entry, idx, arr) => ({
    ...entry,
    step: arr.length - idx,
  }));
  const streamModeLabel = runStatus === "running"
    ? "Lanes and trail update after each completed receipt. Token-by-token model streaming is currently disabled."
    : "Showing receipt replay for this run slice.";
  const clockLabel = lastEventTs ? new Date(lastEventTs).toLocaleTimeString() : "—";

  return `<div class="chat-stack">
    ${problemText ? `<div class="chat-row user">
      <div class="chat-label">You</div>
      <div class="chat-bubble">${esc(problemText)}</div>
    </div>` : ""}

    <div class="result-card">
      <div class="result-head">
        <div class="result-title">Final draft</div>
        <div class="result-pill">${esc(resultStatus)}</div>
      </div>
      <div class="result-body">${resultBodyHtml}</div>
    </div>

    ${frameworkCoordinationHtml({
      palette: "writer",
      metricsTitle: "Coordination status",
      clockLabel,
      metrics: [
        { key: "Run", value: resultStatus },
        { key: "Now", value: nowLabel },
        { key: "Coord receipts", value: String(coordCount) },
        { key: "Prompt slices", value: String(contextCount) },
      ],
      contextTitle: "What Each Agent Saw",
      contextSubtitle: "Prompt/context snapshots sent to each agent before they generated a step.",
      contextNote: "Exact receipt-backed prompt slices (brief + plan outputs). System prompt omitted.",
      contextRows,
      boardTitle: "How Multi-Agent Coordination Happened",
      boardSubtitle: `${streamModeLabel} Lanes show current agent status and action. Trail shows ordered coordination receipts.`,
      lanes: laneRows,
      trail: trailRows,
    })}
  </div>
  <style>
    .chat-stack { display: grid; gap: 18px; }
    .chat-row { display: grid; gap: 6px; }
    .chat-row.user { justify-items: end; }
    .chat-label { font-size: 11px; color: rgba(255,255,255,0.55); }
    .chat-bubble {
      max-width: 78%;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.75);
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
    }
    .chat-row.user .chat-bubble {
      background: rgba(255,204,128,0.16);
      border-color: rgba(255,204,128,0.4);
    }
    .result-card {
      border-radius: 16px;
      border: 1px solid rgba(255,204,128,0.35);
      background: linear-gradient(140deg, rgba(255,204,128,0.12), rgba(141,220,255,0.08));
      padding: 16px 18px;
      display: grid;
      gap: 10px;
    }
    .result-head { display: flex; justify-content: space-between; align-items: center; }
    .result-title { font-weight: 600; font-size: 14px; }
    .result-pill {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      border-radius: 999px;
      padding: 3px 8px;
      border: 1px solid rgba(255,204,128,0.4);
      color: rgba(255,204,128,0.9);
    }
    .result-body { font-size: 13px; line-height: 1.6; color: rgba(255,255,255,0.92); }
    .result-body h1, .result-body h2, .result-body h3 { margin: 12px 0 6px; font-size: 14px; }
    .result-body p { margin: 6px 0; }
    .result-body ul { margin: 6px 0 8px 18px; padding: 0; }
    .result-body li { margin: 4px 0; }
    .result-body code {
      font-family: "IBM Plex Mono", monospace;
      background: rgba(255,255,255,0.06);
      padding: 0 4px;
      border-radius: 6px;
    }
    .result-body pre {
      font-family: "IBM Plex Mono", monospace;
      font-size: 12px;
      white-space: pre-wrap;
      padding: 10px 12px;
      margin: 8px 0;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.65);
    }
  </style>`;
};

// ============================================================================
// Side panel
// ============================================================================

const collabFeedHtml = (
  chain: Chain<WriterEvent>,
  plan: ReadonlyArray<{ id: string; agentId?: string }>,
  team: ReadonlyArray<{ id: string; name: string }>
): string => {
  const nameFor = (agentId?: string): string => {
    if (!agentId) return "System";
    const member = team.find((t) => t.id === agentId);
    return member?.name ?? prettyKey(agentId);
  };
  const stepAgent = new Map(plan.map((p) => [p.id, p.agentId]));

  type FeedItem = { ts: number; agent: string; kind: string; body: string; stream: string };
  const items: FeedItem[] = [];

  for (const r of chain) {
    const e = r.body;
    switch (e.type) {
      case "problem.set":
        items.push({ ts: r.ts, agent: "Orchestrator", kind: "Brief", body: e.problem, stream: r.stream });
        break;
      case "problem.appended":
        items.push({ ts: r.ts, agent: "Orchestrator", kind: "Context", body: e.append, stream: r.stream });
        break;
      case "state.patch": {
        const entries = Object.entries(e.patch ?? {});
        if (entries.length === 0) break;
        const [key, value] = entries[0];
        const agentId = e.stepId ? stepAgent.get(e.stepId) : undefined;
        items.push({
          ts: r.ts,
          agent: nameFor(agentId ?? e.stepId),
          kind: prettyKey(key),
          body: value,
          stream: r.stream,
        });
        break;
      }
      case "solution.finalized":
        items.push({ ts: r.ts, agent: nameFor(e.agentId), kind: "Final", body: e.content, stream: r.stream });
        break;
      case "step.failed":
        if (e.error) {
          items.push({
            ts: r.ts,
            agent: nameFor(e.agentId ?? e.stepId),
            kind: "Failed",
            body: e.error,
            stream: r.stream,
          });
        }
        break;
      default:
        break;
    }
  }

  const recent = items.slice(-8).reverse();
  if (recent.length === 0) return `<div class="empty">No collaboration yet.</div>`;

  return recent.map((item, idx) => {
    const isBranch = item.stream.includes("/branches/");
    const body = truncate(item.body.trim(), 220);
    return `<div class="feed-item${idx === 0 ? " latest" : ""}">
      <div class="feed-meta">
        <div class="feed-agent">${esc(item.agent)}</div>
        <div class="feed-tags">
          <span class="feed-kind">${esc(item.kind)}</span>
          ${isBranch ? `<span class="feed-branch">branch</span>` : ""}
        </div>
      </div>
      <div class="feed-body">${esc(body || "…")}</div>
    </div>`;
  }).join("");
};

export const writerSideHtml = (
  state: WriterState,
  chain: Chain<WriterEvent>,
  at: number | null | undefined,
  _total: number,
  indexStream: string,
  runId?: string,
  team: ReadonlyArray<{ id: string; name: string }> = [],
  chainStream?: string,
  branchStream?: string,
  branches: ReadonlyArray<Branch> = [],
  activityChain?: Chain<WriterEvent>
): string => {
  const activitySource = activityChain ?? chain;
  const steps = state.planner.plan ?? [];
  const runStream = runId ? `${indexStream}/runs/${runId}` : indexStream;
  const branchPrefix = `${runStream}/branches/`;
  const relevantBranches = branches.filter((b) => b.name.startsWith(branchPrefix));
  const branchLabel = (b: Branch): string =>
    b.name.startsWith(branchPrefix) ? b.name.slice(branchPrefix.length) : b.name;
  const branchOptions = [
    { value: "", label: "Main run" },
    ...relevantBranches.map((b) => ({ value: b.name, label: branchLabel(b) })),
  ]
    .filter((opt, i, arr) => arr.findIndex((x) => x.value === opt.value) === i)
    .map((opt) => `<option value="${esc(opt.value)}"${opt.value === (branchStream ?? "") ? " selected" : ""}>${esc(opt.label)}</option>`)
    .join("");

  const activeStep = steps.find((step) => state.planner.steps[step.id]?.status === "running");
  const activeAgentId = activeStep?.agentId;
  const stepItems = steps.map((step) => {
    const status = state.planner.steps[step.id]?.status ?? "pending";
    const isActive = status === "running";
    return `<div class="plan-step ${isActive ? "active" : ""} ${status}">
      <span class="dot ${status}"></span>
      <span>${esc(step.id)}</span>
      <span class="tag ${status}">${esc(status)}</span>
    </div>`;
  }).join("");

  const outputKeys = Object.keys(state.planner.outputs).filter((k) => k !== "problem");
  const outputs = outputKeys
    .map((k) => `<div class="metric-item">${esc(prettyKey(k))}</div>`)
    .join("");

  const agentRows = team.map((t) => {
    const active = t.id === activeAgentId;
    return `<div class="metric-item ${active ? "active" : ""}">${esc(t.name)}${active ? " · working" : ""}</div>`;
  }).join("");

  const integrity = verify(chain);
  const integrityLabel = integrity.ok
    ? "ok"
    : chain.length && chain[0].hash === computeHash(chain[0])
      ? "ok (slice)"
      : "broken";
  const effectiveRun = runId ?? state.runId ?? "";
  const isBranch = Boolean(branchStream);
  const activeChainStream = chainStream ?? runStream;
  const branchItems = relevantBranches
    .map((b) => `<div class="branch-item" title="${esc(b.name)}">${esc(branchLabel(b))}${b.forkAt !== undefined ? ` - r${b.forkAt}` : ""}</div>`)
    .join("");
  const brief = state.problem.trim();
  const outputToStep = new Map<string, string>();
  steps.forEach((step) => step.outputs.forEach((out) => outputToStep.set(out, step.id)));
  const stepLabels = Object.fromEntries(steps.map((step) => [step.id, prettyKey(step.id)]));
  const stepAgents = new Map(steps.map((step) => [step.id, step.agentId]));
  const outputEvents = new Map<string, { content: string; ts: number; stepId?: string }>();
  chain.forEach((r) => {
    const e = r.body;
    if (e.type !== "state.patch") return;
    for (const [key, value] of Object.entries(e.patch ?? {})) {
      if (key === "problem") continue;
      outputEvents.set(key, { content: value, ts: r.ts, stepId: e.stepId });
    }
  });
  const memoryItems = [...outputEvents.entries()].map(([key, info]) => ({
    kind: key,
    content: info.content,
    agentId: info.stepId ? stepAgents.get(info.stepId) : undefined,
    ts: info.ts,
  }));
  const memoryParts = memoryItems.length
    ? formatLensMemory(memoryItems, {
        lens: steps.length
          ? { label: "Plan lens", order: steps.map((step) => step.id), labels: stepLabels }
          : undefined,
        podForItem: (item) => outputToStep.get(item.kind),
        formatItem: (item) => `${prettyKey(item.kind)}: ${item.content}`,
      })
    : [];
  const memoryText = memoryParts.join("\n\n").trim();
  const configMetrics = state.config
    ? [
        `Workflow: ${state.config.workflowId}@${state.config.workflowVersion}`,
        `Model: ${state.config.model}`,
        `Prompt hash: ${state.config.promptHash ? state.config.promptHash.slice(0, 8) : "n/a"}`,
        `Max parallel: ${state.config.maxParallel}`,
      ]
    : [];
  const statusLabel = state.status.slice(0, 1).toUpperCase() + state.status.slice(1);
  const plannerStatus = state.planner.status ?? "pending";
  const statusItems = [
    `Run: ${statusLabel}`,
    `Planner: ${plannerStatus}`,
    state.statusNote ? `Note: ${state.statusNote}` : "",
    state.planner.failureNote ? `Planner note: ${state.planner.failureNote}` : "",
    state.solution ? `Final confidence: ${state.solution.confidence.toFixed(2)}` : "Final confidence: —",
  ].filter(Boolean);
  const streamItems = [
    `Index: ${indexStream}`,
    `Run: ${runStream}`,
    `View: ${activeChainStream}${isBranch ? " (branch)" : ""}`,
    `Branches: ${relevantBranches.length}`,
  ];
  const metrics = [
    ...configMetrics,
    `Receipts: ${chain.length}`,
    `Plan steps: ${steps.length}`,
    `Planner outputs: ${outputKeys.length}`,
    `Integrity: ${integrityLabel}`,
  ].filter(Boolean);
  const collaborationFeed = collabFeedHtml(activitySource, steps, team);

  return `<div class="side-stack">
    <section class="side-card">
      <h2>Status</h2>
      <div class="meta-list">${statusItems.map((item) => `<div class="meta-item">${esc(item)}</div>`).join("")}</div>
    </section>

    <section class="side-card">
      <h2>Streams</h2>
      <div class="stream-pill">${esc(isBranch ? "Branch view" : "Run view")}</div>
      <div class="branch-selector">
        <label>
          <span>View branch</span>
          <select onchange="(function(sel){ const params = new URLSearchParams(window.location.search); params.set('stream', '${esc(indexStream)}'); params.set('run', '${esc(effectiveRun)}'); if (sel.value) params.set('branch', sel.value); else params.delete('branch'); params.set('at', '${esc(String(at ?? ""))}'); window.location.search = '?' + params.toString(); })(this)">
            ${branchOptions || `<option value="">Main run</option>`}
          </select>
        </label>
      </div>
      <div class="metric-list compact">${streamItems.map((item) => `<div class="metric-item">${esc(item)}</div>`).join("")}</div>
      <div class="branch-list">${branchItems || `<div class="empty">No branch streams yet.</div>`}</div>
    </section>

    <section class="side-card">
      <h2>Team</h2>
      <div class="metric-list">${agentRows || `<div class="empty">No agents yet.</div>`}</div>
    </section>

    <section class="side-card">
      <h2>Shared Brief</h2>
      <div class="brief-body">${esc(truncate(brief || "No brief yet.", 240))}</div>
    </section>

    <section class="side-card">
      <h2>Shared Memory</h2>
      <div class="memory-body">${esc(truncate(memoryText || "Memory not built yet.", 420))}</div>
    </section>

    <section class="side-card">
      <h2>Plan</h2>
      <div class="plan-list">${stepItems || `<div class="empty">Plan pending.</div>`}</div>
    </section>

    <section class="side-card">
      <h2>Activity</h2>
      <div class="feed-list">${collaborationFeed}</div>
    </section>

    <section class="side-card">
      <h2>Outputs</h2>
      <div class="metric-list">${outputs || `<div class="empty">No outputs yet.</div>`}</div>
    </section>

    <section class="side-card">
      <h2>Metrics</h2>
      <div class="metric-list">${metrics.map((m) => `<div class="metric-item">${esc(m)}</div>`).join("")}</div>
    </section>

    <section class="side-card">
      <h2>Receipts</h2>
      <div class="json-list">
        ${[...chain].reverse().slice(0, 20).map((r) => `<div class="json-item"><div class="json-type">${esc(r.body.type)}</div><pre>${esc(truncate(JSON.stringify(r.body, null, 2), 240))}</pre></div>`).join("")}
      </div>
    </section>
  </div>
  <style>
    .side-stack { display: grid; gap: 16px; }
    .side-card { background: rgba(16,18,24,0.85); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 14px; }
    .side-card h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.14em; color: rgba(255,255,255,0.55); }
    .brief-body {
      font-size: 12px;
      color: rgba(255,255,255,0.8);
      line-height: 1.45;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 10px 12px;
      white-space: pre-wrap;
      display: -webkit-box;
      -webkit-line-clamp: 5;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .memory-body {
      font-size: 11px;
      color: rgba(255,255,255,0.75);
      line-height: 1.5;
      background: rgba(255,255,255,0.03);
      border: 1px dashed rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 10px 12px;
      white-space: pre-wrap;
      display: -webkit-box;
      -webkit-line-clamp: 8;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .feed-list { display: grid; gap: 10px; }
    .feed-item {
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: linear-gradient(140deg, rgba(24,22,18,0.85), rgba(16,18,24,0.6));
      padding: 10px 12px;
      display: grid;
      gap: 6px;
      position: relative;
      animation: feedIn 0.4s ease;
    }
    .feed-item.latest { box-shadow: 0 0 0 1px rgba(255,204,128,0.25), 0 0 24px rgba(255,204,128,0.12); }
    .feed-item.latest::after {
      content: "";
      position: absolute;
      top: 10px;
      right: 10px;
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: rgba(255,204,128,0.9);
      box-shadow: 0 0 10px rgba(255,204,128,0.6);
      animation: pulse 1.6s ease-in-out infinite;
    }
    .feed-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .feed-agent { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.9); }
    .feed-tags { display: inline-flex; gap: 6px; }
    .feed-kind, .feed-branch {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.18);
      color: rgba(255,255,255,0.65);
    }
    .feed-branch {
      border-color: rgba(255,204,128,0.4);
      color: rgba(255,204,128,0.9);
    }
    .feed-body {
      font-size: 12px;
      color: rgba(255,255,255,0.82);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .plan-list { display: grid; gap: 6px; max-height: 240px; overflow: auto; }
    .plan-step { display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 8px; font-size: 12px; padding: 2px 0; }
    .plan-step.active { background: rgba(141,220,255,0.08); border-radius: 8px; padding: 2px 6px; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.2); }
    .dot.ready { background: rgba(255,204,128,0.8); }
    .dot.running { background: rgba(141,220,255,0.8); }
    .dot.completed { background: rgba(110,243,160,0.8); }
    .dot.failed { background: rgba(255,107,107,0.85); }
    .tag { font-size: 10px; color: rgba(255,255,255,0.55); text-transform: uppercase; letter-spacing: 0.12em; }
    .tag.failed { color: rgba(255,107,107,0.85); }
    .meta-list { display: grid; gap: 6px; }
    .meta-item {
      padding: 6px 8px;
      border-radius: 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .metric-list { display: grid; gap: 6px; font-size: 12px; max-height: 220px; overflow: auto; }
    .metric-list.compact { max-height: none; margin-bottom: 10px; }
    .metric-item { padding: 6px 8px; border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
    .metric-item.active { border-color: rgba(141,220,255,0.6); background: rgba(141,220,255,0.1); }
    .time-meta { font-size: 11px; color: rgba(255,255,255,0.6); margin-bottom: 6px; }
    .json-list { display: grid; gap: 8px; max-height: 240px; overflow: auto; }
    .json-item { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 8px; }
    .json-type { font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: rgba(255,255,255,0.55); }
    .json-item pre { margin: 6px 0 0; font-size: 11px; white-space: pre-wrap; }
    .stream-pill {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      border-radius: 999px;
      padding: 3px 8px;
      border: 1px solid rgba(141,220,255,0.4);
      color: rgba(141,220,255,0.9);
      background: rgba(141,220,255,0.12);
      width: fit-content;
      margin-bottom: 10px;
    }
    .branch-selector { margin-bottom: 10px; }
    .branch-selector label { display: grid; gap: 6px; font-size: 11px; color: rgba(255,255,255,0.6); }
    .branch-selector select {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      padding: 6px 8px;
      color: var(--ink);
      font-size: 12px;
    }
    .branch-list { display: grid; gap: 8px; min-width: 0; }
    .branch-item {
      font-size: 11px;
      color: rgba(255,255,255,0.7);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    @keyframes feedIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0% { transform: scale(1); opacity: 0.6; }
      50% { transform: scale(1.6); opacity: 1; }
      100% { transform: scale(1); opacity: 0.6; }
    }
  </style>`;
};
