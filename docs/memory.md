# Receipt Memory

Status: Current implementation notes  
Audience: Engineering  
Scope: How memory is stored, retrieved, summarized, and used across Receipt, chat, and Factory

## Executive Summary

Receipt memory is not a separate mutable database with its own truth model.

It is a receipt-backed durability layer built on top of the same append-only runtime used elsewhere in the repo:

- writes append memory receipts
- reads and summaries are derived from those receipts
- SQLite tables exist as projections and indexes, not as an independent authority

The practical model is:

- use receipts for raw event history
- use memory scopes for durable facts and bounded summaries
- use session history projections for transcript recall
- use Factory memory packets and scripts to give workers bounded, scoped recall instead of raw dumps

## Where Memory Lives

Memory has three concrete layers in the current implementation.

### 1. Receipt streams

Logical memory scope `foo/bar` is written to a runtime stream under:

```text
memory/<safe-scope>
```

The scope is normalized for the stream name, but the original scope string is stored on each memory entry.

Core implementation: `src/adapters/memory-tools.ts`

### 2. SQLite projections

The runtime also projects memory into SQLite tables:

- `memory_entries`
- `memory_accesses`

Schema: `src/db/schema.ts`

These tables make memory fast to query, but they are still derived from receipt activity.

### 3. Optional embedding cache

When embeddings are enabled, memory search stores vectors in per-scope cache files under:

```text
SQLite table: `memory_embeddings`
```

This cache accelerates semantic retrieval. It is not the source of truth.

## Memory Data Model

### Memory entry

A memory entry contains:

- `id`
- `scope`
- `text`
- optional `tags`
- optional `meta`
- `ts`

### Memory access record

Every read-like operation also records an access entry with fields such as:

- `operation`
- `strategy`
- `query`
- `limit`
- `fromTs` and `toTs`
- `resultCount`
- `resultIds`
- `summaryChars`
- optional audit `meta`
- `ts`

This is important operationally: retrieval is observable, not hidden.

## Memory Events

The current event model is:

- `memory.committed`
- `memory.accessed`
- `memory.forgotten`

The meaning is:

- `memory.committed`: a new durable memory entry was appended
- `memory.accessed`: a read, search, summarize, diff, or reindex operation occurred
- `memory.forgotten`: an existing entry was removed from the active projection

Implementation: `src/adapters/memory-tools.ts`

## Supported Operations

The memory adapter exposes six operations:

- `read`
- `search`
- `summarize`
- `commit`
- `diff`
- `reindex`

Their current behavior is:

### `read`

Returns the newest entries for a scope in descending timestamp order.

Access strategy recorded:

```text
recent
```

### `search`

Searches a scope by query.

Behavior depends on whether the runtime was configured with embeddings:

- with embeddings: semantic search
- without embeddings: keyword matching

Access strategy recorded:

- `semantic` when embeddings are enabled
- `keyword` otherwise

### `summarize`

Builds a bounded text summary from matching memory entries.

Behavior:

- with `query`: uses semantic or keyword retrieval first, then summarizes
- without `query`: summarizes recent entries directly

### `commit`

Appends a new durable entry for a scope.

This is additive. It does not mutate older entries in place.

### `diff`

Returns entries in a time window:

```text
fromTs <= entry.ts <= toTs
```

### `reindex`

Rebuilds the embedding cache for a scope when embeddings are enabled.

This affects retrieval acceleration only. It does not change logical memory contents.

## Search Behavior And `OPENAI_API_KEY`

In the repo's CLI, server, and Factory runtime wiring, memory search becomes semantic when an embedding function is configured. In normal local usage, that means semantic retrieval is enabled when `OPENAI_API_KEY` is present.

Current wiring:

- CLI: `src/cli/runtime.ts`
- Server: `src/server/bootstrap.ts`
- Factory runtime: `src/services/factory-runtime.ts`

The important consequence is:

- semantic search can return near matches, not only exact term matches
- keyword fallback requires literal term overlap across the query terms

So if `OPENAI_API_KEY` is present, this command:

```bash
bun src/cli.ts memory search demo/scope --query "updated durable" --limit 5
```

may return the exact hit first and then additional semantically related entries after it.

If exact literal matching matters more than semantic recall, use one of these instead:

- `memory read`
- `memory diff`
- a narrower scope
- a runtime without embeddings enabled

## Update Semantics

Memory is append-oriented.

There is no generic in-place update operation for arbitrary memory entries.

To change durable state, the current design expects one of these patterns:

- append a new entry that supersedes an older one
- forget a specific entry where removal is supported

In the current user-facing CLI, explicit removal is exposed for preference memory:

```bash
bun src/cli.ts memory prefs remove <entry-id> --scope repo
```

That emits `memory.forgotten` and removes the entry from the active SQLite projection.

This is deliberate: durable history stays receipt-native, and "update" is modeled as new evidence or an explicit forget event, not row mutation.

## Conversation Memory

The newer conversation-memory path is implemented in:

- `src/services/conversation-memory.ts`
- `src/services/session-history.ts`

It combines two different sources:

### 1. Durable user preferences

Preferences are stored in shared scopes, not in chat-local memory.

Current scope layout:

