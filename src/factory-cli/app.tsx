import React, { useEffect, useRef, useState } from "react";
import { Badge, ProgressBar, Spinner, StatusMessage, UnorderedList } from "@inkjs/ui";
import { Box, Text, useApp, useInput } from "ink";

import type { FactoryCliRuntime } from "./runtime.js";
import { FactoryThemeProvider, InlineAlert, statusColor, terminalTheme, tone } from "./theme.js";
import {
  BOARD_SECTION_META,
  PANEL_LABELS,
  PANEL_ORDER,
  type FactoryObjectivePanel,
  budgetPercent,
  flattenObjectives,
  formatDuration,
  formatList,
  formatTime,
  labelize,
  panelIndex,
  shortHash,
  truncate,
} from "./view-model.js";
import type {
  FactoryBoardProjection,
  FactoryComposeModel,
  FactoryDebugProjection,
  FactoryLiveProjection,
  FactoryObjectiveDetail,
  FactoryTaskView,
} from "../services/factory-service.js";

type FactoryAppMode = "board" | "objective";

export type FactoryAppExit = {
  readonly code: number;
  readonly reason: "quit" | "completed" | "failed" | "canceled" | "blocked" | "manual";
  readonly objectiveId?: string;
};

type FactoryTerminalAppProps = {
  readonly runtime: FactoryCliRuntime;
  readonly initialMode: FactoryAppMode;
  readonly initialObjectiveId?: string;
  readonly initialPanel?: FactoryObjectivePanel;
  readonly exitOnTerminal?: boolean;
  readonly onExit: (result: FactoryAppExit) => void;
};

export type FactoryBoardScreenState = {
  readonly compose: FactoryComposeModel;
  readonly board: FactoryBoardProjection;
  readonly selected?: FactoryObjectiveDetail;
  readonly live?: FactoryLiveProjection;
};

export type FactoryObjectiveScreenState = {
  readonly detail: FactoryObjectiveDetail;
  readonly live: FactoryLiveProjection;
  readonly debug: FactoryDebugProjection;
};

type FactoryBoardScreenProps = {
  readonly state: FactoryBoardScreenState;
  readonly selectedObjectiveId?: string;
  readonly compact: boolean;
  readonly stacked: boolean;
  readonly busy?: string;
  readonly error?: string;
  readonly message: string;
};

type FactoryObjectiveScreenProps = {
  readonly state: FactoryObjectiveScreenState;
  readonly panel: FactoryObjectivePanel;
  readonly compact: boolean;
  readonly stacked: boolean;
  readonly busy?: string;
  readonly error?: string;
  readonly message: string;
};

const HOTKEYS = {
  board: [
    ["j/k", "move"],
    ["enter", "open"],
    ["r", "react"],
    ["p", "promote"],
    ["c", "cancel"],
    ["x", "cleanup"],
    ["a", "archive"],
    ["q", "quit"],
  ] as const,
  objective: [
    ["1-8", "tabs"],
    ["←/→", "switch"],
    ["b", "board"],
    ["r", "react"],
    ["p", "promote"],
    ["c", "cancel"],
    ["x", "cleanup"],
    ["a", "archive"],
    ["q", "quit"],
  ] as const,
};

const exitForDetail = (detail: FactoryObjectiveDetail): FactoryAppExit | undefined => {
  if (detail.status === "completed") return { code: 0, reason: "completed", objectiveId: detail.objectiveId };
  if (detail.status === "failed") return { code: 1, reason: "failed", objectiveId: detail.objectiveId };
  if (detail.status === "canceled") return { code: 1, reason: "canceled", objectiveId: detail.objectiveId };
  if (detail.status === "blocked") return { code: 2, reason: "blocked", objectiveId: detail.objectiveId };
  if (!detail.policy.promotion.autoPromote && detail.integration.status === "ready_to_promote") {
    return { code: 2, reason: "manual", objectiveId: detail.objectiveId };
  }
  return undefined;
};

const isDownInput = (input: string, key: { readonly downArrow?: boolean }): boolean =>
  key.downArrow === true || input === "j" || input === "\u001B[B";

const isUpInput = (input: string, key: { readonly upArrow?: boolean }): boolean =>
  key.upArrow === true || input === "k" || input === "\u001B[A";

const isLeftInput = (input: string, key: { readonly leftArrow?: boolean }): boolean =>
  key.leftArrow === true || input === "h" || input === "\u001B[D";

const isRightInput = (input: string, key: { readonly rightArrow?: boolean }): boolean =>
  key.rightArrow === true || input === "l" || input === "\u001B[C";

const formatCount = (value: number, label: string): string =>
  `${value} ${label}${value === 1 ? "" : "s"}`;

const renderTaskSignal = (task: FactoryTaskView): string =>
  truncate(task.lastMessage ?? task.stdoutTail ?? task.stderrTail ?? task.latestSummary ?? "No output yet.", 120);

const renderJobSignal = (job: FactoryLiveProjection["recentJobs"][number]): string =>
  truncate(job.lastError ?? job.canceledReason ?? `${job.agentId} ${job.status}`, 96);

