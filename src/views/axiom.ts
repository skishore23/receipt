import type { Chain } from "../core/types.js";
import type { AgentEvent, AgentState } from "../modules/agent.js";
import { esc, truncate } from "./agent-framework.js";

export type AxiomRunSummary = {
  readonly runId: string;
  readonly problem: string;
  readonly status: "running" | "failed" | "completed" | "idle";
  readonly count: number;
  readonly startedAt?: number;
};

const prettyTool = (name: string): string =>
  name
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part, index) => index === 0 ? part : part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");

const formatClock = (ts?: number): string => ts ? new Date(ts).toLocaleTimeString() : "-";

const formatJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const eventBadgeClass = (event: AgentEvent): string => {
  switch (event.type) {
    case "problem.set":
      return "user";
    case "thought.logged":
    case "response.finalized":
      return "agent";
    case "tool.called":
    case "tool.observed":
      return "tool";
    case "validation.report":
      return event.ok ? "ok" : "bad";
    case "failure.report":
      return "bad";
    case "run.status":
      return event.status === "completed" ? "ok" : event.status === "failed" ? "bad" : "system";
    default:
      return "system";
  }
};

export const axiomShell = (
  stream: string,
  examples: ReadonlyArray<{ readonly id: string; readonly label: string; readonly problem: string }>,
  activeRun?: string,
  at?: number | null
): string => `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt - AXLE Theorem Agent</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.1/sse.js"></script>
  <style>
    :root {
      --bg: #081012;
      --ink: #f2f5f2;
      --muted: #97a3a2;
      --line: rgba(255,255,255,0.08);
      --panel: rgba(12,18,18,0.9);
      --accent: #8cffc1;
      --accent-2: #7fd8ff;
      --ok: #84f8b1;
      --bad: #ff8787;
      --warn: #ffd978;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--ink);
      background: radial-gradient(920px 560px at 62% 0%, rgba(40,96,68,0.24), transparent),
                  radial-gradient(760px 440px at 18% 80%, rgba(42,76,96,0.2), transparent),
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
      background: rgba(8,14,15,0.85);
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
      border: 1px solid rgba(140,255,193,0.38);
      color: rgba(140,255,193,0.95);
      background: rgba(140,255,193,0.12);
    }
    .brand-sub {
      font-size: 11px;
      color: var(--muted);
      margin-top: -8px;
      margin-bottom: 16px;
      line-height: 1.45;
    }
    .nav-title {
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 10px 0;
    }
    .new-run {
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-weight: 700;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .controls-title .pill {
      font-size: 10px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      border-radius: 999px;
      border: 1px solid rgba(127,216,255,0.4);
      color: rgba(127,216,255,0.92);
      background: rgba(127,216,255,0.12);
      padding: 3px 8px;
    }
    .controls-sub {
      font-size: 12px;
      color: rgba(255,255,255,0.62);
      line-height: 1.45;
    }
    .controls form {
      display: grid;
      gap: 10px;
    }
    .controls textarea,
    .controls input,
    .controls select {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 12px 14px;
      color: var(--ink);
      font-size: 14px;
      font-family: inherit;
    }
    .controls textarea {
      min-height: 84px;
      resize: vertical;
    }
    .run-controls {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
      gap: 10px;
      align-items: end;
    }
    .run-controls label {
      display: grid;
      gap: 6px;
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .controls button {
      border: none;
      background: linear-gradient(120deg, rgba(140,255,193,0.28), rgba(127,216,255,0.32));
      color: var(--ink);
      font-weight: 700;
      border-radius: 12px;
      padding: 12px 18px;
      cursor: pointer;
      height: fit-content;
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
    .travel-island {
      margin-bottom: 20px;
      min-height: 90px;
      border-radius: 14px;
      border: 1px solid rgba(140,255,193,0.25);
      background: linear-gradient(120deg, rgba(140,255,193,0.15), rgba(127,216,255,0.1));
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
      border-color: rgba(132,248,177,0.55);
      color: rgba(132,248,177,0.95);
      background: rgba(132,248,177,0.12);
    }
    .travel-pill.past {
      border-color: rgba(255,217,120,0.55);
      color: rgba(255,217,120,0.95);
      background: rgba(255,217,120,0.12);
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
    .travel-btn[disabled] {
      pointer-events: none;
      opacity: 0.35;
    }
    .travel-slider { width: 100%; accent-color: #8cffc1; }
    .travel-step { font-size: 11px; color: rgba(255,255,255,0.75); white-space: nowrap; }
    .run-area {
      margin-top: 16px;
      display: grid;
      gap: 12px;
    }
    .activity {
      padding: 18px 16px;
      border-left: 1px solid var(--line);
      background: rgba(8,14,15,0.85);
    }
    .empty { color: var(--muted); font-size: 12px; }
    @media (max-width: 1180px) {
      .app { grid-template-columns: 220px minmax(0, 1fr); }
      .activity { display: none; }
    }
    @media (max-width: 920px) {
      .app { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--line); }
      .run-controls { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body hx-ext="sse" sse-connect="/axiom/stream?stream=${encodeURIComponent(stream)}">
  <div class="app">
    <aside class="sidebar">
      <div class="brand">AXLE Theorem Agent <span class="brand-tag">axiom</span></div>
      <div class="brand-sub">Long-horizon Lean worker. AXLE is the default verifier and repair engine.</div>
      <div class="nav-title">Runs</div>
      <button class="new-run" type="button" onclick="window.location.href='/axiom?stream=${encodeURIComponent(stream)}&run=new'">+ New Run</button>
      <div id="ax-folds"
           class="folds"
           hx-get="/axiom/island/folds?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:agent-refresh throttle:800ms"
           hx-swap="innerHTML">
        <div class="empty">Loading runs...</div>
      </div>
    </aside>

    <main class="main">
      <div id="ax-travel"
           class="travel-island"
           hx-get="/axiom/island/travel?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:agent-refresh throttle:700ms"
           hx-swap="innerHTML">
        <div class="empty">Loading time travel...</div>
      </div>

      <div class="controls">
        <div class="controls-title">
          <span>AXLE-Powered Lean Search</span>
          <span class="pill">public demo</span>
        </div>
        <div class="controls-sub">Use real AXLE tools like <code>lean.verify_file</code>, <code>lean.repair_file</code>, <code>lean.disprove_file</code>, and <code>lean.theorem2sorry_file</code> inside the agent loop. Local Lean is optional fallback, not the default path.</div>
        <form hx-post="/axiom/run?stream=${encodeURIComponent(stream)}" hx-swap="none">
          <textarea name="problem" id="ax-problem" placeholder="Describe the Lean theorem task, target file, and what should be validated with AXLE..." required></textarea>
          <div class="run-controls">
            <label>
              <span>Iterations</span>
              <input type="number" name="maxIterations" min="1" max="80" value="24" />
            </label>
            <label>
              <span>Environment</span>
              <input type="text" name="leanEnvironment" value="lean-4.28.0" />
            </label>
            <label>
              <span>Auto Repair</span>
              <select name="autoRepair">
                <option value="true" selected>true</option>
                <option value="false">false</option>
              </select>
            </label>
            <button>Run Axiom</button>
          </div>
          <input type="hidden" name="memoryScope" value="axiom" />
          <input type="hidden" name="workspace" value="." />
          <input type="hidden" name="localValidationMode" value="off" />
        </form>
        <div class="examples">
          ${examples.map((example) => `<button type="button" data-problem="${esc(example.problem)}">${esc(example.label)}</button>`).join("")}
        </div>
      </div>

      <div class="run-area" id="ax-chat"
           hx-get="/axiom/island/chat?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:agent-refresh throttle:1200ms"
           hx-swap="innerHTML">
        <div class="empty">Loading run...</div>
      </div>
    </main>

    <aside class="activity" id="ax-side"
           hx-get="/axiom/island/side?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:agent-refresh throttle:800ms"
           hx-swap="innerHTML">
      <div class="empty">Loading panels...</div>
    </aside>
  </div>

  <script>
    (() => {
      const input = document.getElementById("ax-problem");
      document.querySelectorAll(".examples button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const problem = btn.getAttribute("data-problem");
          if (problem && input) input.value = problem;
        });
      });
    })();
  </script>
</body>
</html>`;

