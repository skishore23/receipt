import { esc, truncate } from "./agent-framework.js";
import type {
  HubCommitView,
  HubDashboardModel,
  HubObjectiveCard,
  ObjectivePassView,
} from "../services/hub-service.js";

const shortHash = (hash: string | undefined): string => hash ? hash.slice(0, 8) : "none";
const formatTime = (ts: number): string => new Date(ts).toLocaleString();
const statusClass = (status: string): string => status.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
const formatDuration = (ms: number | undefined): string => {
  if (!ms || ms < 1_000) return "<1s";
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};
const truncateMiddle = (value: string, head = 10, tail = 10): string =>
  value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
const shortenPath = (value: string, parts = 2): string => {
  const split = value.split("/").filter(Boolean);
  return split.length <= parts ? value : `…/${split.slice(-parts).join("/")}`;
};

const renderCard = (card: HubObjectiveCard, activeId?: string): string => `
  <a
    class="objective-card${card.objectiveId === activeId ? " active" : ""}"
    href="/hub?objective=${encodeURIComponent(card.objectiveId)}"
    hx-get="/hub/island/dashboard?objective=${encodeURIComponent(card.objectiveId)}"
    hx-target="#hub-dashboard"
    hx-push-url="/hub?objective=${encodeURIComponent(card.objectiveId)}">
    <div class="card-top">
      <span class="badge ${statusClass(card.status)}">${esc(card.status.replaceAll("_", " "))}</span>
      ${card.activeJobStatus ? `<span class="mini-status">${esc(card.activeJobStatus)}${card.activeElapsedMs ? ` · ${esc(formatDuration(card.activeElapsedMs))}` : ""}</span>` : ""}
    </div>
    <div class="card-title">${esc(truncate(card.title, 84))}</div>
    <div class="card-meta">
      ${card.assignedAgentId ? `<span>${esc(card.assignedAgentId)}</span>` : `<span>unassigned</span>`}
      ${card.currentPhase ? `<span>${esc(card.currentPhase)}</span>` : ""}
    </div>
    ${(card.activeJobStatus === "running" || card.activeJobStatus === "leased" || card.activeJobStatus === "queued") && card.liveActivity
      ? `<div class="card-summary live">${esc(truncate(card.liveActivity, 120))}</div>`
      : card.latestSummary
        ? `<div class="card-summary">${esc(truncate(card.latestSummary, 140))}</div>`
        : `<div class="card-summary muted">No summary yet.</div>`}
    <div class="card-foot">
      ${card.latestCommitHash ? `<span class="hash">${esc(shortHash(card.latestCommitHash))}</span>` : `<span class="hash muted">no commit</span>`}
      <span class="time">${esc(formatTime(card.updatedAt))}</span>
    </div>
  </a>
`;

const renderLane = (
  title: string,
  subtitle: string,
  cards: ReadonlyArray<HubObjectiveCard>,
  activeId?: string,
): string => `
  <section class="lane">
    <div class="lane-head">
      <div>
        <h3>${esc(title)}</h3>
        <div class="lane-sub">${esc(subtitle)}</div>
      </div>
      <span class="lane-count">${cards.length}</span>
    </div>
    <div class="lane-body">
      ${cards.length === 0 ? `<div class="empty">No objectives.</div>` : cards.map((card) => renderCard(card, activeId)).join("")}
    </div>
  </section>
`;

const renderObjectiveForm = (model: HubDashboardModel): string => `
  <section class="panel objective-compose">
    <div class="panel-head">
      <h2>Create Objective</h2>
      <span>${model.objectives.length} tracked</span>
    </div>
    <form class="objective-form" hx-post="/hub/ui/objectives" hx-swap="none">
      <input name="title" placeholder="Add agent deletion to /hub" required />
      <input name="baseHash" placeholder="Base commit (optional)" />
      <select name="channel">
        ${model.channels.map((channel) => `<option value="${esc(channel)}"${channel === "results" ? " selected" : ""}>${esc(channel)}</option>`).join("")}
      </select>
      <textarea name="prompt" placeholder="Describe the objective, acceptance criteria, and any repo-specific constraints." required></textarea>
      <textarea name="checks" placeholder="One shell command per line. Default: npm run build">npm run build</textarea>
      <button type="submit">Create Objective</button>
    </form>
    ${model.sourceDirty ? `
      <div class="form-note warn">
        New objectives are blocked while the source repo has uncommitted changes. Commit or stash first, or set an explicit base commit.
      </div>
    ` : `
      <div class="form-note">Objectives start from committed Git history on <span class="mono">${esc(model.sourceBranch ?? model.defaultBranch)}</span>.</div>
    `}
  </section>
`;

