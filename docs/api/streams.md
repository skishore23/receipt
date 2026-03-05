# Streams and Receipt Model

Receipt persists append-only hash-linked receipts in per-stream JSONL files.

## Stream Families

### Agent Streams
- Index stream: `agents/<agentId>`
- Run stream: `agents/<agentId>/runs/<runId>`
- Branch stream: `agents/<agentId>/runs/<runId>/branches/<branchId>`
- Sub-run stream: `agents/<agentId>/runs/<runId>/sub/<subRunId>`

Examples:
- `agents/theorem`
- `agents/theorem/runs/run_abc123`
- `agents/theorem/runs/run_abc123/branches/resume_k9`
- `agents/theorem/runs/run_abc123/sub/run_abc123_sub_m1`

### Queue Streams
- Index stream: `jobs`
- Authoritative per-job stream: `jobs/<jobId>`

### Memory Streams
- `memory/<scope>`

### Improvement Stream
- `improvement`

### Inspector Stream
- `agents/inspector`

## Queue Lifecycle Receipts
Common job events:
- `job.enqueued`
- `job.leased`
- `job.heartbeat`
- `job.completed`
- `job.failed`
- `job.canceled`
- `job.lease_expired`
- `queue.command`
- `queue.command.consumed`

Queue commands:
- `steer`
- `follow_up`
- `abort`

Lanes:
- `collect`
- `steer`
- `follow_up`

Singleton modes:
- `allow`
- `cancel`
- `steer`

## Run and Replay Semantics
- State is derived by folding receipts, never by mutable snapshots.
- Branches preserve full causal history with `forkAt` metadata.
- Deterministic replay is based on:
  - receipt chain,
  - agent/workflow version,
  - policy versions.

## Storage Layout
- Data root: `DATA_DIR` (default `<cwd>/data`).
- Stream key registry: `_streams.json`.
- Branch metadata stream: `__meta/branches`.
- JSONL file naming uses hashed stream keys.

## Integrity Guarantees
- Receipt hash chain via `prev` linkage.
- Runtime supports idempotent event IDs and expected-prev checks.
- Corrupt JSONL records are surfaced as explicit errors.
