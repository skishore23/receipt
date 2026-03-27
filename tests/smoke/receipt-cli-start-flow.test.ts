import { test, expect } from "bun:test";

import { __receiptCliStartTestables } from "../../src/receipt-cli/start";
import type { ReceiptCliConfig } from "../../src/receipt-cli/config";

type CommandResult = { readonly ok: boolean; readonly stdout: string; readonly stderr: string };
type CommandResponse = CommandResult | ReadonlyArray<CommandResult>;

const commandKey = (command: string, args: ReadonlyArray<string>): string =>
  `${command} ${args.join(" ")}`;

const makeRunCommand = (responses: Record<string, CommandResponse>) => {
  const calls = new Map<string, number>();
  return async (command: string, args: ReadonlyArray<string>): Promise<CommandResult> => {
    const key = commandKey(command, args);
    const response = responses[key];
    if (!response) return { ok: false, stdout: "", stderr: "unexpected command" };
    if (!Array.isArray(response)) return response;
    const index = calls.get(key) ?? 0;
    calls.set(key, index + 1);
    return response[index] ?? response.at(-1) ?? { ok: false, stdout: "", stderr: "unexpected command" };
  };
};

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

test("receipt start: missing gh on linux prints docs install hint", async () => {
  const runCommand = makeRunCommand({
    [commandKey("gh", ["--version"])]: { ok: false, stdout: "", stderr: "not found" },
  });
  const logs: string[] = [];
  await expect(__receiptCliStartTestables.ensureBinaryInstalled("gh", {
    runCommand,
    askRetry: async () => false,
    log: (message) => logs.push(message),
    platform: "linux",
  })).rejects.toThrow("gh is required");
  expect(logs.some((entry) => entry.includes("See install docs: https://cli.github.com/"))).toBe(true);
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

test("receipt start: missing aws on win32 prints docs install hint", async () => {
  const runCommand = makeRunCommand({
    [commandKey("aws", ["--version"])]: { ok: false, stdout: "", stderr: "not found" },
  });
  const logs: string[] = [];
  await expect(__receiptCliStartTestables.ensureBinaryInstalled("aws", {
    runCommand,
    askRetry: async () => false,
    log: (message) => logs.push(message),
    platform: "win32",
  })).rejects.toThrow("aws is required");
  expect(logs.some((entry) => entry.includes("See install docs: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"))).toBe(true);
});

test("receipt start: unauthenticated github fails when user stops retry", async () => {
  const runCommand = makeRunCommand({
    [commandKey("gh", ["auth", "status", "--hostname", "github.com", "--json", "hosts"])]: { ok: false, stdout: "", stderr: "auth failed" },
    [commandKey("gh", ["auth", "status", "--hostname", "github.com"])]: { ok: false, stdout: "", stderr: "auth failed" },
  });
  await expect(__receiptCliStartTestables.ensureGithubLogin(undefined, {
    runCommand,
    askRetry: async () => false,
    confirmPrompt: async () => false,
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
    confirmPrompt: async () => false,
    log: () => undefined,
  })).rejects.toThrow("AWS login is required");
});

test("receipt start: unauthenticated github can complete guided browser login", async () => {
  const runCommand = makeRunCommand({
    [commandKey("gh", ["auth", "status", "--hostname", "github.com", "--json", "hosts"])]: [
      { ok: false, stdout: "", stderr: "auth failed" },
      {
        ok: true,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [{ user: "octocat", active: true }],
          },
        }),
        stderr: "",
      },
    ],
    [commandKey("gh", ["auth", "status", "--hostname", "github.com"])]: { ok: false, stdout: "", stderr: "auth failed" },
    [commandKey("gh", ["auth", "login", "--hostname", "github.com", "--web"])]: { ok: true, stdout: "ok", stderr: "" },
  });

  const username = await __receiptCliStartTestables.ensureGithubLogin(undefined, {
    runCommand,
    askRetry: async () => true,
    confirmPrompt: async () => true,
    log: () => undefined,
  });
  expect(username).toBe("octocat");
});

