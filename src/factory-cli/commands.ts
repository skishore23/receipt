import path from "node:path";

import React from "react";
import { cancel, confirm, intro, isCancel, outro, spinner, text } from "@clack/prompts";
import { render } from "ink";

import { fold } from "@receipt/core/chain";
import { jsonlStore } from "../adapters/jsonl";
import type { Flags } from "../cli.types";
import type { AgentEvent } from "../modules/agent";
import { initial as initialAgent, reduce as reduceAgent } from "../modules/agent";
import type { FactoryObjectiveMode, FactoryObjectivePolicy, FactoryObjectiveSeverity, FactoryEvent, FactoryTaskRecord, FactoryCandidateRecord } from "../modules/factory";
import { DEFAULT_FACTORY_OBJECTIVE_POLICY, buildFactoryProjection, initialFactoryState, reduceFactory } from "../modules/factory";
import { bunWhich, resolveBunRuntime } from "../lib/runtime-paths";
import {
  abortJobMutation,
  archiveObjectiveMutation,
  cancelObjectiveMutation,
  cleanupObjectiveMutation,
  composeObjectiveMutation,
  createObjectiveMutation,
  promoteObjectiveMutation,
  reactObjectiveMutation,
  type FactoryMutationResult,
} from "./actions";
import { FactoryTerminalApp, type FactoryAppExit } from "./app";
import {
  detectGitRoot,
  type FactoryCliConfig,
  type FactoryCliStoredConfig,
  isInteractiveTerminal,
  loadFactoryConfig,
  resolveFactoryRuntimeConfig,
  writeFactoryConfig,
} from "./config";
import { renderCodexProbeText, runFactoryCodexProbe, type CodexProbeMode } from "./codex-probe";
import { renderBoardText, renderObjectiveHeader, renderObjectivePanelText } from "./format";
import { buildInvestigationReportPanelValue, defaultObjectivePanelForDetail } from "./investigation-report";
import { createFactoryCliRuntime } from "./runtime";
import { terminalTheme } from "./theme";
import type { FactoryObjectivePanel } from "./view-model";
import { readObjectiveAnalysis, renderObjectiveAnalysisText } from "./analyze";
import { loadFactoryHelperCatalog, runFactoryHelper } from "../services/factory-helper-catalog";
import type { FactoryCloudProvider } from "../services/factory-cloud-context";

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

const mergePolicy = (base: FactoryObjectivePolicy, override: FactoryObjectivePolicy | undefined): FactoryObjectivePolicy => {
  if (!override) return base;
  return {
    concurrency: { ...(base.concurrency ?? {}), ...(override.concurrency ?? {}) },
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

const parseObjectiveModeFlag = (flags: Flags): FactoryObjectiveMode | undefined => {
  const value = asString(flags, "objective-mode")?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "delivery" || value === "investigation") return value;
  throw new Error(`--objective-mode must be 'delivery' or 'investigation'`);
};

const parseSeverityFlag = (flags: Flags): FactoryObjectiveSeverity | undefined => {
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

const readPolicyFile = async (filePath: string | undefined): Promise<FactoryObjectivePolicy | undefined> => {
  if (!filePath) return undefined;
  const loaded = await import("node:fs/promises").then((fs) => fs.readFile(path.resolve(filePath), "utf-8"));
  const parsed = JSON.parse(loaded) as FactoryObjectivePolicy;
  return parsed;
};

const panelValue = (
  panel: FactoryObjectivePanel,
  detail: Awaited<ReturnType<ReturnType<typeof createFactoryCliRuntime>["service"]["getObjective"]>>,
  live: Awaited<ReturnType<ReturnType<typeof createFactoryCliRuntime>["service"]["buildLiveProjection"]>>,
  debug: Awaited<ReturnType<ReturnType<typeof createFactoryCliRuntime>["service"]["getObjectiveDebug"]>>,
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
  const panel = value?.trim().toLowerCase() as FactoryObjectivePanel | undefined;
  return panel && ["overview", "report", "tasks", "candidates", "evidence", "activity", "live", "debug", "receipts"].includes(panel)
    ? panel
    : "overview";
};

const printJson = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};

const parseHelperProvider = (value: string | undefined): FactoryCloudProvider => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "aws") return "aws";
  if (normalized === "gcp" || normalized === "azure") return normalized;
  throw new Error(`Unsupported helper provider '${value}'. Use aws, gcp, or azure.`);
};

