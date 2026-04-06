---
name: factory-ui-streaming
description: Use when changing Receipt Factory live UI push routing, `data-refresh-on` island contracts, scoped refresh behavior, or the browser/client smoke tests that cover `/factory/events`, `/factory/chat/events`, `/factory/background/events`, and inline shell hydration.
---

# Factory UI Streaming

Use this skill for Factory live-update bugs, stale scope issues, reactive push routing changes, or when the server event streams and browser islands drift out of sync.

## First Files

Inspect these first:

1. `src/client/factory-client/reactive.ts`
2. `src/client/factory-client/chat.ts`
3. `src/client/factory-client/workbench.ts`
4. `src/views/ui.ts`
5. `src/views/factory/shared/index.ts`
6. `src/views/factory/shell/index.ts`
7. `src/views/factory/transcript/index.ts`
8. `src/views/factory/workbench/index.ts`
9. `src/views/factory/sidebar/index.ts`
10. `src/views/factory/workbench/page.ts`
11. `src/agents/factory/route/events.ts`
12. `src/agents/factory/route/handlers.ts`
13. `src/agents/factory/route/navigation.ts`
14. `src/agents/factory/chat/`
15. `tests/smoke/factory-client.test.ts`
16. `tests/smoke/factory.test.ts`

## Live Contract

- The live shell root is `#factory-live-root`.
- Factory shell and workbench no longer rely on root-level `hx-ext="sse"` and `sse-connect`. The JS clients own `EventSource` lifecycles through `src/client/factory-client/reactive.ts`.
- Server markup declares refresh intent through `liveIslandAttrs(...)`, which emits both `hx-trigger` and `data-refresh-on`. Treat `data-refresh-on` as the client routing contract.
- Chat shell uses one scoped stream at `/factory/events${search}`.
- Workbench splits streams by concern:
  - `/factory/background/events...` for header and projection-backed workbench blocks
  - `/factory/chat/events...` for transcript refresh and token streaming
- Workbench scope changes must update `data-events-path` on `#factory-workbench-background-root` and `#factory-workbench-chat-root` before the client resyncs subscriptions.
- Sidebar and inspector remain projection-driven:
  - `profile-board-refresh` for board/list membership and count surfaces
  - `objective-runtime-refresh` for selected objective detail and runtime surfaces
  - `factory:scope-changed from:body` only for local route rebinding
- Workbench is explicitly islandized. Treat the header, whole-background fallback, chat pane, and each block (`summary`, `objectives`, `activity`, `history`) as separate server-rendered refresh targets.
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
- Prefer declaring refresh behavior in view code first, then let `reactive.ts` discover it from `data-refresh-on`. Do not add new hardcoded event-to-target maps when a declarative island binding is sufficient.

## SSE Events

- Keep `agent-token` intact. The Factory JS clients consume it directly for incremental transcript text.
- `factory-stream-reset` still clears the streaming shell when emitted.
- `factory-stream-token` and `sse-swap` markup are the legacy compatibility path used only when `renderFactoryStreamingShell(..., { liveMode: "sse" })` is requested. Current Factory shell and workbench render `liveMode: "js"`.
- Final formatted assistant output still comes from the normal chat island refresh, not the token stream.

## Change Rules

- Do not reintroduce root-level Factory `hx-ext="sse"` or `sse-connect` wiring.
- Do not reintroduce bespoke `EventSource` plumbing or per-surface refresh queues when `createReactivePushRouter(...)` and `createQueuedRefreshRunner(...)` can own the behavior.
- In `src/client/factory-client/workbench.ts`, keep the full-pane refresh path only as a fallback for navigation or recovery. Projection events should target the smallest matching island set first.
- When shell navigation changes route scope, update route/body attributes, `hx-get` values, and any `data-events-path` values before reprocessing markup or resyncing subscriptions.
- Keep the optimistic pending transcript separate from the streaming token surface.
- Preserve mission-control keyboard behavior and bottom-stick scrolling.
- When adding a new live section, add a route-scoped island endpoint plus a declarative `refreshOn` contract instead of teaching the browser how to recompute server projections.

## Validation

Check these before declaring the change done:

- `tests/smoke/factory-client.test.ts`
  - declarative `data-refresh-on` routing for chat and workbench
  - token append and reset behavior
  - scope rebinding after chat/objective discovery
  - projection-scoped workbench block refreshes
  - inline shell hydration
  - mission-control live updates
- `tests/smoke/factory.test.ts`
  - `/factory/events`, `/factory/chat/events`, and `/factory/background/events` scoping
  - projection-scoped workbench block and shell bindings
  - runner reset emission
  - shell markup omits Factory `hx-ext="sse"` and `sse-connect`
- `tests/smoke/build.test.ts`
  - only relevant when asset packaging or non-Factory HTMX SSE usage changes
  - `dist/assets/htmx-ext-sse.js` still exists for non-Factory pages, so its presence is not the Factory live-contract signal

If the shell is acting stale, compare the route search params, current `data-events-path` values, and the `data-refresh-on` / `hx-get` attributes on each island before changing rendering code.
