import path from "node:path";

import React from "react";
import { cancel, confirm, intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import { render } from "ink";

import type { Flags } from "../cli.types.js";
import type { FactoryObjectivePolicy } from "../modules/factory.js";
import { DEFAULT_FACTORY_OBJECTIVE_POLICY } from "../modules/factory.js";
import { bunWhich, resolveBunRuntime } from "../lib/runtime-paths.js";
import {
  abortJobMutation,
  archiveObjectiveMutation,
  cancelObjectiveMutation,
  cleanupObjectiveMutation,
  composeObjectiveMutation,
  createObjectiveMutation,
  followUpJobMutation,
  promoteObjectiveMutation,
  reactObjectiveMutation,
  steerJobMutation,
  type FactoryMutationResult,
} from "./actions.js";
import { FactoryTerminalApp, type FactoryAppExit } from "./app.js";
import {
  detectGitRoot,
  type FactoryCliConfig,
  type FactoryCliStoredConfig,
  isInteractiveTerminal,
  loadFactoryConfig,
  resolveFactoryRuntimeConfig,
  writeFactoryConfig,
} from "./config.js";
import { renderCodexProbeText, runFactoryCodexProbe, type CodexProbeMode } from "./codex-probe.js";
import { renderBoardText, renderObjectiveHeader, renderObjectivePanelText } from "./format.js";
import { createFactoryCliRuntime } from "./runtime.js";
import { terminalTheme } from "./theme.js";
import type { FactoryObjectivePanel } from "./view-model.js";

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

const parseJsonObjectFlag = (value: string | undefined, label: string): Record<string, unknown> | undefined => {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  throw new Error(`${label} must be a JSON object`);
};

const deriveTitle = (title: string | undefined, prompt: string): string => {
  const provided = title?.trim();
  if (provided) return provided;
  const compact = prompt.replace(/\s+/g, " ").trim();
  const firstSentence = compact.split(/[.!?]/)[0] ?? compact;
  return firstSentence.slice(0, 96).trim() || "Factory objective";
};

const mergePolicy = (base: FactoryObjectivePolicy, override: FactoryObjectivePolicy | undefined): FactoryObjectivePolicy => {
  if (!override) return base;
  return {
    concurrency: { ...(base.concurrency ?? {}), ...(override.concurrency ?? {}) },
    budgets: { ...(base.budgets ?? {}), ...(override.budgets ?? {}) },
    throttles: { ...(base.throttles ?? {}), ...(override.throttles ?? {}) },
    mutation: { ...(base.mutation ?? {}), ...(override.mutation ?? {}) },
    promotion: { ...(base.promotion ?? {}), ...(override.promotion ?? {}) },
  };
};

const parseChecksInput = (value: string): string[] =>
  value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);

const formatDurationMs = (durationMs: number): string => {
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
};

const friendlyProfileStep = (step: string, message: string): string =>
  step === "bootstrap" ? "Verified git repository and Factory workspace state"
  : step === "cache" ? "Checked repo-profile cache"
  : step === "scan" ? "Scanned package metadata, README, and repo layout"
  : step === "infer_checks" ? `Detected validation commands: ${message.replace(/^Detected validation commands:\s*/i, "")}`
  : step === "llm" ? "Generated repo summary and skill suggestions"
  : step === "write_skills" ? "Wrote generated repo skill files"
  : step === "persist" ? "Saved repository profile artifacts"
  : step === "complete" ? "Repository profile is ready"
  : message;

const printSetupSummary = (opts: {
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly codexBin: string;
  readonly codexAvailable: boolean;
  readonly branch: string;
  readonly sourceDirty: boolean;
  readonly repoProfileStatus: string;
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
    `  ${marker} Repo profile: ${opts.repoProfileStatus}`,
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
        repoProfile: detail.repoProfile,
        blockedExplanation: detail.blockedExplanation,
        latestDecision: detail.latestDecision,
      };
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
  return panel && ["overview", "tasks", "candidates", "evidence", "activity", "live", "debug", "receipts"].includes(panel)
    ? panel
    : "overview";
};

const printJson = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};

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
  const label = result.action === "follow_up" ? "follow-up" : result.action === "abort" ? "abort" : "steer";
  console.log(`${label} queued for ${result.jobId}`);
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

