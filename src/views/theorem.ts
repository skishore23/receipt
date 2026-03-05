// ============================================================================
// Theorem Guild UI - receipts only
// ============================================================================

import type { Chain } from "../core/types.js";
import { computeHash, verify } from "../core/chain.js";
import type { TheoremEvent, TheoremState } from "../modules/theorem.js";
import type { TheoremRunSummary } from "../agents/theorem.js";
import {
  esc,
  truncate,
  frameworkCoordinationHtml,
  type FrameworkContextRow,
  type FrameworkLaneRow,
  type FrameworkTrailRow,
} from "./agent-framework.js";

const prettyAgent = (id: string): string =>
  id
    .split(/[-_]/g)
    .map((p) => p.slice(0, 1).toUpperCase() + p.slice(1))
    .join(" ");

const prettyPhase = (phase?: string): string =>
  phase ? phase.slice(0, 1).toUpperCase() + phase.slice(1) : "Context";

const renderInlineMath = (line: string): string =>
  esc(line).replace(/\\\((.+?)\\\)/g, (_m, inner) => `<span class="math-inline">${inner}</span>`);

const renderProof = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return `<div class="proof-empty">Waiting for the final proof...</div>`;

  const lines = raw.split("\n");
  let html = "";
  let inList = false;
  let inMath = false;
  let mathLines: string[] = [];

  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };

  const closeMath = () => {
    if (inMath) {
      html += `<div class="math-block">${esc(mathLines.join("\n"))}</div>`;
      mathLines = [];
      inMath = false;
    }
  };

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine === "\\[") {
      closeList();
      inMath = true;
      continue;
    }
    if (trimmedLine === "\\]") {
      closeMath();
      continue;
    }
    if (inMath) {
      mathLines.push(line);
      continue;
    }

    if (trimmedLine.startsWith("### ")) {
      closeList();
      html += `<h3>${renderInlineMath(trimmedLine.slice(4))}</h3>`;
      continue;
    }
    if (trimmedLine.startsWith("## ")) {
      closeList();
      html += `<h2>${renderInlineMath(trimmedLine.slice(3))}</h2>`;
      continue;
    }

    if (trimmedLine.startsWith("- ")) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${renderInlineMath(trimmedLine.slice(2))}</li>`;
      continue;
    }

    if (!trimmedLine) {
      closeList();
      html += `<div class="proof-spacer"></div>`;
      continue;
    }

    closeList();
    html += `<p>${renderInlineMath(line)}</p>`;
  }

  closeMath();
  closeList();
  return html;
};

type TeamMember = { readonly id: string; readonly name: string };

// ============================================================================
// Shell
// ============================================================================

export const theoremShell = (
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
  const resumeUrl = activeRun ? `/theorem/run?${resumeQuery}` : "";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt - Theorem Guild</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.1/sse.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
  <script>
    (function () {
      const renderMath = function (root) {
        const target = root instanceof HTMLElement ? root : document.body;
        const katex = window.katex;
        if (!katex) return;

        target.querySelectorAll(".math-inline").forEach(function (node) {
          if (!(node instanceof HTMLElement)) return;
          if (node.dataset.katexDone === "1") return;
          const expr = (node.textContent || "").trim();
          if (!expr) return;
          try {
            katex.render(expr, node, { throwOnError: false, displayMode: false });
            node.dataset.katexDone = "1";
          } catch (_err) {}
        });

        target.querySelectorAll(".math-block").forEach(function (node) {
          if (!(node instanceof HTMLElement)) return;
          if (node.dataset.katexDone === "1") return;
          const expr = (node.textContent || "").trim();
          if (!expr) return;
          try {
            katex.render(expr, node, { throwOnError: false, displayMode: true });
            node.dataset.katexDone = "1";
          } catch (_err) {}
        });

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
      --ok: #6ef3a0;
      --bad: #ff6b6b;
      --accent: #6bdcff;
      --accent-2: #c38bff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--ink);
      background: radial-gradient(900px 560px at 60% 0%, rgba(40,50,70,0.25), transparent),
                  radial-gradient(700px 420px at 20% 80%, rgba(70,45,100,0.18), transparent),
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
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      margin-bottom: 16px;
    }
    .brand-tag {
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(107,220,255,0.4);
      color: rgba(107,220,255,0.9);
      background: rgba(107,220,255,0.12);
    }
    .brand-sub {
      font-size: 11px;
      color: var(--muted);
      margin-top: -8px;
      margin-bottom: 16px;
    }
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
    .folds {
      display: grid;
      gap: 10px;
    }
    .main {
      padding: 22px 24px;
    }
    .controls {
      display: grid;
      gap: 12px;
      padding: 16px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: var(--panel);
    }
    .controls-title {
      font-weight: 600;
      font-size: 13px;
    }
    .controls-sub {
      font-size: 11px;
      color: rgba(255,255,255,0.55);
    }
    .controls form {
      display: grid;
      gap: 10px;
    }
    .controls form.resume-form {
      display: flex;
      justify-content: flex-end;
      align-items: center;
    }
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
    .controls button {
      border: none;
      background: linear-gradient(120deg, rgba(107,220,255,0.3), rgba(195,139,255,0.35));
      color: var(--ink);
      font-weight: 600;
      border-radius: 12px;
      padding: 12px 18px;
      cursor: pointer;
      height: fit-content;
    }
    .resume-form { margin-top: 4px; }
    .resume-form button {
      border: none;
      background: rgba(255,255,255,0.08);
      color: var(--ink);
      font-weight: 600;
      border-radius: 12px;
      padding: 10px 16px;
      cursor: pointer;
      height: fit-content;
      width: auto;
    }
    .run-controls {
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: flex-end;
    }
    .rounds {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 12px;
      color: var(--muted);
    }
    .rounds input {
      width: 64px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      padding: 6px 8px;
      color: var(--ink);
      font-size: 12px;
    }
    .examples {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .examples button {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      color: var(--muted);
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      cursor: pointer;
    }
    .run-area {
      margin-top: 16px;
      display: grid;
      gap: 16px;
    }
    .travel-island {
      margin-top: 16px;
      margin-bottom: 20px;
      min-height: 90px;
      border-radius: 14px;
      border: 1px solid rgba(107,220,255,0.3);
      background: linear-gradient(120deg, rgba(107,220,255,0.16), rgba(195,139,255,0.12));
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
      accent-color: #6bdcff;
    }
    .travel-step { font-size: 11px; color: rgba(255,255,255,0.75); white-space: nowrap; }
    .activity {
      padding: 18px 16px;
      border-left: 1px solid var(--line);
      background: rgba(10,12,18,0.85);
    }
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
<body hx-ext="sse" sse-connect="/theorem/stream?stream=${encodeURIComponent(stream)}">
  <div class="app">
    <aside class="sidebar">
      <div class="brand">Theorem Guild <span class="brand-tag">multi-agent</span></div>
      <div class="brand-sub">Receipts only. Streams per run. Replay-first.</div>
      <div class="nav-title">Runs</div>
      <button class="new-chat" type="button" onclick="window.location.href='/theorem?stream=${encodeURIComponent(stream)}&run=new'">+ New Run</button>
      <div id="tg-folds"
           class="folds"
           hx-get="/theorem/island/folds?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:theorem-refresh throttle:800ms"
           hx-swap="innerHTML">
        <div class="empty">Loading runs...</div>
      </div>
    </aside>

    <main class="main">
      <div id="tg-travel"
           class="travel-island"
           hx-get="/theorem/island/travel?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&branch=${encodeURIComponent(branch ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:theorem-refresh throttle:700ms"
           hx-swap="innerHTML">
        <div class="empty">Loading time travel...</div>
      </div>

      <div class="controls">
        <div class="controls-title">Multi-agent proof run</div>
        <div class="controls-sub">Parallel attempts, critiques, and merges recorded as receipts.</div>
        <form hx-post="/theorem/run?stream=${encodeURIComponent(stream)}" hx-swap="none">
          <textarea name="problem" id="tg-problem" placeholder="Paste a theorem / problem statement for the guild..." required></textarea>
          <div class="run-controls">
            <label class="rounds">
              <span>Rounds</span>
              <input type="number" name="rounds" min="1" max="5" value="2" />
            </label>
            <label class="rounds">
              <span>Depth</span>
              <input type="number" name="depth" min="1" max="4" value="2" />
            </label>
            <label class="rounds">
              <span>Memory</span>
              <input type="number" name="memory" min="5" max="200" value="60" />
            </label>
            <label class="rounds">
              <span>Branch threshold</span>
              <input type="number" name="branch" min="1" max="6" value="2" />
            </label>
            <button>Run multi-agent</button>
          </div>
        </form>
        <div class="examples">
          ${examples.map(ex => `<button type="button" data-problem="${esc(ex.problem)}">${esc(ex.label)}</button>`).join("")}
        </div>
        ${activeRun
          ? `<form class="resume-form" hx-post="${resumeUrl}" hx-swap="none">
              <input type="hidden" name="append" id="tg-resume-append" />
              <button type="submit">Resume current run</button>
            </form>`
          : ""}
      </div>

      <div class="run-area" id="tg-chat"
           hx-get="/theorem/island/chat?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&branch=${encodeURIComponent(branch ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:theorem-refresh throttle:1200ms"
           hx-swap="innerHTML">
        <div class="empty">Loading run...</div>
      </div>
    </main>

    <aside class="activity" id="tg-side"
           hx-get="/theorem/island/side?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&branch=${encodeURIComponent(branch ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:theorem-refresh throttle:800ms"
           hx-swap="innerHTML">
      <div class="empty">Loading panels...</div>
    </aside>
  </div>

  <script>
    (() => {
      const input = document.getElementById("tg-problem");
      document.querySelectorAll(".examples button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const problem = btn.getAttribute("data-problem");
          if (problem && input) input.value = problem;
        });
      });
      const resumeForm = document.querySelector(".resume-form");
      const resumeAppend = document.getElementById("tg-resume-append");
      if (resumeForm && input && resumeAppend) {
        resumeForm.addEventListener("submit", () => {
          resumeAppend.value = input.value || "";
        });
      }

      const freeze = () => {
        document.body.dataset.freezeCoord = "1";
        if (freezeTimer) clearTimeout(freezeTimer);
      };
      let freezeTimer = null;
      const unfreeze = () => {
        if (freezeTimer) clearTimeout(freezeTimer);
        freezeTimer = setTimeout(() => {
          document.body.dataset.freezeCoord = "0";
        }, 400);
      };

      const storeScroll = () => {
        const strip = document.querySelector(".coord-strip");
        if (strip) document.body.dataset.coordScroll = String(strip.scrollLeft || 0);
      };
      const restoreScroll = () => {
        const strip = document.querySelector(".coord-strip");
        const value = document.body.dataset.coordScroll;
        if (strip && value) strip.scrollLeft = Number(value) || 0;
      };

      document.body.addEventListener("htmx:beforeSwap", (evt) => {
        const target = evt.detail?.target;
        if (target && target.id === "tg-chat" && document.body.dataset.freezeCoord === "1") {
          evt.detail.shouldSwap = false;
          return;
        }
        storeScroll();
      });
      document.body.addEventListener("htmx:afterSwap", restoreScroll);

      const bindStrip = () => {
        const strip = document.querySelector(".coord-strip");
        if (!strip) return;
        strip.addEventListener("pointerdown", freeze);
        strip.addEventListener("pointerup", unfreeze);
        strip.addEventListener("mouseleave", unfreeze);
        strip.addEventListener("wheel", freeze, { passive: true });
        strip.addEventListener("touchstart", freeze, { passive: true });
        strip.addEventListener("touchend", unfreeze);
        strip.addEventListener("scroll", storeScroll, { passive: true });
      };

      bindStrip();
      document.body.addEventListener("htmx:afterSwap", bindStrip);
    })();
  </script>
</body>
</html>`;
};

