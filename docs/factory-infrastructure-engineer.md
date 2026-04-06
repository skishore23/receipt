# Factory Infrastructure Engineer

Status: Implemented design guide  
Audience: Repo customizers and operators  
Scope: How to build a CLI-native infrastructure engineer on Receipt using Factory, Codex task workers, AWS CLI, and severity-based operating modes

## Purpose

This document explains how to build an infrastructure engineer on top of Receipt without leaving the CLI.

The goal is:

- use `receipt factory` as the operator surface
- use Codex as the worker that writes code and runs scripts
- use AWS CLI inside task worktrees with preconfigured credentials
- keep orchestration, audit, and retry behavior receipt-backed
- support multi-agent execution with different safety envelopes for routine work through P0 response

## The Short Version

The clean model is:

- Factory profile or CLI command acts as the supervisor
- Factory objectives hold the durable work plan
- Factory decomposes the objective into tasks
- Codex executes each task inside an isolated worktree
- task workers can edit IaC, shell scripts, runbooks, and repo automation
- task workers can run `aws` and repo scripts in the local shell environment
- receipts, memory, and objective state remain the audit trail

The current implementation also mounts repo execution context for Codex before task work starts:

- `receipt factory init` and repo-profile generation emit a repo skill that maps execution tooling, auth surfaces, policy surfaces, notable paths, and guardrails
- objective packets and direct Codex probe packets include that execution and permissions landscape so workers do not have to guess the repo's operational shape
- supervisor prompts now tell Codex to read mounted repo skills before making permission-sensitive claims

For infrastructure work, keep the control plane and the execution plane separate:

- use the parent Factory flow for orchestration, dispatch, retries, review, and promotion
- use child Codex task runs for actual code changes and shell execution
- use direct probe paths only for read-only evidence gathering

Current planning note:

- automatic multi-task decomposition and action selection use the structured planner path when `OPENAI_API_KEY` is available
- without that planner, Factory falls back to a single deterministic task
- you can still run a safe CLI workflow without OpenAI, but multi-agent depth becomes more manual

## Why This Should Stay CLI-Native

Receipt already has the right CLI seams for this:

- `receipt factory run` to create and stay attached to an objective
- `receipt factory create` to queue work and return immediately
- `receipt factory inspect` to inspect overview, report, tasks, live state, receipts, or debug data
- `receipt factory react` to steer the next pass
- `receipt factory promote` to advance validated integration output
- `receipt factory cleanup` and `receipt factory archive` to close work cleanly
- `receipt trace`, `receipt replay`, and `receipt inspect` to inspect raw receipt streams when needed

That means you do not need a separate orchestration UI to build an infra engineer. The web surface can remain optional. The primary operator workflow can stay in the terminal.

The infrastructure path now exposes a first-class report view:

- `receipt factory run --profile infrastructure --objective-mode investigation --severity 2 --prompt "..."`
- `receipt factory inspect <objective-id> --panel report`
- `receipt factory watch <objective-id> --panel report`

## Core Design

### 1. Use a Factory profile as the supervising infrastructure lead

Create a new profile at `profiles/infrastructure/PROFILE.md`.

The profile should:

- behave like a supervising infra lead, not a shell script that chats
- inspect objective state before reacting
- create objectives for code-changing work
- use async child work for parallel tasks
- keep answers concise and operator-facing
- treat AWS CLI as part of the task worker contract, not the chat-layer contract

Recommended frontmatter:

```md
---
{
  "id": "infrastructure",
  "label": "Infrastructure",
  "capabilities": [
    "memory.read",
    "skill.read",
    "status.read",
    "async.dispatch",
    "async.control",
    "objective.control",
    "profile.handoff"
  ],
  "handoffTargets": [
    "generalist",
    "software"
  ],
  "routeHints": [
    "aws",
    "iam",
    "vpc",
    "eks",
    "ecs",
    "rds",
    "terraform",
    "cloudformation",
    "incident",
    "outage",
    "latency"
  ],
  "skills": [
    "skills/factory-run-orchestrator/SKILL.md"
  ],
  "mode": "supervisor",
  "discoveryBudget": 1,
  "suspendOnAsyncChild": false,
  "allowPollingWhileChildRunning": true,
  "finalWhileChildRunning": "reject",
  "childDedupe": "by_run_and_prompt",
  "objective": {
    "defaultWorker": "codex",
    "maxParallelChildren": 4,
    "defaultMode": "investigation",
    "defaultSeverity": 2
  }
}
---
```

Use `codex` as the default worker today. That matches the current runtime, and the profile defaults infrastructure work to investigation mode at severity `2`.

### 2. Keep code-changing delivery inside Factory objectives

