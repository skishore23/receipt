# Factory Worker Context

Use the checked-in skill at `skills/factory-receipt-worker/SKILL.md` when working inside a Factory task worktree, reviewing Factory candidate or integration failures, or debugging what context a Factory Codex run can see.

## Bootstrap Order

1. Read the current task manifest under `.receipt/factory/<taskId>.manifest.json`.
2. Read the current context pack under `.receipt/factory/<taskId>.context-pack.json`.
3. Run the generated memory script from `.receipt/factory/<taskId>.memory.cjs` for `context`, `objective`, and the relevant scope summaries before assuming the prompt told you everything.
4. Query current-objective state with:
   - `receipt factory inspect <objectiveId> --json --panel debug`
   - `receipt factory inspect <objectiveId> --json --panel receipts`
5. Use `receipt inspect`, `receipt trace`, `receipt replay`, and `receipt memory ...` only as needed for deeper evidence.

## Working Rules

- Treat the prompt as bootstrap only, not as the full source of truth.
- Prefer current worktree packet first, current objective receipts second, repo-shared memory third.
- Query receipts before making retry, review, or inherited-failure claims.
- When checks fail, inspect prior candidate and check history in the current objective before deciding the failure is inherited.
- Write concise durable notes only after gathering evidence from the packet, receipts, or memory.
- Do not assume generated repo-profile skills outside the worktree are required; the committed repo skill and the current packet are the default worker interface.

## Shared Context

The following are shared with the Factory worker and can be queried directly:

- committed repo files
- this repo `AGENTS.md`
- checked-in repo skills under `skills/`
- current worktree files
- current task packet under `.receipt/factory/`
- `receipt` CLI on `PATH`
- `DATA_DIR`-backed receipts and memory reachable through `receipt`
- current-objective receipt history and memory scopes
- candidate and check history reachable through existing Factory and receipt commands

## Not Automatically Shared

Do not assume direct access to:

- arbitrary cross-objective receipt discovery
- other task worktrees' raw filesystem state
- uncommitted source changes outside the current worktree
- controller state that has not been written into receipts or memory
