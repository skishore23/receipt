import { esc, truncate } from "./agent-framework.js";
import type {
  FactoryBoardProjection,
  FactoryComposeModel,
  FactoryDebugProjection,
  FactoryLiveProjection,
  FactoryObjectiveDetail,
} from "../services/factory-service.js";

const statusClass = (value: string): string => value.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
const formatTime = (ts: number | undefined): string => ts ? new Date(ts).toLocaleString() : "n/a";
const shortHash = (value: string | undefined): string => value ? value.slice(0, 8) : "none";
const formatDuration = (ms: number | undefined): string => {
  if (!ms || ms < 1_000) return "<1s";
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};
const factoryQuery = (objectiveId?: string): string =>
  objectiveId ? `?objective=${encodeURIComponent(objectiveId)}` : "";

export const factoryComposeIsland = (model: FactoryComposeModel): string => `
  <section id="factory-compose" class="factory-panel">
    <div class="factory-head">
      <div>
        <h2>Compose Objective</h2>
        <p>Factory is the only objective control surface in v1.</p>
      </div>
      <span>${model.objectiveCount} active</span>
    </div>
    <form
      class="factory-form"
      action="/factory/ui/objectives"
      method="post"
      hx-post="/factory/ui/objectives"
      hx-swap="none"
      hx-on::after-request="if (event.detail.successful) this.reset()">
      <input name="title" placeholder="Receipt-native factory rollout" required />
      <textarea name="prompt" placeholder="Describe the objective, acceptance criteria, and repository constraints." required></textarea>
      <div class="factory-grid two">
        <input name="channel" placeholder="results" value="results" />
        <input name="baseHash" placeholder="optional base commit" />
      </div>
      <textarea name="checks" placeholder="One check per line. Example: npm run build">${esc(model.defaultPolicy.promotion.autoPromote ? "npm run build" : "")}</textarea>
      <textarea name="policy" placeholder='Optional JSON policy override, e.g. {"promotion":{"autoPromote":false}}'></textarea>
      <div class="factory-foot">
        <button type="submit">Launch Objective</button>
        <span>Source branch: <code>${esc(model.sourceBranch ?? model.defaultBranch)}</code></span>
      </div>
      <div class="factory-muted">Launching an objective can take a few seconds while Factory writes receipts and computes the first task graph.</div>
      <div class="factory-note${model.sourceDirty ? " warn" : ""}">
        ${model.sourceDirty
          ? "Objective creation is blocked while the source repo has uncommitted changes unless you provide baseHash explicitly."
          : "Objectives launch from committed Git history and carry explicit policy defaults in the receipt stream."}
      </div>
    </form>
  </section>
`;

const renderCard = (
  card: FactoryBoardProjection["objectives"][number],
  activeId?: string,
): string => {
  const summary = card.status === "blocked" && card.blockedReason
    ? `Blocked: ${card.blockedReason}`
    : card.latestSummary ?? card.blockedReason ?? "No summary yet.";
  return `
  <a class="factory-card${card.objectiveId === activeId ? " active" : ""}" href="/factory${factoryQuery(card.objectiveId)}">
    <div class="factory-card-top">
      <span class="badge ${statusClass(card.status)}">${esc(card.status.replaceAll("_", " "))}</span>
      <span>${esc(formatTime(card.updatedAt))}</span>
    </div>
    <div class="factory-card-title">${esc(truncate(card.title, 92))}</div>
    <div class="factory-card-meta">
      <span>${card.taskCount} tasks</span>
      <span>${card.readyTaskCount} ready</span>
      <span>integration ${esc(card.integrationStatus)}</span>
    </div>
    <div class="factory-card-summary">${esc(truncate(summary, 144))}</div>
    <div class="factory-card-meta">
      <span>${esc(card.lane)}</span>
      <span>${esc(shortHash(card.latestCommitHash))}</span>
    </div>
  </a>
`;
};

const renderLane = (
  title: string,
  cards: ReadonlyArray<FactoryBoardProjection["objectives"][number]>,
  activeId?: string,
): string => `
  <section class="factory-lane">
    <div class="factory-head">
      <h3>${esc(title)}</h3>
      <span>${cards.length}</span>
    </div>
    <div class="factory-lane-body">
      ${cards.length ? cards.map((card) => renderCard(card, activeId)).join("") : `<div class="factory-empty">No objectives.</div>`}
    </div>
  </section>
`;

