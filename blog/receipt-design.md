# Receipt: A New Structure for Agent Runtimes

Receipt is about how the runtime is put together.

A quick definition up front:

`Receipt` is the runtime.

A `receipt` is one durable record of something that happened during a run.

A receipt can capture:

- a user input
- an assistant output
- a tool call
- a tool observation
- a validation result
- a queue event
- a merge or rebracketing decision

Receipts are append-only and hash-linked, so a run becomes a chain of recorded steps.

The core choice is simple:

The run is durable.

The run is a chain of receipts.

Everything else is derived from that.

## Why this matters for agents

Agents accumulate more than outputs.

They accumulate tool calls, retries, validations, queued work, branch timelines, merge decisions, and UI state.

Giving the runtime a durable run gives the agent a few useful properties right away:

- it can reconstruct what happened
- it can rebuild state from the run
- it can project the same run into UI and inspection views
- it can branch and replay without losing causality
- it can keep control flow, coordination, and rebracketing inside the run itself

That is why the runtime works this way.

## The durable run

There are a few questions I want the system to answer cleanly:

- what exactly happened?
- what state was the agent in before this tool call?
- why did it retry here?
- can I fork from this point?
- can I prove this run really happened in this order?

In practice, the run grows by appending receipts for what happened, including run status changes, branch creation, and sub-run coordination.

Those receipts are immutable and hash-linked.

That chain is the run.

## State comes from receipts

In Receipt, state is derived by folding receipts.

That sounds small, but it changes everything.

It means:

- state can be rebuilt
- traces come from the same chain
- replay follows the recorded chain
- projections are disposable
- debugging starts from the same data the runtime used

The runtime starts with receipts and derives state on top.

## Projections come from the run

A projection is a derived view over the run.

That can be state, trace, queue status, a branch summary, or a UI.

UI is just one way to use a projection.

If you move to an earlier point in the run, a projection can fold that prefix and show what existed there.

If new receipts arrive, the projection updates from the appended run.

## Streams keep runs separate

The runtime uses stream families because long-lived agents need clear boundaries:

- `agents/<agentId>`
- `agents/<agentId>/runs/<runId>`
- `agents/<agentId>/runs/<runId>/branches/<branchId>`
- `agents/<agentId>/runs/<runId>/sub/<subRunId>`
- `jobs`
- `jobs/<jobId>`
- `memory/<scope>`

Runs stay isolated. Branches stay real. Sub-runs keep their own timelines. Queue state keeps its own lifecycle.

Memory is one stream family inside the system.

## Control flow belongs in the run

Another part of this matters too:

Control flow is visible in receipts.

If the runtime selects an action, pauses a run, completes a goal, rebrackets a merge, or moves a job through the queue, those decisions should show up in receipts too.

Receipt records control-plane activity in the same run as the rest of the runtime behavior.

## Rebracketing changes how timelines are composed

Rebracketing is one of the more interesting parts of Receipt.

Rebracketing means changing the parenthesization of how branch timelines get merged, without changing the receipts inside those timelines.

In multi-agent runs, branches create separate timelines.

Those timelines still need to be merged.

Receipt treats that composition order as part of the run itself.

The runtime can look at receipts, compute evidence, score candidate bracketings, and apply a new merge order during the run.

That changes how work flows through the run:

- which branch gets merged earlier
- which critique lands earlier
- which summaries shape the next round
- which branch interactions matter most

Why that is useful:

- important critique can reach the next round earlier
- strong branches can reinforce each other earlier
- weak branches can get corrected earlier
- the runtime can adapt its merge order to the evidence showing up in the run

In practice, merge order changes what becomes visible soon enough to matter.

That affects what later summaries contain, what gets carried forward, and how the next round is shaped.

Those decisions are part of the recorded run too.

Evidence, candidate scores, and the applied merge order can all live in receipts.

Receipt does not rewrite old receipts when it rebrackets.

The branch timelines stay intact.

The recorded run stays intact.

Rebracketing changes how future merge steps get composed.

That means:

- each branch keeps its own receipt chain
- the main run records the evidence and applied bracket
- later summaries follow the new merge order
- replay at any point shows the bracket that was active at that point
- forking from any point keeps the exact run up to that point

So replay and time travel still work cleanly.

You can inspect an earlier prefix of the run and see the actual timeline and merge state that existed there.

You can move forward and see where the bracket changed.

You can fork before or after a rebracket and get two different futures from the same recorded run.

That is why rebracketing fits Receipt.

## The queue uses the same receipt model

The queue follows the same receipt model too.

Jobs have their own lifecycle receipts:

- `job.enqueued`
- `job.leased`
- `job.heartbeat`
- `job.completed`
- `job.failed`
- `job.canceled`

You can inspect agent output, scheduling, retries, and aborts from the same run.

## Replay follows the run

Replay is how you check whether the runtime is clean.

Receipt is built so replay can explain:

- domain state
- control flow
- branching
- validation outcomes
- queue lifecycle

That is why the CLI has things like:

```bash
receipt trace <run-id>
receipt replay <run-id>
receipt fork <run-id> --at 12
receipt inspect <run-id>
```

These commands fall out of the runtime.

## Long-lived agents need durable runs

Once runs span multiple tool calls, retries, validations, queued work, delegated sub-runs, and multiple branches, "current state" stops being enough.

You need:

- durable runs
- causal structure
- inspectable control flow
- deterministic views
- branchable runs

That is what Receipt is trying to provide.

## The short version

Receipt is built around a few ideas:

- receipts are the durable truth
- state is derived by folding receipts
- projections are derived from receipts
- queue and control flow are receipt-derived
- merge and rebracketing decisions are receipt-derived
- replay reconstructs what happened and why

That is the runtime.

Repo: https://github.com/skishore23/receipt
