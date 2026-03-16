import { cn } from "../../lib/cn.js";
import { esc, truncate } from "../agent-framework.js";
import type { StreamAction, StreamEntry } from "./types.js";

export { esc, truncate };

// ── Formatting ───────────────────────────────────────────────────────────────

export const statusClass = (value: string): string =>
  value.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();

export const formatTime = (ts: number | undefined): string =>
  ts ? new Date(ts).toLocaleString() : "n/a";

export const formatClock = (ts: number | undefined): string =>
  ts
    ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

export const shortHash = (value: string | undefined): string =>
  value ? value.slice(0, 8) : "none";

export const formatDuration = (ms: number | undefined): string => {
  if (!ms || ms < 1_000) return "<1s";
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

export const factoryQuery = (objectiveId?: string): string =>
  objectiveId ? `?objective=${encodeURIComponent(objectiveId)}` : "";

// ── Style tokens ─────────────────────────────────────────────────────────────

export const modalCard = "bg-card border border-border rounded-lg shadow-panel";
export const kicker = "text-[11px] tracking-[0.14em] uppercase text-muted-foreground font-medium";
export const cardInner = "bg-muted/50 border border-border rounded-md p-3.5";
export const flexBetween = "flex items-start justify-between gap-3";
export const metaRow = "flex flex-wrap gap-2.5 text-muted-foreground text-xs font-mono";
export const titleSm = "text-sm font-semibold leading-tight";
export const gridStack = "grid gap-3";
export const emptyText = "text-muted-foreground text-[13px] italic";
export const mutedSm = "text-muted-foreground text-xs leading-relaxed";
export const labelUpper = "text-[11px] tracking-[0.12em] uppercase text-muted-foreground font-medium";
export const copySoft = "text-muted-foreground leading-normal text-sm whitespace-pre-wrap break-words";
export const btnPrimary = "rounded-md bg-primary text-primary-foreground font-medium py-2 px-3.5";
export const btnGhost = "rounded-md border border-border text-muted-foreground font-medium py-2 px-3.5";
export const btnDanger = "rounded-md border border-destructive/40 bg-destructive/10 text-destructive font-medium py-2 px-3.5";
export const formInput = "w-full rounded-md border border-border bg-background text-foreground text-sm py-2.5 px-3 placeholder:text-muted-foreground/60";
export const statLabel = "text-[11px] tracking-[0.1em] uppercase text-muted-foreground font-medium";
export const statValue = "text-lg font-mono font-semibold text-foreground";

// ── Pill ─────────────────────────────────────────────────────────────────────

const pillBase = "inline-flex items-center gap-1 py-0.5 px-2 rounded-full border text-[10px] uppercase tracking-wider font-medium";

const pillVariant = (kind: string): string => {
  const k = statusClass(kind);
  if (["blocked", "failed", "conflicted"].includes(k)) return "border-destructive/40 bg-destructive/10 text-destructive";
  if (["ready_to_promote", "promoting", "promoted", "active", "completed", "approved", "integrated"].includes(k)) return "border-primary/30 bg-primary/8 text-primary";
  if (["queued", "planning_graph", "preparing_repo", "waiting_for_slot"].includes(k)) return "border-muted-foreground/20 bg-muted text-muted-foreground";
  if (["running", "dispatched"].includes(k)) return "border-ring/30 bg-ring/8 text-ring";
  return "border-border bg-muted/40 text-muted-foreground";
};

export const renderPill = (label: string, kind: string): string =>
  `<span class="${cn(pillBase, pillVariant(kind))}">${esc(label)}</span>`;

// ── Meter (budget progress bar) ──────────────────────────────────────────────

export const renderMeter = (label: string, used: number, max: number): string => {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const barColor = pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-primary";
  return `
    <div class="grid gap-1">
      <div class="flex justify-between">
        <span class="${statLabel}">${esc(label)}</span>
        <span class="text-xs font-mono text-muted-foreground">${used}/${max}</span>
      </div>
      <div class="h-1.5 rounded-full bg-muted overflow-hidden">
        <div class="${barColor} h-full rounded-full transition-all" style="width:${pct}%"></div>
      </div>
    </div>
  `;
};

// ── Action button ────────────────────────────────────────────────────────────

export const renderActionButton = (action: StreamAction): string => {
  const cls = action.variant === "primary" ? btnPrimary
    : action.variant === "danger" ? btnDanger
    : btnGhost;
  return `
    <form action="${esc(action.endpoint)}" method="post"
          hx-post="${esc(action.endpoint)}" hx-swap="none" class="inline">
      <button type="submit" class="${cls} text-xs py-1 px-2">${esc(action.label)}</button>
    </form>
  `;
};

// ── Parsed policy (key-value pairs, not JSON) ────────────────────────────────

export const renderParsedPolicy = (policy: Record<string, unknown>): string => {
  const rows = flattenPolicy(policy);
  return `
    <div class="grid gap-1.5">
      ${rows.map(([key, val]) => `
        <div class="flex gap-3 text-xs">
          <span class="text-muted-foreground font-mono shrink-0">${esc(key)}</span>
          <span class="text-foreground font-mono min-w-0">${esc(String(val))}</span>
        </div>
      `).join("")}
    </div>
  `;
};

const flattenPolicy = (obj: Record<string, unknown>, prefix = ""): ReadonlyArray<[string, unknown]> => {
  const entries: Array<[string, unknown]> = [];
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      entries.push(...flattenPolicy(val as Record<string, unknown>, path));
    } else {
      entries.push([path, val]);
    }
  }
  return entries;
};