// ============================================================================
// Folds
// ============================================================================

export const theoremFoldsHtml = (
  stream: string,
  runs: ReadonlyArray<TheoremRunSummary>,
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
      href="/theorem?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(run.runId)}&at=${encodeURIComponent(String(at ?? ""))}">
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
    .fold-item.active { border-color: rgba(107,220,255,0.45); }
    .fold-head { display: flex; align-items: center; gap: 8px; }
    .fold-dot { width: 8px; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.2); }
    .fold-dot.done { background: rgba(110,243,160,0.8); }
    .fold-dot.running { background: rgba(107,220,255,0.8); }
    .fold-dot.failed { background: rgba(255,107,107,0.85); }
    .fold-title { font-size: 12px; font-weight: 600; }
    .fold-meta { font-size: 11px; color: rgba(255,255,255,0.5); }
  </style>`;
};

export const theoremTravelHtml = (opts: {
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
      <div class="travel-meta">Select a run to scrub receipts and replay coordination.</div>
    </div>`;
  }

  const maxAt = Math.max(0, total);
  const currentAt = at === null || at === undefined ? maxAt : Math.max(0, Math.min(at, maxAt));
  const isPast = currentAt < maxAt;
  const params = (nextAt?: number | null): string => {
    const q = new URLSearchParams({ stream, run: runId });
    if (branch) q.set("branch", branch);
    if (nextAt !== undefined && nextAt !== null && nextAt < maxAt) q.set("at", String(nextAt));
    return `/theorem/travel?${q.toString()}`;
  };
  const atStart = currentAt <= 0;
  const atHead = currentAt >= maxAt;

  return `<div class="travel-hero">
    <div class="travel-head">
      <div class="travel-title">Time travel</div>
      <div class="travel-pill ${isPast ? "past" : "live"}">${isPast ? "past view" : "live head"}</div>
    </div>
    <div class="travel-meta">Replay any prefix of the run. Coordination, context, and proof state are folded from receipts at this point in time.</div>
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
          hx-get="/theorem/travel" hx-include="closest form" hx-trigger="change delay:90ms" hx-swap="none" />
      </form>
      <div class="travel-step">Step ${currentAt} / ${maxAt}</div>
    </div>
  </div>`;
};

