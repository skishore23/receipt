// ============================================================================
// OpenAI adapter - minimal text generation (no tools)
// ============================================================================

import OpenAI from "openai";

const model = process.env.OPENAI_MODEL ?? "gpt-5.2";
let client: OpenAI | null = null;
let rateLimitUntil = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimit = (err: unknown): boolean => {
  const anyErr = err as { status?: number; code?: number; name?: string } | undefined;
  if (!anyErr) return false;
  if (anyErr.status === 429 || anyErr.code === 429) return true;
  if (typeof anyErr.name === "string" && /ratelimit/i.test(anyErr.name)) return true;
  return false;
};

const parseRetryMs = (value?: string | null): number | null => {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.endsWith("ms")) {
    const ms = Number.parseFloat(v.slice(0, -2));
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null;
  }
  if (v.endsWith("s")) {
    const s = Number.parseFloat(v.slice(0, -1));
    return Number.isFinite(s) ? Math.max(0, Math.round(s * 1000)) : null;
  }
  const num = Number.parseFloat(v);
  if (!Number.isFinite(num)) return null;
  return num >= 1000 ? Math.round(num) : Math.round(num * 1000);
};

const extractRetryDelayMs = (err: unknown): number | null => {
  const anyErr = err as { message?: string; headers?: { get?: (k: string) => string | null } } | undefined;
  const msg = typeof anyErr?.message === "string" ? anyErr.message : "";
  const msgMatch = msg.match(/try again in (\d+)ms/i);
  if (msgMatch) return Number.parseInt(msgMatch[1], 10);
  const headers = anyErr?.headers;
  if (headers?.get) {
    const retryMs = parseRetryMs(headers.get("retry-after-ms"));
    if (retryMs !== null) return retryMs;
    const retryAfter = parseRetryMs(headers.get("retry-after"));
    if (retryAfter !== null) return retryAfter;
    const resetTokens = parseRetryMs(headers.get("x-ratelimit-reset-tokens"));
    if (resetTokens !== null) return resetTokens;
    const resetReqs = parseRetryMs(headers.get("x-ratelimit-reset-requests"));
    if (resetReqs !== null) return resetReqs;
  }
  return null;
};

const withRateLimitRetry = async <T>(op: () => Promise<T>): Promise<T> => {
  const maxRetries = Number.parseInt(process.env.OPENAI_MAX_RETRIES ?? "3", 10);
  const baseDelay = Number.parseInt(process.env.OPENAI_RETRY_BASE_MS ?? "500", 10);
  let attempt = 0;
  while (true) {
    const now = Date.now();
    if (rateLimitUntil > now) {
      await sleep(rateLimitUntil - now);
    }
    try {
      return await op();
    } catch (err) {
      if (!isRateLimit(err) || attempt >= maxRetries) throw err;
      attempt += 1;
      const retryMs = extractRetryDelayMs(err);
      const backoff = retryMs ?? Math.min(8000, baseDelay * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 200);
      const waitMs = Math.max(0, backoff + jitter);
      rateLimitUntil = Math.max(rateLimitUntil, Date.now() + waitMs);
      await sleep(waitMs);
    }
  }
};

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");
    client = new OpenAI({ apiKey });
  }
  return client;
}

// ============================================================================
// Text Generation
// ============================================================================

type LlmTextOptions = {
  readonly system?: string;
  readonly user: string;
};

export const llmText = async (opts: LlmTextOptions): Promise<string> => {
  return withRateLimitRetry(async () => {
    const response = await getClient().responses.create({
      model,
      instructions: opts.system,
      input: opts.user,
    });
    return response.output_text?.trim() ?? "";
  });
};
