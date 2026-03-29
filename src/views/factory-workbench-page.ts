import {
  badge,
  CSS_VERSION,
  dangerButtonClass,
  displayLabel,
  esc,
  formatTs,
  ghostButtonClass,
  iconClock,
  iconFactory,
  iconTokens,
  iconWorker,
  liveIslandAttrs,
  statPill,
  statusDot,
  toneForValue,
  truncate,
} from "./ui";
import {
  renderFactoryStreamingShell,
  renderFactoryTranscriptSection,
} from "./factory-chat";
import { renderFactoryRunSteps } from "./factory-live-steps";
import { COMPOSER_COMMANDS } from "../factory-cli/composer";
import type {
  FactoryChatIslandModel,
  FactoryChatProfileNav,
  FactoryChatObjectiveNav,
  FactorySelectedObjectiveCard,
  FactoryWorkbenchActivitySectionModel,
  FactoryWorkbenchBlockModel,
  FactoryWorkbenchFilterKey,
  FactoryWorkbenchObjectiveListSectionModel,
  FactoryWorkbenchPageModel,
  FactoryWorkbenchSectionModel,
  FactoryWorkbenchSummarySectionModel,
  FactoryWorkbenchWorkspaceModel,
} from "./factory-models";

export type FactoryWorkbenchRouteContext = {
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly filter: FactoryWorkbenchFilterKey;
};

export type FactoryWorkbenchShellSnapshot = {
  readonly pageTitle: string;
  readonly route: FactoryWorkbenchRouteContext;
  readonly location?: string;
  readonly backgroundEventsPath: string;
  readonly chatEventsPath: string;
  readonly workbenchHeaderPath: string;
  readonly workbenchIslandPath: string;
  readonly chatIslandPath: string;
  readonly workbenchHeaderHtml: string;
  readonly chatHeaderHtml: string;
  readonly workbenchHtml: string;
  readonly chatHtml: string;
  readonly composeAction: string;
  readonly composerPlaceholder: string;
  readonly streamingLabel: string;
};

type WorkbenchProjection = "profile-board" | "objective-runtime";

const workbenchChatRefreshOn = [
  { event: "agent-refresh", throttleMs: 180 },
  { event: "job-refresh", throttleMs: 180 },
  { kind: "body", event: "factory:chat-refresh" },
] as const;
const workbenchBackgroundRefreshOn = [
  { event: "profile-board-refresh", throttleMs: 350 },
  { event: "objective-runtime-refresh", throttleMs: 350 },
  { kind: "body", event: "factory:workbench-refresh" },
  { kind: "body", event: "factory:scope-changed" },
] as const;
const workbenchHeaderRefreshOn = [
  { event: "profile-board-refresh", throttleMs: 300 },
  { event: "objective-runtime-refresh", throttleMs: 300 },
  { kind: "body", event: "factory:workbench-refresh" },
  { kind: "body", event: "factory:scope-changed" },
] as const;

const composerCommandsJson = (): string => JSON.stringify(COMPOSER_COMMANDS.map((command) => ({
  name: command.name,
  label: command.label,
  usage: command.usage,
  description: command.description,
  aliases: command.aliases ?? [],
})));

const workbenchQueryParams = (input: FactoryWorkbenchRouteContext): URLSearchParams => {
  const params = new URLSearchParams();
  params.set("profile", input.profileId);
  params.set("chat", input.chatId);
  if (input.objectiveId) params.set("objective", input.objectiveId);
  if (input.filter !== "all") params.set("filter", input.filter);
  if (input.focusKind && input.focusId) {
    params.set("focusKind", input.focusKind);
    params.set("focusId", input.focusId);
  }
  return params;
};

const workbenchQuery = (input: FactoryWorkbenchRouteContext): string => {
  const params = workbenchQueryParams(input);
  const query = params.toString();
  return query ? `?${query}` : "";
};

const chatEventsPath = (input: Pick<FactoryWorkbenchRouteContext, "profileId" | "chatId">): string =>
  `/factory/chat/events${workbenchQuery({
    profileId: input.profileId,
    chatId: input.chatId,
    filter: "all",
  })}`;

const backgroundEventsPath = (input: FactoryWorkbenchRouteContext): string =>
  `/factory/background/events${workbenchQuery(input)}`;

const workbenchHeaderPath = (input: FactoryWorkbenchRouteContext): string =>
  `/factory/island/workbench/header${workbenchQuery(input)}`;

const workbenchBlockPath = (
  input: FactoryWorkbenchRouteContext,
  blockKey: FactoryWorkbenchBlockModel["key"],
): string => {
  const params = workbenchQueryParams(input);
  params.set("block", blockKey);
  const query = params.toString();
  return `/factory/island/workbench/block${query ? `?${query}` : ""}`;
};

const workbenchIslandPath = (input: FactoryWorkbenchRouteContext): string =>
  `/factory/island/workbench${workbenchQuery(input)}`;

const chatIslandPath = (input: FactoryWorkbenchRouteContext): string =>
  `/factory/island/chat${workbenchQuery(input)}`;

const workbenchIslandBindings = (input: FactoryWorkbenchRouteContext) => ({
  header: {
    path: workbenchHeaderPath(input),
    refreshOn: workbenchHeaderRefreshOn,
  },
  background: {
    path: workbenchIslandPath(input),
    refreshOn: workbenchBackgroundRefreshOn,
  },
  chat: {
    path: chatIslandPath(input),
    refreshOn: workbenchChatRefreshOn,
  },
});