const ensureSelectValue = async (opts: {
  readonly message: string;
  readonly initialValue: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string; readonly hint?: string }>;
}): Promise<string> => {
  const value = await select({
    message: opts.message,
    initialValue: opts.initialValue,
    options: opts.options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
    })),
  });
  if (isCancel(value)) {
    cancel("Factory setup canceled.");
    throw new Error("Factory setup canceled");
  }
  return String(value);
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
  const defaultCodexBin = asString(flags, "codex-bin") ?? process.env.RECEIPT_CODEX_BIN ?? process.env.HUB_CODEX_BIN ?? detectedCodexPath ?? "codex";

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
  });
  const progress = isInteractiveTerminal() && !json ? spinner() : undefined;
  const profileStartedAt = Date.now();
  const profileSteps: string[] = [];
  const updateProgress = (message: string, started = true): void => {
    if (!progress) return;
    if (started) progress.message(`Profiling repository: ${message}`);
    else progress.start(`Profiling repository: ${message}`);
  };
  updateProgress("checking git repository and Factory state", false);
  try {
    const repoProfile = await runtime.service.prepareRepoProfile({
      onProgress: (event) => {
        updateProgress(event.message);
        const summary = friendlyProfileStep(event.step, event.message);
        if (!profileSteps.includes(summary)) {
          profileSteps.push(summary);
        }
      },
    });
    updateProgress("collecting repo status and existing objectives");
    const compose = await runtime.service.buildComposeModel();
    progress?.stop(`Repository profile collected in ${formatDurationMs(Date.now() - profileStartedAt)}`);
    if (isInteractiveTerminal() && !json) {
      printSetupSummary({
        repoRoot,
        dataDir,
        codexBin,
        codexAvailable: Boolean(detectedCodexPath),
        branch: compose.sourceBranch ?? compose.defaultBranch,
        sourceDirty: compose.sourceDirty,
        repoProfileStatus: compose.repoProfile.status,
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
          placeholder: "npm run build",
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
    } satisfies FactoryCliConfig;
    if (json) {
      printJson({
        ok: true,
        config: resolved,
        repoProfile,
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
    const terminal =
      detail.status === "completed" ? { code: 0, reason: "completed" as const, objectiveId } :
      detail.status === "failed" ? { code: 1, reason: "failed" as const, objectiveId } :
      detail.status === "canceled" ? { code: 1, reason: "canceled" as const, objectiveId } :
      detail.status === "blocked" ? { code: 2, reason: "blocked" as const, objectiveId } :
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
  panel: FactoryObjectivePanel,
  asJson: boolean,
): Promise<void> => {
  const [detail, live, debug] = await Promise.all([
    runtime.service.getObjective(objectiveId),
    runtime.service.buildLiveProjection(objectiveId),
    runtime.service.getObjectiveDebug(objectiveId),
  ]);
  if (asJson) {
    printJson({
      objectiveId,
      panel,
      data: panelValue(panel, detail, live, debug),
    });
    return;
  }
  console.log([
    renderObjectiveHeader(detail).join("\n"),
    renderObjectivePanelText(detail, live, debug, panel),
  ].join("\n\n"));
};

export const handleFactoryCommand = async (cwd: string, args: ReadonlyArray<string>, flags: Flags): Promise<void> => {
  const subcommand = args[0];
  const json = parseBooleanFlag(flags, "json");

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
          title: deriveTitle(asString(flags, "title"), prompt),
          baseHash: asString(flags, "base-hash"),
          checks: explicitChecks.length ? explicitChecks : config.defaultChecks,
          channel: asString(flags, "channel"),
          policy: policyOverride,
          profileId: asString(flags, "profile"),
        });
        if (json || !isInteractiveTerminal()) {
          const result = await waitForObjectiveTerminal(runtime, created.objectiveId);
          await printObjectiveSnapshot(runtime, created.objectiveId, "overview", json);
          process.exitCode = result.code;
          return;
        }
        const result = await runInteractiveFactoryApp({
          runtime,
          initialMode: "objective",
          initialObjectiveId: created.objectiveId,
          exitOnTerminal: true,
        });
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
          title: deriveTitle(asString(flags, "title"), prompt),
          baseHash: asString(flags, "base-hash"),
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
          title: deriveTitle(asString(flags, "title"), prompt),
          baseHash: asString(flags, "base-hash"),
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
        await runtime.start();
        if (json || !isInteractiveTerminal()) {
          await printObjectiveSnapshot(runtime, objectiveId, parsePanel(asString(flags, "panel")), json);
          return;
        }
        await runInteractiveFactoryApp({
          runtime,
          initialMode: "objective",
          initialObjectiveId: objectiveId,
          initialPanel: parsePanel(asString(flags, "panel")),
        });
        return;
      }
      case "inspect": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory inspect requires <objective-id>");
        await runtime.service.ensureBootstrap();
        await printObjectiveSnapshot(runtime, objectiveId, parsePanel(asString(flags, "panel")), json);
        return;
      }
      case "resume": {
        const objectiveId = args[1];
        if (!objectiveId) throw new Error("factory resume requires <objective-id>");
        await runtime.start();
        await reactObjectiveMutation(runtime, { objectiveId });
        if (json || !isInteractiveTerminal()) {
          const result = await waitForObjectiveTerminal(runtime, objectiveId);
          await printObjectiveSnapshot(runtime, objectiveId, "overview", json);
          process.exitCode = result.code;
          return;
        }
        const result = await runInteractiveFactoryApp({
          runtime,
          initialMode: "objective",
          initialObjectiveId: objectiveId,
          exitOnTerminal: true,
        });
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
      case "steer": {
        const jobId = args[1];
        if (!jobId) throw new Error("factory steer requires <job-id>");
        const trailingProblem = args.slice(2).join(" ").trim();
        const problem = asString(flags, "problem") ?? (trailingProblem || undefined);
        const configOverride = parseJsonObjectFlag(asString(flags, "config"), "--config");
        const result = await steerJobMutation(runtime, {
          jobId,
          problem,
          config: configOverride,
        });
        printMutationResult(result, json);
        return;
      }
      case "follow-up": {
        const jobId = args[1];
        if (!jobId) throw new Error("factory follow-up requires <job-id>");
        const note = asString(flags, "note") ?? args.slice(2).join(" ").trim();
        if (!note) throw new Error("factory follow-up requires --note or trailing note text");
        const result = await followUpJobMutation(runtime, { jobId, note });
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
