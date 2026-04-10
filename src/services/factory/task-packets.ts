import fs from "node:fs/promises";
import path from "node:path";

import type {
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
import type { FactoryArtifactActivity, FactoryContextSources, FactoryEvidenceContent } from "../factory-types";

export const FACTORY_TASK_PACKET_DIR = ".receipt/factory";

export type FactoryMemoryScopeSpec = {
  readonly key: string;
  readonly scope: string;
  readonly label: string;
  readonly defaultQuery: string;
  readonly readOnly?: boolean;
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
    readonly taskPhase?: "collecting_evidence" | "evidence_ready" | "synthesizing";
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
    readonly repoAudit?: string;
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
  readonly evidencePath: string;
  readonly skillBundlePath: string;
  readonly memoryScriptPath: string;
  readonly memoryConfigPath: string;
  readonly receiptCliPath: string;
};

export type FactoryReadableArtifact = {
  readonly path: string;
  readonly label: string;
  readonly bytes: number;
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
      readOnly: true,
    },
    {
      key: "repo",
      scope: "factory/repo/shared",
      label: "Repo shared memory",
      defaultQuery: `${state.title}\n${task.title}`,
      readOnly: true,
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
  taskPhase?: "collecting_evidence" | "evidence_ready" | "synthesizing",
): FactoryTaskPacketPaths => {
  const root = path.join(workspacePath, FACTORY_TASK_PACKET_DIR);
  const phaseSuffix = taskPhase === "synthesizing" ? `.synthesizing` : "";
  return {
    manifestPath: path.join(root, `${taskId}${phaseSuffix}.manifest.json`),
    contextSummaryPath: path.join(root, `${taskId}${phaseSuffix}.context.md`),
    contextPackPath: path.join(root, `${taskId}${phaseSuffix}.context-pack.json`),
    promptPath: path.join(root, `${taskId}${phaseSuffix}.prompt.md`),
    resultPath: path.join(root, `${taskId}${phaseSuffix}.result.json`),
    stdoutPath: path.join(root, `${taskId}${phaseSuffix}.stdout.log`),
    stderrPath: path.join(root, `${taskId}${phaseSuffix}.stderr.log`),
    lastMessagePath: path.join(root, `${taskId}${phaseSuffix}.last-message.md`),
    evidencePath: path.join(root, `${taskId}${phaseSuffix}.evidence.json`),
    skillBundlePath: path.join(root, `${taskId}${phaseSuffix}.skill-bundle.json`),
    memoryScriptPath: path.join(root, `${taskId}${phaseSuffix}.memory.cjs`),
    memoryConfigPath: path.join(root, `${taskId}${phaseSuffix}.memory-scopes.json`),
    receiptCliPath: path.join(root, `${taskId}${phaseSuffix}.receipt-cli.md`),
  };
};

export const renderFactoryReceiptCliSurface = (input: {
  readonly objectiveId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly memoryScriptPath: string;
  readonly receiptCliPath: string;
  readonly factoryCliPrefix: string;
}): string => {
  const objectiveScope = `factory/objectives/${input.objectiveId}`;
  const taskScope = `${objectiveScope}/tasks/${input.taskId}`;
  const candidateScope = `${objectiveScope}/candidates/${input.candidateId}`;
  const integrationScope = `${objectiveScope}/integration`;
  return [
    "# Factory Receipt CLI Surface",
    "",
    "Use this bounded Receipt CLI surface before broader `receipt ...` exploration.",
    "Start with the packet and memory script. Use direct `receipt` commands only when those packet surfaces are still insufficient.",
    "",
    "## Read First",
    `1. Manifest and context pack in ${path.dirname(input.receiptCliPath)}`,
    `2. Memory script: bun ${input.memoryScriptPath} context 2800`,
    `3. Objective summary: bun ${input.memoryScriptPath} objective 1800`,
    "",
    "## Task-Worktree Safe Receipt Commands",
    `- ${input.factoryCliPrefix} inspect ${objectiveScope}`,
    `- ${input.factoryCliPrefix} trace ${objectiveScope}`,
    `- ${input.factoryCliPrefix} replay ${objectiveScope}`,
    `- ${input.factoryCliPrefix} memory read ${taskScope} --limit 6`,
    `- ${input.factoryCliPrefix} memory summarize ${taskScope} --query "<term>" --limit 6 --max-chars 1200`,
    `- ${input.factoryCliPrefix} memory summarize ${candidateScope} --query "<term>" --limit 6 --max-chars 1200`,
    `- ${input.factoryCliPrefix} memory summarize ${integrationScope} --query "<term>" --limit 6 --max-chars 1200`,
    "",
    "## Controller-Side Only",
    "Run these from the repo root or mounted controller workspace when live objective state or course correction is required:",
    `- ${input.factoryCliPrefix} factory investigate ${input.objectiveId}`,
    `- ${input.factoryCliPrefix} factory investigate ${input.taskId}`,
    `- ${input.factoryCliPrefix} factory investigate ${input.candidateId} --json`,
    "",
    "## Do Not Run From This Task Worktree",
    `- ${input.factoryCliPrefix} factory inspect`,
    `- ${input.factoryCliPrefix} factory promote`,
    `- ${input.factoryCliPrefix} factory steer`,
    `- ${input.factoryCliPrefix} factory follow-up`,
    `- ${input.factoryCliPrefix} factory abort-job`,
    "",
    "## Working Rule",
    "If the packet, memory script, and bounded commands above still do not answer the question, record the missing evidence in the handoff instead of broadening the receipt search surface ad hoc.",
  ].join("\n");
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
    path.basename(files.receiptCliPath),
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

const EVIDENCE_MAX_FILE_BYTES = 32_768;
const EVIDENCE_MAX_TOTAL_BYTES = 65_536;

const isReadableEvidenceFile = (name: string): boolean =>
  name.endsWith(".md") || name.endsWith(".json") || name.endsWith(".txt") || name.endsWith(".csv");

const readEvidenceFile = async (
  filePath: string,
  label: string,
  maxBytes: number,
): Promise<FactoryEvidenceContent | undefined> => {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) return undefined;
    const effectiveMax = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(effectiveMax);
    const handle = await fs.open(filePath, "r");
    try {
      await handle.read(buffer, 0, effectiveMax, 0);
    } finally {
      await handle.close();
    }
    return {
      path: filePath,
      label,
      content: buffer.toString("utf-8"),
      bytes: stat.size,
      truncated: stat.size > maxBytes,
    };
  } catch {
    return undefined;
  }
};

