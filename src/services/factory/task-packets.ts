import fs from "node:fs/promises";
import path from "node:path";

import type {
  FactoryCandidateRecord,
  FactoryCandidateStatus,
  FactoryExecutionScriptRun,
  FactoryInvestigationSynthesisRecord,
  FactoryInvestigationTaskReport,
  FactoryObjectiveContractRecord,
  FactoryObjectiveMode,
  FactoryObjectiveProfileSnapshot,
  FactoryObjectiveSeverity,
  FactoryPlanningReceiptRecord,
  FactoryState,
  FactoryTaskExecutionMode,
  FactoryTaskRecord,
  FactoryTaskStatus,
  FactoryWorkerType,
} from "../../modules/factory";
import type { FactoryCloudExecutionContext } from "../factory-cloud-context";
import type { FactoryHelperContext } from "../factory-helper-catalog";
import type { FactoryArtifactActivity, FactoryContextSources } from "../factory-types";

export const FACTORY_TASK_PACKET_DIR = ".receipt/factory";

export type FactoryMemoryScopeSpec = {
  readonly key: string;
  readonly scope: string;
  readonly label: string;
  readonly defaultQuery: string;
};

export type FactoryContextTaskNode = {
  readonly taskId: string;
  readonly taskKind: FactoryTaskRecord["taskKind"];
  readonly title: string;
  readonly status: FactoryTaskStatus;
  readonly workerType: FactoryWorkerType;
  readonly sourceTaskId?: string;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly candidateId?: string;
  readonly candidateStatus?: FactoryCandidateStatus;
  readonly memorySummary?: string;
  readonly children: ReadonlyArray<FactoryContextTaskNode>;
};

export type FactoryContextRelatedTask = {
  readonly taskId: string;
  readonly taskKind: FactoryTaskRecord["taskKind"];
  readonly title: string;
  readonly status: FactoryTaskStatus;
  readonly workerType: FactoryWorkerType;
  readonly sourceTaskId?: string;
  readonly relations: ReadonlyArray<"focus" | "dependency" | "dependent">;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly candidateId?: string;
  readonly candidateStatus?: FactoryCandidateStatus;
  readonly memorySummary?: string;
};

export type FactoryContextReceipt = {
  readonly type: string;
  readonly at: number;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly summary: string;
};

export type FactoryContextObjectiveSlice = {
  readonly frontierTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly recentCompletedTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly integrationTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly recentObjectiveReceipts: ReadonlyArray<FactoryContextReceipt>;
  readonly objectiveMemorySummary?: string;
  readonly integrationMemorySummary?: string;
};

type FactoryContextAwsExecutionContext = Omit<NonNullable<FactoryCloudExecutionContext["aws"]>, "ec2RegionScope"> & {
  readonly ec2RegionScope?: Pick<
    NonNullable<NonNullable<FactoryCloudExecutionContext["aws"]>["ec2RegionScope"]>,
    "queryableRegions" | "skippedRegions"
  >;
};

type FactoryContextCloudExecutionContext = Omit<FactoryCloudExecutionContext, "aws"> & {
  readonly aws?: FactoryContextAwsExecutionContext;
};

