import { MiniGFM } from "@oblivionocean/minigfm";

import {
  type Tone,
  badge,
  badgeBaseClass,
  badgeToneClass,
  dangerButtonClass,
  displayLabel,
  esc,
  formatTs,
  ghostButtonClass,
  iconBadgeToneClass,
  panelClass,
  primaryButtonClass,
  railCardClass,
  renderCliActionCard,
  renderJobActionCards,
  renderObjectiveActions,
  sectionLabelClass,
  shortHash,
  softPanelClass,
  startCase,
  statPill,
  toneForValue,
  truncate,
} from "./ui.js";

const md = new MiniGFM();

const FACTORY_CHAT_REFRESH_MS = 120;
const FACTORY_SIDEBAR_REFRESH_MS = 180;
const FACTORY_INSPECTOR_REFRESH_MS = 180;

const renderMarkdown = (raw: string): string => {
  const text = raw.trim();
  if (!text) return `<p class="text-sm text-zinc-500">Waiting for a response.</p>`;
  return md.parse(text);
};

const skillToolLabel = (tool: string): string => {
  const normalized = tool.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "codex.run") return "Codex";
  if (normalized === "codex.status") return "Codex inspect";
  if (normalized === "factory.dispatch") return "Project ops";
  if (normalized === "factory.status") return "Project status";
  if (normalized === "job.control") return "Steer";
  if (normalized === "jobs.list") return "Jobs";
  if (normalized === "agent.status") return "Inspect";
  if (normalized === "agent.inspect") return "Trace";
  if (normalized === "agent.delegate") return "Delegate";
  if (normalized === "profile.handoff") return "Handoff";
  if (normalized === "bash") return "Shell";
  if (normalized === "grep") return "Search";
  if (normalized === "read") return "Read";
  if (normalized === "write") return "Edit";
  return startCase(normalized);
};

const objectiveSummaryLine = (status: string, phase: string, slotState?: string): string =>
  [status, phase, slotState].map(displayLabel).filter(Boolean).join(" · ");

const objectiveMetaPill = (label: string, value?: string, tone: Tone = "neutral"): string => {
  const text = displayLabel(value);
  if (!text) return "";
  return `<span class="${badgeBaseClass} ${badgeToneClass(tone)} px-2.5 py-1 text-[10px] tracking-[0.14em]">${esc(`${label} ${text}`)}</span>`;
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

export type FactoryLiveChildCard = {
  readonly jobId: string;
  readonly agentId: string;
  readonly worker: string;
  readonly status: string;
  readonly summary: string;
  readonly latestNote?: string;
  readonly stderrTail?: string;
  readonly stdoutTail?: string;
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly stream?: string;
  readonly parentStream?: string;
  readonly task?: string;
  readonly updatedAt?: number;
  readonly abortRequested?: boolean;
  readonly rawLink: string;
  readonly running: boolean;
};

export type FactoryLiveRunCard = {
  readonly runId: string;
  readonly profileLabel: string;
  readonly status: string;
  readonly summary: string;
  readonly updatedAt?: number;
  readonly lastToolName?: string;
  readonly lastToolSummary?: string;
  readonly link?: string;
};

export type FactoryProfileSectionView = {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
};

export type FactorySidebarModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly activeProfileSummary?: string;
  readonly activeProfileSections?: ReadonlyArray<FactoryProfileSectionView>;
  readonly activeProfileTools: ReadonlyArray<string>;
  readonly chatId?: string;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
  readonly objectives: ReadonlyArray<FactoryChatObjectiveNav>;
  readonly jobs: ReadonlyArray<FactoryChatJobNav>;
  readonly selectedObjective?: FactorySelectedObjectiveCard;
  readonly activeCodex?: FactoryLiveCodexCard;
  readonly liveChildren?: ReadonlyArray<FactoryLiveChildCard>;
  readonly activeRun?: FactoryLiveRunCard;
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
  readonly activeProfileSections?: ReadonlyArray<FactoryProfileSectionView>;
  readonly activeProfileTools?: ReadonlyArray<string>;
  readonly selectedThread?: FactorySelectedObjectiveCard;
  readonly jobs?: ReadonlyArray<FactoryChatJobNav>;
  readonly activeCodex?: FactoryLiveCodexCard;
  readonly liveChildren?: ReadonlyArray<FactoryLiveChildCard>;
  readonly activeRun?: FactoryLiveRunCard;
  readonly items: ReadonlyArray<FactoryChatItem>;
};

export type FactoryChatShellModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly activeProfileSummary?: string;
  readonly activeProfileSections?: ReadonlyArray<FactoryProfileSectionView>;
  readonly objectiveId?: string;
  readonly chatId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly chat: FactoryChatIslandModel;
  readonly sidebar: FactorySidebarModel;
};

type FactoryChatRouteContext = {
  readonly profileId: string;
  readonly objectiveId?: string;
  readonly chatId?: string;
  readonly runId?: string;
  readonly jobId?: string;
};

const factoryChatQuery = (input: FactoryChatRouteContext): string => {
  const params = new URLSearchParams();
  params.set("profile", input.profileId);
  if (input.objectiveId) params.set("thread", input.objectiveId);
  else if (input.chatId) params.set("chat", input.chatId);
  if (input.runId) params.set("run", input.runId);
  if (input.jobId) params.set("job", input.jobId);
  const query = params.toString();
  return query ? `?${query}` : "";
};

const factoryChatSseTrigger = (throttleMs: number): string =>
  `load, sse:agent-refresh throttle:${throttleMs}ms, sse:factory-refresh throttle:${throttleMs}ms, sse:job-refresh throttle:${throttleMs}ms`;

const renderJobControls = (jobId: string, running?: boolean, abortRequested?: boolean): string =>
  running ? `<div class="mt-4">${renderJobActionCards(jobId, { abortRequested })}</div>` : "";