const renderSourceWarning = (model: HubDashboardModel): string => {
  if (!model.sourceDirty) return "";
  const changed = model.sourceChangedFiles.slice(0, 6);
  return `
    <section class="panel warning-panel">
      <div class="panel-head">
        <h2>Source Repo Has Uncommitted Changes</h2>
        <span>${model.sourceChangedFiles.length} changed</span>
      </div>
      <div class="warning-copy">
        Objectives only see committed Git history. The planner that ran from ${esc(shortHash(model.sourceHead))} cannot see your uncommitted local edits.
        Commit or stash the repo first, or create the objective with an explicit base commit if you want to run from an older snapshot.
      </div>
      ${changed.length
        ? `<div class="warning-files">${changed.map((file) => `<span class="warning-file" title="${esc(file)}">${esc(truncate(file, 56))}</span>`).join("")}</div>`
        : ""}
    </section>
  `;
};

const renderPass = (pass: ObjectivePassView): string => `
  <article class="pass-row">
    <div class="pass-top">
      <span class="pass-title">${esc(`${pass.phase} #${pass.passNumber}`)}</span>
      <span class="badge ${statusClass(pass.jobStatus)}">${esc(pass.jobStatus)}${pass.elapsedMs ? ` · ${esc(formatDuration(pass.elapsedMs))}` : ""}</span>
    </div>
    <div class="pass-meta">
      <span>${esc(pass.agentId)}</span>
      <span>${esc(shortHash(pass.baseCommit))}</span>
      ${pass.commitHash ? `<span>${esc(shortHash(pass.commitHash))}</span>` : ""}
      <span>${esc(formatTime(pass.dispatchedAt))}</span>
    </div>
    ${pass.summary ? `<div class="pass-summary">${esc(pass.summary)}</div>` : ""}
    ${pass.handoff ? `<div class="pass-handoff">${esc(truncate(pass.handoff, 280))}</div>` : ""}
    <div class="pass-meta">
      <span title="${esc(pass.workspacePath)}">${esc(shortenPath(pass.workspacePath, 3))}</span>
      <span>${pass.workspaceExists ? "exists" : "missing"}</span>
      <span>${pass.workspaceDirty ? "dirty" : "clean"}</span>
    </div>
    ${pass.activity ? `<div class="pass-live">${esc(pass.activity)}</div>` : ""}
    ${pass.checkResults?.length
      ? `<div class="check-list">${pass.checkResults.map((check) => `
          <div class="check ${check.ok ? "ok" : "bad"}">
            <span>${esc(check.command)}</span>
            <span>${check.ok ? "ok" : `exit ${check.exitCode ?? 1}`}</span>
          </div>
        `).join("")}</div>`
      : ""}
  </article>
