# Self-Improving Audit with Auto-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded audit recommendations with LLM-generated analysis and auto-create delivery objectives when recurring patterns hit a confidence threshold.

**Architecture:** The audit job (`runFactoryObjectiveAudit`) gains three new steps after investigation analysis: (1) call `llmStructured` to generate structured recommendations, (2) cluster anomaly patterns from recent audit memory, (3) auto-create a delivery objective if a pattern recurs 5+ times with high confidence. The hardcoded `buildRecommendations` in `analyze.ts` is deleted.

**Tech Stack:** TypeScript, bun:test, OpenAI adapter (`llmStructured` with Zod schema), FactoryService for objective creation.

---

## File Structure

| File | Role |
|------|------|
| `src/factory-cli/analyze.ts` | Delete `buildRecommendations`, export `AuditRecommendation` type |
| `src/factory-cli/investigate.ts` | Update recommendation type from `string[]` to `AuditRecommendation[]`, update renderer |
| `src/factory-cli/audit.ts` | Update `buildImprovements` to use structured recommendations, remove hardcoded strings |
| `src/services/factory-runtime.ts` | LLM recommendation generation, pattern clustering, auto-fix trigger, enriched memory text |
| `tests/smoke/factory-investigate-script.test.ts` | Update for new recommendation type and auto-fix |

---

### Task 1: Add AuditRecommendation type and delete hardcoded buildRecommendations

**Files:**
- Modify: `src/factory-cli/analyze.ts:254,869-895`

- [ ] **Step 1: Export the AuditRecommendation type and delete buildRecommendations**

In `src/factory-cli/analyze.ts`, add the new type after the `ObjectiveAnalysis` type (after line 255), and delete `buildRecommendations` (lines 869-895). Replace the deleted function with one that returns an empty array (the LLM generates recommendations in the audit job now, not here).

Replace line 254:
```ts
  readonly recommendations: ReadonlyArray<string>;
```
with:
```ts
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
```

Add after line 255 (after the closing `};` of `ObjectiveAnalysis`):
```ts
export type AuditRecommendation = {
  readonly summary: string;
  readonly anomalyPatterns: ReadonlyArray<string>;
  readonly scope: string;
  readonly confidence: "low" | "medium" | "high";
  readonly suggestedFix: string;
};
```

Delete the entire `buildRecommendations` function (lines 869-895) and replace with:
```ts
const buildRecommendations = (_anomalies: ReadonlyArray<AnalysisAnomaly>): ReadonlyArray<AuditRecommendation> => [];
```

- [ ] **Step 2: Verify build**

Run: `bunx tsc --noEmit 2>&1 | head -20`
Expected: Type errors in `investigate.ts` and `audit.ts` because they expect `string[]` — this is expected and will be fixed in Tasks 2 and 3.

- [ ] **Step 3: Commit**

```bash
git add src/factory-cli/analyze.ts
git commit -m "Add AuditRecommendation type, delete hardcoded buildRecommendations"
```

---

### Task 2: Update investigation report to use structured recommendations

**Files:**
- Modify: `src/factory-cli/investigate.ts:98,781-784`

- [ ] **Step 1: Update the recommendations type in FactoryReceiptInvestigation**

In `src/factory-cli/investigate.ts`, change line 98 from:
```ts
  readonly recommendations: ReadonlyArray<string>;
```
to:
```ts
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
```

Add the import at the top of the file (after the existing imports from `./analyze`):
```ts
import type { AuditRecommendation } from "./analyze";
```

- [ ] **Step 2: Update the text renderer for recommendations**

In `src/factory-cli/investigate.ts`, change lines 781-784 from:
```ts
    "## Recommendations",
    ...(report.recommendations.length > 0
      ? report.recommendations.map((item) => `- ${item}`)
      : ["- none"]),
```
to:
```ts
    "## Recommendations",
    ...(report.recommendations.length > 0
      ? report.recommendations.map((item) =>
          `- [${item.confidence}] ${item.summary} · scope=${item.scope} · patterns=${item.anomalyPatterns.join(",")}`)
      : ["- none"]),
```