const uniqueWorkbenchProjections = (
  values: ReadonlyArray<WorkbenchProjection>,
): ReadonlyArray<WorkbenchProjection> => {
  const seen = new Set<WorkbenchProjection>();
  const unique: WorkbenchProjection[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
};

const workbenchProjectionEvent = (projection: WorkbenchProjection): `${WorkbenchProjection}-refresh` =>
  `${projection}-refresh`;

const workbenchBlockProjections = (
  block: FactoryWorkbenchBlockModel,
): ReadonlyArray<WorkbenchProjection> => {
  switch (block.key) {
    case "objectives":
    case "history":
      return ["profile-board"];
    case "activity":
      return ["objective-runtime"];
    case "summary":
    default:
      return ["profile-board", "objective-runtime"];
  }
};

const workbenchBlockRefreshOn = (
  projections: ReadonlyArray<WorkbenchProjection>,
) => [
  ...uniqueWorkbenchProjections(projections).map((projection) => ({
    event: workbenchProjectionEvent(projection),
    throttleMs: 320,
  })),
  { kind: "body" as const, event: "factory:workbench-refresh" },
  { kind: "body" as const, event: "factory:scope-changed" },
] as const;

const workbenchComposerPlaceholder = (objectiveId?: string): string => objectiveId
  ? "Chat with Factory, use /obj to create a new objective, or use /react to update the selected objective."
  : "Chat with Factory or use /obj to create an objective.";

const isTerminalObjectiveStatusValue = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const workbenchComposerPlaceholderForSelection = (input: {
  readonly objectiveId?: string;
  readonly selectedObjective?: Pick<FactorySelectedObjectiveCard, "status">;
}): string => {
  if (!input.objectiveId && !input.selectedObjective) return workbenchComposerPlaceholder();
  if (input.selectedObjective?.status === "blocked") {
    return "Use /react <guidance> to continue the selected objective, or plain text to stay in chat.";
  }
  if (isTerminalObjectiveStatusValue(input.selectedObjective?.status)) {
    return "Use /obj to start a follow-up objective, or plain text to discuss the next step.";
  }
  return workbenchComposerPlaceholder(
    input.objectiveId || input.selectedObjective ? "selected" : undefined,
  );
};

const workbenchComposerHelperText = (input: {
  readonly objectiveId?: string;
  readonly selectedObjective?: Pick<FactorySelectedObjectiveCard, "status">;
}): string => {
  const selected = input.selectedObjective;
  if (!input.objectiveId && !selected) return "Use /obj to create directly.";
  if (selected?.status === "blocked") {
    return "Selected objective is blocked. Use /react <guidance> to continue it, /cancel to stop it, or plain text to stay in chat.";
  }
  if (isTerminalObjectiveStatusValue(selected?.status)) {
    const label = displayLabel(selected?.status) || "terminal";
    return `Selected objective is ${label.toLowerCase()}. Use /obj to start follow-up work, or plain text to discuss next steps.`;
  }
  return "Plain text stays chat-first. Use /react <guidance> to update the selected objective.";
};

const renderComposerPrefillButton = (
  label: string,
  command: string,
  className: string,
): string => `<button type="button" onclick="document.getElementById('factory-prompt').value = '${command}'; document.getElementById('factory-prompt').focus();" class="${className} !py-1.5 !px-3 !text-[11px]">${esc(label)}</button>`;

const renderWorkbenchComposerQuickActions = (input: {
  readonly objectiveId?: string;
  readonly selectedObjective?: Pick<FactorySelectedObjectiveCard, "status">;
}): string => {
  if (!input.objectiveId && !input.selectedObjective) return "";
  const selected = input.selectedObjective;
  const buttons = [
    renderComposerPrefillButton("React", "/react ", ghostButtonClass),
    renderComposerPrefillButton("New Objective", "/obj ", ghostButtonClass),
  ];
  if (selected) {
    if (isTerminalObjectiveStatusValue(selected.status)) {
      buttons.push(renderComposerPrefillButton("Archive", "/archive ", ghostButtonClass));
    } else {
      buttons.push(renderComposerPrefillButton("Cancel", "/cancel ", dangerButtonClass));
    }
  }
  return `<div class="flex flex-wrap items-center gap-2">${buttons.join("")}</div>`;
};

const objectiveHref = (
  input: FactoryWorkbenchRouteContext,
  objectiveId?: string,
  focus?: {
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  },
  profileId?: string,
): string => `/factory${workbenchQuery({
  ...input,
  profileId: profileId ?? input.profileId,
  objectiveId,
  focusKind: focus?.focusKind,
  focusId: focus?.focusId,
})}`;

const filterHref = (
  input: FactoryWorkbenchRouteContext,
  filter: FactoryWorkbenchFilterKey,
): string => `/factory${workbenchQuery({
  ...input,
  filter,
})}`;

const profileSelectClass = "min-h-[2.5rem] min-w-[12rem] rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground outline-none transition focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/30";

const tooltipAttr = (value?: string): string => {
  const trimmed = value?.trim();
  return trimmed ? ` title="${esc(trimmed)}"` : "";
};

const renderTooltipChip = (label: string, detail?: string): string => {
  const trimmed = detail?.trim();
  if (!trimmed) return "";
  return `<span class="inline-flex items-center rounded-full border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground"${tooltipAttr(trimmed)}>${esc(label)}</span>`;
};

const renderProfileSelect = (input: {
  readonly id: string;
  readonly label: string;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
  readonly compact?: boolean;
}): string => {
  if (input.profiles.length === 0) return "";
  return `<label class="flex min-w-[14rem] flex-col gap-1.5">
    <span class="text-[12px] font-medium text-muted-foreground">${esc(input.label)}</span>
    <select id="${esc(input.id)}" data-factory-profile-select="true" class="${profileSelectClass} ${input.compact ? "min-h-[2.5rem]" : ""}">
      ${input.profiles.map((profile) => `<option value="${esc(profile.href)}"${profile.selected ? " selected" : ""}>${esc(profile.label)}</option>`).join("")}
    </select>
  </label>`;
};

const engineerPrimaryRole = (model: FactoryChatIslandModel): string | undefined =>
  model.activeProfilePrimaryRole
  ?? model.activeProfileRoles?.[0]
  ?? model.activeProfileSummary;

const engineerPresence = (model: FactoryChatIslandModel): string | undefined => {
  const summary = model.activeProfileSummary?.trim();
  if (!summary) return undefined;
  const primaryRole = engineerPrimaryRole(model)?.trim();
  return primaryRole && primaryRole === summary ? undefined : summary;
};

const engineerResponsibilities = (model: FactoryChatIslandModel): ReadonlyArray<string> => {
  if ((model.activeProfileResponsibilities?.length ?? 0) > 0) {
    return model.activeProfileResponsibilities!.slice(0, 4);
  }
  const responsibilitiesSection = (model.activeProfileSections ?? [])
    .find((section) => section.title.trim().toLowerCase() === "responsibilities");
  return (responsibilitiesSection?.items ?? []).slice(0, 4);
};

const renderEngineerCard = (model: FactoryChatIslandModel): string => {
  const primaryRole = engineerPrimaryRole(model);
  const presence = engineerPresence(model);
  const responsibilities = engineerResponsibilities(model);
  const compact = model.items.length > 0;
  const presencePreview = presence ? truncate(presence, compact ? 88 : 120) : undefined;
  const notes = responsibilities.length > 0 ? responsibilities.join(" • ") : undefined;
  return `<section class="border-b border-border ${compact ? "pb-3" : "pb-4"}">
    <div class="flex items-start gap-${compact ? "2.5" : "3"}">
      <span class="mt-0.5 flex ${compact ? "h-6 w-6" : "h-7 w-7"} shrink-0 items-center justify-center text-primary">${iconWorker(compact ? "h-3.5 w-3.5" : "h-4 w-4")}</span>
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <div class="${compact ? "text-[13px]" : "text-sm"} font-semibold text-foreground">${esc(model.activeProfileLabel)}</div>
          ${primaryRole ? `<div class="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground"${tooltipAttr(primaryRole)}>${esc(truncate(primaryRole, compact ? 30 : 42))}</div>` : ""}
          ${!compact && notes ? renderTooltipChip("Notes", notes) : ""}
        </div>
        ${presencePreview ? `<div class="mt-1 max-w-[34ch] text-[11px] leading-5 text-muted-foreground"${tooltipAttr(presence)}>${esc(presencePreview)}</div>` : ""}
      </div>
    </div>
  </section>`;
};

const renderWorkbenchLiveStatus = (model: FactoryChatIslandModel): string => {
  const latestStep = model.activeRun?.steps?.at(-1);
  const activeChild = model.activeCodex
    ?? (model.liveChildren ?? []).find((child) =>
      child.status === "queued" || child.status === "leased" || child.status === "running"
    )
    ?? model.liveChildren?.[0];
  const status = model.activeRun?.status ?? activeChild?.status;
  const summarySource = model.activeRun?.summary
    ?? activeChild?.latestNote
    ?? activeChild?.summary
    ?? latestStep?.summary;
  if (!status && !summarySource && !latestStep) return "";
  const summary = truncate(summarySource ?? `${model.activeProfileLabel} is working on this conversation.`, 180);
  const latestStepSummary = latestStep ? truncate(latestStep.summary, 150) : undefined;
  const childSummary = activeChild
    ? truncate(activeChild.latestNote ?? activeChild.summary ?? activeChild.task ?? "Worker is processing the request.", 150)
    : undefined;
  return `<section class="rounded-xl border border-border bg-card/90 px-3 py-3 shadow-sm">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Live status</div>
        <div class="mt-1 text-sm font-semibold text-foreground">${esc(displayLabel(status) || "Working")}</div>
        <div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(summary)}</div>
      </div>
      ${badge(displayLabel(status) || "Live", toneForValue(status))}
    </div>
    <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      ${model.activeRun?.updatedAt ? `<span class="inline-flex items-center gap-1">${iconClock("h-3 w-3")} ${esc(formatTs(model.activeRun.updatedAt))}</span>` : ""}
      ${typeof activeChild?.tokensUsed === "number" ? `<span class="inline-flex items-center gap-1">${iconTokens("h-3 w-3")} ${esc(activeChild.tokensUsed.toLocaleString())}</span>` : ""}
    </div>
    ${latestStep
      ? `<div class="mt-3 rounded-lg border border-border bg-background/60 px-3 py-2">
        <div class="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Now</div>
        <div class="mt-1 text-xs font-semibold text-foreground">${esc(latestStep.label)}</div>
        ${latestStepSummary ? `<div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(latestStepSummary)}</div>` : ""}
      </div>`
      : ""}
    ${activeChild && childSummary
      ? `<div class="mt-2 rounded-lg border border-border bg-background/60 px-3 py-2">
        <div class="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          ${iconFactory("h-3.5 w-3.5")}
          <span>${esc(displayLabel(model.activeCodex ? "codex" : activeChild.worker || activeChild.agentId) || "Worker")}</span>
          ${badge(displayLabel(activeChild.status), toneForValue(activeChild.status))}
        </div>
        <div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(childSummary)}</div>
      </div>`
      : ""}
  </section>`;
};