The parent profile should not mutate the repo directly.

For code-changing or AWS-changing work:

- create or react a Factory objective
- let Factory decompose the work into tasks
- let Codex execute each task in a task worktree
- use validation and promotion from the objective lifecycle

This is already the model described by the current Factory implementation:

- the profile/orchestrator layer is orchestration-only
- task execution is the delivery path
- direct `codex.run` is for read-only inspection, not tracked delivery

### 3. Treat AWS CLI as part of the worker contract

If credentials are already configured, the Codex worker can inherit the shell environment and use:

- `aws`
- repo scripts under `scripts/infra/` or `bin/`
- IaC toolchains such as Terraform, CDK, Pulumi, or CloudFormation wrappers

Recommended rules:

- prefer committed scripts over long inline shell commands
- prefer `aws ... --output json`
- keep region/account selection explicit
- keep destructive actions behind repo scripts with guard flags
- never store secrets, session tokens, or raw credential material in receipts or memory
- summarize high-signal output in the final handoff instead of dumping large command logs into durable memory

Good repo-native wrappers usually look like:

- `scripts/infra/inventory.sh`
- `scripts/infra/plan.sh`
- `scripts/infra/apply.sh`
- `scripts/infra/rollback.sh`
- `scripts/infra/validate.sh`

That lets Codex edit the scripts, run them, and hand back a bounded summary with reproducible commands.

### 4. Prefer IaC changes over direct live mutation

Receipt and Factory give you durable orchestration and Git-backed code promotion. They do not magically make direct AWS mutations safe.

The safest default is:

- use AWS CLI for evidence gathering, drift checks, health checks, and narrow operational actions
- use committed IaC and repo scripts for intended infrastructure changes
- treat live AWS mutations as explicit high-risk tasks with extra validation and human gating

Promotion in Factory is Git promotion. It is not a second approval layer for live AWS side effects that already happened inside a task.

## Multi-Agent Pattern

The recommended multi-agent pattern is:

1. One supervising Factory profile or CLI session owns the objective.
2. Factory decomposes the objective into a small DAG of tasks.
3. Codex runs those tasks in isolated worktrees.
4. If safe, multiple child tasks run in parallel.
5. The supervisor inspects receipts and live state, then reacts or promotes.

Use the roles below:

- Supervisor: Factory profile or `receipt factory` CLI operator flow
- Investigator: read-only probe or evidence task
- Implementer: Codex task that edits IaC or scripts
- Validator: Codex task or integration validation command that runs checks
- Commander: human operator who decides react, promote, cancel, or archive

For CLI-first usage, objective decomposition is the better multi-agent mechanism than ad hoc subagent chatter. It is durable, inspectable, and already tied into worktrees, review state, and integration.

## Severity Model

Map your 1-5 levels to Factory policy and operating behavior, not just prose labels.

| Level | Use case | Concurrency | Mutation policy | Promotion | AWS action envelope |
| --- | --- | --- | --- | --- | --- |
| 1 Basic | Single-service, low blast radius | 1 child | conservative | optional auto-promote for repo-only changes | read, diff, narrow apply |
| 2 Intermediate | Multi-service, time-pressured incident response | 2 children | conservative | manual promote | focused remediation with targeted checks |
| 3 Advanced | Fleet-wide automation or orchestration | 3-4 children | balanced | manual promote | staged rollout only |
| 4 Expert | Multi-region architecture, RTO/RPO-sensitive | 2 children | conservative | manual promote | plan and validate first, region sequencing |
| 5 Critical | P0 or active threat response | 1 mutation lane plus optional read-only evidence tasks | conservative or off | manual promote only | explicit human gate for every destructive action |

Recommended interpretation:

- increase concurrency only when the blast radius is well partitioned
- reduce mutation aggressiveness as real-world risk rises
- keep `autoPromote` off for anything that could have production impact
- separate evidence collection from remediation for level 4-5 work

## Suggested Policy Presets

Level 1 example:

```json
{
  "concurrency": { "maxActiveTasks": 1 },
  "budgets": {
    "maxTaskRuns": 8,
    "maxCandidatePassesPerTask": 2,
    "maxObjectiveMinutes": 90
  },
  "throttles": {
    "maxDispatchesPerReact": 1,
    "mutationCooldownMs": 30000
  },
  "mutation": { "aggressiveness": "conservative" },
  "promotion": { "autoPromote": false }
}
```

Level 3 example:

```json
{
  "concurrency": { "maxActiveTasks": 4 },
  "budgets": {
    "maxTaskRuns": 24,
    "maxCandidatePassesPerTask": 3,
    "maxObjectiveMinutes": 360
  },
  "throttles": {
    "maxDispatchesPerReact": 3,
    "mutationCooldownMs": 20000
  },
  "mutation": { "aggressiveness": "balanced" },
  "promotion": { "autoPromote": false }
}
```

