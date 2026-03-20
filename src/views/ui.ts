// ============================================================================
// Shared UI primitives — design system for all Receipt views
// ============================================================================

export { esc, truncate } from "./agent-framework.js";
import { esc } from "./agent-framework.js";

export const CSS_VERSION = Date.now();

// ── Layout class constants ──────────────────────────────────────────────────

export const panelClass = "rounded-xl border border-border bg-card shadow-lg backdrop-blur-2xl";
export const softPanelClass = "rounded-lg border border-border bg-muted backdrop-blur-xl";
export const railCardClass = `${softPanelClass} p-4`;
export const sectionLabelClass = "text-[11px] font-medium uppercase tracking-[0.28em] text-muted-foreground";

// ── Badge class constants ───────────────────────────────────────────────────

export const badgeBaseClass = "inline-flex max-w-full items-center justify-center gap-2 rounded-full border px-3 py-1 text-center text-[11px] font-medium uppercase tracking-[0.18em] whitespace-normal leading-4 break-words [overflow-wrap:anywhere]";

// ── Button class constants ──────────────────────────────────────────────────

export const buttonBaseClass = "inline-flex items-center justify-center rounded-full border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition";
export const primaryButtonClass = `${buttonBaseClass} border-success/40 bg-success text-success-foreground hover:bg-success/90`;
export const ghostButtonClass = `${buttonBaseClass} border-border bg-secondary text-secondary-foreground hover:bg-accent`;
export const dangerButtonClass = `${buttonBaseClass} border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/20`;

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
    "queued", "pending", "waiting_for_slot", "waiting", "idle",
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
      return "border-success/20 bg-success/10 text-success";
    case "warning":
      return "border-warning/20 bg-warning/10 text-warning";
    case "danger":
      return "border-destructive/20 bg-destructive/10 text-destructive";
    case "info":
      return "border-info/20 bg-info/10 text-info";
    default:
      return "border-border bg-secondary text-muted-foreground";
  }
};

export const badge = (label: string, tone: Tone = toneForValue(label)): string =>
  `<span class="${badgeBaseClass} ${badgeToneClass(tone)}">${esc(label)}</span>`;

