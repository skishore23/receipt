// ============================================================================
// Receipt Browser UI - chat-first inspector
// ============================================================================

import { MiniGFM } from "@oblivionocean/minigfm";
import type { ReceiptFileInfo } from "../adapters/receipt-tools.js";
import { esc } from "./agent-framework.js";

export type ReceiptInspectorTool = {
  readonly name: string;
  readonly summary?: string;
  readonly durationMs?: number;
  readonly error?: string;
};

export type ReceiptInspectorSnapshot = {
  readonly runId?: string;
  readonly status: "idle" | "running" | "failed" | "completed";
  readonly mode?: string;
  readonly question?: string;
  readonly analysis?: string;
  readonly note?: string;
  readonly tools?: ReadonlyArray<ReceiptInspectorTool>;
  readonly agents?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly status?: "idle" | "running" | "failed" | "completed";
    readonly note?: string;
  }>;
  readonly context?: {
    readonly name: string;
    readonly total: number;
    readonly shown: number;
    readonly order: "asc" | "desc";
    readonly limit: number;
  };
  readonly timeline?: {
    readonly depth: number;
    readonly buckets: ReadonlyArray<{ readonly label: string; readonly count: number }>;
  };
};

export type ReceiptChatItem = {
  readonly id: string;
  readonly role: "user" | "agent" | "system";
  readonly label: string;
  readonly content: string;
  readonly status?: "running" | "failed" | "completed";
  readonly kind?: "analyze" | "improve" | "timeline" | "qa";
  readonly groupId?: string;
};

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const formatTime = (ts: number): string => new Date(ts).toLocaleString();

const md = new MiniGFM();

const truncate = (text: string, max = 160): string => {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
};

const renderMarkdown = (raw: string): string => {
  const text = raw.trim();
  if (!text) return `<div class="empty">No analysis yet.</div>`;
  return md.parse(text);
};