const renderWorkControls = (card: FactoryWorkCard): string =>
  card.jobId ? renderJobControls(card.jobId, card.running, false) : "";

type FactoryLiveStatusEntry = {
  readonly key: string;
  readonly kindLabel: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string;
  readonly meta?: string;
  readonly detail?: string;
  readonly link?: string;
  readonly rawLink?: string;
  readonly jobId?: string;
  readonly running?: boolean;
  readonly abortRequested?: boolean;
};

const shellPill = (label: string, tone: Tone = "neutral"): string =>
  `<span class="inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${badgeToneClass(tone)}">${esc(label)}</span>`;

const shellHeaderTitle = (model: FactoryChatShellModel): string =>
  model.sidebar.selectedObjective?.title
    ?? (model.chatId ? "New chat" : model.activeProfileLabel);

const renderShellStatusPills = (model: FactoryChatShellModel): string => {
  const pills: string[] = [shellPill(`Profile ${model.activeProfileLabel}`, "neutral")];
  const objective = model.sidebar.selectedObjective;
  if (objective) {
    pills.push(shellPill(`Project ${displayLabel(objective.status) || "active"}`, toneForValue(objective.status)));
    pills.push(shellPill(`Stage ${displayLabel(objective.phase) || "active"}`, toneForValue(objective.phase)));
    if (typeof objective.queuePosition === "number") pills.push(shellPill(`Queue #${objective.queuePosition}`, "warning"));
  }
  if (model.sidebar.activeCodex) {
    pills.push(shellPill(`codex ${displayLabel(model.sidebar.activeCodex.status) || "active"}`, toneForValue(model.sidebar.activeCodex.status)));
  } else if ((model.sidebar.liveChildren?.length ?? 0) > 0) {
    pills.push(shellPill(`${model.sidebar.liveChildren!.length} child`, "info"));
  }
  if (model.sidebar.activeRun?.status) {
    pills.push(shellPill(`run ${displayLabel(model.sidebar.activeRun.status)}`, toneForValue(model.sidebar.activeRun.status)));
  }
  return pills.join("");
};

const composerChipClass = "inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/[0.08]";
const composerTextareaClass = "min-h-[132px] w-full rounded-[24px] border border-white/10 bg-black/25 px-4 py-4 text-sm leading-6 text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-emerald-300/30 focus:bg-black/35";

const composerJobId = (model: FactoryChatShellModel): string | undefined => {
  if (model.jobId) return model.jobId;
  if (model.sidebar.activeCodex?.jobId) return model.sidebar.activeCodex.jobId;
  const liveChild = model.sidebar.liveChildren?.find((child) => !isTerminalJobStatusValue(child.status));
  if (liveChild?.jobId) return liveChild.jobId;
  return model.sidebar.jobs.find((job) =>
    job.status === "queued" || job.status === "leased" || job.status === "running"
  )?.jobId;
};

const promptFillChip = (label: string, prompt: string): string =>
  `<button class="${composerChipClass}" type="button" data-prompt-fill="${esc(prompt)}">${esc(label)}</button>`;

const renderComposerPromptChips = (model: FactoryChatShellModel): string => {
  const chips = model.objectiveId
    ? [
        promptFillChip("Status check", "What should happen next on this project?"),
        promptFillChip("Focus plan", "Continue, but focus on the highest-risk open task first."),
        promptFillChip("React", "/react Continue with the latest context and keep the update concise."),
        promptFillChip("Steer", "/steer Retarget the current worker to the top priority issue."),
      ]
    : [
        promptFillChip("Start work", "Investigate the current repo state and tell me what should happen next."),
        promptFillChip("Quick status", "What can you infer about the current Factory state from the UI context?"),
        promptFillChip("Tracked project", "/new Create a tracked Factory objective for this request."),
        promptFillChip("Watch project", "/watch objective_demo"),
      ];
  return chips.join("");
};

const compactStatusText = (value: string, maxChars = 160): string => {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentence = text.match(/^(.{1,160}?[.!?])(\s|$)/)?.[1] ?? text;
  const clipped = sentence.length > maxChars ? `${sentence.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…` : sentence;
  return clipped;
};

const systemItemTone = (item: Extract<FactoryChatItem, { readonly kind: "system" }>): Tone => {
  const metaTone = toneForValue(item.meta);
  if (metaTone !== "neutral") return metaTone;
  const titleTone = toneForValue(item.title);
  if (titleTone !== "neutral") return titleTone;
  return toneForValue(item.body);
};

const splitSystemBody = (body: string): { readonly summary: string; readonly detail?: string } => {
  const normalized = body.trim();
  if (!normalized) return { summary: "" };
  const blocks = normalized.split(/\n\s*\n+/).map((block) => block.trim()).filter(Boolean);
  const summarySource = blocks[0] ?? normalized;
  const summary = compactStatusText(summarySource, 150);
  const detailBlocks = blocks.slice(1);
  const detail = detailBlocks.join("\n\n").trim() || (summary !== normalized ? normalized : "");
  return {
    summary,
    detail: detail || undefined,
  };
};

const systemBadgeLabel = (item: Extract<FactoryChatItem, { readonly kind: "system" }>): string => {
  const metaTone = toneForValue(item.meta);
  if (item.meta && metaTone !== "neutral") return displayLabel(item.meta) || "update";
  const titleTone = toneForValue(item.title);
  if (titleTone !== "neutral") return displayLabel(item.title) || "update";
  return "update";
};

