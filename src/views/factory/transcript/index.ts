import {
  badge,
  displayLabel,
  esc,
  iconChat,
  iconForEntity,
  iconProject,
  iconBadgeToneClass,
  renderEmptyState,
  renderJobActionCards,
  sectionLabelClass,
  toneForValue,
} from "../../ui";
import type {
  FactoryChatItem,
  FactoryChatIslandModel,
  FactoryWorkCard,
} from "../../factory-models";
import {
  assistantResponseBodyClass,
  assistantResponseCardClass,
  compactStatusText,
  factoryChatQuery,
} from "../shared";
import { renderMarkdown } from "../shared/markdown";

const renderJobControls = (jobId: string, running?: boolean, abortRequested?: boolean): string =>
  running
    ? `<details class="mt-3 border border-border bg-background/70 px-3 py-2">
      <summary class="cursor-pointer list-none text-[11px] font-medium text-muted-foreground hover:text-foreground">Need to stop this job?</summary>
      <div class="mt-2">${renderJobActionCards(jobId, { abortRequested })}</div>
    </details>`
    : "";

const renderWorkControls = (card: FactoryWorkCard): string =>
  card.jobId ? renderJobControls(card.jobId, card.running, card.abortRequested) : "";

const systemItemTone = (item: Extract<FactoryChatItem, { readonly kind: "system" }>): "neutral" | "info" | "success" | "warning" | "danger" => {
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
      ${metadata.map((value) => `<span class="border border-border bg-background px-2 py-1">${esc(value)}</span>`).join("")}
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

const renderChatItem = (
  item: FactoryChatItem,
  context: {
    readonly activeProfileId: string;
    readonly activeProfileLabel: string;
    readonly activeProfilePrimaryRole?: string;
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
    const speakerLabel = context.activeProfilePrimaryRole ?? context.activeProfileLabel;
    return `<section class="flex justify-start">
      <div class="w-full max-w-3xl space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-1.5 ${sectionLabelClass}">${iconChat("w-3.5 h-3.5")} ${esc(speakerLabel)}</div>
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

const renderWorkGroup = (
  items: ReadonlyArray<Extract<FactoryChatItem, { readonly kind: "work" }>>,
  context: {
    readonly activeProfileId: string;
    readonly activeProfileLabel: string;
    readonly activeProfilePrimaryRole?: string;
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

const durableObjectiveHandoffObjectiveId = (item: FactoryChatItem): string | undefined => {
  if (item.kind !== "assistant") return undefined;
  const match = item.key.match(/^run_objective_handoff_(.+)_[a-f0-9]{16}-objective-handoff-/);
  return match?.[1];
};

const collapseDurableObjectiveHandoffs = (
  items: ReadonlyArray<FactoryChatItem>,
): ReadonlyArray<FactoryChatItem> => {
  const latestIndexByObjectiveId = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const objectiveId = durableObjectiveHandoffObjectiveId(items[index]!);
    if (!objectiveId) continue;
    latestIndexByObjectiveId.set(objectiveId, index);
  }
  if (latestIndexByObjectiveId.size === 0) return items;
  return items.filter((item, index) => {
    const objectiveId = durableObjectiveHandoffObjectiveId(item);
    if (!objectiveId) return true;
    return latestIndexByObjectiveId.get(objectiveId) === index;
  });
};

const synthesizedTranscriptItems = (model: FactoryChatIslandModel): ReadonlyArray<FactoryChatItem> => {
  const thread = model.selectedThread;
  const transcriptItems = hasDurableObjectiveHandoff(model.items)
    ? collapseDurableObjectiveHandoffs(model.items)
    : model.items;
  if (hasDurableObjectiveHandoff(transcriptItems)) return transcriptItems;
  const blockedHandoff = blockedObjectiveTranscriptItem(model);
  if (transcriptItems.length > 0) {
    return blockedHandoff ? [...transcriptItems, blockedHandoff] : transcriptItems;
  }
  const summary = thread?.summary?.trim();
  if (blockedHandoff) return [blockedHandoff];
  if (!thread || !isTerminalObjectiveStatusValue(thread.status) || !summary) return transcriptItems;
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

const isTerminalObjectiveStatusValue = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const isGenericCompletedNextAction = (value?: string): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "investigation is complete." || normalized === "objective is complete.";
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
    activeProfileId: model.activeProfileId,
    activeProfileLabel: model.activeProfileLabel,
    activeProfilePrimaryRole: model.activeProfilePrimaryRole,
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
        title: options?.emptyState?.title ?? (model.objectiveId ? "This thread is quiet." : "Start a new chat"),
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

export { renderTranscriptContent };
