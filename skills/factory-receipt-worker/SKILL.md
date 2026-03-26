---
name: factory-receipt-worker
description: Use when working inside a Receipt Factory task worktree, reviewing Factory candidate or integration failures, or debugging what context a Factory Codex run can see through the task packet, receipt CLI, and scoped memory.
---

# Factory Receipt Worker

Use this skill when the task is running inside a Factory worktree or when you need to explain or justify a Factory review, retry, or inherited-failure decision from evidence already available in the repo.
Use it for direct Codex probe debugging too, but remember that probe packets are read-only evidence paths, not delivery workspaces.

## First Pass

Do this before making code or review claims:

1. Read the current `.receipt/factory/*.manifest.json`.
2. Read the current `.receipt/factory/*.context-pack.json`.
3. Run the generated `.receipt/factory/*.memory.cjs` script for `context` and `objective`.
4. Treat the mounted packet, recent receipts, and memory output as the worker interface. Do not call `receipt factory inspect` from inside a task worktree unless the runtime explicitly says a safe writable receipt snapshot is mounted.
5. If the question is about whether Codex status capture itself is broken, reproduce it independently with `receipt factory codex-probe --mode both --json --reply probe-ok` before claiming the status pipeline is failing.

## Working Rules

- Treat the worktree packet and receipt surfaces as the primary worker context.
- Treat Resonate as the execution control plane and receipts as the evidence/read-model. When job state and packet evidence disagree, inspect the current objective state and recent receipts before assuming old queue behavior.
- Do not run `receipt factory inspect` from inside a task worktree unless the runtime explicitly mounted a writable receipt snapshot.
- If the packet links to an objective, use the mounted recent receipts and memory output before claiming prior decisions, inherited failures, or missing context.
- Treat the prompt as bootstrap only.
- Prefer the current objective over broader history.
- Use repo-shared memory before assuming you need broader cross-objective context.
- Do not assume generated repo-profile skills outside the worktree are present or necessary.
- When checks fail, inspect prior current-objective candidate history before calling a failure inherited.
- If the evidence is incomplete, say so explicitly instead of guessing.
- Use `receipt factory ...` for Factory mutations. Treat `/factory` web views as inspect-only.
- Use `receipt factory codex-probe` only for Codex runtime/status debugging. Treat it as an isolated runtime probe, not as evidence about the current objective unless you tie it back to receipts or live job state.
- Direct Codex probes from Factory chat are read-only. If the requested outcome needs code changes, say so and route the work back through Factory objective dispatch.

## References

- For exact commands and query order, read `references/command-recipes.md`.
- For memory scope meanings and when to use each one, read `references/memory-scopes.md`.
- For check-failure and inherited-failure review workflow, read `references/failure-review.md`.
