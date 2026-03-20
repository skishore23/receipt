// ============================================================================
// Shared UI primitives — design system for all Receipt views
// ============================================================================

export { esc, truncate } from "./agent-framework.js";
import { esc } from "./agent-framework.js";

// ── Layout class constants ──────────────────────────────────────────────────

export const panelClass = "rounded-[28px] border border-white/10 bg-white/[0.04] shadow-[0_24px_80px_rgba(0,0,0,0.34)] backdrop-blur-2xl";
export const softPanelClass = "rounded-[24px] border border-white/10 bg-black/20 backdrop-blur-xl";
export const railCardClass = `${softPanelClass} p-4`;
export const sectionLabelClass = "text-[11px] font-medium uppercase tracking-[0.28em] text-zinc-500";

// ── Badge class constants ───────────────────────────────────────────────────

export const badgeBaseClass = "inline-flex max-w-full items-center justify-center gap-2 rounded-full border px-3 py-1 text-center text-[11px] font-medium uppercase tracking-[0.18em] whitespace-normal leading-4 break-words [overflow-wrap:anywhere]";

// ── Button class constants ──────────────────────────────────────────────────

export const buttonBaseClass = "inline-flex items-center justify-center rounded-full border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition";
export const primaryButtonClass = `${buttonBaseClass} border-emerald-300/40 bg-emerald-300 text-zinc-950 hover:bg-emerald-200`;
export const ghostButtonClass = `${buttonBaseClass} border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.09]`;
export const dangerButtonClass = `${buttonBaseClass} border-rose-300/25 bg-rose-400/10 text-rose-100 hover:bg-rose-400/20`;

// ── Nav class constants ─────────────────────────────────────────────────────

export const navPillClass = "inline-flex items-center rounded-full border px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] transition";

// ── Tone system ─────────────────────────────────────────────────────────────

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const toneForValue = (value?: string): Tone => {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return "neutral";
  if ([
    "completed", "ready_to_promote", "approved", "success",
    "succeeded", "healthy", "ready", "promoted",
  ].includes(normalized)) return "success";
  if ([
    "failed", "canceled", "cancelled", "aborted", "error",
    "changes_requested", "blocked", "unhealthy", "conflicted",
  ].includes(normalized)) return "danger";
  if ([
    "queued", "pending", "waiting_for_slot", "waiting",
    "needs_attention", "degraded", "decomposing", "planning",
  ].includes(normalized)) return "warning";
  if ([
    "executing", "running", "active", "in_progress",
    "processing", "integrating", "promoting", "reviewing", "leased",
  ].includes(normalized)) return "info";
  return "neutral";
};

export const badgeToneClass = (tone: Tone): string => {
  switch (tone) {
    case "success":
      return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100";
    case "warning":
      return "border-amber-300/25 bg-amber-300/10 text-amber-100";
    case "danger":
      return "border-rose-300/20 bg-rose-300/10 text-rose-100";
    case "info":
      return "border-sky-300/20 bg-sky-300/10 text-sky-100";
    default:
      return "border-white/10 bg-white/[0.04] text-zinc-300";
  }
};

export const badge = (label: string, tone: Tone = toneForValue(label)): string =>
  `<span class="${badgeBaseClass} ${badgeToneClass(tone)}">${esc(label)}</span>`;

export const iconBadgeToneClass = (tone: Tone): string => {
  switch (tone) {
    case "success":
      return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100";
    case "warning":
      return "border-amber-300/20 bg-amber-300/10 text-amber-100";
    case "danger":
      return "border-rose-300/20 bg-rose-300/10 text-rose-100";
    case "info":
      return "border-sky-300/20 bg-sky-300/10 text-sky-100";
    default:
      return "border-white/10 bg-white/[0.04] text-zinc-200";
  }
};

// ── Formatter functions ─────────────────────────────────────────────────────

export const formatTs = (ts?: number): string =>
  typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toLocaleString() : "";

export const shortHash = (hash?: string): string =>
  hash ? hash.slice(0, 10) : "";

export const displayLabel = (value?: string): string => {
  const text = value?.trim();
  if (!text) return "";
  return text.replace(/[_-]+/g, " ");
};

export const startCase = (value?: string): string => {
  const text = value?.trim();
  if (!text) return "";
  return text
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
};

// ── Reusable rendering components ───────────────────────────────────────────