export const axiomFoldsHtml = (
  stream: string,
  runs: ReadonlyArray<AxiomRunSummary>,
  activeRun?: string,
  at?: number | null
): string => {
  const entries: ReadonlyArray<AxiomRunSummary> = runs.length > 0
    ? runs
    : (activeRun
      ? [{ runId: activeRun, problem: "Waiting for first receipt...", status: "running", count: 0, startedAt: undefined }]
      : []);
  if (entries.length === 0) return `<div class="empty">No runs yet.</div>`;

  const items = entries.map((run) => {
    const active = run.runId === activeRun;
    const statusClass = run.status === "completed"
      ? "done"
      : run.status === "failed"
        ? "failed"
        : "running";
    const when = run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "queued";
    return `<a class="fold-item ${active ? "active" : ""} ${statusClass}"
      href="/axiom?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(run.runId)}&at=${encodeURIComponent(String(at ?? ""))}">
      <div class="fold-head">
        <span class="fold-dot ${statusClass}"></span>
        <span class="fold-title">${esc(truncate(run.problem || run.runId, 34))}</span>
      </div>
      <div class="fold-meta">${esc(when)} · ${run.count} receipts</div>
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
    .fold-item.active { border-color: rgba(140,255,193,0.45); }
    .fold-head { display: flex; align-items: center; gap: 8px; }
    .fold-dot { width: 8px; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.2); }
    .fold-dot.done { background: rgba(132,248,177,0.82); }
    .fold-dot.running { background: rgba(127,216,255,0.85); }
    .fold-dot.failed { background: rgba(255,135,135,0.9); }
    .fold-title { font-size: 12px; font-weight: 600; }
    .fold-meta { font-size: 11px; color: rgba(255,255,255,0.5); }
  </style>`;
};

export const axiomTravelHtml = (opts: {
  readonly stream: string;
  readonly runId?: string;
  readonly at: number | null | undefined;
  readonly total: number;
}): string => {
  const { stream, runId, at, total } = opts;
  if (!runId) {
    return `<div class="travel-hero">
      <div class="travel-head">
        <div class="travel-title">Time travel</div>
        <div class="travel-pill">idle</div>
      </div>
      <div class="travel-meta">Select a run to scrub the receipt log and inspect exactly which AXLE tools fired and why.</div>
    </div>`;
  }

  const maxAt = Math.max(0, total);
  const currentAt = at === null || at === undefined ? maxAt : Math.max(0, Math.min(at, maxAt));
  const isPast = currentAt < maxAt;
  const params = (nextAt?: number | null): string => {
    const q = new URLSearchParams({ stream, run: runId });
    if (nextAt !== undefined && nextAt !== null && nextAt < maxAt) q.set("at", String(nextAt));
    return `/axiom/travel?${q.toString()}`;
  };
  const atStart = currentAt <= 0;
  const atHead = currentAt >= maxAt;

  return `<div class="travel-hero">
    <div class="travel-head">
      <div class="travel-title">Time travel</div>
      <div class="travel-pill ${isPast ? "past" : "live"}">${isPast ? "past view" : "live head"}</div>
    </div>
    <div class="travel-meta">Replay a prefix of the run to inspect strategy, tool calls, and validation gates without losing the live head.</div>
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
        <input class="travel-slider" type="range" min="0" max="${maxAt}" value="${currentAt}" name="at"
          hx-get="/axiom/travel" hx-include="closest form" hx-trigger="change delay:90ms" hx-swap="none" />
      </form>
      <div class="travel-step">Receipt ${currentAt} / ${maxAt}</div>
    </div>
  </div>`;
};

export const axiomChatHtml = (chain: Chain<AgentEvent>, runId?: string): string => {
  if (chain.length === 0) {
    return runId
      ? `<div class="empty">Run <code>${esc(runId)}</code> is queued. Waiting for first receipt...</div>`
      : `<div class="empty">No run selected.</div>`;
  }

  const cards = chain.map((receipt) => {
    const event = receipt.body;
    const badge = eventBadgeClass(event);
    const ts = new Date(receipt.ts).toLocaleTimeString();
    const heading = (() => {
      switch (event.type) {
        case "problem.set":
          return "Problem";
        case "run.configured":
          return "Run Configured";
        case "failure.report":
          return `Failure · ${prettyTool(event.failure.failureClass)}`;
        case "run.status":
          return `Run ${event.status}`;
        case "iteration.started":
          return `Iteration ${event.iteration}`;
        case "thought.logged":
          return "Reasoning";
        case "action.planned":
          return event.actionType === "tool"
            ? `Plan · ${prettyTool(event.name ?? "tool")}`
            : "Plan · Final answer";
        case "tool.called":
          return `Tool · ${prettyTool(event.tool)}`;
        case "tool.observed":
          return `Observation · ${prettyTool(event.tool)}`;
        case "validation.report":
          return `Validation · ${event.gate}`;
        case "response.finalized":
          return "Final response";
        case "config.updated":
          return "Config updated";
        case "memory.slice":
          return `Memory slice · ${event.scope}`;
        case "context.pruned":
          return `Context pruned · ${event.mode}`;
        case "context.compacted":
          return `Context compacted · ${event.reason}`;
        case "overflow.recovered":
          return "Overflow recovered";
        case "subagent.merged":
          return `Subagent merged · ${event.subRunId}`;
        case "agent.delegated":
          return `Delegated · ${event.delegatedTo}`;
        case "memory.flushed":
          return `Memory flushed · ${event.scope}`;
      }
    })();

    const body = (() => {
      switch (event.type) {
        case "problem.set":
          return `<pre>${esc(event.problem)}</pre>`;
        case "run.configured":
          return `<pre>${esc(formatJson({
            workflow: event.workflow,
            model: event.model,
            config: event.config,
            promptHash: event.promptHash,
            promptPath: event.promptPath,
          }))}</pre>`;
        case "failure.report":
          return `<div class="meta-row">
            <span class="meta-pill bad">${esc(event.failure.failureClass)}</span>
            <span class="meta-pill">${esc(event.failure.stage)}</span>
            ${typeof event.failure.iteration === "number" ? `<span class="meta-pill">iter ${event.failure.iteration}</span>` : ""}
            ${event.failure.retryable === true ? `<span class="meta-pill warn">retryable</span>` : ""}
          </div>
          <div class="card-copy">${esc(event.failure.message)}</div>
          ${event.failure.details ? `<pre>${esc(event.failure.details)}</pre>` : ""}
          ${event.failure.evidence ? `<pre>${esc(formatJson(event.failure.evidence))}</pre>` : ""}`;
        case "run.status":
          return event.note ? `<div class="card-copy">${esc(event.note)}</div>` : `<div class="card-copy">No status note.</div>`;
        case "iteration.started":
          return `<div class="card-copy">Iteration ${event.iteration} started.</div>`;
        case "thought.logged":
          return `<div class="card-copy">${esc(event.content)}</div>`;
        case "action.planned":
          return event.actionType === "tool"
            ? `<pre>${esc(formatJson({ name: event.name, input: event.input ?? {} }))}</pre>`
            : `<div class="card-copy">Preparing final response.</div>`;
        case "tool.called":
          return `<div class="meta-row">
            ${event.summary ? `<span class="meta-pill">${esc(event.summary)}</span>` : ""}
            ${typeof event.durationMs === "number" ? `<span class="meta-pill">${Math.round(event.durationMs)} ms</span>` : ""}
            ${event.error ? `<span class="meta-pill bad">${esc(event.error)}</span>` : ""}
          </div>
          <pre>${esc(formatJson(event.input))}</pre>`;
        case "tool.observed":
          return `<pre>${esc(event.output)}</pre>`;
        case "validation.report":
          return `<div class="meta-row">
            <span class="meta-pill ${event.ok ? "ok" : "bad"}">${event.ok ? "pass" : "fail"}</span>
            ${event.target ? `<span class="meta-pill">${esc(event.target)}</span>` : ""}
          </div>
          <div class="card-copy">${esc(event.summary)}</div>
          ${event.details ? `<pre>${esc(event.details)}</pre>` : ""}`;
        case "response.finalized":
          return `<pre>${esc(event.content)}</pre>`;
        case "config.updated":
          return `<pre>${esc(formatJson(event.config))}</pre>`;
        case "memory.slice":
          return `<div class="meta-row">
            <span class="meta-pill">${event.itemCount} items</span>
            <span class="meta-pill">${event.chars} chars</span>
            ${event.truncated ? `<span class="meta-pill warn">truncated</span>` : ""}
          </div>
          ${event.query ? `<div class="card-copy">query: ${esc(event.query)}</div>` : ""}`;
        case "context.pruned":
          return `<div class="card-copy">${event.before} -> ${event.after}${event.note ? ` · ${esc(event.note)}` : ""}</div>`;
        case "context.compacted":
          return `<div class="card-copy">${event.before} -> ${event.after}${event.note ? ` · ${esc(event.note)}` : ""}</div>`;
        case "overflow.recovered":
          return `<div class="card-copy">${esc(event.note ?? "Recovered from model context overflow.")}</div>`;
        case "subagent.merged":
          return `<div class="card-copy">${esc(event.task)}</div><pre>${esc(event.summary)}</pre>`;
        case "agent.delegated":
          return `<div class="card-copy">${esc(event.task)}</div><pre>${esc(event.summary)}</pre>`;
        case "memory.flushed":
          return `<div class="card-copy">${event.chars} chars committed to <code>${esc(event.scope)}</code>.</div>`;
      }
    })();

    return `<article class="event-card ${badge}">
      <div class="event-head">
        <div>
          <div class="event-title">${esc(heading)}</div>
          <div class="event-meta">${esc(ts)}${"agentId" in event && event.agentId ? ` · ${esc(event.agentId)}` : ""}</div>
        </div>
        <span class="event-badge ${badge}">${esc(event.type)}</span>
      </div>
      ${body}
    </article>`;
  }).join("");

  return `<div class="event-feed">${cards}</div>
  <style>
    .event-feed { display: grid; gap: 12px; }
    .event-card {
      display: grid;
      gap: 10px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(12,18,18,0.88);
      padding: 14px;
    }
    .event-card.agent { border-color: rgba(140,255,193,0.22); }
    .event-card.user { border-color: rgba(127,216,255,0.24); }
    .event-card.tool { border-color: rgba(255,255,255,0.12); }
    .event-card.ok { border-color: rgba(132,248,177,0.32); }
    .event-card.bad { border-color: rgba(255,135,135,0.32); }
    .event-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .event-title { font-size: 13px; font-weight: 700; }
    .event-meta { font-size: 11px; color: rgba(255,255,255,0.54); margin-top: 2px; }
    .event-badge {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.16);
      padding: 4px 8px;
      white-space: nowrap;
    }
    .event-badge.agent { border-color: rgba(140,255,193,0.35); color: rgba(140,255,193,0.95); }
    .event-badge.user { border-color: rgba(127,216,255,0.35); color: rgba(127,216,255,0.95); }
    .event-badge.tool,
    .event-badge.system { color: rgba(255,255,255,0.76); }
    .event-badge.ok { border-color: rgba(132,248,177,0.35); color: rgba(132,248,177,0.95); }
    .event-badge.bad { border-color: rgba(255,135,135,0.38); color: rgba(255,135,135,0.95); }
    .card-copy { font-size: 13px; line-height: 1.5; color: rgba(255,255,255,0.86); }
    .meta-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .meta-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.14);
      padding: 3px 8px;
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.8);
      background: rgba(255,255,255,0.04);
    }
    .meta-pill.ok { border-color: rgba(132,248,177,0.35); color: rgba(132,248,177,0.95); }
    .meta-pill.bad { border-color: rgba(255,135,135,0.38); color: rgba(255,135,135,0.95); }
    .meta-pill.warn { border-color: rgba(255,217,120,0.35); color: rgba(255,217,120,0.95); }
    .event-card pre {
      margin: 0;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      font-size: 12px;
      line-height: 1.5;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>`;
};

export const axiomSideHtml = (opts: {
  readonly state: AgentState;
  readonly chain: Chain<AgentEvent>;
  readonly at: number | null | undefined;
  readonly total: number;
  readonly runId?: string;
}): string => {
  const { state, chain, at, total, runId } = opts;
  if (!runId) return `<div class="empty">Select a run to inspect AXLE tools, validation gates, and final status.</div>`;

  const toolCalls = chain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.called" }> } =>
    receipt.body.type === "tool.called"
  );
  const usedTools = [...new Set(toolCalls.map((receipt) => receipt.body.tool))];
  const validations = chain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
    receipt.body.type === "validation.report"
  ).slice(-8).reverse();
  const paths = [...new Set(
    toolCalls.flatMap((receipt) => {
      const input = receipt.body.input;
      const values = [input.path, input.outputPath, input.output_path, input.formalStatementPath, input.formal_statement_path, input.outputDir, input.output_dir];
      return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    })
  )];

  const extra = state.config?.extra ?? {};
  const summaryCards = [
    { k: "Status", v: `${state.status}${state.statusNote ? ` · ${state.statusNote}` : ""}` },
    { k: "Iteration", v: `${state.iteration} / ${state.config?.maxIterations ?? "-"}` },
    { k: "Workflow", v: state.config ? `${state.config.workflowId} ${state.config.workflowVersion}` : "-" },
    { k: "Model", v: state.config?.model ?? "-" },
    { k: "Workspace", v: state.config?.workspace ?? "." },
    { k: "Lean Env", v: typeof extra.leanEnvironment === "string" ? extra.leanEnvironment : "-" },
    { k: "Auto Repair", v: String(extra.autoRepair ?? false) },
    { k: "Local Validation", v: String(extra.localValidationMode ?? "off") },
    { k: "Receipts", v: `${chain.length}${at === null || at === undefined ? ` / ${total}` : ` / ${total}`}` },
  ];

  return `<div class="side-stack">
    <section class="side-panel">
      <div class="side-title">Run Overview</div>
      <div class="side-grid">
        ${summaryCards.map((row) => `<div class="side-card"><div class="k">${esc(row.k)}</div><div class="v">${esc(row.v)}</div></div>`).join("")}
      </div>
    </section>

    <section class="side-panel">
      <div class="side-title">AXLE Tools Used</div>
      ${usedTools.length > 0
        ? `<div class="pill-list">${usedTools.map((tool) => `<span class="tool-pill">${esc(tool)}</span>`).join("")}</div>`
        : `<div class="empty">No tool calls yet.</div>`}
    </section>

    <section class="side-panel">
      <div class="side-title">Validation Gates</div>
      ${validations.length > 0
        ? `<div class="validation-list">${validations.map((receipt) => {
            const event = receipt.body;
            return `<div class="validation-row ${event.ok ? "ok" : "bad"}">
              <div class="validation-head">
                <span>${esc(event.gate)}</span>
                <span>${esc(formatClock(receipt.ts))}</span>
              </div>
              <div class="validation-summary">${esc(event.summary)}</div>
              ${event.target ? `<div class="validation-target">${esc(event.target)}</div>` : ""}
            </div>`;
          }).join("")}</div>`
        : `<div class="empty">No validation receipts yet.</div>`}
    </section>

    <section class="side-panel">
      <div class="side-title">Touched Files</div>
      ${paths.length > 0
        ? `<ul class="side-list">${paths.map((entry) => `<li><code>${esc(entry)}</code></li>`).join("")}</ul>`
        : `<div class="empty">No file paths recorded yet.</div>`}
    </section>

    ${state.finalResponse
      ? `<section class="side-panel">
          <div class="side-title">Latest Final Response</div>
          <pre>${esc(state.finalResponse)}</pre>
        </section>`
      : ""}
  </div>
  <style>
    .side-stack { display: grid; gap: 12px; }
    .side-panel {
      display: grid;
      gap: 10px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(12,18,18,0.9);
      padding: 12px;
    }
    .side-title {
      font-size: 11px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.7);
      font-weight: 700;
    }
    .side-grid {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .side-card {
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      padding: 8px 9px;
    }
    .side-card .k {
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    .side-card .v {
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .pill-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .tool-pill {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 10px;
      border-radius: 999px;
      border: 1px solid rgba(127,216,255,0.28);
      background: rgba(127,216,255,0.1);
      color: rgba(127,216,255,0.96);
      padding: 4px 8px;
    }
    .validation-list { display: grid; gap: 8px; }
    .validation-row {
      display: grid;
      gap: 5px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      padding: 8px 9px;
    }
    .validation-row.ok { border-color: rgba(132,248,177,0.22); }
    .validation-row.bad { border-color: rgba(255,135,135,0.24); }
    .validation-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      font-weight: 600;
    }
    .validation-summary { font-size: 11px; color: rgba(255,255,255,0.82); line-height: 1.45; }
    .validation-target {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 10px;
      color: rgba(255,255,255,0.58);
      overflow-wrap: anywhere;
    }
    .side-list {
      margin: 0;
      padding-left: 16px;
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: rgba(255,255,255,0.86);
    }
    .side-panel pre {
      margin: 0;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      font-size: 12px;
      line-height: 1.5;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>`;
};
