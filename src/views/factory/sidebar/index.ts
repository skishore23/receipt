import {
  badge,
  displayLabel,
  esc,
  formatTs,
  iconCheckCircle,
  iconChat,
  iconClock,
  iconCommit,
  iconNext,
  iconProject,
  iconPullRequest,
  iconReceipt,
  iconStatus,
  iconTask,
  iconTokens,
  iconBadgeToneClass,
  renderEmptyState,
  sectionLabelClass,
  shortHash,
  statusDot,
  toneForValue,
  missionControlPanelClass,
  missionControlInsetClass,
  missionControlSectionLabelClass,
  missionControlMonoClass,
} from "../../ui";
import type {
  FactoryChatObjectiveNav,
  FactoryNavModel,
  FactorySelectedObjectiveCard,
  FactoryViewMode,
} from "../../factory-models";
import {
  compactStatusText,
  factoryChatQuery,
  isMissionControlMode,
  titleCaseLabel,
  withQueryParam,
} from "../shared";

const renderObjectiveTokenCallout = (tokensUsed: number): string => `<div class="mt-2 border border-info/20 bg-info/10 px-3 py-2.5">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-info">Token Usage</div>
      <div class="mt-1 text-lg font-semibold leading-none tracking-tight text-foreground">${esc(tokensUsed.toLocaleString())}</div>
    </div>
    <span class="flex h-8 w-8 shrink-0 items-center justify-center border border-info/20 bg-background/70 text-info">
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
  const tone = obj.blockedReason ? "warning" : obj.nextAction ? "info" : "neutral";
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
      <span class="flex h-8 w-8 shrink-0 items-center justify-center border ${iconBadgeToneClass(tone)}>
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
    chatId: model.chatId,
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

const isTerminalObjectiveStatusValue = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const objectiveSidebarStateValue = (objective: Pick<FactoryChatObjectiveNav, "phase" | "status" | "integrationStatus" | "slotState">): string | undefined =>
  objective.phase || objective.status || objective.integrationStatus || objective.slotState;

const isRunningSidebarObjective = (objective: FactoryChatObjectiveNav): boolean => {
  if (objective.blockedReason) return false;
  const state = objectiveSidebarStateValue(objective);
  if (!state) return true;
  if (isTerminalObjectiveStatusValue(state)) return false;
  return state !== "blocked" && state !== "conflicted";
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
        class="inline-flex items-center gap-2 px-1 py-0.5 text-base font-semibold tracking-[-0.01em] text-foreground transition hover:text-primary md:text-[1.05rem]"
        href="/receipt"
        aria-label="Receipt home"
        title="Receipt home"
      >
        <span aria-hidden="true" class="flex h-6 w-6 shrink-0 items-center justify-center border border-border/70 bg-background/80 text-primary shadow-sm md:h-7 md:w-7">
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
