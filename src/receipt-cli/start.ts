import { execFile } from "node:child_process";
import { promisify } from "node:util";

import OpenAI from "openai";
import { cancel, confirm, intro, isCancel, outro, password, select, text } from "@clack/prompts";

import type { Flags } from "../cli.types";
import {
  loadReceiptCliConfig,
  resolveReceiptCliConfigPath,
  type ReceiptCliConfig,
  writeReceiptCliConfig,
} from "./config";

const execFileAsync = promisify(execFile);

type AwsIdentity = {
  readonly profile?: string;
  readonly accountId: string;
  readonly arn: string;
};

const asString = (flags: Flags, key: string): string | undefined => {
  const value = flags[key];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === "string" ? value : undefined;
};

const asBoolean = (flags: Flags, key: string): boolean =>
  flags[key] === true || flags[key] === "true";

const ensurePromptText = async (message: string, initialValue?: string): Promise<string> => {
  const value = await text({
    message,
    ...(initialValue ? { initialValue } : {}),
    validate: (input) => input.trim().length > 0 ? undefined : "This value is required.",
  });
  if (isCancel(value)) {
    cancel("Setup canceled.");
    throw new Error("setup canceled");
  }
  return String(value).trim();
};

const ensurePromptPassword = async (message: string): Promise<string> => {
  const value = await password({
    message,
    mask: "*",
    validate: (input) => input.trim().length > 0 ? undefined : "This value is required.",
  });
  if (isCancel(value)) {
    cancel("Setup canceled.");
    throw new Error("setup canceled");
  }
  return String(value).trim();
};

const askRetry = async (message: string): Promise<boolean> => {
  const value = await confirm({ message, initialValue: true });
  if (isCancel(value)) {
    cancel("Setup canceled.");
    throw new Error("setup canceled");
  }
  return Boolean(value);
};

const runCommand = async (
  command: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], { encoding: "utf-8" });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout?.trim() ?? "",
      stderr: err.stderr?.trim() ?? "",
    };
  }
};

const ensureBinaryInstalled = async (name: "gh" | "aws"): Promise<void> => {
  while (true) {
    const checked = await runCommand(name, ["--version"]);
    if (checked.ok) return;
    console.log(`\n${name} is not installed or not on PATH.`);
    if (name === "gh") {
      console.log("Install GitHub CLI: https://cli.github.com/");
    } else {
      console.log("Install AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html");
    }
    const retry = await askRetry(`Retry ${name} check now?`);
    if (!retry) throw new Error(`${name} is required`);
  }
};

const extractGithubAccounts = (output: string): ReadonlyArray<string> => {
  const accounts = new Set<string>();
  for (const match of output.matchAll(/account\s+([A-Za-z0-9-]+)/g)) {
    if (match[1]) accounts.add(match[1]);
  }
  for (const match of output.matchAll(/\b([A-Za-z0-9-]+)\s+\(.*active.*\)/gi)) {
    if (match[1]) accounts.add(match[1]);
  }
  return [...accounts];
};

const ensureGithubLogin = async (): Promise<string> => {
  while (true) {
    const status = await runCommand("gh", ["auth", "status", "--hostname", "github.com"]);
    if (!status.ok) {
      console.log("\nGitHub is not authenticated for github.com.");
      console.log("Run: gh auth login");
      const retry = await askRetry("Retry GitHub auth check now?");
      if (!retry) throw new Error("GitHub login is required");
      continue;
    }

    const accounts = extractGithubAccounts(`${status.stdout}\n${status.stderr}`);
    if (accounts.length === 0) {
      const fallback = await ensurePromptText("GitHub username to save");
      return fallback;
    }
    if (accounts.length === 1) return accounts[0];

    const selected = await select({
      message: "Select GitHub account for receipt",
      options: accounts.map((account) => ({ label: account, value: account })),
    });
    if (isCancel(selected)) {
      cancel("Setup canceled.");
      throw new Error("setup canceled");
    }
    await runCommand("gh", ["auth", "switch", "--hostname", "github.com", "--user", String(selected)]);
    return String(selected);
  }
};

const parseAwsIdentity = (raw: string): AwsIdentity | undefined => {
  try {
    const parsed = JSON.parse(raw) as { Account?: string; Arn?: string };
    if (!parsed.Account || !parsed.Arn) return undefined;
    return {
      accountId: parsed.Account,
      arn: parsed.Arn,
    };
  } catch {
    return undefined;
  }
};

