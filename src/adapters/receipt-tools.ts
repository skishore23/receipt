// ============================================================================
// Receipt tools - reusable helpers for SQLite-backed receipt streams
// ============================================================================

export type ReceiptStreamInfo = {
  readonly name: string;
  readonly size: number;
  readonly mtime: number;
};

export type ReceiptRecord = {
  readonly raw: string;
  readonly data?: Record<string, unknown>;
};

export const buildReceiptContext = (records: ReadonlyArray<ReceiptRecord>, maxChars: number): string => {
  let out = "";
  for (const r of records) {
    const line = r.raw.trim();
    if (!line) continue;
    if (out.length + line.length + 1 > maxChars) break;
    out += line + "\n";
  }
  return out.trim();
};

export const buildReceiptTimeline = (
  records: ReadonlyArray<ReceiptRecord>,
  depth: number,
): Array<{ label: string; count: number }> => {
  const level = Math.max(1, Math.min(depth, 3));
  const buckets: Array<{ label: string; count: number }> = [];
  const index = new Map<string, number>();
  for (const r of records) {
    const rawBody = r.data?.body;
    const body = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody))
      ? rawBody as Record<string, unknown>
      : undefined;
    const type = typeof body?.type === "string" ? body.type : "receipt";
    const prefix = type.split(".")[0] || type;
    const agentId = typeof body?.agentId === "string"
      ? body.agentId
      : typeof body?.agent === "string"
        ? body.agent
        : typeof body?.role === "string"
          ? body.role
          : "";
    let label = "run";
    if (level === 2) label = prefix;
    if (level >= 3) label = agentId ? `${prefix}/${agentId}` : prefix;
    const idx = index.get(label);
    if (idx === undefined) {
      index.set(label, buckets.length);
      buckets.push({ label, count: 1 });
    } else {
      buckets[idx] = { ...buckets[idx], count: buckets[idx].count + 1 };
    }
  }
  return buckets;
};