const renderChatItem = (
  item: FactoryChatItem,
  activeProfileLabel: string,
  activeProfileId: string,
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
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald-300/20 bg-emerald-300/10 text-sm font-semibold text-emerald-100">AI</div>
        <div class="min-w-0">
          <div class="text-sm font-medium text-zinc-100">${esc(activeProfileLabel)}</div>
          <div class="text-xs text-zinc-500">Profile ${esc(activeProfileId)}</div>
        </div>
      </div>
        ${item.meta ? `<div class="text-xs text-zinc-500">${esc(item.meta)}</div>` : ""}
      </div>
      <div class="${panelClass} px-5 py-4">
        <div class="factory-markdown text-[15px] leading-7 text-zinc-100">${renderMarkdown(item.body)}</div>
      </div>
    </section>`;
  }
  if (item.kind === "system") {
    const tone = systemItemTone(item);
    const body = splitSystemBody(item.body);
    return `<section class="rounded-[20px] border px-4 py-3 ${iconBadgeToneClass(tone)} bg-black/20">
      <div class="flex min-w-0 items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="${sectionLabelClass}">System</span>
            ${item.meta ? `<span class="text-[11px] leading-5 text-zinc-500">${esc(item.meta)}</span>` : ""}
          </div>
          <div class="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <div class="text-sm font-semibold text-zinc-100">${esc(item.title)}</div>
            ${body.summary ? `<div class="min-w-0 text-sm leading-6 text-zinc-300">${esc(body.summary)}</div>` : ""}
          </div>
        </div>
        ${badge(systemBadgeLabel(item), tone)}
      </div>
      ${body.detail ? `<details class="mt-2 rounded-[16px] border border-white/10 bg-black/20 px-3 py-2.5">
        <summary class="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">Details</summary>
        <div class="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-400 [overflow-wrap:anywhere]">${esc(body.detail)}</div>
      </details>` : ""}
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
      ${card.link ? `<a class="text-emerald-200 transition hover:text-emerald-100" href="${esc(card.link)}">Inspect</a>` : ""}
    </div>
    ${renderWorkControls(card)}
  </section>`;
};

const renderCenterWorkbench = (model: FactoryChatIslandModel): string => {
  const thread = model.selectedThread;
  const jobs = model.jobs ?? [];
  const hasLiveWork = Boolean(model.activeRun || model.activeCodex || (model.liveChildren?.length ?? 0) > 0);
  const running = jobs.filter((job) => isActiveJobStatusValue(job.status)).length;
  const queued = jobs.filter((job) => job.status === "queued").length;
  const blocked = jobs.filter((job) => job.status === "failed" || job.status === "canceled").length
    + (thread?.status === "blocked" || thread?.status === "failed" ? 1 : 0);
  const done = jobs.filter((job) => job.status === "completed").length;
  const logSource = model.activeCodex ?? model.liveChildren?.find((child) => child.running) ?? model.liveChildren?.[0];
  const logText = logSource
    ? [
        "latestNote" in logSource ? logSource.latestNote : undefined,
        "stderrTail" in logSource ? logSource.stderrTail : undefined,
        "stdoutTail" in logSource && logSource.stdoutTail !== logSource.stderrTail ? logSource.stdoutTail : undefined,
      ].filter(Boolean).join("\n\n")
    : "";
  if (!thread && !hasLiveWork && jobs.length === 0 && !logText) return "";
  return `<section class="space-y-5">
    <section class="${panelClass} px-5 py-5">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="${sectionLabelClass}">${thread ? "Selected project" : "Project activity"}</div>
          <div class="mt-2 text-xl font-semibold text-white">${esc(thread?.title ?? `${model.activeProfileLabel} project`)}</div>
          <div class="mt-3 text-sm leading-6 text-zinc-300">${esc(thread?.summary ?? model.activeProfileSummary ?? "Factory keeps the active project, logs, and transcript in one place.")}</div>
        </div>
        <div class="flex flex-wrap gap-2">
          ${thread ? badge(displayLabel(thread.status), toneForValue(thread.status)) : ""}
          ${thread ? badge(displayLabel(thread.phase), toneForValue(thread.phase)) : ""}
        </div>
      </div>
      <div class="mt-5 grid gap-2 sm:grid-cols-4">
        ${statPill("Running", String(running))}
        ${statPill("Queued", String(queued))}
        ${statPill("Blocked", String(blocked))}
        ${statPill("Done", String(done))}
      </div>
      ${thread?.nextAction ? `<div class="mt-5 rounded-[20px] border border-white/10 bg-black/20 px-4 py-4">
        <div class="${sectionLabelClass}">Next action</div>
        <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(thread.nextAction)}</div>
      </div>` : ""}
    </section>
    ${logText ? `<section class="${panelClass} px-5 py-5">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="${sectionLabelClass}">Live log</div>
          <div class="mt-2 text-sm text-zinc-400">${esc(logSource?.task ?? logSource?.summary ?? "Current worker output")}</div>
        </div>
        ${logSource?.status ? badge(displayLabel(logSource.status), toneForValue(logSource.status)) : ""}
      </div>
      <pre class="mt-4 max-h-72 overflow-auto rounded-[20px] border border-white/10 bg-black/30 px-4 py-4 text-[12px] leading-5 text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(logText)}</pre>
    </section>` : ""}
  </section>`;
};

export const factoryChatIsland = (model: FactoryChatIslandModel): string => {
  const workbench = renderCenterWorkbench(model);
  const body = model.items.length > 0
    ? model.items.map((item) => renderChatItem(
      item,
      model.activeProfileLabel,
      model.activeProfileId,
    )).join("")
    : `<section class="${softPanelClass} px-5 py-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="${sectionLabelClass}">New chat</div>
          <div class="mt-2 text-sm font-medium text-zinc-100">${esc(model.activeProfileLabel)} is ready for a new request or a quick status question.</div>
        </div>
        ${badge("idle", "neutral")}
      </div>
      <div class="mt-3 text-sm leading-6 text-zinc-400">${esc(model.activeProfileSummary ?? "Start with chat. Factory will open a project automatically when the request needs durable execution.")}</div>
    </section>`;
  return `<div class="chat-stack mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-8 pt-6 md:px-8 xl:px-10" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}" data-active-profile-summary="${esc(model.activeProfileSummary ?? "")}">
    ${workbench}
    <section class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Chat transcript</div>
        <div class="text-xs text-zinc-500">${esc(`${model.items.length}`)} items</div>
      </div>
      ${body}
    </section>
  </div>`;
};

const renderSkillCard = (model: FactorySidebarModel): string => {
  const skillInitials = model.activeProfileLabel
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const sections = (model.activeProfileSections ?? []).slice(0, 2);
  const tools = model.activeProfileTools.map(skillToolLabel).filter(Boolean).slice(0, 6);
  return `<section class="${railCardClass}">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="${sectionLabelClass}">Profile</div>
        <div class="mt-3 text-lg font-semibold text-white">${esc(model.activeProfileLabel)}</div>
        <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(model.activeProfileSummary ?? "Factory uses the active profile to decide how to inspect, queue, and steer projects.")}</div>
      </div>
      <div class="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-xs font-semibold uppercase tracking-[0.2em] text-zinc-200">${esc(skillInitials || "SK")}</div>
    </div>
    ${sections.length > 0 ? `<div class="mt-4 grid gap-3">
      ${sections.map((section) => `<div class="rounded-[20px] border border-white/10 bg-black/20 px-4 py-3">
        <div class="${sectionLabelClass}">${esc(section.title)}</div>
        <div class="mt-2 grid gap-2">
          ${section.items.slice(0, 3).map((item) => `<div class="text-sm leading-6 text-zinc-300">${esc(item)}</div>`).join("")}
        </div>
      </div>`).join("")}
    </div>` : ""}
    ${tools.length > 0 ? `<div class="mt-4">
      <div class="${sectionLabelClass}">Tools</div>
      <div class="mt-3 flex flex-wrap gap-2">
        ${tools.map((tool) => badge(tool, "neutral")).join("")}
      </div>
    </div>` : ""}
  </section>`;
};

const renderObjectiveLink = (model: FactorySidebarModel, objective: FactoryChatObjectiveNav): string => {
  const href = `/factory?profile=${encodeURIComponent(model.activeProfileId)}&thread=${encodeURIComponent(objective.objectiveId)}`;
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
      ${objectiveMetaPill("stage", objective.phase, toneForValue(objective.phase))}
      ${objectiveMetaPill("queue", objective.slotState, toneForValue(objective.slotState))}
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
    ? `&thread=${encodeURIComponent(model.selectedObjective.objectiveId)}`
    : "";
  const selectedChatQuery = blankChat && model.chatId
    ? `&chat=${encodeURIComponent(model.chatId)}`
    : "";
  const profileLinks = model.profiles.length > 0
    ? model.profiles.map((profile) => {
        const selectedClass = profile.selected
          ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
          : "border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]";
        return `<a class="block rounded-[22px] border px-4 py-3 transition ${selectedClass}" href="/factory?profile=${encodeURIComponent(profile.id)}${selectedObjectiveQuery}${selectedChatQuery}">
          <div class="text-sm font-medium">${esc(profile.label)}</div>
          ${profile.summary ? `<div class="mt-1 text-xs leading-5 text-zinc-400">${esc(profile.summary)}</div>` : ""}
        </a>`;
      }).join("")
    : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">No profiles found.</div>`;
  const objectiveCards = model.objectives.length > 0
    ? model.objectives.map((objective) => renderObjectiveLink(model, objective)).join("")
    : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">${blankChat
      ? "No recent projects yet. This new chat has no active project."
      : "No tracked projects yet. Start chatting and Factory will open a project when it needs durable tracking."}</div>`;
  const objectives = blankChat && model.objectives.length > 0
    ? `<div class="space-y-3">
      <div class="rounded-2xl border border-dashed border-white/10 px-4 py-4 text-sm leading-6 text-zinc-500">
        New chat is active. Recent projects are still available here, but they are not part of the current conversation unless you reopen one.
      </div>
      <details class="rounded-[24px] border border-white/10 bg-black/10 px-4 py-4">
        <summary class="cursor-pointer list-none text-sm font-medium text-zinc-200">Show recent projects</summary>
        <div class="mt-4 grid gap-3">
          ${objectiveCards}
        </div>
      </details>
    </div>`
    : objectiveCards;
  return `<div class="space-y-5 px-4 py-5 md:px-5">
    ${renderSkillCard(model)}
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">${blankChat ? "Recent projects" : "Projects"}</div>
        <div class="text-xs text-zinc-500">${esc(`${model.objectives.length}`)}</div>
      </div>
      <div class="mt-4 grid gap-3">
        ${objectives}
      </div>
    </section>
    <section class="${railCardClass}">
      <details>
        <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
          <span class="${sectionLabelClass}">Skills</span>
          <span class="text-xs text-zinc-500">${esc(`${model.profiles.length}`)}</span>
        </summary>
        <div class="mt-4 grid gap-3">
          ${profileLinks}
        </div>
      </details>
    </section>
    <a class="flex items-center gap-2 rounded-2xl border border-sky-300/20 bg-sky-300/[0.06] px-4 py-3 text-sm font-medium text-sky-200 transition hover:bg-sky-300/[0.12]" href="/receipt">
      <span class="text-xs tracking-widest uppercase text-sky-300/70">Receipts</span>
      <span class="text-xs text-zinc-400">\u2192 Browse all streams</span>
    </a>
  </div>`;
};

export const factorySidebarIsland = (model: FactorySidebarModel): string => factoryRailIsland(model);

const renderLocalObjectiveActions = (objective: FactorySelectedObjectiveCard): string =>
  renderObjectiveActions(objective.objectiveId, "grid gap-3 sm:grid-cols-2");

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
  ${job.link ? `<a class="mt-3 inline-flex text-xs font-medium uppercase tracking-[0.16em] text-emerald-200 transition hover:text-emerald-100" href="${esc(job.link)}">Inspect</a>` : ""}
</div>`;

