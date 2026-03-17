import { MiniGFM } from "@oblivionocean/minigfm";

import { esc } from "./agent-framework.js";

const md = new MiniGFM();

const panelClass = "rounded-[28px] border border-white/10 bg-white/[0.04] shadow-[0_24px_80px_rgba(0,0,0,0.34)] backdrop-blur-2xl";
const softPanelClass = "rounded-[24px] border border-white/10 bg-black/20 backdrop-blur-xl";
const sectionLabelClass = "text-[11px] font-medium uppercase tracking-[0.28em] text-zinc-500";
const badgeBaseClass = "inline-flex max-w-full items-center justify-center gap-2 rounded-full border px-3 py-1 text-center text-[11px] font-medium uppercase tracking-[0.18em] whitespace-normal leading-4";
const buttonBaseClass = "inline-flex items-center justify-center rounded-full border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition";
const inputClass = "w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-emerald-300/40 focus:bg-white/[0.06]";
const railCardClass = `${softPanelClass} p-4`;

const renderMarkdown = (raw: string): string => {
  const text = raw.trim();
  if (!text) return `<p class="text-sm text-zinc-500">Waiting for a response.</p>`;
  return md.parse(text);
};

const formatTs = (ts?: number): string =>
  typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toLocaleString() : "";

const shortHash = (hash?: string): string =>
  hash ? hash.slice(0, 10) : "";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const toneForValue = (value?: string): Tone => {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return "neutral";
  if ([
    "completed",
    "ready_to_promote",
    "approved",
    "success",
    "succeeded",
    "healthy",
    "ready",
  ].includes(normalized)) return "success";
  if ([
    "failed",
    "canceled",
    "cancelled",
    "aborted",
    "error",
    "changes_requested",
    "blocked",
    "unhealthy",
  ].includes(normalized)) return "danger";
  if ([
    "queued",
    "pending",
    "waiting_for_slot",
    "waiting",
    "needs_attention",
    "degraded",
  ].includes(normalized)) return "warning";
  if ([
    "executing",
    "running",
    "active",
    "in_progress",
    "processing",
  ].includes(normalized)) return "info";
  return "neutral";
};

const badgeToneClass = (tone: Tone): string => {
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

const badge = (label: string, tone: Tone = toneForValue(label)): string =>
  `<span class="${badgeBaseClass} ${badgeToneClass(tone)}">${esc(label)}</span>`;

const primaryButtonClass = `${buttonBaseClass} border-emerald-300/40 bg-emerald-300 text-zinc-950 hover:bg-emerald-200`;
const ghostButtonClass = `${buttonBaseClass} border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.09]`;
const dangerButtonClass = `${buttonBaseClass} border-rose-300/25 bg-rose-400/10 text-rose-100 hover:bg-rose-400/20`;

const statPill = (label: string, value: string): string => `<div class="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
  <div class="text-[10px] uppercase tracking-[0.18em] text-zinc-500">${esc(label)}</div>
  <div class="mt-1 text-sm font-medium text-zinc-100">${esc(value)}</div>
</div>`;

const objectiveSummaryLine = (status: string, phase: string, slotState?: string): string =>
  [status, phase, slotState].filter(Boolean).join(" · ");

export type FactoryChatProfileNav = {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
};

export type FactoryChatObjectiveNav = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly summary?: string;
  readonly updatedAt?: number;
  readonly selected: boolean;
  readonly slotState?: string;
  readonly activeTaskCount?: number;
  readonly readyTaskCount?: number;
  readonly taskCount?: number;
  readonly integrationStatus?: string;
};

export type FactoryChatJobNav = {
  readonly jobId: string;
  readonly agentId: string;
  readonly status: string;
  readonly summary: string;
  readonly runId?: string;
  readonly objectiveId?: string;
  readonly updatedAt?: number;
  readonly link?: string;
};

export type FactorySelectedObjectiveCard = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly summary?: string;
  readonly debugLink: string;
  readonly receiptsLink: string;
  readonly nextAction?: string;
  readonly slotState?: string;
  readonly queuePosition?: number;
  readonly blockedReason?: string;
  readonly blockedExplanation?: string;
  readonly integrationStatus?: string;
  readonly activeTaskCount?: number;
  readonly readyTaskCount?: number;
  readonly taskCount?: number;
  readonly repoProfileStatus?: string;
  readonly latestCommitHash?: string;
  readonly checks?: ReadonlyArray<string>;
  readonly latestDecisionSummary?: string;
  readonly latestDecisionAt?: number;
};