export const receiptShell = (opts: {
  readonly selected?: string;
  readonly limit: number;
  readonly order: "asc" | "desc";
  readonly depth: number;
}): string => {
  const { selected, limit, order, depth } = opts;
  const selectedName = selected ?? "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Inspector</title>
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
        target.querySelectorAll(".chat-bubble, .result-body, .summary-body").forEach(function (node) {
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
      --accent: #6bdcff;
      --accent-2: #ffcc80;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--ink);
      background: radial-gradient(700px 480px at 10% 0%, rgba(107,220,255,0.08), transparent),
                  radial-gradient(700px 520px at 90% 100%, rgba(255,204,128,0.08), transparent),
                  var(--bg);
      min-height: 100vh;
    }
    .app {
      display: grid;
      grid-template-columns: 250px minmax(0, 1fr) 320px;
      min-height: 100vh;
      min-width: 0;
    }
    .sidebar {
      min-width: 0;
      border-right: 1px solid var(--line);
      padding: 16px 14px;
      background: rgba(10,12,18,0.92);
    }
    .brand { font-weight: 700; margin-bottom: 6px; }
    .brand-tag {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(107,220,255,0.5);
      color: rgba(107,220,255,0.9);
      background: rgba(107,220,255,0.12);
      margin-left: 6px;
    }
    .brand-sub { font-size: 11px; color: var(--muted); margin-bottom: 14px; }
    .nav-title {
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 10px 0;
    }
    .fold-list { display: grid; gap: 10px; }
    .fold-item {
      display: grid;
      gap: 6px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.7);
      color: inherit;
      text-decoration: none;
    }
    .fold-item.active { border-color: rgba(107,220,255,0.4); }
    .fold-title { font-size: 12px; font-weight: 600; word-break: break-all; }
    .fold-meta { font-size: 10px; color: rgba(255,255,255,0.5); }

    .main { min-width: 0; padding: 20px 24px; overflow-x: hidden; }
    .chat-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px; min-width: 0; }
    .chat-title { font-weight: 700; }
    .chat-sub { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .question-card {
      border-radius: 16px;
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 14px;
      display: grid;
      gap: 12px;
    }
    .question-card textarea {
      font-family: "IBM Plex Mono", monospace;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 12px;
      color: var(--ink);
      font-size: 13px;
      min-height: 80px;
      resize: vertical;
    }
    .question-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .agent-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .agent-chip {
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid rgba(107,220,255,0.35);
      background: rgba(107,220,255,0.08);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(107,220,255,0.9);
    }
    .question-controls label {
      font-size: 11px;
      color: rgba(255,255,255,0.6);
      display: grid;
      gap: 4px;
    }
    .question-controls select {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      padding: 6px 8px;
      color: var(--ink);
      font-size: 12px;
    }
    .question-controls button {
      border: none;
      border-radius: 10px;
      padding: 8px 14px;
      background: linear-gradient(120deg, rgba(107,220,255,0.25), rgba(255,204,128,0.25));
      color: var(--ink);
      font-weight: 600;
      cursor: pointer;
    }
    .question-controls button.disabled { opacity: 0.4; pointer-events: none; }
    .travel-focus {
      margin-top: 14px;
      border-radius: 14px;
      border: 1px solid rgba(107,220,255,0.25);
      background: linear-gradient(120deg, rgba(107,220,255,0.14), rgba(255,204,128,0.1));
      padding: 12px;
      display: grid;
      gap: 8px;
    }
    .travel-focus-head {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .travel-focus-sub { font-size: 12px; color: rgba(255,255,255,0.72); }

    .chat-stack { display: grid; gap: 16px; margin-top: 18px; }
    .chat-row { display: grid; gap: 6px; }
    .chat-row.user { justify-items: end; }
    .chat-label { font-size: 11px; color: rgba(255,255,255,0.5); }
    .chat-bubble {
      max-width: 80%;
      min-width: 0;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.75);
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .chat-row.user .chat-bubble {
      background: rgba(107,220,255,0.14);
      border-color: rgba(107,220,255,0.35);
    }
    .chat-row.agent .chat-bubble {
      background: rgba(255,204,128,0.12);
      border-color: rgba(255,204,128,0.35);
    }
    .chat-bubble h1, .chat-bubble h2, .chat-bubble h3 { margin: 10px 0 6px; font-size: 14px; }
    .chat-bubble p { margin: 6px 0; }
    .chat-bubble ul { margin: 6px 0 6px 18px; padding: 0; }
    .chat-bubble li { margin: 4px 0; }
    .chat-bubble code {
      font-family: "IBM Plex Mono", monospace;
      background: rgba(255,255,255,0.06);
      padding: 0 4px;
      border-radius: 6px;
    }
    .chat-bubble pre {
      font-family: "IBM Plex Mono", monospace;
      background: rgba(18,20,28,0.7);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      padding: 8px 10px;
      white-space: pre-wrap;
      max-width: 100%;
      overflow-x: auto;
    }
    .chat-group { display: grid; gap: 18px; }
    .result-card {
      border-radius: 16px;
      border: 1px solid rgba(255,204,128,0.35);
      background: linear-gradient(140deg, rgba(255,204,128,0.12), rgba(141,220,255,0.08));
      padding: 16px 18px;
      display: grid;
      gap: 10px;
      max-width: 760px;
      margin: 0 auto;
    }
    .result-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
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
    .result-pill.running { border-color: rgba(107,220,255,0.6); color: rgba(107,220,255,0.95); }
    .result-pill.completed { border-color: rgba(110,243,160,0.6); color: rgba(110,243,160,0.95); }
    .result-pill.failed { border-color: rgba(255,107,107,0.6); color: rgba(255,107,107,0.95); }
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
    .coordination { display: grid; gap: 10px; }
    .coord-head {
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.55);
    }
    .coord-summary { display: flex; flex-wrap: wrap; gap: 8px; }
    .coord-badge {
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.18);
      color: rgba(255,255,255,0.78);
      background: rgba(255,255,255,0.06);
      padding: 3px 8px;
    }
    .coord-strip {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(220px, 1fr);
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .mini-card {
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.65);
      padding: 10px 12px;
      display: grid;
      gap: 6px;
      min-height: 88px;
    }
    .mini-card.kind-analyze { border-color: rgba(107,220,255,0.35); }
    .mini-card.kind-improve { border-color: rgba(255,204,128,0.35); }
    .mini-card.kind-timeline { border-color: rgba(110,243,160,0.35); }
    .mini-card.kind-qa { border-color: rgba(195,139,255,0.35); }
    .mini-label { font-size: 11px; color: rgba(255,255,255,0.7); }
    .mini-body { font-size: 12px; color: rgba(255,255,255,0.85); line-height: 1.45; white-space: pre-wrap; }
    .empty { color: var(--muted); font-size: 12px; }

    .side {
      min-width: 0;
      padding: 18px 16px;
      border-left: 1px solid var(--line);
      background: rgba(10,12,18,0.92);
      display: grid;
      gap: 14px;
      overflow-x: auto;
    }
    .side-card {
      min-width: 0;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.7);
      padding: 12px;
    }
    .side .meta-item {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .side .chip-row {
      min-width: 0;
      flex-wrap: wrap;
    }
    .side-card h2 {
      margin: 0 0 10px;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.6);
    }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      font-size: 10px;
      color: rgba(255,255,255,0.7);
      text-decoration: none;
    }
    .chip.active { border-color: rgba(107,220,255,0.5); color: rgba(107,220,255,0.9); }
    .meta-list { display: grid; gap: 6px; font-size: 12px; }
    .meta-item { color: rgba(255,255,255,0.8); }
    .metric-list { display: grid; gap: 6px; font-size: 12px; }
    .metric-item { padding: 6px 8px; border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
    .metric-item.active { border-color: rgba(107,220,255,0.6); background: rgba(107,220,255,0.12); }
    .metric-item.failed { border-color: rgba(255,107,107,0.6); background: rgba(255,107,107,0.12); }
    .timeline-list { display: grid; gap: 8px; }
    .timeline-row { display: grid; gap: 6px; }
    .timeline-label { font-size: 11px; color: rgba(255,255,255,0.75); }
    .timeline-bar {
      position: relative;
      height: 6px;
      border-radius: 999px;
      background: rgba(255,255,255,0.1);
      overflow: hidden;
    }
    .timeline-bar span {
      position: absolute;
      inset: 0;
      width: 0%;
      background: rgba(107,220,255,0.7);
    }
    .node-map { display: grid; gap: 10px; margin-top: 8px; }
    .node-row { display: grid; grid-template-columns: 10px 1fr; gap: 8px; align-items: center; }
    .node-dot { width: 8px; height: 8px; border-radius: 999px; background: rgba(255,204,128,0.8); }
    .node-label { font-size: 12px; color: rgba(255,255,255,0.85); }
    .tool-list { display: grid; gap: 8px; }
    .tool-item { display: grid; gap: 4px; padding: 8px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); }
    .tool-item.error { border-color: rgba(255,107,107,0.5); }
    .tool-name { font-size: 12px; font-weight: 600; }
    .tool-meta { font-size: 10px; color: rgba(255,255,255,0.55); }

    @media (max-width: 1100px) {
      .app { grid-template-columns: 220px minmax(0, 1fr); }
      .side { display: none; }
    }
    @media (max-width: 860px) {
      .app { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--line); }
    }
  </style>
