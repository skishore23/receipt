import {
  badge,
  CSS_VERSION,
  dangerButtonClass,
  displayLabel,
  esc,
  formatTs,
  ghostButtonClass,
  iconCheckCircle,
  iconFactory,
  iconSpark,
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
import { renderMarkdown } from "../shared/markdown";
import { displayStateTone } from "../supervision";
import { COMPOSER_COMMANDS } from "../../../factory-cli/composer";
import { DEFAULT_FACTORY_WORKBENCH_FILTER } from "../../factory-models";
import {
  buildFactoryWorkbenchRouteKey,
  buildFactoryWorkbenchSearch,
  buildFactoryWorkbenchSearchParams,
} from "./route";
import type {
  FactoryChatIslandModel,
  FactorySelectedObjectiveCard,
  FactoryWorkbenchActivitySectionModel,
  FactoryWorkbenchBlockModel,
  FactoryWorkbenchDetailTab,
  FactoryWorkbenchObjectiveListSectionModel,
  FactoryWorkbenchPageModel,
  FactoryWorkbenchSectionModel,
  FactoryWorkbenchWorkspaceModel,
} from "../../factory-models";
import type {
  FactoryWorkbenchHeaderIslandModel,
  FactoryWorkbenchRouteContext,
} from "./page";

const composerCommandsJson = (): string => JSON.stringify(COMPOSER_COMMANDS.map((command) => ({
  name: command.name,
  label: command.label,
  usage: command.usage,
  description: command.description,
  aliases: command.aliases ?? [],
})));

const routeBase = (input: Pick<FactoryWorkbenchRouteContext, "shellBase">): string => input.shellBase;

const chatEventsPath = (input: Pick<FactoryWorkbenchRouteContext, "shellBase" | "profileId" | "chatId" | "objectiveId" | "focusKind" | "focusId">): string => {
  const params = buildFactoryWorkbenchSearchParams({
    profileId: input.profileId,
    chatId: input.chatId,
    objectiveId: input.objectiveId,
    filter: DEFAULT_FACTORY_WORKBENCH_FILTER,
  });
  if (input.focusKind === "job" && input.focusId) params.set("job", input.focusId);
  const query = params.toString();
  return `${routeBase(input)}/chat/events${query ? `?${query}` : ""}`;
};

const backgroundEventsPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/background/events${buildFactoryWorkbenchSearch(input)}`;

const workbenchBackgroundRootPath = (input: FactoryWorkbenchRouteContext): string =>
  `${routeBase(input)}/island/workbench/background-root${buildFactoryWorkbenchSearch(input)}`;

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

const workbenchBackgroundRefreshOn = [
  { event: "profile-board-refresh", throttleMs: 320 },
  { event: "objective-runtime-refresh", throttleMs: 320 },
] as const;

const titleCaseLabel = (value?: string): string => {
  const label = displayLabel(value);
  if (!label) return "";
  return label
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

const tooltipAttr = (value?: string): string => {
  const trimmed = value?.trim();
  return trimmed ? ` title="${esc(trimmed)}"` : "";
};

const objectiveStateLabel = (objective?: Pick<FactorySelectedObjectiveCard, "displayState" | "phase" | "status">): string =>
  objective?.displayState ?? (titleCaseLabel(objective?.phase || objective?.status) || "Idle");

const profileSelectClass = "min-h-[2.4rem] rounded-xl border border-white/8 bg-white/[0.04] px-3 py-2 text-sm font-medium text-foreground outline-none transition focus:border-primary/35 focus-visible:ring-2 focus-visible:ring-ring/20";

const renderProfileSelect = (input: {
  readonly profiles: FactoryWorkbenchHeaderIslandModel["profiles"];
}): string => {
  if (input.profiles.length === 0) return "";
  return `<label class="flex min-w-[11rem] items-center gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
    <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Engineer</span>
    <select id="factory-workbench-profile-select" data-factory-profile-select="true" class="${profileSelectClass} min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[13px] font-semibold focus-visible:ring-0">
      ${input.profiles.map((profile) => `<option value="${esc(profile.href)}"${profile.selected ? " selected" : ""}>${esc(profile.label)}</option>`).join("")}
    </select>
  </label>`;
};

const routeHref = (
  input: FactoryWorkbenchRouteContext,
  overrides: Partial<FactoryWorkbenchRouteContext>,
): string => buildFactoryWorkbenchRouteKey({
  ...input,
  ...overrides,
  basePath: input.shellBase,
});

const objectiveHref = (
  input: FactoryWorkbenchRouteContext,
  objectiveId?: string,
  profileId?: string,
): string => buildFactoryWorkbenchRouteKey({
  ...input,
  profileId: profileId ?? input.profileId,
  objectiveId,
  inspectorTab: objectiveId ? "chat" : input.inspectorTab,
  basePath: input.shellBase,
});

const commandHref = (location: string, command: string): string => {
  const url = new URL(location, "http://receipt.local");
  url.searchParams.set("compose", command);
  url.hash = "factory-workbench-composer-shell";
  return `${url.pathname}${url.search}${url.hash}`;
};

const workbenchComposerPlaceholder = (selectedObjective?: Pick<FactorySelectedObjectiveCard, "status">, objectiveId?: string): string => {
  if (!objectiveId && !selectedObjective) return "Ask Factory anything, or use /obj to create an objective.";
  if (selectedObjective?.status === "blocked") return "Use /react <guidance> to unblock this objective, or plain text to stay in chat.";
  if (selectedObjective?.status === "completed" || selectedObjective?.status === "failed" || selectedObjective?.status === "canceled") {
    return "Use /obj to start follow-up work, or ask for the next step.";
  }
  return "Continue the objective, ask for a summary, or use /react to steer it.";
};

const workbenchComposerHelper = (selectedObjective?: Pick<FactorySelectedObjectiveCard, "status">, objectiveId?: string): string => {
  if (!objectiveId && !selectedObjective) return "Plain text stays chat-first. Slash commands can create or route work.";
  if (selectedObjective?.status === "blocked") return "Blocked objective. Use /react to continue it, /cancel to stop it, or plain text to inspect.";
  return "Live updates stay visible while you keep chatting.";
};

const renderComposerPrefillButton = (
  label: string,
  command: string,
  className: string,
): string => `<button type="button" data-factory-command="${esc(command)}" class="${className} !rounded-full !px-3 !py-1.5 !text-[11px]">${esc(label)}</button>`;

const renderComposerActions = (
  selectedObjective?: Pick<FactorySelectedObjectiveCard, "status">,
  objectiveId?: string,
): string => {
  if (!objectiveId && !selectedObjective) return "";
  const actions = [
    renderComposerPrefillButton("React", "/react ", ghostButtonClass),
    renderComposerPrefillButton("New Objective", "/obj ", ghostButtonClass),
  ];
  if (selectedObjective) {
    actions.push(selectedObjective.status === "completed" || selectedObjective.status === "failed" || selectedObjective.status === "canceled"
      ? renderComposerPrefillButton("Archive", "/archive ", ghostButtonClass)
      : renderComposerPrefillButton("Cancel", "/cancel ", dangerButtonClass));
  }
  return `<div class="flex flex-wrap items-center gap-2">${actions.join("")}</div>`;
};

const sectionByShape = <T extends FactoryWorkbenchSectionModel["shape"]>(
  workspace: FactoryWorkbenchWorkspaceModel,
  shape: T,
): Extract<FactoryWorkbenchSectionModel, { readonly shape: T }> | undefined => {
  for (const block of workspace.blocks) {
    for (const section of block.sections) {
      if (section.shape === shape) return section as Extract<FactoryWorkbenchSectionModel, { readonly shape: T }>;
    }
  }
  return undefined;
};

const objectiveSections = (
  workspace: FactoryWorkbenchWorkspaceModel,
): ReadonlyArray<FactoryWorkbenchObjectiveListSectionModel> => workspace.blocks.flatMap((block) =>
  block.sections.filter((section): section is FactoryWorkbenchObjectiveListSectionModel => section.shape === "objective-list"));

const renderLinearHeader = (
  model: FactoryWorkbenchHeaderIslandModel,
): string => {
  const objective = model.workspace.selectedObjective;
  const status = objectiveStateLabel(objective);
  const subline = objective
    ? truncate(objective.summary ?? objective.blockedReason ?? "Selected objective context stays on the right while chat remains in the center.", 90)
    : truncate(model.currentRole ?? model.currentPresence ?? "Chat-first orchestration across the active Factory queue.", 90);
  return `<header id="factory-workbench-header" class="order-1 col-span-full flex min-w-0 items-center justify-between gap-4 border-b border-white/6 pb-3 pt-1">
    <div class="min-w-0 flex items-center gap-3">
      <span class="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-primary">
        ${iconFactory("h-5 w-5")}
      </span>
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Receipt Factory</span>
          ${objective ? badge(status, displayStateTone(status)) : `<span class="rounded-full border border-white/8 bg-white/[0.03] px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Live</span>`}
        </div>
        <div class="mt-1 min-w-0 truncate text-lg font-semibold text-foreground"${tooltipAttr(objective?.title ?? subline)}>${esc(objective?.title ?? "Ask Factory")}</div>
        <div class="mt-1 max-w-[70ch] truncate text-[12px] text-muted-foreground"${tooltipAttr(subline)}>${esc(subline)}</div>
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-3">
      ${renderProfileSelect({ profiles: model.profiles })}
    </div>
  </header>`;
};

const renderFilterPill = (
  routeContext: FactoryWorkbenchRouteContext,
  filter: FactoryWorkbenchWorkspaceModel["filters"][number],
): string => {
  const href = routeHref(routeContext, { filter: filter.key, page: 1 });
  return `<a href="${esc(href)}" ${htmxNavAttrs(workbenchBackgroundRootPath({
    ...routeContext,
    filter: filter.key,
    page: 1,
  }), "#factory-workbench-background-root")} ${filter.selected ? 'aria-current="page"' : ""} class="inline-flex items-center rounded-full px-3 py-1.5 text-[11px] font-medium transition ${filter.selected
    ? "bg-white/10 text-foreground"
    : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"}">${esc(filter.label)} <span class="ml-1 text-muted-foreground">${esc(String(filter.count))}</span></a>`;
};

const renderObjectiveCard = (
  routeContext: FactoryWorkbenchRouteContext,
  objective: FactoryWorkbenchObjectiveListSectionModel["items"][number],
): string => {
  const href = objectiveHref(routeContext, objective.objectiveId, objective.profileId);
  const selectRoute: FactoryWorkbenchRouteContext = {
    ...routeContext,
    profileId: objective.profileId ?? routeContext.profileId,
    objectiveId: objective.objectiveId,
    inspectorTab: "chat",
  };
  const selected = objective.selected;
  const stateTone = toneForValue(objective.displayState ?? objective.phase ?? objective.status);
  const summary = truncate(objective.summary ?? objective.blockedReason ?? "Objective activity will appear here.", 110);
  return `<a href="${esc(href)}" ${htmxNavAttrs(workbenchSelectionPath(selectRoute), "#factory-workbench-background-root")} data-objective-id="${esc(objective.objectiveId)}" ${selected ? 'aria-current="page"' : ""} class="group block rounded-2xl px-3 py-3 transition ${selected ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}">
    <div class="flex items-start gap-3">
      <div class="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03]">${statusDot(stateTone)}</div>
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate text-[13px] font-semibold text-foreground"${tooltipAttr(objective.title)}>${esc(truncate(objective.title, 46))}</div>
            <div class="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">${esc(summary)}</div>
          </div>
          ${selected ? `<span class="inline-flex items-center gap-1 rounded-full bg-primary/12 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">${iconCheckCircle("h-3.5 w-3.5")} Open</span>` : ""}
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span>${esc(objectiveStateLabel(objective))}</span>
          ${objective.updatedAt ? `<span>${esc(formatTs(objective.updatedAt))}</span>` : ""}
          ${typeof objective.taskCount === "number" ? `<span>${esc(`${objective.activeTaskCount ?? 0}/${objective.taskCount} tasks`)}</span>` : ""}
        </div>
      </div>
    </div>
  </a>`;
};

const renderObjectiveSection = (
  section: FactoryWorkbenchObjectiveListSectionModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `<section class="border-t border-white/6 pt-4 first:border-t-0 first:pt-0">
  <div class="mb-2 flex items-center justify-between gap-2 px-1">
    <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(section.title)}</div>
    <div class="text-[11px] text-muted-foreground">${esc(String(section.count))}</div>
  </div>
  <div class="space-y-1">
    ${section.items.length > 0
      ? section.items.map((objective) => renderObjectiveCard(routeContext, objective)).join("")
      : `<div class="rounded-2xl bg-white/[0.03] px-3 py-3 text-sm text-muted-foreground">${esc(section.emptyMessage)}</div>`}
  </div>
