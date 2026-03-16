# Receipt

Receipt is version control for agent runs.

A receipt-native framework for long-lived agents. Every message, tool call, and control decision becomes an immutable, hash-linked receipt, so agents can be replayed, forked, inspected, and verified.

- facts are immutable, hash-linked receipts
- state is derived by folding receipts
- queue and control flow are receipt-derived
- replay reconstructs what happened and why



## Install

```bash
npm install
npm run build
```

## CLI

```bash
receipt new my-agent --template basic
receipt dev
receipt run theorem --problem "Prove a simple claim"
receipt run axiom --problem "Write a Lean proof and verify it"
receipt jobs
receipt abort <job-id>
receipt trace <run-id>
receipt replay <run-id>
receipt inspect <run-id>
receipt fork <run-id> --at 12
```

```bash
npm run eval:axiom:first
```

## Public SDK

```ts
import { defineAgent, receipt, action, assistant, tool, human, goal, merge, rebracket } from "./src/sdk/index.js";
```

## Stream model

Agent streams:

- `agents/<agentId>`
- `agents/<agentId>/runs/<runId>`
- `agents/<agentId>/runs/<runId>/branches/<branchId>`
- `agents/<agentId>/runs/<runId>/sub/<subRunId>`

Queue streams:

- `jobs` (index)
- `jobs/<jobId>` (authoritative job lifecycle)

## Architecture docs

- [architecture.md](./architecture.md)
- [docs/receipt-production-rfc.md](./docs/receipt-production-rfc.md)
- [docs/receipt-coding-runtime.md](./docs/receipt-coding-runtime.md)
- [docs/receipt-cli-mvp-architecture.md](./docs/receipt-cli-mvp-architecture.md)
- [docs/factory-on-receipt.md](./docs/factory-on-receipt.md)
- [docs/factory-on-another-repo.md](./docs/factory-on-another-repo.md)
- [docs/factory-agent-orchestration.md](./docs/factory-agent-orchestration.md)
- [docs/agent-framework.md](./docs/agent-framework.md)
- [docs/axiom-theorem-prover.md](./docs/axiom-theorem-prover.md)
- [docs/axiom-public-prover.md](./docs/axiom-public-prover.md)
- [docs/axiom-benchmark.md](./docs/axiom-benchmark.md)
- [docs/create-agent.md](./docs/create-agent.md)
- [docs/agenthub-on-receipt.md](./docs/agenthub-on-receipt.md)
- [docs/agenthub-prd.md](./docs/agenthub-prd.md)
- [docs/hub-dogfood.md](./docs/hub-dogfood.md)
- [docs/hub-codex-playbook.md](./docs/hub-codex-playbook.md)
- [docs/api/README.md](./docs/api/README.md)
- [docs/api/http.md](./docs/api/http.md)
- [docs/api/sse.md](./docs/api/sse.md)
- [docs/api/cli.md](./docs/api/cli.md)
- [docs/api/sdk.md](./docs/api/sdk.md)
- [docs/api/streams.md](./docs/api/streams.md)
- [docs/api/config.md](./docs/api/config.md)

## Hub vs Factory

`Factory` is the receipt-native objective execution system.

Use `/factory` for:

- creating objectives
- repo preparation and inferred validation defaults
- task DAG decomposition
- autonomous worker dispatch
- per-repo objective queueing and slot admission
- candidate review
- integration, validation, and promotion
- objective debugging, receipts, and runtime control

`Hub` still exists, but it is no longer the objective surface.

Use `/hub` for:

- repo and commit exploration
- workspaces
- manual tasks
- agents, channels, and posts
- operator/debug utilities that are not objective-specific

Short version:

- if you are running or debugging an autonomous software objective, use `Factory`
- if you are doing manual repo/team/workspace operations, you can still use `Hub`

## Multi-agent context management

In Receipt, rebracketing means dynamically changing merge parenthesization based on observed critique/patch interactions, not just trimming prompt history. This gives context management at composition-order level while preserving deterministic replay and auditability.


## Development

```bash
npm run dev
npm run hub:onboard
npm run test:smoke
```

The server auto-loads route modules from `src/agents/*.agent.ts`.

The factory objective surface is mounted at `/factory` and is the only objective control surface in v1.

Hub is mounted at `/hub` for repo/team/workspace/manual-task operations and can be bootstrapped with the default team in [config/hub-agents.json](./config/hub-agents.json).