export type FactoryContextPack = {
  readonly objectiveId: string;
  readonly title: string;
  readonly prompt: string;
  readonly objectiveMode: FactoryObjectiveMode;
  readonly severity: FactoryObjectiveSeverity;
  readonly planning?: FactoryPlanningReceiptRecord;
  readonly contract: FactoryObjectiveContractRecord;
  readonly cloudExecutionContext?: FactoryContextCloudExecutionContext;
  readonly profile: FactoryObjectiveProfileSnapshot;
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly prompt: string;
    readonly workerType: FactoryWorkerType;
    readonly executionMode: FactoryTaskExecutionMode;
    readonly status: FactoryTaskStatus;
    readonly candidateId: string;
  };
  readonly integration: {
    readonly status: FactoryState["integration"]["status"];
    readonly headCommit?: string;
    readonly activeCandidateId?: string;
    readonly conflictReason?: string;
    readonly lastSummary?: string;
  };
  readonly dependencyTree: ReadonlyArray<FactoryContextTaskNode>;
  readonly relatedTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly candidateLineage: ReadonlyArray<{
    readonly candidateId: string;
    readonly parentCandidateId?: string;
    readonly status: FactoryCandidateStatus;
    readonly summary?: string;
    readonly handoff?: string;
    readonly headCommit?: string;
    readonly latestReason?: string;
    readonly scriptsRun?: ReadonlyArray<FactoryExecutionScriptRun>;
  }>;
  readonly recentReceipts: ReadonlyArray<FactoryContextReceipt>;
  readonly objectiveSlice: FactoryContextObjectiveSlice;
  readonly memory: {
    readonly overview?: string;
    readonly objective?: string;
    readonly integration?: string;
  };
  readonly investigation: {
    readonly reports: ReadonlyArray<FactoryInvestigationTaskReport>;
    readonly synthesized?: FactoryInvestigationSynthesisRecord;
  };
  readonly helperCatalog?: FactoryHelperContext;
  readonly contextSources: FactoryContextSources;
};

export type FactoryTaskPacketPaths = {
  readonly manifestPath: string;
  readonly contextSummaryPath: string;
  readonly contextPackPath: string;
  readonly promptPath: string;
  readonly resultPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly lastMessagePath: string;
  readonly skillBundlePath: string;
  readonly memoryScriptPath: string;
  readonly memoryConfigPath: string;
};

export type FactoryIntegrationPacketPaths = {
  readonly resultPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
};

const clipText = (value: string | undefined, max = 280): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const formatContractLines = (
  title: string,
  items: ReadonlyArray<string>,
): ReadonlyArray<string> => items.length > 0 ? [title, ...items.map((item) => `- ${item}`), ""] : [];

export const buildTaskMemoryScopes = (
  state: FactoryState,
  task: FactoryTaskRecord,
  candidateId: string,
  taskPrompt = task.prompt,
): ReadonlyArray<FactoryMemoryScopeSpec> => {
  const baseQuery = `${state.title}\n${task.title}\n${taskPrompt}`;
  return [
    {
      key: "agent",
      scope: `factory/agents/${String(task.workerType)}`,
      label: `Agent memory (${String(task.workerType)})`,
      defaultQuery: baseQuery,
    },
    {
      key: "repo",
      scope: "factory/repo/shared",
      label: "Repo shared memory",
      defaultQuery: `${state.title}\n${task.title}`,
    },
    {
      key: "objective",
      scope: `factory/objectives/${state.objectiveId}`,
      label: "Objective memory",
      defaultQuery: state.title,
    },
    {
      key: "task",
      scope: `factory/objectives/${state.objectiveId}/tasks/${task.taskId}`,
      label: "Task memory",
      defaultQuery: task.title,
    },
    {
      key: "candidate",
      scope: `factory/objectives/${state.objectiveId}/candidates/${candidateId}`,
      label: "Candidate memory",
      defaultQuery: `${candidateId}\n${task.title}`,
    },
    {
      key: "integration",
      scope: `factory/objectives/${state.objectiveId}/integration`,
      label: "Integration memory",
      defaultQuery: `${state.title}\nintegration`,
    },
  ];
};

export const buildTaskFilePaths = (
  workspacePath: string,
  taskId: string,
): FactoryTaskPacketPaths => {
  const root = path.join(workspacePath, FACTORY_TASK_PACKET_DIR);
  return {
    manifestPath: path.join(root, `${taskId}.manifest.json`),
    contextSummaryPath: path.join(root, `${taskId}.context.md`),
    contextPackPath: path.join(root, `${taskId}.context-pack.json`),
    promptPath: path.join(root, `${taskId}.prompt.md`),
    resultPath: path.join(root, `${taskId}.result.json`),
    stdoutPath: path.join(root, `${taskId}.stdout.log`),
    stderrPath: path.join(root, `${taskId}.stderr.log`),
    lastMessagePath: path.join(root, `${taskId}.last-message.md`),
    skillBundlePath: path.join(root, `${taskId}.skill-bundle.json`),
    memoryScriptPath: path.join(root, `${taskId}.memory.cjs`),
    memoryConfigPath: path.join(root, `${taskId}.memory-scopes.json`),
  };
};

