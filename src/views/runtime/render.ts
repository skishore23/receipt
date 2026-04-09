import {
  esc,
  formatTs,
  iconAgent,
  iconCodex,
  iconJob,
  iconMemory,
  iconNext,
  iconQueue,
  iconRun,
  iconWorker,
  liveIslandAttrs,
} from "../ui";
import type { RuntimeDashboardModel, RuntimeStoreMetric } from "./data";

const runtimeRefreshOn = [
  { kind: "load" },
  { event: "receipt-refresh", throttleMs: 500 },
] as const;

type RuntimePlane = "control" | "execution" | "side-effects";

type RuntimeActorView = {
  readonly id: string;
  readonly label: string;
  readonly plane: RuntimePlane;
  readonly group?: string;
  readonly icon: "iconCodex" | "iconJob" | "iconWorker" | "iconRun" | "iconAgent" | "iconQueue";
  readonly impl: string;
  readonly owns: string;
  readonly reads: ReadonlyArray<string>;
  readonly writes: ReadonlyArray<string>;
  readonly emits?: ReadonlyArray<string>;
  readonly handoff?: string;
  readonly liveSummary: string;
  readonly liveMeta?: ReadonlyArray<string>;
};

type RuntimeSideEffectView = {
  readonly label: string;
  readonly kind: "realtime" | "projection" | "background";
  readonly description: string;
  readonly metric: string;
  readonly supporting?: string;
};

type RuntimeDelegationStepView = {
  readonly step: string;
  readonly description: string;
  readonly metric: string;
};

const iconFor = (name: RuntimeActorView["icon"], cls = ""): string => {
  switch (name) {
    case "iconCodex": return iconCodex(cls);
    case "iconJob": return iconJob(cls);
    case "iconWorker": return iconWorker(cls);
    case "iconRun": return iconRun(cls);
    case "iconAgent": return iconAgent(cls);
    case "iconQueue": return iconQueue(cls);
  }
};

const planeTone = (plane: RuntimePlane): string => {
  switch (plane) {
    case "control": return "info";
    case "execution": return "success";
    case "side-effects": return "warning";
  }
};

const planeBg = (plane: RuntimePlane): string => {
  switch (plane) {
    case "control": return "border-info/15 bg-info/5";
    case "execution": return "border-success/15 bg-success/5";
    case "side-effects": return "border-warning/15 bg-warning/5";
  }
};

const planeWriteClass = (plane: RuntimePlane): string => {
  switch (plane) {
    case "control": return "text-info font-semibold";
    case "execution": return "text-success font-semibold";
    case "side-effects": return "text-warning font-semibold";
  }
};

const rowLabel = (label: string, cls: string): string =>
  `<span class="text-[10px] font-bold tracking-widest ${cls} uppercase">${label}</span>`;

const listItems = (items: ReadonlyArray<string>, cls: string): string =>
  items.map((item) => `<span class="${cls} text-[12px] leading-5">${esc(item)}</span>`).join(", ");

const valueTone = (value?: string): "success" | "warning" | "destructive" | "info" | "muted" => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "muted";
  if (normalized === "running" || normalized === "active" || normalized === "completed" || normalized === "success") return "success";
  if (normalized === "blocked" || normalized === "waiting" || normalized === "queued" || normalized === "leased") return "warning";
  if (normalized === "failed" || normalized === "error" || normalized === "canceled") return "destructive";
  return "info";
};

const badgeClass = (value?: string): string => {
  switch (valueTone(value)) {
    case "success": return "border-success/20 bg-success/10 text-success";
    case "warning": return "border-warning/20 bg-warning/10 text-warning";
    case "destructive": return "border-destructive/20 bg-destructive/10 text-destructive";
    case "info": return "border-info/20 bg-info/10 text-info";
    case "muted": return "border-border bg-secondary text-muted-foreground";
  }
};

const metaList = (items: ReadonlyArray<string | undefined>): string => items
  .filter((item): item is string => Boolean(item))
  .map((item) => `<span>${esc(item)}</span>`)
  .join(`<span class="text-border">|</span>`);

