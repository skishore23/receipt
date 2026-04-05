import {
  badge,
  CSS_VERSION,
  dangerButtonClass,
  displayLabel,
  esc,
  formatTs,
  ghostButtonClass,
  iconCheckCircle,
  iconClock,
  iconFactory,
  iconSpark,
  iconTokens,
  iconWorker,
  liveIslandAttrs,
  statPill,
  statusDot,
  toneForValue,
  truncate,
} from "../../ui";
import {
  renderFactoryStreamingShell,
  renderFactoryTranscriptSection,
} from "../transcript";
import { renderFactoryRunSteps } from "../../factory-live-steps";
import {
  displayStateTone,
} from "../supervision";
import { COMPOSER_COMMANDS } from "../../../factory-cli/composer";
import { DEFAULT_FACTORY_WORKBENCH_FILTER } from "../../factory-models";
import type {
  FactoryChatIslandModel,
  FactoryChatProfileNav,
  FactoryChatObjectiveNav,
  FactoryInspectorTab,
  FactoryLifecycleStepModel,
  FactorySelectedObjectiveCard,
  FactoryWorkbenchActivitySectionModel,
  FactoryWorkbenchBlockModel,
  FactoryWorkbenchDetailTab,
  FactoryWorkbenchFilterKey,
  FactoryWorkbenchObjectiveListSectionModel,
  FactoryWorkbenchPageModel,
  FactoryWorkbenchSectionModel,
  FactoryWorkbenchSummarySectionModel,
  FactoryWorkbenchWorkspaceModel,
} from "../../factory-models";

export type FactoryWorkbenchRouteContext = {
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly inspectorTab?: FactoryInspectorTab;
  readonly detailTab?: FactoryWorkbenchDetailTab;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly filter: FactoryWorkbenchFilterKey;
};

export type FactoryWorkbenchShellSnapshot = {
  readonly pageTitle: string;
  readonly routeKey: string;
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
] as const;
const workbenchBackgroundRefreshOn = [] as const;
const workbenchHeaderRefreshOn = [
  { event: "profile-board-refresh", throttleMs: 300 },
  { event: "objective-runtime-refresh", throttleMs: 300 },
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
  if (input.inspectorTab && input.inspectorTab !== "overview") params.set("inspectorTab", input.inspectorTab);
  if (input.detailTab) params.set("detailTab", input.detailTab);
  if (input.filter !== DEFAULT_FACTORY_WORKBENCH_FILTER) params.set("filter", input.filter);
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
    filter: DEFAULT_FACTORY_WORKBENCH_FILTER,
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
    case "selected-overflow":
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
] as const;

const workbenchComposerPlaceholder = (objectiveId?: string): string => objectiveId
  ? "Chat with Factory, use /obj to create a new objective, or use /react to update the selected objective."
  : "Ask a new question, or use /obj to create an objective directly.";

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
  if (!input.objectiveId && !selected) return "Ask a new question or use /obj to create directly.";
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
): string => `<button type="button" data-factory-command="${esc(command)}" class="${className} !py-1.5 !px-3 !text-[11px]">${esc(label)}</button>`;

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
  inspectorTab: objectiveId ? "chat" : input.inspectorTab,
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

const routeHref = (
  input: FactoryWorkbenchRouteContext,
  overrides: Partial<FactoryWorkbenchRouteContext>,
): string => `/factory${workbenchQuery({
  ...input,
  ...overrides,
})}`;

const commandHref = (
  location: string,
  command: string,
): string => {
  const url = new URL(location, "http://receipt.local");
  url.searchParams.set("compose", command);
  url.hash = "factory-workbench-composer-shell";
  return `${url.pathname}${url.search}${url.hash}`;
};

const profileSelectClass = "min-h-[2.5rem] min-w-[12rem]  border border-border bg-background px-3 py-2 text-sm font-medium text-foreground outline-none transition focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/30";

const tooltipAttr = (value?: string): string => {
  const trimmed = value?.trim();
  return trimmed ? ` title="${esc(trimmed)}"` : "";
};

const formatElapsedMinutes = (minutes: number): string => {
  const wholeMinutes = Math.max(0, Math.floor(minutes));
  if (wholeMinutes < 60) return `${wholeMinutes}m`;
  const hours = Math.floor(wholeMinutes / 60);
  const remainderMinutes = wholeMinutes % 60;
  return remainderMinutes > 0
    ? `${hours}h ${remainderMinutes}m`
    : `${hours}h`;
};

