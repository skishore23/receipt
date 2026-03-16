import { cn } from "../lib/cn.js";
import { esc, truncate } from "./agent-framework.js";
import type {
  FactoryBoardProjection,
  FactoryComposeModel,
  FactoryDebugProjection,
  FactoryLiveProjection,
  FactoryObjectiveDetail,
  FactoryTaskView,
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

// ── Style tokens ──────────────────────────────────────────────────────────────

const modalCard = "bg-card border border-border rounded-lg shadow-panel";
const kicker = "text-[11px] tracking-[0.14em] uppercase text-muted-foreground font-medium";
const cardInner = "bg-muted/50 border border-border rounded-md p-3.5";
const flexBetween = "flex items-start justify-between gap-3";
const metaRow = "flex flex-wrap gap-2.5 text-muted-foreground text-xs font-mono";
const titleSm = "text-sm font-semibold leading-tight";
const gridStack = "grid gap-3";
const emptyText = "text-muted-foreground text-[13px] italic";
const mutedSm = "text-muted-foreground text-xs leading-relaxed";
const labelUpper = "text-[11px] tracking-[0.12em] uppercase text-muted-foreground font-medium";
const copySoft = "text-muted-foreground leading-normal text-sm whitespace-pre-wrap break-words";
const btnPrimary = "rounded-md bg-primary text-primary-foreground font-medium py-2 px-3.5";
const btnGhost = "rounded-md border border-border text-muted-foreground font-medium py-2 px-3.5";
const btnDanger = "rounded-md border border-destructive/40 bg-destructive/10 text-destructive font-medium py-2 px-3.5";
const formInput = "w-full rounded-md border border-border bg-background text-foreground text-sm py-2.5 px-3 placeholder:text-muted-foreground/60";
const statLabel = "text-[11px] tracking-[0.1em] uppercase text-muted-foreground font-medium";
const statValue = "text-lg font-mono font-semibold text-foreground";

// ── Pill helpers ──────────────────────────────────────────────────────────────

const pillBase = "inline-flex items-center gap-1 py-0.5 px-2 rounded-full border text-[10px] uppercase tracking-wider font-medium";

const pillVariant = (kind: string): string => {
  const k = statusClass(kind);
  if (["blocked", "failed", "conflicted"].includes(k)) return "border-destructive/40 bg-destructive/10 text-destructive";
  if (["ready_to_promote", "promoting", "promoted", "active"].includes(k)) return "border-primary/30 bg-primary/8 text-primary";
  if (["queued", "planning_graph", "preparing_repo", "waiting_for_slot"].includes(k)) return "border-muted-foreground/20 bg-muted text-muted-foreground";
  return "border-border bg-muted/40 text-muted-foreground";
};

const renderPill = (label: string, kind: string): string =>
  `<span class="${cn(pillBase, pillVariant(kind))}">${esc(label)}</span>`;

const renderDecision = (decision: FactoryObjectiveDetail["latestDecision"] | FactoryDebugProjection["latestDecision"] | undefined): string =>
  decision
    ? `
      <article class="${cardInner} grid gap-2">
        <div class="${labelUpper}">Latest Decision</div>
        <div class="${copySoft}">${esc(decision.summary)}</div>
        <div class="${metaRow}">${esc(decision.source)} · ${esc(formatTime(decision.at))}${decision.selectedActionId ? ` · ${esc(decision.selectedActionId)}` : ""}</div>
      </article>
    `
    : `
      <article class="${cardInner} grid gap-2">
        <div class="${labelUpper}">Latest Decision</div>
        <div class="${emptyText}">No orchestration decision yet.</div>
      </article>
    `;

// ── Compose island ────────────────────────────────────────────────────────────

export const factoryComposeIsland = (model: FactoryComposeModel): string => `
  <section id="factory-compose" class="compose-overlay" aria-hidden="true">
    <div class="${modalCard} w-[min(860px,calc(100vw-48px))] p-5 grid gap-4">
      <div class="${flexBetween}">
        <div>
          <div class="${kicker}">New Objective</div>
          <h2 class="m-0 text-2xl font-semibold leading-tight mt-1">Launch a Factory objective</h2>
          <p class="m-0 text-muted-foreground text-sm leading-relaxed mt-1">Factory turns a repo objective into a task graph, worker passes, integration, validation, and promotion.</p>
        </div>
        <button type="button" class="${btnGhost}" data-compose-close>Close</button>
      </div>
      <form
        class="grid gap-3"
        action="/factory/ui/objectives"
        method="post"
        hx-post="/factory/ui/objectives"
        hx-swap="none"
        hx-on::after-request="if (event.detail.successful) this.reset()">
        <label class="grid gap-1.5">
          <span class="${labelUpper}">Objective</span>
          <textarea name="prompt" class="${formInput} min-h-[120px] resize-y" placeholder="Describe the change, acceptance criteria, and repository constraints." required></textarea>
        </label>
        <div class="form-grid-2">
          <label class="grid gap-1.5">
            <span class="${labelUpper}">Optional title</span>
            <input name="title" class="${formInput}" placeholder="Factory derives one from the objective if you leave this blank." />
          </label>
          <label class="grid gap-1.5">
            <span class="${labelUpper}">Channel</span>
            <input name="channel" class="${formInput}" placeholder="results" value="results" />
          </label>
        </div>
        <details class="${cardInner}">
          <summary class="cursor-pointer list-none font-medium text-sm">Advanced</summary>
          <div class="form-grid-2 mt-3">
            <label class="grid gap-1.5">
              <span class="${labelUpper}">Base commit</span>
              <input name="baseHash" class="${formInput}" placeholder="optional base commit" />
            </label>
            <label class="grid gap-1.5">
              <span class="${labelUpper}">Validation Commands</span>
              <textarea name="validationCommands" class="${formInput} min-h-[100px] resize-y" placeholder="One command per line.">${esc(model.defaultValidationCommands.join("\n"))}</textarea>
            </label>
            <label class="grid gap-1.5">
              <span class="${labelUpper}">Policy override</span>
              <textarea name="policy" class="${formInput} min-h-[100px] resize-y" placeholder='Optional JSON policy override, e.g. {"promotion":{"autoPromote":false}}'></textarea>
            </label>
          </div>
        </details>
        <div class="flex justify-between items-center gap-3 flex-wrap">
          <div class="flex items-center gap-2 flex-wrap">
            ${renderPill(`${model.objectiveCount} objectives`, "count")}
            ${renderPill(model.sourceBranch ?? model.defaultBranch, "branch")}
            ${renderPill(model.repoProfile.status.replaceAll("_", " "), model.repoProfile.status)}
          </div>
          <button type="submit" class="${btnPrimary}">Launch Objective</button>
        </div>
        <div class="${cn("rounded-md text-sm p-3", model.sourceDirty ? "bg-warning/10 text-warning border border-warning/20" : "bg-muted/50 text-muted-foreground")}">
          ${model.sourceDirty
            ? "Objective creation is blocked while the source repo has uncommitted changes unless you provide a base commit."
            : model.repoProfile.summary
              ? esc(model.repoProfile.summary)
              : "Factory will prepare repo defaults and generated skills on the first admitted objective."}
        </div>
      </form>
    </div>
  </section>
`;

// ── Board island ──────────────────────────────────────────────────────────────

const renderObjectiveCard = (
  card: FactoryBoardProjection["objectives"][number],
  activeId?: string,
): string => {
  const summary = card.blockedExplanation?.summary ?? card.latestSummary ?? card.nextAction ?? "No activity yet.";
  return `
    <a class="${cn(cardInner, "block no-underline", card.objectiveId === activeId && "border-primary/40 ring-1 ring-inset ring-primary/15")}" href="/factory${factoryQuery(card.objectiveId)}">
      <div class="${flexBetween}">
        <div class="flex gap-1.5 flex-wrap">
          ${renderPill(card.phase.replaceAll("_", " "), card.phase)}
          ${renderPill(card.scheduler.slotState, card.scheduler.slotState)}
        </div>
        <span class="${mutedSm} shrink-0">${esc(formatTime(card.updatedAt))}</span>
      </div>
      <div class="${titleSm} mt-2">${esc(truncate(card.title, 80))}</div>
      <div class="text-muted-foreground text-xs mt-1">${esc(truncate(summary, 140))}</div>
      <div class="${metaRow} mt-2">
        <span>${card.taskCount} tasks</span>
        <span>${card.activeTaskCount} active</span>
        <span>${card.scheduler.queuePosition ? `q${card.scheduler.queuePosition}` : shortHash(card.latestCommitHash)}</span>
      </div>
    </a>
  `;
};

const renderBoardSection = (
  title: string,
  body: string,
  cards: ReadonlyArray<FactoryBoardProjection["objectives"][number]>,
  activeId?: string,
): string => `
  <section class="${gridStack}">
    <div class="${flexBetween} border-b border-border pb-2">
      <div>
        <div class="text-xs font-semibold">${esc(title)}</div>
        <div class="text-muted-foreground text-[11px]">${esc(body)}</div>
      </div>
      <span class="text-xs font-mono text-muted-foreground">${cards.length}</span>
    </div>
    <div class="${gridStack}">
      ${cards.length ? cards.map((card) => renderObjectiveCard(card, activeId)).join("") : `<div class="${emptyText}">No objectives.</div>`}
    </div>
  </section>
`;

export const factoryBoardIsland = (board: FactoryBoardProjection): string => `
  <section id="factory-board" class="rail-panel grid gap-4 p-4 content-start">
    <div class="grid gap-3">
      <div>
        <div class="${kicker}">Command Center</div>
        <h1 class="m-0 text-xl font-bold leading-tight mt-1">Factory</h1>
        <p class="m-0 text-muted-foreground text-xs leading-relaxed mt-1">Objective orchestration with repo preparation, planning, evidence, and promotion.</p>
      </div>
      <button type="button" class="${btnPrimary} w-full" data-compose-open>New Objective</button>
    </div>
    ${renderBoardSection("Needs Attention", "Blocked or conflicted.", board.sections.needs_attention, board.selectedObjectiveId)}
    ${renderBoardSection("Active", "Holding the execution slot.", board.sections.active, board.selectedObjectiveId)}
    ${renderBoardSection("Queued", "Waiting for the slot.", board.sections.queued, board.selectedObjectiveId)}
    ${renderBoardSection("Completed", "Finished or canceled.", board.sections.completed, board.selectedObjectiveId)}
  </section>
`;

// ── Task / evidence / activity cards ──────────────────────────────────────────

const renderTaskCard = (task: FactoryTaskView): string => `
  <article class="${cardInner}">
    <div class="${flexBetween}">
      <div>
        <strong class="font-mono text-xs">${esc(task.taskId)}</strong>
        <div class="${mutedSm}">${esc(task.workerType)} · ${esc(task.taskKind)}</div>
      </div>
      ${renderPill(task.status.replaceAll("_", " "), task.status)}
    </div>
    <div class="${titleSm} mt-1">${esc(task.title)}</div>
    ${task.dependsOn.length ? `<div class="${mutedSm}">Depends on ${esc(task.dependsOn.join(", "))}</div>` : ""}
    ${task.latestSummary ? `<div class="${copySoft} mt-1">${esc(task.latestSummary)}</div>` : ""}
    ${task.blockedReason ? `<div class="p-3 rounded-md bg-destructive/8 border border-destructive/20 text-destructive text-sm">${esc(task.blockedReason)}</div>` : ""}
    <div class="${metaRow} mt-2">
      ${task.candidateId ? `<span>${esc(task.candidateId)}</span>` : ""}
      ${task.jobStatus ? `<span>${esc(task.jobStatus)}</span>` : ""}
      ${task.elapsedMs ? `<span>${esc(formatDuration(task.elapsedMs))}</span>` : ""}
      <span>${task.workspaceExists ? (task.workspaceDirty ? "dirty workspace" : "clean workspace") : "no workspace"}</span>
    </div>
  </article>
`;

const renderEvidenceCard = (card: FactoryObjectiveDetail["evidenceCards"][number]): string => `
  <article class="${cardInner}" id="receipt-${esc(card.receiptHash ?? `${card.receiptType}-${card.at}`)}">
    <div class="${flexBetween}">
      ${renderPill(card.kind, card.kind)}
      <span class="${mutedSm}">${esc(formatTime(card.at))}</span>
    </div>
    <div class="${titleSm} mt-1">${esc(card.title)}</div>
    <div class="${copySoft} mt-1">${esc(card.summary)}</div>
    <div class="${metaRow} mt-2">
      <span>${esc(card.receiptType)}</span>
      ${card.taskId ? `<span>${esc(card.taskId)}</span>` : ""}
      ${card.candidateId ? `<span>${esc(card.candidateId)}</span>` : ""}
    </div>
  </article>
`;

const renderActivityEntry = (entry: FactoryObjectiveDetail["activity"][number]): string => `
  <article class="${flexBetween} py-2 border-b border-border/50">
    <div>
      <div class="${titleSm}">${esc(entry.title)}</div>
      <div class="text-muted-foreground text-xs">${esc(entry.summary)}</div>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      ${renderPill(entry.kind, entry.kind)}
      <span class="${mutedSm} whitespace-nowrap">${esc(formatTime(entry.at))}</span>
    </div>
  </article>
`;

const renderReceiptTimeline = (receipts: ReadonlyArray<FactoryObjectiveDetail["recentReceipts"][number]>): string =>
  receipts.length
    ? receipts.map((receipt) => `
        <article class="${cardInner}" id="receipt-${esc(receipt.hash)}">
          <div class="${flexBetween}">
            <strong class="font-mono text-xs">${esc(receipt.type)}</strong>
            <span class="${mutedSm}">${esc(formatTime(receipt.ts))}</span>
          </div>
          <div class="${copySoft} mt-1">${esc(receipt.summary)}</div>
          <div class="${metaRow} mt-2">
            ${receipt.taskId ? `<span>${esc(receipt.taskId)}</span>` : ""}
            ${receipt.candidateId ? `<span>${esc(receipt.candidateId)}</span>` : ""}
            <span>${esc(shortHash(receipt.hash))}</span>
          </div>
        </article>
      `).join("")
    : `<div class="${emptyText}">No receipts yet.</div>`;

// ── Tab panels ────────────────────────────────────────────────────────────────

const renderOverview = (detail: FactoryObjectiveDetail): string => `
  <section class="tab-panel" data-tab-panel="overview">
    <div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
      <article class="${cardInner} grid gap-2">
        <div class="${labelUpper}">Objective</div>
        <div class="${copySoft}">${esc(detail.prompt)}</div>
      </article>
      <article class="${cardInner} grid gap-2">
        <div class="${labelUpper}">Next Action</div>
        <div class="${copySoft}">${esc(detail.nextAction ?? "No next action recorded yet.")}</div>
      </article>
      <article class="${cardInner} grid gap-2">
        <div class="${labelUpper}">Repo Profile</div>
        <div class="${copySoft}">${esc(detail.repoProfile.summary || "Repo profile has not been generated yet.")}</div>
        <div class="${metaRow}">
          ${detail.repoProfile.inferredChecks.length
            ? detail.repoProfile.inferredChecks.map((check) => `<span>${esc(check)}</span>`).join("")
            : `<span>No inferred validation commands yet.</span>`}
        </div>
      </article>
      <article class="${cardInner} grid gap-2">
        <div class="${labelUpper}">Policy</div>
        <div class="${copySoft}">Concurrency ${detail.policy.concurrency.maxActiveTasks}, dispatch burst ${detail.policy.throttles.maxDispatchesPerReact}, auto-promote ${String(detail.policy.promotion.autoPromote)}.</div>
      </article>
    </div>
  </section>
`;

const renderTasksTab = (detail: FactoryObjectiveDetail): string => `
  <section class="tab-panel" data-tab-panel="tasks">
    <div class="${flexBetween}">
      <div>
        <h3 class="m-0 text-sm font-semibold">Tasks</h3>
        <p class="m-0 text-muted-foreground text-xs">Task graph, candidates, and active worker passes.</p>
      </div>
      <span class="font-mono text-xs text-muted-foreground">${detail.tasks.length}</span>
    </div>
    <div class="${gridStack}">
      ${detail.tasks.length ? detail.tasks.map(renderTaskCard).join("") : `<div class="${emptyText}">No tasks adopted yet.</div>`}
    </div>
    <div class="${flexBetween} mt-4 pt-4 border-t border-border">
      <div>
        <h3 class="m-0 text-sm font-semibold">Candidates</h3>
        <p class="m-0 text-muted-foreground text-xs">Candidate lineage and review status.</p>
      </div>
      <span class="font-mono text-xs text-muted-foreground">${detail.candidates.length}</span>
    </div>
    <div class="${gridStack}">
      ${detail.candidates.length ? detail.candidates.map((candidate) => `
        <article class="${cardInner}">
          <div class="${flexBetween}">
            <strong class="font-mono text-xs">${esc(candidate.candidateId)}</strong>
            ${renderPill(candidate.status.replaceAll("_", " "), candidate.status)}
          </div>
          <div class="${mutedSm} mt-1">${esc(candidate.taskId)} · base ${esc(shortHash(candidate.baseCommit))}${candidate.headCommit ? ` · head ${esc(shortHash(candidate.headCommit))}` : ""}</div>
          ${candidate.summary ? `<div class="${copySoft} mt-1">${esc(candidate.summary)}</div>` : ""}
          ${candidate.latestReason ? `<div class="${mutedSm} mt-1">${esc(candidate.latestReason)}</div>` : ""}
        </article>
      `).join("") : `<div class="${emptyText}">No candidates yet.</div>`}
    </div>
  </section>
`;

const renderEvidenceTab = (detail: FactoryObjectiveDetail): string => `
  <section class="tab-panel" data-tab-panel="evidence">
    <div class="${flexBetween}">
      <div>
        <h3 class="m-0 text-sm font-semibold">Evidence</h3>
        <p class="m-0 text-muted-foreground text-xs">Plan adoption, orchestration decisions, blocked receipts, merge decisions, and promotion receipts.</p>
      </div>
      <span class="font-mono text-xs text-muted-foreground">${detail.evidenceCards.length}</span>
    </div>
    <div class="${gridStack}">
      ${detail.evidenceCards.length ? detail.evidenceCards.map(renderEvidenceCard).join("") : `<div class="${emptyText}">No evidence cards yet.</div>`}
    </div>
    <div class="${flexBetween} mt-4 pt-4 border-t border-border">
      <div>
        <h3 class="m-0 text-sm font-semibold">Receipt Timeline</h3>
        <p class="m-0 text-muted-foreground text-xs">Humanized recent receipts with links back to the exact event hash.</p>
      </div>
      <span class="font-mono text-xs text-muted-foreground">${detail.recentReceipts.length}</span>
    </div>
    <div class="${gridStack}">
      ${renderReceiptTimeline(detail.recentReceipts)}
    </div>
  </section>
`;

const renderActivityTab = (detail: FactoryObjectiveDetail): string => `
  <section class="tab-panel" data-tab-panel="activity">
    <div class="${flexBetween}">
      <div>
        <h3 class="m-0 text-sm font-semibold">Activity</h3>
        <p class="m-0 text-muted-foreground text-xs">Recent task transitions, jobs, and receipts for the selected objective.</p>
      </div>
      <span class="font-mono text-xs text-muted-foreground">${detail.activity.length}</span>
    </div>
    <div class="${gridStack}">
      ${detail.activity.length ? detail.activity.map(renderActivityEntry).join("") : `<div class="${emptyText}">No activity yet.</div>`}
    </div>
  </section>
`;

// ── Objective island ──────────────────────────────────────────────────────────

export const factoryObjectiveIsland = (detail: FactoryObjectiveDetail | undefined): string => {
  if (!detail) {
    return `
      <section id="factory-objective" class="grid p-5 content-start">
        <div class="min-h-[calc(100vh-40px)] grid place-items-center gap-3 text-center">
          <div>
            <div class="${kicker}">Factory Workspace</div>
            <h2 class="m-0 text-2xl font-semibold leading-tight mt-2">Select an objective</h2>
            <p class="m-0 text-muted-foreground text-sm leading-relaxed mt-1">The center workspace shows repo prep, planning, tasks, evidence, and activity for the selected objective.</p>
            <button type="button" class="${btnPrimary} mt-4" data-compose-open>Create Objective</button>
          </div>
        </div>
      </section>
    `;
  }
  const phase = detail.phase ?? (detail.status === "blocked" ? "blocked" : detail.status === "planning" ? "planning_graph" : detail.status === "decomposing" ? "preparing_repo" : detail.status === "integrating" ? "integrating" : "executing");
  const slotState = detail.scheduler?.slotState ?? "active";
  const integrationStatus = detail.integration?.status ?? detail.integrationStatus ?? "idle";
  return `
    <section id="factory-objective" class="grid gap-4 p-5 content-start" data-objective-id="${esc(detail.objectiveId)}">
      <header class="grid gap-3 pb-4 border-b border-primary/12">
        <div class="${flexBetween} gap-4">
          <div>
            <div class="flex gap-1.5 flex-wrap">
              ${renderPill(phase.replaceAll("_", " "), phase)}
              ${renderPill(slotState, slotState)}
              ${renderPill(integrationStatus.replaceAll("_", " "), integrationStatus)}
            </div>
            <h2 class="m-0 text-xl font-semibold leading-tight mt-2">${esc(detail.title)}</h2>
            <p class="m-0 text-muted-foreground text-xs mt-1 font-mono">${esc(detail.objectiveId)}</p>
          </div>
          <div class="flex flex-wrap gap-2 justify-end shrink-0">
            <form action="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/react" method="post" hx-post="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/react" hx-swap="none"><button type="submit" class="${btnGhost}">React</button></form>
            ${detail.integration.status === "ready_to_promote"
              ? `<form action="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/promote" method="post" hx-post="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/promote" hx-swap="none"><button type="submit" class="${btnPrimary}">Promote</button></form>`
              : ""}
            <form action="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/cleanup" method="post" hx-post="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/cleanup" hx-swap="none"><button type="submit" class="${btnGhost}">Cleanup</button></form>
            <form action="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/archive" method="post" hx-post="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/archive" hx-swap="none"><button type="submit" class="${btnGhost}">Archive</button></form>
            <form action="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/cancel" method="post" hx-post="/factory/ui/objectives/${encodeURIComponent(detail.objectiveId)}/cancel" hx-swap="none"><button type="submit" class="${btnDanger}">Cancel</button></form>
          </div>
        </div>
        <p class="m-0 text-muted-foreground text-sm">${esc(detail.nextAction ?? "Factory is replaying receipts and waiting for the next control transition.")}</p>
      </header>
      ${detail.blockedExplanation
        ? `
          <a class="grid gap-1 p-3 rounded-md border border-warning/25 bg-warning/8 text-warning text-sm" href="#receipt-${esc(detail.blockedExplanation.receiptHash ?? "")}">
            <strong>Why blocked</strong>
            <span>${esc(detail.blockedExplanation.summary)}</span>
          </a>
        `
        : ""}
      <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
        <div class="grid gap-1"><span class="${statLabel}">Queue</span><span class="${statValue}">${esc(detail.scheduler.slotState)}${detail.scheduler.queuePosition ? ` · ${detail.scheduler.queuePosition}` : ""}</span></div>
        <div class="grid gap-1"><span class="${statLabel}">Task Runs</span><span class="${statValue}">${detail.budgetState.taskRunsUsed}/${detail.policy.budgets.maxTaskRuns}</span></div>
        <div class="grid gap-1"><span class="${statLabel}">Reconciliation</span><span class="${statValue}">${detail.budgetState.reconciliationTasksUsed}/${detail.policy.budgets.maxReconciliationTasks}</span></div>
        <div class="grid gap-1"><span class="${statLabel}">Elapsed</span><span class="${statValue}">${detail.budgetState.elapsedMinutes}m</span></div>
        <div class="grid gap-1"><span class="${statLabel}">Latest Commit</span><span class="${statValue}">${esc(shortHash(detail.latestCommitHash))}</span></div>
      </div>
      <nav class="flex border-b border-border sticky top-0 z-2 bg-background" data-objective-tabs>
        <button type="button" class="tab-btn py-2.5 px-4 active" data-tab="overview">Overview</button>
        <button type="button" class="tab-btn py-2.5 px-4" data-tab="tasks">Tasks</button>
        <button type="button" class="tab-btn py-2.5 px-4" data-tab="evidence">Evidence</button>
        <button type="button" class="tab-btn py-2.5 px-4" data-tab="activity">Activity</button>
      </nav>
      <div class="grid">
        ${renderOverview(detail)}
        ${renderTasksTab(detail)}
        ${renderEvidenceTab(detail)}
        ${renderActivityTab(detail)}
      </div>
    </section>
  `;
};

// ── Inspector islands ─────────────────────────────────────────────────────────

export const factoryLiveIsland = (live: FactoryLiveProjection): string => `
  <section id="factory-live" class="grid gap-3 p-4 content-start">
    <div class="${flexBetween}">
      <div>
        <div class="${kicker}">Live</div>
        <h3 class="m-0 text-sm font-semibold mt-0.5">${live.selectedObjectiveId ? esc(live.objectiveTitle ?? live.selectedObjectiveId) : "No objective selected"}</h3>
        <p class="m-0 text-muted-foreground text-xs">${live.selectedObjectiveId ? `${esc(live.phase ?? "executing")} · ${esc(live.objectiveStatus ?? "idle")}` : "Select an objective to inspect live task output."}</p>
      </div>
      <span class="font-mono text-xs text-muted-foreground">${live.activeTasks.length}</span>
    </div>
    <div class="${gridStack}">
      ${live.activeTasks.length
        ? live.activeTasks.map((task) => `
          <article class="${cardInner}">
            <div class="${flexBetween}">
              <strong class="font-mono text-xs">${esc(task.taskId)}</strong>
              ${renderPill((task.jobStatus ?? task.status).replaceAll("_", " "), task.jobStatus ?? task.status)}
            </div>
            <div class="${titleSm} mt-1">${esc(task.title)}</div>
            <div class="${mutedSm}">${esc(task.workerType)} · ${esc(formatDuration(task.elapsedMs))}</div>
            ${task.lastMessage ? `<pre class="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground overflow-x-auto">${esc(task.lastMessage)}</pre>` : ""}
            ${task.stdoutTail ? `<pre class="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground overflow-x-auto">${esc(task.stdoutTail)}</pre>` : ""}
            ${task.stderrTail ? `<pre class="mt-2 whitespace-pre-wrap text-[11px] text-destructive overflow-x-auto">${esc(task.stderrTail)}</pre>` : ""}
          </article>
        `).join("")
        : `<div class="${emptyText}">No active task output right now.</div>`}
    </div>
  </section>
`;

export const factoryDebugIsland = (debug: FactoryDebugProjection | undefined): string => {
  if (!debug) {
    return `
      <section id="factory-debug" class="grid gap-3 p-4 content-start">
        <div>
          <div class="${kicker}">Debug</div>
          <h3 class="m-0 text-sm font-semibold mt-0.5">No objective selected</h3>
          <p class="m-0 text-muted-foreground text-xs">Debug surfaces appear once an objective is selected.</p>
        </div>
      </section>
    `;
  }
  return `
    <section id="factory-debug" class="grid gap-3 p-4 content-start">
      <div class="${flexBetween}">
        <div>
          <div class="${kicker}">Debug</div>
          <h3 class="m-0 text-sm font-semibold mt-0.5">${esc(debug.title)}</h3>
          <p class="m-0 text-muted-foreground text-xs">${esc(debug.phase)} · ${esc(debug.scheduler.slotState)} · ${esc(debug.repoProfile.status)}</p>
        </div>
        <span class="font-mono text-xs text-muted-foreground">${debug.activeJobs.length}</span>
      </div>
      ${renderDecision(debug.latestDecision)}
      <article class="${cardInner} grid gap-2">
        <div class="${labelUpper}">Next Action</div>
        <div class="${copySoft}">${esc(debug.nextAction ?? "No next action surfaced.")}</div>
      </article>
      <details class="${cardInner}">
        <summary class="cursor-pointer list-none font-medium text-sm">Policy and budget</summary>
        <pre class="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground overflow-x-auto">${esc(JSON.stringify({ policy: debug.policy, budgetState: debug.budgetState }, null, 2))}</pre>
      </details>
      <details class="${cardInner}">
        <summary class="cursor-pointer list-none font-medium text-sm">Repo profile</summary>
        <pre class="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground overflow-x-auto">${esc(JSON.stringify(debug.repoProfile, null, 2))}</pre>
      </details>
      <details class="${cardInner}">
        <summary class="cursor-pointer list-none font-medium text-sm">Recent receipts</summary>
        <pre class="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground overflow-x-auto">${esc(JSON.stringify(debug.recentReceipts, null, 2))}</pre>
      </details>
      <details class="${cardInner}">
        <summary class="cursor-pointer list-none font-medium text-sm">Jobs</summary>
        <pre class="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground overflow-x-auto">${esc(JSON.stringify({ activeJobs: debug.activeJobs, lastJobs: debug.lastJobs }, null, 2))}</pre>
      </details>
      <details class="${cardInner}">
        <summary class="cursor-pointer list-none font-medium text-sm">Worktrees</summary>
        <pre class="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground overflow-x-auto">${esc(JSON.stringify({ taskWorktrees: debug.taskWorktrees, integrationWorktree: debug.integrationWorktree }, null, 2))}</pre>
      </details>
      <details class="${cardInner}">
        <summary class="cursor-pointer list-none font-medium text-sm">Context packs</summary>
        <pre class="mt-2 whitespace-pre-wrap text-[11px] text-muted-foreground overflow-x-auto">${esc(JSON.stringify(debug.latestContextPacks, null, 2))}</pre>
      </details>
    </section>
  `;
};

// ── Shell ─────────────────────────────────────────────────────────────────────

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
    <link rel="stylesheet" href="/assets/factory.css" />
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
          if (field instanceof HTMLSelectElement) return Array.from(field.options).some((option) => option.selected !== option.defaultSelected);
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
          const res = await fetch(url, { headers: { "HX-Request": "true" } });
          if (!res.ok) return;
          current.outerHTML = await res.text();
          applyObjectiveTabs();
          bindComposeDrawer();
          bindComposeTitleFallback();
        };
        let refreshPending = false;
        const refresh = () => {
          if (refreshPending) return;
          refreshPending = true;
          window.setTimeout(async () => {
            refreshPending = false;
            for (const [id, resolver] of targets) {
              await loadIsland(id, resolver());
            }
          }, 120);
        };
        const applyObjectiveTabs = () => {
          const objective = document.getElementById("factory-objective");
          if (!objective) return;
          const objectiveId = objective.getAttribute("data-objective-id") || "none";
          const stored = window.sessionStorage.getItem("factory-tab:" + objectiveId) || "overview";
          const tabs = objective.querySelectorAll("[data-tab]");
          const panels = objective.querySelectorAll("[data-tab-panel]");
          const activate = (tabName) => {
            tabs.forEach((tab) => tab.classList.toggle("active", tab.getAttribute("data-tab") === tabName));
            panels.forEach((panel) => {
              panel.classList.toggle("active", panel.getAttribute("data-tab-panel") === tabName);
            });
            window.sessionStorage.setItem("factory-tab:" + objectiveId, tabName);
          };
          tabs.forEach((tab) => {
            tab.addEventListener("click", () => activate(tab.getAttribute("data-tab") || "overview"));
          });
          activate(stored);
        };
        const bindComposeDrawer = () => {
          const openButtons = document.querySelectorAll("[data-compose-open]");
          const closeButtons = document.querySelectorAll("[data-compose-close]");
          openButtons.forEach((button) => button.addEventListener("click", () => document.body.classList.add("compose-open")));
          closeButtons.forEach((button) => button.addEventListener("click", () => document.body.classList.remove("compose-open")));
        };
        const deriveTitle = (prompt) => {
          const text = (prompt || "").replace(/\\s+/g, " ").trim();
          if (!text) return "";
          const firstSentence = text.split(/[.!?]/)[0] || text;
          return firstSentence.slice(0, 96).trim();
        };
        const bindComposeTitleFallback = () => {
          const compose = document.getElementById("factory-compose");
          if (!compose) return;
          const form = compose.querySelector("form");
          if (!(form instanceof HTMLFormElement)) return;
          form.addEventListener("submit", () => {
            const prompt = form.querySelector('textarea[name="prompt"]');
            const title = form.querySelector('input[name="title"]');
            if (prompt instanceof HTMLTextAreaElement && title instanceof HTMLInputElement && !title.value.trim()) {
              title.value = deriveTitle(prompt.value);
            }
          });
        };
        window.addEventListener("DOMContentLoaded", () => {
          applyObjectiveTabs();
          bindComposeDrawer();
          bindComposeTitleFallback();
          const source = new EventSource("/factory/events");
          source.addEventListener("message", refresh);
          source.addEventListener("receipt", refresh);
          source.addEventListener("jobs", refresh);
        });
      })();
    </script>
  </head>
  <body>
    <div class="factory-layout">
      ${opts.boardIsland}
      ${opts.objectiveIsland}
      <aside class="inspector-aside">
        ${opts.liveIsland}
        ${opts.debugIsland}
      </aside>
    </div>
    ${opts.composeIsland}
  </body>
</html>
`;