</section>`;

const renderLinearRail = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `<aside id="factory-workbench-rail-shell" class="order-3 min-h-0 min-w-0 overflow-hidden rounded-[26px] border border-white/8 bg-white/[0.025] backdrop-blur-sm lg:col-start-1 lg:row-start-2" ${passiveRefreshAttrs(workbenchRailPath(routeContext))}>
  <div class="border-b border-white/6 px-4 py-4">
    <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Queue</div>
    <div class="mt-1 text-sm text-muted-foreground">Profile board and objective selection.</div>
    <div class="mt-3 flex flex-wrap items-center gap-2">
      ${workspace.filters.map((filter) => renderFilterPill(routeContext, filter)).join("")}
    </div>
  </div>
  <div id="factory-workbench-rail-scroll" data-preserve-scroll-key="rail" class="factory-scrollbar min-h-0 max-h-[70vh] overflow-x-hidden overflow-y-auto px-4 py-4 lg:h-full lg:max-h-none">
    <div class="space-y-5">
      ${objectiveSections(workspace).map((section) => renderObjectiveSection(section, routeContext)).join("")}
    </div>
  </div>
</aside>`;

const renderStatChip = (label: string, value: string): string => `<div class="rounded-2xl bg-white/[0.04] px-3 py-3">
  <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">${esc(label)}</div>
  <div class="mt-1 text-sm font-semibold text-foreground">${esc(value)}</div>
