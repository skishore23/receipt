import { expect, test } from "bun:test";

import {
  buildDefaultTaskCompletion,
  repairTaskResultSections,
  renderDeliveryResultText,
} from "../../src/services/factory/result-contracts";

test("factory result contracts: blocked runs synthesize structured evidence and alignment", () => {
  const repaired = repairTaskResultSections({
    outcome: "blocked",
    summary: "The worker was blocked before any commit was possible.",
    handoff: "Blocked on an upstream permission failure.",
    artifacts: [],
    scriptsRun: [],
    completion: buildDefaultTaskCompletion({ summary: "The worker was blocked before any commit was possible." }),
    signals: ["stderr: permission denied", "stdout: no commands were executed"],
  });

  expect(repaired.repaired).toBe(true);
  expect(repaired.artifacts[0]?.label).toBe("Captured signals");
  expect(repaired.scriptsRun[0]?.command).toBe("(none executed)");
  expect(repaired.completion.proof[0]).toContain("captured signals");
  expect(renderDeliveryResultText({
    summary: "The worker was blocked before any commit was possible.",
    handoff: "Blocked on an upstream permission failure.",
    scriptsRun: repaired.scriptsRun,
    completion: repaired.completion,
    alignment: repaired.alignment,
  })).toMatchInlineSnapshot(`
    "Summary
    The worker was blocked before any commit was possible.

    Handoff
    Blocked on an upstream permission failure.

    Scripts Run
    - warning: (none executed) | blocked run did not record any executed commands.

    Changed
    - No changed files were recorded for this blocked run.

    Proof
    - blocked run did not produce explicit proof; captured signals: stderr: permission denied | stdout: no commands were executed | Blocked on an upstream permission failure.

    Remaining
    - none

    Alignment
    Verdict: uncertain
    The blocked run did not emit an explicit alignment review, so the finalizer synthesized a stub from the available signals."
  `);
});
