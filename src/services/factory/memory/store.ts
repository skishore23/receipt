import type { MemoryTools } from "../../../adapters/memory-tools";
import type {
  FactoryInvestigationSynthesisRecord,
  FactoryInvestigationTaskReport,
  FactoryState,
  FactoryTaskRecord,
} from "../../../modules/factory";
import { renderInvestigationReportText, renderWorkerHandoffText } from "../result-contracts";
import { buildTaskMemoryScopes } from "../task-packets";

type SummarizeFactoryMemoryScopeInput = {
  readonly memoryTools?: MemoryTools;
  readonly scope: string;
  readonly query: string;
  readonly limit?: number;
  readonly maxChars: number;
  readonly operation: string;
};

export const summarizeFactoryMemoryScope = async (
  input: SummarizeFactoryMemoryScopeInput,
): Promise<string | undefined> => {
  if (!input.memoryTools) return undefined;
  try {
    const { summary } = await input.memoryTools.summarize({
      scope: input.scope,
      query: input.query,
      limit: input.limit ?? 6,
      maxChars: input.maxChars,
      audit: {
        actor: "factory-service",
        operation: input.operation,
      },
    });
    const trimmed = summary.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
};

export const loadFactoryMemorySummary = async (
  memoryTools: MemoryTools | undefined,
  scope: string,
  query: string,
): Promise<string> =>
  await summarizeFactoryMemoryScope({
    memoryTools,
    scope,
    query,
    limit: 8,
    maxChars: 1_200,
    operation: "load-memory-summary",
  }) ?? "";

export const commitFactoryTaskMemory = async (
  memoryTools: MemoryTools | undefined,
  state: FactoryState,
  task: FactoryTaskRecord,
  candidateId: string,
  summary: string,
  outcome: string,
): Promise<void> => {
  if (!memoryTools) return;
  try {
    const scopes = buildTaskMemoryScopes(state, task, candidateId);
    const byKey = new Map(scopes.map((scope) => [scope.key, scope]));
    await Promise.all([
      memoryTools.commit({
        scope: byKey.get("objective")?.scope ?? `factory/objectives/${state.objectiveId}`,
        text: `[${task.taskId}] ${summary}`,
        tags: ["factory", task.taskId, outcome],
      }),
      memoryTools.commit({
        scope: byKey.get("task")?.scope ?? `factory/objectives/${state.objectiveId}/tasks/${task.taskId}`,
        text: summary,
        tags: ["factory", "task", outcome],
      }),
      memoryTools.commit({
        scope: byKey.get("candidate")?.scope ?? `factory/objectives/${state.objectiveId}/candidates/${candidateId}`,
        text: summary,
        tags: ["factory", "candidate", candidateId, outcome],
      }),
    ]);
  } catch {
    // memory is auxiliary
  }
};

type FactoryMemoryCommitInput = {
  readonly summary: string;
  readonly handoff: string;
  readonly details?: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
};

export const commitFactoryIntegrationMemory = async (
  memoryTools: MemoryTools | undefined,
  state: FactoryState,
  candidateId: string,
  input: FactoryMemoryCommitInput,
): Promise<void> => {
  if (!memoryTools) return;
  const text = renderWorkerHandoffText({
    summary: input.summary,
    handoff: input.handoff,
    details: input.details,
  });
  try {
    await Promise.all([
      memoryTools.commit({
        scope: `factory/objectives/${state.objectiveId}`,
        text: `[integration/${candidateId}] ${text}`,
        tags: ["factory", ...input.tags],
      }),
      memoryTools.commit({
        scope: `factory/objectives/${state.objectiveId}/integration`,
        text,
        tags: ["factory", ...input.tags],
      }),
    ]);
  } catch {
    // memory is auxiliary
  }
};

export const commitFactoryPublishMemory = async (
  memoryTools: MemoryTools | undefined,
  state: FactoryState,
  candidateId: string,
  input: FactoryMemoryCommitInput,
): Promise<void> => {
  if (!memoryTools) return;
  const text = renderWorkerHandoffText({
    summary: input.summary,
    handoff: input.handoff,
    details: input.details,
  });
  try {
    await Promise.all([
      memoryTools.commit({
        scope: `factory/objectives/${state.objectiveId}`,
        text: `[publish/${candidateId}] ${text}`,
        tags: ["factory", ...input.tags],
      }),
      memoryTools.commit({
        scope: `factory/objectives/${state.objectiveId}/integration`,
        text,
        tags: ["factory", "integration", ...input.tags],
      }),
      memoryTools.commit({
        scope: `factory/objectives/${state.objectiveId}/publish`,
        text,
        tags: ["factory", "publish", ...input.tags],
      }),
    ]);
  } catch {
    // memory is auxiliary
  }
};

export const commitFactoryInvestigationSynthesisMemory = async (
  memoryTools: MemoryTools | undefined,
  objectiveId: string,
  synthesis: FactoryInvestigationSynthesisRecord,
  reports: ReadonlyArray<FactoryInvestigationTaskReport>,
): Promise<void> => {
  if (!memoryTools) return;
  const handoff = [...new Set(
    reports
      .map((report) => report.handoff.trim())
      .filter((value) => value.length > 0),
  )].join("\n\n");
  const text = renderInvestigationReportText(
    synthesis.summary,
    synthesis.report,
    undefined,
    reports.map((report) => report.artifactRefs),
    handoff || undefined,
  );
  try {
    await memoryTools.commit({
      scope: `factory/objectives/${objectiveId}`,
      text,
      tags: ["factory", "objective", "investigation", "synthesized"],
    });
  } catch {
    // memory is auxiliary
  }
};
