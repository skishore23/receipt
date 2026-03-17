import { MiniGFM } from "@oblivionocean/minigfm";

import { esc } from "./agent-framework.js";

const md = new MiniGFM();

const panelClass = "rounded-[28px] border border-white/10 bg-white/[0.04] shadow-[0_24px_80px_rgba(0,0,0,0.34)] backdrop-blur-2xl";
const softPanelClass = "rounded-[24px] border border-white/10 bg-black/20 backdrop-blur-xl";
const sectionLabelClass = "text-[11px] font-medium uppercase tracking-[0.28em] text-zinc-500";
const badgeBaseClass = "inline-flex max-w-full items-center justify-center gap-2 rounded-full border px-3 py-1 text-center text-[11px] font-medium uppercase tracking-[0.18em] whitespace-normal leading-4 break-words [overflow-wrap:anywhere]";
const iconBadgeChipClass = "inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border px-2.5 py-1.5 text-left";
const iconBadgeCardClass = "flex min-h-[46px] w-full min-w-0 items-center gap-3 rounded-[18px] border px-3.5 py-2.5 text-left";
const buttonBaseClass = "inline-flex items-center justify-center rounded-full border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition";
const inputClass = "w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-emerald-300/40 focus:bg-white/[0.06]";
const railCardClass = `${softPanelClass} p-4`;
const navPillClass = "inline-flex items-center rounded-full border px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] transition";

const renderMarkdown = (raw: string): string => {
  const text = raw.trim();
  if (!text) return `<p class="text-sm text-zinc-500">Waiting for a response.</p>`;
  return md.parse(text);
};

const formatTs = (ts?: number): string =>
  typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toLocaleString() : "";

const shortHash = (hash?: string): string =>
  hash ? hash.slice(0, 10) : "";

const displayLabel = (value?: string): string => {
  const text = value?.trim();
  if (!text) return "";
  return text.replace(/[_-]+/g, " ");
};

const startCase = (value?: string): string => {
  const text = value?.trim();
  if (!text) return "";
  return text
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
};

type Tone = "neutral" | "info" | "success" | "warning" | "danger";
type BadgeIcon = "profile" | "objective" | "codex" | "terminal" | "search" | "read" | "write" | "status" | "inspect" | "dispatch" | "tool";

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

