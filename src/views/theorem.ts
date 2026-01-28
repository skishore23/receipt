// ============================================================================
// Theorem Guild UI - receipts only
// ============================================================================

import type { Chain } from "../core/types.js";
import { verify, computeHash } from "../core/chain.js";
import type { TheoremEvent, TheoremState } from "../modules/theorem.js";
import type { TheoremRunSummary } from "../agents/theorem.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 3) + "...";

const prettyAgent = (id: string): string =>
  id
    .split(/[-_]/g)
    .map((p) => p.slice(0, 1).toUpperCase() + p.slice(1))
    .join(" ");

const stripTexText = (line: string): string =>
  line.replace(/\\text\{([^}]*)\}/g, (_m, inner) => inner);

const renderInlineMath = (line: string): string =>
  esc(stripTexText(line)).replace(/\\\((.+?)\\\)/g, (_m, inner) => `<span class="math-inline">${inner}</span>`);

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
      mathLines.push(stripTexText(line));
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
  at?: number | null
): string => `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt - Theorem Guild</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.1/sse.js"></script>
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
    .controls form {
      display: grid;
      gap: 10px;
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
      <div class="brand">Theorem Guild</div>
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
      <div class="controls">
        <form hx-post="/theorem/run?stream=${encodeURIComponent(stream)}" hx-swap="none">
          <textarea name="problem" id="tg-problem" placeholder="Paste a theorem / problem statement..." required></textarea>
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
              <span>Branch</span>
              <input type="number" name="branch" min="1" max="6" value="2" />
            </label>
            <button>Run guild</button>
          </div>
        </form>
        <div class="examples">
          ${examples.map(ex => `<button type="button" data-problem="${esc(ex.problem)}">${esc(ex.label)}</button>`).join("")}
        </div>
      </div>

      <div class="run-area" id="tg-chat"
           hx-get="/theorem/island/chat?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:theorem-refresh throttle:1200ms"
           hx-swap="innerHTML">
        <div class="empty">Loading run...</div>
      </div>
    </main>

    <aside class="activity" id="tg-side"
           hx-get="/theorem/island/side?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
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

  for (const r of chain) {
    const e = r.body;
    lastEventLabel = e.type;
    lastEventTs = r.ts;
    switch (e.type) {
      case "problem.set":
        problemText = e.problem;
        items.push({ id: r.id, role: "user", label: "You", content: e.problem });
        break;
      case "attempt.proposed":
        claimOwner.set(e.claimId, e.agentId);
        upsertChat(items, index, e.claimId, {
          role: "agent",
          label: prettyAgent(e.agentId),
          content: e.content,
          kind: "attempt",
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
        break;
      case "critique.raised":
        const targetCrit = claimOwner.get(e.targetClaimId);
        upsertChat(items, index, e.claimId, {
          role: "agent",
          label: `${prettyAgent(e.agentId)} → ${prettyAgent(targetCrit ?? "Claim")}`,
          content: e.content,
          kind: "critique",
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
        break;
      case "summary.made":
        upsertChat(items, index, e.claimId, {
          role: "agent",
          label: `Synthesizer · ${e.bracket}`,
          content: e.content,
          kind: "summary",
        });
        summaryChunks.set(e.claimId, (summaryChunks.get(e.claimId) ?? "") + e.content);
        break;
      case "solution.finalized":
        latestSolution = { content: e.content, confidence: e.confidence, gaps: e.gaps };
        break;
      case "run.status":
        runStatus = e.status;
        runNote = e.note;
        break;
      case "phase.parallel":
        items.push({
          id: r.id,
          role: "system",
          label: "Parallel",
          content: `${e.phase} · ${e.agents.map(prettyAgent).join(", ")}${e.round ? ` (r${e.round})` : ""}`,
          kind: "parallel",
        });
        latestParallel = { phase: e.phase, agents: e.agents, round: e.round };
        break;
      case "verification.report":
        items.push({
          id: r.id,
          role: "system",
          label: "Verifier",
          content: `Status: ${e.status.toUpperCase()}\n${e.content}`,
          kind: "summary",
        });
        break;
      case "agent.status":
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
        break;
      case "branch.created":
        items.push({
          id: r.id,
          role: "system",
          label: "System",
          content: `Branch created: ${e.branchId} at r${e.forkAt}`,
          kind: "branch",
        });
        break;
      default:
        break;
    }
  }

  if (latestSolution && runStatus !== "failed") {
    runStatus = "completed";
  }

  const miniCards = items.filter((msg) => msg.role !== "user").map((msg) => {
    const content = msg.content.trim() || "Thinking...";
    return `<div class="mini-card kind-${msg.kind ?? "attempt"}" title="${esc(content)}">
      <div class="mini-label">${esc(msg.label)}</div>
      <div class="mini-body">${esc(truncate(content, 160))}</div>
    </div>`;
  }).join("");

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

  return `<div class="chat-stack">
    ${problemText ? `<div class="chat-row user">
      <div class="chat-label">You</div>
      <div class="chat-bubble">${esc(problemText)}</div>
    </div>` : ""}

    <div class="result-card">
      <div class="result-head">
        <div class="result-title">Final proof</div>
        <div class="result-pill">${esc(resultStatus)}</div>
      </div>
      <div class="result-meta">${esc(resultMeta)}</div>
      <div class="result-body">${resultBodyHtml}</div>
      ${gapsHtml}
    </div>

    <section class="coordination">
      <div class="coord-head">Coordination feed</div>
      <div class="coord-strip">
        ${miniCards || `<div class="empty">No coordination receipts yet.</div>`}
      </div>
    </section>
  </div>
  <style>
    .chat-stack { display: grid; gap: 18px; }
    .chat { display: grid; gap: 14px; }
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
    .coordination { display: grid; gap: 10px; }
    .coord-head {
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.55);
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
    .mini-card.kind-attempt { border-color: rgba(107,220,255,0.25); }
    .mini-card.kind-lemma { border-color: rgba(110,243,160,0.25); }
    .mini-card.kind-critique { border-color: rgba(255,107,107,0.3); }
    .mini-card.kind-patch { border-color: rgba(195,139,255,0.3); }
    .mini-card.kind-branch { border-color: rgba(255,211,106,0.3); }
    .mini-card.kind-summary { border-color: rgba(107,220,255,0.45); }
    .mini-card.kind-parallel { border-color: rgba(255,211,106,0.55); }
    .mini-card.kind-rebracket { border-color: rgba(110,243,160,0.4); }
    .mini-label { font-size: 11px; color: rgba(255,255,255,0.7); }
    .mini-body { font-size: 12px; color: rgba(255,255,255,0.85); line-height: 1.45; white-space: pre-wrap; }
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