const renderFilterPill = (
  routeContext: FactoryWorkbenchRouteContext,
  filter: FactoryWorkbenchWorkspaceModel["filters"][number],
): string => `<a href="${filterHref(routeContext, filter.key)}" class="inline-flex items-center gap-2 border-b-2 px-0 py-1.5 text-sm font-medium transition ${filter.selected
  ? "border-primary text-foreground"
  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"}">
  <span>${esc(filter.label)}</span>
  <span class="text-[11px] text-muted-foreground">${esc(String(filter.count))}</span>
</a>`;

const renderObjectiveCard = (
  routeContext: FactoryWorkbenchRouteContext,
  objective: FactoryChatObjectiveNav,
): string => `<a href="${objectiveHref(routeContext, objective.objectiveId, undefined, objective.profileId)}" class="block border-l-2 px-4 py-3 transition ${objective.selected
  ? "border-primary bg-muted/35"
  : "border-transparent bg-background hover:bg-accent/45"}">
  <div class="flex items-start gap-3">
    <div class="pt-1">${statusDot(toneForValue(objective.blockedReason ? "blocked" : (objective.phase || objective.status)))}</div>
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        <div class="min-w-0 truncate text-sm font-semibold text-foreground">${esc(objective.title)}</div>
        ${badge(displayLabel(objective.phase || objective.status) || "Idle", toneForValue(objective.phase || objective.status))}
      </div>
      <div class="mt-1 text-sm leading-6 text-muted-foreground">${esc(objective.summary ?? objective.blockedReason ?? "Objective activity will appear here.")}</div>
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        <span>${esc(objective.objectiveId)}</span>
        <span>${esc(`${objective.activeTaskCount ?? 0}/${objective.taskCount ?? 0} tasks`)}</span>
        ${objective.updatedAt ? `<span class="inline-flex items-center gap-1">${iconClock("h-3 w-3")} ${esc(formatTs(objective.updatedAt))}</span>` : ""}
      </div>
    </div>
  </div>
</a>`;

