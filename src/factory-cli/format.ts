import type {
  FactoryBoardProjection,
  FactoryComposeModel,
  FactoryDebugProjection,
  FactoryLiveProjection,
  FactoryObjectiveDetail,
} from "../services/factory-service";
import { buildInvestigationReportSections } from "./investigation-report";
import { BOARD_SECTION_META, type FactoryObjectivePanel, formatList, formatTime, shortHash, truncate } from "./view-model";

const section = (title: string, lines: ReadonlyArray<string>): string =>
  [`== ${title} ==`, ...lines].join("\n");

const objectiveStateSummary = (objective: {
  readonly displayState?: string;
  readonly phase?: string;
  readonly phaseDetail?: string;
  readonly statusAuthority?: string;
}): string => [
  objective.displayState ?? objective.phase,
  objective.phaseDetail,
  objective.statusAuthority ? `authority:${objective.statusAuthority}` : undefined,
].filter((value): value is string => Boolean(value)).join(" · ");

const renderObjectiveCard = (objective: FactoryBoardProjection["objectives"][number], selected: boolean): string => {
  const marker = selected ? ">" : " ";
  const blocked = objective.blockedExplanation?.summary ?? objective.blockedReason;
  const summary = truncate(objective.nextAction ?? objective.latestSummary ?? blocked ?? "No activity yet.", 96);
  return [
    `${marker} ${objective.title} [${objectiveStateSummary(objective) || `${objective.phase}/${objective.integrationStatus}`}]`,
    `  id=${objective.objectiveId} slot=${objective.scheduler.slotState}${objective.scheduler.queuePosition ? ` q=${objective.scheduler.queuePosition}` : ""} updated=${formatTime(objective.updatedAt)}`,
    `  mode=${objective.objectiveMode} severity=${objective.severity}`,
    `  tasks=${objective.taskCount} active=${objective.activeTaskCount} ready=${objective.readyTaskCount} head=${shortHash(objective.latestCommitHash)}`,
    blocked ? `  blocked=${truncate(blocked, 120)}` : `  next=${summary}`,
  ].join("\n");
};

export const renderBoardText = (opts: {
  readonly compose: FactoryComposeModel;
  readonly board: FactoryBoardProjection;
  readonly selected?: FactoryObjectiveDetail;
  readonly live?: FactoryLiveProjection;
}): string => {
  const selectedId = opts.board.selectedObjectiveId;
  const lines: string[] = [
    section("Repo", [
      `branch=${opts.compose.sourceBranch ?? opts.compose.defaultBranch}`,
      `dirty=${String(opts.compose.sourceDirty)}`,
      `objectives=${opts.compose.objectiveCount}`,
      `checks=${formatList(opts.compose.defaultValidationCommands)}`,
      `profile=${truncate(opts.compose.profileSummary, 180)}`,
    ]),
  ];

  for (const [key, meta] of Object.entries(BOARD_SECTION_META) as ReadonlyArray<[keyof FactoryBoardProjection["sections"], typeof BOARD_SECTION_META[keyof FactoryBoardProjection["sections"]]]>) {
    const entries = opts.board.sections[key];
    lines.push(section(meta.title, entries.length
      ? entries.map((objective) => renderObjectiveCard(objective, objective.objectiveId === selectedId))
      : ["(empty)"]));
  }

  if (opts.selected) {
    lines.push(section("Selected Objective", [
      `title=${opts.selected.title}`,
      `objective=${opts.selected.objectiveId}`,
      `state=${objectiveStateSummary(opts.selected) || opts.selected.phase} slot=${opts.selected.scheduler.slotState} integration=${opts.selected.integration.status}`,
      `mode=${opts.selected.objectiveMode} severity=${opts.selected.severity}`,
      `next=${truncate(opts.selected.nextAction, 180) || "none"}`,
      opts.selected.blockedExplanation ? `blocked=${truncate(opts.selected.blockedExplanation.summary, 180)}` : "blocked=none",
      opts.selected.latestDecision
        ? `decision=${truncate(opts.selected.latestDecision.summary, 180)} (${opts.selected.latestDecision.source})`
        : "decision=none",
    ]));
  }

  if (opts.live?.activeTasks.length) {
    lines.push(section("Live Tasks", opts.live.activeTasks.map((task) =>
      `${task.taskId} ${task.status}/${task.jobStatus ?? "n/a"} ${truncate(task.title, 80)} | ${truncate(task.lastMessage ?? task.stdoutTail ?? task.stderrTail, 120)}`,
    )));
  }

  return lines.join("\n\n");
};

export const renderObjectiveHeader = (detail: FactoryObjectiveDetail): ReadonlyArray<string> => [
  `objective=${detail.objectiveId}`,
  `title=${detail.title}`,
  `state=${objectiveStateSummary(detail) || detail.phase} slot=${detail.scheduler.slotState}${detail.scheduler.queuePosition ? ` q=${detail.scheduler.queuePosition}` : ""}`,
  `integration=${detail.integration.status}`,
  `mode=${detail.objectiveMode} severity=${detail.severity}`,
  `elapsed=${detail.budgetState.elapsedMinutes}m`,
  `task-runs=${detail.budgetState.taskRunsUsed}/${detail.policy.budgets.maxTaskRuns}`,
  `head=${shortHash(detail.latestCommitHash)}`,
  `next=${truncate(detail.nextAction, 180) || "none"}`,
];

