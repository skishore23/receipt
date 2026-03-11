# Axiom Theorem Prover

This repo has two related but different theorem-proving paths:

- `axiom`: a standalone long-horizon Lean agent built on the generic Receipt agent loop.
- `axiom-guild`: the theorem guild workflow with Axiom subjobs used for real Lean checking and verification.

That distinction matters because rebracketing is part of the theorem guild path, not the standalone `axiom` loop.

For the public internet-facing architecture, see [Public Axiom Prover](./axiom-public-prover.md).
For the first evals, see [Axiom Benchmark](./axiom-benchmark.md).

## Short answer

If you want to understand the design in one pass:

- The standalone `axiom` agent is `runAgent(...)` plus AXLE-backed Lean tools and an optional local Lean final validation pass.
- The theorem guild is a multi-agent proof search workflow with explorers, skeptic, verifier, and synthesizer operating over receipt streams.
- `axiom-guild` is the theorem guild with queued Axiom subjobs wired in.
- Rebracketing changes the theorem guild's merge order for proof branches. It does not change how the standalone `axiom` agent thinks.
- AXLE is used as ground-truth tooling: check, verify, repair, simplify, extract, theorem-to-sorry, sorry-to-lemma, and disprove.

## Main files

- `src/agents/axiom.ts`: standalone Axiom runtime and Lean tool adapters.
- `src/agents/theorem.ts`: theorem guild workflow, round loop, merge, and Axiom delegation.
- `src/agents/theorem.rebracket.ts`: bracket trees, scoring, and deterministic rotation choice.
- `src/agents/theorem.evidence.ts`: round-level signal for whether rebracketing should happen.
- `src/server.ts`: wires queued Axiom subjobs back into theorem runs.
- `src/modules/theorem.ts`: theorem receipt event types and folded state.
- `src/agents/axiom.agent.ts`: `/axiom` route, which is the theorem-style Axiom Guild UI.

## Architecture

### 1. Standalone `axiom`

The standalone Axiom agent is a specialized version of the generic Receipt coding agent.

Base loop:

- implemented by `runAgent(...)` in `src/agents/agent.ts`
- LLM-driven think/act/observe loop
- one tool call per step
- durable receipts for prompts, actions, tool calls, validations, and final responses

Axiom adds:

- AXLE-backed Lean tools in `createAxiomTools(...)`
- workspace-aware file access for `.lean` files
- optional local Lean validation through `lake env lean` or `lean`
- stronger defaults than the generic coding agent

The key idea is simple:

- the LLM decides what to do next
- AXLE and local Lean provide the truth signal
- the final answer is only as strong as the latest verification receipts

### 2. Theorem guild

The theorem guild is not a single tool-using agent. It is a receipt-native multi-agent proof workflow.

Roles:

- `explorer_a`, `explorer_b`, `explorer_c`: produce distinct proof attempts
- `lemma_miner`: extracts reusable lemmas
- `skeptic`: critiques attempts
- `verifier`: patches and performs the final logical verification pass
- `synthesizer`: merges branches into summaries and the final proof
- `orchestrator`: controls rounds and skip/continue decisions

Each round does roughly this:

1. parallel attempt phase
2. optional lemma extraction
3. parallel critique phase
4. parallel patch phase
5. merge according to the current bracket
6. compute rebracketing evidence for the next round

### 3. `axiom-guild`

`axiom-guild` is the theorem guild plus queued Axiom workers.

That means:

- the outer workflow is still `runTheoremGuild(...)`
- explorers or the verifier can ask for an Axiom subtask
- the server enqueues a standalone `axiom.run` job
- the theorem run records the subjob summary and AXLE validation evidence as receipts

This is the path exposed at `/axiom`.

Important:

- `/axiom` is the theorem-style Axiom Guild UI
- the standalone `axiom` agent is run through CLI, job API, or `/monitor`

## How the standalone `axiom` agent is designed

`src/agents/axiom.ts` keeps the design intentionally narrow:

1. Normalize config.
2. Resolve the workspace root safely.
3. Register Lean tools.
4. Run the generic agent loop.
5. Optionally run a local Lean finalizer.

Default config:

- `maxIterations: 24`
- `maxToolOutputChars: 8000`
- `memoryScope: "axiom"`
- `workspace: "."`
- `leanEnvironment: "lean-4.28.0"` unless overridden
- `leanTimeoutSeconds: 120`
- `autoRepair: true`
- `localValidationMode: "off"`

### Tool model

The agent gets normal coding-agent tools plus AXLE tools such as:

- `lean.check`, `lean.check_file`
- `lean.verify`, `lean.verify_file`
- `lean.repair`, `lean.repair_file`
- `lean.normalize`, `lean.normalize_file`
- `lean.simplify`, `lean.simplify_file`
- `lean.extract_theorems`, `lean.extract_theorems_file`
- `lean.sorry2lemma`, `lean.sorry2lemma_file`
- `lean.theorem2sorry`, `lean.theorem2sorry_file`
- `lean.disprove`, `lean.disprove_file`
- `lean.cycle`, `lean.cycle_file`
- `lean.local.info`
- `lean.local.check`, `lean.local.check_file`
- `lean.local.build`

Two design choices are important:

- `lean.verify` is the strongest positive gate because it checks a candidate proof against a formal statement.
- `lean.cycle` is the convenience path: check or verify, optionally repair, then re-run on the repaired artifact.

### Final validation

The standalone agent can also run an optional finalizer after the LLM thinks it is done.

If `localValidationMode` is:

- `off`: do nothing
- `prefer`: try local Lean and annotate the final answer if unavailable
- `require`: reject the final answer unless local Lean succeeds