const isTerminalJobStatusValue = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const isActiveJobStatusValue = (status?: string): boolean =>
  status === "running" || status === "leased";

type FactoryCodexTelemetryCard = {
  readonly jobId: string;
  readonly status: string;
  readonly summary: string;
  readonly latestNote?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly task?: string;
  readonly runId?: string;
  readonly updatedAt?: number;
  readonly rawLink: string;
  readonly running: boolean;
  readonly abortRequested?: boolean;
};

const collectCodexTelemetryCards = (model: FactorySidebarModel): ReadonlyArray<FactoryCodexTelemetryCard> => {
  const entries = new Map<string, FactoryCodexTelemetryCard>();
  for (const child of model.liveChildren ?? []) {
    if (child.worker !== "codex") continue;
    entries.set(child.jobId, {
      jobId: child.jobId,
      status: child.status,
      summary: child.summary,
      latestNote: child.latestNote,
      stdoutTail: child.stdoutTail,
      stderrTail: child.stderrTail,
      task: child.task,
      runId: child.runId,
      updatedAt: child.updatedAt,
      rawLink: child.rawLink,
      running: child.running,
      abortRequested: child.abortRequested,
    });
  }
  if (model.activeCodex && !entries.has(model.activeCodex.jobId)) {
    entries.set(model.activeCodex.jobId, {
      jobId: model.activeCodex.jobId,
      status: model.activeCodex.status,
      summary: model.activeCodex.summary,
      latestNote: model.activeCodex.latestNote,
      stdoutTail: model.activeCodex.stdoutTail,
      stderrTail: model.activeCodex.stderrTail,
      task: model.activeCodex.task,
      runId: model.activeCodex.runId,
      updatedAt: model.activeCodex.updatedAt,
      rawLink: model.activeCodex.rawLink,
      running: model.activeCodex.running,
      abortRequested: model.activeCodex.abortRequested,
    });
  }
  return [...entries.values()]
    .sort((left, right) =>
      Number(Boolean(right.running)) - Number(Boolean(left.running))
      || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    )
    .slice(0, 3);
};

