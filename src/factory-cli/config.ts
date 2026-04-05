import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { HeartbeatSpec } from "../adapters/heartbeat";
import type { JobLane } from "../modules/job";
import type { FactoryObjectivePolicy } from "../modules/factory";
import { DEFAULT_FACTORY_OBJECTIVE_POLICY } from "../modules/factory";

const execFileAsync = promisify(execFile);

export type FactoryCliStoredConfig = {
  readonly repoRoot?: string;
  readonly dataDir?: string;
  readonly codexBin?: string;
  readonly repoSlotConcurrency?: number;
  readonly defaultChecks?: ReadonlyArray<string>;
  readonly defaultPolicy?: FactoryObjectivePolicy;
  readonly schedules?: ReadonlyArray<FactoryCliStoredSchedule>;
};

export type FactoryCliConfig = {
  readonly configPath: string;
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly codexBin: string;
  readonly repoSlotConcurrency: number;
  readonly defaultChecks: ReadonlyArray<string>;
  readonly defaultPolicy: FactoryObjectivePolicy;
  readonly schedules: ReadonlyArray<HeartbeatSpec>;
};

export type FactoryRuntimeConfig = {
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly codexBin: string;
  readonly repoSlotConcurrency: number;
  readonly configPath?: string;
  readonly schedules: ReadonlyArray<HeartbeatSpec>;
};

export type FactoryCliStoredSchedule = {
  readonly id?: string;
  readonly enabled?: boolean;
  readonly agentId?: string;
  readonly intervalMs?: number;
  readonly lane?: JobLane;
  readonly sessionKey?: string;
  readonly singletonMode?: "allow" | "cancel" | "steer";
  readonly maxAttempts?: number;
  readonly payload?: Record<string, unknown>;
};

const CONFIG_DIR = ".receipt";
const CONFIG_NAME = "config.json";
const DEFAULT_FACTORY_REPO_SLOT_CONCURRENCY = 20;

const envString = (...values: ReadonlyArray<string | undefined>): string | undefined =>
  values.map((value) => value?.trim()).find((value) => Boolean(value));

const positiveInteger = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
};

const toAbsolute = (baseDir: string, value: string | undefined, fallback: string): string => {
  const selected = value?.trim() || fallback;
  return path.resolve(baseDir, selected);
};

const uniqueChecks = (values: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const normalizeLane = (value: unknown): JobLane =>
  value === "chat" || value === "collect" || value === "steer" || value === "follow_up"
    ? value
    : "collect";

const normalizeSingletonMode = (value: unknown): "allow" | "cancel" | "steer" =>
  value === "allow" || value === "cancel" || value === "steer"
    ? value
    : "cancel";

const normalizeSchedules = (value: unknown): ReadonlyArray<HeartbeatSpec> => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Factory config schedules must be an array");
  const schedules: HeartbeatSpec[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) throw new Error(`Factory config schedule at index ${index} must be an object`);
    if (entry.enabled === false) continue;
    const agentId = asNonEmptyString(entry.agentId);
    if (!agentId) throw new Error(`Factory config schedule at index ${index} requires agentId`);
    const intervalMsRaw = typeof entry.intervalMs === "number" && Number.isFinite(entry.intervalMs)
      ? Math.floor(entry.intervalMs)
      : Number.NaN;
    if (!Number.isFinite(intervalMsRaw) || intervalMsRaw < 1_000) {
      throw new Error(`Factory config schedule '${agentId}' must set intervalMs >= 1000`);
    }
    if (!isRecord(entry.payload)) {
      throw new Error(`Factory config schedule '${agentId}' requires payload to be an object`);
    }
    const id = asNonEmptyString(entry.id) ?? `schedule:${agentId}:${index + 1}`;
    if (seenIds.has(id)) throw new Error(`Factory config has duplicate schedule id '${id}'`);
    seenIds.add(id);
    schedules.push({
      id,
      agentId,
      intervalMs: intervalMsRaw,
      lane: normalizeLane(entry.lane),
      sessionKey: asNonEmptyString(entry.sessionKey) ?? `schedule:${id}`,
      singletonMode: normalizeSingletonMode(entry.singletonMode),
      maxAttempts: typeof entry.maxAttempts === "number" && Number.isFinite(entry.maxAttempts)
        ? Math.max(1, Math.min(Math.floor(entry.maxAttempts), 8))
        : 1,
      payload: entry.payload as Record<string, unknown>,
    });
  }
  return schedules;
};

export const isInteractiveTerminal = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY);

