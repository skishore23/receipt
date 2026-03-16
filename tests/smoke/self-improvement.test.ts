import { test, expect } from "bun:test";

import {
  reduce,
  initial,
  type SelfImprovementEvent,
} from "../../src/modules/self-improvement.ts";

const fold = (events: ReadonlyArray<SelfImprovementEvent>) =>
  events.reduce((state, event, idx) => reduce(state, event, idx + 1), initial);

test("self-improvement module: lifecycle transitions", () => {
  const state = fold([
    {
      type: "proposal.created",
      proposalId: "p1",
      artifactType: "prompt_patch",
      target: "prompts/theorem.prompts.json",
      patch: "{...}",
      createdBy: "agent",
    },
    {
      type: "proposal.validated",
      proposalId: "p1",
      status: "passed",
      report: "all checks passed",
    },
    {
      type: "proposal.approved",
      proposalId: "p1",
      approvedBy: "reviewer",
    },
    {
      type: "proposal.applied",
      proposalId: "p1",
      appliedBy: "scheduler",
    },
    {
      type: "proposal.reverted",
      proposalId: "p1",
      revertedBy: "reviewer",
      reason: "rollback requested",
    },
  ]);

  const proposal = state.proposals.p1;
  expect(proposal).toBeTruthy();
  expect(proposal?.status).toBe("reverted");
  expect(proposal?.validation?.status).toBe("passed");
});
