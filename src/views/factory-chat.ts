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
  iconAgent,
  iconChat,
  iconCodex,
  iconFactory,
  iconForEntity,
  iconJob,
  iconProject,
  iconReceipt,
  iconRun,
  iconTask,
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
  CSS_VERSION,
} from "./ui.js";

const md = new MiniGFM();

const FACTORY_CHAT_REFRESH_MS = 120;
const FACTORY_SIDEBAR_REFRESH_MS = 180;
const FACTORY_INSPECTOR_REFRESH_MS = 180;

const renderMarkdown = (raw: string): string => {
  const text = raw.trim();
  if (!text) return `<p class="text-sm text-muted-foreground">Waiting for a response.</p>`;
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
  const pills: string[] = [];
  const objective = model.sidebar.selectedObjective;
  if (objective) {
    const phaseLabel = displayLabel(objective.phase) || displayLabel(objective.status) || "active";
    pills.push(shellPill(phaseLabel, toneForValue(objective.phase || objective.status)));
    if (typeof objective.queuePosition === "number") pills.push(shellPill(`Queue #${objective.queuePosition}`, "warning"));
  }
  if (model.sidebar.activeCodex) {
    pills.push(shellPill(`Codex ${displayLabel(model.sidebar.activeCodex.status) || "active"}`, toneForValue(model.sidebar.activeCodex.status)));
  } else if (model.sidebar.activeRun?.status) {
    pills.push(shellPill(displayLabel(model.sidebar.activeRun.status), toneForValue(model.sidebar.activeRun.status)));
  }
  return pills.join("");
};

const composerChipClass = "inline-flex items-center rounded-full border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-card-foreground transition hover:bg-accent";
const composerTextareaClass = "min-h-[56px] w-full resize-none rounded-xl border border-border bg-muted px-3 py-2.5 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/30 focus:bg-muted";

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
      <div class="max-w-3xl space-y-1">
        ${item.meta ? `<div class="text-right text-[11px] text-muted-foreground">${esc(item.meta)}</div>` : ""}
        <div class="rounded-xl border border-info/15 bg-info/10 px-4 py-2.5 text-sm leading-6 text-foreground">
          ${esc(item.body)}
        </div>
      </div>
    </section>`;
  }
  if (item.kind === "assistant") {
    return `<section class="space-y-1.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <div class="flex h-7 w-7 items-center justify-center rounded-lg border border-success/20 bg-success/10 text-[10px] font-semibold text-success">AI</div>
          <span class="text-xs font-medium text-foreground">${esc(activeProfileLabel)}</span>
          ${item.meta ? `<span class="text-[11px] text-muted-foreground">${esc(item.meta)}</span>` : ""}
        </div>
      </div>
      <div class="${panelClass} px-4 py-3">
        <div class="factory-markdown text-sm leading-6 text-foreground">${renderMarkdown(item.body)}</div>
      </div>
    </section>`;
  }
  if (item.kind === "system") {
    const tone = systemItemTone(item);
    const body = splitSystemBody(item.body);
    return `<section class="rounded-lg border px-3 py-2 ${iconBadgeToneClass(tone)} bg-muted">
      <div class="flex min-w-0 items-center justify-between gap-2">
        <div class="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="text-xs font-semibold text-foreground">${esc(item.title)}</span>
          ${body.summary ? `<span class="min-w-0 text-xs leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:1] overflow-hidden">${esc(body.summary)}</span>` : ""}
        </div>
        ${badge(systemBadgeLabel(item), tone)}
      </div>
      ${body.detail ? `<details class="mt-1.5 rounded-lg border border-border bg-muted px-2.5 py-2">
        <summary class="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Details</summary>
        <div class="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">${esc(body.detail)}</div>
      </details>` : ""}
    </section>`;
  }
  const card = item.card;
  return `<section class="rounded-lg border border-border bg-muted px-3 py-2">
    <div class="flex min-w-0 items-center justify-between gap-2">
      <div class="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        ${iconForEntity(card.worker, "w-3 h-3 text-muted-foreground shrink-0 self-center")}
        <span class="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">${esc(card.worker)}</span>
        <span class="min-w-0 text-xs font-semibold text-foreground truncate">${esc(card.title)}</span>
        ${card.summary ? `<span class="min-w-0 text-xs leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:1] overflow-hidden">${esc(card.summary)}</span>` : ""}
      </div>
      ${badge(card.status)}
    </div>
    ${card.detail || card.meta || card.link ? `<details class="mt-1.5">
      <summary class="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">Details</summary>
      <div class="mt-1.5 space-y-1.5">
        ${card.detail ? `<pre class="max-h-32 overflow-auto rounded-md bg-background px-2 py-1.5 text-[11px] leading-4 text-card-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(card.detail)}</pre>` : ""}
        <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          ${card.meta ? `<span>${esc(card.meta)}</span>` : ""}
          ${card.jobId ? `<span>Job ${esc(card.jobId)}</span>` : ""}
          ${card.link ? `<a class="text-primary transition hover:text-primary/80" href="${esc(card.link)}">Inspect</a>` : ""}
        </div>
      </div>
    </details>` : ""}
    ${renderWorkControls(card)}
  </section>`;
};