const renderSnapshotLabel = (label: string): string =>
  `<div class="text-[10px] font-bold tracking-widest text-muted-foreground/80 uppercase">${esc(label)}</div>`;

const renderLegend = (): string => `
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

const renderPlaneHeader = (label: string, plane: RuntimePlane): string => {
  const tone = planeTone(plane);
  return `<div class="mb-3 inline-flex items-center gap-2 border border-${tone}/20 bg-${tone}/10 px-3 py-1 text-[11px] font-bold tracking-widest text-${tone} uppercase">${esc(label)}</div>`;
};

const renderActorCard = (actor: RuntimeActorView): string => {
  const tone = planeTone(actor.plane);
  const writesCls = planeWriteClass(actor.plane);
  const rows: string[] = [];

  rows.push(`<div class="flex flex-col gap-0.5 border-l-2 border-${tone} pl-2.5 py-1">
    ${rowLabel("OWNS", "text-foreground")}
    <span class="text-[12px] font-semibold text-foreground leading-5">${esc(actor.owns)}</span>
  </div>`);

  rows.push(`<div class="flex flex-col gap-0.5 pl-2.5 py-1 border-l-2 border-border">
    ${rowLabel("READS", "text-muted-foreground")}
    <span class="text-muted-foreground text-[12px] leading-5">${actor.reads.map((r) => esc(r)).join(" · ")}</span>
  </div>`);

  rows.push(`<div class="flex flex-col gap-0.5 pl-2.5 py-1 border-l-2 border-primary/40">
    ${rowLabel("LIVE", "text-primary")}
    <span class="text-primary text-[12px] leading-5">${esc(actor.liveSummary)}</span>
    ${actor.liveMeta?.length ? `<span class="text-[11px] leading-5 text-muted-foreground">${actor.liveMeta.map((item) => esc(item)).join(" · ")}</span>` : ""}
  </div>`);

  rows.push(`<div class="flex flex-col gap-0.5 pl-2.5 py-1 border-l-2 border-${tone}/50">
    ${rowLabel("WRITES", writesCls)}
    <span class="${writesCls} text-[12px] leading-5">${listItems(actor.writes, writesCls)}</span>
  </div>`);

  if (actor.emits?.length) {
    rows.push(`<div class="flex flex-col gap-0.5 pl-2.5 py-1 border-l-2 border-dotted border-purple-400/50">
      ${rowLabel("EMITS", "text-purple-400")}
      <span class="text-purple-400 text-[12px] leading-5">${actor.emits.map((e) => esc(e)).join(" · ")}</span>
    </div>`);
  }

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

const renderPollLoopGroup = (groupActors: ReadonlyArray<RuntimeActorView>): string => {
  const cards = groupActors.map(renderActorCard).join(`
    <div class="flex items-center justify-center py-1">
      <span class="text-info">${iconNext("text-info")}</span>
    </div>`);
  return `<div class="border border-dashed border-info/30 bg-info/3 p-3 space-y-0">
  <div class="mb-3 text-[10px] font-bold tracking-widest text-info/70 uppercase">MultiAgentWorker — Poll Loop</div>
  ${cards}
</div>`;
};

const renderStoreCard = (store: RuntimeStoreMetric): string => `
<div class="border border-border bg-card p-3 min-w-[180px] flex-1">
  <div class="flex items-center gap-2 mb-1.5">
    ${iconMemory("text-muted-foreground")}
    <span class="text-[12px] font-bold text-foreground">${esc(store.name)}</span>
  </div>
  <div class="text-[10px] font-bold tracking-widest text-muted-foreground/70 uppercase mb-1">${esc(store.kind)}</div>
  <div class="text-[16px] font-semibold text-foreground">${store.count.toLocaleString()}</div>
  <div class="mt-1 text-[11px] text-muted-foreground leading-4">${esc(store.description)}</div>
  ${store.updatedAt ? `<div class="mt-2 text-[10px] text-muted-foreground/80">Updated ${esc(formatTs(store.updatedAt))}</div>` : ""}