const Surface = (props: {
  readonly kicker?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly right?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly flexGrow?: number;
  readonly width?: number;
  readonly marginRight?: number;
  readonly marginBottom?: number;
}): React.ReactElement => (
  <Box
    borderStyle={terminalTheme.borderStyle}
    borderColor={tone("border")}
    paddingX={1}
    paddingY={0}
    flexDirection="column"
    flexGrow={props.flexGrow}
    width={props.width}
    marginRight={props.marginRight}
    marginBottom={props.marginBottom}
  >
    <Box justifyContent="space-between" marginBottom={1}>
      <Box flexDirection="column" flexGrow={1}>
        {props.kicker ? <Text color={tone("muted")}>{props.kicker.toUpperCase()}</Text> : null}
        <Text bold color={tone("text")}>{props.title}</Text>
        {props.subtitle ? <Text color={tone("muted")}>{truncate(props.subtitle, 140)}</Text> : null}
      </Box>
      {props.right ? <Box marginLeft={1}>{props.right}</Box> : null}
    </Box>
    {props.children}
  </Box>
);

const Keycap = ({ keyLabel, label }: { readonly keyLabel: string; readonly label: string }): React.ReactElement => (
  <Box marginRight={1}>
    <Text color={tone("hotkey")}>[{keyLabel}]</Text>
    <Text color={tone("muted")}> {label}</Text>
  </Box>
);

const FooterStatus = ({
  busy,
  error,
  message,
  mode,
}: {
  readonly busy?: string;
  readonly error?: string;
  readonly message: string;
  readonly mode: "board" | "objective";
}): React.ReactElement => (
  <Box flexDirection="column" marginTop={1}>
    <Box flexWrap="wrap">
      {(mode === "board" ? HOTKEYS.board : HOTKEYS.objective).map(([keyLabel, label]) => (
        <Keycap key={`${mode}-${keyLabel}`} keyLabel={keyLabel} label={label} />
      ))}
    </Box>
    <Box marginTop={1}>
      {busy ? (
        <Spinner label={busy} />
      ) : error ? (
        <InlineAlert variant="error" title="Factory error">{error}</InlineAlert>
      ) : (
        <StatusMessage variant="info">{message}</StatusMessage>
      )}
    </Box>
  </Box>
);

const StateBadge = ({ value }: { readonly value: string | undefined }): React.ReactElement => (
  <Badge color={statusColor(value)}>{labelize(value)}</Badge>
);

const MetricCell = ({ label, value }: { readonly label: string; readonly value: string }): React.ReactElement => (
  <Box flexDirection="column" marginRight={2} marginBottom={1}>
    <Text color={tone("muted")}>{label}</Text>
    <Text bold color={tone("text")}>{truncate(value, 32)}</Text>
  </Box>
);

const EmptyState = ({ message }: { readonly message: string }): React.ReactElement => (
  <StatusMessage variant="info">{message}</StatusMessage>
);

const BoardObjectiveRow = ({
  objective,
  selected,
}: {
  readonly objective: FactoryBoardProjection["objectives"][number];
  readonly selected: boolean;
}): React.ReactElement => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={selected ? tone("selection") : tone("muted")}>
        {selected ? terminalTheme.glyphs.pointer : " "}
      </Text>
      <Text bold={selected} color={selected ? tone("text") : tone("text")}>
        {" "}
        {truncate(objective.title, 28)}
      </Text>
    </Box>
    <Box marginLeft={2} flexDirection="column">
      <Box flexWrap="wrap">
        <Text color={tone("muted")}>{labelize(objective.phase)}</Text>
        <Text color={tone("muted")}> · </Text>
        <Text color={tone("muted")}>{labelize(objective.scheduler.slotState)}</Text>
        {objective.scheduler.queuePosition ? (
          <>
            <Text color={tone("muted")}> · q{objective.scheduler.queuePosition}</Text>
          </>
        ) : null}
      </Box>
      <Text color={objective.blockedExplanation ? tone("warning") : tone("muted")}>
        {truncate(objective.blockedExplanation?.summary ?? objective.nextAction ?? objective.latestSummary ?? "No activity yet.", 44)}
      </Text>
    </Box>
  </Box>
);

const BoardSection = ({
  title,
  description,
  objectives,
  selectedObjectiveId,
}: {
  readonly title: string;
  readonly description: string;
  readonly objectives: ReadonlyArray<FactoryBoardProjection["objectives"][number]>;
  readonly selectedObjectiveId?: string;
}): React.ReactElement => (
  <Box flexDirection="column" marginBottom={1}>
    <Box justifyContent="space-between">
      <Text bold color={tone("text")}>{title}</Text>
      <Text color={tone("muted")}>{objectives.length}</Text>
    </Box>
    <Text color={tone("muted")}>{truncate(description, 48)}</Text>
    <Box marginTop={1} flexDirection="column">
      {objectives.length
        ? objectives.map((objective) => (
          <BoardObjectiveRow
            key={objective.objectiveId}
            objective={objective}
            selected={objective.objectiveId === selectedObjectiveId}
          />
        ))
        : <Text color={tone("muted")}>No objectives.</Text>}
    </Box>
  </Box>
);