type ChatItemGroup =
  | { readonly kind: "single"; readonly item: FactoryChatItem }
  | { readonly kind: "work_group"; readonly items: ReadonlyArray<Extract<FactoryChatItem, { readonly kind: "work" }>> };

const groupChatItems = (items: ReadonlyArray<FactoryChatItem>): ReadonlyArray<ChatItemGroup> => {
  const groups: ChatItemGroup[] = [];
  let workBuf: Extract<FactoryChatItem, { readonly kind: "work" }>[] = [];
  const flushWork = (): void => {
    if (workBuf.length === 0) return;
    if (workBuf.length === 1) groups.push({ kind: "single", item: workBuf[0]! });
    else groups.push({ kind: "work_group", items: workBuf });
    workBuf = [];
  };
  for (const item of items) {
    if (item.kind === "work") { workBuf.push(item); continue; }
    flushWork();
    groups.push({ kind: "single", item });
  }
  flushWork();
  return groups;
};

const renderWorkGroup = (
  items: ReadonlyArray<Extract<FactoryChatItem, { readonly kind: "work" }>>,
  activeProfileLabel: string,
  activeProfileId: string,
): string => {
  const latest = items[items.length - 1]!;
  const earlier = items.slice(0, -1);
  const latestHtml = renderChatItem(latest, activeProfileLabel, activeProfileId);
  return `<div class="space-y-1">
    <details>
      <summary class="cursor-pointer list-none rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground hover:bg-accent transition">${esc(`${earlier.length} earlier update${earlier.length > 1 ? "s" : ""}`)}</summary>
      <div class="mt-1 space-y-1">
        ${earlier.map((item) => renderChatItem(item, activeProfileLabel, activeProfileId)).join("")}
      </div>
    </details>
    ${latestHtml}
  </div>`;
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
  return `<section class="space-y-2">
    <section class="${softPanelClass} px-4 py-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1 flex items-center gap-2">
          <div class="text-sm font-semibold text-foreground truncate">${esc(thread?.title ?? `${model.activeProfileLabel} project`)}</div>
          ${thread?.nextAction ? `<div class="hidden sm:block text-xs text-muted-foreground truncate">${esc(thread.nextAction)}</div>` : ""}
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          ${thread ? badge(displayLabel(thread.phase || thread.status), toneForValue(thread.phase || thread.status)) : ""}
        </div>
      </div>
    </section>
    ${logText ? `<section class="${softPanelClass} px-4 py-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="${sectionLabelClass} truncate">${esc(logSource?.task ?? logSource?.summary ?? "Live log")}</div>
        ${logSource?.status ? badge(displayLabel(logSource.status), toneForValue(logSource.status)) : ""}
      </div>
      <pre class="mt-2 max-h-40 overflow-auto rounded-lg border border-border bg-muted px-2.5 py-2 text-[11px] leading-5 text-card-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(logText)}</pre>
    </section>` : ""}
  </section>`;
};

