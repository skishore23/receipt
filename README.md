# Receipt

Store only receipts. Derive everything else—state, UI, audit, replay—by replaying the receipt chain.

---

## The problem

Most systems persist only **what is** (a mutable snapshot), not **what happened**.

When something goes wrong, Logs are scattered, incomplete, or rotated. Audit trails are added later. Debugging turns into archaeology, and reproducing bugs becomes unreliable.

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

## 30-second terms

- **Fold** = replay all receipts in order to rebuild current state.
- **Rebracketing** = change merge order of parallel agent outputs; it does not rewrite those outputs.
- **Branch** = fork a run into a separate timeline so agents can work in parallel safely.

---

## What this is

Receipt is a **multi-agent framework** and this repo is a **reference implementation** with a small architectural kernel (~500 LoC in this repo; much less in the core) where the only durable artifact is the **receipt chain**. The API surface is small and explicit. Prompts, memory slices, and merge decisions are observable receipts.

No database required. No ORM required. Just events + pure functions.

```text
Command  →  decide  →  Event  →  append  →  Chain
                                              ↓
                                        fold (replay)
                                              ↓
                         View  ←  render  ←  State
```

* **Events are facts**: immutable, append-only, hash-linked, tamper-evident
* **State is derived**: compute it by replaying receipts (`fold`), never store it as truth
* **UI is a projection**: HTML, JSON, graphs, diffs—all from the same chain
* **Time travel is built-in**: replay the first N receipts to see past state

---

## What makes it multi-agent

- **Branching is first-class**: fork streams for parallel agents and merge explicitly.
- **Per-run streams**: each run (and branch) lives in its own JSONL file for clean replay.
- **Policy hooks**: memory, branching, and merge policies are explicit and replace hidden state.

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

---

## Comparison

| Approach           | How it differs                                                  |
| ------------------ | --------------------------------------------------------------- |
| **CRUD**           | mutable state; history is optional/partial                      |
| **Redux**          | time travel is dev-only; actions aren’t durable                 |
| **Event Sourcing** | often heavy infra + projection complexity                       |
| **Blockchain**     | consensus overhead + latency                                    |
| **Receipt**        | local-first, append-only, hash-linked, derived state via replay (`fold`) |

Receipt borrows the *useful* part of blockchains (hash-linked history) without the consensus cost, and the *useful* part of event sourcing (events as truth) without requiring a whole platform.

---

## Run

```bash
npm install
npm run dev
```

Scaffold a new Receipt Runtime agent:

```bash
npm run new:agent -- my-agent
```

Open: [http://localhost:8787](http://localhost:8787)

---

## Architecture

```text
src/
├── core/                 # The kernel (axioms)
│   ├── types.ts          # Receipt, Chain, Branch, Reducer, Decide
│   ├── chain.ts          # receipt, fold, verify, computeHash
│   ├── store.ts          # Store interface
│   └── runtime.ts        # Composition: store + decide + reduce → Runtime
│
├── adapters/             # IO adapters
│   ├── jsonl.ts          # JSONL file store + stream manifest + branch metadata receipts
│   ├── jsonl-indexed.ts  # JSONL store with sidecar indexes (head/count optimized)
│   ├── openai.ts         # LLM text generation (no tools)
│   └── receipt-tools.ts  # receipt file helpers for inspector
│
├── engine/               # Reusable orchestration primitives
│   └── runtime/          # Receipt Runtime surface
│       ├── workflow.ts   # queued emitters + lifecycle runner
│       ├── receipt-runtime.ts # defineReceiptAgent + runReceiptAgent
│       ├── planner.ts    # typed needs/provides planner
│       └── plan-validate.ts # cycle/missing provider validation
│
├── agents/               # Concrete agent workflows
│   ├── theorem.ts        # theorem guild workflow
│   ├── writer.ts         # writer guild workflow
│   └── inspector.ts      # receipt inspector workflow
│
├── modules/              # Domain modules (pure)
│   ├── todo.ts           # decide: Cmd → Event[], reduce: (S, E) → S
│   ├── planner.ts        # planner events + state
│   ├── theorem.ts        # LLM-only theorem receipts
│   ├── writer.ts         # planner-driven writer receipts
│   └── inspector.ts      # receipt inspector receipts
│
├── prompts/              # Prompt loaders
│   ├── theorem.ts
│   ├── writer.ts
│   └── inspector.ts
│
├── views/                # View functions (Chain → Output)
│   ├── html.ts           # Todo HTML views (HTMX-style “islands”)
│   ├── theorem.ts        # Theorem UI projection
│   ├── writer.ts         # Writer UI projection
│   └── receipt.ts        # Receipt inspector UI
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
const branchStore = jsonBranchStore(DATA_DIR);
const rt = createRuntime(store, branchStore, decide, reduce, initial);

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

## Built-in multi-agent apps

All agent demos are receipt-native: prompts, decisions, outputs, and status changes are durable receipts.

1. **Theorem Guild** (`/theorem`)
   - Multi-agent proof workflow with branches, memory slices, and rebracketing (merge-order selection).
2. **Writer Guild** (`/writer`)
   - Planner-driven writing workflow with explicit capability needs/provides.
3. **Receipt Inspector** (`/receipt`)
   - Multi-agent analysis of receipt files (analyze/improve/timeline/qa modes).

Set `OPENAI_API_KEY` to run LLM-backed theorem/writer/inspector analysis flows.

Run:

```bash
npm run dev
```

Optional performance mode:

```bash
RECEIPT_INDEXED_STORE=1 npm run dev
```

Open:
- http://localhost:8787/theorem
- http://localhost:8787/writer
- http://localhost:8787/receipt

---

## Build your own agent

- Start here: `docs/create-agent.md`
- Full framework reference: `docs/agent-framework.md`

Quick scaffold:

```bash
npm run new:agent -- my-agent
```

---

## Receipt runtime principles

Receipt Runtime builds multi-agent systems without hidden mutable state by default:

1. **Receipts are source of truth**: every meaningful action is appended, never mutated.
2. **State is a fold (replay)**: each view and policy is derived from chain replay.
3. **Per-run streams**: each run has its own stream; branches isolate parallel agent timelines.
4. **Planner receipts**: readiness, start, completion, and state patches are first-class events.
5. **Merge lenses**: theorem rebracketing chooses merge order from explicit bracket structures; it does not edit underlying agent outputs.
6. **Replay/debug first**: rerun or time-travel by slicing the chain, not by reconstructing logs.

---