const DecisionCard = ({
  decision,
  blockedSummary,
}: {
  readonly decision: FactoryObjectiveDetail["latestDecision"] | FactoryDebugProjection["latestDecision"] | undefined;
  readonly blockedSummary?: string;
}): React.ReactElement => (
  <Surface
    kicker="Decision Layer"
    title="Next control signal"
    subtitle={blockedSummary ? "Blocked reason surfaced from receipts." : "Latest orchestration guidance."}
    marginBottom={1}
  >
    {blockedSummary ? (
      <InlineAlert variant="warning" title="Blocked">{blockedSummary}</InlineAlert>
    ) : null}
    {decision ? (
      <Box flexDirection="column">
        <Text color={tone("text")}>{decision.summary}</Text>
        <Text color={tone("muted")}>
          {labelize(decision.source)} · {formatTime(decision.at)}{decision.selectedActionId ? ` · ${decision.selectedActionId}` : ""}
        </Text>
      </Box>
    ) : (
      <EmptyState message="No orchestration decision recorded yet." />
    )}
  </Surface>
);

const LiveTaskCard = ({ task }: { readonly task: FactoryTaskView }): React.ReactElement => (
  <Box
    flexDirection="column"
    borderStyle={terminalTheme.borderStyle}
    borderColor={tone("border")}
    paddingX={1}
    marginBottom={1}
  >
    <Box justifyContent="space-between">
      <Text bold color={tone("text")}>{truncate(task.title, 42)}</Text>
      <StateBadge value={task.jobStatus ?? task.status} />
    </Box>
    <Text color={tone("muted")}>
      {task.taskId} · {task.workerType} · {task.elapsedMs ? formatDuration(task.elapsedMs) : "warming up"}
    </Text>
    <Text color={task.stderrTail ? tone("danger") : tone("logInfo")}>{renderTaskSignal(task)}</Text>
  </Box>
);

const JobTimeline = ({ jobs }: { readonly jobs: FactoryLiveProjection["recentJobs"] }): React.ReactElement => (
  <Box flexDirection="column">
    {jobs.length ? jobs.slice(0, 4).map((job) => (
      <Box key={job.id} flexDirection="column" marginBottom={1}>
        <Text color={tone("text")}>{job.agentId} · {labelize(job.status)}</Text>
        <Text color={tone("muted")}>{formatTime(job.updatedAt)} · attempt {job.attempt}/{job.maxAttempts}</Text>
        <Text color={job.lastError ? tone("danger") : tone("muted")}>{renderJobSignal(job)}</Text>
      </Box>
    )) : <Text color={tone("muted")}>No queue activity yet.</Text>}
  </Box>
);

const OverviewPanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    <Text bold color={tone("text")}>Objective prompt</Text>
    <Text color={tone("text")}>{truncate(detail.prompt, 700)}</Text>
    <Box marginTop={1} flexDirection="column">
      <Text bold color={tone("text")}>Repository profile</Text>
      <Text color={tone("muted")}>{detail.repoProfile.summary || "Repo profile has not been generated yet."}</Text>
      <Text color={tone("muted")}>
        Checks: {formatList(detail.repoProfile.inferredChecks.length ? detail.repoProfile.inferredChecks : detail.checks)}
      </Text>
      <Text color={tone("muted")}>
        Generated skills: {formatCount(detail.repoProfile.generatedSkillRefs.length, "skill")}
      </Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text bold color={tone("text")}>Policy</Text>
      <Text color={tone("muted")}>
        Max active {detail.policy.concurrency.maxActiveTasks} · dispatch burst {detail.policy.throttles.maxDispatchesPerReact} · auto-promote {String(detail.policy.promotion.autoPromote)}
      </Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text bold color={tone("text")}>Validation commands</Text>
      {detail.checks.length ? (
        <UnorderedList>
          {detail.checks.map((check) => (
            <UnorderedList.Item key={check}>
              <Text>{check}</Text>
            </UnorderedList.Item>
          ))}
        </UnorderedList>
      ) : (
        <Text color={tone("muted")}>No validation commands configured.</Text>
      )}
    </Box>
  </Box>
);

const TaskCard = ({ task }: { readonly task: FactoryTaskView }): React.ReactElement => (
  <Box
    flexDirection="column"
    borderStyle={terminalTheme.borderStyle}
    borderColor={tone("border")}
    paddingX={1}
    marginBottom={1}
  >
    <Box justifyContent="space-between">
      <Text bold color={tone("text")}>{task.taskId}</Text>
      <StateBadge value={task.status} />
    </Box>
    <Text color={tone("text")}>{truncate(task.title, 70)}</Text>
    <Text color={tone("muted")}>
      {task.workerType} · {task.taskKind} · {task.candidateId ?? "no candidate"} · {task.jobStatus ?? "no job"}
    </Text>
    {task.dependsOn.length ? <Text color={tone("muted")}>Depends on {task.dependsOn.join(", ")}</Text> : null}
    {task.latestSummary ? <Text color={tone("text")}>{truncate(task.latestSummary, 200)}</Text> : null}
    {task.blockedReason ? <Text color={tone("warning")}>{truncate(task.blockedReason, 200)}</Text> : null}
    <Text color={tone("muted")}>
      Workspace {task.workspaceExists ? (task.workspaceDirty ? "dirty" : "clean") : "missing"}{task.workspacePath ? ` · ${truncate(task.workspacePath, 60)}` : ""}
    </Text>
  </Box>
);

const TasksPanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    {detail.tasks.length ? detail.tasks.map((task) => <TaskCard key={task.taskId} task={task} />) : <EmptyState message="No tasks adopted yet." />}
  </Box>
);

const CandidatesPanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    {detail.candidates.length ? detail.candidates.map((candidate) => (
      <Box
        key={candidate.candidateId}
        flexDirection="column"
        borderStyle={terminalTheme.borderStyle}
        borderColor={tone("border")}
        paddingX={1}
        marginBottom={1}
      >
        <Box justifyContent="space-between">
          <Text bold color={tone("text")}>{candidate.candidateId}</Text>
          <StateBadge value={candidate.status} />
        </Box>
        <Text color={tone("muted")}>
          Task {candidate.taskId} · base {shortHash(candidate.baseCommit)} · head {shortHash(candidate.headCommit)}
        </Text>
        {candidate.summary ? <Text color={tone("text")}>{truncate(candidate.summary, 220)}</Text> : null}
        {candidate.latestReason ? <Text color={tone("muted")}>{truncate(candidate.latestReason, 220)}</Text> : null}
      </Box>
    )) : <EmptyState message="No candidates yet." />}
  </Box>
);

const EvidencePanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    {detail.evidenceCards.length ? detail.evidenceCards.map((card) => (
      <Box
        key={`${card.receiptType}-${card.at}-${card.title}`}
        flexDirection="column"
        borderStyle={terminalTheme.borderStyle}
        borderColor={tone("border")}
        paddingX={1}
        marginBottom={1}
      >
        <Box justifyContent="space-between">
          <Text bold color={tone("text")}>{truncate(card.title, 60)}</Text>
          <StateBadge value={card.kind} />
        </Box>
        <Text color={tone("muted")}>{formatTime(card.at)} · {card.receiptType}</Text>
        <Text color={tone("text")}>{truncate(card.summary, 220)}</Text>
        <Text color={tone("muted")}>
          {card.taskId ?? "no task"}{card.candidateId ? ` · ${card.candidateId}` : ""}{card.receiptHash ? ` · ${shortHash(card.receiptHash)}` : ""}
        </Text>
      </Box>
    )) : <EmptyState message="No evidence cards yet." />}
  </Box>
);

const ActivityPanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    {detail.activity.length ? detail.activity.map((entry) => (
      <Box key={`${entry.kind}-${entry.at}-${entry.title}`} flexDirection="column" marginBottom={1}>
        <Box justifyContent="space-between">
          <Text bold color={tone("text")}>{truncate(entry.title, 60)}</Text>
          <StateBadge value={entry.kind} />
        </Box>
        <Text color={tone("muted")}>{formatTime(entry.at)}</Text>
        <Text color={tone("text")}>{truncate(entry.summary, 220)}</Text>
      </Box>
    )) : <EmptyState message="No activity yet." />}
  </Box>
);

const LivePanel = ({ live }: { readonly live: FactoryLiveProjection }): React.ReactElement => (
  <Box flexDirection="column">
    {live.activeTasks.length ? live.activeTasks.map((task) => <LiveTaskCard key={task.taskId} task={task} />) : <EmptyState message="No active task output right now." />}
    {live.recentJobs.length ? (
      <Box marginTop={1} flexDirection="column">
        <Text bold color={tone("text")}>Recent jobs</Text>
        <JobTimeline jobs={live.recentJobs} />
      </Box>
    ) : null}
  </Box>
);

const DebugPanel = ({ debug }: { readonly debug: FactoryDebugProjection }): React.ReactElement => (
  <Box flexDirection="column">
    <Text color={tone("text")}>Repo profile {labelize(debug.repoProfile.status)}</Text>
    <Text color={tone("muted")}>{debug.repoProfile.summary || "No repo profile summary available."}</Text>
    <Box marginTop={1} flexDirection="column">
      <Text bold color={tone("text")}>Worktrees</Text>
      <Text color={tone("muted")}>
        {formatCount(debug.taskWorktrees.length, "task worktree")}{debug.integrationWorktree ? " + integration" : ""}
      </Text>
      {debug.taskWorktrees.slice(0, 4).map((worktree) => (
        <Text key={worktree.taskId} color={tone("muted")}>
          {worktree.taskId} · {worktree.exists ? (worktree.dirty ? "dirty" : "clean") : "missing"} · {shortHash(worktree.head)}
        </Text>
      ))}
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text bold color={tone("text")}>Queue jobs</Text>
      <Text color={tone("muted")}>
        Active {debug.activeJobs.length} · Recent {debug.lastJobs.length} · Context packs {debug.latestContextPacks.length}
      </Text>
      {debug.lastJobs.slice(0, 3).map((job) => (
        <Text key={job.id} color={tone("muted")}>
          {job.agentId} · {labelize(job.status)} · {formatTime(job.updatedAt)}
        </Text>
      ))}
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text bold color={tone("text")}>Next action</Text>
      <Text color={tone("muted")}>{debug.nextAction ?? "No next action surfaced."}</Text>
    </Box>
  </Box>
);

const ReceiptsPanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    {detail.recentReceipts.length ? detail.recentReceipts.map((receipt) => (
      <Box key={receipt.hash} flexDirection="column" marginBottom={1}>
        <Box justifyContent="space-between">
          <Text bold color={tone("text")}>{receipt.type}</Text>
          <Text color={tone("muted")}>{formatTime(receipt.ts)}</Text>
        </Box>
        <Text color={tone("text")}>{truncate(receipt.summary, 220)}</Text>
        <Text color={tone("muted")}>
          {shortHash(receipt.hash)}{receipt.taskId ? ` · ${receipt.taskId}` : ""}{receipt.candidateId ? ` · ${receipt.candidateId}` : ""}
        </Text>
      </Box>
    )) : <EmptyState message="No receipts yet." />}
  </Box>
);

const ObjectivePanelContent = ({
  state,
  panel,
}: {
  readonly state: FactoryObjectiveScreenState;
  readonly panel: FactoryObjectivePanel;
}): React.ReactElement => {
  switch (panel) {
    case "overview":
      return <OverviewPanel detail={state.detail} />;
    case "tasks":
      return <TasksPanel detail={state.detail} />;
    case "candidates":
      return <CandidatesPanel detail={state.detail} />;
    case "evidence":
      return <EvidencePanel detail={state.detail} />;
    case "activity":
      return <ActivityPanel detail={state.detail} />;
    case "live":
      return <LivePanel live={state.live} />;
    case "debug":
      return <DebugPanel debug={state.debug} />;
    case "receipts":
      return <ReceiptsPanel detail={state.detail} />;
    default:
      return <OverviewPanel detail={state.detail} />;
  }
};

