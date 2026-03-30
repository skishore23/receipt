# Factory Self-Improvement And Experiments (Pre-Mainline)

This document describes the Factory work that was implemented and exercised before the changes were consolidated onto `main`.

It is intentionally about the implementation and experiments themselves, not about the later branch cleanup or mainline sync.

## What Was Implemented

### 1. Context And Handoff Repair

The first problem was context quality. Historical receipts showed that task packets were often relevant, but later steps lost durable handoff context. The main issues were:

- downstream publish/integration steps receiving too little context
- investigation and integration memory missing explicit `Handoff` sections
- worker packets relying too heavily on large JSON blobs instead of text-first summaries
- duplicated `contextRefs`
- repo-shared and agent-shared memory being polluted with run-specific summaries

The implementation changed that in several ways:

- task packets now prefer a text-first worker path:
  - prompt
  - `task.context.md`
  - `task.memory.cjs`
  - raw `task.context-pack.json` only as fallback state
- context packs were trimmed so they keep summary/guidance and queryable scope, not bulky raw inventory when that inventory is not needed
- integration and publish memory now write structured `Summary` and `Handoff` sections
- investigation memory now writes explicit `Handoff` sections
- publish prompts now include a controller-side context snapshot with handoff and recent relevant receipts
- shared memory promotion was tightened so task-result summaries do not automatically spill into `factory/repo/shared` or `factory/agents/*`

### 2. Receipt Investigation CLI

A new investigation path was added so humans and agents can reconstruct what happened from receipts in a text-first way.

The core command is:

```bash
receipt factory investigate <objectiveId|taskId|candidateId|jobId|runId>
receipt factory investigate latest
receipt factory investigate <id> --json
```

It produces:

- what happened
- focused context
- DAG flow
- task, candidate, job, and run summaries
- anomalies and recommendations
- a timeline
- a run assessment

The assessment answers questions such as:

- verdict
- easy-route risk
- efficiency
- control churn
- proof present vs missing
- repo diff produced vs avoided
- follow-up validation done vs skipped
- intervention required vs not required
- operator guidance applied vs not applied
- course correction worked vs did not work

### 3. Receipt Audit CLI

A repo-level audit command was added on top of `investigate`:

```bash
receipt factory audit --limit 20
receipt factory audit --json
receipt factory audit --objective <objectiveId>
```

The audit aggregates recent or targeted objectives and reports:

- verdict counts
- easy-route risk counts
- efficiency and churn
- anomaly categories
- memory hygiene
- repo-level improvement signals

Targeted mode was added later so a single known objective can be audited directly without sampling a recent window.

### 4. Automated Background Self-Audit

The audit path was then built into Factory itself.

When an objective reaches a terminal state, Factory now enqueues a background `factory.objective.audit` job that:

- reconstructs the objective from receipts
- writes `objective.audit.json`
- writes `objective.audit.md`
- commits compact audit summaries into memory

Dedicated audit memory scopes were added:

- `factory/audits/objectives/<objectiveId>`
- `factory/audits/repo`

This is the core self-improvement loop: the system now publishes its own run-quality metrics from receipts instead of relying only on manual postmortems.

### 5. Live Intervention And Long-Run Experiment Support

Factory job guidance was made real, not cosmetic.

New CLI surfaces were added:

```bash
receipt factory steer <job-id> --message "<text>"
receipt factory follow-up <job-id> --message "<text>"
```

The runtime was extended so active task jobs actually consume:

- `abort`
- `steer`
- `follow_up`

Behavior added in the runtime:

- poll live commands while a task is running
- coalesce pending live notes
- append guidance under a dedicated `## Live Operator Guidance` section
- rewrite the prompt artifact before restart
- restart the task loop without losing the same workspace or candidate lineage
- emit explicit intervention receipts so `investigate` can prove that course correction happened

### 6. Long-Run Evidence Experiment Harness

A deterministic long-run experiment command was added:

```bash
receipt factory experiment long-run
```

Its purpose is to prove that Factory can:

- start a long-running repo task
- accept live guidance
- restart cleanly
- produce a real repo change
- validate it
- write an evidence bundle

The bundle includes:

- summary
- transcript
- investigate output
- audit output
- timeline
- artifact paths

### 7. Controller-Side Delivery Partial Repair

During the autonomous experiment work, a controller bug showed up: delivery workers could return `outcome: "partial"` even when the controller had enough proof and passing checks to finish autonomously.

The controller was updated so a delivery partial can be cleared when:

- there is a real repo diff
- proof is present
- controller-side checks pass
- the remaining uncertainty is only controller-resolvable validation or cleanup noise

This reduced false blocking for otherwise valid delivery runs.

## Experiment Timeline

### A. Historical Receipt Audit

Older receipts were audited first to understand the failure modes.

The main findings were:

- task-level packets were usually relevant
- downstream handoff memory was thin or missing
- context sometimes contained unrelated cloud inventory
- control-loop churn and lease expiry were major recurring problems
- shared memory was polluted with run-specific entries

