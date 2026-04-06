const FACTORY_TRANSIENT_OPERATION_RE =
  /\b(database is locked|sqlite_busy|resource temporarily unavailable|device or resource busy|another git process seems to be running|index\.lock|cannot lock ref|temporary failure in name resolution|name resolution|could not resolve host|enotfound|eai_again|network is unreachable|connection reset|econnreset|connection refused|econnrefused|tls handshake timeout|timed out|timeout|502 bad gateway|503 service unavailable|504 gateway timeout)\b/i;

const collectErrorMessages = (error: unknown): ReadonlyArray<string> => {
  if (error instanceof AggregateError) {
    return error.errors.flatMap((entry) => collectErrorMessages(entry));
  }
  if (error instanceof Error) {
    const messages = [error.message];
    const cause = "cause" in error ? (error as Error & { readonly cause?: unknown }).cause : undefined;
    return cause ? [...messages, ...collectErrorMessages(cause)] : messages;
  }
  return [String(error ?? "")];
};

export const transientFactoryOperationMessage = (error: unknown): string | undefined => {
  const match = collectErrorMessages(error)
    .map((value) => value.trim())
    .find((value) => value.length > 0 && FACTORY_TRANSIENT_OPERATION_RE.test(value));
  return match && match.length > 0 ? match : undefined;
};