const listEvidenceDirEntries = async (
  evidenceDir: string,
): Promise<ReadonlyArray<FactoryReadableArtifact>> => {
  try {
    const entries = await fs.readdir(evidenceDir, { withFileTypes: true });
    const results = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isReadableEvidenceFile(entry.name))
        .map(async (entry) => {
          const filePath = path.join(evidenceDir, entry.name);
          const stat = await fs.stat(filePath).catch(() => undefined);
          if (!stat?.isFile()) return undefined;
          return { path: filePath, label: entry.name, bytes: stat.size };
        }),
    );
    return results
      .filter((entry): entry is FactoryReadableArtifact => Boolean(entry))
      .sort((left, right) => right.bytes - left.bytes || left.label.localeCompare(right.label));
  } catch {
    return [];
  }
};

export const listTaskReadableArtifacts = async (
  workspacePath: string,
  artifactActivity: ReadonlyArray<FactoryArtifactActivity>,
  extraReadableArtifacts: ReadonlyArray<FactoryReadableArtifact> = [],
): Promise<ReadonlyArray<FactoryReadableArtifact>> => {
  const evidenceDir = path.join(workspacePath, FACTORY_TASK_PACKET_DIR, "evidence");
  const evidenceDirEntries = await listEvidenceDirEntries(evidenceDir);
  const artifactEntries = artifactActivity
    .filter((entry) => isReadableEvidenceFile(entry.label))
    .map((entry) => ({ path: entry.path, label: entry.label, bytes: entry.bytes }));
  const deduped = new Map<string, FactoryReadableArtifact>();
  for (const entry of [...extraReadableArtifacts, ...evidenceDirEntries, ...artifactEntries]) {
    const key = `${entry.path}::${entry.label}`;
    if (!deduped.has(key)) deduped.set(key, entry);
  }
  const evidenceDirPrefix = `${path.join(workspacePath, FACTORY_TASK_PACKET_DIR, "evidence")}${path.sep}`;
  const artifactPriority = (entry: FactoryReadableArtifact): number => {
    const normalizedPath = entry.path.replace(/\\/g, "/");
    const normalizedEvidenceDirPrefix = evidenceDirPrefix.replace(/\\/g, "/");
    if (normalizedPath.startsWith(normalizedEvidenceDirPrefix)) return 0;
    if (/\/task_[^/]+\.evidence\.json$/i.test(normalizedPath)) return 1;
    return 2;
  };
  return [...deduped.values()]
    .sort((left, right) =>
      artifactPriority(left) - artifactPriority(right)
      || right.bytes - left.bytes
      || left.label.localeCompare(right.label)
    );
};

