# Receipt Runtime Framework

Receipt is a **multi-agent framework** where **receipts are the only durable artifact** and **state + UI are pure folds**. This repo is a **reference implementation** of the framework and is optimized for **multi-agent devex**.

---

## Why Receipt for Multi-Agent Systems

Traditional agents hide state inside memory or logs. Receipt flips that:

- **Receipts are the truth**: every tool call, decision, and output is appended.
- **State is derived**: compute it by folding receipts, never store it as truth.
- **UI is a projection**: render any view from the same chain.
- **Time travel + replay**: deterministic analysis of any run.
- **Branching**: forks are first-class, not hacks.

This architecture gives you: auditability, debugging, reproducibility, and the power to cherry-pick context for model calls.

---

## Mental Model

```
Command -> decide -> Event -> append -> Chain
                                      |
                                      v
                                 fold/view
                                      |
                                      v
                                 State / UI
```

- **Command**: external input (HTTP, CLI, tool callback)
- **Event**: immutable fact (receipt body)
- **Chain**: append-only receipt list (hash-linked)
- **Fold**: pure function to derive state
- **View**: pure function to render UI or outputs

---

## Framework Surface (Minimal API)

### Core kernel (do not change)
- `src/core/chain.ts` - receipt/fold/verify
- `src/core/runtime.ts` - runtime composition: store + decide + reducer
- `src/core/types.ts` - receipt + chain types
- `src/adapters/jsonl.ts` - persistence

### Receipt Runtime surface
- `src/engine/runtime/receipt-runtime.ts` - `defineReceiptAgent` + `runReceiptAgent`
- `src/engine/runtime/planner.ts` - typed planner runner (`needs` / `provides`)
- `src/engine/runtime/plan-validate.ts` - cycle and dependency validation
- `src/engine/runtime/workflow.ts` - queued emitters + run lifecycle runner (durable by default)

### Theorem agent (reference implementation)
- `src/agents/theorem.ts` - workflow entry + public API
- `src/agents/theorem.constants.ts` - team, examples, ids
- `src/agents/theorem.streams.ts` - stream layout helpers (run/branch)
- `src/agents/theorem.memory.ts` - memory selection policy
- `src/agents/theorem.rebracket.ts` - rebracketing engine
- `src/agents/theorem.runs.ts` - run slicing + view helpers

---

## Streams (Index + Run)

Runs live in their own stream; the base stream is an **index**. This keeps replay cheap and JSONL files small.

- **Index stream**: `<base>` (ex: `theorem`) - run-level receipts (`problem.set`, `run.configured`, `run.status`, `solution.finalized`).
- **Run stream**: `<base>/runs/<runId>` - full receipt chain for that run.
- **Branch stream**: `<runStream>/branches/<branchId>` - forked timelines.

JSONL is one file per stream, so this layout gives you separate files per run and per branch without extra infra.

---

## DevEx improvements (what changes for builders)

This framework is meant to feel **simpler** than most agent frameworks:

- **One run = one stream = one JSONL**: smaller files, faster loads, easy replay.
- **Index stream**: a tiny run ledger for UI lists and run discovery.
- **Explicit policy hooks**: memory/branch/merge are plain functions, not hidden state.
- **Auditable context**: emit `memory.slice` receipts so you can see what the model saw.
- **Planner layer**: declare `needs` / `provides` and let a scheduler pick safe parallelism.
- **Receipt-native planning**: the planner is just another agent that emits receipts and folds state.

If you only build single-agent flows, you can ignore branching and merge policy entirely.

---

## Included Multi-Agent Demos

The reference repo ships three receipt-native demos:

- **Theorem Guild** (`/theorem`): branch-first proof workflow with memory slices and rebracketing merge policy.
- **Writer Guild** (`/writer`): planner-driven capability graph with explicit `needs` / `provides` and step receipts.
- **Receipt Inspector** (`/receipt`): multi-agent run analysis (analyze/improve/timeline/qa) over JSONL receipts.

Each demo uses the same kernel and runtime primitives. Only events, policies, and prompts change.

---

## Building a New Agent (Multi-agent first)

For a short, implementation-first guide, use `docs/create-agent.md`.

Minimum path for a working agent:
1) Events + reducer
2) Prompts
3) Orchestration (planner or manual workflow)
4) Public run entry (stream strategy)
5) Views (optional)

