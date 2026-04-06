import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { createRuntime } from "@receipt/core/runtime";
import { jsonBranchStore, jsonlStore } from "../adapters/jsonl";
import {
  readFactoryParsedJobStream,
  type FactoryParsedJob,
  type FactoryParsedTaskRun,
} from "../factory-cli/parse";

type GenericEvent = Record<string, unknown>;
type GenericCmd = {
  readonly type: "emit";
  readonly event: GenericEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type ReceiptDstContextRunReport = {
  readonly stream: string;
  readonly jobId: string;
  readonly objectiveId?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly status: string;
  readonly integrity: {
    readonly ok: boolean;
    readonly error?: string;
  };
  readonly replay: {
    readonly ok: boolean;
    readonly error?: string;
  };
  readonly deterministic: {
    readonly ok: boolean;
    readonly error?: string;
  };
  readonly artifacts: {
    readonly manifest: boolean;
    readonly contextPack: boolean;
    readonly contextSummary: boolean;
    readonly prompt: boolean;
    readonly memoryConfig: boolean;
    readonly memoryScript: boolean;
  };
  readonly summary: {
    readonly profileId?: string;
    readonly helperCount: number;
    readonly recentReceiptCount: number;
    readonly objectiveReceiptCount: number;
    readonly memoryScopeCount: number;
    readonly repoSkillCount: number;
    readonly cloudProvider?: string;
    readonly liveGuidanceCount: number;
  };
  readonly issues: ReadonlyArray<string>;
};

export type ReceiptDstContextAuditReport = {
  readonly scannedAt: string;
  readonly dataDir: string;
  readonly runCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly integrityFailures: number;
  readonly replayFailures: number;
  readonly deterministicFailures: number;
  readonly runs: ReadonlyArray<ReceiptDstContextRunReport>;
};

type ReceiptDstContextAuditOptions = {
  readonly prefix?: string;
  readonly repoRoot: string;
};

type ContextPass = {
  readonly job: FactoryParsedJob;
  readonly report: ReceiptDstContextRunReport;
  readonly snapshot: Record<string, unknown>;
};

const createGenericRuntime = (dataDir: string) =>
  createRuntime<GenericCmd, GenericEvent, { readonly ok: true }>(
    jsonlStore<GenericEvent>(dataDir),
    jsonBranchStore(dataDir),
    (cmd) => [cmd.event],
    (state) => state,
    { ok: true },
  );

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.map((item) => asString(item)).filter((item): item is string => Boolean(item))
    : [];

const asRecordArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];

const stringifyValue = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value.length > 100 ? `${value.slice(0, 97)}...` : value);
  if (value === undefined) return "undefined";
  try {
    const raw = JSON.stringify(value);
    if (!raw) return String(value);
    return raw.length > 140 ? `${raw.slice(0, 137)}...` : raw;
  } catch {
    return String(value);
  }
};

const pushMismatch = (
  issues: string[],
  label: string,
  actual: unknown,
  expected: unknown,
): void => {
  if (isDeepStrictEqual(actual, expected)) return;
  issues.push(`${label} mismatch: ${stringifyValue(actual)} !== ${stringifyValue(expected)}`);
};

const pushMissing = (
  issues: string[],
  label: string,
  exists: boolean,
): void => {
  if (!exists) issues.push(`missing ${label}`);
};

const pushTextExpectation = (
  issues: string[],
  label: string,
  text: string | undefined,
  expected: string,
): void => {
  if (!text?.includes(expected)) issues.push(`${label} missing ${JSON.stringify(expected)}`);
};

const liveGuidanceMessages = (job: FactoryParsedJob): ReadonlyArray<string> => {
  const messages = job.queueCommands
    .filter((command) => command.command === "steer" || command.command === "follow_up")
    .map((command) => {
      const payload = command.payload;
      const direct = asString(payload?.message);
      if (direct) return direct;
      return command.command === "steer"
        ? asString(payload?.problem)
        : asString(payload?.note);
    })
    .filter((message): message is string => Boolean(message));
  return [...new Set(messages)];
};