- global preferences: `users/default/preferences`
- repo preferences: `repos/<repoKey>/users/default/preferences`
- global profile conventions: `users/default/profile`
- repo profile conventions: `repos/<repoKey>/users/default/profile`

These are used to build the preference block injected into prompts and returned by CLI and API surfaces.

### 2. Session recall

Session recall does not come from memory scopes.

It comes from projected chat/session history in SQLite:

- `chat_context_projection`
- `session_messages`
- `session_messages_fts`

That path powers:

- recent session readback
- transcript search
- prompt recall for older repo/profile chat history

So "conversation memory" in Receipt is a composition:

- durable preferences from memory scopes
- transcript recall from session-history projections

## Factory Memory

Factory uses memory as bounded durable recall, not as an unstructured transcript dump.

### Factory scope layout

Task packets currently build layered memory scopes such as:

- `factory/agents/<workerType>`
- `factory/repo/shared`
- `factory/objectives/<objectiveId>`
- `factory/objectives/<objectiveId>/tasks/<taskId>`
- `factory/objectives/<objectiveId>/candidates/<candidateId>`
- `factory/objectives/<objectiveId>/integration`

Factory also uses controller-side audit scopes for self-improvement and cross-run review:

- `factory/audits/objectives/<objectiveId>`
- `factory/audits/repo`

Scope builder: `src/services/factory/task-packets.ts`

### Read-only vs writable scopes

The worker packet marks some scopes as read-only:

- agent memory
- repo shared memory

Workers are expected to commit to scoped task/objective/candidate/integration memory instead of modifying shared global context.
Audit scopes are controller-facing review memory, not task-worktree write targets.

### Memory script

Factory task packets ship:

- `*.context.md`
- `*.receipt-cli.md`
- `*.memory-scopes.json`
- `*.memory.cjs`

The generated memory script gives workers bounded commands like:

- `context`
- `objective`
- `overview`
- `scope`
- `search`
- `read`
- `commit`

Implementation: `src/services/factory-codex-artifacts.ts`

Workers are expected to start with the text-first task context summary and bounded receipt CLI surface, then use the memory script for deeper scoped recall and durable note commits.

The `context` command reads the current context summary plus the recursive context pack. `objective` reads the objective slice from the context pack. `overview`, `scope`, `search`, `read`, and `commit` shell out through `receipt memory ...`.

So the memory script is the main deeper worker-facing memory interface in Factory. It lets the worker inspect scoped summaries and commit durable notes without pulling large raw memory dumps.

### Factory memory commits

Factory writes durable notes into multiple scopes depending on the phase:

- task completion writes to objective, task, and candidate scopes
- integration writes to objective and integration scopes
- publish writes to objective, integration, and publish scopes
- investigation synthesis writes a sectioned report to the objective scope

Implementation: `src/services/factory/memory/store.ts`

## CLI Surface

Current CLI commands:

```bash
# generic memory
bun src/cli.ts memory read <scope> --limit 5
bun src/cli.ts memory search <scope> --query "text" --limit 6
bun src/cli.ts memory summarize <scope> --query "text" --max-chars 1200
bun src/cli.ts memory commit <scope> --text "durable note" --tags alpha,beta
bun src/cli.ts memory diff <scope> --from-ts 1710000000000

# user preferences
bun src/cli.ts memory prefs list --scope layered
bun src/cli.ts memory prefs add --scope repo --text "Keep answers concise."
bun src/cli.ts memory prefs remove <entry-id> --scope repo

# session recall
bun src/cli.ts sessions search --query "postgres staging port"
bun src/cli.ts sessions read <chat-id>
```

CLI command implementation: `src/cli/commands.ts`

## HTTP And Agent Surfaces

Memory is also exposed through:

- HTTP endpoints under `/memory/*`
- agent capabilities:
  - `memory.read`
  - `memory.search`
  - `memory.summarize`
  - `memory.commit`
  - `memory.diff`
- session capabilities:
  - `session.search`
  - `session.read`

Relevant code:

- `docs/api/http.md`
- `src/agents/capabilities-core.ts`
- `src/agents/factory/route/register-factory-api-routes.ts`

## Operational Expectations

If memory is working correctly today, these invariants should hold:

- committing memory appends `memory.committed` and projects a new `memory_entries` row
- reading, searching, summarizing, diffing, and reindexing append `memory.accessed`
- forgetting appends `memory.forgotten` and removes the entry from the active projection
- DST can replay `memory/*` streams deterministically when they are not changing during the audit window
- conversation preference recall is driven by shared scopes, not chat-local notes
- session recall is driven by `session_messages` projections, not by memory scopes

For stream-level verification:

```bash
bun src/cli.ts dst memory/ --json --strict
```

Focused tests in the repo:

- `tests/smoke/memory-tools.test.ts`
- `tests/smoke/cli-memory-sessions.test.ts`
- `tests/smoke/conversation-memory-centralization.test.ts`
- `tests/smoke/factory-memory.test.ts`
- `tests/smoke/receipt-dst.test.ts`

## Mental Model To Keep

Use this rule of thumb:

- receipts are the raw durable evidence
- memory scopes are the durable summary layer
- session history is transcript recall
- Factory packets turn memory into bounded worker-facing context

Receipt memory works best when treated as scoped, append-only, replayable context, not as a mutable document store.