// ============================================================================
// Chat
// ============================================================================

type ChatItem = {
  readonly id: string;
  readonly role: "user" | "agent" | "system";
  readonly label: string;
  readonly content: string;
  readonly kind?: "attempt" | "lemma" | "critique" | "patch" | "branch" | "rebracket" | "summary" | "parallel";
};

const upsertChat = (
  items: ChatItem[],
  map: Map<string, number>,
  key: string,
  next: Omit<ChatItem, "id">
) => {
  const idx = map.get(key);
  if (idx === undefined) {
    const id = `${key}-${items.length}`;
    items.push({ id, ...next });
    map.set(key, items.length - 1);
    return;
  }
  items[idx] = { ...items[idx], ...next, content: items[idx].content + next.content };
};

export const theoremChatHtml = (chain: Chain<TheoremEvent>): string => {
  if (chain.length === 0) return `<div class="empty">No run selected.</div>`;

  const items: ChatItem[] = [];
  const index = new Map<string, number>();
  const claimOwner = new Map<string, string>();
  type AgentSnapshot = {
    status?: "running" | "idle" | "done";
    phase?: string;
    round?: number;
    note?: string;
    lastAction?: string;
    updatedAt: number;
  };
  type CoordTrail = {
    ts: number;
    kind: "attempt" | "lemma" | "critique" | "patch" | "branch" | "rebracket" | "summary" | "parallel" | "status";
    agent?: string;
    body: string;
  };
  const agentSnapshots = new Map<string, AgentSnapshot>();
  const coordTrail: CoordTrail[] = [];
  const seenHashes = new Set<string>();
  let problemText = "";
  let latestSolution: { content: string; confidence: number; gaps?: ReadonlyArray<string> } | null = null;
  let runStatus: "running" | "failed" | "completed" | null = null;
  let runNote: string | undefined;
  let runningPhase: string | undefined;
  let runningAgent: string | undefined;
  let lastEventLabel = "";
  let lastEventTs = 0;
  let latestParallel: { phase: string; agents: ReadonlyArray<string>; round?: number } | null = null;
  const summaryChunks = new Map<string, string>();

  const touchAgent = (agentId: string, patch: Partial<AgentSnapshot>, ts: number) => {
    const prev = agentSnapshots.get(agentId) ?? { updatedAt: ts };
    agentSnapshots.set(agentId, { ...prev, ...patch, updatedAt: Math.max(prev.updatedAt, ts) });
  };

  const pushTrail = (item: CoordTrail) => {
    const key = `${item.kind}|${item.agent ?? ""}|${item.body}`;
    const prev = coordTrail[coordTrail.length - 1];
    if (prev && `${prev.kind}|${prev.agent ?? ""}|${prev.body}` === key) return;
    coordTrail.push(item);
  };

  for (const r of chain) {
    if (seenHashes.has(r.hash)) continue;
    seenHashes.add(r.hash);

    const e = r.body;
    lastEventLabel = e.type;
    lastEventTs = r.ts;
    switch (e.type) {
      case "problem.set":
        problemText = e.problem;
        items.push({ id: r.id, role: "user", label: "You", content: e.problem });
        pushTrail({ ts: r.ts, kind: "status", agent: "Orchestrator", body: "Run initialized with user problem." });
        break;
      case "attempt.proposed":
        claimOwner.set(e.claimId, e.agentId);
        upsertChat(items, index, e.claimId, {
          role: "agent",
          label: prettyAgent(e.agentId),
          content: e.content,
          kind: "attempt",
        });
        touchAgent(e.agentId, { lastAction: `Attempt #${e.claimId.slice(-4)}` }, r.ts);
        pushTrail({
          ts: r.ts,
          kind: "attempt",
          agent: prettyAgent(e.agentId),
          body: `Proposed attempt #${e.claimId.slice(-4)}.`,
        });
        break;
      case "lemma.proposed":
        claimOwner.set(e.claimId, e.agentId);
        upsertChat(items, index, e.claimId, {
          role: "agent",
          label: `${prettyAgent(e.agentId)} (Lemma)`,
          content: e.content,
          kind: "lemma",
        });
        touchAgent(e.agentId, { lastAction: `Lemma #${e.claimId.slice(-4)}` }, r.ts);
        pushTrail({
          ts: r.ts,
          kind: "lemma",
          agent: prettyAgent(e.agentId),
          body: `Added lemma #${e.claimId.slice(-4)}.`,
        });
        break;
      case "critique.raised":
        const targetCrit = claimOwner.get(e.targetClaimId);
        upsertChat(items, index, e.claimId, {
          role: "agent",
          label: `${prettyAgent(e.agentId)} → ${prettyAgent(targetCrit ?? "Claim")}`,
          content: e.content,
          kind: "critique",
        });
        touchAgent(e.agentId, { lastAction: `Critique on #${e.targetClaimId.slice(-4)}` }, r.ts);
        pushTrail({
          ts: r.ts,
          kind: "critique",
          agent: prettyAgent(e.agentId),
          body: `Critiqued claim #${e.targetClaimId.slice(-4)}.`,
        });
        break;
      case "patch.applied":
        const targetPatch = claimOwner.get(e.targetClaimId);
        upsertChat(items, index, e.claimId, {
          role: "agent",
          label: `${prettyAgent(e.agentId)} → ${prettyAgent(targetPatch ?? "Claim")}`,
          content: e.content,
          kind: "patch",
        });
        touchAgent(e.agentId, { lastAction: `Patch for #${e.targetClaimId.slice(-4)}` }, r.ts);
        pushTrail({
          ts: r.ts,
          kind: "patch",
          agent: prettyAgent(e.agentId),
          body: `Patched claim #${e.targetClaimId.slice(-4)}.`,
        });
        break;
      case "summary.made":
        upsertChat(items, index, e.claimId, {
          role: "agent",
          label: `Synthesizer · ${e.bracket}`,
          content: e.content,
          kind: "summary",
        });
        summaryChunks.set(e.claimId, (summaryChunks.get(e.claimId) ?? "") + e.content);
        touchAgent(e.agentId, { lastAction: `Summary ${e.bracket}` }, r.ts);
        pushTrail({
          ts: r.ts,
          kind: "summary",
          agent: prettyAgent(e.agentId),
          body: `Merged branches using ${e.bracket}.`,
        });
        break;
      case "solution.finalized":
        latestSolution = { content: e.content, confidence: e.confidence, gaps: e.gaps };
        touchAgent(e.agentId, { status: "done", lastAction: `Finalized proof (${e.confidence.toFixed(2)})` }, r.ts);
        pushTrail({
          ts: r.ts,
          kind: "summary",
          agent: prettyAgent(e.agentId),
          body: `Final proof emitted (confidence ${e.confidence.toFixed(2)}).`,
        });
        break;
      case "run.status":
        runStatus = e.status;
        runNote = e.note;
        pushTrail({
          ts: r.ts,
          kind: "status",
          agent: "Orchestrator",
          body: `Run marked ${e.status}${e.note ? ` (${e.note})` : ""}.`,
        });
        break;
      case "phase.parallel":
        items.push({
          id: r.id,
          role: "system",
          label: "Parallel phase",
          content: `${e.phase} · ${e.agents.map(prettyAgent).join(", ")}${e.round ? ` (r${e.round})` : ""}`,
          kind: "parallel",
        });
        latestParallel = { phase: e.phase, agents: e.agents, round: e.round };
        pushTrail({
          ts: r.ts,
          kind: "parallel",
          body: `Parallel ${e.phase}${e.round ? ` r${e.round}` : ""}: ${e.agents.map(prettyAgent).join(", ")}.`,
        });
        break;
      case "verification.report":
        items.push({
          id: r.id,
          role: "system",
          label: "Verifier",
          content: `Status: ${e.status.toUpperCase()}\n${e.content}`,
          kind: "summary",
        });
        touchAgent(e.agentId, { lastAction: `Verification: ${e.status}` }, r.ts);
        pushTrail({
          ts: r.ts,
          kind: "summary",
          agent: prettyAgent(e.agentId),
          body: `Verification status: ${e.status}.`,
        });
        break;
      case "agent.status":
        touchAgent(
          e.agentId,
          {
            status: e.status,
            phase: e.phase,
            round: e.round,
            note: e.note,
            lastAction: e.status === "running"
              ? `Working on ${e.phase ?? "task"}${e.round ? ` r${e.round}` : ""}`
              : e.note ?? undefined,
          },
          r.ts
        );
        if (e.status === "running") {
          items.push({
            id: r.id,
            role: "system",
            label: "System",
            content: `${prettyAgent(e.agentId)} working on ${e.phase ?? "task"}${e.round ? ` (r${e.round})` : ""}`,
            kind: "rebracket",
          });
          runningAgent = e.agentId;
          runningPhase = `${e.phase ?? "working"}${e.round ? ` r${e.round}` : ""}`;
          pushTrail({
            ts: r.ts,
            kind: "status",
            agent: prettyAgent(e.agentId),
            body: `Started ${e.phase ?? "task"}${e.round ? ` r${e.round}` : ""}.`,
          });
        }
        break;
      case "rebracket.applied":
        items.push({
          id: r.id,
          role: "system",
          label: "System",
          content: `Rebracket → ${e.bracket} (score ${e.score.toFixed(2)})`,
          kind: "rebracket",
        });
        pushTrail({
          ts: r.ts,
          kind: "rebracket",
          agent: "Orchestrator",
          body: `Rebracketed to ${e.bracket} (score ${e.score.toFixed(2)}).`,
        });
        break;
      case "branch.created":
        const shortBranch = e.branchId.includes("/branches/")
          ? e.branchId.split("/branches/").pop() ?? e.branchId
          : e.branchId.split("/").pop() ?? e.branchId;
        items.push({
          id: r.id,
          role: "system",
          label: "System",
          content: `Branch created: ${shortBranch} at r${e.forkAt}`,
          kind: "branch",
        });
        pushTrail({
          ts: r.ts,
          kind: "branch",
          agent: "Orchestrator",
          body: `Created branch ${shortBranch} from step r${e.forkAt}.`,
        });
        break;
      default:
        break;
    }
  }

  if (latestSolution && runStatus !== "failed") {
    runStatus = "completed";
  }

  const contextRows = contextWindowRows(chain);

  const resultStatus = runStatus === "failed"
    ? "Failed"
    : runStatus === "completed"
      ? "Completed"
      : "Running";
  const latestSummaryEvent = [...chain].reverse().find((r) => r.body.type === "summary.made") as
    | { body: Extract<TheoremEvent, { type: "summary.made" }> }
    | undefined;
  const summaryText = latestSummaryEvent ? summaryChunks.get(latestSummaryEvent.body.claimId) ?? "" : "";
  const resultBody = latestSolution?.content?.trim()
    || summaryText.trim()
    || (runStatus === "failed"
      ? (runNote ?? "Run failed before producing a final proof.")
      : "Waiting for the final proof...");
  const resultBodyHtml = latestSolution
    ? renderProof(resultBody)
    : summaryText.trim()
      ? renderProof(resultBody)
      : `<div class="proof-empty">${esc(resultBody)}</div>`;
  const parallelLabel = latestParallel
    ? `Parallel: ${latestParallel.phase}${latestParallel.round ? ` r${latestParallel.round}` : ""} · ${latestParallel.agents.map(prettyAgent).join(", ")}`
    : "";
  const resultMeta = latestSolution
    ? `Confidence: ${latestSolution.confidence.toFixed(2)}`
    : runStatus === "failed"
      ? (runNote ?? "Run failed.")
      : parallelLabel
        ? parallelLabel
        : runningPhase && runningAgent
          ? `Now: ${prettyAgent(runningAgent)} · ${runningPhase}`
          : lastEventLabel
            ? `Last receipt: ${lastEventLabel}`
            : "Streaming receipts...";
  const gaps = latestSolution?.gaps?.length ? latestSolution.gaps.map((g) => `<li>${esc(g)}</li>`).join("") : "";
  const gapsHtml = gaps ? `<div class="result-gaps"><div class="result-meta">Gaps</div><ul>${gaps}</ul></div>` : "";
  const contextCount = chain
    .filter((r) => r.body.type === "prompt.context")
    .filter((r, idx, arr) => arr.findIndex((x) => x.hash === r.hash) === idx)
    .length;
  const coordCount = coordTrail.length;
  const nowLabel = parallelLabel
    || (runningPhase && runningAgent ? `${prettyAgent(runningAgent)} · ${runningPhase}` : "")
    || (lastEventLabel ? `Last: ${lastEventLabel}` : "Waiting for first receipt");
  const clockLabel = lastEventTs ? new Date(lastEventTs).toLocaleTimeString() : "—";
  const streamModeLabel = runStatus === "running"
    ? "Lanes and trail update after each completed receipt. Token-by-token model streaming is currently disabled."
    : "Showing receipt replay for this run slice.";

  const laneRows: ReadonlyArray<FrameworkLaneRow> = [...agentSnapshots.entries()]
    .sort((a, b) => {
      const aRunning = a[1].status === "running" ? 1 : 0;
      const bRunning = b[1].status === "running" ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return b[1].updatedAt - a[1].updatedAt;
    })
    .map(([agentId, snapshot]) => {
      const phase = snapshot.phase ? `${prettyPhase(snapshot.phase)}${snapshot.round ? ` r${snapshot.round}` : ""}` : "Waiting";
      const status = snapshot.status ?? "idle";
      const action = snapshot.lastAction ?? snapshot.note ?? "Waiting for assignment.";
      return {
        agent: prettyAgent(agentId),
        phase,
        status,
        action,
      };
    });

  const trailRows: ReadonlyArray<FrameworkTrailRow> = coordTrail.slice(-14).map((entry, idx, arr) => ({
    step: arr.length - idx,
    kind: entry.kind,
    agent: entry.agent ?? "System",
    body: entry.body,
    ts: entry.ts,
  }));

  return `<div class="chat-stack">
    ${problemText ? `<div class="chat-row user">
      <div class="chat-label">You</div>
      <div class="chat-bubble">${esc(problemText)}</div>
    </div>` : ""}

    <div class="result-card">
      <div class="result-head">
        <div class="result-title">Merged proof</div>
        <div class="result-pill">${esc(resultStatus)}</div>
      </div>
      <div class="result-meta">${esc(resultMeta)}</div>
      <div class="result-body">${resultBodyHtml}</div>
      ${gapsHtml}
    </div>

    ${frameworkCoordinationHtml({
      palette: "theorem",
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
      contextNote: "Exact receipt-backed prompt slices (problem + memory + claim context). System prompt omitted.",
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
      background: rgba(107,220,255,0.16);
      border-color: rgba(107,220,255,0.4);
    }
    .result-card {
      border-radius: 16px;
      border: 1px solid rgba(195,139,255,0.35);
      background: linear-gradient(140deg, rgba(195,139,255,0.12), rgba(107,220,255,0.08));
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
      border: 1px solid rgba(195,139,255,0.4);
      color: rgba(195,139,255,0.9);
    }
    .result-meta { font-size: 11px; color: rgba(255,255,255,0.6); }
    .result-body { font-size: 13px; line-height: 1.6; color: rgba(255,255,255,0.9); }
    .result-body h2,
    .result-body h3 {
      margin: 14px 0 6px;
      font-size: 14px;
      color: rgba(255,255,255,0.92);
    }
    .result-body p { margin: 6px 0; }
    .result-body ul { margin: 6px 0 8px 18px; padding: 0; }
    .result-body li { margin: 4px 0; }
    .proof-spacer { height: 6px; }
    .proof-empty { font-size: 12px; color: rgba(255,255,255,0.6); }
    .math-block {
      font-family: "IBM Plex Mono", monospace;
      font-size: 12px;
      white-space: pre-wrap;
      padding: 10px 12px;
      margin: 8px 0;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.65);
    }
    .math-inline {
      font-family: "IBM Plex Mono", monospace;
      background: rgba(255,255,255,0.06);
      padding: 0 4px;
      border-radius: 6px;
    }
    .result-gaps ul { margin: 6px 0 0 16px; padding: 0; color: rgba(255,255,255,0.7); font-size: 12px; }
  </style>`;
};

