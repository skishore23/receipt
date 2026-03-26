import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ReceiptCliConfig = {
  readonly version: 1;
  readonly setupCompletedAt: string;
  readonly openai: {
    readonly apiKey: string;
  };
  readonly github: {
    readonly hostname: "github.com";
    readonly username: string;
  };
  readonly aws: {
    readonly profile?: string;
    readonly accountId: string;
    readonly arn: string;
  };
};

export type ReceiptCliConfigState =
  | {
      readonly status: "missing";
      readonly configPath: string;
    }
  | {
      readonly status: "valid";
      readonly configPath: string;
      readonly config: ReceiptCliConfig;
    }
  | {
      readonly status: "invalid";
      readonly configPath: string;
      readonly reason: string;
    };

const CONFIG_DIR_NAME = ".receipt";
const CONFIG_FILE_NAME = "config.json";

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export const resolveReceiptCliConfigPath = (homeDir = os.homedir()): string =>
  path.join(homeDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);

export const readReceiptCliConfigState = async (homeDir = os.homedir()): Promise<ReceiptCliConfigState> => {
  const configPath = resolveReceiptCliConfigPath(homeDir);
  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    return { status: "missing", configPath };
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isObject(parsed)) {
    return { status: "invalid", configPath, reason: "config must be a JSON object" };
  }
  if (parsed.version !== 1) {
    return { status: "invalid", configPath, reason: "unsupported config version" };
  }

  const openai = isObject(parsed.openai) ? parsed.openai : undefined;
  const github = isObject(parsed.github) ? parsed.github : undefined;
  const aws = isObject(parsed.aws) ? parsed.aws : undefined;
  if (!openai || !github || !aws) {
    return { status: "invalid", configPath, reason: "openai, github, and aws sections are required" };
  }

  const apiKey = asString(openai.apiKey);
  const username = asString(github.username);
  const hostname = asString(github.hostname);
  const accountId = asString(aws.accountId);
  const arn = asString(aws.arn);
  if (!apiKey || !username || !accountId || !arn || hostname !== "github.com") {
    return { status: "invalid", configPath, reason: "config has missing or invalid credential fields" };
  }

  const config: ReceiptCliConfig = {
    version: 1,
    setupCompletedAt: asString(parsed.setupCompletedAt) ?? new Date(0).toISOString(),
    openai: { apiKey },
    github: { hostname: "github.com", username },
    aws: {
      ...(asString(aws.profile) ? { profile: asString(aws.profile)! } : {}),
      accountId,
      arn,
    },
  };
  return {
    status: "valid",
    configPath,
    config,
  };
};

export const loadReceiptCliConfig = async (homeDir = os.homedir()): Promise<ReceiptCliConfig | undefined> => {
  const loaded = await readReceiptCliConfigState(homeDir);
  return loaded.status === "valid" ? loaded.config : undefined;
};

export const writeReceiptCliConfig = async (
  config: ReceiptCliConfig,
  homeDir = os.homedir(),
): Promise<string> => {
  const configPath = resolveReceiptCliConfigPath(homeDir);
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(configDir, 0o700);
    const dirMode = (await fs.stat(configDir)).mode & 0o777;
    if (dirMode !== 0o700) {
      throw new Error(`Cannot secure config directory permissions at ${configDir}`);
    }
  }
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    await fs.chmod(configPath, 0o600);
    const fileMode = (await fs.stat(configPath)).mode & 0o777;
    if (fileMode !== 0o600) {
      throw new Error(`Cannot secure config file permissions at ${configPath}`);
    }
  }
  return configPath;
};

export const hydrateEnvFromReceiptCliConfig = (config: ReceiptCliConfig | undefined): void => {
  if (!config) return;
  if (!process.env.OPENAI_API_KEY?.trim()) {
    process.env.OPENAI_API_KEY = config.openai.apiKey;
  }
  process.env.RECEIPT_GITHUB_HOST = config.github.hostname;
  process.env.RECEIPT_GITHUB_USER = config.github.username;
  if (config.aws.profile) {
    process.env.AWS_PROFILE = config.aws.profile;
    process.env.RECEIPT_AWS_PROFILE = config.aws.profile;
  }
  process.env.RECEIPT_AWS_ACCOUNT_ID = config.aws.accountId;
  process.env.RECEIPT_AWS_ARN = config.aws.arn;
};
