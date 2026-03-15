import { esc, truncate } from "./agent-framework.js";
import type {
  HubCommitProjection,
  HubDebugProjection,
  HubRepoProjection,
} from "../services/hub-service.js";

const shortHash = (value: string | undefined): string => value ? value.slice(0, 8) : "none";
const formatTime = (ts: number | undefined): string => ts ? new Date(ts).toLocaleString() : "n/a";
const formatJson = (value: unknown): string => esc(JSON.stringify(value, null, 2));

export const hubSummaryIsland = (model: HubRepoProjection): string => `
  <section id="hub-summary" class="hub-panel">
    <div class="hub-head">
      <div>
        <h2>Hub</h2>
        <p>Repo, team, workspace, and commit operations. Objective execution moved to <a href="/factory">/factory</a>.</p>
      </div>
      <a href="/factory">Open Factory</a>
    </div>
    <div class="hub-grid three">
      <div class="hub-stat"><span>Repo</span><strong>${esc(model.sourceBranch ?? model.defaultBranch)}</strong><div>${esc(model.repoRoot)}</div></div>
      <div class="hub-stat"><span>Source</span><strong>${esc(shortHash(model.sourceHead))}</strong><div>${model.sourceDirty ? `${model.sourceChangedFiles.length} uncommitted changes` : "clean"}</div></div>
      <div class="hub-stat"><span>Mirror</span><strong>${esc(model.mirrorStatus)}</strong><div>${model.mirrorHead ? esc(shortHash(model.mirrorHead)) : "not primed"}</div></div>
      <div class="hub-stat"><span>Agents</span><strong>${model.agentIds.length}</strong><div>${esc(model.agentIds.join(" · ") || "none")}</div></div>
      <div class="hub-stat"><span>Mirror sync</span><strong>${esc(formatTime(model.mirrorLastSyncAt))}</strong><div>${esc(model.mirrorLastSyncError ?? "ok")}</div></div>
      <div class="hub-stat"><span>Factory</span><strong><a href="/factory">Go to /factory</a></strong><div>Objectives are no longer served from Hub.</div></div>
    </div>
  </section>
`;

export const hubCommitsIsland = (model: HubCommitProjection): string => `
  <section id="hub-commits" class="hub-panel">
    <div class="hub-head">
      <div>
        <h2>Commit Explorer</h2>
        <p>${model.commitCount} commits · ${model.leafCount} leaves</p>
      </div>
      <span>${esc(model.defaultBranch)}</span>
    </div>
    <div class="hub-columns">
      <div class="hub-list">
        ${model.recentCommits.map((commit) => `
          <a class="hub-card" href="/hub?commit=${encodeURIComponent(commit.hash)}">
            <div class="hub-card-top"><strong>${esc(shortHash(commit.hash))}</strong><span>${esc(formatTime(commit.ts))}</span></div>
            <div>${esc(truncate(commit.subject, 120))}</div>
            <div class="hub-muted">${esc(commit.author)}</div>
          </a>
        `).join("")}
      </div>
      <div class="hub-detail">
        ${model.selectedCommit ? `
          <div class="hub-card">
            <div class="hub-card-top"><strong>${esc(model.selectedCommit.hash)}</strong><span>${esc(model.selectedCommit.author)}</span></div>
            <div>${esc(model.selectedCommit.subject)}</div>
            <div class="hub-muted">Touched files: ${esc(model.selectedCommit.touchedFiles.join(", ") || "none")}</div>
          </div>
        ` : `<div class="hub-empty">No selected commit.</div>`}
        <details class="hub-detail-box" open>
          <summary>Lineage</summary>
          <pre>${formatJson(model.selectedLineage)}</pre>
        </details>
        <details class="hub-detail-box">
          <summary>Diff</summary>
          <pre>${esc(model.selectedDiff ?? "")}</pre>
        </details>
      </div>
    </div>
  </section>
`;