test("receipt start: github login command failure still keeps safe retry path", async () => {
  const runCommand = makeRunCommand({
    [commandKey("gh", ["auth", "status", "--hostname", "github.com", "--json", "hosts"])]: { ok: false, stdout: "", stderr: "auth failed" },
    [commandKey("gh", ["auth", "status", "--hostname", "github.com"])]: { ok: false, stdout: "", stderr: "auth failed" },
    [commandKey("gh", ["auth", "login", "--hostname", "github.com", "--web"])]: { ok: false, stdout: "", stderr: "login failed" },
  });
  await expect(__receiptCliStartTestables.ensureGithubLogin(undefined, {
    runCommand,
    askRetry: async () => false,
    confirmPrompt: async () => true,
    log: () => undefined,
  })).rejects.toThrow("GitHub login is required");
});

test("receipt start: github account uses gh api fallback when status parsing is empty", async () => {
  const runCommand = makeRunCommand({
    [commandKey("gh", ["auth", "status", "--hostname", "github.com", "--json", "hosts"])]: {
      ok: true,
      stdout: JSON.stringify({ hosts: { "github.com": [] } }),
      stderr: "",
    },
    [commandKey("gh", ["api", "user", "--jq", ".login"])]: { ok: true, stdout: "octocat", stderr: "" },
  });
  const username = await __receiptCliStartTestables.ensureGithubLogin(undefined, {
    runCommand,
    askRetry: async () => true,
    confirmPrompt: async () => true,
    log: () => undefined,
  });
  expect(username).toBe("octocat");
});

test("receipt start: github empty json status triggers guided login instead of looping", async () => {
  const runCommand = makeRunCommand({
    [commandKey("gh", ["auth", "status", "--hostname", "github.com", "--json", "hosts"])]: [
      { ok: true, stdout: JSON.stringify({ hosts: {} }), stderr: "" },
      {
        ok: true,
        stdout: JSON.stringify({
          hosts: { "github.com": [{ user: "octocat", active: true }] },
        }),
        stderr: "",
      },
    ],
    [commandKey("gh", ["auth", "status", "--hostname", "github.com"])]: [
      { ok: false, stdout: "", stderr: "not logged in" },
      { ok: false, stdout: "", stderr: "not logged in" },
    ],
    [commandKey("gh", ["api", "user", "--jq", ".login"])]: { ok: false, stdout: "", stderr: "401" },
    [commandKey("gh", ["auth", "login", "--hostname", "github.com", "--web"])]: { ok: true, stdout: "", stderr: "" },
  });

  const username = await __receiptCliStartTestables.ensureGithubLogin(undefined, {
    runCommand,
    askRetry: async () => true,
    confirmPrompt: async () => true,
    log: () => undefined,
  });
  expect(username).toBe("octocat");
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

test("receipt start: unauthenticated aws can complete guided sso setup", async () => {
  const runCommand = makeRunCommand({
    [commandKey("aws", ["configure", "list-profiles"])]: [
      { ok: false, stdout: "", stderr: "not configured" },
      { ok: true, stdout: "work", stderr: "" },
    ],
    [commandKey("aws", ["configure", "sso"])]: { ok: true, stdout: "", stderr: "" },
    [commandKey("aws", ["sso", "login", "--profile", "work"])]: { ok: true, stdout: "", stderr: "" },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json"])]: [
      { ok: false, stdout: "", stderr: "auth failed" },
      { ok: false, stdout: "", stderr: "auth failed" },
    ],
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json", "--profile", "work"])]: {
      ok: true,
      stdout: JSON.stringify({ Account: "333333333333", Arn: "arn:aws:iam::333333333333:user/work" }),
      stderr: "",
    },
  });
  const identity = await __receiptCliStartTestables.ensureAwsIdentity(undefined, {
    runCommand,
    askRetry: async () => true,
    confirmPrompt: async () => true,
    ensurePromptText: async () => "work",
    log: () => undefined,
  });
  expect(identity.accountId).toBe("333333333333");
  expect(identity.profile).toBe("work");
});

test("receipt start: already-working non-sso default aws identity still passes", async () => {
  const runCommand = makeRunCommand({
    [commandKey("aws", ["configure", "list-profiles"])]: { ok: false, stdout: "", stderr: "none" },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json"])]: {
      ok: true,
      stdout: JSON.stringify({ Account: "444444444444", Arn: "arn:aws:iam::444444444444:user/default" }),
      stderr: "",
    },
  });
  const identity = await __receiptCliStartTestables.ensureAwsIdentity(undefined, {
    runCommand,
    askRetry: async () => true,
    confirmPrompt: async () => true,
    log: () => undefined,
  });
  expect(identity.accountId).toBe("444444444444");
  expect(identity.profile).toBeUndefined();
});