</div>`;

const sideEffectTone = (kind: RuntimeSideEffectView["kind"]): string => {
  switch (kind) {
    case "realtime": return "warning";
    case "projection": return "info";
    case "background": return "muted-foreground";
  }
};

const renderSideEffectCard = (effect: RuntimeSideEffectView): string => {
  const tone = sideEffectTone(effect.kind);
  return `<div class="border border-border bg-card p-3">
  <div class="flex items-center gap-2 mb-1">
    <span class="h-2 w-2 bg-${tone} shrink-0"></span>
    <span class="text-[12px] font-bold text-foreground">${esc(effect.label)}</span>
    <span class="text-[10px] text-muted-foreground/70 uppercase tracking-wider">${esc(effect.kind)}</span>
  </div>
  <div class="text-[15px] font-semibold text-foreground">${esc(effect.metric)}</div>
  <div class="mt-1 text-[11px] text-muted-foreground leading-4">${esc(effect.description)}</div>
  ${effect.supporting ? `<div class="mt-2 text-[10px] text-muted-foreground/80">${esc(effect.supporting)}</div>` : ""}
</div>`;
};

const renderDelegationLoop = (steps: ReadonlyArray<RuntimeDelegationStepView>): string => {
  const rows = steps.map((step) => `
    <div class="flex gap-2.5 items-start">
      <span class="flex h-5 w-5 shrink-0 items-center justify-center border border-success/25 bg-success/10 text-[10px] font-bold text-success">${esc(step.step)}</span>
      <span class="min-w-0">
        <span class="block text-[12px] text-muted-foreground leading-5">${esc(step.description)}</span>
        <span class="block text-[11px] text-success mt-1">${esc(step.metric)}</span>
      </span>
    </div>`).join("");
  return `<div class="border border-dashed border-success/30 bg-success/3 p-3 space-y-2">
  <div class="text-[10px] font-bold tracking-widest text-success/70 uppercase mb-2">Child-Run Delegation Loop</div>
  ${rows}
