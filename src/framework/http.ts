export const html = (body: string, headers?: Record<string, string>): Response =>
  new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...(headers ?? {}),
    },
  });

export const text = (status: number, body: string, headers?: Record<string, string>): Response =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...(headers ?? {}),
    },
  });

export const parseAt = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
};

export const parseDepth = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
};

export const parseOrder = (s: string | null | undefined): "asc" | "desc" =>
  s === "asc" ? "asc" : "desc";

export const parseLimit = (s: string | null | undefined): number => {
  if (!s) return 200;
  const n = parseInt(s, 10);
  if (Number.isNaN(n)) return 200;
  return Math.max(10, Math.min(n, 5000));
};

export const parseInspectorDepth = (s: string | null | undefined): number => {
  const n = parseDepth(s);
  if (n === null) return 2;
  return Math.max(1, Math.min(n, 3));
};

export const parseBranch = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const trimmed = s.trim();
  return trimmed.length ? trimmed : null;
};

export const clampDepth = (total: number, requested: number | null): number => {
  if (total === 0) return 0;
  const base = requested ?? Math.min(30, total);
  return Math.max(1, Math.min(base, total));
};

export const makeEventId = (stream: string): string =>
  `${stream}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

export const toFormRecord = (body: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  Object.entries(body).forEach(([key, value]) => {
    if (typeof value === "string") out[key] = value;
  });
  return out;
};