export const readTaskEvidenceContents = async (
  workspacePath: string,
  artifactActivity: ReadonlyArray<FactoryArtifactActivity>,
  extraReadableArtifacts: ReadonlyArray<FactoryReadableArtifact> = [],
): Promise<ReadonlyArray<FactoryEvidenceContent>> => {
  const allEntries = await listTaskReadableArtifacts(workspacePath, artifactActivity, extraReadableArtifacts);
  if (allEntries.length === 0) return [];

  const contents: FactoryEvidenceContent[] = [];
  let totalBytes = 0;
  for (const entry of allEntries) {
    const remaining = EVIDENCE_MAX_TOTAL_BYTES - totalBytes;
    if (remaining <= 0) break;
    const maxForFile = Math.min(EVIDENCE_MAX_FILE_BYTES, remaining);
    const content = await readEvidenceFile(entry.path, entry.label, maxForFile);
    if (!content) continue;
    contents.push(content);
    totalBytes += content.content.length;
  }
  return contents;
};

export const summarizeReadableTaskArtifacts = (
  artifacts: ReadonlyArray<FactoryReadableArtifact>,
): string | undefined => {
  if (artifacts.length === 0) return undefined;
  if (artifacts.length === 1) {
    return `Mounted evidence artifact: ${artifacts[0]?.label}.`;
  }
  const listed = artifacts.slice(0, 3).map((artifact) => artifact.label).join(", ");
  const extra = artifacts.length > 3 ? ` +${artifacts.length - 3} more` : "";
  return `Mounted evidence artifacts: ${listed}${extra}.`;
};

const renderMountedArtifactPathLines = (
  artifacts: ReadonlyArray<FactoryReadableArtifact>,
): ReadonlyArray<string> =>
  artifacts.slice(0, 3).map((artifact) => `- ${artifact.label}: ${artifact.path}`);

const normalizeBootstrapTokens = (value: string): ReadonlySet<string> =>
  new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );

const helperPriority = (
  helper: NonNullable<FactoryContextPack["helperCatalog"]>["selectedHelpers"][number],
  tokens: ReadonlySet<string>,
): number => {
  const id = helper.id.toLowerCase();
  let score = 0;
  if ((tokens.has("nat") || tokens.has("gateway") || tokens.has("egress")) && id.includes("nat_gateway")) {
    score += 100;
  }
  if ((tokens.has("ecs") || tokens.has("container") || tokens.has("service")) && id.includes("ecs_ec2_container")) {
    score += 100;
  }
  if ((tokens.has("rds") || tokens.has("database") || tokens.has("databases")) && id === "aws_resource_inventory") {
    score += 100;
  }
  if ((tokens.has("exposure") || tokens.has("public") || tokens.has("internet")) && id.includes("internet_exposure")) {
    score += 90;
  }
  if ((tokens.has("bucket") || tokens.has("buckets") || tokens.has("s3")) && id.includes("s3_bucket_inventory")) {
    score += 90;
  }
  if ((tokens.has("cost") || tokens.has("billing") || tokens.has("spend")) && id.includes("cost")) {
    score += 60;
  }
  if ((tokens.has("alarm") || tokens.has("alarms")) && id.includes("alarm")) {
    score += 50;
  }
  if ((tokens.has("inventory") || tokens.has("count")) && id.includes("inventory")) {
    score += 20;
  }
  return score;
};

const selectPrimaryHelper = (
  pack: FactoryContextPack,
): NonNullable<FactoryContextPack["helperCatalog"]>["selectedHelpers"][number] | undefined => {
  const helpers = pack.helperCatalog?.selectedHelpers ?? [];
  if (helpers.length === 0) return undefined;
  const tokens = normalizeBootstrapTokens([
    pack.title,
    pack.prompt,
    pack.task.title,
    pack.task.prompt,
  ].join("\n"));
  return [...helpers]
    .sort((left, right) =>
      helperPriority(right, tokens) - helperPriority(left, tokens)
      || left.id.localeCompare(right.id)
    )[0];
};