### 1) Define events and state
Add a new module with event types and a reducer:

```
// src/modules/my-agent.ts
export type MyEvent =
  | { type: "problem.set"; runId: string; problem: string }
  | { type: "run.configured"; runId: string; workflow: { id: string; version: string }; model: string }
  | { type: "run.status"; runId: string; status: "running" | "failed" | "completed"; note?: string }
  | { type: "draft.made"; runId: string; agentId: string; content: string }
  | { type: "review.made"; runId: string; agentId: string; content: string }
  | { type: "solution.final"; runId: string; content: string; confidence: number };

export type MyCmd = { type: "emit"; event: MyEvent; eventId: string; expectedPrev?: string };

export type MyState = {
  runId?: string;
  problem: string;
  status: "idle" | "running" | "completed" | "failed";
  statusNote?: string;
  config?: { workflowId: string; workflowVersion: string; model: string; updatedAt: number };
  drafts: Record<string, string>;
  reviews: Record<string, string>;
  solution?: { content: string; confidence: number };
};

export const initial: MyState = {
  problem: "",
  status: "idle",
  drafts: {},
  reviews: {},
};

export const decide = (cmd: MyCmd): MyEvent[] => [cmd.event];

export const reduce = (state: MyState, event: MyEvent, ts: number): MyState => {
  switch (event.type) {
    case "problem.set":
      return { ...initial, runId: event.runId, problem: event.problem, status: "running" };
    case "run.configured":
      return {
        ...state,
        config: {
          workflowId: event.workflow.id,
          workflowVersion: event.workflow.version,
          model: event.model,
          updatedAt: ts,
        },
      };
    case "run.status":
      return { ...state, status: event.status, statusNote: event.note ?? state.statusNote };
    case "draft.made":
      return { ...state, drafts: { ...state.drafts, [event.agentId]: event.content } };
    case "review.made":
      return { ...state, reviews: { ...state.reviews, [event.agentId]: event.content } };
    case "solution.final":
      return { ...state, status: "completed", solution: { content: event.content, confidence: event.confidence } };
    default:
      return state;
  }
};
```

### 2) Define prompts
Put your prompt templates in `prompts/my-agent.prompts.json` and load via a small adapter. Keep prompt keys stable so receipts remain comparable across runs.

### 3) Create an agent workflow
Use the workflow runner **with a run lifecycle**. The lifecycle emits `problem.set`, `run.configured`, and `run.status` once, and the runner **auto-resumes** whenever a run stream already has receipts (no special flag needed).

### 3a) Add policy modules (minimal API, multi-agent focused)
These are plain functions you own. Keep them in separate files for clarity.

```
type MemoryPolicy = {
  budget: (phase: "attempt" | "lemma" | "critique" | "patch" | "merge") => number;
  select: (chain, opts) => string;
};

type BranchPolicy = {
  shouldFork: (chain, round) => boolean;
  branchName: (runId, agentId, round) => string;
};

type MergePolicy = {
  mergeOrder: (chain, current) => { bracket: string; note?: string };
};
```

If you do not need branching, omit `BranchPolicy` entirely or set `shouldFork` to always return false.

```
// src/agents/my-agent.ts
import { runWorkflow } from "./workflow.js";
import type { Runtime } from "../core/runtime.js";
import type { RunLifecycle } from "./workflow.js";
import { reduce, initial, type MyCmd, type MyEvent, type MyState } from "../modules/my-agent.js";

export const MY_AGENT_ID = "my-agent";
export const MY_AGENT_VERSION = "0.1";

const MY_LIFECYCLE: RunLifecycle<any, MyEvent, MyState, { problem: string }> = {
  reducer: reduce,
  initial,
  init: (ctx, runId, config) => [
    { type: "problem.set", runId, problem: config.problem },
    { type: "run.configured", runId, workflow: { id: MY_AGENT_ID, version: MY_AGENT_VERSION }, model: ctx.model },
    { type: "run.status", runId, status: "running" },
  ],
  resume: (_ctx, runId, state) =>
    state.status === "running" ? [] : [{ type: "run.status", runId, status: "running", note: "resumed" }],
};

const MY_WORKFLOW = {
  id: MY_AGENT_ID,
  version: MY_AGENT_VERSION,
  lifecycle: MY_LIFECYCLE,
  run: async (ctx, config) => {
    const draft = await ctx.llmText({ system: config.prompts.system, user: config.prompts.user });
    await ctx.emit({ type: "draft.made", runId: ctx.runId, agentId: "drafter", content: draft });

    const review = await ctx.llmText({ system: config.prompts.reviewer, user: draft });
    await ctx.emit({ type: "review.made", runId: ctx.runId, agentId: "reviewer", content: review });

    const final = await ctx.llmText({ system: config.prompts.final, user: draft + "\n\n" + review });
    await ctx.emit({ type: "solution.final", runId: ctx.runId, content: final, confidence: 0.7 });
    await ctx.emit({ type: "run.status", runId: ctx.runId, status: "completed" });
  },
};
```

