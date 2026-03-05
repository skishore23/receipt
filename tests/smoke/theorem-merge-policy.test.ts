import assert from "node:assert/strict";
import test from "node:test";

import { theoremMergePolicy } from "../../src/engine/merge/theorem-policy.ts";
import { pickBestBracket } from "../../src/agents/theorem.rebracket.ts";
import type { Chain, Receipt } from "../../src/core/types.ts";
import type { TheoremEvent } from "../../src/modules/theorem.ts";

const rec = (body: TheoremEvent, idx: number): Receipt<TheoremEvent> => ({
  id: `r${idx}`,
  ts: Date.now() + idx,
  stream: "agents/theorem/runs/r1",
  prev: idx > 0 ? `h${idx - 1}` : undefined,
  hash: `h${idx}`,
  body,
});

test("theorem merge policy: chooses same bracket as pickBestBracket", () => {
  const chain: Chain<TheoremEvent> = [
    rec({ type: "attempt.proposed", runId: "r1", claimId: "claim_r1_a", agentId: "explorer_a", content: "A" }, 1),
    rec({ type: "attempt.proposed", runId: "r1", claimId: "claim_r1_b", agentId: "explorer_b", content: "B" }, 2),
    rec({ type: "critique.raised", runId: "r1", claimId: "crit_r1", agentId: "skeptic", targetClaimId: "claim_r1_a", content: "crit" }, 3),
    rec({ type: "patch.applied", runId: "r1", claimId: "patch_r1", agentId: "verifier", targetClaimId: "claim_r1_a", content: "fix" }, 4),
  ];

  const expected = pickBestBracket(chain, undefined).bracket;
  const evidence = theoremMergePolicy.evidence({ chain, round: 1, branchThreshold: 1, currentBracket: undefined });
  const scored = theoremMergePolicy.candidates({ chain, round: 1, branchThreshold: 1, currentBracket: undefined })
    .map((candidate) => ({ candidate, score: theoremMergePolicy.score(candidate, evidence, { chain, round: 1, branchThreshold: 1, currentBracket: undefined }) }));
  const decision = theoremMergePolicy.choose(scored);

  assert.equal(decision.candidateId, expected);
});