const renderOpsSummary = (model: FactorySidebarModel): string => {
  const activeJobs = model.jobs.filter((job) => isActiveJobStatusValue(job.status)).length;
  const queuedJobs = model.jobs.filter((job) => job.status === "queued").length;
  const failedJobs = model.jobs.filter((job) => job.status === "failed").length;
  const codexCards = collectCodexTelemetryCards(model);
  const codexActive = codexCards.filter((card) => card.running).length;
  const activeWorkers = new Set<string>();
  for (const child of model.liveChildren ?? []) {
    if (child.running) activeWorkers.add(child.worker || child.agentId);
  }
  if (model.activeCodex?.running) activeWorkers.add("codex");
  if (model.activeRun && !isTerminalJobStatusValue(model.activeRun.status) && model.activeRun.status !== "idle") {
    activeWorkers.add("supervisor");
  }
  return `<section class="${railCardClass}">
    <div class="flex items-center justify-between gap-3">
      <div class="${sectionLabelClass}">Project overview</div>
      <div class="text-xs text-zinc-500">${esc(`${model.jobs.length}`)} jobs</div>
    </div>
    <div class="mt-4 grid gap-2 sm:grid-cols-2">
      ${statPill("Agents active", `${activeWorkers.size}`)}
      ${statPill("Jobs running", `${activeJobs}`)}
      ${statPill("Jobs queued", `${queuedJobs}`)}
      ${statPill("Jobs failed", `${failedJobs}`)}
      ${statPill("Codex active", `${codexActive}`)}
      ${model.selectedObjective
        ? statPill("Tasks", `${model.selectedObjective.activeTaskCount ?? 0} active / ${model.selectedObjective.readyTaskCount ?? 0} ready`)
        : statPill("Scope", model.chatId ? "New chat" : "Profile chat")}
    </div>
  </section>`;
};

