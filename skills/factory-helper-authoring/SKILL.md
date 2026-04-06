---
name: factory-helper-authoring
description: Use when Codex should add or update a checked-in helper in the shared catalog instead of generating a one-off runtime script.
---

# Factory Helper Authoring

Use this skill when a needed helper does not exist yet or when an existing checked-in helper needs to be extended.

## Scaffold

- Runtime root: `skills/factory-helper-runtime/`
- Catalog layout: `catalog/<domain>/<helper_id>/`
- Required files:
  - `manifest.json`
  - `run.py`

## Authoring Rules

- Keep helpers stdlib-first Python CLIs.
- Use explicit CLI args. Do not read prompt prose directly.
- Emit the canonical result envelope with `status`, `summary`, `artifacts`, `data`, `capturedAt`, and `errors`.
- Prefer generic building blocks over customer-specific helpers.
- Use AWS CLI as the backend for AWS helpers. Do not add MCP or extra frameworks in v1.
- Add or update smoke tests when helper selection, profile mounting, or CLI surfaces change.

## When No Helper Matches

- Do not tell a worker to invent a `.receipt/factory/*.sh` script.
- Name the missing helper directly.
- In repo-writing work, create the checked-in helper immediately when the missing behavior and CLI contract are clear enough to implement safely.
- Add it under the checked-in catalog so later investigations can rerun it.
