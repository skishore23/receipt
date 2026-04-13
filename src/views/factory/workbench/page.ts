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
  statusDot,
  toneForValue,
  truncate,
} from "../../ui";
import {
  describeTranscriptState,
  renderFactoryTranscriptSection,
} from "../transcript";
import { renderFactoryRunSteps } from "../../factory-live-steps";
import {
  displayStateTone,
} from "../supervision";
import { renderObjectiveSelfImprovementSnapshot as renderSharedObjectiveSelfImprovementSnapshot } from "../shared/self-improvement";
import { renderMarkdown } from "../shared/markdown";
import { COMPOSER_COMMANDS } from "../../../factory-cli/composer";
import { DEFAULT_FACTORY_WORKBENCH_FILTER } from "../../factory-models";
import {
  buildFactoryWorkbenchRouteKey,
  buildFactoryWorkbenchSearch,
  buildFactoryWorkbenchSearchParams,
  type FactoryWorkbenchShellBase,
} from "./route";
import type {
  FactoryChatIslandModel,
  FactoryChatProfileNav,
  FactoryChatObjectiveNav,
  FactoryInspectorTab,
  FactorySelectedObjectiveCard,
  FactoryWorkbenchActivitySectionModel,
  FactoryWorkbenchBlockModel,
  FactoryWorkbenchDetailTab,
  FactoryWorkbenchFilterKey,
  FactoryWorkbenchObjectiveListSectionModel,
  FactoryWorkbenchPageModel,
  FactoryWorkbenchSummarySectionModel,
  FactoryWorkbenchWorkspaceModel,
  WorkbenchVersionEnvelope,
} from "../../factory-models";

export type FactoryWorkbenchRouteContext = {
  readonly shellBase: FactoryWorkbenchShellBase;
  readonly profileId: string;
  readonly chatId: string;
  readonly objectiveId?: string;
  readonly inspectorTab?: FactoryInspectorTab;
  readonly detailTab?: FactoryWorkbenchDetailTab;
  readonly page?: number;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly filter: FactoryWorkbenchFilterKey;
};