const titleCaseLabel = (value?: string): string => {
  const label = displayLabel(value);
  if (!label) return "";
  return label
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

const renderWorkbenchHeaderMetric = (input: {
  readonly icon: string;
  readonly label: string;
  readonly value: string;
  readonly tooltip?: string;
  readonly iconClass?: string;
  readonly testId?: string;
}): string => `<div${input.testId ? ` data-factory-workbench-header-metric="${esc(input.testId)}"` : ""} class="inline-flex items-center gap-1.5 border border-white/8 bg-black/35 px-2 py-1 text-[11px] text-muted-foreground"${tooltipAttr(input.tooltip)}>
  <span class="${esc(input.iconClass ?? "text-muted-foreground")}">${input.icon}</span>
  <span class="font-medium uppercase tracking-[0.12em]">${esc(input.label)}</span>
  <span class="font-semibold text-foreground">${esc(input.value)}</span>
</div>`;

const resolveWorkbenchElapsedMinutes = (
  model: FactoryWorkbenchPageModel,
): number | undefined => model.workspace.workbench?.summary.elapsedMinutes;

const renderWorkbenchHeaderContext = (
  model: FactoryWorkbenchPageModel,
): string => {
  const objective = model.workspace.selectedObjective;
  if (objective) {
    const status = objective.displayState ?? titleCaseLabel(objective.phase || objective.status);
    const taskSummary = typeof objective.taskCount === "number"
      ? `${objective.activeTaskCount ?? 0}/${objective.taskCount} tasks`
      : undefined;
    return `<div class="hidden min-w-0 flex-1 items-center gap-3 lg:flex">
      <div class="h-6 w-px shrink-0 bg-white/10"></div>
      <div class="min-w-0">
        <div class="text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">Selected objective</div>
        <div class="mt-1 flex min-w-0 items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground"${tooltipAttr(objective.title)}>${esc(objective.title)}</span>
          ${status ? badge(status, displayStateTone(status)) : ""}
          ${taskSummary ? `<span class="inline-flex shrink-0 items-center border border-white/8 bg-black/25 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">${esc(taskSummary)}</span>` : ""}
        </div>
      </div>
    </div>`;
  }
  const role = engineerPrimaryRole(model.chat)?.trim();
  const presence = engineerPresence(model.chat);
  const summary = role ?? presence;
  if (!summary) return "";
  return `<div class="hidden min-w-0 flex-1 items-center gap-3 lg:flex">
    <div class="h-6 w-px shrink-0 bg-white/10"></div>
    <div class="min-w-0">
      <div class="text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">Current role</div>
      <div class="mt-1 truncate text-[12px] text-muted-foreground"${tooltipAttr(summary)}>${esc(summary)}</div>
    </div>
  </div>`;
};

const renderTooltipChip = (label: string, detail?: string): string => {
  const trimmed = detail?.trim();
  if (!trimmed) return "";
  return `<span class="inline-flex items-center  border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground"${tooltipAttr(trimmed)}>${esc(label)}</span>`;
};

const renderProfileSelect = (input: {
  readonly id: string;
  readonly label: string;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
  readonly compact?: boolean;
  readonly hideLabel?: boolean;
  readonly wrapperClass?: string;
  readonly minWidthClass?: string;
  readonly selectClass?: string;
}): string => {
  if (input.profiles.length === 0) return "";
  const wrapperClass = input.wrapperClass ?? "flex min-w-[14rem] flex-col gap-1.5";
  const minWidthClass = input.minWidthClass ?? "min-w-[12rem]";
  const selectClass = input.selectClass ?? `${profileSelectClass} ${input.compact ? "min-h-[2.5rem]" : ""}`;
  return `<label data-factory-workbench-header-trigger="engineer" class="${esc(wrapperClass)}">
    <span class="${input.hideLabel ? "sr-only" : "text-[12px] font-medium text-muted-foreground"}">${esc(input.label)}</span>
    <select id="${esc(input.id)}" data-factory-profile-select="true" class="${esc(`${selectClass} ${minWidthClass}`.trim())}">
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

const renderFilterPill = (
  routeContext: FactoryWorkbenchRouteContext,
  filter: FactoryWorkbenchWorkspaceModel["filters"][number],
): string => {
  const href = filterHref(routeContext, filter.key);
  return `<a href="${esc(href)}" data-factory-href="${esc(href)}" ${filter.selected ? 'aria-current="page"' : ""} class="inline-flex items-center border-b-2 px-0 py-1.5 text-sm font-medium transition ${filter.selected
  ? "border-primary text-foreground"
  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"}">${esc(filter.label)}</a>`;
};

const objectiveCardStateLabel = (
  objective: FactoryChatObjectiveNav,
): string => objective.displayState ?? (titleCaseLabel(objective.phase || objective.status) || "Idle");

const shouldSuppressObjectiveStateBadge = (
  section: FactoryWorkbenchObjectiveListSectionModel,
  objective: FactoryChatObjectiveNav,
): boolean => {
  const normalizedState = objectiveCardStateLabel(objective).trim().toLowerCase();
  return (
    (section.key === "completed" && normalizedState === "completed")
    || (section.key === "blocked" && normalizedState === "blocked")
  );
};

const objectiveCardSelectionBadge = (selected: boolean): string => selected
  ? `<span class="inline-flex items-center gap-1.5 border border-primary/20 bg-primary/12 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
      ${iconCheckCircle("h-3.5 w-3.5")}
      <span>Selected</span>
    </span>`
  : "";

const renderObjectiveCard = (
  routeContext: FactoryWorkbenchRouteContext,
  objective: FactoryChatObjectiveNav,
  section?: FactoryWorkbenchObjectiveListSectionModel,
): string => {
  const href = objectiveHref(routeContext, objective.objectiveId, undefined, objective.profileId);
  const summary = truncate(
    objective.summary ?? objective.blockedReason ?? "Objective activity will appear here.",
    objective.selected ? 180 : 120,
  );
  const stateLabel = objectiveCardStateLabel(objective);
  const stateValue = objective.blockedReason ? "blocked" : (objective.displayState ?? objective.phase ?? objective.status);
  const stateTone = toneForValue(stateValue);
  const stateBadge = !section || !shouldSuppressObjectiveStateBadge(section, objective)
    ? badge(stateLabel, stateTone)
    : "";
  const selectedBadge = objectiveCardSelectionBadge(objective.selected);
  const cardClass = objective.selected
    ? "border border-primary/30 bg-primary/8 ring-1 ring-primary/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    : "border border-transparent bg-transparent hover:border-border/70 hover:bg-accent/35";
  const statusTileClass = objective.selected
    ? "border-primary/20 bg-primary/10"
    : "border-border/80 bg-background/80";
  return `<a href="${esc(href)}" data-factory-href="${esc(href)}" data-objective-id="${esc(objective.objectiveId)}" data-selected="${objective.selected ? "true" : "false"}" ${objective.selected ? 'aria-current="page"' : ""} class="block px-2 py-2 transition">
    <div class="${cardClass} px-4 py-4 transition-colors">
    <div class="flex items-start gap-3">
      <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border ${statusTileClass}">${statusDot(stateTone)}</div>
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"${tooltipAttr(objective.title)}>${esc(truncate(objective.title, 72))}</div>
          ${(selectedBadge || stateBadge) ? `<div class="flex shrink-0 flex-wrap items-center justify-end gap-2">${selectedBadge}${stateBadge}</div>` : ""}
        </div>
        <div class="mt-1 text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">${esc(summary)}</div>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span class="inline-flex items-center border border-border bg-muted/25 px-2 py-1"${tooltipAttr(objective.objectiveId)}>${esc(truncate(objective.objectiveId, 26))}</span>
          <span class="inline-flex items-center border border-border bg-muted/25 px-2 py-1">${esc(`${objective.activeTaskCount ?? 0}/${objective.taskCount ?? 0} tasks`)}</span>
          ${objective.updatedAt ? `<span class="inline-flex items-center gap-1 border border-border bg-muted/25 px-2 py-1">${iconClock("h-3 w-3")} ${esc(formatTs(objective.updatedAt))}</span>` : ""}
        </div>
      </div>
    </div>
    </div>
  </a>`;
};

const workbenchPrimaryActionClass = "inline-flex items-center justify-center border border-primary/40 bg-primary px-2.5 py-1.5 text-[12px] font-semibold text-primary-foreground transition hover:bg-primary/90";
const workbenchSecondaryActionClass = `${ghostButtonClass} !px-2.5 !py-1.5 !text-[12px]`;

const renderWorkbenchActionButton = (
  routeContext: FactoryWorkbenchRouteContext,
  action: NonNullable<FactorySelectedObjectiveCard["primaryAction"]>,
): string => {
  const focusHref = routeHref(routeContext, {
    inspectorTab: "chat",
    objectiveId: routeContext.objectiveId,
  });
  const className = action.tone === "danger"
    ? `${dangerButtonClass} !px-3 !py-1.5 !text-[13px]`
    : action.tone === "primary"
      ? workbenchPrimaryActionClass
      : workbenchSecondaryActionClass;
  if (action.focusOnly) {
    return `<a href="${esc(focusHref)}" data-factory-href="${esc(focusHref)}" class="${className}">${esc(action.label)}</a>`;
  }
  const command = action.command ?? "";
  const href = commandHref(focusHref, command);
  return `<a href="${esc(href)}" data-factory-command="${esc(command)}" data-factory-focus-href="${esc(focusHref)}" class="${className}">${esc(action.label)}</a>`;
};

const renderWorkbenchCommandButton = (
  label: string,
  command: string,
  focusHref?: string,
  className = workbenchSecondaryActionClass,
): string => focusHref
  ? `<a href="${esc(commandHref(focusHref, command))}" data-factory-command="${esc(command)}" data-factory-focus-href="${esc(focusHref)}" class="${className}">${esc(label)}</a>`
  : `<button type="button" data-factory-command="${esc(command)}" class="${className}">${esc(label)}</button>`;

const renderLiveFocusControls = (
  routeContext: FactoryWorkbenchRouteContext,
  focus: NonNullable<FactoryWorkbenchSummarySectionModel["focus"] | FactoryWorkbenchActivitySectionModel["focus"]>,
): string => {
  const normalizedStatus = focus.status.trim().toLowerCase();
  if (normalizedStatus !== "running" && normalizedStatus !== "stalled") return "";
  const chatHref = routeContext.objectiveId
    ? routeHref(routeContext, {
      objectiveId: routeContext.objectiveId,
      inspectorTab: "chat",
    })
    : undefined;
  const buttons = [
    renderWorkbenchCommandButton("Continue", "/react ", chatHref),
    renderWorkbenchCommandButton("Abort Job", "/abort-job ", chatHref, `${dangerButtonClass} !px-3 !py-1.5 !text-[13px]`),
  ];
  if (chatHref) {
    buttons.push(`<a href="${esc(chatHref)}" data-factory-href="${esc(chatHref)}" class="${workbenchSecondaryActionClass}">Open Chat</a>`);
  }
  return `<div class="mt-3 flex flex-wrap gap-2">${buttons.join("")}</div>`;
};

const renderLifecycleStrip = (
  objective?: FactoryWorkbenchSummarySectionModel["objective"],
): string => {
  if (!objective?.lifecycleSteps?.length) return "";
  const stepTone = (state: FactoryLifecycleStepModel["state"]): string =>
    state === "done"
      ? "border-success/20 bg-success/10 text-success"
      : state === "current"
        ? "border-info/20 bg-info/10 text-info"
        : state === "paused"
          ? "border-warning/20 bg-warning/10 text-warning"
          : "border-border bg-background text-muted-foreground";
  const stepPrefix = (state: FactoryLifecycleStepModel["state"]): string =>
    state === "done" ? "✓"
      : state === "paused" ? "⏸"
      : state === "current" ? "●"
      : "○";
  return `<section class="border border-border bg-muted/25 px-4 py-3">
    <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Lifecycle Strip</div>
    <div class="mt-3 flex flex-wrap gap-2">
      ${objective.lifecycleSteps.map((step) => `<div class="inline-flex items-center gap-2 border px-2.5 py-1.5 text-[11px] font-medium ${stepTone(step.state)}">
        <span>${stepPrefix(step.state)}</span>
        <span>${esc(step.label)}</span>
      </div>`).join("")}
    </div>
  </section>`;
};

const renderObjectiveEvidenceSnapshot = (
  objective?: FactoryWorkbenchSummarySectionModel["objective"],
): string => {
  if (!objective?.evidenceStats?.length) return "";
  return `<section class="border border-border bg-muted/25 px-4 py-3">
    <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Objective Snapshot</div>
    <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      ${objective.evidenceStats.map((stat) => `<div class="border border-border bg-background px-3 py-2">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">${esc(stat.label)}</div>
        <div class="mt-1 text-sm font-semibold text-foreground">${esc(stat.value)}</div>
      </div>`).join("")}
    </div>
  </section>`;
};

const renderObjectiveContractSnapshot = (
  objective?: FactoryWorkbenchSummarySectionModel["objective"],
): string => {
  if (!objective?.contract && !objective?.alignment) return "";
  const contract = objective.contract;
  const alignment = objective.alignment;
  const alignmentTone = alignment
    ? alignment.gateStatus === "blocked"
      ? "danger"
      : alignment.gateStatus === "correction_requested" || alignment.gateStatus === "not_reported"
        ? "warning"
        : alignment.correctedAfterReview
          ? "info"
          : "success"
    : "neutral";
  return `<section class="border border-border bg-muted/25 px-4 py-3">
    <div class="flex flex-wrap items-center gap-2">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Objective Contract</div>
      ${alignment ? badge(
        alignment.correctedAfterReview
          ? "Aligned After Correction"
          : alignment.gateStatus === "blocked"
            ? "Blocked"
            : alignment.gateStatus === "correction_requested"
              ? "Correction Requested"
              : alignment.gateStatus === "not_reported"
                ? "Alignment Not Reported"
                : "Aligned",
        alignmentTone,
      ) : ""}
    </div>
    ${contract ? `<div class="mt-3 space-y-3">
      <div>
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Acceptance Criteria</div>
        <div class="mt-2 space-y-2">
          ${contract.acceptanceCriteria.map((item) => `<div class="border border-border bg-background px-3 py-2 text-sm leading-6 text-foreground">${esc(item)}</div>`).join("")}
        </div>
      </div>
      ${contract.requiredChecks.length > 0 ? `<div>
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Required Checks</div>
        <div class="mt-2 flex flex-wrap gap-2">
          ${contract.requiredChecks.map((item) => `<span class="inline-flex items-center border border-border bg-background px-2 py-1 text-[11px] text-foreground">${esc(item)}</span>`).join("")}
        </div>
      </div>` : ""}
      <div class="text-sm leading-6 text-muted-foreground">${esc(contract.proofExpectation)}</div>
    </div>` : ""}
    ${alignment ? `<div class="mt-4 grid gap-3 xl:grid-cols-2">
      <div class="space-y-3">
        <div class="border border-border bg-background px-3 py-3">
          <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Satisfied</div>
          <div class="mt-2 space-y-2">
            ${(alignment.satisfied.length > 0
              ? alignment.satisfied
              : ["No explicit satisfied criteria recorded yet."])
              .map((item) => `<div class="text-sm leading-6 text-foreground">${esc(item)}</div>`).join("")}
          </div>
        </div>
        <div class="border border-border bg-background px-3 py-3">
          <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Controller View</div>
          <div class="mt-2 text-sm leading-6 text-foreground">${esc(alignment.rationale)}</div>
          ${alignment.correctiveAction ? `<div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(alignment.correctiveAction)}</div>` : ""}
        </div>
      </div>
      <div class="space-y-3">
        <div class="border border-border bg-background px-3 py-3">
          <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Still Missing</div>
          <div class="mt-2 space-y-2">
            ${(alignment.missing.length > 0
              ? alignment.missing
              : ["Nothing missing in the latest alignment report."])
              .map((item) => `<div class="text-sm leading-6 text-foreground">${esc(item)}</div>`).join("")}
          </div>
        </div>
        ${alignment.outOfScope.length > 0 ? `<div class="border border-warning/25 bg-warning/10 px-3 py-3">
          <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Out Of Scope</div>
          <div class="mt-2 space-y-2">
            ${alignment.outOfScope.map((item) => `<div class="text-sm leading-6 text-foreground">${esc(item)}</div>`).join("")}
          </div>
        </div>` : ""}
      </div>
    </div>` : ""}
  </section>`;
};

const renderSummarySection = (
  section: FactoryWorkbenchSummarySectionModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const objective = section.objective;
  const currentRunStatus = section.focus?.status ?? section.currentRun?.status ?? objective?.status ?? "idle";
  const currentRunLabel = titleCaseLabel(currentRunStatus) || "Idle";
  const currentRunTitle = section.focus?.title
    ?? objective?.title
    ?? section.currentRun?.lastToolName
    ?? section.currentRun?.summary
    ?? (section.currentRun ? `Run ${section.currentRun.runId}` : "No background run in flight");
  const currentRunSummary = truncate(
    section.focus?.summary
      ?? section.focus?.lastMessage
      ?? section.currentRun?.lastToolSummary
      ?? section.currentRun?.summary
      ?? objective?.blockedReason
      ?? objective?.summary
      ?? "Send a message from New Chat and the current run will stay pinned here.",
    180,
  );
  const currentRunMeta = [
    section.currentRun?.runId ? `Run ${section.currentRun.runId}` : undefined,
    section.currentRun?.updatedAt ? `Updated ${formatTs(section.currentRun.updatedAt)}` : undefined,
    section.currentRun?.steps?.length
      ? `${section.currentRun.steps.length} step${section.currentRun.steps.length === 1 ? "" : "s"}`
      : undefined,
    objective?.objectiveId ? `Objective ${objective.objectiveId}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const currentRunGuidance = section.currentRun
    ? objective
      ? "Chat handed this work to the background. Use New Chat for the next question, or reopen the objective chat from the queue."
      : "This run is now in the background. You can ask the next question while progress keeps updating here."
    : objective
      ? "No task is running right now. Reopen the objective chat from the queue when you want to continue it."
      : "Start in New Chat to hand work off, or pick an objective from the queue to reopen its chat.";
  const currentRunCard = `<section class="border border-border bg-muted/25 px-4 py-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Current Run</div>
        <div class="mt-2 text-sm font-semibold leading-6 text-foreground">${esc(currentRunTitle)}</div>
      </div>
      ${badge(currentRunLabel, toneForValue(currentRunStatus))}
    </div>
    <div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(currentRunSummary)}</div>
    <div class="mt-2 text-xs leading-5 text-muted-foreground">${esc(currentRunGuidance)}</div>
    ${currentRunMeta.length > 0 ? `<div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      ${currentRunMeta.map((value) => `<span class="border border-border bg-background px-2 py-1">${esc(value)}</span>`).join("")}
    </div>` : ""}
    ${section.focus ? renderLiveFocusControls(routeContext, section.focus) : ""}
  </section>`;
  if (section.empty || !objective) {
    return `<section class="space-y-4 border border-border bg-card px-5 py-5">
      ${currentRunCard}
      <section class="border border-border bg-background px-4 py-4">
        <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Selected Objective</div>
        <div class="mt-2 text-lg font-semibold text-foreground">No objective selected.</div>
        <div class="mt-2 max-w-[68ch] text-sm leading-6 text-muted-foreground">${esc(section.message)}</div>
      </section>
    </section>`;
  }
  const displayState = objective.displayState ?? titleCaseLabel(objective.status) ?? "Running";
  const metrics = [
    objective.profileLabel ? `Assignee: ${objective.profileLabel}` : undefined,
    typeof objective.updatedAt === "number" ? `Updated ${formatTs(objective.updatedAt)}` : undefined,
    section.tokenCount ? `${section.tokenCount} tokens` : undefined,
  ].filter(Boolean).join(" · ");
  const latestOutcome = objective.bottomLine
    ?? objective.summary
    ?? objective.latestDecisionSummary
    ?? "No bottom line captured yet.";
  const nextOperatorAction = objective.nextAction
    ?? objective.primaryAction?.label
    ?? "Ask engineer";
  const actions = [
    objective.primaryAction ? renderWorkbenchActionButton(routeContext, objective.primaryAction) : "",
    ...(objective.secondaryActions ?? []).map((action) => renderWorkbenchActionButton(routeContext, action)),
  ].filter(Boolean).join("");
  const compactStats = section.stats.slice(0, 4);
  return `<section class="space-y-4 border border-border bg-card px-5 py-5">
    ${currentRunCard}
    <div class="space-y-4">
      <div class="min-w-0">
        <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Selected Objective</div>
        <div class="mt-3 text-[1.05rem] font-semibold leading-[1.55] text-foreground">${esc(objective.title)}</div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          ${badge(displayState, displayStateTone(displayState))}
          ${typeof objective.severity === "number" ? `<span class="border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">P${esc(String(objective.severity))}</span>` : ""}
        </div>
        <div class="mt-3 text-sm leading-7 text-muted-foreground">${esc(metrics || "Waiting for more objective telemetry.")}</div>
      </div>
      ${actions ? `<div class="flex flex-wrap items-center gap-2">${actions}</div>` : ""}
    </div>
    <div class="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
      <section class="space-y-3">
        <section class="border border-border bg-muted/25 px-4 py-3">
          <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Latest Outcome</div>
          <div class="mt-2 text-sm leading-6 text-foreground">${esc(latestOutcome)}</div>
        </section>
        <section class="border border-border bg-muted/25 px-4 py-3">
          <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Next Operator Action</div>
          <div class="mt-2 text-sm leading-6 text-foreground">${esc(nextOperatorAction)}</div>
        </section>
        ${section.latestDecisionSummary ? `<section class="border border-border bg-muted/25 px-4 py-3">
          <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Latest Decision</div>
          <div class="mt-2 text-sm leading-6 text-foreground">${esc(section.latestDecisionSummary)}</div>
        </section>` : ""}
      </section>
      <aside class="border border-border bg-muted/25 px-4 py-3">
        <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Objective Snapshot</div>
        <div class="mt-3 grid gap-2">
          ${compactStats.map((stat) => `<div class="border border-border bg-background px-3 py-2">
            <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">${esc(stat.label)}</div>
            <div class="mt-1 text-sm font-semibold text-foreground">${esc(stat.value)}</div>
          </div>`).join("")}
        </div>
      </aside>
    </div>
  </section>`;
};

