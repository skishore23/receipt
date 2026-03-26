import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  hydrateEnvFromReceiptCliConfig,
  loadReceiptCliConfig,
  readReceiptCliConfigState,
  resolveReceiptCliConfigPath,
  writeReceiptCliConfig,
  type ReceiptCliConfig,
} from "../../src/receipt-cli/config";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("receipt cli config: write and load round-trip", async () => {
  const tempHome = await createTempDir("receipt-cli-config");
  const config: ReceiptCliConfig = {
    version: 1,
    setupCompletedAt: new Date().toISOString(),
    openai: {
      apiKey: "sk-test-1234567890",
    },
    github: {
      hostname: "github.com",
      username: "octocat",
    },
    aws: {
      profile: "sandbox",
      accountId: "123456789012",
      arn: "arn:aws:iam::123456789012:user/octocat",
    },
  };
  const written = await writeReceiptCliConfig(config, tempHome);
  expect(written).toBe(resolveReceiptCliConfigPath(tempHome));
  if (process.platform !== "win32") {
    const configDirMode = (await fs.stat(path.dirname(written))).mode & 0o777;
    const configFileMode = (await fs.stat(written)).mode & 0o777;
    expect(configDirMode).toBe(0o700);
    expect(configFileMode).toBe(0o600);
  }
  const loaded = await loadReceiptCliConfig(tempHome);
  expect(loaded).toEqual(config);
}, 60_000);

test("receipt cli config: hydrates environment values", () => {
  const priorOpenAi = process.env.OPENAI_API_KEY;
  const priorGithubUser = process.env.RECEIPT_GITHUB_USER;
  const priorAwsProfile = process.env.AWS_PROFILE;
  const priorAwsAccount = process.env.RECEIPT_AWS_ACCOUNT_ID;
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.RECEIPT_GITHUB_USER;
    delete process.env.AWS_PROFILE;
    delete process.env.RECEIPT_AWS_ACCOUNT_ID;
    hydrateEnvFromReceiptCliConfig({
      version: 1,
      setupCompletedAt: new Date().toISOString(),
      openai: { apiKey: "sk-test-abc" },
      github: { hostname: "github.com", username: "octocat" },
      aws: {
        profile: "default",
        accountId: "123456789012",
        arn: "arn:aws:iam::123456789012:user/octocat",
      },
    });
    expect(process.env.OPENAI_API_KEY).toBe("sk-test-abc");
    expect(process.env.RECEIPT_GITHUB_USER).toBe("octocat");
    expect(process.env.AWS_PROFILE).toBe("default");
    expect(process.env.RECEIPT_AWS_ACCOUNT_ID).toBe("123456789012");
  } finally {
    process.env.OPENAI_API_KEY = priorOpenAi;
    process.env.RECEIPT_GITHUB_USER = priorGithubUser;
    process.env.AWS_PROFILE = priorAwsProfile;
    process.env.RECEIPT_AWS_ACCOUNT_ID = priorAwsAccount;
  }
});

test("receipt cli config: reports invalid schema with reason", async () => {
  const tempHome = await createTempDir("receipt-cli-config-invalid");
  const configPath = resolveReceiptCliConfigPath(tempHome);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ version: 999 }), "utf-8");
  const state = await readReceiptCliConfigState(tempHome);
  expect(state.status).toBe("invalid");
  if (state.status === "invalid") {
    expect(state.reason).toContain("unsupported config version");
    expect(state.configPath).toBe(configPath);
  }
});
