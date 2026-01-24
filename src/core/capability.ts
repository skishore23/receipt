// ============================================================================
// Capability — Typed morphisms with reads/writes contracts
// 
// A capability declares exactly what it reads and writes.
// This enables: type safety, parallel batching, dependency analysis.
// ============================================================================

// ============================================================================
// Types
// ============================================================================

// Keys are string literal types for reads/writes
type Keys = readonly string[];

// Extract the subset of State that matches Keys
type Pick<S, K extends Keys> = { [P in K[number] & keyof S]: S[P] };

// A Capability is a typed morphism: reads some keys, writes some keys
export type Capability<
  S extends Record<string, unknown>,
  R extends Keys,
  W extends Keys,
  Kind extends CapabilityKind = "pure"
> = {
  readonly name: string;
  readonly kind: Kind;
  readonly reads: R;
  readonly writes: W;
  readonly run: (input: Pick<S, R>) => Pick<S, W>;
};

// Kinds of capabilities (from PRD)
export type CapabilityKind = "pure" | "effect" | "human" | "llm";

// Event emitted by a capability
export type CapEvent<W extends Keys, S extends Record<string, unknown>> = {
  readonly type: string;
  readonly writes: Pick<S, W>;
};

// ============================================================================
// Builder DSL — Option A from PRD
// ============================================================================

type Builder<
  S extends Record<string, unknown>,
  R extends Keys,
  W extends Keys,
  K extends CapabilityKind
> = {
  reads: <R2 extends readonly (keyof S & string)[]>(keys: R2) => Builder<S, R2, W, K>;
  writes: <W2 extends readonly (keyof S & string)[]>(keys: W2) => Builder<S, R, W2, K>;
  kind: <K2 extends CapabilityKind>(k: K2) => Builder<S, R, W, K2>;
  run: (fn: (input: Pick<S, R>) => Pick<S, W>) => Capability<S, R, W, K>;
};

export const step = <S extends Record<string, unknown>>(name: string): Builder<S, [], [], "pure"> => {
  const build = <R extends Keys, W extends Keys, K extends CapabilityKind>(
    reads: R,
    writes: W,
    kind: K
  ): Builder<S, R, W, K> => ({
    reads: <R2 extends readonly (keyof S & string)[]>(keys: R2) => build(keys, writes, kind) as any,
    writes: <W2 extends readonly (keyof S & string)[]>(keys: W2) => build(reads, keys, kind) as any,
    kind: <K2 extends CapabilityKind>(k: K2) => build(reads, writes, k),
    run: (fn) => ({ name, kind, reads, writes, run: fn as any }),
  });
  return build([] as const, [] as const, "pure");
};

// ============================================================================
// Capability Composition
// ============================================================================

// Check if two capabilities can run in parallel (disjoint writes)
export const canParallel = <S extends Record<string, unknown>>(
  a: Capability<S, Keys, Keys, CapabilityKind>,
  b: Capability<S, Keys, Keys, CapabilityKind>
): boolean => {
  const aWrites = new Set(a.writes);
  const bWrites = new Set(b.writes);
  // No write conflicts
  for (const w of aWrites) if (bWrites.has(w)) return false;
  // A's writes don't conflict with B's reads
  for (const w of aWrites) if (b.reads.includes(w)) return false;
  // B's writes don't conflict with A's reads
  for (const w of bWrites) if (a.reads.includes(w)) return false;
  return true;
};

// Compose two capabilities sequentially
export const compose = <
  S extends Record<string, unknown>,
  R1 extends Keys,
  W1 extends Keys,
  R2 extends Keys,
  W2 extends Keys
>(
  a: Capability<S, R1, W1, CapabilityKind>,
  b: Capability<S, R2, W2, CapabilityKind>
): Capability<S, readonly [...R1, ...Exclude<R2[number], W1[number]>[]], readonly [...W1, ...W2], "pure"> => {
  // Combined reads: A's reads + B's reads that aren't satisfied by A's writes
  const combinedReads = [...a.reads, ...b.reads.filter(r => !a.writes.includes(r))] as const;
  const combinedWrites = [...a.writes, ...b.writes] as const;

  return {
    name: `${a.name} ∘ ${b.name}`,
    kind: "pure",
    reads: combinedReads as any,
    writes: combinedWrites as any,
    run: (input) => {
      const aOut = a.run(input as any);
      const merged = { ...input, ...aOut };
      const bOut = b.run(merged as any);
      return { ...aOut, ...bOut } as any;
    },
  };
};

// ============================================================================
// Execution — run capability and produce event
// ============================================================================

export const execute = <
  S extends Record<string, unknown>,
  R extends Keys,
  W extends Keys
>(
  cap: Capability<S, R, W, CapabilityKind>,
  state: S
): CapEvent<W, S> => {
  const input = {} as Pick<S, R>;
  for (const k of cap.reads) {
    (input as any)[k] = state[k];
  }
  const writes = cap.run(input);
  return { type: cap.name, writes };
};
