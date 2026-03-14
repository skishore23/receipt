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
- [docs/agent-framework.md](./docs/agent-framework.md)
- [docs/axiom-theorem-prover.md](./docs/axiom-theorem-prover.md)
- [docs/axiom-public-prover.md](./docs/axiom-public-prover.md)
- [docs/axiom-benchmark.md](./docs/axiom-benchmark.md)
- [docs/create-agent.md](./docs/create-agent.md)
- [docs/agenthub-on-receipt.md](./docs/agenthub-on-receipt.md)
- [docs/agenthub-prd.md](./docs/agenthub-prd.md)
- [docs/hub-dogfood.md](./docs/hub-dogfood.md)
- [docs/api/README.md](./docs/api/README.md)
- [docs/api/http.md](./docs/api/http.md)
- [docs/api/sse.md](./docs/api/sse.md)
- [docs/api/cli.md](./docs/api/cli.md)
- [docs/api/sdk.md](./docs/api/sdk.md)
- [docs/api/streams.md](./docs/api/streams.md)
- [docs/api/config.md](./docs/api/config.md)

## Multi-agent context management

In Receipt, rebracketing means dynamically changing merge parenthesization based on observed critique/patch interactions, not just trimming prompt history. This gives context management at composition-order level while preserving deterministic replay and auditability.


## Development

```bash
npm run dev
npm run hub:onboard
npm run test:smoke
```

The server auto-loads route modules from `src/agents/*.agent.ts`.

The Git-first hub is mounted at `/hub` and can be bootstrapped with the default team in [config/hub-agents.json](./config/hub-agents.json).