// ── Worktree table ───────────────────────────────────────────────────────────

export const renderWorktreeTable = (
  worktrees: ReadonlyArray<{
    readonly taskId: string;
    readonly exists: boolean;
    readonly dirty: boolean;
    readonly head?: string;
    readonly branch?: string;
  }>,
): string => {
  if (!worktrees.length) return `<div class="${emptyText}">No task worktrees.</div>`;
  return `
    <table class="w-full text-xs">
      <thead>
        <tr class="text-muted-foreground text-left border-b border-border">
          <th class="py-1 pr-2 font-medium">Task</th>
          <th class="py-1 pr-2 font-medium">Branch</th>
          <th class="py-1 pr-2 font-medium">State</th>
          <th class="py-1 font-medium">Head</th>
        </tr>
      </thead>
      <tbody>
        ${worktrees.map((w) => `
          <tr class="border-b border-border/40">
            <td class="py-1.5 pr-2 font-mono">${esc(w.taskId)}</td>
            <td class="py-1.5 pr-2 font-mono text-muted-foreground">${esc(w.branch ?? "—")}</td>
            <td class="py-1.5 pr-2">
              ${w.exists
                ? (w.dirty
                  ? renderPill("dirty", "blocked")
                  : renderPill("clean", "active"))
                : renderPill("missing", "queued")}
            </td>
            <td class="py-1.5 font-mono text-muted-foreground">${esc(shortHash(w.head))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
};

// ── Stream entry ─────────────────────────────────────────────────────────────

const kindLabel: Record<string, string> = {
  objective_created: "created",
  plan_adopted: "plan",
  task_dispatched: "dispatch",
  task_completed: "complete",
  task_failed: "failed",
  decision: "decision",
  blocked: "blocked",
  merge: "merge",
  promotion: "promote",
  receipt: "receipt",
  job: "job",
  live: "live",
};

type SeverityStyle = { readonly border: string; readonly text: string };

const severityStyle: Record<string, SeverityStyle> = {
  error:   { border: "border-l-destructive",              text: "text-destructive" },
  success: { border: "border-l-[oklch(0.65_0.15_145)]",   text: "text-[oklch(0.65_0.15_145)]" },
  info:    { border: "border-l-[oklch(0.7_0.12_230)]",    text: "text-[oklch(0.7_0.12_230)]" },
  accent:  { border: "border-l-ring",                     text: "text-ring" },
  neutral: { border: "border-l-border",                   text: "text-muted-foreground" },
};

const kindSeverity: Record<string, string> = {
  blocked: "error", task_failed: "error",
  task_completed: "success", promotion: "success", merge: "success",
  plan_adopted: "info", decision: "info",
  task_dispatched: "neutral", job: "neutral", receipt: "neutral", objective_created: "neutral",
  live: "accent",
};

export const renderStreamEntry = (entry: StreamEntry): string => {
  const sev = severityStyle[kindSeverity[entry.kind] ?? "neutral"] ?? severityStyle.neutral;
  const label = kindLabel[entry.kind] ?? entry.kind;
  return `
  <article class="${cn("grid grid-cols-[72px_1fr] gap-x-2.5 py-2.5 border-l-2 ml-2 animate-[fade-in_180ms_ease]", sev.border)}" id="${entry.receiptHash ? `receipt-${esc(entry.receiptHash)}` : ""}">
    <div class="flex flex-col items-end gap-0.5 pr-2.5">
      <span class="${cn("text-[10px] font-semibold tracking-[0.06em] uppercase leading-none", sev.text)}">${esc(label)}</span>
      <span class="text-[10px] text-muted-foreground font-mono">${esc(formatClock(entry.at))}</span>
    </div>
    <div class="grid gap-0.5 min-w-0">
      <div class="text-[13px] font-medium leading-tight truncate">${esc(truncate(entry.title, 120))}</div>
      ${entry.taskId ? `<span class="text-[11px] font-mono text-muted-foreground">${esc(entry.taskId)}</span>` : ""}
      <div class="text-xs text-muted-foreground leading-snug line-clamp-2">${esc(truncate(entry.summary, 200))}</div>
      ${entry.actions.length ? `<div class="flex gap-1.5 mt-1">${entry.actions.map(renderActionButton).join("")}</div>` : ""}
    </div>
  </article>`;
};