export const buildIntegrationFilePaths = (
  workspacePath: string,
  candidateId: string,
): FactoryIntegrationPacketPaths => {
  const root = path.join(workspacePath, FACTORY_TASK_PACKET_DIR);
  return {
    resultPath: path.join(root, `${candidateId}.integration.json`),
    stdoutPath: path.join(root, `${candidateId}.integration.stdout.log`),
    stderrPath: path.join(root, `${candidateId}.integration.stderr.log`),
  };
};

export const listTaskArtifactActivity = async (
  workspacePath: string,
  taskId: string,
  taskResultSchemaPathFor: (resultPath: string) => string,
): Promise<ReadonlyArray<FactoryArtifactActivity>> => {
  const files = buildTaskFilePaths(workspacePath, taskId);
  const root = path.dirname(files.manifestPath);
  const knownFiles = new Set([
    path.basename(files.manifestPath),
    path.basename(files.contextSummaryPath),
    path.basename(files.contextPackPath),
    path.basename(files.promptPath),
    path.basename(files.resultPath),
    path.basename(files.stdoutPath),
    path.basename(files.stderrPath),
    path.basename(files.lastMessagePath),
    path.basename(files.skillBundlePath),
    path.basename(files.memoryScriptPath),
    path.basename(files.memoryConfigPath),
    path.basename(taskResultSchemaPathFor(files.resultPath)),
  ]);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const artifacts = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name.startsWith(`${taskId}.`))
    .filter((entry) => !knownFiles.has(entry.name))
    .map(async (entry) => {
      const targetPath = path.join(root, entry.name);
      const stat = await fs.stat(targetPath).catch(() => undefined);
      if (!stat?.isFile()) return undefined;
      return {
        path: targetPath,
        label: entry.name,
        updatedAt: stat.mtimeMs,
        bytes: stat.size,
      } satisfies FactoryArtifactActivity;
    }));
  return artifacts
    .filter((artifact): artifact is FactoryArtifactActivity => Boolean(artifact))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.bytes - left.bytes || left.label.localeCompare(right.label));
};

export const summarizeTaskArtifactActivity = (
  activity: ReadonlyArray<FactoryArtifactActivity>,
): string | undefined => {
  if (activity.length === 0) return undefined;
  if (activity.length === 1) {
    return `Recent task artifact: ${activity[0]?.label}.`;
  }
  const listed = activity.slice(0, 2).map((artifact) => artifact.label).join(", ");
  const extra = activity.length > 2 ? ` +${activity.length - 2} more` : "";
  return `Recent task artifacts: ${listed}${extra}.`;
};

