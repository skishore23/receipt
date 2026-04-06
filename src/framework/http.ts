export const html = (body: string, headers?: Record<string, string>): Response =>
  new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...(headers ?? {}),
    },
  });


export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
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



export const makeEventId = (stream: string): string =>
  `${stream}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

export const trimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const optionalTrimmedString = (value: unknown): string | undefined => {
  const next = trimmedString(value);
  return next || undefined;
};

export const requireTrimmedString = (value: unknown, message: string): string => {
  const next = trimmedString(value);
  if (!next) throw new Error(message);
  return next;
};


export const readRecordBody = async (
  req: Request,
  makeError: (message: string) => Error,
): Promise<Record<string, unknown>> => {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const raw = await req.text();
    if (!raw.trim()) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw makeError("Malformed JSON body");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw makeError("Request body must be an object");
    }
    return parsed as Record<string, unknown>;
  }
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const data = await req.formData();
    const out: Record<string, unknown> = {};
    data.forEach((value, key) => {
      if (typeof value === "string") out[key] = value;
    });
    return out;
  }
  const raw = await req.text();
  if (!raw.trim()) return {};
  throw makeError("Unsupported request body");
};
