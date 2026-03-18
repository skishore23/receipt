# Failure Review Workflow

Use this workflow when a check fails or when you need to justify retry, approval, or inherited-failure claims.

## Review Order

1. Read the current task manifest and context pack.
2. Inspect the current objective:
   - `receipt factory inspect <objectiveId> --json`
   - `receipt factory inspect <objectiveId> --json --panel receipts`
3. Identify the current task, candidate, failed command, and current summary.
4. Inspect prior candidates for the same task in the current objective.
5. Compare the current failed command and failure text against prior current-objective failures.
6. Read task, candidate, objective, or integration memory only when the receipts do not fully explain the failure.

## Inherited-Failure Standard

Call a failure inherited only when the current objective already contains materially matching prior evidence for the same failure class, such as:

- the same failing command
- the same underlying error after ignoring worktree-specific paths or candidate ids
- a prior candidate or integration pass that already recorded the issue

Do not call a failure inherited when:

- the command changed
- the error moved to a different subsystem
- the output shows a new regression on top of an old issue
- the evidence is incomplete

## Retry And Review Guidance

- If the packet, receipts, and current-objective history show the change is good and the failed check is inherited, say that directly and cite the prior evidence source.
- If the failure appears new or ambiguous, do not guess. Describe what is missing and what needs another pass.
- Before asking for more work, verify that the worker actually queried prior candidate history instead of relying on the prompt or the latest check alone.
- If the claim is that Codex status capture itself is broken, confirm with `receipt factory codex-probe` before attributing the problem to the current objective or candidate.
- If you need to advance, steer, or cancel work during review, use the CLI (`receipt factory react|compose|steer|follow-up|abort-job`) instead of the inspect-only web views.

## Durable Notes

After gathering evidence, keep notes short and concrete:

- what failed
- whether it appears new or inherited
- which current-objective evidence supports that call
- what the next action should be
