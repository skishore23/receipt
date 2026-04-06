import { expect, test } from "bun:test";
import { decideMode, type AwsCostSummaryDecisionInput } from "../../src/services/aws-cost-summary-mode";

const credentialCases = [
  { name: "none", input: { mode: "auto", credentials: { kind: "none" } }, reason: "missing_credentials" },
  { name: "partial", input: { mode: "auto", credentials: { kind: "partial" } }, reason: "partial_credentials" },
  { name: "empty", input: { mode: "auto", credentials: { kind: "empty" } }, reason: "empty_credentials" },
  { name: "malformed", input: { mode: "auto", credentials: { kind: "malformed" } }, reason: "malformed_credentials" },
  { name: "expired session token", input: { mode: "auto", credentials: { kind: "expired-session-token" } }, reason: "expired_session_token" },
  { name: "invalid access key id", input: { mode: "auto", credentials: { kind: "invalid-access-key-id" } }, reason: "invalid_access_key_id" },
] as const;

const configCases = [
  { name: "missing region", input: { mode: "auto", config: { kind: "missing-region" } }, reason: "missing_region" },
  { name: "invalid region", input: { mode: "auto", config: { kind: "invalid-region" } }, reason: "invalid_region" },
] as const;

const errorCases = [
  { name: "ExpiredToken", input: { mode: "auto", error: { code: "ExpiredToken" } }, reason: "expired_token_error" },
  { name: "InvalidClientTokenId", input: { mode: "auto", error: { code: "InvalidClientTokenId" } }, reason: "invalid_client_token_id" },
  { name: "UnrecognizedClientException", input: { mode: "auto", error: { code: "UnrecognizedClientException" } }, reason: "unrecognized_client_exception" },
  { name: "AccessDenied", input: { mode: "auto", error: { code: "AccessDenied" } }, reason: "access_denied" },
  { name: "DNS failure", input: { mode: "auto", error: { code: "ENOTFOUND" } }, reason: "dns_failure" },
  { name: "timeout", input: { mode: "auto", error: { code: "ETIMEDOUT" } }, reason: "timeout" },
] as const;

for (const testCase of [...credentialCases, ...configCases]) {
  test(`decideMode falls back offline for ${testCase.name}`, () => {
    expect(decideMode(testCase.input as AwsCostSummaryDecisionInput)).toEqual({
      mode: "offline",
      reason: testCase.reason,
    });
  });
}

for (const testCase of errorCases) {
  test(`decideMode falls back offline for auto-mode ${testCase.name}`, () => {
    expect(decideMode(testCase.input as AwsCostSummaryDecisionInput)).toEqual({
      mode: "offline",
      reason: testCase.reason,
    });
  });
}

test("decideMode stays online when auto-mode has no blocking signal", () => {
  expect(decideMode({ mode: "auto" })).toEqual({
    mode: "online",
    reason: "transient_network",
  });
});
