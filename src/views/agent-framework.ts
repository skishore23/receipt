// ============================================================================
// Agent Framework UI primitives (shared coordination/context projections)
// ============================================================================

export const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 3)}...`;