const BoardSummary = ({ state }: { readonly state: FactoryBoardScreenState }): React.ReactElement => {
  const selected = state.selected;
  const live = state.live;
  return (
    <Box flexDirection="column">
      {selected ? (
        <>
          <Box flexWrap="wrap" marginBottom={1}>
            <Box marginRight={1}><StateBadge value={selected.phase} /></Box>
            <Box marginRight={1}><StateBadge value={selected.scheduler.slotState} /></Box>
            <Box marginRight={1}><StateBadge value={selected.integration.status} /></Box>
          </Box>
          <Text color={tone("text")}>{truncate(selected.nextAction ?? selected.latestSummary ?? "No next action recorded yet.", 180)}</Text>
          <Box marginTop={1} flexWrap="wrap">
            <MetricCell label="Objective" value={selected.objectiveId} />
            <MetricCell label="Queue" value={`${selected.scheduler.slotState}${selected.scheduler.queuePosition ? ` · ${selected.scheduler.queuePosition}` : ""}`} />
            <MetricCell label="Tasks" value={`${selected.activeTaskCount}/${selected.taskCount} active`} />
            <MetricCell label="Ready" value={String(selected.readyTaskCount)} />
            <MetricCell label="Head" value={shortHash(selected.latestCommitHash)} />
          </Box>
          <DecisionCard
            decision={selected.latestDecision}
            blockedSummary={selected.blockedExplanation?.summary}
          />
          <Surface kicker="Live Feed" title="Active tasks" subtitle={live?.objectiveTitle ?? "Current selected objective"}>
            {live?.activeTasks?.length ? (
              <Box flexDirection="column">
                {live.activeTasks.slice(0, 3).map((task) => <LiveTaskCard key={task.taskId} task={task} />)}
              </Box>
            ) : (
              <EmptyState message="No active task output for the selected objective." />
            )}
          </Surface>
        </>
      ) : (
        <>
          {state.compose.objectiveCount === 0 ? (
            <InlineAlert
              variant={state.compose.sourceDirty ? "warning" : "info"}
              title={state.compose.sourceDirty ? "Repo is dirty" : "No objectives yet"}
            >
              {state.compose.sourceDirty
                ? "Factory only works from committed history. Commit or stash changes first, or pass --base-hash when you create an objective."
                : "Create your first objective with `bun run factory run --title \"Mission\" --prompt \"Describe the change\"`."}
            </InlineAlert>
          ) : (
            <EmptyState message="No objective selected. Use j/k or arrow keys to focus one." />
          )}
          <Box marginTop={1} flexDirection="column">
            <Text bold color={tone("text")}>Quick status</Text>
            <Text color={tone("muted")}>Repo profile: {labelize(state.compose.repoProfile.status)}</Text>
            <Text color={tone("muted")}>Validation: {formatList(state.compose.defaultValidationCommands, "none")}</Text>
            <Text color={tone("muted")}>
              Next step: {state.compose.objectiveCount === 0 ? "create an objective" : "select an objective from the board"}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
};

export const FactoryBoardScreen = ({
  state,
  selectedObjectiveId,
  compact,
  stacked,
  busy,
  error,
  message,
}: FactoryBoardScreenProps): React.ReactElement => (
  <Box flexDirection="column">
    <Surface
      kicker="Mission Control"
      title="Factory"
      subtitle="Receipt-native objective orchestration with repo profiling, task graphs, evidence, and promotion in one console."
      marginBottom={1}
      right={<StateBadge value={state.compose.repoProfile.status} />}
    >
      <Box flexWrap="wrap">
        <MetricCell label="Repo" value={state.compose.sourceBranch ?? state.compose.defaultBranch} />
        <MetricCell label="Dirty" value={state.compose.sourceDirty ? "yes" : "no"} />
        <MetricCell label="Objectives" value={String(state.compose.objectiveCount)} />
        <MetricCell label="Checks" value={formatList(state.compose.defaultValidationCommands, "none")} />
        <MetricCell label="Queue" value={`${state.board.sections.active.length} active · ${state.board.sections.queued.length} queued`} />
      </Box>
      <Text color={tone("muted")}>{state.compose.repoProfile.summary || "Factory will generate a repository profile on demand."}</Text>
    </Surface>
    <Box flexDirection={stacked ? "column" : "row"}>
      <Surface
        kicker="Objective Board"
        title="Queue and attention"
        subtitle="Grouped by operational state."
        width={stacked ? undefined : compact ? 42 : 46}
        marginRight={stacked ? 0 : 1}
        marginBottom={stacked ? 1 : 0}
      >
        {(["needs_attention", "active", "queued", "completed"] as const).map((section) => (
          <BoardSection
            key={section}
            title={BOARD_SECTION_META[section].title}
            description={BOARD_SECTION_META[section].description}
            objectives={state.board.sections[section]}
            selectedObjectiveId={selectedObjectiveId}
          />
        ))}
      </Surface>
      <Box flexGrow={1} flexDirection="column">
        <Surface
          kicker="Selected Objective"
          title={state.selected?.title ?? "No objective selected"}
          subtitle={state.selected?.objectiveId ?? "Use the board on the left to pick an objective."}
          marginBottom={1}
        >
          <BoardSummary state={state} />
        </Surface>
        <Surface
          kicker="Queue Activity"
          title="Recent jobs"
          subtitle={state.live?.selectedObjectiveId ? `Focused on ${state.live.objectiveTitle ?? state.live.selectedObjectiveId}` : "Factory queue activity"}
        >
          <JobTimeline jobs={state.live?.recentJobs ?? []} />
        </Surface>
      </Box>
    </Box>
    <FooterStatus busy={busy} error={error} message={message} mode="board" />
  </Box>
);

const PanelTabs = ({
  panel,
}: {
  readonly panel: FactoryObjectivePanel;
}): React.ReactElement => (
  <Box flexWrap="wrap" marginBottom={1}>
    {PANEL_ORDER.map((candidate) => {
      const active = candidate === panel;
      return (
        <Box key={candidate} marginRight={1} marginBottom={1}>
          <Text color={active ? tone("selection") : tone("muted")} bold={active}>
            [{panelIndex(candidate)}] {PANEL_LABELS[candidate]}
          </Text>
        </Box>
      );
    })}
  </Box>
);

const ObjectiveSummarySidebar = ({ state }: { readonly state: FactoryObjectiveScreenState }): React.ReactElement => {
  const { detail, live, debug } = state;
  return (
    <Box flexDirection="column">
      <Surface kicker="Control" title="Objective state" subtitle={detail.objectiveId} marginBottom={1}>
        <Box flexWrap="wrap" marginBottom={1}>
          <Box marginRight={1}><StateBadge value={detail.phase} /></Box>
          <Box marginRight={1}><StateBadge value={detail.scheduler.slotState} /></Box>
          <Box marginRight={1}><StateBadge value={detail.integration.status} /></Box>
        </Box>
        <Text color={tone("text")}>{truncate(detail.nextAction ?? "No next action surfaced.", 180)}</Text>
        <Box marginTop={1}>
          <Text color={tone("muted")}>Elapsed</Text>
        </Box>
        <ProgressBar value={budgetPercent(detail.budgetState.elapsedMinutes, detail.policy.budgets.maxObjectiveMinutes)} />
        <Text color={tone("muted")}>
          {detail.budgetState.elapsedMinutes}m / {detail.policy.budgets.maxObjectiveMinutes}m
        </Text>
        <Box marginTop={1}>
          <Text color={tone("muted")}>Task budget</Text>
        </Box>
        <ProgressBar value={budgetPercent(detail.budgetState.taskRunsUsed, detail.policy.budgets.maxTaskRuns)} />
        <Text color={tone("muted")}>
          {detail.budgetState.taskRunsUsed} / {detail.policy.budgets.maxTaskRuns} task runs
        </Text>
      </Surface>
      <DecisionCard
        decision={detail.latestDecision ?? debug.latestDecision}
        blockedSummary={detail.blockedExplanation?.summary}
      />
      <Surface kicker="Live Feed" title="Worker output" subtitle={`${live.activeTasks.length} active task${live.activeTasks.length === 1 ? "" : "s"}`}>
        {live.activeTasks.length ? (
          <Box flexDirection="column">
            {live.activeTasks.slice(0, 2).map((task) => <LiveTaskCard key={task.taskId} task={task} />)}
          </Box>
        ) : (
          <EmptyState message="No active task output right now." />
        )}
      </Surface>
    </Box>
  );
};

export const FactoryObjectiveScreen = ({
  state,
  panel,
  compact,
  stacked,
  busy,
  error,
  message,
}: FactoryObjectiveScreenProps): React.ReactElement => (
  <Box flexDirection="column">
    <Surface
      kicker="Objective Workspace"
      title={state.detail.title}
      subtitle={`${state.detail.objectiveId} · ${state.detail.channel}`}
      marginBottom={1}
      right={<StateBadge value={state.detail.integration.status} />}
    >
      <Box flexWrap="wrap">
        <MetricCell label="Queue" value={`${state.detail.scheduler.slotState}${state.detail.scheduler.queuePosition ? ` · ${state.detail.scheduler.queuePosition}` : ""}`} />
        <MetricCell label="Latest Commit" value={shortHash(state.detail.latestCommitHash)} />
        <MetricCell label="Task Runs" value={`${state.detail.budgetState.taskRunsUsed}/${state.detail.policy.budgets.maxTaskRuns}`} />
        <MetricCell label="Reconciliation" value={`${state.detail.budgetState.reconciliationTasksUsed}/${state.detail.policy.budgets.maxReconciliationTasks}`} />
        <MetricCell label="Checks" value={formatList(state.detail.checks, "none")} />
      </Box>
    </Surface>
    <PanelTabs panel={panel} />
    <Box flexDirection={stacked ? "column" : "row"}>
      <Surface
        kicker="Panel"
        title={PANEL_LABELS[panel]}
        subtitle={compact ? "Detailed objective state and evidence." : "Detailed objective state, evidence, and live operator context."}
        flexGrow={1}
        marginRight={stacked ? 0 : 1}
        marginBottom={stacked ? 1 : 0}
      >
        <ObjectivePanelContent state={state} panel={panel} />
      </Surface>
      <Surface
        kicker="Action Rail"
        title="Control and live state"
        subtitle="Visible summary of budgets, decisions, and active output."
        width={stacked ? undefined : compact ? 40 : 44}
      >
        <ObjectiveSummarySidebar state={state} />
      </Surface>
    </Box>
    <FooterStatus busy={busy} error={error} message={message} mode="objective" />
  </Box>
);

export const FactoryTerminalApp = ({
  runtime,
  initialMode,
  initialObjectiveId,
  initialPanel = "overview",
  exitOnTerminal = false,
  onExit,
}: FactoryTerminalAppProps): React.ReactElement => {
  const { exit } = useApp();
  const [mode, setMode] = useState<FactoryAppMode>(initialMode);
  const [selectedObjectiveId, setSelectedObjectiveId] = useState<string | undefined>(initialObjectiveId);
  const [panel, setPanel] = useState<FactoryObjectivePanel>(initialPanel);
  const [boardState, setBoardState] = useState<FactoryBoardScreenState | undefined>();
  const [objectiveState, setObjectiveState] = useState<FactoryObjectiveScreenState | undefined>();
  const [message, setMessage] = useState<string>("Loading Factory mission control...");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [terminalWidth, setTerminalWidth] = useState<number>(process.stdout.columns ?? 120);
  const exitRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const selectedList = boardState?.board ? flattenObjectives(boardState.board) : [];
  const compact = terminalWidth < 138;
  const stacked = terminalWidth < 108;

  const safeExit = (result: FactoryAppExit): void => {
    if (exitRef.current) return;
    exitRef.current = true;
    onExit(result);
    exit();
  };

  const refresh = async (): Promise<void> => {
    try {
      setError(undefined);
      const compose = await runtime.service.buildComposeModel();
      const board = await runtime.service.buildBoardProjection(selectedObjectiveId);
      const allObjectives = flattenObjectives(board);
      const retainedSelection = selectedObjectiveId && allObjectives.some((objective) => objective.objectiveId === selectedObjectiveId)
        ? selectedObjectiveId
        : undefined;
      const nextSelected = retainedSelection ?? board.selectedObjectiveId ?? allObjectives[0]?.objectiveId;
      setSelectedObjectiveId(nextSelected);
      if (mode === "board") {
        const selected = nextSelected ? await runtime.service.getObjective(nextSelected).catch(() => undefined) : undefined;
        const live = nextSelected ? await runtime.service.buildLiveProjection(nextSelected).catch(() => undefined) : undefined;
        setBoardState({ compose, board, selected, live });
      } else {
        setBoardState({ compose, board });
      }
      if (nextSelected) {
        const [detail, live, debug] = await Promise.all([
          runtime.service.getObjective(nextSelected),
          runtime.service.buildLiveProjection(nextSelected),
          runtime.service.getObjectiveDebug(nextSelected),
        ]);
        setObjectiveState({ detail, live, debug });
        if (!busy) {
          setMessage(`Watching ${detail.objectiveId} · ${labelize(detail.phase)} · ${labelize(detail.integration.status)}`);
        }
      } else {
        setObjectiveState(undefined);
        if (!busy) setMessage("Factory ready. Create or select an objective.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    const onResize = (): void => setTerminalWidth(process.stdout.columns ?? 120);
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  useEffect(() => {
    let closed = false;
    const queueRefresh = (source: "runtime" | "fallback"): void => {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = undefined;
        if (!closed) {
          void refresh();
        }
      }, source === "runtime" ? 75 : 250);
    };
    const load = async (): Promise<void> => {
      await refresh();
      if (closed) return;
    };
    void load();
    const unsubscribe = runtime.subscribe((event) => {
      if (closed) return;
      if (!busy && event.type === "queue_changed") {
        setMessage(`Synced from runtime activity · ${formatTime(event.at)}`);
      }
      if (event.type === "worker_error") {
        setError(event.error.message);
      }
      queueRefresh("runtime");
    });
    const fallback = setInterval(() => {
      queueRefresh("fallback");
    }, 15_000);
    return () => {
      closed = true;
      unsubscribe();
      clearInterval(fallback);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = undefined;
      }
    };
  }, [mode, selectedObjectiveId, busy]);

  useEffect(() => {
    if (!exitOnTerminal || !objectiveState?.detail) return;
    const terminal = exitForDetail(objectiveState.detail);
    if (terminal) safeExit(terminal);
  }, [
    exitOnTerminal,
    objectiveState?.detail?.status,
    objectiveState?.detail?.integration.status,
    objectiveState?.detail?.policy.promotion.autoPromote,
  ]);

  const runAction = async (label: string, action: () => Promise<void>): Promise<void> => {
    try {
      setBusy(label);
      setMessage(label);
      setError(undefined);
      await action();
      await refresh();
      setMessage(`${label} complete.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  useInput((input, key) => {
    if (busy) return;
    if (input === "q") {
      safeExit({ code: 0, reason: "quit", objectiveId: selectedObjectiveId });
      return;
    }

    if (mode === "board") {
      if (isDownInput(input, key) && selectedList.length > 0) {
        const index = selectedObjectiveId
          ? Math.max(0, selectedList.findIndex((objective) => objective.objectiveId === selectedObjectiveId))
          : -1;
        const next = selectedList[(index + 1 + selectedList.length) % selectedList.length];
        setSelectedObjectiveId(next?.objectiveId);
        return;
      }
      if (isUpInput(input, key) && selectedList.length > 0) {
        if (!selectedObjectiveId) {
          setSelectedObjectiveId(selectedList[0]?.objectiveId);
          return;
        }
        const index = selectedList.findIndex((objective) => objective.objectiveId === selectedObjectiveId);
        const normalized = index < 0 ? 0 : index;
        const next = selectedList[(normalized - 1 + selectedList.length) % selectedList.length];
        setSelectedObjectiveId(next?.objectiveId);
        return;
      }
      if ((key.return || input === "o") && selectedObjectiveId) {
        setMode("objective");
        return;
      }
    } else {
      if (input === "b") {
        setMode("board");
        return;
      }
      if (isLeftInput(input, key)) {
        const current = PANEL_ORDER.indexOf(panel);
        setPanel(PANEL_ORDER[(current - 1 + PANEL_ORDER.length) % PANEL_ORDER.length]!);
        return;
      }
      if (isRightInput(input, key)) {
        const current = PANEL_ORDER.indexOf(panel);
        setPanel(PANEL_ORDER[(current + 1) % PANEL_ORDER.length]!);
        return;
      }
      const panelNumber = Number.parseInt(input, 10);
      if (Number.isFinite(panelNumber) && panelNumber >= 1 && panelNumber <= PANEL_ORDER.length) {
        setPanel(PANEL_ORDER[panelNumber - 1]!);
        return;
      }
    }

    if (!selectedObjectiveId) return;
    if (input === "r") {
      void runAction("Reacting objective", async () => {
        await runtime.service.reactObjective(selectedObjectiveId);
      });
      return;
    }
    if (input === "p") {
      void runAction("Promoting objective", async () => {
        await runtime.service.promoteObjective(selectedObjectiveId);
      });
      return;
    }
    if (input === "c") {
      void runAction("Canceling objective", async () => {
        await runtime.service.cancelObjective(selectedObjectiveId, "canceled from CLI");
      });
      return;
    }
    if (input === "x") {
      void runAction("Cleaning workspaces", async () => {
        await runtime.service.cleanupObjectiveWorkspaces(selectedObjectiveId);
      });
      return;
    }
    if (input === "a") {
      void runAction("Archiving objective", async () => {
        await runtime.service.archiveObjective(selectedObjectiveId);
      });
      return;
    }
  });

  let body: React.ReactNode;
  if (!boardState && !objectiveState) {
    body = <Spinner label="Profiling queue and loading objectives" />;
  } else if (mode === "board" && boardState) {
    body = (
      <FactoryBoardScreen
        state={boardState}
        selectedObjectiveId={selectedObjectiveId}
        compact={compact}
        stacked={stacked}
        busy={busy}
        error={error}
        message={message}
      />
    );
  } else if (objectiveState) {
    body = (
      <FactoryObjectiveScreen
        state={objectiveState}
        panel={panel}
        compact={compact}
        stacked={stacked}
        busy={busy}
        error={error}
        message={message}
      />
    );
  } else {
    body = <EmptyState message="No objective selected." />;
  }

  return <FactoryThemeProvider>{body}</FactoryThemeProvider>;
};
