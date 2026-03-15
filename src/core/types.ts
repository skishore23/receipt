// ============================================================================
// Core Types — The Axioms
// 
// Everything else is built from these primitives.
// ============================================================================

// A Receipt is immutable evidence of something that happened
export type Receipt<Body = unknown> = {
  readonly id: string;
  readonly ts: number;
  readonly stream: string;
  readonly prev?: string;
  readonly body: Body;
  readonly hash: string;
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

// A Reducer folds a receipt into state
export type Reducer<S, B> = (state: S, body: B, ts: number) => S;

// A Decide transforms a command into events (pure)
export type Decide<Cmd, Event> = (cmd: Cmd) => Event[];

// Store operations as a record of functions
export type Store<B> = {
  readonly append: (r: Receipt<B>) => Promise<void>;
  readonly read: (stream: string) => Promise<Chain<B>>;
  readonly take: (stream: string, n: number) => Promise<Chain<B>>;
  readonly count: (stream: string) => Promise<number>;
  readonly head: (stream: string) => Promise<Receipt<B> | undefined>;
  readonly version?: (stream: string) => Promise<string | undefined>;
};

// Branch metadata store
export type BranchStore = {
  readonly save: (b: Branch) => Promise<void>;
  readonly get: (name: string) => Promise<Branch | undefined>;
  readonly list: () => Promise<Branch[]>;
  readonly children: (parent: string) => Promise<Branch[]>;
};
