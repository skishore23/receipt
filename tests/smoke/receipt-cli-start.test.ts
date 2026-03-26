import { test, expect } from "bun:test";

import { __receiptCliStartTestables } from "../../src/receipt-cli/start";

test("receipt start parsers: extracts GitHub users from gh auth status --json", () => {
  const raw = JSON.stringify({
    hosts: {
      "github.com": [
        { user: "octocat", active: true },
        { user: "monalisa", active: false },
      ],
    },
  });
  const users = __receiptCliStartTestables.extractGithubAccountsFromJson(raw);
  expect(users).toEqual(["octocat", "monalisa"]);
});

test("receipt start parsers: extracts GitHub users from text fallback", () => {
  const raw = [
    "github.com",
    "  ✓ Logged in to github.com account octocat (/Users/me/.config/gh/hosts.yml)",
    "  - Active account: monalisa",
  ].join("\n");
  const users = __receiptCliStartTestables.extractGithubAccountsFromText(raw);
  expect(users.includes("octocat")).toBe(true);
});

test("receipt start parsers: matches AWS identities including profile", () => {
  const matched = __receiptCliStartTestables.sameAwsIdentity(
    { accountId: "111111111111", arn: "arn:aws:iam::111111111111:user/dev", profile: "dev" },
    { accountId: "111111111111", arn: "arn:aws:iam::111111111111:user/dev", profile: "dev" },
  );
  expect(matched).toBe(true);
});

test("receipt start parsers: AWS identity mismatch returns false", () => {
  const matched = __receiptCliStartTestables.sameAwsIdentity(
    { accountId: "111111111111", arn: "arn:aws:iam::111111111111:user/dev", profile: "dev" },
    { accountId: "111111111111", arn: "arn:aws:iam::111111111111:user/dev", profile: "prod" },
  );
  expect(matched).toBe(false);
});
