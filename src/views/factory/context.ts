import type {
  FactoryDebugProjection,
  FactoryLiveProjection,
  FactoryObjectiveDetail,
} from "./types.js";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  cardInner,
  copySoft,
  emptyText,
  esc,
  flexBetween,
  formatTime,
  formInput,
  kicker,
  labelUpper,
  metaRow,
  mutedSm,
  renderMeter,
  renderParsedPolicy,
  renderPill,
  renderWorktreeTable,
  shortHash,
  statLabel,
  statValue,
  titleSm,
} from "./widgets.js";

// ── Budget meters ────────────────────────────────────────────────────────────

const renderBudgetSection = (detail: FactoryObjectiveDetail): string => `
  <div class="context-section grid gap-3 p-4 border-b border-border">
    <div class="${labelUpper}">Budget</div>
    ${renderMeter("Task runs", detail.budgetState.taskRunsUsed, detail.policy.budgets.maxTaskRuns)}
    ${renderMeter("Reconciliation", detail.budgetState.reconciliationTasksUsed, detail.policy.budgets.maxReconciliationTasks)}
    <div class="flex justify-between text-xs">
      <span class="${statLabel}">Elapsed</span>
      <span class="font-mono text-foreground">${detail.budgetState.elapsedMinutes}m</span>
    </div>
    <div class="flex justify-between text-xs">
      <span class="${statLabel}">Queue</span>
      <span class="font-mono text-foreground">${esc(detail.scheduler.slotState)}${detail.scheduler.queuePosition ? ` · #${detail.scheduler.queuePosition}` : ""}</span>
    </div>
  </div>
`;

// ── Integration status ───────────────────────────────────────────────────────

const renderIntegrationSection = (detail: FactoryObjectiveDetail): string => {
  const int = detail.integration;
  return `
    <div class="context-section grid gap-2 p-4 border-b border-border">
      <div class="${labelUpper}">Integration</div>
      <div class="grid gap-1.5 text-xs">
        <div class="flex gap-3">
          <span class="text-muted-foreground">Status</span>
          ${renderPill(int.status.replaceAll("_", " "), int.status)}
        </div>
        ${int.branchName ? `<div class="flex gap-3"><span class="text-muted-foreground shrink-0">Branch</span><span class="font-mono min-w-0">${esc(int.branchName)}</span></div>` : ""}
        ${int.activeCandidateId ? `<div class="flex gap-3"><span class="text-muted-foreground shrink-0">Candidate</span><span class="font-mono min-w-0">${esc(int.activeCandidateId)}</span></div>` : ""}
        ${int.validationResults?.length ? `
          <div class="grid gap-1 mt-1">
            ${int.validationResults.map((check) => `
              <div class="flex gap-2 items-center">
                <span class="text-xs ${check.ok ? "text-primary" : "text-destructive"}">${check.ok ? "✓" : "✕"}</span>
                <code class="text-xs">${esc(check.command)}</code>
              </div>
            `).join("")}
          </div>
        ` : ""}
      </div>
    </div>
  `;
};

// ── Steer form ───────────────────────────────────────────────────────────────

const renderSteerSection = (debug: FactoryDebugProjection): string => {
  const activeJob = debug.activeJobs[0];
  if (!activeJob) return "";
  const jobId = activeJob.id;
  return `
    <div class="context-section grid gap-3 p-4 border-b border-border">
      <div class="${labelUpper}">Steer Active Job</div>
      <div class="${mutedSm}">Job ${esc(jobId)} · ${esc(activeJob.agentId)} · ${esc(activeJob.status)}</div>
      <form action="/factory/job/${encodeURIComponent(jobId)}/steer" method="post"
            hx-post="/factory/job/${encodeURIComponent(jobId)}/steer" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.reset();this.closest('[data-steer-status]')?.setAttribute('data-steer-status','Queued.')}">
        <div class="grid gap-2">
          <textarea name="problem" class="${formInput} min-h-[60px] resize-y text-xs" placeholder="Override problem statement"></textarea>
          <textarea name="config" class="${formInput} min-h-[40px] resize-y text-xs" placeholder='Config JSON (optional), e.g. {"maxIterations":4}'></textarea>
          <div class="flex gap-2">
            <button type="submit" class="${btnPrimary} text-xs py-1.5 px-3">Queue Steer</button>
          </div>
        </div>
      </form>
      <form action="/factory/job/${encodeURIComponent(jobId)}/follow-up" method="post"
            hx-post="/factory/job/${encodeURIComponent(jobId)}/follow-up" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.reset()}">
        <div class="grid gap-2">
          <textarea name="note" class="${formInput} min-h-[40px] resize-y text-xs" placeholder="Follow-up guidance" required></textarea>
          <button type="submit" class="${btnGhost} text-xs py-1.5 px-3">Follow-up</button>
        </div>
      </form>
      <form action="/factory/job/${encodeURIComponent(jobId)}/abort" method="post"
            hx-post="/factory/job/${encodeURIComponent(jobId)}/abort" hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.reset()}">
        <div class="flex gap-2">
          <input name="reason" class="${formInput} text-xs" value="abort requested" />
          <button type="submit" class="${btnDanger} text-xs py-1.5 px-3 whitespace-nowrap">Abort</button>
        </div>
      </form>
    </div>
  `;
};

// ── Latest decision ──────────────────────────────────────────────────────────

const renderDecisionSection = (
  decision: FactoryDebugProjection["latestDecision"] | undefined,
): string => {
  if (!decision) return "";
  return `
    <div class="context-section grid gap-2 p-4 border-b border-border">
      <div class="${labelUpper}">Latest Decision</div>
      <div class="${copySoft}">${esc(decision.summary)}</div>
      <div class="${metaRow}">${esc(decision.source)} · ${esc(formatTime(decision.at))}${decision.selectedActionId ? ` · ${esc(decision.selectedActionId)}` : ""}</div>
    </div>
  `;
};

// ── Parsed debug sections ────────────────────────────────────────────────────

const renderPolicySection = (debug: FactoryDebugProjection): string => `
  <details class="context-section p-4 border-b border-border">
    <summary class="cursor-pointer list-none font-medium text-sm flex items-center gap-2">
      <span class="text-xs text-muted-foreground">▶</span> Policy
    </summary>
    <div class="mt-3">
      ${renderParsedPolicy(debug.policy as unknown as Record<string, unknown>)}
    </div>
  </details>
