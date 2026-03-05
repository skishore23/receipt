# HTTP API Reference

Base URL: `http://localhost:8787` (or `PORT`).

## Conventions
- JSON APIs use `Content-Type: application/json`.
- Form routes use `Content-Type: application/x-www-form-urlencoded`.
- HTML routes return `text/html; charset=utf-8`.
- Error payloads are plain text unless explicitly documented as JSON.
- Most mutating routes publish SSE refresh events (`receipt`, `jobs`, `theorem`, `writer`, `agent`).

## Core Server APIs

### POST /agents/:id/jobs
- Purpose: Enqueue a job for any registered agent (`todo`, `writer`, `theorem`, `agent`, `inspector`).
- Query params: none.
- Body schema (JSON):
```json
{
  "jobId": "optional-id",
  "lane": "collect|steer|follow_up",
  "maxAttempts": 2,
  "sessionKey": "optional",
  "singletonMode": "allow|cancel|steer",
  "singleton": { "key": "optional", "mode": "allow|cancel|steer" },
  "payload": { "kind": "writer.run", "stream": "agents/writer", "runId": "run_...", "problem": "...", "config": {} }
}
```
- Success: `202` with `{ ok: true, job }`.
- Errors: `400` malformed JSON/invalid inspector source, `404` inspector source not found.
- Side effects: appends `job.enqueued` and publishes `job-refresh` + `receipt-refresh`.
- Example:
```bash
curl -sS -X POST http://localhost:8787/agents/writer/jobs \
  -H 'content-type: application/json' \
  -d '{"payload":{"kind":"writer.run","stream":"agents/writer","runId":"run_demo","problem":"Write release notes","config":{"maxParallel":2}}}'
```

### GET /jobs
- Purpose: List recent jobs from queue index projection.
- Query params: `status` (`queued|leased|running|completed|failed|canceled`), `limit` (`1..500`, default `50`).
- Body: none.
- Success: `200` with `{ jobs: QueueJob[] }`.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/jobs?status=running&limit=25'
```

### GET /jobs/:id
- Purpose: Fetch a single job snapshot.
- Query params: none.
- Body: none.
- Success: `200` with `QueueJob`.
- Errors: `404` when job is missing.
- Side effects: none.
- Example:
```bash
curl -sS http://localhost:8787/jobs/job_abc123
```

### GET /jobs/:id/wait
- Purpose: Long-poll until job reaches terminal state or timeout.
- Query params: `timeoutMs` (`0..120000`, default `15000`).
- Body: none.
- Success: `200` with terminal (or latest) `QueueJob`.
- Errors: `404` when job is missing.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/jobs/job_abc123/wait?timeoutMs=30000'
```

### GET /jobs/:id/events
- Purpose: SSE stream scoped to one job id.
- Query params: none.
- Body: none.
- Success: `200` SSE stream.
- Errors: none expected.
- Side effects: keeps an open subscription.
- Example:
```bash
curl -N http://localhost:8787/jobs/job_abc123/events
```

### POST /jobs/:id/steer
- Purpose: Queue a `steer` command for a job.
- Query params: none.
- Body schema (JSON): `{ "payload": { ... }, "by": "optional" }`.
- Success: `202` with `{ ok: true, command }`.
- Errors: `404` job not found.
- Side effects: appends `queue.command`, publishes jobs + receipt refresh.
- Example:
```bash
curl -sS -X POST http://localhost:8787/jobs/job_abc123/steer \
  -H 'content-type: application/json' \
  -d '{"payload":{"problem":"Retarget objective"},"by":"api"}'
```

### POST /jobs/:id/follow-up
- Purpose: Queue a `follow_up` command for a job.
- Query params: none.
- Body schema (JSON): `{ "payload": { "note": "..." }, "by": "optional" }`.
- Success: `202` with `{ ok: true, command }`.
- Errors: `404` job not found.
- Side effects: appends `queue.command`, publishes jobs + receipt refresh.
- Example:
```bash
curl -sS -X POST http://localhost:8787/jobs/job_abc123/follow-up \
  -H 'content-type: application/json' \
  -d '{"payload":{"note":"Please continue with migration plan"}}'
```

### POST /jobs/:id/abort
- Purpose: Request cancel of a queued/running job.
- Query params: none.
- Body schema (JSON): `{ "reason": "optional", "by": "optional" }`.
- Success: `202` with `{ ok: true, command }`.
- Errors: `404` job not found.
- Side effects: appends `queue.command` (and immediate cancel for queued jobs), publishes jobs + receipt refresh.
- Example:
```bash
curl -sS -X POST http://localhost:8787/jobs/job_abc123/abort \
  -H 'content-type: application/json' \
  -d '{"reason":"user requested stop"}'
```