- [ ] **Step 3: Verify build**

Run: `bunx tsc --noEmit 2>&1 | head -20`
Expected: Type errors remaining only in `audit.ts` and `factory-runtime.ts` — will be fixed in Tasks 3 and 4.

- [ ] **Step 4: Commit**

```bash
git add src/factory-cli/investigate.ts
git commit -m "Update investigation report to use structured AuditRecommendation type"
```

---

### Task 3: Update audit buildImprovements for structured recommendations

**Files:**
- Modify: `src/factory-cli/audit.ts:182-222,24,396`

- [ ] **Step 1: Update the AuditObjectiveSample type**

In `src/factory-cli/audit.ts`, find where the `recommendations` field is typed. Update the type alias and `buildImprovements` to accept structured recommendations.

First, add the import at the top:
```ts
import type { AuditRecommendation } from "./analyze";
```

Update line 24 (or wherever `recommendations` appears in the type) from `ReadonlyArray<string>` to `ReadonlyArray<AuditRecommendation>`.

- [ ] **Step 2: Simplify buildImprovements**

Replace the `buildImprovements` function (lines 182-222) with a data-only version that reports counts from structured recommendations instead of generating hardcoded strings:

```ts
const buildImprovements = (
  objectives: ReadonlyArray<AuditObjectiveSample>,
  anomalyCategories: ReadonlyArray<AuditAnomalyCategory>,
  memoryHygiene: AuditMemoryHygiene,
): ReadonlyArray<string> => {
  const verdicts = asCountRecord(objectives.map((objective) => objective.verdict));
  const improvements: string[] = [];

  if ((verdicts.weak ?? 0) > 0) {
    improvements.push(`${verdicts.weak}/${objectives.length} audited objective(s) landed in a weak verdict.`);
  }

  const topAnomaly = anomalyCategories[0];
  if (topAnomaly && topAnomaly.count > 0) {
    improvements.push(`Most common anomaly across the audit window: ${topAnomaly.category} (${topAnomaly.count}).`);
  }

  const allRecs = objectives.flatMap((o) => o.recommendations);
  const highConfidence = allRecs.filter((r) => r.confidence === "high");
  if (highConfidence.length > 0) {
    improvements.push(`${highConfidence.length} high-confidence recommendation(s) from LLM audit analysis.`);
  }

  if (memoryHygiene.repoSharedRunScopedEntries > 0) {
    improvements.push(`Repo shared memory still contains ${memoryHygiene.repoSharedRunScopedEntries} run-specific entries.`);
  }
  if (memoryHygiene.agentRunScopedEntries > 0) {
    improvements.push(`Agent memory still contains ${memoryHygiene.agentRunScopedEntries} run-specific entries.`);
  }

  return [...new Set(improvements)];
};
```

- [ ] **Step 3: Update the per-objective recommendation rendering**

Update line 396 (where `objective.recommendations[0]` is rendered) from:
```ts
          objective.recommendations[0] ? `  recommendation: ${objective.recommendations[0]}` : "",
```
to:
```ts
          objective.recommendations[0] ? `  recommendation: ${objective.recommendations[0].summary}` : "",
```

- [ ] **Step 4: Verify build**