// ============================================================================
// Side panel
// ============================================================================

const latestSummary = (state: TheoremState): { content: string; bracket: string } | undefined => {
  const values = Object.values(state.summaries);
  const sorted = values.sort((a, b) => b.updatedAt - a.updatedAt);
  if (sorted.length === 0) return undefined;
  return { content: sorted[0].content, bracket: sorted[0].bracket };
};

const activityRows = (
  chain: Chain<TheoremEvent>,
  team: ReadonlyArray<TeamMember>,
  statusMap: Readonly<Record<string, { status: "running" | "idle" | "done"; phase?: string; round?: number }>> = {},
  runStatus: "idle" | "running" | "failed" | "completed" = "idle"
): string => {
  const counts = new Map<string, number>();
  const lastIdx = new Map<string, number>();

  const touch = (agentId: string, idx: number) => {
    counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
    lastIdx.set(agentId, idx);
  };

  chain.forEach((r, idx) => {
    const e = r.body;
    switch (e.type) {
      case "problem.set":
      case "attempt.proposed":
      case "lemma.proposed":
      case "critique.raised":
      case "patch.applied":
      case "summary.made":
      case "solution.finalized":
        if (e.agentId) touch(e.agentId, idx);
        break;
      default:
        break;
    }
  });

  const activeThreshold = Math.max(0, chain.length - 12);
  const runComplete = runStatus === "completed" || runStatus === "failed";
  const seen = new Set<string>();
  const rows = team.map((member) => {
    seen.add(member.id);
    const count = counts.get(member.id) ?? 0;
    const status = statusMap[member.id];
    const active = status?.status === "running" || (!runComplete && (lastIdx.get(member.id) ?? -1) >= activeThreshold);
    const tag = status?.status === "running"
      ? `${status.phase ?? "working"}${status.round ? ` r${status.round}` : ""}`
      : active
        ? "active"
        : "idle";
    return `<div class="activity-row ${active ? "active" : "idle"}">
      <div class="activity-dot ${active ? "active" : "idle"}"></div>
      <div class="activity-main">
        <div class="activity-name">${esc(member.name)}</div>
        <div class="activity-meta">${count} receipts</div>
      </div>
      <div class="activity-tag">${esc(tag)}</div>
    </div>`;
  }).join("");

  const extras = [...counts.keys()].filter((id) => !seen.has(id)).map((agentId) => {
    const count = counts.get(agentId) ?? 0;
    const status = statusMap[agentId];
    const active = status?.status === "running" || (!runComplete && (lastIdx.get(agentId) ?? -1) >= activeThreshold);
    const tag = status?.status === "running"
      ? `${status.phase ?? "working"}${status.round ? ` r${status.round}` : ""}`
      : active
        ? "active"
        : "idle";
    return `<div class="activity-row ${active ? "active" : "idle"}">
      <div class="activity-dot ${active ? "active" : "idle"}"></div>
      <div class="activity-main">
        <div class="activity-name">${esc(prettyAgent(agentId))}</div>
        <div class="activity-meta">${count} receipts</div>
      </div>
      <div class="activity-tag">${esc(tag)}</div>
    </div>`;
  }).join("");

  return (rows + extras) || `<div class="empty">No agents yet.</div>`;
};