### POST /memory/:scope/read
- Purpose: Read recent memory entries for a scope.
- Query params: none.
- Body schema (JSON): `{ "limit": 20 }` (optional).
- Success: `200` with `{ entries }`.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS -X POST http://localhost:8787/memory/release/read \
  -H 'content-type: application/json' \
  -d '{"limit":10}'
```

### POST /memory/:scope/search
- Purpose: Search memory by semantic/keyword query.
- Query params: none.
- Body schema (JSON): `{ "query": "...", "limit": 20 }`.
- Success: `200` with `{ entries }`.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS -X POST http://localhost:8787/memory/release/search \
  -H 'content-type: application/json' \
  -d '{"query":"queue behavior","limit":5}'
```

### POST /memory/:scope/summarize
- Purpose: Summarize scoped memory entries.
- Query params: none.
- Body schema (JSON): `{ "query": "optional", "limit": 20, "maxChars": 2400 }`.
- Success: `200` with `{ summary, entries }`.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS -X POST http://localhost:8787/memory/release/summarize \
  -H 'content-type: application/json' \
  -d '{"query":"inspector","maxChars":1200}'
```

### POST /memory/:scope/commit
- Purpose: Persist a new memory entry.
- Query params: none.
- Body schema (JSON): `{ "text": "...", "tags": ["a"], "meta": { "k": "v" } }`.
- Success: `201` with `{ entry }`.
- Errors: `400` when `text` is empty.
- Side effects: appends memory receipt and publishes `receipt-refresh`.
- Example:
```bash
curl -sS -X POST http://localhost:8787/memory/release/commit \
  -H 'content-type: application/json' \
  -d '{"text":"Need stricter review gate","tags":["ops"]}'
```

### POST /memory/:scope/diff
- Purpose: Read memory entries in a timestamp window.
- Query params: none.
- Body schema (JSON): `{ "fromTs": 1700000000000, "toTs": 1700000100000 }`.
- Success: `200` with `{ entries }`.
- Errors: `400` when `fromTs` missing/invalid.
- Side effects: none.
- Example:
```bash
curl -sS -X POST http://localhost:8787/memory/release/diff \
  -H 'content-type: application/json' \
  -d '{"fromTs":1700000000000}'
```

### POST /improvement/proposals
- Purpose: Create a self-improvement proposal artifact.
- Query params: none.
- Body schema (JSON):
```json
{
  "proposalId": "optional",
  "artifactType": "prompt_patch|policy_patch|harness_patch",
  "target": "path",
  "patch": "string payload",
  "createdBy": "optional"
}
```
- Success: `201` with `{ ok: true, proposalId }`.
- Errors: `400` missing/invalid fields.
- Side effects: emits `proposal.created`, publishes `receipt-refresh`.
- Example:
```bash
curl -sS -X POST http://localhost:8787/improvement/proposals \
  -H 'content-type: application/json' \
  -d '{"artifactType":"prompt_patch","target":"prompts/theorem.prompts.json","patch":"{\"note\":\"tighten guard\"}"}'
```

### POST /improvement/:id/validate
- Purpose: Run deterministic/static + command validation for a proposal.
- Query params: none.
- Body schema (JSON): `{ "validatedBy": "optional" }`.
- Success: `200` with `{ ok, proposalId, status, report, checks, requestedBy }`.
- Errors: `404` proposal missing.
- Side effects: emits `proposal.validated`, publishes `receipt-refresh`.
- Example:
```bash
curl -sS -X POST http://localhost:8787/improvement/proposal_abc/validate \
  -H 'content-type: application/json' \
  -d '{"validatedBy":"review-bot"}'
```

### POST /improvement/:id/approve
- Purpose: Mark a passed proposal approved.
- Query params: none.
- Body schema (JSON): `{ "approvedBy": "optional", "note": "optional" }`.
- Success: `200` with `{ ok: true, proposalId, status: "approved" }`.
- Errors: `404` missing proposal, `409` not in validated+passed state.
- Side effects: emits `proposal.approved`, publishes `receipt-refresh`.
- Example:
```bash
curl -sS -X POST http://localhost:8787/improvement/proposal_abc/approve \
  -H 'content-type: application/json' \
  -d '{"approvedBy":"maintainer"}'