const renderObjectiveListSection = (
  section: FactoryWorkbenchObjectiveListSectionModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const pinned = section.key === "selected";
  return `<section class="border border-border bg-card/70">
  <div class="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
    ${pinned ? `<div class="flex min-w-0 flex-1 items-start gap-3">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center bg-primary/12 text-primary ring-1 ring-primary/20">
        ${iconSpark("h-4 w-4")}
      </span>
      <div class="min-w-0 flex-1 pt-0.5">
        <div class="text-sm font-semibold text-foreground">${esc(section.title)}</div>
        <div class="mt-1 text-[11px] leading-4 text-muted-foreground">Pinned while the queue filter hides this objective.</div>
      </div>
    </div>` : `<div class="min-w-0 flex-1">
      <div class="text-sm font-semibold text-foreground">${esc(section.title)}</div>
    </div>`}
    <div class="shrink-0 text-[12px] text-muted-foreground">${esc(String(section.count))}</div>
  </div>
  ${section.items.length > 0
    ? `<div class="divide-y divide-border">
      ${section.items.map((objective) => renderObjectiveCard(routeContext, objective, section)).join("")}
    </div>`
    : `<div class="px-4 py-4 text-sm leading-6 text-muted-foreground">${esc(section.emptyMessage)}</div>`}
</section>`;
};