const renderSummarySection = (section: FactoryWorkbenchSummarySectionModel): string => {
  const statsRow = section.stats.length > 0
    ? `<div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      ${section.stats.map((stat) => statPill(stat.label, stat.value)).join("")}
    </div>`
    : "";
  if (section.empty) {
    return `<section class="border-b border-border pb-5">
      <div class="text-sm font-semibold text-foreground">${esc(section.title)}</div>
      <div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(section.message)}</div>
      ${statsRow}
      <div class="mt-5 border-l-2 border-border pl-4">
        <div class="flex items-center gap-2 text-sm font-medium text-foreground">${iconFactory("h-4 w-4")} No objective selected.</div>
        <div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(section.message)}</div>
        <div class="mt-1 text-[12px] leading-5 text-muted-foreground">Use chat to create a new objective with <code>/obj</code> or pick one from the queue below.</div>
      </div>
    </section>`;
  }
  return `<section class="border-b border-border pb-5">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="min-w-0 flex-1">
        <div class="text-[11px] text-muted-foreground">${esc(section.title)}</div>
        <div class="mt-1 text-sm font-semibold text-foreground">${esc(section.headline)}</div>
        <div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(section.message)}</div>
      </div>
      ${section.tokenCount
        ? `<div class="inline-flex items-center gap-2 text-[12px] font-medium text-foreground">
          <span class="text-info">${iconTokens("h-4 w-4")}</span>
          <span>Tokens ${esc(section.tokenCount)}</span>
        </div>`
        : ""}
    </div>
    ${statsRow}
  </section>`;
};

