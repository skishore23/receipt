// ============================================================================
// Shared UI primitives — design system for all Receipt views
// ============================================================================

export { esc, truncate } from "./agent-framework";
import { esc } from "./agent-framework";

export const CSS_VERSION = Date.now();

// ── Layout class constants ──────────────────────────────────────────────────

export const softPanelClass = "border border-border/80 bg-muted/45";
export const sectionLabelClass = "text-[12px] font-medium text-muted-foreground";

// ── Badge class constants ───────────────────────────────────────────────────

export const badgeBaseClass = "inline-flex max-w-full shrink-0 items-center justify-center gap-1.5 border px-2 py-1 text-center text-[11px] font-medium whitespace-nowrap leading-4";

// ── Button class constants ──────────────────────────────────────────────────

export const buttonBaseClass = "inline-flex items-center justify-center border px-3 py-2 text-sm font-medium transition";
export const ghostButtonClass = `${buttonBaseClass} border-border bg-secondary text-secondary-foreground hover:bg-accent`;
export const dangerButtonClass = `${buttonBaseClass} border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/20`;

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
    "changes_requested", "unhealthy", "conflicted",
  ].includes(normalized)) return "danger";
  if ([
    "blocked", "queued", "pending", "waiting_for_slot", "waiting", "idle",
    "needs_attention", "degraded", "planning", "stalled",
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

export const statusDotToneClass = (tone: Tone): string => {
  switch (tone) {
    case "success":
      return "bg-success";
    case "warning":
      return "bg-warning";
    case "danger":
      return "bg-destructive";
    case "info":
      return "bg-info";
    default:
      return "bg-muted-foreground";
  }
};

export const statusDot = (tone: Tone): string =>
  `<span class="inline-flex h-2.5 w-2.5 shrink-0 ${statusDotToneClass(tone)}"></span>`;

// ── Formatter functions ─────────────────────────────────────────────────────

export const formatTs = (ts?: number): string =>
  typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toLocaleString() : "";

export const displayLabel = (value?: string): string => {
  const text = value?.trim();
  if (!text) return "";
  return text.replace(/[_-]+/g, " ");
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

export const iconMemory = (cls = ""): string =>
  svg16(`<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>`, cls);

export const iconSpark = (cls = ""): string =>
  svg16(`<path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"/><path d="M5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14z"/>`, cls);

export const iconCheckCircle = (cls = ""): string =>
  svg16(`<circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/>`, cls);

export const iconClock = (cls = ""): string =>
  svg16(`<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>`, cls);

export const iconTokens = (cls = ""): string =>
  svg16(`<circle cx="12" cy="12" r="9"/><path d="M9 9h6"/><path d="M9 12h6"/><path d="M9 15h4"/>`, cls);

export const iconNext = (cls = ""): string =>
  svg16(`<circle cx="12" cy="12" r="9"/><path d="M10 8l4 4-4 4"/><path d="M8 12h6"/>`, cls);

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

export const iconForRunStepKind = (kind: string, cls = ""): string => {
  const key = kind.trim().toLowerCase();
  if (key === "thought") return iconSpark(cls);
  if (key === "action") return iconQueue(cls);
  if (key === "tool") return iconJob(cls);
  if (key === "memory") return iconMemory(cls);
  if (key === "validation") return iconCheckCircle(cls);
  return iconRun(cls);
};

// ── Reusable rendering components ───────────────────────────────────────────

export const statPill = (
  label: string,
  value: string,
  opts?: {
    readonly icon?: string;
    readonly supporting?: string;
  },
) : string => `<div class="min-w-0 overflow-hidden border border-border bg-muted/45 px-3 py-3">
  <div class="flex items-start gap-2">
    ${opts?.icon ? `<span class="flex h-7 w-7 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground">${opts.icon}</span>` : ""}
    <div class="min-w-0">
      <div class="text-[11px] font-medium text-muted-foreground">${esc(label)}</div>
      ${opts?.supporting ? `<div class="mt-0.5 text-[11px] leading-4 text-muted-foreground/80">${esc(opts.supporting)}</div>` : ""}
    </div>
  </div>
  <div class="mt-2 break-words text-sm font-semibold text-foreground [overflow-wrap:anywhere]">${esc(value)}</div>
</div>`;

export const renderEmptyState = (input: {
  readonly icon: string;
  readonly title: string;
  readonly message: string;
  readonly tone?: Tone;
  readonly eyebrow?: string;
  readonly detail?: string;
  readonly minHeightClass?: string;
}): string => `<section class="flex ${input.minHeightClass ?? "min-h-[240px]"} items-center justify-center border border-border bg-card px-6 py-8">
  <div class="mx-auto flex max-w-lg items-start gap-4 text-left">
    <span class="flex h-11 w-11 shrink-0 items-center justify-center border ${iconBadgeToneClass(input.tone ?? "neutral")}">
      ${input.icon}
    </span>
    <div class="min-w-0">
      ${input.eyebrow ? `<div class="${sectionLabelClass}">${esc(input.eyebrow)}</div>` : ""}
      <div class="mt-1 text-base font-semibold text-foreground">${esc(input.title)}</div>
      <div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(input.message)}</div>
      ${input.detail ? `<div class="mt-3 text-[12px] leading-5 text-muted-foreground/90">${esc(input.detail)}</div>` : ""}
    </div>
  </div>
</section>`;

export type LiveRefreshSpec =
  | {
      readonly kind: "load";
    }
  | {
      readonly kind: "body";
      readonly event: string;
    }
  | {
      readonly kind?: "live" | "sse";
      readonly event: string;
      readonly throttleMs?: number;
    };

const liveRefreshTriggerPart = (spec: LiveRefreshSpec): string => {
  if (spec.kind === "load") return "load";
  if (spec.kind === "body") return `${spec.event} from:body`;
  return `sse:${spec.event}${typeof spec.throttleMs === "number" ? ` throttle:${spec.throttleMs}ms` : ""}`;
};

const liveRefreshDescriptorPart = (spec: LiveRefreshSpec): string => {
  if (spec.kind === "load") return "load";
  if (spec.kind === "body") return `body:${spec.event}`;
  return `live:${spec.event}${typeof spec.throttleMs === "number" ? `@${spec.throttleMs}` : ""}`;
};

export const liveRefreshTrigger = (refreshOn: ReadonlyArray<LiveRefreshSpec>): string =>
  refreshOn.map((spec) => liveRefreshTriggerPart(spec)).join(", ");

export const liveRefreshDescriptor = (refreshOn: ReadonlyArray<LiveRefreshSpec>): string =>
  refreshOn.map((spec) => liveRefreshDescriptorPart(spec)).join(",");

export const liveIslandAttrs = (input: {
  readonly path: string;
  readonly refreshOn: ReadonlyArray<LiveRefreshSpec>;
  readonly swap?: string;
  readonly clientOnly?: boolean;
}): string => {
  const attrs = [
    `data-refresh-path="${esc(input.path)}"`,
    `data-refresh-on="${esc(liveRefreshDescriptor(input.refreshOn))}"`,
  ];
  if (!input.clientOnly) {
    attrs.push(`hx-get="${esc(input.path)}"`);
    attrs.push(`hx-trigger="${esc(liveRefreshTrigger(input.refreshOn))}"`);
    attrs.push(`hx-swap="${esc(input.swap ?? "innerHTML")}"`);
  }
  return attrs.join(" ");
};

export const sseConnectAttrs = (path: string): string =>
  `hx-ext="sse" sse-connect="${esc(path)}"`;


export const renderCliActionCard = (input: {
  readonly label: string;
  readonly description: string;
  readonly command: string;
  readonly badgeClass?: string;
  readonly span?: string;
}): string => `<div class="${input.span ?? ""} border border-border bg-card px-4 py-4">
    <span class="flex items-start justify-between gap-3">
      <span class="min-w-0">
        <span class="block text-sm font-semibold text-foreground">${esc(input.label)}</span>
        <span class="mt-2 block text-sm leading-6 text-muted-foreground">${esc(input.description)}</span>
      </span>
      <span class="${input.badgeClass ?? ghostButtonClass} shrink-0">CLI</span>
    </span>
    <code class="mt-3 block overflow-x-auto border border-border bg-muted px-3 py-3 text-[12px] leading-5 text-foreground [overflow-wrap:anywhere]">${esc(input.command)}</code>
  </div>`;

// ── Shared job action cards ─────────────────────────────────────────────────

export const renderJobActionCards = (
  jobId: string,
  opts?: { readonly abortRequested?: boolean },
): string =>
  `<div class="grid gap-3">
    ${opts?.abortRequested
      ? `<div class="border border-warning/20 bg-warning/10 px-4 py-3 text-sm leading-6 text-warning">Abort requested. Waiting for the worker to stop cleanly.</div>`
      : renderCliActionCard({
          label: "Stop this job",
          description: "Ask the worker to stop cleanly if you want to interrupt the current run.",
          command: `receipt factory abort-job ${jobId} --reason "abort requested"`,
          badgeClass: dangerButtonClass,
        })}
  </div>`;
