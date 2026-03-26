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

type JsonObject = Record<string, unknown>;
type CommandResult = { readonly ok: boolean; readonly stdout: string; readonly stderr: string };
type SelectOption = { readonly label: string; readonly value: string };

type StartDeps = {
  readonly runCommand?: (command: string, args: ReadonlyArray<string>) => Promise<CommandResult>;
  readonly askRetry?: (message: string) => Promise<boolean>;
  readonly ensurePromptText?: (message: string, initialValue?: string) => Promise<string>;
  readonly ensurePromptPassword?: (message: string) => Promise<string>;
  readonly confirmPrompt?: (message: string, initialValue?: boolean) => Promise<boolean>;
  readonly selectPrompt?: (message: string, options: ReadonlyArray<SelectOption>) => Promise<string>;
  readonly validateOpenAiKey?: (apiKey: string) => Promise<boolean>;
  readonly loadReceiptCliConfig?: () => Promise<ReceiptCliConfig | undefined>;
  readonly writeReceiptCliConfig?: (config: ReceiptCliConfig) => Promise<string>;
  readonly intro?: (message: string) => void;
  readonly outro?: (message: string) => void;
  readonly log?: (message: string) => void;
  readonly platform?: NodeJS.Platform;
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

const confirmPrompt = async (message: string, initialValue = true): Promise<boolean> => {
  const value = await confirm({ message, initialValue });
  if (isCancel(value)) {
    cancel("Setup canceled.");
    throw new Error("setup canceled");
  }
  return Boolean(value);
};

const selectPrompt = async (message: string, options: ReadonlyArray<SelectOption>): Promise<string> => {
  const value = await select({ message, options });
  if (isCancel(value)) {
    cancel("Setup canceled.");
    throw new Error("setup canceled");
  }
  return String(value);
};

const runCommand = async (
  command: string,
  args: ReadonlyArray<string>,
): Promise<CommandResult> => {
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

const installCommandFor = (name: "gh" | "aws", platform = process.platform): string =>
  name === "gh"
    ? platform === "darwin"
      ? "brew install gh"
      : "See install docs: https://cli.github.com/"
    : platform === "darwin"
      ? "brew install awscli"
      : "See install docs: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html";

const isRecord = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const ensureBinaryInstalled = async (name: "gh" | "aws", deps?: StartDeps): Promise<void> => {
  const run = deps?.runCommand ?? runCommand;
  const retryPrompt = deps?.askRetry ?? askRetry;
  const log = deps?.log ?? console.log;
  const platform = deps?.platform ?? process.platform;
  while (true) {
    const checked = await run(name, ["--version"]);
    if (checked.ok) return;
    log(`\nCheck failed: ${name} is not installed or not on PATH.`);
    log(`Run: ${installCommandFor(name, platform)}`);
    const retry = await retryPrompt(`Retry ${name} check now?`);
    if (!retry) throw new Error(`${name} is required`);
  }
};

const sameAwsIdentity = (left: AwsIdentity | undefined, right: AwsIdentity | undefined): boolean =>
  Boolean(left && right)
  && left.accountId === right.accountId
  && left.arn === right.arn
  && (left.profile ?? "") === (right.profile ?? "");

const extractGithubAccountsFromText = (output: string): ReadonlyArray<string> => {
  const accounts = new Set<string>();
  for (const match of output.matchAll(/account\s+([A-Za-z0-9-]+)/g)) {
    if (match[1]) accounts.add(match[1]);
  }
  for (const match of output.matchAll(/\b([A-Za-z0-9-]+)\s+\(.*active.*\)/gi)) {
    if (match[1]) accounts.add(match[1]);
  }
  return [...accounts];
};

const extractGithubAccountsFromJson = (raw: string): ReadonlyArray<string> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return [];
    const hosts = parsed.hosts;
    if (!isRecord(hosts)) return [];
    const githubHost = hosts["github.com"];
    if (!Array.isArray(githubHost)) return [];
    const users = new Set<string>();
    for (const entry of githubHost) {
      if (!isRecord(entry)) continue;
      const user = typeof entry.user === "string" ? entry.user.trim() : "";
      if (user) users.add(user);
    }
    return [...users];
  } catch {
    return [];
  }
};