export const factoryBoardIsland = (board: FactoryBoardProjection): string => `
  <section id="factory-board" class="factory-panel">
    <div class="factory-head">
      <div>
        <h2>Objective Board</h2>
        <p>Receipt-backed objective lanes with no Hub compatibility layer.</p>
      </div>
      <span>${board.objectives.length} objectives</span>
    </div>
    <div class="factory-board-grid">
      ${renderLane("Planning", board.lanes.planning, board.selectedObjectiveId)}
      ${renderLane("Executing", board.lanes.executing, board.selectedObjectiveId)}
      ${renderLane("Integrating", board.lanes.integrating, board.selectedObjectiveId)}
      ${renderLane("Promoting", board.lanes.promoting, board.selectedObjectiveId)}
      ${renderLane("Blocked", board.lanes.blocked, board.selectedObjectiveId)}
      ${renderLane("Completed", board.lanes.completed, board.selectedObjectiveId)}
    </div>
  </section>
`;

const renderTask = (task: FactoryObjectiveDetail["tasks"][number]): string => `
  <article class="factory-item">
    <div class="factory-item-top">
      <strong>${esc(task.taskId)}</strong>
      <span class="badge ${statusClass(task.status)}">${esc(task.status)}</span>
    </div>
    <div class="factory-item-body">
      <div>${esc(task.title)}</div>
      <div class="factory-muted">${esc(task.workerType)} · kind ${esc(task.taskKind)}${task.sourceTaskId ? ` · source ${esc(task.sourceTaskId)}` : ""}</div>
      ${task.dependsOn.length ? `<div class="factory-muted">depends on ${esc(task.dependsOn.join(", "))}</div>` : ""}
      ${task.blockedReason ? `<div class="factory-note warn"><strong>Blocked:</strong> ${esc(task.blockedReason)}</div>` : ""}
      ${task.latestSummary ? `<div>${esc(task.latestSummary)}</div>` : ""}
      <div class="factory-tags">
        ${task.candidateId ? `<span class="tag">${esc(task.candidateId)}</span>` : ""}
        ${task.jobStatus ? `<span class="tag">${esc(task.jobStatus)}</span>` : ""}
        <span class="tag">${task.workspaceExists ? (task.workspaceDirty ? "workspace dirty" : "workspace clean") : "workspace cleared"}</span>
        ${task.elapsedMs ? `<span class="tag">${esc(formatDuration(task.elapsedMs))}</span>` : ""}
      </div>
    </div>
  </article>
`;

const renderCandidate = (candidate: FactoryObjectiveDetail["candidates"][number]): string => `
  <article class="factory-item compact">
    <div class="factory-item-top">
      <strong>${esc(candidate.candidateId)}</strong>
      <span class="badge ${statusClass(candidate.status)}">${esc(candidate.status)}</span>
    </div>
    <div class="factory-item-body">
      <div class="factory-muted">${esc(candidate.taskId)} · base ${esc(shortHash(candidate.baseCommit))}${candidate.headCommit ? ` · head ${esc(shortHash(candidate.headCommit))}` : ""}</div>
      ${candidate.summary ? `<div>${esc(candidate.summary)}</div>` : ""}
      ${candidate.latestReason ? `<div class="factory-muted">${esc(candidate.latestReason)}</div>` : ""}
    </div>
  </article>
`;

