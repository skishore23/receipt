// ============================================================================
// Runtime visualization — rendering helpers
// ============================================================================

import { esc } from "../ui";
import {
  iconCodex,
  iconJob,
  iconWorker,
  iconRun,
  iconAgent,
  iconQueue,
  iconNext,
  iconMemory,
} from "../ui";
import type {
  RuntimeActor,
  RuntimeStore,
  RuntimeSideEffect,
  RuntimeDelegationStep,
  RuntimePlane,
} from "./data";

// ── Icon resolver ───────────────────────────────────────────────────────────

const iconFor = (name: string, cls = ""): string => {
  switch (name) {
    case "iconCodex": return iconCodex(cls);
    case "iconJob": return iconJob(cls);
    case "iconWorker": return iconWorker(cls);
    case "iconRun": return iconRun(cls);
    case "iconAgent": return iconAgent(cls);
    case "iconQueue": return iconQueue(cls);
    case "iconNext": return iconNext(cls);
    case "iconMemory": return iconMemory(cls);
    default: return iconRun(cls);
  }
};

// ── Plane color helpers ─────────────────────────────────────────────────────

const planeTone = (plane: RuntimePlane): string => {
  switch (plane) {
    case "control": return "info";
    case "execution": return "success";
    case "side-effects": return "warning";
  }
};

const planeBg = (plane: RuntimePlane): string => {
  switch (plane) {
    case "control": return "bg-info/5 border-info/15";
    case "execution": return "bg-success/5 border-success/15";
    case "side-effects": return "bg-warning/5 border-warning/15";
  }
};

const planeWriteClass = (plane: RuntimePlane): string => {
  switch (plane) {
    case "control": return "text-info font-semibold";
    case "execution": return "text-success font-semibold";
    case "side-effects": return "text-warning font-semibold";
  }
};

// ── Legend ───────────────────────────────────────────────────────────────────

export const renderLegend = (): string => `
<div class="flex flex-wrap items-center gap-6 border border-border bg-card px-4 py-2.5 text-[11px] text-muted-foreground">
  <span class="font-semibold text-foreground tracking-wide">LEGEND</span>
  <span class="flex items-center gap-2">
    <span class="inline-block h-0.5 w-6 bg-info"></span> writes (solid)
  </span>
  <span class="flex items-center gap-2">
    <span class="inline-block h-0.5 w-6 border-t border-dashed border-muted-foreground"></span> reads (dashed)
  </span>
  <span class="flex items-center gap-2">
    <span class="inline-block h-0.5 w-6 border-t border-dotted border-purple-400"></span> emits / fanout (dotted)
  </span>
  <span class="flex items-center gap-2">
    <span class="inline-block h-0.5 w-6 bg-success"></span> handoff (solid)
  </span>
</div>`;

// ── Plane header ────────────────────────────────────────────────────────────

export const renderPlaneHeader = (label: string, plane: RuntimePlane): string => {
  const tone = planeTone(plane);
  return `<div class="mb-3 inline-flex items-center gap-2 border border-${tone}/20 bg-${tone}/10 px-3 py-1 text-[11px] font-bold tracking-widest text-${tone} uppercase">${esc(label)}</div>`;
};

// ── Actor card ──────────────────────────────────────────────────────────────

const rowLabel = (label: string, cls: string): string =>
  `<span class="text-[10px] font-bold tracking-widest ${cls} uppercase">${label}</span>`;

const listItems = (items: string[], cls: string): string =>
  items.map((item) => `<span class="${cls} text-[12px] leading-5">${esc(item)}</span>`).join(", ");

export const renderActorCard = (actor: RuntimeActor): string => {
  const tone = planeTone(actor.plane);
  const writesCls = planeWriteClass(actor.plane);
  const rows: string[] = [];

  // OWNS
  rows.push(`<div class="flex flex-col gap-0.5 border-l-2 border-${tone} pl-2.5 py-1">
    ${rowLabel("OWNS", "text-foreground")}
    <span class="text-[12px] font-semibold text-foreground leading-5">${esc(actor.owns)}</span>
  </div>`);

  // READS
  rows.push(`<div class="flex flex-col gap-0.5 pl-2.5 py-1 border-l-2 border-border">
    ${rowLabel("READS", "text-muted-foreground")}
    <span class="text-muted-foreground text-[12px] leading-5">${actor.reads.map((r) => esc(r)).join(" · ")}</span>
  </div>`);

  // WRITES
  rows.push(`<div class="flex flex-col gap-0.5 pl-2.5 py-1 border-l-2 border-${tone}/50">
    ${rowLabel("WRITES", writesCls)}
    <span class="${writesCls} text-[12px] leading-5">${listItems(actor.writes, writesCls)}</span>
  </div>`);

  // EMITS
  if (actor.emits?.length) {
    rows.push(`<div class="flex flex-col gap-0.5 pl-2.5 py-1 border-l-2 border-dotted border-purple-400/50">
      ${rowLabel("EMITS", "text-purple-400")}
      <span class="text-purple-400 text-[12px] leading-5">${actor.emits.map((e) => esc(e)).join(" · ")}</span>
    </div>`);
  }

  // HANDOFF
  if (actor.handoff) {
    rows.push(`<div class="flex items-center gap-1.5 pl-2.5 py-1 border-l-2 border-success">
      ${rowLabel("HANDOFF", "text-success")}
      ${iconNext("text-success")}
      <span class="text-success text-[12px] font-medium leading-5">${esc(actor.handoff)}</span>
    </div>`);
  }

  return `<div class="border border-border bg-card p-3 space-y-1.5">
  <div class="flex items-center gap-2 mb-1">
    <span class="flex h-7 w-7 shrink-0 items-center justify-center border border-${tone}/25 bg-${tone}/10 text-${tone}">${iconFor(actor.icon)}</span>
    <span class="text-[13px] font-bold text-foreground tracking-wide">${esc(actor.label)}</span>
  </div>
  <div class="text-[10px] font-mono text-muted-foreground/70 leading-4 mb-2 pl-9 break-all">${esc(actor.impl)}</div>
  ${rows.join("\n  ")}
</div>`;
};