export type FactoryWorkbenchShellSnapshot = {
  readonly pageTitle: string;
  readonly routeKey: string;
  readonly route: FactoryWorkbenchRouteContext;
  readonly envelope?: WorkbenchVersionEnvelope;
  readonly location?: string;
  readonly livePath: string;
  readonly backgroundRootPath: string;
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

export type FactoryWorkbenchHeaderIslandModel = {
  readonly activeProfileId: string;
  readonly activeProfileLabel: string;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly currentRole?: string;
  readonly currentPresence?: string;
};

export type FactoryWorkbenchChatHeaderModel = {
  readonly route: FactoryWorkbenchRouteContext;
  readonly activeProfileLabel: string;
  readonly activeRole?: string;
};

type WorkbenchProjection = "profile-board" | "objective-runtime";

const workbenchBackgroundRefreshOn = [
  { event: "profile-board-refresh", throttleMs: 320 },
  { event: "objective-runtime-refresh", throttleMs: 320 },
] as const;

const workbenchChatRefreshOn = (input: Pick<FactoryWorkbenchRouteContext, "inspectorTab" | "objectiveId">) => input.inspectorTab === "chat"
  ? [
      { event: "agent-refresh", throttleMs: 180 },
      { event: "job-refresh", throttleMs: 180 },
      ...(input.objectiveId ? [{ event: "objective-runtime-refresh", throttleMs: 180 }] : []),
    ] as const
  : [
      { event: "profile-board-refresh", throttleMs: 300 },
      ...(input.objectiveId ? [{ event: "objective-runtime-refresh", throttleMs: 300 }] : []),
    ] as const;

const composerCommandsJson = (): string => JSON.stringify(COMPOSER_COMMANDS.map((command) => ({
  name: command.name,
  label: command.label,
  usage: command.usage,
  description: command.description,
  aliases: command.aliases ?? [],
})));

const routeBase = (input: Pick<FactoryWorkbenchRouteContext, "shellBase">): string => input.shellBase;

const livePath = (input: Pick<FactoryWorkbenchRouteContext, "shellBase" | "profileId" | "chatId" | "objectiveId" | "focusKind" | "focusId">): string => {
  const params = buildFactoryWorkbenchSearchParams({
    profileId: input.profileId,
    chatId: input.chatId,
    objectiveId: input.objectiveId,
    filter: DEFAULT_FACTORY_WORKBENCH_FILTER,
  });
  if (input.focusKind === "job" && input.focusId) params.set("job", input.focusId);
  const query = params.toString();
  return `${routeBase(input)}/live${query ? `?${query}` : ""}`;
};

const workbenchBackgroundRootPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/workbench/background-root${buildFactoryWorkbenchSearch(input)}`;

const workbenchBlockPath = (
  input: FactoryWorkbenchRouteContext,
  blockKey: FactoryWorkbenchBlockModel["key"],
): string => {
  const params = buildFactoryWorkbenchSearchParams(input);
  params.set("block", blockKey);
  const query = params.toString();
  return `${routeBase(input)}/island/workbench/block${query ? `?${query}` : ""}`;
};

const workbenchIslandPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/workbench${buildFactoryWorkbenchSearch(input)}`;

const workbenchBoardPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/workbench/board${buildFactoryWorkbenchSearch(input)}`;

const chatIslandPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/chat${buildFactoryWorkbenchSearch(input)}`;

const workbenchFocusPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/workbench/focus${buildFactoryWorkbenchSearch(input)}`;

const workbenchRailPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/workbench/rail${buildFactoryWorkbenchSearch(input)}`;

const workbenchChatShellPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/workbench/chat-shell${buildFactoryWorkbenchSearch(input)}`;

const workbenchChatPanePath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/workbench/chat-pane${buildFactoryWorkbenchSearch(input)}`;

const workbenchChatBodyPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/workbench/chat-body${buildFactoryWorkbenchSearch(input)}`;

const workbenchSelectionPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/workbench/select${buildFactoryWorkbenchSearch(input)}`;

const htmxNavAttrs = (
  path: string,
  targetId: string,
  swap: "innerHTML" | "outerHTML" = "outerHTML",
): string => `hx-get="${esc(path)}" hx-target="${esc(targetId)}" hx-swap="${esc(swap)}" hx-push-url="true"`;

const passiveRefreshAttrs = (path: string): string => `data-refresh-path="${esc(path)}"`;

const htmxOobAttrs = (targetId: string): string =>
  `hx-swap-oob="outerHTML:${esc(targetId)}"`;

const withOuterHtmlOob = (targetId: string, markup: string): string =>
  markup.replace(/^(<\w+)/, `$1 ${htmxOobAttrs(targetId)}`);

const workbenchEnvelopeAttrs = (envelope?: WorkbenchVersionEnvelope): string => {
  if (!envelope) return "";
  return [
    `data-workbench-route-key="${esc(envelope.routeKey)}"`,
    `data-workbench-profile-id="${esc(envelope.profileId)}"`,
    `data-workbench-chat-id="${esc(envelope.chatId)}"`,
    `data-workbench-objective-id="${esc(envelope.objectiveId ?? "")}"`,
    `data-workbench-board-version="${esc(envelope.boardVersion)}"`,
    `data-workbench-focus-version="${esc(envelope.focusVersion)}"`,
    `data-workbench-chat-version="${esc(envelope.chatVersion)}"`,
  ].join(" ");
};

const workbenchChatRegionTarget = "#factory-workbench-chat-region";

const workbenchBlockProjections = (
  block: Pick<FactoryWorkbenchBlockModel, "key">,
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

const workbenchComposerPlaceholder = (objectiveId?: string): string => objectiveId
  ? "Chat with Factory, use /note to add context, /obj to create new work, or /react to update the selected objective."
  : "Ask a new question, or use /obj to create an objective directly.";

const isTerminalObjectiveStatusValue = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const hasMissingObjectiveSelection = (input: {
  readonly objectiveId?: string;
  readonly selectedObjective?: Pick<FactorySelectedObjectiveCard, "status">;
}): boolean => Boolean(input.objectiveId && !input.selectedObjective);

const workbenchComposerPlaceholderForSelection = (input: {
  readonly objectiveId?: string;
  readonly selectedObjective?: Pick<FactorySelectedObjectiveCard, "status">;
}): string => {
  if (!input.objectiveId && !input.selectedObjective) return workbenchComposerPlaceholder();
  if (hasMissingObjectiveSelection(input)) {
    return "Selected objective could not be loaded. Ask a new question, or use /obj to start a replacement objective.";
  }
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
  if (hasMissingObjectiveSelection(input)) {
    return "Selected objective could not be loaded from the current Factory store. Plain text stays chat-first; use /obj to start new work.";
  }
  if (selected?.status === "blocked") {
    return "Selected objective is blocked. Use /react <guidance> to continue it, /cancel to stop it, or plain text to stay in chat.";
  }
  if (isTerminalObjectiveStatusValue(selected?.status)) {
    const label = displayLabel(selected?.status) || "terminal";
    return `Selected objective is ${label.toLowerCase()}. Use /obj to start follow-up work, or plain text to discuss next steps.`;
  }
  return "Plain text stays chat-first. Use /note <context> to attach context, or /react <guidance> to mutate the selected objective.";
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
  if (hasMissingObjectiveSelection(input)) {
    return `<div class="flex flex-wrap items-center gap-2">${renderComposerPrefillButton("New Objective", "/obj ", ghostButtonClass)}</div>`;
  }
  const selected = input.selectedObjective;
  const buttons = [
    renderComposerPrefillButton("Note", "/note ", ghostButtonClass),
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
): string => buildFactoryWorkbenchRouteKey({
  ...input,
  profileId: profileId ?? input.profileId,
  objectiveId,
  inspectorTab: objectiveId ? "chat" : input.inspectorTab,
  focusKind: focus?.focusKind,
  focusId: focus?.focusId,
  basePath: input.shellBase,
});

const filterHref = (
  input: FactoryWorkbenchRouteContext,
  filter: FactoryWorkbenchFilterKey,
): string => buildFactoryWorkbenchRouteKey({
  ...input,
  filter,
  basePath: input.shellBase,
});

const routeHref = (
  input: FactoryWorkbenchRouteContext,
  overrides: Partial<FactoryWorkbenchRouteContext>,
): string => buildFactoryWorkbenchRouteKey({
  ...input,
  ...overrides,
  basePath: input.shellBase,
});

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

const phaseDetailLabel = (value?: string): string =>
  titleCaseLabel(value) || "";

const renderWorkbenchHeaderMetric = (input: {
  readonly icon: string;
  readonly label: string;
  readonly value: string;
  readonly tooltip?: string;
  readonly iconClass?: string;
}): string => `<div class="inline-flex items-center gap-1.5 border border-white/8 bg-black/35 px-2 py-1 text-[11px] text-muted-foreground"${tooltipAttr(input.tooltip)}>
  <span class="${esc(input.iconClass ?? "text-muted-foreground")}">${input.icon}</span>
  <span class="font-medium uppercase tracking-[0.12em]">${esc(input.label)}</span>
  <span class="font-semibold text-foreground">${esc(input.value)}</span>
</div>`;

const resolveWorkbenchElapsedMinutes = (
  model: FactoryWorkbenchHeaderIslandModel,
): number | undefined => model.workspace.workbench?.summary.elapsedMinutes;

const renderWorkbenchHeaderContext = (
  model: FactoryWorkbenchHeaderIslandModel,
): string => {
  const objective = model.workspace.selectedObjective;
  if (objective) {
    const status = objective.displayState ?? titleCaseLabel(objective.phase || objective.status);
    const detail = phaseDetailLabel(objective.phaseDetail);
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
          ${detail ? `<span class="inline-flex shrink-0 items-center border border-white/8 bg-black/25 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">${esc(detail)}</span>` : ""}
          ${taskSummary ? `<span class="inline-flex shrink-0 items-center border border-white/8 bg-black/25 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">${esc(taskSummary)}</span>` : ""}
        </div>
      </div>
    </div>`;
  }
  const role = model.currentRole?.trim();
  const presence = model.currentPresence?.trim();
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
  return `<label class="${esc(wrapperClass)}">
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

const partitionWorkbenchBlocks = (workspace: FactoryWorkbenchWorkspaceModel) => {
  const showSummary = isSummaryVisible(workspace);
  const leftDetailTab = workspace.detailTab === "review" ? "review" : "action";
  const activityBlock = workspace.blocks.find((block) => block.key === "activity");
  const summaryBlock = showSummary ? workspace.blocks.find((block) => block.key === "summary") : undefined;
  const liveBlocks = leftDetailTab === "review"
    ? [
        ...(activityBlock ? [activityBlock] : []),
      ]
    : [
        ...(summaryBlock ? [summaryBlock] : []),
      ];
  const feedBlocks = workspace.blocks.filter((block) =>
    block.key !== "summary" && block.key !== "activity",
  );
  const visibleBlocks = showSummary
    ? workspace.blocks
    : workspace.blocks.filter((block) => block.key !== "summary");
  return {
    feedBlocks,
    liveBlocks,
    visibleBlocks,
  };
};

const engineerResponsibilities = (model: FactoryChatIslandModel): ReadonlyArray<string> => {
  if ((model.activeProfileResponsibilities?.length ?? 0) > 0) {
    return model.activeProfileResponsibilities!.slice(0, 4);
  }
  const responsibilitiesSection = (model.activeProfileSections ?? [])
    .find((section) => section.title.trim().toLowerCase() === "responsibilities");
  return (responsibilitiesSection?.items ?? []).slice(0, 4);
};

const uniqueProfileSummaries = (model: FactoryChatIslandModel): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const summaries: string[] = [];
  for (const value of [
    model.activeProfileProfileSummary,
    model.activeProfileSoulSummary,
    model.activeProfileSummary,
  ]) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    summaries.push(trimmed);
  }
  return summaries;
};

const renderProfileOverviewPanel = (
  model: FactoryChatIslandModel,
): string => {
  const primaryRole = engineerPrimaryRole(model);
  const summaries = uniqueProfileSummaries(model);
  const responsibilities = engineerResponsibilities(model);
  const sections = (model.activeProfileSections ?? [])
    .filter((section) => section.title.trim().toLowerCase() !== "responsibilities")
    .slice(0, 3);
  const tools = (model.activeProfileTools ?? []).slice(0, 6);
  if (
    !primaryRole
    && summaries.length === 0
    && responsibilities.length === 0
    && sections.length === 0
    && tools.length === 0
  ) {
    return "";
  }
  const summaryHighlights = summaries
    .flatMap((summary) => summary
      .split(/(?<=[.!?])\s+/)
      .map((part) => part.trim())
      .filter(Boolean))
    .slice(0, 4);
  return `<section class="border border-border bg-card">
    <div class="flex items-center gap-3 border-b border-border px-4 py-3">
      <span class="flex h-7 w-7 shrink-0 items-center justify-center text-primary">${iconWorker("h-4 w-4")}</span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Profile Brief</div>
          <div class="text-sm font-semibold text-foreground">${esc(model.activeProfileLabel)}</div>
          ${primaryRole ? `<span class="inline-flex items-center border border-border bg-background px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground"${tooltipAttr(primaryRole)}>${esc(truncate(primaryRole, 36))}</span>` : ""}
        </div>
      </div>
    </div>
    <div class="flex flex-col">
      ${summaries.length > 0 ? `<section class="border-b border-border">
        <div class="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Summary</div>
        <div class="space-y-2 px-4 pb-4">
          ${summaryHighlights.map((summary) => `<div class="border border-border bg-muted/25 px-3 py-2.5 text-sm leading-6 text-foreground"${tooltipAttr(summary)}>${esc(summary)}</div>`).join("")}
        </div>
      </section>` : ""}
      ${responsibilities.length > 0 ? `<section class="border-b border-border">
        <div class="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Responsibilities</div>
        <div class="space-y-2 px-4 pb-4">
          ${responsibilities.map((item) => `<div class="border border-border bg-muted/25 px-3 py-2.5 text-sm leading-6 text-foreground">${esc(item)}</div>`).join("")}
        </div>
      </section>` : ""}
      ${sections.map((section, index) => `<section class="${index === sections.length - 1 && tools.length === 0 ? "" : "border-b border-border"}">
        <div class="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">${esc(section.title)}</div>
        <div class="space-y-2 px-4 pb-4">
          ${section.items.map((item) => `<div class="border border-border bg-muted/25 px-3 py-2.5 text-sm leading-6 text-foreground">${esc(item)}</div>`).join("")}
        </div>
      </section>`).join("")}
      ${tools.length > 0 ? `<section>
        <div class="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Tool Access</div>
        <div class="factory-scrollbar h-32 overflow-x-hidden overflow-y-auto px-4 pb-4">
          <div class="flex flex-wrap gap-2">
            ${tools.map((tool) => `<span class="inline-flex items-center border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">${esc(tool)}</span>`).join("")}
          </div>
        </div>
      </section>` : ""}
    </div>
  </section>`;
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
  const targetRoute = {
    ...routeContext,
    filter: filter.key,
  };
  return `<a href="${esc(href)}" ${htmxNavAttrs(workbenchRailPath(targetRoute), "#factory-workbench-rail-shell")} ${filter.selected ? 'aria-current="page"' : ""} class="inline-flex items-center border-b-2 px-0 py-1.5 text-sm font-medium transition ${filter.selected
  ? "border-primary text-foreground"
  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"}">${esc(filter.label)}</a>`;
};

const objectiveCardStateLabel = (
  objective: FactoryChatObjectiveNav,
): string => objective.displayState ?? (titleCaseLabel(objective.phase || objective.status) || "Idle");

const objectiveCardPhaseDetailLabel = (
  objective: FactoryChatObjectiveNav,
): string => phaseDetailLabel(objective.phaseDetail);

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
  const objectiveRouteContext: FactoryWorkbenchRouteContext = {
    ...routeContext,
    chatId: objective.chatId ?? routeContext.chatId,
  };
  const href = objectiveHref(objectiveRouteContext, objective.objectiveId, undefined, objective.profileId);
  const selectRoute: FactoryWorkbenchRouteContext = {
    ...objectiveRouteContext,
    profileId: objective.profileId ?? routeContext.profileId,
    objectiveId: objective.objectiveId,
    inspectorTab: "chat",
  };
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
  const detailLabel = objectiveCardPhaseDetailLabel(objective);
  const selectedBadge = objectiveCardSelectionBadge(objective.selected);
  const cardClass = objective.selected
    ? "border border-primary/30 bg-primary/8 ring-1 ring-primary/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    : "border border-transparent bg-transparent hover:border-border/70 hover:bg-accent/35";
  const statusTileClass = objective.selected
    ? "border-primary/20 bg-primary/10"
    : "border-border/80 bg-background/80";
  return `<a href="${esc(href)}" ${htmxNavAttrs(workbenchSelectionPath(selectRoute), "#factory-workbench-background-root")} data-objective-id="${esc(objective.objectiveId)}" data-selected="${objective.selected ? "true" : "false"}" ${objective.selected ? 'aria-current="page"' : ""} class="block px-2 py-2 transition">
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
          ${detailLabel ? `<span class="inline-flex items-center border border-border bg-muted/25 px-2 py-1">${esc(detailLabel)}</span>` : ""}
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
    return `<a href="${esc(focusHref)}" ${htmxNavAttrs(workbenchChatShellPath({
      ...routeContext,
      inspectorTab: "chat",
      objectiveId: routeContext.objectiveId,
    }), workbenchChatRegionTarget)} class="${className}">${esc(action.label)}</a>`;
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
    buttons.push(`<a href="${esc(chatHref)}" ${htmxNavAttrs(workbenchChatShellPath({
      ...routeContext,
      inspectorTab: "chat",
      objectiveId: routeContext.objectiveId,
    }), workbenchChatRegionTarget)} class="${workbenchSecondaryActionClass}">Open Chat</a>`);
  }
  return `<div class="mt-3 flex flex-wrap gap-2">${buttons.join("")}</div>`;
};

const recommendationConfidenceTone = (
  confidence: NonNullable<NonNullable<FactorySelectedObjectiveCard["selfImprovement"]>["recommendations"][number]>["confidence"],
): "neutral" | "info" | "success" | "warning" => {
  switch (confidence) {
    case "high":
      return "success";
    case "medium":
      return "info";
    default:
      return "warning";
  }
};

const systemHealthTone = (
  healthStatus: NonNullable<FactorySelectedObjectiveCard["systemImprovement"]>["healthStatus"],
): "neutral" | "info" | "success" | "warning" | "danger" => {
  switch (healthStatus) {
    case "action_needed":
      return "danger";
    case "watch":
      return "warning";
    default:
      return "success";
  }
};

const renderSystemImprovementSnapshot = (
  systemImprovement: FactorySelectedObjectiveCard["systemImprovement"] | FactoryWorkbenchSummarySectionModel["systemImprovement"],
  routeContext: FactoryWorkbenchRouteContext,
  options?: {
    readonly compact?: boolean;
  },
): string => {
  if (!systemImprovement) return "";
  const compact = options?.compact ?? false;
  const recommendation = systemImprovement.selectedRecommendation ?? systemImprovement.recommendations[0];
  const anomalyPreview = systemImprovement.auditSummary.topAnomalies.slice(0, compact ? 2 : 4);
  return `<section class="border border-border bg-muted/25 px-4 py-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">System Improvement</div>
      ${badge(displayLabel(systemImprovement.healthStatus) ?? systemImprovement.healthStatus, systemHealthTone(systemImprovement.healthStatus))}
    </div>
    <div class="mt-2 text-xs leading-5 text-muted-foreground">${esc(`Updated ${formatTs(systemImprovement.generatedAt)} · audit ${systemImprovement.auditSummary.weakObjectives}/${systemImprovement.auditSummary.objectivesAudited} weak`)}</div>
    <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      ${renderSummaryTextCard("Base DST", `integrity ${systemImprovement.dstSummary.integrityFailures} · replay ${systemImprovement.dstSummary.replayFailures} · deterministic ${systemImprovement.dstSummary.deterministicFailures}`)}
      ${renderSummaryTextCard("Context DST", `hard ${systemImprovement.contextSummary.hardFailureCount} · warnings ${systemImprovement.contextSummary.compatibilityWarningCount}`)}
      ${renderSummaryTextCard("Audit Window", `${systemImprovement.auditSummary.objectivesAudited} objectives · ${systemImprovement.auditSummary.strongObjectives} strong`)}
      ${renderSummaryTextCard("Top Goal", recommendation?.summary ?? "No repo-wide recommendation recorded yet.")}
    </div>
    ${recommendation ? `<div class="mt-3 border border-border bg-background px-3 py-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold leading-6 text-foreground">${esc(recommendation.summary)}</div>
          <div class="mt-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">${esc(recommendation.scope)}</div>
        </div>
        ${badge(displayLabel(recommendation.confidence) ?? recommendation.confidence, recommendationConfidenceTone(recommendation.confidence))}
      </div>
      ${compact ? "" : `<div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(recommendation.suggestedFix)}</div>`}
      ${recommendation.successMetrics.length > 0 ? `<div class="mt-3 space-y-2">
        ${recommendation.successMetrics.slice(0, compact ? 1 : 3).map((metric) => `<div class="border border-border bg-muted/25 px-3 py-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">${esc(metric.label)}</div>
            ${badge(metric.severity === "hard_defect" ? "Hard Defect" : "Warning", metric.severity === "hard_defect" ? "danger" : "warning")}
          </div>
          <div class="mt-1 text-sm leading-6 text-foreground">${esc(`Baseline: ${metric.baseline}`)}</div>
          <div class="text-sm leading-6 text-muted-foreground">${esc(`Target: ${metric.target}`)}</div>
          ${compact || metric.verification.length === 0 ? "" : `<div class="mt-2 text-xs leading-5 text-muted-foreground">${esc(`Verify: ${metric.verification.join(" | ")}`)}</div>`}
        </div>`).join("")}
      </div>` : ""}
      ${recommendation.acceptanceChecks.length > 0 && !compact ? `<div class="mt-3 text-xs leading-5 text-muted-foreground">${esc(`Acceptance: ${recommendation.acceptanceChecks.join(" | ")}`)}</div>` : ""}
      ${!compact && !systemImprovement.autoFixObjectiveId ? `<form class="mt-3" data-factory-inline-submit="true" data-factory-inline-pending-label="Applying..." data-factory-inline-pending-status="Applying repo-wide system recommendation..." action="${esc(`${routeContext.shellBase}/api/system-improvement/apply${buildFactoryWorkbenchSearch(routeContext)}`)}" method="post">
        <button type="submit" class="${workbenchPrimaryActionClass}">Apply</button>
        <div data-factory-inline-status="true" class="mt-2 hidden border border-border bg-muted px-3 py-2 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
      </form>` : ""}
    </div>` : `<div class="mt-3 text-sm leading-6 text-muted-foreground">No repo-wide recommendation recorded yet.</div>`}
    ${anomalyPreview.length > 0 ? `<div class="mt-3 flex flex-wrap gap-2">
      ${anomalyPreview.map((item) => `<span class="inline-flex items-center border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">${esc(`${item.category} ×${item.count}`)}</span>`).join("")}
    </div>` : ""}
    ${systemImprovement.autoFixObjectiveId ? `<div class="mt-3 border border-info/20 bg-info/10 px-3 py-2 text-sm leading-6 text-foreground">
      Repo-wide auto-fix objective:
      <a href="${esc(objectiveHref(routeContext, systemImprovement.autoFixObjectiveId))}" data-factory-href="${esc(objectiveHref(routeContext, systemImprovement.autoFixObjectiveId))}" class="font-semibold text-primary underline-offset-2 hover:underline">${esc(systemImprovement.autoFixObjectiveId)}</a>
    </div>` : ""}
  </section>`;
};

const renderObjectiveSelfImprovementSnapshot = (
  objective: FactoryWorkbenchSummarySectionModel["objective"],
  routeContext: FactoryWorkbenchRouteContext,
  options?: {
    readonly compact?: boolean;
  },
): string => objective
  ? renderSharedObjectiveSelfImprovementSnapshot({
      objectiveId: objective.objectiveId,
      selfImprovement: objective.selfImprovement,
      compact: options?.compact,
      actionButtonClass: workbenchPrimaryActionClass,
      buildObjectiveHref: (objectiveId, profileId) => objectiveHref(routeContext, objectiveId, undefined, profileId),
      buildApplyAction: (objectiveId) =>
        `${routeContext.shellBase}/api/objectives/${encodeURIComponent(objectiveId)}/self-improvement/apply${buildFactoryWorkbenchSearch(routeContext)}`,
    })
  : "";

const normalizeSummaryCardValue = (value?: string): string =>
  (value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.]+$/g, "")
    .toLowerCase();

const renderSummaryTextCard = (label: string, body: string): string => `<section class="border border-border bg-muted/25 px-4 py-3">
  <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(label)}</div>
  <div class="mt-2 text-sm leading-6 text-foreground">${esc(body)}</div>
</section>`;

const renderWorkbenchLoadingPlaceholder = (): string => `<div class="factory-ephemeral-placeholder mt-3" aria-hidden="true">
  <div class="factory-ephemeral-placeholder-line factory-ephemeral-placeholder-line--long"></div>
  <div class="factory-ephemeral-placeholder-line factory-ephemeral-placeholder-line--medium"></div>
  <div class="factory-ephemeral-placeholder-line factory-ephemeral-placeholder-line--short"></div>
</div>`;

const renderWorkbenchLoadingCard = (input: {
  readonly label: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string;
  readonly tone?: "neutral" | "info" | "success" | "warning" | "danger";
  readonly detail?: string;
  readonly highlights?: ReadonlyArray<string>;
  readonly nextAction?: string;
  readonly shimmer?: boolean;
}): string => `<div class="factory-running-card border border-border bg-muted/25 px-4 py-4" data-factory-loading-card="true">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 flex-1">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(input.label)}</div>
      <div class="mt-2 text-sm font-semibold leading-6 text-foreground">${esc(input.title)}</div>
    </div>
    ${badge(input.status, input.tone ?? toneForValue(input.status))}
  </div>
  <div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(input.summary)}</div>
  ${input.detail ? `<div class="mt-3 inline-flex items-center  border border-border bg-background px-3 py-1 text-[11px] font-medium text-muted-foreground">${esc(input.detail)}</div>` : ""}
  ${input.highlights?.length ? `<div class="mt-3 space-y-1.5">
    ${input.highlights.map((line) => `<div class="text-xs leading-5 text-muted-foreground">${esc(line)}</div>`).join("")}
  </div>` : ""}
  ${input.shimmer ? `<div class="factory-running-activity text-[11px] text-muted-foreground">
    <span class="factory-running-activity-orb"></span>
    <span>Streaming live execution updates.</span>
  </div>${renderWorkbenchLoadingPlaceholder()}` : ""}
  ${input.nextAction ? `<div class="mt-3 border border-border bg-background px-3 py-2 text-xs leading-5 text-card-foreground">${esc(input.nextAction)}</div>` : ""}
