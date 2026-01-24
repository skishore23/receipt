// ============================================================================
// Core Types — The Axioms
// 
// Everything else is built from these primitives.
// ============================================================================

// A Hash is a content-addressable identifier
export type Hash = string;

// A Receipt is immutable evidence of something that happened
export type Receipt<Body = unknown> = {
  readonly id: string;
  readonly ts: number;
  readonly stream: string;
  readonly prev?: Hash;
  readonly body: Body;
  readonly hash: Hash;
  readonly hints?: Record<string, unknown>;  // optional metadata (non-authoritative)
};

// A Chain is an append-only sequence of receipts
export type Chain<Body = unknown> = readonly Receipt<Body>[];

// A Branch is a named fork from a parent chain at a specific point
export type Branch = {
  readonly name: string;        // branch/stream name
  readonly parent?: string;     // parent branch name (undefined = root)
  readonly forkAt?: number;     // index in parent where forked
  readonly createdAt: number;   // timestamp
};

// Result type for operations that can fail
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// A Reducer folds a receipt into state
export type Reducer<S, B> = (state: S, body: B, ts: number) => S;

// A View transforms a chain into some output
export type View<B, O> = (chain: Chain<B>) => O;

// A Decide transforms a command into events (pure)
export type Decide<Cmd, Event> = (cmd: Cmd) => Event[];