So the standalone Axiom design is:

- LLM for orchestration
- AXLE for theorem tooling
- optional local Lean for final sanity

## How rebracketing is used

Rebracketing belongs to the theorem guild path in `src/agents/theorem.ts` and `src/agents/theorem.rebracket.ts`.

It is not used by the standalone `axiom` loop.

### What a bracket means

The guild has four merge pods:

- `A`: Explorer A
- `B`: Explorer B
- `C`: Explorer C
- `D`: critic pod (`lemma_miner`, `skeptic`, `verifier`, `synthesizer`)

The code enumerates five binary bracketings over `A B C D`:

- `(((A o B) o C) o D)`
- `((A o (B o C)) o D)`
- `((A o B) o (C o D))`
- `(A o ((B o C) o D))`
- `(A o (B o (C o D)))`

These are merge trees. They define who gets merged first.

Example:

- `((A o B) o (C o D))` means merge `A` with `B`, merge `C` with `D`, then merge those results.

In practical terms, rebracketing decides which explorer gets combined with the critic pod earlier.

### What evidence drives rebracketing

There are two layers.

#### Layer 1: should the system rotate at all?

`evaluateRoundRebracketEvidence(...)` computes:

- `critiqueDensity`
- `disagreement`
- `patchCoverage`
- `unresolvedPressure`

It combines them into:

- `score = critiqueDensity + disagreement + unresolvedPressure + (1 - patchCoverage)`

If that score is at least `branchThreshold`, the run is allowed to rebracket.

Interpretation:

- lots of critique
- critiques spread across multiple attempts
- not enough successful patch coverage

means the current merge order is probably not helping enough.

#### Layer 2: which bracket should win?

`computeWeights(...)` scans receipts and assigns pod-pair weights from:

- `critique.raised`
- `patch.applied`
- `summary.made`

Then `pickBestBracket(...)` scores each bracket by how closely it places heavily interacting pods in the merge tree.

Tie-breakers are deterministic:

1. best causal score
2. best parallel merge potential
3. prefer the current bracket for stability
4. lexical order

### How it changes execution

The current bracket is used when the synthesizer merges the round outputs.

That means rebracketing changes:

- the order of intermediate `summary.made` receipts
- which sub-results are merged first
- how early critique-heavy material gets folded into the summary

It does not change:

- which agents exist
- what each agent is prompted to do
- whether AXLE is available

It only changes the merge tree.

## How Axiom is used inside the theorem workflow

There are two ways Axiom enters the theorem run.

### 1. Optional delegation requested by an agent

The theorem prompts allow explorers and the verifier to return:

- `axiom_task`
- `axiom_config`

Those fields are parsed in `src/agents/theorem.structured.ts`.

If present, `runTheoremGuild(...)` calls `runAxiomDelegate(...)`, which:

- emits a theorem `tool.called` receipt for `axiom.delegate`
- enqueues an `axiom.run` job through `delegateAxiomForTheorem(...)` in `src/server.ts`
- waits for the subjob to settle
- extracts AXLE validation receipts from the subrun
- emits `subagent.merged` back into the theorem run

The theorem attempt or verification text then includes the Axiom worker summary.

### 2. Required verification in `axiom-guild`

The `/axiom` route runs theorem guild with:

- `axiomPolicy: "required"`

In that mode, even if the verifier LLM does not request Axiom explicitly, the workflow builds a forced verification task and sends it to Axiom.

The required verification task instructs Axiom to:

- formalize or load the exact theorem statement
- use `lean.theorem2sorry` or `lean.theorem2sorry_file` to get the sorried statement artifact when needed
- run `lean.verify` or `lean.verify_file` as the final ground-truth gate

### What evidence comes back

The server reads the Axiom subrun and extracts:

- Lean tool names used
- AXLE validation reports
- final `lean.verify` evidence when present
- candidate hash
- formal statement hash

That evidence is stored on theorem receipts as `TheoremAxiomEvidence`.

For a final theorem proof to become `valid` in required mode, the code checks:

- there is final `lean.verify` or `lean.verify_file` evidence
- that verification succeeded
- the verified candidate hash matches the merged proof artifact
- the verified formal-statement hash matches the statement used for verification

If those checks fail, the theorem result is downgraded to `needs` or `false`.

So Axiom is not just advisory in `axiom-guild`. It can be the deciding gate.

## Receipt model

The important theorem receipts for this design are:

- `attempt.proposed`
- `lemma.proposed`
- `critique.raised`
- `patch.applied`
- `summary.made`
- `rebracket.applied`
- `merge.evidence.computed`
- `merge.candidate.scored`
- `merge.applied`
- `tool.called`
- `subagent.merged`
- `verification.report`
- `solution.finalized`

This is what makes the workflow auditable:

- you can see when Axiom was called
- you can see why the bracket changed
- you can inspect exactly which AXLE verification artifact was trusted

## End-to-end mental model

If you want the cleanest mental model, use this:

- `axiom` is the Lean worker.
- theorem guild is the debate and synthesis framework.
- rebracketing is the theorem guild's merge scheduler.
- `axiom-guild` is theorem guild plus real Lean evidence from Axiom workers.

So when someone says "the Axiom theorem proving agent" in this repo, they usually mean one of two things:

- the standalone `axiom` worker that drives AXLE tools directly
- the `/axiom` Axiom Guild route, where theorem-guild rebracketing and Axiom verification are combined

If you care about rebracketing, read the theorem guild code.
If you care about AXLE tool use and Lean validation, read the standalone Axiom code.
If you care about the full combined system, read both.
