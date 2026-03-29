import { MiniGFM } from "@oblivionocean/minigfm";

import {
  type Tone,
  badge,
  badgeToneClass,
  displayLabel,
  esc,
  formatTs,
  iconChat,
  iconCheckCircle,
  iconClock,
  iconCommit,
  iconCodex,
  iconForEntity,
  iconNext,
  iconProject,
  iconPullRequest,
  iconQueue,
  iconReceipt,
  iconRun,
  iconStatus,
  iconTask,
  iconTokens,
  iconBadgeToneClass,
  missionControlHotkeyClass,
  missionControlInsetClass,
  missionControlMonoClass,
  missionControlPanelClass,
  missionControlSectionLabelClass,
  liveIslandAttrs,
  sseConnectAttrs,
  renderEmptyState,
  renderJobActionCards,
  sectionLabelClass,
  shortHash,
  softPanelClass,
  statusDot,
  toneForValue,
  CSS_VERSION,
} from "./ui";

import {
  factoryInspectorIsland,
} from "./factory-inspector";
import { renderFactoryRunSteps } from "./factory-live-steps";
import { COMPOSER_COMMANDS } from "../factory-cli/composer";

const md = new MiniGFM();

const FACTORY_MARKDOWN_SECTION_HEADINGS = new Set([
  "conclusion",
  "evidence",
  "disagreements",
  "scripts run",
  "artifacts",
  "next steps",
  "next best action",
  "what's happening",
  "current signal",
  "blockers",
  "what i found",
  "why it matters",
  "scope",
  "next",
]);

const FACTORY_MARKDOWN_LIST_MARKER_RE = /^([-*+]|\d+[.)])\s+/;

const nextMeaningfulMarkdownLine = (
  lines: ReadonlyArray<string>,
  startIndex: number,
): string | undefined => {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
};

const isMarkdownListLine = (value: string): boolean => FACTORY_MARKDOWN_LIST_MARKER_RE.test(value);

const isLikelyMarkdownSectionHeading = (value: string): boolean => {
  const heading = value.replace(/:\s*$/, "").trim();
  const withoutParens = heading.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!heading || !withoutParens) return false;
  if (heading.length > 72) return false;
  if (!/^[A-Z0-9]/.test(heading)) return false;
  if (/[.!?;|]/.test(heading)) return false;
  const words = withoutParens.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 7;
};

const normalizeMarkdownHeadingDepth = (value: string): string => {
  const lines = value.split(/\r?\n/);
  let inFence = false;
  return lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    if (/^#\s+/.test(line)) return line.replace(/^#(\s+)/, "##$1");
    return line.replace(/^(#{5,})(\s+)/, "####$2");
  }).join("\n");
};

const normalizeMarkdownSectionHeadings = (value: string): string => {
  const lines = value.split(/\r?\n/);
  let inFence = false;
  return lines.map((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (
      inFence
      || !trimmed
      || trimmed.startsWith("#")
      || trimmed.startsWith("- ")
      || trimmed.includes("|")
      || /^\d+[.)]\s+/.test(trimmed)
    ) {
      return line;
    }
    const heading = trimmed.replace(/:\s*$/, "");
    const nextMeaningful = nextMeaningfulMarkdownLine(lines, index);
    const prevTrimmed = index > 0 ? lines[index - 1]?.trim() ?? "" : "";
    const nextTrimmed = index + 1 < lines.length ? lines[index + 1]?.trim() ?? "" : "";
    const isStandalone = (!prevTrimmed || index === 0) && (!nextTrimmed || index === lines.length - 1);
    const isLeadInBeforeList = trimmed.endsWith(":") && Boolean(nextMeaningful && isMarkdownListLine(nextMeaningful));
    return FACTORY_MARKDOWN_SECTION_HEADINGS.has(heading.toLowerCase())
      || (isStandalone && !isLeadInBeforeList && isLikelyMarkdownSectionHeading(trimmed))
      ? `## ${heading}`
      : line;
  }).join("\n");
};

const normalizeMarkdownLeadIns = (value: string): string => {
  const lines = value.split(/\r?\n/);
  let inFence = false;
  return lines.map((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (
      inFence
      || !trimmed
      || trimmed.startsWith("#")
      || trimmed.startsWith("- ")
      || trimmed.includes("|")
      || /^\d+[.)]\s+/.test(trimmed)
      || !trimmed.endsWith(":")
    ) {
      return line;
    }
    const label = trimmed.replace(/:\s*$/, "");
    const nextMeaningful = nextMeaningfulMarkdownLine(lines, index);
    const words = label.split(/\s+/).filter(Boolean);
    if (
      FACTORY_MARKDOWN_SECTION_HEADINGS.has(label.toLowerCase())
      || !nextMeaningful
      || !isMarkdownListLine(nextMeaningful)
      || words.length === 0
      || words.length > 5
      || label.length > 48
    ) {
      return line;
    }
    return `**${label}:**`;
  }).join("\n");
};

const normalizeInlineNumberedLists = (value: string): string => {
  const lines = value.split(/\r?\n/);
  let inFence = false;
  return lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (inFence || line.includes("|")) return line;
    const markers = [...line.matchAll(/(?:^|\s)(\d+)\)\s+/g)];
    if (markers.length < 2) return line;
    const firstMarker = markers[0];
    if (!firstMarker || typeof firstMarker.index !== "number") return line;
    const prefix = line.slice(0, firstMarker.index).trimEnd();
    const numbered = line.slice(firstMarker.index);
    const items = [...numbered.matchAll(/\d+\)\s*([^]+?)(?=(?:\s+\d+\)\s)|$)/g)]
      .map((match) => match[1]?.trim())
      .filter((item): item is string => Boolean(item));
    if (items.length === 0) return line;
    const list = items.map((item) => `- ${item}`).join("\n");
    return prefix ? `${prefix}\n\n${list}` : list;
  }).join("\n");
};

const normalizeMarkdownForDisplay = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return normalizeMarkdownHeadingDepth(
    normalizeInlineNumberedLists(
      normalizeMarkdownLeadIns(
        normalizeMarkdownSectionHeadings(trimmed),
      ),
    ),
  );
};

const renderMarkdown = (raw: string): string => {
  const text = normalizeMarkdownForDisplay(raw);
  if (!text) return `<p class="text-sm text-muted-foreground">Waiting for a response.</p>`;
  return md.parse(text);
};

import type {
  FactoryChatProfileNav,
  FactoryChatObjectiveNav,
  FactoryInspectorTab,
  FactorySelectedObjectiveCard,
  FactoryWorkCard,
  FactoryChatItem,
  FactoryChatIslandModel,
  FactoryChatShellModel,
  FactoryNavModel,
  FactoryLiveCodexCard,
  FactoryInspectorPanel,
  FactoryViewMode,
} from "./factory-models";

type FactoryChatRouteContext = {
  readonly mode?: FactoryViewMode;
  readonly profileId: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly panel?: FactoryInspectorPanel;
  readonly inspectorTab?: FactoryInspectorTab;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
};

