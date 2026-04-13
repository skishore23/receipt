import fs from "node:fs/promises";
import path from "node:path";

import React from "react";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  spinner,
  text,
} from "@clack/prompts";
import { render } from "ink";

import { fold } from "@receipt/core/chain";
import { sqliteReceiptStore } from "../../adapters/sqlite";
import type { Flags } from "../../cli.types";
import { printUsage } from "../../cli/shared";
import type { AgentEvent } from "../../modules/agent";
import {
  initial as initialAgent,
  reduce as reduceAgent,
} from "../../modules/agent";
import type {
  FactoryObjectiveMode,
  FactoryObjectivePolicy,
  FactoryObjectiveSeverity,
  FactoryTaskRecord,
  FactoryCandidateRecord,
} from "../../modules/factory";
import { DEFAULT_FACTORY_OBJECTIVE_POLICY } from "../../modules/factory";
import { bunWhich, resolveBunRuntime } from "../../lib/runtime-paths";
import {
  abortJobMutation,
  archiveObjectiveMutation,
  cancelObjectiveMutation,
  cleanupObjectiveMutation,
  composeObjectiveMutation,
  createObjectiveMutation,
  followUpJobMutation,
  noteObjectiveMutation,
  promoteObjectiveMutation,
  reactObjectiveMutation,
  steerJobMutation,
  type FactoryMutationResult,
} from "../actions";
import { FactoryTerminalApp, type FactoryAppExit } from "../app";
import {
  detectGitRoot,
  type FactoryCliConfig,
  type FactoryCliStoredConfig,
  isInteractiveTerminal,
  loadFactoryConfig,
  resolveFactoryRuntimeConfig,
  writeFactoryConfig,
} from "../config";
import {
  renderCodexProbeText,
  runFactoryCodexProbe,
  type CodexProbeMode,
} from "../codex-probe";
import {
  renderBoardText,
  renderObjectiveHeader,
  renderObjectivePanelText,
} from "../format";
import {
  buildInvestigationReportPanelValue,
  defaultObjectivePanelForDetail,
} from "../investigation-report";
import {
  readFactoryReceiptInvestigation,
  renderFactoryReceiptInvestigationText,
} from "../investigate";
import {
  readFactoryReceiptAudit,
  renderFactoryReceiptAuditText,
} from "../audit";
import {
  renderFactoryLongRunExperimentText,
  runFactoryLongRunExperiment,
} from "../experiment";
import { createFactoryCliRuntime } from "../runtime";
import { terminalTheme } from "../theme";
import { truncate, type FactoryObjectivePanel } from "../view-model";
import { readObjectiveAnalysis, renderObjectiveAnalysisText } from "../analyze";
import { readFactoryParsedRun, renderFactoryParsedRunText } from "../parse";
import {
  loadFactoryHelperCatalog,
  runFactoryHelper,
} from "../../services/factory-helper-catalog";
import { buildFactoryObjectiveLoadingState } from "../../services/factory/live-status";
import { resolveFactoryChatProfile } from "../../services/factory-chat-profiles";
import type { FactoryCloudProvider } from "../../services/factory-cloud-context";
import { readObjectiveReplaySnapshot } from "../../services/factory/objective-replay";

const parseBooleanFlag = (flags: Flags, key: string): boolean =>
  flags[key] === true || flags[key] === "true";

const parseIntegerFlag = (
  flags: Flags,
  key: string,
  fallback: number,
  input: {
    readonly min: number;
    readonly max: number;
  },
): number => {
  const value = asString(flags, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return Math.max(input.min, Math.min(Math.floor(parsed), input.max));
};

const parseOptionalIntegerFlag = (
  flags: Flags,
  key: string,
): number | undefined => {
  const value = asString(flags, key);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return Math.floor(parsed);
};

const asString = (flags: Flags, key: string): string | undefined => {
  const value = flags[key];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === "string" ? value : undefined;
};

const asStrings = (flags: Flags, key: string): ReadonlyArray<string> => {
  const value = flags[key];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
};

const mergePolicy = (
  base: FactoryObjectivePolicy,
  override: FactoryObjectivePolicy | undefined,
): FactoryObjectivePolicy => {
  if (!override) return base;
  return {
    concurrency: {
      ...(base.concurrency ?? {}),
      ...(override.concurrency ?? {}),
    },
    budgets: { ...(base.budgets ?? {}), ...(override.budgets ?? {}) },
    throttles: { ...(base.throttles ?? {}), ...(override.throttles ?? {}) },
    promotion: { ...(base.promotion ?? {}), ...(override.promotion ?? {}) },
  };
};

const parseChecksInput = (value: string): string[] =>
  value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);

const resolveObjectiveChecks = async (input: {
  readonly repoRoot: string;
  readonly profileRoot: string;
  readonly profileId?: string;
  readonly explicitChecks: ReadonlyArray<string>;
  readonly fallbackChecks: ReadonlyArray<string>;
}): Promise<ReadonlyArray<string> | undefined> => {
  if (input.explicitChecks.length > 0) return input.explicitChecks;
  const profile = await resolveFactoryChatProfile({
    repoRoot: input.repoRoot,
    profileRoot: input.profileRoot,
    requestedId: input.profileId,
  });
  return profile.objectivePolicy.defaultValidationMode === "none"
    ? undefined
    : input.fallbackChecks;
};

const parseObjectiveModeFlag = (
  flags: Flags,
): FactoryObjectiveMode | undefined => {
  const value = asString(flags, "objective-mode")?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "delivery" || value === "investigation") return value;
  throw new Error(`--objective-mode must be 'delivery' or 'investigation'`);
};

const parseSeverityFlag = (
  flags: Flags,
): FactoryObjectiveSeverity | undefined => {
  const value = asString(flags, "severity");
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new Error("--severity must be an integer between 1 and 5");
  }
  return parsed as FactoryObjectiveSeverity;
};

const formatDurationMs = (durationMs: number): string => {
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
};

