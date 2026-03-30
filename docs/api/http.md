# HTTP API Reference

Base URL: `http://localhost:8787` (or `PORT`).

## Conventions
- JSON APIs use `Content-Type: application/json`.
- Form routes use `Content-Type: application/x-www-form-urlencoded`.
- HTML routes return `text/html; charset=utf-8`.
- Error payloads are plain text unless explicitly documented as JSON.
- Most mutating routes publish SSE refresh events (`receipt`, `jobs`, `agent`).

## Core Server APIs

### GET /healthz
- Purpose: Return a lightweight runtime health snapshot for the current process.
- Query params: none.
- Body: none.
- Success: `200` with `{ ok, uptimeSec, dataDir, jobBackend, processRole, queue, codexBin, resonateUrl }`.
- Errors: none expected.
- Side effects: none.
- Example:
```bash
curl -sS http://localhost:8787/healthz
```

### POST /agents/:id/jobs
- Purpose: Enqueue a job for any registered agent (`agent`, `factory`, `codex`).
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
  "payload": { "kind": "agent.run", "stream": "agents/agent", "runId": "run_...", "problem": "...", "config": {} }
}
```
- Success: `202` with `{ ok: true, job }`.
- Errors: `400` malformed JSON.
- Side effects: appends `job.enqueued` and publishes `job-refresh` + `receipt-refresh`.
- Example:
```bash
curl -sS -X POST http://localhost:8787/agents/agent/jobs \
  -H 'content-type: application/json' \
  -d '{"payload":{"kind":"agent.run","stream":"agents/agent","runId":"run_demo","problem":"Review open issues","config":{"maxIterations":3}}}'
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

## Factory Web Surface

Factory operator mutations are CLI-first. The `/factory` pages still use `POST /factory/compose` for browser chat submissions, while objective lifecycle operations remain CLI-first.

Use the CLI for mutations:

- `receipt factory run|create|compose|react|promote|cancel|cleanup|archive`
- `receipt factory steer|follow-up|abort-job`

Factory HTTP routes that remain supported:

- `GET /factory`
- `GET /factory/workbench` redirect to `/factory`
- `GET /factory/control` redirect to `/factory`
- `POST /factory/compose`
- `GET /factory/island/*`
- `GET /factory/events`
- `GET /factory/chat/events`
- `GET /factory/background/events`
- `GET /factory/api/workbench-shell`
- `GET /factory/api/objectives`
- `GET /factory/api/objectives/:id`
- `GET /factory/api/objectives/:id/debug`
- `GET /factory/api/objectives/:id/receipts`
- `GET /factory/api/live-output`

`POST /factory/compose` accepts browser composer submissions. When the request includes `Accept: application/json`, success responses return `{ location, live? }`, where `live` carries the immediate shell handoff scope (`profileId`, `chatId`, `objectiveId?`, `runId`, `jobId`).

### POST /memory/:scope/read
- Purpose: Read recent memory entries for a scope.
- Query params: none.
- Body schema (JSON): `{ "limit": 20 }` (optional).
- Success: `200` with `{ entries }`.
- Errors: none expected.
- Side effects: appends an audited `memory.accessed` receipt for the scope.
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
- Side effects: appends an audited `memory.accessed` receipt for the scope.
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
- Side effects: appends an audited `memory.accessed` receipt for the scope.
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
- Side effects: appends an audited `memory.accessed` receipt for the scope.
- Example:
```bash
curl -sS -X POST http://localhost:8787/memory/release/diff \
  -H 'content-type: application/json' \
  -d '{"fromTs":1700000000000}'
```

## Static Assets

### GET /assets/:file
- Purpose: Serve static front-end assets (CSS, JS) from the built asset directory.
- Query params: none.
- Body: none.
- Success: `200` with the file contents and appropriate `Content-Type`.
- Errors: `400` invalid path, `404` asset not found.
- Side effects: none.
- Example:
```bash
curl -sS http://localhost:8787/assets/factory.css
```