export const theoremSideHtml = (
  state: TheoremState,
  chain: Chain<TheoremEvent>,
  at: number | null | undefined,
  total: number,
  stream: string,
  runId?: string,
  team: ReadonlyArray<TeamMember> = []
): string => {
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
  const branches = state.branches.map((b) => `<div class="branch-item">${esc(b.id)} - r${b.forkAt}</div>`).join("");
  const branchOptions = [stream, ...state.branches.map((b) => b.id)]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .map((name) => `<option value="${esc(name)}"${name === stream ? " selected" : ""}>${esc(name)}</option>`)
    .join("");
  const receipts = [...chain].reverse().slice(0, 30).map((r) => {
    return `<div class="json-item">
      <div class="json-type">${esc(r.body.type)}</div>
      <pre>${esc(truncate(JSON.stringify(r.body, null, 2), 240))}</pre>
    </div>`;
  }).join("");

  const maxAt = total;
  const currentAt = at === null || at === undefined ? maxAt : Math.max(0, Math.min(at, maxAt));
  const effectiveRun = runId ?? state.runId ?? "";
  const isBranch = stream.includes(":");
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
  const verifySlice = (slice: Chain<TheoremEvent>): { ok: boolean; reason?: string } => {
    if (slice.length === 0) return { ok: true };
    if (slice[0].hash !== computeHash(slice[0])) return { ok: false, reason: "hash mismatch" };
    let prev = slice[0].hash;
    for (let i = 1; i < slice.length; i += 1) {
      const r = slice[i];
      if (r.prev !== prev) return { ok: false, reason: "broken prev" };
      if (r.hash !== computeHash(r)) return { ok: false, reason: "hash mismatch" };
      prev = r.hash;
    }
    return { ok: true };
  };
  const integrity = verify(chain);
  const integrityLabel = integrity.ok
    ? "ok"
    : verifySlice(chain).ok
      ? "ok (slice)"
      : "broken";
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
  const metrics = [
    ...configMetrics,
    `Stream: ${stream}${isBranch ? " (branch)" : ""}`,
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
      <h2>Rebracket</h2>
      <div class="stream-pill">${esc(isBranch ? "Branch stream" : "Main stream")}</div>
      <div class="bracket">${esc(bracketText)}</div>
      <div class="bracket-note">${esc(noteText)}</div>
    </section>

    <section class="side-card">
      <h2>Branches</h2>
      <div class="branch-selector">
        <label>
          <span>View stream</span>
          <select onchange="window.location.search = '?stream=' + this.value + '&run=${encodeURIComponent(effectiveRun)}&at=${encodeURIComponent(String(at ?? ""))}'">
            ${branchOptions || `<option value="${esc(stream)}">${esc(stream)}</option>`}
          </select>
        </label>
      </div>
      <div class="branch-list">${branches || `<div class="empty">No branches</div>`}</div>
    </section>

    <section class="side-card">
      <h2>Activity</h2>
      <div class="activity-list">${activityRows(chain, team, state.agentStatus, state.status)}</div>
    </section>

     <section class="side-card">
      <h2>Metrics</h2>
      <div class="metric-list">${metrics.map((m) => `<div class="metric-item">${esc(m)}</div>`).join("")}</div>
      <div class="metric-note">Heuristic only. Use formal proof to verify correctness.</div>
    </section>

    <section class="side-card">
      <h2>Time travel</h2>
      <div class="time-meta">Step ${currentAt} / ${maxAt}</div>
      <input type="range" min="0" max="${maxAt}" value="${currentAt}"
        onchange="window.location.search = '?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(effectiveRun)}&at=' + this.value" />
    </section>

    <section class="side-card">
      <h2>Receipts</h2>
      <div class="json-list">${receipts || `<div class="empty">No receipts</div>`}</div>
    </section>
  </div>
  <style>
    .side-stack { display: grid; gap: 16px; }
    .side-card { background: rgba(16,18,24,0.85); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 14px; }
    .side-card h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.14em; color: rgba(255,255,255,0.55); }
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
    .branch-list { display: grid; gap: 8px; }
    .branch-item { font-size: 11px; color: rgba(255,255,255,0.7); }
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
    .metric-list { display: grid; gap: 6px; }
    .metric-item { font-size: 11px; color: rgba(255,255,255,0.72); }
    .metric-note { margin-top: 8px; font-size: 10px; color: rgba(255,255,255,0.45); }
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