</head>
<body hx-ext="sse" sse-connect="/receipt/stream">
  <div class="app">
    <aside class="sidebar">
      <div class="brand">Receipt Inspector <span class="brand-tag">multi-agent</span></div>
      <div class="brand-sub">Chat-first run analysis, powered by receipts.</div>
      <div class="nav-title">Runs</div>
      <div id="receipt-folds"
           class="fold-list"
           hx-get="/receipt/island/folds?selected=${encodeURIComponent(selectedName)}&order=${order}&limit=${limit}&depth=${depth}"
           hx-trigger="load, sse:receipt-refresh throttle:800ms, receipt-refresh"
           hx-swap="innerHTML">
        <div class="empty">Loading runs...</div>
      </div>
    </aside>

    <main class="main">
      <div class="chat-header">
        <div>
          <div class="chat-title">Receipt Chat</div>
          <div class="chat-sub">Ask the run anything. A multi-agent team inspects the receipts.</div>
        </div>
        <div class="chat-sub">${selected ? esc(selected) : "No run selected"}</div>
      </div>

      <form class="question-card" hx-post="/receipt/inspect" hx-swap="none">
        <input type="hidden" name="file" value="${esc(selectedName)}" />
        <input type="hidden" name="order" value="${order}" />
        <input type="hidden" name="limit" value="${limit}" />
        <textarea name="question" id="receipt-question" placeholder="Ask about this run (state, errors, gaps, improvements)..." required></textarea>
        <div class="question-controls">
          <div class="agent-strip">
            <span class="agent-chip">Analyst</span>
            <span class="agent-chip">Improver</span>
            <span class="agent-chip">Chronologist</span>
            <span class="agent-chip">Q&amp;A</span>
          </div>
          <label>
            Depth
            <select name="depth">
              <option value="1" ${depth === 1 ? "selected" : ""}>1</option>
              <option value="2" ${depth === 2 ? "selected" : ""}>2</option>
              <option value="3" ${depth === 3 ? "selected" : ""}>3</option>
            </select>
          </label>
          <button type="submit" class="${selected ? "" : "disabled"}">Run team</button>
        </div>
      </form>

      <section class="travel-focus">
        <div class="travel-focus-head">Time travel lens</div>
        <div class="travel-focus-sub">Change ordering and window size to inspect earlier or later receipts before re-running the agent team.</div>
        <div class="chip-row">
          <span class="chip">Order</span>
          <a class="chip ${order === "desc" ? "active" : ""}" href="/receipt?file=${encodeURIComponent(selectedName)}&order=desc&limit=${limit}&depth=${depth}">Newest first</a>
          <a class="chip ${order === "asc" ? "active" : ""}" href="/receipt?file=${encodeURIComponent(selectedName)}&order=asc&limit=${limit}&depth=${depth}">Oldest first</a>
        </div>
        <div class="chip-row">
          <span class="chip">Window</span>
          ${[50, 200, 1000].map((n) => `<a class="chip ${limit === n ? "active" : ""}" href="/receipt?file=${encodeURIComponent(selectedName)}&order=${order}&limit=${n}&depth=${depth}">${n}</a>`).join("")}
          <span class="chip">Depth</span>
          ${[1, 2, 3].map((d) => `<a class="chip ${depth === d ? "active" : ""}" href="/receipt?file=${encodeURIComponent(selectedName)}&order=${order}&limit=${limit}&depth=${d}">${d}</a>`).join("")}
        </div>
      </section>

      <div id="receipt-chat"
           class="chat-stack"
           hx-get="/receipt/island/chat?file=${encodeURIComponent(selectedName)}&order=${order}&limit=${limit}&depth=${depth}"
           hx-trigger="load, sse:receipt-refresh throttle:900ms, receipt-refresh"
           hx-swap="innerHTML">
        <div class="empty">Loading chat...</div>
      </div>
    </main>

    <aside class="side" id="receipt-side"
           hx-get="/receipt/island/side?file=${encodeURIComponent(selectedName)}&order=${order}&limit=${limit}&depth=${depth}"
           hx-trigger="load, sse:receipt-refresh throttle:900ms, receipt-refresh"
           hx-swap="innerHTML">
      <div class="empty">Loading context...</div>
    </aside>
  </div>
  <script>
    (() => {
      const input = document.getElementById("receipt-question");
      const storageKey = "receipt-inspector-question";
      if (input && window.localStorage) {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) input.value = saved;
        input.addEventListener("input", () => {
          window.localStorage.setItem(storageKey, input.value);
        });
      }
    })();
  </script>