const factoryChatQuery = (input: FactoryChatRouteContext): string => {
  const params = new URLSearchParams();
  if (input.mode === "mission-control") params.set("mode", input.mode);
  params.set("profile", input.profileId);
  if (input.chatId) params.set("chat", input.chatId);
  if (input.objectiveId) params.set("thread", input.objectiveId);
  if (input.runId) params.set("run", input.runId);
  if (input.jobId) params.set("job", input.jobId);
  if (input.panel) params.set("panel", input.panel);
  if (input.inspectorTab && input.inspectorTab !== "overview") params.set("inspectorTab", input.inspectorTab);
  if (input.focusKind && input.focusId) {
    params.set("focusKind", input.focusKind);
    params.set("focusId", input.focusId);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
};

const isMissionControlMode = (mode?: FactoryViewMode): boolean => mode === "mission-control";
const chatLiveRefreshOn = [
  { event: "agent-refresh", throttleMs: 180 },
  { event: "job-refresh", throttleMs: 180 },
  { event: "objective-runtime-refresh", throttleMs: 180 },
  { event: "factory-refresh", throttleMs: 180 },
  { kind: "body", event: "factory:chat-refresh" },
] as const;
const objectiveLiveRefreshOn = [
  { event: "profile-board-refresh", throttleMs: 450 },
  { event: "objective-runtime-refresh", throttleMs: 450 },
  { event: "factory-refresh", throttleMs: 450 },
  { kind: "body", event: "factory:scope-changed" },
] as const;

const modeSwitchHref = (
  routeContext: FactoryChatRouteContext,
  mode: FactoryViewMode,
): string => `/factory${factoryChatQuery({ ...routeContext, mode })}`;

const workbenchHref = (routeContext: FactoryChatRouteContext): string => {
  const params = new URLSearchParams();
  params.set("profile", routeContext.profileId);
  if (routeContext.chatId) params.set("chat", routeContext.chatId);
  if (routeContext.objectiveId) params.set("objective", routeContext.objectiveId);
  if (routeContext.inspectorTab) params.set("inspectorTab", routeContext.inspectorTab);
  if (routeContext.focusKind && routeContext.focusId) {
    params.set("focusKind", routeContext.focusKind);
    params.set("focusId", routeContext.focusId);
  }
  const query = params.toString();
  return `/factory/workbench${query ? `?${query}` : ""}`;
};

const factoryShellIslandBindings = (shellQuery: string) => ({
  sidebar: {
    path: `/factory/island/sidebar${shellQuery}`,
    refreshOn: objectiveLiveRefreshOn,
  },
  chat: {
    path: `/factory/island/chat${shellQuery}`,
    refreshOn: chatLiveRefreshOn,
  },
  inspector: {
    path: `/factory/island/inspector${shellQuery}`,
    refreshOn: objectiveLiveRefreshOn,
  },
});

const renderJobControls = (jobId: string, running?: boolean, abortRequested?: boolean): string =>
  running
    ? `<details class="mt-3 border border-border bg-background/70 px-3 py-2">
      <summary class="cursor-pointer list-none text-[11px] font-medium text-muted-foreground hover:text-foreground">Need to stop this job?</summary>
      <div class="mt-2">${renderJobActionCards(jobId, { abortRequested })}</div>
    </details>`
    : "";

const renderWorkControls = (card: FactoryWorkCard): string =>
  card.jobId ? renderJobControls(card.jobId, card.running, card.abortRequested) : "";

const shellPill = (label: string, tone: Tone = "neutral", icon?: string): string =>
  `<span class="inline-flex shrink-0 items-center gap-1.5  border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] whitespace-nowrap ${badgeToneClass(tone)}">${icon ?? ""}${esc(label)}</span>`;

const shellHeaderTitle = (model: FactoryChatShellModel): string =>
  model.inspector.selectedObjective?.title
    ?? (!model.objectiveId ? "New chat" : model.activeProfileLabel);

const shellProfileSummary = (model: FactoryChatShellModel): string | undefined =>
  model.chat.activeProfileSummary?.trim() || undefined;

const renderShellStatusPills = (model: FactoryChatShellModel): string => {
  const pills: string[] = [];
  const objective = model.inspector.selectedObjective;
  if (objective) {
    const phaseLabel = objective.displayState ?? displayLabel(objective.phase) ?? displayLabel(objective.status) ?? "active";
    pills.push(shellPill(`Objective ${phaseLabel}`, toneForValue(objective.displayState ?? objective.phase ?? objective.status), iconProject("h-3 w-3")));
    if (typeof objective.queuePosition === "number") pills.push(shellPill(`Queue #${objective.queuePosition}`, "warning", iconQueue("h-3 w-3")));
    if (typeof objective.tokensUsed === "number") pills.push(shellPill(`${objective.tokensUsed.toLocaleString()} tokens`, "info", iconTokens("h-3 w-3")));
  }
  if (model.inspector.activeCodex) {
    pills.push(shellPill(`Codex ${displayLabel(model.inspector.activeCodex.status) || "active"}`, toneForValue(model.inspector.activeCodex.status), iconCodex("h-3 w-3")));
  } else if (model.inspector.activeRun?.status) {
    pills.push(shellPill(`Run ${displayLabel(model.inspector.activeRun.status) || "active"}`, toneForValue(model.inspector.activeRun.status), iconRun("h-3 w-3")));
  }
  return pills.join("");
};

const composerCommandsJson = (): string => JSON.stringify(COMPOSER_COMMANDS.map((command) => ({
  name: command.name,
  label: command.label,
  usage: command.usage,
  description: command.description,
  aliases: command.aliases ?? [],
})));

const composerTextareaClass = "min-h-[88px] w-full flex-[1_1_0%] resize-none  border border-border bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/30 focus:bg-background focus-visible:ring-2 focus-visible:ring-ring/40";
const composerShellClass = "mx-auto w-full max-w-6xl";
const composerPanelClass = "relative flex flex-col gap-2";
const assistantResponseCardClass = "overflow-hidden border border-border/80 bg-card/90";
const assistantResponseBodyClass = "max-w-[72ch] px-4 py-3 sm:px-5 sm:py-4";

const composerJobId = (model: FactoryChatShellModel): string | undefined => {
  if (model.jobId) return model.jobId;
  if (model.inspector.activeCodex?.jobId) return model.inspector.activeCodex.jobId;
  const liveChild = model.inspector.liveChildren?.find((child) => !isTerminalJobStatusValue(child.status));
  if (liveChild?.jobId) return liveChild.jobId;
  return model.inspector.jobs.find((job) =>
    job.status === "queued" || job.status === "leased" || job.status === "running"
  )?.jobId;
};

const compactStatusText = (value: string, maxChars = 160): string => {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentence = text.match(/^(.{1,160}?[.!?])(\s|$)/)?.[1] ?? text;
  const clipped = sentence.length > maxChars ? `${sentence.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…` : sentence;
  return clipped;
};

const titleCaseLabel = (value?: string): string => {
  const label = displayLabel(value);
  return label ? label.replace(/\b\w/g, (match) => match.toUpperCase()) : "";
};

const withQueryParam = (query: string, key: string, value: string): string =>
  `${query}${query.includes("?") ? "&" : "?"}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;

const factoryEventsPath = (query: string): string => `/factory/events${query}`;

const headerProfileSelectClass = "min-w-[11rem]  border border-border bg-background px-3 py-2 text-sm font-medium text-foreground outline-none transition hover:bg-accent hover:text-foreground focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/30";

const renderHeaderProfileSelect = (input: {
  readonly id: string;
  readonly label: string;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
}): string => {
  if (input.profiles.length === 0) return "";
  return `<select id="${esc(input.id)}" aria-label="${esc(input.label)}" data-factory-profile-select="true" class="${headerProfileSelectClass}">
    ${input.profiles.map((profile) => `<option value="${esc(profile.href)}"${profile.selected ? " selected" : ""}>${esc(profile.label)}</option>`).join("")}
  </select>`;
};

export const renderFactoryStreamingShell = (
  profileLabel: string,
  options?: {
    readonly liveMode?: "sse" | "js";
  },
): string => `<div id="factory-chat-streaming" class="space-y-2" aria-live="polite">
  <section data-factory-stream-shell class="flex justify-start">
    <div class="w-full max-w-3xl space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-1.5 ${sectionLabelClass}">${iconChat("w-3.5 h-3.5")} <span id="factory-chat-streaming-label-text">${esc(profileLabel)}</span></div>
        <span class="text-[11px] text-muted-foreground">Streaming</span>
      </div>
      <div class="${assistantResponseCardClass}">
        <div class="${assistantResponseBodyClass}">
          <div
            id="factory-chat-streaming-content"
            class="whitespace-pre-wrap text-sm leading-6 text-foreground"
            ${options?.liveMode === "js"
              ? ""
              : 'sse-swap="factory-stream-token" hx-swap="beforeend"'}
          ></div>
        </div>
      </div>
    </div>
  </section>
  <div
    id="factory-chat-stream-reset-listener"
    class="hidden"
    aria-hidden="true"
    ${options?.liveMode === "js"
      ? ""
      : 'sse-swap="factory-stream-reset" hx-swap="none"'}
  ></div>
</div>`;

export const renderFactoryStreamingTokenFragment = (input: {
  readonly delta: string;
  readonly runId?: string;
}): string => `<span${input.runId ? ` data-run-id="${esc(input.runId)}"` : ""}>${esc(input.delta)}</span>`;

export const renderFactoryStreamingResetFragment = (): string =>
  '<div id="factory-chat-streaming-content" hx-swap-oob="innerHTML"></div>';

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

const looksLikeTechnicalStatusSummary = (value?: string): boolean => {
  const text = value?.trim();
  if (!text) return false;
  return /^command (?:completed|failed|started|running):/i.test(text)
    || /^\/bin\/(?:bash|zsh)\b/i.test(text)
    || /^receipt\b/i.test(text);
};

const liveOutputCardHeading = (card: FactoryWorkCard): string =>
  compactStatusText(
    card.subject
      ? `Working on ${card.subject}`
      : card.focusKind === "job"
        ? "Current job progress"
        : "Current task progress",
    140,
  ) || "Current progress";

const liveOutputCardSummary = (card: FactoryWorkCard): string => {
  const primary = compactStatusText(card.latestNote ?? "", 180);
  if (primary) return primary;
  const fallback = looksLikeTechnicalStatusSummary(card.summary)
    ? ""
    : compactStatusText(card.summary, 180);
  return fallback || "Factory is still working on this.";
};

const liveOutputCardSupport = (card: FactoryWorkCard): string | undefined => {
  const summary = compactStatusText(card.summary, 180);
  if (!summary || looksLikeTechnicalStatusSummary(summary) || summary === liveOutputCardSummary(card)) return undefined;
  return summary;
};

const renderLiveOutputWorkCard = (card: FactoryWorkCard): string => {
  const metadata = [
    card.taskId ? `Task ${card.taskId}` : undefined,
    card.candidateId ? `Candidate ${card.candidateId}` : undefined,
    card.jobId ? `Job ${card.jobId}` : undefined,
    card.meta,
  ].filter((value): value is string => Boolean(value));
  return `<section class="border border-border bg-muted/45 px-3 py-3">
    <div class="flex min-w-0 items-center justify-between gap-2">
      <div class="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        ${iconForEntity(card.worker, "w-3 h-3 text-muted-foreground shrink-0 self-center")}
        <span class="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">${esc(card.worker)}</span>
        <span class="text-xs font-semibold text-foreground">${esc(card.focusKind === "job" ? "Job Update" : "Task Update")}</span>
      </div>
      ${badge(card.status)}
    </div>
    <div class="mt-2 text-sm font-semibold text-foreground">${esc(liveOutputCardHeading(card))}</div>
    <div class="mt-1 text-sm leading-6 text-muted-foreground">${esc(liveOutputCardSummary(card))}</div>
    ${liveOutputCardSupport(card) ? `<div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(liveOutputCardSupport(card)!)}</div>` : ""}
    ${metadata.length > 0 ? `<div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      ${metadata.map((value) => `<span class="rounded-full border border-border bg-background px-2 py-1">${esc(value)}</span>`).join("")}
    </div>` : ""}
    ${(card.artifactSummary || card.stdoutTail || card.stderrTail || card.detail || card.link) ? `<details class="mt-3 border border-border bg-background/70 px-3 py-2">
      <summary class="cursor-pointer list-none text-[11px] font-medium text-muted-foreground hover:text-foreground">More details</summary>
      <div class="mt-2 space-y-3">
        ${card.artifactSummary ? `<div class="text-xs leading-5 text-muted-foreground">${esc(card.artifactSummary)}</div>` : ""}
        ${card.stdoutTail ? `<section class="border border-border bg-muted/25">
          <div class="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Recent output</div>
          <pre class="max-h-40 overflow-auto px-3 py-3 text-[11px] leading-5 text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(card.stdoutTail)}</pre>
        </section>` : ""}
        ${card.stderrTail ? `<section class="border border-destructive/30 bg-destructive/5">
          <div class="border-b border-destructive/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-destructive">Error output</div>
          <pre class="max-h-40 overflow-auto px-3 py-3 text-[11px] leading-5 text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(card.stderrTail)}</pre>
        </section>` : ""}
        ${card.detail ? `<pre class="max-h-32 overflow-auto bg-muted/25 px-3 py-3 text-[11px] leading-5 text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(card.detail)}</pre>` : ""}
        ${card.link ? `<a class="inline-flex text-[11px] font-medium text-primary transition hover:text-primary/80" href="${esc(card.link)}">Inspect</a>` : ""}
      </div>
    </details>` : ""}
    ${renderWorkControls(card)}
  </section>`;
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
  context: {
    readonly mode?: FactoryViewMode;
    readonly activeProfileId: string;
    readonly activeProfileLabel: string;
    readonly chatId?: string;
    readonly objectiveHref?: (objectiveId: string) => string;
  },
): string => {
  if (item.kind === "user") {
    return `<section class="flex justify-end">
      <div class="max-w-3xl space-y-1">
        ${item.meta ? `<div class="text-right text-[11px] text-muted-foreground">${esc(item.meta)}</div>` : ""}
        <div class="border border-border bg-muted/45 px-4 py-2.5 text-sm leading-6 text-foreground">
          ${esc(item.body)}
        </div>
      </div>
    </section>`;
  }
  if (item.kind === "assistant") {
    return `<section class="flex justify-start">
      <div class="w-full max-w-3xl space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-1.5 ${sectionLabelClass}">${iconChat("w-3.5 h-3.5")} ${esc(context.activeProfileLabel)}</div>
          ${item.meta ? `<span class="text-[11px] text-muted-foreground">${esc(item.meta)}</span>` : ""}
        </div>
        <div class="${assistantResponseCardClass}">
          <div class="${assistantResponseBodyClass}">
            <div class="factory-markdown">${renderMarkdown(item.body)}</div>
          </div>
        </div>
      </div>
    </section>`;
  }
  if (item.kind === "system") {
    const tone = systemItemTone(item);
    const body = splitSystemBody(item.body);
    return `<section class="border px-3 py-2 ${iconBadgeToneClass(tone)} bg-muted/45">
      <div class="flex min-w-0 items-center justify-between gap-2">
        <div class="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="text-xs font-semibold text-foreground">${esc(item.title)}</span>
          ${body.summary ? `<span class="min-w-0 text-xs leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:1] overflow-hidden">${esc(body.summary)}</span>` : ""}
        </div>
        ${badge(systemBadgeLabel(item), tone)}
      </div>
      ${body.detail ? `<details class="mt-1.5 border border-border bg-muted/45 px-2.5 py-2">
        <summary class="cursor-pointer list-none text-[11px] font-medium text-muted-foreground">Details</summary>
        <div class="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">${esc(body.detail)}</div>
      </details>` : ""}
    </section>`;
  }
  if (item.kind === "objective_event") {
    const href = context.objectiveHref
      ? context.objectiveHref(item.objectiveId)
      : `/factory${factoryChatQuery({
          mode: context.mode,
          profileId: context.activeProfileId,
          chatId: context.chatId,
          objectiveId: item.objectiveId,
          panel: "overview",
        })}`;
    return `<a class="block border-l-2 border-primary px-3 py-2 transition hover:bg-accent/40"
      href="${href}">
      <div class="flex items-center gap-2 text-sm font-semibold text-primary">
        ${iconProject("w-4 h-4")} ${esc(item.title)}
      </div>
      <div class="mt-1 text-xs text-foreground">${esc(item.summary)}</div>
    </a>`;
  }
  const card = item.card;
  if (card.variant === "live-output") return renderLiveOutputWorkCard(card);
  return `<section class="border border-border bg-muted/45 px-3 py-2">
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
        ${card.detail ? `<pre class="max-h-32 overflow-auto  bg-background px-2 py-1.5 text-[11px] leading-4 text-card-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(card.detail)}</pre>` : ""}
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
  context: {
    readonly mode?: FactoryViewMode;
    readonly activeProfileId: string;
    readonly activeProfileLabel: string;
    readonly chatId?: string;
  },
): string => {
  const latest = items[items.length - 1]!;
  const earlier = items.slice(0, -1);
  const latestHtml = renderChatItem(latest, context);
  return `<div class="space-y-1">
    <details>
      <summary class="cursor-pointer list-none px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition">${esc(`Earlier progress (${earlier.length})`)}</summary>
      <div class="mt-1 space-y-1">
        ${earlier.map((item) => renderChatItem(item, context)).join("")}
      </div>
    </details>
    ${latestHtml}
  </div>`;
};

const renderLiveExecutionCard = (
  title: string,
  card: Pick<FactoryLiveCodexCard, "jobId" | "status" | "summary" | "latestNote" | "task" | "tokensUsed" | "updatedAt" | "rawLink">,
): string => {
  const note = compactStatusText(card.latestNote ?? card.summary, 220) || card.summary;
  return `<section class="${softPanelClass} px-4 py-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <div class="${sectionLabelClass}">${esc(title)}</div>
          ${badge(displayLabel(card.status), toneForValue(card.status))}
        </div>
        <div class="mt-1 text-sm font-semibold text-foreground">${esc(card.task ?? "Codex is working")}</div>
        <div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(note)}</div>
      </div>
      <a class="shrink-0 text-[11px] font-medium text-primary transition hover:text-primary/80" href="${esc(card.rawLink)}">Inspect</a>
    </div>
    ${(card.updatedAt || typeof card.tokensUsed === "number")
      ? `<div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        ${card.updatedAt ? `<span>${esc(formatTs(card.updatedAt))}</span>` : ""}
        ${typeof card.tokensUsed === "number" ? shellPill(`${card.tokensUsed.toLocaleString()} tokens`, "info", iconTokens("h-3 w-3")) : ""}
      </div>`
      : ""}
  </section>`;
};

const renderLiveCodexExecution = (model: FactoryChatIslandModel): string => {
  const codexCards: Array<Pick<FactoryLiveCodexCard, "jobId" | "status" | "summary" | "latestNote" | "task" | "tokensUsed" | "updatedAt" | "rawLink">> = [];
  if (model.activeCodex) codexCards.push(model.activeCodex);
  const childCodex = (model.liveChildren ?? [])
    .filter((child) => child.worker === "codex" || child.agentId === "codex")
    .filter((child) => child.jobId !== model.activeCodex?.jobId);
  codexCards.push(...childCodex);
  if (codexCards.length === 0) return "";
  return `<section class="space-y-2">
    <div class="flex items-center justify-between gap-2">
      <div class="${sectionLabelClass}">Live</div>
      <div class="text-[11px] text-muted-foreground">${esc(`${codexCards.length}`)}</div>
    </div>
    ${codexCards.map((card, index) => renderLiveExecutionCard(index === 0 ? "Active Codex" : `Codex Worker ${index + 1}`, card)).join("")}
  </section>`;
};

type ThreadTaskCard = {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly isActive: boolean;
  readonly isReady: boolean;
};

const describeTaskDependencies = (
  task: ThreadTaskCard,
  taskById: ReadonlyMap<string, ThreadTaskCard>,
): string | undefined => {
  if (task.dependsOn.length === 0) return undefined;
  const labels = task.dependsOn.map((taskId) => {
    const dependency = taskById.get(taskId);
    return dependency?.title ?? taskId;
  });
  if (task.status === "pending") return `Waiting on ${labels.join(", ")}`;
  return `Depends on ${labels.join(", ")}`;
};

const renderThreadSummaryCard = (
  input: {
    readonly label: string;
    readonly title: string;
    readonly detail: string;
    readonly tone?: Tone;
    readonly icon: string;
    readonly stateLabel?: string;
  },
): string => `<section class="${softPanelClass} px-4 py-3">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0 flex flex-1 items-start gap-3">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center border ${iconBadgeToneClass(input.tone ?? "neutral")}">
        ${input.icon}
      </span>
      <div class="min-w-0">
        <div class="${sectionLabelClass}">${esc(input.label)}</div>
        <div class="mt-1 text-sm font-semibold text-foreground">${esc(input.title)}</div>
      </div>
    </div>
    ${input.stateLabel ? shellPill(input.stateLabel, input.tone ?? "neutral") : ""}
  </div>
  <div class="mt-3 text-xs leading-5 text-muted-foreground">${esc(input.detail)}</div>
</section>`;

const renderThreadOverview = (model: FactoryChatIslandModel, thread?: FactorySelectedObjectiveCard): string => {
  const tasks: ReadonlyArray<ThreadTaskCard> = model.workbench?.tasks ?? [];
  const taskById = new Map(tasks.map((task) => [task.taskId, task] as const));
  const activeTask = tasks.find((task) => task.isActive);
  const readyTask = tasks.find((task) => task.isReady) ?? tasks.find((task) => task.status === "pending");
  const blockedTask = tasks.find((task) => task.status === "blocked");

  const currentTitle = activeTask?.title
    ?? model.activeCodex?.task
    ?? (thread ? displayLabel(thread.phase || thread.status) || thread.title : "No active work");
  const currentDetail = compactStatusText(
    model.activeCodex?.latestNote
      ?? model.activeCodex?.summary
      ?? activeTask?.latestSummary
      ?? model.activeRun?.summary
      ?? thread?.summary
      ?? "No task is currently running.",
    180,
  ) || "No task is currently running.";

  const nextTitle = readyTask?.title ?? "No queued task";
  const nextDetail = compactStatusText(
    (readyTask ? describeTaskDependencies(readyTask, taskById) : undefined)
      ?? readyTask?.latestSummary
      ?? (readyTask?.isReady ? "Ready to run." : undefined)
      ?? thread?.nextAction
      ?? "Nothing else is waiting right now.",
    180,
  ) || "Nothing else is waiting right now.";

  const statusLabel = blockedTask || thread?.blockedReason ? "Blocked" : "Status";
  const statusTone: Tone = blockedTask || thread?.blockedReason ? "warning" : "neutral";
  const statusTitle = blockedTask?.title
    ?? (thread ? `${thread.activeTaskCount ?? 0} active · ${thread.readyTaskCount ?? 0} ready · ${thread.taskCount ?? 0} total` : "Idle");
  const statusDetail = compactStatusText(
    blockedTask?.blockedReason
      ?? thread?.blockedExplanation
      ?? thread?.blockedReason
      ?? thread?.summary
      ?? "This thread is updating in place from the current workflow state.",
    180,
  ) || "This thread is updating in place from the current workflow state.";

  return `<section class="grid gap-2 md:grid-cols-3">
    ${renderThreadSummaryCard({
      label: "Current",
      title: currentTitle,
      detail: currentDetail,
      tone: activeTask || model.activeCodex ? "info" : "neutral",
      icon: iconRun("h-4 w-4"),
      stateLabel: activeTask || model.activeCodex ? "Live" : (displayLabel(thread?.phase || thread?.status) || "Idle"),
    })}
    ${renderThreadSummaryCard({
      label: "Next",
      title: nextTitle,
      detail: nextDetail,
      tone: readyTask?.isReady ? "success" : "neutral",
      icon: iconNext("h-4 w-4"),
      stateLabel: readyTask?.isReady ? "Ready" : (readyTask ? "Queued" : "Clear"),
    })}
    ${renderThreadSummaryCard({
      label: statusLabel,
      title: statusTitle,
      detail: statusDetail,
      tone: statusTone,
      icon: iconStatus("h-4 w-4"),
      stateLabel: blockedTask || thread?.blockedReason ? "Blocked" : (displayLabel(thread?.phase || thread?.status) || "Snapshot"),
    })}
  </section>`;
};

const renderObjectiveTasks = (tasks?: ReadonlyArray<ThreadTaskCard>): string => {
  if (!tasks || tasks.length === 0) return "";
  const taskById = new Map(tasks.map((task) => [task.taskId, task] as const));
  return `<section class="space-y-2">
    <div class="flex items-center justify-between gap-2">
      <div class="${sectionLabelClass}">Tasks</div>
      <div class="text-[11px] text-muted-foreground">${esc(`${tasks.length}`)}</div>
    </div>
    <div class="overflow-hidden border border-border bg-card">
      ${tasks.map((task, index) => {
        const dependencyText = describeTaskDependencies(task, taskById);
        const note = task.blockedReason
          ?? (task.isActive ? task.latestSummary ?? "Running now." : undefined)
          ?? (task.isReady ? task.latestSummary ?? "Ready to run." : undefined)
          ?? task.latestSummary
          ?? dependencyText;
        const rowClass = task.isActive
          ? "bg-primary/5"
          : task.status === "blocked"
            ? "bg-warning/5"
            : "";
        return `<section class="px-4 py-3 ${rowClass} ${index > 0 ? "border-t border-border" : ""}">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-3">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center  border border-border bg-background text-[10px] font-semibold text-muted-foreground">${index + 1}</span>
                <div class="min-w-0">
                  <div class="text-sm font-semibold text-foreground truncate">${esc(task.title)}</div>
                  ${note ? `<div class="mt-0.5 text-xs leading-5 text-muted-foreground">${esc(note)}</div>` : ""}
                </div>
              </div>
            </div>
            ${badge(displayLabel(task.status), toneForValue(task.status))}
          </div>
        </section>`;
      }).join("")}
    </div>
  </section>`;
};

const renderRunningWorkbench = (model: FactoryChatIslandModel): string => {
  const workbench = model.workbench;
  if (!workbench || !workbench.hasActiveExecution) return "";
  const thread = model.selectedThread;
  const focus = workbench.focus;
  const focusedTask = workbench.focusedTask;
  const focusSummary = compactStatusText(
    focus?.summary
      ?? focusedTask?.latestSummary
      ?? workbench.summary.latestDecisionSummary
      ?? workbench.summary.nextAction
      ?? "Live task state is updating in the inspector.",
    180,
  ) || "Live task state is updating in the inspector.";
  const telemetryNote = focus?.active
    ? "Recent Activity shows live inner steps from the active task pass. The objective stays in progress until the task reports a result, blocks, or fails."
    : undefined;
  return `<section class="space-y-2">
    <section class="${softPanelClass} px-4 py-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold text-foreground truncate">${esc(thread?.title ?? workbench.summary.title)}</div>
          <div class="mt-1 text-xs text-muted-foreground">${esc(focusSummary)}</div>
          ${telemetryNote ? `<div class="mt-1 text-[11px] leading-5 text-muted-foreground/90">${esc(telemetryNote)}</div>` : ""}
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          ${badge(`Objective ${displayLabel(workbench.summary.phase) || workbench.summary.phase}`, toneForValue(workbench.summary.phase))}
          ${focus ? badge(displayLabel(focus.status), toneForValue(focus.status)) : ""}
        </div>
      </div>
    </section>
    ${renderThreadOverview(model, thread)}
  </section>`;
};

const renderCompactObjectiveFraming = (thread?: FactorySelectedObjectiveCard): string => {
  if (!thread) return "";
  return `<section class="${softPanelClass} px-4 py-3">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="${sectionLabelClass}">Objective</div>
        <div class="mt-1 text-sm font-semibold text-foreground">${esc(thread.title)}</div>
        ${thread.bottomLine ? `<div class="mt-2 text-xs leading-5 text-muted-foreground">${esc(thread.bottomLine)}</div>` : ""}
      </div>
      ${badge(thread.displayState ?? displayLabel(thread.phase || thread.status) ?? "Active", toneForValue(thread.displayState ?? thread.phase ?? thread.status))}
    </div>
    ${thread.lifecycleSteps?.length ? `<div class="mt-3 grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
      ${thread.lifecycleSteps.map((step) => `<div class=" border px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${step.state === "done"
        ? "border-success/20 bg-success/10 text-success"
        : step.state === "current"
          ? "border-primary/20 bg-primary/10 text-primary"
          : step.state === "paused"
            ? "border-warning/20 bg-warning/10 text-warning"
            : "border-border bg-background text-muted-foreground"}">${esc(step.label)}</div>`).join("")}
    </div>` : ""}
    ${thread.evidenceStats?.length ? `<div class="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      ${thread.evidenceStats.slice(0, 4).map((stat) => `<div class=" border border-border bg-background px-3 py-2">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">${esc(stat.label)}</div>
        <div class="mt-1 text-sm font-semibold text-foreground">${esc(stat.value)}</div>
      </div>`).join("")}
    </div>` : ""}
    ${thread.nextAction ? `<div class="mt-3 text-xs text-muted-foreground"><span class="font-medium text-foreground">Next step:</span> ${esc(thread.nextAction)}</div>` : ""}
  </section>`;
};

const renderCenterWorkbench = (model: FactoryChatIslandModel): string => {
  const thread = model.selectedThread;
  const jobs = model.jobs ?? [];
  const hasLiveWork = Boolean(model.activeRun || model.activeCodex || (model.liveChildren?.length ?? 0) > 0);
  const liveCodexSection = renderLiveCodexExecution(model);
  const liveStepsSection = renderFactoryRunSteps(model.activeRun, {
    title: "What's Happening",
    subtitle: "Recent supervisor steps update automatically while this thread is active.",
  });
  const tasksSection = renderObjectiveTasks(model.workbench?.tasks);
  const runningWorkbench = renderRunningWorkbench(model);
  if (!thread && !hasLiveWork && jobs.length === 0 && !liveCodexSection && !liveStepsSection && !tasksSection && !runningWorkbench) return "";
  return `<section class="space-y-2">
    ${renderCompactObjectiveFraming(thread)}
    ${runningWorkbench || renderThreadOverview(model, thread)}
    ${liveStepsSection}
    ${tasksSection}
    ${thread ? "" : liveCodexSection}
  </section>`;
};

const isTerminalTaskCardStatus = (status?: string): boolean =>
  status === "approved" || status === "blocked" || status === "integrated" || status === "superseded";

const renderMissionControlProgressCard = (model: FactoryChatIslandModel): string => {
  const workbench = model.workbench;
  const tasks = workbench?.tasks ?? [];
  const completedCount = tasks.filter((task) => isTerminalTaskCardStatus(task.status)).length;
  const totalCount = tasks.length;
  const percent = totalCount > 0 ? Math.max(4, Math.round((completedCount / totalCount) * 100)) : 0;
  const summary = workbench?.summary;
  const nextSignal = compactStatusText(
    workbench?.focus?.summary
      ?? workbench?.summary.nextAction
      ?? workbench?.summary.latestDecisionSummary
      ?? model.selectedThread?.nextAction
      ?? model.selectedThread?.summary
      ?? "Pick a thread or send a prompt to start work.",
    180,
  ) || "Pick a thread or send a prompt to start work.";
  const phaseLabel = displayLabel(summary?.phase || model.selectedThread?.phase || model.selectedThread?.status || "idle") || "idle";
  return `<section class="${missionControlPanelClass} p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="${missionControlSectionLabelClass}">Objective Progress</div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <div class="text-xl font-semibold tracking-tight text-foreground">${esc(`${completedCount}/${totalCount || 0}`)}</div>
          ${badge(`Phase ${phaseLabel}`, toneForValue(summary?.phase || model.selectedThread?.phase || model.selectedThread?.status))}
        </div>
      </div>
      <div class="grid min-w-[220px] grid-cols-2 gap-2 text-right">
        <div class="${missionControlInsetClass} px-3 py-2">
          <div class="${missionControlSectionLabelClass}">Active</div>
          <div class="mt-1 text-base font-semibold text-foreground">${esc(String(summary?.activeTaskCount ?? 0))}</div>
        </div>
        <div class="${missionControlInsetClass} px-3 py-2">
          <div class="${missionControlSectionLabelClass}">Ready</div>
          <div class="mt-1 text-base font-semibold text-foreground">${esc(String(summary?.readyTaskCount ?? 0))}</div>
        </div>
      </div>
    </div>
    <div class="mt-4 mission-control-track">${percent > 0 ? `<span style="width:${percent}%"></span>` : `<span style="width:0%"></span>`}</div>
    <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
      <div class="text-sm text-muted-foreground">${esc(nextSignal)}</div>
      <div class="flex flex-wrap gap-2">
        ${typeof summary?.checksCount === "number" && summary.checksCount > 0 ? `<span class="${missionControlHotkeyClass}">${esc(`${summary.checksCount} checks`)}</span>` : ""}
        ${typeof summary?.elapsedMinutes === "number" && summary.elapsedMinutes > 0 ? `<span class="${missionControlHotkeyClass}">${esc(`${summary.elapsedMinutes} min`)}</span>` : ""}
      </div>
    </div>
  </section>`;
};

const renderMissionControlFocusCard = (model: FactoryChatIslandModel): string => {
  const workbench = model.workbench;
  const focus = workbench?.focus;
  const focusedTask = workbench?.focusedTask;
  const activeCodex = model.activeCodex;
  const title = focus?.title
    ?? focusedTask?.title
    ?? activeCodex?.task
    ?? model.selectedThread?.title
    ?? `${model.activeProfileLabel} queue`;
  const status = focus?.status
    ?? focusedTask?.status
    ?? activeCodex?.status
    ?? model.selectedThread?.phase
    ?? model.selectedThread?.status;
  const summary = compactStatusText(
    focus?.summary
      ?? focus?.lastMessage
      ?? focus?.stdoutTail
      ?? focusedTask?.latestSummary
      ?? activeCodex?.latestNote
      ?? activeCodex?.summary
      ?? model.activeRun?.summary
      ?? model.selectedThread?.summary
      ?? "No live task selected.",
    240,
  ) || "No live task selected.";
  const meta: string[] = [];
  if (focus?.focusKind && focus?.focusId) meta.push(`${focus.focusKind} ${focus.focusId}`);
  if (focusedTask?.taskId) meta.push(`task ${focusedTask.taskId}`);
  if (activeCodex?.jobId) meta.push(`job ${activeCodex.jobId}`);
  return `<section class="${missionControlPanelClass} p-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="${missionControlSectionLabelClass}">Current Signal</div>
        <div class="mt-2 text-lg font-semibold leading-tight text-foreground">${esc(title)}</div>
      </div>
      ${status ? badge(displayLabel(status), toneForValue(status)) : ""}
    </div>
    <div class="mt-3 text-sm leading-6 text-muted-foreground">${esc(summary)}</div>
    ${meta.length ? `<div class="mt-4 flex flex-wrap gap-2">${meta.map((item) => `<span class="${missionControlHotkeyClass}">${esc(item)}</span>`).join("")}</div>` : ""}
  </section>`;
};

const renderMissionControlTaskList = (
  model: FactoryChatIslandModel,
  routeContext: FactoryChatRouteContext,
): string => {
  const tasks = model.workbench?.tasks ?? [];
  if (tasks.length === 0) {
    return `<section class="${missionControlPanelClass} p-4">
      <div class="flex items-center justify-between gap-2">
        <div class="${missionControlSectionLabelClass}">Task Board</div>
        <div class="text-[11px] text-muted-foreground">0</div>
      </div>
      <div class="mt-4 text-sm text-muted-foreground">Task state will appear here when a thread has a workbench projection.</div>
    </section>`;
  }
  const taskById = new Map(tasks.map((task) => [task.taskId, task] as const));
  return `<section class="${missionControlPanelClass} p-4">
    <div class="flex items-center justify-between gap-2">
      <div class="${missionControlSectionLabelClass}">Task Board</div>
      <div class="text-[11px] text-muted-foreground">${esc(`${tasks.length}`)}</div>
    </div>
    <div class="mt-3 space-y-2">
      ${tasks.map((task, index) => {
        const note = compactStatusText(
          task.blockedReason
            ?? task.latestSummary
            ?? describeTaskDependencies(task, taskById)
            ?? (task.isReady ? "Ready to run." : undefined)
            ?? (task.isActive ? "Running now." : undefined)
            ?? "",
          120,
        );
        const href = `/factory${factoryChatQuery({
          ...routeContext,
          panel: "execution",
          focusKind: "task",
          focusId: task.taskId,
        })}`;
        const stateTone = toneForValue(task.status);
        const rowClass = task.isActive
          ? "border-primary/25 bg-primary/10"
          : task.isReady
            ? "border-success/25 bg-success/10"
            : task.status === "blocked"
              ? "border-warning/25 bg-warning/10"
              : "border-border/70 bg-muted/45";
        return `<a href="${href}" class="block ${missionControlInsetClass} ${rowClass} px-3 py-3 transition hover:bg-accent/60">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center  border border-border/80 bg-background/80 text-[10px] font-semibold text-muted-foreground">${index + 1}</span>
                <div class="text-sm font-semibold leading-5 text-foreground">${esc(task.title)}</div>
              </div>
              ${note ? `<div class="mt-1.5 text-xs leading-5 text-muted-foreground">${esc(note)}</div>` : ""}
            </div>
            <div class="flex shrink-0 items-center gap-2">
              ${statusDot(stateTone)}
              <span class="${missionControlMonoClass} text-muted-foreground">${esc(task.taskId)}</span>
            </div>
          </div>
        </a>`;
      }).join("")}
    </div>
  </section>`;
};

const renderMissionControlActivityLog = (model: FactoryChatIslandModel): string => {
  const activity = model.workbench?.activity ?? [];
  if (activity.length === 0) {
    return `<section class="${missionControlPanelClass} p-4">
      <div class="flex items-center justify-between gap-2">
        <div class="${missionControlSectionLabelClass}">Decision Log</div>
        <div class="text-[11px] text-muted-foreground">0</div>
      </div>
      <div class="mt-4 text-sm text-muted-foreground">Supervisor and receipt activity will appear here once work starts.</div>
    </section>`;
  }
  return `<section class="${missionControlPanelClass} p-4">
    <div class="flex items-center justify-between gap-2">
      <div class="${missionControlSectionLabelClass}">Decision Log</div>
      <div class="text-[11px] text-muted-foreground">${esc(`${activity.length}`)}</div>
    </div>
    <div class="mt-3 space-y-2">
      ${activity.slice(0, 8).map((entry) => {
        const toneClass = entry.emphasis === "danger"
          ? "text-destructive"
          : entry.emphasis === "warning"
            ? "text-warning"
            : entry.emphasis === "success"
              ? "text-success"
              : entry.emphasis === "accent"
                ? "text-primary"
                : "text-muted-foreground";
        return `<div class="${missionControlInsetClass} px-3 py-2.5">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-semibold text-foreground">${esc(entry.title)}</div>
              <div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(entry.summary)}</div>
            </div>
            <div class="shrink-0 ${missionControlMonoClass} ${toneClass}">${esc(entry.kind)}</div>
          </div>
          <div class="mt-2 ${missionControlMonoClass} text-muted-foreground">${esc(entry.meta)}</div>
        </div>`;
      }).join("")}
    </div>
  </section>`;
};

const renderMissionControlTranscriptSection = (
  model: FactoryChatIslandModel,
  body: string,
  itemCount: number,
): string => `<section class="${missionControlPanelClass} p-4">
  <div class="flex items-center justify-between gap-2">
    <div class="${missionControlSectionLabelClass}">Transcript</div>
    <div class="text-[11px] text-muted-foreground">${esc(`${itemCount}`)}</div>
  </div>
  <div class="mt-3 space-y-3">${body}</div>
</section>`;

const renderMissionControlChatIsland = (model: FactoryChatIslandModel): string => {
  const routeContext: FactoryChatRouteContext = {
    mode: model.mode,
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    runId: model.runId,
    jobId: model.jobId,
    panel: model.panel,
    inspectorTab: model.inspectorTab,
    focusKind: model.focusKind,
    focusId: model.focusId,
  };
  const transcriptItems = synthesizedTranscriptItems(model);
  const grouped = groupChatItems(transcriptItems);
  const renderContext = {
    mode: model.mode,
    activeProfileId: model.activeProfileId,
    activeProfileLabel: model.activeProfileLabel,
    chatId: model.chatId,
  };
  const transcriptBody = grouped.length > 0
    ? grouped.map((group) =>
      group.kind === "single"
        ? renderChatItem(group.item, renderContext)
        : renderWorkGroup(group.items, renderContext)
    ).join("")
    : renderTranscriptEmptyState(model);
  const liveStepsSection = renderFactoryRunSteps(model.activeRun, {
    title: "Progress Log",
    subtitle: "Recent supervisor steps and worker updates land here while the thread is active.",
  });
  const liveCodexSection = model.selectedThread ? "" : renderLiveCodexExecution(model);
  return `<div class="chat-stack mx-auto flex w-full max-w-[1440px] flex-col gap-3 px-3 pb-4 pt-3 md:px-4 xl:px-6" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}" data-active-profile-summary="${esc(model.activeProfileSummary ?? "")}" data-chat-id="${esc(model.chatId ?? "")}" data-objective-id="${esc(model.objectiveId ?? "")}" data-active-run-id="${esc(model.runId ?? "")}" data-known-run-ids="${esc((model.knownRunIds ?? []).join(","))}" data-terminal-run-ids="${esc((model.terminalRunIds ?? []).join(","))}">
    ${renderMissionControlProgressCard(model)}
    <div class="grid gap-3 2xl:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)]">
      <section class="space-y-3">
        ${renderMissionControlFocusCard(model)}
        ${liveStepsSection}
        ${liveCodexSection}
      </section>
      <aside class="space-y-3">
        ${renderMissionControlTaskList(model, routeContext)}
        ${renderMissionControlActivityLog(model)}
      </aside>
    </div>
    ${renderMissionControlTranscriptSection(model, transcriptBody, transcriptItems.length)}
  </div>`;
};

const renderTranscriptEmptyState = (model: FactoryChatIslandModel): string =>
  renderEmptyState({
    icon: iconChat("h-6 w-6"),
    tone: "info",
    eyebrow: "Ready",
    title: model.objectiveId ? "This thread is quiet." : "Start a new thread",
    message: model.objectiveId
      ? "No transcript items have landed yet. Ask for status, react to a task, or wait for the next supervisor update."
      : `Describe what ${model.activeProfileLabel} should investigate, fix, or review.`,
    detail: model.objectiveId
      ? "Use /react, /cleanup, /promote, or /abort-job from the composer below."
      : "Slash commands still work here when you want a direct Factory action instead of a new prompt.",
    minHeightClass: "min-h-[320px]",
  });

const isTerminalObjectiveStatusValue = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const isGenericCompletedNextAction = (value?: string): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "investigation is complete." || normalized === "objective is complete.";
};

const objectiveSidebarStateValue = (objective: Pick<FactoryChatObjectiveNav, "phase" | "status" | "integrationStatus" | "slotState">): string | undefined =>
  objective.phase || objective.status || objective.integrationStatus || objective.slotState;

const isRunningSidebarObjective = (objective: FactoryChatObjectiveNav): boolean => {
  if (objective.blockedReason) return false;
  const state = objectiveSidebarStateValue(objective);
  if (!state) return true;
  if (isTerminalObjectiveStatusValue(state)) return false;
  return state !== "blocked" && state !== "conflicted";
};

const blockedObjectiveTranscriptItem = (
  model: FactoryChatIslandModel,
): FactoryChatItem | undefined => {
  const thread = model.selectedThread;
  const workbench = model.workbench;
  const isBlockedWorkbench = workbench?.summary.phase === "blocked" || workbench?.summary.status === "blocked";
  if (!thread?.blockedReason && !isBlockedWorkbench) return undefined;
  const title = thread?.title ?? workbench?.summary.title;
  if (!title) return undefined;
  const currentSignal = compactStatusText(
    thread?.summary
      ?? thread?.latestDecisionSummary
      ?? thread?.blockedExplanation
      ?? thread?.blockedReason
      ?? workbench?.focus?.summary
      ?? workbench?.focusedTask?.latestSummary
      ?? workbench?.summary.latestDecisionSummary
      ?? workbench?.summary.nextAction
      ?? "",
    220,
  );
  const blocker = compactStatusText(
    thread?.blockedExplanation
      ?? thread?.blockedReason
      ?? workbench?.focus?.summary
      ?? "",
    220,
  );
  const next = compactStatusText(thread?.nextAction ?? workbench?.summary.nextAction ?? "", 220);
  const lines = [
    `${title} is blocked and handed back to Chat.`,
    currentSignal ? `What we know: ${currentSignal}` : "",
    blocker && blocker !== currentSignal ? `Still missing: ${blocker}` : "",
    next ? `Tracked next step: ${next}` : "",
    "Chat can explain the current evidence or inspect the repo with a read-only Codex probe. Use `/react <guidance>` to continue the tracked objective.",
  ].filter(Boolean);
  return {
    key: `objective-blocked-handoff-${thread?.objectiveId ?? workbench?.summary.objectiveId ?? model.objectiveId ?? "current"}-${thread?.latestDecisionAt ?? thread?.updatedAt ?? 0}`,
    kind: "assistant",
    body: lines.join("\n\n"),
    meta: "Blocked handoff",
  };
};

const hasDurableObjectiveHandoff = (
  items: ReadonlyArray<FactoryChatItem>,
): boolean => items.some((item) => item.key.includes("-objective-handoff-"));

const synthesizedTranscriptItems = (model: FactoryChatIslandModel): ReadonlyArray<FactoryChatItem> => {
  const thread = model.selectedThread;
  if (hasDurableObjectiveHandoff(model.items)) return model.items;
  const blockedHandoff = blockedObjectiveTranscriptItem(model);
  if (model.items.length > 0) {
    return blockedHandoff ? [...model.items, blockedHandoff] : model.items;
  }
  const summary = thread?.summary?.trim();
  if (blockedHandoff) return [blockedHandoff];
  if (!thread || !isTerminalObjectiveStatusValue(thread.status) || !summary) return model.items;
  const detail = thread.nextAction?.trim();
  return [{
    key: `objective-summary-${thread.objectiveId}-${thread.status}`,
    kind: "assistant",
    body: detail && detail !== summary && !(thread.status === "completed" && isGenericCompletedNextAction(detail))
      ? `${summary}\n\nNext: ${detail}`
      : summary,
    meta: displayLabel(thread.status) || thread.status,
  }];
};

type FactoryTranscriptSectionOptions = {
  readonly objectiveHref?: (objectiveId: string) => string;
  readonly sectionLabel?: string;
  readonly emptyState?: {
    readonly title?: string;
    readonly message?: string;
    readonly detail?: string;
  };
};

const renderTranscriptContent = (
  model: FactoryChatIslandModel,
  options?: FactoryTranscriptSectionOptions,
): {
  readonly body: string;
  readonly count: number;
} => {
  const transcriptItems = synthesizedTranscriptItems(model);
  const grouped = groupChatItems(transcriptItems);
  const renderContext = {
    mode: model.mode,
    activeProfileId: model.activeProfileId,
    activeProfileLabel: model.activeProfileLabel,
    chatId: model.chatId,
    objectiveHref: options?.objectiveHref,
  };
  const body = grouped.length > 0
    ? grouped.map((group) =>
      group.kind === "single"
        ? renderChatItem(group.item, renderContext)
        : renderWorkGroup(group.items, renderContext)
    ).join("")
    : renderEmptyState({
        icon: iconChat("h-6 w-6"),
        tone: "info",
        eyebrow: "Ready",
        title: options?.emptyState?.title ?? (model.objectiveId ? "This thread is quiet." : "Start a new thread"),
        message: options?.emptyState?.message ?? (
          model.objectiveId
            ? "No transcript items have landed yet. Ask for status, react to a task, or wait for the next supervisor update."
            : `Describe what ${model.activeProfileLabel} should investigate, fix, or review.`
        ),
        detail: options?.emptyState?.detail ?? (
          model.objectiveId
            ? "Use /react, /cleanup, /promote, /cancel, /archive, or /abort-job from the composer below."
            : "Slash commands still work here when you want a direct Factory action instead of a new prompt."
        ),
        minHeightClass: "min-h-[320px]",
      });
  return {
    body,
    count: transcriptItems.length,
  };
};

export const renderFactoryTranscriptSection = (
  model: FactoryChatIslandModel,
  options?: FactoryTranscriptSectionOptions,
): string => {
  const content = renderTranscriptContent(model, options);
  return `<section class="space-y-2">
    <div class="flex items-center justify-between gap-2">
      <div class="${sectionLabelClass}">${esc(options?.sectionLabel ?? "Transcript")}</div>
      <div class="text-[11px] text-muted-foreground">${esc(`${content.count}`)}</div>
    </div>
    ${content.body}
  </section>`;
};

export const factoryChatIsland = (model: FactoryChatIslandModel): string => {
  if (isMissionControlMode(model.mode)) return renderMissionControlChatIsland(model);
  const workbench = renderCenterWorkbench(model);
  return `<div class="chat-stack mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pb-4 pt-4 md:px-8 xl:px-10" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}" data-active-profile-summary="${esc(model.activeProfileSummary ?? "")}" data-chat-id="${esc(model.chatId ?? "")}" data-objective-id="${esc(model.objectiveId ?? "")}" data-active-run-id="${esc(model.runId ?? "")}" data-known-run-ids="${esc((model.knownRunIds ?? []).join(","))}" data-terminal-run-ids="${esc((model.terminalRunIds ?? []).join(","))}">
    ${workbench}
    ${renderFactoryTranscriptSection(model)}
  </div>`;
};

const renderObjectiveTokenCallout = (tokensUsed: number): string => `<div class="mt-2  border border-info/20 bg-info/10 px-3 py-2.5">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-info">Token Usage</div>
      <div class="mt-1 text-lg font-semibold leading-none tracking-tight text-foreground">${esc(tokensUsed.toLocaleString())}</div>
    </div>
    <span class="flex h-8 w-8 shrink-0 items-center justify-center  border border-info/20 bg-background/70 text-info">
      ${iconTokens("h-4 w-4")}
    </span>
  </div>
  <div class="mt-1 text-[11px] text-muted-foreground">Codex tokens recorded so far</div>