```

### POST /improvement/:id/apply
- Purpose: Mark approved proposal applied.
- Query params: none.
- Body schema (JSON): `{ "appliedBy": "optional", "note": "optional" }`.
- Success: `200` with `{ ok: true, proposalId, status: "applied" }`.
- Errors: `404` missing proposal, `409` if not approved.
- Side effects: emits `proposal.applied`, publishes `receipt-refresh`.
- Example:
```bash
curl -sS -X POST http://localhost:8787/improvement/proposal_abc/apply \
  -H 'content-type: application/json' \
  -d '{}'
```

### POST /improvement/:id/revert
- Purpose: Mark applied proposal reverted.
- Query params: none.
- Body schema (JSON): `{ "revertedBy": "optional", "reason": "optional" }`.
- Success: `200` with `{ ok: true, proposalId, status: "reverted" }`.
- Errors: `404` missing proposal, `409` if proposal not applied.
- Side effects: emits `proposal.reverted`, publishes `receipt-refresh`.
- Example:
```bash
curl -sS -X POST http://localhost:8787/improvement/proposal_abc/revert \
  -H 'content-type: application/json' \
  -d '{"reason":"rollback"}'
```

### GET /improvement/:id
- Purpose: Fetch one proposal record.
- Query params: none.
- Body: none.
- Success: `200` with proposal object.
- Errors: `404` proposal missing.
- Side effects: none.
- Example:
```bash
curl -sS http://localhost:8787/improvement/proposal_abc
```

### GET /improvement
- Purpose: List all proposals sorted by `updatedAt` desc.
- Query params: none.
- Body: none.
- Success: `200` with `{ proposals }`.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS http://localhost:8787/improvement
```

## Todo Routes

### GET /
- Purpose: Todo shell HTML.
- Query params: `stream` (default `todo`).
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/?stream=todo'
```

### POST /cmd
- Purpose: Mutate todo stream (`add`, `toggle`, `delete`) via form.
- Query params: `stream` (default `todo`).
- Body schema (form):
  - add: `text=<value>`
  - toggle: `type=toggle&id=<todoId>`
  - delete: `type=delete&id=<todoId>`
- Success: `200` empty HTML with `HX-Trigger: refresh`.
- Errors: `400 bad` on invalid form/body.
- Side effects: emits todo command receipt and publishes `receipt-refresh`.
- Example:
```bash
curl -sS -X POST 'http://localhost:8787/cmd?stream=todo' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'text=ship+api+docs'
```

### GET /travel
- Purpose: Return full todo OOB travel HTML at selected cursor.
- Query params: `stream`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/travel?stream=todo&at=4'
```

### GET /island/state
- Purpose: Render todo state island.
- Query params: `stream`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/island/state?stream=todo'
```

### GET /island/timeline
- Purpose: Render todo timeline island.
- Query params: `stream`, `at`, `depth`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/island/timeline?stream=todo&depth=20'
```

### GET /island/time
- Purpose: Render todo time slider island.
- Query params: `stream`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/island/time?stream=todo'
```

### GET /island/verify
- Purpose: Render integrity verification island for current slice.
- Query params: `stream`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/island/verify?stream=todo'
```

### GET /island/branches
- Purpose: Render todo branch selector island.
- Query params: `stream`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/island/branches?stream=todo'
```

## Writer Routes

### GET /writer
- Purpose: Writer shell page.
- Query params: `stream`, `run`, `branch`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/writer?stream=agents/writer'
```

### POST /writer/run
- Purpose: Start/resume writer run and enqueue background job.
- Query params: `stream`, `run`, `branch`, `at`.
- Body schema (form): `problem` (required for new run), `append`, `parallel`.
- Success: `200` empty HTML with redirect header (`HX-Redirect`) to writer shell.
- Errors: `400 problem required`.
- Side effects: may fork branch receipts, enqueues writer job, publishes `jobs` + `receipt`.
- Example:
```bash
curl -sS -X POST 'http://localhost:8787/writer/run?stream=agents/writer' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'problem=Draft+announcement&parallel=2'
```

### GET /writer/island/folds
- Purpose: Writer left folds panel.
- Query params: `stream`, `run`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/writer/island/folds?stream=agents/writer'
```

### GET /writer/island/travel
- Purpose: Writer travel timeline island.
- Query params: `stream`, `run`, `branch`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/writer/island/travel?stream=agents/writer&run=run_demo'
```

