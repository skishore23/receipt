import React, { useEffect, useMemo, useRef, useState } from "react";
import { Badge, ProgressBar, Spinner, StatusMessage } from "@inkjs/ui";
import { Box, Text, useApp, useInput } from "ink";

import {
  abortJobMutation,
  archiveObjectiveMutation,
  cancelObjectiveMutation,
  cleanupObjectiveMutation,
  createObjectiveMutation,
  followUpJobMutation,
  promoteObjectiveMutation,
  reactObjectiveMutation,
  requireActiveObjectiveJob,
  steerJobMutation,
} from "./actions";
import { readObjectiveAnalysis, type ObjectiveAnalysis } from "./analyze";
import type { FactoryCliRuntime } from "./runtime";
import { COMPOSER_COMMANDS, parseComposerDraft } from "./composer";
import { FactoryThemeProvider, InlineAlert, statusColor, terminalTheme, tone } from "./theme";
import {
  BOARD_SECTION_META,
  buildFactoryWorkbenchViewModel,
  budgetPercent,
  flattenObjectives,
  formatDuration,
  formatList,
  formatTime,
  labelize,
  PANEL_LABELS,
  PANEL_ORDER,
  panelIndex,
  shortHash,
  truncate,
  type FactoryWorkbenchFocusArea,
  type FactoryObjectivePanel,
} from "./view-model";
import { buildInvestigationReportSections } from "./investigation-report";
import type {
  FactoryBoardProjection,
  FactoryComposeModel,
  FactoryDebugProjection,
  FactoryLiveProjection,
  FactoryObjectiveDetail,
  FactoryTaskView,
} from "../services/factory-service";
import { DEFAULT_FACTORY_OBJECTIVE_POLICY } from "../modules/factory";
import { buildFactoryWorkbench } from "../views/factory-workbench";

export type FactoryAppExit = {
  readonly code: number;
  readonly reason: "quit" | "completed" | "failed" | "canceled" | "blocked" | "manual" | "integration_conflicted";
  readonly objectiveId?: string;
};

type FactoryTerminalAppProps = {
  readonly runtime: FactoryCliRuntime;
  readonly initialObjectiveId?: string;
  readonly initialPanel?: FactoryObjectivePanel;
  readonly exitOnTerminal?: boolean;
  readonly onExit: (result: FactoryAppExit) => void;
};


type FactoryWorkbenchSnapshot = {
  readonly compose: FactoryComposeModel;
  readonly board: FactoryBoardProjection;
  readonly detail?: FactoryObjectiveDetail;
  readonly live?: FactoryLiveProjection;
  readonly debug?: FactoryDebugProjection;
  readonly analysis?: ObjectiveAnalysis;
};

const HOTKEYS = [
  ["j/k, ↑/↓", "select"],
  ["1-9,0", "panel"],
  ["tab", "focus"],
  ["/", "chat"],
  ["enter", "focus/send"],
  ["r/p/c/x/a", "act"],
  ["o", "rail"],
  ["?", "help"],
  ["q", "quit"],
] as const;

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
  readonly borderColor?: ReturnType<typeof tone>;
}): React.ReactElement => (
  <Box
    borderStyle={terminalTheme.borderStyle}
    borderColor={props.borderColor ?? tone("border")}
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

const MetricCell = ({ label, value }: { readonly label: string; readonly value: string }): React.ReactElement => (
  <Box flexDirection="column" marginRight={2} marginBottom={1}>
    <Text color={tone("muted")}>{label}</Text>
    <Text bold color={tone("text")}>{truncate(value, 28)}</Text>
  </Box>
);

const StateBadge = ({ value }: { readonly value: string | undefined }): React.ReactElement => (
  <Badge color={statusColor(value)}>{labelize(value)}</Badge>
);

const EmptyState = ({ title, message }: { readonly title: string; readonly message: string }): React.ReactElement => (
  <InlineAlert variant="info" title={title}>{message}</InlineAlert>
);

const renderTaskSignal = (task: FactoryTaskView): string =>
  truncate(task.lastMessage ?? task.stdoutTail ?? task.stderrTail ?? task.latestSummary ?? "No output yet.", 140);

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

const PanelTabs = ({ panel }: { readonly panel: FactoryObjectivePanel }): React.ReactElement => (
  <Box flexWrap="wrap" marginBottom={1}>
    {PANEL_ORDER.map((candidate) => {
      const active = candidate === panel;
      const shortcut = panelIndex(candidate) === 10 ? 0 : panelIndex(candidate);
      return (
        <Box key={candidate} marginRight={1} marginBottom={1}>
          <Text color={active ? tone("selection") : tone("muted")} bold={active}>
            [{shortcut}] {PANEL_LABELS[candidate]}
          </Text>
        </Box>
      );
    })}
  </Box>
);

const TimelineEntryView = ({
  title,
  summary,
  meta,
  emphasis,
  body,
}: {
  readonly title: string;
  readonly summary: string;
  readonly meta: string;
  readonly emphasis?: "accent" | "warning" | "danger" | "success" | "muted";
  readonly body?: string;
}): React.ReactElement => {
  const color = emphasis === "danger"
    ? tone("danger")
    : emphasis === "warning"
      ? tone("warning")
      : emphasis === "success"
        ? tone("success")
        : emphasis === "accent"
          ? tone("accent")
          : tone("muted");
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color}>{terminalTheme.glyphs.pointer}</Text>
        <Text bold color={tone("text")}> {truncate(title, 52)}</Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        <Text color={tone("text")}>{truncate(summary, 220)}</Text>
        {body && body !== summary ? <Text color={tone("muted")}>{truncate(body, 260)}</Text> : null}
        <Text color={tone("muted")}>{truncate(meta, 86)}</Text>
      </Box>
    </Box>
  );
};