const iconBadgeToneClass = (tone: Tone): string => {
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

const renderIcon = (icon: BadgeIcon): string => {
  const common = 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
  switch (icon) {
    case "profile":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="8" r="4"></circle></svg>`;
    case "objective":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="3"></circle></svg>`;
    case "codex":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><path d="m8 8-4 4 4 4"></path><path d="m16 8 4 4-4 4"></path><path d="m14 4-4 16"></path></svg>`;
    case "terminal":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="m7 10 3 3-3 3"></path><path d="M13 16h4"></path></svg>`;
    case "search":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><circle cx="11" cy="11" r="6"></circle><path d="m20 20-4.2-4.2"></path></svg>`;
    case "read":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><path d="M8 3h7l4 4v14H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"></path><path d="M15 3v5h5"></path><path d="M10 12h7"></path><path d="M10 16h7"></path></svg>`;
    case "write":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><path d="M12 20h9"></path><path d="m16.5 3.5 4 4"></path><path d="M4 20l3.5-1 10-10a2.8 2.8 0 0 0-4-4l-10 10L2 20Z"></path></svg>`;
    case "status":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><path d="M3 12h4l3-6 4 12 3-6h4"></path></svg>`;
    case "inspect":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    case "dispatch":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><path d="M4 12h14"></path><path d="m13 5 7 7-7 7"></path></svg>`;
    default:
      return `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" ${common}><circle cx="12" cy="12" r="8"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg>`;
  }
};

const iconBadge = (input: {
  readonly icon: BadgeIcon;
  readonly text: string;
  readonly tone?: Tone;
  readonly mode?: "chip" | "card";
}): string => {
  const mode = input.mode ?? "chip";
  const rootClass = mode === "card" ? iconBadgeCardClass : iconBadgeChipClass;
  const iconSizeClass = mode === "card" ? "h-7 w-7" : "h-5 w-5";
  const textClass = mode === "card"
    ? "min-w-0 break-words text-sm font-medium leading-5 [overflow-wrap:anywhere]"
    : "min-w-0 break-words text-xs font-medium leading-5 [overflow-wrap:anywhere]";
  return `<span class="${rootClass} ${iconBadgeToneClass(input.tone ?? "neutral")}">
    <span class="flex ${iconSizeClass} shrink-0 items-center justify-center rounded-full bg-black/25">${renderIcon(input.icon)}</span>
    <span class="${textClass}">${esc(input.text)}</span>
  </span>`;
};

const primaryButtonClass = `${buttonBaseClass} border-emerald-300/40 bg-emerald-300 text-zinc-950 hover:bg-emerald-200`;
const ghostButtonClass = `${buttonBaseClass} border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.09]`;
const dangerButtonClass = `${buttonBaseClass} border-rose-300/25 bg-rose-400/10 text-rose-100 hover:bg-rose-400/20`;

const statPill = (label: string, value: string): string => `<div class="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
  <div class="text-[10px] uppercase tracking-[0.18em] text-zinc-500">${esc(label)}</div>
  <div class="mt-1 break-words text-sm font-medium text-zinc-100 [overflow-wrap:anywhere]">${esc(value)}</div>
</div>`;

const navPill = (input: {
  readonly href: string;
  readonly label: string;
  readonly active?: boolean;
}): string => {
  const classes = input.active
    ? "border-sky-300/30 bg-sky-300/10 text-sky-100"
    : "border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]";
  return `<a class="${navPillClass} ${classes}" href="${esc(input.href)}">${esc(input.label)}</a>`;
};

const objectiveSummaryLine = (status: string, phase: string, slotState?: string): string =>
  [status, phase, slotState].map(displayLabel).filter(Boolean).join(" · ");

const objectiveMetaPill = (label: string, value?: string, tone: Tone = "neutral"): string => {
  const text = displayLabel(value);
  if (!text) return "";
  return `<span class="${badgeBaseClass} ${badgeToneClass(tone)} px-2.5 py-1 text-[10px] tracking-[0.14em]">${esc(`${label} ${text}`)}</span>`;
};

const toolBadgeSpec = (tool: string): { readonly icon: BadgeIcon; readonly label: string; readonly tone: Tone } => {
  const normalized = tool.trim().toLowerCase();
  if (normalized === "codex.run" || normalized.includes("codex")) {
    return { icon: "codex", label: "Codex", tone: "info" };
  }
  if (normalized === "factory.dispatch") {
    return { icon: "dispatch", label: "Dispatch", tone: "success" };
  }
  if (normalized === "agent.delegate") {
    return { icon: "dispatch", label: "Delegate", tone: "success" };
  }
  if (normalized === "profile.handoff") {
    return { icon: "dispatch", label: "Profile", tone: "success" };
  }
  if (normalized === "factory.status") {
    return { icon: "inspect", label: "Thread", tone: "info" };
  }
  if (normalized === "agent.status") {
    return { icon: "status", label: "Status", tone: "info" };
  }
  if (normalized === "agent.inspect") {
    return { icon: "inspect", label: "Inspect", tone: "info" };
  }
  if (normalized === "ls") {
    return { icon: "read", label: "Files", tone: "neutral" };
  }
  if (normalized === "jobs.list") {
    return { icon: "status", label: "Jobs", tone: "neutral" };
  }
  if (normalized === "job.control") {
    return { icon: "status", label: "Control", tone: "neutral" };
  }
  if (normalized === "skill.read") {
    return { icon: "read", label: "Skills", tone: "neutral" };
  }
  if (normalized === "memory.read") {
    return { icon: "read", label: "Memory", tone: "neutral" };
  }
  if (normalized === "memory.search") {
    return { icon: "search", label: "Mem search", tone: "info" };
  }
  if (normalized === "memory.commit") {
    return { icon: "write", label: "Mem write", tone: "warning" };
  }
  if (normalized === "bash" || normalized.includes("shell") || normalized.includes("terminal")) {
    return { icon: "terminal", label: "Shell", tone: "neutral" };
  }
  if (normalized === "grep" || normalized.includes("search")) {
    return { icon: "search", label: "Search", tone: "info" };
  }
  if (normalized === "read" || normalized.endsWith(".read")) {
    return { icon: "read", label: "Read", tone: "neutral" };
  }
  if (normalized === "write" || normalized.endsWith(".write") || normalized.includes("edit")) {
    return { icon: "write", label: "Write", tone: "warning" };
  }
  if (normalized.endsWith(".status")) {
    return { icon: "status", label: "Status", tone: "info" };
  }
  if (normalized.includes("inspect")) {
    return { icon: "inspect", label: "Inspect", tone: "info" };
  }
  if (normalized.includes("dispatch") || normalized.includes("delegate") || normalized.includes("handoff")) {
    return { icon: "dispatch", label: "Dispatch", tone: "success" };
  }
  return { icon: "tool", label: startCase(tool), tone: "neutral" };
};

const renderSelectedProfileSummary = (input: {
  readonly profileLabel: string;
  readonly profileId: string;
  readonly profileSummary?: string;
  readonly tools: ReadonlyArray<string>;
  readonly objectiveId?: string;
  readonly includeObjective?: boolean;
  readonly layout?: "header" | "panel";
}): string => {
  const layout = input.layout ?? "header";
  const badgeMode = layout === "panel" ? "card" : "chip";
  const contextContainerClass = layout === "panel" ? "grid gap-2" : "mt-3 flex flex-wrap gap-2";
  const toolContainerClass = layout === "panel" ? "mt-3 grid grid-cols-2 gap-2" : "mt-3 flex flex-wrap gap-1.5";
  const contextBadges = [
    iconBadge({
      icon: "profile",
      text: input.profileLabel,
      tone: "neutral",
      mode: badgeMode,
    }),
  ];
  if (input.includeObjective ?? true) {
    contextBadges.push(iconBadge({
      icon: "objective",
      text: input.objectiveId ? "Thread" : "No thread",
      tone: input.objectiveId ? "info" : "neutral",
      mode: badgeMode,
    }));
  }
  return `<div class="space-y-4">
    <div class="space-y-2">
      <div class="${sectionLabelClass}">Selected profile</div>
      <div class="${contextContainerClass}">
        ${contextBadges.join("")}
      </div>
      <div class="font-mono text-[11px] text-zinc-500">${esc(input.profileId)}</div>
      ${input.profileSummary ? `<div class="text-sm leading-6 text-zinc-400">${esc(input.profileSummary)}</div>` : ""}
    </div>
    ${input.tools.length > 0 ? `<div class="space-y-2">
      <div class="${sectionLabelClass}">Tools in scope</div>
      <div class="${toolContainerClass}">
        ${input.tools.map((tool) => {
          const badgeSpec = toolBadgeSpec(tool);
          return iconBadge({
            icon: badgeSpec.icon,
            text: badgeSpec.label,
            tone: badgeSpec.tone,
            mode: badgeMode,
          });
        }).join("")}
      </div>
    </div>` : ""}
  </div>`;
};

export type FactoryChatProfileNav = {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
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
  readonly selected?: boolean;
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

export type FactoryLiveCodexCard = {
  readonly jobId: string;
  readonly status: string;
  readonly summary: string;
  readonly latestNote?: string;
  readonly stderrTail?: string;
  readonly stdoutTail?: string;
  readonly runId?: string;
  readonly task?: string;
  readonly updatedAt?: number;
  readonly abortRequested?: boolean;
  readonly rawLink: string;
  readonly running: boolean;
};

export type FactorySidebarModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly activeProfileSummary?: string;
  readonly activeProfileTools: ReadonlyArray<string>;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
  readonly objectives: ReadonlyArray<FactoryChatObjectiveNav>;
  readonly jobs: ReadonlyArray<FactoryChatJobNav>;
  readonly selectedObjective?: FactorySelectedObjectiveCard;
  readonly activeCodex?: FactoryLiveCodexCard;
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
  readonly activeProfileSummary?: string;
  readonly items: ReadonlyArray<FactoryChatItem>;
};

export type FactoryChatShellModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly activeProfileSummary?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
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

const renderChatItem = (
  item: FactoryChatItem,
  activeProfileLabel: string,
  activeProfileId: string,
  activeProfileSummary?: string,
): string => {
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
      <div class="flex items-start gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald-300/20 bg-emerald-300/10 text-sm font-semibold text-emerald-100">AI</div>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-zinc-100">Selected profile</div>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            ${iconBadge({ icon: "profile", text: activeProfileLabel, tone: "neutral" })}
            <span class="text-xs text-zinc-500">${esc(activeProfileId)}</span>
            ${item.meta ? `<span class="text-xs text-zinc-500">${esc(item.meta)}</span>` : ""}
          </div>
          ${activeProfileSummary ? `<div class="mt-2 text-sm leading-6 text-zinc-400">${esc(activeProfileSummary)}</div>` : ""}
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
    ${card.detail ? `<details class="mt-4 rounded-2xl border border-white/10 bg-black/25 p-4">
      <summary class="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">View details</summary>
      <pre class="mt-3 overflow-x-auto text-[13px] leading-6 text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(card.detail)}</pre>
    </details>` : ""}
    <div class="mt-4 flex flex-wrap gap-2 text-xs text-zinc-500">
      ${card.meta ? `<span>${esc(card.meta)}</span>` : ""}
      ${card.jobId ? `<span>Job ${esc(card.jobId)}</span>` : ""}
      ${card.link ? `<a class="text-emerald-200 transition hover:text-emerald-100" href="${esc(card.link)}">Open thread</a>` : ""}
    </div>
    ${renderWorkControls(card)}
  </section>`;
};

export const factoryChatIsland = (model: FactoryChatIslandModel): string => {
  const body = model.items.length > 0
    ? model.items.map((item) => renderChatItem(
      item,
      model.activeProfileLabel,
      model.activeProfileId,
      model.activeProfileSummary,
    )).join("")
    : `<section class="${panelClass} px-6 py-6 text-center">
      <div class="mx-auto max-w-2xl">
        <div class="text-base font-semibold text-zinc-100">${esc(model.activeProfileLabel)} is ready.</div>
        <div class="mt-3 text-sm leading-6 text-zinc-400">${esc(model.activeProfileSummary ?? "Start with status, plan, debug, or a new thread.")}</div>
      </div>
    </section>`;
  return `<div class="chat-stack mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pb-8 pt-6 md:px-8 xl:px-10" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}" data-active-profile-summary="${esc(model.activeProfileSummary ?? "")}">
    ${body}
  </div>`;
};

const renderObjectiveLink = (model: FactorySidebarModel, objective: FactoryChatObjectiveNav): string => {
  const href = `/factory?profile=${encodeURIComponent(model.activeProfileId)}&objective=${encodeURIComponent(objective.objectiveId)}`;
  const selectedClass = objective.selected
    ? "border-sky-300/30 bg-sky-300/10 shadow-[0_16px_48px_rgba(56,189,248,0.12)]"
    : "border-white/10 bg-black/10 hover:border-white/15 hover:bg-white/[0.05]";
  return `<a class="block min-w-0 overflow-hidden rounded-[24px] border px-4 py-4 transition ${selectedClass}" href="${href}">
    <div class="flex min-w-0 items-start gap-3 overflow-hidden">
      <div class="min-w-0 flex-1 overflow-hidden">
        <div class="min-w-0 break-words text-sm font-semibold leading-6 text-zinc-100 [display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow-wrap:anywhere]">${esc(objective.title)}</div>
      </div>
      <div class="shrink-0">${badge(displayLabel(objective.status), toneForValue(objective.status))}</div>
    </div>
    <div class="mt-3 flex flex-wrap gap-2">
      ${objectiveMetaPill("phase", objective.phase, toneForValue(objective.phase))}
      ${objectiveMetaPill("slot", objective.slotState, toneForValue(objective.slotState))}
      ${objective.integrationStatus ? objectiveMetaPill("integration", objective.integrationStatus, toneForValue(objective.integrationStatus)) : ""}
    </div>
    ${objective.summary ? `<div class="mt-3 [display:-webkit-box] overflow-hidden break-words text-sm leading-6 text-zinc-400 [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow-wrap:anywhere]">${esc(objective.summary)}</div>` : ""}
    <div class="mt-4 flex flex-wrap overflow-hidden gap-2">
      ${typeof objective.activeTaskCount === "number" ? `<span class="inline-flex min-w-0 max-w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] uppercase tracking-[0.16em] text-zinc-400 whitespace-normal leading-4">${esc(`${objective.activeTaskCount} active`)}</span>` : ""}
      ${typeof objective.readyTaskCount === "number" ? `<span class="inline-flex min-w-0 max-w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] uppercase tracking-[0.16em] text-zinc-400 whitespace-normal leading-4">${esc(`${objective.readyTaskCount} ready`)}</span>` : ""}
      ${typeof objective.taskCount === "number" ? `<span class="inline-flex min-w-0 max-w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] uppercase tracking-[0.16em] text-zinc-400 whitespace-normal leading-4">${esc(`${objective.taskCount} total`)}</span>` : ""}
    </div>
    ${objective.updatedAt ? `<div class="mt-3 text-xs text-zinc-500">Updated ${esc(formatTs(objective.updatedAt))}</div>` : ""}
  </a>`;
};

export const factoryRailIsland = (model: FactorySidebarModel): string => {
  const blankChat = !model.selectedObjective;
  const selectedObjectiveQuery = model.selectedObjective
    ? `&objective=${encodeURIComponent(model.selectedObjective.objectiveId)}`
    : "";
  const profileLinks = model.profiles.length > 0
    ? model.profiles.map((profile) => {
        const selectedClass = profile.selected
          ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
          : "border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]";
        return `<a class="block rounded-[22px] border px-4 py-3 transition ${selectedClass}" href="/factory?profile=${encodeURIComponent(profile.id)}${selectedObjectiveQuery}">
          <div class="text-sm font-medium">${esc(profile.label)}</div>
          ${profile.summary ? `<div class="mt-1 text-xs leading-5 text-zinc-400">${esc(profile.summary)}</div>` : ""}
        </a>`;
      }).join("")
    : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">No profiles found.</div>`;
  const objectiveCards = model.objectives.length > 0
    ? model.objectives.map((objective) => renderObjectiveLink(model, objective)).join("")
    : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">${blankChat
      ? "No recent threads yet. This blank chat has no active thread."
      : "No threads yet. Start a chat and Factory will open one when work needs durable tracking."}</div>`;
  const objectives = blankChat && model.objectives.length > 0
    ? `<div class="space-y-3">
      <div class="rounded-2xl border border-dashed border-white/10 px-4 py-4 text-sm leading-6 text-zinc-500">
        Blank chat is active. Recent threads are still available here, but they are not part of the current conversation unless you reopen one.
      </div>
      <details class="rounded-[24px] border border-white/10 bg-black/10 px-4 py-4">
        <summary class="cursor-pointer list-none text-sm font-medium text-zinc-200">Show recent threads</summary>
        <div class="mt-4 grid gap-3">
          ${objectiveCards}
        </div>
      </details>
    </div>`
    : objectiveCards;
  return `<div class="space-y-5 px-4 py-5 md:px-5">
    <section class="${railCardClass}">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="${sectionLabelClass}">Factory</div>
          <div class="mt-3 text-lg font-semibold text-white">Chat</div>
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
        <div class="${sectionLabelClass}">${blankChat ? "Recent Threads" : "Threads"}</div>
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
  const actionCard = (input: {
    readonly action: string;
    readonly label: string;
    readonly description: string;
    readonly buttonClass: string;
    readonly hiddenReason?: string;
    readonly span?: string;
  }): string => `<form class="${input.span ?? ""}" action="/factory/api/objectives/${objectiveId}/${input.action}" method="post" hx-post="/factory/api/objectives/${objectiveId}/${input.action}" hx-swap="none">
      ${input.hiddenReason ? `<input type="hidden" name="reason" value="${esc(input.hiddenReason)}" />` : ""}
      <button class="w-full rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-4 text-left transition hover:bg-white/[0.06]" type="submit">
        <span class="flex items-start justify-between gap-3">
          <span class="min-w-0">
            <span class="block text-sm font-semibold text-zinc-100">${esc(input.label)}</span>
            <span class="mt-2 block text-sm leading-6 text-zinc-400">${esc(input.description)}</span>
          </span>
          <span class="${input.buttonClass} shrink-0">Run</span>
        </span>
      </button>
    </form>`;
  return `<div class="grid gap-3 sm:grid-cols-2">
    ${actionCard({
      action: "react",
      label: "Keep working",
      description: "Re-evaluate this thread and dispatch the next eligible work.",
      buttonClass: primaryButtonClass,
    })}
    ${actionCard({
      action: "promote",
      label: "Promote to source",
      description: "Merge the ready integration branch into the source branch.",
      buttonClass: ghostButtonClass,
    })}
    ${actionCard({
      action: "cleanup",
      label: "Remove worktrees",
      description: "Delete this thread's task worktrees and integration workspace from disk.",
      buttonClass: ghostButtonClass,
    })}
    ${actionCard({
      action: "cancel",
      label: "Stop thread",
      description: "Stop active jobs and mark this thread as canceled.",
      buttonClass: dangerButtonClass,
      hiddenReason: "cancel requested from /factory inspector",
    })}
    ${actionCard({
      action: "archive",
      label: "Archive thread",
      description: "Hide this thread from the main list without deleting its receipts.",
      buttonClass: ghostButtonClass,
      span: "sm:col-span-2",
    })}
  </div>`;
};