const contextWindowRows = (chain: Chain<TheoremEvent>): ReadonlyArray<FrameworkContextRow> => {
  const claimOwner = new Map<string, string>();
  chain.forEach((r) => {
    const e = r.body;
    if (e.type === "attempt.proposed" || e.type === "lemma.proposed") {
      claimOwner.set(e.claimId, e.agentId);
    }
  });

  const dedupedPromptEvents = chain
    .filter((r) => r.body.type === "prompt.context")
    .filter((r, idx, arr) => arr.findIndex((x) => x.hash === r.hash) === idx) as Array<{
      ts: number;
      body: Extract<TheoremEvent, { type: "prompt.context" }>;
    }>;
  const recent = dedupedPromptEvents.slice(-8).reverse();

  return recent.map((row, idx) => {
    const e = row.body;
    const agentLabel = e.agentId ? prettyAgent(e.agentId) : "System";
    const title = e.title ?? `${prettyPhase(e.phase)} prompt`;
    const targetAgent = e.targetClaimId ? claimOwner.get(e.targetClaimId) : undefined;
    const metaParts = [
      agentLabel,
      e.round ? `r${e.round}` : "",
      e.claimId ? `#${e.claimId.slice(-4)}` : "",
    ].filter(Boolean);
    const targetLine = targetAgent
      ? `Target: ${prettyAgent(targetAgent)}`
      : e.targetClaimId ? `Target: #${e.targetClaimId.slice(-4)}` : "";
    const body = truncate(e.content.trim() || "No prompt content.", 420);
    return {
      step: recent.length - idx,
      title,
      meta: metaParts.join(" · "),
      target: targetLine || undefined,
      content: body,
      ts: row.ts,
    };
  });
};