That work drove the context, memory, and audit changes above.

### B. Live Intervention Proof

An early experiment proved that Factory could apply live intervention and restart active work.

Objective:

- `objective_mncpuewv_97ucef`

What it proved:

- live interventions were recorded
- live restarts happened
- proof and repo diff were captured

What it did not prove:

- clean terminal success, because the run ended blocked on unrelated validation outside the feature scope

### C. Follow-Up Objective For Live Guidance Docs

A follow-up objective corrected the live-guidance documentation path and completed successfully.

Objective:

- `objective_mncqjk8w_1d7nqs`

What it showed:

- a receipt-managed objective could complete, integrate, and promote cleanly for that narrower change

### D. Strict Autonomous Receipt Objective

The most important experiment was the self-contained autonomous delivery objective:

- `objective_mncrzmmt_w9fwp3`

Goal:

- run a real delivery objective under Receipt
- make a real repo change
- validate it
- integrate it
- publish a PR
- let external Codex monitor only after the real run started

Actual task objective:

- add `receipt factory audit --objective <objectiveId>`

What the run did:

- 1 task
- 1 candidate pass
- 5 jobs
- completed successfully
- integrated and promoted
- published a PR
- received a `strong` investigation verdict with `low` easy-route risk

Important caveat:

- the published PR branch also contained a sandbox baseline commit from pre-run setup, so the PR diff was not a clean proof artifact even though the objective itself did the correct narrow task

That contamination was an experiment packaging problem, not a task-execution problem.

## Automated Tests That Were Run Before Mainline Consolidation

The following automated checks were run during implementation and experiment hardening before the work was moved onto `main`.

### Targeted Smoke And Policy Checks

These were used while landing specific context, memory, audit, and controller fixes:

```bash
bun test tests/smoke/factory-memory.test.ts
bun test tests/smoke/factory-policy.test.ts
bun test tests/smoke/factory-memory.test.ts tests/smoke/factory-investigation.test.ts tests/smoke/factory-policy.test.ts
bun test tests/smoke/factory-investigate-script.test.ts
bun test tests/smoke/factory-investigate-script.test.ts tests/smoke/cli.test.ts
```

### Typecheck And Feature-Specific Verification

These were run while wiring live guidance and autonomous delivery behavior:

```bash
bun x tsc --noEmit
bun test tests/smoke/factory-cli.test.ts -t "factory cli: steer and follow-up queue structured guidance commands"
bun test tests/smoke/factory-cli.test.ts -t "factory cli: composer parser handles plain text and slash commands"
bun test tests/smoke/factory-cli.test.ts -t "factory cli: composer metadata exposes steer and follow-up commands in help surfaces"
```

### Controller Partial-Repair Validation

After the controller-side partial-resolution logic was added, the following were run:

```bash
bun x tsc --noEmit
bun test tests/smoke/factory-policy.test.ts -t "factory policy: controller can clear delivery partials when repo checks resolve validation-only uncertainty|factory policy: promotion gate blocks when task completion reports remaining work|factory policy: software delivery objectives auto-publish and expose PR metadata"
```

### Final Pre-Mainline Validation Sweep

Before the work was consolidated, the broader Factory validation sweep was run:

```bash
bun x tsc --noEmit
bun test tests/smoke/factory-cli.test.ts -t "factory cli: audit supports a targeted objective without changing the recent-window flow|factory cli: steer and follow-up queue structured live guidance commands|factory cli: composer parser handles plain text and slash commands|factory cli: composer parser rejects job commands without a selected objective|factory cli: composer metadata exposes steer and follow-up commands in help surfaces"
bun test tests/smoke/factory-cli.test.ts tests/smoke/factory-investigate-script.test.ts tests/smoke/factory-memory.test.ts tests/smoke/factory-policy.test.ts tests/smoke/factory-experiment.test.ts
```

Result of the final broad sweep:

- `62 pass`
- `0 fail`

## What The Self-Improvement Loop Now Does

The self-improvement path is now:

1. Factory runs an objective and records receipts.
2. On terminal state, Factory runs an objective audit in the background.
3. The audit writes objective artifacts and audit memory.
4. Humans or agents can inspect a single run with `factory investigate`.
5. Humans or agents can inspect trends with `factory audit`.
6. The assessment makes route quality explicit:
   - did the run produce proof
   - did it produce a real repo diff
   - did it validate
   - was intervention required
   - did course correction work
   - did the run look weak, churn-heavy, or easy-route-prone
7. Memory hygiene is measured explicitly so shared memory can stay reusable instead of turning into a dump of per-run summaries.

## Known Lessons From The Pre-Mainline Work

- clean experiment baselines matter; a contaminated sandbox base makes PR evidence misleading even when the objective itself behaves correctly
- Receipt is strongest when the controller owns context, validation, audit, promotion, and publish, and the worker stays scoped to the task itself
- text-first context plus durable handoff memory is much easier for both humans and agents to consume than large raw JSON packets
- receipt-derived audit signals are useful enough to serve as a real self-improvement surface, not just a debugging aid
