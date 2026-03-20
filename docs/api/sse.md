# SSE API

Receipt uses Server-Sent Events for live UI refresh and token streaming.

## Transport
- Protocol: SSE (`text/event-stream`).
- Headers: `Cache-Control: no-store`, `Connection: keep-alive`.
- Initial event: each subscription immediately receives `<topic>-refresh` with `data: init`.
- Keepalive: `event: ping` every 15 seconds.

## Topics and Event Names
- `agent` topic
  - refresh event: `agent-refresh`
- `receipt` topic (global)
  - refresh event: `receipt-refresh`
- `jobs` topic
  - refresh event: `job-refresh`
- `factory` topic
  - refresh event: `factory-refresh`

## Subscription Endpoints

### GET /factory/events
- Scope: factory topic + objective-scoped channel.
- Example:
```bash
curl -N 'http://localhost:8787/factory/events?objective=obj_abc'
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
