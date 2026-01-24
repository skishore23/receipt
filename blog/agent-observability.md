# What If Agents Remembered Everything?

Not logs. Not traces. **Actual memory.**

- Make “what happened” the source of truth, so state, UI, debugging, and trust fall out of the same data structure.

What if your agent could:

* Jump to any moment in a conversation and show you exactly what it knew then
* Fork a conversation at step 30 and keep both timelines
* Prove (tamper-evidently) that it made specific decisions in a specific order
* Replay a past interaction exactly as it happened

This isn’t a feature list. It’s a consequence of one thing: **the receipt chain**.

~60 lines of core logic. Everything else follows.

---

## The idea

Every agent action—every message, every tool call, every tool result—becomes a **receipt**: timestamped, immutable, and hash-linked to what came before.

```text
Receipt 1: user said "Generate a cat"
    ↓ (hash link)
Receipt 2: agent called tool: queue_workflow
    ↓ (hash link)
Receipt 3: tool returned: { prompt_id: "abc" }
    ↓ (hash link)
Receipt 4: agent responded: "Here’s your cat..."
```

That chain *is* the agent’s memory.

* **Execution** = appending receipts
* **Memory** = the chain
* **State** = replaying (folding) the chain
* **UI** = rendering a view over that fold

One data structure. Three perspectives.

---

## Why agents forget

Most agent systems keep “truth” in two different places:

1. **Execution state** in memory (or some mutable store).
2. **Observability** somewhere else (logs, traces, dashboards).

So when you ask:

* “What was the state at step 47?”
* “Can we try a different approach from step 30?”
* “Prove what happened.”

…you end up reconstructing reality from exhaust fumes.

Better logging helps. But it’s still bolted on. It’s still after the fact.

---

## The insight: memory is a chain of events

Agents don’t have “mystical state.” They have **events**.

```ts
type AgentEvent =
  | { type: "user.message"; content: string }
  | { type: "tool.called"; tool: string; args: Record<string, unknown> }
  | { type: "tool.result"; tool: string; result: unknown }
  | { type: "agent.response"; content: string };
```

A conversation is just a sequence:

```text
1. user.message: "Generate a cat image"
2. tool.called: queue_workflow({ prompt: "cat", steps: 20 })
3. tool.result: { prompt_id: "abc123" }
4. tool.called: get_image({ prompt_id: "abc123" })
5. tool.result: { url: "https://..." }
6. agent.response: "Here’s your cat image: …"
```

If you store those events *correctly*, observability stops being a separate system.

So what’s “correctly”?

---

## The data structure

Each event becomes a **receipt**:

```ts
type Receipt<Body> = {
  id: string;       // unique identifier
  ts: number;       // timestamp
  stream: string;   // conversation/session id
  prev?: string;    // hash of previous receipt
  body: Body;       // the event
  hash: string;     // hash of this receipt (over contents + prev)
};
```

Core properties:

* **Immutable**: never edited, only appended
* **Ordered**: each receipt points to the previous hash
* **Hash-linked**: change anything and the chain breaks

This makes the chain **tamper-evident**. (If you want stronger “prove it to outsiders” guarantees, you add signatures and/or anchor hashes to an external ledger. The chain is the core.)

---

## The core implementation (the kernel)

### Hashing + canonicalization

Deterministic hashing needs deterministic JSON. Object key order matters.

```ts
import { createHash } from "node:crypto";

const sha256 = (s: string) =>
  createHash("sha256").update(s).digest("hex");

const sortKeys = (x: unknown): unknown => {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(sortKeys);

  const o = x as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
  return out;
};

const canonicalize = (x: unknown) => JSON.stringify(sortKeys(x));

const computeHash = <B>(r: Omit<Receipt<B>, "hash">) =>
  sha256(
    canonicalize({
      id: r.id,
      ts: r.ts,
      stream: r.stream,
      prev: r.prev ?? null,
      body: r.body,
    })
  );
```

### Receipt construction + append

```ts
const makeId = (ts: number) =>
  `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const receipt = <B>(
  stream: string,
  prev: string | undefined,
  body: B
): Receipt<B> => {
  const ts = Date.now();
  const id = makeId(ts);
  const base = { id, ts, stream, prev, body };
  return { ...base, hash: computeHash(base) };
};