const ObjectiveRail = ({
  board,
  selectedObjectiveId,
  compact,
}: {
  readonly board: FactoryBoardProjection;
  readonly selectedObjectiveId?: string;
  readonly compact: boolean;
}): React.ReactElement => (
  <Box flexDirection="column">
    {(["needs_attention", "active", "queued", "completed"] as const).map((section) => (
      <Box key={section} flexDirection="column" marginBottom={1}>
        <Box justifyContent="space-between">
          <Text bold color={tone("text")}>{BOARD_SECTION_META[section].title}</Text>
          <Text color={tone("muted")}>{board.sections[section].length}</Text>
        </Box>
        {!compact ? <Text color={tone("muted")}>{truncate(BOARD_SECTION_META[section].description, 40)}</Text> : null}
        <Box flexDirection="column" marginTop={1}>
          {board.sections[section].length ? board.sections[section].map((objective) => {
            const active = objective.objectiveId === selectedObjectiveId;
            return (
              <Box key={objective.objectiveId} flexDirection="column" marginBottom={1}>
                <Box>
                  <Text color={active ? tone("selection") : tone("muted")}>
                    {active ? terminalTheme.glyphs.pointer : " "}
                  </Text>
                  <Text bold={active} color={tone("text")}> {truncate(objective.title, compact ? 20 : 28)}</Text>
                </Box>
                <Box marginLeft={2} flexDirection="column">
                  <Text color={tone("muted")}>
                    {labelize(objective.displayState ?? objective.phase)}
                    {objective.phaseDetail ? ` · ${labelize(objective.phaseDetail)}` : ""}
                    · {labelize(objective.scheduler.slotState)}
                    {objective.scheduler.queuePosition ? ` · q${objective.scheduler.queuePosition}` : ""}
                  </Text>
                  <Text color={objective.blockedExplanation ? tone("warning") : tone("muted")}>
                    {truncate(objective.blockedExplanation?.summary ?? objective.nextAction ?? objective.latestSummary ?? "No activity yet.", compact ? 28 : 44)}
                  </Text>
                </Box>
              </Box>
            );
          }) : <Text color={tone("muted")}>No objectives.</Text>}
        </Box>
      </Box>
    ))}
  </Box>
);

const WorkbenchPane = ({
  snapshot,
  railVisible,
  focused,
}: {
  readonly snapshot: FactoryWorkbenchSnapshot;
  readonly railVisible: boolean;
  readonly focused: boolean;
}): React.ReactElement => {
  const model = buildFactoryWorkbenchViewModel({
    compose: snapshot.compose,
    board: snapshot.board,
    detail: snapshot.detail,
    live: snapshot.live,
    debug: snapshot.debug,
  });
  const workbench = snapshot.detail
    ? buildFactoryWorkbench({
        detail: snapshot.detail,
        recentJobs: snapshot.live?.recentJobs,
      })
    : undefined;
  const readyTasks = snapshot.detail?.tasks.filter((task) => task.status === "ready").length ?? 0;
  return (
    <Surface
      kicker="Workbench"
      title={snapshot.detail ? snapshot.detail.title : "Factory workbench"}
      subtitle={snapshot.detail?.nextAction ?? model.timeline.subtitle}
      flexGrow={1}
      marginRight={1}
      marginBottom={1}
      borderColor={focused ? tone("selection") : tone("border")}
    >
      {snapshot.detail ? (
        <Box flexDirection="column">
          <Box flexWrap="wrap" marginBottom={1}>
            <Box marginRight={1} marginBottom={1}><StateBadge value={snapshot.detail.phase} /></Box>
            <Box marginRight={1} marginBottom={1}><StateBadge value={snapshot.detail.scheduler.slotState} /></Box>
            <Box marginRight={1} marginBottom={1}><StateBadge value={snapshot.detail.integration.status} /></Box>
          </Box>
          <Box flexWrap="wrap" marginBottom={1}>
            <MetricCell label="Tasks" value={String(snapshot.detail.tasks.length)} />
            <MetricCell label="Ready" value={String(readyTasks)} />
            <MetricCell label="Active Jobs" value={String(workbench?.summary.activeJobCount ?? 0)} />
            <MetricCell label="Checks" value={String(snapshot.detail.checks.length)} />
          </Box>
          <Text color={tone("muted")}>
            {snapshot.detail.objectiveId} · {labelize(snapshot.detail.objectiveMode)} · severity {snapshot.detail.severity}
          </Text>
          {workbench ? <ExecutionWorkbenchRail detail={snapshot.detail} live={snapshot.live ?? { activeTasks: [], recentJobs: [] }} /> : null}
          <Box marginTop={1} flexDirection="column">
            <Text bold color={tone("text")}>Recent Stream</Text>
            {model.timeline.entries.length ? (
              <Box marginTop={1} flexDirection="column">
                {model.timeline.entries.map((entry) => (
                  <TimelineEntryView
                    key={entry.id}
                    title={entry.title}
                    summary={entry.summary}
                    meta={entry.meta}
                    emphasis={entry.emphasis}
                    body={entry.body}
                  />
                ))}
              </Box>
            ) : (
              <Box marginTop={1}>
                <EmptyState
                  title={model.timeline.emptyTitle}
                  message={model.timeline.emptyMessage}
                />
              </Box>
            )}
          </Box>
        </Box>
      ) : (
        <EmptyState
          title={model.timeline.emptyTitle}
          message={model.timeline.emptyMessage}
        />
      )}
      {!railVisible && snapshot.board.objectives.length ? (
        <Text color={tone("muted")}>Press `o` to show the objective rail.</Text>
      ) : null}
    </Surface>
  );
};

const OverviewPanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    <Text bold color={tone("text")}>Objective prompt</Text>
    <Text color={tone("text")}>{truncate(detail.prompt, 520)}</Text>
    <Box marginTop={1} flexWrap="wrap">
      <MetricCell label="Mode" value={labelize(detail.objectiveMode)} />
      <MetricCell label="Severity" value={String(detail.severity)} />
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text bold color={tone("text")}>Initiating profile</Text>
      <Text color={tone("muted")}>
        {detail.profile.rootProfileLabel} · {detail.profile.rootProfileId} · {truncate(detail.profile.promptPath, 80)}
      </Text>
      <Text color={tone("muted")}>Skills {formatList(detail.profile.selectedSkills, "none")}</Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text bold color={tone("text")}>Next action</Text>
      <Text color={tone("muted")}>{detail.nextAction ?? "No next action surfaced."}</Text>
    </Box>
    {detail.selfImprovement ? (
      <Box marginTop={1} flexDirection="column">
        <Text bold color={tone("text")}>Self improvement</Text>
        <Text color={tone("muted")}>
          {detail.selfImprovement.auditStatus === "failed"
            ? "Audit failed"
            : detail.selfImprovement.auditStatus === "running"
              ? "Audit running"
              : detail.selfImprovement.auditStatus === "pending"
                ? "Audit queued"
                : detail.selfImprovement.stale
                  ? "Audit stale"
                  : detail.selfImprovement.auditStatus === "missing"
                    ? "Audit missing"
                    : detail.selfImprovement.auditedAt
                      ? `Audited ${formatTime(detail.selfImprovement.auditedAt)}`
                      : "Audit recorded"}
          {detail.selfImprovement.stale ? " · snapshot stale" : ""}
          {` · ${detail.selfImprovement.recommendations.length} recommendation${detail.selfImprovement.recommendations.length === 1 ? "" : "s"}`}
        </Text>
        {detail.selfImprovement.auditStatusMessage ? (
          <Text color={tone("warning")}>{truncate(detail.selfImprovement.auditStatusMessage, 220)}</Text>
        ) : null}
        {detail.selfImprovement.recommendationStatus === "failed" ? (
          <Text color={tone("warning")}>
            {truncate(`Recommendation generation failed${detail.selfImprovement.recommendationError ? `: ${detail.selfImprovement.recommendationError}` : "."}`, 220)}
          </Text>
        ) : null}
        {detail.selfImprovement.recommendations.length ? detail.selfImprovement.recommendations.slice(0, 3).map((recommendation, index) => (
          <Text key={`${recommendation.summary}:${index}`} color={tone("muted")}>
            {truncate(`- ${recommendation.summary}${recommendation.suggestedFix ? ` :: ${recommendation.suggestedFix}` : ""}`, 220)}
          </Text>
        )) : <Text color={tone("muted")}>
          {detail.selfImprovement.recommendationStatus === "failed"
            ? "Audit completed, but recommendation generation failed."
            : detail.selfImprovement.auditStatus === "pending" || detail.selfImprovement.auditStatus === "running"
              ? "Audit has not produced a fresh recommendation snapshot yet."
              : detail.selfImprovement.auditStatus === "missing"
                ? "No fresh audit snapshot is available for this objective yet."
                : "No actionable recommendations surfaced."}
        </Text>}
        {detail.selfImprovement.recurringPatterns.length ? (
          <Text color={tone("muted")}>
            {truncate(`Patterns: ${detail.selfImprovement.recurringPatterns.map((pattern) => `${pattern.pattern} x${pattern.count}`).join(", ")}`, 220)}
          </Text>
        ) : null}
        {detail.selfImprovement.autoFixObjectiveId ? (
          <Text color={tone("selection")}>Auto-fix objective: {detail.selfImprovement.autoFixObjectiveId}</Text>
        ) : null}
      </Box>
    ) : null}
    <Box marginTop={1} flexWrap="wrap">
      <MetricCell label="Queue" value={`${detail.scheduler.slotState}${detail.scheduler.queuePosition ? ` · ${detail.scheduler.queuePosition}` : ""}`} />
      <MetricCell label="Head" value={shortHash(detail.latestCommitHash)} />
      <MetricCell label="Checks" value={formatList(detail.checks, "none")} />
    </Box>
  </Box>
);

const TasksPanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    {detail.tasks.length ? detail.tasks.map((task) => (
      <Box
        key={task.taskId}
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
        <Text color={tone("text")}>{truncate(task.title, 48)}</Text>
        <Text color={tone("muted")}>{task.workerType} · {task.taskKind} · {task.jobStatus ?? "no job"}</Text>
        {task.dependsOn.length ? <Text color={tone("muted")}>Depends on {task.dependsOn.join(", ")}</Text> : null}
        {task.latestSummary ? <Text color={tone("muted")}>{truncate(task.latestSummary, 180)}</Text> : null}
      </Box>
    )) : <Text color={tone("muted")}>No tasks yet.</Text>}
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
        {candidate.summary ? <Text color={tone("text")}>{truncate(candidate.summary, 180)}</Text> : null}
      </Box>
    )) : <Text color={tone("muted")}>No candidates yet.</Text>}
  </Box>
);

const EvidencePanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    {detail.evidenceCards.length ? detail.evidenceCards.map((card) => (
      <Box key={`${card.receiptHash ?? card.title}-${card.at}`} flexDirection="column" marginBottom={1}>
        <Text bold color={tone("text")}>{truncate(card.title, 44)}</Text>
        <Text color={tone("muted")}>{formatTime(card.at)} · {card.receiptType}</Text>
        <Text color={tone("text")}>{truncate(card.summary, 180)}</Text>
      </Box>
    )) : <Text color={tone("muted")}>No evidence cards yet.</Text>}
  </Box>
);

const ReportPanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    {buildInvestigationReportSections(detail).map((entry) => (
      <Box key={entry.title} flexDirection="column" marginBottom={1}>
        <Text bold color={tone("text")}>{entry.title}</Text>
        {entry.lines.map((line, index) => (
          <Text key={`${entry.title}:${index}`} color={tone("muted")}>
            {entry.title === "Report" || entry.title === "Conclusion" ? truncate(line, 220) : truncate(`- ${line}`, 220)}
          </Text>
        ))}
      </Box>
    ))}
  </Box>
);

const ActivityPanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    {detail.activity.length ? detail.activity.map((entry) => (
      <Box key={`${entry.kind}-${entry.at}-${entry.title}`} flexDirection="column" marginBottom={1}>
        <Text bold color={tone("text")}>{truncate(entry.title, 44)}</Text>
        <Text color={tone("muted")}>{formatTime(entry.at)} · {entry.kind}</Text>
        <Text color={tone("text")}>{truncate(entry.summary, 180)}</Text>
      </Box>
    )) : <Text color={tone("muted")}>No activity yet.</Text>}
  </Box>
);

const LivePanel = ({ live }: { readonly live: FactoryLiveProjection }): React.ReactElement => (
  <Box flexDirection="column">
    {live.activeTasks.length ? live.activeTasks.map((task) => <LiveTaskCard key={task.taskId} task={task} />) : <Text color={tone("muted")}>No active task output right now.</Text>}
  </Box>
);