`;

const renderActiveCodex = (pass: ObjectivePassView | undefined): string => {
  if (!pass) return "";
  if (!(pass.jobStatus === "queued" || pass.jobStatus === "leased" || pass.jobStatus === "running")) return "";
  return `
    <section class="active-pass">
      <div class="panel-head">
        <h2>Active Codex</h2>
        <span>${esc(pass.phase)} #${pass.passNumber}${pass.elapsedMs ? ` · ${esc(formatDuration(pass.elapsedMs))}` : ""}</span>
      </div>
      <div class="detail-kv">
        <span>${esc(pass.agentId)}</span>
        <span title="${esc(pass.workspacePath)}">${esc(shortenPath(pass.workspacePath, 3))}</span>
      </div>
      <pre class="live-log">${esc(pass.stdoutTail || pass.lastMessage || "Codex started. Waiting for output...")}</pre>
      ${pass.stderrTail ? `<pre class="live-log error">${esc(pass.stderrTail)}</pre>` : ""}
    </section>
  `;
};

const renderObjectiveDetail = (model: HubDashboardModel): string => {
  const objective = model.selectedObjective;
  if (!objective) {
    return `
      <section class="panel detail-panel">
        <div class="panel-head">
          <h2>Objective Detail</h2>
          <span>Select a card</span>
        </div>
        <div class="empty">Create an objective or select one from a lane to inspect its passes, review state, and candidate commit.</div>
      </section>
    `;
  }
  const canApprove = objective.status === "awaiting_confirmation";
  const canCancel = objective.status !== "completed" && objective.status !== "canceled";
  return `
    <section class="panel detail-panel">
      <div class="panel-head">
        <div class="detail-title-wrap">
          <h2>${esc(objective.title)}</h2>
          <div class="detail-id" title="${esc(objective.objectiveId)}">${esc(truncateMiddle(objective.objectiveId, 12, 10))}</div>
        </div>
      </div>
      <div class="detail-badges">
        <span class="badge ${statusClass(objective.status)}">${esc(objective.status.replaceAll("_", " "))}</span>
        ${objective.assignedAgentId ? `<span class="tag">${esc(objective.assignedAgentId)}</span>` : ""}
        ${objective.latestCommitHash ? `<span class="tag">commit ${esc(shortHash(objective.latestCommitHash))}</span>` : ""}
      </div>
      <div class="detail-grid compact">
        <div>
          <div class="detail-label">Objective</div>
          <div class="detail-text">${esc(objective.prompt)}</div>
        </div>
        <div>
          <div class="detail-label">Checks</div>
          <div class="detail-text">${objective.checks.length ? objective.checks.map((check) => esc(check)).join("<br/>") : "None"}</div>
        </div>
        <div>
          <div class="detail-label">Base Commit</div>
          <div class="detail-text mono" title="${esc(objective.baseHash)}">${esc(truncateMiddle(objective.baseHash, 12, 12))}</div>
        </div>
        <div>
          <div class="detail-label">Latest Review</div>
          <div class="detail-text">${esc(objective.latestReviewOutcome ?? "pending")}${objective.latestReviewSummary ? `<br/>${esc(objective.latestReviewSummary)}` : ""}</div>
        </div>
      </div>
      <div class="detail-actions">
        ${canApprove ? `
          <form hx-post="/hub/ui/objectives/${encodeURIComponent(objective.objectiveId)}/approve" hx-swap="none">
            <button type="submit">Approve Completion</button>
          </form>
        ` : ""}
        ${canCancel ? `
          <form hx-post="/hub/ui/objectives/${encodeURIComponent(objective.objectiveId)}/cancel" hx-swap="none">
            <button type="submit" class="ghost">Cancel</button>
          </form>
        ` : ""}
      </div>
      ${renderActiveCodex(objective.activePass)}
      <div class="pass-list">
        ${objective.passes.length === 0 ? `<div class="empty">No passes yet.</div>` : objective.passes.map(renderPass).join("")}
      </div>
    </section>
  `;
};

const renderCommitList = (
  title: string,
  commits: ReadonlyArray<HubCommitView>,
  selectedHash?: string,
): string => `
  <section class="panel debug-panel">
    <div class="panel-head">
      <h2>${esc(title)}</h2>
      <span>${commits.length}</span>
    </div>
    <div class="commit-list">
      ${commits.length === 0 ? `<div class="empty">No commits.</div>` : commits.map((commit) => `
        <a
          class="commit-card${commit.hash === selectedHash ? " active" : ""}"
          href="/hub?commit=${encodeURIComponent(commit.hash)}"
          hx-get="/hub/island/dashboard?commit=${encodeURIComponent(commit.hash)}"
          hx-target="#hub-dashboard"
          hx-push-url="/hub?commit=${encodeURIComponent(commit.hash)}">
          <div class="card-top">
            <span class="hash">${esc(shortHash(commit.hash))}</span>
            <span class="time">${esc(formatTime(commit.ts))}</span>
          </div>
          <div class="card-title">${esc(truncate(commit.subject, 96))}</div>
          <div class="card-meta">${esc(commit.author)} · ${commit.parents.length ? `${commit.parents.length} parent${commit.parents.length === 1 ? "" : "s"}` : "root"}</div>
        </a>
      `).join("")}
    </div>
  </section>