const renderBootstrapSeedLines = (
  pack: FactoryContextPack,
  mountedReadableArtifacts: ReadonlyArray<FactoryReadableArtifact>,
): ReadonlyArray<string> => {
  const helperCommand = suggestPrimaryHelperCommand(pack);
  const packetBase = `.receipt/factory/${pack.task.taskId}`;
  const workerSkillPath = pack.contextSources.repoSkillPaths.find((skillPath) =>
    skillPath.replace(/\\/g, "/").endsWith("/skills/factory-receipt-worker/SKILL.md"));
  const selectedSkillPaths = pack.contextSources.repoSkillPaths.filter((skillPath) =>
    pack.contextSources.profileSkillRefs.some((relativePath) =>
      skillPath.replace(/\\/g, "/").endsWith(relativePath.replace(/\\/g, "/"))));
  const primaryHelper = selectPrimaryHelper(pack);
  const lines = [
    "Controller precomputed this seed from the manifest, context pack, scoped memory, recent receipts, and mounted evidence.",
    "Start with this summary instead of rereading the whole packet stack.",
    `Exact packet paths from the workspace root: ${packetBase}.context.md, ${packetBase}.context-pack.json, ${packetBase}.memory.cjs.`,
    "When joining packet-relative paths to the workspace root, do not prefix them with a leading slash.",
    "Open the JSON context pack only when you need an exact field, ref, or artifact path.",
    "Run the memory script only if the summary and context pack still leave a factual gap.",
  ];
  if (workerSkillPath) {
    lines.push(`Checked-in worker skill path: ${workerSkillPath}.`);
  }
  if (selectedSkillPaths[0]) {
    lines.push(`Checked-in profile skill path: ${selectedSkillPaths[0]}.`);
  }
  if (workerSkillPath || selectedSkillPaths[0]) {
    lines.push("Do not substitute .receipt/codex-home-runtime or ~/.codex skill paths when these checked-in paths exist.");
  }
  if (mountedReadableArtifacts.length > 0) {
    lines.push(`Primary evidence path: inspect ${mountedReadableArtifacts[0]!.path} (${mountedReadableArtifacts[0]!.label}) before new external queries.`);
  } else if (primaryHelper && pack.task.taskPhase !== "synthesizing") {
    lines.push(`Primary evidence path: run the selected helper ${primaryHelper.id} first.`);
    if (pack.helperCatalog?.runnerPath && helperCommand) {
      lines.push(`Primary evidence command: python3 ${pack.helperCatalog.runnerPath} run --provider ${primaryHelper.provider} --json ${primaryHelper.id} -- ${helperCommand}`);
    }
  } else if (pack.task.taskPhase === "synthesizing") {
    lines.push("Primary evidence path: use inherited artifact refs and mounted evidence only; if they are insufficient, return partial or blocked instead of gathering new evidence.");
  }
  if (pack.objectiveMode === "investigation") {
    lines.push("Stop condition: once one helper run or a small number of direct CLI calls answers the question, emit the final JSON immediately.");
    if (mountedReadableArtifacts.length > 0) {
      lines.push("Synthesis reporting: if mounted evidence already answers the question, return final JSON directly and prefer report.evidenceRecords: [] over timestamp reconstruction.");
      lines.push("Synthesis reporting: use mounted artifact paths and already-captured helper commands as proof; do not run timestamp-only bookkeeping commands.");
    }
  }
  return lines.map((line) => `- ${line}`);
};

const appendEvidenceOutputDir = (args: string): string =>
  /(^|\s)--output-dir(\s|$)/.test(args) ? args : `${args} --output-dir .receipt/factory/evidence`;