type IntegritySummary = {
  readonly ok: boolean;
  readonly sliced?: boolean;
  readonly reason?: string;
};

const verifyDisplaySlice = (slice: Chain<TheoremEvent>): IntegritySummary => {
  if (slice.length === 0) return { ok: true };
  const strict = verify(slice);
  if (strict.ok) return { ok: true };
  if (strict.reason !== "broken prev" || strict.at !== 0) {
    return { ok: false, reason: strict.reason };
  }

  // Branch deltas are intentionally rendered as suffix slices where the first
  // receipt points to an omitted predecessor in the source stream.
  const first = slice[0];
  if (first.hash !== computeHash(first)) return { ok: false, reason: "hash mismatch" };

  let prev = first.hash;
  for (let i = 1; i < slice.length; i += 1) {
    const receipt = slice[i];
    if (receipt.hash !== computeHash(receipt)) return { ok: false, reason: "hash mismatch" };
    if (receipt.prev !== prev) return { ok: false, reason: "broken prev" };
    prev = receipt.hash;
  }

  return { ok: true, sliced: true };
};

const memoryPulseHtml = (chain: Chain<TheoremEvent>): string => {
  const memoryEvent = [...chain].reverse().find((r) => r.body.type === "memory.slice") as
    | { body: Extract<TheoremEvent, { type: "memory.slice" }> }
    | undefined;
  if (!memoryEvent) return `<div class="empty">Memory not built yet.</div>`;

  const e = memoryEvent.body;
  const items = (e.items ?? []).slice(0, 8);
  const bracketNote = e.bracket ? ` · ${esc(e.bracket)}` : "";
  const itemRows = items.map((item) => {
    const label = item.kind.replace(/\./g, " ");
    const claim = item.claimId ? `#${item.claimId.slice(-4)}` : "";
    return `<span class="memory-pill">${esc(label)} ${esc(claim)}</span>`;
  }).join("");
  return `
    <div class="memory-meta">Phase ${esc(e.phase)}${bracketNote} · ${e.itemCount} items · ${e.chars} chars</div>
    <div class="memory-grid">${itemRows || `<span class="memory-pill">No items</span>`}</div>
  `;
};