const DebugPanel = ({ debug }: { readonly debug: FactoryDebugProjection }): React.ReactElement => (
  <Box flexDirection="column">
    <Text color={tone("muted")}>
      Profile {debug.profile.rootProfileLabel} · skills {debug.profile.selectedSkills.length} · shared artifacts {debug.contextSources.sharedArtifactRefs.length}
    </Text>
    <Box marginTop={1} flexDirection="column">
      <Text bold color={tone("text")}>Next action</Text>
      <Text color={tone("muted")}>{truncate(debug.nextAction, 220) || "No next action."}</Text>
      <Text color={tone("muted")}>
        Active jobs {debug.activeJobs.length} · Recent jobs {debug.lastJobs.length} · Context packs {debug.latestContextPacks.length}
      </Text>
    </Box>
  </Box>
);

const ReceiptsPanel = ({ detail }: { readonly detail: FactoryObjectiveDetail }): React.ReactElement => (
  <Box flexDirection="column">
    {detail.recentReceipts.length ? detail.recentReceipts.map((receipt) => (
      <Box key={receipt.hash} flexDirection="column" marginBottom={1}>
        <Text bold color={tone("text")}>{truncate(receipt.type, 40)}</Text>
        <Text color={tone("muted")}>{formatTime(receipt.ts)} · {shortHash(receipt.hash)}</Text>
        <Text color={tone("text")}>{truncate(receipt.summary, 180)}</Text>
      </Box>
    )) : <Text color={tone("muted")}>No receipts yet.</Text>}
  </Box>
);

