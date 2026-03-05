# Receipt Runtime Framework

Receipt is a receipt-native agent runtime.

## Principles

- Receipts are the only durable truth.
- State/views/traces/queues are derived from receipts.
- Control decisions are observable via control receipts.
- Replay is deterministic under pinned versions.

## Public SDK

- `defineAgent`
- `receipt<T>()`
- `action`, `assistant`, `tool`, `human`
- `goal`
- `merge` / `rebracket`

## Runtime loop

1. Fold chain into view.
2. Evaluate action readiness.
3. Select deterministically.
4. Emit `action.selected` + execution receipts.
5. Execute action and append domain receipts.
6. Evaluate goal + merge policy.

Control receipts include:

- `run.started`, `run.completed`, `run.failed`
- `action.selected`, `action.started`, `action.completed`, `action.failed`
- `goal.completed`
- `human.requested`, `human.responded`
- `merge.evidence.computed`, `merge.candidate.scored`, `merge.applied`

## Discovery

Agents are auto-discovered from `src/agents/*.agent.ts` (dev) and `dist/agents/*.agent.js` (prod).

No central registry edits are required.

## Queue model

Queue streams:

- `jobs` (index/projection)
- `jobs/<jobId>` (authoritative lifecycle)

Lifecycle uses leases, heartbeats, retries, singleton behavior, and in-flight commands (`steer`, `follow_up`, `abort`).

## CLI

- `receipt new`
- `receipt dev`
- `receipt run`
- `receipt trace`
- `receipt replay`
- `receipt fork`
- `receipt inspect`
- `receipt jobs`
- `receipt abort`

## First-party modules

- Theorem (`src/agents/theorem.agent.ts`)
- Writer (`src/agents/writer.agent.ts`)
- Monitor/Agent (`src/agents/monitor.agent.ts`)
- Inspector (`src/agents/inspector.agent.ts`)
- Todo (`src/agents/todo.agent.ts`)