const renderJobRow = (job: FactoryChatJobNav): string => `<div class="factory-job-card min-w-0 overflow-hidden rounded-[22px] border ${job.selected ? "border-sky-300/30 bg-sky-300/10" : "border-white/10 bg-black/20"} px-4 py-4">
  <div class="factory-job-card__row flex min-w-0 flex-wrap items-start justify-between gap-3 overflow-hidden">
    <div class="factory-job-card__body min-w-0 flex-1 overflow-hidden">
      <div class="factory-job-card__title break-words text-sm font-semibold text-zinc-100 [overflow-wrap:anywhere]">${esc(job.agentId)} · ${esc(job.jobId)}</div>
      <div class="factory-job-card__summary mt-2 break-words text-sm leading-6 text-zinc-400 [overflow-wrap:anywhere]">${esc(job.summary)}</div>
    </div>
    <div class="factory-job-card__status shrink-0">${badge(job.status)}</div>
  </div>
  <div class="factory-job-card__meta mt-3 break-words text-xs text-zinc-500 [overflow-wrap:anywhere]">
    ${job.runId ? `Run ${esc(job.runId)}` : "No run id"}
    ${job.updatedAt ? ` · ${esc(formatTs(job.updatedAt))}` : ""}
  </div>
  ${job.link ? `<a class="mt-3 inline-flex text-xs font-medium uppercase tracking-[0.16em] text-emerald-200 transition hover:text-emerald-100" href="${esc(job.link)}">Open thread</a>` : ""}
</div>`;