const defaultFactoryConfigPath = (repoRoot: string): string =>
  path.join(repoRoot, CONFIG_DIR, CONFIG_NAME);

export const detectGitRoot = async (cwd: string): Promise<string | undefined> => {
  try {
    await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf-8",
    });
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
    });
    const root = stdout.trim();
    return root ? path.resolve(root) : undefined;
  } catch {
    return undefined;
  }
};

const findFactoryConfig = async (startDir: string): Promise<string | undefined> => {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = defaultFactoryConfigPath(current);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
};

export const loadFactoryConfig = async (cwd: string, repoRootOverride?: string): Promise<FactoryCliConfig | undefined> => {
  const configuredRepoRoot = envString(repoRootOverride, process.env.RECEIPT_REPO_ROOT);
  const configPath = configuredRepoRoot
    ? defaultFactoryConfigPath(path.resolve(configuredRepoRoot))
    : await findFactoryConfig(cwd);
  if (!configPath) return undefined;

  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    return undefined;
  }
  const parsed = raw.trim()
    ? JSON.parse(raw) as FactoryCliStoredConfig
    : {};
  const configBaseDir = path.dirname(path.dirname(configPath));
  const repoRoot = toAbsolute(
    configBaseDir,
    envString(configuredRepoRoot, parsed.repoRoot),
    ".",
  );
  const dataDir = envString(process.env.RECEIPT_DATA_DIR, process.env.DATA_DIR)
    ? path.resolve(envString(process.env.RECEIPT_DATA_DIR, process.env.DATA_DIR)!)
    : toAbsolute(configBaseDir, parsed.dataDir, path.join(".receipt", "data"));
  return {
    configPath,
    repoRoot,
    dataDir,
    codexBin: envString(process.env.RECEIPT_CODEX_BIN, parsed.codexBin) ?? "codex",
    repoSlotConcurrency: positiveInteger(
      envString(process.env.RECEIPT_FACTORY_REPO_SLOT_CONCURRENCY),
      positiveInteger(parsed.repoSlotConcurrency, DEFAULT_FACTORY_REPO_SLOT_CONCURRENCY),
    ),
    defaultChecks: uniqueChecks(parsed.defaultChecks),
    defaultPolicy: parsed.defaultPolicy ?? DEFAULT_FACTORY_OBJECTIVE_POLICY,
    schedules: normalizeSchedules(parsed.schedules),
  };
};

export const resolveFactoryRuntimeConfig = async (
  cwd: string,
  repoRootOverride?: string,
): Promise<FactoryRuntimeConfig> => {
  const normalizedCwd = path.resolve(cwd);
  const gitRoot = await detectGitRoot(normalizedCwd);
  const configuredRepoRoot = envString(repoRootOverride, process.env.RECEIPT_REPO_ROOT);
  if (!gitRoot && !configuredRepoRoot) {
    throw new Error(
      `Factory runtime config requires a git repository or RECEIPT_REPO_ROOT. cwd=${normalizedCwd} failed: git -C ${normalizedCwd} rev-parse --is-inside-work-tree`,
    );
  }

  const loaded = await loadFactoryConfig(cwd, repoRootOverride);
  if (loaded) {
    return {
      repoRoot: loaded.repoRoot,
      dataDir: loaded.dataDir,
      codexBin: loaded.codexBin,
      repoSlotConcurrency: loaded.repoSlotConcurrency,
      configPath: loaded.configPath,
      schedules: loaded.schedules,
    };
  }

  const fallbackRepoRoot = path.resolve(configuredRepoRoot ?? gitRoot ?? normalizedCwd);
  const explicitDataDir = envString(process.env.RECEIPT_DATA_DIR, process.env.DATA_DIR);
  return {
    repoRoot: fallbackRepoRoot,
    dataDir: explicitDataDir ? path.resolve(explicitDataDir) : path.join(fallbackRepoRoot, ".receipt", "data"),
    codexBin: envString(process.env.RECEIPT_CODEX_BIN) ?? "codex",
    repoSlotConcurrency: positiveInteger(
      envString(process.env.RECEIPT_FACTORY_REPO_SLOT_CONCURRENCY),
      DEFAULT_FACTORY_REPO_SLOT_CONCURRENCY,
    ),
    schedules: [],
  };
};

export const writeFactoryConfig = async (
  repoRoot: string,
  config: FactoryCliStoredConfig,
  force = false,
): Promise<string> => {
  const configPath = defaultFactoryConfigPath(repoRoot);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  if (!force) {
    try {
      await fs.access(configPath);
      throw new Error(`Factory config already exists at ${configPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  return configPath;
};
