export type WithTimeoutOptions = {
  readonly timeoutMs: number;
  readonly label: string;
  readonly signal?: AbortSignal;
};

export const withTimeout = async <T>(
  work: Promise<T>,
  opts: WithTimeoutOptions,
): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error(`${opts.label} canceled before start`));
      return;
    }
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      finish(() => reject(new Error(`${opts.label} canceled`)));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);
    timer.unref?.();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
