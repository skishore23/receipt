# Factory Chat Output Fidelity and Classification Simplification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove regex-based response classification and surface actual investigation output (tables, formatted data) in objective handoff messages.

**Architecture:** Two independent changes. (1) Classification simplified to length-only heuristic — no regex. (2) Handoff event gets a new optional `output` field populated from investigation evidence, rendered in chat instead of the prose summary.

**Tech Stack:** TypeScript, bun:test

---

## File Structure

| File | Role |
|------|------|
| `src/agents/factory/chat-context.ts` | Response style classification (remove regex) |
| `src/modules/factory/events.ts` | Event type definitions (add `output` to handoff) |
| `src/modules/factory/types.ts` | State types (add `output` to handoff record) |
| `src/modules/factory/reducer.ts` | State reducer (persist `output` from event) |
| `src/services/factory/runtime/base-service.ts` | Handoff builder + investigation output extraction |
| `src/agents/factory/chat-items.ts` | Chat UI rendering (prefer `output` over `summary`) |
| `tests/smoke/factory-chat-runner.test.ts` | Classification tests |

---

### Task 1: Remove regex classification

**Files:**
- Modify: `src/agents/factory/chat-context.ts:81-99`
- Modify: `tests/smoke/factory-chat-runner.test.ts:50-59`

- [ ] **Step 1: Update classification tests to match new length-only logic**

In `tests/smoke/factory-chat-runner.test.ts`, replace both test blocks (lines 50-59):

```ts
test("factory chat prompt guidance: classifies short prompts as conversational", () => {
  expect(classifyFactoryResponseStyle("grade your performance")).toBe("conversational");
  expect(classifyFactoryResponseStyle("hello")).toBe("conversational");
  expect(classifyFactoryResponseStyle("inspect AWS cost spike")).toBe("conversational");
  expect(renderFactoryResponseStyleGuidance("grade your performance")).toContain("Do not use headings, scorecards, grades");
  expect(renderFactoryResponseStyleGuidance("grade your performance")).toContain("Do not turn the reply into operator-handoff analysis");
});

test("factory chat prompt guidance: classifies long prompts as work mode", () => {
  const long = "investigate the cost spike across all regions and accounts, compare with last month baseline, and produce a summary report with recommendations";
  expect(classifyFactoryResponseStyle(long)).toBe("work");
  expect(renderFactoryResponseStyleGuidance(long)).toContain("This turn is work-focused.");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/smoke/factory-chat-runner.test.ts`
Expected: FAIL — "inspect AWS cost spike" now asserts "conversational" but current regex returns "work"

- [ ] **Step 3: Remove regexes and simplify classification**

In `src/agents/factory/chat-context.ts`, delete lines 81-85 (both regex constants) and replace lines 93-99 (the function body):

```ts
export const classifyFactoryResponseStyle = (problem: string): FactoryChatResponseStyle => {
  const compact = problem.replace(/\s+/g, " ").trim();
  if (!compact) return "work";
  if (compact.length <= 140) return "conversational";
  return "work";
};
```

The two deleted constants are:
- `FACTORY_CHAT_META_REFLECTION_RE` (line 81-82)
- `FACTORY_CHAT_WORKLIKE_SIGNAL_RE` (line 84-85)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/smoke/factory-chat-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/factory/chat-context.ts tests/smoke/factory-chat-runner.test.ts
git commit -m "Remove regex classification, simplify to length-only heuristic"
```

---

### Task 2: Add `output` field to handoff event and state types

**Files:**
- Modify: `src/modules/factory/events.ts:129-139`
- Modify: `src/modules/factory/types.ts:87-94`
- Modify: `src/modules/factory/reducer.ts:303-315`

- [ ] **Step 1: Add `output` to the `objective.handoff` event type**

In `src/modules/factory/events.ts`, add `readonly output?: string;` after line 134 (`readonly summary: string;`):

```ts
  | {
      readonly type: "objective.handoff";
      readonly objectiveId: string;
      readonly title: string;
      readonly status: FactoryObjectiveHandoffStatus;
      readonly summary: string;
      readonly output?: string;
      readonly blocker?: string;
      readonly nextAction?: string;
      readonly handoffKey: string;
      readonly sourceUpdatedAt: number;
    }
```

- [ ] **Step 2: Add `output` to the `FactoryObjectiveHandoffRecord` state type**

In `src/modules/factory/types.ts`, add `readonly output?: string;` after line 89 (`readonly summary: string;`):

```ts
export type FactoryObjectiveHandoffRecord = {
  readonly status: FactoryObjectiveHandoffStatus;
  readonly summary: string;
  readonly output?: string;
  readonly blocker?: string;
  readonly nextAction?: string;
  readonly handoffKey: string;
  readonly sourceUpdatedAt: number;
};
```

- [ ] **Step 3: Persist `output` in the reducer**

In `src/modules/factory/reducer.ts`, add `output: event.output,` after line 309 (`summary: event.summary,`):

```ts
    case "objective.handoff":
      return {
        ...state,
        updatedAt: Math.max(state.updatedAt, event.sourceUpdatedAt),
        latestHandoff: {
          status: event.status,
          summary: event.summary,
          output: event.output,
          blocker: event.blocker,
          nextAction: event.nextAction,
          handoffKey: event.handoffKey,
          sourceUpdatedAt: event.sourceUpdatedAt,
        },
      };