const normalizedTaskRunSnapshot = (
  job: FactoryParsedJob,
  taskRun: FactoryParsedTaskRun,
): Record<string, unknown> => ({
  jobId: job.jobId,
  stream: job.stream,
  status: job.status,
  objectiveId: job.objectiveId,
  taskId: job.taskId,
  candidateId: job.candidateId,
  queueCommands: job.queueCommands.map((command) => ({
    command: command.command,
    payload: command.payload,
    consumedAt: command.consumedAt,
  })),
  payload: taskRun.payload,
  manifest: taskRun.manifest.json ?? null,
  contextPack: taskRun.contextPack.json ?? null,
  contextSummary: taskRun.contextSummary.text ?? null,
  prompt: taskRun.prompt.text ?? null,
  memoryConfig: taskRun.memoryConfig.json ?? null,
  memoryScript: taskRun.memoryScript.text ?? null,
});

const buildContextRunReport = (
  job: FactoryParsedJob,
  taskRun: FactoryParsedTaskRun,
): ReceiptDstContextRunReport => {
  const payload = taskRun.payload;
  const manifest = asRecord(taskRun.manifest.json);
  const manifestObjective = asRecord(manifest?.objective);
  const manifestProfile = asRecord(manifest?.profile);
  const manifestTask = asRecord(manifest?.task);
  const manifestCandidate = asRecord(manifest?.candidate);
  const manifestMemory = asRecord(manifest?.memory);
  const manifestContext = asRecord(manifest?.context);
  const contextPack = asRecord(taskRun.contextPack.json);
  const contextProfile = asRecord(contextPack?.profile);
  const contextTask = asRecord(contextPack?.task);
  const contextSources = asRecord(contextPack?.contextSources);
  const cloudExecutionContext = asRecord(contextPack?.cloudExecutionContext);
  const helperCatalog = asRecord(contextPack?.helperCatalog);
  const memoryConfig = asRecord(taskRun.memoryConfig.json);
  const promptText = taskRun.prompt.text;
  const summaryText = taskRun.contextSummary.text;
  const memoryScriptText = taskRun.memoryScript.text;
  const payloadProfile = asRecord(payload.profile);
  const payloadContextRefs = Array.isArray(payload.contextRefs) ? payload.contextRefs : [];
  const payloadSharedArtifactRefs = Array.isArray(payload.sharedArtifactRefs) ? payload.sharedArtifactRefs : [];
  const liveGuidance = liveGuidanceMessages(job);
  const issues: string[] = [];

  pushMissing(issues, "manifest", taskRun.manifest.exists);
  pushMissing(issues, "context pack", taskRun.contextPack.exists);
  pushMissing(issues, "prompt", taskRun.prompt.exists);
  pushMissing(issues, "memory config", taskRun.memoryConfig.exists);
  pushMissing(issues, "memory script", taskRun.memoryScript.exists);
  if (asString(payload.contextSummaryPath)) {
    pushMissing(issues, "context summary", taskRun.contextSummary.exists);
  }

  pushMismatch(issues, "payload kind", asString(payload.kind), "factory.task.run");
  pushMismatch(issues, "job objectiveId", job.objectiveId, asString(payload.objectiveId));
  pushMismatch(issues, "job taskId", job.taskId, asString(payload.taskId));
  pushMismatch(issues, "job candidateId", job.candidateId, asString(payload.candidateId));
  pushMismatch(issues, "manifest objectiveId", asString(manifestObjective?.objectiveId), asString(payload.objectiveId));
  pushMismatch(issues, "manifest taskId", asString(manifestTask?.taskId), asString(payload.taskId));
  pushMismatch(issues, "manifest candidateId", asString(manifestCandidate?.candidateId), asString(payload.candidateId));
  pushMismatch(issues, "manifest profile rootProfileId", asString(manifestProfile?.rootProfileId), asString(payloadProfile?.rootProfileId));
  pushMismatch(issues, "manifest profile promptPath", asString(manifestProfile?.promptPath), asString(payloadProfile?.promptPath));
  pushMismatch(issues, "manifest memory scriptPath", asString(manifestMemory?.scriptPath), asString(payload.memoryScriptPath));
  pushMismatch(issues, "manifest memory configPath", asString(manifestMemory?.configPath), asString(payload.memoryConfigPath));
  pushMismatch(issues, "manifest context packPath", asString(manifestContext?.packPath), asString(payload.contextPackPath));
  if (asString(payload.contextSummaryPath)) {
    pushMismatch(issues, "manifest context summaryPath", asString(manifestContext?.summaryPath), asString(payload.contextSummaryPath));
  }
  pushMismatch(issues, "manifest repoSkillPaths", asStringArray(manifest?.repoSkillPaths), asStringArray(payload.repoSkillPaths));
  pushMismatch(issues, "manifest skillBundlePaths", asStringArray(manifest?.skillBundlePaths), asStringArray(payload.skillBundlePaths));
  pushMismatch(issues, "manifest contextRefs", manifest?.contextRefs, payloadContextRefs);
  pushMismatch(issues, "manifest sharedArtifactRefs", manifest?.sharedArtifactRefs, payloadSharedArtifactRefs);

  pushMismatch(issues, "context pack objectiveId", asString(contextPack?.objectiveId), asString(payload.objectiveId));
  pushMismatch(issues, "context pack taskId", asString(contextTask?.taskId), asString(payload.taskId));
  pushMismatch(issues, "context pack candidateId", asString(contextTask?.candidateId), asString(payload.candidateId));
  pushMismatch(issues, "context pack profile rootProfileId", asString(contextProfile?.rootProfileId), asString(payloadProfile?.rootProfileId));
  pushMismatch(issues, "context pack profile promptPath", asString(contextProfile?.promptPath), asString(payloadProfile?.promptPath));
  pushMismatch(issues, "context pack repoSkillPaths", asStringArray(contextSources?.repoSkillPaths), asStringArray(payload.repoSkillPaths));
  pushMismatch(issues, "context pack profileSkillRefs", asStringArray(contextSources?.profileSkillRefs), asStringArray(payload.profileSkillRefs));
  pushMismatch(issues, "context pack sharedArtifactRefs", contextSources?.sharedArtifactRefs, payloadSharedArtifactRefs);

  pushMismatch(issues, "memory config objectiveId", asString(memoryConfig?.objectiveId), asString(payload.objectiveId));
  pushMismatch(issues, "memory config taskId", asString(memoryConfig?.taskId), asString(payload.taskId));
  pushMismatch(issues, "memory config candidateId", asString(memoryConfig?.candidateId), asString(payload.candidateId));
  pushMismatch(issues, "memory config contextPackPath", asString(memoryConfig?.contextPackPath), path.basename(asString(payload.contextPackPath) ?? ""));
  if (asString(payload.contextSummaryPath)) {
    pushMismatch(issues, "memory config contextSummaryPath", asString(memoryConfig?.contextSummaryPath), path.basename(asString(payload.contextSummaryPath) ?? ""));
  }
  pushMismatch(
    issues,
    "memory scope keys",
    asRecordArray(memoryConfig?.scopes).map((scope) => asString(scope.key)).filter((item): item is string => Boolean(item)),
    asRecordArray(manifestMemory?.scopes).map((scope) => asString(scope.key)).filter((item): item is string => Boolean(item)),
  );

  pushTextExpectation(issues, "prompt", promptText, "The prompt is bootstrap only.");
  pushTextExpectation(issues, "prompt", promptText, "manifest, context pack, then memory script");
  pushTextExpectation(issues, "prompt", promptText, "AGENTS.md and skills/factory-receipt-worker/SKILL.md");
  pushTextExpectation(issues, "prompt", promptText, asString(payload.manifestPath) ?? "");
  pushTextExpectation(issues, "prompt", promptText, asString(payload.contextPackPath) ?? "");
  pushTextExpectation(issues, "prompt", promptText, asString(payload.memoryScriptPath) ?? "");
  if (asString(payload.contextSummaryPath)) {
    pushTextExpectation(issues, "prompt", promptText, asString(payload.contextSummaryPath) ?? "");
  }
  pushTextExpectation(issues, "prompt", promptText, "factory inspect");
  if (cloudExecutionContext) {
    pushTextExpectation(issues, "prompt", promptText, "## Live Cloud Context");
  }
  if (helperCatalog) {
    pushTextExpectation(issues, "prompt", promptText, "## Helper-First Execution");
    const runnerPath = asString(helperCatalog.runnerPath);
    if (runnerPath) pushTextExpectation(issues, "prompt", promptText, runnerPath);
    for (const helper of asRecordArray(helperCatalog.selectedHelpers).slice(0, 3)) {
      const helperId = asString(helper.id);
      if (helperId) pushTextExpectation(issues, "prompt", promptText, helperId);
    }
  }
  if (liveGuidance.length > 0) {
    pushTextExpectation(issues, "prompt", promptText, "## Live Operator Guidance");
    for (const message of liveGuidance) pushTextExpectation(issues, "prompt", promptText, message);
  }

  if (taskRun.contextSummary.exists) {
    pushTextExpectation(issues, "context summary", summaryText, "# Factory Task Context Summary");
    pushTextExpectation(issues, "context summary", summaryText, "## Packet Usage");
  }

  pushTextExpectation(issues, "memory script", memoryScriptText, path.basename(asString(payload.memoryConfigPath) ?? ""));
  pushTextExpectation(issues, "memory script", memoryScriptText, `receipt`);
  pushTextExpectation(issues, "memory script", memoryScriptText, `"context"`);
  pushTextExpectation(issues, "memory script", memoryScriptText, `"objective"`);

  return {
    stream: job.stream,
    jobId: job.jobId,
    objectiveId: job.objectiveId,
    taskId: job.taskId,
    candidateId: job.candidateId,
    status: job.status,
    integrity: issues.length === 0
      ? { ok: true }
      : { ok: false, error: issues[0] },
    replay: { ok: true },
    deterministic: { ok: true },
    artifacts: {
      manifest: taskRun.manifest.exists,
      contextPack: taskRun.contextPack.exists,
      contextSummary: taskRun.contextSummary.exists,
      prompt: taskRun.prompt.exists,
      memoryConfig: taskRun.memoryConfig.exists,
      memoryScript: taskRun.memoryScript.exists,
    },
    summary: {
      profileId: asString(contextProfile?.rootProfileId) ?? asString(manifestProfile?.rootProfileId) ?? asString(payloadProfile?.rootProfileId),
      helperCount: asRecordArray(helperCatalog?.selectedHelpers).length,
      recentReceiptCount: asRecordArray(contextPack?.recentReceipts).length,
      objectiveReceiptCount: asRecordArray(asRecord(contextPack?.objectiveSlice)?.recentObjectiveReceipts).length,
      memoryScopeCount: asRecordArray(memoryConfig?.scopes).length,
      repoSkillCount: asStringArray(contextSources?.repoSkillPaths).length,
      cloudProvider: asString(cloudExecutionContext?.preferredProvider),
      liveGuidanceCount: liveGuidance.length,
    },
    issues,
  };
};