const objectiveReplayStream = (objectiveIdOrStream: string): {
  readonly objectiveId: string;
  readonly stream: string;
} => {
  const raw = objectiveIdOrStream.trim();
  const stream = raw.startsWith("factory/objectives/") ? raw : `factory/objectives/${raw}`;
  const objectiveId = stream.replace(/^factory\/objectives\//, "");
  return { objectiveId, stream };
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

const readObjectiveReplay = async (dataDir: string, objectiveIdOrStream: string) => {
  const { objectiveId, stream } = objectiveReplayStream(objectiveIdOrStream);
  const chain = await jsonlStore<FactoryEvent>(dataDir).read(stream);
  if (chain.length === 0) {
    throw new Error(`No receipts found for ${stream}`);
  }
  const state = fold(chain, reduceFactory, initialFactoryState);
  const projection = buildFactoryProjection(state);
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

const renderObjectiveReplayText = (replay: Awaited<ReturnType<typeof readObjectiveReplay>>): string => {
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
    ...replay.tasks.map((task) =>
      `- ${task.taskId} [${task.status}]${task.dependsOn.length ? ` dependsOn=${task.dependsOn.join(",")}` : ""}${task.blockedReason ? ` blocked=${task.blockedReason}` : ""}`,
    ),
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
};

const readChatReplay = async (dataDir: string, stream: string) => {
  const chain = await jsonlStore<AgentEvent>(dataDir).read(stream);
  if (chain.length === 0) {
    throw new Error(`No receipts found for ${stream}`);
  }
  const runChains = new Map<string, Array<(typeof chain)[number]>>();
  for (const receipt of chain) {
    const runId = typeof receipt.body.runId === "string" ? receipt.body.runId : undefined;
    if (!runId) continue;
    const existing = runChains.get(runId);
    if (existing) existing.push(receipt);
    else runChains.set(runId, [receipt]);
  }
  const runs = [...runChains.entries()].map(([runId, runChain]) => {
    const state = fold(runChain, reduceAgent, initialAgent);
    const bindings = runChain
      .filter((receipt): receipt is typeof receipt & { readonly body: Extract<AgentEvent, { readonly type: "thread.bound" }> } =>
        isThreadBoundEvent(receipt.body))
      .map((receipt) => {
        const body = receipt.body;
        return {
          at: receipt.ts,
          objectiveId: body.objectiveId,
          reason: body.reason,
          created: body.created,
        };
      });
    const continuationReceipt = [...runChain].reverse()
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
      startupObjectiveId: bindings.find((binding) => binding.reason === "startup")?.objectiveId,
      latestBoundObjectiveId: bindings.at(-1)?.objectiveId,
      bindings,
      continuation,
    };
  });
  const threadTimeline = chain
    .filter((receipt): receipt is typeof receipt & {
      readonly body: Extract<AgentEvent, { readonly type: "thread.bound" | "run.continued" }>;
    } => isThreadBoundEvent(receipt.body) || isRunContinuedEvent(receipt.body))
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
    latestObjectiveId: [...threadTimeline].reverse().find((entry) => entry.type === "thread.bound")?.objectiveId,
    runs,
    threadTimeline,
  };
};

const renderChatReplayText = (replay: Awaited<ReturnType<typeof readChatReplay>>): string => {
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

const isThreadBoundEvent = (
  event: AgentEvent,
): event is Extract<AgentEvent, { readonly type: "thread.bound" }> =>
  event.type === "thread.bound";

const isRunContinuedEvent = (
  event: AgentEvent,
): event is Extract<AgentEvent, { readonly type: "run.continued" }> =>
  event.type === "run.continued";

const printMutationResult = (
  result: FactoryMutationResult,
  asJson: boolean,
): void => {
  if (asJson) {
    printJson({
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
    const verb = result.action === "compose" && result.note ? "reacted" : result.action;
    console.log(`${verb} ${result.objectiveId}`);
    return;
  }
  console.log(`${result.action} queued for ${result.jobId}`);
};

const parseCodexProbeMode = (value: string | undefined): CodexProbeMode => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "both";
  if (normalized === "direct" || normalized === "queue" || normalized === "both") return normalized;
  throw new Error(`Unsupported codex probe mode '${value}'. Use direct, queue, or both.`);
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
    validate: (input) => (input ?? "").trim().length > 0 ? undefined : "Value is required",
  });
  if (isCancel(value)) {
    cancel("Factory setup canceled.");
    throw new Error("Factory setup canceled");
  }
  return String(value).trim();
};

const initFactoryConfig = async (cwd: string, flags: Flags): Promise<FactoryCliConfig> => {
  const repoRoot = path.resolve(asString(flags, "repo-root") ?? await detectGitRoot(cwd) ?? cwd);
  const gitRoot = await detectGitRoot(repoRoot);
  if (!gitRoot) {
    throw new Error(`Factory init requires a git repository. No repo found from ${repoRoot}`);
  }

  const yes = parseBooleanFlag(flags, "yes");
  const force = parseBooleanFlag(flags, "force");
  const json = parseBooleanFlag(flags, "json");
  const defaultDataDir = path.resolve(repoRoot, asString(flags, "data-dir") ?? path.join(".receipt", "data"));
  const detectedCodexPath = bunWhich("codex");
  const explicitCodexBin = asString(flags, "codex-bin") ?? process.env.RECEIPT_CODEX_BIN ?? process.env.HUB_CODEX_BIN;
  const defaultCodexBin = explicitCodexBin ?? "codex";

  let dataDir = defaultDataDir;
  let codexBin = defaultCodexBin;

  if (isInteractiveTerminal() && !yes) {
    intro("Receipt Factory setup");
    dataDir = path.resolve(repoRoot, await ensurePromptValue({
      message: "Data directory",
      initialValue: path.relative(repoRoot, defaultDataDir) || ".receipt/data",
      placeholder: ".receipt/data",
    }));
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
    progress?.stop(`Repository profile collected in ${formatDurationMs(Date.now() - profileStartedAt)}`);
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
        defaultChecks = parseChecksInput(await ensurePromptValue({
          message: "Validation commands (comma or newline separated)",
          initialValue: defaultChecks.join("\n"),
          placeholder: "bun run build",
        }));
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
      defaultChecks,
      defaultPolicy: compose.defaultPolicy,
      schedules: [],
    } satisfies FactoryCliConfig;
    if (json) {
      printJson({
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
      outro([
        `Factory config written to ${configPath}`,
        `Next: bun run factory`,
        `Create objective: bun run factory run --title "Mission" --prompt "Describe the change"`,
      ].join("\n"));
    } else {
      console.log(`factory config written: ${configPath}`);
    }
    return resolved;
  } finally {
    runtime.stop();
  }
};

const ensureFactoryConfig = async (cwd: string, flags: Flags): Promise<FactoryCliConfig> => {
  const loaded = await loadFactoryConfig(cwd, asString(flags, "repo-root"));
  if (loaded) return loaded;
  if (isInteractiveTerminal()) {
    return initFactoryConfig(cwd, flags);
  }
  throw new Error("Factory is not initialized in this repo. Run `receipt factory init` first.");
};

const runInteractiveFactoryApp = async (opts: {
  readonly runtime: ReturnType<typeof createFactoryCliRuntime>;
  readonly initialMode: "board" | "objective";
  readonly initialObjectiveId?: string;
  readonly initialPanel?: FactoryObjectivePanel;
  readonly exitOnTerminal?: boolean;
}): Promise<FactoryAppExit> => {
  let result: FactoryAppExit = { code: 0, reason: "quit", objectiveId: opts.initialObjectiveId };
  const instance = render(React.createElement(FactoryTerminalApp, {
    runtime: opts.runtime,
    initialMode: opts.initialMode,
    initialObjectiveId: opts.initialObjectiveId,
    initialPanel: opts.initialPanel,
    exitOnTerminal: opts.exitOnTerminal,
    onExit: (next: FactoryAppExit) => {
      result = next;
    },
  }));
  await instance.waitUntilExit();
  return result;
};

const waitForObjectiveTerminal = async (
  runtime: ReturnType<typeof createFactoryCliRuntime>,
  objectiveId: string,
): Promise<FactoryAppExit> => {
  while (true) {
    const detail = await runtime.service.getObjective(objectiveId);
    console.log(`waiting... obj=${objectiveId.slice(-6)} status=${detail.status} int=${detail.integration.status} cands=${detail.candidates.length} tasks=${detail.tasks.map(t => `${t.taskId.slice(-2)}(${t.status.slice(0, 3)})`).join(",")}`);
    const terminal =
      detail.status === "completed" ? { code: 0, reason: "completed" as const, objectiveId } :
      detail.status === "failed" ? { code: 1, reason: "failed" as const, objectiveId } :
      detail.status === "canceled" ? { code: 1, reason: "canceled" as const, objectiveId } :
      detail.status === "blocked" ? { code: 2, reason: "blocked" as const, objectiveId } :
      detail.integration.status === "conflicted" ? { code: 1, reason: "integration_conflicted" as const, objectiveId } :
      (!detail.policy.promotion.autoPromote && detail.integration.status === "ready_to_promote")
        ? { code: 2, reason: "manual" as const, objectiveId }
        : undefined;
    if (terminal) return terminal;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
};

const printBoardSnapshot = async (runtime: ReturnType<typeof createFactoryCliRuntime>, asJson: boolean): Promise<void> => {
  const compose = await runtime.service.buildComposeModel();
  const board = await runtime.service.buildBoardProjection();
  const selectedObjectiveId = board.selectedObjectiveId;
  const selected = selectedObjectiveId ? await runtime.service.getObjective(selectedObjectiveId).catch(() => undefined) : undefined;
  const live = selectedObjectiveId ? await runtime.service.buildLiveProjection(selectedObjectiveId).catch(() => undefined) : undefined;
  if (asJson) {
    printJson({ compose, board, selected, live });
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
    printJson({
      objectiveId,
      panel: resolvedPanel,
      data: panelValue(resolvedPanel, detail, live, debug),
    });
    return;
  }
  console.log([
    renderObjectiveHeader(detail).join("\n"),
    renderObjectivePanelText(detail, live, debug, resolvedPanel),
  ].join("\n\n"));
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

export const handleFactoryCommand = async (cwd: string, args: ReadonlyArray<string>, flags: Flags): Promise<void> => {
  const subcommand = args[0];
  const json = parseBooleanFlag(flags, "json");
  const objectiveMode = parseObjectiveModeFlag(flags);
  const severity = parseSeverityFlag(flags);

  if (subcommand === "init") {
    await initFactoryConfig(cwd, flags);
    return;
  }

  if (subcommand === "codex-probe") {
    const runtimeConfig = await resolveFactoryRuntimeConfig(cwd, asString(flags, "repo-root"));
    const mode = parseCodexProbeMode(asString(flags, "mode"));
    const timeoutMs = parseIntegerFlag(flags, "timeout-ms", 120_000, { min: 30_000, max: 900_000 });
    const pollMs = parseIntegerFlag(flags, "poll-ms", 250, { min: 50, max: 10_000 });
    const reply = asString(flags, "reply") ?? `receipt-probe-${Date.now().toString(36)}`;
    const prompt = asString(flags, "prompt") ?? [
      `Reply with exactly: ${reply}`,
      "Do not modify any files.",
    ].join("\n");
    const probeId = `codex-probe-${Date.now().toString(36)}`;
    const probeDataDir = path.resolve(
      asString(flags, "probe-dir") ?? path.join(runtimeConfig.dataDir, "probes", probeId),
    );
    const report = await runFactoryCodexProbe({
      configPath: runtimeConfig.configPath ?? path.join(runtimeConfig.repoRoot, ".receipt", "config.json"),
      repoRoot: runtimeConfig.repoRoot,
      dataDir: runtimeConfig.dataDir,
      codexBin: runtimeConfig.codexBin,
      defaultChecks: [],
      defaultPolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      schedules: [],
    }, {
      mode,
      prompt,
      dataDir: probeDataDir,
      pollMs,
      timeoutMs,
    });
    if (json) printJson(report);
    else console.log(renderCodexProbeText(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (subcommand === "helper") {
    const helperCommand = args[1] ?? "list";
    const repoRoot = path.resolve(asString(flags, "repo-root") ?? await detectGitRoot(cwd) ?? cwd);
    const domain = asString(flags, "domain") ?? "infrastructure";
    if (helperCommand === "list") {
      const provider = asString(flags, "provider");
      const helpers = await loadFactoryHelperCatalog(repoRoot, domain);
      const filtered = provider
        ? helpers.filter((helper) => helper.provider === parseHelperProvider(provider))
        : helpers;
      if (json) {
        printJson(filtered);
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
      const helperArgs = [
        ...args.slice(3),
        ...asStrings(flags, "helper-arg"),
      ];
      const result = await runFactoryHelper({
        profileRoot: repoRoot,
        helperId,
        provider,
        domain,
        helperArgs,
      });
      if (json) {
        printJson(result);
      } else {
        console.log(result.summary);
      }
      if (result.status === "error") process.exitCode = 1;
      return;
    }
    throw new Error(`Unsupported factory helper command '${helperCommand}'. Use 'list' or 'run'.`);
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
          initialMode: "board",
        });
        process.exitCode = result.code;
        return;
      }
      case "run": {
        const prompt = asString(flags, "prompt") ?? asString(flags, "problem") ?? args.slice(1).join(" ").trim();
        if (!prompt) throw new Error("factory run requires --prompt or trailing prompt text");
        const explicitChecks = asStrings(flags, "check").flatMap(parseChecksInput);
        const policyOverride = mergePolicy(
          config.defaultPolicy,
          await readPolicyFile(asString(flags, "policy-file")),
        );
        await runtime.start();
        const created = await createObjectiveMutation(runtime, {
          prompt,
          title: asString(flags, "title"),
          baseHash: asString(flags, "base-hash"),
          objectiveMode,
          severity,
          checks: explicitChecks.length ? explicitChecks : config.defaultChecks,
          channel: asString(flags, "channel"),
          policy: policyOverride,
          profileId: asString(flags, "profile"),
        });
        if (json || !isInteractiveTerminal()) {
          const result = await waitForObjectiveTerminal(runtime, created.objectiveId);
          await printObjectiveSnapshot(runtime, created.objectiveId, undefined, json);
          process.exitCode = result.code;
          return;
        }
        const result = await runInteractiveFactoryApp({
          runtime,
          initialMode: "objective",
          initialObjectiveId: created.objectiveId,
          exitOnTerminal: true,
        });
        await printObjectiveSnapshot(runtime, created.objectiveId, undefined, false);
        process.exitCode = result.code;
        return;
      }
      case "create": {
        const prompt = asString(flags, "prompt") ?? asString(flags, "problem") ?? args.slice(1).join(" ").trim();
        if (!prompt) throw new Error("factory create requires --prompt or trailing prompt text");
        const explicitChecks = asStrings(flags, "check").flatMap(parseChecksInput);
        const policyOverride = mergePolicy(
          config.defaultPolicy,
          await readPolicyFile(asString(flags, "policy-file")),
        );
        const result = await createObjectiveMutation(runtime, {
          prompt,
          title: asString(flags, "title"),
          baseHash: asString(flags, "base-hash"),
          objectiveMode,
          severity,
          checks: explicitChecks.length ? explicitChecks : config.defaultChecks,
          channel: asString(flags, "channel"),
          policy: policyOverride,
          profileId: asString(flags, "profile"),
        });
        printMutationResult(result, json);
        return;
      }
      case "compose": {
        const prompt = asString(flags, "prompt") ?? asString(flags, "problem") ?? args.slice(1).join(" ").trim();
        if (!prompt) throw new Error("factory compose requires --prompt or trailing prompt text");
        const explicitChecks = asStrings(flags, "check").flatMap(parseChecksInput);
        const policyOverride = mergePolicy(
          config.defaultPolicy,
          await readPolicyFile(asString(flags, "policy-file")),
        );
        const result = await composeObjectiveMutation(runtime, {
          prompt,
          objectiveId: asString(flags, "objective"),
          title: asString(flags, "title"),
          baseHash: asString(flags, "base-hash"),
          objectiveMode,
          severity,
          checks: explicitChecks.length ? explicitChecks : config.defaultChecks,
          channel: asString(flags, "channel"),
          policy: policyOverride,
          profileId: asString(flags, "profile"),
        });
        printMutationResult(result, json);
        return;
      }
      case "watch": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory watch requires <objective-id>");
        const panelFlag = asString(flags, "panel");
        await runtime.start();
        if (json || !isInteractiveTerminal()) {
          await printObjectiveSnapshot(runtime, objectiveId, panelFlag ? parsePanel(panelFlag) : undefined, json);
          return;
        }
        const initialPanel = await resolveObjectivePanel(runtime, objectiveId, panelFlag ? parsePanel(panelFlag) : undefined);
        await runInteractiveFactoryApp({
          runtime,
          initialMode: "objective",
          initialObjectiveId: objectiveId,
          initialPanel,
        });
        return;
      }
      case "inspect": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory inspect requires <objective-id>");
        const panelFlag = asString(flags, "panel");
        await runtime.service.ensureBootstrap();
        await printObjectiveSnapshot(runtime, objectiveId, panelFlag ? parsePanel(panelFlag) : undefined, json);
        return;
      }
      case "replay": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory replay requires <objective-id>");
        const replay = await readObjectiveReplay(config.dataDir, objectiveId);
        if (json || !isInteractiveTerminal()) {
          printJson(replay);
          return;
        }
        console.log(renderObjectiveReplayText(replay));
        return;
      }
      case "replay-chat": {
        const stream = args[1];
        if (!stream) throw new Error("factory replay-chat requires <chat-or-run-stream>");
        const replay = await readChatReplay(config.dataDir, stream);
        if (json || !isInteractiveTerminal()) {
          printJson(replay);
          return;
        }
        console.log(renderChatReplayText(replay));
        return;
      }
      case "analyze": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory analyze requires <objective-id>");
        const analysis = await readObjectiveAnalysis(config.dataDir, objectiveId);
        if (json || !isInteractiveTerminal()) {
          printJson(analysis);
          return;
        }
        console.log(renderObjectiveAnalysisText(analysis));
        return;
      }
      case "resume": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory resume requires <objective-id>");
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
          initialMode: "objective",
          initialObjectiveId: objectiveId,
          exitOnTerminal: true,
        });
        await printObjectiveSnapshot(runtime, objectiveId, undefined, false);
        process.exitCode = result.code;
        return;
      }
      case "react": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory react requires <objective-id>");
        const trailingMessage = args.slice(2).join(" ").trim();
        const message = asString(flags, "message") ?? (trailingMessage || undefined);
        const result = await reactObjectiveMutation(runtime, { objectiveId, message });
        printMutationResult(result, json);
        return;
      }
      case "promote": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory promote requires <objective-id>");
        const result = await promoteObjectiveMutation(runtime, objectiveId);
        printMutationResult(result, json);
        return;
      }
      case "cancel": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory cancel requires <objective-id>");
        const result = await cancelObjectiveMutation(runtime, {
          objectiveId,
          reason: asString(flags, "reason") ?? "canceled from CLI",
        });
        printMutationResult(result, json);
        return;
      }
      case "cleanup": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory cleanup requires <objective-id>");
        const result = await cleanupObjectiveMutation(runtime, objectiveId);
        printMutationResult(result, json);
        return;
      }
      case "archive": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory archive requires <objective-id>");
        const result = await archiveObjectiveMutation(runtime, objectiveId);
        printMutationResult(result, json);
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
        printMutationResult(result, json);
        return;
      }
      default:
        throw new Error(`Unknown factory subcommand '${subcommand}'`);
    }
  } finally {
    runtime.stop();
  }
};
