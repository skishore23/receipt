# Factory Streaming Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty/flickery Factory workbench streaming shell with a theme-native persistent loader that shows rich placeholder content immediately and transitions smoothly into streamed tokens.

**Architecture:** Keep one streaming shell mounted across pending and streaming states. Render richer placeholder markup in the transcript view, drive shell state and crossfade timing in the workbench client, and move the visual polish into focused theme-aware CSS classes so the shell stays coherent in dark mode.

**Tech Stack:** TypeScript, server-rendered view helpers, Factory browser client, Tailwind/theme CSS, Bun smoke tests

---

### Task 1: Rich Streaming Shell Markup

**Files:**
- Modify: `src/views/factory/transcript/index.ts`
- Test: `tests/smoke/factory-client.test.ts`

- [ ] **Step 1: Write the failing markup assertions**

Add or update the streaming-shell expectations so the rendered shell includes:

```ts
expect(html).toContain('id="factory-chat-streaming-loader-meta"');
expect(html).toContain('id="factory-chat-streaming-placeholder"');
expect(html).toContain('id="factory-chat-streaming-activity-rail"');
expect(html).toContain('factory-stream-placeholder-line');
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `bun test tests/smoke/factory-client.test.ts --test-name-pattern "stream"`

Expected: FAIL because the new placeholder ids/classes do not exist yet.

- [ ] **Step 3: Render the richer shell structure**

Change `renderFactoryStreamingShell(...)` so the assistant card contains:

```ts
<div id="factory-chat-streaming-activity-rail" class="factory-stream-activity-rail" aria-hidden="true"></div>
<div id="factory-chat-streaming-loader" class="factory-stream-loader" aria-hidden="true">
  <span class="factory-stream-loader-dots" aria-hidden="true"><span></span><span></span><span></span></span>
  <div class="min-w-0 flex-1 space-y-3">
    <div class="factory-stream-loader-row">
      <span id="factory-chat-streaming-loader-label" class="factory-stream-loader-label">Sending</span>
      <span class="factory-stream-loader-separator" aria-hidden="true"></span>
      <span id="factory-chat-streaming-loader-meta" class="factory-stream-loader-meta">Waiting for the reply.</span>
    </div>
    <div id="factory-chat-streaming-placeholder" class="factory-stream-placeholder" aria-hidden="true">
      <div class="factory-stream-placeholder-line factory-stream-placeholder-line--long"></div>
      <div class="factory-stream-placeholder-line factory-stream-placeholder-line--medium"></div>
      <div class="factory-stream-placeholder-line factory-stream-placeholder-line--short">
        <span id="factory-chat-streaming-placeholder-cursor" class="factory-stream-placeholder-cursor"></span>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `bun test tests/smoke/factory-client.test.ts --test-name-pattern "stream"`

Expected: PASS for the markup assertions.

### Task 2: Theme-Native Loader Styling

**Files:**
- Modify: `src/styles/factory.css`
- Test: `tests/smoke/factory-client.test.ts`

- [ ] **Step 1: Add failing assertions for active-state classes**

Cover the new state contract with checks that the client can expose `pending`, `streaming`, and `settling` without relying on an always-hidden loader:

```ts
expect(streamingShell.getAttribute("data-stream-state")).toBe("pending");
expect(streamingLoader.classList.contains("hidden")).toBe(false);
```

- [ ] **Step 2: Run the targeted client test to verify it fails**

Run: `bun test tests/smoke/factory-client.test.ts --test-name-pattern "loader|stream"`

Expected: FAIL because the old CSS/client behavior still toggles the loader through `.hidden`.

- [ ] **Step 3: Implement the loader styles**

Update `factory.css` so:

```css
[data-factory-stream-shell][data-stream-state="idle"] { max-height: 0; opacity: 0; ... }
[data-factory-stream-shell][data-stream-state="pending"],
[data-factory-stream-shell][data-stream-state="streaming"],
[data-factory-stream-shell][data-stream-state="settling"] { min-height: 8rem; opacity: 1; ... }

.factory-stream-placeholder-line { /* shimmer line */ }
.factory-stream-activity-rail { /* subtle animated top rail */ }
.factory-stream-shell[data-stream-state="streaming"] .factory-stream-placeholder { opacity: 0.18; }
.factory-stream-shell[data-stream-state="streaming"] .factory-streaming-content { opacity: 1; }
```

Also add a reduced-motion guard:

```css
@media (prefers-reduced-motion: reduce) {
  .factory-stream-placeholder-line,
  .factory-stream-loader-dots > span,
  .factory-stream-activity-rail { animation: none; }
}
```

- [ ] **Step 4: Run the targeted client test to verify it passes**

Run: `bun test tests/smoke/factory-client.test.ts --test-name-pattern "loader|stream"`

Expected: PASS for the active-state and loader visibility assertions.

### Task 3: Client State Timing And Anti-Flicker Behavior

**Files:**
- Modify: `src/client/factory-client/workbench.ts`
- Modify: `src/client/factory-client/live-updates.ts`
- Test: `tests/smoke/factory-client.test.ts`

- [ ] **Step 1: Add failing lifecycle assertions**

Extend the client test coverage so the browser client proves:

```ts
expect(streamingCard.getAttribute("data-stream-state")).toBe("pending");
expect(streamingLoaderLabel.textContent).toBe("Sending");
expect(streamingLoaderMeta.textContent).toContain("Sending your message");

// after token event
expect(streamingCard.getAttribute("data-stream-state")).toBe("streaming");
expect(stripHtml(streaming.innerHTML)).toContain("Hello from Factory.");
```

- [ ] **Step 2: Run the targeted client test to verify it fails**

Run: `bun test tests/smoke/factory-client.test.ts --test-name-pattern "token|stream|compose"`

Expected: FAIL because the current implementation only uses `idle` and `active`, and it hides the loader too aggressively.

- [ ] **Step 3: Implement the minimal state-machine changes**

Update `scheduleOverlayRender()` and related helpers so:

```ts
const hasStreamingText = Boolean(streamingReply?.text);
const hasPendingStream = Boolean(!hasStreamingText && pendingLiveStatus && ["Sending", "Queued", "Starting"].includes(pendingLiveStatus.statusLabel));
const streamState = hasStreamingText ? "streaming" : hasPendingStream ? "pending" : pendingLiveStatus ? "settling" : "idle";
```

And update visible copy:

```ts
const pendingSummary =
  pendingLiveStatus?.statusLabel === "Sending" ? "Sending your message." :
  pendingLiveStatus?.statusLabel === "Queued" ? "Queued and preparing the run." :
  pendingLiveStatus?.statusLabel === "Starting" ? "Starting the reply." :
  "Reply streaming live.";
```

Do not clear the shell until transcript reconciliation has acknowledged the reply handoff.

- [ ] **Step 4: Run the focused verification**

Run: `bun test tests/smoke/factory-client.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the broader Factory live-contract verification**

Run: `bun test tests/smoke/factory.test.ts`

Expected: PASS.
