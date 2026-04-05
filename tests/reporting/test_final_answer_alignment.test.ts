import { expect, test } from "bun:test";

import { renderDeliveryResultText } from "../../src/services/factory/result-contracts";

test("final answer alignment block maps acceptance criteria to evidence", () => {
  const rendered = renderDeliveryResultText({
    summary: "Delivered the requested change.",
    handoff: "Returning the candidate with proof and explicit alignment.",
    scriptsRun: [{ command: "bun run build", summary: "Build completed successfully.", status: "ok" }],
    completion: {
      changed: ["Updated the final response formatter."],
      proof: ["bun run build passed."],
      remaining: [],
    },
    alignment: {
      verdict: "aligned",
      satisfied: ["Implement the requested delivery objective: Emit an explicit alignment report section in the final deliverable so audits stop flagging align."],
      missing: [],
      outOfScope: [],
      rationale: "The final deliverable now reports the objective contract explicitly.",
    },
    contract: {
      acceptanceCriteria: [
        "Implement the requested delivery objective: Emit an explicit alignment report section in the final deliverable so audits stop flagging align.",
        "Keep the shipped change aligned with the objective prompt and avoid unrelated scope.",
      ],
      allowedScope: [],
      disallowedScope: [],
      requiredChecks: ["bun run build"],
      proofExpectation: "Return concrete changed files, validation evidence, and no unresolved delivery work in completion.remaining.",
    },
  });

  expect(rendered).toContain("Alignment");
  expect(rendered).toContain("criterion_id | criterion_text | evidence_ref | status");
  expect(rendered).toContain("AC-1 | Implement the requested delivery objective: Emit an explicit alignment report section in the final deliverable so audits stop flagging align. | alignment.satisfied[0] | met");
  expect(rendered).toContain("AC-2 | Keep the shipped change aligned with the objective prompt and avoid unrelated scope. | alignment.review | met");
});