</div>`;

const renderSidebarTokenHero = (tokensUsed: number): string => `<div class="l border border-info/25 bg-info/10 px-3 py-3">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-info">Token Usage</div>
      <div class="mt-1 text-2xl font-semibold leading-none tracking-tight text-foreground">${esc(tokensUsed.toLocaleString())}</div>
      <div class="mt-2 text-[11px] text-muted-foreground">Codex tokens recorded for this thread</div>
    </div>
    <span class="flex h-10 w-10 shrink-0 items-center justify-center l border border-info/20 bg-background/70 text-info">
      ${iconTokens("h-5 w-5")}
    </span>
  </div>
</div>`;

const renderSidebarSignalCard = (obj: FactorySelectedObjectiveCard): string => {
  const label = obj.blockedReason
    ? "Blocked"
    : obj.nextAction
      ? "Next Action"
      : obj.latestDecisionSummary
        ? "Latest Decision"
        : "Summary";
  const tone: Tone = obj.blockedReason ? "warning" : obj.nextAction ? "info" : "neutral";
  const primary = compactStatusText(
    obj.blockedReason
      ?? obj.nextAction
      ?? obj.latestDecisionSummary
      ?? obj.summary
      ?? "No thread summary yet.",
    140,
  ) || "No thread summary yet.";
  const supporting = compactStatusText(
    obj.blockedReason
      ? obj.blockedExplanation ?? obj.summary ?? ""
      : obj.latestDecisionSummary && obj.latestDecisionAt
        ? `Updated ${formatTs(obj.latestDecisionAt)}`
        : obj.summary && primary !== compactStatusText(obj.summary, 140)
          ? obj.summary
          : "",
    140,
  );
  const icon = obj.blockedReason
    ? iconStatus("h-4 w-4")
    : obj.nextAction
      ? iconNext("h-4 w-4")
      : iconProject("h-4 w-4");
  return `<div class="border border-border/80 bg-muted/45 px-3 py-3">
    <div class="flex items-start justify-between gap-3">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(label)}</div>
      <span class="flex h-8 w-8 shrink-0 items-center justify-center border ${iconBadgeToneClass(tone)}">
        ${icon}
      </span>
    </div>
    <div class="mt-2 text-sm font-semibold leading-5 text-foreground">${esc(primary)}</div>
    ${supporting ? `<div class="mt-2 text-[11px] leading-5 text-muted-foreground">${esc(supporting)}</div>` : ""}
  </div>`;
};

const renderSidebarDetailRows = (obj: FactorySelectedObjectiveCard): string => {
  const stateValue = `${titleCaseLabel(obj.slotState ?? obj.phase ?? obj.status) || "Idle"}${typeof obj.queuePosition === "number" ? ` (q${obj.queuePosition})` : ""}`;
  const tasksValue = `${obj.activeTaskCount ?? 0} active / ${obj.readyTaskCount ?? 0} ready / ${obj.taskCount ?? 0} total`;
  const checksValue = obj.checks?.length ? `${obj.checks.length} checks` : "None";
  const outputLabel = obj.prNumber || obj.prUrl ? "Pull Request" : "Commit";
  const outputValue = obj.prNumber
    ? `#${obj.prNumber}`
    : obj.prUrl
      ? "Opened"
      : shortHash(obj.latestCommitHash) || "None";
  const outputIcon = obj.prNumber || obj.prUrl
    ? iconPullRequest("h-3.5 w-3.5")
    : iconCommit("h-3.5 w-3.5");
  const rows = [
    { label: "State", value: stateValue, icon: iconStatus("h-3.5 w-3.5") },
    { label: "Tasks", value: tasksValue, icon: iconTask("h-3.5 w-3.5") },
    { label: "Checks", value: checksValue, icon: iconCheckCircle("h-3.5 w-3.5") },
    { label: outputLabel, value: outputValue, icon: outputIcon },
  ];
  return `<div class="border border-border/80 bg-muted/45 px-3 py-1.5">
    ${rows.map((row, index) => `<div class="flex items-start justify-between gap-3 py-2 ${index > 0 ? "border-t border-border/70" : ""}">
      <div class="flex min-w-0 items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        <span class="text-muted-foreground">${row.icon}</span>
        <span>${esc(row.label)}</span>
      </div>
      <div class="min-w-0 text-right text-[12px] font-medium leading-5 text-foreground [overflow-wrap:anywhere]">${esc(row.value)}</div>
    </div>`).join("")}
  </div>`;
};

