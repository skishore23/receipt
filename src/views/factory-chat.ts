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
  iconPlus,
  iconProject,
  iconPullRequest,
  iconQueue,
  iconReceipt,
  iconRun,
  iconStatus,
  iconTask,
  iconTokens,
  iconBadgeToneClass,
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

const FACTORY_CHAT_REFRESH_MS = 180;
const FACTORY_SIDEBAR_REFRESH_MS = 450;
const FACTORY_INSPECTOR_TABS_REFRESH_MS = 900;
const FACTORY_INSPECTOR_PANEL_REFRESH_MS = 450;

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
  FactoryChatObjectiveNav,
  FactorySelectedObjectiveCard,
  FactoryWorkCard,
  FactoryChatItem,
  FactoryChatIslandModel,
  FactoryChatShellModel,
  FactoryNavModel,
  FactoryLiveCodexCard,
  FactoryInspectorPanel,
} from "./factory-models";

type FactoryChatRouteContext = {
  readonly profileId: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly panel?: FactoryInspectorPanel;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
};

const factoryChatQuery = (input: FactoryChatRouteContext): string => {
  const params = new URLSearchParams();
  params.set("profile", input.profileId);
  if (input.chatId) params.set("chat", input.chatId);
  if (input.objectiveId) params.set("thread", input.objectiveId);
  if (input.runId) params.set("run", input.runId);
  if (input.jobId) params.set("job", input.jobId);
  if (input.panel) params.set("panel", input.panel);
  if (input.focusKind && input.focusId) {
    params.set("focusKind", input.focusKind);
    params.set("focusId", input.focusId);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
};

const factoryChatSseTrigger = (throttleMs: number): string =>
  `sse:agent-refresh throttle:${throttleMs}ms, sse:factory-refresh throttle:${throttleMs}ms, sse:job-refresh throttle:${throttleMs}ms`;

const factoryStatusSseTrigger = (throttleMs: number): string =>
  `sse:factory-refresh throttle:${throttleMs}ms, sse:job-refresh throttle:${throttleMs}ms`;

const renderJobControls = (jobId: string, running?: boolean, abortRequested?: boolean): string =>
  running ? `<div class="mt-4">${renderJobActionCards(jobId, { abortRequested })}</div>` : "";

const renderWorkControls = (card: FactoryWorkCard): string =>
  card.jobId ? renderJobControls(card.jobId, card.running, false) : "";

const shellPill = (label: string, tone: Tone = "neutral", icon?: string): string =>
  `<span class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] whitespace-nowrap ${badgeToneClass(tone)}">${icon ?? ""}${esc(label)}</span>`;

const shellHeaderTitle = (model: FactoryChatShellModel): string =>
  model.inspector.selectedObjective?.title
    ?? (!model.objectiveId ? "New chat" : model.activeProfileLabel);

const renderShellStatusPills = (model: FactoryChatShellModel): string => {
  const pills: string[] = [];
  const objective = model.inspector.selectedObjective;
  if (objective) {
    const phaseLabel = displayLabel(objective.phase) || displayLabel(objective.status) || "active";
    pills.push(shellPill(`Objective ${phaseLabel}`, toneForValue(objective.phase || objective.status), iconProject("h-3 w-3")));
    if (typeof objective.queuePosition === "number") pills.push(shellPill(`Queue #${objective.queuePosition}`, "warning", iconQueue("h-3 w-3")));
    if (objective.tokensUsed) pills.push(shellPill(`${objective.tokensUsed.toLocaleString()} tokens`, "info", iconTokens("h-3 w-3")));
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

const composerTextareaClass = "min-h-[88px] w-full flex-[1_1_0%] resize-none rounded-xl border border-border bg-muted px-4 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/30 focus:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40";
const composerShellClass = "mx-auto w-full max-w-6xl";
const composerPanelClass = "relative flex flex-col gap-2";
const assistantResponseCardClass = "overflow-hidden rounded-xl border border-border/80 bg-card/90 shadow-sm backdrop-blur-xl";
const assistantResponseBodyClass = "max-w-[72ch] px-5 py-4 sm:px-6 sm:py-5";

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
    return `<section class="flex justify-start">
      <div class="w-full max-w-3xl space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-1.5 ${sectionLabelClass}">${iconChat("w-3.5 h-3.5")} ${esc(activeProfileLabel)}</div>
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
  if (item.kind === "objective_event") {
    return `<section class="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 cursor-pointer hover:bg-primary/20 transition"
      hx-get="/factory/island/inspector?thread=${encodeURIComponent(item.objectiveId)}"
      hx-target="#factory-inspector"
      hx-swap="innerHTML">
      <div class="flex items-center gap-2 text-sm font-semibold text-primary">
        ${iconProject("w-4 h-4")} ${esc(item.title)}
      </div>
      <div class="mt-1 text-xs text-foreground">${esc(item.summary)}</div>
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
): string => {
  const latest = items[items.length - 1]!;
  const earlier = items.slice(0, -1);
  const latestHtml = renderChatItem(latest, activeProfileLabel);
  return `<div class="space-y-1">
    <details>
      <summary class="cursor-pointer list-none rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground hover:bg-accent transition">${esc(`${earlier.length} earlier update${earlier.length > 1 ? "s" : ""}`)}</summary>
      <div class="mt-1 space-y-1">
        ${earlier.map((item) => renderChatItem(item, activeProfileLabel)).join("")}
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
    ${(card.updatedAt || card.tokensUsed)
      ? `<div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        ${card.updatedAt ? `<span>${esc(formatTs(card.updatedAt))}</span>` : ""}
        ${card.tokensUsed ? shellPill(`${card.tokensUsed.toLocaleString()} tokens`, "info", iconTokens("h-3 w-3")) : ""}
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
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border ${iconBadgeToneClass(input.tone ?? "neutral")} shadow-sm">
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
    <div class="overflow-hidden rounded-xl border border-border bg-card">
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
                <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[10px] font-semibold text-muted-foreground">${index + 1}</span>
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
  return `<section class="space-y-2">
    <section class="${softPanelClass} px-4 py-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold text-foreground truncate">${esc(thread?.title ?? workbench.summary.title)}</div>
          <div class="mt-1 text-xs text-muted-foreground">${esc(focusSummary)}</div>
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
    <section class="${softPanelClass} px-4 py-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1 flex items-center gap-2">
          <div class="text-sm font-semibold text-foreground truncate">${esc(thread?.title ?? `${model.activeProfileLabel} chat`)}</div>
          ${thread?.nextAction ? `<div class="hidden sm:block text-xs text-muted-foreground truncate">${esc(thread.nextAction)}</div>` : ""}
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          ${thread ? badge(`Objective ${displayLabel(thread.phase || thread.status)}`, toneForValue(thread.phase || thread.status)) : ""}
        </div>
      </div>
    </section>
    ${runningWorkbench || renderThreadOverview(model, thread)}
    ${liveStepsSection}
    ${tasksSection}
    ${thread ? "" : liveCodexSection}
  </section>`;
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

const synthesizedTranscriptItems = (model: FactoryChatIslandModel): ReadonlyArray<FactoryChatItem> => {
  if (model.items.length > 0) return model.items;
  const thread = model.selectedThread;
  const summary = thread?.summary?.trim();
  if (!thread || !isTerminalObjectiveStatusValue(thread.status) || !summary) return model.items;
  const detail = thread.nextAction?.trim();
  return [{
    key: `objective-summary-${thread.objectiveId}-${thread.status}`,
    kind: "assistant",
    body: detail && detail !== summary ? `${summary}\n\nNext: ${detail}` : summary,
    meta: displayLabel(thread.status) || thread.status,
  }];
};

export const factoryChatIsland = (model: FactoryChatIslandModel): string => {
  const workbench = renderCenterWorkbench(model);
  const transcriptItems = synthesizedTranscriptItems(model);
  const grouped = groupChatItems(transcriptItems);
  const body = grouped.length > 0
    ? grouped.map((group) =>
      group.kind === "single"
        ? renderChatItem(group.item, model.activeProfileLabel)
        : renderWorkGroup(group.items, model.activeProfileLabel)
    ).join("")
    : renderTranscriptEmptyState(model);
  return `<div class="chat-stack mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pb-4 pt-4 md:px-8 xl:px-10" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}" data-active-profile-summary="${esc(model.activeProfileSummary ?? "")}">
    ${workbench}
    <section class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="${sectionLabelClass}">Transcript</div>
        <div class="text-[11px] text-muted-foreground">${esc(`${transcriptItems.length}`)}</div>
      </div>
      ${body}
    </section>
  </div>`;
};

const renderObjectiveTokenCallout = (tokensUsed: number): string => `<div class="mt-2 rounded-xl border border-info/20 bg-info/10 px-3 py-2.5">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-info">Token Usage</div>
      <div class="mt-1 text-lg font-semibold leading-none tracking-tight text-foreground">${esc(tokensUsed.toLocaleString())}</div>
    </div>
    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-info/20 bg-background/70 text-info">
      ${iconTokens("h-4 w-4")}
    </span>
  </div>
  <div class="mt-1 text-[11px] text-muted-foreground">Codex tokens recorded so far</div>
</div>`;

const renderSidebarTokenHero = (tokensUsed: number): string => `<div class="rounded-2xl border border-info/25 bg-info/10 px-3 py-3">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-info">Token Usage</div>
      <div class="mt-1 text-2xl font-semibold leading-none tracking-tight text-foreground">${esc(tokensUsed.toLocaleString())}</div>
      <div class="mt-2 text-[11px] text-muted-foreground">Codex tokens recorded for this thread</div>
    </div>
    <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-info/20 bg-background/70 text-info">
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
  return `<div class="rounded-xl border border-border/80 bg-muted/65 px-3 py-3">
    <div class="flex items-start justify-between gap-3">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(label)}</div>
      <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${iconBadgeToneClass(tone)}">
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
  return `<div class="rounded-xl border border-border/80 bg-muted/65 px-3 py-1.5">
    ${rows.map((row, index) => `<div class="flex items-start justify-between gap-3 py-2 ${index > 0 ? "border-t border-border/70" : ""}">
      <div class="flex min-w-0 items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        <span class="text-muted-foreground">${row.icon}</span>
        <span>${esc(row.label)}</span>
      </div>
      <div class="min-w-0 text-right text-[12px] font-medium leading-5 text-foreground [overflow-wrap:anywhere]">${esc(row.value)}</div>
    </div>`).join("")}
  </div>`;
};

const renderSidebarLinks = (profileId: string, obj: FactorySelectedObjectiveCard): string => {
  const otherThreadsHref = withQueryParam(factoryChatQuery({ profileId }), "all", "1");
  return `<div class="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
    <a class="font-medium text-primary hover:underline" href="${otherThreadsHref}">See other threads</a>
    <a class="font-medium text-primary hover:underline" href="${obj.receiptsLink}">Receipts</a>
    <a class="font-medium text-primary hover:underline" href="${obj.debugLink}">Debug</a>
  </div>`;
};


const renderObjectiveLink = (model: FactoryNavModel, objective: FactoryChatObjectiveNav): string => {
  const href = factoryChatQuery({
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: objective.objectiveId,
  });
  const selectedClass = objective.selected
    ? "border-primary/30 bg-primary/10"
    : "border-border bg-muted hover:bg-accent";
  const displayStatus = objective.phase || objective.status;
  const summary = compactStatusText(objective.summary ?? "", 92);
  const tone = toneForValue(displayStatus);
  return `<a class="block min-w-0 rounded-xl border px-3 py-2.5 transition ${selectedClass}" href="${href}">
    <div class="flex min-w-0 items-start gap-2.5">
      <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border border-border/80 bg-background/70 text-muted-foreground">
        ${iconProject("h-4 w-4")}
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold leading-5 text-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">${esc(objective.title)}</div>
        ${summary ? `<div class="mt-1 text-[11px] leading-4 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">${esc(summary)}</div>` : ""}
        ${objective.tokensUsed ? renderObjectiveTokenCallout(objective.tokensUsed) : ""}
      </div>
    </div>
    <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span class="inline-flex items-center gap-1.5 uppercase tracking-[0.18em]" title="${esc(displayLabel(displayStatus) || displayStatus)}">
          ${statusDot(tone)}
          <span class="sr-only">${esc(displayLabel(displayStatus) || displayStatus)}</span>
        </span>
        ${objective.updatedAt ? `<span class="inline-flex items-center gap-1 whitespace-nowrap">${iconClock("h-3 w-3")} ${esc(formatTs(objective.updatedAt))}</span>` : ""}
      </div>
    </div>
  </a>`;
};

const renderSidebarEmptyState = (blankChat: boolean): string =>
  renderEmptyState({
    icon: iconProject("h-5 w-5"),
    tone: "neutral",
    eyebrow: blankChat ? "New Chat" : "Threads",
    title: blankChat ? "No threads yet" : "No tracked threads",
    message: blankChat
      ? "Send the first message below to create a thread in this profile."
      : "This profile does not have any recent objectives to show right now.",
    minHeightClass: "min-h-[168px]",
  });

const renderSidebarMetrics = (profileId: string, obj?: FactorySelectedObjectiveCard): string => {
  if (!obj) return "";
  return `<section class="space-y-2">
    <div class="flex items-center justify-between gap-2">
      <div class="${sectionLabelClass}">Thread Snapshot</div>
      <div class="text-[10px] text-muted-foreground">${esc(titleCaseLabel(obj.slotState ?? obj.phase ?? obj.status) || "Idle")}</div>
    </div>
    ${obj.tokensUsed ? renderSidebarTokenHero(obj.tokensUsed) : ""}
    ${renderSidebarSignalCard(obj)}
    ${renderSidebarDetailRows(obj)}
    ${renderSidebarLinks(profileId, obj)}
  </section>`;
};

const factoryRailIsland = (model: FactoryNavModel, selectedObjective?: FactorySelectedObjectiveCard): string => {
  const blankChat = !selectedObjective;
  const visibleObjectives = model.showAll ? model.objectives : model.objectives.slice(0, 5);
  const hasMoreObjectives = !model.showAll && model.objectives.length > 5;
  const selectedObjectiveQuery = factoryChatQuery({
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: selectedObjective?.objectiveId,
  });
  const viewAllQuery = `${selectedObjectiveQuery}${selectedObjectiveQuery.includes("?") ? "&" : "?"}all=1`;
  const objectiveCards = visibleObjectives.length > 0
    ? visibleObjectives.map((objective) => renderObjectiveLink(model, objective)).join("")
    : renderSidebarEmptyState(blankChat);
  const profileLinks = model.profiles.length > 0
    ? model.profiles.map((profile) => {
        const selectedClass = profile.selected
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-secondary/65 text-muted-foreground hover:bg-accent hover:text-foreground";
        return `<a class="rounded-full border px-3 py-1 text-[11px] font-medium transition ${selectedClass}" href="${factoryChatQuery({
          profileId: profile.id,
          chatId: model.chatId,
          objectiveId: selectedObjective?.objectiveId,
        })}">${esc(profile.label)}</a>`;
      }).join("")
    : "";
  return `<div class="space-y-3 px-3 py-3 md:px-3.5">
    <div class="space-y-2">
      <a class="flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition" href="/receipt">
        ${iconReceipt("text-primary")} Receipt
      </a>
      <div class="flex flex-wrap gap-1.5">
        ${profileLinks}
      </div>
    </div>
    <section class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 ${sectionLabelClass}">${iconChat("w-3.5 h-3.5")} ${blankChat ? "Recent" : "Threads"}</div>
        <div class="text-[10px] text-muted-foreground">${esc(`${model.objectives.length}`)}</div>
      </div>
      <div class="space-y-2">
        ${objectiveCards}
      </div>
      ${hasMoreObjectives ? `<div>
        <button hx-get="/factory/island/sidebar${viewAllQuery}" hx-target="#factory-sidebar" hx-swap="innerHTML" class="text-[10px] font-medium text-primary hover:underline text-left cursor-pointer">View all</button>
      </div>` : ""}
    </section>
    ${renderSidebarMetrics(model.activeProfileId, selectedObjective)}
  </div>`;
};

export const factorySidebarIsland = (model: FactoryNavModel, selectedObjective?: FactorySelectedObjectiveCard): string => factoryRailIsland(model, selectedObjective);

const isTerminalJobStatusValue = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

export const factoryChatShell = (model: FactoryChatShellModel): string => {
  const routeContext: FactoryChatRouteContext = {
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    runId: model.runId,
    jobId: model.jobId,
    panel: model.panel,
    focusKind: model.focusKind,
    focusId: model.focusId,
  };
  const shellQuery = factoryChatQuery(routeContext);
  const composerRouteContext: FactoryChatRouteContext = model.inspector.objectiveMissing
    ? {
        profileId: model.activeProfileId,
        panel: model.panel,
      }
    : routeContext;
  const composerQuery = factoryChatQuery(composerRouteContext);
  const islandTrigger = factoryChatSseTrigger(FACTORY_CHAT_REFRESH_MS);
  const sidebarTrigger = factoryStatusSseTrigger(FACTORY_SIDEBAR_REFRESH_MS);
  const inspectorTabsTrigger = factoryStatusSseTrigger(FACTORY_INSPECTOR_TABS_REFRESH_MS);
  const inspectorPanelTrigger = factoryStatusSseTrigger(FACTORY_INSPECTOR_PANEL_REFRESH_MS);
  const currentJobId = model.inspector.objectiveMissing ? undefined : composerJobId(model);
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
  <script src="/assets/htmx.min.js"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.1/sse.js"></script>
</head>
<body data-factory-chat data-focus-kind="${esc(model.focusKind ?? "")}" data-focus-id="${esc(model.focusId ?? "")}" class="font-sans antialiased overflow-x-hidden md:h-screen md:overflow-hidden" hx-ext="sse" sse-connect="/factory/events${shellQuery}">
  <div class="relative min-h-screen bg-background text-foreground md:h-screen">
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(13_73%_55%/0.06),transparent_40%),radial-gradient(circle_at_top_right,hsl(210_38%_65%/0.08),transparent_40%)]"></div>
    <div class="relative flex min-h-screen flex-col md:grid md:h-screen md:min-h-0 md:grid-cols-[248px_minmax(0,1fr)_320px] lg:grid-cols-[256px_minmax(0,1fr)_336px] md:overflow-hidden">
      <aside class="order-2 min-w-0 overflow-hidden border-t border-sidebar-border bg-sidebar text-sidebar-foreground md:order-0 md:min-h-0 md:border-r md:border-t-0">
        <div class="factory-scrollbar max-h-[40vh] overflow-x-hidden overflow-y-auto md:h-full md:max-h-none">
          <div id="factory-sidebar" hx-get="/factory/island/sidebar${shellQuery}" hx-trigger="${sidebarTrigger}" hx-swap="innerHTML">
            ${factoryRailIsland(model.nav, model.inspector.selectedObjective)}
          </div>
        </div>
      </aside>
      <main class="order-1 min-w-0 overflow-hidden bg-background md:order-0 md:min-h-0">
        <div class="flex min-h-screen flex-col md:h-full md:min-h-0">
          <header class="shrink-0 border-b border-border bg-card/80 backdrop-blur-xl">
            <div class="flex items-center justify-between gap-3 px-4 py-2.5">
              <div class="min-w-0 flex flex-1 items-center gap-2 overflow-x-auto factory-scrollbar">
                <span class="flex items-center gap-1.5 ${sectionLabelClass}">${iconChat("w-3.5 h-3.5")} Thread</span>
                <h1 class="min-w-0 truncate text-sm font-semibold text-foreground" data-profile-label>${esc(shellHeaderTitle(model))}</h1>
                ${renderShellStatusPills(model)}
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                <a
                  class="group inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-sm transition hover:border-primary/35 hover:bg-primary/15 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  href="/factory/new-chat?profile=${encodeURIComponent(model.activeProfileId)}"
                  aria-label="Start a new chat"
                  title="New chat"
                >
                  ${iconPlus("h-3 w-3")}
                </a>
              </div>
            </div>
          </header>
          <section id="factory-chat-scroll" class="factory-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div id="factory-chat" hx-get="/factory/island/chat${shellQuery}" hx-trigger="${islandTrigger}" hx-swap="innerHTML">
              ${factoryChatIsland(model.chat)}
            </div>
          </section>
          <section class="shrink-0 border-t border-border bg-background px-2 py-2 sm:px-3">
            <div class="${composerShellClass}">
              <form id="factory-composer" action="/factory/compose${composerQuery}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
                ${currentJobId ? `<input type="hidden" name="currentJobId" value="${esc(currentJobId)}" />` : ""}
                <label class="sr-only" for="factory-prompt">Factory prompt</label>
                <div class="${composerPanelClass}">
                  <div class="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
                    <textarea id="factory-prompt" name="prompt" class="${composerTextareaClass} sm:min-h-[104px]" rows="2" placeholder="${esc(composerPlaceholder)}" autofocus aria-autocomplete="list" aria-expanded="false" aria-controls="factory-composer-completions" aria-haspopup="listbox"></textarea>
                    <button id="factory-composer-submit" class="inline-flex min-h-[88px] w-full shrink-0 items-center justify-center rounded-xl border border-primary/40 bg-primary px-6 py-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground sm:w-[8.5rem] sm:min-h-[104px]" type="submit">Send</button>
                  </div>
                  <div id="factory-composer-completions" class="hidden max-h-56 overflow-auto rounded-xl border border-border bg-background shadow-lg" role="listbox" aria-label="Slash command suggestions"></div>
                </div>
                <div id="factory-composer-status" class="mt-2 hidden rounded-lg border border-border bg-muted px-3 py-1.5 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
              </form>
            </div>
          </section>
        </div>
      </main>
      <aside class="order-3 min-w-0 overflow-hidden border-t border-sidebar-border bg-sidebar text-sidebar-foreground md:min-h-0 md:border-l md:border-t-0">
        <div class="factory-scrollbar max-h-[45vh] overflow-x-hidden overflow-y-auto md:h-full md:max-h-none">
          <div id="factory-inspector" class="factory-inspector-panel">
            ${factoryInspectorIsland(model.inspector, {
              tabsTrigger: inspectorTabsTrigger,
              panelTrigger: inspectorPanelTrigger,
            })}
          </div>
        </div>
      </aside>
    </div>
  </div>
  <script src="/assets/factory-client.js"></script>
</body>
</html>`;
};
