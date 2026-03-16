import { test, expect } from "bun:test";

import { THEOREM_TEAM } from "../../src/agents/theorem.ts";
import { fold, receipt } from "../../src/core/chain.ts";
import type { Chain } from "../../src/core/types.ts";
import {
  initial as initialTheorem,
  reduce as reduceTheorem,
  type TheoremEvent,
} from "../../src/modules/theorem.ts";
import { theoremChatHtml, theoremSideHtml } from "../../src/views/theorem.ts";

const mkChain = (): Chain<TheoremEvent> => {
  const stream = "agents/axiom-guild/runs/run_demo";
  const runId = "run_demo";
  let prev: string | undefined;

  const emit = (body: TheoremEvent, ts: number) => {
    const next = receipt(stream, prev, body, ts);
    prev = next.hash;
    return next;
  };

  return [
    emit({
      type: "problem.set",
      runId,
      problem: "Prove theorem foo.",
      agentId: "orchestrator",
    }, 1),
    emit({
      type: "rebracket.applied",
      runId,
      agentId: "orchestrator",
      bracket: "(A o (B o (C o D)))",
      score: 2,
      note: "Rotation applied via causal score.",
    }, 2),
  ];
};

test("theorem side panel expands rebracket pods and merge order", () => {
  const chain = mkChain();
  const state = fold(chain, reduceTheorem, initialTheorem);
  const team = THEOREM_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));

  const html = theoremSideHtml(
    state,
    chain,
    null,
    chain.length,
    "agents/axiom-guild",
    "run_demo",
    team
  );

  expect(html).toMatch(/\(Explorer A o \(Explorer B o \(Explorer C o Critic Pod\)\)\)/);
  expect(html).toMatch(/Raw: \(A o \(B o \(C o D\)\)\)/);
  expect(html).toMatch(/Lemma Miner, Skeptic, Verifier, Synthesizer/);
  expect(html).toMatch(/1\. Merge Explorer C \+ Critic Pod/);
  expect(html).toMatch(/2\. Merge Explorer B \+ previous result/);
  expect(html).toMatch(/3\. Merge Explorer A \+ previous result/);
  expect(html).toMatch(/Decider: orchestrator each round\. Ranking: causal score, parallel tie-break, stability, lexical\./);
});

test("theorem chat expands rebracket events with friendly copy", () => {
  const html = theoremChatHtml(mkChain());

  expect(html).toMatch(/Rebracketed to \(Explorer A o \(Explorer B o \(Explorer C o Critic Pod\)\)\) \(score 2\.00\)\./);
  expect(html).toMatch(/Raw: \(A o \(B o \(C o D\)\)\)/);
});

