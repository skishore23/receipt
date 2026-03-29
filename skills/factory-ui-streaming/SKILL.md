---
name: factory-ui-streaming
description: Use when changing Receipt Factory live UI streaming, HTMX SSE bindings, scoped refresh behavior, or the browser/client smoke tests that cover `/factory/events`, chat streaming fragments, and inline shell hydration.
---

# Factory UI Streaming

Use this skill for Factory chat live-update bugs, stale scope issues, HTMX SSE migrations, or when `/factory/events` behavior and the browser shell drift out of sync.

## First Files

Inspect these first:

1. `src/views/factory-chat.ts`
2. `src/client/factory-client/chat.ts`
3. `src/agents/factory/route.ts`
4. `src/server.ts`
5. `tests/smoke/factory-client.test.ts`
6. `tests/smoke/factory.test.ts`
7. `tests/smoke/build.test.ts`

## Live Contract

- The live shell root is `#factory-live-root`.
- The browser connects with HTMX SSE through `hx-ext="sse"` and `sse-connect="/factory/events..."`.
- Chat refresh is declarative on `#factory-chat` through `hx-trigger="sse:agent-refresh ..., sse:job-refresh ..., sse:factory-refresh ..."`.
- Sidebar and inspector refresh through `sse:job-refresh`, `sse:factory-refresh`, and `factory:scope-changed from:body`.
- `factory-refresh` should be objective-scoped on the server whenever the current route can resolve an objective id.

## SSE Events

- Keep `agent-token` intact for non-Factory consumers.
- Factory UI also consumes:
  - `factory-stream-token`: escaped HTML fragments appended into `#factory-chat-streaming-content`
  - `factory-stream-reset`: out-of-band fragment that clears `#factory-chat-streaming-content`
- Final formatted assistant output still comes from the normal chat island refresh, not the token stream.

## Change Rules

- Do not reintroduce a manual `EventSource` loop or client-owned refresh queue in `src/client/factory-client/chat.ts`.
- When shell navigation changes the route scope, update the live-root attributes, then re-run `window.htmx.process(...)` on the current live root.
- Keep the optimistic pending transcript separate from the streaming token surface.
- Preserve mission-control keyboard behavior and bottom-stick scrolling.

## Validation

Check these before declaring the change done:

- `tests/smoke/factory-client.test.ts`
  - token append and reset behavior
  - scope rebinding after chat/objective discovery
  - inline shell hydration
  - mission-control live updates
- `tests/smoke/factory.test.ts`
  - `/factory/events` objective scoping
  - runner reset emission
  - shell markup includes HTMX SSE hooks
- `tests/smoke/build.test.ts`
  - `dist/assets/htmx-ext-sse.js` exists

If the shell is acting stale, compare the route search params, the current `sse-connect` URL, and the `hx-get` attributes on chat, sidebar, and inspector before changing rendering code.