const renderSidebarLinks = (
  profileId: string,
  obj: FactorySelectedObjectiveCard,
  mode?: FactoryViewMode,
): string => {
  const targetProfileId = obj.profileId ?? profileId;
  const otherThreadsHref = withQueryParam(factoryChatQuery({ mode, profileId: targetProfileId }), "all", "1");
  const receiptsHref = `/factory${factoryChatQuery({
    mode,
    profileId: targetProfileId,
    objectiveId: obj.objectiveId,
    panel: "receipts",
  })}`;
  return `<div class="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
    <a class="font-medium text-primary hover:underline" href="${otherThreadsHref}">See other threads</a>
    <a class="font-medium text-primary hover:underline" href="${receiptsHref}">Receipts</a>
  </div>`;
};


const renderObjectiveLink = (model: FactoryNavModel, objective: FactoryChatObjectiveNav): string => {
  const href = factoryChatQuery({
    mode: model.mode,
    profileId: objective.profileId || model.activeProfileId,
    objectiveId: objective.objectiveId,
    inspectorTab: model.inspectorTab,
  });
  const selectedClass = objective.selected
    ? "border-primary bg-primary/5"
    : "border-transparent bg-transparent hover:bg-accent/45";
  const displayStatus = objective.blockedReason ? "blocked" : (objective.phase || objective.status);
  const summary = compactStatusText(objective.blockedReason ?? objective.summary ?? "", 92);
  const tone = toneForValue(displayStatus);
  return `<a class="block min-w-0 border-l-2 px-3 py-2.5 transition ${selectedClass}" href="${href}" data-factory-objective-link="true" data-selected="${objective.selected ? "true" : "false"}" data-objective-id="${esc(objective.objectiveId)}">
    <div class="flex min-w-0 items-start gap-2.5">
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold leading-5 text-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">${esc(objective.title)}</div>
        ${summary ? `<div class="mt-1 text-[11px] leading-4 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">${esc(summary)}</div>` : ""}
        ${objective.profileLabel ? `<div class="mt-1.5 text-[10px] font-medium text-muted-foreground">${esc(objective.profileLabel)}</div>` : ""}
        ${typeof objective.tokensUsed === "number" ? renderObjectiveTokenCallout(objective.tokensUsed) : ""}
      </div>
    </div>
    <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span class="inline-flex items-center gap-1.5" title="${esc(displayLabel(displayStatus) || displayStatus)}">
          ${statusDot(tone)}
          <span class="sr-only">${esc(displayLabel(displayStatus) || displayStatus)}</span>
        </span>
        ${objective.updatedAt ? `<span class="inline-flex items-center gap-1 whitespace-nowrap">${iconClock("h-3 w-3")} ${esc(formatTs(objective.updatedAt))}</span>` : ""}
      </div>
    </div>
  </a>`;
};

