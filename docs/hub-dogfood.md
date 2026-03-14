# Hub Dogfood Flow

The Git-first hub runs directly against the current repository and stores hub state under `data/`.

## Start the server

```bash
npm run dev
```

The hub is available at `http://127.0.0.1:8787/hub`.

## Onboard the default agent team

```bash
npm run hub:onboard
```

This reads [config/hub-agents.json](../config/hub-agents.json) and registers each agent profile through `POST /hub/api/agents`.

The command is idempotent:

- missing agents are created
- existing agents are left alone

You can point it at another hub instance or another file:

```bash
npm run hub:onboard -- --url http://127.0.0.1:8791 --file ./config/hub-agents.json
```

## What onboarding sets up

Each onboarded profile has:

- an `agentId`
- a display name
- a private `memoryScope`

Hub tasks reuse the shared `agent` prompt set. In this v1, onboarding does not create per-agent prompt packs or model policies.

## Normal workflow

1. Open `/hub`.
2. Create a workspace for one of the onboarded agents.
3. Make changes in the workspace path shown by the UI or API.
4. Commit inside that worktree.
5. Announce the workspace head to a channel.
6. Enqueue a task if you want the generic `agent` worker to operate inside that workspace.

## Notes

- Workspaces are real Git worktrees under `data/hub/worktrees/`.
- Hub metadata stays file-backed; Git remains the code source of truth.
- Live task execution still requires the normal model environment, for example `OPENAI_API_KEY`.