const timelineItemBorderClass = (
  emphasis?: "accent" | "warning" | "danger" | "success" | "muted",
): string => {
  switch (emphasis) {
    case "success":
      return "border-success/30";
    case "warning":
      return "border-warning/30";
    case "danger":
      return "border-destructive/30";
    case "accent":
      return "border-primary/30";
    default:
      return "border-border";
  }
};

const renderTimelineGroups = (
  section: FactoryWorkbenchActivitySectionModel,
): string => {
  if (!section.timelineGroups?.length) {
    return section.items.length > 0
      ? `<div class="space-y-2">
        ${section.items.map((entry) => `<div class="border border-border bg-background px-4 py-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-semibold text-foreground">${esc(entry.title)}</div>
              <div class="mt-1 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">${esc(entry.summary)}</div>
            </div>
            <div class="shrink-0 text-[11px] font-medium text-muted-foreground">${esc(entry.kind)}</div>
          </div>
          <div class="mt-2 flex items-start justify-between gap-2 text-[12px] text-muted-foreground">
            <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">${esc(entry.meta ?? "")}</span>
            ${entry.at ? `<span class="inline-flex items-center gap-1">${iconClock("h-3 w-3")} ${esc(formatTs(entry.at))}</span>` : ""}
          </div>
        </div>`).join("")}
      </div>`
      : `<div class="text-sm leading-6 text-muted-foreground">${esc(section.emptyMessage)}</div>`;
  }
  return section.timelineGroups.map((group) => {
    const content = `<div class="space-y-2">
      ${group.items.map((item) => `<div class="border-l-2 ${timelineItemBorderClass(item.emphasis)} bg-background px-4 py-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold text-foreground">${esc(item.title)}</div>
            <div class="mt-1 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">${esc(item.summary)}</div>
          </div>
          ${item.at ? `<div class="shrink-0 text-[11px] text-muted-foreground">${esc(formatTs(item.at))}</div>` : ""}
        </div>
        ${item.meta ? `<div class="mt-2 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">${esc(item.meta)}</div>` : ""}
      </div>`).join("")}
    </div>`;
    if (group.collapsedByDefault) {
      return `<details class="border border-border bg-muted/25 px-4 py-3">
        <summary class="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(group.title)}</summary>
        <div class="mt-3">${content}</div>
      </details>`;
    }
    return `<section class="border border-border bg-muted/25 px-4 py-3">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(group.title)}</div>
      <div class="mt-3">${content}</div>
    </section>`;
  }).join("");
};

