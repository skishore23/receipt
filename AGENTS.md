# Factory Worker Context

Use the checked-in skill at `skills/factory-receipt-worker/SKILL.md` when working inside a Factory task worktree, reviewing Factory candidate or integration failures, or debugging what context a Factory Codex run can see.

## Bootstrap Order

1. Read the current task context summary under `.receipt/factory/<taskId>.context.md`.
2. Read the current context pack under `.receipt/factory/<taskId>.context-pack.json`.
3. Read the generated Receipt CLI surface under `.receipt/factory/<taskId>.receipt-cli.md`, and use the current task manifest under `.receipt/factory/<taskId>.manifest.json` only when you need exact contract, path, or ref reconciliation.
4. Run the generated memory script from `.receipt/factory/<taskId>.memory.cjs` for `context`, `objective`, and the relevant scope summaries before assuming the prompt told you everything.
5. If you need a controller-side reconstruction of what happened before retrying, reviewing, or course-correcting, use `receipt factory investigate <objectiveId|taskId|candidateId|jobId|runId>` from the repo root.
6. If you need repo-level self-improvement signals or cross-objective run quality, use `receipt factory audit [--limit <n>]` from the repo root.
7. If a live Factory task is drifting, use `receipt factory steer <jobId> --message ...` or `receipt factory follow-up <jobId> --message ...` from the repo root instead of assuming the worker will recover on its own.
8. If you need a reproducible evidence bundle for how long-running live intervention behaves, use `receipt factory experiment long-run`.
9. Do not call `receipt factory inspect` from inside a task worktree by default. The packet already mounts recent receipts and objective state, and worktree-side inspect can fail on receipt lock files outside the writable workspace.
10. Use `receipt inspect`, `receipt trace`, `receipt replay`, and `receipt memory ...` only as needed for deeper evidence, and prefer controller-side inspection over task-worktree inspection when live objective state is required.

## Working Rules

- Treat the prompt as bootstrap only, not as the full source of truth.
- Treat the task context summary as the fast bootstrap digest; reopen the manifest or raw context pack only when you need exact fields, paths, refs, or contradiction checks.
- Prefer current worktree packet first, current objective receipts second, repo-shared memory third.
- Use the generated Receipt CLI surface before ad hoc broader `receipt ...` exploration.
- Query the packet and mounted recent receipts before making retry, review, or inherited-failure claims.
- When you need to explain or repair a failed attempt from controller-side evidence, run `receipt factory investigate ...` before deciding the next retry or operator handoff.
- When you need to judge whether the system is improving, whether a run took the easy route, or whether shared memory should be promoted, run `receipt factory audit ...` and prefer the dedicated audit memory scopes over repo-shared guesses.
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
- current task context summary and generated Receipt CLI surface under `.receipt/factory/`
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
