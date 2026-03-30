import {
  badge,
  displayLabel,
  esc,
  formatTs,
  iconNext,
  iconRun,
  iconStatus,
  iconTokens,
  iconForEntity,
  iconChat,
  iconProject,
  iconQueue,
  iconBadgeToneClass,
  renderEmptyState,
  renderJobActionCards,
  sectionLabelClass,
  shortHash,
  softPanelClass,
  statusDot,
  toneForValue,
  missionControlHotkeyClass,
  missionControlInsetClass,
  missionControlMonoClass,
  missionControlPanelClass,
  missionControlSectionLabelClass,
} from "../../ui";
import { renderFactoryRunSteps } from "../../factory-live-steps";
import type {
  FactoryChatItem,
  FactoryChatIslandModel,
  FactoryChatObjectiveNav,
  FactoryLiveCodexCard,
  FactorySelectedObjectiveCard,
  FactoryViewMode,
  FactoryWorkCard,
} from "../../factory-models";
import {
  compactStatusText,
  factoryChatQuery,
  isMissionControlMode,
  factoryShellIslandBindings,
  factoryEventsPath,
  shellHeaderTitle,
  shellPill,
  shellProfileSummary,
  modeSwitchHref,
  workbenchHref,
  composerJobId,
  composerShellClass,
  composerTextareaClass,
  composerPanelClass,
  composerCommandsJson,
  renderHeaderProfileSelect,
  renderShellStatusPills,
  type FactoryChatRouteContext,
} from "../shared";
import {
  renderFactoryStreamingShell,
  renderFactoryTranscriptSection,
  renderTranscriptContent,
  renderMissionControlTranscriptSection,
} from "../transcript";
import { factorySidebarIsland } from "../sidebar";

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
    readonly tone?: "neutral" | "info" | "success" | "warning" | "danger";
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
  const statusTone = blockedTask || thread?.blockedReason ? "warning" : "neutral";
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
                <span class="flex h-5 w-5 shrink-0 items-center justify-center border border-border bg-background text-[10px] font-semibold text-muted-foreground">${index + 1}</span>
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
      ${thread.lifecycleSteps.map((step) => `<div class="border px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${step.state === "done"
        ? "border-success/20 bg-success/10 text-success"
        : step.state === "current"
          ? "border-primary/20 bg-primary/10 text-primary"
          : step.state === "paused"
            ? "border-warning/20 bg-warning/10 text-warning"
            : "border-border bg-background text-muted-foreground"}">${esc(step.label)}</div>`).join("")}
    </div>` : ""}
    ${thread.evidenceStats?.length ? `<div class="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      ${thread.evidenceStats.slice(0, 4).map((stat) => `<div class="border border-border bg-background px-3 py-2">
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
                <span class="flex h-5 w-5 shrink-0 items-center justify-center border border-border/80 bg-background/80 text-[10px] font-semibold text-muted-foreground">${index + 1}</span>
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

const renderMissionControlChatIsland = (model: FactoryChatIslandModel): string => {
  const routeContext = {
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
  const transcriptContent = renderTranscriptContent(model);
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
    ${renderMissionControlTranscriptSection(model, transcriptContent.body, transcriptContent.count)}
  </div>`;
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

export const factoryChatIsland = (model: FactoryChatIslandModel): string => {
  if (isMissionControlMode(model.mode)) return renderMissionControlChatIsland(model);
  const workbench = renderCenterWorkbench(model);
  return `<div class="chat-stack mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pb-4 pt-4 md:px-8 xl:px-10" data-active-profile="${esc(model.activeProfileId)}" data-active-profile-label="${esc(model.activeProfileLabel)}" data-active-profile-summary="${esc(model.activeProfileSummary ?? "")}" data-chat-id="${esc(model.chatId ?? "")}" data-objective-id="${esc(model.objectiveId ?? "")}" data-active-run-id="${esc(model.runId ?? "")}" data-known-run-ids="${esc((model.knownRunIds ?? []).join(","))}" data-terminal-run-ids="${esc((model.terminalRunIds ?? []).join(","))}">
    ${workbench}
    ${renderFactoryTranscriptSection(model)}
  </div>`;
};