export const theoremSideHtml = (
  state: TheoremState,
  chain: Chain<TheoremEvent>,
  at: number | null | undefined,
  _total: number,
  indexStream: string,
  runId?: string,
  team: ReadonlyArray<TeamMember> = [],
  chainStream?: string,
  branchStream?: string,
  activityChain?: Chain<TheoremEvent>
): string => {
  const activitySource = activityChain ?? chain;
  const summaryEvents = chain.filter((r) => r.body.type === "summary.made") as Array<{ body: Extract<TheoremEvent, { type: "summary.made" }> }>;
  const rebracketEvents = chain.filter((r) => r.body.type === "rebracket.applied") as Array<{ body: Extract<TheoremEvent, { type: "rebracket.applied" }> }>;
  const latestRebracket = rebracketEvents[rebracketEvents.length - 1]?.body;
  const latestSummaryEvent = summaryEvents[summaryEvents.length - 1]?.body;
  const summaryClaimId = latestSummaryEvent?.claimId;
  const summaryText = summaryClaimId
    ? summaryEvents.filter((r) => r.body.claimId === summaryClaimId).map((r) => r.body.content).join("")
    : "";
  const summary = latestSummaryEvent
    ? { bracket: latestSummaryEvent.bracket, content: summaryText }
    : latestSummary(state);
  const runStream = runId ? `${indexStream}/runs/${runId}` : indexStream;
  const branchPrefix = `${runStream}/branches/`;
  const branchLabel = (b: { id: string; forkAt: number }): string =>
    b.id.startsWith(branchPrefix) ? b.id.slice(branchPrefix.length) : b.id;
  const branches = state.branches
    .map((b) => `<div class="branch-item" title="${esc(b.id)}">${esc(branchLabel(b))} - r${b.forkAt}</div>`)
    .join("");
  const branchOptions = [
    { value: "", label: "Main run" },
    ...state.branches.map((b) => ({ value: b.id, label: branchLabel(b) })),
  ]
    .filter((opt, i, arr) => arr.findIndex((x) => x.value === opt.value) === i)
    .map((opt) => `<option value="${esc(opt.value)}"${opt.value === (branchStream ?? "") ? " selected" : ""}>${esc(opt.label)}</option>`)
    .join("");
  const receipts = [...chain].reverse().slice(0, 30).map((r) => {
    return `<div class="json-item">
      <div class="json-type">${esc(r.body.type)}</div>
      <pre>${esc(truncate(JSON.stringify(r.body, null, 2), 240))}</pre>
    </div>`;
  }).join("");

  const effectiveRun = runId ?? state.runId ?? "";
  const isBranch = Boolean(branchStream);
  const activeChainStream = chainStream ?? runStream;
  const bracketText = latestRebracket?.bracket ?? summary?.bracket ?? (state.solution ? "(bracket pending)" : "((A o B) o C)");
  const noteText = latestRebracket
    ? (latestRebracket.note ?? `Rotation score ${latestRebracket.score.toFixed(2)}`)
    : summary?.content
      ? truncate(summary.content, 120)
      : state.solution
        ? "Final proof ready. Summary not emitted."
        : "Waiting for summary";
  const rebrackets = chain.filter((r) => r.body.type === "rebracket.applied") as Array<{ body: Extract<TheoremEvent, { type: "rebracket.applied" }> }>;
  const appliedRotations = rebrackets.filter((r) => /rotation applied/i.test(r.body.note ?? "")).length;
  const streamNames = [...new Set(chain.map((r) => r.stream))];
  const verifyPerStream = (slice: Chain<TheoremEvent>): IntegritySummary => {
    if (slice.length === 0) return { ok: true };
    let sliced = false;
    for (const stream of streamNames) {
      const streamSlice = slice.filter((r) => r.stream === stream);
      if (streamSlice.length === 0) continue;
      const result = verifyDisplaySlice(streamSlice);
      if (!result.ok) return { ok: false, reason: `${stream}: ${result.reason ?? "invalid"}` };
      sliced = sliced || Boolean(result.sliced);
    }
    return { ok: true, sliced };
  };
  const integrity = streamNames.length <= 1 ? verifyDisplaySlice(chain) : verifyPerStream(chain);
  const integrityLabel = integrity.ok
    ? streamNames.length <= 1
      ? (integrity.sliced ? "ok (slice)" : "ok")
      : `ok (${streamNames.length} streams)`
        + (integrity.sliced ? ", sliced" : "")
    : streamNames.length <= 1
      ? "broken"
      : `broken (${integrity.reason ?? "invalid"})`;
  const memoryPulse = memoryPulseHtml(activitySource);
  const configMetrics = state.config
    ? [
        `Workflow: ${state.config.workflowId}@${state.config.workflowVersion}`,
        `Model: ${state.config.model}`,
        `Prompt hash: ${state.config.promptHash ? state.config.promptHash.slice(0, 8) : "n/a"}`,
        `Rounds: ${state.config.rounds}`,
        `Depth: ${state.config.depth}`,
        `Memory: ${state.config.memoryWindow}`,
        `Branch threshold: ${state.config.branchThreshold}`,
      ]
    : [];
  const statusLabel = state.status.slice(0, 1).toUpperCase() + state.status.slice(1);
  const verificationStatus = state.verification?.status ?? "pending";
  const statusItems = [
    `Run: ${statusLabel}`,
    state.statusNote ? `Note: ${state.statusNote}` : "",
    `Verification: ${verificationStatus}`,
    state.solution ? `Solution confidence: ${state.solution.confidence.toFixed(2)}` : "Solution confidence: —",
  ].filter(Boolean);
  const streamItems = [
    `Index: ${indexStream}`,
    `Run: ${runStream}`,
    `View: ${activeChainStream}${isBranch ? " (branch)" : ""}`,
    `Branches: ${state.branches.length}`,
  ];
  const rebracketPolicy = isBranch
    ? "Branch view follows rebracket events emitted on the main run."
    : "Decider: orchestrator each round. Ranking: causal score, parallel tie-break, stability, lexical.";
  const metrics = [
    ...configMetrics,
    `Receipts: ${chain.length}`,
    `Attempts: ${Object.keys(state.attempts).length}`,
    `Critiques: ${Object.keys(state.critiques).length}`,
    `Patches: ${Object.keys(state.patches).length}`,
    `Summaries: ${Object.keys(state.summaries).length}`,
    isBranch ? "Rebrackets: — (main only)" : `Rebrackets: ${rebrackets.length}`,
    isBranch ? "Rotations applied: — (main only)" : `Rotations applied: ${appliedRotations}`,
    `Branches: ${state.branches.length}`,
    state.solution ? `Confidence: ${state.solution.confidence.toFixed(2)}` : "Confidence: —",
    state.solution?.gaps?.length ? `Gaps: ${state.solution.gaps.length}` : "Gaps: 0",
    state.verification ? `Verification: ${state.verification.status}` : "Verification: —",
    `Integrity: ${integrityLabel}`,
  ];

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
      <div class="branch-list">${branches || `<div class="empty">No branch streams yet.</div>`}</div>
    </section>

    <section class="side-card">
      <h2>Team</h2>
      <div class="activity-list">${activityRows(activitySource, team, state.agentStatus, state.status)}</div>
    </section>

    <section class="side-card">
      <h2>Rebracket</h2>
      <div class="bracket">${esc(bracketText)}</div>
      <div class="bracket-note">${esc(noteText)}</div>
      <div class="policy-note">${esc(rebracketPolicy)}</div>
    </section>

    <section class="side-card">
      <h2>Shared Memory</h2>
      <div class="memory-panel">${memoryPulse}</div>
    </section>

    <section class="side-card">
      <h2>Metrics</h2>
      <div class="metric-list">${metrics.map((m) => `<div class="metric-item">${esc(m)}</div>`).join("")}</div>
      <div class="metric-note">Heuristic only. Use formal proof to verify correctness.</div>
    </section>

    <section class="side-card">
      <h2>Receipts</h2>
      <div class="json-list">${receipts || `<div class="empty">No receipts</div>`}</div>
    </section>
  </div>
  <style>
    .side-stack { display: grid; gap: 16px; }
    .side-card { background: rgba(16,18,24,0.85); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 14px; min-width: 0; }
    .side-card h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.14em; color: rgba(255,255,255,0.55); }
    .memory-panel { display: grid; gap: 8px; }
    .memory-meta { font-size: 11px; color: rgba(255,255,255,0.65); }
    .memory-grid { display: flex; flex-wrap: wrap; gap: 6px; }
    .memory-pill {
      font-size: 10px;
      border-radius: 999px;
      padding: 4px 8px;
      border: 1px solid rgba(107,220,255,0.25);
      color: rgba(107,220,255,0.85);
      background: rgba(107,220,255,0.08);
    }
    .bracket { font-family: "IBM Plex Mono", monospace; font-size: 12px; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.04); }
    .stream-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid rgba(107,220,255,0.3);
      color: rgba(107,220,255,0.9);
      margin-bottom: 8px;
    }
    .bracket-note { font-size: 11px; color: rgba(255,255,255,0.6); margin-top: 8px; }
    .branch-list { display: grid; gap: 8px; min-width: 0; }
    .branch-item { font-size: 11px; color: rgba(255,255,255,0.7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .branch-selector { margin-bottom: 10px; }
    .branch-selector label { display: grid; gap: 6px; font-size: 11px; color: rgba(255,255,255,0.6); }
    .branch-selector select {
      width: 100%;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      padding: 6px 8px;
      color: rgba(255,255,255,0.9);
      font-size: 12px;
    }
    .meta-list { display: grid; gap: 6px; }
    .meta-item {
      font-size: 11px;
      color: rgba(255,255,255,0.8);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      padding: 6px 8px;
      overflow-wrap: anywhere;
    }
    .metric-list { display: grid; gap: 6px; }
    .metric-list.compact { margin-bottom: 10px; }
    .metric-item {
      font-size: 11px;
      color: rgba(255,255,255,0.72);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      padding: 6px 8px;
      overflow-wrap: anywhere;
    }
    .metric-note { margin-top: 8px; font-size: 10px; color: rgba(255,255,255,0.45); }
    .policy-note { margin-top: 8px; font-size: 10px; color: rgba(255,255,255,0.55); line-height: 1.45; }
    .activity-list { display: grid; gap: 10px; }
    .activity-row { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); background: rgba(18,20,28,0.6); }
    .activity-row.active { border-color: rgba(107,220,255,0.35); box-shadow: 0 0 0 1px rgba(107,220,255,0.2) inset; }
    .activity-dot { width: 8px; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.3); }
    .activity-dot.active { background: rgba(107,220,255,0.9); }
    .activity-name { font-size: 12px; font-weight: 600; }
    .activity-meta { font-size: 11px; color: rgba(255,255,255,0.55); }
    .activity-tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: rgba(255,255,255,0.45); }
    .json-list { display: grid; gap: 10px; max-height: 240px; overflow: auto; }
    .json-item { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 8px; background: rgba(18,20,28,0.6); }
    .json-type { font-size: 10px; color: rgba(107,220,255,0.85); margin-bottom: 6px; }
    .json-item pre { margin: 0; font-size: 10px; color: rgba(255,255,255,0.65); white-space: pre-wrap; }
    .time-meta { font-size: 11px; color: rgba(255,255,255,0.6); margin-bottom: 8px; }
    input[type="range"] { width: 100%; }
  </style>`;
};
