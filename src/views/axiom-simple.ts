import type { Chain } from "../core/types.js";
import type { AxiomSimpleRunSummary } from "../agents/axiom-simple.runs.js";
import type { AxiomSimpleEvent, AxiomSimpleState, AxiomSimpleWorkerRecord, AxiomSimpleWorkerSnapshot, AxiomSimpleWorkerStatus } from "../modules/axiom-simple.js";
import {
  esc,
  frameworkCoordinationHtml,
  truncate,
  type FrameworkContextRow,
  type FrameworkLaneRow,
  type FrameworkTrailRow,
} from "./agent-framework.js";

const shortHash = (value?: string): string =>
  value ? value.slice(0, 8) : "—";

const prettyStrategy = (value: string): string => {
  if (value === "final_verify") return "Final Verify";
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
};

const prettyStatus = (status: AxiomSimpleWorkerStatus): string =>
  status === "queued"
    ? "Queued"
    : status === "running"
      ? "Running"
      : status === "completed"
        ? "Completed"
        : status === "failed"
          ? "Failed"
          : status === "canceled"
            ? "Canceled"
            : status === "missing"
              ? "Missing"
              : "Planned";

const resultStatus = (state: AxiomSimpleState): string => {
  if (state.solution?.verificationStatus === "verified") return "Verified";
  if (state.solution?.verificationStatus === "false") return "False";
  if (state.status === "failed") return "Failed";
  if (state.status === "completed") return "Completed";
  return "Running";
};

const workerLink = (worker: AxiomSimpleWorkerRecord, basePath: string): string | undefined => {
  if (!worker.childRunId) return undefined;
  const params = new URLSearchParams({
    stream: worker.childStream ?? "agents/axiom",
    run: worker.childRunId,
  });
  return `${basePath}/worker?${params.toString()}`;
};

const workerExcerpt = (snapshot?: AxiomSimpleWorkerSnapshot): string =>
  snapshot?.outputExcerpt
  ?? snapshot?.validationSummary
  ?? snapshot?.observationExcerpt
  ?? "Waiting for worker output...";