export type FactorySidebarModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
  readonly objectives: ReadonlyArray<FactoryChatObjectiveNav>;
  readonly jobs: ReadonlyArray<FactoryChatJobNav>;
  readonly selectedObjective?: FactorySelectedObjectiveCard;
};

export type FactoryWorkCard = {
  readonly key: string;
  readonly title: string;
  readonly worker: string;
  readonly status: string;
  readonly summary: string;
  readonly detail?: string;
  readonly meta?: string;
  readonly link?: string;
  readonly objectiveId?: string;
  readonly jobId?: string;
  readonly running?: boolean;
};

export type FactoryChatItem =
  | {
      readonly key: string;
      readonly kind: "user";
      readonly body: string;
      readonly meta?: string;
    }
  | {
      readonly key: string;
      readonly kind: "assistant";
      readonly body: string;
      readonly meta?: string;
    }
  | {
      readonly key: string;
      readonly kind: "system";
      readonly title: string;
      readonly body: string;
      readonly meta?: string;
    }
  | {
      readonly key: string;
      readonly kind: "work";
      readonly card: FactoryWorkCard;
    };

export type FactoryChatIslandModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly items: ReadonlyArray<FactoryChatItem>;
};

export type FactoryChatShellModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly objectiveId?: string;
  readonly chat: FactoryChatIslandModel;
  readonly sidebar: FactorySidebarModel;
};

const renderWorkControls = (card: FactoryWorkCard): string => {
  if (!card.jobId || !card.running) return "";
  const jobId = encodeURIComponent(card.jobId);
  return `<div class="mt-4 grid gap-3">
    <form class="grid gap-2" action="/factory/job/${jobId}/steer" method="post" hx-post="/factory/job/${jobId}/steer" hx-swap="none">
      <input class="${inputClass}" type="text" name="problem" placeholder="Steer this job" />
      <div class="flex flex-wrap gap-2">
        <button class="${ghostButtonClass}" type="submit">Steer</button>
      </div>
    </form>
    <form class="grid gap-2" action="/factory/job/${jobId}/follow-up" method="post" hx-post="/factory/job/${jobId}/follow-up" hx-swap="none">
      <input class="${inputClass}" type="text" name="note" placeholder="Add follow-up context" />
      <div class="flex flex-wrap gap-2">
        <button class="${ghostButtonClass}" type="submit">Add Note</button>
      </div>
    </form>
    <form action="/factory/job/${jobId}/abort" method="post" hx-post="/factory/job/${jobId}/abort" hx-swap="none">
      <input type="hidden" name="reason" value="abort requested from /factory chat" />
      <button class="${dangerButtonClass}" type="submit">Abort</button>
    </form>
  </div>`;
};