const getAwsProfiles = async (): Promise<ReadonlyArray<string>> => {
  const listed = await runCommand("aws", ["configure", "list-profiles"]);
  if (!listed.ok) return [];
  return listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

const getAwsIdentity = async (profile?: string): Promise<AwsIdentity | undefined> => {
  const args = ["sts", "get-caller-identity", "--output", "json"];
  if (profile) args.push("--profile", profile);
  const result = await runCommand("aws", args);
  if (!result.ok) return undefined;
  const identity = parseAwsIdentity(result.stdout);
  if (!identity) return undefined;
  return profile ? { ...identity, profile } : identity;
};

const ensureAwsIdentity = async (): Promise<AwsIdentity> => {
  while (true) {
    const identities = new Map<string, AwsIdentity>();
    const profiles = await getAwsProfiles();
    for (const profile of profiles) {
      const identity = await getAwsIdentity(profile);
      if (!identity) continue;
      const key = `${identity.accountId}:${identity.arn}:${profile}`;
      identities.set(key, identity);
    }

    const defaultIdentity = await getAwsIdentity();
    if (defaultIdentity) {
      const key = `${defaultIdentity.accountId}:${defaultIdentity.arn}:default`;
      identities.set(key, defaultIdentity);
    }

    const options = [...identities.values()];
    if (options.length === 0) {
      console.log("\nAWS is not authenticated.");
      console.log("Run one of: aws configure, aws sso login, or export AWS credentials.");
      const retry = await askRetry("Retry AWS auth check now?");
      if (!retry) throw new Error("AWS login is required");
      continue;
    }

    if (options.length === 1) return options[0];

    const selected = await select({
      message: "Select AWS account/profile for receipt",
      options: options.map((item) => ({
        label: `${item.accountId} ${item.profile ? `(profile: ${item.profile})` : "(default credentials)"}`,
        value: JSON.stringify(item),
      })),
    });
    if (isCancel(selected)) {
      cancel("Setup canceled.");
      throw new Error("setup canceled");
    }
    const parsed = JSON.parse(String(selected)) as AwsIdentity;
    return parsed;
  }
};

const validateOpenAiKey = async (apiKey: string): Promise<boolean> => {
  try {
    const client = new OpenAI({ apiKey });
    await client.models.list();
    return true;
  } catch {
    return false;
  }
};

const ensureOpenAiKey = async (initial?: string): Promise<string> => {
  let candidate = initial?.trim();
  while (true) {
    if (!candidate) {
      candidate = await ensurePromptPassword("OpenAI API Key (required)");
    }
    const valid = await validateOpenAiKey(candidate);
    if (valid) return candidate;
    console.log("\nOpenAI key validation failed.");
    const retry = await askRetry("Try entering the OpenAI key again?");
    if (!retry) throw new Error("OpenAI key is required");
    candidate = undefined;
  }
};

const maskKey = (value: string): string =>
  value.length <= 8 ? "********" : `${value.slice(0, 4)}...${value.slice(-4)}`;

const printExistingSetup = (config: ReceiptCliConfig): void => {
  console.log([
    "Receipt setup is already complete.",
    `Config: ${resolveReceiptCliConfigPath()}`,
    `GitHub: ${config.github.username}@${config.github.hostname}`,
    `AWS: ${config.aws.accountId}${config.aws.profile ? ` (profile ${config.aws.profile})` : ""}`,
    `OpenAI: ${maskKey(config.openai.apiKey)}`,
    "Run `receipt start --reset` to reconfigure.",
  ].join("\n"));
};

export const runReceiptStart = async (flags: Flags): Promise<void> => {
  const reset = asBoolean(flags, "reset");
  const existing = await loadReceiptCliConfig();
  if (existing && !reset) {
    printExistingSetup(existing);
    return;
  }

  intro("Receipt CLI setup");
  const openaiKey = await ensureOpenAiKey(asString(flags, "openai-key") ?? process.env.OPENAI_API_KEY);
  await ensureBinaryInstalled("gh");
  const githubUsername = await ensureGithubLogin();
  await ensureBinaryInstalled("aws");
  const awsIdentity = await ensureAwsIdentity();
  const config: ReceiptCliConfig = {
    version: 1,
    setupCompletedAt: new Date().toISOString(),
    openai: { apiKey: openaiKey },
    github: {
      hostname: "github.com",
      username: githubUsername,
    },
    aws: awsIdentity,
  };
  const configPath = await writeReceiptCliConfig(config);
  outro([
    "Receipt setup complete.",
    `Config saved: ${configPath}`,
    `GitHub: ${config.github.username}@${config.github.hostname}`,
    `AWS: ${config.aws.accountId}${config.aws.profile ? ` (profile ${config.aws.profile})` : ""}`,
    `OpenAI: ${maskKey(config.openai.apiKey)}`,
  ].join("\n"));
};
