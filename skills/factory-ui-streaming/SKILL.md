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
3. `src/views/factory-workbench-page.ts`
4. `src/client/factory-client/workbench.ts`
5. `src/agents/factory/route.ts`
6. `src/server.ts`
7. `tests/smoke/factory-client.test.ts`
8. `tests/smoke/factory.test.ts`
9. `tests/smoke/build.test.ts`

## Live Contract

- The live shell root is `#factory-live-root`.
- The browser connects with HTMX SSE through `hx-ext="sse"` and `sse-connect="/factory/events..."`.
- Chat refresh is declarative on `#factory-chat` through `hx-trigger="sse:agent-refresh ..., sse:job-refresh ..., sse:objective-runtime-refresh ..."`.
- Sidebar and inspector are projection-driven:
  - `profile-board-refresh` for board/list membership and count surfaces
  - `objective-runtime-refresh` for selected objective detail and runtime surfaces
  - `factory:scope-changed from:body` only for local route rebinding
- Workbench background is not a single coarse island anymore. Treat the header and each block (`summary`, `objectives`, `activity`, `history`) as separate server-rendered islands with explicit projection dependencies.
- `factory-refresh` remains a compatibility fallback, not the primary contract for new work.

## Projection Rules

- Push invalidation from synced server projections, not raw receipts.
- Every live island must declare which projection it depends on before wiring refresh behavior.
- Use the existing projection topics first:
  - `profile-board`
  - `objective-runtime`
- Publish projection refreshes only after the related server-side projection/cache has been synced and invalidated.
- Do not bind new sidebar/workbench list/count surfaces directly to broad `factory-refresh` or global `job-refresh` topics when a narrower projection topic exists.
- Prefer smaller islands over refreshing an entire pane when only one projection-backed section changed.

## SSE Events

- Keep `agent-token` intact for non-Factory consumers.
- Factory UI also consumes:
  - `factory-stream-token`: escaped HTML fragments appended into `#factory-chat-streaming-content`
  - `factory-stream-reset`: out-of-band fragment that clears `#factory-chat-streaming-content`
- Final formatted assistant output still comes from the normal chat island refresh, not the token stream.

## Change Rules

- Do not reintroduce a manual `EventSource` loop or client-owned refresh queue in `src/client/factory-client/chat.ts`.
- In `src/client/factory-client/workbench.ts`, keep the full-pane refresh path only as a fallback for navigation or recovery. Projection events should target the smallest matching island set first.
- When shell navigation changes the route scope, update the live-root attributes, then re-run `window.htmx.process(...)` on the current live root.
- Keep the optimistic pending transcript separate from the streaming token surface.
- Preserve mission-control keyboard behavior and bottom-stick scrolling.
- When adding a new live section, add a route-scoped island endpoint for that section instead of teaching the browser how to recompute server projections.

## Validation

Check these before declaring the change done:

- `tests/smoke/factory-client.test.ts`
  - token append and reset behavior
  - scope rebinding after chat/objective discovery
  - projection-scoped workbench block refreshes
  - inline shell hydration
  - mission-control live updates
- `tests/smoke/factory.test.ts`
  - `/factory/events` objective scoping
  - projection-scoped `/factory/background/events` subscriptions
  - runner reset emission
  - shell markup includes projection-scoped island hooks
- `tests/smoke/build.test.ts`
  - `dist/assets/htmx-ext-sse.js` exists

If the shell is acting stale, compare the route search params, the current `sse-connect` URL, and the `hx-get` attributes on chat, sidebar, and inspector before changing rendering code.