export const factoryObjectiveIsland = (detail: FactoryObjectiveDetail | undefined): string => {
  if (!detail) {
    return `
      <section id="factory-objective" class="factory-panel">
        <div class="factory-head"><h2>Objective Detail</h2><span>Select an objective</span></div>
        <div class="factory-empty">Select an objective from the board to inspect tasks, candidates, integration state, and policy budgets.</div>
      </section>
    `;
  }
  const blockedTasks = detail.tasks.filter((task) => task.status === "blocked");
  const blockedReason = detail.blockedReason ?? blockedTasks[0]?.blockedReason;
  const blockedHint = blockedReason?.includes("no tracked diff")
    ? "This task returned analysis without a committed repository change. React will bypass it only when downstream implementation tasks can safely continue."
    : undefined;
  return `
    <section id="factory-objective" class="factory-panel">
      <div class="factory-head">
        <div>
          <h2>${esc(detail.title)}</h2>
          <p>${esc(detail.objectiveId)} · ${esc(detail.status)}</p>
        </div>
        <div class="factory-actions">
          <form action="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/react" method="post" hx-post="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/react" hx-swap="none"><button type="submit">React</button></form>
          ${detail.integration.status === "ready_to_promote"
            ? `<form action="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/promote" method="post" hx-post="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/promote" hx-swap="none"><button type="submit">Promote</button></form>`
            : ""}
          <form action="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/cleanup" method="post" hx-post="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/cleanup" hx-swap="none"><button type="submit">Cleanup</button></form>
          <form action="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/archive" method="post" hx-post="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/archive" hx-swap="none"><button type="submit">Archive</button></form>
          <form action="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/cancel" method="post" hx-post="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/cancel" hx-swap="none"><button type="submit" class="danger">Cancel</button></form>
        </div>
      </div>
      <div class="factory-grid three">
        <div class="factory-stat"><span>Status</span><strong>${esc(detail.status)}</strong></div>
        <div class="factory-stat"><span>Integration</span><strong>${esc(detail.integration.status)}</strong></div>
        <div class="factory-stat"><span>Latest commit</span><strong>${esc(shortHash(detail.latestCommitHash))}</strong></div>
        <div class="factory-stat"><span>Task runs</span><strong>${detail.budgetState.taskRunsUsed}/${detail.policy.budgets.maxTaskRuns}</strong></div>
        <div class="factory-stat"><span>Reconciliation</span><strong>${detail.budgetState.reconciliationTasksUsed}/${detail.policy.budgets.maxReconciliationTasks}</strong></div>
        <div class="factory-stat"><span>Elapsed</span><strong>${detail.budgetState.elapsedMinutes}m</strong></div>
      </div>
      ${blockedReason ? `
        <div class="factory-note warn">
          <strong>Why blocked:</strong> ${esc(blockedReason)}
          ${blockedHint ? `<div class="factory-muted">${esc(blockedHint)}</div>` : ""}
          ${blockedTasks.length
            ? `<div class="factory-muted">Blocked tasks: ${esc(blockedTasks.map((task) => `${task.taskId}${task.blockedReason ? ` (${task.blockedReason})` : ""}`).join(" · "))}</div>`
            : ""}
        </div>
      ` : ""}
      ${detail.budgetState.policyBlockedReason ? `<div class="factory-note warn">${esc(detail.budgetState.policyBlockedReason)}</div>` : ""}
      <details class="factory-detail">
        <summary>Prompt and policy</summary>
        <pre>${esc(detail.prompt)}</pre>
        <pre>${esc(JSON.stringify(detail.policy, null, 2))}</pre>
      </details>
      <div class="factory-split">
        <div>
          <div class="factory-subhead">Tasks</div>
          ${detail.tasks.map(renderTask).join("") || `<div class="factory-empty">No tasks.</div>`}
        </div>
        <div>
          <div class="factory-subhead">Candidates</div>
          ${detail.candidates.map(renderCandidate).join("") || `<div class="factory-empty">No candidates.</div>`}
        </div>
      </div>
    </section>
  `;
};

export const factoryLiveIsland = (live: FactoryLiveProjection): string => `
  <section id="factory-live" class="factory-panel">
    <div class="factory-head">
      <div>
        <h2>Live Console</h2>
        <p>${live.selectedObjectiveId ? `${esc(live.objectiveTitle ?? live.selectedObjectiveId)} · ${esc(live.objectiveStatus ?? "idle")}` : "No selected objective"}</p>
      </div>
      <span>${live.activeTasks.length} active</span>
    </div>
    ${live.activeTasks.length
      ? live.activeTasks.map((task) => `
          <article class="factory-item">
            <div class="factory-item-top">
              <strong>${esc(task.taskId)}</strong>
              <span class="badge ${statusClass(task.jobStatus ?? task.status)}">${esc(task.jobStatus ?? task.status)}</span>
            </div>
            <div class="factory-item-body">
              <div>${esc(task.title)}</div>
              <div class="factory-muted">${esc(task.workerType)} · ${esc(formatDuration(task.elapsedMs))}</div>
              ${task.lastMessage ? `<pre>${esc(task.lastMessage)}</pre>` : ""}
              ${task.stdoutTail ? `<pre>${esc(task.stdoutTail)}</pre>` : ""}
              ${task.stderrTail ? `<pre class="error">${esc(task.stderrTail)}</pre>` : ""}
            </div>
          </article>
        `).join("")
      : `<div class="factory-empty">No active tasks right now.</div>`}
    <details class="factory-detail">
      <summary>Recent jobs</summary>
      <pre>${esc(JSON.stringify(live.recentJobs, null, 2))}</pre>
    </details>
  </section>
`;