`;

const renderRepoProfileSection = (debug: FactoryDebugProjection): string => `
  <details class="context-section p-4 border-b border-border">
    <summary class="cursor-pointer list-none font-medium text-sm flex items-center gap-2">
      <span class="text-xs text-muted-foreground">▶</span> Repo Profile
    </summary>
    <div class="mt-3 grid gap-2">
      <div class="flex gap-2 items-center">
        ${renderPill(debug.repoProfile.status.replaceAll("_", " "), debug.repoProfile.status)}
      </div>
      ${debug.repoProfile.summary ? `<div class="${mutedSm}">${esc(debug.repoProfile.summary)}</div>` : ""}
      ${debug.repoProfile.inferredChecks?.length ? `
        <div class="flex flex-wrap gap-1.5 mt-1">
          ${debug.repoProfile.inferredChecks.map((check: string) => renderPill(check, "check")).join("")}
        </div>
      ` : ""}
    </div>
  </details>
`;

const renderWorktreeSection = (debug: FactoryDebugProjection): string => `
  <details class="context-section p-4 border-b border-border">
    <summary class="cursor-pointer list-none font-medium text-sm flex items-center gap-2">
      <span class="text-xs text-muted-foreground">▶</span> Worktrees
    </summary>
    <div class="mt-3">
      ${renderWorktreeTable(debug.taskWorktrees)}
      ${debug.integrationWorktree ? `
        <div class="mt-3 pt-3 border-t border-border/40">
          <div class="${labelUpper} mb-2">Integration Worktree</div>
          <div class="grid gap-1 text-xs">
            <div class="flex gap-3">
              <span class="text-muted-foreground shrink-0">Branch</span>
              <span class="font-mono min-w-0">${esc(debug.integrationWorktree.branch ?? "—")}</span>
            </div>
            <div class="flex gap-3">
              <span class="text-muted-foreground">State</span>
              ${debug.integrationWorktree.exists
                ? (debug.integrationWorktree.dirty ? renderPill("dirty", "blocked") : renderPill("clean", "active"))
                : renderPill("missing", "queued")}
            </div>
            <div class="flex gap-3">
              <span class="text-muted-foreground">Head</span>
              <span class="font-mono">${esc(shortHash(debug.integrationWorktree.head))}</span>
            </div>
          </div>
        </div>
      ` : ""}
    </div>
  </details>
