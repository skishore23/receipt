# Factory Chat: Output Fidelity and Classification Simplification

## Problem

When a user asks Factory Chat a question like "get list of all EC2 instances for all region in table format", two things go wrong:

1. **Classification is regex-heavy**: `classifyFactoryResponseStyle` uses two hardcoded regexes (`FACTORY_CHAT_WORKLIKE_SIGNAL_RE`, `FACTORY_CHAT_META_REFLECTION_RE`) to decide response style. Keywords like `ec2`, `aws`, `s3` force any message into "work" mode regardless of intent. This is brittle and over-classifies.

2. **Handoff drops actual output**: When an objective completes, the handoff message only includes a prose `summary` (e.g., "Collected a table-format EC2 inventory across all 17 queryable regions..."). The actual formatted output (the table the user asked for) is buried in investigation report evidence and never surfaces to the user.

## Design

### Part 1: Remove regex classification

**File: `src/agents/factory/chat-context.ts`**

- Delete `FACTORY_CHAT_META_REFLECTION_RE` constant (line 81-82)
- Delete `FACTORY_CHAT_WORKLIKE_SIGNAL_RE` constant (line 84-85)
- Simplify `classifyFactoryResponseStyle` to a length-only heuristic:
  - Empty input -> "work"
  - <= 140 characters -> "conversational"
  - Everything else -> "work"
- The LLM orchestration rules in `chat/run.ts` handle the actual routing decision (codex.run vs factory.dispatch). This classification only affects response tone guidance.

### Part 2: Add `output` field to handoff event

**File: `src/modules/factory/events.ts`**

Add an optional `output` field to the `objective.handoff` event type:

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

### Part 3: Populate output from investigation evidence

**File: `src/services/factory/runtime/base-service.ts`**

1. Update `buildObjectiveHandoffEvent` signature to accept optional `output` field and pass it through to the event.

2. In the `objective.complete` effect handler (line 3072), extract formatted output from investigation report evidence when the objective is an investigation:

```ts
case "objective.complete": {
  const completedAt = Date.now();
  const output = state.objectiveMode === "investigation"
    ? this.buildInvestigationOutput(state)
    : undefined;
  // ... build events with output
}
```

3. Add private method `buildInvestigationOutput`:

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

This extracts `detail` (preferred) or `summary` from each evidence item. Evidence items contain the actual formatted data (tables, JSON, etc.) produced by the worker.

### Part 4: Render output in handoff chat item

**File: `src/agents/factory/chat-items.ts`**

In `objectiveHandoffItem`, for completed status, prefer `event.output` over `event.summary`:

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
  // ...
}
```

### Part 5: Update tests

**File: `tests/smoke/factory-chat-runner.test.ts`**

Update classification tests to reflect the new length-only logic:
- Short messages (<=140 chars) are "conversational" regardless of keywords
- Long messages are "work"

## Files Changed

| File | Change |
|------|--------|
| `src/agents/factory/chat-context.ts` | Remove both regexes, simplify classification to length-only |
| `src/modules/factory/events.ts` | Add optional `output` to `objective.handoff` event type |
| `src/services/factory/runtime/base-service.ts` | Add `buildInvestigationOutput`, accept/pass `output` in `buildObjectiveHandoffEvent`, populate in `objective.complete` handler |
| `src/agents/factory/chat-items.ts` | Prefer `output` over `summary` in completed handoff rendering |
| `tests/smoke/factory-chat-runner.test.ts` | Update classification test assertions |

## Out of Scope

- Changing the LLM orchestration rules for codex.run vs factory.dispatch routing (separate concern)
- Changing investigation report structure or worker behavior
- Adding output to blocked/failed handoffs (only completed for now)
