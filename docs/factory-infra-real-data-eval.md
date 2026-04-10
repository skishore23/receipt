# Factory Infrastructure Real-Data Evaluation Plan

Status: proposed  
Audience: operators and engineering  
Scope: measure whether Receipt-backed infrastructure agents produce strong outputs, finish work, avoid getting stuck, and generalize beyond narrow canned cases

## Why this plan exists

We want to evaluate four things on real runs:

1. output quality
2. task completion
3. anti-stall behavior
4. non-hardcoded generalization

This plan uses the repo's existing evaluation surfaces instead of inventing a parallel framework:

- `receipt factory run|create|resume`
- `receipt factory investigate`
- `receipt factory audit`
- `receipt dst`
- `receipt factory experiment long-run`
- `skills/factory-helper-runtime/runner.py`

## Baseline from current real repo data

Current repo evidence already gives us a useful baseline:

- `receipt factory audit --limit 10 --json` on April 10, 2026 sampled 10 objectives:
  - 5 `weak`
  - 4 `strong`
  - 1 `mixed`
  - 5 `efficient`
  - 4 `noisy`
  - 1 `churn-heavy`
- The most common failure patterns in that sample were:
  - repeated control jobs on the same objective session
  - terminal-state publish/control churn
  - missing alignment or validation artifacts
- `receipt dst --json` over the current data store reported:
  - 17,280 streams scanned
  - 0 integrity failures
  - 0 replay failures
  - 0 deterministic failures

That means the receipt substrate itself looks healthy right now. The evaluation focus should be run behavior and worker quality, not stream corruption.

## What to measure

Score each run on four axes.

### 1. Output quality

A strong run should:

- use the right helper or AWS API family for the question
- return evidence, not generic advice
- keep the conclusion proportional to the data collected
- include a bounded handoff with remaining gaps if the environment blocks completion

Primary signals:

- `assessment.verdict`
- `assessment.proofPresent`
- `assessment.alignmentVerdict`
- `followUpValidation`
- presence of `scriptsRun`, `completion.proof`, and concrete artifacts in the result

### 2. Task completion

A strong run should end in the correct terminal state:

- `completed` when the question is answerable from the mounted data and permissions
- `blocked` only when the blocker is real, explicit, and operator-actionable

Primary signals:

- objective status from `factory inspect` / `factory investigate`
- `completion.remaining`
- terminal objective summary quality
- whether the run reached a terminal state inside the budget

### 3. Anti-stall behavior

A strong run should make progress without controller churn.

Primary signals:

- `assessment.efficiency`
- `assessment.controlChurn`
- anomaly counts for:
  - `job_failed`
  - `job_stalled`
  - `lease expired`
  - `repeated_control_job`
  - `objective_blocked`
- time to first evidence command
- total run duration

### 4. Non-hardcoded generalization

A strong run should survive prompt paraphrases and target changes.

Primary signals:

- same scenario asked with different wording still reaches similar evidence and conclusion
- region/account/resource changes do not cause placeholder invention
- helper choice changes appropriately by prompt shape
- outputs remain grounded in live evidence instead of canned text

## Test structure

Run each scenario in three prompt variants:

1. canonical
2. paraphrased
3. noisy but still valid

Run each variant against at least two different real targets when available:

- different AWS account or profile
- different region
- different resource family

This gives a minimum batch size of 9 runs for the first wave.

## Start with these 3 medium questions

These are medium difficulty because they require real evidence collection, some synthesis, and a concrete answer, but they do not require open-ended remediation.

### Scenario 1: S3 exposure inventory

Prompt:

`Investigate our current S3 bucket exposure posture in the active AWS account. Identify buckets that appear public or weakly protected, include region, encryption, versioning, and public-access signals, and finish with the 3 highest-risk buckets plus why they are risky. Do not change infrastructure.`

Why this is a good test:

- requires real AWS data
- should use checked-in helper(s), not ad hoc scripting
- forces prioritization instead of dumping raw inventory
- easy to detect hardcoding if it invents bucket names or canned risks

Likely helper path:

- `aws_account_scope`
- `aws_s3_bucket_inventory`
- optionally `aws_policy_or_exposure_check`

### Scenario 2: EC2 or NAT cost spike triage

Prompt:

