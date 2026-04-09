# Factory Streaming Loader Refresh

## Problem

The current Factory workbench streaming shell feels empty and flickery during the early reply lifecycle.

Two implementation details cause that behavior:

1. The streaming shell collapses in `idle` with `max-height: 0`, `opacity: 0`, and a translate transform. That means the user often sees a blank region first, then a shell that repaints later.
2. The loader, status text, and streamed content swap inside the same region without a stable visual frame. As the state moves through `Sending`, `Queued`, `Starting`, and token streaming, the area appears to blink between empty, sparse, and filled states.

The result does not feel responsive. It also underuses the existing theme tokens in dark mode, where the shell should feel intentional and alive instead of transient.

## Goal

Make the workbench reply loader feel immediate, polished, and theme-native:

- show a rich placeholder immediately once a reply is in flight
- never show an empty streaming region during `Sending`, `Queued`, or `Starting`
- preserve one stable shell across pending and streaming states
- transition from placeholder to real tokens without collapsing layout
- keep the look aligned with the existing Receipt dark theme rather than importing a foreign visual language

## Design

### Part 1: Keep one persistent streaming shell

**Files: `src/views/factory/workbench/page.ts`, `src/views/factory/transcript/index.ts`, `src/client/factory-client/workbench.ts`**

Replace the current sparse streaming shell with a richer shell that stays mounted through the entire pending and streaming lifecycle.

State model:

- `idle`: hidden only before a compose action starts
- `pending`: visible immediately after compose with placeholder visuals and status text
- `streaming`: same shell, same frame, but token text fades in while placeholder visuals fade down
- `settling`: keep the shell visible after the last token until the transcript refresh lands
- `idle`: only then clear and collapse the shell

The shell should no longer rely on "hidden means absent" during active reply startup.

### Part 2: Render a richer placeholder structure

**File: `src/views/factory/workbench/page.ts`**

Expand the shell markup from:

- profile label
- status chip
- tiny loader row
- content container

into a structured pending card with dedicated regions:

- header row
  - profile label
  - status chip
- animated activity rail at the top edge
- primary loader row
  - animated dot cluster or pulse marker
  - short loader label
  - one-line meta summary
- placeholder body
  - 2-3 shimmer lines with staggered widths
  - subtle terminal/cursor accent near the end of the last line
- token content region
  - initially empty
  - fades in without changing container ownership

Suggested ids/classes:

- keep existing ids for JS compatibility:
  - `factory-chat-stream-shell`
  - `factory-chat-streaming-label-text`
  - `factory-chat-streaming-status`
  - `factory-chat-streaming-loader`
  - `factory-chat-streaming-loader-label`
  - `factory-chat-streaming-content`
- add new structural ids/classes for the richer placeholder:
  - `factory-chat-streaming-loader-meta`
  - `factory-chat-streaming-placeholder`
  - `factory-chat-streaming-placeholder-lines`
  - `factory-chat-streaming-placeholder-cursor`
  - `factory-chat-streaming-activity-rail`

### Part 3: Remove collapse-driven pending behavior

**File: `src/styles/factory.css`**

Change the shell behavior so `idle` is the only fully collapsed state.

Rules:

- `pending`, `streaming`, and `settling` should all reserve stable vertical space
- the shell should use `min-height` rather than repeated `max-height` jumps while active
- opacity and transform can animate, but layout should remain stable
- the loader should never use `.hidden` to mean "not mounted" during active reply startup

This directly removes the empty-gap effect.

### Part 4: Add a theme-native visual treatment

**File: `src/styles/factory.css`**

The loader should feel polished in the existing dark theme:

- border, card, muted, primary, and ring colors must come from theme variables already defined in `factory.css`
- use a subtle active edge or top shimmer rail based on `--primary`
- shimmer rows should be low-contrast and layered against `--card`, `--muted`, and `--accent`
- preserve the monospace chip/status feel already used elsewhere in the workbench
- keep motion subtle enough to feel premium instead of noisy

Add or revise component classes:

- `.factory-stream-shell`
- `.factory-stream-loader`
- `.factory-stream-loader-label`
- `.factory-stream-loader-meta`
- `.factory-stream-placeholder`
- `.factory-stream-placeholder-line`
- `.factory-stream-placeholder-line--short`
- `.factory-stream-placeholder-line--medium`
- `.factory-stream-placeholder-line--long`
- `.factory-stream-activity-rail`
- `.factory-stream-text`

Animation guidelines:

- shimmer/pulse duration should be slow and smooth
- cursor blink remains only for real streamed text
- if `prefers-reduced-motion` is active, freeze shimmer and retain only static placeholder styling

### Part 5: Separate placeholder visibility from token visibility

**Files: `src/client/factory-client/workbench.ts`, `src/client/factory-client/live-updates.ts`**

Keep placeholder and token content in the same shell, but drive them independently.

Behavior:

- when compose starts:
  - shell enters `pending`
  - placeholder is visible
  - status chip and meta summary update immediately
- when first token arrives:
  - shell enters `streaming`
  - token region fades in
  - placeholder remains briefly but at lower opacity
  - placeholder then fades away instead of disappearing instantly
- when stream resets:
  - do not clear the shell immediately if the transcript island has not refreshed yet
  - move to `settling`
  - once transcript refresh lands or terminal state is confirmed, clear the streaming shell

This keeps the visual transition continuous instead of stepwise and blank.

### Part 6: Tighten pending state copy

**File: `src/client/factory-client/workbench.ts`**

Use the existing status pipeline, but make the visible copy shorter and more human:

- `Sending`: "Sending your message"
- `Queued`: "Queued and preparing the run"
- `Starting`: "Starting the reply"

The loader meta line should hold the longer explanatory sentence. The chip should stay concise.

### Part 7: Preserve current live-update contracts

**Files: `src/client/factory-client/workbench.ts`, `tests/smoke/factory-client.test.ts`**

Do not change the underlying live contract:

- keep `agent-token`
- keep `factory-stream-reset`
- keep the optimistic transcript separate from the streamed reply surface
- do not reintroduce root-level SSE wiring or sidecar event plumbing

This change is presentation and state-timing only, not a protocol rewrite.

## Files Changed

| File | Change |
|------|--------|
| `src/views/factory/workbench/page.ts` | Render richer streaming shell markup with placeholder regions and stable frame |
| `src/styles/factory.css` | Add theme-native shimmer/rail/placeholder styles and remove collapse-driven active-state behavior |
| `src/client/factory-client/workbench.ts` | Drive stable shell states, placeholder visibility, status/meta updates, and settling timing |
| `src/client/factory-client/live-updates.ts` | Keep token rendering compatible with the richer shell fade-in path |
| `tests/smoke/factory-client.test.ts` | Update shell markup and JS behavior tests for pending/streaming/reset lifecycle |

## Validation

Run focused verification:

- `bun test tests/smoke/factory-client.test.ts`

If the view rendering tests are split or broader coverage is needed, also run:

- `bun test tests/smoke/factory.test.ts`

Manual checks in the workbench should confirm:

- no blank shell after submit
- no visible collapse between `Queued` and `Starting`
- first token appears inside the existing shell instead of replacing it
- shell clears only after the transcript refresh is visible
- styling looks coherent in the current dark theme

## Out of Scope

- redesigning transcript message cards outside the streaming shell
- changing Factory event semantics or token payload structure
- adding a separate reasoning timeline inside the loader
- changing optimistic compose behavior beyond what is needed to avoid flicker