export const factoryChatIsland = (model: FactoryChatIslandModel): string => {
  const workbench = renderCenterWorkbench(model);
  const grouped = groupChatItems(model.items);
  const body = grouped.length > 0
    ? grouped.map((group) =>
      group.kind === "single"
        ? renderChatItem(group.item, model.activeProfileLabel, model.activeProfileId)
        : renderWorkGroup(group.items, model.activeProfileLabel, model.activeProfileId)
    ).join("")
    : `<section class="${softPanelClass} px-4 py-3">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="${sectionLabelClass}">Ready</span>
          <span class="text-xs text-foreground">${esc(model.activeProfileLabel)}</span>
        </div>
        ${badge("idle", "neutral")}
      </div>
    </section>`;
  return `<div class="chat-stack mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pb-4 pt-4 md:px-8 xl:px-10" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}" data-active-profile-summary="${esc(model.activeProfileSummary ?? "")}">
    ${workbench}
    <section class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="${sectionLabelClass}">Transcript</div>
        <div class="text-[11px] text-muted-foreground">${esc(`${model.items.length}`)}</div>
      </div>
      ${body}
    </section>
  </div>`;
};

const renderProfileCard = (model: FactorySidebarModel): string => {
  const skillInitials = model.activeProfileLabel
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const sections = (model.activeProfileSections ?? []).slice(0, 2);
  const tools = model.activeProfileTools.map(skillToolLabel).filter(Boolean).slice(0, 6);
  return `<section class="${railCardClass}">
    <div class="${sectionLabelClass}">Profile</div>
    <div class="mt-3 rounded-[20px] border border-border bg-muted px-4 py-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-lg font-semibold text-foreground">${esc(model.activeProfileLabel)}</div>
          <div class="mt-2 text-sm leading-6 text-card-foreground">${esc(model.activeProfileSummary ?? "Active profile controls how Factory inspects and routes work.")}</div>
        </div>
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border bg-secondary text-foreground">${iconAgent()}</div>
      </div>
    </div>
    ${sections.length > 0 ? `<div class="mt-4 grid gap-3">
      ${sections.map((section) => `<div class="rounded-[20px] border border-border bg-muted px-4 py-3">
        <div class="${sectionLabelClass}">${esc(section.title)}</div>
        <div class="mt-2 grid gap-2">
          ${section.items.slice(0, 3).map((item) => `<div class="text-sm leading-6 text-card-foreground">${esc(truncate(item, 120))}</div>`).join("")}
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
    ? "border-primary/30 bg-primary/10"
    : "border-border bg-muted hover:bg-accent";
  const displayStatus = objective.phase || objective.status;
  return `<a class="block min-w-0 rounded-lg border px-3 py-2 transition ${selectedClass}" href="${href}">
    <div class="flex min-w-0 items-center justify-between gap-2">
      <div class="min-w-0 truncate text-xs font-medium text-foreground">${esc(objective.title)}</div>
      <span class="shrink-0 text-[10px] font-medium uppercase ${badgeToneClass(toneForValue(displayStatus)).replace(/border-\S+/g, "").replace(/bg-\S+/g, "").trim()}">${esc(displayLabel(displayStatus))}</span>
    </div>
    ${objective.updatedAt ? `<div class="mt-0.5 text-[10px] text-muted-foreground">${esc(formatTs(objective.updatedAt))}</div>` : ""}
  </a>`;
};

const renderSidebarMetrics = (model: FactorySidebarModel): string => {
  const running = model.jobs.filter((j) => isActiveJobStatusValue(j.status)).length;
  const queued = model.jobs.filter((j) => j.status === "queued").length;
  const failed = model.jobs.filter((j) => j.status === "failed").length;
  const completed = model.jobs.filter((j) => j.status === "completed").length;
  if (model.jobs.length === 0 && !model.selectedObjective) return "";
  const obj = model.selectedObjective;
  const metricDot = (n: number, tone: Tone): string =>
    n > 0 ? `<span class="inline-flex items-center gap-1.5 text-xs ${badgeToneClass(tone).replace(/border-\S+/g, "").trim()}">${n}</span>` : `<span class="text-xs text-muted-foreground">0</span>`;
  return `<section class="${railCardClass}">
    <div class="flex items-center gap-1.5 ${sectionLabelClass}">${iconJob("w-3.5 h-3.5")} Jobs</div>
    <div class="mt-3 grid grid-cols-4 gap-1.5">
      <div class="rounded-xl border border-border bg-muted px-2 py-1.5 text-center">
        <div class="flex items-center justify-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">${iconRun("w-2.5 h-2.5")} Run</div>
        <div class="mt-0.5">${metricDot(running, "info")}</div>
      </div>
      <div class="rounded-xl border border-border bg-muted px-2 py-1.5 text-center">
        <div class="flex items-center justify-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">Queue</div>
        <div class="mt-0.5">${metricDot(queued, "warning")}</div>
      </div>
      <div class="rounded-xl border border-border bg-muted px-2 py-1.5 text-center">
        <div class="text-[10px] uppercase tracking-widest text-muted-foreground">Fail</div>
        <div class="mt-0.5">${metricDot(failed, "danger")}</div>
      </div>
      <div class="rounded-xl border border-border bg-muted px-2 py-1.5 text-center">
        <div class="text-[10px] uppercase tracking-widest text-muted-foreground">Done</div>
        <div class="mt-0.5">${metricDot(completed, "success")}</div>
      </div>
    </div>
    ${obj ? `<div class="mt-3 grid grid-cols-3 gap-1.5">
      <div class="rounded-xl border border-border bg-muted px-2 py-1.5 text-center">
        <div class="text-[10px] uppercase tracking-widest text-muted-foreground">Active</div>
        <div class="mt-0.5 text-xs text-card-foreground">${obj.activeTaskCount ?? 0}</div>
      </div>
      <div class="rounded-xl border border-border bg-muted px-2 py-1.5 text-center">
        <div class="text-[10px] uppercase tracking-widest text-muted-foreground">Ready</div>
        <div class="mt-0.5 text-xs text-card-foreground">${obj.readyTaskCount ?? 0}</div>
      </div>
      <div class="rounded-xl border border-border bg-muted px-2 py-1.5 text-center">
        <div class="text-[10px] uppercase tracking-widest text-muted-foreground">Total</div>
        <div class="mt-0.5 text-xs text-card-foreground">${obj.taskCount ?? 0}</div>
      </div>
    </div>` : ""}
  </section>`;
};

export const factoryRailIsland = (model: FactorySidebarModel): string => {
  const blankChat = !model.selectedObjective;
  const selectedObjectiveQuery = model.selectedObjective
    ? `&thread=${encodeURIComponent(model.selectedObjective.objectiveId)}`
    : "";
  const selectedChatQuery = blankChat && model.chatId
    ? `&chat=${encodeURIComponent(model.chatId)}`
    : "";
  const objectiveCards = model.objectives.length > 0
    ? model.objectives.map((objective) => renderObjectiveLink(model, objective)).join("")
    : `<div class="text-[11px] text-muted-foreground">${blankChat ? "No projects yet." : "No tracked projects."}</div>`;
  const objectives = objectiveCards;
  const profileLinks = model.profiles.length > 0
    ? model.profiles.map((profile) => {
        const selectedClass = profile.selected
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground";
        return `<a class="rounded-lg border px-2 py-1 text-[11px] font-medium transition ${selectedClass}" href="/factory?profile=${encodeURIComponent(profile.id)}${selectedObjectiveQuery}${selectedChatQuery}">${esc(profile.label)}</a>`;
      }).join("")
    : "";
  return `<div class="space-y-3 px-3 py-3 md:px-4">
    <div class="space-y-2">
      <a class="flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition" href="/receipt">
        ${iconReceipt("text-primary")} Receipt
      </a>
      <div class="flex flex-wrap gap-1.5">
        ${profileLinks}
      </div>
    </div>
    <section class="${softPanelClass} px-3 py-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 ${sectionLabelClass}">${iconProject("w-3.5 h-3.5")} ${blankChat ? "Recent" : "Projects"}</div>
        <div class="text-[10px] text-muted-foreground">${esc(`${model.objectives.length}`)}</div>
      </div>
      <div class="mt-2 grid gap-2">
        ${objectives}
      </div>
    </section>
    ${renderSidebarMetrics(model)}
  </div>`;
};

export const factorySidebarIsland = (model: FactorySidebarModel): string => factoryRailIsland(model);

const renderLocalObjectiveActions = (objective: FactorySelectedObjectiveCard): string =>
  renderObjectiveActions(objective.objectiveId, "grid gap-2");

const renderJobRow = (job: FactoryChatJobNav): string => `<div class="factory-job-card min-w-0 rounded-lg border ${job.selected ? "border-primary/30 bg-primary/10" : "border-border bg-muted"} px-3 py-2" data-job-id="${esc(job.jobId)}">
  <div class="flex items-center justify-between gap-2">
    <div class="min-w-0 truncate text-xs font-medium text-foreground">${esc(job.agentId)}</div>
    <span class="shrink-0 text-[10px] font-medium uppercase ${badgeToneClass(toneForValue(job.status)).replace(/border-\S+/g, "").replace(/bg-\S+/g, "").trim()}">${esc(displayLabel(job.status))}</span>
  </div>
  <div class="mt-0.5 truncate text-[11px] text-muted-foreground">${esc(job.summary)}</div>
  <div class="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
    ${job.updatedAt ? `<span>${esc(formatTs(job.updatedAt))}</span>` : ""}
    ${job.link ? `<a class="font-medium text-primary hover:underline" href="${esc(job.link)}">Inspect</a>` : ""}
  </div>
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
  return `<section class="${softPanelClass} px-3 py-2.5">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 ${sectionLabelClass}">${iconFactory("w-3.5 h-3.5")} Overview</div>
      <div class="text-[10px] text-muted-foreground">${esc(`${model.jobs.length}`)} jobs</div>
    </div>
    <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
      <span class="inline-flex items-center gap-1 text-muted-foreground">${iconAgent("w-3 h-3")} <span class="font-medium text-foreground">${activeWorkers.size}</span></span>
      <span class="inline-flex items-center gap-1 text-muted-foreground">${iconRun("w-3 h-3 text-info")} <span class="font-medium text-info">${activeJobs}</span></span>
      <span class="inline-flex items-center gap-1 text-muted-foreground">Queued <span class="font-medium text-warning">${queuedJobs}</span></span>
      <span class="inline-flex items-center gap-1 text-muted-foreground">Failed <span class="font-medium text-destructive">${failedJobs}</span></span>
      <span class="inline-flex items-center gap-1 text-muted-foreground">${iconCodex("w-3 h-3")} <span class="font-medium text-foreground">${codexActive}</span></span>
    </div>
  </section>`;
};

const renderCodexTelemetryCard = (card: FactoryCodexTelemetryCard): string => {
  const logChunks = [
    card.latestNote ? `latest:\n${card.latestNote}` : "",
    card.stderrTail ? `stderr:\n${card.stderrTail}` : "",
    card.stdoutTail && card.stdoutTail !== card.stderrTail ? `stdout:\n${card.stdoutTail}` : "",
  ].filter(Boolean).join("\n\n");
  return `<article class="rounded-[22px] border border-border bg-muted px-4 py-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-1.5 ${sectionLabelClass}">${iconCodex("w-3.5 h-3.5")} Codex</div>
        <div class="mt-1 text-sm font-semibold text-foreground">${esc(card.task ?? card.summary)}</div>
        <div class="mt-1 text-sm leading-6 text-card-foreground">${esc(compactStatusText(card.summary, 180))}</div>
      </div>
      ${badge(displayLabel(card.status), toneForValue(card.status))}
    </div>
    <div class="mt-2 text-[11px] leading-5 text-muted-foreground">
      ${esc([`Job ${card.jobId}`, card.runId ? `Run ${card.runId}` : "", card.updatedAt ? `Updated ${formatTs(card.updatedAt)}` : ""].filter(Boolean).join(" · "))}
    </div>
    ${logChunks ? `<pre class="mt-3 max-h-52 overflow-auto rounded-[18px] border border-border bg-muted px-3 py-3 text-[12px] leading-5 text-card-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(logChunks)}</pre>` : `<div class="mt-3 rounded-[18px] border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">No live Codex output yet.</div>`}
    <div class="mt-3 flex flex-wrap gap-2">
      <a class="${ghostButtonClass}" href="${esc(card.rawLink)}" target="_blank" rel="noreferrer">Inspect job</a>
    </div>
    ${renderJobControls(card.jobId, card.running, card.abortRequested)}
  </article>`;
};

const renderLiveStatusEntry = (entry: FactoryLiveStatusEntry, depth: number = 0): string => {
  const hasInspect = Boolean(entry.detail || entry.link || entry.rawLink || entry.jobId);
  const summary = compactStatusText(entry.summary, 100);
  const indent = depth > 0 ? "ml-3 border-l-2 border-border pl-3" : "";
  return `<article class="${indent} rounded-lg border border-border bg-muted px-3 py-2">
    <div class="flex items-center justify-between gap-2">
      <div class="min-w-0 flex items-center gap-1.5">
        ${iconForEntity(entry.kindLabel, "w-3 h-3 text-muted-foreground shrink-0")}
        <span class="text-[10px] uppercase tracking-wider text-muted-foreground">${esc(entry.kindLabel)}</span>
        <span class="truncate text-xs font-medium text-foreground">${esc(entry.title)}</span>
      </div>
      ${badge(displayLabel(entry.status), toneForValue(entry.status))}
    </div>
    ${summary ? `<div class="mt-1 truncate text-[11px] text-muted-foreground">${esc(summary)}</div>` : ""}
    ${hasInspect ? `<details class="mt-1.5">
      <summary class="cursor-pointer text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">Details</summary>
      <div class="mt-1.5 space-y-1.5">
        ${entry.detail ? `<pre class="max-h-32 overflow-auto rounded-md bg-background px-2 py-1.5 text-[11px] leading-4 text-card-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(entry.detail)}</pre>` : ""}
        ${(entry.link || entry.rawLink) ? `<div class="flex gap-1.5">
          ${entry.link ? `<a class="text-[10px] font-medium text-primary hover:underline" href="${esc(entry.link)}">Open</a>` : ""}
          ${entry.rawLink ? `<a class="text-[10px] font-medium text-muted-foreground hover:text-foreground" href="${esc(entry.rawLink)}" target="_blank" rel="noreferrer">JSON</a>` : ""}
        </div>` : ""}
        ${entry.jobId ? renderJobControls(entry.jobId, entry.running, entry.abortRequested) : ""}
      </div>
    </details>` : ""}
  </article>`;
};

export const factoryInspectorIsland = (model: FactorySidebarModel): string => {
  const objective = model.selectedObjective;
  const liveChildren = model.liveChildren ?? [];
  const codexTelemetry = collectCodexTelemetryCards(model);
  const hiddenJobIds = new Set(liveChildren.map((job) => job.jobId));
  if (model.activeCodex?.jobId) hiddenJobIds.add(model.activeCodex.jobId);
  const visibleJobs = model.jobs.filter((job) => !hiddenJobIds.has(job.jobId));

  const objectiveEntry = (obj: FactorySelectedObjectiveCard): FactoryLiveStatusEntry => ({
    key: `objective-${obj.objectiveId}`,
    kindLabel: "Project",
    title: obj.title,
    status: obj.status,
    summary: obj.summary ?? obj.nextAction ?? "",
    detail: [
      obj.nextAction ? `Next: ${obj.nextAction}` : "",
      obj.blockedExplanation ? `Blocked: ${obj.blockedExplanation}` : "",
    ].filter(Boolean).join("\n") || undefined,
    link: `/factory/control?thread=${encodeURIComponent(obj.objectiveId)}`,
  });

  const runEntry = (run: FactoryLiveRunCard): FactoryLiveStatusEntry => ({
    key: `run-${run.runId}`,
    kindLabel: "Run",
    title: run.profileLabel,
    status: run.status,
    summary: run.summary,
    detail: run.lastToolSummary ? `Tool: ${run.lastToolName ?? "?"} — ${run.lastToolSummary}` : undefined,
    link: run.link,
  });

  const childEntry = (card: FactoryLiveChildCard): FactoryLiveStatusEntry => ({
    key: `child-${card.jobId}`,
    kindLabel: card.worker === "codex" ? "Codex" : startCase(card.agentId),
    title: card.task ?? card.summary,
    status: card.status,
    summary: card.latestNote && card.latestNote !== card.summary ? card.latestNote : card.summary,
    detail: [
      card.stderrTail ? `stderr:\n${card.stderrTail}` : "",
      card.stdoutTail && card.stdoutTail !== card.stderrTail ? `stdout:\n${card.stdoutTail}` : "",
    ].filter(Boolean).join("\n\n") || undefined,
    rawLink: card.rawLink,
    jobId: card.jobId,
    running: card.running,
    abortRequested: card.abortRequested,
  });

  const codexEntry = (c: FactoryLiveCodexCard): FactoryLiveStatusEntry => ({
    key: `codex-${c.jobId}`,
    kindLabel: "Codex",
    title: c.task ?? c.summary,
    status: c.status,
    summary: c.latestNote ?? c.summary,
    detail: [
      c.stderrTail ? `stderr:\n${c.stderrTail}` : "",
      c.stdoutTail && c.stdoutTail !== c.stderrTail ? `stdout:\n${c.stdoutTail}` : "",
    ].filter(Boolean).join("\n\n") || undefined,
    rawLink: c.rawLink,
    jobId: c.jobId,
    running: c.running,
    abortRequested: c.abortRequested,
  });

  const lineageMarkup = (): string => {
    const parts: string[] = [];
    if (objective) parts.push(renderLiveStatusEntry(objectiveEntry(objective), 0));
    if (model.activeRun) parts.push(renderLiveStatusEntry(runEntry(model.activeRun), objective ? 1 : 0));
    const childDepth = (objective ? 1 : 0) + (model.activeRun ? 1 : 0);
    if (liveChildren.length > 0) {
      parts.push(...liveChildren.map((c) => renderLiveStatusEntry(childEntry(c), childDepth)));
    } else if (model.activeCodex) {
      parts.push(renderLiveStatusEntry(codexEntry(model.activeCodex), childDepth));
    }
    return parts.length > 0
      ? parts.join("")
      : `<div class="text-xs text-muted-foreground">No active lineage.</div>`;
  };

  const jobs = visibleJobs.length > 0
    ? visibleJobs.map(renderJobRow).join("")
    : `<div class="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">No recent jobs.</div>`;
  return `<div class="space-y-3 px-3 py-3 md:px-4">
    ${renderOpsSummary(model)}
    <section class="${softPanelClass} px-3 py-2.5">
      <div class="flex items-center gap-1.5 ${sectionLabelClass}">${iconRun("w-3.5 h-3.5")} Lineage</div>
      <div class="mt-2 space-y-1.5">
        ${lineageMarkup()}
      </div>
    </section>
    ${objective ? `<section class="${softPanelClass} px-3 py-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 ${sectionLabelClass}">${iconProject("w-3.5 h-3.5")} Project</div>
        ${badge(objective.status)}
      </div>
      <div class="mt-1.5 text-xs font-medium text-foreground">${esc(objective.title)}</div>
      ${objective.nextAction ? `<div class="mt-1 text-[11px] text-muted-foreground truncate">${esc(objective.nextAction)}</div>` : ""}
      ${objective.blockedExplanation || objective.blockedReason ? `<div class="mt-2 rounded-md border border-warning/20 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">${esc(objective.blockedExplanation ?? objective.blockedReason ?? "")}</div>` : ""}
      <div class="mt-2 flex flex-wrap gap-1.5">
        <a class="text-[10px] font-medium text-primary hover:underline" href="/factory/control?thread=${encodeURIComponent(objective.objectiveId)}">Inspect</a>
        <a class="text-[10px] font-medium text-muted-foreground hover:text-foreground" href="${esc(objective.receiptsLink)}">Receipts</a>
        <a class="text-[10px] font-medium text-muted-foreground hover:text-foreground" href="${esc(objective.debugLink)}">Debug</a>
      </div>
      <details class="mt-2">
        <summary class="cursor-pointer text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">Actions</summary>
        <div class="mt-1.5">${renderLocalObjectiveActions(objective)}</div>
      </details>
    </section>` : ""}
    <section class="${softPanelClass} px-3 py-2.5 factory-job-panel">
      <details ${visibleJobs.length > 0 ? "" : "open"}>
        <summary class="flex cursor-pointer list-none items-center justify-between gap-2">
          <span class="flex items-center gap-1.5 ${sectionLabelClass}">${iconJob("w-3.5 h-3.5")} Jobs</span>
          <span class="text-[10px] text-muted-foreground">${esc(`${visibleJobs.length}`)}</span>
        </summary>
        <div class="factory-job-list mt-2 grid gap-1.5">
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
<html class="dark h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Factory Chat</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
  <script src="/assets/htmx.min.js"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.1/sse.js"></script>
</head>
<body data-factory-chat class="overflow-x-hidden md:h-screen md:overflow-hidden" hx-ext="sse" sse-connect="/factory/events${shellQuery}">
  <div class="relative min-h-screen bg-background text-foreground md:h-screen">
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(13_73%_55%_/_0.06),transparent_40%),radial-gradient(circle_at_top_right,hsl(210_38%_65%_/_0.08),transparent_40%)]"></div>
    <div class="relative flex min-h-screen flex-col md:grid md:h-screen md:min-h-0 md:grid-cols-[220px_minmax(0,1fr)_280px] md:overflow-hidden">
      <aside class="order-2 min-w-0 overflow-hidden border-t border-sidebar-border bg-sidebar text-sidebar-foreground md:order-none md:min-h-0 md:border-r md:border-t-0">
        <div class="factory-scrollbar max-h-[40vh] overflow-x-hidden overflow-y-auto md:h-full md:max-h-none">
          <div id="factory-sidebar" hx-get="/factory/island/sidebar${shellQuery}" hx-trigger="${sidebarTrigger}" hx-swap="innerHTML">
            ${factoryRailIsland(model.sidebar)}
          </div>
        </div>
      </aside>
      <main class="order-1 min-w-0 overflow-hidden bg-background md:order-none md:min-h-0">
        <div class="flex min-h-screen flex-col md:h-full md:min-h-0">
          <header class="shrink-0 border-b border-border bg-card/80 backdrop-blur-xl">
            <div class="flex items-center justify-between gap-2 px-4 py-2">
              <div class="min-w-0 flex flex-1 items-center gap-2">
                <span class="flex items-center gap-1.5 ${sectionLabelClass}">${model.objectiveId ? iconProject("w-3.5 h-3.5") : iconChat("w-3.5 h-3.5")} ${model.objectiveId ? "Project" : "Chat"}</span>
                <h1 class="min-w-0 truncate text-sm font-semibold text-foreground" data-profile-label>${esc(shellHeaderTitle(model))}</h1>
                ${renderShellStatusPills(model)}
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
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
          <section class="shrink-0 border-t border-border bg-background px-3 py-2">
            <div class="mx-auto w-full max-w-3xl">
              <form id="factory-composer" action="/factory/compose${shellQuery}" method="post">
                ${currentJobId ? `<input type="hidden" name="currentJobId" value="${esc(currentJobId)}" />` : ""}
                <label class="sr-only" for="factory-prompt">Factory prompt</label>
                <div class="flex items-end gap-2">
                  <textarea id="factory-prompt" name="prompt" class="${composerTextareaClass}" rows="2" placeholder="${esc(composerPlaceholder)}" autofocus></textarea>
                  <button id="factory-composer-submit" class="shrink-0 rounded-lg border border-primary/40 bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90" type="submit">Send</button>
                </div>
                <div id="factory-composer-status" class="mt-2 hidden rounded-lg border border-border bg-muted px-3 py-1.5 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
              </form>
              <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                ${renderComposerPromptChips(model)}
                <details id="factory-command-help" class="inline">
                  <summary class="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">/ Commands</summary>
                  <div class="mt-1 text-xs leading-5 text-muted-foreground"><code>/new</code> <code>/react</code> <code>/steer</code> <code>/follow-up</code> <code>/abort-job</code> <code>/promote</code> <code>/cancel</code></div>
                </details>
              </div>
            </div>
          </section>
        </div>
      </main>
      <aside class="order-3 min-w-0 overflow-hidden border-t border-sidebar-border bg-sidebar text-sidebar-foreground md:min-h-0 md:border-l md:border-t-0">
        <div class="factory-scrollbar max-h-[45vh] overflow-x-hidden overflow-y-auto md:h-full md:max-h-none">
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