const renderObjectiveListSection = (
  section: FactoryWorkbenchObjectiveListSectionModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `<section class="border-b border-border pb-4">
  <div class="flex items-center justify-between gap-3 pb-2">
    <div class="text-sm font-semibold text-foreground">${esc(section.title)}</div>
    <div class="text-[12px] text-muted-foreground">${esc(String(section.count))}</div>
  </div>
  ${section.items.length > 0
    ? `<div class="divide-y divide-border border-y border-border">
      ${section.items.map((objective) => renderObjectiveCard(routeContext, objective)).join("")}
    </div>`
    : `<div class="py-3 text-sm leading-6 text-muted-foreground">${esc(section.emptyMessage)}</div>`}
</section>`;

const renderActivitySection = (section: FactoryWorkbenchActivitySectionModel): string => {
  const focusCard = section.focus
    ? `<div class="border-l-2 border-primary pl-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold text-foreground">${esc(section.focus.title)}</div>
          <div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(section.focus.summary)}</div>
        </div>
        ${badge(displayLabel(section.focus.status), toneForValue(section.focus.status))}
      </div>
      </div>`
    : "";
  const escalationCallout = section.callout
    ? `<div class="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs leading-5 text-foreground">
      ${esc(section.callout)}
    </div>`
    : "";
  const stepsSection = section.run
    ? renderFactoryRunSteps(section.run, {
        title: "Supervisor Steps",
        subtitle: "Recent orchestration and worker progress.",
      })
    : "";
  const activitySection = section.items.length > 0
    ? `<div class="divide-y divide-border border-y border-border">
      ${section.items.map((entry, index) => `<div class="${index > 0 ? "border-t border-border " : ""}px-4 py-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold text-foreground">${esc(entry.title)}</div>
            <div class="mt-1 text-sm leading-6 text-muted-foreground">${esc(entry.summary)}</div>
          </div>
          <div class="shrink-0 text-[11px] font-medium text-muted-foreground">${esc(entry.kind)}</div>
        </div>
        <div class="mt-2 flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
          <span>${esc(entry.meta ?? "")}</span>
          ${entry.at ? `<span class="inline-flex items-center gap-1">${iconClock("h-3 w-3")} ${esc(formatTs(entry.at))}</span>` : ""}
        </div>
      </div>`).join("")}
    </div>`
    : `<div class="text-sm leading-6 text-muted-foreground">${esc(section.emptyMessage)}</div>`;
  return `<section class="border-b border-border pb-5">
    <div class="flex items-center justify-between gap-3">
      <div class="text-sm font-semibold text-foreground">${esc(section.title)}</div>
      <div class="text-[12px] text-muted-foreground">${esc(String(section.count))}</div>
    </div>
    <div class="mt-4 space-y-4">
      ${focusCard}
      ${escalationCallout}
      ${stepsSection}
      ${activitySection}
    </div>
  </section>`;
};

const renderBlock = (
  block: FactoryWorkbenchWorkspaceModel["blocks"][number],
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const rendered = block.sections.map((section) => {
    switch (section.shape) {
      case "summary":
        return renderSummarySection(section);
      case "activity-list":
        return renderActivitySection(section);
      case "objective-list":
      default:
        return renderObjectiveListSection(section, routeContext);
    }
  }).join("");
  if (block.layout === "split") {
    return `<div class="grid gap-4 xl:grid-cols-[minmax(0,1.02fr)_minmax(300px,0.98fr)]">${rendered}</div>`;
  }
  return rendered;
};

const renderWorkbenchBlockIsland = (
  block: FactoryWorkbenchWorkspaceModel["blocks"][number],
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const projections = workbenchBlockProjections(block);
  return `<div id="factory-workbench-block-${esc(block.key)}" data-workbench-projections="${esc(projections.join(" "))}" ${liveIslandAttrs({
    path: workbenchBlockPath(routeContext, block.key),
    refreshOn: workbenchBlockRefreshOn(projections),
  })}>
    ${renderBlock(block, routeContext)}
  </div>`;
};

export const factoryWorkbenchWorkspaceIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `<div class="factory-scrollbar flex flex-col gap-4 pr-1 lg:h-full lg:min-h-0 lg:overflow-y-auto" data-workbench-objective-id="${esc(workspace.objectiveId ?? "")}" data-workbench-filter="${esc(workspace.filter)}">
  ${workspace.blocks.map((block) => renderWorkbenchBlockIsland(block, routeContext)).join("")}
</div>`;

export const factoryWorkbenchChatIsland = (
  model: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `<div class="flex min-h-0 flex-col gap-4" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}" data-chat-id="${esc(model.chatId ?? "")}" data-objective-id="${esc(model.objectiveId ?? "")}" data-active-run-id="${esc(model.runId ?? "")}" data-known-run-ids="${esc((model.knownRunIds ?? []).join(","))}" data-terminal-run-ids="${esc((model.terminalRunIds ?? []).join(","))}">
  ${model.items.length === 0 ? renderEngineerCard(model) : ""}
  ${renderWorkbenchLiveStatus(model)}
  ${renderFactoryTranscriptSection(model, {
    sectionLabel: "Chat",
    objectiveHref: (objectiveId) => objectiveHref(routeContext, objectiveId),
    emptyState: {
      title: "Start a conversation.",
      message: "Use chat to discuss work, ask Factory questions, or use /obj to create an objective directly.",
      detail: "Objective links created from chat stay clickable and update the workbench without replacing the chat session.",
    },
  })}
</div>`;

export const factoryWorkbenchBlockIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
  blockKey: FactoryWorkbenchBlockModel["key"],
): string => {
  const block = workspace.blocks.find((candidate) => candidate.key === blockKey);
  return block ? renderBlock(block, routeContext) : "";
};

const renderWorkbenchHeader = (
  model: FactoryWorkbenchPageModel,
  routeContext: FactoryWorkbenchRouteContext,
  workbenchSummaryPreview: string,
  workbenchSummary: string,
): string => `<div class="flex flex-wrap items-start justify-between gap-4">
  <div class="min-w-0 flex-1">
    <div class="inline-flex items-center gap-2.5">
      <span class="inline-flex h-9 w-9 items-center justify-center border border-border bg-primary/10 text-primary">
        ${iconFactory("h-4.5 w-4.5")}
      </span>
      <div class="min-w-0">
        <div class="text-[11px] font-semibold uppercase tracking-[0.26em] text-primary">receipt</div>
        <div class="mt-1 flex flex-wrap items-center gap-2">
          <div class="text-[15px] font-semibold leading-none text-foreground">${esc(model.activeProfileLabel)}</div>
          <div class="text-[12px] font-medium uppercase tracking-[0.16em] text-muted-foreground">factory</div>
        </div>
      </div>
    </div>
    <div class="mt-1 max-w-[70ch] text-[12px] leading-5 text-muted-foreground"${tooltipAttr(workbenchSummary)}>${esc(workbenchSummaryPreview)}</div>
  </div>
  <div class="flex flex-wrap items-center gap-3">
    ${renderProfileSelect({
      id: "factory-workbench-profile-select",
      label: "Engineer",
      profiles: model.profiles,
    })}
    <div class="flex flex-wrap items-center gap-2 text-[12px] leading-none text-muted-foreground">
      ${model.workspace.selectedObjective?.tokensUsed !== undefined
        ? `<span class="inline-flex items-center gap-1 text-foreground"><span class="text-info">${iconTokens("h-3.5 w-3.5")}</span>${esc(model.workspace.selectedObjective.tokensUsed.toLocaleString())} tokens</span>`
        : ""}
      ${model.chatId
        ? `<span class="inline-flex items-center gap-1"${tooltipAttr(`Conversation ${model.chatId}`)}>${iconWorker("h-3.5 w-3.5")} Session</span>`
        : ""}
    </div>
  </div>
</div>
<div class="mt-3 flex flex-wrap items-center gap-2">
  <div class="text-[11px] font-medium text-muted-foreground">Filters</div>
  <div class="flex flex-wrap gap-4">
    ${model.workspace.filters.map((filter) => renderFilterPill(routeContext, filter)).join("")}
  </div>
</div>`;

export const factoryWorkbenchHeaderIsland = (
  model: FactoryWorkbenchPageModel,
): string => {
  const routeContext: FactoryWorkbenchRouteContext = {
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    focusKind: model.focusKind,
    focusId: model.focusId,
    filter: model.filter,
  };
  const activeRole = engineerPrimaryRole(model.chat);
  const activePresence = engineerPresence(model.chat);
  const workbenchSummary = activePresence
    ?? activeRole
    ?? "Profile-scoped objectives, recent activity, and receipts-backed progress.";
  return renderWorkbenchHeader(model, routeContext, truncate(workbenchSummary, 120), workbenchSummary);
};

const renderWorkbenchChatHeader = (
  model: FactoryWorkbenchPageModel,
  activeRole?: string,
  activePresence?: string,
): string => `<div class="flex items-start justify-between gap-3">
  <div class="min-w-0">
    <div class="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">conversation</div>
    <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
      <div class="text-[13px] font-semibold text-foreground">${esc(model.activeProfileLabel)}</div>
      ${activeRole ? `<div class="text-[10px] text-muted-foreground"${tooltipAttr(activeRole)}>${esc(truncate(activeRole, 32))}</div>` : ""}
      ${activePresence ? `<span class="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"${tooltipAttr(activePresence)}>notes</span>` : ""}
    </div>
  </div>
  <div class="flex flex-wrap items-end justify-end gap-3">
    <a href="/receipt" class="inline-flex items-center text-[12px] font-medium text-muted-foreground transition hover:text-foreground">Receipts</a>
  </div>
</div>`;

export const buildFactoryWorkbenchShellSnapshot = (
  model: FactoryWorkbenchPageModel,
): FactoryWorkbenchShellSnapshot => {
  const routeContext: FactoryWorkbenchRouteContext = {
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    focusKind: model.focusKind,
    focusId: model.focusId,
    filter: model.filter,
  };
  const pageQuery = workbenchQuery(routeContext);
  const activeRole = engineerPrimaryRole(model.chat);
  const activePresence = engineerPresence(model.chat);
  const workbenchSummary = activePresence
    ?? activeRole
    ?? "Profile-scoped objectives, recent activity, and receipts-backed progress.";
  const workbenchSummaryPreview = truncate(workbenchSummary, 120);
  return {
    pageTitle: "Receipt Factory Workbench",
    route: routeContext,
    backgroundEventsPath: backgroundEventsPath(routeContext),
    chatEventsPath: chatEventsPath(routeContext),
    workbenchHeaderPath: workbenchHeaderPath(routeContext),
    workbenchIslandPath: workbenchIslandPath(routeContext),
    chatIslandPath: chatIslandPath(routeContext),
    workbenchHeaderHtml: renderWorkbenchHeader(model, routeContext, workbenchSummaryPreview, workbenchSummary),
    chatHeaderHtml: renderWorkbenchChatHeader(model, activeRole, activePresence),
    workbenchHtml: factoryWorkbenchWorkspaceIsland(model.workspace, routeContext),
    chatHtml: factoryWorkbenchChatIsland(model.chat, routeContext),
    composeAction: `/factory/compose${pageQuery}`,
    composerPlaceholder: workbenchComposerPlaceholderForSelection({
      objectiveId: model.objectiveId,
      selectedObjective: model.workspace.selectedObjective,
    }),
    streamingLabel: model.activeProfileLabel,
  };
};

const renderWorkbenchLoadingHeader = (routeContext: FactoryWorkbenchRouteContext): string => {
  const profileLabel = displayLabel(routeContext.profileId) || "Factory";
  const chatLabel = routeContext.chatId ? truncate(routeContext.chatId, 24) : "Pending";
  const focusLabel = routeContext.focusKind && routeContext.focusId
    ? `${displayLabel(routeContext.focusKind)} ${truncate(routeContext.focusId, 20)}`
    : undefined;
  return `<div class="flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0 flex-1">
      <div class="inline-flex items-center gap-2.5">
        <span class="inline-flex h-9 w-9 items-center justify-center border border-border bg-primary/10 text-primary">
          ${iconFactory("h-4.5 w-4.5")}
        </span>
        <div class="min-w-0">
          <div class="text-[11px] font-semibold uppercase tracking-[0.26em] text-primary">receipt</div>
          <div class="mt-1 flex flex-wrap items-center gap-2">
            <div class="text-[15px] font-semibold leading-none text-foreground">${esc(profileLabel)}</div>
            <div class="text-[12px] font-medium uppercase tracking-[0.16em] text-muted-foreground">factory</div>
          </div>
        </div>
      </div>
      <div class="mt-1 max-w-[70ch] text-[12px] leading-5 text-muted-foreground">Hydrating receipt-backed workbench projections after first paint.</div>
    </div>
    <div class="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
      <span class="inline-flex items-center gap-1">${iconWorker("h-3.5 w-3.5")} ${esc(chatLabel)}</span>
      ${routeContext.objectiveId ? `<span class="inline-flex items-center gap-1">${iconFactory("h-3.5 w-3.5")} ${esc(truncate(routeContext.objectiveId, 24))}</span>` : ""}
      ${focusLabel ? `<span class="inline-flex items-center gap-1">${iconClock("h-3.5 w-3.5")} ${esc(focusLabel)}</span>` : ""}
    </div>
  </div>`;
};

const renderWorkbenchLoadingChatHeader = (routeContext: FactoryWorkbenchRouteContext): string => `<div class="flex items-start justify-between gap-3">
  <div class="min-w-0">
    <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">conversation</div>
    <div class="mt-1 flex flex-wrap items-center gap-2">
      <div class="text-sm font-semibold text-foreground">${esc(displayLabel(routeContext.profileId) || "Factory")}</div>
      <div class="text-[11px] text-muted-foreground">Loading chat projection...</div>
    </div>
  </div>
  <div class="flex flex-wrap items-end justify-end gap-3">
    <a href="/receipt" class="inline-flex items-center text-[12px] font-medium text-muted-foreground transition hover:text-foreground">Receipts</a>
  </div>
</div>`;

const renderWorkbenchLoadingWorkspace = (): string => `<div class="factory-scrollbar flex flex-col gap-4 pr-1 lg:h-full lg:min-h-0 lg:overflow-y-auto">
  <section class="border border-border bg-card px-5 py-5">
    <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Loading</div>
    <div class="mt-2 text-base font-semibold text-foreground">Preparing workspace projections.</div>
    <div class="mt-2 max-w-[56ch] text-sm leading-6 text-muted-foreground">The shell is live. Objectives, job activity, and receipt aggregates are loading into their islands now.</div>
  </section>
  <section class="border border-border bg-card px-5 py-5 text-sm leading-6 text-muted-foreground">
    Pending statuses, objective lists, and recent activity will replace this placeholder when the snapshot arrives.
  </section>
</div>`;

const renderWorkbenchLoadingChat = (): string => `<div class="flex min-h-0 flex-col gap-4">
  <section class="border-b border-border pb-4">
    <div class="flex items-start gap-3">
      <span class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center text-primary">${iconWorker("h-4 w-4")}</span>
      <div class="min-w-0">
        <div class="text-sm font-semibold text-foreground">Factory chat</div>
        <div class="mt-2 max-w-[36ch] text-[12px] leading-5 text-muted-foreground">Waiting for the current transcript and live job state.</div>
      </div>
    </div>
  </section>
  <section class="flex min-h-[240px] items-center justify-center border border-border bg-card px-6 py-8">
    <div class="mx-auto max-w-lg text-left">
      <div class="text-base font-semibold text-foreground">Loading conversation.</div>
      <div class="mt-2 text-sm leading-6 text-muted-foreground">The composer stays available while Receipt rebuilds the chat projection.</div>
    </div>
  </section>
</div>`;

export const factoryWorkbenchScaffold = (
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const pageQuery = workbenchQuery(routeContext);
  const profileLabel = displayLabel(routeContext.profileId) || "Factory";
  const scaffoldComposerActions = renderWorkbenchComposerQuickActions({ objectiveId: routeContext.objectiveId });
  const scaffoldComposerHelper = workbenchComposerHelperText({ objectiveId: routeContext.objectiveId });
  return `<!doctype html>
<html class="dark h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Factory Workbench</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
  <script src="/assets/htmx.min.js?v=${CSS_VERSION}"></script>
  <script src="/assets/htmx-ext-sse.js?v=${CSS_VERSION}"></script>
</head>
<body data-factory-workbench data-workbench-shell-lazy="true" data-chat-id="${esc(routeContext.chatId)}" data-objective-id="${esc(routeContext.objectiveId ?? "")}" data-focus-kind="${esc(routeContext.focusKind ?? "")}" data-focus-id="${esc(routeContext.focusId ?? "")}" class="min-h-screen overflow-x-hidden font-sans antialiased lg:h-screen lg:overflow-hidden">
  <div class="factory-workbench-shell min-h-screen w-full bg-background text-foreground lg:h-screen">
    <div class="factory-workbench-grid grid min-h-screen w-full lg:h-full lg:grid-cols-[minmax(0,1fr)_420px]">
      <section class="flex min-h-0 flex-col bg-background lg:border-r lg:border-border">
        <header id="factory-workbench-header" class="shrink-0 border-b border-border bg-background px-4 py-3">
          ${renderWorkbenchLoadingHeader(routeContext)}
        </header>
        <div class="flex-1 px-4 py-4 lg:min-h-0 lg:overflow-hidden">
          <div id="factory-workbench-background-root" class="lg:h-full" data-events-path="${esc(backgroundEventsPath(routeContext))}">
            <div id="factory-workbench-panel" class="lg:h-full">
              ${renderWorkbenchLoadingWorkspace()}
            </div>
          </div>
        </div>
      </section>
      <aside class="flex flex-col bg-background lg:min-h-0">
        <div class="factory-workbench-chat-shell flex min-h-[42rem] flex-col overflow-hidden lg:h-full lg:min-h-0">
          <div id="factory-workbench-chat-header" class="shrink-0 border-b border-border bg-background px-4 py-3">
            ${renderWorkbenchLoadingChatHeader(routeContext)}
          </div>
          <div id="factory-workbench-chat-root" data-events-path="${esc(chatEventsPath(routeContext))}" class="flex flex-1 flex-col lg:min-h-0">
            <section id="factory-workbench-chat-scroll" class="factory-scrollbar flex-1 overflow-y-auto px-4 py-4 lg:min-h-0">
              <div id="factory-workbench-chat">
                ${renderWorkbenchLoadingChat()}
              </div>
              <div id="factory-chat-live" class="mt-4 space-y-3">
                ${renderFactoryStreamingShell(profileLabel, { liveMode: "js" })}
                <div id="factory-chat-optimistic" class="space-y-2" aria-live="polite"></div>
              </div>
            </section>
            <section class="shrink-0 border-t border-border bg-background px-4 py-4">
              <form id="factory-composer" action="/factory/compose${esc(pageQuery)}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
                <input id="factory-composer-current-job" type="hidden" name="currentJobId" value="" />
                <label class="sr-only" for="factory-prompt">Factory prompt</label>
                <div class="space-y-3">
                  ${scaffoldComposerActions}
                  <div class="relative">
                    <textarea id="factory-prompt" name="prompt" class="min-h-[120px] w-full resize-none border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/30" rows="3" placeholder="${esc(workbenchComposerPlaceholderForSelection({ objectiveId: routeContext.objectiveId }))}" autofocus aria-autocomplete="list" aria-expanded="false" aria-controls="factory-composer-completions" aria-haspopup="listbox"></textarea>
                    <div id="factory-composer-completions" class="hidden mt-2 max-h-56 overflow-auto rounded-md border border-border bg-background shadow-lg" role="listbox" aria-label="Slash command suggestions"></div>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-xs leading-5 text-muted-foreground">${esc(scaffoldComposerHelper)}</div>
                    <button id="factory-composer-submit" class="inline-flex items-center justify-center rounded-md border border-primary/40 bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground" type="submit">Send</button>
                  </div>
                </div>
                <div id="factory-composer-status" class="mt-3 hidden rounded-sm border border-border bg-muted px-3 py-2 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
              </form>
            </section>
          </div>
        </div>
      </aside>
    </div>
  </div>
  <script src="/assets/factory-client.js?v=${CSS_VERSION}"></script>
</body>
</html>`;
};

export const factoryWorkbenchShell = (model: FactoryWorkbenchPageModel): string => {
  const shell = buildFactoryWorkbenchShellSnapshot(model);
  const routeContext = shell.route;
  const pageQuery = workbenchQuery(routeContext);
  const islandBindings = workbenchIslandBindings(routeContext);
  const composerActions = renderWorkbenchComposerQuickActions({
    objectiveId: routeContext.objectiveId,
    selectedObjective: model.workspace.selectedObjective,
  });
  const composerHelper = workbenchComposerHelperText({
    objectiveId: routeContext.objectiveId,
    selectedObjective: model.workspace.selectedObjective,
  });
  return `<!doctype html>
<html class="dark h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(shell.pageTitle)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
  <script src="/assets/htmx.min.js?v=${CSS_VERSION}"></script>
  <script src="/assets/htmx-ext-sse.js?v=${CSS_VERSION}"></script>
</head>
<body data-factory-workbench data-chat-id="${esc(model.chatId)}" data-objective-id="${esc(model.objectiveId ?? "")}" data-focus-kind="${esc(model.focusKind ?? "")}" data-focus-id="${esc(model.focusId ?? "")}" class="min-h-screen overflow-x-hidden font-sans antialiased lg:h-screen lg:overflow-hidden">
  <div class="factory-workbench-shell min-h-screen w-full bg-background text-foreground lg:h-screen">
    <div class="factory-workbench-grid grid min-h-screen w-full lg:h-full lg:grid-cols-[minmax(0,1fr)_420px]">
      <section class="flex min-h-0 flex-col bg-background lg:border-r lg:border-border">
        <header id="factory-workbench-header" class="shrink-0 border-b border-border bg-background px-4 py-3" ${liveIslandAttrs(islandBindings.header)}>
          ${shell.workbenchHeaderHtml}
        </header>
        <div class="flex-1 px-4 py-4 lg:min-h-0 lg:overflow-hidden">
          <div id="factory-workbench-background-root" class="lg:h-full" data-events-path="${esc(backgroundEventsPath(routeContext))}">
            <div id="factory-workbench-panel" class="lg:h-full" ${liveIslandAttrs(islandBindings.background)}>
              ${shell.workbenchHtml}
            </div>
          </div>
        </div>
      </section>
      <aside class="flex flex-col bg-background lg:min-h-0">
        <div class="factory-workbench-chat-shell flex min-h-[42rem] flex-col overflow-hidden lg:h-full lg:min-h-0">
          <div id="factory-workbench-chat-header" class="shrink-0 border-b border-border bg-background px-4 py-3">
            ${shell.chatHeaderHtml}
          </div>
          <div id="factory-workbench-chat-root" data-events-path="${esc(chatEventsPath(routeContext))}" class="flex flex-1 flex-col lg:min-h-0">
            <section id="factory-workbench-chat-scroll" class="factory-scrollbar flex-1 overflow-y-auto px-4 py-4 lg:min-h-0">
              <div id="factory-workbench-chat" ${liveIslandAttrs(islandBindings.chat)}>
                ${shell.chatHtml}
              </div>
              <div id="factory-chat-live" class="mt-4 space-y-3">
                ${renderFactoryStreamingShell(model.activeProfileLabel, { liveMode: "js" })}
                <div id="factory-chat-optimistic" class="space-y-2" aria-live="polite"></div>
              </div>
            </section>
            <section class="shrink-0 border-t border-border bg-background px-4 py-4">
              <form id="factory-composer" action="${esc(shell.composeAction)}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
                <input id="factory-composer-current-job" type="hidden" name="currentJobId" value="" />
                <label class="sr-only" for="factory-prompt">Factory prompt</label>
                <div class="space-y-3">
                  ${composerActions}
                  <div class="relative">
                    <textarea id="factory-prompt" name="prompt" class="min-h-[120px] w-full resize-none border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/30" rows="3" placeholder="${esc(shell.composerPlaceholder)}" autofocus aria-autocomplete="list" aria-expanded="false" aria-controls="factory-composer-completions" aria-haspopup="listbox"></textarea>
                    <div id="factory-composer-completions" class="hidden mt-2 max-h-56 overflow-auto rounded-md border border-border bg-background shadow-lg" role="listbox" aria-label="Slash command suggestions"></div>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-xs leading-5 text-muted-foreground">${esc(composerHelper)}</div>
                    <button id="factory-composer-submit" class="inline-flex items-center justify-center rounded-md border border-primary/40 bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground" type="submit">Send</button>
                  </div>
                </div>
                <div id="factory-composer-status" class="mt-3 hidden rounded-sm border border-border bg-muted px-3 py-2 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
              </form>
            </section>
          </div>
        </div>
      </aside>
    </div>
  </div>
  <script src="/assets/factory-client.js?v=${CSS_VERSION}"></script>
</body>
</html>`;
};