`;

const renderDebugSection = (model: HubDashboardModel): string => `
  <section class="debug-shell">
    <details class="debug-toggle">
      <summary>Debug Surfaces</summary>
      <div class="debug-grid">
        <section class="panel debug-panel">
          <div class="panel-head">
            <h2>Workspaces</h2>
            <span>${model.workspaces.length}</span>
          </div>
          <div class="mini-list">
            ${model.workspaces.map((workspace) => `
              <div class="mini-card">
                <div class="card-top">
                  <span>${esc(workspace.workspaceId)}</span>
                  <span>${workspace.dirty ? "dirty" : "clean"}</span>
                </div>
                <div class="card-meta">${esc(workspace.agentId)} · ${esc(shortHash(workspace.head ?? workspace.baseHash))}</div>
                <div class="card-summary">${esc(workspace.path)}</div>
              </div>
            `).join("") || `<div class="empty">No active workspaces.</div>`}
          </div>
        </section>
        <section class="panel debug-panel">
          <div class="panel-head">
            <h2>Board</h2>
            <span>${model.posts.length}</span>
          </div>
          <div class="mini-list">
            ${model.posts.map((post) => `
              <div class="mini-card">
                <div class="card-top">
                  <span>#${esc(post.channel)}</span>
                  <span>${esc(post.agentId)}</span>
                </div>
                <div class="card-summary">${esc(truncate(post.content, 160))}</div>
              </div>
            `).join("") || `<div class="empty">No posts.</div>`}
          </div>
        </section>
        <section class="panel debug-panel">
          <div class="panel-head">
            <h2>Manual Tasks</h2>
            <span>${model.tasks.length}</span>
          </div>
          <div class="mini-list">
            ${model.tasks.map((task) => `
              <div class="mini-card">
                <div class="card-top">
                  <span>${esc(task.agentId)}</span>
                  <span class="badge ${statusClass(task.status)}">${esc(task.status)}</span>
                </div>
                <div class="card-summary">${esc(truncate(task.prompt, 160))}</div>
              </div>
            `).join("") || `<div class="empty">No manual tasks.</div>`}
          </div>
        </section>
        ${renderCommitList("Recent Commits", model.recentCommits, model.selectedCommit?.hash)}
      </div>
    </details>
  </section>
