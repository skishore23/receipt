// ============================================================================
// Memory Views — lens-based grouping for derived memory slices
// ============================================================================

export type MemoryItem = {
  readonly kind: string;
  readonly content: string;
  readonly agentId?: string;
  readonly claimId?: string;
  readonly targetClaimId?: string;
  readonly score?: number;
  readonly ts?: number;
};

export type MemoryLens = {
  readonly label?: string;
  readonly order?: ReadonlyArray<string>;
  readonly labels?: Readonly<Record<string, string>>;
};

export type FormatMemoryOptions = {
  readonly lens?: MemoryLens;
  readonly summary?: string;
  readonly podForItem: (item: MemoryItem) => string | undefined;
  readonly formatItem: (item: MemoryItem) => string;
};

export type RankedContextResult<T> = {
  readonly text: string;
  readonly items: ReadonlyArray<T>;
  readonly truncated: boolean;
  readonly chars: number;
};

export type BuildRankedContextOptions<T> = {
  readonly items: ReadonlyArray<T>;
  readonly score: (item: T) => number;
  readonly ts: (item: T) => number;
  readonly line: (item: T) => string;
  readonly maxChars: number;
  readonly maxItems: number;
  readonly maxLineChars?: number;
  readonly pinned?: ReadonlyArray<T>;
  readonly key?: (item: T) => string | undefined;
};

const sortItems = (items: ReadonlyArray<MemoryItem>): MemoryItem[] =>
  [...items].sort((a, b) => {
    const scoreA = a.score ?? 0;
    const scoreB = b.score ?? 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    const tsA = a.ts ?? 0;
    const tsB = b.ts ?? 0;
    return tsB - tsA;
  });

const truncateLine = (line: string, max: number): { text: string; truncated: boolean } => {
  if (line.length <= max) return { text: line, truncated: false };
  if (max <= 3) return { text: line.slice(0, Math.max(0, max)), truncated: true };
  return { text: `${line.slice(0, max - 3)}...`, truncated: true };
};

export const formatLensMemory = (
  items: ReadonlyArray<MemoryItem>,
  opts: FormatMemoryOptions
): string[] => {
  const parts: string[] = [];
  if (opts.lens?.label) parts.push(opts.lens.label);
  if (opts.summary) parts.push(opts.summary);

  const order = opts.lens?.order ?? [];
  const labels = opts.lens?.labels ?? {};
  const groups = new Map<string, MemoryItem[]>();
  const misc: MemoryItem[] = [];

  for (const item of items) {
    const pod = opts.podForItem(item);
    if (!pod) {
      misc.push(item);
      continue;
    }
    const bucket = groups.get(pod) ?? [];
    bucket.push(item);
    groups.set(pod, bucket);
  }

  const used = new Set<string>();
  const renderGroup = (pod: string, groupItems: MemoryItem[]) => {
    if (!groupItems.length) return;
    used.add(pod);
    const label = labels[pod];
    const header = label ? `${pod} — ${label}` : pod;
    const lines = sortItems(groupItems).map(opts.formatItem).join("\n");
    parts.push(`${header}\n${lines}`);
  };

  order.forEach((pod) => {
    const groupItems = groups.get(pod);
    if (groupItems) renderGroup(pod, groupItems);
  });

  for (const [pod, groupItems] of groups.entries()) {
    if (used.has(pod)) continue;
    renderGroup(pod, groupItems);
  }

  if (misc.length) {
    const lines = sortItems(misc).map(opts.formatItem).join("\n");
    parts.push(`Other\n${lines}`);
  }

  return parts;
};

export const buildRankedContext = <T>(opts: BuildRankedContextOptions<T>): RankedContextResult<T> => {
  const maxChars = Math.max(0, opts.maxChars);
  const maxItems = Math.max(0, opts.maxItems);
  const maxLineChars = Math.max(8, opts.maxLineChars ?? 320);
  if (maxChars === 0 || maxItems === 0 || opts.items.length === 0) {
    return { text: "", items: [], truncated: false, chars: 0 };
  }

  const keyFor = opts.key ?? (() => undefined);
  const seen = new Set<string>();
  const selected: T[] = [];

  const trySelect = (item: T): boolean => {
    if (selected.length >= maxItems) return false;
    const key = keyFor(item);
    if (key && seen.has(key)) return false;
    selected.push(item);
    if (key) seen.add(key);
    return true;
  };

  (opts.pinned ?? []).forEach((item) => {
    trySelect(item);
  });

  const ranked = [...opts.items].sort((a, b) => {
    const scoreDelta = opts.score(b) - opts.score(a);
    if (scoreDelta !== 0) return scoreDelta;
    return opts.ts(b) - opts.ts(a);
  });
  ranked.forEach((item) => {
    trySelect(item);
  });

  let truncated = false;
  const lines: string[] = [];
  for (const item of selected) {
    const raw = opts.line(item);
    const compact = truncateLine(raw, maxLineChars);
    lines.push(compact.text);
    if (compact.truncated) truncated = true;
  }

  let keptCount = lines.length;
  let text = lines.join("\n").trim();
  while (text.length > maxChars && keptCount > 1) {
    truncated = true;
    keptCount -= 1;
    text = lines.slice(0, keptCount).join("\n").trim();
  }
  if (text.length > maxChars) {
    truncated = true;
    if (maxChars <= 3) text = text.slice(0, maxChars);
    else text = `${text.slice(0, maxChars - 3)}...`;
  }

  return {
    text,
    items: selected.slice(0, keptCount),
    truncated,
    chars: text.length,
  };
};
