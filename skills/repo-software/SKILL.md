---
name: repo-software
description: Use when a Factory profile or worker needs a reusable map for understanding the Receipt codebase, inspecting implementation surfaces, and validating software changes without guessing.
---

# Repo Software

Use this skill when you need to understand how this repository is organized before proposing, dispatching, or validating software work.

## Primary Goal

Build a fast, evidence-based picture of the current codebase so decisions come from repo state, not prompt assumptions.

## First Pass

1. Identify the subsystem you are about to touch.
2. Read the nearest reducer/runtime/service/view files before proposing changes.
3. Trace the stream or job surface involved with `rg` before assuming ownership boundaries.
4. Check existing tests around the same subsystem before changing behavior.

## Repo Working Rules

- Treat receipts and reducers as the durable behavior layer.
- Treat Resonate as the default execution control plane; treat receipts as the audit log and read-model unless the code path explicitly says otherwise.
- Treat services as adapters and side-effect coordinators, not the source of truth.
- Treat worktrees as disposable execution sandboxes, not orchestration state.
- Check `.receipt/config.json` before assuming current Factory policy defaults; the checked-in config can intentionally override module defaults like task concurrency.
- Prefer current code, tests, and receipts over old prompt assumptions.
- When behavior is unclear, inspect the owning module and the nearest smoke test together.

## What To Inspect

- `src/modules/` for reducers, state, and domain receipt meaning
- `src/services/` for orchestration, queueing, and side effects
- `src/agents/` for runtime/chat/UI wiring
- `src/views/` and `src/factory-cli/` for operator-facing projections
- `tests/smoke/` for expected behavior and compatibility coverage

## Validation

- Prefer targeted smoke tests for the changed subsystem.
- If a change affects stream semantics, queueing, or orchestration, validate with the nearest end-to-end Factory tests too.
- Summarize validation in terms of behavior proved, not just commands run.