test("theorem chat renders a DAG with memory highlights", () => {
  const stream = "agents/axiom-guild/runs/run_dag";
  const runId = "run_dag";
  let prev: string | undefined;
  const emit = (body: TheoremEvent, ts: number) => {
    const next = receipt(stream, prev, body, ts);
    prev = next.hash;
    return next;
  };

  const chain: Chain<TheoremEvent> = [
    emit({
      type: "problem.set",
      runId,
      problem: "Prove theorem foo.",
      agentId: "orchestrator",
    }, 1),
    emit({
      type: "rebracket.applied",
      runId,
      agentId: "orchestrator",
      bracket: "(A o (B o (C o D)))",
      score: 2,
      note: "Rotation applied via causal score.",
    }, 2),
    emit({
      type: "memory.slice",
      runId,
      agentId: "orchestrator",
      phase: "merge",
      window: 8,
      bracket: "((A o B) o (C o D))",
      maxChars: 1200,
      chars: 240,
      itemCount: 2,
      items: [
        { kind: "attempt.proposed", claimId: "c_attempt", agentId: "explorer_b" },
        { kind: "critique.raised", claimId: "c_critique", targetClaimId: "c_attempt", agentId: "skeptic" },
      ],
    }, 3),
  ];

  const html = theoremChatHtml(chain);

  expect(html).toMatch(/Workflow DAG/);
  expect(html).toMatch(/Current merge: \(\(Explorer A o Explorer B\) o \(Explorer C o Critic Pod\)\)/);
  expect(html).toMatch(/Raw: \(\(A o B\) o \(C o D\)\)/);
  expect(html).toMatch(/Memory focus: merge · 2 items · Explorer B, Critic Pod/);
  expect(html).toMatch(/Memory highlight = pods and merge links in the latest shared memory slice/);
  expect(html).toMatch(/class="mermaid dag-mermaid"/);
  expect(html).toMatch(/flowchart TD/);
  expect(html).toMatch(/pod_b\[&quot;Explorer B&quot;\]/);
  expect(html).toMatch(/class pod_b,merge_1,pod_d,merge_2,merge_3,stage_summary memoryNode;/);
  expect(html).toMatch(/linkStyle 1,3,4,5,6 stroke:#6ef3a0,stroke-width:4px;/);
});

test("theorem chat shows receipt-backed node attribution for pods and merges", () => {
  const stream = "agents/axiom-guild/runs/run_dag_attribution";
  const runId = "run_dag_attribution";
  let prev: string | undefined;
  const emit = (body: TheoremEvent, ts: number) => {
    const next = receipt(stream, prev, body, ts);
    prev = next.hash;
    return next;
  };

  const verifyEvidence = {
    phase: "verify" as const,
    tool: "lean.verify",
    ok: true,
    failedDeclarations: [],
  };

  const chain: Chain<TheoremEvent> = [
    emit({
      type: "problem.set",
      runId,
      problem: "Prove theorem foo.",
      agentId: "orchestrator",
    }, 1),
    emit({
      type: "attempt.proposed",
      runId,
      claimId: "attempt_a",
      agentId: "explorer_a",
      content: "Route A",
    }, 2),
    emit({
      type: "attempt.proposed",
      runId,
      claimId: "attempt_b",
      agentId: "explorer_b",
      content: "Route B",
    }, 3),
    emit({
      type: "attempt.proposed",
      runId,
      claimId: "attempt_c",
      agentId: "explorer_c",
      content: "Route C",
    }, 4),
    emit({
      type: "lemma.proposed",
      runId,
      claimId: "lemma_1",
      agentId: "lemma_miner",
      content: "Lemma path",
    }, 5),
    emit({
      type: "critique.raised",
      runId,
      claimId: "crit_1",
      agentId: "skeptic",
      targetClaimId: "attempt_a",
      content: "Critique path",
    }, 6),
    emit({
      type: "patch.applied",
      runId,
      claimId: "patch_1",
      agentId: "verifier",
      targetClaimId: "attempt_a",
      content: "Patch path",
    }, 7),
    emit({
      type: "rebracket.applied",
      runId,
      agentId: "orchestrator",
      bracket: "((A o B) o (C o D))",
      score: 4,
      note: "Rotation applied via causal score.",
    }, 8),
    emit({
      type: "summary.made",
      runId,
      claimId: "merge_ab",
      agentId: "synthesizer",
      bracket: "(A o B)",
      content: "Merged AB",
      uses: ["attempt_a", "attempt_b"],
    }, 9),
    emit({
      type: "summary.made",
      runId,
      claimId: "merge_cd",
      agentId: "synthesizer",
      bracket: "(C o D)",
      content: "Merged CD",
      uses: ["attempt_c", "lemma_1", "crit_1", "patch_1"],
    }, 10),
    emit({
      type: "summary.made",
      runId,
      claimId: "merge_root",
      agentId: "synthesizer",
      bracket: "((A o B) o (C o D))",
      content: "Merged root",
      uses: ["attempt_a", "attempt_b", "attempt_c", "lemma_1", "crit_1", "patch_1"],
    }, 11),
    emit({
      type: "memory.slice",
      runId,
      agentId: "orchestrator",
      phase: "merge",
      window: 8,
      bracket: "((A o B) o (C o D))",
      maxChars: 1200,
      chars: 320,
      itemCount: 2,
      items: [
        { kind: "attempt.proposed", claimId: "attempt_b", agentId: "explorer_b" },
        { kind: "critique.raised", claimId: "crit_1", targetClaimId: "attempt_a", agentId: "skeptic" },
      ],
    }, 12),
    emit({
      type: "verification.report",
      runId,
      agentId: "verifier",
      status: "valid",
      content: "Proof checks out.",
      evidence: verifyEvidence,
    }, 13),
    emit({
      type: "solution.finalized",
      runId,
      agentId: "synthesizer",
      content: "theorem foo : True := by trivial",
      confidence: 0.61,
      gaps: [],
    }, 14),
  ];

  const html = theoremChatHtml(chain);

  expect(html).toMatch(/Receipt-backed owners for pods, merges, verify, and final proof/);
  expect(html).toMatch(/Critic Pod/);
  expect(html).toMatch(/Lemma Miner, Skeptic, Verifier/);
  expect(html).toMatch(/3 receipts · latest Verifier applied patch/);
  expect(html).toMatch(/Merge 1/);
  expect(html).toMatch(/Merge Explorer A \+ Explorer B/);
  expect(html).toMatch(/Merge 2/);
  expect(html).toMatch(/Merge Explorer C \+ Critic Pod/);
  expect(html).toMatch(/Verification valid via lean\.verify/);
  expect(html).toMatch(/Finalized proof \(0\.61\)/);
});

test("theorem side panel shows AXLE verify status, link, and derived curl", () => {
  const stream = "agents/axiom-guild/runs/run_verify";
  const runId = "run_verify";
  let prev: string | undefined;
  const emit = (body: TheoremEvent, ts: number) => {
    const next = receipt(stream, prev, body, ts);
    prev = next.hash;
    return next;
  };

  const proof = [
    "import Mathlib",
    "",
    "open scoped BigOperators",
    "",
    "open Finset",
    "",
    "theorem sum_range_id (n : Nat) : (∑ i : Nat in Finset.range (n+1), i) = n*(n+1)/2 := by",
    "  simpa using (Finset.sum_range_id (n + 1))",
  ].join("\n");

  const evidence = {
    phase: "verify" as const,
    tool: "lean.verify",
    environment: "lean-4.28.0",
    candidateHash: "abc123",
    formalStatementHash: "def456",
    candidateContent: proof,
    formalStatement: [
      "import Mathlib",
      "",
      "open scoped BigOperators",
      "",
      "open Finset",
      "",
      "theorem sum_range_id (n : Nat) : (∑ i : Nat in Finset.range (n+1), i) = n*(n+1)/2 := by",
      "  sorry",
    ].join("\n"),
    ok: true,
    failedDeclarations: [],
  };

  const chain: Chain<TheoremEvent> = [
    emit({
      type: "problem.set",
      runId,
      problem: "Prove sum_range_id.",
      agentId: "orchestrator",
    }, 1),
    emit({
      type: "subagent.merged",
      runId,
      agentId: "verifier",
      subJobId: "job_1",
      subRunId: "axiom_run_1",
      task: "Verify theorem with Axiom.",
      summary: "status: completed\noutcome: verified\nAXLE tools: lean.verify",
      outcome: "verified",
      evidence: [evidence],
    }, 2),
    emit({
      type: "verification.report",
      runId,
      agentId: "verifier",
      status: "valid",
      content: "AXLE verification succeeded.",
      evidence,
    }, 3),
    emit({
      type: "solution.finalized",
      runId,
      agentId: "synthesizer",
      content: proof,
      confidence: 0.62,
      gaps: [],
    }, 4),
  ];

  const state = fold(chain, reduceTheorem, initialTheorem);
  const team = THEOREM_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));
  const html = theoremSideHtml(
    state,
    chain,
    null,
    chain.length,
    "agents/axiom-guild",
    runId,
    team
  );

  expect(html).toMatch(/Verification run: yes/);
  expect(html).toMatch(/https:\/\/axle\.axiommath\.ai\/api\/v1\/verify_proof/);
  expect(html).toMatch(/curl -s -X POST https:\/\/axle\.axiommath\.ai\/api\/v1\/verify_proof/);
  expect(html).toMatch(/Final environment: lean-4\.28\.0/);
  expect(html).toMatch(/&quot;environment&quot;:&quot;lean-4\.28\.0&quot;/);
  expect(html).toMatch(/&quot;ignore_imports&quot;:true/);
  expect(html).toMatch(/sum_range_id/);
  expect(html).toMatch(/sorry/);
  expect(html).toMatch(/derived from persisted axle verification evidence for this run/i);
});
