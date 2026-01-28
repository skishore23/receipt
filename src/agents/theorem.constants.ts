// ============================================================================
// Theorem Guild constants
// ============================================================================

export const THEOREM_WORKFLOW_ID = "theorem-guild";
export const THEOREM_WORKFLOW_VERSION = "0.2";

export const THEOREM_TEAM = [
  { id: "orchestrator", name: "Orchestrator" },
  { id: "explorer_a", name: "Explorer A" },
  { id: "explorer_b", name: "Explorer B" },
  { id: "explorer_c", name: "Explorer C" },
  { id: "lemma_miner", name: "Lemma Miner" },
  { id: "skeptic", name: "Skeptic" },
  { id: "verifier", name: "Verifier" },
  { id: "synthesizer", name: "Synthesizer" },
];

export const THEOREM_EXAMPLES = [
  { id: "ineq", label: "Inequality", problem: "Prove for a,b,c>0: (a+b+c)^2 >= 3(ab+bc+ca)." },
  { id: "invariant", label: "Invariant", problem: "A process on integers is defined. Prove it terminates." },
  { id: "func", label: "Functional eq", problem: "Find all f such that f(x+y)=f(x)+f(y) with given constraints." },
];