</div>`;

const renderObjectiveHandoffOutputCard = (output?: string): string => {
  const body = output?.trim();
  if (!body) return "";
  return `<section class="border border-border bg-muted/25 px-4 py-3">
    <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Returned Output</div>
    <div class="mt-3 factory-markdown text-sm leading-6 text-foreground">${renderMarkdown(body)}</div>
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
    section.focus?.loading?.summary
      ?? section.focus?.summary
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
    ${section.focus?.loading ? `<div class="mt-3">${renderWorkbenchLoadingCard({
      label: "Live Objective",
      title: section.focus.title,
      status: section.focus.loading.label,
      tone: section.focus.loading.tone,
      summary: section.focus.loading.summary,
      detail: section.focus.loading.detail,
      highlights: section.focus.loading.highlights,
      nextAction: section.focus.loading.nextAction,
      shimmer: section.focus.active || section.focus.status === "running" || section.focus.status === "queued",
    })}</div>` : ""}
    ${section.focus ? renderLiveFocusControls(routeContext, section.focus) : ""}
  </section>`;
  if (section.empty || !objective) {
    const missingObjectiveSelection = Boolean(routeContext.objectiveId);
    const emptyTitle = missingObjectiveSelection ? "Objective not found." : "No objective selected.";
    const emptyMessage = missingObjectiveSelection
      ? `The current thread URL points to Factory data that no longer exists: ${routeContext.objectiveId}. Use New Chat to continue in chat, or /obj to start a replacement objective.`
      : section.message;
    return `<section class="space-y-4 border border-border bg-card px-5 py-5">
      ${currentRunCard}
      ${renderSystemImprovementSnapshot(section.systemImprovement, routeContext)}
      <section class="border border-border bg-background px-4 py-4">
        <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Selected Objective</div>
        <div class="mt-2 text-lg font-semibold text-foreground">${esc(emptyTitle)}</div>
        <div class="mt-2 max-w-[68ch] text-sm leading-6 text-muted-foreground">${esc(emptyMessage)}</div>
      </section>
    </section>`;
  }
  const displayState = objective.displayState ?? titleCaseLabel(objective.status) ?? "Running";
  const detailLabel = phaseDetailLabel(objective.phaseDetail);
  const metrics = [
    objective.profileLabel ? `Assignee: ${objective.profileLabel}` : undefined,
    typeof objective.updatedAt === "number" ? `Updated ${formatTs(objective.updatedAt)}` : undefined,
    section.tokenCount ? `${section.tokenCount} tokens` : undefined,
  ].filter(Boolean).join(" · ");
  const latestOutcome = objective.bottomLine
    ?? objective.summary
    ?? objective.latestDecisionSummary
    ?? "No bottom line captured yet.";
  const handoffOutput = objective.renderedBody?.trim();
  const showHandoffOutput = Boolean(
    handoffOutput
    && normalizeSummaryCardValue(handoffOutput) !== normalizeSummaryCardValue(latestOutcome),
  );
  const nextOperatorAction = objective.nextAction
    ?? objective.primaryAction?.label
    ?? "Ask engineer";
  const actions = [
    objective.primaryAction ? renderWorkbenchActionButton(routeContext, objective.primaryAction) : "",
    ...(objective.secondaryActions ?? []).map((action) => renderWorkbenchActionButton(routeContext, action)),
  ].filter(Boolean).join("");
  const compactStats = section.stats.slice(0, 4);
  const summaryCards = [
    { label: "Latest Outcome", value: latestOutcome },
    { label: "Next Operator Action", value: nextOperatorAction },
    { label: "Latest Decision", value: section.latestDecisionSummary },
  ].filter((entry): entry is { label: string; value: string } => Boolean(entry.value?.trim()))
    .filter((entry, index, entries) => {
      const normalized = normalizeSummaryCardValue(entry.value);
      if (!normalized) return false;
      return entries.findIndex((candidate) => normalizeSummaryCardValue(candidate.value) === normalized) === index;
    });
  const primarySummaryCard = summaryCards[0];
  const secondarySummaryCards = summaryCards.slice(1);
  return `<section class="space-y-4 border border-border bg-card px-5 py-5">
    ${currentRunCard}
    <div class="space-y-4">
      <div class="min-w-0">
        <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Selected Objective</div>
        <div class="mt-3 text-[1.05rem] font-semibold leading-[1.55] text-foreground">${esc(objective.title)}</div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          ${badge(displayState, displayStateTone(displayState))}
          ${detailLabel ? `<span class="border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">${esc(detailLabel)}</span>` : ""}
          ${typeof objective.severity === "number" ? `<span class="border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">P${esc(String(objective.severity))}</span>` : ""}
        </div>
        <div class="mt-3 text-sm leading-7 text-muted-foreground">${esc(metrics || "Waiting for more objective telemetry.")}</div>
      </div>
      ${actions ? `<div class="flex flex-wrap items-center gap-2">${actions}</div>` : ""}
    </div>
    <div class="grid gap-3 xl:grid-cols-[minmax(0,1fr)_220px] xl:items-start">
      <section class="min-w-0">
        ${primarySummaryCard ? renderSummaryTextCard(primarySummaryCard.label, primarySummaryCard.value) : ""}
      </section>
      <aside class="border border-border bg-muted/25 px-4 py-3 xl:max-w-[220px]">
        <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Objective Snapshot</div>
        <div class="mt-3 grid gap-2">
          ${compactStats.map((stat) => `<div class="border border-border bg-background px-3 py-2">
            <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">${esc(stat.label)}</div>
            <div class="mt-1 text-sm font-semibold text-foreground">${esc(stat.value)}</div>
          </div>`).join("")}
        </div>
      </aside>
    </div>
    <div class="space-y-3">
      ${showHandoffOutput ? renderObjectiveHandoffOutputCard(handoffOutput) : ""}
      ${secondarySummaryCards.map((card) => renderSummaryTextCard(card.label, card.value)).join("")}
      ${renderSystemImprovementSnapshot(section.systemImprovement, routeContext)}
      ${renderObjectiveSelfImprovementSnapshot(objective, routeContext)}
    </div>
  </section>`;
};

const renderObjectiveListSection = (
  section: FactoryWorkbenchObjectiveListSectionModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const pinned = section.key === "selected";
  const pageHref = (page: number): string => routeHref(routeContext, { page });
  const pageRailPath = (page: number): string => workbenchRailPath({
    ...routeContext,
    page,
  });
  const pagination = section.pageCount > 1 ? `<div class="flex items-center gap-2 border-t border-border px-4 py-3 text-[12px] text-muted-foreground">
    <span>Page ${esc(String(section.page))} of ${esc(String(section.pageCount))}</span>
    <div class="ml-auto flex items-center gap-2">
      <a class="inline-flex items-center border border-border px-2 py-1 ${section.hasPreviousPage ? "text-foreground hover:border-primary/50" : "pointer-events-none opacity-40"}" href="${esc(pageHref(Math.max(1, section.page - 1)))}" ${section.hasPreviousPage ? htmxNavAttrs(pageRailPath(Math.max(1, section.page - 1)), "#factory-workbench-rail-shell") : 'aria-disabled="true" tabindex="-1"'}>Previous</a>
      <a class="inline-flex items-center border border-border px-2 py-1 ${section.hasNextPage ? "text-foreground hover:border-primary/50" : "pointer-events-none opacity-40"}" href="${esc(pageHref(Math.min(section.pageCount, section.page + 1)))}" ${section.hasNextPage ? htmxNavAttrs(pageRailPath(Math.min(section.pageCount, section.page + 1)), "#factory-workbench-rail-shell") : 'aria-disabled="true" tabindex="-1"'}>Next</a>
    </div>
  </div>` : "";
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
  ${pagination}
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
      </div>` : (section.focus.loading
        ? `${renderWorkbenchLoadingCard({
          label: "Current Execution",
          title: section.focus.title,
          status: section.focus.loading.label,
          tone: section.focus.loading.tone,
          summary: section.focus.loading.summary,
          detail: section.focus.loading.detail,
          highlights: section.focus.loading.highlights,
          nextAction: section.focus.loading.nextAction,
          shimmer: section.focus.active || section.focus.status === "running" || section.focus.status === "queued",
        })}${renderLiveFocusControls(routeContext, section.focus)}`
        : `<div class="border border-border bg-muted/25 px-4 py-3">
        <div class="flex items-center justify-between gap-3">
          <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Current Execution</span>
          ${badge(titleCaseLabel(section.focus.status), toneForValue(section.focus.status))}
        </div>
        <div class="mt-1 text-sm leading-6 text-muted-foreground">${esc(truncate(section.focus.summary, 120))}</div>
        ${renderLiveFocusControls(routeContext, section.focus)}
      </div>`)}`
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
  return `<div id="factory-workbench-block-${esc(block.key)}" class="min-w-0" data-workbench-projections="${esc(projections.join(" "))}" ${passiveRefreshAttrs(workbenchBlockPath(routeContext, block.key))}>
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
  return `<a href="${esc(href)}" ${htmxNavAttrs(workbenchFocusPath({
    ...routeContext,
    detailTab: tab,
  }), "#factory-workbench-focus-shell")} ${active ? 'aria-current="page"' : ""} class="inline-flex items-center border-b-2 px-0 py-1.5 text-sm font-medium transition ${active
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
  envelope?: WorkbenchVersionEnvelope,
): string => {
  return `<div class="flex min-w-0 flex-col gap-4 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[minmax(320px,0.92fr)_minmax(0,1.08fr)] lg:gap-5 lg:overflow-hidden" data-workbench-objective-id="${esc(workspace.objectiveId ?? "")}" data-workbench-filter="${esc(workspace.filter)}">
    ${factoryWorkbenchFocusIsland(workspace, routeContext, envelope)}
    ${factoryWorkbenchRailIsland(workspace, routeContext, envelope)}
  </div>`;
};

export const factoryWorkbenchFocusIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
  envelope?: WorkbenchVersionEnvelope,
): string => {
  const { feedBlocks, liveBlocks, visibleBlocks } = partitionWorkbenchBlocks(workspace);
  const content = feedBlocks.length === 0
    ? visibleBlocks.map((block) => renderWorkbenchBlockIsland(block, routeContext)).join("")
    : `<div class="flex min-w-0 flex-col gap-6">
      ${liveBlocks.map((block) => renderWorkbenchBlockIsland(block, routeContext)).join("")}
    </div>`;
  return `<section id="factory-workbench-focus-shell" class="flex min-h-0 min-w-0 flex-col overflow-hidden border border-border bg-card/35" ${passiveRefreshAttrs(workbenchFocusPath(routeContext))} ${workbenchEnvelopeAttrs(envelope)}>
    ${feedBlocks.length === 0 ? "" : renderWorkbenchPrimaryHeader(workspace, routeContext)}
    <div id="factory-workbench-focus-scroll" data-preserve-scroll-key="focus" class="factory-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5 lg:pr-1">
      ${content}
    </div>
  </section>`;
};

export const factoryWorkbenchRailIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
  envelope?: WorkbenchVersionEnvelope,
): string => {
  const { feedBlocks } = partitionWorkbenchBlocks(workspace);
  return `<section id="factory-workbench-rail-shell" class="flex min-h-0 min-w-0 flex-col overflow-hidden border border-border bg-card/35" ${passiveRefreshAttrs(workbenchBoardPath(routeContext))} ${workbenchEnvelopeAttrs(envelope)}>
    ${renderWorkbenchFeedHeader(workspace, routeContext)}
    <div id="factory-workbench-rail-scroll" data-preserve-scroll-key="rail" class="factory-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5">
      <div class="flex min-w-0 flex-col gap-6">
        ${feedBlocks.map((block) => renderWorkbenchBlockIsland(block, routeContext)).join("")}
      </div>
    </div>
  </section>`;
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
  return `<a href="${esc(href)}" ${htmxNavAttrs(workbenchChatShellPath({
    ...routeContext,
    inspectorTab: tab,
  }), workbenchChatRegionTarget)} ${active ? 'aria-current="page"' : ""} class="inline-flex items-center justify-center border font-semibold uppercase tracking-[0.14em] transition ${pad} ${active
    ? "border-primary/20 bg-primary/10 text-primary"
    : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground"}">${esc(label)}</a>`;
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
    : `<a href="${esc(focusHref)}" ${htmxNavAttrs(workbenchChatShellPath({
      ...routeContext,
      inspectorTab: "chat",
    }), workbenchChatRegionTarget)} class="${workbenchPrimaryActionClass}">Message engineer</a>`;
  const overviewNote = model.activeRun || model.activeCodex || (model.liveChildren?.length ?? 0) > 0
    ? "Current run updates stay pinned on the left."
    : "Pick an objective from the queue when you want its dedicated chat.";
  const profileOverview = renderProfileOverviewPanel(model);
  return objective
    ? `<div class="space-y-4">
    <section class="border border-border bg-card px-4 py-4">
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
      ${objective.renderedBody?.trim()
        && normalizeSummaryCardValue(objective.renderedBody) !== normalizeSummaryCardValue(objective.bottomLine ?? objective.summary)
        ? `<div class="mt-3 border border-border bg-muted/25 px-3 py-2.5">
          <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Returned Output</div>
          <div class="mt-3 factory-markdown text-sm leading-6 text-foreground">${renderMarkdown(objective.renderedBody)}</div>
        </div>`
        : ""}
      <div class="mt-3 border border-border bg-muted/25 px-3 py-2.5">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Next Operator Action</div>
        <div class="mt-1 text-sm leading-6 text-foreground">${esc(objective.nextAction ?? "Ask chat for the next step.")}</div>
      </div>
      ${renderSystemImprovementSnapshot(objective.systemImprovement, routeContext, { compact: true })}
      ${renderObjectiveSelfImprovementSnapshot(objective, routeContext, { compact: true })}
      <div class="mt-3 text-xs leading-5 text-muted-foreground">${esc(overviewNote)}</div>
      <div class="mt-4 flex flex-wrap gap-2">${actions}</div>
    </section>
    ${profileOverview}
  </div>`
    : profileOverview;
};

export const factoryWorkbenchChatIsland = (
  model: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const inspectorTab = routeContext.inspectorTab ?? "overview";
  const transcriptState = describeTranscriptState(model);
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
  return `<div class="flex min-h-0 flex-col gap-4" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}" data-chat-id="${esc(model.chatId ?? "")}" data-objective-id="${esc(model.objectiveId ?? "")}" data-active-run-id="${esc(model.runId ?? "")}" data-known-run-ids="${esc((model.knownRunIds ?? []).join(","))}" data-terminal-run-ids="${esc((model.terminalRunIds ?? []).join(","))}" data-transcript-signature="${esc(transcriptState.signature)}" data-last-item-kind="${esc(transcriptState.lastItemKind ?? "")}">
    ${content}
  </div>`;
};

const isSummaryVisible = (_workspace: FactoryWorkbenchWorkspaceModel): boolean =>
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
  model: FactoryWorkbenchHeaderIslandModel,
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
        })
        : ""}
      ${typeof elapsedMinutes === "number"
        ? renderWorkbenchHeaderMetric({
          icon: iconClock("h-3 w-3"),
          label: "Spent",
          value: formatElapsedMinutes(elapsedMinutes),
          tooltip: "Time spent on the selected objective",
        })
        : ""}
    </div>
  </div>`;
};