const loadContextPass = async (
  dataDir: string,
  repoRoot: string,
  stream: string,
): Promise<ContextPass | undefined> => {
  const job = await readFactoryParsedJobStream(dataDir, repoRoot, stream);
  if (!job?.taskRun || job.payloadKind !== "factory.task.run") return undefined;
  return {
    job,
    report: buildContextRunReport(job, job.taskRun),
    snapshot: normalizedTaskRunSnapshot(job, job.taskRun),
  };
};

const analyzeContextRun = async (
  dataDir: string,
  repoRoot: string,
  stream: string,
): Promise<ReceiptDstContextRunReport | undefined> => {
  let firstPass: ContextPass | undefined;
  let secondPass: ContextPass | undefined;
  let replay: ReceiptDstContextRunReport["replay"] = { ok: true };
  let deterministic: ReceiptDstContextRunReport["deterministic"] = { ok: true };

  try {
    firstPass = await loadContextPass(dataDir, repoRoot, stream);
    if (!firstPass) return undefined;
    secondPass = await loadContextPass(dataDir, repoRoot, stream);
    if (!secondPass) {
      deterministic = { ok: false, error: "task packet disappeared between context audit passes" };
    } else if (!isDeepStrictEqual(firstPass.snapshot, secondPass.snapshot)) {
      deterministic = { ok: false, error: "task packet changed between fresh context audit passes" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    replay = { ok: false, error: message };
    deterministic = { ok: false, error: message };
  }

  const primary = firstPass ?? secondPass;
  if (!primary) return undefined;
  return {
    ...primary.report,
    replay,
    deterministic,
  };
};

export const runReceiptContextDstAudit = async (
  dataDir: string,
  opts: ReceiptDstContextAuditOptions,
): Promise<ReceiptDstContextAuditReport> => {
  const runtime = createGenericRuntime(dataDir);
  const jobStreams = (await runtime.listStreams("jobs/"))
    .filter((stream) => !opts.prefix || stream.startsWith(opts.prefix));
  const reports = (await Promise.all(jobStreams.map((stream) =>
    analyzeContextRun(dataDir, opts.repoRoot, stream))))
    .filter((report): report is ReceiptDstContextRunReport => Boolean(report));

  const ordered = [...reports].sort((left, right) =>
    Number(left.integrity.ok) - Number(right.integrity.ok)
    || Number(left.replay.ok) - Number(right.replay.ok)
    || Number(left.deterministic.ok) - Number(right.deterministic.ok)
    || left.jobId.localeCompare(right.jobId),
  );

  const statusCounts: Record<string, number> = {};
  for (const report of ordered) {
    statusCounts[report.status] = (statusCounts[report.status] ?? 0) + 1;
  }

  return {
    scannedAt: new Date().toISOString(),
    dataDir,
    runCount: ordered.length,
    statusCounts,
    integrityFailures: ordered.filter((report) => !report.integrity.ok).length,
    replayFailures: ordered.filter((report) => !report.replay.ok).length,
    deterministicFailures: ordered.filter((report) => !report.deterministic.ok).length,
    runs: ordered,
  };
};

export const renderReceiptContextDstAuditText = (
  report: ReceiptDstContextAuditReport,
  opts: {
    readonly limit?: number;
  } = {},
): string => {
  const limit = Math.max(1, opts.limit ?? 20);
  const lines = [
    "Factory Context DST",
    `Data dir: ${report.dataDir}`,
    `Scanned: ${report.runCount} task run(s)`,
    `Integrity failures: ${report.integrityFailures}`,
    `Replay failures: ${report.replayFailures}`,
    `Deterministic failures: ${report.deterministicFailures}`,
  ];

  const statuses = Object.entries(report.statusCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([status, count]) => `${status}:${count}`);
  if (statuses.length > 0) {
    lines.push(`Statuses: ${statuses.join(", ")}`);
  }

  const failures = report.runs.filter((run) => !run.integrity.ok || !run.replay.ok || !run.deterministic.ok);
  if (failures.length > 0) {
    lines.push("", "Issues:");
    for (const run of failures.slice(0, limit)) {
      const problems = [
        !run.integrity.ok ? `integrity=${run.integrity.error}` : undefined,
        !run.replay.ok ? `replay=${run.replay.error}` : undefined,
        !run.deterministic.ok ? `deterministic=${run.deterministic.error}` : undefined,
      ].filter((item): item is string => Boolean(item));
      lines.push(`- ${run.stream} task=${run.taskId ?? "unknown"} candidate=${run.candidateId ?? "unknown"} ${problems.join(" | ")}`);
    }
  }

  lines.push("", "Runs:");
  for (const run of report.runs.slice(0, limit)) {
    const parts = [
      `status=${run.status}`,
      run.summary.profileId ? `profile=${run.summary.profileId}` : undefined,
      `helpers=${run.summary.helperCount}`,
      `scopes=${run.summary.memoryScopeCount}`,
      `receipts=${run.summary.recentReceiptCount}/${run.summary.objectiveReceiptCount}`,
      run.summary.cloudProvider ? `cloud=${run.summary.cloudProvider}` : undefined,
      run.summary.liveGuidanceCount > 0 ? `guidance=${run.summary.liveGuidanceCount}` : undefined,
    ].filter((item): item is string => Boolean(item));
    lines.push(`- ${run.stream} task=${run.taskId ?? "unknown"} candidate=${run.candidateId ?? "unknown"} ${parts.join(" ")}`);
  }

  if (report.runs.length > limit) {
    lines.push(`- ... ${report.runs.length - limit} more run(s) omitted`);
  }

  return lines.join("\n");
};
