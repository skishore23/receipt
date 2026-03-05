# SDK API (TypeScript)

Source barrel: `src/sdk/index.ts`.

```ts
import {
  receipt,
  defineAgent,
  runDefinedAgent,
  goal,
  action,
  assistant,
  tool,
  human,
  merge,
  rebracket,
} from "../src/sdk/index.js";
```

## Exports

### `receipt<T>()`
- Declares a typed receipt payload schema marker.
- Returns `ReceiptDeclaration<T>`.

### `defineAgent(spec)`
- Declares an agent spec.
- Supports:
  - modern receipt-native spec (`receipts`, `view`, `actions`, `goal`, optional `mergePolicy`),
  - legacy workflow spec (`reducer`, `initial`, `lifecycle`, `run`).

### `runDefinedAgent({ spec, ctx, config, deps, wrap })`
- Executes an agent spec against a runtime context.
- Dispatches to modern `runAgentLoop` or legacy workflow runner.

### `goal(fn)`
- Helper wrapper for goal predicates: `(ctx) => boolean`.

### `action(id, spec)`
- Declares action of kind `action`.

### `assistant(id, spec)`
- Declares action of kind `assistant`.

### `tool(id, spec)`
- Declares action of kind `tool`.

### `human(id, spec)`
- Declares action of kind `human`.

### `merge(policy)` / `rebracket(policy)`
- Attach merge/rebracketing policy metadata and logic.
- `rebracket` is an alias of `merge`.

## Exported Types
- `ReceiptDeclaration`, `ReceiptBody`
- `LegacyAgentSpec`, `AgentSpec`
- `AgentAction`, `ActionKind`
- `MergePolicy`, `MergeCandidate`, `MergeDecision`, `MergeScoreVector`

## Minimal End-to-End Example

```ts
import { defineAgent, receipt, action, goal } from "../src/sdk/index.js";

export default defineAgent({
  id: "hello-agent",
  version: "1.0.0",
  receipts: {
    "prompt.received": receipt<{ prompt: string }>(),
    "response.ready": receipt<{ text: string }>(),
  },
  view: ({ on }) => ({
    prompt: on("prompt.received").last()?.prompt,
    done: on("response.ready").exists(),
  }),
  actions: () => [
    action("respond", {
      when: ({ view }) => Boolean(view.prompt) && !view.done,
      run: async ({ view, emit }) => {
        emit("response.ready", { text: `Echo: ${view.prompt ?? ""}` });
      },
    }),
  ],
  goal: goal(({ view }) => Boolean(view.done)),
});
```

## Action Runtime Contract
- `when({ view })`: optional readiness predicate.
- `run({ view, emit })`: emits domain receipts through `emit(type, body)`.
- Optional coordination hints:
  - `watch: string[]`
  - `exclusive: boolean`
  - `maxConcurrency: number`

## Merge Policy Contract
A merge policy must provide:
- `id`, `version`
- `candidates(ctx)`
- `evidence(ctx)`
- `score(candidate, evidence, ctx)`
- `choose(scored)`
- optional `shouldRecompute(ctx)`