`;

export const hubShell = (query = ""): string => `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Hub</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <style>
    :root {
      --bg: #0b0d11;
      --panel: rgba(16, 20, 28, 0.92);
      --line: rgba(255, 255, 255, 0.08);
      --line-strong: rgba(255, 255, 255, 0.14);
      --muted: #9aa5b5;
      --ink: #eef3f8;
      --accent: #79e4bf;
      --accent-2: #8cc4ff;
      --danger: #ff8f8f;
      --warn: #ffcf7a;
      --ok: #7de29d;
      --shadow: 0 16px 50px rgba(0, 0, 0, 0.3);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: "Space Grotesk", system-ui, sans-serif;
      background:
        radial-gradient(860px 420px at 0% 0%, rgba(121,228,191,0.14), transparent),
        radial-gradient(720px 440px at 100% 0%, rgba(140,196,255,0.12), transparent),
        var(--bg);
    }
    .shell {
      max-width: 1640px;
      margin: 0 auto;
      padding: 18px;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 16px;
      margin-bottom: 18px;
    }
    .title {
      margin: 0;
      font-size: 28px;
      font-weight: 700;
    }
    .sub {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .back {
      color: var(--accent-2);
      text-decoration: none;
      font-size: 13px;
    }
    .panel, .lane {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: var(--shadow);
    }
    .panel {
      padding: 16px;
    }
    .panel-head, .lane-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
      margin-bottom: 12px;
    }
    .panel-head h2, .lane-head h3 {
      margin: 0;
      font-size: 16px;
    }
    .lane-head h3 {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .lane-sub, .muted {
      color: var(--muted);
    }
    .summary-bar {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .summary-tile {
      padding: 14px;
      border-radius: 16px;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--line);
    }
    .summary-tile.source-dirty {
      border-color: rgba(255, 207, 122, 0.3);
      background: rgba(255, 207, 122, 0.08);
    }
    .summary-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .summary-value {
      font-size: 18px;
      font-weight: 700;
    }
    .objective-form {
      display: grid;
      grid-template-columns: 1.2fr 0.9fr 0.7fr;
      gap: 10px;
    }
    .objective-form textarea,
    .objective-form input,
    .objective-form select,
    .reply-form input,
    .mini-form input,
    .mini-form textarea,
    .mini-form select {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--line-strong);
      background: rgba(255,255,255,0.03);
      color: var(--ink);
      padding: 11px 12px;
      font: inherit;
    }
    .objective-form textarea {
      min-height: 92px;
      grid-column: span 3;
    }
    .objective-form button,
    button {
      border: 0;
      border-radius: 999px;
      padding: 11px 16px;
      background: linear-gradient(135deg, var(--accent), #9de8ff);
      color: #041015;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .form-note {
      grid-column: 1 / -1;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
    .form-note.warn {
      color: var(--warn);
    }
    button.ghost {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--line-strong);
    }
    .warning-panel {
      margin-bottom: 16px;
      border-color: rgba(255, 207, 122, 0.3);
      background: rgba(255, 207, 122, 0.08);
    }
    .warning-copy {
      color: var(--ink);
      font-size: 13px;
      line-height: 1.55;
    }
    .warning-files {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .warning-file {
      display: inline-flex;
      max-width: 100%;
      padding: 5px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--muted);
      font-family: "IBM Plex Mono", monospace;
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .board-shell {
      display: grid;
      grid-template-columns: minmax(0, 2.2fr) minmax(360px, 0.9fr);
      gap: 16px;
      margin-top: 16px;
      align-items: start;
    }
    .lane-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(260px, 1fr));
      gap: 12px;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .lane {
      padding: 14px;
      min-height: 420px;
    }
    .lane-count {
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 12px;
      color: var(--muted);
    }
    .lane-body {
      display: grid;
      gap: 10px;
    }
    .objective-card, .commit-card, .mini-card, .pass-row {
      display: block;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255,255,255,0.03);
      padding: 12px;
      text-decoration: none;
      color: inherit;
    }
    .objective-card.active, .commit-card.active {
      border-color: rgba(121,228,191,0.45);
      background: rgba(121,228,191,0.08);
    }
    .card-top, .card-foot, .card-meta, .pass-top, .pass-meta, .detail-actions, .detail-badges {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .card-title {
      margin: 10px 0 8px;
      font-size: 15px;
      font-weight: 600;
    }
    .card-summary, .pass-summary, .pass-handoff, .detail-text {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .card-summary {
      min-height: 42px;
      margin-bottom: 10px;
    }
    .card-summary.live {
      color: var(--ink);
      min-height: 36px;
    }
    .hash, .time, .mini-status {
      font-family: "IBM Plex Mono", monospace;
      font-size: 11px;
      color: var(--muted);
    }
    .badge, .tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      border: 1px solid var(--line-strong);
    }
    .badge.awaiting_confirmation { color: var(--warn); border-color: rgba(255,207,122,0.35); }
    .badge.blocked, .badge.failed, .badge.canceled { color: var(--danger); border-color: rgba(255,143,143,0.4); }
    .badge.completed, .badge.approved, .badge.ok { color: var(--ok); border-color: rgba(125,226,157,0.35); }
    .badge.reviewing, .badge.building, .badge.planning, .badge.running, .badge.queued { color: var(--accent-2); border-color: rgba(140,196,255,0.35); }
    .detail-panel {
      position: sticky;
      top: 18px;
      padding: 14px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin: 14px 0;
    }
    .detail-grid > div {
      min-width: 0;
    }
    .detail-grid.compact {
      gap: 10px 14px;
    }
    .detail-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .detail-title-wrap {
      min-width: 0;
    }
    .detail-title-wrap h2 {
      margin: 0;
      font-size: 18px;
      line-height: 1.15;
    }
    .detail-id {
      margin-top: 6px;
      color: var(--muted);
      font-family: "IBM Plex Mono", monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .detail-kv {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 10px;
    }
    .mono {
      font-family: "IBM Plex Mono", monospace;
    }
    .pass-list, .commit-list, .mini-list {
      display: grid;
      gap: 10px;
    }
    .pass-row {
      padding: 10px 12px;
    }
    .pass-title {
      font-weight: 700;
      text-transform: capitalize;
    }
    .pass-meta {
      color: var(--muted);
      font-size: 12px;
    }
    .pass-live {
      margin-top: 8px;
      padding: 9px 10px;
      border-radius: 12px;
      background: rgba(140,196,255,0.08);
      color: var(--ink);
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .active-pass {
      margin-bottom: 12px;
      padding: 12px;
      border: 1px solid rgba(140,196,255,0.22);
      border-radius: 16px;
      background: rgba(140,196,255,0.06);
    }
    .active-pass .panel-head {
      margin-bottom: 8px;
    }
    .live-log {
      margin: 0;
      max-height: 180px;
      overflow: auto;
      border-radius: 12px;
      background: rgba(7, 11, 18, 0.88);
      border: 1px solid var(--line);
      padding: 10px 12px;
      color: var(--ink);
      font-family: "IBM Plex Mono", monospace;
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .live-log.error {
      margin-top: 8px;
      color: var(--danger);
    }
    .check-list {
      display: grid;
      gap: 6px;
      margin-top: 10px;
    }
    .check {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      font-size: 12px;
      border: 1px solid var(--line);
    }
    .check.ok { color: var(--ok); }
    .check.bad { color: var(--danger); }
    .debug-shell {
      margin-top: 16px;
    }
    .debug-toggle summary {
      cursor: pointer;
      color: var(--muted);
      margin-bottom: 12px;
    }
    .debug-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .empty {
      color: var(--muted);
      font-size: 13px;
      padding: 8px 0;
    }
    @media (max-width: 1180px) {
      .summary-bar, .detail-grid, .debug-grid, .objective-form, .board-shell {
        grid-template-columns: 1fr;
      }
      .detail-panel {
        position: static;
      }
      .lane-grid {
        grid-template-columns: repeat(6, minmax(240px, 78vw));
      }
    }
  </style>
  <script>
    (() => {
      let source;
      const refresh = () => document.body.dispatchEvent(new CustomEvent("hub-refresh"));
      const connect = () => {
        source = new EventSource("/hub/events");
        source.onmessage = refresh;
        source.addEventListener("receipt-refresh", refresh);
        source.addEventListener("job-refresh", refresh);
        source.onerror = () => {
          source?.close();
          setTimeout(connect, 1000);
        };
      };
      window.addEventListener("DOMContentLoaded", connect);
      window.addEventListener("beforeunload", () => source?.close());
    })();
  </script>
</head>
<body>
  <div class="shell">
    <div class="head">
      <div>
        <h1 class="title">Receipt Hub</h1>
        <div class="sub">Codex-powered objectives on top of Git worktrees for this repo.</div>
      </div>
      <a class="back" href="/monitor">Open command center</a>
    </div>
    <div id="hub-dashboard"
      hx-get="/hub/island/dashboard${query}"
      hx-trigger="load, hub-refresh from:body, every 4s"
      hx-swap="innerHTML"></div>
  </div>
</body>
</html>`;

export const hubDashboard = (model: HubDashboardModel): string => `
  ${renderSourceWarning(model)}
  <div class="summary-bar">
    <div class="summary-tile${model.sourceDirty ? " source-dirty" : ""}">
      <div class="summary-label">Repo</div>
      <div class="summary-value">${esc(model.sourceBranch ?? model.defaultBranch)}</div>
      <div class="muted">${esc(model.repoRoot)}</div>
      <div class="muted">${model.sourceDirty ? `${model.sourceChangedFiles.length} uncommitted change${model.sourceChangedFiles.length === 1 ? "" : "s"}` : `head ${esc(shortHash(model.sourceHead))}`}</div>
    </div>
    <div class="summary-tile">
      <div class="summary-label">Commits</div>
      <div class="summary-value">${model.commitCount}</div>
      <div class="muted">${model.leafCount} leaves</div>
    </div>
    <div class="summary-tile">
      <div class="summary-label">Objectives</div>
      <div class="summary-value">${model.objectives.length}</div>
      <div class="muted">${model.lanes.awaiting_confirmation.length} awaiting confirmation</div>
    </div>
    <div class="summary-tile">
      <div class="summary-label">Agents</div>
      <div class="summary-value">${model.agents.length}</div>
      <div class="muted">${model.agents.map((agent) => esc(agent.agentId)).join(" · ")}</div>
    </div>
  </div>
  ${renderObjectiveForm(model)}
  <div class="board-shell">
    <section class="panel">
      <div class="panel-head">
        <h2>Agent Columns</h2>
        <span>Objectives move automatically by phase</span>
      </div>
      <div class="lane-grid">
        ${renderLane("Planner", "planner-1", model.lanes.planner, model.selectedObjective?.objectiveId)}
        ${renderLane("Builder", "builder-1", model.lanes.builder, model.selectedObjective?.objectiveId)}
        ${renderLane("Reviewer", "reviewer-1", model.lanes.reviewer, model.selectedObjective?.objectiveId)}
        ${renderLane("Awaiting Confirmation", "human approval required", model.lanes.awaiting_confirmation, model.selectedObjective?.objectiveId)}
        ${renderLane("Blocked", "needs intervention", model.lanes.blocked, model.selectedObjective?.objectiveId)}
        ${renderLane("Completed", "closed objectives", model.lanes.completed, model.selectedObjective?.objectiveId)}
      </div>
    </section>
    ${renderObjectiveDetail(model)}
  </div>
  ${renderDebugSection(model)}
`;