const toWorkbenchHeaderModel = (
  model: FactoryWorkbenchPageModel,
): FactoryWorkbenchHeaderIslandModel => ({
  activeProfileId: model.activeProfileId,
  activeProfileLabel: model.activeProfileLabel,
  profiles: model.profiles,
  workspace: model.workspace,
  currentRole: engineerPrimaryRole(model.chat),
  currentPresence: engineerPresence(model.chat),
});

export const factoryWorkbenchHeaderIsland = (
  model: FactoryWorkbenchHeaderIslandModel,
): string => {
  return renderWorkbenchHeader(model);
};

const renderWorkbenchChatHeader = (
  model: FactoryWorkbenchChatHeaderModel,
): string => {
  const resolvedRole = model.activeRole?.trim();
  const routeContext = model.route;
  const newChatParams = new URLSearchParams();
  newChatParams.set("profile", routeContext.profileId);
  newChatParams.set("inspectorTab", "chat");
  if (routeContext.detailTab) newChatParams.set("detailTab", routeContext.detailTab);
  newChatParams.set("filter", routeContext.filter);
  const newChatHref = `${routeContext.shellBase}/new-chat?${newChatParams.toString()}`;
  const newChatClass = routeContext.inspectorTab === "chat" && !routeContext.objectiveId
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
      <a href="${esc(newChatHref)}" class="inline-flex items-center justify-center border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] transition ${newChatClass}">New Chat</a>
      <a href="/receipt" class="inline-flex items-center px-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground transition hover:text-foreground">Receipts</a>
    </div>
  </div>`;
};

const toWorkbenchChatHeaderModel = (
  routeContext: FactoryWorkbenchRouteContext,
  model: Pick<FactoryChatIslandModel, "activeProfileLabel">,
  activeRole?: string,
): FactoryWorkbenchChatHeaderModel => ({
  route: routeContext,
  activeProfileLabel: model.activeProfileLabel,
  activeRole,
});

export const factoryWorkbenchChatHeaderIsland = (
  model: FactoryWorkbenchPageModel,
): string => renderWorkbenchChatHeader(toWorkbenchChatHeaderModel({
  shellBase: "/factory",
  profileId: model.activeProfileId,
  chatId: model.chatId,
  objectiveId: model.objectiveId,
  inspectorTab: model.inspectorTab,
  detailTab: model.detailTab,
  page: model.page,
  focusKind: model.focusKind,
  focusId: model.focusId,
  filter: model.filter,
}, model.chat, engineerPrimaryRole(model.chat)));

export const factoryWorkbenchHeaderShell = (
  model: FactoryWorkbenchHeaderIslandModel,
): string => `<header id="factory-workbench-header" class="border-b border-border bg-background px-3 py-1.5">
  ${factoryWorkbenchHeaderIsland(model)}
</header>`;

export const factoryWorkbenchChatHeaderShell = (
  model: FactoryWorkbenchChatHeaderModel,
  options?: {
    readonly inPane?: boolean;
  },
): string => `<div id="factory-workbench-chat-header" class="border-b border-border bg-background px-3 py-1.5 ${options?.inPane ? "" : "lg:col-start-2 lg:row-start-1"}">
  ${renderWorkbenchChatHeader(model)}
</div>`;

export const factoryWorkbenchChatRegion = (
  workspace: FactoryWorkbenchWorkspaceModel,
  chat: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
  envelope?: WorkbenchVersionEnvelope,
): string => `<div id="factory-workbench-chat-region" class="flex min-w-0 flex-1 flex-col bg-background lg:min-h-0" ${passiveRefreshAttrs(workbenchChatShellPath(routeContext))}>
  ${factoryWorkbenchChatHeaderShell(toWorkbenchChatHeaderModel(routeContext, chat, engineerPrimaryRole(chat)), { inPane: true })}
  ${factoryWorkbenchChatBody(workspace, chat, routeContext, envelope)}
</div>`;

export const factoryWorkbenchChatBody = (
  _workspace: FactoryWorkbenchWorkspaceModel,
  chat: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
  envelope?: WorkbenchVersionEnvelope,
): string => `<div id="factory-workbench-chat-body" class="flex min-h-0 flex-1 flex-col lg:min-h-0" ${liveIslandAttrs({
  path: workbenchChatBodyPath(routeContext),
  refreshOn: workbenchChatRefreshOn(routeContext),
  swap: "outerHTML",
  clientOnly: true,
})} ${workbenchEnvelopeAttrs(envelope)}>
  <div id="factory-workbench-chat-root" class="flex flex-1 flex-col lg:min-h-0">
    <section id="factory-workbench-chat-scroll" class="bg-background factory-scrollbar flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 lg:min-h-0">
      <div id="factory-workbench-chat" ${passiveRefreshAttrs(chatIslandPath(routeContext))}>
        ${factoryWorkbenchChatIsland(chat, routeContext)}
      </div>
      <div id="factory-chat-ephemeral" class="mt-4 space-y-3" aria-live="polite"></div>
      <div id="factory-chat-streaming-content" class="hidden" aria-hidden="true"></div>
    </section>
  </div>
</div>`;

export const factoryWorkbenchChatShell = (
  workspace: FactoryWorkbenchWorkspaceModel,
  _chat: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const composerActions = renderWorkbenchComposerQuickActions({
    objectiveId: routeContext.objectiveId,
    selectedObjective: workspace.selectedObjective,
  });
  const composerHelper = workbenchComposerHelperText({
    objectiveId: routeContext.objectiveId,
    selectedObjective: workspace.selectedObjective,
  });
  return `<div id="factory-workbench-chat-shell" class="factory-workbench-chat-shell flex shrink-0 flex-col overflow-hidden">
    <section id="factory-workbench-composer-shell" class="shrink-0 border-t border-border bg-background px-4 py-4">
      <form id="factory-composer" action="${esc(`${routeContext.shellBase}/compose${buildFactoryWorkbenchSearch(routeContext)}`)}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
        <input id="factory-composer-current-job" type="hidden" name="currentJobId" value="" />
        <label class="sr-only" for="factory-prompt">Factory prompt</label>
        <div class="space-y-3">
          ${composerActions}
          <div class="relative">
            <textarea id="factory-prompt" name="prompt" class="min-h-[120px] w-full resize-none border border-border bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/30" rows="3" placeholder="${esc(workbenchComposerPlaceholderForSelection({
              objectiveId: routeContext.objectiveId,
              selectedObjective: workspace.selectedObjective,
            }))}" autofocus aria-autocomplete="list" aria-expanded="false" aria-controls="factory-composer-completions" aria-haspopup="listbox"></textarea>
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
  </div>`;
};

export const factoryWorkbenchChatShellResponse = (
  workspace: FactoryWorkbenchWorkspaceModel,
  chat: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
  envelope?: WorkbenchVersionEnvelope,
): string => factoryWorkbenchChatRegion(workspace, chat, routeContext, envelope);

export const factoryWorkbenchChatPaneIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  chat: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
  envelope?: WorkbenchVersionEnvelope,
): string => `<aside id="factory-workbench-chat-pane" class="flex min-w-0 flex-col bg-background lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-0 lg:overflow-hidden" ${passiveRefreshAttrs(workbenchChatPanePath(routeContext))}>
  ${factoryWorkbenchChatRegion(workspace, chat, routeContext, envelope)}
  ${factoryWorkbenchChatShell(workspace, chat, routeContext)}
