# SSE API

Receipt uses Server-Sent Events for live UI refresh and token streaming.

## Transport
- Protocol: SSE (`text/event-stream`).
- Headers: `Cache-Control: no-store`, `Connection: keep-alive`.
- Initial event: each subscription immediately receives `<topic>-refresh` with `data: init`.
- Keepalive: `event: ping` every 5 seconds.

## Topics and Event Names
- `agent` topic
  - refresh event: `agent-refresh`
  - token event: `agent-token`
- `receipt` topic (global)
  - refresh event: `receipt-refresh`
- `jobs` topic
  - refresh event: `job-refresh`
- `factory` topic
  - refresh event: `factory-refresh`

## Subscription Endpoints

### GET /factory/events
- Scope: multiplexed Factory chat subscription.
- Query params:
  - `profile`: active Factory profile id.
  - `chat`: optional saved chat session id.
  - `thread`: optional objective id.
  - `run`: optional run id used to scope related jobs.
  - `job`: optional selected job id.
- Subscriptions:
  - `agent:<stream>` for transcript refreshes and `agent-token` deltas.
  - `factory:<objectiveId>` when the current scope resolves to an objective.
  - `jobs:<jobId>` for the selected and related jobs in the current scope.
- Notes:
  - The Factory shell uses one manual `EventSource` and does not rely on HTMX SSE triggers.
  - `agent-token` is chat-only; sidebar and inspector should ignore it.
- Example:
```bash
curl -N 'http://localhost:8787/factory/events?profile=generalist&chat=chat_abc'
```

### GET /receipt/stream
- Query: none.
- Scope: global receipt channel (`receipt:*`).
- Example:
```bash
curl -N http://localhost:8787/receipt/stream
```

### GET /jobs/:id/events
- Query: none.
- Scope: jobs topic keyed by job id.
- Example:
```bash
curl -N http://localhost:8787/jobs/job_abc/events
```