export const statPill = (label: string, value: string): string => `<div class="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
  <div class="text-[10px] uppercase tracking-[0.18em] text-zinc-500">${esc(label)}</div>
  <div class="mt-1 break-words text-sm font-medium text-zinc-100 [overflow-wrap:anywhere]">${esc(value)}</div>
</div>`;

export const navPill = (input: {
  readonly href: string;
  readonly label: string;
  readonly active?: boolean;
  readonly dataFactoryNav?: string;
}): string => {
  const classes = input.active
    ? "border-sky-300/30 bg-sky-300/10 text-sky-100"
    : "border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]";
  return `<a class="${navPillClass} ${classes}" href="${esc(input.href)}"${input.dataFactoryNav ? ` data-factory-nav="${esc(input.dataFactoryNav)}"` : ""}>${esc(input.label)}</a>`;
};

export const renderCliActionCard = (input: {
  readonly label: string;
  readonly description: string;
  readonly command: string;
  readonly badgeClass?: string;
  readonly span?: string;
}): string => `<div class="${input.span ?? ""} rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-4">
    <span class="flex items-start justify-between gap-3">
      <span class="min-w-0">
        <span class="block text-sm font-semibold text-zinc-100">${esc(input.label)}</span>
        <span class="mt-2 block text-sm leading-6 text-zinc-400">${esc(input.description)}</span>
      </span>
      <span class="${input.badgeClass ?? ghostButtonClass} shrink-0">CLI</span>
    </span>
    <code class="mt-3 block overflow-x-auto rounded-2xl border border-white/10 bg-black/25 px-3 py-3 text-[12px] leading-5 text-zinc-200 [overflow-wrap:anywhere]">${esc(input.command)}</code>
  </div>`;

export const emptyState = (title: string, body: string): string => `<section class="${panelClass} px-6 py-6 text-center">
  <div class="mx-auto max-w-2xl">
    <div class="text-base font-semibold text-zinc-100">${esc(title)}</div>
    <div class="mt-3 text-sm leading-6 text-zinc-400">${esc(body)}</div>
  </div>
</section>`;

// ── Shared objective action cards ───────────────────────────────────────────

export const renderObjectiveActions = (objectiveId: string, gridClass = "grid gap-3"): string =>
  `<div class="${gridClass}">
    ${renderCliActionCard({
      label: "Advance project",
      description: "Re-evaluate this project and dispatch the next eligible step from the CLI.",
      command: `receipt factory react ${objectiveId} --message "<operator note>"`,
      badgeClass: primaryButtonClass,
    })}
    ${renderCliActionCard({
      label: "Promote to source",
      description: "Merge the ready integration branch into the source branch.",
      command: `receipt factory promote ${objectiveId}`,
    })}
    ${renderCliActionCard({
      label: "Remove worktrees",
      description: "Delete this project's task worktrees and integration workspace from disk.",
      command: `receipt factory cleanup ${objectiveId}`,
    })}
    ${renderCliActionCard({
      label: "Stop project",
      description: "Stop active jobs and mark this project as canceled.",
      command: `receipt factory cancel ${objectiveId} --reason "cancel requested"`,
      badgeClass: dangerButtonClass,
    })}
    ${renderCliActionCard({
      label: "Archive project",
      description: "Hide this project from the main list without deleting its receipts.",
      command: `receipt factory archive ${objectiveId}`,
    })}
  </div>`;

// ── Shared job action cards ─────────────────────────────────────────────────

export const renderJobActionCards = (
  jobId: string,
  opts?: { readonly abortRequested?: boolean },
): string =>
  `<div class="grid gap-3">
    ${renderCliActionCard({
      label: "Steer job",
      description: "Queue updated direction for this active Factory child.",
      command: `receipt factory steer ${jobId} --problem "<updated direction>"`,
    })}
    ${renderCliActionCard({
      label: "Follow up",
      description: "Attach extra context without replacing the active job goal.",
      command: `receipt factory follow-up ${jobId} --note "<extra context>"`,
    })}
    ${opts?.abortRequested
      ? `<div class="rounded-[20px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-50">Abort requested. Waiting for the worker to stop cleanly.</div>`
      : renderCliActionCard({
          label: "Abort job",
          description: "Request a clean stop from the CLI-first operator workflow.",
          command: `receipt factory abort-job ${jobId} --reason "abort requested"`,
          badgeClass: dangerButtonClass,
        })}
  </div>`;