Run: `bunx tsc --noEmit 2>&1 | head -20`
Expected: Remaining errors only in `factory-runtime.ts` (will be fixed in Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/factory-cli/audit.ts
git commit -m "Update audit buildImprovements for structured recommendations"
```

---

### Task 4: LLM recommendation generation, pattern clustering, and auto-fix trigger

**Files:**
- Modify: `src/services/factory-runtime.ts:172-311`

This is the core task. The audit job gains three new steps after investigation analysis.

- [ ] **Step 1: Add imports**

At the top of `src/services/factory-runtime.ts`, add:
```ts
import { z } from "zod";
import { llmStructured } from "../adapters/openai";
import type { AuditRecommendation } from "../factory-cli/analyze";
```

- [ ] **Step 2: Add the Zod schema for LLM recommendations**

Add after the imports (before `parseObjectiveAuditPayload`):

```ts
const AuditRecommendationSchema = z.object({
  recommendations: z.array(z.object({
    summary: z.string(),
    anomalyPatterns: z.array(z.string()),
    scope: z.string(),
    confidence: z.enum(["low", "medium", "high"]),
    suggestedFix: z.string(),
  })),
});
```

- [ ] **Step 3: Add the LLM recommendation generator function**

Add after the schema:

```ts
const AUTOFIX_PATTERN_THRESHOLD = 5;

const generateAuditRecommendations = async (
  report: FactoryReceiptInvestigation,
  recentAuditEntries: ReadonlyArray<{ readonly text: string }>,
): Promise<ReadonlyArray<AuditRecommendation>> => {
  const anomalySummary = report.anomalies
    .slice(0, 20)
    .map((a) => `- [${a.severity}] ${a.summary}`)
    .join("\n");
  const assessmentSummary = [
    `Verdict: ${report.assessment.verdict}`,
    `Efficiency: ${report.assessment.efficiency}`,
    `Control churn: ${report.assessment.controlChurn}`,
    `Easy route risk: ${report.assessment.easyRouteRisk}`,
    ...report.assessment.notes.slice(0, 8).map((n) => `- ${n}`),
  ].join("\n");
  const recentPatterns = recentAuditEntries
    .slice(0, 10)
    .map((e) => e.text.slice(0, 300))
    .join("\n---\n");
  const whatHappened = report.summary.whatHappened?.join("\n") ?? "";

  try {
    const result = await llmStructured({
      system: [
        "You are an expert software reliability engineer analyzing Factory objective audit reports.",
        "Generate concrete, actionable recommendations for code improvements.",
        "Each recommendation must include:",
        "- summary: what to fix (one sentence)",
        "- anomalyPatterns: normalized pattern keys that this addresses (e.g. 'repeated_control_job', 'lease_expired', 'iteration_budget_exhausted')",
        "- scope: specific file paths or system areas affected",
        "- confidence: 'high' only if the fix is well-understood and scoped, 'medium' if reasonable but needs verification, 'low' if speculative",
        "- suggestedFix: concrete description of the code change needed",
        "Look at cross-run patterns in the recent audit history to identify recurring issues.",
        "Do not generate recommendations for external/infrastructure issues (API rate limits, permission denials) unless a code-level mitigation exists.",
        "Return an empty array if no actionable recommendations exist.",
      ].join("\n"),
      user: [
        "## Current Objective Audit",
        whatHappened,
        "",
        "## Assessment",
        assessmentSummary,
        "",
        "## Anomalies",
        anomalySummary || "none",
        "",
        "## Recent Audit History (cross-run patterns)",
        recentPatterns || "none",
      ].join("\n"),
      schema: AuditRecommendationSchema,
      schemaName: "AuditRecommendations",
    });
    return result.parsed.recommendations;
  } catch {
    return [];
  }
};
```

- [ ] **Step 4: Add pattern clustering function**

Add after the generator:

```ts
const clusterAnomalyPatterns = (
  recentEntries: ReadonlyArray<{ readonly text: string }>,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const entry of recentEntries) {
    const patternsMatch = entry.text.match(/patterns=([^\s\n]+)/g);
    if (!patternsMatch) continue;
    for (const match of patternsMatch) {
      const patterns = match.replace("patterns=", "").split(",").filter(Boolean);
      for (const pattern of patterns) {
        counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
      }
    }
  }
  return counts;
};
```

- [ ] **Step 5: Update renderObjectiveAuditMemoryText to accept structured recommendations**

Change the `recommendations` field in the input type (line 180) from:
```ts
  readonly recommendations: ReadonlyArray<string>;
