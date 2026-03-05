# SSE API

Receipt uses Server-Sent Events for live UI refresh and token streaming.

## Transport
- Protocol: SSE (`text/event-stream`).
- Headers: `Cache-Control: no-store`, `Connection: keep-alive`.
- Initial event: each subscription immediately receives `<topic>-refresh` with `data: init`.
- Keepalive: `event: ping` every 15 seconds.

## Topics and Event Names
- `theorem` topic
  - refresh event: `theorem-refresh`
  - token event: `theorem-token` (JSON `{ runId, delta }`)
- `writer` topic
  - refresh event: `writer-refresh`
  - token event: `writer-token` (JSON `{ runId, delta }`)
- `agent` topic
  - refresh event: `agent-refresh`
  - token event: `agent-token` (JSON `{ runId, delta }`)
- `receipt` topic (global)
  - refresh event: `receipt-refresh`
  - token event: `receipt-token` (JSON `{ groupId, runId, agentId, file, delta }`)
- `jobs` topic
  - refresh event: `job-refresh`

## Subscription Endpoints

### GET /theorem/stream
- Query: `stream` (default `agents/theorem`).
- Scope: theorem topic + stream-specific channel.
- Example:
```bash
curl -N 'http://localhost:8787/theorem/stream?stream=agents/theorem'
```

### GET /writer/stream
- Query: `stream` (default `agents/writer`).
- Scope: writer topic + stream-specific channel.
- Example:
```bash
curl -N 'http://localhost:8787/writer/stream?stream=agents/writer'
```

### GET /monitor/stream
- Query: `stream` (default `agents/agent`).
- Scope: agent topic + stream-specific channel.
- Example:
```bash
curl -N 'http://localhost:8787/monitor/stream?stream=agents/agent'
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