const renderObjectiveWaitLine = (opts: {
  readonly objectiveId: string;
  readonly detail: Awaited<
    ReturnType<
      ReturnType<typeof createFactoryCliRuntime>["service"]["getObjective"]
    >
  >;
  readonly live?: Awaited<
    ReturnType<
      ReturnType<
        typeof createFactoryCliRuntime
      >["service"]["buildLiveProjection"]
    >
  >;
  readonly auditStatus: "idle" | "queued" | "running" | "completed" | "failed";
}): { readonly key: string; readonly line: string } => {
  const loading = buildFactoryObjectiveLoadingState({
    detail: opts.detail,
    live: opts.live,
  });
  const auditLabel = opts.auditStatus === "queued" || opts.auditStatus === "running"
    ? `audit ${opts.auditStatus}`
    : undefined;
  const segments = [
    `[${opts.objectiveId.slice(-6)}] ${loading.label}`,
    loading.summary,
    loading.detail,
    ...(loading.highlights?.slice(0, 2) ?? []),
    auditLabel,
    loading.nextAction ? `Next: ${truncate(loading.nextAction, 96)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const line = segments.join(" · ");
  const key = JSON.stringify([
    opts.detail.status,
    opts.detail.phase,
    opts.detail.integration.status,
    opts.auditStatus,
    loading.label,
    loading.summary,
    loading.detail,
    ...(loading.highlights ?? []),
    loading.nextAction,
    opts.detail.updatedAt,
  ]);
  return { key, line };
};

const printSetupSummary = (opts: {
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly codexBin: string;
  readonly codexAvailable: boolean;
  readonly branch: string;
  readonly sourceDirty: boolean;
  readonly profileSummary: string;
  readonly checks: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<string>;
}): void => {
  const marker = terminalTheme.glyphs.pointer;
  const lines = [
    "",
    "Repository profiling",
    ...opts.steps.map((step) => `  ${marker} ${step}`),
    "",
    "Detected setup",
    `  ${marker} Repo root: ${opts.repoRoot}`,
    `  ${marker} Data dir: ${opts.dataDir}`,
    `  ${marker} Branch: ${opts.branch}${opts.sourceDirty ? " (dirty)" : ""}`,
    `  ${marker} Profile: ${opts.profileSummary}`,
    `  ${marker} Validation: ${opts.checks.join(" | ") || "none"}`,
    `  ${marker} Codex: ${opts.codexBin}${opts.codexAvailable ? "" : " (not found on PATH)"}`,
    "",
  ];
  console.log(lines.join("\n"));
};

const readPolicyFile = async (
  filePath: string | undefined,
): Promise<FactoryObjectivePolicy | undefined> => {
  if (!filePath) return undefined;
  const loaded = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.resolve(filePath), "utf-8"),
  );
  const parsed = JSON.parse(loaded) as FactoryObjectivePolicy;
  return parsed;
};

const panelValue = (
  panel: FactoryObjectivePanel,
  detail: Awaited<
    ReturnType<
      ReturnType<typeof createFactoryCliRuntime>["service"]["getObjective"]
    >
  >,
  live: Awaited<
    ReturnType<
      ReturnType<
        typeof createFactoryCliRuntime
      >["service"]["buildLiveProjection"]
    >
  >,
  debug: Awaited<
    ReturnType<
      ReturnType<typeof createFactoryCliRuntime>["service"]["getObjectiveDebug"]
    >
  >,
): unknown => {
  switch (panel) {
    case "overview":
      return {
        header: renderObjectiveHeader(detail),
        prompt: detail.prompt,
        checks: detail.checks,
        policy: detail.policy,
        blockedExplanation: detail.blockedExplanation,
        latestDecision: detail.latestDecision,
      };
    case "report":
      return buildInvestigationReportPanelValue(detail);
    case "tasks":
      return detail.tasks;
    case "candidates":
      return detail.candidates;
    case "evidence":
      return detail.evidenceCards;
    case "activity":
      return detail.activity;
    case "live":
      return live;
    case "debug":
      return debug;
    case "receipts":
      return detail.recentReceipts;
    default:
      return detail;
  }
};

const parsePanel = (value: string | undefined): FactoryObjectivePanel => {
  const panel = value?.trim().toLowerCase() as
    | FactoryObjectivePanel
    | undefined;
  return panel &&
    [
      "overview",
      "report",
      "tasks",
      "candidates",
      "evidence",
      "activity",
      "live",
      "debug",
      "receipts",
    ].includes(panel)
    ? panel
    : "overview";
};

const objectiveAuditJobs = async (
  runtime: ReturnType<typeof createFactoryCliRuntime>,
  objectiveId: string,
) => {
  const jobs = await runtime.queue.listJobs({ limit: 200 });
  return jobs.filter(
    (job) =>
      typeof job.payload === "object" &&
      job.payload &&
      job.payload.kind === "factory.objective.audit" &&
      job.payload.objectiveId === objectiveId,
  );
};

const objectiveAuditStatus = async (
  runtime: ReturnType<typeof createFactoryCliRuntime>,
  objectiveId: string,
): Promise<"idle" | "queued" | "running" | "completed" | "failed"> => {
  const jobs = await objectiveAuditJobs(runtime, objectiveId);
  if (jobs.some((job) => job.status === "running" || job.status === "leased"))
    return "running";
  if (jobs.some((job) => job.status === "queued")) return "queued";
  if (jobs.some((job) => job.status === "failed" || job.status === "canceled"))
    return "failed";
  if (jobs.some((job) => job.status === "completed")) return "completed";
  return "idle";
};

const ensureObjectiveAuditQueued = async (
  runtime: ReturnType<typeof createFactoryCliRuntime>,
  detail: Awaited<
    ReturnType<
      ReturnType<typeof createFactoryCliRuntime>["service"]["getObjective"]
    >
  >,
): Promise<void> => {
  const auditStatus = await objectiveAuditStatus(runtime, detail.objectiveId);
  if (auditStatus !== "idle") return;
  await runtime.queue.enqueue({
    agentId: "factory-control",
    lane: "collect",
    sessionKey: `factory:audit:${detail.objectiveId}`,
    singletonMode: "steer",
    maxAttempts: 1,
    payload: {
      kind: "factory.objective.audit",
      objectiveId: detail.objectiveId,
      objectiveStatus: detail.status,
      objectiveUpdatedAt: detail.updatedAt,
      objectiveChannel: detail.channel,
    },
  });
};

const printJson = async (value: unknown): Promise<void> => {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await writeStdoutPayload(payload);
};

const writeStdoutPayload = async (payload: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const wrote = process.stdout.write(payload, (error) =>
      finish(error ?? undefined),
    );
    if (!wrote) process.stdout.once("drain", () => finish());
  });
};

const renderCliOutput = (value: string | unknown, asJson: boolean): string => {
  if (asJson) return `${JSON.stringify(value, null, 2)}\n`;
  const text = typeof value === "string" ? value : String(value);
  return text.endsWith("\n") ? text : `${text}\n`;
};

const printFactoryReadOutput = async (input: {
  readonly flags: Flags;
  readonly asJson: boolean;
  readonly value: string | unknown;
}): Promise<void> => {
  const payload = renderCliOutput(input.value, input.asJson);
  const outputFile = asString(input.flags, "output-file");
  if (!outputFile) {
    await writeStdoutPayload(payload);
    return;
  }
  const resolvedPath = path.resolve(outputFile);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, payload, "utf-8");
  if (input.asJson) {
    await printJson({
      ok: true,
      outputFile: resolvedPath,
      format: "json",
      bytes: Buffer.byteLength(payload, "utf-8"),
    });
    return;
  }
  process.stdout.write(`wrote ${resolvedPath}\n`);
};

const parseHelperProvider = (
  value: string | undefined,
): FactoryCloudProvider => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "aws") return "aws";
  if (normalized === "gcp" || normalized === "azure") return normalized;
  throw new Error(
    `Unsupported helper provider '${value}'. Use aws, gcp, or azure.`,
  );
};

const isHelpToken = (value: string | undefined): boolean =>
  value === "help" || value === "--help" || value === "-h";

const hasHelpFlag = (flags: Flags): boolean =>
  flags.help === true || flags.help === "true";

const printFactoryUsage = (subcommand?: string): void => {
  switch (subcommand) {
    case "replay":
      console.log(
        "receipt factory replay <objectiveId> [--json] [--output-file <path>]",
      );
      return;
    case "replay-chat":
      console.log(
        "receipt factory replay-chat <chat-or-run-stream> [--json] [--output-file <path>]",
      );
      return;
    case "analyze":
      console.log(
        "receipt factory analyze <objectiveId> [--json] [--output-file <path>]",
      );
      return;
    case "parse":
      console.log(
        "receipt factory parse [<objectiveId|taskId|candidateId|jobId|runId>] [--json] [--output-file <path>]",
      );
      return;
    case "investigate":
      console.log(
        "receipt factory investigate <objectiveId|taskId|candidateId|jobId|runId> [--json] [--compact] [--output-file <path>] [--as-of-ts <ts>]",
      );
      return;
    case "audit":
      console.log(
        "receipt factory audit [--limit <n>] [--objective <id>] [--json] [--output-file <path>]",
      );
      return;
    case "experiment":
      console.log(
        "receipt factory experiment long-run [--json] [--output-dir <path>] [--codex-bin <path>] [--keep-workdir]",
      );
      return;
    case "codex-probe":
      console.log(
        "receipt factory codex-probe [--mode direct|queue|both] [--reply <text>] [--prompt <text>] [--json]",
      );
      return;
    default:
      printUsage();
      console.log(
        [
          "",
          "Factory read / inspect:",
          "  receipt factory inspect <objective-id> [--panel <name>] [--json]",
          "  receipt factory replay <objective-id> [--json] [--output-file <path>]",
          "  receipt factory replay-chat <chat-or-run-stream> [--json] [--output-file <path>]",
          "  receipt factory analyze <objective-id> [--json] [--output-file <path>]",
          "  receipt factory parse [<objectiveId|taskId|candidateId|jobId|runId>] [--json] [--output-file <path>]",
          "  receipt factory investigate <objectiveId|taskId|candidateId|jobId|runId> [--json] [--compact] [--output-file <path>] [--as-of-ts <ts>]",
          "  receipt factory audit [--limit <n>] [--objective <id>] [--json] [--output-file <path>]",
          "",
          "Factory write / control:",
          "  receipt factory init [--repo-root <path>]",
          "  receipt factory codex-probe [--mode direct|queue|both] [--reply <text>] [--prompt <text>] [--json]",
          "  receipt factory create --prompt <text> [--objective-mode delivery|investigation] [--severity 1|2|3|4|5]",
          "  receipt factory compose [--objective <id>] --prompt <text>",
          "  receipt factory note <objective-id> [--message <text>]",
          "  receipt factory react <objective-id> [--message <text>]",
          "  receipt factory promote <objective-id>",
          "  receipt factory cancel <objective-id> [--reason <text>]",
          "  receipt factory cleanup <objective-id>",
          "  receipt factory archive <objective-id>",
          "  receipt factory steer <job-id> [--message <text>]",
          "  receipt factory follow-up <job-id> [--message <text>]",
          "  receipt factory abort-job <job-id> [--reason <text>]",
          "",
          "Notes:",
          "  - Prefer read commands first and add --json when another tool or agent will consume the output.",
          "  - Use --output-file <path> on large read commands to write the full payload and return the path.",
          "  - Read commands do not mutate state; write / control commands do.",
          "",
          "Factory experiments:",
          "  receipt factory experiment long-run [--json] [--output-dir <path>] [--codex-bin <path>] [--keep-workdir]",
        ].join("\n"),
      );
  }
};

const summarizeReplayTask = (task: FactoryTaskRecord) => ({
  taskId: task.taskId,
  title: task.title,
  status: task.status,
  dependsOn: task.dependsOn,
  candidateId: task.candidateId,
  jobId: task.jobId,
  latestSummary: task.latestSummary,
  blockedReason: task.blockedReason,
});

const summarizeReplayCandidate = (candidate: FactoryCandidateRecord) => ({
  candidateId: candidate.candidateId,
  taskId: candidate.taskId,
  status: candidate.status,
  summary: candidate.summary,
  latestReason: candidate.latestReason,
});

const readObjectiveReplay = async (
  dataDir: string,
  objectiveIdOrStream: string,
) => {
  const { objectiveId, stream, chain, projection } =
    await readObjectiveReplaySnapshot(dataDir, objectiveIdOrStream);
  return {
    objectiveId,
    stream,
    receiptCount: chain.length,
    status: projection.status,
    latestSummary: projection.latestSummary,
    blockedReason: projection.blockedReason,
    archivedAt: projection.archivedAt,
    updatedAt: projection.updatedAt,
    workflow: {
      activeTaskIds: projection.activeTasks.map((task) => task.taskId),
      readyTaskIds: projection.readyTasks.map((task) => task.taskId),
      pendingTaskIds: projection.pendingTasks.map((task) => task.taskId),
      completedTaskIds: projection.completedTasks.map((task) => task.taskId),
      blockedTaskIds: projection.blockedTasks.map((task) => task.taskId),
    },
    tasks: projection.tasks.map(summarizeReplayTask),
    candidates: projection.candidates.map(summarizeReplayCandidate),
    integration: projection.integration,
  };
};

const renderObjectiveReplayText = (
  replay: Awaited<ReturnType<typeof readObjectiveReplay>>,
): string => {
  const lines = [
    `${replay.objectiveId} (${replay.status})`,
    `Receipts: ${replay.receiptCount}`,
    replay.latestSummary ? `Summary: ${replay.latestSummary}` : undefined,
    replay.blockedReason ? `Blocked: ${replay.blockedReason}` : undefined,
    `Active: ${replay.workflow.activeTaskIds.join(", ") || "none"}`,
    `Ready: ${replay.workflow.readyTaskIds.join(", ") || "none"}`,
    `Pending: ${replay.workflow.pendingTaskIds.join(", ") || "none"}`,
    `Completed: ${replay.workflow.completedTaskIds.join(", ") || "none"}`,
    `Blocked tasks: ${replay.workflow.blockedTaskIds.join(", ") || "none"}`,
    "",
    "Tasks:",
    ...replay.tasks.map(
      (task) =>
        `- ${task.taskId} [${task.status}]${task.dependsOn.length ? ` dependsOn=${task.dependsOn.join(",")}` : ""}${task.blockedReason ? ` blocked=${task.blockedReason}` : ""}`,
    ),
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
};

const readChatReplay = async (dataDir: string, stream: string) => {
  const chain = await sqliteReceiptStore<AgentEvent>(dataDir).read(stream);
  if (chain.length === 0) {
    throw new Error(`No receipts found for ${stream}`);
  }
  const runChains = new Map<string, Array<(typeof chain)[number]>>();
  for (const receipt of chain) {
    const runId =
      typeof receipt.body.runId === "string" ? receipt.body.runId : undefined;
    if (!runId) continue;
    const existing = runChains.get(runId);
    if (existing) existing.push(receipt);
    else runChains.set(runId, [receipt]);
  }
  const runs = [...runChains.entries()].map(([runId, runChain]) => {
    const state = fold(runChain, reduceAgent, initialAgent);
    const bindings = runChain
      .filter(
        (
          receipt,
        ): receipt is typeof receipt & {
          readonly body: Extract<AgentEvent, { readonly type: "thread.bound" }>;
        } => isThreadBoundEvent(receipt.body),
      )
      .map((receipt) => {
        const body = receipt.body;
        return {
          at: receipt.ts,
          objectiveId: body.objectiveId,
          reason: body.reason,
          created: body.created,
        };
      });
    const continuationReceipt = [...runChain]
      .reverse()
      .map((receipt) => receipt.body)
      .find(isRunContinuedEvent);
    const continuation = continuationReceipt
      ? {
          objectiveId: continuationReceipt.objectiveId,
          nextRunId: continuationReceipt.nextRunId,
          nextJobId: continuationReceipt.nextJobId,
          summary: continuationReceipt.summary,
        }
      : undefined;
    return {
      runId,
      problem: state.problem,
      status: state.status,
      finalResponse: state.finalResponse,
      startupObjectiveId: bindings.find(
        (binding) => binding.reason === "startup",
      )?.objectiveId,
      latestBoundObjectiveId: bindings.at(-1)?.objectiveId,
      bindings,
      continuation,
    };
  });
  const threadTimeline = chain
    .filter(
      (
        receipt,
      ): receipt is typeof receipt & {
        readonly body: Extract<
          AgentEvent,
          { readonly type: "thread.bound" | "run.continued" }
        >;
      } =>
        isThreadBoundEvent(receipt.body) || isRunContinuedEvent(receipt.body),
    )
    .map((receipt) => {
      const body = receipt.body;
      if (body.type === "thread.bound") {
        return {
          at: receipt.ts,
          type: body.type,
          runId: body.runId,
          objectiveId: body.objectiveId,
          reason: body.reason,
          created: body.created,
        };
      }
      return {
        at: receipt.ts,
        type: body.type,
        runId: body.runId,
        objectiveId: body.objectiveId,
        nextRunId: body.nextRunId,
        nextJobId: body.nextJobId,
      };
    });
  return {
    stream,
    receiptCount: chain.length,
    latestObjectiveId: [...threadTimeline]
      .reverse()
      .find((entry) => entry.type === "thread.bound")?.objectiveId,
    runs,
    threadTimeline,
  };
};

const renderChatReplayText = (
  replay: Awaited<ReturnType<typeof readChatReplay>>,
): string => {
  const lines = [
    replay.stream,
    `Receipts: ${replay.receiptCount}`,
    `Latest objective: ${replay.latestObjectiveId ?? "none"}`,
    "",
    "Runs:",
    ...replay.runs.flatMap((run) => [
      `- ${run.runId} [${run.status}] ${run.problem || ""}`.trim(),
      `  startup=${run.startupObjectiveId ?? "none"} latest=${run.latestBoundObjectiveId ?? "none"} continuation=${run.continuation?.objectiveId ?? "none"}`,
    ]),
  ];
  return lines.join("\n");
};

const printFactoryInvestigation = async (opts: {
  readonly cwd: string;
  readonly flags: Flags;
  readonly targetId?: string;
  readonly asJson: boolean;
}): Promise<void> => {
  const repoRootOverride = asString(opts.flags, "repo-root");
  const runtime = await resolveFactoryRuntimeConfig(opts.cwd, repoRootOverride);
  const dataDir = path.resolve(
    asString(opts.flags, "data-dir") ?? runtime.dataDir,
  );
  const repoRoot = path.resolve(repoRootOverride ?? runtime.repoRoot);
  const asOfTs = parseOptionalIntegerFlag(opts.flags, "as-of-ts");
  const report = await readFactoryReceiptInvestigation(
    dataDir,
    repoRoot,
    opts.targetId,
    typeof asOfTs === "number" ? { asOfTs } : {},
  );
  if (opts.asJson) {
    await printFactoryReadOutput({
      flags: opts.flags,
      asJson: true,
      value: report,
    });
    return;
  }
  const compact = parseBooleanFlag(opts.flags, "compact");
  const timelineLimit = parseIntegerFlag(
    opts.flags,
    "timeline-limit",
    compact ? 12 : 20,
    { min: 1, max: 1_000 },
  );
  const contextChars = parseIntegerFlag(
    opts.flags,
    "context-chars",
    compact ? 700 : 1_200,
    { min: 200, max: 20_000 },
  );
  await printFactoryReadOutput({
    flags: opts.flags,
    asJson: false,
    value: renderFactoryReceiptInvestigationText(report, {
      timelineLimit,
      contextChars,
      compact,
    }),
  });
};

const printFactoryAudit = async (opts: {
  readonly cwd: string;
  readonly flags: Flags;
  readonly asJson: boolean;
}): Promise<void> => {
  const repoRootOverride = asString(opts.flags, "repo-root");
  const runtime = await resolveFactoryRuntimeConfig(opts.cwd, repoRootOverride);
  const dataDir = path.resolve(
    asString(opts.flags, "data-dir") ?? runtime.dataDir,
  );
  const repoRoot = path.resolve(repoRootOverride ?? runtime.repoRoot);
  const limit = parseIntegerFlag(opts.flags, "limit", 12, { min: 1, max: 200 });
  const objectiveId = asString(opts.flags, "objective");
  const report = await readFactoryReceiptAudit(
    dataDir,
    repoRoot,
    limit,
    objectiveId,
  );
  if (opts.asJson) {
    await printFactoryReadOutput({
      flags: opts.flags,
      asJson: true,
      value: report,
    });
    return;
  }
  await printFactoryReadOutput({
    flags: opts.flags,
    asJson: false,
    value: renderFactoryReceiptAuditText(report),
  });
};

const isThreadBoundEvent = (
  event: AgentEvent,
): event is Extract<AgentEvent, { readonly type: "thread.bound" }> =>
  event.type === "thread.bound";

const isRunContinuedEvent = (
  event: AgentEvent,
): event is Extract<AgentEvent, { readonly type: "run.continued" }> =>
  event.type === "run.continued";

const printMutationResult = async (
  result: FactoryMutationResult,
  asJson: boolean,
): Promise<void> => {
  if (asJson) {
    await printJson({
      ok: true,
      kind: result.kind,
      action: result.action,
      ...(result.kind === "objective"
        ? {
            objectiveId: result.objectiveId,
            objective: result.objective,
            ...(result.note ? { note: result.note } : {}),
          }
        : {
            jobId: result.jobId,
            job: result.job,
            commandId: result.commandId,
          }),
    });
    return;
  }
  if (result.kind === "objective") {
    const verb =
      result.action === "compose" && result.note ? "reacted" : result.action;
    console.log(`${verb === "note" ? "noted" : verb} ${result.objectiveId}`);
    return;
  }
  console.log(`${result.action} queued for ${result.jobId}`);
};

const parseCodexProbeMode = (value: string | undefined): CodexProbeMode => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "both";
  if (
    normalized === "direct" ||
    normalized === "queue" ||
    normalized === "both"
  )
    return normalized;
  throw new Error(
    `Unsupported codex probe mode '${value}'. Use direct, queue, or both.`,
  );
};

const ensurePromptValue = async (opts: {
  readonly message: string;
  readonly initialValue?: string;
  readonly placeholder?: string;
}): Promise<string> => {
  const value = await text({
    message: opts.message,
    initialValue: opts.initialValue,
    placeholder: opts.placeholder,
    validate: (input) =>
      (input ?? "").trim().length > 0 ? undefined : "Value is required",
  });
  if (isCancel(value)) {
    cancel("Factory setup canceled.");
    throw new Error("Factory setup canceled");
  }
  return String(value).trim();
};

const initFactoryConfig = async (
  cwd: string,
  flags: Flags,
): Promise<FactoryCliConfig> => {
  const repoRoot = path.resolve(
    asString(flags, "repo-root") ?? (await detectGitRoot(cwd)) ?? cwd,
  );
  const gitRoot = await detectGitRoot(repoRoot);
  if (!gitRoot) {
    throw new Error(
      `Factory init requires a git repository. No repo found from ${repoRoot}`,
    );
  }

  const yes = parseBooleanFlag(flags, "yes");
  const force = parseBooleanFlag(flags, "force");
  const json = parseBooleanFlag(flags, "json");
  const defaultDataDir = path.resolve(
    repoRoot,
    asString(flags, "data-dir") ?? path.join(".receipt", "data"),
  );
  const detectedCodexPath = bunWhich("codex");
  const explicitCodexBin =
    asString(flags, "codex-bin") ?? process.env.RECEIPT_CODEX_BIN;
  const defaultCodexBin = explicitCodexBin ?? "codex";

  let dataDir = defaultDataDir;
  let codexBin = defaultCodexBin;

  if (isInteractiveTerminal() && !yes) {
    intro("Receipt Factory setup");
    dataDir = path.resolve(
      repoRoot,
      await ensurePromptValue({
        message: "Data directory",
        initialValue:
          path.relative(repoRoot, defaultDataDir) || ".receipt/data",
        placeholder: ".receipt/data",
      }),
    );
    codexBin = await ensurePromptValue({
      message: "Codex executable",
      initialValue: defaultCodexBin,
      placeholder: "codex",
    });
  }

  const runtime = createFactoryCliRuntime({
    configPath: path.join(repoRoot, ".receipt", "config.json"),
    repoRoot,
    dataDir,
    codexBin,
    repoSlotConcurrency: 20,
    defaultChecks: [],
    defaultPolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
    schedules: [],
  });
  const progress = isInteractiveTerminal() && !json ? spinner() : undefined;
  const profileStartedAt = Date.now();
  const profileSteps = ["Using checked-in Factory profiles and skills only."];
  const updateProgress = (message: string, started = true): void => {
    if (!progress) return;
    if (started) progress.message(`Profiling repository: ${message}`);
    else progress.start(`Profiling repository: ${message}`);
  };
  updateProgress("collecting repository status and Factory defaults", false);
  try {
    const compose = await runtime.service.buildComposeModel();
    updateProgress("collecting repo status and existing objectives");
    progress?.stop(
      `Repository profile collected in ${formatDurationMs(Date.now() - profileStartedAt)}`,
    );
    if (isInteractiveTerminal() && !json) {
      printSetupSummary({
        repoRoot,
        dataDir,
        codexBin,
        codexAvailable: Boolean(detectedCodexPath),
        branch: compose.sourceBranch ?? compose.defaultBranch,
        sourceDirty: compose.sourceDirty,
        profileSummary: compose.profileSummary,
        checks: compose.defaultValidationCommands,
        steps: profileSteps,
      });
    }
    let defaultChecks: string[] = [...compose.defaultValidationCommands];
    if (isInteractiveTerminal() && !yes) {
      const useDetected = await confirm({
        message: `Use detected validation commands?\n${defaultChecks.join("\n") || "(none)"}`,
        initialValue: true,
      });
      if (isCancel(useDetected)) {
        cancel("Factory setup canceled.");
        throw new Error("Factory setup canceled");
      }
      if (!useDetected) {
        defaultChecks = parseChecksInput(
          await ensurePromptValue({
            message: "Validation commands (comma or newline separated)",
            initialValue: defaultChecks.join("\n"),
            placeholder: "bun run build",
          }),
        );
      }
    }

    const stored: FactoryCliStoredConfig = {
      repoRoot: ".",
      dataDir: path.relative(repoRoot, dataDir) || ".",
      codexBin,
      defaultChecks,
      defaultPolicy: compose.defaultPolicy,
    };
    const configPath = await writeFactoryConfig(repoRoot, stored, force);
    const resolved = {
      configPath,
      repoRoot,
      dataDir,
      codexBin,
      repoSlotConcurrency: runtime.config.repoSlotConcurrency,
      defaultChecks,
      defaultPolicy: compose.defaultPolicy,
      schedules: [],
    } satisfies FactoryCliConfig;
    if (json) {
      await printJson({
        ok: true,
        config: resolved,
        profileSummary: compose.profileSummary,
        environment: {
          bunRuntime: resolveBunRuntime(),
          codexPath: detectedCodexPath,
          codexAvailable: Boolean(detectedCodexPath),
          openAiReady: Boolean(process.env.OPENAI_API_KEY?.trim()),
          sourceBranch: compose.sourceBranch ?? compose.defaultBranch,
          sourceDirty: compose.sourceDirty,
        },
      });
    } else if (isInteractiveTerminal() && !yes) {
      outro(
        [
          `Factory config written to ${configPath}`,
          `Next: bun run factory`,
          `Create objective: bun run factory run --title "Mission" --prompt "Describe the change"`,
        ].join("\n"),
      );
    } else {
      console.log(`factory config written: ${configPath}`);
    }
    return resolved;
  } finally {
    runtime.stop();
  }
};

const ensureFactoryConfig = async (
  cwd: string,
  flags: Flags,
): Promise<FactoryCliConfig> => {
  const loaded = await loadFactoryConfig(cwd, asString(flags, "repo-root"));
  if (loaded) return loaded;
  if (isInteractiveTerminal()) {
    return initFactoryConfig(cwd, flags);
  }
  throw new Error(
    "Factory is not initialized in this repo. Run `receipt factory init` first.",
  );
};

const runInteractiveFactoryApp = async (opts: {
  readonly runtime: ReturnType<typeof createFactoryCliRuntime>;
  readonly initialObjectiveId?: string;
  readonly initialPanel?: FactoryObjectivePanel;
  readonly exitOnTerminal?: boolean;
}): Promise<FactoryAppExit> => {
  let result: FactoryAppExit = {
    code: 0,
    reason: "quit",
    objectiveId: opts.initialObjectiveId,
  };
  const instance = render(
    React.createElement(FactoryTerminalApp, {
      runtime: opts.runtime,
      initialObjectiveId: opts.initialObjectiveId,
      initialPanel: opts.initialPanel,
      exitOnTerminal: opts.exitOnTerminal,
      onExit: (next: FactoryAppExit) => {
        result = next;
      },
    }),
  );
  await instance.waitUntilExit();
  return result;
};

const waitForObjectiveTerminal = async (
  runtime: ReturnType<typeof createFactoryCliRuntime>,
  objectiveId: string,
  opts: {
    readonly quiet?: boolean;
  } = {},
): Promise<FactoryAppExit> => {
  let terminalObservedAt: number | undefined;
  let lastPrintedKey: string | undefined;
  let lastPrintedAt = 0;
  let ttyWidth = 0;
  const quiet = opts.quiet === true;
  while (true) {
    const [detail, live] = await Promise.all([
      runtime.service.getObjective(objectiveId),
      runtime.service.buildLiveProjection(objectiveId).catch(() => undefined),
    ]);
    let auditStatus = await objectiveAuditStatus(runtime, objectiveId);
    const progress = renderObjectiveWaitLine({
      objectiveId,
      detail,
      live,
      auditStatus,
    });
    if (!quiet) {
      if (process.stdout.isTTY) {
        ttyWidth = Math.max(ttyWidth, progress.line.length);
        process.stdout.write(`\r${progress.line.padEnd(ttyWidth, " ")}`);
      } else if (
        progress.key !== lastPrintedKey ||
        Date.now() - lastPrintedAt >= 10_000
      ) {
        console.log(progress.line);
        lastPrintedKey = progress.key;
        lastPrintedAt = Date.now();
      }
    }
    const terminal =
      detail.status === "completed"
        ? { code: 0, reason: "completed" as const, objectiveId }
        : detail.status === "failed"
          ? { code: 1, reason: "failed" as const, objectiveId }
          : detail.status === "canceled"
            ? { code: 1, reason: "canceled" as const, objectiveId }
            : detail.status === "blocked"
              ? { code: 2, reason: "blocked" as const, objectiveId }
              : detail.integration.status === "conflicted"
                ? {
                    code: 1,
                    reason: "integration_conflicted" as const,
                    objectiveId,
                  }
                : !detail.policy.promotion.autoPromote &&
                    detail.integration.status === "ready_to_promote"
                  ? { code: 2, reason: "manual" as const, objectiveId }
                  : undefined;
    if (terminal) {
      if (
        auditStatus === "idle" &&
        (detail.status === "completed" ||
          detail.status === "failed" ||
          detail.status === "canceled" ||
          detail.status === "blocked")
      ) {
        await ensureObjectiveAuditQueued(runtime, detail);
        auditStatus = await objectiveAuditStatus(runtime, objectiveId);
      }
      if (auditStatus === "queued" || auditStatus === "running") {
        terminalObservedAt ??= Date.now();
      } else if (auditStatus === "idle") {
        terminalObservedAt ??= Date.now();
        if (Date.now() - terminalObservedAt >= 2_000) {
          if (!quiet && process.stdout.isTTY) process.stdout.write("\n");
          return terminal;
        }
      } else {
        if (!quiet && process.stdout.isTTY) process.stdout.write("\n");
        return terminal;
      }
    } else {
      terminalObservedAt = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
};

const printBoardSnapshot = async (
  runtime: ReturnType<typeof createFactoryCliRuntime>,
  asJson: boolean,
): Promise<void> => {
  const compose = await runtime.service.buildComposeModel();
  const board = await runtime.service.buildBoardProjection();
  const selectedObjectiveId = board.selectedObjectiveId;
  const selected = selectedObjectiveId
    ? await runtime.service
        .getObjective(selectedObjectiveId)
        .catch(() => undefined)
    : undefined;
  const live = selectedObjectiveId
    ? await runtime.service
        .buildLiveProjection(selectedObjectiveId)
        .catch(() => undefined)
    : undefined;
  if (asJson) {
    await printJson({ compose, board, selected, live });
    return;
  }
  console.log(renderBoardText({ compose, board, selected, live }));
};

const printObjectiveSnapshot = async (
  runtime: ReturnType<typeof createFactoryCliRuntime>,
  objectiveId: string,
  panel: FactoryObjectivePanel | undefined,
  asJson: boolean,
): Promise<void> => {
  const [detail, live, debug] = await Promise.all([
    runtime.service.getObjective(objectiveId),
    runtime.service.buildLiveProjection(objectiveId),
    runtime.service.getObjectiveDebug(objectiveId),
  ]);
  const resolvedPanel = panel ?? defaultObjectivePanelForDetail(detail);
  if (asJson) {
    await printJson({
      objectiveId,
      panel: resolvedPanel,
      data: panelValue(resolvedPanel, detail, live, debug),
    });
    return;
  }
  console.log(
    [
      renderObjectiveHeader(detail).join("\n"),
      renderObjectivePanelText(detail, live, debug, resolvedPanel),
    ].join("\n\n"),
  );
};

const resolveObjectivePanel = async (
  runtime: ReturnType<typeof createFactoryCliRuntime>,
  objectiveId: string,
  requestedPanel?: FactoryObjectivePanel,
): Promise<FactoryObjectivePanel> => {
  if (requestedPanel) return requestedPanel;
  const detail = await runtime.service.getObjective(objectiveId);
  return defaultObjectivePanelForDetail(detail);
};

export const handleFactoryCommand = async (
  cwd: string,
  args: ReadonlyArray<string>,
  flags: Flags,
): Promise<void> => {
  const subcommand = args[0];
  if (hasHelpFlag(flags)) {
    printFactoryUsage(isHelpToken(subcommand) ? undefined : subcommand);
    return;
  }
  if (isHelpToken(subcommand)) {
    printFactoryUsage(args[1]);
    return;
  }
  if (subcommand && isHelpToken(args[1])) {
    printFactoryUsage(subcommand);
    return;
  }
  const json = parseBooleanFlag(flags, "json");
  const objectiveMode = parseObjectiveModeFlag(flags);
  const severity = parseSeverityFlag(flags);

  if (subcommand === "init") {
    await initFactoryConfig(cwd, flags);
    return;
  }

  if (subcommand === "codex-probe") {
    const runtimeConfig = await resolveFactoryRuntimeConfig(
      cwd,
      asString(flags, "repo-root"),
    );
    const mode = parseCodexProbeMode(asString(flags, "mode"));
    const timeoutMs = parseIntegerFlag(flags, "timeout-ms", 120_000, {
      min: 30_000,
      max: 900_000,
    });
    const pollMs = parseIntegerFlag(flags, "poll-ms", 250, {
      min: 50,
      max: 10_000,
    });
    const reply =
      asString(flags, "reply") ?? `receipt-probe-${Date.now().toString(36)}`;
    const prompt =
      asString(flags, "prompt") ??
      [`Reply with exactly: ${reply}`, "Do not modify any files."].join("\n");
    const probeId = `codex-probe-${Date.now().toString(36)}`;
    const probeDataDir = path.resolve(
      asString(flags, "probe-dir") ??
        path.join(runtimeConfig.dataDir, "probes", probeId),
    );
    const report = await runFactoryCodexProbe(
      {
        configPath:
          runtimeConfig.configPath ??
          path.join(runtimeConfig.repoRoot, ".receipt", "config.json"),
        repoRoot: runtimeConfig.repoRoot,
        dataDir: runtimeConfig.dataDir,
        codexBin: runtimeConfig.codexBin,
        repoSlotConcurrency: runtimeConfig.repoSlotConcurrency,
        defaultChecks: [],
        defaultPolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
        schedules: [],
      },
      {
        mode,
        prompt,
        dataDir: probeDataDir,
        pollMs,
        timeoutMs,
      },
    );
    if (json) await printJson(report);
    else console.log(renderCodexProbeText(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (subcommand === "investigate") {
    const targetId = args[1];
    await printFactoryInvestigation({
      cwd,
      flags,
      targetId,
      asJson: json,
    });
    return;
  }

  if (subcommand === "audit") {
    await printFactoryAudit({
      cwd,
      flags,
      asJson: json,
    });
    return;
  }

  if (subcommand === "experiment") {
    const scenario = args[1] ?? "long-run";
    if (scenario !== "long-run") {
      throw new Error(
        `Unsupported factory experiment scenario '${scenario}'. Use 'long-run'.`,
      );
    }
    const sourceRepoRoot = path.resolve(
      asString(flags, "repo-root") ?? (await detectGitRoot(cwd)) ?? cwd,
    );
    const report = await runFactoryLongRunExperiment({
      sourceRepoRoot,
      outputDir: asString(flags, "output-dir"),
      codexBin: asString(flags, "codex-bin"),
      keepWorkdir: parseBooleanFlag(flags, "keep-workdir"),
    });
    if (json) {
      await printJson(report);
    } else {
      console.log(renderFactoryLongRunExperimentText(report));
    }
    return;
  }

  if (subcommand === "helper") {
    const helperCommand = args[1] ?? "list";
    const repoRoot = path.resolve(
      asString(flags, "repo-root") ?? (await detectGitRoot(cwd)) ?? cwd,
    );
    const domain = asString(flags, "domain") ?? "infrastructure";
    if (helperCommand === "list") {
      const provider = asString(flags, "provider");
      const helpers = await loadFactoryHelperCatalog(repoRoot, domain);
      const filtered = provider
        ? helpers.filter(
            (helper) => helper.provider === parseHelperProvider(provider),
          )
        : helpers;
      if (json) {
        await printJson(filtered);
      } else {
        const lines = filtered.flatMap((helper) => [
          `${helper.id} (${helper.provider})`,
          `  ${helper.description}`,
          `  tags: ${helper.tags.join(", ")}`,
        ]);
        console.log(lines.join("\n"));
      }
      return;
    }
    if (helperCommand === "run") {
      const helperId = args[2] ?? asString(flags, "id");
      if (!helperId) throw new Error("factory helper run requires a helper id");
      const provider = parseHelperProvider(asString(flags, "provider"));
      const helperArgs = [...args.slice(3), ...asStrings(flags, "helper-arg")];
      const result = await runFactoryHelper({
        profileRoot: repoRoot,
        helperId,
        provider,
        domain,
        helperArgs,
      });
      if (json) {
        await printJson(result);
      } else {
        console.log(result.summary);
      }
      if (result.status === "error") process.exitCode = 1;
      return;
    }
    throw new Error(
      `Unsupported factory helper command '${helperCommand}'. Use 'list' or 'run'.`,
    );
  }

  const config = await ensureFactoryConfig(cwd, flags);
  const runtime = createFactoryCliRuntime(config, {
    onWorkerError: (error) => {
      console.error(`factory worker error: ${error.message}`);
    },
  });

  try {
    switch (subcommand) {
      case undefined:
      case "board": {
        await runtime.start();
        if (json || !isInteractiveTerminal()) {
          await printBoardSnapshot(runtime, json);
          return;
        }
        const result = await runInteractiveFactoryApp({
          runtime,
        });
        process.exitCode = result.code;
        return;
      }
      case "run": {
        const prompt =
          asString(flags, "prompt") ??
          asString(flags, "problem") ??
          args.slice(1).join(" ").trim();
        if (!prompt)
          throw new Error(
            "factory run requires --prompt or trailing prompt text",
          );
        const explicitChecks = asStrings(flags, "check").flatMap(
          parseChecksInput,
        );
        const profileId = asString(flags, "profile");
        const policyOverride = mergePolicy(
          config.defaultPolicy,
          await readPolicyFile(asString(flags, "policy-file")),
        );
        await runtime.start();
        const checks = await resolveObjectiveChecks({
          repoRoot: config.repoRoot,
          profileRoot: runtime.service.profileRoot,
          profileId,
          explicitChecks,
          fallbackChecks: config.defaultChecks,
        });
        const created = await createObjectiveMutation(runtime, {
          prompt,
          title: asString(flags, "title"),
          baseHash: asString(flags, "base-hash"),
          objectiveMode,
          severity,
          checks,
          channel: asString(flags, "channel"),
          policy: policyOverride,
          profileId,
        });
        if (json || !isInteractiveTerminal()) {
          const result = await waitForObjectiveTerminal(
            runtime,
            created.objectiveId,
            { quiet: json },
          );
          await printObjectiveSnapshot(
            runtime,
            created.objectiveId,
            undefined,
            json,
          );
          process.exitCode = result.code;
          return;
        }
        const result = await runInteractiveFactoryApp({
          runtime,
          initialObjectiveId: created.objectiveId,
          exitOnTerminal: true,
        });
        await printObjectiveSnapshot(
          runtime,
          created.objectiveId,
          undefined,
          false,
        );
        process.exitCode = result.code;
        return;
      }
      case "create": {
        const prompt =
          asString(flags, "prompt") ??
          asString(flags, "problem") ??
          args.slice(1).join(" ").trim();
        if (!prompt)
          throw new Error(
            "factory create requires --prompt or trailing prompt text",
          );
        const explicitChecks = asStrings(flags, "check").flatMap(
          parseChecksInput,
        );
        const profileId = asString(flags, "profile");
        const policyOverride = mergePolicy(
          config.defaultPolicy,
          await readPolicyFile(asString(flags, "policy-file")),
        );
        const checks = await resolveObjectiveChecks({
          repoRoot: config.repoRoot,
          profileRoot: runtime.service.profileRoot,
          profileId,
          explicitChecks,
          fallbackChecks: config.defaultChecks,
        });
        const result = await createObjectiveMutation(runtime, {
          prompt,
          title: asString(flags, "title"),
          baseHash: asString(flags, "base-hash"),
          objectiveMode,
          severity,
          checks,
          channel: asString(flags, "channel"),
          policy: policyOverride,
          profileId,
        });
        await printMutationResult(result, json);
        return;
      }
      case "compose": {
        const prompt =
          asString(flags, "prompt") ??
          asString(flags, "problem") ??
          args.slice(1).join(" ").trim();
        if (!prompt)
          throw new Error(
            "factory compose requires --prompt or trailing prompt text",
          );
        const explicitChecks = asStrings(flags, "check").flatMap(
          parseChecksInput,
        );
        const profileId = asString(flags, "profile");
        const policyOverride = mergePolicy(
          config.defaultPolicy,
          await readPolicyFile(asString(flags, "policy-file")),
        );
        const checks = await resolveObjectiveChecks({
          repoRoot: config.repoRoot,
          profileRoot: runtime.service.profileRoot,
          profileId,
          explicitChecks,
          fallbackChecks: config.defaultChecks,
        });
        const result = await composeObjectiveMutation(runtime, {
          prompt,
          objectiveId: asString(flags, "objective"),
          title: asString(flags, "title"),
          baseHash: asString(flags, "base-hash"),
          objectiveMode,
          severity,
          checks,
          channel: asString(flags, "channel"),
          policy: policyOverride,
          profileId,
        });
        await printMutationResult(result, json);
        return;
      }
      case "watch": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory watch requires <objective-id>");
        const panelFlag = asString(flags, "panel");
        await runtime.start();
        if (json || !isInteractiveTerminal()) {
          await printObjectiveSnapshot(
            runtime,
            objectiveId,
            panelFlag ? parsePanel(panelFlag) : undefined,
            json,
          );
          return;
        }
        const initialPanel = await resolveObjectivePanel(
          runtime,
          objectiveId,
          panelFlag ? parsePanel(panelFlag) : undefined,
        );
        await runInteractiveFactoryApp({
          runtime,
          initialObjectiveId: objectiveId,
          initialPanel,
        });
        return;
      }
      case "inspect": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory inspect requires <objective-id>");
        const panelFlag = asString(flags, "panel");
        await runtime.service.ensureBootstrap();
        await printObjectiveSnapshot(
          runtime,
          objectiveId,
          panelFlag ? parsePanel(panelFlag) : undefined,
          json,
        );
        return;
      }
      case "replay": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory replay requires <objective-id>");
        const replay = await readObjectiveReplay(config.dataDir, objectiveId);
        if (json || !isInteractiveTerminal()) {
          await printFactoryReadOutput({
            flags,
            asJson: true,
            value: replay,
          });
          return;
        }
        await printFactoryReadOutput({
          flags,
          asJson: false,
          value: renderObjectiveReplayText(replay),
        });
        return;
      }
      case "replay-chat": {
        const stream = args[1];
        if (!stream)
          throw new Error("factory replay-chat requires <chat-or-run-stream>");
        const replay = await readChatReplay(config.dataDir, stream);
        if (json || !isInteractiveTerminal()) {
          await printFactoryReadOutput({
            flags,
            asJson: true,
            value: replay,
          });
          return;
        }
        await printFactoryReadOutput({
          flags,
          asJson: false,
          value: renderChatReplayText(replay),
        });
        return;
      }
      case "analyze": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory analyze requires <objective-id>");
        const analysis = await readObjectiveAnalysis(
          config.dataDir,
          objectiveId,
        );
        if (json || !isInteractiveTerminal()) {
          await printFactoryReadOutput({
            flags,
            asJson: true,
            value: analysis,
          });
          return;
        }
        await printFactoryReadOutput({
          flags,
          asJson: false,
          value: renderObjectiveAnalysisText(analysis),
        });
        return;
      }
      case "parse": {
        const targetId = args[1];
        const parsed = await readFactoryParsedRun(
          config.dataDir,
          config.repoRoot,
          targetId,
        );
        if (json || !isInteractiveTerminal()) {
          await printFactoryReadOutput({
            flags,
            asJson: true,
            value: parsed,
          });
          return;
        }
        await printFactoryReadOutput({
          flags,
          asJson: false,
          value: renderFactoryParsedRunText(parsed),
        });
        return;
      }
      case "resume": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory resume requires <objective-id>");
        await runtime.start();
        await reactObjectiveMutation(runtime, { objectiveId });
        if (json || !isInteractiveTerminal()) {
          const result = await waitForObjectiveTerminal(runtime, objectiveId);
          await printObjectiveSnapshot(runtime, objectiveId, undefined, json);
          process.exitCode = result.code;
          return;
        }
        const result = await runInteractiveFactoryApp({
          runtime,
          initialObjectiveId: objectiveId,
          exitOnTerminal: true,
        });
        await printObjectiveSnapshot(runtime, objectiveId, undefined, false);
        process.exitCode = result.code;
        return;
      }
      case "react": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory react requires <objective-id>");
        const trailingMessage = args.slice(2).join(" ").trim();
        const message =
          asString(flags, "message") ?? (trailingMessage || undefined);
        const result = await reactObjectiveMutation(runtime, {
          objectiveId,
          message,
        });
        await printMutationResult(result, json);
        return;
      }
      case "note": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory note requires <objective-id>");
        const trailingMessage = args.slice(2).join(" ").trim();
        const message =
          asString(flags, "message") ?? (trailingMessage || undefined);
        if (!message) {
          throw new Error(
            "factory note requires --message or trailing note text",
          );
        }
        const result = await noteObjectiveMutation(runtime, {
          objectiveId,
          message,
        });
        await printMutationResult(result, json);
        return;
      }
      case "promote": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory promote requires <objective-id>");
        const result = await promoteObjectiveMutation(runtime, objectiveId);
        await printMutationResult(result, json);
        return;
      }
      case "cancel": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory cancel requires <objective-id>");
        const result = await cancelObjectiveMutation(runtime, {
          objectiveId,
          reason: asString(flags, "reason") ?? "canceled from CLI",
        });
        await printMutationResult(result, json);
        return;
      }
      case "cleanup": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory cleanup requires <objective-id>");
        const result = await cleanupObjectiveMutation(runtime, objectiveId);
        await printMutationResult(result, json);
        return;
      }
      case "archive": {
        const objectiveId = args[1];
        if (!objectiveId)
          throw new Error("factory archive requires <objective-id>");
        const result = await archiveObjectiveMutation(runtime, objectiveId);
        await printMutationResult(result, json);
        return;
      }
      case "abort-job": {
        const jobId = args[1];
        if (!jobId) throw new Error("factory abort-job requires <job-id>");
        const trailingReason = args.slice(2).join(" ").trim();
        const result = await abortJobMutation(runtime, {
          jobId,
          reason: asString(flags, "reason") ?? (trailingReason || undefined),
        });
        await printMutationResult(result, json);
        return;
      }
      case "steer": {
        const jobId = args[1];
        if (!jobId) throw new Error("factory steer requires <job-id>");
        const trailingMessage = args.slice(2).join(" ").trim();
        const message =
          asString(flags, "message") ?? (trailingMessage || undefined);
        if (!message)
          throw new Error(
            "factory steer requires --message or trailing message text",
          );
        const result = await steerJobMutation(runtime, {
          jobId,
          message,
        });
        await printMutationResult(result, json);
        return;
      }
      case "follow-up": {
        const jobId = args[1];
        if (!jobId) throw new Error("factory follow-up requires <job-id>");
        const trailingMessage = args.slice(2).join(" ").trim();
        const message =
          asString(flags, "message") ?? (trailingMessage || undefined);
        if (!message)
          throw new Error(
            "factory follow-up requires --message or trailing message text",
          );
        const result = await followUpJobMutation(runtime, {
          jobId,
          message,
        });
        await printMutationResult(result, json);
        return;
      }
      default:
        throw new Error(`Unknown factory subcommand '${subcommand}'`);
    }
  } finally {
    runtime.stop();
  }
};