export const factoryDebugIsland = (debug: FactoryDebugProjection | undefined): string => {
  if (!debug) {
    return `
      <section id="factory-debug" class="factory-panel">
        <div class="factory-head"><h2>Debug</h2><span>Select an objective</span></div>
        <div class="factory-empty">Debug surfaces appear once an objective is selected.</div>
      </section>
    `;
  }
  return `
    <section id="factory-debug" class="factory-panel">
      <div class="factory-head">
        <div>
          <h2>Debug</h2>
          <p>${esc(debug.objectiveId)} · ${esc(debug.status)}</p>
        </div>
        <span>${debug.activeJobs.length} live jobs</span>
      </div>
      <div class="factory-grid two">
        <details class="factory-detail" open>
          <summary>Policy and budget</summary>
          <pre>${esc(JSON.stringify({ policy: debug.policy, budgetState: debug.budgetState }, null, 2))}</pre>
        </details>
        <details class="factory-detail" open>
          <summary>Context packs</summary>
          <pre>${esc(JSON.stringify(debug.latestContextPacks, null, 2))}</pre>
        </details>
        <details class="factory-detail">
          <summary>Recent receipts</summary>
          <pre>${esc(JSON.stringify(debug.recentReceipts, null, 2))}</pre>
        </details>
        <details class="factory-detail">
          <summary>Jobs</summary>
          <pre>${esc(JSON.stringify({ activeJobs: debug.activeJobs, lastJobs: debug.lastJobs }, null, 2))}</pre>
        </details>
        <details class="factory-detail">
          <summary>Task worktrees</summary>
          <pre>${esc(JSON.stringify(debug.taskWorktrees, null, 2))}</pre>
        </details>
        <details class="factory-detail">
          <summary>Integration worktree</summary>
          <pre>${esc(JSON.stringify(debug.integrationWorktree ?? null, null, 2))}</pre>
        </details>
      </div>
    </section>
  `;
};