const renderSidebarEmptyState = (input: {
  readonly eyebrow: string;
  readonly title: string;
  readonly message: string;
}): string =>
  renderEmptyState({
    icon: iconProject("h-5 w-5"),
    tone: "neutral",
    eyebrow: input.eyebrow,
    title: input.title,
    message: input.message,
    minHeightClass: "min-h-[168px]",
  });

const renderSidebarMetrics = (
  profileId: string,
  obj?: FactorySelectedObjectiveCard,
  mode?: FactoryViewMode,
): string => {
  if (!obj) return "";
  return `<section class="space-y-2">
    <div class="flex items-center justify-between gap-2">
      <div class="${sectionLabelClass}">Thread Snapshot</div>
      <div class="text-[10px] text-muted-foreground">${esc(titleCaseLabel(obj.slotState ?? obj.phase ?? obj.status) || "Idle")}</div>
    </div>
    ${typeof obj.tokensUsed === "number" ? renderSidebarTokenHero(obj.tokensUsed) : ""}
    ${renderSidebarSignalCard(obj)}
    ${renderSidebarDetailRows(obj)}
    ${renderSidebarLinks(profileId, obj, mode)}
  </section>`;
};

const factoryRailIsland = (model: FactoryNavModel, selectedObjective?: FactorySelectedObjectiveCard): string => {
  const runningObjectives = model.objectives.filter((objective) => isRunningSidebarObjective(objective));
  const previousSessions = model.objectives.filter((objective) => !isRunningSidebarObjective(objective));
  const visiblePreviousSessions = model.showAll ? previousSessions : previousSessions.slice(0, 5);
  const hasMorePreviousSessions = !model.showAll && previousSessions.length > 5;
  const selectedObjectiveQuery = factoryChatQuery({
    mode: model.mode,
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: selectedObjective?.objectiveId,
    panel: model.panel,
    inspectorTab: model.inspectorTab,
  });
  const viewAllQuery = `${selectedObjectiveQuery}${selectedObjectiveQuery.includes("?") ? "&" : "?"}all=1`;
  const runningObjectiveCards = runningObjectives.length > 0
    ? runningObjectives.map((objective) => renderObjectiveLink(model, objective)).join("")
    : renderSidebarEmptyState({
        eyebrow: "Running",
        title: "No running objectives",
        message: "Queued, active, and integrating work for this profile will stay pinned here.",
      });
  const previousSessionCards = visiblePreviousSessions.length > 0
    ? visiblePreviousSessions.map((objective) => renderObjectiveLink(model, objective)).join("")
    : renderSidebarEmptyState({
        eyebrow: "Previous Sessions",
        title: "No previous sessions",
        message: "Completed, failed, and canceled objectives will appear here once this repo has history.",
      });
  const profileLinks = model.profiles.length > 0
    ? model.profiles.map((profile) => {
        const selectedClass = profile.selected
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground";
        return `<a class="border-b-2 px-0 py-1 text-[11px] font-medium transition ${selectedClass}" href="${esc(profile.href)}">${esc(profile.label)}</a>`;
      }).join("")
    : "";
  return `<div class="space-y-3 px-3 py-3 md:px-3.5">
    <div class="border-b border-border pb-3">
      <a
        class="inline-flex items-center gap-2  px-1 py-0.5 text-base font-semibold tracking-[-0.01em] text-foreground transition hover:text-primary md:text-[1.05rem]"
        href="/receipt"
        aria-label="Receipt home"
        title="Receipt home"
      >
        <span aria-hidden="true" class="flex h-6 w-6 shrink-0 items-center justify-center  border border-border/70 bg-background/80 text-primary shadow-sm md:h-7 md:w-7">
          ${iconReceipt("h-3.5 w-3.5")}
        </span>
        <span class="leading-none">Receipt</span>
      </a>
      <div class="mt-2 flex flex-wrap gap-4">
        ${profileLinks}
      </div>
    </div>
    <section class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 ${sectionLabelClass}">${iconProject("w-3.5 h-3.5")} Running</div>
        <div class="text-[10px] text-muted-foreground">${esc(`${runningObjectives.length}`)}</div>
      </div>
      <div class="space-y-2">
        ${runningObjectiveCards}
      </div>
    </section>
    ${renderSidebarMetrics(model.activeProfileId, selectedObjective, model.mode)}
    <section class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 ${sectionLabelClass}">${iconChat("w-3.5 h-3.5")} Previous Sessions</div>
        <div class="text-[10px] text-muted-foreground">${esc(`${previousSessions.length}`)}</div>
      </div>
      <div class="space-y-2">
        ${previousSessionCards}
      </div>
      ${hasMorePreviousSessions ? `<div>
        <a href="/factory${viewAllQuery}" class="text-[10px] font-medium text-primary hover:underline">View all</a>
      </div>` : ""}
    </section>
  </div>`;
};

