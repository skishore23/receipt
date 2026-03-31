# Self-Improving Audit with Auto-Fix

## Problem

The self-improvement loop is structurally complete but produces weak signal:
- `buildRecommendations` in `analyze.ts` is a hardcoded 7-pattern match that produces static strings
- 7/10 audits produce "Recommendations: none"
- No cross-run pattern aggregation
- No mechanism to automatically act on recurring issues
- The audit writes findings but nothing closes the loop with code changes

## Design

Replace hardcoded recommendation generation with LLM-generated analysis. When recurring anomaly patterns hit a confidence threshold, auto-create a delivery objective to implement the fix.

### Component 1: Structured Recommendation Type

Replace `recommendations: ReadonlyArray<string>` with a structured type throughout the investigation/audit pipeline:

```ts
type AuditRecommendation = {
  readonly summary: string;
  readonly anomalyPatterns: ReadonlyArray<string>;
  readonly scope: string;
  readonly confidence: "low" | "medium" | "high";
  readonly suggestedFix: string;
};
```

- `summary`: human-readable description of the recommendation
- `anomalyPatterns`: normalized keys for clustering (e.g., `"repeated_control_job"`, `"lease_expired"`). A single recommendation can reference multiple patterns when they share a root cause.
- `scope`: affected file paths or system area
- `confidence`: LLM's self-assessed confidence in the fix
- `suggestedFix`: concrete description of what to change (file paths, logic changes, expected behavior)

### Component 2: LLM Recommendation Generator

In `runFactoryObjectiveAudit` (factory-runtime.ts), after the investigation analysis completes:

1. Build a prompt containing:
   - The structured audit report (anomalies, assessment, timeline summary, what-happened)
   - Recent audit memory from `factory/audits/repo` (last 10 entries) for cross-run context
   - The anomaly types and their frequencies across recent audits
2. Call the LLM to generate `AuditRecommendation[]`
3. The LLM has the full investigation context (file paths from timeline, packet context, anomaly details) and cross-run pattern data, so it produces concrete, file-aware, multi-pattern recommendations

The LLM replaces the hardcoded `buildRecommendations` function in `analyze.ts` entirely.

### Component 3: Anomaly Pattern Clustering

Before deciding whether to auto-fix, the audit job:

1. Reads recent entries from `factory/audits/repo` (last 20 entries)
2. Extracts `anomalyPatterns` from stored recommendations
3. Counts frequency of each pattern across recent audits
4. A pattern is "recurring" when it appears in 5+ distinct audits

### Component 4: Auto-Fix Trigger

After clustering, for each recommendation where:
- At least one `anomalyPattern` has 5+ occurrences across recent audits
- `confidence` is `"high"`

The audit job:
1. Creates a delivery objective via `factoryService.createObjective`:
   - `title`: derived from recommendation summary
   - `prompt`: the `suggestedFix` with full context (anomaly patterns, frequency, scope)
   - `objectiveMode`: `"delivery"`
   - `severity`: `1` (lowest priority, won't preempt user work)
   - `channel`: `"auto-fix"`
   - `startImmediately`: `true`
2. Writes a `factory/audits/repo` entry noting the auto-fix was triggered, including the objective ID
3. Only triggers ONE auto-fix per audit run (the highest-confidence qualifying recommendation)

### Component 5: Enriched Audit Memory

The audit memory entry written to `factory/audits/repo` is updated to include structured recommendation data:

```
[objective_xxx] Summary
...existing assessment...

Recommendations
- [high] scope=src/services/factory/runtime/base-service.ts patterns=repeated_control_job,lease_expired
  Deduplicate control job enqueues by coalescing reconcile attempts per session key.

Auto-fix
- Triggered: objective_yyy (delivery, severity 1) for recommendation #1
```

This structured format allows future audit runs to parse pattern frequencies from memory entries.

## Files Changed

| File | Change |
|------|--------|
| `src/factory-cli/analyze.ts` | Delete `buildRecommendations`. Export `AuditRecommendation` type. Return empty recommendations from analysis (LLM generates them later). |
| `src/factory-cli/investigate.ts` | Update `FactoryReceiptInvestigation.recommendations` from `ReadonlyArray<string>` to `ReadonlyArray<AuditRecommendation>`. Update text renderer. |
| `src/factory-cli/audit.ts` | Update `buildImprovements` to work with structured recommendations. Remove hardcoded improvement strings that are now LLM-generated. Keep pure-data signals (memory hygiene counts). |
| `src/services/factory-runtime.ts` | In `runFactoryObjectiveAudit`: add LLM recommendation generation, pattern clustering from recent audit memory, auto-fix trigger with objective creation. |
| `src/services/factory/memory/store.ts` | Add `renderAuditRecommendationMemoryText` for structured recommendation serialization. |
| `tests/smoke/factory-investigate-script.test.ts` | Update for new recommendation type. |

## Safety Rails

- Delivery mode with full alignment gate, check validation, and promotion pipeline
- Severity 1: auto-fix objectives never preempt user-initiated work
- 5-occurrence threshold: prevents acting on transient or one-off issues
- High-confidence gate: LLM must self-assess high confidence for auto-fix to trigger
- One auto-fix per audit run: prevents cascading objective creation
- `channel: "auto-fix"` tag: auto-fix objectives are identifiable and filterable
- If the auto-fix objective itself gets a weak verdict, the pattern is noted but no automatic retry

## Out of Scope (follow-ups)

- Configurable threshold via policy (`autoFixThreshold` in objective policy)
- Feedback loop from auto-fix verdict back into threshold tuning
- Auto-fix for non-code improvements (profile changes, policy updates)
- Rate limiting across audit runs (currently one-per-run is sufficient)
