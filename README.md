# Receipt

Store only receipts. Derive everything else—state, UI, audit, replay—from pure folds over the receipt chain.

---

## The problem

Ever tried to answer: *“How did we get into this state?”*

Traditional apps store **what is** (a mutable snapshot). When something goes wrong, you guess. Logs are scattered, incomplete, or rotated. Audit trails get bolted on later. Debugging becomes archaeology. Reproducing bugs becomes luck.

---

## The idea

Store **what happened** instead.

Every meaningful action becomes a **receipt**: timestamped, immutable, and hash-linked to the previous one. State isn’t stored; it’s computed by replaying receipts—like a bank ledger or a git history.

That single choice unlocks:

* **Full history**: see exactly how you got here
* **Time travel**: view state at any point by replaying a prefix
* **Replay debugging**: reproduce bugs from the exact event sequence
* **Branching**: fork history to explore “what if” paths
* **Integrity**: detect tampering via hash-chain verification

---

## What this is

Receipt is a small architectural kernel (~500 LoC in this repo; much less in the core) where the only durable artifact is the **receipt chain**.

No database required. No ORM required. Just events + pure functions.

```text
Command  →  decide  →  Event  →  append  →  Chain
                                              ↓
                                            fold
                                              ↓
                         View  ←  render  ←  State
```

* **Events are facts**: immutable, append-only, hash-linked, tamper-evident
* **State is derived**: compute it by folding receipts, never store it as truth
* **UI is a projection**: HTML, JSON, graphs, diffs—all from the same chain
* **Time travel is built-in**: replay the first N receipts to see past state

---

## Where this applies

Any system where **“what happened” matters more than “what is.”**

| Domain                    | What the chain stores                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| **AI agents**             | tool calls, results, decisions, traces—replay to debug, fork to explore |
| **Financial systems**     | transactions, transfers, adjustments                                    |
| **Audit/compliance**      | who did what, when—with tamper-evidence                                 |
| **Collaborative editing** | operations that can be replayed/merged/conflicted                       |
| **Game engines**          | player actions, deterministic replays                                   |
| **IoT / sensors**         | readings over time with verifiable history                              |
| **Workflow engines**      | step executions, approvals, transitions                                 |

**If you can express your domain as events, you get time travel, audit, branching, and verification as consequences.**

---

## The key inversion

Most systems treat state as primary and events as “logs.” Receipt flips it:

```text
Traditional:  State → (mutate) → State  →  (log) → Event
Receipt:      Command → Event → (append) → Chain → (fold) → State
```

**Events are the truth. State is computed. UI is optional.**

---

## What comes “for free”

These aren’t features bolted on later. They fall out of the model:

| Capability           | Traditional approach         | Receipt approach                      |
| -------------------- | ---------------------------- | ------------------------------------- |
| **Undo/Redo**        | track & reverse mutations    | `take(chain, n-1)`                    |
| **Audit log**        | separate logging system      | the chain *is* the audit log          |
| **Time travel**      | snapshot state constantly    | `fold(take(chain, n))`                |
| **Branching**        | complex version control      | fork a stream at index N              |
| **Integrity**        | checksums, signatures, trust | hash-linked receipts (tamper-evident) |
| **Replay debugging** | ad-hoc recording/playback    | replay the same event sequence        |

Minimal sketch:

```ts
const append = (chain, event) => [...chain, receipt(event)];
const fold   = (chain, reduce, init) => chain.reduce((s, r) => reduce(s, r.body, r.ts), init);
const take   = (chain, n) => chain.slice(0, n);
const verify = (chain) => chain.every((r, i) => i === 0 || r.prev === chain[i-1].hash);
```

Everything else is wiring.

## Run

```bash
npm install
npm run dev
```