export const renderTaskContextSummary = (pack: FactoryContextPack): string => {
  const taskLine = `Task: ${pack.task.taskId} · ${pack.task.title} [${pack.task.status}]`;
  const selectedHelpers = pack.helperCatalog?.selectedHelpers
    ?.slice(0, 4)
    .map((helper) => `- ${helper.id}: ${helper.description}`);
  const relatedTasks = pack.relatedTasks
    .slice(0, 8)
    .map((task) => `- ${task.taskId} [${task.relations.join(", ")}] · ${task.title} [${task.status}]${task.memorySummary ? ` · ${task.memorySummary}` : ""}`);
  const candidateLineage = pack.candidateLineage
    .slice(-6)
    .map((candidate) => `- ${candidate.candidateId} [${candidate.status}]${candidate.summary ? ` · ${candidate.summary}` : ""}${candidate.handoff && candidate.handoff !== candidate.summary ? ` · handoff ${candidate.handoff}` : ""}`);
  const recentReceipts = pack.recentReceipts
    .slice(-10)
    .map((receipt) => `- ${receipt.type}: ${clipText(receipt.summary, 240) ?? receipt.summary}`);
  const frontierTasks = pack.objectiveSlice.frontierTasks
    .slice(0, 8)
    .map((task) => `- ${task.taskId} · ${task.title} [${task.status}]${task.memorySummary ? ` · ${task.memorySummary}` : ""}`);
  const recentCompleted = pack.objectiveSlice.recentCompletedTasks
    .slice(0, 6)
    .map((task) => `- ${task.taskId} · ${task.title} [${task.status}]${task.memorySummary ? ` · ${task.memorySummary}` : ""}`);
  const objectiveReceipts = pack.objectiveSlice.recentObjectiveReceipts
    .slice(-8)
    .map((receipt) => `- ${receipt.type}: ${clipText(receipt.summary, 220) ?? receipt.summary}`);
  return [
    "# Factory Task Context Summary",
    "",
    `Objective: ${pack.title} (${pack.objectiveId})`,
    `Mode: ${pack.objectiveMode}`,
    `Severity: ${pack.severity}`,
    taskLine,
    `Profile: ${pack.profile.rootProfileLabel} (${pack.profile.rootProfileId})`,
    `Runtime: ${pack.task.executionMode}`,
    `Candidate: ${pack.task.candidateId}`,
    `Integration: ${pack.integration.status}${pack.integration.lastSummary ? ` · ${pack.integration.lastSummary}` : ""}`,
    pack.contextSources.profileSkillRefs.length > 0 ? `Profile skills: ${pack.contextSources.profileSkillRefs.join(", ")}` : "",
    "",
    "## What Matters",
    pack.memory.overview ? `Overview: ${pack.memory.overview}` : "",
    pack.objectiveSlice.objectiveMemorySummary ? `Objective memory: ${pack.objectiveSlice.objectiveMemorySummary}` : "",
    pack.objectiveSlice.integrationMemorySummary ? `Integration memory: ${pack.objectiveSlice.integrationMemorySummary}` : "",
    "",
    "## Objective Contract",
    `Acceptance criteria: ${pack.contract.acceptanceCriteria.length}`,
    ...pack.contract.acceptanceCriteria.map((item) => `- ${item}`),
    ...formatContractLines("Allowed scope", pack.contract.allowedScope),
    ...formatContractLines("Disallowed scope", pack.contract.disallowedScope),
    ...formatContractLines("Required checks", pack.contract.requiredChecks),
    `Proof expectation: ${pack.contract.proofExpectation}`,
    "",
    selectedHelpers && selectedHelpers.length > 0 ? "## Selected Helpers" : "",
    ...(selectedHelpers ?? []),
    "",
    pack.cloudExecutionContext?.summary ? "## Live Cloud Context" : "",
    pack.cloudExecutionContext?.summary ?? "",
    ...(pack.cloudExecutionContext?.guidance ?? []).slice(0, 3).map((item) => `- ${item}`),
    "",
    relatedTasks.length > 0 ? "## Related Tasks" : "",
    ...relatedTasks,
    "",
    candidateLineage.length > 0 ? "## Candidate Lineage" : "",
    ...candidateLineage,
    "",
    recentReceipts.length > 0 ? "## Recent Receipts" : "",
    ...recentReceipts,
    "",
    frontierTasks.length > 0 ? "## Objective Frontier" : "",
    ...frontierTasks,
    "",
    recentCompleted.length > 0 ? "## Recent Completed Tasks" : "",
    ...recentCompleted,
    "",
    objectiveReceipts.length > 0 ? "## Objective-Wide Receipts" : "",
    ...objectiveReceipts,
    "",
    "## Packet Usage",
    "Use this summary first.",
    "Use the generated memory script for scoped recall.",
    "Open the JSON context pack only when you need exact raw fields, refs, or artifact paths.",
  ].filter(Boolean).join("\n");
};