export const factoryShell = (opts: {
  readonly composeIsland: string;
  readonly boardIsland: string;
  readonly objectiveIsland: string;
  readonly liveIsland: string;
  readonly debugIsland: string;
}): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Factory</title>
    <script src="/assets/htmx.min.js"></script>
    <script>
      (() => {
        const targets = [
          ["factory-compose", () => "/factory/island/compose"],
          ["factory-board", () => "/factory/island/board" + window.location.search],
          ["factory-objective", () => "/factory/island/objective" + window.location.search],
          ["factory-live", () => "/factory/island/live" + window.location.search],
          ["factory-debug", () => "/factory/island/debug" + window.location.search],
        ];
        const isDirtyField = (field) => {
          if (!(field instanceof HTMLElement) || field.hasAttribute("disabled")) return false;
          if (field instanceof HTMLInputElement) {
            if (field.type === "checkbox" || field.type === "radio") return field.checked !== field.defaultChecked;
            return field.value !== field.defaultValue;
          }
          if (field instanceof HTMLTextAreaElement) return field.value !== field.defaultValue;
          if (field instanceof HTMLSelectElement) {
            return Array.from(field.options).some((option) => option.selected !== option.defaultSelected);
          }
          return false;
        };
        const preserveComposeDraft = () => {
          const compose = document.getElementById("factory-compose");
          if (!compose) return false;
          const form = compose.querySelector("form");
          if (!(form instanceof HTMLFormElement)) return false;
          return Array.from(form.elements).some((field) => isDirtyField(field));
        };
        const loadIsland = async (id, url) => {
          const current = document.getElementById(id);
          if (!current) return;
          if (id === "factory-compose" && preserveComposeDraft()) return;
          const res = await fetch(url, {
            headers: { "HX-Request": "true" },
            cache: "no-store",
          });
          if (!res.ok) return;
          const markup = (await res.text()).trim();
          if (!markup) return;
          const template = document.createElement("template");
          template.innerHTML = markup;
          const next = template.content.firstElementChild;
          if (next) current.replaceWith(next);
        };
        let timer = 0;
        const refresh = () => {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            Promise.all(targets.map(([id, buildUrl]) => loadIsland(id, buildUrl()))).catch(() => undefined);
          }, 120);
        };
        window.addEventListener("DOMContentLoaded", () => {
          const events = new EventSource("/factory/events");
          events.addEventListener("receipt-refresh", refresh);
          events.addEventListener("job-refresh", refresh);
          window.addEventListener("beforeunload", () => events.close(), { once: true });
        }, { once: true });
      })();
    </script>
    <style>
      :root { color-scheme: dark; --bg: #0f1117; --panel: #171b24; --panel-2: #1e2430; --line: #2f3848; --text: #edf1f8; --muted: #97a4b8; --accent: #84d4ff; --warn: #ffd27b; --danger: #ff8f8f; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "IBM Plex Sans", system-ui, sans-serif; background: radial-gradient(circle at top, #1b2230 0%, var(--bg) 45%); color: var(--text); }
      a { color: inherit; text-decoration: none; }
      code, pre { font-family: "IBM Plex Mono", monospace; }
      .factory-shell { max-width: 1500px; margin: 0 auto; padding: 24px; display: grid; gap: 16px; }
      .factory-shell > header { display: flex; justify-content: space-between; gap: 12px; align-items: end; }
      .factory-shell h1, .factory-shell h2, .factory-shell h3 { margin: 0; }
      .factory-shell p { margin: 4px 0 0; color: var(--muted); }
      .factory-panel { border: 1px solid var(--line); background: rgba(23,27,36,0.9); border-radius: 18px; padding: 16px; display: grid; gap: 12px; }
      .factory-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
      .factory-grid { display: grid; gap: 12px; }
      .factory-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .factory-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .factory-form, .factory-split { display: grid; gap: 12px; }
      .factory-split { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); }
      .factory-board-grid { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .factory-lane { border: 1px solid var(--line); border-radius: 14px; padding: 12px; background: rgba(17,20,28,0.72); display: grid; gap: 12px; }
      .factory-lane-body { display: grid; gap: 10px; }
      .factory-card { border: 1px solid var(--line); border-radius: 12px; background: rgba(24,29,39,0.92); padding: 12px; display: grid; gap: 8px; }
      .factory-card.active { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(132,212,255,0.25); }
      .factory-card-top, .factory-card-meta, .factory-item-top, .factory-foot, .factory-actions, .factory-tags { display: flex; gap: 8px; justify-content: space-between; align-items: center; flex-wrap: wrap; }
      .factory-card-summary, .factory-muted { color: var(--muted); font-size: 13px; }
      .factory-card-title { font-size: 15px; font-weight: 600; }
      .factory-item, .factory-stat { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: rgba(18,22,30,0.74); }
      .factory-item.compact { padding: 10px; }
      .factory-item-body { display: grid; gap: 6px; }
      .factory-actions form { margin: 0; }
      .factory-actions button, .factory-form button { cursor: pointer; border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; background: var(--panel-2); color: var(--text); }
      .factory-actions .danger { border-color: rgba(255,143,143,0.45); color: var(--danger); }
      .factory-form input, .factory-form textarea { width: 100%; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: rgba(10,13,19,0.85); color: var(--text); }
      .factory-form textarea { min-height: 110px; resize: vertical; }
      .factory-note { border: 1px solid rgba(132,212,255,0.25); border-radius: 12px; padding: 10px 12px; color: var(--muted); background: rgba(132,212,255,0.08); }
      .factory-note.warn { border-color: rgba(255,210,123,0.35); color: var(--warn); background: rgba(255,210,123,0.08); }
      .factory-empty { padding: 18px; border: 1px dashed var(--line); border-radius: 12px; color: var(--muted); }
      .factory-stat span { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
      .factory-stat strong { display: block; margin-top: 4px; font-size: 16px; }
      .factory-subhead { font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 8px; }
      .factory-detail { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: rgba(15,18,26,0.72); }
      .factory-detail summary { cursor: pointer; font-weight: 600; }
      .badge, .tag { border-radius: 999px; padding: 3px 8px; font-size: 11px; border: 1px solid var(--line); background: rgba(255,255,255,0.04); }
      pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
      pre.error { color: var(--danger); }
      @media (max-width: 1100px) { .factory-board-grid, .factory-split, .factory-grid.two, .factory-grid.three { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main class="factory-shell">
      <header>
        <div>
          <h1>Factory</h1>
          <p>Receipt-native objective orchestration, debugging, and control. Hub no longer owns objective execution.</p>
        </div>
      </header>
      ${opts.composeIsland}
      ${opts.boardIsland}
      ${opts.objectiveIsland}
      ${opts.liveIsland}
      ${opts.debugIsland}
    </main>
  </body>
</html>`;