### 3b) Planner (`needs`/`provides`, Ranger-like)
Define **capabilities** with explicit `needs`/`provides` and let the planner emit receipts for step readiness and completion.
The planner is built on the same receipt chain: it folds state, decides readiness, and records everything as receipts.
No DSL required; just data + a planner loop that folds receipts into state.

```
type CapabilitySpec<Ctx> = {
  id: string;
  inputs: string[];
  outputs: string[];
  run: (ctx: Ctx, state: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

type PlanStep = { id: string; cap: string };

const CAPS: CapabilitySpec<any>[] = [
  { id: "research", inputs: ["problem"], outputs: ["attempts"], run: async () => ({ attempts: [] }) },
  { id: "critique", inputs: ["attempts"], outputs: ["critiques"], run: async () => ({ critiques: [] }) },
  { id: "merge", inputs: ["attempts", "critiques"], outputs: ["summary"], run: async () => ({ summary: "" }) },
];
```

Planner rules (suggested):
- **Ready** when all inputs exist in derived state.
- **Safe to run in parallel** when outputs do not overlap.
- Emit receipts like `step.ready`, `step.started`, `step.completed`, and `state.patch`.

This keeps orchestration **declarative**, but still receipt-native.

### 4) Public run entry (stream strategy)
Use per-run streams for clean JSONL files and fast replay. Emit to the index stream for run lists.

```
// src/agents/my-agent.ts (run entry)
export const runMyAgent = async (input) => {
  const runStream = `${input.stream}/runs/${input.runId}`;
  const emitRun = createQueuedEmitter({ runtime: input.runtime, stream: runStream, wrap: (event) => ({ type: "emit", event }) });
  const emitIndex = createQueuedEmitter({ runtime: input.runtime, stream: input.stream, wrap: (event) => ({ type: "emit", event }) });
  await runReceiptAgent({ spec: MY_RECEIPT_RUNTIME, ctx: { ...input, stream: runStream, emit: emitRun, emitIndex }, config: input.config });
};
```

If you use `emitIndex`, add it to your workflow deps type and only forward run-level events.
`runWorkflow` will automatically resume if the run stream already has receipts—replay is the default.

### 5) Wire runtime + route
In `src/server.ts`, create a runtime and a route that calls `runMyAgent(...)`.

### 6) Add views (optional)
A view is just a fold or chain projection:

```
const view = (chain) => renderFrom(chain);
```

---

## Memory: Receipt-first, policy-driven

Memory is **computed**, not stored. The framework expectation is that each agent exposes a **MemoryPolicy** (a minimal API you control) and the workflow calls it per phase.

Minimal policy surface (suggested):
```
type MemoryPolicy = {
  budget: (phase: "attempt" | "lemma" | "critique" | "patch" | "merge") => number;
  select: (chain, opts) => string;
};
```

Default behavior for multi-agent work:
- **Phase-aware**: each phase gets a different memory profile.
- **Relevance-ranked**: score by links (`targetClaimId`), conflict signals, and recency.
- **Budgeted**: cap by token or dynamic character budget.
- **Auditable**: emit a `memory.slice` receipt (phase, size, items) for traceability.

Reference: `src/agents/theorem.memory.ts` is a policy module you can reuse or fork.

---

## Branching-first parallelism (core mental model)

Branching is **first-class** in this framework. Parallelism is an **emergent property** of the chain and is expressed as **multiple streams**, not just tags. If you avoid branching, you lose the core multi-agent advantages (isolated timelines, clean merges, and replay).

Recommended pattern (minimal API, high leverage):
- Main stream emits `task.ready` receipts.
- For each ready task, **fork a branch** and run that agent in its own timeline.
- Merge results back into the main stream via `summary.made` or `task.completed` receipts.
- Optional: emit `phase.parallel` receipts purely for UI/telemetry.

