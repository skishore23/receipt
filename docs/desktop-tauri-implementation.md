# Receipt Desktop App Implementation Plan

## Goal

Ship Receipt as an installable desktop app with the smallest possible architecture change:

- keep the current Receipt CLI, server, Factory runtime, and data model
- bundle Bun with the app
- add a Tauri shell for setup, lifecycle, and desktop packaging
- let the user configure an OpenAI key and confirm access to required CLIs
- run Receipt against a user-selected repository
- preserve terminal interoperability so the same repo can still be used with `receipt ...`

This plan does **not** clone the Receipt source repo onto the customer's machine as part of normal usage. The installed app bundles Receipt itself. The user only selects the repository that Receipt should operate on.

## Non-goals for v1

- rewriting Receipt into Rust
- removing Bun from the backend
- embedding GitHub auth in the desktop app
- replacing `git`, `gh`, `aws`, or `codex` with native Rust integrations
- multi-repo orchestration in one app session

## Current Reality

Receipt is already shaped like a local backend plus UI:

- the server boots Hono, workers, memory, queue, and Factory in one process
- the UI is served from the local Receipt server
- the CLI and Factory runtime already operate from repo-local config and data

Relevant references:

- [README.md](/Users/kishore/receipt/README.md#L58)
- [README.md](/Users/kishore/receipt/README.md#L84)
- [src/server/bootstrap.ts](/Users/kishore/receipt/src/server/bootstrap.ts)
- [src/cli/runtime.ts](/Users/kishore/receipt/src/cli/runtime.ts)

That makes the lowest-risk desktop architecture:

1. Tauri desktop app starts.
2. Tauri launches a bundled Receipt sidecar.
3. Receipt sidecar starts the existing local server and workers.
4. Tauri webview loads the local Receipt UI.

## High-level Architecture

### Packaged App Contents

The desktop installer should include:

- Tauri app shell
- bundled Receipt backend
- bundled Bun runtime
- bundled frontend assets
- a small desktop config store

The app should **not** bundle user repos.

### User-managed Tools

For v1, require these tools on the host:

- `git`
- `gh`
- `aws`
- `codex`

Bundling these is possible later, but not necessary for the first desktop release.

### Runtime Model

At runtime the desktop app should manage:

- one selected repo root
- one Receipt data dir for that repo
- one local Receipt server process
- one local window pointing at that server

Recommended path layout:

- app config:
  - macOS: `~/Library/Application Support/<app-name>/`
  - Linux: `~/.config/<app-name>/`
  - Windows: `%AppData%\\<app-name>\\`
- repo state:
  - default to the repo's existing `.receipt/data`
  - optionally allow app-managed data under app config later

For minimum compatibility, keep using repo-local `.receipt/config.json` and `.receipt/data` where possible.

## Critical Product Decision

The desktop app should operate on a **user-selected target repository**, not on the Receipt repo.

That means:

- users install the app once
- users choose a repo they want Receipt to work on
- Receipt runs against that repo root
- worktrees, integration branches, checks, and PRs belong to that selected repo

## Where PRs Open

PRs should open against the selected customer repository, not against the Receipt codebase.

Why:

- the publisher flow explicitly pushes the current branch to a GitHub remote and opens a PR with `gh`
- the publish worker prefers the selected repo's GitHub remote, typically `origin`
- the Hub mirror copies remotes from the selected source repo into Receipt's managed bare mirror

Relevant references:

- [skills/factory-pr-publisher/SKILL.md](/Users/kishore/receipt/skills/factory-pr-publisher/SKILL.md#L7)
- [skills/factory-pr-publisher/SKILL.md](/Users/kishore/receipt/skills/factory-pr-publisher/SKILL.md#L14)
- [src/services/factory/runtime/service.ts](/Users/kishore/receipt/src/services/factory/runtime/service.ts#L4377)
- [src/adapters/hub-git.ts](/Users/kishore/receipt/src/adapters/hub-git.ts#L685)

Operationally:

1. User selects repo `/path/to/customer-repo`.
2. Receipt uses that repo as `repoRoot`.
3. HubGit mirrors that repo and its remotes.
4. The publisher runs `git push` and `gh pr create` against the selected repo's GitHub remote.
5. The PR appears in the customer's repo under the GitHub account authenticated in `gh`.

For v1, the desktop app should make this explicit in setup:

- selected repo path
- detected GitHub remotes
- detected `gh` auth account

## Recommended v1 UX

### First-run flow

On first launch:

1. Show a welcome screen.
2. Ask for the OpenAI API key.
3. Run environment checks for `git`, `gh`, `aws`, `codex`, and bundled `bun`.
4. Ask the user to select a target repository.
5. Detect or create `.receipt/config.json`.
6. Start the local Receipt backend.
7. Open the existing Receipt UI in the desktop window.

### Settings UI

The desktop app should expose:

- OpenAI API key status
- selected repo
- data dir
- CLI diagnostics
- backend logs
- restart backend

### Doctor UI

Add a desktop "doctor" screen that checks:

- `git --version`
- `gh --version`
- `gh auth status`
- `aws --version`
- `aws sts get-caller-identity`
- `codex --version`
- repo is a valid git worktree
- repo remotes are present
- OpenAI key exists

## Security and Secret Handling

### OpenAI API key

The desktop app should collect the OpenAI key and pass it to the Receipt sidecar as `OPENAI_API_KEY`.

Preferred storage:

- OS credential store or secure desktop-managed secret storage

Minimum acceptable v1 fallback:

- app-managed config file with encryption at rest if secure-store integration is not ready

Do not store the OpenAI key in the selected repo.

### CLI auth

For v1, keep auth ownership with the host CLIs:

- `gh` stays logged in as the user's GitHub account
- `aws` uses the user's AWS profile/session setup
- `codex` uses the user's Codex auth flow

The desktop app should verify access, not replace it.

## Minimal Backend Changes Required

The main engineering work is not Tauri UI. It is making Receipt bootable as a sidecar with explicit config.

### 1. Add an explicit server entrypoint

Current issue:

- [src/server.ts](/Users/kishore/receipt/src/server.ts) imports [src/server/bootstrap.ts](/Users/kishore/receipt/src/server/bootstrap.ts), which starts immediately at module load

Required change:

- refactor bootstrap into something like:
  - `createReceiptServer(options)`
  - `startReceiptServer(options)`
  - `stopReceiptServer()`

The sidecar entrypoint should accept:

- `repoRoot`
- `dataDir`
- `port`
- `openAiApiKey`
- optional explicit paths for `git`, `gh`, `aws`, `codex`, `bun`

### 2. Stop resolving runtime config from `process.cwd()` at import time

Current issue:

- [src/cli/runtime.ts](/Users/kishore/receipt/src/cli/runtime.ts) binds `ROOT`, `FACTORY_RUNTIME`, and `DATA_DIR` eagerly

Required change:

- replace module-level globals with lazy functions that accept explicit runtime options
- keep CLI defaults for terminal usage
- add desktop overrides for packaged usage

Suggested shape:

```ts
type ReceiptRuntimeOptions = {
  repoRoot: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
};
```

### 3. Add a desktop-sidecar command

Add a new CLI command, for example:

```bash
receipt desktop serve --repo-root /path/to/repo --data-dir /path/to/data --port 8787
```

This becomes the sidecar launch target for Tauri.

Responsibilities:

- validate repo root
- resolve config
- start server/workers
- print structured startup logs
- expose health information

### 4. Make asset loading packaging-safe

Current issue:

- [src/server/assets.ts](/Users/kishore/receipt/src/server/assets.ts) looks for assets relative to runtime cwd and `dist/assets`

Required change:

- allow an explicit assets path
- in packaged builds, point it at bundled resources

### 5. Make route loading packaging-safe

Current issue:

- [src/framework/agent-loader.ts](/Users/kishore/receipt/src/framework/agent-loader.ts) scans `src/agents/*.agent.ts` dynamically from the filesystem

Required change:

- replace runtime directory scanning with a static route registry for production builds
- keep dynamic loading for local dev if desired

### 6. Keep Bun bundled and explicit

Receipt currently depends on Bun runtime discovery:

- [src/lib/runtime-paths.ts](/Users/kishore/receipt/src/lib/runtime-paths.ts#L33)

For v1:

- ship Bun as part of the app
- set `RECEIPT_BUN_BIN` explicitly when launching the sidecar

Do not depend on a user-installed Bun for the consumer app.

## Tauri App Responsibilities

The Tauri app should be intentionally thin.

### Responsibilities

- onboarding flow
- secure OpenAI key input
- CLI diagnostics
- repo selection
- sidecar launch and lifecycle
- log viewing
- update install/restart flow
- desktop menus and windowing

### Non-responsibilities

- Receipt orchestration logic
- Factory control logic
- PR creation logic
- memory, receipts, queue, workers

Those stay in the Receipt backend.

## Sidecar Launch Contract

The Tauri app should launch the bundled backend with explicit env and args.

Suggested env:

```text
OPENAI_API_KEY=<user key>
RECEIPT_REPO_ROOT=<selected repo>
RECEIPT_DATA_DIR=<selected repo>/.receipt/data
RECEIPT_BUN_BIN=<bundled bun path>
RECEIPT_GIT_BIN=<optional explicit git path>
RECEIPT_GH_BIN=<optional explicit gh path>
RECEIPT_AWS_BIN=<optional explicit aws path>
RECEIPT_CODEX_BIN=<optional explicit codex path>
PORT=<chosen local port>
JOB_BACKEND=local
```

Suggested launch target:

```bash
<bundled-bun> <bundled-receipt-entry> desktop serve --repo-root ... --data-dir ... --port ...
```

## Repository Selection Model

### v1 recommendation

The app should ask the user to select a local git repository.

Rules:

- repo must pass `git rev-parse --is-inside-work-tree`
- repo must be writable
- repo should have at least one remote
- if no remote exists, PR publishing is unavailable until configured

### `.receipt/config.json`

If the selected repo does not already have `.receipt/config.json`, the app should offer to create one with:

```json
{
  "repoRoot": ".",
  "dataDir": ".receipt/data",
  "codexBin": "codex"
}
```

Then the desktop app can override paths at runtime with environment variables when needed.

## Step-by-step Implementation Plan

### Phase 0: Hard decisions

1. Decide app name and bundle identifier.
2. Decide whether v1 supports one active repo or multiple saved repos.
3. Decide where app-level settings live.
4. Decide whether to require `gh` for PR publishing in v1.

Recommended decision:

- one active repo at a time
- require `gh`
- require `git`, `aws`, and `codex`

### Phase 1: Refactor Receipt for sidecar boot

1. Refactor server bootstrap into explicit start/stop functions.
2. Refactor CLI runtime config to accept explicit `repoRoot` and `dataDir`.
3. Add `receipt desktop serve`.
4. Add `receipt doctor --json`.
5. Add support for explicit binary overrides:
   - `RECEIPT_GIT_BIN`
   - `RECEIPT_GH_BIN`
   - `RECEIPT_AWS_BIN`
   - `RECEIPT_CODEX_BIN`
6. Add a static route registry for packaged mode.
7. Add explicit asset path configuration.

Deliverable:

- a backend that can be launched deterministically from outside a terminal session

### Phase 2: Create the Tauri shell

1. Scaffold a Tauri app.
2. Add a sidecar launcher.
3. Add startup health polling.
4. Load the existing Receipt UI in the webview after backend health is green.
5. Add log piping from sidecar stdout/stderr into a desktop diagnostics panel.

Deliverable:

- a windowed Receipt app using the existing local UI

### Phase 3: Onboarding and settings

1. Build first-run onboarding UI.
2. Add OpenAI key entry.
3. Add repo picker.
4. Add CLI checks.
5. Add repo summary:
   - repo path
   - branch
   - remotes
   - `gh` auth account
   - `aws sts get-caller-identity`
6. Add "Start Receipt" action.

Deliverable:

- a non-technical user can install, configure, and launch the app

### Phase 4: Packaging

1. Bundle Bun with the app.
2. Bundle Receipt backend resources.
3. Ensure packaged path resolution works on macOS, Windows, and Linux.
4. Sign installers.
5. Add release builds.

Deliverable:

- distributable installers

### Phase 5: Auto-update

1. Configure Tauri updater.
2. Publish signed artifacts and update metadata.
3. Add in-app update check/install flow.
4. Restart app after install.

Deliverable:

- desktop app updates carry backend updates with them

## Update Model

The customer should not update Receipt by pulling the Receipt source repo.

Instead:

1. Build a new desktop release.
2. Bundle the updated Receipt backend inside it.
3. Publish signed update artifacts.
4. Let the installed desktop app download and install the update.

This updates:

- Tauri shell
- bundled Receipt backend
- bundled Bun runtime
- bundled assets

It does **not** change the user's target repository except through normal Receipt operations inside that repo.

## PR Publishing Model in Desktop

The app should make the publish path obvious:

1. Work happens in the selected repo's Factory-managed worktrees and integration branches.
2. Receipt validates and promotes locally inside that repo.
3. The publisher pushes the current branch to the selected repo's GitHub remote.
4. `gh` opens the PR under the user's authenticated GitHub account.

Desktop should expose a preflight check before enabling publish:

- `gh auth status` passes
- selected repo has a GitHub remote
- push access is likely available

If any of those fail, the app should mark publish as unavailable and explain why.

## Suggested Commands to Add

### `receipt desktop serve`

Starts the backend for desktop usage.

### `receipt doctor --json`

Returns structured diagnostics for:

- required CLIs
- repo validity
- git remotes
- gh auth
- aws auth
- codex availability
- OpenAI key presence

### `receipt desktop init-repo`

Optionally writes `.receipt/config.json` for a selected repo.

## Risks

### Packaging risk

Dynamic filesystem loading and cwd-based assumptions will be the first things that break in a packaged app.

### PATH risk

Desktop apps often do not inherit shell PATH reliably, especially on macOS.

Mitigation:

- resolve explicit binary paths during onboarding
- persist them in app settings

### Auth mismatch risk

The desktop app may launch successfully while `gh`, `aws`, or `codex` are installed but unauthenticated.

Mitigation:

- separate "binary found" from "auth ready"

### Repo safety risk

Users may select the wrong repo and assume PRs will go elsewhere.

Mitigation:

- show repo path and remote URLs prominently before enabling Factory publish

## Recommended v1 Scope

Ship only this:

- Tauri shell
- bundled Bun
- bundled Receipt backend
- OpenAI key onboarding
- repo picker
- CLI checks for `git`, `gh`, `aws`, `codex`
- local backend lifecycle
- existing Receipt UI in webview
- updater

Do **not** add:

- native GitHub OAuth
- native AWS credential management
- multi-repo dashboards
- embedded sandbox infrastructure

## Summary

The minimal desktop path is:

1. bundle Receipt and Bun
2. keep the current backend and UI
3. add a Tauri shell for onboarding, secrets, diagnostics, and packaging
4. run Receipt against a user-selected repo
5. use the user's existing `git`, `gh`, `aws`, and `codex` access
6. open PRs against the selected repo's remotes, not the Receipt repo

That gets an installable product without throwing away the current CLI and Factory architecture.