</div>`;

const renderObjectiveDetailPanel = (
  objective: FactorySelectedObjectiveCard,
): string => {
  const primary = objective.bottomLine ?? objective.summary ?? objective.latestDecisionSummary ?? "No captured outcome yet.";
  const next = objective.nextAction ?? objective.primaryAction?.label ?? "Ask chat for the next step.";
  const metrics = [
    objective.profileLabel ? ["Owner", objective.profileLabel] : undefined,
    typeof objective.updatedAt === "number" ? ["Updated", formatTs(objective.updatedAt)] : undefined,
    typeof objective.taskCount === "number" ? ["Tasks", `${objective.activeTaskCount ?? 0}/${objective.taskCount}`] : undefined,
  ].filter((entry): entry is [string, string] => Boolean(entry));
  return `<section class="space-y-4">
    <div>
      <div class="flex flex-wrap items-center gap-2">
        ${badge(objectiveStateLabel(objective), displayStateTone(objectiveStateLabel(objective)))}
        ${objective.phaseDetail ? `<span class="rounded-full bg-white/[0.05] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">${esc(displayLabel(objective.phaseDetail) ?? objective.phaseDetail)}</span>` : ""}
      </div>
      <div class="mt-3 text-[18px] font-semibold leading-7 text-foreground">${esc(objective.title)}</div>
      <div class="mt-3 rounded-[24px] bg-white/[0.04] px-4 py-4">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Latest Outcome</div>
        <div class="mt-2 factory-markdown text-sm leading-6 text-foreground">${renderMarkdown(primary)}</div>
      </div>
      <div class="mt-3 rounded-[24px] bg-white/[0.03] px-4 py-4">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Next Operator Action</div>
        <div class="mt-2 text-sm leading-6 text-foreground">${esc(next)}</div>
      </div>
    </div>
    ${metrics.length > 0 ? `<div class="grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
      ${metrics.map(([label, value]) => renderStatChip(label, value)).join("")}
    </div>` : ""}
    ${objective.renderedBody?.trim() ? `<div class="rounded-[24px] bg-white/[0.03] px-4 py-4">
      <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Returned Output</div>
      <div class="mt-3 factory-markdown text-sm leading-6 text-foreground">${renderMarkdown(objective.renderedBody)}</div>
    </div>` : ""}
  </section>`;
};

const renderActivityPanel = (
  activity: FactoryWorkbenchActivitySectionModel | undefined,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  if (!activity) return `<div class="rounded-[24px] bg-white/[0.03] px-4 py-4 text-sm text-muted-foreground">Execution activity will appear here when an objective is active.</div>`;
  return `<section class="space-y-4">
    ${activity.focus ? `<div class="rounded-[24px] bg-white/[0.04] px-4 py-4">
      <div class="flex items-center justify-between gap-3">
        <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Current Execution</div>
        ${badge(titleCaseLabel(activity.focus.status), toneForValue(activity.focus.status))}
      </div>
      <div class="mt-2 text-sm font-semibold text-foreground">${esc(activity.focus.title)}</div>
      <div class="mt-1 text-sm leading-6 text-muted-foreground">${esc(truncate(activity.focus.summary, 160))}</div>
    </div>` : ""}
    ${activity.run ? `<div class="[&>section]:border-0 [&>section]:bg-transparent [&>section]:px-0 [&>section]:py-0">${renderFactoryRunSteps(activity.run, {
      title: "Supervisor Steps",
      subtitle: "Recent orchestration and worker progress.",
    })}</div>` : ""}
    ${activity.items.length > 0 ? `<div class="space-y-3">
      ${activity.items.slice(0, 8).map((item) => `<div class="border-t border-white/6 pt-3 first:border-t-0 first:pt-0">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-foreground">${esc(item.title)}</div>
            <div class="mt-1 text-sm leading-6 text-muted-foreground">${esc(item.summary)}</div>
          </div>
          ${item.at ? `<div class="shrink-0 text-[11px] text-muted-foreground">${esc(formatTs(item.at))}</div>` : ""}
        </div>
        ${item.meta ? `<div class="mt-2 text-[12px] text-muted-foreground">${esc(item.meta)}</div>` : ""}
      </div>`).join("")}
    </div>` : ""}
    ${activity.focus?.status === "running" || activity.focus?.status === "stalled" ? `<div class="flex flex-wrap gap-2">
      <a href="${esc(commandHref(routeHref(routeContext, { inspectorTab: "chat" }), "/react "))}" data-factory-command="/react " data-factory-focus-href="${esc(routeHref(routeContext, { inspectorTab: "chat" }))}" class="${ghostButtonClass} !rounded-full !px-3 !py-1.5 !text-[12px]">Continue</a>
      <a href="${esc(commandHref(routeHref(routeContext, { inspectorTab: "chat" }), "/abort-job "))}" data-factory-command="/abort-job " data-factory-focus-href="${esc(routeHref(routeContext, { inspectorTab: "chat" }))}" class="${dangerButtonClass} !rounded-full !px-3 !py-1.5 !text-[12px]">Abort Job</a>
    </div>` : ""}
  </section>`;
};

const renderProfilePanel = (
  model: FactoryChatIslandModel,
): string => {
  const summaries = [
    model.activeProfilePrimaryRole,
    model.activeProfileSummary,
    model.activeProfileSoulSummary,
  ].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
  const responsibilities = (model.activeProfileResponsibilities ?? []).slice(0, 4);
  const tools = (model.activeProfileTools ?? []).slice(0, 6);
  return `<section class="space-y-4">
    <div>
      <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        ${iconWorker("h-3.5 w-3.5")}
        <span>${esc(model.activeProfileLabel)}</span>
      </div>
      ${summaries.length > 0 ? `<div class="mt-3 space-y-2">
        ${summaries.map((summary) => `<div class="rounded-[20px] bg-white/[0.04] px-4 py-3 text-sm leading-6 text-foreground">${esc(summary)}</div>`).join("")}
      </div>` : ""}
    </div>
    ${responsibilities.length > 0 ? `<div>
      <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Responsibilities</div>
      <div class="mt-3 space-y-2">
        ${responsibilities.map((item) => `<div class="rounded-[18px] bg-white/[0.03] px-4 py-3 text-sm leading-6 text-muted-foreground">${esc(item)}</div>`).join("")}
      </div>
    </div>` : ""}
    ${tools.length > 0 ? `<div>
      <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Tool Access</div>
      <div class="mt-3 flex flex-wrap gap-2">
        ${tools.map((tool) => `<span class="rounded-full bg-white/[0.05] px-3 py-1.5 text-[11px] text-muted-foreground">${esc(tool)}</span>`).join("")}
      </div>
    </div>` : ""}
  </section>`;
};

const renderDetailTabs = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const renderTab = (tab: FactoryWorkbenchDetailTab, label: string) => {
    const active = workspace.detailTab === tab;
    return `<a href="${esc(routeHref(routeContext, { detailTab: tab }))}" ${htmxNavAttrs(workbenchFocusPath({
      ...routeContext,
      detailTab: tab,
    }), "#factory-workbench-focus-shell")} ${active ? 'aria-current="page"' : ""} class="inline-flex items-center rounded-full px-3 py-1.5 text-[11px] font-medium transition ${active
      ? "bg-white/10 text-foreground"
      : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"}">${esc(label)}</a>`;
  };
  return `<div class="flex items-center gap-2">
    ${renderTab("action", "Objective")}
    ${renderTab("review", "Execution")}
  </div>`;
};

const renderLinearFocus = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const summary = sectionByShape(workspace, "summary");
  const activity = sectionByShape(workspace, "activity-list");
  const body = workspace.detailTab === "review"
    ? renderActivityPanel(activity, routeContext)
    : workspace.selectedObjective
      ? renderObjectiveDetailPanel(workspace.selectedObjective)
      : `<div class="rounded-[24px] bg-white/[0.03] px-4 py-4">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Context</div>
        <div class="mt-2 text-sm font-semibold text-foreground">${esc(workspace.activeProfileLabel)}</div>
        <div class="mt-2 text-sm leading-6 text-muted-foreground">Select an objective from the queue or keep chatting in the center column while Factory updates live around it.</div>
      </div>`;
  return `<aside id="factory-workbench-focus-shell" class="order-4 min-h-0 min-w-0 overflow-hidden rounded-[26px] border border-white/8 bg-white/[0.025] backdrop-blur-sm lg:col-start-3 lg:row-start-2" ${passiveRefreshAttrs(workbenchFocusPath(routeContext))}>
    <div class="border-b border-white/6 px-4 py-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(workspace.selectedObjective ? "Selected Objective" : "Context")}</div>
          <div class="mt-1 text-sm text-muted-foreground">${esc(workspace.selectedObjective ? "Operational brief and execution detail." : "Active engineer profile and live context.")}</div>
        </div>
        ${renderDetailTabs(workspace, routeContext)}
      </div>
    </div>
    <div id="factory-workbench-focus-scroll" data-preserve-scroll-key="focus" class="factory-scrollbar min-h-0 max-h-[70vh] overflow-x-hidden overflow-y-auto px-4 py-4 lg:h-full lg:max-h-none">
      <div class="space-y-5">
        ${body}
        ${summary?.focus?.status && workspace.detailTab !== "review" ? `<div class="rounded-[24px] bg-white/[0.03] px-4 py-4">
          <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Live Run</div>
          <div class="mt-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            ${statusDot(toneForValue(summary.focus.status))}
            <span>${esc(summary.focus.title)}</span>
          </div>
          <div class="mt-2 text-sm leading-6 text-muted-foreground">${esc(summary.focus.summary)}</div>
        </div>` : ""}
      </div>
    </div>
  </aside>`;
};

const renderOverviewCenter = (
  chat: FactoryChatIslandModel,
): string => {
  const objective = chat.selectedThread;
  return `<div class="mx-auto w-full max-w-[720px] space-y-6 px-2 py-8 lg:px-0">
    ${objective ? renderObjectiveDetailPanel(objective) : renderProfilePanel(chat)}
  </div>`;
};

export const factoryWorkbenchLinearChatIsland = (
  chat: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const transcriptState = describeTranscriptState(chat);
  const content = routeContext.inspectorTab === "overview"
    ? renderOverviewCenter(chat)
    : `<div class="mx-auto w-full max-w-[720px] px-2 py-6 lg:px-0">
      ${chat.items.length === 0 ? `<section class="mb-6 rounded-[28px] border border-white/8 bg-white/[0.035] px-6 py-6">
        <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${iconSpark("h-3.5 w-3.5")} Ask Factory</div>
        <div class="mt-3 text-[22px] font-semibold tracking-tight text-foreground">${esc(chat.selectedThread ? "Continue the objective in chat." : "Chat stays at the center.")}</div>
        <div class="mt-2 max-w-[58ch] text-sm leading-6 text-muted-foreground">${esc(chat.selectedThread
          ? "The queue and objective telemetry stay visible on the sides while the active conversation remains focused here."
          : "Use plain language, or use slash commands like /obj and /react. Background runs keep updating while the conversation remains open.")}</div>
      </section>` : ""}
      ${renderFactoryTranscriptSection(chat, {
        sectionLabel: chat.selectedThread ? "Objective Chat" : "Conversation",
        objectiveHref: (objectiveId) => objectiveHref(routeContext, objectiveId),
        emptyState: {
          title: "Start a new chat.",
          message: "Ask Factory a question, or use /obj to create an objective directly.",
          detail: "When work is handed off, progress stays live in the surrounding columns.",
        },
      })}
    </div>`;
  return `<div class="flex min-h-0 flex-col" data-active-profile="${esc(chat.activeProfileId)}" data-active-profile-label="${esc(chat.activeProfileLabel)}" data-chat-id="${esc(chat.chatId ?? "")}" data-objective-id="${esc(chat.objectiveId ?? "")}" data-active-run-id="${esc(chat.runId ?? "")}" data-known-run-ids="${esc((chat.knownRunIds ?? []).join(","))}" data-terminal-run-ids="${esc((chat.terminalRunIds ?? []).join(","))}" data-transcript-signature="${esc(transcriptState.signature)}" data-last-item-kind="${esc(transcriptState.lastItemKind ?? "")}">
    ${content}
  </div>`;
};

const renderChatModeToggle = (
  routeContext: FactoryWorkbenchRouteContext,
  tab: "overview" | "chat",
  label: string,
): string => {
  const active = (routeContext.inspectorTab ?? "overview") === tab;
  return `<a href="${esc(routeHref(routeContext, { inspectorTab: tab }))}" ${htmxNavAttrs(workbenchChatShellPath({
    ...routeContext,
    inspectorTab: tab,
  }), "#factory-workbench-chat-region")} ${active ? 'aria-current="page"' : ""} class="inline-flex items-center rounded-full px-3 py-1.5 text-[11px] font-medium transition ${active
    ? "bg-white/10 text-foreground"
    : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"}">${esc(label)}</a>`;
};

const renderLinearChatHeader = (
  workspace: FactoryWorkbenchWorkspaceModel,
  chat: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => {
  const title = workspace.selectedObjective?.title ?? chat.activeProfileLabel;
  const state = workspace.selectedObjective ? objectiveStateLabel(workspace.selectedObjective) : "Open";
  const newChatParams = new URLSearchParams();
  newChatParams.set("profile", routeContext.profileId);
  newChatParams.set("inspectorTab", "chat");
  if (routeContext.detailTab) newChatParams.set("detailTab", routeContext.detailTab);
  newChatParams.set("filter", routeContext.filter);
  const newChatHref = `${routeContext.shellBase}/new-chat?${newChatParams.toString()}`;
  return `<div id="factory-workbench-chat-header" class="border-b border-white/6 px-6 py-4">
    <div class="mx-auto flex w-full max-w-[720px] items-center justify-between gap-4">
      <div class="min-w-0">
        <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(workspace.selectedObjective ? "Selected objective" : "Active conversation")}</div>
        <div class="mt-1 flex items-center gap-2">
          <div class="truncate text-lg font-semibold text-foreground"${tooltipAttr(title)}>${esc(truncate(title, 56))}</div>
          <span class="rounded-full bg-white/[0.05] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">${esc(state)}</span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        ${renderChatModeToggle(routeContext, "chat", "Conversation")}
        ${renderChatModeToggle(routeContext, "overview", "Brief")}
        <a href="${esc(newChatHref)}" class="inline-flex items-center rounded-full border border-white/8 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground">New Chat</a>
      </div>
    </div>
  </div>`;
};

export const factoryWorkbenchLinearChatBody = (
  chat: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `<div id="factory-workbench-chat-body" class="flex min-h-0 flex-1 flex-col lg:min-h-0" ${liveIslandAttrs({
  path: workbenchChatBodyPath(routeContext),
  refreshOn: workbenchChatRefreshOn(routeContext),
  swap: "outerHTML",
  clientOnly: true,
})}>
  <div id="factory-workbench-chat-root" data-events-path="${esc(chatEventsPath(routeContext))}" class="flex flex-1 flex-col lg:min-h-0">
    <section id="factory-workbench-chat-scroll" class="factory-scrollbar flex-1 overflow-x-hidden overflow-y-auto px-4 lg:min-h-0">
      <div id="factory-workbench-chat" ${passiveRefreshAttrs(`${routeBase(routeContext)}/island/chat${buildFactoryWorkbenchSearch(routeContext)}`)}>
        ${factoryWorkbenchLinearChatIsland(chat, routeContext)}
      </div>
      <div class="mx-auto w-full max-w-[720px] px-2 pb-6 lg:px-0">
        <div id="factory-chat-ephemeral" class="mt-4 space-y-3" aria-live="polite"></div>
      </div>
    </section>
  </div>