const renderActivitySection = (
  section: FactoryWorkbenchActivitySectionModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const focusCard = section.focus
    ? `${(section.focus.stdoutTail || section.focus.stderrTail) ? `<div class="grid gap-3 ${section.focus.stdoutTail && section.focus.stderrTail ? "xl:grid-cols-2" : ""}">
        ${section.focus.stdoutTail ? `<section class="border border-border bg-background">
          <div class="flex items-center justify-between border-b border-border px-4 py-2">
            <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Codex Log</span>
            ${badge(titleCaseLabel(section.focus.status), toneForValue(section.focus.status))}
          </div>
          <pre class="factory-scrollbar min-w-0 max-h-80 overflow-x-hidden overflow-y-auto whitespace-pre-wrap px-4 py-4 text-[12px] leading-6 text-foreground [overflow-wrap:anywhere]">${esc(section.focus.stdoutTail)}</pre>
          <div class="border-t border-border px-4 py-3">
            ${renderLiveFocusControls(routeContext, section.focus)}
          </div>
        </section>` : ""}
        ${section.focus.stderrTail ? `<section class="border border-destructive/30 bg-destructive/5">
          <div class="border-b border-destructive/20 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-destructive">Error Output</div>
          <pre class="factory-scrollbar min-w-0 max-h-80 overflow-x-hidden overflow-y-auto whitespace-pre-wrap px-4 py-4 text-[12px] leading-6 text-foreground [overflow-wrap:anywhere]">${esc(section.focus.stderrTail)}</pre>
        </section>` : ""}
      </div>` : `<div class="border border-border bg-muted/25 px-4 py-3">
        <div class="flex items-center justify-between gap-3">
          <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Current Execution</span>
          ${badge(titleCaseLabel(section.focus.status), toneForValue(section.focus.status))}
        </div>
        <div class="mt-1 text-sm leading-6 text-muted-foreground">${esc(truncate(section.focus.summary, 120))}</div>
        ${renderLiveFocusControls(routeContext, section.focus)}
      </div>`}`
    : "";
  const escalationCallout = section.callout
    ? `<div class="border border-warning/25 bg-warning/10 px-3 py-2 text-xs leading-5 text-foreground">
      ${esc(section.callout)}
    </div>`
    : "";
  const stepsSection = section.run
    ? renderFactoryRunSteps(section.run, {
        title: "Supervisor Steps",
        subtitle: "Recent orchestration and worker progress.",
      })
    : "";
  return `<section class="border border-border bg-card px-5 py-5">
    <div class="flex items-center justify-between gap-3">
      <div class="text-sm font-semibold text-foreground">${esc(section.title)}</div>
      <div class="text-[12px] text-muted-foreground">${esc(String(section.count))}</div>
    </div>
    <div class="mt-4 space-y-4">
      ${focusCard}
      ${escalationCallout}
      ${stepsSection}
      ${renderTimelineGroups(section)}
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
        return renderSummarySection(section, routeContext);
      case "activity-list":
        return renderActivitySection(section, routeContext);
      case "objective-list":
      default:
        return renderObjectiveListSection(section, routeContext);
    }
  }).join("");
  if (block.layout === "split") {
    return `<div class="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.02fr)_minmax(300px,0.98fr)]">${rendered}</div>`;
  }
  return rendered;
};

const renderWorkbenchBlockIsland = (
  block: FactoryWorkbenchWorkspaceModel["blocks"][number],
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const projections = workbenchBlockProjections(block);
  const refreshOn = block.key === "summary"
    ? [
        ...workbenchBlockRefreshOn(projections),
        { event: "agent-refresh", throttleMs: 180 },
        { event: "job-refresh", throttleMs: 180 },
      ]
    : workbenchBlockRefreshOn(projections);
  return `<div id="factory-workbench-block-${esc(block.key)}" class="min-w-0" data-workbench-projections="${esc(projections.join(" "))}" ${liveIslandAttrs({
    path: workbenchBlockPath(routeContext, block.key),
    refreshOn,
  })}>
    ${renderBlock(block, routeContext)}
  </div>`;
};

const renderWorkbenchFeedHeader = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `<div class="shrink-0 border-b border-border bg-background/95 px-4 py-2.5 lg:sticky lg:top-0 lg:z-10">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Queue Monitor</span>
      <span class="text-[11px] text-muted-foreground">Live profile-board feed</span>
    </div>
    <div class="mt-2 flex flex-wrap items-center gap-3">
      ${workspace.filters.map((filter) => renderFilterPill(routeContext, filter)).join("")}
    </div>
  </div>`;

const renderWorkbenchPrimaryTabLink = (
  routeContext: FactoryWorkbenchRouteContext,
  tab: FactoryWorkbenchDetailTab,
  label: string,
  active: boolean,
): string => {
  const href = routeHref(routeContext, { detailTab: tab });
  return `<a href="${esc(href)}" data-factory-href="${esc(href)}" ${active ? 'aria-current="page"' : ""} class="inline-flex items-center border-b-2 px-0 py-1.5 text-sm font-medium transition ${active
    ? "border-primary text-foreground"
    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"}">${esc(label)}</a>`;
};

const renderWorkbenchPrimaryHeader = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const activeTab = workspace.detailTab === "review" ? "review" : "action";
  return `<div class="shrink-0 border-b border-border bg-background/95 px-4 py-2.5 lg:sticky lg:top-0 lg:z-10">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Primary Focus</span>
      <div class="flex flex-wrap items-center gap-3">
        ${renderWorkbenchPrimaryTabLink(routeContext, "action", "Objective", activeTab === "action")}
        ${renderWorkbenchPrimaryTabLink(routeContext, "review", "Execution", activeTab === "review")}
      </div>
    </div>
  </div>`;
};

export const factoryWorkbenchWorkspaceIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const showSummary = isSummaryVisible(workspace);
  const leftDetailTab = workspace.detailTab === "review" ? "review" : "action";
  const activityBlock = workspace.blocks.find((block) => block.key === "activity");
  const summaryBlock = showSummary ? workspace.blocks.find((block) => block.key === "summary") : undefined;
  const liveBlocks = [
    ...(summaryBlock ? [summaryBlock] : []),
    ...(leftDetailTab === "review" && activityBlock ? [activityBlock] : []),
  ];
  const feedBlocks = workspace.blocks.filter((block) =>
    block.key !== "summary" && block.key !== "activity",
  );
  const visibleBlocks = showSummary
    ? workspace.blocks
    : workspace.blocks.filter((block) => block.key !== "summary");
  if (feedBlocks.length === 0) {
    return `<div id="factory-workbench-focus-scroll" data-preserve-scroll-key="focus" class="factory-scrollbar flex min-w-0 flex-col gap-6 overflow-x-hidden pr-1 lg:h-full lg:min-h-0 lg:overflow-y-auto" data-workbench-objective-id="${esc(workspace.objectiveId ?? "")}" data-workbench-filter="${esc(workspace.filter)}">
      ${visibleBlocks.map((block) => renderWorkbenchBlockIsland(block, routeContext)).join("")}
    </div>`;
  }
  return `<div class="flex min-w-0 flex-col gap-4 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[minmax(320px,0.92fr)_minmax(0,1.08fr)] lg:gap-5 lg:overflow-hidden" data-workbench-objective-id="${esc(workspace.objectiveId ?? "")}" data-workbench-filter="${esc(workspace.filter)}">
    <section class="flex min-h-0 min-w-0 flex-col overflow-hidden border border-border bg-card/35">
      ${renderWorkbenchPrimaryHeader(workspace, routeContext)}
      <div id="factory-workbench-focus-scroll" data-preserve-scroll-key="focus" class="factory-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5 lg:pr-1">
        <div class="flex min-w-0 flex-col gap-6">
      ${liveBlocks.map((block) => renderWorkbenchBlockIsland(block, routeContext)).join("")}
        </div>
      </div>
    </section>
    <section class="flex min-h-0 min-w-0 flex-col overflow-hidden border border-border bg-card/35">
      ${renderWorkbenchFeedHeader(workspace, routeContext)}
      <div id="factory-workbench-rail-scroll" data-preserve-scroll-key="rail" class="factory-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5">
        <div class="flex min-w-0 flex-col gap-6">
          ${feedBlocks.map((block) => renderWorkbenchBlockIsland(block, routeContext)).join("")}
        </div>
      </div>
    </section>
  </div>`;
};

const renderInspectorTabLink = (
  routeContext: FactoryWorkbenchRouteContext,
  tab: FactoryInspectorTab,
  label: string,
  compact?: boolean,
): string => {
  const href = routeHref(routeContext, { inspectorTab: tab });
  const active = (routeContext.inspectorTab ?? "overview") === tab;
  const pad = compact ? "px-2.5 py-1 text-[10px]" : "px-3 py-2 text-[12px]";
  return `<a href="${esc(href)}" data-factory-href="${esc(href)}" ${active ? 'aria-current="page"' : ""} class="inline-flex items-center justify-center border font-semibold uppercase tracking-[0.14em] transition ${pad} ${active
    ? "border-primary/20 bg-primary/10 text-primary"
    : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground"}">${esc(label)}</a>`;
};

const renderProfileListSection = (
  title: string,
  items: ReadonlyArray<string>,
): string => items.length > 0
  ? `<section class="border border-border bg-card px-4 py-4">
    <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(title)}</div>
    <div class="mt-3 space-y-2">
      ${items.map((item) => `<div class="border border-border bg-muted/25 px-3 py-2 text-sm leading-6 text-foreground">${esc(item)}</div>`).join("")}
    </div>
  </section>`
  : "";

const renderEmployeeProfilePanel = (
  model: FactoryChatIslandModel,
  options?: {
    readonly sectionLimit?: number;
    readonly includeTools?: boolean;
  },
): string => {
  const roles = (model.activeProfileRoles ?? []).slice(0, 6);
  const responsibilities = engineerResponsibilities(model).slice(0, 6);
  const profileSections = (model.activeProfileSections ?? [])
    .filter((section) => {
      const normalized = section.title.trim().toLowerCase();
      return normalized !== "roles" && normalized !== "responsibilities" && section.items.length > 0;
    })
    .slice(0, options?.sectionLimit ?? 3);
  const tools = options?.includeTools
    ? (model.activeProfileTools ?? []).slice(0, 8)
    : [];
  const profileIntro = [
    model.activeProfileProfileSummary
      ? `<div class="border border-border bg-muted/25 px-3 py-2.5">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">PROFILE.md</div>
        <div class="mt-1 text-sm leading-6 text-foreground">${esc(model.activeProfileProfileSummary)}</div>
      </div>`
      : "",
    model.activeProfileSoulSummary
      ? `<div class="border border-border bg-muted/25 px-3 py-2.5">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">SOUL.md</div>
        <div class="mt-1 text-sm leading-6 text-foreground">${esc(model.activeProfileSoulSummary)}</div>
      </div>`
      : "",
  ].filter(Boolean).join("");
  const toolsMarkup = tools.length > 0
    ? `<div class="mt-4 flex flex-wrap gap-2">
      ${tools.map((tool) => `<span class="inline-flex items-center border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">${esc(tool)}</span>`).join("")}
    </div>`
    : "";
  const cards = [
    `<section class="border border-border bg-card px-4 py-4">
      <div class="flex items-start gap-3">
        <span class="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-background text-primary">
          ${iconWorker("h-4 w-4")}
        </span>
        <div class="min-w-0 flex-1">
          <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Employee Profile</div>
          <div class="mt-1 text-base font-semibold text-foreground">${esc(model.activeProfileLabel)}</div>
          ${engineerPrimaryRole(model) ? `<div class="mt-1 text-sm text-muted-foreground">${esc(engineerPrimaryRole(model)!)}</div>` : ""}
        </div>
      </div>
      ${roles.length > 0 ? `<div class="mt-4 flex flex-wrap gap-2">
        ${roles.map((role) => `<span class="inline-flex items-center border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">${esc(role)}</span>`).join("")}
      </div>` : ""}
      ${profileIntro ? `<div class="mt-4 space-y-3">${profileIntro}</div>` : ""}
      ${toolsMarkup}
    </section>`,
    renderProfileListSection("Responsibilities", responsibilities),
    ...profileSections.map((section) => renderProfileListSection(section.title, section.items.slice(0, 6))),
  ].filter(Boolean);
  return cards.length > 0
    ? cards.join("")
    : `<section class="border border-border bg-card px-4 py-4 text-sm leading-6 text-muted-foreground">
      Profile and soul notes will appear here when available.
    </section>`;
};

const renderEmployeeOverviewPanel = (
  model: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const objective = model.selectedThread;
  const status = objective?.displayState ?? titleCaseLabel(objective?.status) ?? "Available";
  const focusHref = routeHref(routeContext, { inspectorTab: "chat" });
  const actions = objective
    ? [
      objective.primaryAction ? renderWorkbenchActionButton(routeContext, objective.primaryAction) : "",
      ...(objective.secondaryActions ?? []).map((action) => renderWorkbenchActionButton(routeContext, action)),
    ].filter(Boolean).join("")
    : `<a href="${esc(focusHref)}" data-factory-href="${esc(focusHref)}" class="${workbenchPrimaryActionClass}">Message engineer</a>`;
  const overviewNote = model.activeRun || model.activeCodex || (model.liveChildren?.length ?? 0) > 0
    ? "Current run updates stay pinned on the left."
    : "Pick an objective from the queue when you want its dedicated chat.";
  return `<div class="space-y-4">
    ${objective ? `<section class="border border-border bg-card px-4 py-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Objective Brief</div>
          <div class="mt-2 text-sm font-semibold text-foreground">${esc(objective.title)}</div>
        </div>
        ${badge(status, displayStateTone(status))}
      </div>
      <div class="mt-3 border border-border bg-muted/25 px-3 py-2.5">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Latest Outcome</div>
        <div class="mt-1 text-sm leading-6 text-foreground">${esc(objective.bottomLine ?? objective.summary ?? "No bottom line yet.")}</div>
      </div>
      <div class="mt-3 border border-border bg-muted/25 px-3 py-2.5">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Next Operator Action</div>
        <div class="mt-1 text-sm leading-6 text-foreground">${esc(objective.nextAction ?? "Ask chat for the next step.")}</div>
      </div>
      <div class="mt-3 text-xs leading-5 text-muted-foreground">${esc(overviewNote)}</div>
      <div class="mt-4 flex flex-wrap gap-2">${actions}</div>
    </section>` : `<section class="border border-border bg-card px-4 py-4 text-sm leading-6 text-muted-foreground">
      No objective is selected. Start in New Chat to discuss the work, or select an objective from the queue to reopen its chat.
      <div class="mt-4">${actions}</div>
    </section>`}
  </div>`;
};

export const factoryWorkbenchChatIsland = (
  model: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const inspectorTab = routeContext.inspectorTab ?? "overview";
  const content = inspectorTab === "chat"
    ? `${model.items.length === 0 ? renderEngineerCard(model) : ""}
      ${renderFactoryTranscriptSection(model, {
        sectionLabel: "Chat",
        objectiveHref: (objectiveId) => objectiveHref(routeContext, objectiveId),
        emptyState: {
          title: "Start a new chat.",
          message: "Use New Chat to hand off work, ask Factory questions, or use /obj to create an objective directly.",
          detail: "When work is handed to the background, progress stays pinned on the left and chat stays free for the next question.",
        },
      })}`
    : renderEmployeeOverviewPanel(model, routeContext);
  return `<div class="flex min-h-0 flex-col gap-4" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}" data-chat-id="${esc(model.chatId ?? "")}" data-objective-id="${esc(model.objectiveId ?? "")}" data-active-run-id="${esc(model.runId ?? "")}" data-known-run-ids="${esc((model.knownRunIds ?? []).join(","))}" data-terminal-run-ids="${esc((model.terminalRunIds ?? []).join(","))}">
    ${content}
  </div>`;
};

const isSummaryVisible = (workspace: FactoryWorkbenchWorkspaceModel): boolean =>
  true;

export const factoryWorkbenchBlockIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
  blockKey: FactoryWorkbenchBlockModel["key"],
): string => {
  if (blockKey === "summary" && !isSummaryVisible(workspace)) return "";
  const block = workspace.blocks.find((candidate) => candidate.key === blockKey);
  return block ? renderBlock(block, routeContext) : "";
};

const renderWorkbenchHeader = (
  model: FactoryWorkbenchPageModel,
): string => {
  const tokenCount = model.workspace.workbench?.summary.tokensUsed ?? model.workspace.selectedObjective?.tokensUsed;
  const elapsedMinutes = resolveWorkbenchElapsedMinutes(model);
  return `<div class="flex min-w-0 items-center gap-3">
    <div class="flex min-w-0 items-center gap-3">
      <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-white/8 bg-black/60 text-muted-foreground">
        ${iconFactory("h-5 w-5")}
      </div>
      <div class="flex min-w-0 items-baseline gap-2">
        <span class="text-lg font-extrabold uppercase tracking-[0.12em] text-foreground">Receipt</span>
        <span class="shrink-0 text-[8px] font-medium uppercase tracking-[0.28em] text-muted-foreground/60">factory</span>
      </div>
      <div class="hidden h-6 w-px shrink-0 bg-white/10 sm:block"></div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-0 text-[11px] text-muted-foreground">
        <span class="font-semibold uppercase tracking-[0.16em]">Engineer</span>
        ${renderProfileSelect({
          id: "factory-workbench-profile-select",
          label: "Switch engineer",
          profiles: model.profiles,
          compact: true,
          hideLabel: true,
          wrapperClass: "inline-flex min-w-0 max-w-[12rem] flex-col",
          minWidthClass: "min-w-[7rem]",
          selectClass: "w-auto min-w-[7rem] appearance-none border border-border bg-transparent px-2.5 py-1.5 text-[13px] font-semibold leading-none text-foreground focus:border-primary/40 focus-visible:ring-1 focus-visible:ring-ring/30",
        })}
      </div>
    </div>
    ${renderWorkbenchHeaderContext(model)}
    <div class="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
      ${typeof tokenCount === "number"
        ? renderWorkbenchHeaderMetric({
          icon: iconTokens("h-3 w-3"),
          iconClass: "text-info",
          label: "Tokens",
          value: tokenCount.toLocaleString(),
          tooltip: `${tokenCount.toLocaleString()} tokens used`,
          testId: "token-count",
        })
        : ""}
      ${typeof elapsedMinutes === "number"
        ? renderWorkbenchHeaderMetric({
          icon: iconClock("h-3 w-3"),
          label: "Spent",
          value: formatElapsedMinutes(elapsedMinutes),
          tooltip: "Time spent on the selected objective",
          testId: "elapsed-minutes",
        })
        : ""}
    </div>
  </div>`;
};

export const factoryWorkbenchHeaderIsland = (
  model: FactoryWorkbenchPageModel,
): string => {
  return renderWorkbenchHeader(model);
};

const renderWorkbenchChatHeader = (
  model: FactoryWorkbenchPageModel,
  activeRole?: string,
): string => {
  const resolvedRole = activeRole?.trim();
  const routeContext: FactoryWorkbenchRouteContext = {
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    inspectorTab: model.inspectorTab,
    detailTab: model.detailTab,
    focusKind: model.focusKind,
    focusId: model.focusId,
    filter: model.filter,
  };
  const newChatHref = `/factory/new-chat?${new URLSearchParams({
    profile: model.activeProfileId,
    inspectorTab: "chat",
    detailTab: model.detailTab,
    filter: model.filter,
  }).toString()}`;
  const newChatClass = model.inspectorTab === "chat" && !model.objectiveId
    ? "border-primary/20 bg-primary/10 text-primary"
    : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground";
  return `<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      ${resolvedRole
        ? `<span class="max-w-[16rem] truncate text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground"${tooltipAttr(resolvedRole)}>${esc(truncate(resolvedRole, 24))}</span>`
        : `<span class="text-base font-semibold text-foreground">${esc(model.activeProfileLabel)}</span>`}
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      ${renderInspectorTabLink(routeContext, "overview", "Overview", true)}
      <a href="${esc(newChatHref)}" data-factory-href="${esc(newChatHref)}" class="inline-flex items-center justify-center border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] transition ${newChatClass}">New Chat</a>
      <a href="/receipt" class="inline-flex items-center px-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground transition hover:text-foreground">Receipts</a>
    </div>
  </div>`;
};

export const buildFactoryWorkbenchShellSnapshot = (
  model: FactoryWorkbenchPageModel,
): FactoryWorkbenchShellSnapshot => {
  const routeContext: FactoryWorkbenchRouteContext = {
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    inspectorTab: model.inspectorTab,
    detailTab: model.detailTab,
    focusKind: model.focusKind,
    focusId: model.focusId,
    filter: model.filter,
  };
  const pageQuery = workbenchQuery(routeContext);
  const activeRole = engineerPrimaryRole(model.chat);
  return {
    pageTitle: "Receipt Factory Workbench",
    routeKey: `/factory${pageQuery}`,
    route: routeContext,
    backgroundEventsPath: backgroundEventsPath(routeContext),
    chatEventsPath: chatEventsPath(routeContext),
    workbenchHeaderPath: workbenchHeaderPath(routeContext),
    workbenchIslandPath: workbenchIslandPath(routeContext),
    chatIslandPath: chatIslandPath(routeContext),
    workbenchHeaderHtml: renderWorkbenchHeader(model),
    chatHeaderHtml: renderWorkbenchChatHeader(model, activeRole),
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
  return `<div class="flex items-center gap-3">
    <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-white/8 bg-black/60 text-muted-foreground">
      ${iconFactory("h-5 w-5")}
    </div>
    <div class="flex min-w-0 items-baseline gap-2">
      <span class="text-lg font-extrabold uppercase tracking-[0.12em] text-foreground">Receipt</span>
      <span class="shrink-0 text-[8px] font-medium uppercase tracking-[0.28em] text-muted-foreground/60">factory</span>
    </div>
    <div class="hidden h-6 w-px shrink-0 bg-white/10 sm:block"></div>
    <div class="flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
      <span class="font-semibold text-foreground">${esc(profileLabel)}</span>
      <span class="text-[12px]">${esc(chatLabel)}</span>
      ${routeContext.objectiveId ? `<span class="inline-flex items-center gap-1">${iconFactory("h-3 w-3")} ${esc(truncate(routeContext.objectiveId, 24))}</span>` : ""}
      ${focusLabel ? `<span class="inline-flex items-center gap-1">${iconClock("h-3 w-3")} ${esc(focusLabel)}</span>` : ""}
    </div>
  </div>`;
};

const renderWorkbenchLoadingChatHeader = (routeContext: FactoryWorkbenchRouteContext): string => `<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
  <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
    <span class="text-base font-semibold text-foreground">${esc(displayLabel(routeContext.profileId) || "Factory")}</span>
    <span class="text-[11px] text-muted-foreground">Loading…</span>
  </div>
  <a href="/receipt" class="inline-flex items-center text-[11px] font-medium text-muted-foreground transition hover:text-foreground">Receipts</a>
