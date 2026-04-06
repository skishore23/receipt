import type { MemoryTools } from "../../../adapters/memory-tools";

export const commitWorkerSummary = async (
  memoryTools: MemoryTools,
  scope: string,
  text: string,
  meta: Readonly<Record<string, unknown>>,
): Promise<void> => {
  await memoryTools.commit({
    scope,
    text,
    tags: ["factory-chat", "worker"],
    meta,
  });
};

export const summarizeMemoryScope = async (
  memoryTools: MemoryTools,
  input: {
    readonly scope: string;
    readonly query: string;
    readonly maxChars: number;
    readonly audit: Readonly<Record<string, unknown>>;
  },
): Promise<string | undefined> => {
  try {
    const { summary } = await memoryTools.summarize({
      scope: input.scope,
      query: input.query,
      limit: 6,
      maxChars: input.maxChars,
      audit: input.audit,
    });
    const trimmed = summary.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
};

export const resolveProfileMemorySummary = async (input: {
  readonly memoryTools: MemoryTools;
  readonly repoKey: string;
  readonly profileId: string;
  readonly primaryScope: string;
  readonly primarySummary: string;
  readonly query: string;
  readonly runId: string;
  readonly iteration: number;
}): Promise<string | undefined> => {
  const profileScope = `repos/${input.repoKey}/profiles/${input.profileId}`;
  return input.primaryScope === profileScope
    ? input.primarySummary.trim() || undefined
    : summarizeMemoryScope(input.memoryTools, {
        scope: profileScope,
        query: input.query,
        maxChars: 320,
        audit: {
          actor: "factory-chat",
          operation: "profile-memory",
          runId: input.runId,
          iteration: input.iteration,
          label: "Profile memory",
        },
      });
};
