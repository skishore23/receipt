# Axiom Benchmark

This document defines the first concrete benchmark target for the `axiom` agent and how to run it.

## First Problem

The first benchmark problem is:

- id: `list_length_append_nat`
- title: `List Length Append`

The agent must create `Main.lean` and prove:

```lean
import Mathlib

theorem list_length_append_nat (xs ys : List Nat) :
  List.length (xs ++ ys) = List.length xs + List.length ys := by
  ...
```

Why this is the right first target:

- not degenerate like `1 = 1`
- still easy enough to solve repeatedly
- rewards library search and `simpa using ...`
- exercises actual AXLE validation through `lean.check_file` or `lean.verify_file`
- gives a clear pass/fail outcome for prompt iteration

## Run It

Requires:

- `OPENAI_API_KEY`
- `AXLE_API_URL` and optionally `AXLE_API_KEY`

Run the starter benchmark:

```bash
npm run eval:axiom:first
```

Run a specific case:

```bash
npm run eval:axiom -- --case list_length_append_nat
```

JSON report:

```bash
npm run eval:axiom -- --case list_length_append_nat --json
```

## Pass Criteria

A run passes only if all of these hold:

- the run finishes with `completed`
- `Main.lean` exists
- `Main.lean` contains theorem `list_length_append_nat`
- `Main.lean` contains no `sorry`
- the run includes a successful AXLE file validation step
- a final response is recorded

## Self-Improvement Use

The benchmark runner supports prompt-patch validation through environment variables injected by the improvement harness.

For prompt proposals targeting `prompts/axiom.prompts.json`, set:

```bash
export IMPROVEMENT_VALIDATE_CMD="npm run eval:axiom:first"
```

Then `/improvement/:id/validate` will run the benchmark command with:

- `IMPROVEMENT_ARTIFACT_TYPE`
- `IMPROVEMENT_TARGET`
- `IMPROVEMENT_PATCH`

The evaluator will use the proposed Axiom prompt config in-memory when the proposal target is `prompts/axiom.prompts.json`.

## Next Cases

After the first case is stable, add benchmarks in this order:

1. small induction theorem
2. theorem requiring repair after a broken draft
3. false statement that must be rejected via `lean.disprove` or failed verification
4. small theorem requiring normalization or theorem extraction before proving