const renderCodexTelemetryCard = (card: FactoryCodexTelemetryCard): string => {
  const logChunks = [
    card.latestNote ? `latest:\n${card.latestNote}` : "",
    card.stderrTail ? `stderr:\n${card.stderrTail}` : "",
    card.stdoutTail && card.stdoutTail !== card.stderrTail ? `stdout:\n${card.stdoutTail}` : "",
  ].filter(Boolean).join("\n\n");
  return `<article class="rounded-[22px] border border-white/10 bg-black/20 px-4 py-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="${sectionLabelClass}">Codex</div>
        <div class="mt-1 text-sm font-semibold text-zinc-100">${esc(card.task ?? card.summary)}</div>
        <div class="mt-1 text-sm leading-6 text-zinc-300">${esc(compactStatusText(card.summary, 180))}</div>
      </div>
      ${badge(displayLabel(card.status), toneForValue(card.status))}
    </div>
    <div class="mt-2 text-[11px] leading-5 text-zinc-500">
      ${esc([`Job ${card.jobId}`, card.runId ? `Run ${card.runId}` : "", card.updatedAt ? `Updated ${formatTs(card.updatedAt)}` : ""].filter(Boolean).join(" · "))}
    </div>
    ${logChunks ? `<pre class="mt-3 max-h-52 overflow-auto rounded-[18px] border border-white/10 bg-black/30 px-3 py-3 text-[12px] leading-5 text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(logChunks)}</pre>` : `<div class="mt-3 rounded-[18px] border border-dashed border-white/10 px-3 py-3 text-sm text-zinc-500">No live Codex output yet.</div>`}
    <div class="mt-3 flex flex-wrap gap-2">
      <a class="${ghostButtonClass}" href="${esc(card.rawLink)}" target="_blank" rel="noreferrer">Inspect job</a>
    </div>
    ${renderJobControls(card.jobId, card.running, card.abortRequested)}
  </article>`;
};

const renderLiveStatusEntry = (entry: FactoryLiveStatusEntry): string => {
  const hasInspect = Boolean(entry.detail || entry.link || entry.rawLink || entry.jobId);
  const summary = compactStatusText(entry.summary);
  const meta = compactStatusText(entry.meta ?? "", 120);
  const inspectBlock = hasInspect
    ? `<details class="mt-3 rounded-[18px] border border-white/10 bg-black/25 px-3 py-3">
      <summary class="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">Details</summary>
      ${entry.detail ? `<pre class="mt-3 max-h-48 overflow-auto text-[12px] leading-5 text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(entry.detail)}</pre>` : ""}
      ${(entry.link || entry.rawLink) ? `<div class="mt-3 flex flex-wrap gap-2">
        ${entry.link ? `<a class="${ghostButtonClass}" href="${esc(entry.link)}">Open</a>` : ""}
        ${entry.rawLink ? `<a class="${ghostButtonClass}" href="${esc(entry.rawLink)}" target="_blank" rel="noreferrer">Job JSON</a>` : ""}
      </div>` : ""}
      ${entry.jobId ? renderJobControls(entry.jobId, entry.running, entry.abortRequested) : ""}
    </details>`
    : "";
  return `<article class="rounded-[20px] border border-white/10 bg-black/20 px-4 py-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="${sectionLabelClass}">${esc(entry.kindLabel)}</div>
        <div class="mt-1 [display:-webkit-box] overflow-hidden text-sm font-semibold text-zinc-100 [-webkit-box-orient:vertical] [-webkit-line-clamp:1] [overflow-wrap:anywhere]">${esc(entry.title)}</div>
        <div class="mt-1 [display:-webkit-box] overflow-hidden text-sm leading-6 text-zinc-300 [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow-wrap:anywhere]">${esc(summary)}</div>
      </div>
      ${badge(displayLabel(entry.status), toneForValue(entry.status))}
    </div>
    <div class="mt-2 flex items-center justify-between gap-3">
      <div class="min-w-0 text-[11px] leading-5 text-zinc-500">${meta ? esc(meta) : ""}</div>
      ${hasInspect ? `<span class="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">Details</span>` : ""}
    </div>
    ${inspectBlock}
  </article>`;
};

export const factoryInspectorIsland = (model: FactorySidebarModel): string => {
  const objective = model.selectedObjective;
  const liveChildren = model.liveChildren ?? [];
  const codexTelemetry = collectCodexTelemetryCards(model);
  const hiddenJobIds = new Set(liveChildren.map((job) => job.jobId));
  if (model.activeCodex?.jobId) hiddenJobIds.add(model.activeCodex.jobId);
  const visibleJobs = model.jobs.filter((job) => !hiddenJobIds.has(job.jobId));
  const statusEntries: FactoryLiveStatusEntry[] = [];
  if (objective) {
    statusEntries.push({
      key: `objective-${objective.objectiveId}`,
      kindLabel: "Factory project",
      title: objective.title,
      status: objective.status,
      summary: objective.summary ?? objective.nextAction ?? "Project is waiting for the next action.",
      meta: [displayLabel(objective.phase), displayLabel(objective.slotState), displayLabel(objective.integrationStatus)].filter(Boolean).join(" · "),
      detail: [
        objective.nextAction ? `Next action: ${objective.nextAction}` : "",
        objective.blockedExplanation ? `Blocked: ${objective.blockedExplanation}` : "",
        objective.latestDecisionSummary ? `Latest decision: ${objective.latestDecisionSummary}` : "",
      ].filter(Boolean).join("\n\n") || undefined,
      link: `/factory/control?thread=${encodeURIComponent(objective.objectiveId)}`,
    });
  }
  if (model.activeRun) {
    statusEntries.push({
        key: `run-${model.activeRun.runId}`,
        kindLabel: "Run",
        title: model.activeRun.profileLabel,
        status: model.activeRun.status,
        summary: model.activeRun.summary,
        meta: [
          `Run ${model.activeRun.runId}`,
          model.activeRun.lastToolName ? `Tool ${model.activeRun.lastToolName}` : "",
          model.activeRun.updatedAt ? `Updated ${formatTs(model.activeRun.updatedAt)}` : "",
        ].filter(Boolean).join(" · "),
        detail: [
          model.activeRun.lastToolSummary ? `Last tool summary: ${model.activeRun.lastToolSummary}` : "",
          `Run ${model.activeRun.runId}`,
        ].filter(Boolean).join("\n\n") || undefined,
        link: model.activeRun.link,
      });
  }
  if (liveChildren.length > 0) {
    statusEntries.push(...liveChildren.map((card) => {
      const latestNote = card.latestNote && card.latestNote !== card.summary ? card.latestNote : undefined;
      const detail = [
        card.task ? `Task: ${card.task}` : "",
        latestNote ? `Latest note: ${latestNote}` : "",
        card.stderrTail ? `stderr:\n${card.stderrTail}` : "",
        card.stdoutTail && card.stdoutTail !== card.stderrTail ? `stdout:\n${card.stdoutTail}` : "",
        card.stream ? `Stream: ${card.stream}` : "",
        card.parentStream && card.parentStream !== card.stream ? `Parent stream: ${card.parentStream}` : "",
      ].filter(Boolean).join("\n\n");
      return {
        key: `child-${card.jobId}`,
        kindLabel: card.worker === "codex" ? "Codex child" : "Child job",
        title: startCase(card.worker === "codex" ? "codex" : card.agentId),
        status: card.status,
        summary: card.summary,
        meta: [
          `Job ${card.jobId}`,
          card.runId ? `Run ${card.runId}` : "",
          card.parentRunId && card.parentRunId !== card.runId ? `Parent ${card.parentRunId}` : "",
          card.updatedAt ? `Updated ${formatTs(card.updatedAt)}` : "",
        ].filter(Boolean).join(" · "),
        detail: detail || undefined,
        rawLink: card.rawLink,
        jobId: card.jobId,
        running: card.running,
        abortRequested: card.abortRequested,
      } satisfies FactoryLiveStatusEntry;
    }));
  } else if (model.activeCodex) {
    statusEntries.push({
      key: `codex-${model.activeCodex.jobId}`,
      kindLabel: "Codex child",
      title: "Codex",
      status: model.activeCodex.status,
      summary: model.activeCodex.summary,
      meta: [
        `Job ${model.activeCodex.jobId}`,
        model.activeCodex.runId ? `Run ${model.activeCodex.runId}` : "",
        model.activeCodex.updatedAt ? `Updated ${formatTs(model.activeCodex.updatedAt)}` : "",
      ].filter(Boolean).join(" · "),
      detail: [
        model.activeCodex.task ? `Task: ${model.activeCodex.task}` : "",
        model.activeCodex.latestNote ? `Latest note: ${model.activeCodex.latestNote}` : "",
        model.activeCodex.stderrTail ? `stderr:\n${model.activeCodex.stderrTail}` : "",
        model.activeCodex.stdoutTail && model.activeCodex.stdoutTail !== model.activeCodex.stderrTail ? `stdout:\n${model.activeCodex.stdoutTail}` : "",
      ].filter(Boolean).join("\n\n") || undefined,
      rawLink: model.activeCodex.rawLink,
      jobId: model.activeCodex.jobId,
      running: model.activeCodex.running,
      abortRequested: model.activeCodex.abortRequested,
    });
  }
  const liveStatusMarkup = statusEntries.length > 0
    ? statusEntries.map(renderLiveStatusEntry).join("")
    : `<div class="text-sm leading-6 text-zinc-500">No live project state is visible in this project chat yet. When Factory, runs, or child jobs move, their current state will appear here automatically.</div>`;
  const jobs = visibleJobs.length > 0
    ? visibleJobs.map(renderJobRow).join("")
    : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">No recent jobs.</div>`;
  return `<div class="space-y-5 px-4 py-5 md:px-5">
    ${renderOpsSummary(model)}
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Inspect</div>
        <div class="text-xs text-zinc-500">${esc(`${statusEntries.length}`)}</div>
      </div>
      <div class="mt-3 text-xs leading-5 text-zinc-500">Live project, run, and child-job state. This rail is the inspect view, not the full chat transcript.</div>
      <div class="mt-4 grid gap-3">
        ${liveStatusMarkup}
      </div>
    </section>
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Worker tails</div>
        <div class="text-xs text-zinc-500">${esc(`${codexTelemetry.length}`)}</div>
      </div>
      <div class="mt-3 text-xs leading-5 text-zinc-500">Visible tail output for the Codex jobs currently active in this project chat, or the most recent failed one if nothing is active.</div>
      <div class="mt-4 grid gap-3">
        ${codexTelemetry.length > 0
          ? codexTelemetry.map(renderCodexTelemetryCard).join("")
          : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">No Codex worker is active in this project chat right now.</div>`}
      </div>
    </section>
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Project details</div>
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
          <a class="${primaryButtonClass}" href="/factory/control?thread=${encodeURIComponent(objective.objectiveId)}">Inspect</a>
          <a class="${ghostButtonClass}" href="${esc(objective.debugLink)}">Debug</a>
          <a class="${ghostButtonClass}" href="${esc(objective.receiptsLink)}">Receipts</a>
        </div>
        <div class="mt-5">
          <div class="${sectionLabelClass}">Actions</div>
          <div class="mt-3">
            ${renderLocalObjectiveActions(objective)}
          </div>
        </div>
      </div>` : `<div class="mt-4 text-sm leading-6 text-zinc-500">Pick a project from the left rail to inspect it.</div>`}
    </section>
    <section class="${railCardClass} factory-job-panel">
      <details ${visibleJobs.length > 0 ? "" : "open"}>
        <summary class="flex cursor-pointer list-none items-center justify-between gap-3">
          <span class="${sectionLabelClass}">Recent job history</span>
          <span class="text-xs text-zinc-500">${esc(`${visibleJobs.length}`)}</span>
        </summary>
        <div class="factory-job-list mt-4 grid gap-3">
          ${jobs}
        </div>
      </details>
    </section>
  </div>`;
};