const workerMeta = (worker: AxiomSimpleWorkerRecord): string => {
  const parts = [
    `Strategy ${prettyStrategy(worker.strategy)}`,
    worker.phase !== "initial" ? prettyStrategy(worker.phase) : "",
    worker.snapshot ? `iter ${worker.snapshot.iteration}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
};

const detailsBlock = (worker: AxiomSimpleWorkerRecord): string => {
  const snapshot = worker.snapshot;
  if (!snapshot) return `<div class="as-detail-empty">No child snapshot yet.</div>`;
  const rows = [
    snapshot.lastTool ? `<div><span>Last tool</span><code>${esc(snapshot.lastTool)}</code></div>` : "",
    snapshot.validationSummary ? `<div><span>Validation</span><strong>${esc(snapshot.validationSummary)}</strong></div>` : "",
    snapshot.observationExcerpt ? `<div><span>Observation</span><pre>${esc(snapshot.observationExcerpt)}</pre></div>` : "",
    snapshot.touchedPath ? `<div><span>Path</span><code>${esc(snapshot.touchedPath)}</code></div>` : "",
    `<div><span>Candidate hash</span><code>${esc(shortHash(snapshot.candidateHash))}</code></div>`,
    `<div><span>Statement hash</span><code>${esc(shortHash(snapshot.formalStatementHash))}</code></div>`,
  ].filter(Boolean);
  return `<div class="as-detail-grid">${rows.join("")}</div>`;
};

const workerCardsHtml = (
  state: AxiomSimpleState,
  basePath: string,
): string => {
  const cards = state.workerOrder
    .map((workerId) => state.workers[workerId])
    .filter((worker): worker is AxiomSimpleWorkerRecord => Boolean(worker))
    .sort((left, right) => left.order - right.order)
    .map((worker) => {
      const link = workerLink(worker, basePath);
      const isWinner = state.winner?.workerId === worker.workerId;
      const isVerifier = state.finalVerification?.workerId === worker.workerId;
      return `<article class="as-worker-card ${worker.status} ${isWinner ? "winner" : ""} ${isVerifier ? "verifier" : ""}">
        <div class="as-worker-head">
          <div>
            <div class="as-worker-title">${esc(worker.label)}</div>
            <div class="as-worker-meta">${esc(workerMeta(worker))}</div>
          </div>
          <div class="as-worker-badges">
            ${isWinner ? `<span class="as-badge accent">Winner</span>` : ""}
            ${isVerifier ? `<span class="as-badge verify">Final Verify</span>` : ""}
            <span class="as-badge status ${worker.status}">${esc(prettyStatus(worker.status))}</span>
          </div>
        </div>
        <div class="as-worker-copy">${esc(truncate(workerExcerpt(worker.snapshot), 220))}</div>
        <div class="as-worker-summary">
          <span>${esc(worker.score ? `score ${worker.score.score}` : "score pending")}</span>
          <span>${esc(worker.snapshot ? `failures ${worker.snapshot.failureCount}` : "failures —")}</span>
          <span>${esc(worker.snapshot?.validationGate ?? "no validation")}</span>
        </div>
        <details class="as-worker-details" data-detail-id="${esc(worker.workerId)}">
          <summary>Details</summary>
          ${detailsBlock(worker)}
        </details>
        ${link
          ? `<a class="as-worker-link" href="${link}">Open child run</a>`
          : `<div class="as-worker-link muted">Child run link pending</div>`}
      </article>`;
    }).join("");

  return `<section class="as-workers">
    <div class="as-section-head">
      <div class="as-section-title">Worker Lanes</div>
      <div class="as-section-sub">Each lane is a real Axiom worker. Repair and final verify lanes appear only when used.</div>
    </div>
    <div class="as-worker-strip">${cards || `<div class="empty">No workers yet.</div>`}</div>
  </section>`;
};

const graphHtml = (state: AxiomSimpleState): string => {
  const initialWorkers = state.workerOrder
    .map((workerId) => state.workers[workerId])
    .filter((worker): worker is AxiomSimpleWorkerRecord => Boolean(worker) && worker.phase === "initial");
  const repairWorker = state.workerOrder
    .map((workerId) => state.workers[workerId])
    .find((worker) => worker?.phase === "repair");
  const finalWorker = state.workerOrder
    .map((workerId) => state.workers[workerId])
    .find((worker) => worker?.phase === "final_verify");
  const winner = state.winner ? state.workers[state.winner.workerId] : undefined;

  const workerNodes = initialWorkers.map((worker) =>
    `<div class="as-graph-node branch ${worker.status}">
      <div class="node-title">${esc(worker.label)}</div>
      <div class="node-sub">${esc(prettyStatus(worker.status))}</div>
    </div>`
  ).join("");

  return `<section class="as-graph">
    <div class="as-section-head">
      <div class="as-section-title">Branch / Merge / Loop</div>
      <div class="as-section-sub">The graph reflects orchestration receipts at the current scrub point.</div>
    </div>
    <div class="as-graph-stack">
      <div class="as-graph-node root">
        <div class="node-title">Problem</div>
        <div class="node-sub">${esc(resultStatus(state))}</div>
      </div>
      <div class="as-graph-branch-label">Fan out to workers</div>
      <div class="as-graph-row workers count-${Math.max(2, initialWorkers.length)}">${workerNodes || `<div class="empty">Waiting for initial workers...</div>`}</div>
      <div class="as-graph-merge-label">Merge at selected winner</div>
      <div class="as-graph-node merge ${winner?.status ?? "planned"}">
        <div class="node-title">${esc(winner?.label ?? "Winner pending")}</div>
        <div class="node-sub">${esc(state.winner?.reason ?? "Best candidate not selected yet.")}</div>
      </div>
      ${repairWorker
        ? `<div class="as-graph-loop">Loop through repair from ${esc(winner?.label ?? repairWorker.label)} to ${esc(repairWorker.label)}</div>
           <div class="as-graph-node loop ${repairWorker.status}">
             <div class="node-title">${esc(repairWorker.label)}</div>
             <div class="node-sub">${esc(prettyStatus(repairWorker.status))}</div>
           </div>`
        : `<div class="as-graph-loop muted">No repair loop used.</div>`}
      <div class="as-graph-merge-label">Final verification selection</div>
      <div class="as-graph-node final ${finalWorker?.status ?? "planned"}">
        <div class="node-title">${esc(finalWorker?.label ?? "Final verify pending")}</div>
        <div class="node-sub">${esc(state.finalVerification?.summary ?? "Waiting for final verify.")}</div>
      </div>
    </div>
  </section>`;
};

const buildTrailRows = (
  chain: Chain<AxiomSimpleEvent>,
): ReadonlyArray<FrameworkTrailRow> => {
  const rows: FrameworkTrailRow[] = [];
  const pushRow = (row: FrameworkTrailRow) => {
    const previous = rows[rows.length - 1];
    if (previous && previous.kind === row.kind && previous.agent === row.agent && previous.body === row.body) {
      return;
    }
    rows.push(row);
  };
  for (const receipt of chain) {
    const event = receipt.body;
    switch (event.type) {
      case "problem.set":
        pushRow({ kind: "status", agent: "Orchestrator", body: "Run initialized.", ts: receipt.ts });
        break;
      case "worker.planned":
        pushRow({ kind: "branch", agent: "Orchestrator", body: `Planned ${event.label}.`, ts: receipt.ts });
        break;
      case "worker.started":
        pushRow({ kind: "status", agent: event.workerId, body: `Started child run ${event.childRunId}.`, ts: receipt.ts });
        break;
      case "worker.progressed":
        pushRow({
          kind: "tool",
          agent: event.workerId,
          body: event.snapshot.validationSummary
            ? `${prettyStatus(event.snapshot.status)} · ${event.snapshot.validationSummary}`
            : `${prettyStatus(event.snapshot.status)} · ${event.snapshot.lastTool ?? "waiting"}`,
          ts: receipt.ts,
        });
        break;
      case "worker.completed":
        pushRow({
          kind: "summary",
          agent: event.workerId,
          body: `${prettyStatus(event.status)}${event.summary ? ` · ${event.summary}` : ""}.`,
          ts: receipt.ts,
        });
        break;
      case "candidate.scored":
        pushRow({
          kind: "summary",
          agent: event.workerId,
          body: `Scored ${event.score} · ${event.reason}.`,
          ts: receipt.ts,
        });
        break;
      case "winner.selected":
        pushRow({ kind: "branch", agent: "Orchestrator", body: `Selected ${event.workerId} as winner.`, ts: receipt.ts });
        break;
      case "repair.started":
        pushRow({ kind: "branch", agent: "Orchestrator", body: `Repair loop started from ${event.sourceWorkerId}.`, ts: receipt.ts });
        break;
      case "repair.completed":
        pushRow({ kind: "summary", agent: event.workerId, body: `Repair completed as ${prettyStatus(event.status)}.`, ts: receipt.ts });
        break;
      case "final.verify.started":
        pushRow({ kind: "branch", agent: "Orchestrator", body: `Final verify launched from ${event.sourceWorkerId}.`, ts: receipt.ts });
        break;
      case "final.verify.completed":
        pushRow({ kind: "summary", agent: event.workerId, body: `Final verify: ${event.status}.`, ts: receipt.ts });
        break;
      case "solution.finalized":
        pushRow({ kind: "final", agent: event.workerId, body: `Solution finalized (${event.verificationStatus}).`, ts: receipt.ts });
        break;
      case "failure.report":
        pushRow({ kind: "status", agent: "Orchestrator", body: `${event.failure.failureClass}: ${event.failure.message}`, ts: receipt.ts });
        break;
      case "run.status":
        pushRow({ kind: "status", agent: "Orchestrator", body: `Run marked ${event.status}${event.note ? ` (${event.note})` : ""}.`, ts: receipt.ts });
        break;
      default:
        break;
    }
  }
  return rows.slice(-16).map((row, index, arr) => ({ ...row, step: arr.length - index }));
};

const buildContextRows = (
  state: AxiomSimpleState,
): ReadonlyArray<FrameworkContextRow> =>
  state.workerOrder
    .map((workerId) => state.workers[workerId])
    .filter((worker): worker is AxiomSimpleWorkerRecord => Boolean(worker?.snapshot))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 8)
    .map((worker, index, arr) => ({
      step: arr.length - index,
      title: `${worker.label} snapshot`,
      meta: `${prettyStrategy(worker.strategy)} · ${prettyStatus(worker.status)}`,
      target: worker.snapshot?.touchedPath,
      content: workerExcerpt(worker.snapshot),
      ts: worker.updatedAt,
    }));

const coordinationHtml = (
  state: AxiomSimpleState,
  chain: Chain<AxiomSimpleEvent>,
): string => {
  const metrics = [
    { key: "Run", value: resultStatus(state) },
    { key: "Winner", value: state.winner?.workerId ?? "pending" },
    { key: "Final verify", value: state.finalVerification?.status ?? "pending" },
    { key: "Workers", value: String(state.workerOrder.length) },
  ];
  const lanes: FrameworkLaneRow[] = state.workerOrder
    .map((workerId) => state.workers[workerId])
    .filter((worker): worker is AxiomSimpleWorkerRecord => Boolean(worker))
    .sort((left, right) => left.order - right.order)
    .map((worker) => ({
      agent: worker.label,
      phase: prettyStrategy(worker.phase),
      status: worker.status === "completed"
        ? "done"
        : worker.status === "failed" || worker.status === "canceled" || worker.status === "missing"
          ? "failed"
          : worker.status === "planned" || worker.status === "queued"
            ? "idle"
            : "running",
      action: worker.snapshot?.validationSummary
        ?? worker.snapshot?.lastToolSummary
        ?? worker.summary
        ?? prettyStatus(worker.status),
    }));

  return frameworkCoordinationHtml({
    palette: "theorem",
    metricsTitle: "Orchestration",
    clockLabel: state.statusNote,
    metrics,
    contextTitle: "Worker Excerpts",
    contextSubtitle: "Receipt-backed snapshots copied into the parent stream for scrub-safe inspection.",
    contextNote: "Open a child run for the full AXLE receipt stream and tool-by-tool detail.",
    contextRows: buildContextRows(state),
    boardTitle: "Coordination Trail",
    boardSubtitle: "The trail shows planning, scoring, winner selection, repair loops, and final verification.",
    lanes,
    trail: buildTrailRows(chain),
  });
};

export const axiomSimpleShell = (
  stream: string,
  examples: ReadonlyArray<{ readonly id: string; readonly label: string; readonly problem: string }>,
  activeRun?: string,
  at?: number | null,
  opts?: {
    readonly basePath?: string;
    readonly title?: string;
  },
): string => {
  const basePath = opts?.basePath ?? "/axiom-simple";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(opts?.title ?? "Receipt - Axiom Simple")}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <script src="/assets/htmx.min.js"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.1/sse.js"></script>
  <style>
    :root {
      --bg: #071114;
      --ink: #edf4f2;
      --muted: #8ea19f;
      --line: rgba(255,255,255,0.08);
      --panel: rgba(10,18,19,0.9);
      --accent: #f0c36c;
      --accent-2: #78d7c9;
      --good: #8df0bb;
      --bad: #ff8a8a;
      --warn: #ffd978;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(900px 520px at 70% 0%, rgba(91,108,64,0.24), transparent),
        radial-gradient(760px 440px at 10% 80%, rgba(34,95,88,0.22), transparent),
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
      background: rgba(6,13,14,0.88);
    }
    .brand { font-weight: 700; margin-bottom: 8px; }
    .brand-tag {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(240,195,108,0.45);
      color: rgba(240,195,108,0.95);
      background: rgba(240,195,108,0.12);
      margin-left: 6px;
    }
    .brand-sub { font-size: 11px; color: var(--muted); line-height: 1.45; margin-bottom: 16px; }
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
    .folds { display: grid; gap: 10px; }
    .main { padding: 22px 24px; }
    .controls {
      display: grid;
      gap: 12px;
      padding: 16px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: var(--panel);
    }
    .controls-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
    .controls-sub { font-size: 12px; color: rgba(255,255,255,0.62); line-height: 1.45; }
    .controls form { display: grid; gap: 10px; }
    .controls textarea,
    .controls select {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 12px 14px;
      color: var(--ink);
      font-size: 14px;
      font-family: inherit;
    }
    .controls textarea { min-height: 84px; resize: vertical; }
    .run-controls {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 180px)) auto;
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
      background: linear-gradient(120deg, rgba(240,195,108,0.3), rgba(120,215,201,0.34));
      color: var(--ink);
      border-radius: 12px;
      padding: 12px 18px;
      font-weight: 700;
      cursor: pointer;
      height: fit-content;
    }
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
    .travel-island {
      margin-top: 16px;
      margin-bottom: 18px;
      min-height: 90px;
      border-radius: 14px;
      border: 1px solid rgba(240,195,108,0.25);
      background: linear-gradient(120deg, rgba(240,195,108,0.12), rgba(120,215,201,0.1));
      padding: 14px;
    }
    .run-area { display: grid; gap: 18px; }
    .activity { padding: 22px 18px 22px 0; }
    .empty {
      border-radius: 14px;
      border: 1px dashed rgba(255,255,255,0.14);
      padding: 18px;
      color: rgba(255,255,255,0.62);
      text-align: center;
    }
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
    .fold-item.active { border-color: rgba(120,215,201,0.45); }
    .fold-head { display: flex; align-items: center; gap: 8px; }
    .fold-dot { width: 8px; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.2); }
    .fold-dot.done { background: rgba(141,240,187,0.9); }
    .fold-dot.running { background: rgba(120,215,201,0.9); }
    .fold-dot.failed { background: rgba(255,138,138,0.9); }
    .fold-title { font-size: 12px; font-weight: 600; }
    .fold-meta { font-size: 11px; color: rgba(255,255,255,0.5); }
  </style>
</head>
<body hx-ext="sse" sse-connect="${basePath}/stream?stream=${encodeURIComponent(stream)}">
  <div class="app">
    <aside class="sidebar">
      <div class="brand">Axiom Simple <span class="brand-tag">AXLE</span></div>
      <div class="brand-sub">Deterministic orchestration outside. Real Axiom workers inside.</div>
      <button class="new-run" type="button" onclick="window.location.href='${basePath}?stream=${encodeURIComponent(stream)}&run=new'">+ New Run</button>
      <div class="nav-title">Runs</div>
      <div id="as-folds" class="folds"
           hx-get="${basePath}/island/folds?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:theorem-refresh throttle:800ms"
           hx-swap="innerHTML">
        <div class="empty">Loading runs...</div>
      </div>
    </aside>

    <main class="main">
      <div class="controls">
        <div class="controls-title">Axiom Simple Run</div>
        <div class="controls-sub">Fan out to a few real Lean workers, score their evidence, optionally repair once, then require an explicit final verify pass.</div>
        <form hx-post="${basePath}/run?stream=${encodeURIComponent(stream)}" hx-swap="none">
          <textarea id="as-problem" name="problem" placeholder="State the theorem or Lean proving task."></textarea>
          <div class="run-controls">
            <label>
              <span>Workers</span>
              <select name="workerCount">
                <option value="2">2</option>
                <option value="3" selected>3</option>
              </select>
            </label>
            <label>
              <span>Repair</span>
              <select name="repairMode">
                <option value="auto" selected>Auto</option>
                <option value="off">Off</option>
              </select>
            </label>
            <button>Run Axiom Simple</button>
          </div>
        </form>
        <div class="examples">
          ${examples.map((example) => `<button type="button" data-problem="${esc(example.problem)}">${esc(example.label)}</button>`).join("")}
        </div>
      </div>

      <div id="as-travel" class="travel-island"
           hx-get="${basePath}/island/travel?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:theorem-refresh throttle:700ms"
           hx-swap="innerHTML">
        <div class="empty">Loading time travel...</div>
      </div>

      <div id="as-chat" class="run-area"
           hx-get="${basePath}/island/chat?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:theorem-refresh throttle:1000ms"
           hx-swap="innerHTML">
        <div class="empty">Loading run...</div>
      </div>
    </main>

    <aside class="activity" id="as-side"
           hx-get="${basePath}/island/side?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun ?? "")}&at=${encodeURIComponent(String(at ?? ""))}"
           hx-trigger="load, sse:theorem-refresh throttle:800ms"
           hx-swap="innerHTML">
      <div class="empty">Loading panels...</div>
    </aside>
  </div>

  <script>
    (() => {
      const input = document.getElementById("as-problem");
      document.querySelectorAll(".examples button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const problem = btn.getAttribute("data-problem");
          if (problem && input) input.value = problem;
        });
      });

      const storeDetails = () => {
        const openIds = [...document.querySelectorAll(".as-worker-details[open]")]
          .map((node) => node.getAttribute("data-detail-id"))
          .filter(Boolean);
        document.body.dataset.axiomSimpleOpen = JSON.stringify(openIds);
        const strip = document.querySelector(".as-worker-strip");
        if (strip) document.body.dataset.axiomSimpleScroll = String(strip.scrollLeft || 0);
      };

      const restoreDetails = () => {
        try {
          const openIds = JSON.parse(document.body.dataset.axiomSimpleOpen || "[]");
          openIds.forEach((id) => {
            const node = document.querySelector('.as-worker-details[data-detail-id="' + id + '"]');
            if (node) node.setAttribute("open", "open");
          });
        } catch (_err) {}
        const strip = document.querySelector(".as-worker-strip");
        if (strip && document.body.dataset.axiomSimpleScroll) {
          strip.scrollLeft = Number(document.body.dataset.axiomSimpleScroll) || 0;
        }
      };

      document.body.addEventListener("htmx:beforeSwap", storeDetails);
      document.body.addEventListener("htmx:afterSwap", restoreDetails);
    })();
  </script>
</body>
</html>`;
};

export const axiomSimpleFoldsHtml = (
  stream: string,
  runs: ReadonlyArray<AxiomSimpleRunSummary>,
  activeRun?: string,
  at?: number | null,
  opts?: { readonly basePath?: string },
): string => {
  const basePath = opts?.basePath ?? "/axiom-simple";
  if (runs.length === 0) return `<div class="empty">No runs yet.</div>`;
  const items = runs.map((run) => {
    const active = run.runId === activeRun;
    const statusClass = run.status === "done" ? "done" : run.status === "failed" ? "failed" : "running";
    const when = run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "-";
    return `<a class="fold-item ${active ? "active" : ""} ${statusClass}"
      href="${basePath}?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(run.runId)}&at=${encodeURIComponent(String(at ?? ""))}">
      <div class="fold-head">
        <span class="fold-dot ${statusClass}"></span>
        <span class="fold-title">${esc(truncate(run.problem || run.runId, 30))}</span>
      </div>
      <div class="fold-meta">${esc(when)} · ${run.count} receipts</div>
    </a>`;
  }).join("");
  return `<div class="fold-list">${items}</div>`;
};

export const axiomSimpleTravelHtml = (opts: {
  readonly stream: string;
  readonly runId?: string;
  readonly at: number | null | undefined;
  readonly total: number;
  readonly basePath?: string;
}): string => {
  const { stream, runId, at, total } = opts;
  const basePath = opts.basePath ?? "/axiom-simple";
  if (!runId) {
    return `<div class="travel-hero">
      <div class="travel-title">Time travel</div>
      <div class="travel-meta">Select a run to scrub orchestration receipts.</div>
    </div>`;
  }
  const maxAt = Math.max(0, total);
  const currentAt = at === null || at === undefined ? maxAt : Math.max(0, Math.min(at, maxAt));
  const isPast = currentAt < maxAt;
  const params = (nextAt?: number | null): string => {
    const q = new URLSearchParams({ stream, run: runId });
    if (nextAt !== undefined && nextAt !== null && nextAt < maxAt) q.set("at", String(nextAt));
    return `${basePath}/travel?${q.toString()}`;
  };
  return `<div class="travel-hero">
    <div class="travel-head">
      <div class="travel-title">Time travel</div>
      <div class="travel-pill ${isPast ? "past" : "live"}">${isPast ? "past view" : "live head"}</div>
    </div>
    <div class="travel-meta">Scrub the parent orchestration stream. Worker cards render from the latest snapshot visible at that step.</div>
    <div class="travel-row">
      <div class="travel-actions">
        <button type="button" class="travel-btn" ${currentAt <= 0 ? "disabled" : ""} hx-get="${params(0)}" hx-swap="none">Start</button>
        <button type="button" class="travel-btn" ${currentAt <= 0 ? "disabled" : ""} hx-get="${params(Math.max(0, currentAt - 1))}" hx-swap="none">Back</button>
        <button type="button" class="travel-btn" ${currentAt >= maxAt ? "disabled" : ""} hx-get="${params(Math.min(maxAt, currentAt + 1))}" hx-swap="none">Forward</button>
        <button type="button" class="travel-btn" ${currentAt >= maxAt ? "disabled" : ""} hx-get="${params(null)}" hx-swap="none">Live</button>
      </div>
      <form class="travel-scrub">
        <input type="hidden" name="stream" value="${esc(stream)}" />
        <input type="hidden" name="run" value="${esc(runId)}" />
        <input class="travel-slider" type="range" min="0" max="${maxAt}" value="${currentAt}" name="at"
          hx-get="${basePath}/travel" hx-include="closest form" hx-trigger="change delay:90ms" hx-swap="none" />
      </form>
      <div class="travel-step">Step ${currentAt} / ${maxAt}</div>
    </div>
    <style>
      .travel-hero { display: grid; gap: 10px; }
      .travel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .travel-title { font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
      .travel-meta { font-size: 12px; color: rgba(255,255,255,0.72); line-height: 1.45; }
      .travel-pill {
        font-size: 10px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.18);
        padding: 3px 8px;
      }
      .travel-pill.live { color: rgba(141,240,187,0.95); border-color: rgba(141,240,187,0.35); }
      .travel-pill.past { color: rgba(255,217,120,0.95); border-color: rgba(255,217,120,0.35); }
      .travel-row { display: grid; gap: 10px; align-items: center; }
      .travel-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .travel-btn {
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.05);
        color: inherit;
        border-radius: 999px;
        padding: 6px 10px;
        cursor: pointer;
      }
      .travel-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
      .travel-slider { width: 100%; }
      .travel-step { font-size: 11px; color: rgba(255,255,255,0.7); }
    </style>
  </div>`;
};

export const axiomSimpleChatHtml = (
  state: AxiomSimpleState,
  chain: Chain<AxiomSimpleEvent>,
  opts?: { readonly basePath?: string },
): string => {
  if (chain.length === 0) return `<div class="empty">No run selected.</div>`;
  const basePath = opts?.basePath ?? "/axiom-simple";
  const finalText = state.solution?.content?.trim()
    || state.finalVerification?.summary
    || state.statusNote
    || "Waiting for worker output...";
  const finalGaps = state.solution?.gaps?.length
    ? `<ul class="as-result-gaps">${state.solution.gaps.map((gap) => `<li>${esc(gap)}</li>`).join("")}</ul>`
    : "";
  return `<div class="as-chat-stack">
    <section class="as-result-card">
      <div class="as-result-head">
        <div>
          <div class="as-result-title">Selected Output</div>
          <div class="as-result-meta">${esc(state.problem)}</div>
        </div>
        <div class="as-result-pill">${esc(resultStatus(state))}</div>
      </div>
      <div class="as-result-grid">
        <div><span>Winner</span><strong>${esc(state.winner?.workerId ?? "pending")}</strong></div>
        <div><span>Final verify</span><strong>${esc(state.finalVerification?.status ?? "pending")}</strong></div>
      </div>
      <pre class="as-result-body">${esc(finalText)}</pre>
      ${finalGaps}
    </section>

    ${workerCardsHtml(state, basePath)}
    ${graphHtml(state)}
    ${coordinationHtml(state, chain)}

    <style>
      .as-chat-stack { display: grid; gap: 18px; }
      .as-section-head { display: grid; gap: 4px; }
      .as-section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
      .as-section-sub { font-size: 12px; color: rgba(255,255,255,0.62); line-height: 1.45; }
      .as-result-card,
      .as-workers,
      .as-graph {
        border-radius: 16px;
        border: 1px solid rgba(240,195,108,0.2);
        background: rgba(10,18,19,0.88);
        padding: 16px 18px;
        display: grid;
        gap: 12px;
      }
      .as-result-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .as-result-title { font-size: 14px; font-weight: 700; }
      .as-result-meta { font-size: 12px; color: rgba(255,255,255,0.62); margin-top: 4px; line-height: 1.45; }
      .as-result-pill {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        border-radius: 999px;
        border: 1px solid rgba(120,215,201,0.4);
        padding: 4px 8px;
        color: rgba(120,215,201,0.95);
      }
      .as-result-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .as-result-grid > div {
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
        padding: 8px 10px;
        display: grid;
        gap: 4px;
      }
      .as-result-grid span { font-size: 10px; color: rgba(255,255,255,0.55); text-transform: uppercase; letter-spacing: 0.08em; }
      .as-result-body,
      .as-detail-grid pre {
        margin: 0;
        padding: 12px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
        font-size: 12px;
        line-height: 1.5;
        font-family: "IBM Plex Mono", monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .as-result-gaps {
        margin: 0;
        padding-left: 18px;
        color: rgba(255,255,255,0.72);
        display: grid;
        gap: 6px;
      }
      .as-worker-strip {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        overflow-x: auto;
        padding-bottom: 2px;
      }
      .as-worker-card {
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
        padding: 14px;
        display: grid;
        gap: 10px;
        min-width: 0;
      }
      .as-worker-card.running,
      .as-worker-card.queued { border-color: rgba(120,215,201,0.36); }
      .as-worker-card.completed { border-color: rgba(141,240,187,0.32); }
      .as-worker-card.failed,
      .as-worker-card.canceled,
      .as-worker-card.missing { border-color: rgba(255,138,138,0.34); }
      .as-worker-card.winner { box-shadow: 0 0 0 1px rgba(240,195,108,0.32) inset; }
      .as-worker-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
      .as-worker-title { font-size: 13px; font-weight: 700; }
      .as-worker-meta { font-size: 11px; color: rgba(255,255,255,0.56); margin-top: 4px; }
      .as-worker-badges { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
      .as-badge {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.18);
        padding: 4px 7px;
      }
      .as-badge.accent { border-color: rgba(240,195,108,0.45); color: rgba(240,195,108,0.95); }
      .as-badge.verify { border-color: rgba(120,215,201,0.45); color: rgba(120,215,201,0.95); }
      .as-badge.status.completed { border-color: rgba(141,240,187,0.4); color: rgba(141,240,187,0.95); }
      .as-badge.status.failed,
      .as-badge.status.canceled,
      .as-badge.status.missing { border-color: rgba(255,138,138,0.42); color: rgba(255,138,138,0.95); }
      .as-badge.status.running,
      .as-badge.status.queued { border-color: rgba(120,215,201,0.4); color: rgba(120,215,201,0.95); }
      .as-worker-copy { font-size: 13px; line-height: 1.5; color: rgba(255,255,255,0.86); }
      .as-worker-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        font-size: 11px;
        color: rgba(255,255,255,0.62);
      }
      .as-worker-details summary {
        cursor: pointer;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(255,255,255,0.68);
      }
      .as-detail-grid { display: grid; gap: 10px; margin-top: 10px; }
      .as-detail-grid div {
        display: grid;
        gap: 6px;
      }
      .as-detail-grid span {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(255,255,255,0.52);
      }
      .as-detail-grid code {
        font-family: "IBM Plex Mono", monospace;
        font-size: 12px;
      }
      .as-detail-empty { margin-top: 10px; font-size: 12px; color: rgba(255,255,255,0.6); }
      .as-worker-link { font-size: 12px; color: rgba(120,215,201,0.95); text-decoration: none; }
      .as-worker-link.muted { color: rgba(255,255,255,0.5); }
      .as-graph-stack { display: grid; gap: 10px; }
      .as-graph-row.workers {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .as-graph-node,
      .as-graph-loop {
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.03);
        padding: 12px;
      }
      .as-graph-node.root { border-color: rgba(240,195,108,0.35); }
      .as-graph-node.merge { border-color: rgba(120,215,201,0.35); }
      .as-graph-node.loop { border-color: rgba(255,217,120,0.35); }
      .as-graph-node.final { border-color: rgba(141,240,187,0.35); }
      .as-graph-node.failed,
      .as-graph-node.canceled,
      .as-graph-node.missing { border-color: rgba(255,138,138,0.36); }
      .node-title { font-size: 12px; font-weight: 700; }
      .node-sub { font-size: 11px; color: rgba(255,255,255,0.64); margin-top: 4px; line-height: 1.45; }
      .as-graph-branch-label,
      .as-graph-merge-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: rgba(255,255,255,0.48);
      }
      .as-graph-loop.muted { color: rgba(255,255,255,0.56); }
      @media (max-width: 1180px) {
        .app { grid-template-columns: 1fr; }
        .activity { padding: 0 24px 24px; }
      }
    </style>
  </div>`;
};

export const axiomSimpleSideHtml = (
  state: AxiomSimpleState,
  _chain: Chain<AxiomSimpleEvent>,
  opts?: { readonly basePath?: string },
): string => {
  const basePath = opts?.basePath ?? "/axiom-simple";
  const workers = state.workerOrder
    .map((workerId) => state.workers[workerId])
    .filter((worker): worker is AxiomSimpleWorkerRecord => Boolean(worker));
  const linkedRuns = workers
    .filter((worker) => worker.childRunId)
    .map((worker) => ({
      worker,
      href: workerLink(worker, basePath) ?? "#",
    }));
  const touchedPaths = [...new Set(
    workers
      .map((worker) => worker.snapshot?.touchedPath)
      .filter((value): value is string => Boolean(value))
  )];
  const scoreRows = workers
    .filter((worker) => worker.score)
    .sort((left, right) => (right.score?.score ?? 0) - (left.score?.score ?? 0));

  return `<div class="as-side-stack">
    <section class="as-side-panel">
      <div class="as-side-title">Run Overview</div>
      <div class="as-side-grid">
        <div class="as-side-card"><div class="k">Status</div><div class="v">${esc(resultStatus(state))}</div></div>
        <div class="as-side-card"><div class="k">Workers</div><div class="v">${esc(String(state.workerOrder.length))}</div></div>
        <div class="as-side-card"><div class="k">Winner</div><div class="v">${esc(state.winner?.workerId ?? "pending")}</div></div>
        <div class="as-side-card"><div class="k">Repair</div><div class="v">${esc(state.config?.repairMode ?? "auto")}</div></div>
        <div class="as-side-card"><div class="k">Final Verify</div><div class="v">${esc(state.finalVerification?.status ?? "pending")}</div></div>
        <div class="as-side-card"><div class="k">Workflow</div><div class="v">${esc(state.config ? `${state.config.workflowId}@${state.config.workflowVersion}` : "-")}</div></div>
      </div>
    </section>

    <section class="as-side-panel">
      <div class="as-side-title">Candidate Scores</div>
      ${scoreRows.length > 0
        ? `<div class="as-score-list">${scoreRows.map((worker) => `<div class="as-score-row">
            <div class="name">${esc(worker.label)}</div>
            <div class="score">${esc(String(worker.score?.score ?? 0))}</div>
            <div class="reason">${esc(worker.score?.reason ?? "")}</div>
          </div>`).join("")}</div>`
        : `<div class="empty">Scores appear after workers finish.</div>`}
    </section>

    <section class="as-side-panel">
      <div class="as-side-title">Evidence</div>
      <div class="as-meta-list">
        <div class="as-meta-item">Final summary: ${esc(state.finalVerification?.summary ?? "pending")}</div>
        <div class="as-meta-item">Candidate hash: ${esc(shortHash(state.finalVerification?.snapshot.candidateHash))}</div>
        <div class="as-meta-item">Statement hash: ${esc(shortHash(state.finalVerification?.snapshot.formalStatementHash))}</div>
        <div class="as-meta-item">Validation: ${esc(state.finalVerification?.validation?.summary ?? "—")}</div>
      </div>
    </section>

    <section class="as-side-panel">
      <div class="as-side-title">Linked Runs</div>
      ${linkedRuns.length > 0
        ? `<div class="as-link-list">${linkedRuns.map(({ worker, href }) => `<a href="${href}" class="as-link-row">${esc(worker.label)} · ${esc(worker.childRunId ?? "")}</a>`).join("")}</div>`
        : `<div class="empty">No child runs yet.</div>`}
    </section>

    <section class="as-side-panel">
      <div class="as-side-title">Touched Files</div>
      ${touchedPaths.length > 0
        ? `<ul class="as-path-list">${touchedPaths.map((item) => `<li><code>${esc(item)}</code></li>`).join("")}</ul>`
        : `<div class="empty">No touched files recorded yet.</div>`}
    </section>

    <style>
      .as-side-stack { display: grid; gap: 12px; }
      .as-side-panel {
        display: grid;
        gap: 10px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(10,18,19,0.9);
        padding: 12px;
      }
      .as-side-title {
        font-size: 11px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.68);
        font-weight: 700;
      }
      .as-side-grid {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .as-side-card {
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
        padding: 8px 9px;
      }
      .as-side-card .k {
        font-size: 10px;
        color: rgba(255,255,255,0.5);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 4px;
      }
      .as-side-card .v {
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .as-score-list,
      .as-link-list,
      .as-meta-list { display: grid; gap: 8px; }
      .as-score-row {
        display: grid;
        gap: 3px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
        padding: 8px 9px;
      }
      .as-score-row .name { font-size: 12px; font-weight: 700; }
      .as-score-row .score { font-size: 11px; color: rgba(240,195,108,0.95); }
      .as-score-row .reason { font-size: 11px; color: rgba(255,255,255,0.64); line-height: 1.45; }
      .as-link-row {
        text-decoration: none;
        color: rgba(120,215,201,0.95);
        font-size: 12px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
        padding: 8px 9px;
      }
      .as-meta-item {
        font-size: 12px;
        line-height: 1.45;
        color: rgba(255,255,255,0.78);
      }
      .as-path-list {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 6px;
      }
      .as-path-list code {
        font-family: "IBM Plex Mono", monospace;
        font-size: 11px;
      }
    </style>
  </div>`;
};
