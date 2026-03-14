import { esc, truncate } from "./agent-framework.js";
import type {
  HubBoardProjection,
  HubCommitView,
  HubCommitProjection,
  HubComposeModel,
  HubDashboardModel,
  HubDebugProjection,
  HubLiveProjection,
  HubObjectiveCard,
  HubObjectiveProjection,
  HubRepoProjection,
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
const pluralize = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
const describeChecks = (checks: ReadonlyArray<string>): string =>
  checks.length ? `${pluralize(checks.length, "verification gate")} armed` : "No explicit verification gates";
const describeMirrorStatus = (status: HubRepoProjection["mirrorStatus"]): string => {
  if (status === "fresh") return "mirror synced";
  if (status === "syncing") return "mirror syncing";
  if (status === "error") return "mirror error";
  return "mirror catching up";
};
const hubQuery = (objectiveId: string | undefined, commitHash: string): string => {
  const params = new URLSearchParams();
  if (objectiveId) params.set("objective", objectiveId);
  params.set("commit", commitHash);
  return params.toString();
};
const summarizeCheckResults = (
  checkResults: ReadonlyArray<{ readonly ok: boolean }> | undefined,
): { readonly label: string; readonly tone: "ok" | "bad" | "muted" } => {
  if (!checkResults?.length) return { label: "Verification pending", tone: "muted" };
  const passed = checkResults.filter((check) => check.ok).length;
  const failed = checkResults.length - passed;
  if (failed > 0) return { label: `${pluralize(failed, "gate")} failed`, tone: "bad" };
  return { label: `${pluralize(passed, "gate")} passed`, tone: "ok" };
};
const summarizeWorkspaceState = (pass: ObjectivePassView): string => {
  if (!pass.workspaceExists) return "workspace cleared";
  if (pass.workspaceDirty) return "workspace dirty";
  return "workspace clean";
};
const isLiveJobStatus = (status: string | undefined): boolean =>
  status === "queued" || status === "leased" || status === "running";
const presentJobState = (status: string | undefined): string => {
  if (status === "queued") return "queued";
  if (status === "leased") return "starting";
  if (status === "running") return "running now";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  return status ?? "idle";
};
const presentObjectiveStatus = (status: string): string =>
  status === "awaiting_confirmation"
    ? "ready to merge"
    : status.replaceAll("_", " ");
const liveNarrative = (phase: string | undefined, status: string | undefined, elapsedMs: number | undefined): string => {
  const phaseLabel = phase ? `${phase} pass` : "pass";
  const duration = elapsedMs ? ` for ${formatDuration(elapsedMs)}` : "";
  if (status === "queued") return `${phaseLabel} queued. Waiting for Codex worker${duration}.`;
  if (status === "leased") return `${phaseLabel} starting. Worker claimed the job${duration}.`;
  if (status === "running") return `${phaseLabel} is actively running in Codex${duration}.`;
  return `${phaseLabel} idle.`;
};

const renderCard = (card: HubObjectiveCard, activeId?: string): string => `
  <form
    class="card-action"
    hx-get="/hub/island/board?objective=${encodeURIComponent(card.objectiveId)}"
    hx-target="#hub-board"
    hx-swap="outerHTML"
    hx-push-url="/hub?objective=${encodeURIComponent(card.objectiveId)}">
    <button
      type="submit"
      class="objective-card${card.objectiveId === activeId ? " active" : ""}${isLiveJobStatus(card.activeJobStatus) ? " live-card" : ""}"
      aria-pressed="${card.objectiveId === activeId ? "true" : "false"}">
      <span class="card-top">
        <span class="badge ${statusClass(card.status)}">${esc(presentObjectiveStatus(card.status))}</span>
        ${card.activeJobStatus ? `
          <span class="mini-status${isLiveJobStatus(card.activeJobStatus) ? " live" : ""}">
            ${isLiveJobStatus(card.activeJobStatus) ? `<span class="live-dot"></span>` : ""}
            ${esc(presentJobState(card.activeJobStatus))}
            ${card.activeElapsedMs ? ` · ${esc(formatDuration(card.activeElapsedMs))}` : ""}
          </span>` : ""}
      </span>
      <span class="card-title">${esc(truncate(card.title, 72))}</span>
      <span class="card-meta">
        ${card.assignedAgentId ? `<span>${esc(card.assignedAgentId)}</span>` : `<span>unassigned</span>`}
        ${card.currentPhase ? `<span>${esc(card.currentPhase)}</span>` : ""}
      </span>
      ${card.status === "awaiting_confirmation"
        ? `${card.latestSummary
            ? `<span class="card-summary">${esc(truncate(card.latestSummary, 112))}</span>`
            : `<span class="card-summary muted">Approved candidate ready to merge.</span>`}
           <span class="card-runtime">Review is complete. Human merge is the final step.</span>`
        : isLiveJobStatus(card.activeJobStatus)
        ? `<span class="card-summary live">${esc(liveNarrative(card.currentPhase, card.activeJobStatus, card.activeElapsedMs))}</span>
           <span class="card-runtime">${esc(truncate(card.liveActivity || "Codex is working in the background.", 112))}</span>`
        : card.latestSummary
          ? `<span class="card-summary">${esc(truncate(card.latestSummary, 112))}</span>`
          : `<span class="card-summary muted">No summary yet.</span>`}
      <span class="card-foot">
        ${card.latestCommitHash ? `<span class="hash">${esc(shortHash(card.latestCommitHash))}</span>` : `<span class="hash muted">no commit</span>`}
        <span class="time">${esc(formatTime(card.updatedAt))}</span>
      </span>
    </button>
  </form>
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

export const hubCompose = (model: HubComposeModel): string => `
  <section class="panel objective-compose">
    <div class="panel-head">
      <h2>Create Objective</h2>
      <span>${model.objectiveCount} tracked</span>
    </div>
    <form
      class="objective-form"
      hx-post="/hub/ui/objectives"
      hx-swap="none"
      hx-on::after-request="if (event.detail.successful) this.reset()">
      <input name="title" placeholder="Add agent deletion to /hub" required />
      <textarea name="prompt" placeholder="Describe the objective, acceptance criteria, and any repo-specific constraints." required></textarea>
      <div class="compose-actions">
        <button type="submit">Launch Objective</button>
        <span class="compose-hint">${esc(model.sourceBranch ?? model.defaultBranch)}</span>
      </div>
    </form>
    ${model.sourceDirty ? `
      <div class="form-note warn">
        New objectives are blocked while the source repo has uncommitted changes. Commit or stash first, or set an explicit base commit.
      </div>
    ` : `
      <div class="form-note">Objectives launch from committed Git history on <span class="mono">${esc(model.sourceBranch ?? model.defaultBranch)}</span>. Verification and merge flow run automatically.</div>
    `}
  </section>
`;

export const hubComposeIsland = (model: HubComposeModel): string => `
  <div id="hub-compose"
    hx-get="/hub/island/compose"
    hx-trigger="hub-compose-refresh from:body"
    hx-swap="outerHTML">
    ${hubCompose(model)}
  </div>
`;

const renderSourceWarning = (model: Pick<HubRepoProjection, "sourceDirty" | "sourceChangedFiles" | "sourceHead">): string => {
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

const renderRepoSummary = (model: HubRepoProjection): string => `
  ${renderSourceWarning(model)}
  <div class="summary-bar">
    <div class="summary-tile${model.sourceDirty ? " source-dirty" : ""}">
      <div class="summary-label">Repo</div>
      <div class="summary-value">${esc(model.sourceBranch ?? model.defaultBranch)}</div>
      <div class="muted">${esc(model.repoRoot)}</div>
      <div class="muted">${model.sourceDirty ? `${model.sourceChangedFiles.length} uncommitted change${model.sourceChangedFiles.length === 1 ? "" : "s"}` : `head ${esc(shortHash(model.sourceHead))}`}</div>
    </div>
    <div class="summary-tile">
      <div class="summary-label">Mirror</div>
      <div class="summary-value">${esc(describeMirrorStatus(model.mirrorStatus))}</div>
      <div class="muted">${model.mirrorHead ? `mirror ${esc(shortHash(model.mirrorHead))}` : "mirror not primed yet"}</div>
      <div class="muted">${model.mirrorLastSyncAt ? `last sync ${esc(formatTime(model.mirrorLastSyncAt))}` : "sync on demand for commit explorer"}</div>
    </div>
    <div class="summary-tile">
      <div class="summary-label">Objectives</div>
      <div class="summary-value">${model.objectiveCount}</div>
      <div class="muted">${model.awaitingConfirmationCount} awaiting human merge</div>
    </div>
    <div class="summary-tile">
      <div class="summary-label">Agents</div>
      <div class="summary-value">${model.agentIds.length}</div>
      <div class="muted">${model.agentIds.map((agentId) => esc(agentId)).join(" · ")}</div>
    </div>
  </div>
`;

const renderPass = (pass: ObjectivePassView): string => {
  const verification = summarizeCheckResults(pass.checkResults);
  return `
  <article class="pass-row">
    <div class="pass-top">
      <span class="pass-title">${esc(`${pass.phase} #${pass.passNumber}`)}</span>
      <span class="badge ${statusClass(pass.jobStatus)}">${esc(pass.jobStatus)}${pass.elapsedMs ? ` · ${esc(formatDuration(pass.elapsedMs))}` : ""}</span>
    </div>
    <div class="pass-meta">
      <span>${esc(pass.agentId)}</span>
      <span>base ${esc(shortHash(pass.baseCommit))}</span>
      ${pass.commitHash ? `<span>${esc(shortHash(pass.commitHash))}</span>` : ""}
      <span>${esc(formatTime(pass.dispatchedAt))}</span>
    </div>
    ${pass.summary ? `<div class="pass-summary">${esc(pass.summary)}</div>` : ""}
    <div class="pass-signals">
      <span class="tag ${verification.tone}">${esc(verification.label)}</span>
      <span class="tag">${esc(summarizeWorkspaceState(pass))}</span>
      ${pass.outcome ? `<span class="tag">${esc(pass.outcome.replaceAll("_", " "))}</span>` : ""}
    </div>
    ${pass.activity ? `<div class="pass-live">${esc(pass.activity)}</div>` : ""}
    <details class="pass-inspect">
      <summary>Inspect pass</summary>
      ${pass.handoff ? `<div class="pass-handoff">${esc(truncate(pass.handoff, 420))}</div>` : ""}
      <div class="pass-meta">
        <span title="${esc(pass.workspacePath)}">${esc(shortenPath(pass.workspacePath, 3))}</span>
        <span>${pass.workspaceExists ? "exists" : "missing"}</span>
        <span>${pass.workspaceDirty ? "dirty" : "clean"}</span>
      </div>
      ${pass.checkResults?.length
        ? `<div class="check-list">${pass.checkResults.map((check, index) => `
            <div class="check ${check.ok ? "ok" : "bad"}">
              <span>Gate ${index + 1}</span>
              <span>${check.ok ? "passed" : `exit ${check.exitCode ?? 1}`}</span>
            </div>
          `).join("")}</div>`
        : `<div class="empty">No verification trace recorded yet.</div>`}
    </details>
  </article>
`;
};

const renderObjectiveDetail = (model: HubObjectiveProjection): string => {
  const objective = model.objective;
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
  const canMerge = objective.status === "awaiting_confirmation";
  const canResume = objective.status === "blocked" || objective.status === "failed";
  const canCancel = objective.status !== "completed" && objective.status !== "canceled";
  const canCleanup = ["completed", "blocked", "failed", "canceled"].includes(objective.status)
    && objective.passes.some((pass) => pass.workspaceExists);
  const mergeTarget = model.sourceBranch ?? model.defaultBranch;
  const verification = summarizeCheckResults(objective.latestCheckResults);
  const activeIsLive = objective.activePass ? isLiveJobStatus(objective.activePass.jobStatus) : false;
  return `
    <section class="panel detail-panel">
      <div class="panel-head">
        <div class="detail-title-wrap">
          <h2>${esc(objective.title)}</h2>
          <div class="detail-id" title="${esc(objective.objectiveId)}">${esc(truncateMiddle(objective.objectiveId, 12, 10))}</div>
        </div>
      </div>
      <div class="detail-badges">
        <span class="badge ${statusClass(objective.status)}">${esc(presentObjectiveStatus(objective.status))}</span>
        ${objective.assignedAgentId ? `<span class="tag">${esc(objective.assignedAgentId)}</span>` : ""}
        ${objective.latestCommitHash ? `<span class="tag">commit ${esc(shortHash(objective.latestCommitHash))}</span>` : ""}
      </div>
      ${activeIsLive && objective.activePass ? `
        <div class="live-banner">
          <span class="mini-status live"><span class="live-dot"></span>${esc(presentJobState(objective.activePass.jobStatus))}</span>
          <span>${esc(liveNarrative(objective.activePass.phase, objective.activePass.jobStatus, objective.activePass.elapsedMs))}</span>
        </div>
      ` : ""}
      <div class="detail-grid compact">
        <div>
          <div class="detail-label">Intent</div>
          <div class="detail-text">${esc(objective.prompt)}</div>
        </div>
        <div>
          <div class="detail-label">Verification</div>
          <div class="detail-text">${esc(describeChecks(objective.checks))}<br/>${esc(verification.label)}</div>
        </div>
        <div>
          <div class="detail-label">Base Commit</div>
          <div class="detail-text mono" title="${esc(objective.baseHash)}">${esc(truncateMiddle(objective.baseHash, 12, 12))}</div>
        </div>
        <div>
          <div class="detail-label">Next Handoff</div>
          <div class="detail-text">${esc(objective.nextHandoff ?? "No active handoff.")}</div>
        </div>
      </div>
      <div class="detail-stage-grid">
        <div class="detail-stage">
          <div class="detail-label">Planned</div>
          <div class="detail-text">${esc(objective.latestPlanSummary ?? "Planner has not produced a durable plan yet.")}</div>
          <div class="detail-note">${esc(objective.latestPlanHandoff ?? "No builder handoff recorded yet.")}</div>
        </div>
        <div class="detail-stage">
          <div class="detail-label">Built</div>
          <div class="detail-text">${esc(objective.latestBuildSummary ?? "No candidate has been built yet.")}</div>
          <div class="detail-note">
            ${esc(objective.latestBuildHandoff ?? "No reviewer handoff recorded yet.")}
            ${objective.latestCommitHash ? `<br/><span class="mono">candidate ${esc(shortHash(objective.latestCommitHash))}</span>` : ""}
          </div>
        </div>
        <div class="detail-stage">
          <div class="detail-label">Review</div>
          <div class="detail-text">${esc(objective.latestReviewOutcome ?? "pending")}${objective.latestReviewSummary ? `<br/>${esc(objective.latestReviewSummary)}` : ""}</div>
          <div class="detail-note">${esc(objective.latestReviewHandoff ?? "No reviewer handoff recorded yet.")}</div>
        </div>
      </div>
      ${canMerge ? `
        <div class="live-banner ready-banner">
          <span class="mini-status live"><span class="live-dot"></span>review complete</span>
          <span>This objective is finished from the agents' side. Merge the approved candidate into ${esc(mergeTarget)} to close the loop.</span>
        </div>
      ` : ""}
      <div class="detail-actions">
        ${canResume ? `
          <form hx-post="/hub/ui/objectives/${encodeURIComponent(objective.objectiveId)}/resume" hx-swap="none">
            <button type="submit">Resume</button>
          </form>
        ` : ""}
        ${canMerge ? `
          <form hx-post="/hub/ui/objectives/${encodeURIComponent(objective.objectiveId)}/merge" hx-swap="none">
            <button type="submit"${model.sourceDirty ? " disabled" : ""}>Merge to ${esc(mergeTarget)}</button>
          </form>
        ` : ""}
        ${canCleanup ? `
          <form hx-post="/hub/ui/objectives/${encodeURIComponent(objective.objectiveId)}/cleanup" hx-swap="none">
            <button type="submit" class="ghost">Clear Worktrees</button>
          </form>
        ` : ""}
        ${canCancel ? `
          <form hx-post="/hub/ui/objectives/${encodeURIComponent(objective.objectiveId)}/cancel" hx-swap="none">
            <button type="submit" class="ghost">Cancel</button>
          </form>
        ` : ""}
      </div>
      ${canMerge && model.sourceDirty ? `<div class="form-note warn">Merge is blocked while the source repo has uncommitted changes.</div>` : ""}
      <div class="pass-list">
        ${objective.passes.length === 0 ? `<div class="empty">No passes yet.</div>` : objective.passes.map(renderPass).join("")}
      </div>
    </section>
  `;
};

const renderLiveConsole = (model: HubLiveProjection): string => {
  if (!model.selectedObjectiveId) {
    return `
      <section class="panel detail-panel live-panel">
        <div class="panel-head">
          <h2>Codex Live</h2>
          <span>select an objective</span>
        </div>
        <div class="empty">Live Codex output appears here for the selected objective only.</div>
      </section>
    `;
  }
  if (!model.activePass) {
    return `
      <section class="panel detail-panel live-panel">
        <div class="panel-head">
          <h2>Codex Live</h2>
          <span>${esc(model.objectiveStatus ?? "idle")}</span>
        </div>
        <div class="detail-text">${esc(model.objectiveTitle ?? "Objective")} has no active Codex pass right now.</div>
      </section>
    `;
  }
  const pass = model.activePass;
  return `
    <section class="panel detail-panel live-panel">
      <div class="panel-head">
        <h2>Codex Live</h2>
        <span class="mini-status${isLiveJobStatus(pass.jobStatus) ? " live" : ""}">
          ${isLiveJobStatus(pass.jobStatus) ? `<span class="live-dot"></span>` : ""}
          ${esc(presentJobState(pass.jobStatus))}
          ${pass.elapsedMs ? ` · ${esc(formatDuration(pass.elapsedMs))}` : ""}
        </span>
      </div>
      <div class="active-pass-copy">${esc(liveNarrative(pass.phase, pass.jobStatus, pass.elapsedMs))}</div>
      <div class="detail-kv">
        <span>${esc(pass.agentId)}</span>
        <span title="${esc(pass.workspacePath)}">${esc(shortenPath(pass.workspacePath, 3))}</span>
      </div>
      <pre class="live-log">${esc(pass.stdoutTail || pass.lastMessage || "Codex accepted the prompt. No terminal output yet.")}</pre>
      ${pass.stderrTail ? `<pre class="live-log error">${esc(pass.stderrTail)}</pre>` : ""}
    </section>
  `;
};

const renderCommitList = (
  title: string,
  commits: ReadonlyArray<HubCommitView>,
  selectedHash?: string,
  selectedObjectiveId?: string,
): string => `
  <section class="panel debug-panel">
    <div class="panel-head">
      <h2>${esc(title)}</h2>
      <span>${commits.length}</span>
    </div>
    <div class="commit-list">
      ${commits.length === 0 ? `<div class="empty">No commits.</div>` : commits.map((commit) => `
        <form
          class="card-action"
          hx-get="/hub/island/commits?${hubQuery(selectedObjectiveId, commit.hash)}"
          hx-target="#hub-commits"
          hx-swap="outerHTML"
          hx-push-url="/hub?${hubQuery(selectedObjectiveId, commit.hash)}">
          <button
            type="submit"
            class="commit-card${commit.hash === selectedHash ? " active" : ""}"
            aria-pressed="${commit.hash === selectedHash ? "true" : "false"}">
            <span class="card-top">
              <span class="hash">${esc(shortHash(commit.hash))}</span>
              <span class="time">${esc(formatTime(commit.ts))}</span>
            </span>
            <span class="card-title">${esc(truncate(commit.subject, 96))}</span>
            <span class="card-meta">${esc(commit.author)} · ${commit.parents.length ? `${commit.parents.length} parent${commit.parents.length === 1 ? "" : "s"}` : "root"}</span>
          </button>
        </form>
      `).join("")}
    </div>
  </section>
`;

const renderDebugSection = (model: HubDebugProjection): string => `
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
  </div>
`;

const renderCommitExplorer = (model: HubCommitProjection, selectedObjectiveId?: string): string => `
  <div class="debug-grid commit-grid">
    ${renderCommitList("Recent Commits", model.recentCommits, model.selectedCommit?.hash, selectedObjectiveId)}
    <section class="panel debug-panel">
      <div class="panel-head">
        <h2>Selected Commit</h2>
        <span>${model.selectedCommit ? shortHash(model.selectedCommit.hash) : "none"}</span>
      </div>
      ${model.selectedCommit ? `
        <div class="mini-list">
          <div class="mini-card">
            <div class="card-top">
              <span>${esc(model.selectedCommit.author)}</span>
              <span>${esc(formatTime(model.selectedCommit.ts))}</span>
            </div>
            <div class="card-title">${esc(model.selectedCommit.subject)}</div>
            <div class="card-summary">${esc(model.selectedCommit.touchedFiles.join(", ") || "No touched files recorded.")}</div>
          </div>
        </div>
      ` : `<div class="empty">No commit selected.</div>`}
    </section>
  </div>
`;

export const hubSummaryIsland = (model: HubRepoProjection): string => `
  <div id="hub-summary"
    hx-get="/hub/island/summary"
    hx-trigger="sse:receipt-refresh throttle:900ms, hub-summary-refresh from:body"
    hx-swap="outerHTML">
    ${renderRepoSummary(model)}
  </div>
`;

export const hubBoard = (model: HubBoardProjection): string => `
  <section class="panel">
    <div class="panel-head">
      <h2>Objective Grid</h2>
      <span>Work flows across agents automatically</span>
    </div>
    <div class="lane-grid">
      ${renderLane("Planner", "planner-1", model.lanes.planner, model.selectedObjectiveId)}
      ${renderLane("Builder", "builder-1", model.lanes.builder, model.selectedObjectiveId)}
      ${renderLane("Reviewer", "reviewer-1", model.lanes.reviewer, model.selectedObjectiveId)}
      ${renderLane("Ready To Merge", "review complete · human merge required", model.lanes.awaiting_confirmation, model.selectedObjectiveId)}
      ${renderLane("Blocked", "needs intervention", model.lanes.blocked, model.selectedObjectiveId)}
      ${renderLane("Completed", "closed objectives", model.lanes.completed, model.selectedObjectiveId)}
    </div>
  </section>
`;

export const hubBoardIsland = (model: HubBoardProjection, query = "", oob = false): string => `
  <div id="hub-board"
    ${oob ? `hx-swap-oob="outerHTML"` : ""}
    hx-get="/hub/island/board${query}"
    hx-trigger="sse:receipt-refresh throttle:700ms, sse:job-refresh throttle:350ms, hub-board-refresh from:body"
    hx-swap="outerHTML">
    ${hubBoard(model)}
  </div>
`;

export const hubObjectiveIsland = (model: HubObjectiveProjection, query = "", oob = false): string => `
  <div id="hub-objective"
    ${oob ? `hx-swap-oob="outerHTML"` : ""}
    hx-get="/hub/island/objective${query}"
    hx-trigger="${model.selectedObjectiveId ? "sse:receipt-refresh throttle:700ms, sse:job-refresh throttle:400ms, " : ""}hub-objective-refresh from:body"
    hx-swap="outerHTML">
    ${renderObjectiveDetail(model)}
  </div>
`;

export const hubLiveIsland = (model: HubLiveProjection, query = "", oob = false): string => `
  <div id="hub-live"
    ${oob ? `hx-swap-oob="outerHTML"` : ""}
    hx-get="/hub/island/live${query}"
    hx-trigger="${model.selectedObjectiveId ? "sse:job-refresh throttle:300ms, sse:receipt-refresh throttle:450ms, " : ""}hub-live-refresh from:body"
    hx-swap="outerHTML">
    ${renderLiveConsole(model)}
  </div>
`;

export const hubDebugShell = (): string => `
  <section class="panel secondary-panel">
    <div class="panel-head">
      <h2>Debug Surfaces</h2>
      <span>load on demand</span>
    </div>
    <div id="hub-debug-shell">
      <button class="ghost panel-load" hx-get="/hub/island/debug" hx-target="#hub-debug-shell" hx-swap="innerHTML">Load debug surfaces</button>
    </div>
  </section>
`;

export const hubDebugIsland = (model: HubDebugProjection): string => `
  <div id="hub-debug"
    hx-get="/hub/island/debug"
    hx-trigger="hub-debug-refresh from:body"
    hx-swap="outerHTML">
    ${renderDebugSection(model)}
  </div>
`;

export const hubCommitsShell = (): string => `
  <section class="panel secondary-panel">
    <div class="panel-head">
      <h2>Commit Explorer</h2>
      <span>mirror-backed, load on demand</span>
    </div>
    <div id="hub-commits-shell">
      <button class="ghost panel-load" hx-get="/hub/island/commits" hx-target="#hub-commits-shell" hx-swap="innerHTML">Load commit explorer</button>
    </div>
  </section>
`;

export const hubCommitsIsland = (model: HubCommitProjection, query = "", oob = false): string => {
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const selectedObjectiveId = params.get("objective") || undefined;
  return `
  <div id="hub-commits"
    ${oob ? `hx-swap-oob="outerHTML"` : ""}
    hx-get="/hub/island/commits${query}"
    hx-trigger="hub-commits-refresh from:body"
    hx-swap="outerHTML">
    ${renderCommitExplorer(model, selectedObjectiveId)}
  </div>
`;
};

export const hubShell = (opts: {
  readonly composeIsland: string;
  readonly summaryIsland: string;
  readonly boardIsland: string;
  readonly objectiveIsland: string;
  readonly liveIsland: string;
  readonly debugShell: string;
  readonly commitsShell: string;
}): string => `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Hub</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script src="https://unpkg.com/htmx.org/dist/ext/sse.js"></script>
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
      max-width: 1760px;
      margin: 0 auto;
      padding: 14px;
    }
    .shell-grid {
      display: grid;
      grid-template-columns: minmax(300px, 0.82fr) minmax(0, 2.18fr);
      gap: 12px;
      align-items: start;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 12px;
      margin-bottom: 14px;
    }
    .title {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.03em;
    }
    .sub {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .back {
      color: var(--accent-2);
      text-decoration: none;
      font-size: 13px;
    }
    .panel, .lane {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }
    .panel {
      padding: 12px;
    }
    .panel-head, .lane-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: start;
      margin-bottom: 10px;
    }
    .panel-head h2, .lane-head h3 {
      margin: 0;
      font-size: 15px;
    }
    .lane-head h3 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .lane-sub, .muted {
      color: var(--muted);
    }
    .summary-bar {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .summary-tile {
      position: relative;
      padding: 11px 12px;
      border-radius: 14px;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--line);
      overflow: hidden;
    }
    .summary-tile::after {
      content: "";
      position: absolute;
      inset: 0 auto auto 0;
      width: 100%;
      height: 1px;
      background: linear-gradient(90deg, rgba(121,228,191,0.55), rgba(140,196,255,0.18), transparent);
    }
    .summary-tile.source-dirty {
      border-color: rgba(255, 207, 122, 0.3);
      background: rgba(255, 207, 122, 0.08);
    }
    .summary-label {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .summary-value {
      font-size: 16px;
      font-weight: 700;
      line-height: 1.1;
    }
    .objective-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }
    .objective-form textarea,
    .objective-form input,
    .objective-form select,
    .reply-form input,
    .mini-form input,
    .mini-form textarea,
    .mini-form select {
      width: 100%;
      border-radius: 11px;
      border: 1px solid var(--line-strong);
      background: rgba(255,255,255,0.03);
      color: var(--ink);
      padding: 10px 11px;
      font: inherit;
    }
    .objective-form textarea {
      min-height: 82px;
    }
    .compose-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .compose-hint {
      display: inline-flex;
      align-items: center;
      min-height: 38px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      font-family: "IBM Plex Mono", monospace;
      font-size: 11px;
    }
    .objective-form button,
    button {
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      background: linear-gradient(135deg, var(--accent), #9de8ff);
      color: #041015;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
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
      margin-bottom: 12px;
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
      grid-template-columns: minmax(0, 2.35fr) minmax(332px, 0.85fr);
      gap: 12px;
      margin-top: 12px;
      align-items: start;
    }
    .detail-stack {
      display: grid;
      gap: 12px;
      align-items: start;
    }
    .lane-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(220px, 1fr));
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .lane {
      position: relative;
      padding: 12px;
      min-height: 320px;
      overflow: hidden;
    }
    .lane::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 2px;
      background: linear-gradient(90deg, rgba(121,228,191,0.55), rgba(140,196,255,0.24), transparent);
    }
    .lane-count {
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .lane-body {
      display: grid;
      gap: 8px;
    }
    .card-action {
      margin: 0;
    }
    .objective-card, .commit-card {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.025));
      padding: 10px;
      color: inherit;
      cursor: pointer;
      text-align: left;
      appearance: none;
      display: grid;
      gap: 6px;
      transition: transform 140ms ease, border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
    }
    .mini-card, .pass-row {
      display: block;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.025));
      padding: 10px;
      text-decoration: none;
      color: inherit;
      transition: transform 140ms ease, border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
    }
    .objective-card:hover, .commit-card:hover, .mini-card:hover {
      transform: translateY(-1px);
      border-color: rgba(140,196,255,0.24);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
    }
    .objective-card.live-card {
      border-color: rgba(121,228,191,0.32);
      box-shadow: inset 0 0 0 1px rgba(121,228,191,0.08);
    }
    .objective-card.active, .commit-card.active {
      border-color: rgba(121,228,191,0.45);
      background: rgba(121,228,191,0.08);
    }
    .card-top, .card-foot, .card-meta, .pass-top, .pass-meta, .detail-actions, .detail-badges {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }
    .detail-actions form {
      margin: 0;
    }
    .card-title {
      display: block;
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.01em;
      line-height: 1.28;
    }
    .card-summary, .pass-summary, .pass-handoff, .detail-text {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.42;
      overflow-wrap: anywhere;
    }
    .card-summary {
      display: block;
      min-height: 18px;
      margin-bottom: 0;
    }
    .card-summary.live {
      color: var(--ink);
      min-height: 18px;
    }
    .card-runtime {
      display: block;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
      min-height: 15px;
      margin-bottom: 0;
      overflow-wrap: anywhere;
    }
    .hash, .time, .mini-status {
      font-family: "IBM Plex Mono", monospace;
      font-size: 10px;
      color: var(--muted);
    }
    .mini-status.live {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--accent);
    }
    .live-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 0 rgba(121,228,191,0.6);
      animation: pulse-live 1.6s ease-out infinite;
      flex: 0 0 auto;
    }
    @keyframes pulse-live {
      0% {
        box-shadow: 0 0 0 0 rgba(121,228,191,0.55);
      }
      70% {
        box-shadow: 0 0 0 9px rgba(121,228,191,0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(121,228,191,0);
      }
    }
    .badge, .tag {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border-radius: 999px;
      padding: 3px 7px;
      font-size: 10px;
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
      top: 14px;
      padding: 12px;
      background:
        linear-gradient(180deg, rgba(140,196,255,0.06), transparent 24%),
        var(--panel);
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin: 12px 0;
    }
    .detail-grid > div {
      min-width: 0;
    }
    .detail-grid.compact {
      gap: 9px 12px;
    }
    .detail-stage-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin: 12px 0;
    }
    .detail-stage {
      display: grid;
      gap: 6px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.025));
    }
    .detail-note {
      color: rgba(184, 194, 214, 0.72);
      font-size: 11px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .detail-label {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .detail-title-wrap {
      min-width: 0;
    }
    .detail-title-wrap h2 {
      margin: 0;
      font-size: 17px;
      line-height: 1.15;
    }
    .detail-id {
      margin-top: 4px;
      color: var(--muted);
      font-family: "IBM Plex Mono", monospace;
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .detail-kv {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 8px;
    }
    .live-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      border: 1px solid rgba(121,228,191,0.22);
      background: linear-gradient(180deg, rgba(121,228,191,0.12), rgba(121,228,191,0.04));
      color: var(--ink);
      font-size: 12px;
      line-height: 1.4;
    }
    .mono {
      font-family: "IBM Plex Mono", monospace;
    }
    .pass-list, .commit-list, .mini-list {
      display: grid;
      gap: 8px;
    }
    .pass-row {
      padding: 9px 10px;
    }
    .pass-title {
      font-weight: 700;
      text-transform: capitalize;
    }
    .pass-meta {
      color: var(--muted);
      font-size: 11px;
    }
    .pass-live {
      margin-top: 6px;
      padding: 8px 9px;
      border-radius: 11px;
      background: rgba(140,196,255,0.08);
      color: var(--ink);
      font-size: 11px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .pass-signals {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .tag.ok {
      color: var(--ok);
      border-color: rgba(125,226,157,0.35);
    }
    .tag.bad {
      color: var(--danger);
      border-color: rgba(255,143,143,0.4);
    }
    .tag.muted {
      color: var(--muted);
    }
    .pass-inspect {
      margin-top: 8px;
      border-top: 1px solid var(--line);
      padding-top: 8px;
    }
    .pass-inspect summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      list-style: none;
    }
    .pass-inspect summary::-webkit-details-marker {
      display: none;
    }
    .active-pass {
      margin-bottom: 12px;
      padding: 10px;
      border: 1px solid rgba(140,196,255,0.22);
      border-radius: 14px;
      background:
        linear-gradient(180deg, rgba(140,196,255,0.1), rgba(140,196,255,0.04)),
        rgba(140,196,255,0.06);
    }
    .active-pass .panel-head {
      margin-bottom: 8px;
    }
    .active-pass-copy {
      color: var(--ink);
      font-size: 12px;
      line-height: 1.45;
      margin-bottom: 8px;
    }
    .live-log {
      margin: 0;
      max-height: 168px;
      overflow: auto;
      border-radius: 11px;
      background: rgba(7, 11, 18, 0.88);
      border: 1px solid var(--line);
      padding: 9px 10px;
      color: var(--ink);
      font-family: "IBM Plex Mono", monospace;
      font-size: 10px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .live-log.error {
      margin-top: 8px;
      color: var(--danger);
    }
    .check-list {
      display: grid;
      gap: 5px;
      margin-top: 8px;
    }
    .check {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 9px;
      border-radius: 11px;
      font-size: 11px;
      border: 1px solid var(--line);
    }
    .check.ok { color: var(--ok); }
    .check.bad { color: var(--danger); }
    .debug-shell {
      margin-top: 12px;
    }
    .secondary-shell {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 12px;
      align-items: start;
    }
    .secondary-panel {
      min-height: 92px;
    }
    .panel-load {
      width: 100%;
      justify-content: center;
    }
    .live-panel {
      position: sticky;
      top: 18px;
    }
    .debug-toggle summary {
      cursor: pointer;
      color: var(--muted);
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 12px;
    }
    .debug-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    .commit-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .empty {
      color: var(--muted);
      font-size: 13px;
      padding: 8px 0;
    }
    @media (max-width: 1180px) {
      .summary-bar, .detail-grid, .debug-grid, .objective-form, .board-shell, .compose-advanced-grid, .shell-grid, .secondary-shell, .commit-grid {
        grid-template-columns: 1fr;
      }
      .detail-panel {
        position: static;
      }
      .live-panel {
        position: static;
      }
      .lane-grid {
        grid-template-columns: repeat(6, minmax(210px, 78vw));
      }
    }
  </style>
</head>
<body hx-ext="sse" sse-connect="/hub/stream">
  <div class="shell">
    <div class="head">
      <div>
        <h1 class="title">Receipt Hub</h1>
        <div class="sub">Autonomous objectives routed through isolated Git worktrees on this repo.</div>
      </div>
      <a class="back" href="/monitor">Open command center</a>
    </div>
    <div class="shell-grid">
      ${opts.composeIsland}
      ${opts.summaryIsland}
    </div>
    <div class="board-shell">
      ${opts.boardIsland}
      <div class="detail-stack">
        ${opts.objectiveIsland}
        ${opts.liveIsland}
      </div>
    </div>
    <div class="secondary-shell">
      ${opts.debugShell}
      ${opts.commitsShell}
    </div>
  </div>
  <script>
    (() => {
      const key = "receipt:hub:compose";
      const fields = ["title", "prompt"];
      const bindCompose = () => {
        const root = document.getElementById("hub-compose");
        const form = root ? root.querySelector("form.objective-form") : null;
        if (!form || form.dataset.bound === "true") return;
        form.dataset.bound = "true";
        let saved = {};
        try {
          saved = JSON.parse(sessionStorage.getItem(key) || "{}");
        } catch {
          saved = {};
        }
        for (const name of fields) {
          const field = form.elements.namedItem(name);
          if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) continue;
          const value = saved[name];
          if (typeof value === "string" && value && !field.value) {
            field.value = value;
          }
          const persist = () => {
            const next = {};
            for (const fieldName of fields) {
              const current = form.elements.namedItem(fieldName);
              if (current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement || current instanceof HTMLSelectElement) {
                if (current.value) next[fieldName] = current.value;
              }
            }
            sessionStorage.setItem(key, JSON.stringify(next));
          };
          field.addEventListener("input", persist);
          field.addEventListener("change", persist);
        }
        form.addEventListener("htmx:afterRequest", (event) => {
          if (!event.detail?.successful) return;
          sessionStorage.removeItem(key);
          form.reset();
        });
      };
      document.addEventListener("DOMContentLoaded", bindCompose, { once: true });
      document.body.addEventListener("htmx:afterSwap", bindCompose);
    })();
  </script>
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
      <div class="muted">${model.lanes.awaiting_confirmation.length} ready to merge</div>
    </div>
    <div class="summary-tile">
      <div class="summary-label">Agents</div>
      <div class="summary-value">${model.agents.length}</div>
      <div class="muted">${model.agents.map((agent) => esc(agent.agentId)).join(" · ")}</div>
    </div>
  </div>
  <div class="board-shell">
    <section class="panel">
      <div class="panel-head">
        <h2>Objective Grid</h2>
        <span>Work flows across agents automatically</span>
      </div>
      <div class="lane-grid">
        ${renderLane("Planner", "planner-1", model.lanes.planner, model.selectedObjective?.objectiveId)}
        ${renderLane("Builder", "builder-1", model.lanes.builder, model.selectedObjective?.objectiveId)}
        ${renderLane("Reviewer", "reviewer-1", model.lanes.reviewer, model.selectedObjective?.objectiveId)}
        ${renderLane("Ready To Merge", "review complete · human merge required", model.lanes.awaiting_confirmation, model.selectedObjective?.objectiveId)}
        ${renderLane("Blocked", "needs intervention", model.lanes.blocked, model.selectedObjective?.objectiveId)}
        ${renderLane("Completed", "closed objectives", model.lanes.completed, model.selectedObjective?.objectiveId)}
      </div>
    </section>
    ${renderObjectiveDetail({
      defaultBranch: model.defaultBranch,
      sourceBranch: model.sourceBranch,
      sourceDirty: model.sourceDirty,
      selectedObjectiveId: model.selectedObjective?.objectiveId,
      objective: model.selectedObjective,
    })}
  </div>
  <section class="secondary-shell">
    <div class="panel secondary-panel">${renderDebugSection({
      workspaces: model.workspaces,
      posts: model.posts,
      tasks: model.tasks,
    })}</div>
    <div class="panel secondary-panel">${renderCommitExplorer({
      defaultBranch: model.defaultBranch,
      sourceHead: model.sourceHead,
      commitCount: model.commitCount,
      leafCount: model.leafCount,
      recentCommits: model.recentCommits,
      leaves: model.leaves,
      selectedCommit: model.selectedCommit,
      selectedLineage: model.selectedLineage,
      selectedDiff: model.selectedDiff,
    })}</div>
  </section>
`;

export const hubDashboardIsland = (model: HubDashboardModel, query = ""): string => `
  <div id="hub-dashboard"
    hx-get="/hub/island/dashboard${query}"
    hx-trigger="sse:receipt-refresh throttle:900ms, sse:job-refresh throttle:500ms, hub-refresh from:body"
    hx-swap="outerHTML">
    ${hubDashboard(model)}
  </div>
`;