const renderActiveCodexCard = (card?: FactoryLiveCodexCard): string => {
  if (!card) {
    return `<div class="mt-4 text-sm leading-6 text-zinc-500">No Codex worker has been queued in this thread yet. When one starts, its latest note and log tail will stream here automatically.</div>`;
  }
  const latestNote = card.latestNote && card.latestNote !== card.summary
    ? card.latestNote
    : undefined;
  const stderrTail = card.stderrTail?.trim();
  const stdoutTail = card.stdoutTail?.trim();
  return `<div class="mt-4 space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="text-base font-semibold text-white">Latest child</div>
        <div class="mt-2 font-mono text-[11px] text-zinc-500">${esc(card.jobId)}</div>
      </div>
      ${badge(displayLabel(card.status), toneForValue(card.status))}
    </div>
    ${card.task ? `<div>
      <div class="${sectionLabelClass}">Task</div>
      <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(card.task)}</div>
    </div>` : ""}
    <div>
      <div class="${sectionLabelClass}">Summary</div>
      <div class="mt-2 text-sm leading-6 text-zinc-100">${esc(card.summary)}</div>
    </div>
    ${latestNote ? `<div>
      <div class="${sectionLabelClass}">Latest note</div>
      <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(latestNote)}</div>
    </div>` : ""}
    ${stderrTail ? `<div>
      <div class="${sectionLabelClass}">stderr tail</div>
      <pre class="mt-2 max-h-36 overflow-auto rounded-[20px] border border-white/10 bg-black/25 px-3 py-3 text-[12px] leading-5 text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(stderrTail)}</pre>
    </div>` : ""}
    ${stdoutTail && stdoutTail !== stderrTail ? `<div>
      <div class="${sectionLabelClass}">stdout tail</div>
      <pre class="mt-2 max-h-32 overflow-auto rounded-[20px] border border-white/10 bg-black/25 px-3 py-3 text-[12px] leading-5 text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(stdoutTail)}</pre>
    </div>` : ""}
    ${card.abortRequested ? `<div class="rounded-[20px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-50">Abort requested. Waiting for the worker to stop cleanly.</div>` : ""}
    <div class="flex flex-wrap gap-2 text-xs text-zinc-500">
      ${card.runId ? `<span>Run ${esc(card.runId)}</span>` : ""}
      ${card.updatedAt ? `<span>Updated ${esc(formatTs(card.updatedAt))}</span>` : ""}
    </div>
    <div class="flex flex-wrap gap-2">
      <a class="${ghostButtonClass}" href="${esc(card.rawLink)}" target="_blank" rel="noreferrer">Job JSON</a>
      ${card.running && !card.abortRequested ? `<form action="/factory/job/${encodeURIComponent(card.jobId)}/abort" method="post" hx-post="/factory/job/${encodeURIComponent(card.jobId)}/abort" hx-swap="none">
        <input type="hidden" name="reason" value="abort requested from /factory codex panel" />
        <button class="${dangerButtonClass}" type="submit">Abort</button>
      </form>` : ""}
    </div>
  </div>`;
};