// ── Poll loop group ─────────────────────────────────────────────────────────

export const renderPollLoopGroup = (groupActors: readonly RuntimeActor[]): string => {
  const cards = groupActors.map(renderActorCard).join(`
    <div class="flex items-center justify-center py-1">
      <span class="text-info">${iconNext("text-info")}</span>
    </div>`);

  return `<div class="border border-dashed border-info/30 bg-info/3 p-3 space-y-0">
  <div class="mb-3 text-[10px] font-bold tracking-widest text-info/70 uppercase">MultiAgentWorker — Poll Loop</div>
  ${cards}
</div>`;
};

// ── Store card ──────────────────────────────────────────────────────────────

export const renderStoreCard = (store: RuntimeStore): string => `
<div class="border border-border bg-card p-3 min-w-[180px] flex-1">
  <div class="flex items-center gap-2 mb-1.5">
    ${iconMemory("text-muted-foreground")}
    <span class="text-[12px] font-bold text-foreground">${esc(store.name)}</span>
  </div>
  <div class="text-[10px] font-bold tracking-widest text-muted-foreground/70 uppercase mb-1">${esc(store.kind)}</div>
  <div class="text-[11px] text-muted-foreground leading-4">${esc(store.description)}</div>
</div>`;

// ── Side effect card ────────────────────────────────────────────────────────

const sideEffectTone = (kind: string): string => {
  switch (kind) {
    case "realtime": return "warning";
    case "projection": return "info";
    case "background": return "muted-foreground";
    default: return "muted-foreground";
  }
};

export const renderSideEffectCard = (effect: RuntimeSideEffect): string => {
  const tone = sideEffectTone(effect.kind);
  return `<div class="border border-border bg-card p-3">
  <div class="flex items-center gap-2 mb-1">
    <span class="h-2 w-2 bg-${tone} shrink-0"></span>
    <span class="text-[12px] font-bold text-foreground">${esc(effect.label)}</span>
    <span class="text-[10px] text-muted-foreground/70 uppercase tracking-wider">${esc(effect.kind)}</span>
  </div>
  <div class="text-[11px] text-muted-foreground leading-4">${esc(effect.description)}</div>
</div>`;
};

// ── Delegation loop ─────────────────────────────────────────────────────────

export const renderDelegationLoop = (steps: readonly RuntimeDelegationStep[]): string => {
  const rows = steps.map((s) => `
    <div class="flex gap-2.5 items-start">
      <span class="flex h-5 w-5 shrink-0 items-center justify-center border border-success/25 bg-success/10 text-[10px] font-bold text-success">${esc(s.step)}</span>
      <span class="text-[12px] text-muted-foreground leading-5">${esc(s.description)}</span>
    </div>`).join("");

  return `<div class="border border-dashed border-success/30 bg-success/3 p-3 space-y-2">
  <div class="text-[10px] font-bold tracking-widest text-success/70 uppercase mb-2">Child-Run Delegation Loop</div>
  ${rows}
</div>`;
};

// ── Concurrency callout ─────────────────────────────────────────────────────

export const renderConcurrencyCallout = (): string => `
<div class="border border-dashed border-primary/30 bg-primary/5 p-4 space-y-2">
  <div class="flex items-center gap-2">
    <span class="text-[10px] font-bold tracking-widest text-primary uppercase">Multi-Objective Concurrency</span>
  </div>
  <div class="text-[12px] text-muted-foreground leading-5 space-y-1.5">
    <p>Each <span class="text-foreground font-semibold">objective</span> gets its own independent pipeline instance.
       The poll loop (<span class="font-mono text-[11px] text-info">JobWorker</span>) picks up work from any objective —
       <span class="font-mono text-[11px] text-info">factoryReadyTasks()</span> selects across all active objectives.</p>
    <div class="flex flex-wrap gap-2 mt-2">
      <span class="inline-flex items-center gap-1.5 border border-info/20 bg-info/10 px-2 py-0.5 text-[10px] text-info font-mono">Objective A → run₁ · run₂</span>
      <span class="inline-flex items-center gap-1.5 border border-success/20 bg-success/10 px-2 py-0.5 text-[10px] text-success font-mono">Objective B → run₃</span>
      <span class="inline-flex items-center gap-1.5 border border-warning/20 bg-warning/10 px-2 py-0.5 text-[10px] text-warning font-mono">Objective C → run₄ · run₅</span>
    </div>
    <p class="text-[11px] text-muted-foreground/80 mt-1">Runs are leased independently — multiple objectives execute in parallel, bounded by <span class="font-mono text-[11px] text-foreground">concurrency</span> limit on JobWorker. Data stores are shared; leases prevent conflicts.</p>
  </div>
</div>`;

// ── Flow summary ────────────────────────────────────────────────────────────

export const renderFlowSummary = (): string => `
<div class="border-t border-border bg-card px-4 py-3 text-[11px] text-muted-foreground text-center">
  HTTP → Readiness → Lease → Run Driver ↔ Tool Executor → Outbox → SSE · Projections · Background
  <span class="mx-2 text-border">|</span> per objective, N in parallel
</div>`;