</aside>`;

export const factoryWorkbenchBoardResponse = (input: {
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly routeContext: FactoryWorkbenchRouteContext;
  readonly envelope?: WorkbenchVersionEnvelope;
}): string => `<div data-workbench-sync="board" ${workbenchEnvelopeAttrs(input.envelope)}>
  ${factoryWorkbenchHeaderShell(input.header)}
  ${factoryWorkbenchRailIsland(input.workspace, input.routeContext, input.envelope)}
</div>`;

export const factoryWorkbenchBackgroundRootResponse = (input: {
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly routeContext: FactoryWorkbenchRouteContext;
  readonly envelope?: WorkbenchVersionEnvelope;
}): string => `${factoryWorkbenchHeaderShell(input.header)}
  <section class="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
    <div class="flex-1 px-4 py-4 lg:min-h-0 lg:overflow-hidden">
      <div id="factory-workbench-panel" class="min-w-0 lg:h-full" ${passiveRefreshAttrs(workbenchIslandPath(input.routeContext))}>
        ${factoryWorkbenchWorkspaceIsland(input.workspace, input.routeContext, input.envelope)}
      </div>
    </div>
  </section>`;

export const factoryWorkbenchBackgroundRootIsland = (input: {
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly routeContext: FactoryWorkbenchRouteContext;
  readonly envelope?: WorkbenchVersionEnvelope;
}): string => `<div id="factory-workbench-background-root" class="flex min-h-0 min-w-0 flex-col bg-background lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:border-r lg:border-border" ${liveIslandAttrs({
  path: workbenchBackgroundRootPath(input.routeContext),
  refreshOn: workbenchBackgroundRefreshOn,
  clientOnly: true,
})} ${workbenchEnvelopeAttrs(input.envelope)}>
  ${factoryWorkbenchBackgroundRootResponse(input)}