type Chain<B> = Receipt<B>[];

const head = <B>(chain: Chain<B>) => chain[chain.length - 1];

const append = <B>(chain: Chain<B>, stream: string, body: B): Chain<B> => {
  const prev = head(chain)?.hash;
  return [...chain, receipt(stream, prev, body)];
};
```

### Fold = derive state by replay

```ts
type Reducer<S, B> = (state: S, body: B, ts: number) => S;

const fold = <S, B>(chain: Chain<B>, reducer: Reducer<S, B>, initial: S): S => {
  let state = initial;
  for (const r of chain) state = reducer(state, r.body, r.ts);
  return state;
};
```

### Verify = integrity check

```ts
const verify = <B>(chain: Chain<B>): { ok: boolean; error?: string } => {
  let prev: string | undefined;

  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];

    if (r.prev !== prev) return { ok: false, error: `Receipt ${i}: broken link` };

    const expected = computeHash({
      id: r.id,
      ts: r.ts,
      stream: r.stream,
      prev: r.prev,
      body: r.body,
    });

    if (r.hash !== expected) return { ok: false, error: `Receipt ${i}: hash mismatch` };

    prev = r.hash;
  }

  return { ok: true };
};
```

That’s the kernel. Everything else is “just” consequences.

---

## What perfect memory enables (without special features)

### Time travel

You don’t “build” time travel. You take a prefix.

```ts
const take = <B>(chain: Chain<B>, n: number) => chain.slice(0, n);

const stateAt47 = fold(take(fullChain, 47), reducer, initialState);
```

### Branching

Forking is copying a prefix into a new stream and re-linking hashes.

```ts
const fork = (source: Chain<AgentEvent>, at: number, newStream: string) => {
  const prefix = source.slice(0, at);

  let out: Chain<AgentEvent> = [];
  for (const r of prefix) out = append(out, newStream, r.body);

  return out;
};
```

Two timelines. Shared history. Zero magical machinery.

### Replay

Replay isn’t “read the logs.” Replay is… replay.

```ts
for (const r of chain) {
  // feed events back through your reducer or runtime
}
```

If your reducer defines “state,” then replay defines “truth.”

---

## Putting it together: a tiny agent loop

Define state as a fold over receipts.

```ts
type AgentState = {
  messages: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
};

const initialState: AgentState = { messages: [] };

const reducer: Reducer<AgentState, AgentEvent> = (s, e) => {
  switch (e.type) {
    case "user.message":
      return { ...s, messages: [...s.messages, { role: "user", content: e.content }] };
    case "tool.result":
      return { ...s, messages: [...s.messages, { role: "tool", content: JSON.stringify(e.result) }] };
    case "agent.response":
      return { ...s, messages: [...s.messages, { role: "assistant", content: e.content }] };
    default:
      return s;
  }
};
```

Then the runtime becomes: append → fold → decide → append.

---

## Storage: newline-delimited JSON

No database required. Just append receipts to a file.

```json
{"id":"abc1","ts":1706000001,"stream":"s1","body":{"type":"user.message","content":"Hi"},"hash":"a1b2..."}
{"id":"abc2","ts":1706000002,"stream":"s1","prev":"a1b2...","body":{"type":"agent.response","content":"Hello!"},"hash":"c3d4..."}
```

If your storage is append-only, your memory stays honest.

---

## Why this feels different

Traditional approach:

* The agent acts.
* Then it logs what it did.
* Then you try to reconstruct meaning later.

Receipt-chain approach:

* The agent acts **by writing a receipt**.
* Memory **is** that receipt chain.
* State **is** replay.
* UI **is** a view over replay.

The receipt isn’t a record of what happened.

**The receipt *is* what happened.**

---

## Finally

Agents are weird. They’re half software, half narrative. They talk, they call tools, they wait, they retry, they fork.

If you build them like normal apps, they forget like normal apps.

So I’m trying a different premise: what if forget doesnt exist?

can we built agents that *couldn’t* forget.

The simplest answer I’ve found is a chain of receipts.

One data structure. Everything else is a view.

Check out this repo for implementation of a todo app https://github.com/skishore23/reciept
