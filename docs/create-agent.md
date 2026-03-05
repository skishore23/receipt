# Create an Agent

This is the primary developer experience for building agents in Receipt.

The default flow is:

1. scaffold a single-file agent
2. edit receipts, view, actions, and goal
3. run it with the CLI
4. inspect receipts and replay

## Prerequisites

From repo root:

```bash
npm install
npm run build
```

Use either command style:

- `receipt ...` (if the `receipt` bin is available in your shell)
- `npm run cli -- ...` (always works in this repo)

## 1) Scaffold an agent

```bash
receipt new my-agent --template basic
```

Available templates:

- `basic`
- `assistant-tool`
- `human-loop`
- `merge`

Scaffold output:

- `src/agents/my-agent.agent.ts`

No central registry or manifest edits are required.

## 2) Authoring model

Every agent follows the same shape:

- `receipts`: typed event declarations
- `view`: pure fold/query helpers over receipts
- `actions`: runnable units that emit receipts
- `goal`: completion predicate

Example:

```ts
import { defineAgent, receipt, assistant, human } from "../sdk/index.js";

export default defineAgent({
  id: "writer",
  version: "1.0.0",

  receipts: {
    "prompt.received": receipt<{ prompt: string }>(),
    "draft.generated": receipt<{ text: string }>(),
    "draft.approved": receipt<{ text: string }>(),
  },

  view: ({ on }) => ({
    prompt: on("prompt.received").last(),
    draft: on("draft.generated").last(),
    done: on("draft.approved").exists(),
  }),

  actions: () => [
    assistant("draft", {
      when: ({ view }) => Boolean(view.prompt) && !view.draft,
      run: async ({ view, emit }) => {
        emit("draft.generated", { text: `Draft for: ${view.prompt?.prompt ?? ""}` });
      },
    }),
    human("approve", {
      when: ({ view }) => Boolean(view.draft) && !view.done,
      run: async ({ view, emit }) => {
        emit("draft.approved", { text: view.draft?.text ?? "" });
      },
    }),
  ],

  goal: ({ view }) => view.done,
});
```

## 3) Run your agent

For a scaffolded `defineAgent` file:

```bash
receipt run my-agent --problem "Write a short summary"
```

Defaults:

- stream: `agents/<agentId>`
- run stream: `agents/<agentId>/runs/<runId>`

Optional flags:

- `--stream <stream>`
- `--run-id <runId>`

## 4) Inspect and replay

Use receipts as your debugging surface:

```bash
receipt inspect <run-id-or-stream>
receipt trace <run-id-or-stream>
receipt replay <run-id-or-stream>
receipt fork <run-id-or-stream> --at <index>
```

Queue operations:

```bash
receipt jobs
receipt abort <job-id>
```

## 5) Dev loop

For server-driven workflows and UI routes:

```bash
receipt dev
```

Route modules are auto-discovered from `src/agents/*.agent.ts`.

## Stream model

Agent streams:

- `agents/<agentId>`
- `agents/<agentId>/runs/<runId>`
- `agents/<agentId>/runs/<runId>/branches/<branchId>`
- `agents/<agentId>/runs/<runId>/sub/<subRunId>`

Queue streams:

- `jobs` (index)
- `jobs/<jobId>` (authoritative lifecycle)

## Authoring checklist

- Emit meaningful receipts; avoid hidden mutable state.
- Keep `view` logic pure and deterministic.
- Keep side effects inside action `run` functions.
- Make action readiness (`when`) explicit.
- Use `exclusive` and `maxConcurrency` only for coordination/perf hints.
- Prefer stable receipt type names so replay/traces stay readable.

## Common issues

- `receipt: command not found`
  - Use `npm run cli -- <command>`.

- Agent runs but never completes
  - Check `goal(...)` and `when(...)` conditions with `receipt trace`.

- Nothing appears in routes
  - `receipt dev` only auto-loads route modules that default-export a route factory/module.