export const factoryChatShell = (model: FactoryChatShellModel): string => {
  const routeContext: FactoryChatRouteContext = {
    profileId: model.activeProfileId,
    objectiveId: model.objectiveId,
    chatId: model.chatId,
    runId: model.runId,
    jobId: model.jobId,
  };
  const shellQuery = factoryChatQuery(routeContext);
  const islandTrigger = factoryChatSseTrigger(FACTORY_CHAT_REFRESH_MS);
  const sidebarTrigger = factoryChatSseTrigger(FACTORY_SIDEBAR_REFRESH_MS);
  const inspectorTrigger = factoryChatSseTrigger(FACTORY_INSPECTOR_REFRESH_MS);
  const currentJobId = composerJobId(model);
  const composerPlaceholder = model.objectiveId
    ? "Ask for status, send guidance, or use /react, /steer, /follow-up, /promote, /cancel..."
    : "Chat here to inspect, plan, or start work. Plain text stays in chat; slash commands run direct actions.";
  return `<!doctype html>
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
  <script src="https://unpkg.com/htmx-ext-sse@2.2.1/sse.js"></script>
</head>
<body data-factory-chat class="overflow-x-hidden lg:h-screen lg:overflow-hidden" hx-ext="sse" sse-connect="/factory/events${shellQuery}">
  <div class="relative min-h-screen bg-background text-foreground lg:h-screen">
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(110,231,183,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(96,165,250,0.16),transparent_30%),linear-gradient(180deg,rgba(8,10,14,0.94),rgba(8,10,14,1))]"></div>
    <div class="relative flex min-h-screen flex-col lg:grid lg:h-screen lg:min-h-0 lg:grid-cols-[320px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)_360px]">
      <aside class="order-2 min-w-0 border-t border-white/10 bg-black/30 lg:order-none lg:min-h-0 lg:border-r lg:border-t-0">
        <div class="factory-scrollbar max-h-[40vh] overflow-x-hidden overflow-y-auto lg:h-screen lg:max-h-none">
          <div id="factory-sidebar" hx-get="/factory/island/sidebar${shellQuery}" hx-trigger="${sidebarTrigger}" hx-swap="innerHTML">
            ${factoryRailIsland(model.sidebar)}
          </div>
        </div>
      </aside>
      <main class="order-1 min-w-0 bg-black/20 lg:order-none lg:min-h-0">
        <div class="flex min-h-screen flex-col lg:h-screen lg:min-h-0">
          <header class="sticky top-0 z-20 border-b border-white/10 bg-black/35 backdrop-blur-xl">
            <div class="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-2.5 md:px-8 xl:px-10">
              <div class="min-w-0 flex flex-1 flex-wrap items-center gap-2">
                <span class="${sectionLabelClass}">${model.objectiveId ? "Project" : "Chat"}</span>
                <h1 class="min-w-0 truncate text-sm font-semibold text-white" data-profile-label>${esc(shellHeaderTitle(model))}</h1>
                <div class="flex flex-wrap gap-2">
                  ${renderShellStatusPills(model)}
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <a class="${ghostButtonClass}" href="/factory/new-chat?profile=${encodeURIComponent(model.activeProfileId)}">New chat</a>
                ${model.objectiveId ? `<a class="${ghostButtonClass}" href="/factory/control?thread=${encodeURIComponent(model.objectiveId)}">Inspect</a>` : ""}
              </div>
            </div>
          </header>
          <section id="factory-chat-scroll" class="factory-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div id="factory-chat" hx-get="/factory/island/chat${shellQuery}" hx-trigger="${islandTrigger}" hx-swap="innerHTML">
              ${factoryChatIsland(model.chat)}
            </div>
          </section>
          <section class="border-t border-white/10 bg-black/35 px-3 py-3 backdrop-blur-2xl sm:px-4">
            <div class="mx-auto w-full max-w-4xl px-1 md:px-4 xl:px-6">
              <div class="${panelClass} px-4 py-4">
                <div class="${sectionLabelClass}">Chat And Commands</div>
                <div class="mt-3 text-sm leading-6 text-zinc-300">Use plain text to chat from the UI. The agent can still drive CLI-backed work under the hood, and slash commands trigger direct Factory actions when you need them.</div>
                <form id="factory-composer" class="mt-4" action="/factory/compose${shellQuery}" method="post">
                  ${currentJobId ? `<input type="hidden" name="currentJobId" value="${esc(currentJobId)}" />` : ""}
                  <label class="sr-only" for="factory-prompt">Factory prompt</label>
                  <textarea id="factory-prompt" name="prompt" class="${composerTextareaClass}" rows="4" placeholder="${esc(composerPlaceholder)}" autofocus></textarea>
                  <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div class="text-xs leading-5 text-zinc-500">Plain text starts or continues chat. Press Cmd/Ctrl + Enter to send.</div>
                    <button id="factory-composer-submit" class="${primaryButtonClass}" type="submit">Send</button>
                  </div>
                  <div id="factory-composer-status" class="mt-3 hidden rounded-[18px] border border-white/10 bg-black/20 px-3 py-2 text-sm leading-6 text-zinc-300" aria-live="polite"></div>
                </form>
                <div class="mt-4 flex flex-wrap gap-2">
                  ${renderComposerPromptChips(model)}
                </div>
                <details id="factory-command-help" class="mt-4 rounded-[22px] border border-white/10 bg-black/20 px-4 py-4">
                  <summary class="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">Slash commands</summary>
                  <div class="mt-3 text-sm leading-6 text-zinc-300">Available commands: <code>/new</code>, <code>/watch</code>, <code>/react</code>, <code>/steer</code>, <code>/follow-up</code>, <code>/abort-job</code>, <code>/promote</code>, <code>/cancel</code>, <code>/cleanup</code>, <code>/archive</code>.</div>
                  <div class="mt-2 text-sm leading-6 text-zinc-500">Examples: <code>/new Fix the live-output panel.</code> <code>/react Keep receipts concise.</code> <code>/steer Retarget the current worker to the failing check.</code></div>
                </details>
              </div>
            </div>
          </section>
        </div>
      </main>
      <aside class="order-3 min-w-0 border-t border-white/10 bg-black/30 xl:min-h-0 xl:border-l xl:border-t-0">
        <div class="factory-scrollbar max-h-[45vh] overflow-x-hidden overflow-y-auto xl:h-screen xl:max-h-none">
          <div id="factory-inspector" class="factory-inspector-panel" hx-get="/factory/island/inspector${shellQuery}" hx-trigger="${inspectorTrigger}" hx-swap="innerHTML">
            ${factoryInspectorIsland(model.sidebar)}
          </div>
        </div>
      </aside>
    </div>
  </div>
  <script src="/assets/factory-client.js"></script>
</body>
</html>`;
};