const renderChatItem = (item: FactoryChatItem): string => {
  if (item.kind === "user") {
    return `<section class="flex justify-end">
      <div class="max-w-3xl space-y-2">
        ${item.meta ? `<div class="text-right text-xs text-zinc-500">${esc(item.meta)}</div>` : ""}
        <div class="rounded-[28px] border border-sky-300/15 bg-sky-300/10 px-5 py-4 text-[15px] leading-7 text-zinc-100 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
          ${esc(item.body)}
        </div>
      </div>
    </section>`;
  }
  if (item.kind === "assistant") {
    return `<section class="space-y-3">
      <div class="flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald-300/20 bg-emerald-300/10 text-sm font-semibold text-emerald-100">AI</div>
        <div>
          <div class="text-sm font-medium text-zinc-100">Factory profile</div>
          ${item.meta ? `<div class="text-xs text-zinc-500">${esc(item.meta)}</div>` : ""}
        </div>
      </div>
      <div class="${panelClass} px-5 py-4">
        <div class="factory-markdown text-[15px] leading-7 text-zinc-100">${renderMarkdown(item.body)}</div>
      </div>
    </section>`;
  }
  if (item.kind === "system") {
    return `<section class="${softPanelClass} px-5 py-4">
      <div class="flex flex-wrap items-center gap-2">
        <span class="${sectionLabelClass}">System</span>
        ${item.meta ? `<span class="text-xs text-zinc-500">${esc(item.meta)}</span>` : ""}
      </div>
      <div class="mt-3 text-base font-semibold text-zinc-100">${esc(item.title)}</div>
      <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(item.body)}</div>
    </section>`;
  }
  const card = item.card;
  return `<section class="${panelClass} px-5 py-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-2">
        <div class="${sectionLabelClass}">${esc(card.worker)}</div>
        <div class="text-base font-semibold text-zinc-100">${esc(card.title)}</div>
      </div>
      ${badge(card.status)}
    </div>
    <div class="mt-4 text-sm leading-6 text-zinc-200">${esc(card.summary)}</div>
    ${card.detail ? `<pre class="mt-4 overflow-x-auto rounded-2xl border border-white/10 bg-black/30 p-4 text-[13px] leading-6 text-zinc-300">${esc(card.detail)}</pre>` : ""}
    <div class="mt-4 flex flex-wrap gap-2 text-xs text-zinc-500">
      ${card.meta ? `<span>${esc(card.meta)}</span>` : ""}
      ${card.jobId ? `<span>Job ${esc(card.jobId)}</span>` : ""}
      ${card.objectiveId ? `<span>Objective ${esc(card.objectiveId)}</span>` : ""}
      ${card.link ? `<a class="text-emerald-200 transition hover:text-emerald-100" href="${esc(card.link)}">Open related view</a>` : ""}
    </div>
    ${renderWorkControls(card)}
  </section>`;
};

export const factoryChatIsland = (model: FactoryChatIslandModel): string => {
  const body = model.items.length > 0
    ? model.items.map(renderChatItem).join("")
    : `<section class="${panelClass} px-6 py-6 text-center">
      <div class="mx-auto max-w-2xl">
        <div class="text-base font-semibold text-zinc-100">${esc(model.activeProfileLabel)} is ready.</div>
        <div class="mt-3 text-sm leading-6 text-zinc-400">Start with status, plan, debug, or dispatch.</div>
      </div>
    </section>`;
  return `<div class="chat-stack mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pb-8 pt-6 md:px-8 xl:px-10" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}">
    ${body}
  </div>`;
};

const renderObjectiveLink = (model: FactorySidebarModel, objective: FactoryChatObjectiveNav): string => {
  const href = `/factory?profile=${encodeURIComponent(model.activeProfileId)}&objective=${encodeURIComponent(objective.objectiveId)}`;
  const selectedClass = objective.selected
    ? "border-sky-300/30 bg-sky-300/10 shadow-[0_16px_48px_rgba(56,189,248,0.12)]"
    : "border-white/10 bg-black/10 hover:border-white/15 hover:bg-white/[0.05]";
  return `<a class="block min-w-0 overflow-hidden rounded-[24px] border px-4 py-4 transition ${selectedClass}" href="${href}">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="max-w-full break-words text-sm font-semibold leading-6 text-zinc-100">${esc(objective.title)}</div>
        <div class="mt-2 text-xs text-zinc-500">${esc(objectiveSummaryLine(objective.status, objective.phase, objective.slotState))}</div>
      </div>
      <div class="shrink-0 max-w-full">${badge(objective.status)}</div>
    </div>
    ${objective.summary ? `<div class="mt-3 max-h-[3rem] overflow-hidden break-words text-sm leading-6 text-zinc-400">${esc(objective.summary)}</div>` : ""}
    <div class="mt-4 flex flex-wrap overflow-hidden gap-2">
      ${typeof objective.activeTaskCount === "number" ? `<span class="inline-flex min-w-0 max-w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] uppercase tracking-[0.16em] text-zinc-400 whitespace-normal leading-4">${esc(`${objective.activeTaskCount} active`)}</span>` : ""}
      ${typeof objective.readyTaskCount === "number" ? `<span class="inline-flex min-w-0 max-w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] uppercase tracking-[0.16em] text-zinc-400 whitespace-normal leading-4">${esc(`${objective.readyTaskCount} ready`)}</span>` : ""}
      ${typeof objective.taskCount === "number" ? `<span class="inline-flex min-w-0 max-w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] uppercase tracking-[0.16em] text-zinc-400 whitespace-normal leading-4">${esc(`${objective.taskCount} total`)}</span>` : ""}
      ${objective.integrationStatus ? `<div class="max-w-full">${badge(`integration ${objective.integrationStatus}`, toneForValue(objective.integrationStatus))}</div>` : ""}
    </div>
    ${objective.updatedAt ? `<div class="mt-3 text-xs text-zinc-500">Updated ${esc(formatTs(objective.updatedAt))}</div>` : ""}
  </a>`;
};

