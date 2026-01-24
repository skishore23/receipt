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

import type { Chain, Decide, Reducer, View, Branch } from "./types.js";
import type { Store, BranchStore } from "./store.js";
import { receipt, fold, verify, head } from "./chain.js";

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
  
  // Apply a view to the chain
  readonly view: <O>(stream: string, v: View<Event, O>) => Promise<O>;
  
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
  
  const getChain = (stream: string) => store.read(stream);
  const getChainAt = (stream: string, n: number) => store.take(stream, n);
  
  const getState = async (stream: string) => {
    const chain = await getChain(stream);
    return fold(chain, reducer, initial);
  };
  
  const getStateAt = async (stream: string, n: number) => {
    const chain = await getChainAt(stream, n);
    return fold(chain, reducer, initial);
  };
  
  const execute = async (stream: string, cmd: Cmd): Promise<Event[]> => {
    const events = decide(cmd);
    let prev = (await store.head(stream))?.hash;
    
    for (const event of events) {
      const r = receipt(stream, prev, event);
      await store.append(r);
      prev = r.hash;
    }
    
    return events;
  };
  
  const fork = async (stream: string, at: number, newName: string): Promise<Branch> => {
    // Get receipts up to fork point from parent
    const parentChain = await getChainAt(stream, at);
    
    // Copy receipts to new stream (re-link to form new chain)
    let prev: string | undefined;
    for (const r of parentChain) {
      const newReceipt = receipt(newName, prev, r.body as Event, r.ts);
      await store.append(newReceipt);
      prev = newReceipt.hash;
    }
    
    // Save branch metadata
    const branch: Branch = {
      name: newName,
      parent: stream,
      forkAt: at,
      createdAt: Date.now(),
    };
    await branchStore.save(branch);
    
    // Ensure parent branch exists in metadata
    const parentBranch = await branchStore.get(stream);
    if (!parentBranch) {
      await branchStore.save({ name: stream, createdAt: Date.now() });
    }
    
    return branch;
  };
  
  return {
    execute,
    state: getState,
    stateAt: getStateAt,
    chain: getChain,
    chainAt: getChainAt,
    view: async (stream, v) => v(await getChain(stream)),
    verify: async (stream) => verify(await getChain(stream)),
    fork,
    branch: (stream) => branchStore.get(stream),
    branches: () => branchStore.list(),
    children: (stream) => branchStore.children(stream),
  };
};