export const factoryInspectorIsland = (model: FactorySidebarModel): string => {
  const objective = model.selectedObjective;
  const visibleJobs = model.activeCodex
    ? model.jobs.filter((job) => job.jobId !== model.activeCodex?.jobId)
    : model.jobs;
  const jobs = visibleJobs.length > 0
    ? visibleJobs.map(renderJobRow).join("")
    : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">No recent jobs.</div>`;
  return `<div class="space-y-5 px-4 py-5 md:px-5">
    <section class="${railCardClass}">
      ${renderSelectedProfileSummary({
        profileLabel: model.activeProfileLabel,
        profileId: model.activeProfileId,
        profileSummary: model.activeProfileSummary,
        tools: model.activeProfileTools,
        includeObjective: false,
        layout: "panel",
      })}
    </section>
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Codex worker</div>
        ${model.activeCodex ? badge(displayLabel(model.activeCodex.status), toneForValue(model.activeCodex.status)) : ""}
      </div>
      ${renderActiveCodexCard(model.activeCodex)}
    </section>
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Thread details</div>
        ${objective ? badge(objective.status) : ""}
      </div>
      ${objective ? `<div class="mt-4">
        <div class="text-lg font-semibold text-white">${esc(objective.title)}</div>
        <div class="mt-2 text-xs text-zinc-500">${esc(objectiveSummaryLine(objective.status, objective.phase, objective.slotState))}</div>
        ${objective.summary ? `<div class="mt-4 text-sm leading-6 text-zinc-300">${esc(objective.summary)}</div>` : ""}
        <div class="mt-4 grid gap-2 sm:grid-cols-2">
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
          <a class="${primaryButtonClass}" href="/factory/control?objective=${encodeURIComponent(objective.objectiveId)}">Work Details</a>
          <a class="${ghostButtonClass}" href="${esc(objective.debugLink)}">Debug JSON</a>
          <a class="${ghostButtonClass}" href="${esc(objective.receiptsLink)}">Receipts</a>
        </div>
        <div class="mt-5">
          <div class="${sectionLabelClass}">Actions</div>
          <div class="mt-3">
            ${renderObjectiveActions(objective)}
          </div>
        </div>
      </div>` : `<div class="mt-4 text-sm leading-6 text-zinc-500">Pick a thread from the left rail to inspect it.</div>`}
    </section>
    <section class="${railCardClass} factory-job-panel">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Recent jobs</div>
        <div class="text-xs text-zinc-500">${esc(`${visibleJobs.length}`)}</div>
      </div>
      <div class="factory-job-list mt-4 grid gap-3">
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
<body class="overflow-x-hidden lg:h-screen lg:overflow-hidden" data-profile="${esc(model.activeProfileId)}" data-objective="${esc(model.objectiveId ?? "")}" data-run="${esc(model.runId ?? "")}" data-job="${esc(model.jobId ?? "")}">
  <div class="relative min-h-screen bg-background text-foreground lg:h-screen">
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(110,231,183,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(96,165,250,0.16),transparent_30%),linear-gradient(180deg,rgba(8,10,14,0.94),rgba(8,10,14,1))]"></div>
    <div class="relative flex min-h-screen flex-col lg:grid lg:h-screen lg:min-h-0 lg:grid-cols-[320px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)_360px]">
      <aside class="order-2 min-w-0 border-t border-white/10 bg-black/30 lg:order-none lg:min-h-0 lg:border-r lg:border-t-0">
        <div class="factory-scrollbar max-h-[40vh] overflow-x-hidden overflow-y-auto lg:h-screen lg:max-h-none">
          <div id="factory-sidebar" hx-get="/factory/island/sidebar?profile=${encodeURIComponent(model.activeProfileId)}${model.objectiveId ? `&objective=${encodeURIComponent(model.objectiveId)}` : ""}${model.runId ? `&run=${encodeURIComponent(model.runId)}` : ""}${model.jobId ? `&job=${encodeURIComponent(model.jobId)}` : ""}" hx-trigger="load, factory-refresh from:body throttle:800ms" hx-swap="innerHTML">
            ${factoryRailIsland(model.sidebar)}
          </div>
        </div>
      </aside>
      <main class="order-1 min-w-0 bg-black/20 lg:order-none lg:min-h-0">
        <div class="flex min-h-screen flex-col lg:h-screen lg:min-h-0">
	          <header class="border-b border-white/10 bg-black/20 backdrop-blur-xl">
	            <div class="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-4 px-4 py-4 md:px-8 xl:px-10">
	              <div class="min-w-0">
	                <div class="${sectionLabelClass}">${model.objectiveId ? "Thread" : "Chat"}</div>
	                <div class="mt-3">
	                  <h1 class="text-lg font-semibold text-white">Chat with <span data-profile-label>${esc(model.activeProfileLabel)}</span></h1>
	                </div>
                  <div class="mt-3 flex flex-wrap gap-2">
                    ${navPill({
                      href: `/factory?profile=${encodeURIComponent(model.activeProfileId)}`,
                      label: "Chat",
                      active: !model.objectiveId,
                    })}
                    ${model.objectiveId ? navPill({
                      href: `/factory?profile=${encodeURIComponent(model.activeProfileId)}&objective=${encodeURIComponent(model.objectiveId)}${model.runId ? `&run=${encodeURIComponent(model.runId)}` : ""}${model.jobId ? `&job=${encodeURIComponent(model.jobId)}` : ""}`,
                      label: "Thread",
                      active: true,
                    }) : ""}
                    ${model.objectiveId ? navPill({
                      href: `/factory/control?objective=${encodeURIComponent(model.objectiveId)}${model.runId ? `&focusKind=run&focusId=${encodeURIComponent(`${model.activeProfileId}:${model.runId}`)}` : ""}`,
                      label: "Work Details",
                    }) : ""}
                  </div>
	                <div class="mt-3 text-sm leading-6 text-zinc-400" data-profile-summary>${esc(model.activeProfileSummary ?? (model.objectiveId
	                    ? "Messages, runs, and recent jobs in this view stay scoped to the current thread."
	                    : "Start a chat here. Factory will keep coordination here until work needs its own thread."))}</div>
                  ${!model.objectiveId ? `<div class="mt-2 text-xs leading-5 text-zinc-500">Blank chat is active. Recent threads stay in the rail until you reopen one.</div>` : ""}
	              </div>
	              <div class="flex flex-wrap items-center gap-2">
	                <a class="${ghostButtonClass}" href="/factory?profile=${encodeURIComponent(model.activeProfileId)}">Blank Chat</a>
	                ${model.objectiveId ? `<a class="${ghostButtonClass}" href="/factory/control?objective=${encodeURIComponent(model.objectiveId)}">Work Details</a>` : ""}
	              </div>
	            </div>
	          </header>
          <section id="factory-chat-scroll" class="factory-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div id="factory-chat" hx-get="/factory/island/chat?profile=${encodeURIComponent(model.activeProfileId)}${model.objectiveId ? `&objective=${encodeURIComponent(model.objectiveId)}` : ""}${model.runId ? `&run=${encodeURIComponent(model.runId)}` : ""}${model.jobId ? `&job=${encodeURIComponent(model.jobId)}` : ""}" hx-trigger="load, factory-refresh from:body throttle:700ms" hx-swap="innerHTML">
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
                    <button class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-white/[0.08]" type="button" data-prompt-fill="Debug the selected thread and explain what is blocking it.">Debug</button>
	                    <button class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-white/[0.08]" type="button" data-prompt-fill="Start a dedicated Factory thread for this request, then keep delivery moving with Codex workers until there is a concrete result.">Start thread</button>
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
          <div id="factory-inspector" class="factory-inspector-panel" hx-get="/factory/island/inspector?profile=${encodeURIComponent(model.activeProfileId)}${model.objectiveId ? `&objective=${encodeURIComponent(model.objectiveId)}` : ""}${model.runId ? `&run=${encodeURIComponent(model.runId)}` : ""}${model.jobId ? `&job=${encodeURIComponent(model.jobId)}` : ""}" hx-trigger="load, factory-refresh from:body throttle:800ms" hx-swap="innerHTML">
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
      const syncUrl = function () {
        const url = new URL(window.location.href);
        const profile = document.body.dataset.profile || "generalist";
        const objective = document.body.dataset.objective || "";
        const run = document.body.dataset.run || "";
        const job = document.body.dataset.job || "";
        url.pathname = "/factory";
        url.searchParams.set("profile", profile);
        if (objective) url.searchParams.set("objective", objective);
        else url.searchParams.delete("objective");
        if (run) url.searchParams.set("run", run);
        else url.searchParams.delete("run");
        if (job) url.searchParams.set("job", job);
        else url.searchParams.delete("job");
        history.replaceState({}, "", url);
      };
      const updateIslandUrls = function () {
        const profile = document.body.dataset.profile || "generalist";
        const objective = document.body.dataset.objective || "";
        const run = document.body.dataset.run || "";
        const job = document.body.dataset.job || "";
        const query = "?profile=" + encodeURIComponent(profile)
          + (objective ? "&objective=" + encodeURIComponent(objective) : "")
          + (run ? "&run=" + encodeURIComponent(run) : "")
          + (job ? "&job=" + encodeURIComponent(job) : "");
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
        const nextSummary = chat.getAttribute("data-active-profile-summary") || "";
        document.querySelectorAll(profileInputSelector).forEach(function (node) {
          node.value = nextProfile;
        });
        document.querySelectorAll("[data-profile-label]").forEach(function (node) {
          node.textContent = nextLabel;
        });
        document.querySelectorAll("[data-profile-summary]").forEach(function (node) {
          node.textContent = nextSummary;
        });
        syncUrl();
        updateIslandUrls();
        connect();
        refresh();
      };
      const syncObjective = function () {
        const objective = document.body.dataset.objective || "";
        document.querySelectorAll(objectiveInputSelector).forEach(function (node) {
          node.value = objective;
        });
        syncUrl();
        updateIslandUrls();
      };
	      const connect = function () {
	        const profile = document.body.dataset.profile || "generalist";
	        const objective = document.body.dataset.objective || "";
	        if (source) source.close();
	        source = new EventSource("/factory/events?profile=" + encodeURIComponent(profile) + (objective ? "&objective=" + encodeURIComponent(objective) : ""));
	        ["agent-refresh", "receipt-refresh", "factory-refresh"].forEach(function (eventName) {
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
        document.body.dataset.run = typeof detail.runId === "string" ? detail.runId : "";
        document.body.dataset.job = typeof detail.jobId === "string" ? detail.jobId : "";
        document.querySelectorAll("[data-profile-label]").forEach(function (node) {
          node.textContent = typeof detail.profileLabel === "string" && detail.profileLabel ? detail.profileLabel : nextProfile;
        });
        document.querySelectorAll("[data-profile-summary]").forEach(function (node) {
          node.textContent = typeof detail.profileSummary === "string" ? detail.profileSummary : "";
        });
        syncUrl();
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