Why this is the default:
- Every agent has a **separate timeline** (true isolation).
- Merges are explicit and replayable.
- The chain captures coordination without hidden state.

---

## Coordination UI Contract (framework-level)

Use one shared projection contract across agents so users can read coordination the same way in theorem, writer, and future agents.

Shared renderer:
- `src/views/agent-framework.ts` (`frameworkCoordinationHtml`)

Projection model expected by the renderer:
- **Metrics**: run status, current active phase, receipt counts, context slice counts.
- **Context rows**: what each agent saw before generation (`prompt.context` slices).
- **Lane rows**: per-agent live status (`running`/`idle`/`done`/`failed`) + current action.
- **Trail rows**: ordered coordination receipts (branching, planner steps, summaries, failures, lifecycle).

Recommended receipt mapping:
- Context:
  - `prompt.context` -> one context row per emitted slice.
- Lanes:
  - `agent.status` for direct agent workflows (theorem-style), or
  - `step.ready` / `step.started` / `step.completed` / `step.failed` for planner workflows (writer-style).
- Trail:
  - `phase.parallel`, `branch.created`, `run.status`, `solution.finalized`,
  - plus domain receipts like `attempt.proposed`, `summary.made`, `state.patch`.

Time-travel UX rules (framework default):
- Keep time travel at the top of the main panel (not in the sidebar).
- Treat time-travel as a first-class replay control for all agents.
- Use an OOB endpoint (`/<agent>/travel`) that updates travel + chat + side islands together to prevent flicker during scrubbing.

Streaming semantics (why it is not ChatGPT-like token streaming by default):
- Current framework demos stream at **receipt granularity** (after each completed agent step/receipt).
- Token-level streaming is off because most workflows call `llmText` and only emit receipts once the step finishes.
- To enable token streaming, switch to a provider streaming API and emit incremental receipts (`output.delta` + final `output.completed`) that the UI appends live.

---

## Rebracketing (Optional, merge-order policy)

Rebracketing changes **merge order**, not agent outputs. It's a heuristic that chooses which outputs should be merged earlier based on cross-pod conflict signals.
Under the hood this is a walk on the **Tamari lattice** of binary bracketings; each bracket can be treated as a merge **lens** (category-theory optics over the pod tree).

- Inputs: critiques + patches + summaries
- Output: a bracket for the next merge
- Use only if merge order meaningfully changes quality

---

## Testing and Debugging (multi-agent oriented)

- Use the chain to reproduce any run: fold receipts to rebuild state.
- Add view endpoints for slices (time travel).
- Use integrity checks (`verify`) to detect tampering.
- Emit `run.configured` for reproducibility (model, prompt hash, parameters).
- Treat each branch as a test fixture: replay branches independently to debug agent behavior.

---

## Design Principles (framework stance)

- **Receipts only**: no hidden memory, no mutable state.
- **Pure folds**: state and UI are derived.
- **Branching-first**: multi-agent timelines are explicit, not simulated.
- **Minimal surface**: small, composable primitives.
- **Auditable by default**: every output is a receipt.

---

## Multi-agent devex checklist

- Every agent has its own branch stream (stable naming).
- Runs write to per-run streams; base stream stores lifecycle receipts.
- Main stream only merges and decisions, not raw agent drafts.
- Memory policy is explicit and phase-aware.
- Merge policy is explicit (bracket or priority).
- Emit `run.configured` on start for reproducibility.
- Provide a time-travel view for any run and any branch.

---

## Next Ideas

- Add a lightweight task scheduler (ready-set evaluation).
- Add a `tools.call` receipt type if you integrate tool use.
- Add a CLI runner for headless execution.

---

## Quick Reference

- Workflow runner: `src/engine/runtime/workflow.ts`
- Planner runner: `src/engine/runtime/planner.ts`
- Agent spec: `src/engine/runtime/receipt-runtime.ts`
- Theorem agent: `src/agents/theorem.ts`
- Stream helpers: `src/agents/theorem.streams.ts`
- Memory policy: `src/agents/theorem.memory.ts`
- Rebracket logic: `src/agents/theorem.rebracket.ts`
- Run slicing: `src/agents/theorem.runs.ts`
- Shared coordination view: `src/views/agent-framework.ts`