</div>`;

export const factoryWorkbenchLinearChatShell = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `<div id="factory-workbench-chat-shell" class="factory-workbench-chat-shell shrink-0 border-t border-white/6 px-4 py-4">
  <div id="factory-workbench-composer-shell" class="mx-auto w-full max-w-[720px]">
    <form id="factory-composer" action="${esc(`${routeContext.shellBase}/compose${buildFactoryWorkbenchSearch(routeContext)}`)}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
      <input id="factory-composer-current-job" type="hidden" name="currentJobId" value="" />
      <div class="rounded-[28px] border border-white/10 bg-white/[0.045] px-4 py-4 shadow-[0_20px_80px_rgba(0,0,0,0.28)] backdrop-blur-md">
        <div class="space-y-3">
          ${renderComposerActions(workspace.selectedObjective, routeContext.objectiveId)}
          <div class="relative">
            <textarea id="factory-prompt" name="prompt" class="min-h-[124px] w-full resize-none border-0 bg-transparent px-1 py-1 text-[15px] leading-7 text-foreground outline-none placeholder:text-muted-foreground" rows="3" placeholder="${esc(workbenchComposerPlaceholder(workspace.selectedObjective, routeContext.objectiveId))}" autofocus aria-autocomplete="list" aria-expanded="false" aria-controls="factory-composer-completions" aria-haspopup="listbox"></textarea>
            <div id="factory-composer-completions" class="mt-2 hidden max-h-56 overflow-auto rounded-2xl border border-white/10 bg-[#17181d] shadow-2xl" role="listbox" aria-label="Slash command suggestions"></div>
          </div>
          <div class="flex items-center justify-between gap-3">
            <div class="text-xs leading-5 text-muted-foreground">${esc(workbenchComposerHelper(workspace.selectedObjective, routeContext.objectiveId))}</div>
            <button id="factory-composer-submit" class="inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-muted-foreground" type="submit">Send</button>
          </div>
        </div>
        <div id="factory-composer-status" class="mt-3 hidden rounded-2xl bg-white/[0.05] px-3 py-2 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
      </div>
    </form>
  </div>