const ensureGithubLogin = async (preferredUsername?: string, deps?: StartDeps): Promise<string> => {
  const run = deps?.runCommand ?? runCommand;
  const retryPrompt = deps?.askRetry ?? askRetry;
  const promptText = deps?.ensurePromptText ?? ensurePromptText;
  const confirmChoice = deps?.confirmPrompt ?? confirmPrompt;
  const selectChoice = deps?.selectPrompt ?? selectPrompt;
  const log = deps?.log ?? console.log;
  while (true) {
    const jsonStatus = await run("gh", ["auth", "status", "--hostname", "github.com", "--json", "hosts"]);
    const textStatus = jsonStatus.ok
      ? { ok: true, stdout: "", stderr: "" }
      : await run("gh", ["auth", "status", "--hostname", "github.com"]);
    if (!jsonStatus.ok && !textStatus.ok) {
      log("\nCheck failed: GitHub is not authenticated for github.com.");
      log("Run: gh auth login");
      const retry = await retryPrompt("Retry GitHub auth check now?");
      if (!retry) throw new Error("GitHub login is required");
      continue;
    }

    const accounts = jsonStatus.ok
      ? extractGithubAccountsFromJson(jsonStatus.stdout)
      : extractGithubAccountsFromText(`${textStatus.stdout}\n${textStatus.stderr}`);
    if (accounts.length === 0) {
      const fallback = await promptText("GitHub username to save", preferredUsername);
      return fallback;
    }
    if (accounts.length === 1) return accounts[0];
    if (preferredUsername && accounts.includes(preferredUsername)) {
      const keepPreferred = await confirmChoice(`Use saved GitHub account '${preferredUsername}'?`, true);
      if (keepPreferred) return preferredUsername;
    }

    const selected = await selectChoice(
      "Select GitHub account for receipt",
      accounts.map((account) => ({ label: account, value: account })),
    );
    await run("gh", ["auth", "switch", "--hostname", "github.com", "--user", String(selected)]);
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

const getAwsProfiles = async (deps?: StartDeps): Promise<ReadonlyArray<string>> => {
  const run = deps?.runCommand ?? runCommand;
  const listed = await run("aws", ["configure", "list-profiles"]);
  if (!listed.ok) return [];
  return listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

const getAwsIdentity = async (profile?: string, deps?: StartDeps): Promise<AwsIdentity | undefined> => {
  const run = deps?.runCommand ?? runCommand;
  const args = ["sts", "get-caller-identity", "--output", "json"];
  if (profile) args.push("--profile", profile);
  const result = await run("aws", args);
  if (!result.ok) return undefined;
  const identity = parseAwsIdentity(result.stdout);
  if (!identity) return undefined;
  return profile ? { ...identity, profile } : identity;
};

const ensureAwsIdentity = async (preferredIdentity?: AwsIdentity, deps?: StartDeps): Promise<AwsIdentity> => {
  const retryPrompt = deps?.askRetry ?? askRetry;
  const selectChoice = deps?.selectPrompt ?? selectPrompt;
  const confirmChoice = deps?.confirmPrompt ?? confirmPrompt;
  const log = deps?.log ?? console.log;
  while (true) {
    const identities = new Map<string, AwsIdentity>();
    const profiles = await getAwsProfiles(deps);
    for (const profile of profiles) {
      const identity = await getAwsIdentity(profile, deps);
      if (!identity) continue;
      const key = `${identity.accountId}:${identity.arn}:${profile}`;
      identities.set(key, identity);
    }

    const defaultIdentity = await getAwsIdentity(undefined, deps);
    if (defaultIdentity) {
      const key = `${defaultIdentity.accountId}:${defaultIdentity.arn}:default`;
      identities.set(key, defaultIdentity);
    }

    const options = [...identities.values()];
    if (options.length === 0) {
      log("\nCheck failed: AWS is not authenticated.");
      log("Run: aws configure");
      log("Or run: aws sso login --profile <profile>");
      const retry = await retryPrompt("Retry AWS auth check now?");
      if (!retry) throw new Error("AWS login is required");
      continue;
    }

    if (options.length === 1) return options[0];
    if (preferredIdentity) {
      const matched = options.find((option) => sameAwsIdentity(option, preferredIdentity));
      if (matched) {
        const keepPreferred = await confirmChoice(
          `Use saved AWS target '${matched.accountId}${matched.profile ? ` (${matched.profile})` : ""}'?`,
          true,
        );
        if (keepPreferred) return matched;
      }
    }

    const selected = await selectChoice(
      "Select AWS account/profile for receipt",
      options.map((item) => ({
        label: `${item.accountId} ${item.profile ? `(profile: ${item.profile})` : "(default credentials)"}`,
        value: JSON.stringify(item),
      })),
    );
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

const ensureOpenAiKey = async (initial?: string, deps?: StartDeps): Promise<string> => {
  const validate = deps?.validateOpenAiKey ?? validateOpenAiKey;
  const promptPassword = deps?.ensurePromptPassword ?? ensurePromptPassword;
  const retryPrompt = deps?.askRetry ?? askRetry;
  const log = deps?.log ?? console.log;
  let candidate = initial?.trim();
  while (true) {
    if (!candidate) {
      candidate = await promptPassword("OpenAI API Key (required)");
    }
    const valid = await validate(candidate);
    if (valid) return candidate;
    log("\nOpenAI key validation failed.");
    const retry = await retryPrompt("Try entering the OpenAI key again?");
    if (!retry) throw new Error("OpenAI key is required");
    candidate = undefined;
  }
};

const maskKey = (value: string): string =>
  value.length <= 8 ? "********" : `${value.slice(0, 4)}...${value.slice(-4)}`;

const printExistingSetup = (config: ReceiptCliConfig, log: (message: string) => void = console.log): void => {
  log([
    "Existing receipt setup detected. Re-running checks.",
    `Config: ${resolveReceiptCliConfigPath()}`,
    `GitHub: ${config.github.username}@${config.github.hostname}`,
    `AWS: ${config.aws.accountId}${config.aws.profile ? ` (profile ${config.aws.profile})` : ""}`,
    `OpenAI: ${maskKey(config.openai.apiKey)}`,
    "Use `receipt start --reset` to ignore saved selections.",
  ].join("\n"));
};

export const runReceiptStart = async (flags: Flags, deps?: StartDeps): Promise<void> => {
  const loadConfig = deps?.loadReceiptCliConfig ?? loadReceiptCliConfig;
  const writeConfig = deps?.writeReceiptCliConfig ?? writeReceiptCliConfig;
  const introMessage = deps?.intro ?? intro;
  const outroMessage = deps?.outro ?? outro;
  const log = deps?.log ?? console.log;
  const reset = asBoolean(flags, "reset");
  const existing = reset ? undefined : await loadConfig();

  introMessage("Receipt CLI setup");
  if (existing) printExistingSetup(existing, log);
  const openaiKey = await ensureOpenAiKey(
    asString(flags, "openai-key")
    ?? process.env.OPENAI_API_KEY
    ?? existing?.openai.apiKey,
    deps,
  );
  await ensureBinaryInstalled("gh", deps);
  const githubUsername = await ensureGithubLogin(existing?.github.username, deps);
  await ensureBinaryInstalled("aws", deps);
  const awsIdentity = await ensureAwsIdentity(existing?.aws, deps);
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
  const configPath = await writeConfig(config);
  outroMessage([
    "Receipt setup complete.",
    `Config saved: ${configPath}`,
    `GitHub: ${config.github.username}@${config.github.hostname}`,
    `AWS: ${config.aws.accountId}${config.aws.profile ? ` (profile ${config.aws.profile})` : ""}`,
    `OpenAI: ${maskKey(config.openai.apiKey)}`,
  ].join("\n"));
};

export const __receiptCliStartTestables = {
  extractGithubAccountsFromText,
  extractGithubAccountsFromJson,
  sameAwsIdentity,
  ensureBinaryInstalled,
  ensureGithubLogin,
  ensureAwsIdentity,
  ensureOpenAiKey,
  runReceiptStart,
};