`;

const renderContextPacksSection = (debug: FactoryDebugProjection): string => `
  <details class="context-section p-4 border-b border-border">
    <summary class="cursor-pointer list-none font-medium text-sm flex items-center gap-2">
      <span class="text-xs text-muted-foreground">▶</span> Context Packs
    </summary>
    <div class="mt-3 grid gap-2">
      ${debug.latestContextPacks.length ? debug.latestContextPacks.map((cp) => `
        <div class="grid gap-0.5 text-xs py-1 border-b border-border/30">
          <span class="font-mono text-foreground">${esc(cp.taskId)}</span>
          ${cp.candidateId ? `<span class="${mutedSm}">candidate: ${esc(cp.candidateId)}</span>` : ""}
          ${cp.contextPackPath ? `<span class="${mutedSm}">pack: ${esc(cp.contextPackPath)}</span>` : ""}
        </div>
      `).join("") : `<div class="${emptyText}">No context packs.</div>`}
    </div>
  </details>
`;

const renderJobsSection = (debug: FactoryDebugProjection): string => {
  const allJobs = [...debug.activeJobs, ...debug.lastJobs];
  if (!allJobs.length) return "";
  return `
    <details class="context-section p-4 border-b border-border">
      <summary class="cursor-pointer list-none font-medium text-sm flex items-center gap-2">
        <span class="text-xs text-muted-foreground">▶</span> Jobs
        <span class="text-xs font-mono text-muted-foreground ml-auto">${allJobs.length}</span>
      </summary>
      <div class="mt-3 grid gap-2">
        ${allJobs.map((job) => `
          <div class="${cardInner} grid gap-1 min-w-0">
            <div class="${flexBetween}">
              <span class="font-mono text-xs min-w-0">${esc(job.id)}</span>
              <span class="shrink-0">${renderPill(job.status, job.status)}</span>
            </div>
            <div class="${mutedSm}">${esc(job.agentId)} · attempt ${job.attempt}/${job.maxAttempts}</div>
            ${job.lastError ? `<div class="text-xs text-destructive">${esc(job.lastError)}</div>` : ""}
          </div>
        `).join("")}
      </div>
    </details>
  `;
};

// ── Context island ───────────────────────────────────────────────────────────

export const factoryContextIsland = (
  detail: FactoryObjectiveDetail | undefined,
  debug: FactoryDebugProjection | undefined,
  live: FactoryLiveProjection | undefined,
): string => {
  if (!detail || !debug) {
    return `
      <section id="factory-context" class="grid content-start">
        <div class="p-4">
          <div class="${kicker}">Context</div>
          <h3 class="m-0 text-sm font-semibold mt-0.5">No objective selected</h3>
          <p class="${mutedSm}">Context panel appears once an objective is selected.</p>
        </div>
      </section>
    `;
  }

  return `
    <section id="factory-context" class="grid content-start [overflow-wrap:anywhere]" data-steer-status="">
      ${renderBudgetSection(detail)}
      ${renderIntegrationSection(detail)}
      ${renderDecisionSection(debug.latestDecision)}
      ${renderSteerSection(debug)}
      ${renderPolicySection(debug)}
      ${renderRepoProfileSection(debug)}
      ${renderWorktreeSection(debug)}
      ${renderContextPacksSection(debug)}
      ${renderJobsSection(debug)}
    </section>
  `;
};