const missionControlRailIsland = (model: FactoryNavModel, selectedObjective?: FactorySelectedObjectiveCard): string => {
  const runningObjectives = model.objectives.filter((objective) => isRunningSidebarObjective(objective));
  const previousSessions = model.objectives.filter((objective) => !isRunningSidebarObjective(objective));
  const visiblePreviousSessions = model.showAll ? previousSessions : previousSessions.slice(0, 6);
  const selectedObjectiveQuery = factoryChatQuery({
    mode: model.mode,
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: selectedObjective?.objectiveId,
    panel: model.panel,
    inspectorTab: model.inspectorTab,
  });
  const viewAllQuery = `${selectedObjectiveQuery}${selectedObjectiveQuery.includes("?") ? "&" : "?"}all=1`;
  const profileLinks = model.profiles.length > 0
    ? model.profiles.map((profile) => {
      const selectedClass = profile.selected
        ? "border-primary text-foreground"
        : "border-transparent text-muted-foreground hover:border-border hover:text-foreground";
      return `<a class="border-b-2 px-0 py-1 text-[11px] font-medium transition ${selectedClass}" href="${factoryChatQuery({
        mode: model.mode,
        profileId: profile.id,
        inspectorTab: model.inspectorTab,
      })}">${esc(profile.label)}</a>`;
    }).join("")
    : "";
  const renderSection = (title: string, count: number, content: string, footer?: string): string => `<section class="${missionControlPanelClass} p-3">
    <div class="flex items-center justify-between gap-2">
      <div class="${missionControlSectionLabelClass}">${esc(title)}</div>
      <div class="${missionControlMonoClass} text-muted-foreground">${esc(String(count))}</div>
    </div>
    <div class="mt-3 space-y-2">${content}</div>
    ${footer ? `<div class="mt-3">${footer}</div>` : ""}
  </section>`;
  return `<div class="space-y-3 px-3 py-3">
    <section class="${missionControlPanelClass} p-3">
      <a class="text-[11px] font-medium text-muted-foreground transition hover:text-foreground" href="/receipt">receipt / factory</a>
      <div class="mt-3 flex flex-wrap gap-4">
        ${profileLinks}
      </div>
      ${selectedObjective ? `<div class="mt-3">${renderSidebarMetrics(model.activeProfileId, selectedObjective, model.mode)}</div>` : ""}
    </section>
    ${renderSection(
      "Objective Queue",
      runningObjectives.length,
      runningObjectives.length > 0
        ? runningObjectives.map((objective) => renderObjectiveLink(model, objective)).join("")
        : `<div class="${missionControlInsetClass} px-3 py-3 text-sm text-muted-foreground">No live objectives are running right now.</div>`,
    )}
    ${renderSection(
      "Recent Threads",
      previousSessions.length,
      visiblePreviousSessions.length > 0
        ? visiblePreviousSessions.map((objective) => renderObjectiveLink(model, objective)).join("")
        : `<div class="${missionControlInsetClass} px-3 py-3 text-sm text-muted-foreground">Completed and archived objectives will show up here.</div>`,
      !model.showAll && previousSessions.length > visiblePreviousSessions.length
        ? `<a href="/factory${viewAllQuery}" class="text-[11px] font-medium text-primary hover:underline">View all recent threads</a>`
        : "",
    )}
  </div>`;
};