</body>
</html>`;
};

export const receiptFoldsHtml = (
  files: ReadonlyArray<ReceiptFileInfo>,
  selected?: string,
  order: "asc" | "desc" = "desc",
  limit = 200,
  depth = 2
): string => {
  if (!files.length) return `<div class="empty">No JSONL files found.</div>`;
  const sorted = [...files].sort((a, b) => b.mtime - a.mtime);
  return sorted.map((f) => {
    const active = f.name === selected;
    return `<a class="fold-item ${active ? "active" : ""}" href="/receipt?file=${encodeURIComponent(f.name)}&order=${order}&limit=${limit}&depth=${depth}">
      <div class="fold-title">${esc(f.name)}</div>
      <div class="fold-meta">${formatBytes(f.size)} · ${formatTime(f.mtime)}</div>
    </a>`;
  }).join("");
};

export const receiptChatHtml = (opts: {
  readonly selected?: string;
  readonly items: ReadonlyArray<ReceiptChatItem>;
}): string => {
  const { selected, items } = opts;
  if (!selected) return `<div class="empty">Select a run to start chatting.</div>`;
  if (!items.length) return `<div class="empty">Ask the team to inspect this run.</div>`;

  const out: string[] = [];
  let idx = 0;
  while (idx < items.length) {
    const msg = items[idx];
    const question = msg.role === "user" ? msg : undefined;
    if (question) idx += 1;

    const group: ReceiptChatItem[] = [];
    while (idx < items.length && items[idx].role !== "user") {
      group.push(items[idx]);
      idx += 1;
    }

    if (!question && !group.length) continue;

    const priority: Array<ReceiptChatItem["kind"]> = ["analyze", "improve", "qa", "timeline"];
    const pick = group.find((item) => item.kind && priority.includes(item.kind))
      ?? group.find((item) => item.content.trim().length > 0)
      ?? group[0];
    const resultStatus = group.some((item) => item.status === "running")
      ? "running"
      : group.some((item) => item.status === "completed")
        ? "completed"
        : group.some((item) => item.status === "failed")
          ? "failed"
          : "queued";
    const resultBody = pick?.content?.trim()
      ?? (resultStatus === "running" ? "Inspector is working..." : "Waiting for outputs...");
    const resultBodyHtml = renderMarkdown(resultBody);
    const runningAgents = group.filter((item) => item.status === "running").length;
    const completedAgents = group.filter((item) => item.status === "completed").length;
    const failedAgents = group.filter((item) => item.status === "failed").length;

    const miniCards = group.map((item) => {
      const content = item.content.trim() || "Working...";
      const kindClass = item.kind ? ` kind-${item.kind}` : "";
      return `<div class="mini-card${kindClass}" title="${esc(content)}">
        <div class="mini-label">${esc(item.label)}${item.status ? ` · ${esc(item.status)}` : ""}</div>
        <div class="mini-body">${esc(truncate(content, 160))}</div>
      </div>`;
    }).join("");

    out.push(`<section class="chat-group">
      ${question ? `<div class="chat-row user">
        <div class="chat-label">${esc(question.label)}</div>
        <div class="chat-bubble">${esc(question.content)}</div>
      </div>` : ""}
      <div class="coord-summary">
        <span class="coord-badge">Team: ${group.length}</span>
        <span class="coord-badge">Running: ${runningAgents}</span>
        <span class="coord-badge">Completed: ${completedAgents}</span>
        <span class="coord-badge">Failed: ${failedAgents}</span>
      </div>
      <div class="result-card">
        <div class="result-head">
          <div class="result-title">Final synthesis</div>
          <div class="result-pill ${resultStatus}">${esc(resultStatus)}</div>
        </div>
        <div class="result-body">${resultBodyHtml}</div>
      </div>
      <section class="coordination">
        <div class="coord-head">Coordination timeline (latest receipts)</div>
        <div class="coord-strip">
          ${miniCards || `<div class="empty">No agent outputs yet.</div>`}
        </div>
      </section>
    </section>`);
  }

  return out.join("");
};

export const receiptSideHtml = (opts: {
  readonly selected?: string;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly depth: number;
  readonly snapshot: ReceiptInspectorSnapshot;
  readonly fileMeta?: { size: number; mtime: number };
}): string => {
  const { selected, order, limit, depth, snapshot, fileMeta } = opts;
  const context = snapshot.context;
  const timeline = snapshot.timeline;
  const tools = snapshot.tools ?? [];
  const total = timeline?.buckets.reduce((acc, b) => acc + b.count, 0) ?? 0;
  const agents = snapshot.agents ?? [];

  const timelineRows = timeline?.buckets.map((b) => {
    const pct = total ? Math.round((b.count / total) * 100) : 0;
    return `<div class="timeline-row">
      <div class="timeline-label">${esc(b.label)} · ${b.count}</div>
      <div class="timeline-bar"><span style="width:${pct}%"></span></div>
    </div>`;
  }).join("");

  const nodeRows = timeline?.buckets.map((b) =>
    `<div class="node-row"><span class="node-dot"></span><span class="node-label">${esc(b.label)}</span></div>`
  ).join("");

  const statusLabel = snapshot.status === "running"
    ? "Running"
    : snapshot.status === "failed"
      ? "Failed"
      : snapshot.status === "completed"
        ? "Completed"
        : "Idle";

  const agentRows = agents.length
    ? agents.map((agent) => {
      const isActive = agent.status === "running";
      const isFailed = agent.status === "failed";
      const suffix = agent.status && agent.status !== "idle" ? ` · ${agent.status}` : "";
      return `<div class="metric-item ${isActive ? "active" : isFailed ? "failed" : ""}">${esc(agent.name)}${suffix}</div>`;
    }).join("")
    : `<div class="empty">No agents yet.</div>`;

  const toolRows = tools.length
    ? tools.map((tool) => {
      const duration = tool.durationMs ? `${tool.durationMs}ms` : "";
      const meta = [duration, tool.error ? "error" : "ok"].filter(Boolean).join(" · ");
      return `<div class="tool-item ${tool.error ? "error" : ""}">
        <div class="tool-name">${esc(tool.name)}</div>
        <div class="tool-meta">${esc(meta)}${tool.summary ? ` · ${esc(tool.summary)}` : ""}</div>
      </div>`;
    }).join("")
    : `<div class="empty">No tool calls yet.</div>`;
  const metricRows = [
    `Context receipts: ${context?.shown ?? 0}/${context?.total ?? 0}`,
    `Timeline buckets: ${timeline?.buckets.length ?? 0}`,
    `Depth: ${timeline?.depth ?? depth}`,
    `Tool calls: ${tools.length}`,
    `Agents: ${agents.length}`,
  ];

  return `
  <section class="side-card">
    <h2>Status</h2>
    <div class="meta-list">
      <div class="meta-item">${statusLabel}${agents.length ? " · team" : snapshot.mode ? ` · ${esc(snapshot.mode)}` : ""}</div>
      ${snapshot.note ? `<div class="meta-item">${esc(snapshot.note)}</div>` : ""}
    </div>
  </section>

  <section class="side-card">
    <h2>Streams</h2>
    ${selected ? `<div class="meta-list">
      <div class="meta-item">Run: ${esc(selected)}</div>
      ${fileMeta ? `<div class="meta-item">File: ${formatBytes(fileMeta.size)} · ${formatTime(fileMeta.mtime)}</div>` : ""}
      <div class="meta-item">Window: ${context?.shown ?? 0}/${context?.total ?? 0} receipts</div>
      <div class="meta-item">Order: ${order}</div>
      <div class="meta-item">Limit: ${limit}</div>
    </div>` : `<div class="empty">Select a run to load context.</div>`}
    <div class="chip-row" style="margin-top:10px;">
      <span class="chip">Order</span>
      <a class="chip ${order === "desc" ? "active" : ""}" href="/receipt?file=${encodeURIComponent(selected ?? "")}&order=desc&limit=${limit}&depth=${depth}">Newest</a>
      <a class="chip ${order === "asc" ? "active" : ""}" href="/receipt?file=${encodeURIComponent(selected ?? "")}&order=asc&limit=${limit}&depth=${depth}">Oldest</a>
    </div>
    <div class="chip-row" style="margin-top:8px;">
      <span class="chip">Limit</span>
      ${[50, 200, 1000].map((n) => `<a class="chip ${limit === n ? "active" : ""}" href="/receipt?file=${encodeURIComponent(selected ?? "")}&order=${order}&limit=${n}&depth=${depth}">${n}</a>`).join("")}
    </div>
    <div class="chip-row" style="margin-top:8px;">
      <span class="chip">Depth</span>
      ${[1, 2, 3].map((d) => `<a class="chip ${depth === d ? "active" : ""}" href="/receipt?file=${encodeURIComponent(selected ?? "")}&order=${order}&limit=${limit}&depth=${d}">${d}</a>`).join("")}
    </div>
  </section>

  <section class="side-card">
    <h2>Team</h2>
    <div class="metric-list">
      ${agentRows}
    </div>
  </section>

  <section class="side-card">
    <h2>Timeline</h2>
    ${timelineRows ? `<div class="timeline-list">${timelineRows}</div>` : `<div class="empty">No timeline yet.</div>`}
    ${nodeRows ? `<div class="node-map">${nodeRows}</div>` : ""}
  </section>

  <section class="side-card">
    <h2>Metrics</h2>
    <div class="metric-list">
      ${metricRows.map((row) => `<div class="metric-item">${esc(row)}</div>`).join("")}
    </div>
  </section>

  <section class="side-card">
    <h2>Tools</h2>
    <div class="tool-list">${toolRows}</div>
  </section>`;
};
