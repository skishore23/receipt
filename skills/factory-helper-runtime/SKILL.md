---
name: factory-helper-runtime
description: Use when Factory infrastructure work should prefer checked-in reusable helpers over task-local scripts, and when Codex needs the standard helper runner, catalog layout, and result contract.
---

# Factory Helper Runtime

Use this skill when the active work should run a checked-in helper first instead of generating a one-off script inside `.receipt/factory/`.

## Runtime Order

1. Read the task packet, context pack, and memory script.
2. Check the mounted helper context for selected helpers.
3. Run the best matching checked-in helper with the shared runner.
4. Interpret the normalized helper output.
5. Stop when one or two helper runs produce enough evidence.

## Runner

- Shared runner: `skills/factory-helper-runtime/runner.py`
- Catalog root: `skills/factory-helper-runtime/catalog/`
- Infrastructure helpers live under `catalog/infrastructure/<helper_id>/`

Runner commands:

- `python3 skills/factory-helper-runtime/runner.py list --domain infrastructure --provider aws --json`
- `python3 skills/factory-helper-runtime/runner.py run --provider aws --json aws_account_scope -- --profile default`

## Contracts

Manifest fields:

- `id`
- `version`
- `provider`
- `tags`
- `description`
- `entrypoint`

Result fields:

- `status`
- `summary`
- `artifacts`
- `data`
- `capturedAt`
- `errors`
- `scriptsRun` (runtime-populated execution record)
- `evidenceRecords` (runtime-populated structured proof)

## Rules

- Prefer a checked-in helper over a new `.receipt/factory/*.sh` script.
- If no helper matches closely enough and repo edits are allowed, author or extend a checked-in helper under `skills/factory-helper-runtime/catalog/` instead of stopping at a no-helper report.
- If repo edits are out of scope for the current run, return the missing helper name and route the work back to a repo-writing Factory task. Do not invent a task-local `.receipt/factory/*.sh` script.
- Keep helper runs Unix-style: explicit CLI args in, structured JSON out.
- Record helper runner invocations in `report.scriptsRun`.
- Do not persist raw secrets, tokens, keys, or passwords in helper output, artifacts, or summaries.
- Keep helpers generic. Do not hard-code customer-specific names or account assumptions into the catalog.