</div>`;
};

const renderObjectiveSnapshots = (objectives: RuntimeDashboardModel["objectives"]): string => {
  const cards = objectives.slice(0, 3).map((objective) => `
    <div class="border border-border bg-card p-3 space-y-2">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="text-[12px] font-bold text-foreground">${esc(objective.title)}</div>
          <div class="text-[10px] font-mono text-muted-foreground break-all">${esc(objective.objectiveId)}</div>
        </div>
        <span class="shrink-0 border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeClass(objective.status)}">${esc(objective.status)}</span>
      </div>
      <div class="text-[11px] text-muted-foreground leading-5">${esc(
        objective.summary ?? `${objective.activeTaskCount} active tasks and ${objective.readyTaskCount} ready tasks.`,
      )}</div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/80">
        ${metaList([
          `phase ${objective.phase}`,
          `scheduler ${objective.scheduler}`,
          `${objective.activeTaskCount}/${objective.taskCount} active`,
          `${objective.readyTaskCount} ready`,
          objective.profileId ? `profile ${objective.profileId}` : undefined,
          objective.updatedAt ? `updated ${formatTs(objective.updatedAt)}` : undefined,
        ])}
      </div>
    </div>`).join("");

  return `<div class="space-y-2">
    ${renderSnapshotLabel("Live Objective Snapshot")}
    ${cards || `<div class="border border-dashed border-border bg-card px-3 py-4 text-[11px] text-muted-foreground">No projected objectives available.</div>`}
  </div>`;
};

const renderJobSnapshots = (jobs: RuntimeDashboardModel["jobs"]): string => {
  const cards = jobs.slice(0, 3).map((job) => `
    <div class="border border-border bg-card p-3 space-y-2">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="text-[12px] font-bold text-foreground">${esc(job.jobId)}</div>
          <div class="text-[10px] font-mono text-muted-foreground break-all">${esc(job.objectiveId ?? job.lane)}</div>
        </div>
        <span class="shrink-0 border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeClass(job.status)}">${esc(job.status)}</span>
      </div>
      <div class="text-[11px] text-muted-foreground leading-5">${esc(job.summary)}</div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/80">
        ${metaList([
          job.kind ? `kind ${job.kind}` : undefined,
          `attempt ${job.attempt}/${job.maxAttempts}`,
          job.runId ? `run ${job.runId}` : undefined,
          job.updatedAt ? `updated ${formatTs(job.updatedAt)}` : undefined,
          job.leaseUntil ? `lease ${formatTs(job.leaseUntil)}` : undefined,
        ])}
      </div>
    </div>`).join("");

  return `<div class="space-y-2">
    ${renderSnapshotLabel("Recent Jobs")}
    ${cards || `<div class="border border-dashed border-border bg-card px-3 py-4 text-[11px] text-muted-foreground">No recent jobs visible in the current window.</div>`}
  </div>`;
};

const renderRunSnapshots = (runs: RuntimeDashboardModel["runs"]): string => {
  const cards = runs.slice(0, 3).map((run) => {
    const primary = run.problem ?? run.summary;
    const secondary = run.problem && run.summary !== run.problem ? run.summary : undefined;
    return `
    <div class="border border-border bg-card p-3 space-y-2">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="text-[12px] font-bold text-foreground">${esc(run.runId)}</div>
          <div class="text-[10px] font-mono text-muted-foreground break-all">${esc(run.objectiveId ?? run.stream)}</div>
        </div>
        <span class="shrink-0 border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeClass(run.status)}">${esc(run.status)}</span>
      </div>
      <div class="text-[11px] text-foreground leading-5">${esc(primary)}</div>
      ${secondary ? `<div class="text-[11px] text-muted-foreground leading-5">${esc(secondary)}</div>` : ""}
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/80">
        ${metaList([
          `iteration ${run.iteration}`,
          `${run.toolCount} tools`,
          run.lastTool ? `last ${run.lastTool}` : undefined,
          run.worker ? `worker ${run.worker}` : undefined,
          run.updatedAt ? `updated ${formatTs(run.updatedAt)}` : undefined,
        ])}
      </div>
    </div>`;
  }).join("");

  return `<div class="space-y-2">
    ${renderSnapshotLabel("Observed Runs")}
    ${cards || `<div class="border border-dashed border-border bg-card px-3 py-4 text-[11px] text-muted-foreground">No linked run receipts were found in the current job window.</div>`}
  </div>`;
};

const renderActivitySnapshots = (activity: RuntimeDashboardModel["activity"]): string => {
  const items = activity.slice(0, 5).map((item) => `
    <div class="border border-border bg-card px-3 py-2.5">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badgeClass(item.kind)}">${esc(item.kind)}</span>
            <span class="text-[12px] font-semibold text-foreground">${esc(item.title)}</span>
          </div>
          <div class="mt-1 text-[11px] text-muted-foreground leading-5">${esc(item.summary)}</div>
        </div>
        ${item.at ? `<span class="shrink-0 text-[10px] text-muted-foreground/80">${esc(formatTs(item.at))}</span>` : ""}
      </div>
    </div>`).join("");

  return `<div class="space-y-2">
    ${renderSnapshotLabel("Recent Activity")}
    ${items || `<div class="border border-dashed border-border bg-card px-3 py-4 text-[11px] text-muted-foreground">No recent activity was recorded.</div>`}
  </div>`;
};

const renderConcurrencyCallout = (model: RuntimeDashboardModel): string => {
  const exampleTitles = model.metrics.activeObjectiveTitles;
  const examplePills = exampleTitles.length > 0
    ? exampleTitles.map((title, index) => {
        const tones = ["info", "success", "warning"] as const;
        const tone = tones[index % tones.length];
        return `<span class="inline-flex items-center gap-1.5 border border-${tone}/20 bg-${tone}/10 px-2 py-0.5 text-[10px] text-${tone} font-mono">${esc(title)}</span>`;
      }).join("")
    : `<span class="inline-flex items-center gap-1.5 border border-border bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground font-mono">No active objectives right now</span>`;
  return `<div class="border border-dashed border-primary/30 bg-primary/5 p-4 space-y-2">
  <div class="flex items-center gap-2">
    <span class="text-[10px] font-bold tracking-widest text-primary uppercase">Multi-Objective Concurrency</span>
  </div>
  <div class="text-[12px] text-muted-foreground leading-5 space-y-1.5">
    <p>${model.activeObjectiveCount} objectives are currently active, with ${model.queue.leased + model.queue.running} leased or running jobs and ${model.liveRunCount} visible running run streams.</p>
    <div class="flex flex-wrap gap-2 mt-2">
      ${examplePills}
    </div>
    <p class="text-[11px] text-muted-foreground/80 mt-1">Queue snapshot: ${model.queue.total.toLocaleString()} total jobs, ${model.queue.queued} queued, ${model.queue.failed} failed. Recent receipt activity: ${model.metrics.recentReceiptCount} changes in the last ${model.metrics.receiptWindowMinutes} minutes.</p>
  </div>