export const iconBadgeToneClass = (tone: Tone): string => {
  switch (tone) {
    case "success":
      return "border-success/20 bg-success/10 text-success";
    case "warning":
      return "border-warning/20 bg-warning/10 text-warning";
    case "danger":
      return "border-destructive/20 bg-destructive/10 text-destructive";
    case "info":
      return "border-info/20 bg-info/10 text-info";
    default:
      return "border-border bg-secondary text-muted-foreground";
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

// ── Inline SVG icons (16×16, stroke-based, Lucide-style) ────────────────────

const svg16 = (path: string, cls = ""): string =>
  `<svg class="inline-block shrink-0${cls ? ` ${cls}` : ""}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

export const iconCodex = (cls = ""): string =>
  svg16(`<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>`, cls);

export const iconQueue = (cls = ""): string =>
  svg16(`<rect x="3" y="3" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="17" width="18" height="4" rx="1"/>`, cls);

export const iconAgent = (cls = ""): string =>
  svg16(`<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="3"/><path d="M7 21v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/>`, cls);

export const iconRun = (cls = ""): string =>
  svg16(`<polygon points="6 3 20 12 6 21 6 3"/>`, cls);

export const iconTask = (cls = ""): string =>
  svg16(`<path d="M12 2 L20 7 L20 17 L12 22 L4 17 L4 7 Z"/><polyline points="9 12 11 14 15 10"/>`, cls);

export const iconJob = (cls = ""): string =>
  svg16(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`, cls);

export const iconProject = (cls = ""): string =>
  svg16(`<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>`, cls);

export const iconReceipt = (cls = ""): string =>
  svg16(`<path d="M4 2v20l4-2 4 2 4-2 4 2V2l-4 2-4-2-4 2Z"/><line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="12" y2="14"/>`, cls);

export const iconFactory = (cls = ""): string =>
  svg16(`<path d="M2 20V8l5 4V8l5 4V4h8a2 2 0 0 1 2 2v14"/><path d="M2 20h20"/>`, cls);

export const iconChat = (cls = ""): string =>
  svg16(`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`, cls);

export const iconInspect = (cls = ""): string =>
  svg16(`<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`, cls);

export const iconArrowLeft = (cls = ""): string =>
  svg16(`<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>`, cls);

export const iconArrowRight = (cls = ""): string =>
  svg16(`<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>`, cls);

export const iconCheckCircle = (cls = ""): string =>
  svg16(`<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`, cls);

export const iconAlertCircle = (cls = ""): string =>
  svg16(`<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>`, cls);

export const iconClock = (cls = ""): string =>
  svg16(`<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`, cls);

export const iconWorker = (cls = ""): string =>
  svg16(`<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="14"/><line x1="10" y1="10" x2="10" y2="14"/><line x1="14" y1="10" x2="14" y2="14"/><line x1="18" y1="10" x2="18" y2="14"/>`, cls);

export const iconForEntity = (entity: string, cls = ""): string => {
  const key = entity.trim().toLowerCase();
  if (key === "codex") return iconCodex(cls);
  if (key === "project" || key === "objective") return iconProject(cls);
  if (key === "run" || key === "supervisor") return iconRun(cls);
  if (key === "job") return iconJob(cls);
  if (key === "task") return iconTask(cls);
  if (key === "queue") return iconQueue(cls);
  if (key === "agent" || key === "profile") return iconAgent(cls);
  if (key === "receipt") return iconReceipt(cls);
  if (key === "factory") return iconFactory(cls);
  if (key === "chat") return iconChat(cls);
  if (key === "worker") return iconWorker(cls);
  return "";
};

// ── Reusable rendering components ───────────────────────────────────────────

export const statPill = (label: string, value: string): string => `<div class="min-w-0 overflow-hidden rounded-2xl border border-border bg-muted px-3 py-2">
  <div class="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">${esc(label)}</div>
  <div class="mt-1 break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">${esc(value)}</div>
</div>`;

export const navPill = (input: {
  readonly href: string;
  readonly label: string;
  readonly active?: boolean;
  readonly dataFactoryNav?: string;
}): string => {
  const classes = input.active
    ? "border-info/30 bg-info/10 text-info"
    : "border-border bg-secondary text-muted-foreground hover:bg-accent";
  return `<a class="${navPillClass} ${classes}" href="${esc(input.href)}"${input.dataFactoryNav ? ` data-factory-nav="${esc(input.dataFactoryNav)}"` : ""}>${esc(input.label)}</a>`;
};

export const renderCliActionCard = (input: {
  readonly label: string;
  readonly description: string;
  readonly command: string;
  readonly badgeClass?: string;
  readonly span?: string;
}): string => `<div class="${input.span ?? ""} rounded-xl border border-border bg-card px-4 py-4">
    <span class="flex items-start justify-between gap-3">
      <span class="min-w-0">
        <span class="block text-sm font-semibold text-foreground">${esc(input.label)}</span>
        <span class="mt-2 block text-sm leading-6 text-muted-foreground">${esc(input.description)}</span>
      </span>
      <span class="${input.badgeClass ?? ghostButtonClass} shrink-0">CLI</span>
    </span>
    <code class="mt-3 block overflow-x-auto rounded-lg border border-border bg-muted px-3 py-3 text-[12px] leading-5 text-foreground [overflow-wrap:anywhere]">${esc(input.command)}</code>
  </div>`;

export const emptyState = (title: string, body: string): string => `<section class="${panelClass} px-6 py-6 text-center">
  <div class="mx-auto max-w-2xl">
    <div class="text-base font-semibold text-foreground">${esc(title)}</div>
    <div class="mt-3 text-sm leading-6 text-muted-foreground">${esc(body)}</div>
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
      ? `<div class="rounded-xl border border-warning/20 bg-warning/10 px-4 py-3 text-sm leading-6 text-warning">Abort requested. Waiting for the worker to stop cleanly.</div>`
      : renderCliActionCard({
          label: "Abort job",
          description: "Request a clean stop from the CLI-first operator workflow.",
          command: `receipt factory abort-job ${jobId} --reason "abort requested"`,
          badgeClass: dangerButtonClass,
        })}
  </div>`;