export const factoryRailIsland = (model: FactorySidebarModel): string => {
  const selectedObjectiveQuery = model.selectedObjective
    ? `&objective=${encodeURIComponent(model.selectedObjective.objectiveId)}`
    : "";
  const profileLinks = model.profiles.length > 0
    ? model.profiles.map((profile) => {
        const selectedClass = profile.selected
          ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
          : "border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]";
        return `<a class="block rounded-full border px-4 py-3 text-sm font-medium transition ${selectedClass}" href="/factory?profile=${encodeURIComponent(profile.id)}${selectedObjectiveQuery}">
          ${esc(profile.label)}
        </a>`;
      }).join("")
    : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">No profiles found.</div>`;
  const objectives = model.objectives.length > 0
    ? model.objectives.map((objective) => renderObjectiveLink(model, objective)).join("")
    : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">No objectives yet. Start in the composer and the profile can dispatch one.</div>`;
  return `<div class="space-y-5 px-4 py-5 md:px-5">
    <section class="${railCardClass}">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="${sectionLabelClass}">Factory</div>
          <div class="mt-3 text-lg font-semibold text-white">Control room</div>
        </div>
        <div class="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-xs font-semibold uppercase tracking-[0.2em] text-zinc-200">FX</div>
      </div>
    </section>
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Profiles</div>
        <div class="text-xs text-zinc-500">${esc(`${model.profiles.length}`)}</div>
      </div>
      <div class="mt-4 grid gap-3">
        ${profileLinks}
      </div>
    </section>
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Objectives</div>
        <div class="text-xs text-zinc-500">${esc(`${model.objectives.length}`)}</div>
      </div>
      <div class="mt-4 grid gap-3">
        ${objectives}
      </div>
    </section>
  </div>`;
};

export const factorySidebarIsland = (model: FactorySidebarModel): string => factoryRailIsland(model);

const renderObjectiveActions = (objective: FactorySelectedObjectiveCard): string => {
  const objectiveId = encodeURIComponent(objective.objectiveId);
  return `<div class="grid gap-2 sm:grid-cols-2">
    <form action="/factory/api/objectives/${objectiveId}/react" method="post" hx-post="/factory/api/objectives/${objectiveId}/react" hx-swap="none">
      <button class="${primaryButtonClass} w-full" type="submit">React</button>
    </form>
    <form action="/factory/api/objectives/${objectiveId}/promote" method="post" hx-post="/factory/api/objectives/${objectiveId}/promote" hx-swap="none">
      <button class="${ghostButtonClass} w-full" type="submit">Promote</button>
    </form>
    <form action="/factory/api/objectives/${objectiveId}/cleanup" method="post" hx-post="/factory/api/objectives/${objectiveId}/cleanup" hx-swap="none">
      <button class="${ghostButtonClass} w-full" type="submit">Cleanup</button>
    </form>
    <form action="/factory/api/objectives/${objectiveId}/cancel" method="post" hx-post="/factory/api/objectives/${objectiveId}/cancel" hx-swap="none">
      <input type="hidden" name="reason" value="cancel requested from /factory inspector" />
      <button class="${dangerButtonClass} w-full" type="submit">Cancel</button>
    </form>
    <form action="/factory/api/objectives/${objectiveId}/archive" method="post" hx-post="/factory/api/objectives/${objectiveId}/archive" hx-swap="none">
      <button class="${ghostButtonClass} w-full sm:col-span-2" type="submit">Archive</button>
    </form>
  </div>`;
};

