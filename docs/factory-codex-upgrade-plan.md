# Factory Codex Upgrade Plan

Status: Partially implemented; retained as an upgrade/history note  
Audience: Engineering  
Decision date: 2026-03-25  
Scope: Reliability, observability, execution isolation, and operator UX for long-running Factory and Codex work

Note: As of 2026-03-26, the broad AWS `danger-full-access` default and the executor's sandbox bootstrap auto-escalation have been removed. Some "current behavior" bullets below describe the pre-change system and remain as historical context for the rest of the plan.

## Why This Plan Exists

Factory is now using Codex in the right general way:

- `codex exec` is the execution boundary
- repo-specific guidance is provided through `AGENTS.md` and checked-in skills
- direct probes are read-only
- objective work runs through receipts, queueing, and worktrees

The remaining problems are operational:

- a job can still look `running` when the useful work is stalled
- task status is inferred from files and process state more than from structured Codex events
- AWS investigation work defaults to `danger-full-access`
- operator follow-ups do not always mutate the active objective immediately
- some objectives are still too broad for predictable Codex execution

This document turns those gaps into a concrete upgrade sequence.

## Current Seams In Code

### Codex execution

- `src/adapters/codex-executor.ts`
- Current behavior:
  - launches `codex exec -a never`
  - captures `stdout`, `stderr`, and `--output-last-message`
  - optionally writes `--output-schema`
  - has timeout and stall watchdog logic
- Current gap:
  - does not consume `codex exec --json`
  - job state is still inferred from process/files instead of event stream truth

### Queue and lease lifecycle

- `src/adapters/jsonl-queue.ts`
- Current behavior:
  - queue jobs, lease them, heartbeat them, expire leases
  - refresh can now reap expired leases even without a new lease request
- Current gap:
  - there is no first-class stalled-job state or policy-driven recovery path above raw lease expiry

### Factory objective orchestration

- `src/services/factory-service.ts`
- Current behavior:
  - plans objectives, dispatches tasks, runs Codex workers, reacts to receipts
  - AWS investigations default to `danger-full-access`
- Current gap:
  - sandbox choice is too broad
  - large investigations are not consistently decomposed into tighter tasks
  - follow-up guidance is not always applied as an immediate objective mutation

### Factory chat and operator UX

- `src/agents/factory-chat.ts`
- `src/views/factory-chat.ts`
- Current behavior:
  - queues direct Codex probes
  - shows live job snapshots and tails
- Current gap:
  - UI state semantics do not cleanly distinguish `running`, `stalled`, `continued`, `superseded`, and `blocked`
  - some follow-ups become read-only observation first, not immediate reruns

## Priorities

## P0: Make Run State Truthful And Recoverable

### 1. Move Codex runtime ingestion to `--json`

Goal:

- stop inferring run state from partial logs when Codex already emits structured events

Files:

- `src/adapters/codex-executor.ts`
- `src/agents/factory-chat.ts`
- `src/views/factory-chat.ts`
- `tests/smoke/codex-executor.test.ts`
- `tests/smoke/factory-chat-runner.test.ts`

Implementation:

- add a JSON mode to `CodexExecutor.run(...)`
- run `codex exec --json` for Factory-managed executions
- parse JSONL events into:
  - run lifecycle
  - item lifecycle
  - final usage tokens
  - tool execution progress
  - turn completion vs turn failure
- keep `--output-last-message` for the final answer file
- preserve plain `stdout` and `stderr` capture for debugging, but stop relying on them as the main status channel

Acceptance:

- UI token counts come from `turn.completed.usage`
- live jobs show the latest Codex item/event, not only file tails
- a Codex turn failure is visible without scraping error text

### 2. Add a first-class stalled-job state machine

Goal:

- prevent jobs from appearing live forever after useful execution has stopped

Files:

- `src/adapters/jsonl-queue.ts`
- `src/services/factory-service.ts`
- `src/views/factory-chat.ts`
- `tests/smoke/jsonl-queue.test.ts`
- `tests/smoke/factory-orchestration.test.ts`

Implementation:

- add explicit stalled detection at the controller level, not only inside the child executor
- introduce a first-class `stalled` status or equivalent projection state
- distinguish:
  - child process alive but no event progress
  - lease expired
  - abort requested
  - superseded by a newer task/run
- add bounded recovery policy:
  - mark stalled
  - append a receipt
  - retry or react once when policy allows
  - stop retry loops after the configured cap

Acceptance:

- no Factory objective can remain `running` indefinitely without fresh queue or Codex progress
- restart/replay leaves stale jobs in a truthful state

### 3. Replace broad `danger-full-access` defaults for live cloud work

Goal:

- keep live cloud investigations working without granting the broadest host permissions by default

Files:

- `src/services/factory-service.ts`
- `src/adapters/codex-executor.ts`
- `docs/factory-agent-orchestration.md`
- `tests/smoke/factory-investigation.test.ts`

Implementation:

- remove the blanket AWS-investigation mapping in `sandboxModeForTask(...)`
- replace it with an explicit execution policy model, for example:
  - `read-only`
  - `workspace-write`
  - `cloud-live`
- keep `cloud-live` behind an isolated runner contract
- make policy selection explicit in the task packet and receipts

Acceptance:

- standard host-local tasks no longer silently escalate to `danger-full-access`
- live AWS work still has the required credentials and network access through a defined execution mode

## P1: Improve Task Shaping And Operator Control

### 4. Make follow-ups mutate the active objective immediately when appropriate

Goal:

- if the operator clearly intends to redirect the current objective, do not spend a round on read-only diagnosis first

Files:

- `src/agents/factory-chat.ts`
- `src/services/factory-service.ts`
- `tests/smoke/factory-chat-runner.test.ts`
- `tests/smoke/factory-orchestration.test.ts`

Implementation:

- detect follow-ups that are objective mutations rather than observation requests
- route them to objective reaction first
- only use read-only Codex inspection when the request is genuinely diagnostic

Acceptance:

- a rerun or narrowing instruction on an active objective produces an objective note/react path immediately
- operators do not have to wait through a separate chat-only probe before work restarts

### 5. Decompose broad investigations into smaller bounded tasks

Goal:

- keep Codex operating on well-scoped work rather than open-ended “scan everything” prompts

Files:

- `src/services/factory-service.ts`
- `src/agents/orchestrator.ts`
- `tests/smoke/factory-investigation.test.ts`
- `tests/smoke/factory-policy.test.ts`

Implementation:

- add decomposition heuristics for broad infra asks
- prefer service-bounded or evidence-bounded tasks
- allow follow-up tasks for synthesis instead of forcing one task to scan all surfaces
- cap per-task breadth and expected runtime

Acceptance:

- large infra prompts split into narrower tasks such as discovery, path analysis, and risk ranking
- task prompts become hour-scale, not repo-scale or account-scale whenever possible

### 6. Continue moving context from prose into structure

Goal:

- let Codex reason from explicit helper/task metadata instead of long policy prose

Files:

- `src/services/factory-helper-catalog.ts`
- `src/services/factory-codex-artifacts.ts`
- `skills/factory-helper-runtime/catalog/**/manifest.json`
- `tests/smoke/factory-context-skill.test.ts`
- `tests/smoke/factory-investigation.test.ts`

Implementation:

- keep expanding helper metadata:
  - `requiredArgs`
  - `requiredContext`
  - input validation semantics
  - evidence shape
  - known failure classes
- add task-level structured execution hints:
  - expected artifacts
  - bounded region/service scope
  - acceptable fallback behavior
- reduce prompt prose that tries to force exact model behavior

Acceptance:

- Codex can identify missing context and recover without fabricating placeholders
- prompts get shorter while packet structure gets richer

## P2: Clarify UI And Strengthen Regression Coverage

### 7. Make live status semantics visible to operators

Goal:

- match the UI language to the real lifecycle of long-running work

Files:

- `src/views/factory-chat.ts`
- any related projection/view helpers used by the Factory UI

Implementation:

- add distinct badges or labels for:
  - `running`
  - `stalled`
  - `continued`
  - `superseded`
  - `blocked`
- show why the state changed using the latest receipt or queue event

Acceptance:

- operators can tell the difference between active progress, silent stall, and auto-continuation

### 8. Add critical-path reliability tests for 24x7 operation

Goal:

- cover the paths most likely to leave work in misleading or indefinite states

Files:

- `tests/smoke/codex-executor.test.ts`
- `tests/smoke/jsonl-queue.test.ts`
- `tests/smoke/factory-orchestration.test.ts`
- `tests/smoke/factory-chat-runner.test.ts`
- `tests/smoke/factory-investigation.test.ts`

Add scenarios for:

- Codex child emits no progress after bootstrap
- queue lease expires during controller quiet period
- restart while an objective is marked active
- follow-up redirects an in-flight objective
- objective auto-continues into another run
- child process exits after writing structured output but before clean shutdown

Acceptance:

- every historical stuck or ambiguous state gets a deterministic test

### 9. Trim and localize instruction surface

Goal:

- keep Codex context high-signal and closer to the work

Files:

- `AGENTS.md`
- `skills/**`
- selected subtree `AGENTS.md` files if needed

Implementation:

- keep root instructions short and durable
- move narrow rules into subtree `AGENTS.md` or checked-in skills
- prefer structured packet data over repeated prompt narration

Acceptance:

- less prompt overhead
- fewer duplicated instructions across runtime surfaces

## Delivery Sequence

Recommended order:

1. `--json` Codex event ingestion
2. controller-level stalled-job state and recovery
3. explicit execution policy replacing blanket `danger-full-access`
4. immediate follow-up-to-objective mutation path
5. investigation decomposition improvements
6. UI state cleanup
7. expanded regression coverage
8. instruction-surface cleanup

## What To Avoid

- do not try to “force” Codex into a brittle exact workflow through prompt prose
- do not rely on host-local `danger-full-access` as the normal solution for cloud work
- do not add retry loops without explicit stop conditions and receipts
- do not let UI statuses collapse distinct states into one generic `running`

## Near-Term Success Criteria

The system is materially healthier when all of the following are true:

- a stalled Codex run becomes visibly `stalled` or `failed`, not indefinitely `running`
- token usage and progress come from structured Codex events
- live cloud work uses an explicit execution policy, not blanket host escalation
- operator follow-ups redirect active work immediately when that intent is clear
- broad investigations are decomposed into smaller bounded tasks