Level 5 example:

```json
{
  "concurrency": { "maxActiveTasks": 1 },
  "budgets": {
    "maxTaskRuns": 40,
    "maxCandidatePassesPerTask": 4,
    "maxObjectiveMinutes": 720
  },
  "throttles": {
    "maxDispatchesPerReact": 1,
    "mutationCooldownMs": 60000
  },
  "mutation": { "aggressiveness": "off" },
  "promotion": { "autoPromote": false }
}
```

Store these as JSON files and pass them with `--policy-file`.

## CLI Workflow

Initialize Factory once for the repo:

```bash
receipt factory init
```

Run a level 1 objective:

```bash
receipt factory run \
  --profile infrastructure \
  --title "Rotate expiring ACM certificate for internal ALB" \
  --prompt "Inspect the current ACM certificate, update the repo automation if needed, run targeted validation, and prepare the safe rollout steps." \
  --policy-file policies/infra-level-1.json \
  --check "scripts/infra/validate.sh"
```

Run a level 3 objective:

```bash
receipt factory create \
  --profile infrastructure \
  --title "Roll out standardized CloudWatch alarms across services" \
  --prompt "Implement the alarm baseline across the fleet, update IaC or generator code, validate against sample services, and stage the rollout plan." \
  --policy-file policies/infra-level-3.json \
  --check "scripts/infra/validate.sh"
```

Inspect live state:

```bash
receipt factory inspect <objective-id> --json --panel overview
receipt factory inspect <objective-id> --json --panel tasks
receipt factory inspect <objective-id> --json --panel live
receipt factory inspect <objective-id> --json --panel receipts
receipt factory inspect <objective-id> --json --panel debug
```

Steer the next pass:

```bash
receipt factory react <objective-id> \
  --message "Continue, but keep all AWS mutations in us-west-2 behind dry-run evidence first."
```

Promote validated integration output:

```bash
receipt factory promote <objective-id>
```

Clean up worktrees after completion:

```bash
receipt factory cleanup <objective-id>
receipt factory archive <objective-id>
```

## Prompting Rules For Infra Objectives

Good infra prompts are concrete about:

- the AWS surface area
- whether the task is read-only, code-changing, or live-mutating
- the account and region boundaries
- the expected repo artifacts to edit
- the validation command
- the rollback or stop condition

Good prompt shape:

```text
Investigate elevated 5xx errors on the public ALB in prod-us-west-2. Gather evidence with AWS CLI first. If the likely fix is in the repo, update the relevant IaC or operational script, run targeted validation, and prepare a conservative rollout. Do not perform destructive AWS actions without explicit evidence and a follow-up operator note.
```

Bad prompt shape:

```text
Fix AWS.
```

## Repo Changes To Make

To support this cleanly, add:

1. `profiles/infrastructure/PROFILE.md`
2. policy presets such as `policies/infra-level-1.json` through `policies/infra-level-5.json`
3. repo-owned AWS wrappers under `scripts/infra/`
4. validation commands that prove infra code health without requiring a full production action
5. optional repo skill files that teach the worker your AWS layout, account map, service boundaries, and deployment rules

If you need stricter AWS guidance in every task packet, the current prompt seam is in `src/services/factory/prompt-rendering.ts`, where Factory renders the task prompt and validation guidance for Codex workers.

## Important Current Implementation Caveat

Today, the safest implementation is to keep `objective.defaultWorker` set to `codex`.

Why:

- `infra` is already a recognized worker type in objective policy
- worktree naming and memory scopes can carry an `infra` label
- but the current background job runtime only has a concrete Factory task executor for the Codex lane

So if you want a distinct `infra` execution lane later, add it deliberately instead of only changing profile metadata.

That means updating:

- `src/services/factory-runtime.ts`
- `src/server.ts`

The first version should keep one executor lane:

- supervisor = infrastructure profile
- delivery worker = Codex
- shell/tool contract = AWS CLI plus repo scripts

## Recommended Rollout Plan

1. Add the infrastructure profile.
2. Add severity policy JSON files.
3. Move AWS knowledge into committed scripts and repo skills.
4. Start with `defaultWorker: "codex"` and objective-managed task execution.
5. Prove level 1 and level 2 workflows first.
6. Add level 3 parallelism only after validation and rollback scripts are reliable.
7. Add a distinct `infra` worker handler only if you need different runtime policy, leasing, or executor behavior from Codex.

That gives you a CLI-native infrastructure engineer that can still write code, run scripts, use AWS CLI, and operate as a receipt-backed multi-agent system.