const renderJobRow = (job: FactoryChatJobNav): string => `<div class="rounded-[22px] border border-white/10 bg-black/20 px-4 py-4">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <div class="truncate text-sm font-semibold text-zinc-100">${esc(job.agentId)} · ${esc(job.jobId)}</div>
      <div class="mt-2 max-h-[3rem] overflow-hidden text-sm leading-6 text-zinc-400">${esc(job.summary)}</div>
    </div>
    ${badge(job.status)}
  </div>
  <div class="mt-3 text-xs text-zinc-500">
    ${job.runId ? `Run ${esc(job.runId)}` : "No run id"}
    ${job.objectiveId ? ` · Objective ${esc(job.objectiveId)}` : ""}
    ${job.updatedAt ? ` · ${esc(formatTs(job.updatedAt))}` : ""}
  </div>
  ${job.link ? `<a class="mt-3 inline-flex text-xs font-medium uppercase tracking-[0.16em] text-emerald-200 transition hover:text-emerald-100" href="${esc(job.link)}">Open related view</a>` : ""}
</div>`;

export const factoryInspectorIsland = (model: FactorySidebarModel): string => {
  const objective = model.selectedObjective;
  const jobs = model.jobs.length > 0
    ? model.jobs.map(renderJobRow).join("")
    : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">No recent jobs.</div>`;
  return `<div class="space-y-5 px-4 py-5 md:px-5">
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="${sectionLabelClass}">Active profile</div>
          <div class="mt-3 text-lg font-semibold text-white">${esc(model.activeProfileLabel)}</div>
        </div>
        ${badge(model.activeProfileId, "neutral")}
      </div>
    </section>
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Objective inspector</div>
        ${objective ? badge(objective.status) : ""}
      </div>
      ${objective ? `<div class="mt-4">
        <div class="text-lg font-semibold text-white">${esc(objective.title)}</div>
        <div class="mt-2 text-xs text-zinc-500">${esc(objectiveSummaryLine(objective.status, objective.phase, objective.slotState))}</div>
        ${objective.summary ? `<div class="mt-4 text-sm leading-6 text-zinc-300">${esc(objective.summary)}</div>` : ""}
        <div class="mt-4 grid gap-2 sm:grid-cols-2">
          ${statPill("Objective", objective.objectiveId)}
          ${statPill("Integration", objective.integrationStatus ?? "unknown")}
          ${statPill("Task load", `${objective.activeTaskCount ?? 0} active / ${objective.readyTaskCount ?? 0} ready`)}
          ${statPill("Repo profile", objective.repoProfileStatus ?? "unknown")}
          ${objective.queuePosition ? statPill("Queue", `#${objective.queuePosition}`) : statPill("Slot", objective.slotState ?? "active")}
          ${objective.latestCommitHash ? statPill("Commit", shortHash(objective.latestCommitHash)) : statPill("Checks", `${objective.checks?.length ?? 0}`)}
        </div>
        ${objective.nextAction ? `<div class="mt-5">
          <div class="${sectionLabelClass}">Next action</div>
          <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(objective.nextAction)}</div>
        </div>` : ""}
        ${objective.blockedExplanation || objective.blockedReason ? `<div class="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-4">
          <div class="${sectionLabelClass}">Attention</div>
          <div class="mt-2 text-sm leading-6 text-amber-50">${esc(objective.blockedExplanation ?? objective.blockedReason ?? "")}</div>
        </div>` : ""}
        ${objective.latestDecisionSummary ? `<div class="mt-5">
          <div class="${sectionLabelClass}">Latest decision</div>
          <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(objective.latestDecisionSummary)}</div>
          ${objective.latestDecisionAt ? `<div class="mt-2 text-xs text-zinc-500">${esc(formatTs(objective.latestDecisionAt))}</div>` : ""}
        </div>` : ""}
        <div class="mt-5 flex flex-wrap gap-2">
          <a class="${ghostButtonClass}" href="${esc(objective.debugLink)}">Debug JSON</a>
          <a class="${ghostButtonClass}" href="${esc(objective.receiptsLink)}">Receipts</a>
        </div>
        <div class="mt-5">
          <div class="${sectionLabelClass}">Actions</div>
          <div class="mt-3">
            ${renderObjectiveActions(objective)}
          </div>
        </div>
      </div>` : `<div class="mt-4 text-sm leading-6 text-zinc-500">Pick an objective from the left rail to inspect it.</div>`}
    </section>
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Recent jobs</div>
        <div class="text-xs text-zinc-500">${esc(`${model.jobs.length}`)}</div>
      </div>
      <div class="mt-4 grid gap-3">
        ${jobs}
      </div>
    </section>
  </div>`;
};