</div>`;

const renderWorkbenchLoadingWorkspace = (): string => `<div class="flex min-w-0 flex-col gap-4 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[minmax(320px,0.92fr)_minmax(0,1.08fr)] lg:gap-4 lg:overflow-hidden">
  <section class="factory-scrollbar flex min-h-0 min-w-0 flex-col gap-4 overflow-x-hidden lg:overflow-y-auto lg:pr-1">
    <section class="border border-border bg-card px-5 py-5">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Loading</div>
      <div class="mt-2 text-base font-semibold text-foreground">Preparing realtime workspace projections.</div>
      <div class="mt-2 max-w-[56ch] text-sm leading-6 text-muted-foreground">The live board is hydrating selected-objective state, execution logs, and receipt-backed activity.</div>
    </section>
    <section class="border border-border bg-card px-5 py-5 text-sm leading-6 text-muted-foreground">
      Summary and execution surfaces will replace this placeholder as soon as the first snapshot arrives.
    </section>
  </section>
  <section class="flex min-h-0 min-w-0 flex-col overflow-hidden border border-border bg-card/35">
    <div class="shrink-0 border-b border-border bg-background/90 px-4 py-4">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Queue Monitor</div>
      <div class="mt-1 text-base font-semibold text-foreground">Loading objective feed</div>
      <div class="mt-1 text-[12px] leading-5 text-muted-foreground">Profile-board cards and completed history will stream into this compact column.</div>
    </div>
    <div class="factory-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4">
      <section class="border border-border bg-card px-5 py-5 text-sm leading-6 text-muted-foreground">
        Pending objective lists and recent history will replace this placeholder when the snapshot arrives.
      </section>
    </div>
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
</head>
<body data-factory-workbench data-workbench-shell-lazy="true" data-chat-id="${esc(routeContext.chatId)}" data-objective-id="${esc(routeContext.objectiveId ?? "")}" data-focus-kind="${esc(routeContext.focusKind ?? "")}" data-focus-id="${esc(routeContext.focusId ?? "")}" class="min-h-screen overflow-x-hidden font-sans antialiased lg:h-screen lg:overflow-hidden">
  <div class="factory-workbench-shell min-h-screen w-full bg-background text-foreground lg:h-screen">
    <div class="factory-workbench-grid grid min-h-screen w-full lg:h-full lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-[auto_minmax(0,1fr)]">
      <header id="factory-workbench-header" class="border-b border-border bg-background px-3 py-1.5 lg:border-r lg:border-border">
        ${renderWorkbenchLoadingHeader(routeContext)}
      </header>
      <div id="factory-workbench-chat-header" class="border-b border-border bg-background px-3 py-1.5">
        ${renderWorkbenchLoadingChatHeader(routeContext)}
      </div>
      <section class="flex min-h-0 min-w-0 flex-col bg-background lg:border-r lg:border-border">
        <div class="flex-1 px-4 py-4 lg:min-h-0 lg:overflow-hidden">
          <div id="factory-workbench-background-root" class="min-w-0 lg:h-full" data-events-path="${esc(backgroundEventsPath(routeContext))}">
            <div id="factory-workbench-panel" class="min-w-0 lg:h-full">
              ${renderWorkbenchLoadingWorkspace()}
            </div>
          </div>
        </div>
      </section>
      <aside class="flex min-w-0 flex-col bg-background lg:min-h-0">
        <div class="factory-workbench-chat-shell flex min-h-[42rem] flex-col overflow-hidden lg:h-full lg:min-h-0">
          <div id="factory-workbench-chat-root" data-events-path="${esc(chatEventsPath(routeContext))}" class="flex flex-1 flex-col lg:min-h-0">
            <section id="factory-workbench-chat-scroll" class="bg-background factory-scrollbar flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 lg:min-h-0">
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
                    <div id="factory-composer-completions" class="hidden mt-2 max-h-56 overflow-auto  border border-border bg-background shadow-lg" role="listbox" aria-label="Slash command suggestions"></div>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-xs leading-5 text-muted-foreground">${esc(scaffoldComposerHelper)}</div>
                    <button id="factory-composer-submit" class="inline-flex items-center justify-center  border border-primary/40 bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground" type="submit">Send</button>
                  </div>
                </div>
                <div id="factory-composer-status" class="mt-3 hidden  border border-border bg-muted px-3 py-2 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
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
</head>
<body data-factory-workbench data-route-key="${esc(shell.routeKey)}" data-chat-id="${esc(model.chatId)}" data-objective-id="${esc(model.objectiveId ?? "")}" data-inspector-tab="${esc(model.inspectorTab ?? "overview")}" data-detail-tab="${esc(model.detailTab)}" data-focus-kind="${esc(model.focusKind ?? "")}" data-focus-id="${esc(model.focusId ?? "")}" class="min-h-screen overflow-x-hidden font-sans antialiased lg:h-screen lg:overflow-hidden">
  <div class="factory-workbench-shell min-h-screen w-full bg-background text-foreground lg:h-screen">
    <div class="factory-workbench-grid grid min-h-screen w-full lg:h-full lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-[auto_minmax(0,1fr)]">
      <header id="factory-workbench-header" class="border-b border-border bg-background px-3 py-1.5 lg:border-r lg:border-border" ${liveIslandAttrs(islandBindings.header)}>
        ${shell.workbenchHeaderHtml}
      </header>
      <div id="factory-workbench-chat-header" class="border-b border-border bg-background px-3 py-1.5">
        ${shell.chatHeaderHtml}
      </div>
      <section class="flex min-h-0 min-w-0 flex-col bg-background lg:border-r lg:border-border">
        <div class="flex-1 px-4 py-4 lg:min-h-0 lg:overflow-hidden">
          <div id="factory-workbench-background-root" class="min-w-0 lg:h-full" data-events-path="${esc(backgroundEventsPath(routeContext))}">
            <div id="factory-workbench-panel" class="min-w-0 lg:h-full" ${liveIslandAttrs(islandBindings.background)}>
              ${shell.workbenchHtml}
            </div>
          </div>
        </div>
      </section>
      <aside class="flex min-w-0 flex-col bg-background lg:min-h-0">
        <div class="factory-workbench-chat-shell flex min-h-[42rem] flex-col overflow-hidden lg:h-full lg:min-h-0">
          <div id="factory-workbench-chat-root" data-events-path="${esc(chatEventsPath(routeContext))}" class="flex flex-1 flex-col lg:min-h-0">
            <section id="factory-workbench-chat-scroll" class="bg-background factory-scrollbar flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 lg:min-h-0">
              <div id="factory-workbench-chat" ${liveIslandAttrs(islandBindings.chat)}>
                ${shell.chatHtml}
              </div>
              <div id="factory-chat-live" class="mt-4 space-y-3">
                ${renderFactoryStreamingShell(model.activeProfileLabel, { liveMode: "js" })}
                <div id="factory-chat-optimistic" class="space-y-2" aria-live="polite"></div>
              </div>
            </section>
            <section id="factory-workbench-composer-shell" class="shrink-0 border-t border-border bg-background px-4 py-4">
              <form id="factory-composer" action="${esc(shell.composeAction)}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
                <input id="factory-composer-current-job" type="hidden" name="currentJobId" value="" />
                <label class="sr-only" for="factory-prompt">Factory prompt</label>
                <div class="space-y-3">
                  ${composerActions}
                  <div class="relative">
                    <textarea id="factory-prompt" name="prompt" class="min-h-[120px] w-full resize-none border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/30" rows="3" placeholder="${esc(shell.composerPlaceholder)}" autofocus aria-autocomplete="list" aria-expanded="false" aria-controls="factory-composer-completions" aria-haspopup="listbox"></textarea>
                    <div id="factory-composer-completions" class="hidden mt-2 max-h-56 overflow-auto  border border-border bg-background shadow-lg" role="listbox" aria-label="Slash command suggestions"></div>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-xs leading-5 text-muted-foreground">${esc(composerHelper)}</div>
                    <button id="factory-composer-submit" class="inline-flex items-center justify-center  border border-primary/40 bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground" type="submit">Send</button>
                  </div>
                </div>
                <div id="factory-composer-status" class="mt-3 hidden  border border-border bg-muted px-3 py-2 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
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