```

- [ ] **Step 4: Verify build**

Run: `bun build src/modules/factory/events.ts src/modules/factory/types.ts src/modules/factory/reducer.ts --no-bundle 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/modules/factory/events.ts src/modules/factory/types.ts src/modules/factory/reducer.ts
git commit -m "Add output field to objective.handoff event and state types"
```

---

### Task 3: Build investigation output and populate handoff

**Files:**
- Modify: `src/services/factory/runtime/base-service.ts:3433-3465` (buildObjectiveHandoffEvent)
- Modify: `src/services/factory/runtime/base-service.ts:3072-3090` (objective.complete handler)
- Add method: `buildInvestigationOutput` near line 5230

- [ ] **Step 1: Add `output` to `buildObjectiveHandoffEvent` input and return**

In `src/services/factory/runtime/base-service.ts`, modify `buildObjectiveHandoffEvent` (lines 3433-3465) to accept and pass through `output`:

```ts
  private buildObjectiveHandoffEvent(input: {
    readonly state: FactoryState;
    readonly status: FactoryObjectiveHandoffStatus;
    readonly summary: string;
    readonly output?: string;
    readonly sourceUpdatedAt: number;
    readonly blocker?: string;
    readonly nextAction?: string;
  }): Extract<FactoryEvent, { readonly type: "objective.handoff" }> {
    const effectiveNextAction = optionalTrimmedString(input.nextAction)
      ?? this.defaultObjectiveHandoffNextAction(input.state, input.status);
    const handoffKey = createHash("sha1")
      .update(JSON.stringify({
        objectiveId: input.state.objectiveId,
        status: input.status,
        summary: input.summary,
        blocker: input.blocker,
        nextAction: effectiveNextAction,
        sourceUpdatedAt: input.sourceUpdatedAt,
      }))
      .digest("hex")
      .slice(0, 16);
    return {
      type: "objective.handoff",
      objectiveId: input.state.objectiveId,
      title: input.state.title,
      status: input.status,
      summary: input.summary,
      ...(input.output ? { output: input.output } : {}),
      ...(input.blocker ? { blocker: input.blocker } : {}),
      ...(effectiveNextAction ? { nextAction: effectiveNextAction } : {}),
      handoffKey,
      sourceUpdatedAt: input.sourceUpdatedAt,
    };
  }
```

- [ ] **Step 2: Add `buildInvestigationOutput` private method**

Add after `buildFinalInvestigationReport` (after line 5230):

```ts
  private buildInvestigationOutput(state: FactoryState): string | undefined {
    const report = state.investigation.synthesized?.report
      ?? this.buildFinalInvestigationReport(state);
    const details = report.evidence
      .map((e) => e.detail ?? e.summary)
      .filter(Boolean);
    return details.length > 0 ? details.join("\n\n") : undefined;
  }
```

- [ ] **Step 3: Populate `output` in the `objective.complete` handler**

In the `objective.complete` case (lines 3072-3090), pass `output` to the handoff builder:

```ts
      case "objective.complete":
        {
          const completedAt = Date.now();
          const output = state.objectiveMode === "investigation"
            ? this.buildInvestigationOutput(state)
            : undefined;
          const completedEvent = {
            type: "objective.completed" as const,
            objectiveId: state.objectiveId,
            summary: effect.summary,
            completedAt,
          };
          await this.emitObjectiveBatch(state.objectiveId, [
            completedEvent,
            this.buildObjectiveHandoffEvent({
              state,
              status: "completed",
              summary: effect.summary,
              output,
              sourceUpdatedAt: completedAt,
            }),
          ]);
        }
        return "applied";
```

- [ ] **Step 4: Verify build**

Run: `bun build src/services/factory/runtime/base-service.ts --no-bundle 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/services/factory/runtime/base-service.ts
git commit -m "Populate handoff output from investigation evidence on completion"
```

---

### Task 4: Render output in completed handoff chat item

**Files:**
- Modify: `src/agents/factory/chat-items.ts:494-509`

- [ ] **Step 1: Prefer `output` over `summary` in completed handoff**

In `src/agents/factory/chat-items.ts`, modify the completed handoff block (lines 494-509). Change line 498 from `event.summary` to `event.output ?? event.summary`:

```ts
  if (event.status === "completed") {
    const nextAction = event.nextAction?.trim();
    const lines = [
      `${title} finished and is back with Chat.`,
      event.output ?? event.summary,
      nextAction && nextAction !== event.summary && !isGenericCompletedNextAction(nextAction)
        ? `Next: ${nextAction}`
        : "",
      "Ask a new question in chat, or reopen the objective if you want to keep working from this result.",
    ].filter(Boolean);
    return {
      key: `${runId}-objective-handoff-${hash}`,
      kind: "assistant",
      body: lines.join("\n\n"),
      meta: "Completed handoff",
    };
  }
```

- [ ] **Step 2: Verify build**

Run: `bun build src/agents/factory/chat-items.ts --no-bundle 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 3: Run all smoke tests**

Run: `bun test tests/smoke/factory-chat-runner.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/agents/factory/chat-items.ts
git commit -m "Render investigation output in completed handoff chat items"
```
