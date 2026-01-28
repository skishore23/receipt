# Receipt Agent Framework

Build agents where **receipts are the only durable artifact** and **state + UI are pure folds**. This doc treats the current repo as a **framework** (not a demo) and is optimized for **multi-agent** devex.

---

## Why Receipt for Agents

Traditional agents hide state inside memory or logs. Receipt flips that:

- **Receipts are the truth**: every tool call, decision, and output is appended.
- **State is derived**: compute it by folding receipts, never store it as truth.
- **UI is a projection**: render any view from the same chain.
- **Time travel + replay**: deterministic analysis of any run.
- **Branching**: forks are first-class, not hacks.

This architecture gives you: auditability, debugging, reproducibility, and the power to cherry-pick context for LLM calls.

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
- `src/core/chain.ts` - append/fold/verify
- `src/core/runtime.ts` - runtime composition: store + decide + reducer
- `src/core/types.ts` - receipt + chain types
- `src/adapters/jsonl.ts` - persistence

### Agent framework
- `src/agents/agent.ts` - `AgentSpec` + registry (minimal API)
- `src/agents/workflow.ts` - workflow runner + queued emitter

### Theorem agent (reference implementation)
- `src/agents/theorem.ts` - workflow entry + public API
- `src/agents/theorem.constants.ts` - team, examples, ids
- `src/agents/theorem.memory.ts` - memory selection policy
- `src/agents/theorem.rebracket.ts` - rebracketing engine
- `src/agents/theorem.runs.ts` - run slicing + view helpers

---

## Building a New Agent (Multi-agent first)

### 1) Define events and state
Add a new module with event types and a reducer:

```
// src/modules/my-agent.ts
export type MyEvent =
  | { type: "problem.set"; runId: string; problem: string }
  | { type: "draft.made"; runId: string; agentId: string; content: string }
  | { type: "review.made"; runId: string; agentId: string; content: string }
  | { type: "solution.final"; runId: string; content: string; confidence: number };

export type MyCmd = { type: "emit"; event: MyEvent };

export type MyState = {
  runId?: string;
  problem: string;
  status: "idle" | "running" | "completed" | "failed";
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

export const reduce = (state: MyState, event: MyEvent): MyState => {
  switch (event.type) {
    case "problem.set":
      return { ...initial, runId: event.runId, problem: event.problem, status: "running" };
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
Use the workflow runner to orchestrate steps. Keep the orchestration minimal and push complexity into policy functions (memory, branching, merge).

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

If you do not need branching, set `shouldFork` to always return false.

```
// src/agents/my-agent.ts
import { createQueuedEmitter, runWorkflow } from "./workflow.js";
import type { Runtime } from "../core/runtime.js";
import type { MyCmd, MyEvent, MyState } from "../modules/my-agent.js";

export const MY_AGENT_ID = "my-agent";
export const MY_AGENT_VERSION = "0.1";

const MY_WORKFLOW = {
  id: MY_AGENT_ID,
  version: MY_AGENT_VERSION,
  run: async (ctx, config) => {
    await ctx.emit({ type: "problem.set", runId: ctx.runId, problem: config.problem });

    const draft = await ctx.llmText({ system: config.prompts.system, user: config.prompts.user });
    await ctx.emit({ type: "draft.made", runId: ctx.runId, agentId: "drafter", content: draft });

    const review = await ctx.llmText({ system: config.prompts.reviewer, user: draft });
    await ctx.emit({ type: "review.made", runId: ctx.runId, agentId: "reviewer", content: review });

    const final = await ctx.llmText({ system: config.prompts.final, user: draft + "\n\n" + review });
    await ctx.emit({ type: "solution.final", runId: ctx.runId, content: final, confidence: 0.7 });
  },
};
```

### 4) Wire runtime + route
In `src/server.ts`, create a runtime and a route that calls `runMyAgent(...)`.

### 5) Add views (optional)
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
- **Auditable**: optionally emit a `memory.slice` receipt (hash + size) for traceability.

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

## Rebracketing (Optional, merge-order policy)

Rebracketing changes **merge order**, not agent outputs. It's a heuristic that chooses which outputs should be merged earlier based on cross-pod conflict signals.

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
- Main stream only merges and decisions, not raw agent drafts.
- Memory policy is explicit and phase-aware.
- Merge policy is explicit (bracket or priority).
- Emit `run.configured` on start for reproducibility.
- Provide a time-travel view for any run and any branch.

---

## Next Ideas

- Add a `memory.slice` receipt for audit trace.
- Add a lightweight task scheduler (ready-set evaluation).
- Add a `tools.call` receipt type if you integrate tool use.
- Add a CLI runner for headless execution.

---

## Quick Reference

- Agent spec: `src/agents/agent.ts`
- Workflow runner: `src/agents/workflow.ts`
- Theorem agent: `src/agents/theorem.ts`
- Memory policy: `src/agents/theorem.memory.ts`
- Rebracket logic: `src/agents/theorem.rebracket.ts`
- Run slicing: `src/agents/theorem.runs.ts`