const AnalysisPanel = ({ analysis }: { readonly analysis?: ObjectiveAnalysis }): React.ReactElement => {
  if (!analysis) {
    return <Text color={tone("muted")}>Analysis is not available for this objective yet.</Text>;
  }
  return (
    <Box flexDirection="column">
      {analysis.latestSummary ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={tone("text")}>Current signal</Text>
          <Text color={tone("text")}>{truncate(analysis.latestSummary, 220)}</Text>
        </Box>
      ) : null}
      <Box flexWrap="wrap">
        <MetricCell label="Concurrency" value={`${analysis.metrics.objective.maxObservedActiveTasks}/${analysis.metrics.objective.concurrencyLimit}`} />
        <MetricCell label="Control jobs" value={String(analysis.metrics.jobs.controlJobs)} />
        <MetricCell label="Tool errors" value={`${analysis.metrics.agent.toolErrors}/${analysis.metrics.agent.toolCalls}`} />
        <MetricCell label="Run mismatch" value={String(analysis.metrics.agent.mismatchedRuns)} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold color={tone("text")}>Top tools</Text>
        {analysis.metrics.agent.topTools.length ? analysis.metrics.agent.topTools.slice(0, 5).map((tool) => (
          <Text key={tool.tool} color={tool.errorCount > 0 ? tone("warning") : tone("muted")}>
            {truncate(`${tool.tool} · ${tool.count} calls · ${tool.errorCount} errors`, 120)}
          </Text>
        )) : <Text color={tone("muted")}>No tool calls recorded.</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold color={tone("text")}>Anomalies</Text>
        {analysis.anomalies.length ? analysis.anomalies.slice(0, 6).map((anomaly, index) => (
          <Text key={`${anomaly.kind}:${index}`} color={anomaly.severity === "high" ? tone("danger") : anomaly.severity === "medium" ? tone("warning") : tone("muted")}>
            {truncate(`${anomaly.kind} · ${anomaly.summary}`, 220)}
          </Text>
        )) : <Text color={tone("muted")}>No anomalies detected.</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold color={tone("text")}>Recommendations</Text>
        {analysis.recommendations.length ? analysis.recommendations.slice(0, 4).map((recommendation, index) => (
          <Text key={`${index}:${recommendation}`} color={tone("muted")}>{truncate(`- ${recommendation}`, 220)}</Text>
        )) : <Text color={tone("muted")}>No recommendations surfaced.</Text>}
      </Box>
    </Box>
  );
};

const ExecutionWorkbenchRail = ({
  detail,
  live,
}: {
  readonly detail: FactoryObjectiveDetail;
  readonly live: FactoryLiveProjection;
}): React.ReactElement | null => {
  const workbench = buildFactoryWorkbench({
    detail,
    recentJobs: live.recentJobs,
  });
  if (!workbench || !workbench.hasActiveExecution) return null;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold color={tone("text")}>Running Task</Text>
      <Text color={tone("muted")}>
        {formatDuration(workbench.summary.elapsedMinutes * 60_000)} · {workbench.summary.activeTaskCount} active · {workbench.summary.activeJobCount} jobs
      </Text>
      <Box marginTop={1} flexDirection="column">
        {workbench.tasks.map((task) => (
          <Box key={task.taskId} flexDirection="column" marginBottom={1}>
            <Text color={task.taskId === workbench.focusedTask?.taskId ? tone("selection") : tone("text")} bold={task.taskId === workbench.focusedTask?.taskId}>
              {task.taskId} · {truncate(task.title, 34)}
            </Text>
            <Text color={tone("muted")}>
              {labelize(task.jobStatus ?? task.status)} · {task.workerType}
              {task.isActive ? " · active" : task.isReady ? " · ready" : ""}
            </Text>
            {task.dependencySummary ? <Text color={tone("muted")}>{truncate(task.dependencySummary, 64)}</Text> : null}
          </Box>
        ))}
      </Box>
      {workbench.focusedTask ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={tone("text")}>Focus Detail</Text>
          <Text color={tone("text")}>{truncate(workbench.focusedTask.title, 50)}</Text>
          <Text color={tone("muted")}>{truncate(workbench.focusedTask.prompt, 220)}</Text>
          <Text color={tone("muted")}>
            Workspace {workbench.focusedTask.workspaceExists ? (workbench.focusedTask.workspaceDirty ? "dirty" : "clean") : "missing"}
            {workbench.focusedTask.workspaceHead ? ` · ${shortHash(workbench.focusedTask.workspaceHead)}` : ""}
          </Text>
          <Text color={tone("muted")}>
            Checks {detail.checks.length ? formatList(detail.checks, "none") : "none"}
          </Text>
        </Box>
      ) : null}
      {workbench.focus ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={tone("text")}>Live Stream</Text>
          {workbench.focus.lastMessage ? <Text color={tone("text")}>{truncate(workbench.focus.lastMessage, 180)}</Text> : null}
          {workbench.focus.stdoutTail ? <Text color={tone("muted")}>{truncate(workbench.focus.stdoutTail, 180)}</Text> : null}
          {workbench.focus.stderrTail ? <Text color={tone("danger")}>{truncate(workbench.focus.stderrTail, 180)}</Text> : null}
        </Box>
      ) : null}
      {workbench.activity.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={tone("text")}>Recent Activity</Text>
          {workbench.activity.slice(0, 4).map((entry) => (
            <Box key={entry.id} flexDirection="column" marginBottom={1}>
              <Text color={tone("text")}>{truncate(entry.title, 42)}</Text>
              <Text color={tone("muted")}>{truncate(entry.summary, 180)}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
};

const ObjectivePanelContent = ({
  detail,
  live,
  debug,
  analysis,
  panel,
}: {
  readonly detail: FactoryObjectiveDetail;
  readonly live: FactoryLiveProjection;
  readonly debug: FactoryDebugProjection;
  readonly analysis?: ObjectiveAnalysis;
  readonly panel: FactoryObjectivePanel;
}): React.ReactElement => {
  switch (panel) {
    case "overview":
      return <OverviewPanel detail={detail} />;
    case "report":
      return <ReportPanel detail={detail} />;
    case "tasks":
      return <TasksPanel detail={detail} />;
    case "candidates":
      return <CandidatesPanel detail={detail} />;
    case "evidence":
      return <EvidencePanel detail={detail} />;
    case "activity":
      return <ActivityPanel detail={detail} />;
    case "live":
      return <LivePanel live={live} />;
    case "debug":
      return <DebugPanel debug={debug} />;
    case "receipts":
      return <ReceiptsPanel detail={detail} />;
    case "analysis":
      return <AnalysisPanel analysis={analysis} />;
    default:
      return <OverviewPanel detail={detail} />;
  }
};

const RightRail = ({
  detail,
  live,
  debug,
  analysis,
  panel,
  compact,
}: {
  readonly detail?: FactoryObjectiveDetail;
  readonly live?: FactoryLiveProjection;
  readonly debug?: FactoryDebugProjection;
  readonly analysis?: ObjectiveAnalysis;
  readonly panel: FactoryObjectivePanel;
  readonly compact: boolean;
}): React.ReactElement => (
  <Surface
    kicker="Inspector"
    title={detail ? `${PANEL_LABELS[panel]} panel` : "Objective inspector"}
    subtitle={detail ? `${detail.objectiveId} · ${labelize(detail.displayState ?? detail.phase)}${detail.phaseDetail ? ` · ${labelize(detail.phaseDetail)}` : ""}` : "Select an objective to inspect receipts, evidence, and controls."}
    width={compact ? 40 : 46}
    marginBottom={1}
  >
    {detail && live && debug ? (
      <Box flexDirection="column">
        <Box flexWrap="wrap" marginBottom={1}>
          <Box marginRight={1}><StateBadge value={detail.displayState ?? detail.phase} /></Box>
          {detail.phaseDetail ? <Box marginRight={1}><StateBadge value={detail.phaseDetail} /></Box> : null}
          <Box marginRight={1}><StateBadge value={detail.scheduler.slotState} /></Box>
          <Box marginRight={1}><StateBadge value={detail.integration.status} /></Box>
        </Box>
        <Text color={tone("muted")}>Objective budget</Text>
        <ProgressBar value={budgetPercent(detail.budgetState.elapsedMinutes, detail.policy.budgets.maxObjectiveMinutes)} />
        <Text color={tone("muted")}>
          {detail.budgetState.elapsedMinutes}m / {detail.policy.budgets.maxObjectiveMinutes}m
        </Text>
        <Text color={tone("muted")}>Task budget</Text>
        <ProgressBar value={budgetPercent(detail.budgetState.taskRunsUsed, detail.policy.budgets.maxTaskRuns)} />
        <Text color={tone("muted")}>
          {detail.budgetState.taskRunsUsed} / {detail.policy.budgets.maxTaskRuns} task runs
        </Text>
        <Box marginTop={1}>
          <Text color={tone("text")}>{truncate(detail.nextAction ?? "No next action.", 180)}</Text>
        </Box>
        <Box marginTop={1} flexWrap="wrap">
          <MetricCell label="Mode" value={labelize(detail.objectiveMode)} />
          <MetricCell label="Severity" value={String(detail.severity)} />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold color={tone("text")}>Panel</Text>
          <PanelTabs panel={panel} />
          <ObjectivePanelContent detail={detail} live={live} debug={debug} analysis={analysis} panel={panel} />
        </Box>
      </Box>
    ) : (
      <EmptyState title="No objective selected" message="Pick an objective from the rail or describe a new one below." />
    )}
  </Surface>
);

const ComposerBox = ({
  draft,
  focused,
  title,
  subtitle,
  placeholder,
  submitHint,
}: {
  readonly draft: string;
  readonly focused: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly placeholder: string;
  readonly submitHint: string;
}): React.ReactElement => {
  const lines = draft.length
    ? draft.split("\n")
    : [placeholder];
  return (
    <Surface
      kicker="Chat"
      title={title}
      subtitle={subtitle}
      borderColor={focused ? tone("selection") : tone("border")}
    >
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Text key={`${index}:${line}`} color={draft.length ? tone("text") : tone("muted")}>
            {index === lines.length - 1 && focused ? `${line}${terminalTheme.unicodeEnabled ? "▌" : "_"}` : line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} justifyContent="space-between">
        <Text color={tone("hotkey")}>{submitHint}</Text>
        <Text color={tone("muted")}>/help for commands</Text>
      </Box>
    </Surface>
  );
};

const FooterStatus = ({
  busy,
  error,
  message,
}: {
  readonly busy?: string;
  readonly error?: string;
  readonly message: string;
}): React.ReactElement => (
  <Box flexDirection="column" marginTop={1}>
    <Box flexWrap="wrap">
      {HOTKEYS.map(([keyLabel, label]) => (
        <Box key={keyLabel} marginRight={1}>
          <Text color={tone("hotkey")}>[{keyLabel}]</Text>
          <Text color={tone("muted")}> {label}</Text>
        </Box>
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

const HelpOverlay = (): React.ReactElement => (
  <Surface
    kicker="Command Help"
    title="Slash commands"
    subtitle="Plain text creates a new objective when nothing is selected, otherwise it reacts to the selected objective. Active-job commands target the latest running or queued job for the selected objective."
    marginBottom={1}
  >
    {COMPOSER_COMMANDS.map((command) => (
      <Text key={command.name} color={tone("text")}>{command.usage}</Text>
    ))}
  </Surface>
);

const FactoryWorkbenchScreen = ({
  snapshot,
  selectedObjectiveId,
  panel,
  draft,
  focusArea,
  compact,
  stacked,
  railVisible,
  showComposer,
  busy,
  error,
  message,
  showHelp,
}: {
  readonly snapshot: FactoryWorkbenchSnapshot;
  readonly selectedObjectiveId?: string;
  readonly panel: FactoryObjectivePanel;
  readonly draft: string;
  readonly focusArea: FactoryWorkbenchFocusArea;
  readonly compact: boolean;
  readonly stacked: boolean;
  readonly railVisible: boolean;
  readonly showComposer: boolean;
  readonly busy?: string;
  readonly error?: string;
  readonly message: string;
  readonly showHelp: boolean;
}): React.ReactElement => {
  const model = buildFactoryWorkbenchViewModel({
    compose: snapshot.compose,
    board: snapshot.board,
    detail: snapshot.detail,
    live: snapshot.live,
    debug: snapshot.debug,
  });
  return (
    <FactoryThemeProvider>
      <Box flexDirection="column">
        <Surface
          kicker="Workbench"
          title="Factory CLI"
          subtitle="One consolidated terminal surface for objective selection, execution state, inspection, and chat."
          marginBottom={1}
          right={<StateBadge value={snapshot.detail?.displayState ?? snapshot.detail?.integration.status ?? "planning"} />}
        >
          <Box flexWrap="wrap">
            <MetricCell label="Repo" value={model.header.repo} />
            <MetricCell label="Dirty" value={model.header.dirty ? "yes" : "no"} />
            <MetricCell label="Objectives" value={String(model.header.objectiveCount)} />
            <MetricCell label="Checks" value={model.header.checks} />
            <MetricCell label="Queue" value={model.header.queueSummary} />
          </Box>
          <Text color={tone("muted")}>{model.header.profileSummary}</Text>
          <Text color={tone("muted")}>Selected: {model.header.selectedObjectiveLabel}</Text>
        </Surface>
        {showHelp ? <HelpOverlay /> : null}
        <Box flexDirection={stacked ? "column" : "row"}>
          {railVisible ? (
            <Surface
              kicker="Objectives"
              title="Queue"
              subtitle="Receipt-backed objectives grouped by operational state."
              width={stacked ? undefined : compact ? 34 : 40}
              marginRight={stacked ? 0 : 1}
              marginBottom={1}
              borderColor={focusArea === "rail" ? tone("selection") : tone("border")}
            >
              <ObjectiveRail board={snapshot.board} selectedObjectiveId={selectedObjectiveId} compact={compact} />
            </Surface>
          ) : null}
          <Box flexGrow={1} flexDirection={stacked ? "column" : "row"}>
            <Box flexGrow={1} flexDirection="column">
              <WorkbenchPane
                snapshot={snapshot}
                railVisible={railVisible}
                focused={focusArea === "timeline"}
              />
              {showComposer ? (
                <ComposerBox
                  draft={draft}
                  focused={focusArea === "composer"}
                  title={model.composer.title}
                  subtitle={model.composer.subtitle}
                  placeholder={model.composer.placeholder}
                  submitHint={model.composer.submitHint}
                />
              ) : null}
            </Box>
            <RightRail
              detail={snapshot.detail}
              live={snapshot.live}
              debug={snapshot.debug}
              analysis={snapshot.analysis}
              panel={panel}
              compact={compact}
            />
          </Box>
        </Box>
        <FooterStatus busy={busy} error={error} message={message} />
      </Box>
    </FactoryThemeProvider>
  );
};

const cycleFocus = (
  current: FactoryWorkbenchFocusArea,
  opts: { readonly hasObjectives: boolean; readonly hasDetail: boolean },
): FactoryWorkbenchFocusArea => {
  const order: FactoryWorkbenchFocusArea[] = opts.hasObjectives && opts.hasDetail
    ? ["rail", "timeline", "composer"]
    : opts.hasObjectives
      ? ["rail", "composer", "timeline"]
      : ["composer", "timeline", "rail"];
  const index = order.indexOf(current);
  return order[(index + 1 + order.length) % order.length];
};

const nextPanel = (panel: FactoryObjectivePanel, delta: number): FactoryObjectivePanel => {
  const current = PANEL_ORDER.indexOf(panel);
  const normalized = current < 0 ? 0 : current;
  return PANEL_ORDER[(normalized + delta + PANEL_ORDER.length) % PANEL_ORDER.length] ?? "overview";
};

export const FactoryTerminalApp = ({
  runtime,
  initialObjectiveId,
  initialPanel = "overview",
  exitOnTerminal = false,
  onExit,
}: FactoryTerminalAppProps): React.ReactElement => {
  const { exit } = useApp();
  const [selectedObjectiveId, setSelectedObjectiveId] = useState<string | undefined>(initialObjectiveId);
  const [panel, setPanel] = useState<FactoryObjectivePanel>(initialPanel);
  const [focusArea, setFocusArea] = useState<FactoryWorkbenchFocusArea>(initialObjectiveId ? "composer" : "rail");
  const [draft, setDraft] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [showRail, setShowRail] = useState((process.stdout.columns ?? 120) >= 110);
  const [snapshot, setSnapshot] = useState<FactoryWorkbenchSnapshot>();
  const [message, setMessage] = useState<string>("Loading Factory workbench...");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [terminalWidth, setTerminalWidth] = useState<number>(process.stdout.columns ?? 120);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exitRef = useRef(false);
  const selectedObjectiveIdRef = useRef<string | undefined>(initialObjectiveId);
  const busyRef = useRef<string | undefined>(undefined);

  const selectedList = snapshot?.board ? flattenObjectives(snapshot.board) : [];
  const compact = terminalWidth < 140;
  const stacked = terminalWidth < 118;
  const railVisible = !stacked || showRail;

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const safeExit = (result: FactoryAppExit): void => {
    if (exitRef.current) return;
    exitRef.current = true;
    onExit(result);
    exit();
  };

  const refresh = async (panelOverride: FactoryObjectivePanel = panel): Promise<void> => {
    try {
      setError(undefined);
      const compose = await runtime.service.buildComposeModel();
      const board = await runtime.service.buildBoardProjection(selectedObjectiveIdRef.current);
      const objectives = flattenObjectives(board);
      const retained = selectedObjectiveIdRef.current && objectives.some((objective) => objective.objectiveId === selectedObjectiveIdRef.current)
        ? selectedObjectiveIdRef.current
        : undefined;
      const nextSelected = retained ?? board.selectedObjectiveId ?? objectives[0]?.objectiveId;
      selectedObjectiveIdRef.current = nextSelected;
      setSelectedObjectiveId(nextSelected);
      if (!nextSelected) {
        await runtime.focusObjective(undefined);
        runtime.trackTaskLogs(undefined, []);
        setSnapshot({ compose, board });
        if (!busyRef.current) setMessage("Factory ready. Describe the next objective below.");
        return;
      }
      const [detail, live, debug] = await Promise.all([
        runtime.service.getObjective(nextSelected),
        runtime.service.buildLiveProjection(nextSelected),
        runtime.service.getObjectiveDebug(nextSelected),
      ]);
      const analysis = panelOverride === "analysis"
        ? await readObjectiveAnalysis(runtime.service.dataDir, nextSelected).catch(() => undefined)
        : undefined;
      await runtime.focusObjective(nextSelected);
      runtime.trackTaskLogs(nextSelected, detail.tasks);
      setSnapshot({ compose, board, detail, live, debug, analysis });
      if (!busyRef.current) {
        setMessage(`Watching ${detail.objectiveId} · ${labelize(detail.phase)} · ${labelize(detail.integration.status)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const scheduleRefresh = (delayMs: number): void => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = undefined;
      void refresh();
    }, delayMs);
  };

  useEffect(() => {
    const onResize = (): void => {
      const width = process.stdout.columns ?? 120;
      setTerminalWidth(width);
      if (width >= 110) setShowRail(true);
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  useEffect(() => {
    void refresh(panel);
  }, [panel]);

  useEffect(() => {
    let closed = false;
    void refresh();
    const unsubscribe = runtime.subscribe((event) => {
      if (closed) return;
      if (event.type === "worker_error") {
        setError(event.error.message);
      } else if (!busyRef.current) {
        if (event.type === "queue_changed") setMessage(`Queue update · ${formatTime(event.at)}`);
        if (event.type === "objective_changed") setMessage(`Objective update · ${event.objectiveId}`);
        if (event.type === "log_updated") setMessage(`Streaming ${event.stream} · ${event.taskId ?? event.objectiveId}`);
      }
      scheduleRefresh(event.type === "log_updated" ? 50 : 75);
    });
    const fallback = setInterval(() => {
      scheduleRefresh(200);
    }, 30_000);
    return () => {
      closed = true;
      unsubscribe();
      clearInterval(fallback);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = undefined;
      }
    };
  }, [runtime]);

  useEffect(() => {
    if (!exitOnTerminal || !snapshot?.detail) return;
    const terminal = exitForDetail(snapshot.detail);
    if (terminal) safeExit(terminal);
  }, [
    exitOnTerminal,
    snapshot?.detail?.status,
    snapshot?.detail?.integration.status,
    snapshot?.detail?.policy.promotion.autoPromote,
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

  const resolveWatchObjectiveId = (value: string | undefined): string | undefined => {
    if (!value) return selectedObjectiveIdRef.current;
    const exact = selectedList.find((objective) => objective.objectiveId === value);
    if (exact) return exact.objectiveId;
    const prefix = selectedList.find((objective) => objective.objectiveId.startsWith(value));
    return prefix?.objectiveId;
  };

  const submitDraft = async (): Promise<void> => {
    const parsed = parseComposerDraft(draft, selectedObjectiveIdRef.current);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setShowHelp(false);
    const command = parsed.command;
    if (command.type === "help") {
      setShowHelp(true);
      setDraft("");
      setMessage("Showing chat command help.");
      return;
    }
    if (command.type === "watch") {
      const next = resolveWatchObjectiveId(command.objectiveId);
      if (!next) {
        setError(`Objective '${command.objectiveId ?? ""}' was not found.`);
        return;
      }
      setSelectedObjectiveId(next);
      selectedObjectiveIdRef.current = next;
      setPanel("overview");
      setDraft("");
      await refresh();
      setMessage(`Focused ${next}.`);
      return;
    }
    if (command.type === "new") {
      await runAction("Creating objective", async () => {
        const created = await createObjectiveMutation(runtime, {
          prompt: command.prompt,
          title: command.title,
          objectiveMode: command.objectiveMode,
          checks: runtime.config.defaultChecks,
          policy: runtime.config.defaultPolicy,
        });
        selectedObjectiveIdRef.current = created.objectiveId;
        setSelectedObjectiveId(created.objectiveId);
        setPanel("overview");
        setFocusArea("composer");
      });
      setDraft("");
      return;
    }
    const objectiveId = selectedObjectiveIdRef.current;
    if (!objectiveId) {
      setError("Select an objective first.");
      return;
    }
    switch (command.type) {
      case "react":
        await runAction("Reacting objective", async () => {
          await reactObjectiveMutation(runtime, {
            objectiveId,
            message: command.message,
          });
        });
        setDraft("");
        return;
      case "promote":
        await runAction("Promoting objective", async () => {
          await promoteObjectiveMutation(runtime, objectiveId);
        });
        setDraft("");
        return;
      case "cancel":
        await runAction("Canceling objective", async () => {
          await cancelObjectiveMutation(runtime, {
            objectiveId,
            reason: command.reason ?? "canceled from CLI",
          });
        });
        setDraft("");
        return;
      case "cleanup":
        await runAction("Cleaning workspaces", async () => {
          await cleanupObjectiveMutation(runtime, objectiveId);
        });
        setDraft("");
        return;
      case "archive":
        await runAction("Archiving objective", async () => {
          await archiveObjectiveMutation(runtime, objectiveId);
        });
        setDraft("");
        return;
      case "abort-job":
        await runAction("Requesting job abort", async () => {
          const activeJob = requireActiveObjectiveJob(snapshot?.detail, snapshot?.live);
          await abortJobMutation(runtime, {
            jobId: activeJob.id,
            reason: command.reason ?? "abort requested from CLI",
          });
        });
        setDraft("");
        return;
      case "steer":
        await runAction("Sending steer guidance", async () => {
          const activeJob = requireActiveObjectiveJob(snapshot?.detail, snapshot?.live);
          await steerJobMutation(runtime, {
            jobId: activeJob.id,
            message: command.message ?? "",
          });
        });
        setDraft("");
        return;
      case "follow-up":
        await runAction("Sending follow-up guidance", async () => {
          const activeJob = requireActiveObjectiveJob(snapshot?.detail, snapshot?.live);
          await followUpJobMutation(runtime, {
            jobId: activeJob.id,
            message: command.message ?? "",
          });
        });
        setDraft("");
        return;
      default:
        return;
    }
  };

  const moveSelection = (delta: number): void => {
    if (!selectedList.length) return;
    const currentIndex = selectedObjectiveIdRef.current
      ? selectedList.findIndex((objective) => objective.objectiveId === selectedObjectiveIdRef.current)
      : -1;
    const normalized = currentIndex < 0 ? 0 : currentIndex;
    const next = selectedList[(normalized + delta + selectedList.length) % selectedList.length];
    if (!next) return;
    selectedObjectiveIdRef.current = next.objectiveId;
    setSelectedObjectiveId(next.objectiveId);
    void refresh();
  };

  useInput((input, key) => {
    if (busy) return;
    if (key.tab) {
      setFocusArea((current) => cycleFocus(current, { hasObjectives: selectedList.length > 0, hasDetail: Boolean(snapshot?.detail) }));
      return;
    }
    if (input === "q") {
      safeExit({ code: 0, reason: "quit", objectiveId: selectedObjectiveIdRef.current });
      return;
    }
    if (input === "?") {
      setShowHelp((current) => !current);
      return;
    }
    if (input === "o") {
      setShowRail((current) => !current);
      return;
    }
    if (key.escape) {
      if (showHelp) {
        setShowHelp(false);
        return;
      }
      if (draft) {
        setDraft("");
        return;
      }
      setFocusArea(snapshot?.detail ? "timeline" : "rail");
      return;
    }
    if (focusArea === "composer") {
      if (key.return && key.shift) {
        setDraft((current) => `${current}\n`);
        return;
      }
      if (key.return) {
        void submitDraft();
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((current) => current.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDraft((current) => `${current}${input}`);
        return;
      }
      return;
    }
    if (input === "/") {
      setFocusArea("composer");
      setDraft((current) => current || "/");
      return;
    }
    if ((key.downArrow || input === "j") && selectedList.length > 0) {
      moveSelection(1);
      return;
    }
    if ((key.upArrow || input === "k") && selectedList.length > 0) {
      moveSelection(-1);
      return;
    }
    if ((key.leftArrow || input === "h") && snapshot?.detail) {
      setPanel((current) => nextPanel(current, -1));
      return;
    }
    if ((key.rightArrow || input === "l") && snapshot?.detail) {
      setPanel((current) => nextPanel(current, 1));
      return;
    }
    if (input === "enter" || key.return) {
      if (selectedObjectiveIdRef.current) setFocusArea("composer");
      return;
    }
    if (/^[0-9]$/.test(input)) {
      const index = input === "0" ? PANEL_ORDER.length - 1 : Number(input) - 1;
      const next = PANEL_ORDER[index];
      if (next) setPanel(next);
      return;
    }
    const objectiveId = selectedObjectiveIdRef.current;
    if (!objectiveId) return;
    if (input === "r") {
      void runAction("Reacting objective", async () => {
        await reactObjectiveMutation(runtime, { objectiveId });
      });
      return;
    }
    if (input === "p") {
      void runAction("Promoting objective", async () => {
        await promoteObjectiveMutation(runtime, objectiveId);
      });
      return;
    }
    if (input === "c") {
      void runAction("Canceling objective", async () => {
        await cancelObjectiveMutation(runtime, {
          objectiveId,
          reason: "canceled from CLI",
        });
      });
      return;
    }
    if (input === "x") {
      void runAction("Cleaning workspaces", async () => {
        await cleanupObjectiveMutation(runtime, objectiveId);
      });
      return;
    }
    if (input === "a") {
      void runAction("Archiving objective", async () => {
        await archiveObjectiveMutation(runtime, objectiveId);
      });
    }
  });

  const renderedSnapshot = useMemo<FactoryWorkbenchSnapshot>(() => {
    if (snapshot) return snapshot;
    return {
      compose: {
        defaultBranch: "main",
        sourceDirty: false,
        sourceBranch: "main",
        objectiveCount: 0,
        defaultPolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
        profileSummary: "Using checked-in Factory profiles and skills only.",
        defaultValidationCommands: runtime.config.defaultChecks,
      },
      board: {
        objectives: [],
        sections: {
          needs_attention: [],
          active: [],
          queued: [],
          completed: [],
        },
        selectedObjectiveId: undefined,
      },
    };
  }, [snapshot, runtime.config.defaultChecks]);

  return (
    <FactoryWorkbenchScreen
      snapshot={renderedSnapshot}
      selectedObjectiveId={selectedObjectiveId}
      panel={panel}
      draft={draft}
      focusArea={focusArea}
      compact={compact}
      stacked={stacked}
      railVisible={railVisible}
      showComposer
      busy={busy}
      error={error}
      message={message}
      showHelp={showHelp}
    />
  );
};
