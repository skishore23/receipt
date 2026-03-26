import { test, expect } from "bun:test";

import { __receiptCliStartTestables } from "../../src/receipt-cli/start";
import type { ReceiptCliConfig } from "../../src/receipt-cli/config";

type CommandResult = { readonly ok: boolean; readonly stdout: string; readonly stderr: string };

const commandKey = (command: string, args: ReadonlyArray<string>): string =>
  `${command} ${args.join(" ")}`;

const makeRunCommand = (responses: Record<string, CommandResult>) =>
  async (command: string, args: ReadonlyArray<string>): Promise<CommandResult> =>
    responses[commandKey(command, args)] ?? { ok: false, stdout: "", stderr: "unexpected command" };

test("receipt start: missing gh fails when user stops retry", async () => {
  const runCommand = makeRunCommand({
    [commandKey("gh", ["--version"])]: { ok: false, stdout: "", stderr: "not found" },
  });
  await expect(__receiptCliStartTestables.ensureBinaryInstalled("gh", {
    runCommand,
    askRetry: async () => false,
    log: () => undefined,
    platform: "darwin",
  })).rejects.toThrow("gh is required");
});

test("receipt start: missing aws fails when user stops retry", async () => {
  const runCommand = makeRunCommand({
    [commandKey("aws", ["--version"])]: { ok: false, stdout: "", stderr: "not found" },
  });
  await expect(__receiptCliStartTestables.ensureBinaryInstalled("aws", {
    runCommand,
    askRetry: async () => false,
    log: () => undefined,
    platform: "darwin",
  })).rejects.toThrow("aws is required");
});

test("receipt start: unauthenticated github fails when user stops retry", async () => {
  const runCommand = makeRunCommand({
    [commandKey("gh", ["auth", "status", "--hostname", "github.com", "--json", "hosts"])]: { ok: false, stdout: "", stderr: "auth failed" },
    [commandKey("gh", ["auth", "status", "--hostname", "github.com"])]: { ok: false, stdout: "", stderr: "auth failed" },
  });
  await expect(__receiptCliStartTestables.ensureGithubLogin(undefined, {
    runCommand,
    askRetry: async () => false,
    log: () => undefined,
  })).rejects.toThrow("GitHub login is required");
});

test("receipt start: unauthenticated aws fails when user stops retry", async () => {
  const runCommand = makeRunCommand({
    [commandKey("aws", ["configure", "list-profiles"])]: { ok: false, stdout: "", stderr: "not configured" },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json"])]: { ok: false, stdout: "", stderr: "auth failed" },
  });
  await expect(__receiptCliStartTestables.ensureAwsIdentity(undefined, {
    runCommand,
    askRetry: async () => false,
    log: () => undefined,
  })).rejects.toThrow("AWS login is required");
});

test("receipt start: multiple aws profiles uses explicit picker", async () => {
  const runCommand = makeRunCommand({
    [commandKey("aws", ["configure", "list-profiles"])]: { ok: true, stdout: "dev\nprod", stderr: "" },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json", "--profile", "dev"])]: {
      ok: true,
      stdout: JSON.stringify({ Account: "111111111111", Arn: "arn:aws:iam::111111111111:user/dev" }),
      stderr: "",
    },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json", "--profile", "prod"])]: {
      ok: true,
      stdout: JSON.stringify({ Account: "222222222222", Arn: "arn:aws:iam::222222222222:user/prod" }),
      stderr: "",
    },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json"])]: { ok: false, stdout: "", stderr: "no default" },
  });

  const picked = await __receiptCliStartTestables.ensureAwsIdentity(undefined, {
    runCommand,
    askRetry: async () => true,
    selectPrompt: async (_message, options) => options[1]?.value ?? options[0]!.value,
    log: () => undefined,
  });
  expect(picked.accountId).toBe("222222222222");
  expect(picked.profile).toBe("prod");
});

test("receipt start: invalid openai key retries then succeeds", async () => {
  const entered: string[] = [];
  const key = await __receiptCliStartTestables.ensureOpenAiKey(undefined, {
    ensurePromptPassword: async () => {
      const next = entered.length === 0 ? "invalid-key" : "valid-key";
      entered.push(next);
      return next;
    },
    validateOpenAiKey: async (candidate) => candidate === "valid-key",
    askRetry: async () => true,
    log: () => undefined,
  });
  expect(key).toBe("valid-key");
  expect(entered).toEqual(["invalid-key", "valid-key"]);
});

test("receipt start: invalid openai key fails when user declines retry", async () => {
  await expect(__receiptCliStartTestables.ensureOpenAiKey(undefined, {
    ensurePromptPassword: async () => "invalid-key",
    validateOpenAiKey: async () => false,
    askRetry: async () => false,
    log: () => undefined,
  })).rejects.toThrow("OpenAI key is required");
});

test("receipt start: successful setup writes config", async () => {
  const writes: ReceiptCliConfig[] = [];
  const runCommand = makeRunCommand({
    [commandKey("gh", ["--version"])]: { ok: true, stdout: "gh version 2.81.0", stderr: "" },
    [commandKey("gh", ["auth", "status", "--hostname", "github.com", "--json", "hosts"])]: {
      ok: true,
      stdout: JSON.stringify({
        hosts: {
          "github.com": [{ user: "octocat", active: true }],
        },
      }),
      stderr: "",
    },
    [commandKey("aws", ["--version"])]: { ok: true, stdout: "aws-cli/2.34.0", stderr: "" },
    [commandKey("aws", ["configure", "list-profiles"])]: { ok: true, stdout: "dev", stderr: "" },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json", "--profile", "dev"])]: {
      ok: true,
      stdout: JSON.stringify({ Account: "111111111111", Arn: "arn:aws:iam::111111111111:user/dev" }),
      stderr: "",
    },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json"])]: { ok: false, stdout: "", stderr: "no default" },
  });

  await __receiptCliStartTestables.runReceiptStart(
    { "openai-key": "valid-key" },
    {
      runCommand,
      validateOpenAiKey: async (candidate) => candidate === "valid-key",
      loadReceiptCliConfig: async () => undefined,
      writeReceiptCliConfig: async (config) => {
        writes.push(config);
        return "/tmp/receipt-config.json";
      },
      intro: () => undefined,
      outro: () => undefined,
      log: () => undefined,
    },
  );

  expect(writes.length).toBe(1);
  expect(writes[0]?.openai.apiKey).toBe("valid-key");
  expect(writes[0]?.github.username).toBe("octocat");
  expect(writes[0]?.aws.accountId).toBe("111111111111");
});