export const renderObjectivePanelText = (
  detail: FactoryObjectiveDetail,
  live: FactoryLiveProjection,
  debug: FactoryDebugProjection,
  panel: FactoryObjectivePanel,
): string => {
  const activeTask = detail.tasks.find((task) => task.status === "running" || task.status === "reviewing");
  const nextTask = detail.tasks.find((task) =>
    task.taskId !== activeTask?.taskId && (task.status === "ready" || task.status === "pending"),
  );
  const blockedCount = detail.tasks.filter((task) => task.status === "blocked").length;
  switch (panel) {
    case "overview":
      return section("Overview", [
        ...renderObjectiveHeader(detail),
        `prompt=${truncate(detail.prompt, 240)}`,
        `checks=${formatList(detail.checks)}`,
        `policy=maxActiveTasks:${detail.policy.concurrency.maxActiveTasks} autoPromote:${String(detail.policy.promotion.autoPromote)}`,
      ]);
    case "report":
      return buildInvestigationReportSections(detail)
        .map((entry) => section(entry.title, entry.lines.map((line) => line.startsWith("- ") ? line : entry.title === "Conclusion" || entry.title === "Report" ? line : `- ${line}`)))
        .join("\n\n");
    case "tasks":
      return section("Tasks", [
        `active=${activeTask ? `${activeTask.taskId} [${activeTask.status}] ${truncate(activeTask.title, 80)}` : "none"}`,
        `next=${nextTask ? `${nextTask.taskId} [${nextTask.status}] ${truncate(nextTask.title, 80)}` : "none"}`,
        `counts=total:${detail.tasks.length} active:${detail.activeTaskCount} ready:${detail.readyTaskCount} blocked:${blockedCount}`,
        ...(detail.tasks.length ? [""] : []),
        ...(detail.tasks.length
          ? detail.tasks.map((task) => [
          `${task.taskId} [${task.status}] ${task.title}`,
          `  worker=${task.workerType} kind=${task.taskKind} candidate=${task.candidateId ?? "none"} job=${task.jobStatus ?? "none"}`,
          `  dependsOn=${task.dependsOn.join(", ") || "none"} workspace=${task.workspaceExists ? `${task.workspaceDirty ? "dirty" : "clean"} ${task.workspacePath ?? ""}` : "missing"}`,
          task.latestSummary ? `  summary=${truncate(task.latestSummary, 180)}` : undefined,
          task.blockedReason ? `  blocked=${truncate(task.blockedReason, 180)}` : undefined,
        ].filter((line): line is string => Boolean(line)).join("\n"))
          : ["(no tasks)"]),
      ]);
    case "candidates":
      return section("Candidates", detail.candidates.length
        ? detail.candidates.map((candidate) => [
          `${candidate.candidateId} [${candidate.status}] task=${candidate.taskId}`,
          `  base=${shortHash(candidate.baseCommit)} head=${shortHash(candidate.headCommit)}`,
          candidate.summary ? `  summary=${truncate(candidate.summary, 180)}` : undefined,
          candidate.latestReason ? `  reason=${truncate(candidate.latestReason, 180)}` : undefined,
        ].filter((line): line is string => Boolean(line)).join("\n"))
        : ["(no candidates)"]);
    case "evidence":
      return section("Evidence", detail.evidenceCards.length
        ? detail.evidenceCards.map((card) =>
          `${formatTime(card.at)} [${card.kind}] ${card.title} | ${truncate(card.summary, 180)}`,
        )
        : ["(no evidence)"]);
    case "activity":
      return section("Activity", detail.activity.length
        ? detail.activity.map((entry) =>
          `${formatTime(entry.at)} [${entry.kind}] ${entry.title} | ${truncate(entry.summary, 180)}`,
        )
        : ["(no activity)"]);
    case "live":
      return section("Live", [
        `focus=${live.activeTasks[0] ? `${live.activeTasks[0].taskId} [${live.activeTasks[0].jobStatus ?? live.activeTasks[0].status}] ${truncate(live.activeTasks[0].title, 80)}` : "none"}`,
        `signal=${truncate(live.activeTasks[0]?.lastMessage ?? live.activeTasks[0]?.stderrTail ?? live.activeTasks[0]?.stdoutTail ?? detail.nextAction ?? "none", 180)}`,
        ...(live.activeTasks.length > 0 ? [""] : []),
        ...(live.activeTasks.length
          ? live.activeTasks.map((task) => [
          `${task.taskId} [${task.jobStatus ?? task.status}] ${task.title}`,
          task.lastMessage ? `  last=${truncate(task.lastMessage, 180)}` : undefined,
          task.stdoutTail ? `  stdout=${truncate(task.stdoutTail, 180)}` : undefined,
          task.stderrTail ? `  stderr=${truncate(task.stderrTail, 180)}` : undefined,
        ].filter((line): line is string => Boolean(line)).join("\n"))
          : ["(no active task output)"]),
      ]);
    case "debug":
      return section("Debug", [
        `state=${objectiveStateSummary(debug) || debug.phase}`,
        `next=${truncate(debug.nextAction, 180) || "none"}`,
        debug.latestDecision
          ? `decision=${truncate(debug.latestDecision.summary, 180)} (${debug.latestDecision.source})`
          : "decision=none",
        `active-jobs=${debug.activeJobs.length} recent-jobs=${debug.lastJobs.length}`,
        debug.activeJobAuthorities?.length
          ? `authorities=${debug.activeJobAuthorities.map((entry) => `${entry.jobId}:${entry.authority}`).join(", ")}`
          : "authorities=none",
        `worktrees=${debug.taskWorktrees.length}${debug.integrationWorktree ? " + integration" : ""}`,
        `context-packs=${debug.latestContextPacks.length}`,
      ]);
    case "receipts":
      return section("Receipts", detail.recentReceipts.length
        ? detail.recentReceipts.map((receipt) =>
          `${formatTime(receipt.ts)} ${receipt.type} ${shortHash(receipt.hash)} | ${truncate(receipt.summary, 180)}`,
        )
        : ["(no receipts)"]);
    default:
      return section("Overview", ["unsupported panel"]);
  }
};