export const hubDebugIsland = (model: HubDebugProjection): string => `
  <section id="hub-debug" class="hub-panel">
    <div class="hub-head">
      <div>
        <h2>Operators</h2>
        <p>Manual agent, channel, workspace, post, and task controls.</p>
      </div>
      <span>${model.workspaces.length} workspaces</span>
    </div>
    <div class="hub-grid two">
      <form class="hub-form" hx-post="/hub/ui/agents" hx-swap="none">
        <h3>Create Agent</h3>
        <input name="agentId" placeholder="builder-2" required />
        <input name="displayName" placeholder="Builder 2" />
        <input name="memoryScope" placeholder="hub/agents/builder-2" />
        <button type="submit">Add agent</button>
      </form>
      <form class="hub-form" hx-post="/hub/ui/channels" hx-swap="none">
        <h3>Create Channel</h3>
        <input name="name" placeholder="ops" required />
        <button type="submit">Add channel</button>
      </form>
      <form class="hub-form" hx-post="/hub/ui/workspaces" hx-swap="none">
        <h3>Create Workspace</h3>
        <input name="agentId" placeholder="builder-1" required />
        <input name="workspaceId" placeholder="optional workspace id" />
        <input name="baseHash" placeholder="optional base commit" />
        <button type="submit">Create workspace</button>
      </form>
      <form class="hub-form" hx-post="/hub/ui/tasks" hx-swap="none">
        <h3>Manual Task</h3>
        <input name="agentId" placeholder="builder-1" required />
        <input name="workspaceId" placeholder="workspace id" required />
        <textarea name="prompt" placeholder="Ask the agent to inspect or modify the workspace." required></textarea>
        <button type="submit">Run task</button>
      </form>
      <form class="hub-form" hx-post="/hub/ui/posts" hx-swap="none">
        <h3>Post Message</h3>
        <input name="agentId" placeholder="planner-1" required />
        <input name="channel" placeholder="results" required />
        <textarea name="content" placeholder="Share an update or handoff." required></textarea>
        <button type="submit">Post</button>
      </form>
      <div class="hub-detail-box">
        <h3>Workspaces</h3>
        <pre>${formatJson(model.workspaces)}</pre>
      </div>
      <div class="hub-detail-box">
        <h3>Tasks</h3>
        <pre>${formatJson(model.tasks)}</pre>
      </div>
      <div class="hub-detail-box">
        <h3>Posts</h3>
        <pre>${formatJson(model.posts)}</pre>
      </div>
    </div>
  </section>
`;

export const hubShell = (opts: {
  readonly summaryIsland: string;
  readonly commitsIsland: string;
  readonly debugIsland: string;
}): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hub</title>
    <script src="https://unpkg.com/htmx.org@1.9.12"></script>
    <style>
      :root { color-scheme: dark; --bg: #11141c; --panel: #171c27; --line: #313a4b; --text: #eef2f8; --muted: #97a4b8; --accent: #88d8ff; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "IBM Plex Sans", system-ui, sans-serif; background: radial-gradient(circle at top, #1b2230 0%, var(--bg) 42%); color: var(--text); }
      a { color: var(--accent); text-decoration: none; }
      code, pre { font-family: "IBM Plex Mono", monospace; }
      .hub-shell { max-width: 1450px; margin: 0 auto; padding: 24px; display: grid; gap: 16px; }
      .hub-shell h1, .hub-shell h2, .hub-shell h3 { margin: 0; }
      .hub-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
      .hub-panel { border: 1px solid var(--line); border-radius: 18px; padding: 16px; background: rgba(23,28,39,0.9); display: grid; gap: 12px; }
      .hub-grid { display: grid; gap: 12px; }
      .hub-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .hub-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .hub-columns { display: grid; gap: 12px; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); }
      .hub-list { display: grid; gap: 10px; }
      .hub-card, .hub-stat, .hub-detail-box, .hub-form { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: rgba(17,21,29,0.8); display: grid; gap: 8px; }
      .hub-card-top { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
      .hub-stat span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
      .hub-stat strong { font-size: 16px; }
      .hub-muted { color: var(--muted); font-size: 13px; }
      .hub-form input, .hub-form textarea, .hub-form button { width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: rgba(10,13,19,0.85); color: var(--text); }
      .hub-form button { background: #202838; cursor: pointer; }
      .hub-empty { padding: 18px; color: var(--muted); border: 1px dashed var(--line); border-radius: 12px; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
      @media (max-width: 1100px) { .hub-grid.two, .hub-grid.three, .hub-columns { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main class="hub-shell">
      <header class="hub-panel">
        <div class="hub-head">
          <div>
            <h1>Hub</h1>
            <p>Repo/team operations only. Objective execution, board state, and promotion controls live in <a href="/factory">/factory</a>.</p>
          </div>
          <a href="/factory">Open Factory</a>
        </div>
      </header>
      ${opts.summaryIsland}
      ${opts.commitsIsland}
      ${opts.debugIsland}
    </main>
  </body>
</html>`;
