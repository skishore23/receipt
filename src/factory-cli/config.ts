import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { FactoryObjectivePolicy } from "../modules/factory.js";
import { DEFAULT_FACTORY_OBJECTIVE_POLICY } from "../modules/factory.js";

const execFileAsync = promisify(execFile);

export type FactoryCliStoredConfig = {
  readonly repoRoot?: string;
  readonly dataDir?: string;
  readonly codexBin?: string;
  readonly orchestratorMode?: "enabled" | "disabled";
  readonly defaultChecks?: ReadonlyArray<string>;
  readonly defaultPolicy?: FactoryObjectivePolicy;
};

export type FactoryCliConfig = {
  readonly configPath: string;
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly codexBin: string;
  readonly orchestratorMode: "enabled" | "disabled";
  readonly defaultChecks: ReadonlyArray<string>;
  readonly defaultPolicy: FactoryObjectivePolicy;
};

export type FactoryRuntimeConfig = {
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly codexBin: string;
  readonly orchestratorMode: "enabled" | "disabled";
  readonly configPath?: string;
};

const CONFIG_DIR = ".receipt";
const CONFIG_NAME = "config.json";

const envString = (...values: ReadonlyArray<string | undefined>): string | undefined =>
  values.map((value) => value?.trim()).find((value) => Boolean(value));

const toAbsolute = (baseDir: string, value: string | undefined, fallback: string): string => {
  const selected = value?.trim() || fallback;
  return path.resolve(baseDir, selected);
};

const uniqueChecks = (values: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];

export const isInteractiveTerminal = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY);

export const defaultFactoryConfigPath = (repoRoot: string): string =>
  path.join(repoRoot, CONFIG_DIR, CONFIG_NAME);

export const detectGitRoot = async (cwd: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
    });
    const root = stdout.trim();
    return root ? path.resolve(root) : undefined;
  } catch {
    return undefined;
  }
};

export const findFactoryConfig = async (startDir: string): Promise<string | undefined> => {
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
  const configuredRepoRoot = envString(repoRootOverride, process.env.RECEIPT_REPO_ROOT, process.env.HUB_REPO_ROOT);
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
    codexBin: envString(process.env.RECEIPT_CODEX_BIN, process.env.HUB_CODEX_BIN, parsed.codexBin) ?? "codex",
    orchestratorMode: envString(process.env.FACTORY_ORCHESTRATOR_MODE, parsed.orchestratorMode) === "enabled" ? "enabled" : "disabled",
    defaultChecks: uniqueChecks(parsed.defaultChecks),
    defaultPolicy: parsed.defaultPolicy ?? DEFAULT_FACTORY_OBJECTIVE_POLICY,
  };
};

export const resolveFactoryRuntimeConfig = async (
  cwd: string,
  repoRootOverride?: string,
): Promise<FactoryRuntimeConfig> => {
  const loaded = await loadFactoryConfig(cwd, repoRootOverride);
  if (loaded) {
    return {
      repoRoot: loaded.repoRoot,
      dataDir: loaded.dataDir,
      codexBin: loaded.codexBin,
      orchestratorMode: loaded.orchestratorMode,
      configPath: loaded.configPath,
    };
  }

  const configuredRepoRoot = envString(repoRootOverride, process.env.RECEIPT_REPO_ROOT, process.env.HUB_REPO_ROOT);
  const fallbackRepoRoot = path.resolve(configuredRepoRoot ?? await detectGitRoot(cwd) ?? cwd);
  const explicitDataDir = envString(process.env.RECEIPT_DATA_DIR, process.env.DATA_DIR);
  return {
    repoRoot: fallbackRepoRoot,
    dataDir: explicitDataDir ? path.resolve(explicitDataDir) : path.join(fallbackRepoRoot, "data"),
    codexBin: envString(process.env.RECEIPT_CODEX_BIN, process.env.HUB_CODEX_BIN) ?? "codex",
    orchestratorMode: envString(process.env.FACTORY_ORCHESTRATOR_MODE) === "enabled" ? "enabled" : "disabled",
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