```
to:
```ts
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
```

Update the rendering inside the function body. Find the lines that render recommendations (around line 196-198) and replace with:
```ts
    "",
    "Recommendations",
    ...(input.recommendations.length > 0
      ? input.recommendations.map((r) =>
          `- [${r.confidence}] scope=${r.scope} patterns=${r.anomalyPatterns.join(",")} ${r.summary}`)
      : ["- none"]),
```

Also add an optional `autoFixObjectiveId` field to the input and render it:
```ts
  readonly autoFixObjectiveId?: string;
```

And at the end of the lines array (before the Artifacts section):
```ts
    ...(input.autoFixObjectiveId
      ? ["", "Auto-fix", `- Triggered: ${input.autoFixObjectiveId} (delivery, severity 1)`]
      : []),
```

- [ ] **Step 6: Update runFactoryObjectiveAudit to use LLM recommendations and auto-fix**

The `runFactoryObjectiveAudit` function needs to:
1. Accept `factoryService` as an optional input (for creating objectives)
2. Read recent audit memory entries
3. Call the LLM to generate recommendations
4. Cluster patterns and check the auto-fix threshold
5. Auto-create objective if conditions met

Update the function signature to add `factoryService`:
```ts
export const runFactoryObjectiveAudit = async (input: {
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly memoryTools: MemoryTools;
  readonly payload: Record<string, unknown>;
  readonly factoryService?: FactoryService;
}): Promise<Record<string, unknown>> => {
```

After the investigation report is generated and artifacts are written (after line 262), add the new steps:

```ts
  // Read recent audit entries for cross-run patterns
  const recentAuditEntries = await input.memoryTools.read({
    scope: "factory/audits/repo",
    limit: 20,
  }).catch(() => []);

  // Generate LLM recommendations
  const recommendations = await generateAuditRecommendations(report, recentAuditEntries);

  // Cluster anomaly patterns from recent audits
  const patternCounts = clusterAnomalyPatterns(recentAuditEntries);

  // Check auto-fix threshold: pattern count >= 5 AND confidence = high
  let autoFixObjectiveId: string | undefined;
  if (input.factoryService) {
    const qualifyingRec = recommendations.find((rec) =>
      rec.confidence === "high"
      && rec.anomalyPatterns.some((p) => (patternCounts.get(p) ?? 0) >= AUTOFIX_PATTERN_THRESHOLD)
    );
    if (qualifyingRec) {
      try {
        const objective = await input.factoryService.createObjective({
          title: qualifyingRec.summary.slice(0, 96),
          prompt: [
            `Auto-fix triggered by recurring audit pattern.`,
            ``,
            `## Recommendation`,
            qualifyingRec.suggestedFix,
            ``,
            `## Scope`,
            qualifyingRec.scope,
            ``,
            `## Anomaly Patterns (${qualifyingRec.anomalyPatterns.join(", ")})`,
            ...qualifyingRec.anomalyPatterns.map((p) => `- ${p}: ${patternCounts.get(p) ?? 0} occurrences`),
          ].join("\n"),
          objectiveMode: "delivery",
          severity: 1,
          channel: "auto-fix",
          startImmediately: true,
        });
        autoFixObjectiveId = objective.objectiveId;
      } catch {
        // auto-fix is best-effort
      }
    }
  }
```

Then update the `renderObjectiveAuditMemoryText` call to pass structured recommendations and autoFixObjectiveId:
```ts
  const memoryText = renderObjectiveAuditMemoryText({
    objectiveId: parsed.objectiveId,
    objectiveStatus: parsed.objectiveStatus,
    verdict: report.assessment.verdict,
    easyRouteRisk: report.assessment.easyRouteRisk,
    efficiency: report.assessment.efficiency,
    controlChurn: report.assessment.controlChurn,
    notes: [
      ...report.assessment.notes.slice(0, 6),
      `alignment=${report.assessment.alignmentVerdict}`,
      report.assessment.correctiveSteerIssued
        ? `corrective_steer=issued aligned_after_correction=${report.assessment.alignedAfterCorrection ? "yes" : "no"}`
        : "corrective_steer=none",
    ],
    recommendations: recommendations.slice(0, 6),
    autoFixObjectiveId,
    jsonPath: artifacts.jsonPath,
    textPath: artifacts.textPath,
  });
```

And update the return value to include recommendations and autofix info:
```ts
  return {
    objectiveId: parsed.objectiveId,
    objectiveStatus: parsed.objectiveStatus,
    objectiveUpdatedAt: parsed.objectiveUpdatedAt,
    verdict: report.assessment.verdict,
    easyRouteRisk: report.assessment.easyRouteRisk,
    efficiency: report.assessment.efficiency,
    controlChurn: report.assessment.controlChurn,
    alignmentVerdict: report.assessment.alignmentVerdict,
    correctiveSteerIssued: report.assessment.correctiveSteerIssued,
    alignedAfterCorrection: report.assessment.alignedAfterCorrection,
    recommendations: recommendations.length,
    autoFixObjectiveId,
    jsonPath: artifacts.jsonPath,
    textPath: artifacts.textPath,
  };
```

- [ ] **Step 7: Pass factoryService through in the worker handler**

In `createFactoryWorkerHandlers` (line 313), update the audit call to pass `service`:

Change:
```ts
        ? await runFactoryObjectiveAudit({
            dataDir: service.dataDir,
            repoRoot: service.git.repoRoot,
            memoryTools: auditMemoryTools ?? (() => { throw new Error("factory objective audit requires memory tools"); })(),
            payload: job.payload as Record<string, unknown>,
          })
```
to:
```ts
        ? await runFactoryObjectiveAudit({
            dataDir: service.dataDir,
            repoRoot: service.git.repoRoot,
            memoryTools: auditMemoryTools ?? (() => { throw new Error("factory objective audit requires memory tools"); })(),
            payload: job.payload as Record<string, unknown>,
            factoryService: service,
          })
```

- [ ] **Step 8: Verify build**

Run: `bunx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 9: Run tests**

Run: `bun test tests/smoke/factory-investigate-script.test.ts 2>&1 | tail -15`
Expected: Tests may need updating (Task 5).

- [ ] **Step 10: Commit**

```bash
git add src/services/factory-runtime.ts
git commit -m "Add LLM audit recommendations, pattern clustering, and auto-fix trigger"
```

---

### Task 5: Update tests for new recommendation type

**Files:**
- Modify: `tests/smoke/factory-investigate-script.test.ts`

- [ ] **Step 1: Update test assertions for structured recommendations**

In `tests/smoke/factory-investigate-script.test.ts`, find assertions on `result.recommendations` or `report.recommendations`. The type changed from `string[]` to `AuditRecommendation[]`.

Update the `runFactoryObjectiveAudit` call in the test (around line 661) — it now needs a `factoryService` field (optional, so just omit it or pass `undefined`).

Any assertion like:
```ts
expect(result.recommendations).toEqual(expect.arrayContaining([expect.any(String)]));
```
should become:
```ts
expect(typeof result.recommendations).toBe("number");
```
since the return value now contains the count, not the array.

For the investigation report itself, if there are assertions on `report.recommendations`, they should expect `AuditRecommendation[]` (which will be empty since the LLM call will fail in test without an API key — the `catch` returns `[]`).

- [ ] **Step 2: Run tests**

Run: `bun test tests/smoke/factory-investigate-script.test.ts 2>&1 | tail -15`
Expected: PASS

- [ ] **Step 3: Run all smoke tests to check for regressions**

Run: `bun test tests/smoke/factory-policy.test.ts tests/smoke/factory-chat-runner.test.ts tests/smoke/factory-task-packets.test.ts 2>&1 | tail -10`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add tests/smoke/factory-investigate-script.test.ts
git commit -m "Update tests for structured AuditRecommendation type"
```