### GET /writer/travel
- Purpose: Writer OOB travel refresh route.
- Query params: `stream`, `run`, `branch`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/writer/travel?stream=agents/writer&run=run_demo&at=3'
```

### GET /writer/island/chat
- Purpose: Writer chat transcript island.
- Query params: `stream`, `run`, `branch`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/writer/island/chat?stream=agents/writer&run=run_demo'
```

### GET /writer/island/side
- Purpose: Writer side diagnostics/metrics island.
- Query params: `stream`, `run`, `branch`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/writer/island/side?stream=agents/writer&run=run_demo'
```

### GET /writer/stream
- Purpose: SSE subscription for writer topic.
- Query params: `stream` (default `agents/writer`).
- Body: none.
- Success: `200` SSE stream.
- Errors: none expected.
- Side effects: open stream.
- Example:
```bash
curl -N 'http://localhost:8787/writer/stream?stream=agents/writer'
```

## Theorem Routes

### GET /theorem
- Purpose: Theorem shell page.
- Query params: `stream`, `run`, `branch`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/theorem?stream=agents/theorem'
```

### POST /theorem/run
- Purpose: Start/resume theorem run and enqueue background job.
- Query params: `stream`, `run`, `branch`, `at`.
- Body schema (form): `problem` (required for new run), `append`, `rounds`, `depth`, `memory`, `branch`.
- Success: `200` empty HTML with redirect header (`HX-Redirect`) to theorem shell.
- Errors: `400 problem required`.
- Side effects: may fork branches and append receipts, enqueues theorem job, publishes `jobs` + `receipt`.
- Example:
```bash
curl -sS -X POST 'http://localhost:8787/theorem/run?stream=agents/theorem' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'problem=Prove+claim&rounds=2&depth=2&memory=60&branch=2'
```

### GET /theorem/island/folds
- Purpose: Theorem folds panel.
- Query params: `stream`, `run`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/theorem/island/folds?stream=agents/theorem'
```

### GET /theorem/island/travel
- Purpose: Theorem travel timeline island.
- Query params: `stream`, `run`, `branch`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/theorem/island/travel?stream=agents/theorem&run=run_demo'
```

### GET /theorem/travel
- Purpose: Theorem OOB travel refresh route.
- Query params: `stream`, `run`, `branch`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/theorem/travel?stream=agents/theorem&run=run_demo&at=5'
```

### GET /theorem/island/chat
- Purpose: Theorem run chat island.
- Query params: `stream`, `run`, `branch`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/theorem/island/chat?stream=agents/theorem&run=run_demo'
```

### GET /theorem/island/side
- Purpose: Theorem diagnostics/metrics island.
- Query params: `stream`, `run`, `branch`, `at`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/theorem/island/side?stream=agents/theorem&run=run_demo'
```

### GET /theorem/stream
- Purpose: SSE subscription for theorem topic.
- Query params: `stream` (default `agents/theorem`).
- Body: none.
- Success: `200` SSE stream.
- Errors: none expected.
- Side effects: open stream.
- Example:
```bash
curl -N 'http://localhost:8787/theorem/stream?stream=agents/theorem'
```

## Monitor Routes

### GET /monitor
- Purpose: Command Center shell page.
- Query params: `stream` (default `agents/agent`), `run`, `job`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/monitor?stream=agents/agent'
```

### POST /monitor/run
- Purpose: Enqueue a monitor/agent run from UI form.
- Query params: `stream` (default `agents/agent`).
- Body schema (form): `problem` (required), optional agent config fields (`maxIterations`, `maxToolOutputChars`, `memoryScope`, `workspace`).
- Success: `303` redirect response with `HX-Redirect`.
- Errors: `400 problem required`.
- Side effects: enqueues `agent.run` job and publishes `jobs`, `agent`, `receipt` refresh events.
- Example:
```bash
curl -i -X POST 'http://localhost:8787/monitor/run?stream=agents/agent' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'problem=Review+open+issues&maxIterations=3'
```

### POST /monitor/job/:id/steer
- Purpose: Queue steer command for selected monitor job.
- Query params: `stream`, `run`, `job`.
- Body schema (form): `problem` and/or `config` (JSON object string).
- Success: `202` plain text when `X-Requested-With: fetch`, otherwise `303` redirect.
- Errors: `400` invalid payload/config, `404` job missing.
- Side effects: queues `steer` command and publishes `jobs`, `agent`, `receipt`.
- Example:
```bash
curl -sS -X POST 'http://localhost:8787/monitor/job/job_abc/steer?stream=agents/agent' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H 'X-Requested-With: fetch' \
  -d 'problem=Narrow+scope'
```

