# Command Recipes

Use the existing task packet and `receipt` CLI before inventing new context-gathering steps.

## Current Task Bootstrap

Start in the current worktree:

- `ls .receipt/factory`
- `sed -n '1,220p' .receipt/factory/<taskId>.manifest.json`
- `sed -n '1,240p' .receipt/factory/<taskId>.context-pack.json`
- `sed -n '1,220p' .receipt/factory/<taskId>.memory-scopes.json`

Then use the generated memory script:

- `node .receipt/factory/<taskId>.memory.cjs context 2800`
- `node .receipt/factory/<taskId>.memory.cjs objective 1800`
- `node .receipt/factory/<taskId>.memory.cjs overview "<task title>" 2400`
- `node .receipt/factory/<taskId>.memory.cjs scope task "<task title>" 1400`
- `node .receipt/factory/<taskId>.memory.cjs scope objective "<objective title>" 1400`
- `node .receipt/factory/<taskId>.memory.cjs search repo "<task title>" 6`

## Current Objective Inspection

Use the objective id from the manifest:

- `receipt factory inspect <objectiveId> --json --panel debug`
- `receipt factory inspect <objectiveId> --json --panel receipts`
- `receipt factory inspect <objectiveId> --json`

Use the JSON output to inspect:

- current task and candidate state
- prior candidates for the same task
- integration state
- latest context-pack and memory-script paths
- recent receipts and summaries

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

## Query Order

Prefer this order:

1. current task packet
2. current objective receipts
3. repo-shared and objective-scoped memory
4. broader receipt inspection only if the current objective is insufficient