Open: [http://localhost:8787](http://localhost:8787)

---

## Architecture

```text
src/
├── core/                 # The kernel (axioms)
│   ├── types.ts          # Receipt, Chain, Reducer, View, Decide
│   ├── chain.ts          # append, fold, take, verify, computeHash
│   ├── store.ts          # Store interface
│   ├── runtime.ts        # Composition: store + decide + reduce → Runtime
│   └── capability.ts     # Builder DSL with reads/writes contracts (optional)
│
├── adapters/             # Persistence adapters
│   └── jsonl.ts          # JSONL file store
│
├── modules/              # Domain modules (pure)
│   └── todo.ts           # decide: Cmd → Event[], reduce: (S, E) → S
│
├── views/                # View functions (Chain → Output)
│   └── html.ts           # HTML views (HTMX-style “islands”)
│
└── server.ts             # HTTP layer (thin routing)
```

---

## Plain-English glossary

| Term            | Meaning                                                         |
| --------------- | --------------------------------------------------------------- |
| **Receipt**     | A timestamped record of something that happened. Immutable.     |
| **Chain**       | Receipts linked by hashes. Edit history and the chain breaks.   |
| **Event**       | A fact: “todo added,” “payment posted,” “tool returned result.” |
| **Command**     | An intent: “add todo,” “transfer funds,” “run tool.”            |
| **State**       | Current derived view (computed from events).                    |
| **Fold**        | Replay events in order to compute state.                        |
| **Reducer**     | One fold step: `(state, event) → state`.                        |
| **View**        | A projection: `(chain/state) → HTML/JSON/etc`.                  |
| **Stream**      | A named chain (session, tenant, aggregate, etc.).               |
| **Hash**        | A fingerprint: change one byte, the hash changes.               |
| **Time travel** | Compute past state by folding only a prefix.                    |
| **Branch**      | Fork the chain at index N into a new stream.                    |

---

## Core concepts

### Receipt

```ts
type Receipt<Body> = {
  id: string;
  ts: number;
  stream: string;
  prev?: string;                  // hash of previous receipt
  body: Body;                     // domain event (fact)
  hash: string;                   // hash(id + ts + stream + prev + body)
  hints?: Record<string, unknown> // non-authoritative metadata
};
```

### Chain operations

```ts
const [newChain, r] = append(chain, stream, event);

const state = fold(chain, reducer, initial);

const pastChain = take(chain, n);
const pastState = fold(pastChain, reducer, initial);

const result = verify(chain); // ok / reason
```

### Domain module (pure)

```ts
type Cmd =
  | { type: "add"; text: string }
  | { type: "toggle"; id: string };

type Event =
  | { type: "todo.added"; id: string; text: string }
  | { type: "todo.toggled"; id: string };

const decide = (cmd: Cmd): Event[] => {
  switch (cmd.type) {
    case "add":    return [{ type: "todo.added", id: makeId(), text: cmd.text }];
    case "toggle": return [{ type: "todo.toggled", id: cmd.id }];
  }
};

const reduce = (state: State, event: Event): State => {
  switch (event.type) {
    case "todo.added":   return addTodo(state, event);
    case "todo.toggled": return toggleTodo(state, event.id);
  }
};
```

### Runtime (composition)

```ts
const store = jsonlStore<Event>(DATA_DIR);
const rt = createRuntime(store, decide, reduce, initial);

await rt.execute(stream, { type: "add", text: "Hello" });

const stateNow = await rt.state(stream);
const stateThen = await rt.stateAt(stream, 5);

const integrity = await rt.verify(stream);
```

---

## Data

Receipts persist as `./data/<stream>.jsonl`:

```jsonl
{"id":"abc123","ts":1234567890,"stream":"demo","body":{"type":"todo.added","id":"xyz","text":"Hello"},"hash":"..."}
{"id":"def456","ts":1234567891,"stream":"demo","prev":"...","body":{"type":"todo.toggled","id":"xyz"},"hash":"..."}
```

---

## Included demo

This repo includes a small todo app with a chain explorer to make the model tangible:

* **State panel**: derived from `fold(chain, reducer, initial)`
* **Chain panel**: raw receipt history
* **Time travel**: scrub history with VCR-style controls
* **Branching**: fork at any point and explore
* **Verification**: integrity status via hash-chain checks

The UI is optional. The chain is the product.

---
