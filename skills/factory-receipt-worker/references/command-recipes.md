# Command Recipes

Use the existing task packet and `receipt` CLI before inventing new context-gathering steps.

## Current Task Bootstrap

Start in the current worktree:

- `ls .receipt/factory`
- `sed -n '1,220p' .receipt/factory/<taskId>.manifest.json`
- `sed -n '1,240p' .receipt/factory/<taskId>.context-pack.json`
- `sed -n '1,220p' .receipt/factory/<taskId>.memory-scopes.json`

Then use the generated memory script:

- `bun .receipt/factory/<taskId>.memory.cjs context 2800`
- `bun .receipt/factory/<taskId>.memory.cjs objective 1800`
- `bun .receipt/factory/<taskId>.memory.cjs overview "<task title>" 2400`
- `bun .receipt/factory/<taskId>.memory.cjs scope task "<task title>" 1400`
- `bun .receipt/factory/<taskId>.memory.cjs scope objective "<objective title>" 1400`
- `bun .receipt/factory/<taskId>.memory.cjs search repo "<task title>" 6`

## Current Objective Inspection

Do not call `receipt factory inspect` from inside a task worktree by default.

Use the mounted packet and memory output instead:

- manifest and context-pack for current task/candidate state
- mounted recent receipts for objective history
- memory script output for task, objective, and repo summaries

If live objective state is still required, use controller-side inspection instead of task-worktree inspection.

## Repair And Course-Correct

Before retrying a blocked task, reviewing a failed candidate, or deciding whether a failure is inherited, reconstruct the controller-side story first:

- `receipt factory investigate <objectiveId>`
- `receipt factory investigate <taskId>`
- `receipt factory investigate <candidateId> --json`

Use this output to answer:

- what happened end-to-end
- what context the worker actually had
- how the DAG advanced or stalled
- what candidate lineage and recent receipts say about the next repair step

For repo-level self-improvement and trend review:

- `receipt factory audit --limit 12`
- `receipt factory audit --limit 20 --json`

Use this output to answer:

- which recent runs were weak, noisy, or churn-heavy
- whether the agent likely took the easy route
- which anomalies dominate across objectives
- whether shared memory is being polluted with run-specific entries

## CLI-First Factory Control

Use these when you need to mutate Factory state. Do not rely on `/factory` web forms for operator actions.

- `receipt factory run --prompt "<objective prompt>"`
- `receipt factory create --prompt "<objective prompt>"`
- `receipt factory compose --objective <objectiveId> --prompt "<operator note>"`
- `receipt factory react <objectiveId> --message "<operator note>"`
- `receipt factory promote <objectiveId>`
- `receipt factory cancel <objectiveId> --reason "<reason>"`
- `receipt factory cleanup <objectiveId>`
- `receipt factory archive <objectiveId>`
- `receipt factory steer <jobId> --problem "<updated direction>"`
- `receipt factory follow-up <jobId> --note "<extra context>"`
- `receipt factory abort-job <jobId> --reason "<reason>"`

## Codex Status Probe

Use this only when the debugging question is about the Codex runtime or status plumbing itself, such as:

- "Codex always shows failed"
- "I never see queued or running"
- "Is the problem in live status capture or just this objective?"

Run an isolated probe first:

- `receipt factory codex-probe --mode both --json --reply probe-ok`

Useful variants:

- `receipt factory codex-probe --mode queue --json --reply probe-ok`
- `receipt factory codex-probe --mode direct --json --reply probe-ok`
- `receipt factory codex-probe --mode both --reply probe-ok`

Use the probe output to inspect:

- whether direct Codex progress snapshots appear
- whether the queue path moves through `queued`, `running`, and `completed`
- the artifact paths for `last-message.txt`, `stdout.log`, and `stderr.log`

Treat the probe as independent runtime evidence. It does not replace current-objective receipts when you are explaining why a specific task or candidate failed.

## Deeper Receipt Inspection

When the Factory objective view is not enough, inspect the objective stream directly:

- `receipt inspect factory/objectives/<objectiveId>`
- `receipt trace factory/objectives/<objectiveId>`
- `receipt replay factory/objectives/<objectiveId>`

Use these only after checking the task packet and `receipt factory inspect`, because the direct stream output is lower-level.

## Memory Queries

Use `receipt memory ...` when you need durable summaries or exact entries:

- `receipt memory read factory/repo/shared --limit 6`
- `receipt memory search factory/repo/shared --query "<term>" --limit 6`
- `receipt memory summarize factory/objectives/<objectiveId> --query "<term>" --limit 6 --max-chars 1200`
- `receipt memory summarize factory/objectives/<objectiveId>/tasks/<taskId> --query "<term>" --limit 6 --max-chars 1200`
- `receipt memory summarize factory/objectives/<objectiveId>/candidates/<candidateId> --query "<term>" --limit 6 --max-chars 1200`
- `receipt memory summarize factory/objectives/<objectiveId>/integration --query "<term>" --limit 6 --max-chars 1200`
- `receipt memory summarize factory/audits/objectives/<objectiveId> --limit 4 --max-chars 1200`
- `receipt memory summarize factory/audits/repo --limit 8 --max-chars 1600`

## Query Order

Prefer this order:

1. current task packet
2. mounted current objective receipts
3. repo-shared and objective-scoped memory
4. controller-side receipt inspection only if the current objective packet is insufficient