export const factoryChatShell = (model: FactoryChatShellModel): string => `<!doctype html>
<html class="h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Factory Chat</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css" />
  <script src="/assets/htmx.min.js"></script>
</head>
<body class="overflow-x-hidden lg:h-screen lg:overflow-hidden" data-profile="${esc(model.activeProfileId)}" data-objective="${esc(model.objectiveId ?? "")}">
  <div class="relative min-h-screen bg-background text-foreground lg:h-screen">
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(110,231,183,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(96,165,250,0.16),transparent_30%),linear-gradient(180deg,rgba(8,10,14,0.94),rgba(8,10,14,1))]"></div>
    <div class="relative flex min-h-screen flex-col lg:grid lg:h-screen lg:min-h-0 lg:grid-cols-[280px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[280px_minmax(0,1fr)_360px]">
      <aside class="order-2 min-w-0 border-t border-white/10 bg-black/30 lg:order-none lg:min-h-0 lg:border-r lg:border-t-0">
        <div class="factory-scrollbar max-h-[40vh] overflow-x-hidden overflow-y-auto lg:h-screen lg:max-h-none">
          <div id="factory-sidebar" hx-get="/factory/island/sidebar?profile=${encodeURIComponent(model.activeProfileId)}${model.objectiveId ? `&objective=${encodeURIComponent(model.objectiveId)}` : ""}" hx-trigger="load, factory-refresh from:body throttle:800ms" hx-swap="innerHTML">
            ${factoryRailIsland(model.sidebar)}
          </div>
        </div>
      </aside>
      <main class="order-1 min-w-0 bg-black/20 lg:order-none lg:min-h-0">
        <div class="flex min-h-screen flex-col lg:h-screen lg:min-h-0">
          <header class="border-b border-white/10 bg-black/20 backdrop-blur-xl">
            <div class="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-4 px-4 py-4 md:px-8 xl:px-10">
              <div class="min-w-0">
                <div class="${sectionLabelClass}">Factory chat</div>
                <div class="mt-3 flex flex-wrap items-center gap-2">
                  <h1 class="text-lg font-semibold text-white">Talk to <span data-profile-label>${esc(model.activeProfileLabel)}</span></h1>
                  ${badge(model.activeProfileId, "neutral")}
                  ${model.objectiveId ? badge(`objective ${model.objectiveId}`, "info") : badge("no objective selected", "neutral")}
                </div>
              </div>
            </div>
          </header>
          <section id="factory-chat-scroll" class="factory-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div id="factory-chat" hx-get="/factory/island/chat?profile=${encodeURIComponent(model.activeProfileId)}${model.objectiveId ? `&objective=${encodeURIComponent(model.objectiveId)}` : ""}" hx-trigger="load, factory-refresh from:body throttle:700ms" hx-swap="innerHTML">
              ${factoryChatIsland(model.chat)}
            </div>
          </section>
          <section class="border-t border-white/10 bg-black/35 px-3 py-3 backdrop-blur-2xl sm:px-4">
            <div class="mx-auto w-full max-w-4xl px-1 md:px-4 xl:px-6">
              <form class="${panelClass} px-4 py-4" action="/factory/run" method="post" hx-post="/factory/run" hx-swap="none">
                <input type="hidden" name="profile" value="${esc(model.activeProfileId)}" />
                <input type="hidden" name="objective" value="${esc(model.objectiveId ?? "")}" />
                <label class="sr-only" for="factory-prompt">Factory prompt</label>
                <textarea id="factory-prompt" class="max-h-40 min-h-[72px] w-full resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-[15px] leading-7 text-zinc-100 outline-none placeholder:text-zinc-500" name="problem" placeholder="Message Factory" required rows="1"></textarea>
                <div class="mt-4 flex flex-col gap-4 border-t border-white/10 pt-4 md:flex-row md:items-end md:justify-between">
                  <div class="flex flex-wrap gap-2">
                    <button class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-white/[0.08]" type="button" data-prompt-fill="Summarize the current Factory status and the next best action.">Status</button>
                    <button class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-white/[0.08]" type="button" data-prompt-fill="Plan the work in a clean sequence and call out risks before dispatching anything.">Plan</button>
                    <button class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-white/[0.08]" type="button" data-prompt-fill="Debug the selected objective and explain what is blocking it.">Debug</button>
                    <button class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-white/[0.08]" type="button" data-prompt-fill="Dispatch a Factory objective and keep delivery moving until there is a concrete result.">Dispatch</button>
                  </div>
                  <div class="flex flex-wrap items-center gap-3">
                    <button class="${primaryButtonClass}" data-send-label="Send" type="submit">Send</button>
                  </div>
                </div>
              </form>
            </div>
          </section>
        </div>
      </main>
      <aside class="order-3 min-w-0 border-t border-white/10 bg-black/30 xl:min-h-0 xl:border-l xl:border-t-0">
        <div class="factory-scrollbar max-h-[45vh] overflow-x-hidden overflow-y-auto xl:h-screen xl:max-h-none">
          <div id="factory-inspector" hx-get="/factory/island/inspector?profile=${encodeURIComponent(model.activeProfileId)}${model.objectiveId ? `&objective=${encodeURIComponent(model.objectiveId)}` : ""}" hx-trigger="load, factory-refresh from:body throttle:800ms" hx-swap="innerHTML">
            ${factoryInspectorIsland(model.sidebar)}
          </div>
        </div>
      </aside>
    </div>
  </div>
  <script>
    (function () {
      let source = null;
      let pendingRunScroll = false;
      let shouldStickToBottom = true;
      const refresh = function () {
        document.body.dispatchEvent(new CustomEvent("factory-refresh", { bubbles: true }));
      };
      const profileInputSelector = 'input[name="profile"]';
      const objectiveInputSelector = 'input[name="objective"]';
      const updateIslandUrls = function () {
        const profile = document.body.dataset.profile || "generalist";
        const objective = document.body.dataset.objective || "";
        const query = "?profile=" + encodeURIComponent(profile) + (objective ? "&objective=" + encodeURIComponent(objective) : "");
        const chat = document.getElementById("factory-chat");
        const sidebar = document.getElementById("factory-sidebar");
        const inspector = document.getElementById("factory-inspector");
        if (chat) chat.setAttribute("hx-get", "/factory/island/chat" + query);
        if (sidebar) sidebar.setAttribute("hx-get", "/factory/island/sidebar" + query);
        if (inspector) inspector.setAttribute("hx-get", "/factory/island/inspector" + query);
      };
      const isNearBottom = function () {
        const scroll = document.getElementById("factory-chat-scroll");
        if (!(scroll instanceof HTMLElement)) return true;
        return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
      };
      const scrollChatToBottom = function (behavior) {
        const scroll = document.getElementById("factory-chat-scroll");
        if (!(scroll instanceof HTMLElement)) return;
        if (typeof scroll.scrollTo === "function") {
          scroll.scrollTo({ top: scroll.scrollHeight, behavior: behavior || "auto" });
        } else {
          scroll.scrollTop = scroll.scrollHeight;
        }
        shouldStickToBottom = true;
      };
      const clearPrompt = function () {
        const input = document.getElementById("factory-prompt");
        if (!(input instanceof HTMLTextAreaElement)) return;
        input.value = "";
        input.focus();
      };
      const setRunPending = function (pending) {
        document.querySelectorAll('form[action="/factory/run"]').forEach(function (form) {
          if (!(form instanceof HTMLFormElement)) return;
          const submit = form.querySelector('button[type="submit"]');
          if (!(submit instanceof HTMLButtonElement)) return;
          submit.disabled = pending;
          submit.textContent = pending ? "Sending..." : (submit.getAttribute("data-send-label") || "Send");
        });
      };
      const syncProfile = function () {
        const chat = document.querySelector("#factory-chat .chat-stack");
        const nextProfile = chat && chat.getAttribute("data-active-profile");
        if (!nextProfile || nextProfile === document.body.dataset.profile) return;
        document.body.dataset.profile = nextProfile;
        const nextLabel = chat.getAttribute("data-active-profile-label") || nextProfile;
        document.querySelectorAll(profileInputSelector).forEach(function (node) {
          node.value = nextProfile;
        });
        document.querySelectorAll("[data-profile-label]").forEach(function (node) {
          node.textContent = nextLabel;
        });
        const url = new URL(window.location.href);
        url.searchParams.set("profile", nextProfile);
        history.replaceState({}, "", url);
        updateIslandUrls();
        connect();
        refresh();
      };
      const syncObjective = function () {
        const objective = document.body.dataset.objective || "";
        document.querySelectorAll(objectiveInputSelector).forEach(function (node) {
          node.value = objective;
        });
        updateIslandUrls();
      };
      const connect = function () {
        const profile = document.body.dataset.profile || "generalist";
        if (source) source.close();
        source = new EventSource("/factory/events?profile=" + encodeURIComponent(profile));
        ["agent-refresh", "receipt-refresh", "job-refresh"].forEach(function (eventName) {
          source.addEventListener(eventName, refresh);
        });
      };
      document.addEventListener("click", function (event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const chip = target.closest("[data-prompt-fill]");
        if (!(chip instanceof HTMLElement)) return;
        const prompt = chip.getAttribute("data-prompt-fill");
        const input = document.getElementById("factory-prompt");
        if (!(input instanceof HTMLTextAreaElement) || !prompt) return;
        input.value = prompt;
        input.focus();
        input.selectionStart = input.value.length;
        input.selectionEnd = input.value.length;
      });
      document.addEventListener("DOMContentLoaded", function () {
        updateIslandUrls();
        connect();
        syncObjective();
        const scroll = document.getElementById("factory-chat-scroll");
        if (scroll instanceof HTMLElement) {
          scroll.addEventListener("scroll", function () {
            shouldStickToBottom = isNearBottom();
          }, { passive: true });
        }
        window.requestAnimationFrame(function () {
          scrollChatToBottom("auto");
        });
      });
      document.body.addEventListener("factory-run-started", function (event) {
        const detail = event && typeof event.detail === "object" && event.detail ? event.detail : {};
        const nextProfile = typeof detail.profileId === "string" && detail.profileId
          ? detail.profileId
          : (document.body.dataset.profile || "generalist");
        const nextObjective = typeof detail.objectiveId === "string" ? detail.objectiveId : "";
        document.body.dataset.profile = nextProfile;
        document.body.dataset.objective = nextObjective;
        document.querySelectorAll(profileInputSelector).forEach(function (node) {
          node.value = nextProfile;
        });
        document.querySelectorAll(objectiveInputSelector).forEach(function (node) {
          node.value = nextObjective;
        });
        document.querySelectorAll("[data-profile-label]").forEach(function (node) {
          node.textContent = typeof detail.profileLabel === "string" && detail.profileLabel ? detail.profileLabel : nextProfile;
        });
        updateIslandUrls();
        connect();
        pendingRunScroll = true;
        setRunPending(false);
        clearPrompt();
        refresh();
      });
      document.addEventListener("htmx:beforeRequest", function (event) {
        const detail = event && event.detail;
        const elt = detail && detail.elt;
        if (!elt || !(elt instanceof HTMLElement)) return;
        if (elt.tagName === "FORM" && elt.getAttribute("action") === "/factory/run") {
          pendingRunScroll = true;
          shouldStickToBottom = true;
          setRunPending(true);
        }
      });
      document.addEventListener("htmx:afterSwap", function (event) {
        const target = event && event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.id === "factory-chat") {
          syncProfile();
          if (pendingRunScroll || shouldStickToBottom) {
            const behavior = pendingRunScroll ? "smooth" : "auto";
            window.requestAnimationFrame(function () {
              scrollChatToBottom(behavior);
            });
          }
          pendingRunScroll = false;
        }
        if (target.id === "factory-sidebar" || target.id === "factory-inspector") syncObjective();
      });
      document.addEventListener("htmx:afterRequest", function (event) {
        const detail = event && event.detail;
        const elt = detail && detail.elt;
        if (!elt || !(elt instanceof HTMLElement)) return;
        if (elt.tagName === "FORM" && elt.getAttribute("action") === "/factory/run") {
          if (detail.failed) setRunPending(false);
          return;
        }
        if (detail.failed) return;
        if (elt.tagName === "FORM") refresh();
      });
      window.addEventListener("beforeunload", function () {
        if (source) source.close();
      });
    })();
  </script>
</body>
</html>`;
