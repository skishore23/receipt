# Receipt

Receipt is version control for agent runs.

A receipt-native framework for long-lived agents. Every message, tool call, and control decision becomes an immutable, hash-linked receipt, so agents can be replayed, forked, inspected, and verified.

- facts are immutable, hash-linked receipts
- state is derived by folding receipts
- queue and control flow are receipt-derived
- replay reconstructs what happened and why



## Install

For CLI users:

```bash
npm install -g receipt-agent-cli
```

For repo contributors:

```bash
bun install
bun run build # prepares web assets
```

## CLI Quickstart

```bash
receipt start
```

`receipt start` checks and configures:

- OpenAI API key (validated before setup continues)
- GitHub CLI authentication for `github.com` (guided browser login)
- AWS CLI authentication and selected account/profile (guided SSO login)

### Prerequisites (minimum versions)

- Node.js `>=20.0.0`
- GitHub CLI (`gh`) `>=2.81.0`
- AWS CLI v2 `>=2.0.0`

### Setup behavior

- `receipt start`: reruns full setup checks and reuses saved selections as defaults
- `receipt start --reset`: reruns setup from scratch and ignores saved selections
- If GitHub is not logged in, setup can run `gh auth login --hostname github.com --web` and then re-check auth.
- If AWS is not logged in, setup can guide `aws configure sso` then `aws sso login --profile <profile>`.
- Setup still accepts already-working non-SSO AWS credentials.

### Troubleshooting

