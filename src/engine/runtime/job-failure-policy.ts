export type JobFailureDecision = {
  readonly error: string;
  readonly noRetry: boolean;
};

export const deriveJobFailureDecision = (normalizedResult: Record<string, unknown>): JobFailureDecision => {
  const failure = typeof normalizedResult.failure === "object" && normalizedResult.failure && !Array.isArray(normalizedResult.failure)
    ? normalizedResult.failure as Record<string, unknown>
    : undefined;
  const failureMessage = typeof failure?.message === "string" && failure.message.trim()
    ? failure.message
    : undefined;
  const note = typeof normalizedResult.note === "string" && normalizedResult.note.trim()
    ? normalizedResult.note.trim()
    : undefined;

  return {
    error: note ?? failureMessage ?? "run failed",
    noRetry: failure?.retryable === true ? false : true,
  };
};
