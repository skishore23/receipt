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
import { computeHash, fold, receipt, verify } from "./chain.js";
// ============================================================================
// Create Runtime
// ============================================================================
export const createRuntime = (store, branchStore, decide, reducer, initial) => {
    const streamLocks = new Map();
    const snapshots = new Map();
    const enqueueStream = async (stream, op) => {
        const previous = streamLocks.get(stream) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        const gate = previous.then(() => current);
        streamLocks.set(stream, gate);
        await previous;
        try {
            return await op();
        }
        finally {
            if (release)
                release();
            if (streamLocks.get(stream) === gate) {
                streamLocks.delete(stream);
            }
        }
    };
    const withStreamLocks = (streams, op) => {
        const ordered = [...new Set(streams)].sort();
        const runLocked = (index) => {
            if (index >= ordered.length)
                return op();
            return enqueueStream(ordered[index], () => runLocked(index + 1));
        };
        return runLocked(0);
    };
    const relinkLocalChain = (stream, localChain, initialPrev) => {
        let prev = initialPrev;
        return localChain.map((entry) => {
            const base = {
                id: entry.id,
                ts: entry.ts,
                stream,
                prev,
                body: entry.body,
            };
            const next = {
                ...base,
                hash: computeHash(base),
                hints: entry.hints,
            };
            prev = next.hash;
            return next;
        });
    };
    const parentPrefixMatches = (parentPrefix, localChain) => {
        if (parentPrefix.length === 0 || localChain.length < parentPrefix.length)
            return false;
        for (let index = 0; index < parentPrefix.length; index += 1) {
            const parent = parentPrefix[index];
            const local = localChain[index];
            if (!parent || !local)
                return false;
            if (parent.ts !== local.ts)
                return false;
            if (JSON.stringify(parent.body) !== JSON.stringify(local.body))
                return false;
        }
        return true;
    };
    const materializeChain = async (stream, localChain, seen) => {
        if (seen.has(stream)) {
            throw new Error(`Branch cycle detected for stream '${stream}'`);
        }
        seen.add(stream);
        try {
            const branch = await branchStore.get(stream);
            if (!branch?.parent || typeof branch.forkAt !== "number") {
                return localChain;
            }
            const parentSnapshot = await loadSnapshot(branch.parent, seen);
            const parentPrefix = parentSnapshot.chain.slice(0, branch.forkAt);
            const trimmedLocal = parentPrefixMatches(parentPrefix, localChain)
                ? localChain.slice(parentPrefix.length)
                : localChain;
            if (trimmedLocal.length === 0)
                return parentPrefix;
            const relinked = relinkLocalChain(stream, trimmedLocal, parentPrefix[parentPrefix.length - 1]?.hash);
            return [...parentPrefix, ...relinked];
        }
        finally {
            seen.delete(stream);
        }
    };
    const loadSnapshot = async (stream, seen = new Set()) => {
        const branch = await branchStore.get(stream);
        const branchKey = branch
            ? `${branch.name}:${branch.parent ?? ""}:${branch.forkAt ?? ""}:${branch.createdAt}`
            : "";
        const cached = snapshots.get(stream);
        if (cached) {
            if (!store.version)
                return cached;
            const currentVersion = await store.version(stream);
            if (currentVersion === cached.version && cached.branchKey === branchKey)
                return cached;
        }
        const localChain = [...await store.read(stream)];
        const chain = [...await materializeChain(stream, localChain, seen)];
        let state = initial;
        let foldStartIndex = 0;
        if (cached && cached.branchKey === branchKey && chain.length >= cached.chain.length) {
            const cachedLength = cached.chain.length;
            if (cachedLength > 0) {
                const lastCached = cached.chain[cachedLength - 1];
                const correspondingNew = chain[cachedLength - 1];
                if (correspondingNew && correspondingNew.hash === lastCached?.hash) {
                    state = cached.state;
                    foldStartIndex = cachedLength;
                }
            }
        }
        for (let i = foldStartIndex; i < chain.length; i++) {
            state = reducer(state, chain[i].body, chain[i].ts);
        }
        const snapshot = {
            chain,
            localChain,
            state,
            version: store.version ? await store.version(stream) : undefined,
            branchKey,
        };
        snapshots.set(stream, snapshot);
        return snapshot;
    };
    const getChain = async (stream) => (await loadSnapshot(stream)).chain;
    const getChainAt = async (stream, n) => (await loadSnapshot(stream)).chain.slice(0, n);
    const getState = async (stream) => {
        return (await loadSnapshot(stream)).state;
    };
    const getStateAt = async (stream, n) => {
        if (n === 0)
            return initial;
        const snapshot = await loadSnapshot(stream);
        return fold(snapshot.chain.slice(0, n), reducer, initial);
    };
    const asEmitLike = (cmd) => {
        if (!cmd || typeof cmd !== "object")
            return undefined;
        const value = cmd;
        if (typeof value.eventId === "string" || typeof value.expectedPrev === "string")
            return value;
        return undefined;
    };
    const alreadyApplied = (chain, eventId) => chain.some((r) => {
        const hint = r.hints?.eventId;
        if (typeof hint !== "string")
            return false;
        return hint === eventId || hint.startsWith(`${eventId}#`);
    });
    const execute = async (stream, cmd) => withStreamLocks([stream], async () => {
        const emitLike = asEmitLike(cmd);
        const eventId = emitLike?.eventId;
        const expectedPrev = emitLike?.expectedPrev;
        const snapshot = await loadSnapshot(stream);
        const chain = snapshot.chain;
        if (eventId && chain && alreadyApplied(chain, eventId)) {
            return [];
        }
        const head = chain[chain.length - 1];
        if (typeof expectedPrev === "string" && expectedPrev !== (head?.hash ?? undefined)) {
            throw new Error(`Expected prev hash ${expectedPrev} but head is ${head?.hash ?? "undefined"}`);
        }
        const events = decide(cmd);
        let prev = head?.hash;
        let localPrev = snapshot.localChain[snapshot.localChain.length - 1]?.hash;
        let nextState = snapshot.state;
        const appended = [...chain];
        const localChain = [...snapshot.localChain];
        for (let idx = 0; idx < events.length; idx += 1) {
            const event = events[idx];
            const eventHint = eventId === undefined
                ? undefined
                : events.length === 1
                    ? eventId
                    : `${eventId}#${idx}`;
            const r = receipt(stream, prev, event, Date.now(), eventHint ? { eventId: eventHint } : undefined);
            await store.append(r, localPrev);
            localPrev = r.hash;
            prev = r.hash;
            appended.push(r);
            localChain.push(r);
            nextState = reducer(nextState, event, r.ts);
        }
        if (events.length > 0) {
            snapshots.set(stream, {
                chain: appended,
                localChain,
                state: nextState,
                version: store.version ? await store.version(stream) : snapshot.version,
                branchKey: snapshot.branchKey,
            });
        }
        return events;
    });
    const fork = async (stream, at, newName) => withStreamLocks([stream, newName], async () => {
        const parentChain = await getChain(stream);
        if (at < 0 || at > parentChain.length) {
            throw new Error(`Cannot fork ${stream} at ${at}; valid range is 0..${parentChain.length}`);
        }
        const existingBranch = await branchStore.get(newName);
        if (existingBranch) {
            throw new Error(`Branch '${newName}' already exists`);
        }
        const existingLocalChain = await store.read(newName);
        if (existingLocalChain.length > 0) {
            throw new Error(`Stream '${newName}' already has receipts`);
        }
        const branch = {
            name: newName,
            parent: stream,
            forkAt: at,
            createdAt: Date.now(),
        };
        await branchStore.save(branch);
        const parentBranch = await branchStore.get(stream);
        if (!parentBranch) {
            await branchStore.save({ name: stream, createdAt: Date.now() });
        }
        snapshots.delete(newName);
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
        listStreams: (prefix) => store.listStreams ? store.listStreams(prefix) : Promise.resolve([]),
    };
};