test("receipt start: aws sso command failure still keeps safe retry path", async () => {
  const runCommand = makeRunCommand({
    [commandKey("aws", ["configure", "list-profiles"])]: { ok: false, stdout: "", stderr: "not configured" },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json"])]: { ok: false, stdout: "", stderr: "auth failed" },
    [commandKey("aws", ["configure", "sso"])]: { ok: false, stdout: "", stderr: "configure failed" },
    [commandKey("aws", ["sso", "login", "--profile", "work"])]: { ok: false, stdout: "", stderr: "login failed" },
  });
  await expect(__receiptCliStartTestables.ensureAwsIdentity(undefined, {
    runCommand,
    askRetry: async () => false,
    confirmPrompt: async () => true,
    ensurePromptText: async () => "work",
    log: () => undefined,
  })).rejects.toThrow("AWS login is required");
});

test("receipt start: aws auth gap keeps guided setup prompt and safe exit", async () => {
  const runCommand = makeRunCommand({
    [commandKey("aws", ["configure", "list-profiles"])]: { ok: true, stdout: "work", stderr: "" },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json", "--profile", "work"])]: {
      ok: false,
      stdout: "",
      stderr: "expired token",
    },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json"])]: { ok: false, stdout: "", stderr: "no default" },
    [commandKey("aws", ["configure", "sso"])]: { ok: false, stdout: "", stderr: "configure failed" },
    [commandKey("aws", ["sso", "login", "--profile", "work"])]: { ok: false, stdout: "", stderr: "login failed" },
  });
  await expect(__receiptCliStartTestables.ensureAwsIdentity(undefined, {
    runCommand,
    askRetry: async () => false,
    confirmPrompt: async () => true,
    ensurePromptText: async () => "work",
    log: () => undefined,
  })).rejects.toThrow("AWS login is required");
});

test("receipt start: unauthenticated aws can use access key setup path", async () => {
  const runCommand = makeRunCommand({
    [commandKey("aws", ["configure", "list-profiles"])]: [
      { ok: false, stdout: "", stderr: "not configured" },
      { ok: true, stdout: "default", stderr: "" },
    ],
    [commandKey("aws", ["configure"])]: { ok: true, stdout: "", stderr: "" },
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json"])]: [
      { ok: false, stdout: "", stderr: "auth failed" },
      {
        ok: true,
        stdout: JSON.stringify({ Account: "555555555555", Arn: "arn:aws:iam::555555555555:user/default" }),
        stderr: "",
      },
    ],
    [commandKey("aws", ["sts", "get-caller-identity", "--output", "json", "--profile", "default"])]: {
      ok: true,
      stdout: JSON.stringify({ Account: "555555555555", Arn: "arn:aws:iam::555555555555:user/default" }),
      stderr: "",
    },
  });
  const identity = await __receiptCliStartTestables.ensureAwsIdentity(undefined, {
    runCommand,
    askRetry: async () => true,
    confirmPrompt: async () => false,
    log: () => undefined,
  });
  expect(identity.accountId).toBe("555555555555");
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

test("receipt start --reset: ignores saved selections", async () => {
  const writes: ReceiptCliConfig[] = [];
  let confirmCalls = 0;
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

  await __receiptCliStartTestables.runReceiptStart(
    { reset: true },
    {
      runCommand,
      validateOpenAiKey: async (candidate) => candidate === "new-valid-key",
      ensurePromptPassword: async () => "new-valid-key",
      loadReceiptCliConfig: async () => ({
        version: 1,
        setupCompletedAt: new Date(0).toISOString(),
        openai: { apiKey: "old-key" },
        github: { hostname: "github.com", username: "old-user" },
        aws: {
          profile: "dev",
          accountId: "111111111111",
          arn: "arn:aws:iam::111111111111:user/dev",
        },
      }),
      writeReceiptCliConfig: async (config) => {
        writes.push(config);
        return "/tmp/receipt-config.json";
      },
      confirmPrompt: async () => {
        confirmCalls += 1;
        return true;
      },
      selectPrompt: async (_message, options) => options[1]?.value ?? options[0]!.value,
      intro: () => undefined,
      outro: () => undefined,
      log: () => undefined,
    },
  );

  expect(confirmCalls).toBe(0);
  expect(writes.length).toBe(1);
  expect(writes[0]?.openai.apiKey).toBe("new-valid-key");
  expect(writes[0]?.aws.profile).toBe("prod");
});