### POST /monitor/job/:id/follow-up
- Purpose: Queue follow-up note command.
- Query params: `stream`, `run`, `job`.
- Body schema (form): `note` (required).
- Success: `202` plain text when fetch-mode, otherwise redirect.
- Errors: `400 note required`, `404 job not found`.
- Side effects: queues `follow_up` command and publishes `jobs`, `agent`, `receipt`.
- Example:
```bash
curl -sS -X POST 'http://localhost:8787/monitor/job/job_abc/follow-up?stream=agents/agent' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H 'X-Requested-With: fetch' \
  -d 'note=Add+acceptance+criteria'
```

### POST /monitor/job/:id/abort
- Purpose: Queue abort command for monitor job.
- Query params: `stream`, `run`, `job`.
- Body schema (form): `reason` (optional).
- Success: `202` plain text when fetch-mode, otherwise redirect.
- Errors: `404 job not found`.
- Side effects: queues `abort` command and publishes `jobs`, `agent`, `receipt`.
- Example:
```bash
curl -sS -X POST 'http://localhost:8787/monitor/job/job_abc/abort?stream=agents/agent' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H 'X-Requested-With: fetch' \
  -d 'reason=user+cancel'
```

### GET /monitor/island/log
- Purpose: Monitor run log island for selected run.
- Query params: `stream`, `run`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/monitor/island/log?stream=agents/agent&run=run_demo'
```

### GET /monitor/island/jobs
- Purpose: Monitor job table island.
- Query params: `job` (selected id).
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/monitor/island/jobs?job=job_abc'
```

### GET /monitor/island/job
- Purpose: Monitor job detail island.
- Query params: `stream`, `run`, `job`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected (`not found` rendered in HTML).
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/monitor/island/job?stream=agents/agent&job=job_abc'
```

### GET /monitor/island/agents
- Purpose: Monitor agent health/activity island.
- Query params: none.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/monitor/island/agents'
```

### GET /monitor/island/activity
- Purpose: Monitor global activity feed island.
- Query params: `stream` (optional filter).
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/monitor/island/activity?stream=agents/agent'
```

### GET /monitor/island/memory
- Purpose: Monitor memory search island.
- Query params: `scope` (default `agent`), `query` (optional).
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/monitor/island/memory?scope=agent&query=delegate'
```

### GET /monitor/stream
- Purpose: SSE subscription for monitor/agent topic.
- Query params: `stream` (default `agents/agent`).
- Body: none.
- Success: `200` SSE stream.
- Errors: none expected.
- Side effects: open stream.
- Example:
```bash
curl -N 'http://localhost:8787/monitor/stream?stream=agents/agent'
```

## Receipt Inspector Routes

### GET /receipt
- Purpose: Receipt Inspector shell page.
- Query params: `file`, `order`, `limit`, `depth`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/receipt'
```

### POST /receipt/inspect
- Purpose: Queue inspector team jobs for a selected JSONL receipt file.
- Query params: none.
- Body schema (form): `file` (required), `order`, `limit`, `depth`, `question`.
- Success: `200` empty HTML with `HX-Trigger: receipt-refresh`.
- Errors: `400 file required`, `404 file not found`.
- Side effects: enqueues inspector jobs, publishes `jobs` + `receipt`.
- Example:
```bash
curl -sS -X POST http://localhost:8787/receipt/inspect \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'file=fixture-inspector.jsonl&question=Summarize+failures&order=desc&limit=200&depth=2'
```

### GET /receipt/island/folds
- Purpose: Receipt file list/folds island.
- Query params: `selected`, `order`, `limit`, `depth`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/receipt/island/folds?selected=fixture-inspector.jsonl'
```

### GET /receipt/island/chat
- Purpose: Inspector conversation island for selected file.
- Query params: `file`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/receipt/island/chat?file=fixture-inspector.jsonl'
```

### GET /receipt/island/side
- Purpose: Inspector side panel with context, timeline, tool stats.
- Query params: `file`, `order`, `limit`, `depth`.
- Body: none.
- Success: `200` HTML.
- Errors: none expected (missing file rendered as failed snapshot).
- Side effects: none.
- Example:
```bash
curl -sS 'http://localhost:8787/receipt/island/side?file=fixture-inspector.jsonl&order=desc&limit=200&depth=2'
```

### GET /receipt/stream
- Purpose: SSE subscription for receipt topic (global).
- Query params: none.
- Body: none.
- Success: `200` SSE stream.
- Errors: none expected.
- Side effects: open stream.
- Example:
```bash
curl -N http://localhost:8787/receipt/stream
```