const suggestResourceInventoryArgs = (tokens: ReadonlySet<string>): string => {
  if (tokens.has("rds") || tokens.has("database") || tokens.has("databases")) {
    return "--service rds --resource db-instances --all-regions --output-dir .receipt/factory/evidence";
  }
  if (tokens.has("ecs")) {
    if (tokens.has("service") || tokens.has("services")) {
      return "--service ecs --resource services --all-regions --output-dir .receipt/factory/evidence";
    }
    if (tokens.has("task") || tokens.has("tasks") || tokens.has("container") || tokens.has("containers")) {
      return "--service ecs --resource tasks --all-regions --output-dir .receipt/factory/evidence";
    }
    return "--service ecs --resource clusters --all-regions --output-dir .receipt/factory/evidence";
  }
  if (tokens.has("ec2") || tokens.has("instance") || tokens.has("instances")) {
    return "--service ec2 --resource instances --all-regions --output-dir .receipt/factory/evidence";
  }
  if (tokens.has("volume") || tokens.has("volumes") || tokens.has("ebs")) {
    return "--service ec2 --resource volumes --all-regions --output-dir .receipt/factory/evidence";
  }
  if (tokens.has("bucket") || tokens.has("buckets") || tokens.has("s3")) {
    return "--service s3 --resource buckets --output-dir .receipt/factory/evidence";
  }
  if (tokens.has("lambda") || tokens.has("function") || tokens.has("functions")) {
    return "--service lambda --resource functions --all-regions --output-dir .receipt/factory/evidence";
  }
  if (tokens.has("eks")) {
    return "--service eks --resource clusters --all-regions --output-dir .receipt/factory/evidence";
  }
  return "--service s3 --resource buckets --output-dir .receipt/factory/evidence";
};

const selectHelperExample = (
  helper: NonNullable<FactoryContextPack["helperCatalog"]>["selectedHelpers"][number],
): string | undefined =>
  helper.examples.find((example) => example.includes("--output-dir"))
  ?? helper.examples.find((example) => example.includes("--all-regions"))
  ?? helper.examples[0];

const suggestPrimaryHelperCommand = (pack: FactoryContextPack): string | undefined => {
  const helper = selectPrimaryHelper(pack);
  if (!helper) return undefined;
  const tokens = normalizeBootstrapTokens([
    pack.title,
    pack.prompt,
    pack.task.title,
    pack.task.prompt,
  ].join("\n"));
  switch (helper.id) {
    case "aws_resource_inventory":
      return suggestResourceInventoryArgs(tokens);
    case "aws_ecs_ec2_container_inventory":
      return "--profile default --all-regions --output-dir .receipt/factory/evidence";
    case "aws_internet_exposure_inventory":
      return "--profile default --all-regions --output-dir .receipt/factory/evidence";
    case "aws_alarm_summary":
      return "--all-regions --output-dir .receipt/factory/evidence";
    default: {
      const example = selectHelperExample(helper);
      return example ? appendEvidenceOutputDir(example) : undefined;
    }
  }
};

export const renderTaskContextSummary = (
  pack: FactoryContextPack,
  options?: {
    readonly mountedReadableArtifacts?: ReadonlyArray<FactoryReadableArtifact>;
  },
): string => {
  const taskLine = `Task: ${pack.task.taskId} · ${pack.task.title} [${pack.task.status}]`;
  const taskPhaseLine = pack.task.taskPhase ? `Task Phase: ${pack.task.taskPhase}` : "";
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
  const mountedReadableArtifacts = options?.mountedReadableArtifacts ?? [];
  const mountedArtifactSummary = summarizeReadableTaskArtifacts(mountedReadableArtifacts);
  const mountedArtifactPathLines = renderMountedArtifactPathLines(mountedReadableArtifacts);
  const bootstrapSeedLines = renderBootstrapSeedLines(pack, mountedReadableArtifacts);
  return [
    "# Factory Task Context Summary",
    "",
    `Objective: ${pack.title} (${pack.objectiveId})`,
    `Mode: ${pack.objectiveMode}`,
    `Severity: ${pack.severity}`,
    taskLine,
    taskPhaseLine,
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
    pack.memory.repoAudit ? `Recent audit signals: ${pack.memory.repoAudit}` : "",
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
    "## Bootstrap Seed",
    ...bootstrapSeedLines,
    "",
    mountedArtifactSummary ? "## Mounted Evidence" : "",
    mountedArtifactSummary ?? "",
    ...mountedArtifactPathLines,
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
    "If this summary already points at mounted evidence or a selected helper, follow that path before rereading the packet internals.",
    "Open the JSON context pack only when you need exact raw fields, refs, or artifact paths.",
    "Use the generated memory script only when the summary and context pack still leave a factual gap.",
  ].filter(Boolean).join("\n");
};