export const factorySidebarIsland = (model: FactoryNavModel, selectedObjective?: FactorySelectedObjectiveCard): string =>
  isMissionControlMode(model.mode)
    ? missionControlRailIsland(model, selectedObjective)
    : factoryRailIsland(model, selectedObjective);

const isTerminalJobStatusValue = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const renderDefaultFactoryShell = (model: FactoryChatShellModel): string => {
  const routeContext: FactoryChatRouteContext = {
    mode: model.mode,
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    runId: model.runId,
    jobId: model.jobId,
    panel: model.panel,
    inspectorTab: model.inspectorTab,
    focusKind: model.focusKind,
    focusId: model.focusId,
  };
  const shellQuery = factoryChatQuery(routeContext);
  const composerRouteContext: FactoryChatRouteContext = model.inspector.objectiveMissing
    ? {
        mode: model.mode,
        profileId: model.activeProfileId,
        panel: model.panel,
      }
    : routeContext;
  const composerQuery = factoryChatQuery(composerRouteContext);
  const currentJobId = model.inspector.objectiveMissing ? undefined : composerJobId(model);
  const missionControlHref = modeSwitchHref(routeContext, "mission-control");
  const workbenchViewHref = workbenchHref(routeContext);
  const islandBindings = factoryShellIslandBindings(shellQuery);
  const profileSummary = shellProfileSummary(model);
  const newChatHref = `/factory/new-chat${factoryChatQuery({
    mode: model.mode,
    profileId: model.activeProfileId,
  })}`;
  const composerPlaceholder = model.inspector.objectiveMissing
    ? "This thread no longer exists. Send a message to start a new thread."
    : model.objectiveId
    ? "Ask for status, or use /analyze, /react, /promote, /cancel, /cleanup, /archive, /abort-job..."
    : "Send the first message to start a new thread. Slash commands run direct actions.";
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
  <script src="/assets/htmx.min.js?v=${CSS_VERSION}"></script>
  <script src="/assets/htmx-ext-sse.js?v=${CSS_VERSION}"></script>
</head>
<body data-factory-chat data-factory-mode="${esc(model.mode ?? "default")}" data-focus-kind="${esc(model.focusKind ?? "")}" data-focus-id="${esc(model.focusId ?? "")}" class="font-sans antialiased overflow-x-hidden md:h-screen md:overflow-hidden">
  <div class="min-h-screen bg-background text-foreground md:h-screen">
    <div id="factory-live-root" ${sseConnectAttrs(factoryEventsPath(shellQuery))} class="flex min-h-screen flex-col md:grid md:h-screen md:min-h-0 md:grid-cols-[248px_minmax(0,1fr)_320px] lg:grid-cols-[256px_minmax(0,1fr)_336px] md:overflow-hidden">
      <aside class="order-2 min-w-0 overflow-hidden border-t border-sidebar-border bg-sidebar text-sidebar-foreground md:order-0 md:min-h-0 md:border-r md:border-t-0">
        <div class="factory-scrollbar max-h-[40vh] overflow-x-hidden overflow-y-auto md:h-full md:max-h-none">
          <div id="factory-sidebar" ${liveIslandAttrs(islandBindings.sidebar)}>
            ${factoryRailIsland(model.nav, model.inspector.selectedObjective)}
          </div>
        </div>
      </aside>
      <main class="order-1 min-w-0 overflow-hidden bg-background md:order-0 md:min-h-0">
        <div class="flex min-h-screen flex-col md:h-full md:min-h-0">
          <header class="shrink-0 border-b border-border bg-card">
            <div class="flex items-center justify-between gap-3 px-4 py-2.5">
              <div class="min-w-0 flex flex-1 items-center gap-2 overflow-x-auto factory-scrollbar">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 overflow-x-auto factory-scrollbar">
                    <span class="text-[11px] font-medium text-muted-foreground">receipt / factory</span>
                    <h1 id="factory-shell-title" class="min-w-0 truncate text-sm font-semibold text-foreground" data-profile-label>${esc(shellHeaderTitle(model))}</h1>
                    <span id="factory-shell-status-pills" class="contents">${renderShellStatusPills(model)}</span>
                  </div>
                  ${profileSummary ? `<div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(profileSummary)}</div>` : ""}
                </div>
              </div>
              <div id="factory-shell-controls" class="flex shrink-0 items-center gap-1.5">
                ${renderHeaderProfileSelect({
                  id: "factory-shell-profile-select",
                  label: "Profile",
                  profiles: model.nav.profiles,
                })}
                <a
                  class="inline-flex items-center justify-center  border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  href="${workbenchViewHref}"
                  aria-label="Open workbench"
                  title="Workbench"
                >
                  Workbench
                </a>
                <a
                  class="inline-flex items-center justify-center  border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  href="${missionControlHref}"
                  aria-label="Open mission control"
                  title="Mission control"
                >
                  Mission Control
                </a>
                <a
                  class="inline-flex items-center justify-center  border border-primary/20 bg-background px-3 py-2 text-sm font-medium text-primary transition hover:border-primary/35 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  href="${newChatHref}"
                  aria-label="Start a new chat"
                  title="New chat"
                >
                  New Chat
                </a>
              </div>
            </div>
          </header>
          <section id="factory-chat-scroll" class="factory-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div id="factory-chat" data-active-profile-label="${esc(model.activeProfileLabel)}" ${liveIslandAttrs(islandBindings.chat)}>
              ${factoryChatIsland(model.chat)}
            </div>
            <div id="factory-chat-live" class="chat-stack mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pb-4 md:px-8 xl:px-10">
              ${renderFactoryStreamingShell(model.activeProfileLabel)}
              <div id="factory-chat-optimistic" class="space-y-2" aria-live="polite"></div>
            </div>
          </section>
          <section class="shrink-0 border-t border-border bg-background px-2 py-2 sm:px-3">
            <div class="${composerShellClass}">
              <form id="factory-composer" action="/factory/compose${composerQuery}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
                <input id="factory-composer-current-job" type="hidden" name="currentJobId" value="${esc(currentJobId ?? "")}" />
                <label class="sr-only" for="factory-prompt">Factory prompt</label>
                <div class="${composerPanelClass}">
                  <div class="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
                    <textarea id="factory-prompt" name="prompt" class="${composerTextareaClass} sm:min-h-[104px]" rows="2" placeholder="${esc(composerPlaceholder)}" autofocus aria-autocomplete="list" aria-expanded="false" aria-controls="factory-composer-completions" aria-haspopup="listbox"></textarea>
                    <button id="factory-composer-submit" class="inline-flex min-h-[88px] w-full shrink-0 items-center justify-center  border border-primary/40 bg-primary px-6 py-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground sm:w-[8.5rem] sm:min-h-[104px]" type="submit">Send</button>
                  </div>
                  <div id="factory-composer-completions" class="hidden max-h-56 overflow-auto  border border-border bg-background shadow-lg" role="listbox" aria-label="Slash command suggestions"></div>
                </div>
                <div id="factory-composer-status" class="mt-2 hidden  border border-border bg-muted px-3 py-1.5 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
              </form>
            </div>
          </section>
        </div>
      </main>
      <aside class="order-3 min-w-0 overflow-hidden border-t border-sidebar-border bg-sidebar text-sidebar-foreground md:min-h-0 md:border-l md:border-t-0">
        <div class="factory-scrollbar max-h-[45vh] overflow-x-hidden overflow-y-auto md:h-full md:max-h-none">
          <div id="factory-inspector" class="factory-inspector-panel" ${liveIslandAttrs(islandBindings.inspector)}>
            ${factoryInspectorIsland(model.inspector)}
          </div>
        </div>
      </aside>
    </div>
  </div>
  <script src="/assets/factory-client.js?v=${CSS_VERSION}"></script>
</body>
</html>`;
};

const renderMissionControlShell = (model: FactoryChatShellModel): string => {
  const routeContext: FactoryChatRouteContext = {
    mode: model.mode,
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    runId: model.runId,
    jobId: model.jobId,
    panel: model.panel,
    inspectorTab: model.inspectorTab,
    focusKind: model.focusKind,
    focusId: model.focusId,
  };
  const shellQuery = factoryChatQuery(routeContext);
  const composerRouteContext: FactoryChatRouteContext = model.inspector.objectiveMissing
    ? {
        mode: model.mode,
        profileId: model.activeProfileId,
        panel: model.panel,
      }
    : routeContext;
  const composerQuery = factoryChatQuery(composerRouteContext);
  const currentJobId = model.inspector.objectiveMissing ? undefined : composerJobId(model);
  const standardHref = modeSwitchHref(routeContext, "default");
  const workbenchViewHref = workbenchHref(routeContext);
  const islandBindings = factoryShellIslandBindings(shellQuery);
  const profileSummary = shellProfileSummary(model);
  const newChatHref = `/factory/new-chat${factoryChatQuery({
    mode: model.mode,
    profileId: model.activeProfileId,
  })}`;
  const composerPlaceholder = model.inspector.objectiveMissing
    ? "This thread no longer exists. Send a message to start a new thread."
    : model.objectiveId
      ? "Ask for status or use /react, /promote, /cancel, /cleanup, /archive, /abort-job..."
      : "Describe the next operator task to start a new thread.";
  const summary = model.chat.workbench?.summary;
  const statTiles = [
    ["profile", model.activeProfileLabel],
    ["phase", displayLabel(summary?.phase || model.inspector.selectedObjective?.phase || model.inspector.selectedObjective?.status || "idle") || "Idle"],
    ["tasks", `${summary?.activeTaskCount ?? 0} active / ${summary?.taskCount ?? 0} total`],
    ["checks", typeof summary?.checksCount === "number" && summary.checksCount > 0 ? `${summary.checksCount}` : "0"],
  ].map(([label, value]) => `<div class="${missionControlInsetClass} px-3 py-2">
      <div class="${missionControlSectionLabelClass}">${esc(label)}</div>
      <div class="mt-1 text-sm font-semibold text-foreground">${esc(value)}</div>
    </div>`).join("");
  const hotkeys = [
    ["tab", "cycle pane"],
    ["j / k", "queue nav"],
    ["1-5", "inspector"],
    ["c", "composer"],
    ["esc", "clear"],
  ].map(([key, label]) => `<span class="${missionControlHotkeyClass}"><span class="font-semibold text-foreground">${esc(key)}</span><span>${esc(label)}</span></span>`).join("");
  return `<!doctype html>
<html class="dark h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Factory Mission Control</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
  <script src="/assets/htmx.min.js?v=${CSS_VERSION}"></script>
  <script src="/assets/htmx-ext-sse.js?v=${CSS_VERSION}"></script>
</head>
<body data-factory-chat data-factory-mode="mission-control" data-focus-kind="${esc(model.focusKind ?? "")}" data-focus-id="${esc(model.focusId ?? "")}" class="font-sans antialiased overflow-x-hidden">
  <div class="mission-control-shell min-h-screen bg-background text-foreground">
    <div id="factory-live-root" ${sseConnectAttrs(factoryEventsPath(shellQuery))} class="mx-auto flex min-h-screen max-w-[1680px] flex-col gap-3 px-3 py-3 lg:px-4">
      <header class="${missionControlPanelClass} px-4 py-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[11px] font-medium text-muted-foreground">receipt / factory</div>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <h1 id="factory-shell-title" class="min-w-0 truncate text-lg font-semibold tracking-tight text-foreground" data-profile-label>${esc(shellHeaderTitle(model))}</h1>
              <span id="factory-shell-status-pills" class="contents">${renderShellStatusPills(model)}</span>
            </div>
            ${profileSummary ? `<div class="mt-2 max-w-[64ch] text-sm leading-6 text-muted-foreground">${esc(profileSummary)}</div>` : ""}
          </div>
          <div id="factory-shell-controls" class="flex flex-wrap items-center gap-2">
            ${renderHeaderProfileSelect({
              id: "factory-shell-profile-select",
              label: "Profile",
              profiles: model.nav.profiles,
            })}
            <a class="inline-flex items-center justify-center  border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground" href="${workbenchViewHref}">Workbench</a>
            <a class="inline-flex items-center justify-center  border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground" href="${standardHref}">Standard View</a>
            <a class="inline-flex items-center justify-center  border border-primary/30 bg-background px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10" href="${newChatHref}" aria-label="Start a new chat">New Thread</a>
          </div>
        </div>
        <div id="factory-shell-metrics" class="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          ${statTiles}
        </div>
      </header>
      <div class="grid min-h-0 flex-1 gap-3 xl:grid-cols-[300px_minmax(0,1fr)_360px]">
        <aside id="factory-sidebar-shell" data-mission-control-pane="sidebar" data-pane-active="false" class="mission-control-pane min-w-0 ${missionControlPanelClass} overflow-hidden">
          <div class="factory-scrollbar max-h-[42vh] overflow-y-auto xl:h-full xl:max-h-none">
            <div id="factory-sidebar" ${liveIslandAttrs(islandBindings.sidebar)}>
              ${factorySidebarIsland(model.nav, model.inspector.selectedObjective)}
            </div>
          </div>
        </aside>
        <main class="min-w-0">
          <div class="grid gap-3">
            <section id="factory-chat-shell" data-mission-control-pane="chat" data-pane-active="false" class="mission-control-pane min-w-0 ${missionControlPanelClass} overflow-hidden">
              <div id="factory-chat-scroll" class="factory-scrollbar min-h-[360px] overflow-y-auto overscroll-contain xl:max-h-[calc(100vh-18rem)]">
                <div id="factory-chat" data-active-profile-label="${esc(model.activeProfileLabel)}" ${liveIslandAttrs(islandBindings.chat)}>
                  ${factoryChatIsland(model.chat)}
                </div>
                <div id="factory-chat-live" class="chat-stack mx-auto flex w-full max-w-[1440px] flex-col gap-3 px-3 pb-4 md:px-4 xl:px-6">
                  ${renderFactoryStreamingShell(model.activeProfileLabel)}
                  <div id="factory-chat-optimistic" class="space-y-2" aria-live="polite"></div>
                </div>
              </div>
            </section>
            <section id="factory-composer-shell" data-mission-control-pane="composer" data-pane-active="false" class="mission-control-pane ${missionControlPanelClass} p-3">
              <form id="factory-composer" action="/factory/compose${composerQuery}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
                <input id="factory-composer-current-job" type="hidden" name="currentJobId" value="${esc(currentJobId ?? "")}" />
                <label class="sr-only" for="factory-prompt">Factory prompt</label>
                <div class="grid gap-3 xl:grid-cols-[minmax(0,1fr)_10rem]">
                  <div class="relative">
                    <textarea id="factory-prompt" name="prompt" class="min-h-[112px] w-full resize-none  border border-border/80 bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/30 focus-visible:ring-2 focus-visible:ring-ring/40" rows="3" placeholder="${esc(composerPlaceholder)}" autofocus aria-autocomplete="list" aria-expanded="false" aria-controls="factory-composer-completions" aria-haspopup="listbox"></textarea>
                    <div id="factory-composer-completions" class="hidden mt-2 max-h-56 overflow-auto  border border-border bg-background shadow-lg" role="listbox" aria-label="Slash command suggestions"></div>
                  </div>
                  <button id="factory-composer-submit" class="inline-flex min-h-[112px] w-full items-center justify-center  border border-primary/40 bg-primary px-6 py-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground" type="submit">Send</button>
                </div>
                <div id="factory-composer-status" class="mt-2 hidden  border border-border bg-muted px-3 py-2 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
              </form>
            </section>
          </div>
        </main>
        <aside id="factory-inspector-shell" data-mission-control-pane="inspector" data-pane-active="false" class="mission-control-pane min-w-0 ${missionControlPanelClass} overflow-hidden">
          <div class="factory-scrollbar max-h-[42vh] overflow-y-auto xl:h-full xl:max-h-none">
            <div id="factory-inspector" class="factory-inspector-panel" ${liveIslandAttrs(islandBindings.inspector)}>
              ${factoryInspectorIsland(model.inspector)}
            </div>
          </div>
        </aside>
      </div>
      <footer class="${missionControlPanelClass} px-4 py-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="${missionControlSectionLabelClass}">Hotkeys</div>
          <div class="flex flex-wrap gap-2">${hotkeys}</div>
        </div>
      </footer>
    </div>
  </div>
  <script src="/assets/factory-client.js?v=${CSS_VERSION}"></script>
</body>
</html>`;
};

export const factoryChatShell = (model: FactoryChatShellModel): string =>
  isMissionControlMode(model.mode)
    ? renderMissionControlShell(model)
    : renderDefaultFactoryShell(model);
