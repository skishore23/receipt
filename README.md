# Receipt

Receipt is version control for agent runs.

A receipt-native framework for long-lived agents. Every message, tool call, and control decision becomes an immutable, hash-linked receipt, so agents can be replayed, forked, inspected, and verified.

- facts are immutable, hash-linked receipts
- state is derived by folding receipts
- queue and control flow are receipt-derived
- replay reconstructs what happened and why



## Install

```bash
bun install
bun run build # prepares web assets
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
import { defineAgent, receipt, action, assistant, tool, human, goal, merge, rebracket } from "./src/sdk/index";
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
- [docs/factory-profile-orchestration.md](./docs/factory-profile-orchestration.md)
- [docs/factory-infrastructure-engineer.md](./docs/factory-infrastructure-engineer.md)
- [docs/agent-framework.md](./docs/agent-framework.md)
- [docs/axiom-theorem-prover.md](./docs/axiom-theorem-prover.md)
- [docs/axiom-public-prover.md](./docs/axiom-public-prover.md)
- [docs/axiom-benchmark.md](./docs/axiom-benchmark.md)
- [docs/create-agent.md](./docs/create-agent.md)
- [docs/api/README.md](./docs/api/README.md)
- [docs/api/http.md](./docs/api/http.md)
- [docs/api/sse.md](./docs/api/sse.md)
- [docs/api/cli.md](./docs/api/cli.md)
- [docs/api/sdk.md](./docs/api/sdk.md)
- [docs/api/streams.md](./docs/api/streams.md)
- [docs/api/config.md](./docs/api/config.md)

## Factory and Profiles

`Factory` is the operator surface for this repo.

Use `/factory` for:

- chat and thread management
- starting new work through chat
- repo preparation and inferred validation defaults
- task DAG decomposition
- autonomous worker dispatch
- per-repo objective queueing and slot admission
- candidate review
- integration, validation, and promotion
- thread-scoped runs and job updates
- repo-local customization through `profiles/<id>/PROFILE.md` and `profiles/<id>/profile.json`

Use `/factory/control` for:

- advanced work details
- receipts, runtime control, and live output
- operator actions on the selected thread

`/factory/chat` remains as a compatibility redirect to `/factory`.

The older Hub UI is gone. Factory still reuses `src/adapters/hub-git.ts` internally as its Git/worktree adapter, but there is no separate `/hub` product surface.

## Multi-agent context management

In Receipt, rebracketing means dynamically changing merge parenthesization based on observed critique/patch interactions, not just trimming prompt history. This gives context management at composition-order level while preserving deterministic replay and auditability.


## Development

```bash
bun run dev
bun run test:smoke
```

## Docker + Resonate

The repo now includes a single-container Docker setup that runs:

- the Receipt API process
- the Resonate driver process
- the chat worker process
- the control worker process
- the codex worker process
- an embedded Resonate server with SQLite persistence
- the `resonate` CLI
- the `codex` CLI used by Factory task workers

Start it with:

```bash
bun run docker:up
```

That launcher:

- detects and forwards your local UID/GID
- mounts the repo plus `${HOME}/.codex`
- creates the local `.receipt` and Codex mount directories if needed
- applies the tuned Resonate worker and queue defaults automatically

If you want detached mode:

```bash
bun run docker:up -- up --build -d
```

The container mounts the repo into `/workspace/receipt`, stores Resonate state at `.receipt/resonate/resonate.db`, runs with `JOB_BACKEND=resonate`, and exposes:

- `http://localhost:8787` for Receipt
- `http://localhost:8001` for Resonate HTTP
- `http://localhost:9090/metrics` for Resonate metrics

The compose file also mounts `${HOME}/.codex` into the container so `codex exec` can authenticate and launch worker runs.

For Linux hosts, the compose service sets `seccomp=unconfined` and `apparmor=unconfined` so Codex can install its own nested Landlock/seccomp sandbox inside the container. If you remove those, `codex exec --sandbox read-only|workspace-write` may fail inside Docker.

For local non-Docker startup with the Resonate control plane, use:

```bash
bun run start:resonate
```

That command now starts both the local Resonate server and the full multi-process Receipt runtime. It uses SQLite at `.receipt/resonate/resonate.db`, so the only extra local prerequisite is that the `resonate` CLI is installed on your machine.

The canonical source entrypoints in this repo are `bun src/cli.ts`, `bun src/server.ts`, and `bun scripts/start-resonate-runtime.mjs`.

The server auto-loads route modules from `src/agents/*.agent.ts`.

The web UI uses `chat`, `thread`, and `Work Details` terminology while the durable code, HTTP APIs, receipts, and CLI still use `objective`.

## Docker

The repo ships with a Docker image for EC2 or any other container host:

```bash
docker build -t receipt .
docker run --rm -p 8787:8787 \
  -e OPENAI_API_KEY=... \
  -v receipt-data:/app/.receipt/data \
  receipt
```

Environment variables that are commonly useful at runtime:

- `PORT` defaults to `8787`
- `DATA_DIR` defaults to `/app/.receipt/data`
- `OPENAI_API_KEY` enables live LLM and embedding calls
- `RECEIPT_CODEX_BIN` or `HUB_CODEX_BIN` can point at a Codex CLI binary if you want the container to use a non-default path

The app expects a `codex` executable to be present on `PATH` or supplied through `RECEIPT_CODEX_BIN`. If you want it baked into the image, install that binary in the `runner` stage before starting the server.

For EC2, run the container with a persistent EBS-backed volume mounted at `/app/.receipt/data` so receipts, queue state, and workspace metadata survive restarts.