| Check failed | What to run | Retry path |
| --- | --- | --- |
| `gh` missing | macOS: `brew install gh`<br/>Linux/Windows: install from [https://cli.github.com/](https://cli.github.com/) | Re-run `receipt start` |
| GitHub auth missing | Use guided login in setup, or run `gh auth login --hostname github.com --web` | Re-run `receipt start` |
| `aws` missing | macOS: `brew install awscli`<br/>Linux/Windows: install from [AWS CLI install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | Re-run `receipt start` |
| AWS auth missing | Use guided setup in CLI, or run `aws configure sso` then `aws sso login --profile <profile>` | Re-run `receipt start` |
| OpenAI key invalid | Enter a valid key when prompted | Stay in setup prompt and retry |

### Config and security

- Setup writes local config to `~/.receipt/config.json`.
- Stored values include OpenAI key, selected GitHub login, and selected AWS identity.
- Use `receipt start --reset` to rotate/reselect credentials and rewrite this file.

## CLI

```bash
receipt start # setup/recheck OpenAI key + GitHub + AWS
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

`receipt start` requires:

- `OPENAI_API_KEY` (or paste during setup)
- `gh` installed and authenticated to `github.com`
- `aws` installed and authenticated

```bash
receipt start --openai-key "sk-..."
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

## Release verification commands

Use these commands for different goals:

- `bun run verify:release`: full project release confidence (runs the broader smoke lane).
- `npm run verify:publish`: npm publish readiness for this CLI package (build + publish-safe smoke tests + pack smoke + `npm publish --dry-run`).

If you are preparing an npm publish, prefer `npm run verify:publish`.

## Docker + Resonate

Receipt now has two Docker modes.

### Dev mode

Use dev mode for local iteration. It bind-mounts the repo, keeps runtime state under the repo-local `.receipt/` tree, and forwards the targeted host auth/config surfaces that Factory and Codex need.

Start it with:

```bash
bun run docker:dev:up
```

or the existing alias:

```bash
bun run docker:up
```

Dev mode:

- bind-mounts the repo at `/workspace/receipt`
- stores shared state under:
  - `/workspace/receipt/.receipt/data`
  - `/workspace/receipt/.receipt/resonate`
  - `/workspace/receipt/.receipt/home`
- runs the Receipt multi-process Resonate runtime in one container
- enables Bun watch mode for the server roles
- runs a Tailwind watcher for live CSS updates
- makes `receipt`, `bun`, `git`, `gh`, `aws`, `python3`, `jq`, and `rg` available in the container

The 80/20 auth model in dev is:

- mount AWS, GitHub, Git, and SSH config directly into the stable container home
- mount the key Codex auth/config files directly into `CODEX_HOME`
- keep `CODEX_HOME/runtime` writable for isolated Codex homes and local runtime state

That means the container sees the same login state as the host CLI:

- `/workspace/receipt/.receipt/home/.aws`
- `/workspace/receipt/.receipt/home/.config/gh`
- `/workspace/receipt/.receipt/home/.gitconfig`
- `/workspace/receipt/.receipt/home/.git-credentials`
- `/workspace/receipt/.receipt/home/.ssh`
- `/workspace/receipt/.receipt/home/.codex/auth.json`
- `/workspace/receipt/.receipt/home/.codex/config.toml`
- `/workspace/receipt/.receipt/home/.codex/version.json`
- `/workspace/receipt/.receipt/home/.codex/.codex-global-state.json`

Stop it with:

```bash
bun run docker:dev:down
```

If you really want to remove dev volumes too:

```bash
bun run docker:dev:reset
```

### Prod mode

Use prod mode for distribution and upgrades. It runs from an immutable image, does not bind-mount the repo, and only persists runtime state volumes.

Start it with:

```bash
bun run docker:prod:up
```

Prod mode persists only:

- `/workspace/receipt/.receipt/data`
- `/workspace/receipt/.receipt/resonate`
- `/workspace/receipt/.receipt/home`

It does **not** mount the entire `.receipt/` tree, so the checked-in `.receipt/bin/receipt` wrapper and `.receipt/config.json` stay inside the image.

If you publish a distributable image, set `RECEIPT_IMAGE` and pull it first:

```bash
RECEIPT_IMAGE=ghcr.io/your-org/receipt:latest bun run docker:prod:pull
RECEIPT_IMAGE=ghcr.io/your-org/receipt:latest bun run docker:prod:up
```

Stop prod without deleting volumes:

```bash
bun run docker:prod:down
```

If you explicitly want to destroy prod volumes too:

```bash
bun run docker:prod:reset
```

### Shared runtime details

Both Docker modes run:

- the Receipt API process
- the Resonate driver process
- the chat worker process
- the control worker process
- the codex worker process
- an embedded Resonate server with SQLite persistence

Both expose:

- `http://localhost:8787` for Receipt
- `http://localhost:8001` for Resonate HTTP
- `http://localhost:9090/metrics` for Resonate metrics

Both use the same internal runtime paths:

- `DATA_DIR=/workspace/receipt/.receipt/data`
- `RESONATE_SQLITE_PATH=/workspace/receipt/.receipt/resonate/resonate.db`
- `HOME=/workspace/receipt/.receipt/home`
- `CODEX_HOME=/workspace/receipt/.receipt/home/.codex`

Codex isolated homes are created under `${CODEX_HOME}/runtime`, not `/tmp`.

For Linux hosts, the compose service sets `seccomp=unconfined` and `apparmor=unconfined` so Codex can install its own nested Landlock/seccomp sandbox inside the container. If you remove those, `codex exec --sandbox read-only|workspace-write` may fail inside Docker.

For local non-Docker startup with the Resonate control plane, use:

```bash
bun run start:resonate
```

That command starts both the local Resonate server and the full multi-process Receipt runtime. It uses SQLite at `.receipt/resonate/resonate.db`, so the only extra local prerequisite is that the `resonate` CLI is installed on your machine.

The canonical source entrypoints in this repo are `bun src/cli.ts`, `bun src/server.ts`, and `bun scripts/start-resonate-runtime.mjs`.

Repo-local recurring jobs can be declared in `.receipt/config.json` under `schedules`. See [docs/api/config.md](./docs/api/config.md) for the schedule schema and a recurring Factory software-improvement example.

The server auto-loads route modules from `src/agents/*.agent.ts`.

The web UI uses `chat`, `thread`, and `Work Details` terminology while the durable code, HTTP APIs, receipts, and CLI still use `objective`.