</div>`;

export const factoryWorkbenchLinearChatShellResponse = (
  workspace: FactoryWorkbenchWorkspaceModel,
  chat: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `<div id="factory-workbench-chat-region" class="flex min-w-0 flex-1 flex-col lg:min-h-0" ${passiveRefreshAttrs(workbenchChatShellPath(routeContext))}>
  ${renderLinearChatHeader(workspace, chat, routeContext)}
  ${factoryWorkbenchLinearChatBody(chat, routeContext)}
</div>`;

export const factoryWorkbenchLinearChatPaneIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  chat: FactoryChatIslandModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `<aside id="factory-workbench-chat-pane" class="order-2 min-h-0 min-w-0 overflow-hidden rounded-[30px] border border-white/8 bg-[#111217]/85 shadow-[0_30px_120px_rgba(0,0,0,0.32)] backdrop-blur-sm lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:flex lg:h-full lg:flex-col" ${passiveRefreshAttrs(workbenchChatPanePath(routeContext))}>
  ${factoryWorkbenchLinearChatShellResponse(workspace, chat, routeContext)}
  ${factoryWorkbenchLinearChatShell(workspace, routeContext)}
</aside>`;

export const factoryWorkbenchLinearWorkspaceIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => `${renderLinearRail(workspace, routeContext)}${renderLinearFocus(workspace, routeContext)}`;

export const factoryWorkbenchLinearFocusIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => renderLinearFocus(workspace, routeContext);

export const factoryWorkbenchLinearRailIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
): string => renderLinearRail(workspace, routeContext);

export const factoryWorkbenchLinearBlockIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  routeContext: FactoryWorkbenchRouteContext,
  blockKey: FactoryWorkbenchBlockModel["key"],
): string => {
  if (blockKey === "activity") return factoryWorkbenchLinearFocusIsland({ ...workspace, detailTab: "review" }, routeContext);
  if (blockKey === "summary") return factoryWorkbenchLinearFocusIsland({ ...workspace, detailTab: "action" }, routeContext);
  return factoryWorkbenchLinearRailIsland(workspace, routeContext);
};

export const factoryWorkbenchLinearBackgroundRootResponse = (input: {
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly routeContext: FactoryWorkbenchRouteContext;
}): string => `${renderLinearHeader(input.header)}
  ${factoryWorkbenchLinearWorkspaceIsland(input.workspace, input.routeContext)}`;

export const factoryWorkbenchLinearBackgroundRootIsland = (input: {
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly routeContext: FactoryWorkbenchRouteContext;
}): string => `<div id="factory-workbench-background-root" class="contents" data-events-path="${esc(backgroundEventsPath(input.routeContext))}" ${liveIslandAttrs({
  path: workbenchBackgroundRootPath(input.routeContext),
  refreshOn: workbenchBackgroundRefreshOn,
  clientOnly: true,
})}>
  ${factoryWorkbenchLinearBackgroundRootResponse(input)}