</div>`;
};

const renderFlowSummary = (model: RuntimeDashboardModel): string => `
<div class="border-t border-border bg-card px-4 py-3 text-[11px] text-muted-foreground text-center">
  HTTP → Readiness → Lease → Run Driver ↔ Tool Executor → Projection / SSE
  <span class="mx-2 text-border">|</span> objectives ${model.objectiveCount.toLocaleString()}
  <span class="mx-2 text-border">|</span> jobs ${model.queue.total.toLocaleString()}
  <span class="mx-2 text-border">|</span> receipts ${model.metrics.receiptCount.toLocaleString()}
</div>`;

const runtimeActors = (model: RuntimeDashboardModel): ReadonlyArray<RuntimeActorView> => {
  const readyTasks = model.objectives.reduce((count, objective) => count + objective.readyTaskCount, 0);
  const activeTasks = model.objectives.reduce((count, objective) => count + objective.activeTaskCount, 0);
  const latestLease = model.metrics.latestLeaseUntil ? formatTs(model.metrics.latestLeaseUntil) : "no active leases";
  const recentTools = model.metrics.recentToolNames.length > 0 ? model.metrics.recentToolNames.join(", ") : "no recent tools observed";
  const activeObjectiveList = model.metrics.activeObjectiveTitles.length > 0 ? model.metrics.activeObjectiveTitles.join(" | ") : "no active objectives";
  return [
    {
      id: "http-commands",
      label: "HTTP Commands",
      plane: "control",
      icon: "iconCodex",
      impl: "handlers.ts → register() Hono routes",
      owns: "Translate external requests into orchestration state",
      reads: ["request payload", "auth / tenant scope", "session / thread context"],
      writes: ["job_projection", "objective_projection", "receipts"],
      handoff: "Readiness Engine (via poll)",
      liveSummary: `${model.jobs.length} recent jobs visible across ${model.objectiveCount} projected objectives.`,
      liveMeta: [
        `${model.queue.queued} queued`,
        `${model.metrics.recentReceiptCount} receipt changes / ${model.metrics.receiptWindowMinutes}m`,
      ],
    },
    {
      id: "readiness-engine",
      label: "Readiness Engine",
      plane: "control",
      group: "poll-loop",
      icon: "iconJob",
      impl: "objective_projection + queue snapshot",
      owns: "Select next actionable readiness decision",
      reads: ["objective_projection", "job_projection", "change_log"],
      writes: ["queue ordering", "admission decisions"],
      handoff: "Lease Controller",
      liveSummary: `${readyTasks} ready tasks and ${activeTasks} active tasks across ${model.activeObjectiveCount} active objectives.`,
      liveMeta: [
        `${model.queue.queued} queued jobs`,
        activeObjectiveList,
      ],
    },
    {
      id: "lease-controller",
      label: "Lease Controller",
      plane: "control",
      group: "poll-loop",
      icon: "iconWorker",
      impl: "SQLite queue adapter → leaseNext() · heartbeat()",
      owns: "Acquire, renew, release exclusive run ownership",
      reads: ["job_projection", "queue snapshot", "lease timestamps"],
      writes: ["job leases", "running job state", "lease heartbeats"],
      handoff: "Run Driver",
      liveSummary: `${model.queue.leased} leased and ${model.queue.running} running jobs in the current snapshot.`,
      liveMeta: [
        `latest lease ${latestLease}`,
        `${model.queue.failed} failed jobs retained`,
      ],
    },
    {
      id: "run-driver",
      label: "Run Driver",
      plane: "execution",
      icon: "iconRun",
      impl: "agent runtime receipts → run projection",
      owns: "One leased execution turn",
      reads: ["run receipts", "chat context", "memory"],
      writes: ["receipts", "run state", "session projections"],
      emits: ["tool calls", "status notes", "final responses"],
      handoff: "Tool Executor · or complete · or wait",
      liveSummary: `${model.runs.length} run streams linked to the current job window, ${model.liveRunCount} still running.`,
      liveMeta: [
        `${model.metrics.visibleToolCallCount} visible tool calls`,
        `${model.metrics.mergedChildRunCount} merged child runs`,
      ],
    },
    {
      id: "tool-executor",
      label: "Tool Executor",
      plane: "execution",
      icon: "iconAgent",
      impl: "capability registry + observed tool receipts",
      owns: "Validate, dispatch, and resolve tool calls",
      reads: ["tool registry", "run receipts", "job payloads"],
      writes: ["tool receipts", "child-job payloads", "delegation links"],
      emits: ["tool.called", "tool.observed"],
      handoff: "Outcomes back to Run Driver",
      liveSummary: `${recentTools}.`,
      liveMeta: [
        `${model.metrics.delegatedJobCount} delegated child jobs`,
        `${model.metrics.activeChildJobCount} active child jobs`,
      ],
    },
    {
      id: "outbox-worker",
      label: "Outbox Worker",
      plane: "side-effects",
      icon: "iconQueue",
      impl: "SSE hub + receipt change feed + projections",
      owns: "Drain queued side effects by topic",
      reads: ["change_log", "job_projection", "objective_projection", "chat_context_projection"],
      writes: ["SSE refresh events", "projection tables"],
      emits: ["receipt-refresh", "factory-refresh", "objective-runtime-refresh"],
      liveSummary: `${model.metrics.recentReceiptCount} recent receipt changes driving live refresh.`,
      liveMeta: [
        `${model.metrics.objectiveProjectionCount} objectives / ${model.metrics.jobProjectionCount} jobs / ${model.metrics.chatProjectionCount} chats`,
        model.latestUpdateAt ? `latest update ${formatTs(model.latestUpdateAt)}` : "no recent update",
      ],
    },
  ];
};

const runtimeSideEffects = (model: RuntimeDashboardModel): ReadonlyArray<RuntimeSideEffectView> => [
  {
    label: "Realtime",
    kind: "realtime",
    description: "Receipt-driven SSE refresh across the runtime surfaces.",
    metric: `${model.metrics.recentReceiptCount} changes / ${model.metrics.receiptWindowMinutes}m`,
    supporting: model.latestUpdateAt ? `Latest receipt ${formatTs(model.latestUpdateAt)}` : "No recent receipt activity",
  },
  {
    label: "Projection",
    kind: "projection",
    description: "Materialized views for jobs, objectives, and chat context.",
    metric: `${model.metrics.objectiveProjectionCount} objectives · ${model.metrics.jobProjectionCount} jobs · ${model.metrics.chatProjectionCount} chats`,
    supporting: `${model.metrics.streamCount.toLocaleString()} streams · ${model.metrics.receiptCount.toLocaleString()} receipts`,
  },
  {
    label: "Background",
    kind: "background",
    description: "Control, audit, publish, and other non-chat runtime jobs in the recent window.",
    metric: `${model.metrics.recentBackgroundJobCount} recent background jobs`,
    supporting: `${model.metrics.memoryEntryCount.toLocaleString()} memory entries · ${model.metrics.branchCount.toLocaleString()} branches`,
  },
];

const runtimeDelegationSteps = (model: RuntimeDashboardModel): ReadonlyArray<RuntimeDelegationStepView> => [
  {
    step: "1",
    description: "delegate_to_agent creates child linkage from a parent run or stream.",
    metric: `${model.metrics.delegatedJobCount} delegated child jobs visible now`,
  },
  {
    step: "2",
    description: "Child jobs execute independently once they are queued and leased.",
    metric: `${model.metrics.activeChildJobCount} active child jobs in the recent window`,
  },
  {
    step: "3",
    description: "Child results merge back into parent receipts after completion.",
    metric: `${model.metrics.mergedChildRunCount} merged child-run receipts observed`,
  },
];

const renderRuntimeLiveContent = (
  model: RuntimeDashboardModel,
): string => {
  const sideEffects = runtimeSideEffects(model);
  const delegationSteps = runtimeDelegationSteps(model);
  const objectiveSnapshots = renderObjectiveSnapshots(model.objectives);
  const jobSnapshots = renderJobSnapshots(model.jobs);
  const runSnapshots = renderRunSnapshots(model.runs);
  const activitySnapshots = renderActivitySnapshots(model.activity);

  return `<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
    <div class="border ${planeBg("control")} p-4 space-y-3">
      ${objectiveSnapshots}
    </div>

    <div class="border ${planeBg("execution")} p-4 space-y-3">
      ${jobSnapshots}
      ${runSnapshots}
    </div>

    <div class="border ${planeBg("side-effects")} p-4 space-y-3">
      <div class="space-y-2">
        <div class="text-[10px] font-bold tracking-widest text-warning/70 uppercase">Subsystems</div>
        ${sideEffects.map(renderSideEffectCard).join("")}
      </div>
      ${activitySnapshots}
    </div>
  </div>

  ${renderConcurrencyCallout(model)}

  ${renderDelegationLoop(delegationSteps)}

  <div class="space-y-2">
    <div class="text-[11px] font-bold tracking-widest text-muted-foreground uppercase px-1">Data Stores</div>
    <div class="flex flex-wrap gap-3">
      ${model.stores.map(renderStoreCard).join("")}
    </div>
  </div>

  ${renderFlowSummary(model)}`;
};

export const runtimeDashboardLiveIsland = (
  model: RuntimeDashboardModel,
  islandPath = "/runtime/island",
): string => {
  return `<div id="runtime-dashboard-live" class="space-y-5"
    ${liveIslandAttrs({
      path: islandPath,
      refreshOn: runtimeRefreshOn,
      swap: "outerHTML",
    })}>
    ${renderRuntimeLiveContent(model)}
  </div>`;
};

export const runtimeDashboardIsland = (
  model: RuntimeDashboardModel,
  islandPath = "/runtime/island",
): string => {
  const actors = runtimeActors(model);
  const controlStandalone = actors.filter((actor) => actor.plane === "control" && !actor.group);
  const pollLoopActors = actors.filter((actor) => actor.plane === "control" && actor.group === "poll-loop");
  const executionActors = actors.filter((actor) => actor.plane === "execution");
  const sideEffectActors = actors.filter((actor) => actor.plane === "side-effects");

  return `<div id="runtime-dashboard" class="space-y-5">
    ${renderLegend()}

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div class="border ${planeBg("control")} p-4 space-y-3">
        ${renderPlaneHeader("Control Plane", "control")}
        ${controlStandalone.map(renderActorCard).join("")}
        ${pollLoopActors.length ? renderPollLoopGroup(pollLoopActors) : ""}
      </div>

      <div class="border ${planeBg("execution")} p-4 space-y-3">
        ${renderPlaneHeader("Execution Plane", "execution")}
        ${executionActors.map(renderActorCard).join("")}
      </div>

      <div class="border ${planeBg("side-effects")} p-4 space-y-3">
        ${renderPlaneHeader("Side Effects", "side-effects")}
        ${sideEffectActors.map(renderActorCard).join("")}
      </div>
    </div>

    ${runtimeDashboardLiveIsland(model, islandPath)}
  </div>`;
};