</div>`;

export const factoryWorkbenchSelectionResponse = (input: {
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly chat: FactoryChatIslandModel;
  readonly routeContext: FactoryWorkbenchRouteContext;
  readonly envelope?: WorkbenchVersionEnvelope;
}): string => {
  const backgroundRoot = factoryWorkbenchBackgroundRootIsland({
    header: input.header,
    workspace: input.workspace,
    routeContext: input.routeContext,
    envelope: input.envelope,
  });
  const chatPane = factoryWorkbenchChatPaneIsland(
    input.workspace,
    input.chat,
    input.routeContext,
    input.envelope,
  );
  return [
    backgroundRoot,
    withOuterHtmlOob("#factory-workbench-chat-pane", chatPane),
  ].join("");
};

export const buildFactoryWorkbenchShellSnapshot = (
  model: FactoryWorkbenchPageModel,
  shellBase: FactoryWorkbenchShellBase = "/factory",
  envelope?: WorkbenchVersionEnvelope,
): FactoryWorkbenchShellSnapshot => {
  const routeContext: FactoryWorkbenchRouteContext = {
    shellBase,
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    inspectorTab: model.inspectorTab,
    detailTab: model.detailTab,
    page: model.page,
    focusKind: model.focusKind,
    focusId: model.focusId,
    filter: model.filter,
  };
  const pageQuery = buildFactoryWorkbenchSearch(routeContext);
  const activeRole = engineerPrimaryRole(model.chat);
  const headerModel = toWorkbenchHeaderModel(model);
  return {
    pageTitle: "Receipt Factory Workbench",
    routeKey: buildFactoryWorkbenchRouteKey(routeContext),
    route: routeContext,
    envelope,
    livePath: livePath(routeContext),
    backgroundRootPath: workbenchBackgroundRootPath(routeContext),
    workbenchIslandPath: workbenchIslandPath(routeContext),
    chatIslandPath: chatIslandPath(routeContext),
    workbenchHeaderHtml: renderWorkbenchHeader(headerModel),
    chatHeaderHtml: renderWorkbenchChatHeader(toWorkbenchChatHeaderModel(routeContext, model.chat, activeRole)),
    workbenchHtml: factoryWorkbenchWorkspaceIsland(model.workspace, routeContext, envelope),
    chatHtml: factoryWorkbenchChatIsland(model.chat, routeContext),
    composeAction: `${routeContext.shellBase}/compose${pageQuery}`,
    composerPlaceholder: workbenchComposerPlaceholderForSelection({
      objectiveId: model.objectiveId,
      selectedObjective: model.workspace.selectedObjective,
    }),
    streamingLabel: model.activeProfileLabel,
  };
};

export const factoryWorkbenchShell = (
  model: FactoryWorkbenchPageModel,
  shellBase: FactoryWorkbenchShellBase = "/factory",
  envelope?: WorkbenchVersionEnvelope,
): string => {
  const shell = buildFactoryWorkbenchShellSnapshot(model, shellBase, envelope);
  const routeContext = shell.route;
  const headerModel = toWorkbenchHeaderModel(model);
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
<body data-factory-workbench data-shell-base="${esc(routeContext.shellBase)}" data-route-key="${esc(shell.routeKey)}" data-profile-id="${esc(model.activeProfileId)}" data-chat-id="${esc(model.chatId)}" data-objective-id="${esc(model.objectiveId ?? "")}" data-inspector-tab="${esc(model.inspectorTab ?? "overview")}" data-detail-tab="${esc(model.detailTab)}" data-focus-kind="${esc(model.focusKind ?? "")}" data-focus-id="${esc(model.focusId ?? "")}" ${workbenchEnvelopeAttrs(shell.envelope)} class="min-h-screen overflow-x-hidden font-sans antialiased lg:h-screen lg:overflow-hidden">
  <div class="factory-workbench-shell min-h-screen w-full bg-background text-foreground lg:h-screen">
    <div class="factory-workbench-grid grid min-h-screen w-full lg:h-full lg:grid-cols-[minmax(0,1fr)_420px]">
      ${factoryWorkbenchBackgroundRootIsland({
        header: headerModel,
        workspace: model.workspace,
        routeContext,
        envelope: shell.envelope,
      })}
      ${factoryWorkbenchChatPaneIsland(model.workspace, model.chat, routeContext, shell.envelope)}
    </div>
  </div>
  <script src="/assets/factory-client.js?v=${CSS_VERSION}"></script>
</body>
</html>`;
};