</div>`;

export const factoryWorkbenchLinearSelectionResponse = (input: {
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly chat: FactoryChatIslandModel;
  readonly routeContext: FactoryWorkbenchRouteContext;
}): string => [
  factoryWorkbenchLinearBackgroundRootIsland({
    header: input.header,
    workspace: input.workspace,
    routeContext: input.routeContext,
  }),
  withOuterHtmlOob("#factory-workbench-chat-pane", factoryWorkbenchLinearChatPaneIsland(
    input.workspace,
    input.chat,
    input.routeContext,
  )),
].join("");

export const factoryWorkbenchLinearShell = (
  model: FactoryWorkbenchPageModel,
  shellBase: "/factory" | "/factory-new" = "/factory-new",
): string => {
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
  const headerModel: FactoryWorkbenchHeaderIslandModel = {
    activeProfileId: model.activeProfileId,
    activeProfileLabel: model.activeProfileLabel,
    profiles: model.profiles,
    workspace: model.workspace,
  };
  return `<!doctype html>
<html class="dark h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Factory New</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
  <script src="/assets/htmx.min.js?v=${CSS_VERSION}"></script>
  <script src="/assets/htmx-ext-sse.js?v=${CSS_VERSION}"></script>
</head>
<body data-factory-workbench data-shell-base="${esc(shellBase)}" data-route-key="${esc(routeHref(routeContext, {}))}" data-profile-id="${esc(model.activeProfileId)}" data-chat-id="${esc(model.chatId)}" data-objective-id="${esc(model.objectiveId ?? "")}" data-inspector-tab="${esc(model.inspectorTab ?? "chat")}" data-detail-tab="${esc(model.detailTab)}" data-focus-kind="${esc(model.focusKind ?? "")}" data-focus-id="${esc(model.focusId ?? "")}" class="min-h-screen overflow-x-hidden bg-background font-sans text-foreground antialiased">
  <div class="factory-workbench-shell factory-workbench-linear-shell min-h-screen bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.08),_transparent_34%),linear-gradient(180deg,_rgba(255,255,255,0.02),_transparent_22%)]">
    <div class="mx-auto flex min-h-screen w-full max-w-[1680px] flex-col gap-4 px-4 pb-4 pt-4 lg:grid lg:grid-cols-[280px_minmax(0,760px)_320px] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-x-6 lg:gap-y-4 lg:px-6 lg:pb-6">
      ${factoryWorkbenchLinearBackgroundRootIsland({
        header: headerModel,
        workspace: model.workspace,
        routeContext,
      })}
      ${factoryWorkbenchLinearChatPaneIsland(model.workspace, model.chat, routeContext)}
    </div>
  </div>
  <script src="/assets/factory-client.js?v=${CSS_VERSION}"></script>
</body>
</html>`;
};
