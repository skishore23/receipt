export class TimeoutError extends Error {
  readonly code = "E_TIMEOUT";

  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Math.floor(ms)));

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const isAbortError = (err: unknown): boolean =>
  err instanceof Error && (err.name === "AbortError" || err.message === "aborted");

export const isTimeoutError = (err: unknown): boolean =>
  err instanceof TimeoutError || (
    err instanceof Error
    && typeof (err as { readonly code?: unknown }).code === "string"
    && (err as { readonly code?: string }).code === "E_TIMEOUT"
  );

export const withTimeout = async <T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> => {
  const timeout = Math.max(0, Math.floor(timeoutMs));
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  if (timeout === 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${timeout}ms`));
    }, timeout);
  });
  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const retryOnceWithBackoff = async <T>(
  work: () => Promise<T>,
  opts: {
    readonly label: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<T> => {
  try {
    return await withTimeout(work(), opts.timeoutMs ?? 5_000, opts.label, opts.signal);
  } catch (err) {
    if (opts.signal?.aborted || isAbortError(err) || isTimeoutError(err)) throw err;
    const jitter = 200 + Math.floor(Math.random() * 600);
    await sleep(jitter, opts.signal);
    return withTimeout(work(), opts.timeoutMs ?? 5_000, opts.label, opts.signal);
  }
};
