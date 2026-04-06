import { expect, test } from "bun:test";

import { deriveJobFailureDecision } from "../../src/engine/runtime/job-failure-policy";

test("job failure policy: retryable failure receipts keep queue retries enabled", () => {
  // Mirrors the observed run_mmwngtcm_rphm failure payload shape.
  const result = {
    runId: "run_mmwngtcm_rphm",
    stream: "agents/agent",
    runStream: "agents/agent/runs/run_mmwngtcm_rphm",
    status: "failed",
    note: "Model tool action input is not valid JSON",
    failure: {
      stage: "model_json",
      failureClass: "model_json_parse",
      message: "Model tool action input is not valid JSON",
      details: "",
      retryable: true,
      iteration: 13,
    },
  } satisfies Record<string, unknown>;

  expect(deriveJobFailureDecision(result)).toEqual({
    error: "Model tool action input is not valid JSON",
    noRetry: false,
  });
});

test("job failure policy: missing retryable metadata stays terminal", () => {
  const result = {
    status: "failed",
    note: "workspace does not exist",
    failure: {
      stage: "runtime",
      failureClass: "workspace_missing",
      message: "workspace does not exist",
      retryable: false,
    },
  } satisfies Record<string, unknown>;

  expect(deriveJobFailureDecision(result)).toEqual({
    error: "workspace does not exist",
    noRetry: true,
  });
});