`Investigate whether EC2 compute or NAT Gateway is driving the biggest recent cost spike in this AWS account. Use recent billing evidence, identify the likely spike window, name the top contributing region or dimension, and tell me what data you would check next if the first pass is inconclusive. Do not make changes.`

Why this is a good test:

- forces the agent to choose between overlapping cost helpers
- requires explanation of uncertainty instead of false precision
- tests whether the agent can stop after enough evidence rather than wandering

Likely helper path:

- `aws_cost_explorer_billing_summary`
- `aws_ec2_compute_cost_spike` or `nat_gateway_cost_spike`
- optionally `aws_region_scope`

### Scenario 3: ECS-on-EC2 workload inventory with alarm context

Prompt:

`Show me which ECS workloads are currently running on EC2, grouped by region and cluster, and tell me whether any related CloudWatch alarms are already in ALARM state for those regions. Keep the answer compact and evidence-first. Do not change infrastructure.`

Why this is a good test:

- requires joining two different evidence sources
- checks whether the agent can stay compact while still grounded
- exposes hardcoding if it assumes EKS, Fargate, or fake cluster names

Likely helper path:

- `aws_ecs_ec2_container_inventory`
- `aws_alarm_summary`

## How to run a batch

For each scenario variant:

```bash
bun src/cli.ts factory run \
  --profile infrastructure \
  --objective-mode investigation \
  --severity 2 \
  --prompt "<scenario prompt>"
```

After the run reaches terminal state:

```bash
bun src/cli.ts factory investigate <objective-id> --json > /tmp/<objective-id>.investigate.json
bun src/cli.ts factory audit --objective <objective-id> --json > /tmp/<objective-id>.audit.json
```

At the end of the batch:

```bash
bun src/cli.ts factory audit --limit 20 --json > /tmp/factory-batch-audit.json
bun src/cli.ts dst --context --strict --json > /tmp/factory-batch-dst.json
```

Use `receipt factory experiment long-run --json` once per batch as a control probe for live guidance and course-correction behavior. That experiment is not an infrastructure scenario, but it is useful for validating the "doesn't get stuck" and "responds to operator steering" parts of the system.

## Scoring rubric

Use a 0-2 score per category.

### Output quality

- `2`: evidence-backed, concise, specific, correct helper usage, aligned conclusion
- `1`: partially grounded but missing prioritization, proof, or clarity
- `0`: generic, invented, or weakly evidenced

### Completion

- `2`: correct terminal state with actionable closure
- `1`: reached terminal state but closure is weak or incomplete
- `0`: never reached a useful terminal state

### Anti-stall

- `2`: efficient, low churn, no lease or duplicate-control anomalies
- `1`: completed but with noisy progress or minor control churn
- `0`: stalled, lease-expired, or blocked for avoidable runtime reasons

### Generalization

- `2`: paraphrases and target swaps preserve quality
- `1`: some sensitivity to wording or target shape
- `0`: clearly overfit to one prompt form or resource type

Maximum score per run: `8`

Recommended interpretation:

- `7-8`: ready
- `5-6`: usable but needs hardening
- `0-4`: not reliable enough for real operator use

## Failure patterns to call out immediately

Fail the run even if it produced some output when any of these appear:

- invented AWS resource identifiers
- recommendations that are not supported by collected evidence
- no `scriptsRun` or proof despite required checks
- `alignmentVerdict=not_reported` on a delivery-style evaluation
- repeated control jobs for the same session
- lease expiry without a strong terminal handoff

## Analysis template

Use this template for each objective:

- objective id
- scenario id
- prompt variant
- aws profile/account/region scope
- objective status
- verdict
- efficiency
- control churn
- proof present
- alignment verdict
- follow-up validation status
- anomalies
- helpers used
- key evidence collected
- final answer quality summary
- blocker quality summary if blocked
- score out of 8

## What success looks like after the first 9 runs

The first wave should show:

- at least 7 of 9 runs reaching the correct terminal state
- at least 6 of 9 runs scoring `6+`
- zero invented resource names
- zero DST context failures for the audited batch
- lower incidence of:
  - repeated control jobs
  - lease expiry
  - missing proof/alignment artifacts

If that bar is not met, use `receipt factory investigate` on the failed objectives first, then use `receipt factory audit` to cluster the repeated causes before changing prompts or helpers.
