# Factory Worktree `bwrap --argv0` Failure Handoff

Date: 2026-03-28
Status: Open infrastructure incident
Scope: Factory software-agent and task-worktree sessions that fail before any shell command executes

## Summary

Affected Factory task sessions are failing before repo inspection begins. The common failure is:

```text
bwrap: Unknown option --argv0
```

When that happens, the worker cannot complete the normal bootstrap order:

- read `.receipt/factory/<taskId>.manifest.json`
- read `.receipt/factory/<taskId>.context-pack.json`
- run `.receipt/factory/<taskId>.memory.cjs`
- inspect mounted recent receipts

This is blocking access to the mounted packet and recent run receipts from inside the affected worktrees. The failure is deterministic at shell startup, not a one-off task error.

## Evidence

### 1. Current repo-local Factory status probe is healthy

On 2026-03-28, the repo-local CLI probe completed successfully:

```bash
bun src/cli.ts factory codex-probe --mode both --json --reply probe-ok
```

Observed result:

- direct path: completed with `probe-ok`
- queue path: completed with `probe-ok`

That means the Factory queue/status path is not universally broken in this repo checkout. The failure is environment-specific.

### 2. The executor is designed to fail closed on sandbox bootstrap errors

`LocalCodexExecutor` forwards sandbox mode directly to `codex exec` and does not add a retry-to-unsafe fallback when sandbox bootstrap fails.

- [`src/adapters/codex-executor.ts`](/Users/kishore/receipt/src/adapters/codex-executor.ts#L376) chooses the sandbox mode.
- [`src/adapters/codex-executor.ts`](/Users/kishore/receipt/src/adapters/codex-executor.ts#L404) passes either `--sandbox <mode>` or `--dangerously-bypass-approvals-and-sandbox`.
- [`tests/smoke/codex-executor.test.ts`](/Users/kishore/receipt/tests/smoke/codex-executor.test.ts#L645) explicitly covers `bwrap: Unknown option --argv0`.
- [`tests/smoke/codex-executor.test.ts`](/Users/kishore/receipt/tests/smoke/codex-executor.test.ts#L676) asserts there is no retry with `danger-full-access`.

### 3. Shared repo memory shows repeated cross-objective failures

Repo-shared Factory memory contains repeated blocked tasks with the same launcher failure. Sample incidents:

- 2026-03-24: `objective_mn4jivv6_261zwg/task_01`
- 2026-03-25: `objective_mn6d2jwf_wgt7qr/task_01`
- 2026-03-25: `objective_mn6d2jwf_wgt7qr/task_02`
- 2026-03-26: `objective_mn7yiydb_2yrv80/task_01`
- 2026-03-26: `objective_mn827u6a_4ensn3/task_01`
- 2026-03-26: `objective_mn827u6a_4ensn3/task_02`
- 2026-03-27: `objective_mn8cjwoc_0joj0r/task_01`
- 2026-03-27: `objective_mn8etnso_ityha4/task_01`
- 2026-03-27: `objective_mn8kyx7c_5nn765/task_02`

These entries consistently report that even trivial commands such as `pwd`, `true`, `cat AGENTS.md`, or `bun .receipt/factory/task_01.memory.cjs ...` fail before execution with the same `bwrap` error.

### 4. This local worktree is not itself the failing session

The currently mounted `.receipt/factory` folder only contains a result file, and that result shows the generated memory script had already run successfully in an earlier candidate:

- [`.receipt/factory/task_01.result.json`](/Users/kishore/receipt/.receipt/factory/task_01.result.json#L2) reports `approved`
- [`.receipt/factory/task_01.result.json`](/Users/kishore/receipt/.receipt/factory/task_01.result.json#L7) shows `task_01.memory.cjs context 1800` succeeded

So this checkout can inspect the repo normally; it is not the same failing worktree session described in the blocked task notes.

## Likely Root Cause

The strongest current hypothesis is an environment compatibility mismatch between the failing worker runtime and the installed `bubblewrap` binary on that host or image.

Why this is the leading hypothesis:

- the error is emitted by `bwrap`, not by Receipt code
- the repo does not pass `--argv0` itself; it shells out to `codex exec`
- upstream `bubblewrap` documentation includes `--argv0`, so `Unknown option --argv0` strongly suggests an older or incompatible `bwrap` build in the affected environment
- the same repo and same probe path succeed in this local environment, so the failure is not a universal application regression

## Impact

- Affected task sessions cannot read the task packet.
- Affected task sessions cannot run the generated memory script.
- Affected task sessions cannot inspect mounted receipts from inside the worktree.
- Validation commands such as `bun run build` never start.
- Factory receives blocked or partial worker outcomes that look like task failures, but the underlying issue is launcher infrastructure.

## Immediate Mitigation

1. Treat this as an execution-environment incident, not as a repo-task incident.
2. Route critical objectives through a known-good environment where `bun src/cli.ts factory codex-probe --mode both --json --reply probe-ok` succeeds.
3. On a failing host or image, capture:
   - `codex --version`
   - `bwrap --version`
   - `which bwrap`
   - the exact sandbox launcher command or wrapper args
4. Upgrade or replace the incompatible `bubblewrap` package in the failing environment, or switch that environment to a launcher path that does not rely on unsupported `bwrap` flags.
5. Re-run one of the previously blocked objectives after the environment fix and verify that basic commands such as `pwd` and `bun .receipt/factory/<taskId>.memory.cjs context 2800` succeed before resuming normal delivery.

## Follow-Up Engineering Work

If the environment fix is outside this repo, the codebase still has two useful follow-ups:

1. Add explicit operator-facing diagnostics when sandbox startup fails with a known incompatibility string like `bwrap: Unknown option --argv0`.
2. Add a targeted preflight probe in Factory runtime diagnostics that records host sandbox compatibility before dispatching a full task.

## Owner Handoff

Primary owner: whoever manages the failing Factory worker image or local Codex tool-runner environment.

Repo-side owner: Factory/Codex integration maintainers for diagnostics and operator messaging.

Do not treat this as evidence that the Factory objective graph, receipts, or queue are generally unhealthy. Current evidence points to a host-specific sandbox launcher incompatibility.
