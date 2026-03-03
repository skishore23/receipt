// ============================================================================
// Runtime — Composition of store, capabilities, and views
// 
// The runtime is the "engine" that:
// 1. Takes commands
// 2. Runs decide to get events
// 3. Wraps events in receipts
// 4. Appends to store
// 5. Provides views over the chain
// 6. Supports branching (forking chains at any point)
// ============================================================================

import type { Chain, Decide, Reducer, Branch, Store, BranchStore } from "./types.js";
import { receipt, fold, verify } from "./chain.js";

// ============================================================================
// Runtime Type
// ============================================================================

export type Runtime<Cmd, Event, State> = {
  // Execute a command, returns the events that were recorded
  readonly execute: (stream: string, cmd: Cmd) => Promise<Event[]>;
  
  // Get current state (full replay)
  readonly state: (stream: string) => Promise<State>;
  
  // Get state at a specific point (time travel)
  readonly stateAt: (stream: string, n: number) => Promise<State>;
  
  // Get the chain
  readonly chain: (stream: string) => Promise<Chain<Event>>;
  
  // Get chain prefix (time travel)
  readonly chainAt: (stream: string, n: number) => Promise<Chain<Event>>;
  
  // Verify chain integrity
  readonly verify: (stream: string) => Promise<ReturnType<typeof verify>>;
  
  // Fork a stream at a given point, creating a new branch
  readonly fork: (stream: string, at: number, newName: string) => Promise<Branch>;
  
  // Get branch metadata
  readonly branch: (stream: string) => Promise<Branch | undefined>;
  
  // List all branches
  readonly branches: () => Promise<Branch[]>;
  
  // List child branches of a stream
  readonly children: (stream: string) => Promise<Branch[]>;
};

// ============================================================================
// Create Runtime
// ============================================================================

export const createRuntime = <Cmd, Event, State>(
  store: Store<Event>,
  branchStore: BranchStore,
  decide: Decide<Cmd, Event>,
  reducer: Reducer<State, Event>,
  initial: State
): Runtime<Cmd, Event, State> => {
  type EmitLikeCommand = {
    readonly eventId?: string;
    readonly expectedPrev?: string;
  };

  const getChain = (stream: string) => store.read(stream);
  const getChainAt = (stream: string, n: number) => store.take(stream, n);
  const streamLocks = new Map<string, Promise<void>>();

  const enqueueStream = async <T>(stream: string, op: () => Promise<T>): Promise<T> => {
    const previous = streamLocks.get(stream) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = previous.then(() => current);
    streamLocks.set(stream, gate);

    await previous;
    try {
      return await op();
    } finally {
      if (release) release();
      if (streamLocks.get(stream) === gate) {
        streamLocks.delete(stream);
      }
    }
  };

  const withStreamLocks = <T>(streams: ReadonlyArray<string>, op: () => Promise<T>): Promise<T> => {
    const ordered = [...new Set(streams)].sort();

    const runLocked = (index: number): Promise<T> => {
      if (index >= ordered.length) return op();
      return enqueueStream(ordered[index], () => runLocked(index + 1));
    };

    return runLocked(0);
  };

  const getState = async (stream: string) => {
    const chain = await getChain(stream);
    return fold(chain, reducer, initial);
  };

  const getStateAt = async (stream: string, n: number) => {
    if (n === 0) return initial;
    const chain = await getChainAt(stream, n);
    return fold(chain, reducer, initial);
  };

  const asEmitLike = (cmd: Cmd): EmitLikeCommand | undefined => {
    if (!cmd || typeof cmd !== "object") return undefined;
    const value = cmd as EmitLikeCommand;
    if (typeof value.eventId === "string" || typeof value.expectedPrev === "string") return value;
    return undefined;
  };

  const alreadyApplied = <B>(
    chain: Chain<B>,
    eventId: string
  ): boolean => chain.some((r) => {
    const hint = r.hints?.eventId;
    if (typeof hint !== "string") return false;
    return hint === eventId || hint.startsWith(`${eventId}#`);
  });

  const execute = async (stream: string, cmd: Cmd): Promise<Event[]> =>
    withStreamLocks([stream], async () => {
      const emitLike = asEmitLike(cmd);
      const eventId = emitLike?.eventId;
      const expectedPrev = emitLike?.expectedPrev;
      const chain = eventId ? await store.read(stream) : undefined;

      if (eventId && chain && alreadyApplied(chain, eventId)) {
        return [];
      }

      const head = chain ? chain[chain.length - 1] : await store.head(stream);
      if (typeof expectedPrev === "string" && expectedPrev !== (head?.hash ?? undefined)) {
        throw new Error(`Expected prev hash ${expectedPrev} but head is ${head?.hash ?? "undefined"}`);
      }

      const events = decide(cmd);
      let prev = head?.hash;

      for (let idx = 0; idx < events.length; idx += 1) {
        const event = events[idx];
        const eventHint =
          eventId === undefined
            ? undefined
            : events.length === 1
              ? eventId
              : `${eventId}#${idx}`;
        const r = receipt(stream, prev, event, Date.now(), eventHint ? { eventId: eventHint } : undefined);
        await store.append(r);
        prev = r.hash;
      }
      return events;
    });
  
  const fork = async (stream: string, at: number, newName: string): Promise<Branch> =>
    withStreamLocks([stream, newName], async () => {
      // Get receipts up to fork point from parent.
      const parentChain = await getChainAt(stream, at);
      
      // Copy receipts to new stream (re-link to form new chain).
      let prev: string | undefined;
      for (const r of parentChain) {
        const newReceipt = receipt(newName, prev, r.body, r.ts);
        await store.append(newReceipt);
        prev = newReceipt.hash;
      }
      
      // Save branch metadata.
      const branch: Branch = {
        name: newName,
        parent: stream,
        forkAt: at,
        createdAt: Date.now(),
      };
      await branchStore.save(branch);
      
      // Ensure parent branch exists in metadata.
      const parentBranch = await branchStore.get(stream);
      if (!parentBranch) {
        await branchStore.save({ name: stream, createdAt: Date.now() });
      }

      return branch;
    });
  
  return {
    execute,
    state: getState,
    stateAt: getStateAt,
    chain: getChain,
    chainAt: getChainAt,
    verify: async (stream) => verify(await getChain(stream)),
    fork,
    branch: (stream) => branchStore.get(stream),
    branches: () => branchStore.list(),
    children: (stream) => branchStore.children(stream),
  };
};
