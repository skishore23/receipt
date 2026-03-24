import path from "node:path";

import type { Hono } from "hono";

import { LocalCodexExecutor } from "../adapters/codex-executor";
import type { MemoryTools } from "../adapters/memory-tools";
import { fold } from "@receipt/core/chain";
import type { Runtime } from "@receipt/core/runtime";
import {
  html,
  json,
  optionalTrimmedString,
  readRecordBody,
  text,
} from "../framework/http";
import type { AgentLoaderContext, AgentRouteModule } from "../framework/agent-types";
import { agentRunStream } from "./agent.streams";
import type { AgentCmd, AgentEvent, AgentState } from "../modules/agent";
import { initial as initialAgent, reduce as reduceAgent } from "../modules/agent";
import { buildFactoryProjection, type FactoryState } from "../modules/factory";
import {
  factoryChatStream,
  factoryChatSessionStream,
  type FactoryChatProfile,
  discoverFactoryChatProfiles,
  resolveFactoryChatProfile,
} from "../services/factory-chat-profiles";
import {
  FactoryService,
  FactoryServiceError,
  type FactoryLiveOutputTargetKind,
} from "../services/factory-service";
import {
  factoryChatIsland,
  factoryChatShell,
  factorySidebarIsland,
} from "../views/factory-chat";
import {
  factoryInspectorIsland,
  factoryInspectorPanelIsland,
  factoryInspectorSelectionIsland,
  factoryInspectorTabsIsland,
} from "../views/factory-inspector";
import { buildFactoryWorkbench } from "../views/factory-workbench";
import type {
  FactoryChatIslandModel,
  FactoryChatItem,
  FactoryChatObjectiveNav,
  FactoryChatProfileNav,
  FactoryChatShellModel,
  FactoryChatJobNav,
  FactoryInspectorPanel,
  FactoryLiveCodexCard,
  FactoryLiveChildCard,
  FactoryLiveRunCard,
  FactorySelectedObjectiveCard,
  FactoryWorkCard,
  FactoryNavModel,
  FactoryInspectorModel,
  FactoryInspectorTabsModel,
} from "../views/factory-models";
import type { QueueJob } from "../adapters/jsonl-queue";
import { deriveObjectiveTitle, parseComposerDraft } from "../factory-cli/composer";
import {
  listReceiptFiles,
  readReceiptFile,
  sliceReceiptRecords,
  buildReceiptTimeline,
} from "../adapters/receipt-tools";
import {
  receiptShell,
  receiptFoldsHtml,
  receiptRecordsHtml,
  receiptSideHtml,
} from "../views/receipt";
import { parseOrder, parseLimit, parseInspectorDepth } from "../framework/http";
import type {
  FactoryObjectiveCard,
  FactoryObjectiveDetail,
} from "../services/factory-types";

const isActiveJobStatus = (status?: string): boolean =>
  status === "queued" || status === "leased" || status === "running";

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const profileLabel = (profileId?: string): string => {
  const value = profileId?.trim();
  if (!value) return "Active profile";
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
};

type FactoryProfileSectionView = {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
};

const FACTORY_INSPECTOR_TABS_TRIGGER = "sse:factory-refresh throttle:900ms, sse:job-refresh throttle:900ms";
const FACTORY_INSPECTOR_PANEL_TRIGGER = "sse:factory-refresh throttle:450ms, sse:job-refresh throttle:450ms";

const clipProfileText = (value: string, max = 180): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const describeProfileMarkdown = (value: string): {
  readonly summary?: string;
  readonly sections: ReadonlyArray<FactoryProfileSectionView>;
} => {
  const withoutFrontmatter = value.replace(/^---[\s\S]*?---\s*/, "");
  const lines = withoutFrontmatter.split(/\r?\n/).map((line) => line.trim());
  let summary: string | undefined;
  const sections: FactoryProfileSectionView[] = [];
  let currentSection: { title: string; items: string[] } | undefined;
  const flushSection = (): void => {
    if (!currentSection || currentSection.items.length === 0) return;
    sections.push({
      title: currentSection.title,
      items: currentSection.items.slice(0, 4),
    });
  };
  for (const line of lines) {
    if (!line || line.startsWith("```")) continue;
    if (line.startsWith("## ")) {
      flushSection();
      currentSection = { title: line.slice(3).trim(), items: [] };
      continue;
    }
    if (!summary && !line.startsWith("#") && !line.startsWith("-")) {
      summary = clipProfileText(line);
      continue;
    }
    if (line.startsWith("- ")) {
      const item = line.slice(2).trim();
      if (!item) continue;
      if (!currentSection) currentSection = { title: "How I Work", items: [] };
      currentSection.items.push(item);
    }
  }
  flushSection();
  return {
    summary,
    sections: sections.slice(0, 3),
  };
};

const tryParseJson = (value: string): Record<string, unknown> | undefined => {
  try {
    return asObject(JSON.parse(value));
  } catch {
    return undefined;
  }
};

const humanizeKey = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());

const formatJsonScalar = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
};

const compactJsonValue = (value: unknown): string | undefined => {
  const scalar = formatJsonScalar(value);
  if (scalar) return clipProfileText(scalar, 220);
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => formatJsonScalar(entry) ?? compactJsonValue(asObject(entry)))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 6);
    return items.length > 0 ? clipProfileText(items.join("; "), 220) : undefined;
  }
  const record = asObject(value);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .map(([key, entryValue]) => {
      const rendered = formatJsonScalar(entryValue)
        ?? (Array.isArray(entryValue)
          ? compactJsonValue(entryValue)
          : compactJsonValue(asObject(entryValue)));
      return rendered ? `${humanizeKey(key)}: ${rendered}` : undefined;
    })
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 6);
  return entries.length > 0 ? clipProfileText(entries.join("; "), 220) : undefined;
};

const markdownTableCell = (value: unknown): string | undefined => {
  const rendered = formatJsonScalar(value)
    ?? (Array.isArray(value)
      ? compactJsonValue(value)
      : compactJsonValue(asObject(value)));
  return rendered
    ? rendered.replace(/\|/g, "\\|").replace(/\r?\n+/g, " <br> ")
    : undefined;
};

const jsonArrayToMarkdownTable = (value: ReadonlyArray<unknown>): string | undefined => {
  const rows = value
    .map(asObject)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  if (rows.length === 0 || rows.length !== value.length) return undefined;

  const orderedKeys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!orderedKeys.includes(key)) orderedKeys.push(key);
    }
  }

  const columns = orderedKeys
    .filter((key) => rows.some((row) => markdownTableCell(row[key])))
    .filter((key) => rows.every((row) => row[key] == null || markdownTableCell(row[key]) !== undefined))
    .slice(0, 6);
  if (columns.length === 0) return undefined;

  const tableRows = rows
    .map((row) => columns.map((key) => markdownTableCell(row[key]) ?? ""))
    .filter((cells) => cells.some((cell) => cell.length > 0));
  if (tableRows.length === 0) return undefined;

  const previewRows = tableRows.slice(0, 8);
  const header = `| ${columns.map((key) => humanizeKey(key)).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = previewRows.map((cells) => `| ${cells.join(" | ")} |`).join("\n");
  const note = tableRows.length > previewRows.length
    ? `\n\n_Showing ${previewRows.length} of ${tableRows.length} rows._`
    : "";
  return `${header}\n${divider}\n${body}${note}`;
};

const jsonRecordToMarkdown = (record: Record<string, unknown>): string | undefined => {
  const sections = Object.entries(record)
    .flatMap(([key, value]) => {
      const heading = `## ${humanizeKey(key)}`;
      const scalar = formatJsonScalar(value);
      if (scalar) return [`${heading}\n${scalar}`];
      if (Array.isArray(value)) {
        const table = jsonArrayToMarkdownTable(value);
        if (table) {
          const countLine = `${value.length} item${value.length === 1 ? "" : "s"}.\n\n`;
          return [`${heading}\n${countLine}${table}`];
        }
        const items = value
          .map((entry) => formatJsonScalar(entry)
            ?? (Array.isArray(entry)
              ? compactJsonValue(entry)
              : compactJsonValue(asObject(entry))))
          .filter((entry): entry is string => Boolean(entry))
          .slice(0, 8);
        return items.length > 0 ? [`${heading}\n${items.map((entry) => `- ${entry}`).join("\n")}`] : [];
      }
      const nested = asObject(value);
      if (!nested) return [];
      const lines = Object.entries(nested)
        .map(([nestedKey, nestedValue]) => {
          const rendered = formatJsonScalar(nestedValue)
            ?? (Array.isArray(nestedValue)
              ? compactJsonValue(nestedValue)
              : compactJsonValue(asObject(nestedValue)));
          return rendered ? `- ${humanizeKey(nestedKey)}: ${rendered}` : undefined;
        })
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 8);
      return lines.length > 0 ? [`${heading}\n${lines.join("\n")}`] : [];
    })
    .filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
};

const buildDetail = (...chunks: ReadonlyArray<string | undefined>): string | undefined => {
  const detail = chunks
    .map((chunk) => chunk?.trim())
    .filter((chunk): chunk is string => Boolean(chunk))
    .join("\n\n");
  return detail || undefined;
};

const asRecordArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];

const summarizeObservationJob = (record: Record<string, unknown>): string | undefined => {
  const result = asObject(record.result);
  const failure = asObject(result?.failure);
  return asString(record.summary)
    ?? asString(result?.summary)
    ?? asString(result?.finalResponse)
    ?? asString(result?.note)
    ?? asString(result?.message)
    ?? asString(failure?.message)
    ?? asString(record.lastError)
    ?? asString(asObject(record.payload)?.problem)
    ?? asString(asObject(record.payload)?.task)
    ?? asString(asObject(record.payload)?.kind);
};

const formatFactoryActiveJobs = (value: unknown): string | undefined => {
  const jobs = asRecordArray(value).slice(0, 5);
  if (jobs.length === 0) return undefined;
  return `Active jobs:\n${jobs.map((job) => {
    const jobId = asString(job.id) ?? asString(job.jobId) ?? "unknown";
    const worker = asString(job.agentId) ?? asString(job.worker) ?? "worker";
    const status = asString(job.status) ?? "unknown";
    const summary = summarizeObservationJob(job);
    return `- ${jobId}: ${worker} ${status}${summary ? ` — ${summary}` : ""}`;
  }).join("\n")}`;
};

const formatFactoryReceipts = (value: unknown): string | undefined => {
  const receipts = asRecordArray(value).slice(0, 6);
  if (receipts.length === 0) return undefined;
  return `Recent receipts:\n${receipts.map((receipt) => {
    const type = asString(receipt.type) ?? "receipt";
    const summary = asString(receipt.summary) ?? "No summary";
    return `- ${type}: ${summary}`;
  }).join("\n")}`;
};

const formatFactoryTaskWorktrees = (value: unknown): string | undefined => {
  const worktrees = asRecordArray(value).slice(0, 5);
  if (worktrees.length === 0) return undefined;
  return `Task worktrees:\n${worktrees.map((worktree) => {
    const taskId = asString(worktree.taskId) ?? "unknown";
    const exists = worktree.exists === true ? "exists" : "missing";
    const dirty = worktree.dirty === true ? "dirty" : "clean";
    const branch = asString(worktree.branch);
    const head = asString(worktree.head);
    const workspacePath = asString(worktree.workspacePath);
    const meta = [exists, dirty, branch, head].filter(Boolean).join(" · ");
    return `- ${taskId}: ${meta}${workspacePath ? ` — ${workspacePath}` : ""}`;
  }).join("\n")}`;
};

const formatFactoryContextPacks = (value: unknown): string | undefined => {
  const packs = asRecordArray(value).slice(0, 5);
  if (packs.length === 0) return undefined;
  return `Context packs:\n${packs.map((pack) => {
    const taskId = asString(pack.taskId) ?? "unknown";
    const candidateId = asString(pack.candidateId);
    const contextPackPath = asString(pack.contextPackPath);
    const memoryScriptPath = asString(pack.memoryScriptPath);
    const label = [taskId, candidateId].filter(Boolean).join(" · ");
    const pathLines = [
      contextPackPath ? `context: ${contextPackPath}` : undefined,
      memoryScriptPath ? `memory: ${memoryScriptPath}` : undefined,
    ].filter(Boolean).join(" · ");
    return `- ${label || "context"}${pathLines ? ` — ${pathLines}` : ""}`;
  }).join("\n")}`;
};

const summarizeJob = (job: QueueJob): string => {
  const result = asObject(job.result);
  const failure = asObject(result?.failure);
  const resultSummary = asString(result?.summary)
    ?? asString(result?.finalResponse)
    ?? asString(result?.note)
    ?? asString(result?.message)
    ?? asString(failure?.message);
  if (resultSummary) return resultSummary;
  if (job.lastError) return job.lastError;
  const payloadProblem = asString(job.payload.problem);
  if (payloadProblem) return payloadProblem.replace(/\s+/g, " ").slice(0, 120);
  const kind = asString(job.payload.kind);
  if (kind) return kind;
  return `${job.agentId} job`;
};

const isDescendantStream = (value: string | undefined, stream: string): boolean => {
  const candidate = value?.trim();
  if (!candidate) return false;
  return candidate === stream || candidate.startsWith(`${stream}/sub/`);
};

const isRelevantShellJob = (job: QueueJob, stream: string, objectiveId?: string): boolean => {
  const payloadObjectiveId = asString(job.payload.objectiveId);
  const payloadStream = asString(job.payload.stream);
  const parentStream = asString(job.payload.parentStream);
  return isDescendantStream(payloadStream, stream)
    || isDescendantStream(parentStream, stream)
    || (Boolean(objectiveId) && payloadObjectiveId === objectiveId);
};

const isTerminalJobStatus = (status: string | undefined): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const codexJobPriority = (job: QueueJob): number => {
  if (!isTerminalJobStatus(job.status)) return 0;
  if (job.status === "failed") return 1;
  if (job.status === "completed") return 2;
  return 3;
};

const normalizedWorkerId = (agentId: string | undefined): string =>
  agentId?.trim() || "unknown";

type AgentRunChain = Awaited<ReturnType<Runtime<AgentCmd, AgentEvent, AgentState>["chain"]>>;

const payloadRecord = (job: QueueJob | undefined): Record<string, unknown> =>
  asObject(job?.payload) ?? {};

const jobObjectiveId = (job: QueueJob | undefined): string | undefined =>
  asString(payloadRecord(job).objectiveId) ?? asString(asObject(job?.result)?.objectiveId);

const jobRunId = (job: QueueJob | undefined): string | undefined =>
  asString(payloadRecord(job).runId);

const jobParentRunId = (job: QueueJob | undefined): string | undefined =>
  asString(payloadRecord(job).parentRunId);

const jobAnyRunId = (job: QueueJob | undefined): string | undefined =>
  jobRunId(job) ?? jobParentRunId(job);

const seedSet = (values: ReadonlyArray<string | undefined>): Set<string> =>
  new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0));

const linkRunId = (pending: string[], seen: ReadonlySet<string>, value: string | undefined): void => {
  const runId = value?.trim();
  if (!runId || seen.has(runId) || pending.includes(runId)) return;
  pending.push(runId);
};

const collectRunLineageIds = (
  seedRunIds: ReadonlyArray<string | undefined>,
  runChainsById: ReadonlyMap<string, AgentRunChain>,
  jobs: ReadonlyArray<QueueJob>,
): ReadonlySet<string> => {
  const related = new Set<string>();
  const pending = [...seedSet(seedRunIds)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || related.has(current)) continue;
    related.add(current);

    const currentChain = runChainsById.get(current);
    if (currentChain) {
      for (const receipt of currentChain) {
        const event = receipt.body;
        if (event.type === "run.continued") {
          linkRunId(pending, related, event.runId);
          linkRunId(pending, related, event.nextRunId);
          continue;
        }
        if (event.type === "subagent.merged") {
          linkRunId(pending, related, event.runId);
          linkRunId(pending, related, event.subRunId);
          continue;
        }
        if (event.type === "tool.observed" && event.tool === "agent.delegate") {
          const parsed = tryParseJson(event.output);
          linkRunId(pending, related, asString(parsed?.runId));
          linkRunId(pending, related, asString(parsed?.parentRunId));
        }
      }
    }

    for (const [candidateRunId, candidateChain] of runChainsById.entries()) {
      for (const receipt of candidateChain) {
        const event = receipt.body;
        if (event.type === "run.continued" && event.nextRunId === current) {
          linkRunId(pending, related, candidateRunId);
          continue;
        }
        if (event.type === "subagent.merged" && event.subRunId === current) {
          linkRunId(pending, related, event.runId);
          continue;
        }
        if (event.type === "tool.observed" && event.tool === "agent.delegate") {
          const parsed = tryParseJson(event.output);
          if (asString(parsed?.runId) === current) linkRunId(pending, related, candidateRunId);
        }
      }
    }

    for (const job of jobs) {
      const payloadRun = jobRunId(job);
      const parentRun = jobParentRunId(job);
      if (parentRun === current) linkRunId(pending, related, payloadRun);
      if (payloadRun === current) linkRunId(pending, related, parentRun);
    }
  }
  return related;
};

const jobMatchesRunIds = (job: QueueJob, runIds: ReadonlySet<string>): boolean => {
  if (runIds.size === 0) return false;
  const payloadRun = jobRunId(job);
  const parentRun = jobParentRunId(job);
  return (payloadRun !== undefined && runIds.has(payloadRun))
    || (parentRun !== undefined && runIds.has(parentRun));
};

export const buildActiveCodexCard = (jobs: ReadonlyArray<QueueJob>): FactoryLiveCodexCard | undefined => {
  const codexJob = [...jobs]
    .filter((job) => normalizedWorkerId(job.agentId) === "codex")
    .filter((job) => !isTerminalJobStatus(job.status))
    .sort((left, right) =>
      codexJobPriority(left) - codexJobPriority(right)
      || right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id)
    )[0];
  if (!codexJob) return undefined;
  const result = asObject(codexJob.result);
  return {
    jobId: codexJob.id,
    status: codexJob.status,
    summary: summarizeJob(codexJob),
    latestNote: asString(result?.lastMessage) ?? asString(result?.message),
    stderrTail: asString(result?.stderrTail),
    stdoutTail: asString(result?.stdoutTail),
    runId: asString(codexJob.payload.parentRunId) ?? asString(codexJob.payload.runId),
    task: asString(codexJob.payload.task)
      ?? asString(codexJob.payload.prompt)
      ?? asString(codexJob.payload.problem)
      ?? asString(codexJob.payload.taskId),
    updatedAt: codexJob.updatedAt,
    abortRequested: codexJob.abortRequested === true,
    rawLink: `/jobs/${encodeURIComponent(codexJob.id)}`,
    running: !isTerminalJobStatus(codexJob.status),
  };
};

const isLiveChildShellJob = (job: QueueJob, stream: string, objectiveId?: string): boolean => {
  const kind = asString(job.payload.kind);
  const payloadStream = asString(job.payload.stream);
  const parentStream = asString(job.payload.parentStream);
  const payloadObjectiveId = asString(job.payload.objectiveId);
  if (kind === "factory.run" && payloadStream === stream) return false;
  if (isDescendantStream(parentStream, stream)) return true;
  if (payloadStream?.startsWith(`${stream}/sub/`)) return true;
  if (Boolean(objectiveId) && payloadObjectiveId === objectiveId && kind !== "factory.run") return true;
  return false;
};

const liveChildPriority = (job: QueueJob): number => {
  if (!isTerminalJobStatus(job.status)) return 0;
  if (job.status === "failed") return 1;
  if (job.status === "canceled") return 2;
  return 3;
};

const buildLiveChildCards = (
  jobs: ReadonlyArray<QueueJob>,
  stream: string,
  objectiveId?: string,
): ReadonlyArray<FactoryLiveChildCard> =>
  [...jobs]
    .filter((job) => isLiveChildShellJob(job, stream, objectiveId))
    .sort((left, right) =>
      liveChildPriority(left) - liveChildPriority(right)
      || right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id)
    )
    .map((job) => {
      const result = asObject(job.result);
      const payloadStream = asString(job.payload.stream);
      const parentStream = asString(job.payload.parentStream);
      const worker = asString(result?.worker) ?? normalizedWorkerId(job.agentId);
      return {
        jobId: job.id,
        agentId: job.agentId,
        worker,
        status: job.status,
        summary: summarizeJob(job),
        latestNote: asString(result?.lastMessage) ?? asString(result?.message),
        stderrTail: asString(result?.stderrTail),
        stdoutTail: asString(result?.stdoutTail),
        runId: asString(job.payload.runId) ?? asString(job.payload.parentRunId),
        parentRunId: asString(job.payload.parentRunId),
        stream: payloadStream,
        parentStream,
        task: asString(job.payload.task)
          ?? asString(job.payload.prompt)
          ?? asString(job.payload.problem)
          ?? asString(job.payload.taskId),
        updatedAt: job.updatedAt,
        abortRequested: job.abortRequested === true,
        rawLink: `/jobs/${encodeURIComponent(job.id)}`,
        running: !isTerminalJobStatus(job.status),
      } satisfies FactoryLiveChildCard;
    });

const interestingTools = new Set([
  "agent.delegate",
  "agent.status",
  "codex.status",
  "job.control",
  "codex.run",
  "factory.dispatch",
  "factory.status",
  "factory.output",
]);

type ToolObservation = {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly durationMs?: number;
};

const overlayLiveJobState = (card: FactoryWorkCard, job: QueueJob | undefined): FactoryWorkCard => {
  if (!job) return card;
  const parsed = asObject(job.result);
  const failure = asObject(parsed?.failure);
  const terminalSummary = job.status === "failed"
    ? job.lastError ?? asString(failure?.message)
    : job.status === "canceled"
      ? job.canceledReason ?? asString(parsed?.note)
      : undefined;
  const summary = terminalSummary
    ?? asString(parsed?.summary)
    ?? asString(parsed?.finalResponse)
    ?? asString(parsed?.note)
    ?? asString(parsed?.message)
    ?? asString(failure?.message)
    ?? job.lastError
    ?? card.summary;
  const detail = [
    asString(parsed?.lastMessage),
    asString(parsed?.message),
    asString(parsed?.stderrTail),
    asString(parsed?.stdoutTail),
    card.detail,
  ].filter(Boolean).join("\n\n");
  return {
    ...card,
    status: job.status,
    summary,
    detail: detail || undefined,
    running: !isTerminalJobStatus(job.status),
  };
};

const summarizeStructuredSupervisorFinal = (
  content: string,
  jobsById: ReadonlyMap<string, QueueJob>,
  fallbackChildCard?: FactoryWorkCard,
): { readonly title: string; readonly body: string; readonly childCard?: FactoryWorkCard } | undefined => {
  const parsed = tryParseJson(content);
  if (!parsed) return undefined;
  const codex = asObject(parsed.codex);
  const otherRelevant = asObject(parsed.otherRelevant);
  if (!codex && !otherRelevant) return undefined;

  let childCard = fallbackChildCard;
  const lines: string[] = [];
  const codexJobId = asString(codex?.jobId);
  const codexJob = codexJobId ? jobsById.get(codexJobId) : undefined;
  const codexStatus = asString(codex?.status) ?? codexJob?.status;
  const codexTask = asString(codex?.task);
  const codexLatestNote = asString(codex?.latestNote);
  if (codex) {
    const synthesizedCard: FactoryWorkCard = {
      key: `codex-final-${codexJobId ?? "snapshot"}`,
      title: "Codex child status",
      worker: "codex",
      status: codexStatus ?? "running",
      summary: codexLatestNote ?? codexTask ?? "Codex child is still processing this request.",
      detail: [codexTask, codexLatestNote]
        .filter((value, index, list) => value && list.indexOf(value) === index)
        .join("\n\n") || undefined,
      jobId: codexJobId,
      running: !isTerminalJobStatus(codexStatus),
    };
    childCard = childCard
      ? overlayLiveJobState(childCard, codexJob)
      : overlayLiveJobState(synthesizedCard, codexJob);
    lines.push(`Codex child ${childCard.jobId ?? codexJobId ?? "unknown"} is ${childCard.status}.`);
    if (childCard.summary) lines.push(`Latest child summary: ${childCard.summary}`);
  }

  const relevantLines = Object.entries(otherRelevant ?? {})
    .map(([label, value]) => {
      const entry = asObject(value);
      if (!entry) return undefined;
      const jobId = asString(entry.jobId) ?? "unknown";
      const status = asString(entry.status) ?? "unknown";
      const result = asString(entry.result) ?? asString(entry.summary);
      return `${label}: ${jobId} is ${status}${result ? ` — ${result}` : ""}`;
    })
    .filter((value): value is string => Boolean(value));
  if (relevantLines.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...relevantLines);
  }

  return {
    title: childCard?.running ? "Supervisor waiting on child" : "Supervisor snapshot",
    body: lines.join("\n"),
    childCard,
  };
};

const workCardFromObservation = (observation: ToolObservation): FactoryWorkCard | undefined => {
  if (!interestingTools.has(observation.tool)) return undefined;
  const durationLabel = typeof observation.durationMs === "number" && Number.isFinite(observation.durationMs)
    ? `${Math.max(1, Math.round(observation.durationMs / 1000))}s`
    : undefined;

  if (observation.error) {
    return {
      key: `${observation.tool}-error-${observation.summary ?? observation.error}`,
      title: observation.tool,
      worker: observation.tool.split(".")[0] ?? "tool",
      status: "failed",
      summary: observation.error,
      detail: observation.summary,
      meta: durationLabel,
      running: false,
    };
  }

  const parsed = observation.output ? tryParseJson(observation.output) : undefined;
  if (observation.tool === "agent.delegate") {
    const delegatedTo = asString(parsed?.delegatedTo) ?? asString(observation.input.agentId) ?? "agent";
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? observation.summary ?? "delegate"}`,
      title: `Delegated to ${delegatedTo}`,
      worker: delegatedTo,
      status: asString(parsed?.status) ?? "queued",
      summary: asString(parsed?.summary) ?? observation.summary ?? "Delegated work queued.",
      detail: buildDetail(
        asString(parsed?.summary),
        asString(parsed?.jobId) ? `Job ${asString(parsed?.jobId)}` : undefined,
        asString(parsed?.runId) ? `Run ${asString(parsed?.runId)}` : undefined,
      ),
      meta: durationLabel,
      jobId: asString(parsed?.jobId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "agent.status") {
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? observation.summary ?? "status"}`,
      title: "Child job status",
      worker: asString(parsed?.worker) ?? "agent",
      status: asString(parsed?.status) ?? "unknown",
      summary: asString(parsed?.summary) ?? observation.summary ?? `Job ${asString(parsed?.jobId) ?? "unknown"}`,
      detail: buildDetail(
        asString(parsed?.task) ? `Task: ${asString(parsed?.task)}` : undefined,
        asString(parsed?.lastMessage) ? `Latest note: ${asString(parsed?.lastMessage)}` : undefined,
        asString(parsed?.stderrTail) ? `stderr:\n${asString(parsed?.stderrTail)}` : undefined,
        asString(parsed?.stdoutTail) ? `stdout:\n${asString(parsed?.stdoutTail)}` : undefined,
      ),
      meta: durationLabel,
      jobId: asString(parsed?.jobId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "codex.status") {
    const jobs = Array.isArray(parsed?.jobs)
      ? parsed.jobs.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
    const latest = (parsed?.latest && typeof parsed.latest === "object" && !Array.isArray(parsed.latest)
      ? parsed.latest
      : jobs[0]) as Record<string, unknown> | undefined;
    const latestStatus = asString(latest?.status);
    return {
      key: `${observation.tool}-${asString(latest?.jobId) ?? observation.summary ?? "codex-status"}`,
      title: "Codex status",
      worker: "codex",
      status: latestStatus ?? "unknown",
      summary: observation.summary ?? asString(latest?.summary) ?? "Checked Codex status.",
      detail: buildDetail(
        typeof parsed?.activeCount === "number" ? `${parsed.activeCount} active Codex job${parsed.activeCount === 1 ? "" : "s"}` : undefined,
        asString(latest?.task) ? `Task: ${asString(latest?.task)}` : undefined,
        asString(latest?.lastMessage) ? `Latest note: ${asString(latest?.lastMessage)}` : undefined,
        jobs.length > 1
          ? `Recent jobs:\n${jobs.slice(0, 5).map((job) => `- ${asString(job.jobId) ?? "unknown"}: ${asString(job.status) ?? "unknown"}${asString(job.summary) ? ` — ${asString(job.summary)}` : ""}`).join("\n")}`
          : undefined,
      ),
      meta: durationLabel,
      jobId: asString(latest?.jobId),
      running: typeof parsed?.activeCount === "number"
        ? parsed.activeCount > 0
        : !isTerminalJobStatus(latestStatus),
    };
  }
  if (observation.tool === "job.control") {
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? observation.summary ?? "job-control"}`,
      title: "Job command queued",
      worker: "queue",
      status: asString(parsed?.status) ?? "queued",
      summary: observation.summary ?? "Queued a command for a child job.",
      detail: buildDetail(
        asString(parsed?.command) ? `Command: ${asString(parsed?.command)}` : undefined,
        asString(parsed?.jobId) ? `Job ${asString(parsed?.jobId)}` : undefined,
        compactJsonValue(parsed?.payload),
      ),
      meta: [asString(parsed?.command), durationLabel].filter(Boolean).join(" · "),
      jobId: asString(parsed?.jobId),
      running: false,
    };
  }
  if (observation.tool === "codex.run") {
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? observation.summary ?? "codex"}`,
      title: "Codex run",
      worker: asString(parsed?.worker) ?? "codex",
      status: asString(parsed?.status) ?? "queued",
      summary: asString(parsed?.summary) ?? observation.summary ?? "Codex run queued.",
      detail: buildDetail(
        asString(parsed?.task) ? `Task: ${asString(parsed?.task)}` : undefined,
        asString(parsed?.jobId) ? `Job ${asString(parsed?.jobId)}` : undefined,
        asString(parsed?.lastMessage),
        asString(parsed?.stderrTail),
        asString(parsed?.stdoutTail),
      ),
      meta: durationLabel,
      link: asString(parsed?.link),
      jobId: asString(parsed?.jobId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "factory.dispatch" || observation.tool === "factory.status") {
    const action = asString(parsed?.action);
    return {
      key: `${observation.tool}-${asString(parsed?.objectiveId) ?? observation.summary ?? "factory"}`,
      title: observation.tool === "factory.status"
        ? "Thread status"
        : action === "create"
          ? "Thread started"
          : action === "react"
            ? "Thread updated"
            : action === "promote"
              ? "Thread promoted"
              : action === "cancel"
                ? "Thread stopped"
                : action === "cleanup"
                  ? "Worktrees removed"
                  : action === "archive"
                    ? "Thread archived"
                    : "Factory thread",
      worker: asString(parsed?.worker) ?? "factory",
      status: asString(parsed?.status) ?? "updated",
      summary: asString(parsed?.summary) ?? observation.summary ?? "Factory updated.",
      detail: buildDetail(
        asString(parsed?.title) ? `Title: ${asString(parsed?.title)}` : undefined,
        asString(parsed?.phase) ? `Stage: ${asString(parsed?.phase)}` : undefined,
        asString(parsed?.integrationStatus) ? `Integration: ${asString(parsed?.integrationStatus)}` : undefined,
        asString(parsed?.latestCommitHash) ? `Commit: ${asString(parsed?.latestCommitHash)}` : undefined,
        formatFactoryActiveJobs(parsed?.activeJobs),
        formatFactoryReceipts(parsed?.recentReceipts),
        formatFactoryTaskWorktrees(parsed?.taskWorktrees),
        formatFactoryContextPacks(parsed?.latestContextPacks),
      ),
      meta: [action, durationLabel].filter(Boolean).join(" · "),
      link: asString(parsed?.link),
      objectiveId: asString(parsed?.objectiveId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "factory.output") {
    const focusKind = asString(parsed?.focusKind);
    const focusLabel = focusKind === "job"
      ? "Live job output"
      : focusKind === "task"
        ? "Live task output"
        : "Live output";
    const status = asString(parsed?.status) ?? "unknown";
    const active = parsed?.active === true || !isTerminalJobStatus(status);
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? asString(parsed?.focusId) ?? observation.summary ?? "factory-output"}`,
      title: focusLabel,
      worker: asString(parsed?.worker) ?? "factory",
      status,
      summary: asString(parsed?.summary) ?? observation.summary ?? asString(parsed?.title) ?? "Captured live task output.",
      detail: buildDetail(
        asString(parsed?.title) ? `Title: ${asString(parsed?.title)}` : undefined,
        focusKind && asString(parsed?.focusId) ? `Focus: ${focusKind} ${asString(parsed?.focusId)}` : undefined,
        asString(parsed?.taskId) ? `Task: ${asString(parsed?.taskId)}` : undefined,
        asString(parsed?.candidateId) ? `Candidate: ${asString(parsed?.candidateId)}` : undefined,
        asString(parsed?.jobId) ? `Job ${asString(parsed?.jobId)}` : undefined,
        asString(parsed?.artifactSummary) ? `Artifacts: ${asString(parsed?.artifactSummary)}` : undefined,
        asString(parsed?.lastMessage) ? `Latest note: ${asString(parsed?.lastMessage)}` : undefined,
        asString(parsed?.stderrTail) ? `stderr:\n${asString(parsed?.stderrTail)}` : undefined,
        asString(parsed?.stdoutTail) ? `stdout:\n${asString(parsed?.stdoutTail)}` : undefined,
      ),
      meta: durationLabel,
      objectiveId: asString(parsed?.objectiveId),
      jobId: asString(parsed?.jobId),
      running: active,
    };
  }
  return undefined;
};

const formatRunMeta = (runId: string, state: AgentState, firstTs?: number): string => {
  const parts = [`Run ${runId}`];
  if (typeof firstTs === "number") parts.push(new Date(firstTs).toLocaleString());
  parts.push(state.status);
  return parts.join(" · ");
};

const reverseFind = <T,>(items: ReadonlyArray<T>, predicate: (item: T) => boolean): T | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
};

export const buildChatItemsForRun = (
  runId: string,
  chain: Awaited<ReturnType<Runtime<AgentCmd, AgentEvent, AgentState>["chain"]>>,
  jobsById: ReadonlyMap<string, QueueJob>,
): ReadonlyArray<FactoryChatItem> => {
  const items: FactoryChatItem[] = [];
  const state = fold(chain, reduceAgent, initialAgent);
  const firstTs = chain[0]?.ts;
  const problem = chain.find((receipt) => receipt.body.type === "problem.set")?.body;
  if (problem?.type === "problem.set") {
    items.push({
      key: `${runId}-user`,
      kind: "user",
      body: problem.problem,
      meta: formatRunMeta(runId, state, firstTs),
    });
  }

  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type === "profile.selected") {
      continue;
    }
    if (event.type === "subagent.merged") {
      const job = jobsById.get(event.subJobId);
      const worker = asString(asObject(job?.result)?.worker) ?? normalizedWorkerId(job?.agentId);
      const baseCard: FactoryWorkCard = {
        key: `${runId}-subagent-${receipt.hash}`,
        title: worker === "codex" ? "Codex child update" : "Child update",
        worker,
        status: job?.status ?? "running",
        summary: event.summary,
        detail: event.task,
        meta: new Date(receipt.ts).toLocaleString(),
        jobId: event.subJobId,
        running: !isTerminalJobStatus(job?.status),
      };
      items.push({
        key: `${runId}-subagent-${receipt.hash}`,
        kind: "work",
        card: overlayLiveJobState(baseCard, job),
      });
      continue;
    }
  }

  const pending = new Map<string, ToolObservation>();
  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type === "tool.called") {
      const key = `${event.iteration}:${event.tool}`;
      pending.set(key, {
        tool: event.tool,
        input: (typeof event.input === 'string' ? tryParseJson(event.input) : event.input) as Record<string, unknown> ?? {},
        summary: event.summary,
        error: event.error,
        durationMs: event.durationMs,
      });
      if (event.error) {
        const card = workCardFromObservation({
          tool: event.tool,
          input: (typeof event.input === 'string' ? tryParseJson(event.input) : event.input) as Record<string, unknown> ?? {},
          summary: event.summary,
          error: event.error,
          durationMs: event.durationMs,
        });
        if (card) items.push({ key: `${runId}-tool-error-${receipt.hash}`, kind: "work", card });
      }
      continue;
    }
    if (event.type === "tool.observed") {
      const key = `${event.iteration}:${event.tool}`;
      const prior = pending.get(key);
      const inputObj = prior?.input as Record<string, unknown> | undefined;
      const outputObj = (typeof event.output === 'string' ? tryParseJson(event.output) : event.output) as Record<string, unknown> | undefined;
      
      if (event.tool === "factory.dispatch" && (inputObj?.action === "create" || inputObj?.action === "promote")) {
        const objectiveId = (outputObj?.objectiveId as string | undefined) ?? (inputObj?.objectiveId as string | undefined) ?? "";
        items.push({
          key: `${runId}-tool-${receipt.hash}`,
          kind: "objective_event",
          title: inputObj.action === "create" ? "Objective Started" : "Objective Promoted",
          summary: prior?.summary ?? "Objective updated",
          objectiveId,
        });
      } else {
        const card = workCardFromObservation({
          tool: event.tool,
          input: prior?.input ?? {},
          output: event.output,
          summary: prior?.summary,
          error: prior?.error,
          durationMs: prior?.durationMs,
        });
        if (card) {
          items.push({
            key: `${runId}-tool-${receipt.hash}`,
            kind: "work",
            card: card.worker === "queue"
              ? card
              : overlayLiveJobState(card, card.jobId ? jobsById.get(card.jobId) : undefined),
          });
        }
      }
      pending.delete(key);
    }
  }

  const hasRunningWorkCard = (): boolean =>
    items.some((item) => item.kind === "work" && Boolean(item.card.running));

  const final = reverseFind(chain, (receipt) => receipt.body.type === "response.finalized")?.body;
  const continued = reverseFind(chain, (receipt) => receipt.body.type === "run.continued")?.body;
  const latestChildCard = [...items].reverse().find((item): item is Extract<FactoryChatItem, { kind: "work" }> =>
    item.kind === "work" && Boolean(item.card.jobId) && item.card.worker === "codex"
  )?.card;
  const latestObjectiveCard = [...items].reverse().find((item): item is Extract<FactoryChatItem, { kind: "work" }> =>
    item.kind === "work" && Boolean(item.card.objectiveId)
  )?.card;
  if (final?.type === "response.finalized") {
    const structuredFinal = summarizeStructuredSupervisorFinal(final.content, jobsById, latestChildCard);
    if (structuredFinal) {
      items.push({
        key: `${runId}-structured-final`,
        kind: "system",
        title: structuredFinal.title,
        body: structuredFinal.body,
        meta: structuredFinal.childCard?.running ? "child running" : (state.statusNote ?? state.status),
      });
      if (!latestChildCard && structuredFinal.childCard) {
        items.push({
          key: `${runId}-structured-final-card`,
          kind: "work",
          card: structuredFinal.childCard,
        });
      }
    } else if (continued?.type === "run.continued") {
      items.push({
        key: `${runId}-continued`,
        kind: "system",
        title: "Thread continues automatically",
        body: `${continued.summary}\n\nNext run: ${continued.nextRunId}\nNext job: ${continued.nextJobId}`,
        meta: `${continued.previousMaxIterations} -> ${continued.nextMaxIterations} steps`,
      });
    } else if (state.failure?.failureClass === "iteration_budget_exhausted" && latestChildCard) {
      const childStatus = latestChildCard.running
        ? `still running as ${latestChildCard.jobId}`
        : `${latestChildCard.status}${latestChildCard.jobId ? ` (${latestChildCard.jobId})` : ""}`;
      items.push({
        key: `${runId}-child-status`,
        kind: "system",
        title: "Orchestrator paused",
        body: `The parent skill hit its 8-turn budget, but the Codex child is ${childStatus}.\n\n${latestChildCard.summary}`,
        meta: state.statusNote ?? state.status,
      });
    } else if (state.failure?.failureClass === "iteration_budget_exhausted" && latestObjectiveCard) {
      items.push({
        key: `${runId}-objective-status`,
        kind: "system",
        title: "Thread continues",
        body: `The parent skill hit its 8-turn budget after updating this thread. The thread is still ${latestObjectiveCard.status}.\n\n${latestObjectiveCard.summary}`,
        meta: state.statusNote ?? state.status,
      });
    } else {
      const parsedFinal = tryParseJson(final.content);
      items.push({
        key: `${runId}-assistant-final`,
        kind: "assistant",
        body: parsedFinal ? (jsonRecordToMarkdown(parsedFinal) ?? final.content) : final.content,
        meta: state.statusNote ?? state.status,
      });
    }
  } else if (state.status === "running") {
    const activeProfile = profileLabel(state.profile?.profileId);
    const activityLine = state.lastTool?.name
      ? `${activeProfile} is using ${state.lastTool.name}${state.lastTool.summary ? `.\n\n${state.lastTool.summary}` : ""}${state.lastTool.error ? `\n\n${state.lastTool.error}` : ""}`
      : `${activeProfile} is shaping the next step in this thread. Live updates will appear here.`;
    if (!hasRunningWorkCard()) {
      items.push({
        key: `${runId}-running`,
        kind: "system",
        title: `${activeProfile} working`,
        body: activityLine,
        meta: state.status,
      });
    }
  } else if (state.status === "failed") {
    items.push({
      key: `${runId}-failed`,
      kind: "system",
      title: "Run failed",
      body: state.failure?.message ?? state.statusNote ?? "The run ended without a final response.",
      meta: state.failure?.failureClass ?? state.status,
    });
  }
  return items;
};

const collectRunIds = (chain: Awaited<ReturnType<Runtime<AgentCmd, AgentEvent, AgentState>["chain"]>>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type !== "problem.set" || !event.runId || seen.has(event.runId)) continue;
    seen.add(event.runId);
    ordered.push(event.runId);
  }
  return ordered.slice(-12);
};

const buildChatLink = (input: {
  readonly profileId?: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly panel?: FactoryInspectorPanel;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
}): string => {
  const params = new URLSearchParams();
  if (input.profileId) params.set("profile", input.profileId);
  if (input.chatId) params.set("chat", input.chatId);
  if (input.objectiveId) params.set("thread", input.objectiveId);
  if (input.runId) params.set("run", input.runId);
  if (input.jobId) params.set("job", input.jobId);
  if (input.panel) params.set("panel", input.panel);
  if (input.focusKind && input.focusId) {
    params.set("focusKind", input.focusKind);
    params.set("focusId", input.focusId);
  }
  const query = params.toString();
  return `/factory${query ? `?${query}` : ""}`;
};

const resolveChatViewStream = (input: {
  readonly repoRoot: string;
  readonly profileId: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly job?: QueueJob;
}): string | undefined =>
  input.chatId
    ? factoryChatSessionStream(input.repoRoot, input.profileId, input.chatId)
    : input.objectiveId
      ? factoryChatStream(input.repoRoot, input.profileId, input.objectiveId)
      : asString(input.job?.payload.parentStream)
        ?? asString(input.job?.payload.stream);

const normalizeKnownObjectiveId = <T extends { readonly objectiveId: string }>(
  candidate: string | undefined,
  objectives: ReadonlyArray<T>,
): string | undefined => {
  const objectiveId = candidate?.trim();
  if (!objectiveId) return undefined;
  return objectives.some((objective) => objective.objectiveId === objectiveId)
    ? objectiveId
    : undefined;
};

const latestObjectiveIdFromRunChains = (
  runChains: ReadonlyArray<Awaited<ReturnType<Runtime<AgentCmd, AgentEvent, AgentState>["chain"]>>>,
): string | undefined => {
  for (let chainIndex = runChains.length - 1; chainIndex >= 0; chainIndex -= 1) {
    const chain = runChains[chainIndex] ?? [];
    for (let receiptIndex = chain.length - 1; receiptIndex >= 0; receiptIndex -= 1) {
      const event = chain[receiptIndex]?.body;
      if (!event) continue;
      if (event.type === "thread.bound") {
        const objectiveId = asString(event.objectiveId);
        if (objectiveId) return objectiveId;
        continue;
      }
      if (event.type === "tool.observed") {
        const output = typeof event.output === "string" ? tryParseJson(event.output) : asObject(event.output);
        const objectiveId = asString(output?.objectiveId);
        if (objectiveId) return objectiveId;
        continue;
      }
      if (event.type === "tool.called") {
        const input = typeof event.input === "string" ? tryParseJson(event.input) : asObject(event.input);
        const objectiveId = asString(input?.objectiveId);
        if (objectiveId) return objectiveId;
      }
    }
  }
  return undefined;
};

const compareJobsByRecency = (left: QueueJob, right: QueueJob): number =>
  right.updatedAt - left.updatedAt
  || right.createdAt - left.createdAt
  || right.id.localeCompare(left.id);

const latestObjectiveIdFromJobs = (
  jobs: ReadonlyArray<QueueJob>,
  stream: string,
  chatId?: string,
): string | undefined =>
  [...jobs]
    .filter((job) =>
      (chatId && asString(job.payload.chatId) === chatId)
      || isRelevantShellJob(job, stream)
    )
    .sort(compareJobsByRecency)
    .map((job) => jobObjectiveId(job))
    .find((objectiveId): objectiveId is string => typeof objectiveId === "string" && objectiveId.trim().length > 0);

const objectiveIdFromChatItem = (item: FactoryChatItem): string | undefined =>
  item.kind === "objective_event"
    ? item.objectiveId
    : item.kind === "work"
      ? item.card.objectiveId
      : undefined;

const collectScopedObjectiveIds = (input: {
  readonly requestedObjectiveId?: string;
  readonly resolvedObjectiveId?: string;
  readonly chatId?: string;
  readonly items: ReadonlyArray<FactoryChatItem>;
  readonly jobs: ReadonlyArray<QueueJob>;
}): ReadonlyArray<string> => {
  const requestedObjectiveId = input.requestedObjectiveId?.trim();
  if (requestedObjectiveId) {
    return [input.resolvedObjectiveId ?? requestedObjectiveId];
  }
  if (!input.chatId) {
    return input.resolvedObjectiveId ? [input.resolvedObjectiveId] : [];
  }
  return [...new Set([
    ...(input.resolvedObjectiveId ? [input.resolvedObjectiveId] : []),
    ...input.items
      .map((item) => objectiveIdFromChatItem(item))
      .filter((objectiveId): objectiveId is string => typeof objectiveId === "string" && objectiveId.trim().length > 0),
    ...input.jobs
      .map((job) => jobObjectiveId(job))
      .filter((objectiveId): objectiveId is string => typeof objectiveId === "string" && objectiveId.trim().length > 0),
  ])];
};

const toSelectedObjectiveCard = (selectedObjective: FactoryObjectiveDetail): FactorySelectedObjectiveCard => ({
  objectiveId: selectedObjective.objectiveId,
  title: selectedObjective.title,
  status: selectedObjective.status,
  phase: selectedObjective.phase,
  summary: selectedObjective.latestSummary ?? selectedObjective.nextAction,
  debugLink: `/factory/api/objectives/${encodeURIComponent(selectedObjective.objectiveId)}/debug`,
  receiptsLink: `/receipt`,
  nextAction: selectedObjective.nextAction,
  slotState: selectedObjective.scheduler.slotState,
  queuePosition: selectedObjective.scheduler.queuePosition,
  blockedReason: selectedObjective.blockedReason,
  blockedExplanation: selectedObjective.blockedExplanation?.summary,
  integrationStatus: selectedObjective.integrationStatus,
  activeTaskCount: selectedObjective.activeTaskCount,
  readyTaskCount: selectedObjective.readyTaskCount,
  taskCount: selectedObjective.taskCount,
  latestCommitHash: selectedObjective.latestCommitHash,
  checks: selectedObjective.checks,
  latestDecisionSummary: selectedObjective.latestDecision?.summary,
  latestDecisionAt: selectedObjective.latestDecision?.at,
  tokensUsed: selectedObjective.tokensUsed,
});

const toSidebarSelectedObjectiveCard = (selectedObjective: FactoryObjectiveCard): FactorySelectedObjectiveCard => ({
  objectiveId: selectedObjective.objectiveId,
  title: selectedObjective.title,
  status: selectedObjective.status,
  phase: selectedObjective.phase,
  summary: selectedObjective.latestSummary ?? selectedObjective.nextAction,
  debugLink: `/factory/api/objectives/${encodeURIComponent(selectedObjective.objectiveId)}/debug`,
  receiptsLink: `/receipt`,
  nextAction: selectedObjective.nextAction,
  slotState: selectedObjective.scheduler.slotState,
  queuePosition: selectedObjective.scheduler.queuePosition,
  blockedReason: selectedObjective.blockedReason,
  blockedExplanation: selectedObjective.blockedExplanation?.summary,
  integrationStatus: selectedObjective.integrationStatus,
  activeTaskCount: selectedObjective.activeTaskCount,
  readyTaskCount: selectedObjective.readyTaskCount,
  taskCount: selectedObjective.taskCount,
  latestCommitHash: selectedObjective.latestCommitHash,
  latestDecisionSummary: selectedObjective.latestDecision?.summary,
  latestDecisionAt: selectedObjective.latestDecision?.at,
  tokensUsed: selectedObjective.tokensUsed,
});

const toStateSelectedObjectiveCard = (state: FactoryState): FactorySelectedObjectiveCard => {
  const projection = buildFactoryProjection(state);
  const latestCandidate = projection.candidates.at(-1);
  const tokensUsed = Object.values(state.candidates).reduce((sum, candidate) => sum + (candidate.tokensUsed ?? 0), 0);
  return {
    objectiveId: state.objectiveId,
    title: state.title,
    status: state.status,
    phase: state.status,
    summary: state.latestSummary,
    debugLink: `/factory/api/objectives/${encodeURIComponent(state.objectiveId)}/debug`,
    receiptsLink: `/receipt`,
    slotState: state.scheduler.slotState,
    blockedReason: state.blockedReason,
    integrationStatus: state.integration.status,
    activeTaskCount: projection.activeTasks.length,
    readyTaskCount: projection.readyTasks.length,
    taskCount: projection.tasks.length,
    latestCommitHash: state.integration.promotedCommit ?? state.integration.headCommit ?? latestCandidate?.headCommit,
    checks: state.checks,
    tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
  };
};

const makeFactoryRunId = (): string =>
  `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const makeFactoryChatId = (): string =>
  `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const summarizePendingRunJob = (job: QueueJob, profileLabel: string): FactoryLiveRunCard => {
  const summary = job.status === "queued"
    ? "Waiting for a worker to pick up this run."
    : job.status === "leased"
      ? "A worker claimed this run and is starting it."
      : job.status === "running"
        ? `${profileLabel} is starting this run.`
        : job.status === "completed"
          ? "Run worker finished."
          : job.status === "canceled"
            ? (job.canceledReason ?? "Run was canceled.")
            : (job.lastError ?? "Run failed.");
  return {
    runId: asString(job.payload.runId) ?? asString(job.payload.parentRunId) ?? job.id,
    profileLabel,
    status: job.status,
    summary,
    updatedAt: job.updatedAt,
    link: buildChatLink({
      profileId: asString(job.payload.profileId),
      chatId: asString(job.payload.chatId),
      objectiveId: asString(job.payload.objectiveId),
      runId: asString(job.payload.runId) ?? asString(job.payload.parentRunId),
      jobId: job.id,
    }),
    lastToolSummary: asString(job.payload.problem) ?? asString(job.payload.task) ?? asString(job.payload.kind),
  };
};

const describeRunActivity = (
  profileLabel: string,
  state: AgentState,
  finalContent?: string,
): string => {
  const tool = state.lastTool?.name?.trim().toLowerCase();
  if (state.status === "failed") return "Needs attention.";
  if (state.status === "completed") return "Run completed.";
  if (tool === "jobs.list") return `${profileLabel} is checking live jobs.`;
  if (tool === "agent.status") return `${profileLabel} is checking child status.`;
  if (tool === "codex.status") return `${profileLabel} is checking Codex progress.`;
  if (tool === "factory.status") return `${profileLabel} is checking thread status.`;
  if (tool === "repo.status") return `${profileLabel} is checking repo state.`;
  if (tool === "agent.inspect") return `${profileLabel} is tracing child activity.`;
  if (tool === "factory.dispatch") return `${profileLabel} is updating the thread.`;
  if (tool === "codex.run") return `${profileLabel} queued Codex work and is waiting for progress.`;
  if (tool === "agent.delegate") return `${profileLabel} delegated follow-up work.`;
  if (tool && tool.length > 0) return `${profileLabel} is using ${tool}.`;
  if (finalContent?.trim()) return "Run completed.";
  if (state.status === "running") return `${profileLabel} is still working.`;
  return "No run receipts yet.";
};

const summarizeActiveRunCard = (
  input: {
    readonly runId: string;
    readonly runChain: Awaited<ReturnType<Runtime<AgentCmd, AgentEvent, AgentState>["chain"]>>;
    readonly relatedJobs: ReadonlyArray<QueueJob>;
    readonly profileLabel: string;
    readonly profileId: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
  },
): FactoryLiveRunCard => {
  const state = fold(input.runChain, reduceAgent, initialAgent);
  const final = reverseFind(input.runChain, (receipt) => receipt.body.type === "response.finalized")?.body;
  const failure = state.failure?.message;
  const finalContent = final?.type === "response.finalized"
    ? final.content.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim()
    : undefined;
  const relatedJobs = [...input.relatedJobs]
    .sort((left, right) =>
      right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id)
    );
  const activeChild = relatedJobs.find((job) => !isTerminalJobStatus(job.status) && normalizedWorkerId(job.agentId) !== "factory");
  const latestFailedChild = relatedJobs.find((job) => job.status === "failed" && normalizedWorkerId(job.agentId) !== "factory");
  const latestTerminalChild = relatedJobs.find((job) => isTerminalJobStatus(job.status) && normalizedWorkerId(job.agentId) !== "factory");
  const tool = state.lastTool?.name?.trim().toLowerCase();
  const isPureStatusPoll = tool === "agent.status" || tool === "codex.status" || tool === "jobs.list" || tool === "factory.status" || tool === "repo.status" || tool === "agent.inspect";
  const derivedStatus = activeChild
    ? state.status
    : latestFailedChild && state.status === "running"
      ? "needs_attention"
      : isPureStatusPoll && state.status === "running"
        ? "idle"
        : state.status;
  const summary = activeChild
    ? summarizeJob(activeChild)
    : latestFailedChild
      ? `Latest child ${latestFailedChild.id} failed: ${summarizeJob(latestFailedChild)}`
      : latestTerminalChild && isPureStatusPoll
        ? `No active child jobs. Latest update: ${summarizeJob(latestTerminalChild)}`
        : state.lastTool?.error
          ?? failure
          ?? describeRunActivity(input.profileLabel, state, finalContent);
  return {
    runId: input.runId,
    profileLabel: input.profileLabel,
    status: derivedStatus,
    summary,
    updatedAt: input.runChain.at(-1)?.ts,
    lastToolName: state.lastTool?.name,
    lastToolSummary: latestFailedChild
      ? `${latestFailedChild.id}: ${summarizeJob(latestFailedChild)}`
      : state.lastTool?.summary ?? state.lastTool?.error,
    link: buildChatLink({
      profileId: input.profileId,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      runId: input.runId,
    }),
  };
};

const createFactoryRoute = (ctx: AgentLoaderContext): AgentRouteModule => {
  const helpers = ctx.helpers ?? {};
  const service = (helpers.factoryService as FactoryService | undefined) ?? new FactoryService({
    dataDir: ctx.dataDir,
    queue: ctx.queue,
    jobRuntime: ctx.jobRuntime,
    sse: ctx.sse,
    codexExecutor: new LocalCodexExecutor(),
    memoryTools: helpers.memoryTools as MemoryTools | undefined,
  });
  const agentRuntime = ctx.runtimes.agent as Runtime<AgentCmd, AgentEvent, AgentState>;
  const profileRoot = path.resolve(typeof helpers.profileRoot === "string" ? helpers.profileRoot : process.cwd());

  const wrap = async <T>(
    fn: () => Promise<T>,
    render: (value: T) => Response,
  ): Promise<Response> => {
    try {
      return render(await fn());
    } catch (err) {
      if (err instanceof FactoryServiceError) return text(err.status, err.message);
      const message = err instanceof Error ? err.message : "factory server error";
      console.error(err);
      return text(500, message);
    }
  };

  const requestedObjectiveId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("thread"))
    ?? optionalTrimmedString(new URL(req.url).searchParams.get("objective"));

  const requestedChatId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("chat"));

  const requestedProfileId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("profile"));

  const requestedRunId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("run"));

  const requestedJobId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("job"));

  const requestedFocusId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("focusId"));

  const requestedPanel = (req: Request): FactoryInspectorPanel => {
    const panel = optionalTrimmedString(new URL(req.url).searchParams.get("panel"));
    return panel === "execution" || panel === "live" || panel === "receipts" || panel === "debug"
      ? panel
      : "overview";
  };

  const requestedPanelParam = (req: Request): FactoryInspectorPanel | undefined => {
    const panel = optionalTrimmedString(new URL(req.url).searchParams.get("panel"));
    return panel === "overview" || panel === "execution" || panel === "live" || panel === "receipts" || panel === "debug"
      ? panel
      : undefined;
  };

  const requestedShowAll = (req: Request): boolean =>
    optionalTrimmedString(new URL(req.url).searchParams.get("all")) === "1";

  const requestedFocusKind = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("focusKind"));

  const normalizeFocusKind = (value: string | undefined): "task" | "job" | undefined =>
    value === "task" || value === "job" ? value : undefined;

  const wantsJsonNavigation = (req: Request): boolean =>
    (req.headers.get("accept") ?? "").includes("application/json");

  const navigationResponse = (req: Request, location: string): Response =>
    wantsJsonNavigation(req)
      ? json(200, { location })
      : new Response(null, {
          status: 303,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
          },
        });

  const navigationError = (req: Request, status: number, message: string): Response =>
    wantsJsonNavigation(req)
      ? json(status, { error: message })
      : text(status, message);

  const resolveWatchedObjectiveId = async (value: string | undefined): Promise<string | undefined> => {
    if (!value) return undefined;
    const objectives = await service.listObjectives();
    const exact = objectives.find((objective) => objective.objectiveId === value);
    if (exact) return exact.objectiveId;
    const prefix = objectives.find((objective) => objective.objectiveId.startsWith(value));
    return prefix?.objectiveId;
  };

  const resolveComposerJob = async (
    objectiveId: string | undefined,
    preferredJobId: string | undefined,
  ): Promise<QueueJob> => {
    if (preferredJobId) {
      const preferred = await ctx.queue.getJob(preferredJobId);
      if (preferred) return preferred;
    }
    if (!objectiveId) throw new FactoryServiceError(409, "Select an objective before sending job commands.");
    const jobs = (await ctx.queue.listJobs({ limit: 160 }))
      .filter((job) => jobObjectiveId(job) === objectiveId)
      .sort((left, right) => {
        const leftActive = isActiveJobStatus(left.status) ? 1 : 0;
        const rightActive = isActiveJobStatus(right.status) ? 1 : 0;
        return rightActive - leftActive
          || right.updatedAt - left.updatedAt
          || right.createdAt - left.createdAt
          || right.id.localeCompare(left.id);
      });
    const active = jobs.find((job) => isActiveJobStatus(job.status));
    if (active) return active;
    const detail = await service.getObjective(objectiveId);
    const taskJobId = detail.tasks.find((task) => isActiveJobStatus(task.jobStatus) && task.jobId)?.jobId;
    if (taskJobId) {
      const queued = await ctx.queue.getJob(taskJobId);
      if (queued) return queued;
    }
    throw new FactoryServiceError(409, "Selected objective has no active job to control.");
  };

  const projectionCacheTtlMs = 180;
  const chatShellCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryChatShellModel>;
  }>();
  const sidebarCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<{ readonly nav: FactoryNavModel; readonly selectedObjective?: FactorySelectedObjectiveCard }>;
  }>();
  const inspectorTabsCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryInspectorTabsModel>;
  }>();
  const inspectorPanelCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryInspectorModel>;
  }>();

  const withProjectionCache = async <T>(
    cache: Map<string, { readonly expiresAt: number; readonly value: Promise<T> }>,
    key: string,
    build: () => Promise<T>,
  ): Promise<T> => {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = build();
    cache.set(key, {
      expiresAt: now + projectionCacheTtlMs,
      value,
    });
    setTimeout(() => {
      const current = cache.get(key);
      if (current?.value === value && current.expiresAt <= Date.now()) {
        cache.delete(key);
      }
    }, projectionCacheTtlMs + 20);
    return value;
  };

  const resolveSessionObjectiveId = async (input: {
    readonly repoRoot: string;
    readonly profileId: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly selectedJob?: QueueJob;
    readonly jobs: ReadonlyArray<QueueJob>;
    readonly liveObjectives?: ReadonlyArray<{ readonly objectiveId: string }>;
    readonly allowExplicitFallback?: boolean;
  }): Promise<string | undefined> => {
    const liveObjectives = input.liveObjectives ?? [];
    const requestedObjectiveId = normalizeKnownObjectiveId(input.objectiveId, liveObjectives);
    if (requestedObjectiveId) return requestedObjectiveId;
    const explicitObjectiveId = input.objectiveId?.trim();
    if (input.allowExplicitFallback && explicitObjectiveId) return explicitObjectiveId;
    const selectedJobObjectiveId = normalizeKnownObjectiveId(jobObjectiveId(input.selectedJob), liveObjectives);
    if (selectedJobObjectiveId) return selectedJobObjectiveId;
    if (!selectedJobObjectiveId && input.allowExplicitFallback) {
      const explicitSelectedJobObjectiveId = jobObjectiveId(input.selectedJob);
      if (explicitSelectedJobObjectiveId) return explicitSelectedJobObjectiveId;
    }
    if (!input.chatId) return undefined;
    const stream = factoryChatSessionStream(input.repoRoot, input.profileId, input.chatId);
    const indexChain = await agentRuntime.chain(stream);
    const runIds = collectRunIds(indexChain);
    const runChains = await Promise.all(runIds.map((runId) => agentRuntime.chain(agentRunStream(stream, runId))));
    const discoveredObjectiveId = latestObjectiveIdFromRunChains(runChains)
      ?? latestObjectiveIdFromJobs(input.jobs, stream, input.chatId);
    return normalizeKnownObjectiveId(
      discoveredObjectiveId,
      liveObjectives,
    ) ?? (
      input.allowExplicitFallback
        ? discoveredObjectiveId
        : undefined
    );
  };

  const buildChatShellModel = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly showAll?: boolean;
  }): Promise<FactoryChatShellModel> => {
    await service.ensureBootstrap();
    const explicitObjectiveId = input.objectiveId?.trim();
    const repoRoot = service.git.repoRoot;
    const scopedUi = Boolean(input.objectiveId?.trim() || input.chatId?.trim());
    const [resolved, profiles, jobs] = await Promise.all([
      resolveFactoryChatProfile({
        repoRoot,
        profileRoot,
        requestedId: input.profileId,
      }),
      discoverFactoryChatProfiles(profileRoot),
      ctx.queue.listJobs({ limit: 120 }),
    ]);

    if (explicitObjectiveId && !input.chatId) {
      const [state, detail] = await Promise.all([
        service.getObjectiveState(explicitObjectiveId).catch(() => undefined),
        service.getObjective(explicitObjectiveId).catch((err) => {
          if (err instanceof FactoryServiceError && err.status === 404) return undefined;
          throw err;
        }),
      ]);
      if (!state && !detail) {
        return buildMissingExplicitThreadShellModel({
          resolvedProfile: resolved.root,
          profiles,
          objectiveId: explicitObjectiveId,
          runId: input.runId,
          jobId: input.jobId,
          panel: input.panel,
          focusKind: input.focusKind,
          focusId: input.focusId,
          showAll: input.showAll,
        });
      }
      const stateProfileId = state?.profile.rootProfileId;
      const effectiveProfile = profiles.find((profile) => profile.id === stateProfileId) ?? resolved.root;
      const activeProfileOverview = describeProfileMarkdown(effectiveProfile.mdBody);
      const objectiveJobs = jobs
        .filter((job) => jobObjectiveId(job) === explicitObjectiveId)
        .sort(compareJobsByRecency);
      const jobsById = new Map(objectiveJobs.map((job) => [job.id, job] as const));
      const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
      const stream = resolveChatViewStream({
        repoRoot,
        profileId: effectiveProfile.id,
        objectiveId: explicitObjectiveId,
        job: selectedJob,
      });
      const indexChain = stream ? await agentRuntime.chain(stream) : [];
      const allRunIds = collectRunIds(indexChain);
      const requestedRunIndex = input.runId ? allRunIds.indexOf(input.runId) : -1;
      const runIds = requestedRunIndex >= 0 ? allRunIds.slice(requestedRunIndex) : allRunIds;
      const runChains = await Promise.all(runIds.map((runId) => stream ? agentRuntime.chain(agentRunStream(stream, runId)) : Promise.resolve([])));
      const chatItems = runChains.flatMap((runChain, index) => buildChatItemsForRun(runIds[index]!, runChain, jobsById));
      const activeRunId = runIds.at(-1) ?? input.runId;
      const selectedObjectiveCard = detail
        ? toSelectedObjectiveCard(detail)
        : state
          ? toStateSelectedObjectiveCard(state)
          : undefined;
      const initialWorkbench = detail
        ? buildFactoryWorkbench({
            detail,
            recentJobs: objectiveJobs,
            requestedFocusKind: input.focusKind,
            requestedFocusId: input.focusId,
          })
        : undefined;
      const liveOutput = detail && initialWorkbench?.focus
        ? await service.getObjectiveLiveOutput(
            explicitObjectiveId,
            initialWorkbench.focus.focusKind,
            initialWorkbench.focus.focusId,
          ).catch(() => undefined)
        : undefined;
      const workbench = detail
        ? buildFactoryWorkbench({
            detail,
            recentJobs: objectiveJobs,
            requestedFocusKind: initialWorkbench?.focus?.focusKind ?? input.focusKind,
            requestedFocusId: initialWorkbench?.focus?.focusId ?? input.focusId,
            liveOutput,
          })
        : undefined;
      const resolvedFocusKind = workbench?.focus?.focusKind ?? input.focusKind;
      const resolvedFocusId = workbench?.focus?.focusId ?? input.focusId;
      const inspectorPanel = input.panel ?? (workbench?.hasActiveExecution ? "live" : "overview");
      const relevantJobs = objectiveJobs
        .slice(0, 12)
        .map((job) => ({
          jobId: job.id,
          agentId: job.agentId,
          status: job.status,
          summary: summarizeJob(job),
          runId: jobAnyRunId(job),
          objectiveId: jobObjectiveId(job),
          updatedAt: job.updatedAt,
          selected: job.id === input.jobId,
          link: buildChatLink({
            profileId: effectiveProfile.id,
            objectiveId: explicitObjectiveId,
            runId: jobAnyRunId(job),
            jobId: job.id,
            panel: inspectorPanel,
            focusKind: "job",
            focusId: job.id,
          }),
        } satisfies FactoryChatJobNav));
      const profileNav: ReadonlyArray<FactoryChatProfileNav> = profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        summary: describeProfileMarkdown(profile.mdBody).summary,
        selected: profile.id === effectiveProfile.id,
      }));
      const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = selectedObjectiveCard
        ? [{
            objectiveId: selectedObjectiveCard.objectiveId,
            title: selectedObjectiveCard.title,
            status: selectedObjectiveCard.status,
            phase: selectedObjectiveCard.phase,
            summary: selectedObjectiveCard.summary,
            selected: true,
            slotState: selectedObjectiveCard.slotState,
            activeTaskCount: selectedObjectiveCard.activeTaskCount,
            readyTaskCount: selectedObjectiveCard.readyTaskCount,
            taskCount: selectedObjectiveCard.taskCount,
            integrationStatus: selectedObjectiveCard.integrationStatus,
          }]
        : [];
      const activeCodex = buildActiveCodexCard(objectiveJobs);
      const liveChildren = stream
        ? buildLiveChildCards(objectiveJobs, stream, explicitObjectiveId)
        : [];
      const activeRunIndex = activeRunId ? runIds.indexOf(activeRunId) : -1;
      const activeRun = activeRunIndex >= 0
        ? summarizeActiveRunCard({
            runId: activeRunId!,
            runChain: runChains[activeRunIndex]!,
            relatedJobs: objectiveJobs,
            profileLabel: effectiveProfile.label,
            profileId: effectiveProfile.id,
            objectiveId: explicitObjectiveId,
          })
        : selectedJob
          ? summarizePendingRunJob(selectedJob, effectiveProfile.label)
          : undefined;
      const chatModel: FactoryChatIslandModel = {
        activeProfileId: effectiveProfile.id,
        activeProfileLabel: effectiveProfile.label,
        objectiveId: explicitObjectiveId,
        runId: activeRunId,
        jobId: input.jobId,
        panel: inspectorPanel,
        focusKind: resolvedFocusKind,
        focusId: resolvedFocusId,
        activeProfileSummary: activeProfileOverview.summary,
        activeProfileSections: activeProfileOverview.sections,
        selectedThread: selectedObjectiveCard,
        jobs: relevantJobs,
        activeCodex,
        liveChildren,
        activeRun,
        workbench,
        items: chatItems,
      };
      const navModel: FactoryNavModel = {
        activeProfileId: effectiveProfile.id,
        activeProfileLabel: effectiveProfile.label,
        profiles: profileNav,
        objectives: objectiveNav,
        showAll: input.showAll,
      };
      const inspectorModel: FactoryInspectorModel = {
        panel: inspectorPanel,
        activeProfileId: effectiveProfile.id,
        objectiveId: explicitObjectiveId,
        runId: activeRunId,
        jobId: input.jobId,
        focusKind: resolvedFocusKind,
        focusId: resolvedFocusId,
        selectedObjective: selectedObjectiveCard,
        activeCodex,
        liveChildren,
        activeRun,
        workbench,
        jobs: relevantJobs,
        tasks: detail?.tasks,
      };
      return {
        activeProfileId: effectiveProfile.id,
        activeProfileLabel: effectiveProfile.label,
        objectiveId: explicitObjectiveId,
        runId: activeRunId,
        jobId: input.jobId,
        panel: inspectorPanel,
        focusKind: resolvedFocusKind,
        focusId: resolvedFocusId,
        chat: chatModel,
        nav: navModel,
        inspector: inspectorModel,
      };
    }

    const objectives = scopedUi ? [] : await service.listObjectives();
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
    const liveObjectives = objectives.filter((objective) => !objective.archivedAt);
    const resolvedObjectiveId = await resolveSessionObjectiveId({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      selectedJob,
      jobs,
      liveObjectives,
      allowExplicitFallback: true,
    });
    const stream = resolveChatViewStream({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      job: selectedJob,
    });
    const indexChain = stream ? await agentRuntime.chain(stream) : [];

    const allRunIds = collectRunIds(indexChain);
    const requestedRunIndex = input.runId ? allRunIds.indexOf(input.runId) : -1;
    const runIds = requestedRunIndex >= 0 ? allRunIds.slice(requestedRunIndex) : allRunIds;
    const activeRunId = runIds.at(-1) ?? input.runId;
    const runChains = await Promise.all(runIds.map((runId) => stream ? agentRuntime.chain(agentRunStream(stream, runId)) : Promise.resolve([])));
    const runChainsById = new Map(runIds.map((runId, index) => [runId, runChains[index]!] as const));
    const chatItems = runChains.flatMap((runChain, index) => buildChatItemsForRun(runIds[index]!, runChain, jobsById));
    const selectedObjective = resolvedObjectiveId
      ? await service.getObjective(resolvedObjectiveId).catch(err => {
          if (err instanceof FactoryServiceError && err.status === 404) return undefined;
          throw err;
        })
      : undefined;
    const activeProfileOverview = describeProfileMarkdown(resolved.root.mdBody);

    const profileNav: ReadonlyArray<FactoryChatProfileNav> = profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      summary: describeProfileMarkdown(profile.mdBody).summary,
      selected: profile.id === resolved.root.id,
    }));
    const baseQueueJobs = stream
      ? jobs.filter((job) => isRelevantShellJob(job, stream, resolvedObjectiveId))
      : [];
    const selectedRunIds = collectRunLineageIds(
      [
        input.runId,
        selectedJob ? jobRunId(selectedJob) : undefined,
        selectedJob ? jobParentRunId(selectedJob) : undefined,
      ],
      runChainsById,
      baseQueueJobs,
    );
    const relevantQueueJobs = selectedRunIds.size > 0 || input.jobId
      ? baseQueueJobs.filter((job) =>
          job.id === input.jobId
          || jobMatchesRunIds(job, selectedRunIds)
        )
      : baseQueueJobs;
    if (selectedJob && !relevantQueueJobs.some((job) => job.id === selectedJob.id)) {
      relevantQueueJobs.unshift(selectedJob);
    }
    const activeRunLineageIds = activeRunId
      ? collectRunLineageIds([activeRunId], runChainsById, relevantQueueJobs)
      : new Set<string>();
    const activeRunJobs = activeRunLineageIds.size > 0
      ? relevantQueueJobs.filter((job) => jobMatchesRunIds(job, activeRunLineageIds))
      : relevantQueueJobs.filter((job) => jobMatchesRunIds(job, new Set([activeRunId].filter(Boolean) as string[])));
    const activeCodex = buildActiveCodexCard(relevantQueueJobs);
    const liveChildren = stream
      ? buildLiveChildCards(relevantQueueJobs, stream, resolvedObjectiveId)
      : [];
    const activeRunIndex = activeRunId ? runIds.indexOf(activeRunId) : -1;
    const activeRun = activeRunIndex >= 0
      ? summarizeActiveRunCard({
          runId: activeRunId!,
          runChain: runChains[activeRunIndex]!,
          relatedJobs: activeRunJobs,
          profileLabel: resolved.root.label,
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: resolvedObjectiveId,
        })
      : selectedJob
          ? summarizePendingRunJob(selectedJob, resolved.root.label)
          : undefined;
    const relevantJobs = relevantQueueJobs
      .slice(0, 12)
      .map((job) => ({
        jobId: job.id,
        agentId: job.agentId,
        status: job.status,
        summary: summarizeJob(job),
        runId: jobAnyRunId(job),
        objectiveId: jobObjectiveId(job),
        updatedAt: job.updatedAt,
        selected: job.id === input.jobId,
        link: buildChatLink({
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: jobObjectiveId(job),
          runId: jobAnyRunId(job),
          jobId: job.id,
          panel: input.panel,
          focusKind: "job",
          focusId: job.id,
        }),
      } satisfies FactoryChatJobNav));
    const scopedObjectiveIds = collectScopedObjectiveIds({
      requestedObjectiveId: input.objectiveId,
      resolvedObjectiveId,
      chatId: input.chatId,
      items: chatItems,
      jobs: relevantQueueJobs,
    });
    const objectiveCards = scopedUi
      ? await service.listObjectives({ objectiveIds: scopedObjectiveIds })
      : objectives;
    const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = objectiveCards
      .filter((objective) => !objective.archivedAt || objective.objectiveId === resolvedObjectiveId)
      .slice(0, input.showAll ? undefined : 16)
      .map((objective) => ({
        objectiveId: objective.objectiveId,
        title: objective.title,
        status: objective.status,
        phase: objective.phase,
        summary: objective.latestSummary ?? objective.nextAction,
        updatedAt: objective.updatedAt,
        selected: objective.objectiveId === resolvedObjectiveId,
        slotState: objective.scheduler.slotState,
        activeTaskCount: objective.activeTaskCount,
        readyTaskCount: objective.readyTaskCount,
        taskCount: objective.taskCount,
        integrationStatus: objective.integrationStatus,
      }));

    const selectedObjectiveCard: FactorySelectedObjectiveCard | undefined = selectedObjective
      ? toSelectedObjectiveCard(selectedObjective)
      : undefined;
    const initialWorkbench = buildFactoryWorkbench({
      detail: selectedObjective,
      recentJobs: relevantQueueJobs,
      requestedFocusKind: input.focusKind,
      requestedFocusId: input.focusId,
    });
    const liveOutput = selectedObjective && initialWorkbench?.focus
      ? await service.getObjectiveLiveOutput(
          selectedObjective.objectiveId,
          initialWorkbench.focus.focusKind,
          initialWorkbench.focus.focusId,
        ).catch(() => undefined)
      : undefined;
    const workbench = buildFactoryWorkbench({
      detail: selectedObjective,
      recentJobs: relevantQueueJobs,
      requestedFocusKind: initialWorkbench?.focus?.focusKind ?? input.focusKind,
      requestedFocusId: initialWorkbench?.focus?.focusId ?? input.focusId,
      liveOutput,
    });
    const inspectorPanel = input.panel ?? (workbench?.hasActiveExecution ? "live" : "overview");
    const resolvedFocusKind = workbench?.focus?.focusKind;
    const resolvedFocusId = workbench?.focus?.focusId;

    const chatModel: FactoryChatIslandModel = {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: resolvedFocusKind,
      focusId: resolvedFocusId,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSections: activeProfileOverview.sections,
      activeProfileTools: resolved.toolAllowlist,
      selectedThread: selectedObjectiveCard,
      jobs: relevantJobs,
      activeCodex,
      liveChildren,
      activeRun,
      workbench,
      items: chatItems,
    };
    const navModel: FactoryNavModel = {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      profiles: profileNav,
      objectives: objectiveNav,
      showAll: input.showAll,
    };
    const inspectorModel: FactoryInspectorModel = {
      panel: inspectorPanel,
      activeProfileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      jobId: input.jobId,
      focusKind: resolvedFocusKind,
      focusId: resolvedFocusId,
      selectedObjective: selectedObjectiveCard,
      activeCodex,
      liveChildren,
      activeRun,
      workbench,
      jobs: relevantJobs,
      tasks: selectedObjective?.tasks,
    };
    return {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: resolvedFocusKind,
      focusId: resolvedFocusId,
      chat: chatModel,
      nav: navModel,
      inspector: inspectorModel,
    };
  };

  const buildSidebarModel = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly showAll?: boolean;
  }): Promise<{ readonly nav: FactoryNavModel; readonly selectedObjective?: FactorySelectedObjectiveCard }> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const explicitObjectiveId = input.objectiveId?.trim();
    const scopedUi = Boolean(input.objectiveId?.trim() || input.chatId?.trim());
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const shouldLoadJobs = !explicitObjectiveId || Boolean(input.jobId);
    const [profiles, jobs] = await Promise.all([
      discoverFactoryChatProfiles(profileRoot),
      shouldLoadJobs ? ctx.queue.listJobs({ limit: 120 }) : Promise.resolve([] as QueueJob[]),
    ]);
    const objectives = scopedUi ? [] : await service.listObjectives();
    const liveObjectives = objectives.filter((objective) => !objective.archivedAt);
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
    const resolvedObjectiveId = explicitObjectiveId ?? await resolveSessionObjectiveId({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      selectedJob,
      jobs,
      liveObjectives,
      allowExplicitFallback: true,
    });
    const stream = !explicitObjectiveId
      ? resolveChatViewStream({
          repoRoot,
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: resolvedObjectiveId,
          job: selectedJob,
        })
      : undefined;
    const scopedJobs = !explicitObjectiveId && stream
      ? jobs.filter((job) => isRelevantShellJob(job, stream, resolvedObjectiveId))
      : [];
    if (selectedJob && !scopedJobs.some((job) => job.id === selectedJob.id)) {
      scopedJobs.unshift(selectedJob);
    }
    const objectiveCards = scopedUi
      ? await service.listObjectives({
          objectiveIds: explicitObjectiveId
            ? [explicitObjectiveId]
            : collectScopedObjectiveIds({
                requestedObjectiveId: input.objectiveId,
                resolvedObjectiveId,
                chatId: input.chatId,
                items: [],
                jobs: scopedJobs,
              }),
        })
      : objectives;
    const selectedObjective = objectiveCards.find((objective) => objective.objectiveId === resolvedObjectiveId);
    const profileNav: ReadonlyArray<FactoryChatProfileNav> = profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      summary: describeProfileMarkdown(profile.mdBody).summary,
      selected: profile.id === resolved.root.id,
    }));
    const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = objectiveCards
      .filter((objective) => !objective.archivedAt || objective.objectiveId === resolvedObjectiveId)
      .slice(0, input.showAll ? undefined : 16)
      .map((objective) => ({
        objectiveId: objective.objectiveId,
        title: objective.title,
        status: objective.status,
        phase: objective.phase,
        summary: objective.latestSummary ?? objective.nextAction,
        updatedAt: objective.updatedAt,
        selected: objective.objectiveId === resolvedObjectiveId,
        slotState: objective.scheduler.slotState,
        activeTaskCount: objective.activeTaskCount,
        readyTaskCount: objective.readyTaskCount,
        taskCount: objective.taskCount,
        integrationStatus: objective.integrationStatus,
      }));
    return {
      nav: {
        activeProfileId: resolved.root.id,
        activeProfileLabel: resolved.root.label,
        chatId: input.chatId,
        profiles: profileNav,
        objectives: objectiveNav,
        showAll: input.showAll,
      },
      selectedObjective: selectedObjective ? toSidebarSelectedObjectiveCard(selectedObjective) : undefined,
    };
  };

  const buildMissingInspectorModel = (input: {
    readonly activeProfileId: string;
    readonly objectiveId: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): FactoryInspectorModel => ({
    panel: input.panel ?? "overview",
    activeProfileId: input.activeProfileId,
    objectiveId: input.objectiveId,
    runId: input.runId,
    jobId: input.jobId,
    focusKind: input.focusKind,
    focusId: input.focusId,
    activeCodex: undefined,
    liveChildren: [],
    activeRun: undefined,
    workbench: undefined,
    jobs: [],
    objectiveMissing: true,
  });

  const buildMissingExplicitThreadShellModel = (input: {
    readonly resolvedProfile: FactoryChatProfile;
    readonly profiles: ReadonlyArray<FactoryChatProfile>;
    readonly objectiveId: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly showAll?: boolean;
  }): FactoryChatShellModel => {
    const activeProfileOverview = describeProfileMarkdown(input.resolvedProfile.mdBody);
    const inspectorPanel = input.panel ?? "overview";
    const profileNav: ReadonlyArray<FactoryChatProfileNav> = input.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      summary: describeProfileMarkdown(profile.mdBody).summary,
      selected: profile.id === input.resolvedProfile.id,
    }));
    const chatModel: FactoryChatIslandModel = {
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: input.focusKind,
      focusId: input.focusId,
      activeProfileSummary: activeProfileOverview.summary,
      activeProfileSections: activeProfileOverview.sections,
      items: [{
        key: `missing-objective-${input.objectiveId}`,
        kind: "system",
        title: "Objective not found",
        body: `The current thread URL points to Factory data that no longer exists.\n\nThread: ${input.objectiveId}`,
        meta: "warning",
      }],
    };
    const navModel: FactoryNavModel = {
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      profiles: profileNav,
      objectives: [],
      showAll: input.showAll,
    };
    const inspectorModel = buildMissingInspectorModel({
      activeProfileId: input.resolvedProfile.id,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: input.focusKind,
      focusId: input.focusId,
    });
    return {
      activeProfileId: input.resolvedProfile.id,
      activeProfileLabel: input.resolvedProfile.label,
      objectiveId: input.objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      panel: inspectorPanel,
      focusKind: input.focusKind,
      focusId: input.focusId,
      chat: chatModel,
      nav: navModel,
      inspector: inspectorModel,
    };
  };

  const buildExplicitInspectorModel = async (input: {
    readonly profileId?: string;
    readonly objectiveId: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): Promise<FactoryInspectorModel> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const objectiveId = input.objectiveId.trim();
    const panel = input.panel ?? "overview";
    const [maybeState, objectiveJobs] = await Promise.all([
      panel === "overview" || panel === "debug" || panel === "receipts"
        ? service.getObjectiveState(objectiveId).catch(() => undefined)
        : Promise.resolve(undefined),
      panel === "overview" || panel === "live"
        ? ctx.queue.listJobs({ limit: 120 }).then((jobs) =>
            jobs
              .filter((job) => jobObjectiveId(job) === objectiveId)
              .sort(compareJobsByRecency)
          )
        : Promise.resolve([] as ReadonlyArray<QueueJob>),
    ]);
    const selectedObjective = maybeState ? toStateSelectedObjectiveCard(maybeState) : undefined;

    if (!maybeState && (panel === "overview" || panel === "receipts" || panel === "debug")) {
      return buildMissingInspectorModel({
        activeProfileId: resolved.root.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        panel,
        focusKind: input.focusKind,
        focusId: input.focusId,
      });
    }

    if (panel === "overview") {
      return {
        panel,
        activeProfileId: resolved.root.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        focusKind: input.focusKind,
        focusId: input.focusId,
        selectedObjective,
        activeCodex: buildActiveCodexCard(objectiveJobs),
        liveChildren: [],
        activeRun: undefined,
        workbench: undefined,
        jobs: [],
        tasks: undefined,
        debugInfo: maybeState,
      };
    }

    if (panel === "receipts") {
      return {
        panel,
        activeProfileId: resolved.root.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        focusKind: input.focusKind,
        focusId: input.focusId,
        selectedObjective,
        activeCodex: undefined,
        liveChildren: [],
        activeRun: undefined,
        workbench: undefined,
        jobs: [],
        tasks: undefined,
        receipts: await service.listObjectiveReceipts(objectiveId, 100).catch(() => undefined),
      };
    }

    if (panel === "debug") {
      return {
        panel,
        activeProfileId: resolved.root.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        focusKind: input.focusKind,
        focusId: input.focusId,
        selectedObjective,
        activeCodex: undefined,
        liveChildren: [],
        activeRun: undefined,
        workbench: undefined,
        jobs: [],
        tasks: undefined,
        debugInfo: maybeState,
      };
    }

    const detail = await service.getObjective(objectiveId).catch(() => undefined);
    if (!detail) {
      return buildMissingInspectorModel({
        activeProfileId: resolved.root.id,
        objectiveId,
        runId: input.runId,
        jobId: input.jobId,
        panel,
        focusKind: input.focusKind,
        focusId: input.focusId,
      });
    }
    const selectedObjectiveDetail = toSelectedObjectiveCard(detail);

    const recentJobs = objectiveJobs.length > 0
      ? objectiveJobs
      : await ctx.queue.listJobs({ limit: 120 }).then((jobs) =>
          jobs
            .filter((job) => jobObjectiveId(job) === objectiveId)
            .sort(compareJobsByRecency)
        );
    const relevantJobs = recentJobs
      .slice(0, 12)
      .map((job) => ({
        jobId: job.id,
        agentId: job.agentId,
        status: job.status,
        summary: summarizeJob(job),
        runId: jobAnyRunId(job),
        objectiveId: jobObjectiveId(job),
        updatedAt: job.updatedAt,
        selected: job.id === input.jobId,
        link: buildChatLink({
          profileId: resolved.root.id,
          objectiveId,
          runId: jobAnyRunId(job),
          jobId: job.id,
          panel,
          focusKind: "job",
          focusId: job.id,
        }),
      } satisfies FactoryChatJobNav));
    const initialWorkbench = buildFactoryWorkbench({
      detail,
      recentJobs,
      requestedFocusKind: input.focusKind,
      requestedFocusId: input.focusId,
    });
    const liveOutput = initialWorkbench?.focus
      ? await service.getObjectiveLiveOutput(
          objectiveId,
          initialWorkbench.focus.focusKind,
          initialWorkbench.focus.focusId,
        ).catch(() => undefined)
      : undefined;
    const workbench = buildFactoryWorkbench({
      detail,
      recentJobs,
      requestedFocusKind: initialWorkbench?.focus?.focusKind ?? input.focusKind,
      requestedFocusId: initialWorkbench?.focus?.focusId ?? input.focusId,
      liveOutput,
    });
    return {
      panel,
      activeProfileId: resolved.root.id,
      objectiveId,
      runId: input.runId,
      jobId: input.jobId,
      focusKind: workbench?.focus?.focusKind,
      focusId: workbench?.focus?.focusId,
      selectedObjective: selectedObjectiveDetail,
      activeCodex: buildActiveCodexCard(recentJobs),
      liveChildren: [],
      activeRun: undefined,
      workbench,
      jobs: relevantJobs,
      tasks: detail.tasks,
    };
  };

  const buildInspectorTabsModel = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: string;
    readonly focusId?: string;
  }): Promise<FactoryInspectorTabsModel> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const explicitObjectiveId = input.objectiveId?.trim();
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const jobs = explicitObjectiveId && !input.jobId
      ? []
      : await ctx.queue.listJobs({ limit: 120 });
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
    const resolvedObjectiveId = explicitObjectiveId ?? await resolveSessionObjectiveId({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      selectedJob,
      jobs,
      allowExplicitFallback: true,
    });
    return {
      panel: input.panel ?? "overview",
      activeProfileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: input.runId,
      jobId: input.jobId,
      focusKind: normalizeFocusKind(input.focusKind),
      focusId: input.focusId,
    };
  };

  const buildInspectorModel = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): Promise<FactoryInspectorModel> => {
    const explicitObjectiveId = input.objectiveId?.trim();
    if (explicitObjectiveId) {
      return buildExplicitInspectorModel({
        profileId: input.profileId,
        objectiveId: explicitObjectiveId,
        runId: input.runId,
        jobId: input.jobId,
        panel: input.panel,
        focusKind: input.focusKind,
        focusId: input.focusId,
      });
    }
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const jobs = await ctx.queue.listJobs({ limit: 120 });
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
    const resolvedObjectiveId = await resolveSessionObjectiveId({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      selectedJob,
      jobs,
      allowExplicitFallback: true,
    });
    const stream = resolveChatViewStream({
      repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      job: selectedJob,
    });
    const indexChain = stream ? await agentRuntime.chain(stream) : [];
    const allRunIds = collectRunIds(indexChain);
    const requestedRunIndex = input.runId ? allRunIds.indexOf(input.runId) : -1;
    const runIds = requestedRunIndex >= 0 ? allRunIds.slice(requestedRunIndex) : allRunIds;
    const activeRunId = runIds.at(-1) ?? input.runId;
    const runChains = await Promise.all(
      runIds.map((runId) => stream ? agentRuntime.chain(agentRunStream(stream, runId)) : Promise.resolve([])),
    );
    const runChainsById = new Map(runIds.map((runId, index) => [runId, runChains[index]!] as const));
    const selectedObjective = resolvedObjectiveId
      ? await service.getObjective(resolvedObjectiveId).catch((err) => {
          if (err instanceof FactoryServiceError && err.status === 404) return undefined;
          throw err;
        })
      : undefined;
    const baseQueueJobs = stream
      ? jobs.filter((job) => isRelevantShellJob(job, stream, resolvedObjectiveId))
      : [];
    const selectedRunIds = collectRunLineageIds(
      [
        input.runId,
        selectedJob ? jobRunId(selectedJob) : undefined,
        selectedJob ? jobParentRunId(selectedJob) : undefined,
      ],
      runChainsById,
      baseQueueJobs,
    );
    const relevantQueueJobs = selectedRunIds.size > 0 || input.jobId
      ? baseQueueJobs.filter((job) =>
          job.id === input.jobId
          || jobMatchesRunIds(job, selectedRunIds)
        )
      : baseQueueJobs;
    if (selectedJob && !relevantQueueJobs.some((job) => job.id === selectedJob.id)) {
      relevantQueueJobs.unshift(selectedJob);
    }
    const activeRunLineageIds = activeRunId
      ? collectRunLineageIds([activeRunId], runChainsById, relevantQueueJobs)
      : new Set<string>();
    const activeRunJobs = activeRunLineageIds.size > 0
      ? relevantQueueJobs.filter((job) => jobMatchesRunIds(job, activeRunLineageIds))
      : relevantQueueJobs.filter((job) => jobMatchesRunIds(job, new Set([activeRunId].filter(Boolean) as string[])));
    const activeCodex = buildActiveCodexCard(relevantQueueJobs);
    const liveChildren = stream
      ? buildLiveChildCards(relevantQueueJobs, stream, resolvedObjectiveId)
      : [];
    const activeRunIndex = activeRunId ? runIds.indexOf(activeRunId) : -1;
    const activeRun = activeRunIndex >= 0
      ? summarizeActiveRunCard({
          runId: activeRunId!,
          runChain: runChains[activeRunIndex]!,
          relatedJobs: activeRunJobs,
          profileLabel: resolved.root.label,
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: resolvedObjectiveId,
        })
      : selectedJob
          ? summarizePendingRunJob(selectedJob, resolved.root.label)
          : undefined;
    const relevantJobs = relevantQueueJobs
      .slice(0, 12)
      .map((job) => ({
        jobId: job.id,
        agentId: job.agentId,
        status: job.status,
        summary: summarizeJob(job),
        runId: jobAnyRunId(job),
        objectiveId: jobObjectiveId(job),
        updatedAt: job.updatedAt,
        selected: job.id === input.jobId,
        link: buildChatLink({
          profileId: resolved.root.id,
          chatId: input.chatId,
          objectiveId: jobObjectiveId(job),
          runId: jobAnyRunId(job),
          jobId: job.id,
          panel: input.panel,
          focusKind: "job",
          focusId: job.id,
        }),
      } satisfies FactoryChatJobNav));
    const initialWorkbench = buildFactoryWorkbench({
      detail: selectedObjective,
      recentJobs: relevantQueueJobs,
      requestedFocusKind: input.focusKind,
      requestedFocusId: input.focusId,
    });
    const liveOutput = selectedObjective && initialWorkbench?.focus
      ? await service.getObjectiveLiveOutput(
          selectedObjective.objectiveId,
          initialWorkbench.focus.focusKind,
          initialWorkbench.focus.focusId,
        ).catch(() => undefined)
      : undefined;
    const workbench = buildFactoryWorkbench({
      detail: selectedObjective,
      recentJobs: relevantQueueJobs,
      requestedFocusKind: initialWorkbench?.focus?.focusKind ?? input.focusKind,
      requestedFocusId: initialWorkbench?.focus?.focusId ?? input.focusId,
      liveOutput,
    });
    const panel = input.panel ?? (workbench?.hasActiveExecution ? "live" : "overview");
    return {
      panel,
      activeProfileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      runId: activeRunId,
      jobId: input.jobId,
      focusKind: workbench?.focus?.focusKind,
      focusId: workbench?.focus?.focusId,
      selectedObjective: selectedObjective ? toSelectedObjectiveCard(selectedObjective) : undefined,
      activeCodex,
      liveChildren,
      activeRun,
      workbench,
      jobs: relevantJobs,
      tasks: selectedObjective?.tasks,
    };
  };

  const buildChatShellModelCached = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
    readonly showAll?: boolean;
  }): Promise<FactoryChatShellModel> => withProjectionCache(
    chatShellCache,
    JSON.stringify({
      input,
      queueVersion: ctx.queue.snapshot?.().version ?? 0,
      objectiveVersion: typeof service.projectionVersion === "function" ? service.projectionVersion() : 0,
    }),
    () => buildChatShellModel(input),
  );

  const buildSidebarModelCached = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly showAll?: boolean;
  }): Promise<{ readonly nav: FactoryNavModel; readonly selectedObjective?: FactorySelectedObjectiveCard }> => withProjectionCache(
    sidebarCache,
    JSON.stringify({
      input,
      queueVersion: ctx.queue.snapshot?.().version ?? 0,
      objectiveVersion: typeof service.projectionVersion === "function" ? service.projectionVersion() : 0,
    }),
    () => buildSidebarModel(input),
  );

  const buildInspectorTabsModelCached = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: string;
    readonly focusId?: string;
  }): Promise<FactoryInspectorTabsModel> => withProjectionCache(
    inspectorTabsCache,
    JSON.stringify({
      input,
      queueVersion: ctx.queue.snapshot?.().version ?? 0,
      objectiveVersion: typeof service.projectionVersion === "function" ? service.projectionVersion() : 0,
    }),
    () => buildInspectorTabsModel(input),
  );

  const buildInspectorModelCached = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly panel?: FactoryInspectorPanel;
    readonly focusKind?: "task" | "job";
    readonly focusId?: string;
  }): Promise<FactoryInspectorModel> => withProjectionCache(
    inspectorPanelCache,
    JSON.stringify({
      input,
      queueVersion: ctx.queue.snapshot?.().version ?? 0,
      objectiveVersion: typeof service.projectionVersion === "function" ? service.projectionVersion() : 0,
    }),
    () => buildInspectorModel(input),
  );

  const hydrateInspectorPanel = async (model: FactoryInspectorModel): Promise<FactoryInspectorModel> => {
    const objectiveId = model.objectiveId ?? model.selectedObjective?.objectiveId;
    const panel = model.panel;
    let receipts: FactoryInspectorModel["receipts"];
    let debugInfo: FactoryInspectorModel["debugInfo"];
    let tasks: FactoryInspectorModel["tasks"];

    if (objectiveId) {
      if (panel === "receipts" && !model.receipts) {
        try {
          receipts = await service.listObjectiveReceipts(objectiveId, 100);
        } catch {
          // Ignore if not initialized
        }
      } else if (panel === "debug" && !model.debugInfo) {
        try {
          debugInfo = await service.getObjectiveState(objectiveId);
        } catch {
          // Ignore if not initialized
        }
      } else if (panel === "execution") {
        tasks = model.tasks;
        if (!tasks) {
          try {
            const detail = await service.getObjective(objectiveId);
            tasks = detail.tasks;
          } catch {
            // Ignore if not initialized
          }
        }
      }
    }

    return {
      ...model,
      panel,
      receipts: receipts ?? model.receipts,
      debugInfo: debugInfo ?? model.debugInfo,
      tasks: tasks ?? model.tasks,
    };
  };

  const collectChatSubscriptionJobIds = async (input: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
  }): Promise<ReadonlyArray<string>> => {
    const resolved = await resolveFactoryChatProfile({
      repoRoot: service.git.repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const jobs = await ctx.queue.listJobs({ limit: 120 });
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const selectedJob = input.jobId ? jobsById.get(input.jobId) : undefined;
    const resolvedObjectiveId = await resolveSessionObjectiveId({
      repoRoot: service.git.repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: input.objectiveId,
      selectedJob,
      jobs,
      allowExplicitFallback: true,
    });
    const stream = resolveChatViewStream({
      repoRoot: service.git.repoRoot,
      profileId: resolved.root.id,
      chatId: input.chatId,
      objectiveId: resolvedObjectiveId,
      job: selectedJob,
    });
    const baseQueueJobs = stream
      ? jobs.filter((job) => isRelevantShellJob(job, stream, resolvedObjectiveId))
      : [];
    const selectedRunIds = collectRunLineageIds(
      [
        input.runId,
        selectedJob ? jobRunId(selectedJob) : undefined,
        selectedJob ? jobParentRunId(selectedJob) : undefined,
      ],
      new Map<string, AgentRunChain>(),
      baseQueueJobs,
    );
    const scopedJobs = selectedRunIds.size > 0 || input.jobId
      ? baseQueueJobs.filter((job) => job.id === input.jobId || jobMatchesRunIds(job, selectedRunIds))
      : baseQueueJobs.slice(0, 16);
    return [...new Set([
      ...scopedJobs.map((job) => job.id),
      ...(input.jobId ? [input.jobId] : []),
    ])];
  };

  return {
    id: "factory",
    kind: "factory",
    paths: {
      shell: "/factory",
      state: "/factory/api/objectives",
      events: "/factory/events",
    },
    register: (app: Hono) => {
      app.post("/factory/compose", async (c) => {
        const req = c.req.raw;
        try {
          await service.ensureBootstrap();
          const body = await readRecordBody(req, (message) => new FactoryServiceError(400, message));
          const prompt = optionalTrimmedString(body.prompt);
          if (!prompt) return navigationError(req, 400, "Enter a chat message or slash command.");

          const requestedObjective = requestedObjectiveId(req);
          const requestedChat = requestedChatId(req) ?? (!requestedObjective ? makeFactoryChatId() : undefined);
          const requestedRun = requestedRunId(req);
          const requestedJob = optionalTrimmedString(body.currentJobId) ?? requestedJobId(req);
          const currentPanel = requestedPanelParam(req);
          const currentFocusKind = normalizeFocusKind(requestedFocusKind(req));
          const currentFocusId = requestedFocusId(req);
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfileId(req),
          });
          const [objectives, jobs] = await Promise.all([
            service.listObjectives(),
            ctx.queue.listJobs({ limit: 120 }),
          ]);
          const liveObjectives = objectives.filter((objective) => !objective.archivedAt);
          const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
          let objectiveId = await resolveSessionObjectiveId({
            repoRoot: service.git.repoRoot,
            profileId: resolved.root.id,
            chatId: requestedChat,
            objectiveId: requestedObjective,
            selectedJob: requestedJob ? jobsById.get(requestedJob) : undefined,
            jobs,
            liveObjectives,
            allowExplicitFallback: true,
          });

          if (prompt.startsWith("/")) {
            const parsed = parseComposerDraft(prompt, objectiveId);
            if (!parsed.ok) return navigationError(req, 400, parsed.error);
            const command = parsed.command;

            switch (command.type) {
              case "help":
                return navigationResponse(
                  req,
                  `${buildChatLink({
                    profileId: resolved.root.id,
                    chatId: requestedChat,
                    objectiveId,
                    runId: requestedRun,
                    jobId: requestedJob,
                    panel: currentPanel,
                    focusKind: currentFocusKind,
                    focusId: currentFocusId,
                  })}#factory-command-help`,
                );
              case "watch": {
                const nextObjectiveId = await resolveWatchedObjectiveId(command.objectiveId ?? objectiveId);
                if (!nextObjectiveId) {
                  return navigationError(req, 404, command.objectiveId
                    ? `Objective '${command.objectiveId}' was not found.`
                    : "Select an objective or provide one to /watch.");
                }
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: nextObjectiveId,
                  panel: currentPanel,
                }));
              }
              case "new": {
                const nextChatId = makeFactoryChatId();
                const created = await service.createObjective({
                  title: command.title ?? "Factory objective",
                  prompt: command.prompt,
                  profileId: resolved.root.id,
                  startImmediately: true,
                });
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: nextChatId,
                  objectiveId: created.objectiveId,
                  panel: currentPanel,
                }));
              }
              case "react": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before reacting to it.");
                const detail = await service.reactObjectiveWithNote(objectiveId, command.message);
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  runId: requestedRun,
                  jobId: requestedJob,
                  panel: currentPanel,
                  focusKind: currentFocusKind,
                  focusId: currentFocusId,
                }));
              }
              case "promote": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before promoting it.");
                const detail = await service.promoteObjective(objectiveId);
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  runId: requestedRun,
                  jobId: requestedJob,
                  panel: currentPanel,
                  focusKind: currentFocusKind,
                  focusId: currentFocusId,
                }));
              }
              case "cancel": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before canceling it.");
                const detail = await service.cancelObjective(objectiveId, command.reason ?? "canceled from UI");
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  panel: currentPanel,
                  focusKind: currentFocusKind,
                  focusId: currentFocusId,
                }));
              }
              case "cleanup": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before cleaning workspaces.");
                const detail = await service.cleanupObjectiveWorkspaces(objectiveId);
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  panel: currentPanel,
                  focusKind: currentFocusKind,
                  focusId: currentFocusId,
                }));
              }
              case "archive": {
                if (!objectiveId) return navigationError(req, 409, "Select an objective before archiving it.");
                const detail = await service.archiveObjective(objectiveId);
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: detail.objectiveId,
                  panel: currentPanel,
                  focusKind: currentFocusKind,
                  focusId: currentFocusId,
                }));
              }
              case "abort-job": {
                const job = await resolveComposerJob(objectiveId, requestedJob);
                const queued = await service.queueJobAbort(
                  job.id,
                  command.reason ?? "abort requested from UI",
                  "factory.web",
                );
                return navigationResponse(req, buildChatLink({
                  profileId: resolved.root.id,
                  chatId: requestedChat,
                  objectiveId: jobObjectiveId(queued.job) ?? objectiveId,
                  runId: jobAnyRunId(queued.job) ?? requestedRun,
                  jobId: queued.job.id,
                  panel: currentPanel,
                  focusKind: "job",
                  focusId: queued.job.id,
                }));
              }
            }
          }

          if (!objectiveId) {
            const created = await service.createObjective({
              title: deriveObjectiveTitle(prompt),
              prompt,
              profileId: resolved.root.id,
              startImmediately: true,
            });
            objectiveId = created.objectiveId;
          }

          const stream = requestedChat
            ? factoryChatSessionStream(service.git.repoRoot, resolved.root.id, requestedChat)
            : factoryChatStream(service.git.repoRoot, resolved.root.id, objectiveId);
          const runId = makeFactoryRunId();
          const created = await ctx.queue.enqueue({
            agentId: "factory",
            lane: "chat",
            sessionKey: `factory-chat:${stream}`,
            singletonMode: "allow",
            maxAttempts: 1,
            payload: {
              kind: "factory.run",
              stream,
              runId,
              problem: prompt,
              profileId: resolved.root.id,
              ...(objectiveId ? { objectiveId } : {}),
              ...(requestedChat ? { chatId: requestedChat } : {}),
            },
          });
          ctx.sse.publish("jobs", created.id);
          if (objectiveId) ctx.sse.publish("factory", objectiveId);
          return navigationResponse(req, buildChatLink({
            profileId: resolved.root.id,
            chatId: requestedChat,
            objectiveId,
            runId,
            jobId: created.id,
            panel: currentPanel,
            focusKind: currentFocusKind,
            focusId: currentFocusId,
          }));
        } catch (err) {
          if (err instanceof FactoryServiceError) return navigationError(req, err.status, err.message);
          const message = err instanceof Error ? err.message : "factory server error";
          console.error(err);
          return navigationError(req, 500, message);
        }
      });

      app.get("/factory", async (c) => wrap(
        async () => buildChatShellModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
          showAll: requestedShowAll(c.req.raw),
        }),
        (model) => html(factoryChatShell(model))
      ));

      app.get("/factory/new-chat", async (c) => wrap(
        async () => buildChatLink({
          profileId: requestedProfileId(c.req.raw) ?? "generalist",
          chatId: makeFactoryChatId(),
        }),
        (location) => new Response(null, {
          status: 303,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
          },
        })
      ));

      app.get("/factory/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfileId(c.req.raw),
          });
          const chatId = requestedChatId(c.req.raw);
          const jobId = requestedJobId(c.req.raw);
          const selectedJob = jobId ? await ctx.queue.getJob(jobId) : undefined;
          const jobs = await ctx.queue.listJobs({ limit: 120 });
          const objectiveId = await resolveSessionObjectiveId({
            repoRoot: service.git.repoRoot,
            profileId: resolved.root.id,
            chatId,
            objectiveId: requestedObjectiveId(c.req.raw),
            selectedJob,
            jobs,
            allowExplicitFallback: true,
          });
          return {
            stream: resolveChatViewStream({
              repoRoot: service.git.repoRoot,
              profileId: resolved.root.id,
              chatId,
              objectiveId,
              job: selectedJob,
            }),
            objectiveId,
            jobId,
            jobIds: await collectChatSubscriptionJobIds({
              profileId: requestedProfileId(c.req.raw),
              chatId,
              objectiveId,
              runId: requestedRunId(c.req.raw),
              jobId,
            }),
          };
        },
        (body) => ctx.sse.subscribeMany([
          ...(body.stream ? [{ topic: "agent" as const, stream: body.stream }] : []),
          ...(body.objectiveId ? [{ topic: "factory" as const, stream: body.objectiveId }] : []),
          ...body.jobIds.map((jobId) => ({ topic: "jobs" as const, stream: jobId })),
          ...(body.jobId && !body.jobIds.includes(body.jobId) ? [{ topic: "jobs" as const, stream: body.jobId }] : []),
        ], c.req.raw.signal)
      ));

      app.get("/factory/island/chat", async (c) => wrap(
        async () => {
          const model = await buildChatShellModelCached({
            profileId: requestedProfileId(c.req.raw),
            chatId: requestedChatId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
            panel: requestedPanel(c.req.raw),
            focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
            focusId: requestedFocusId(c.req.raw),
            showAll: requestedShowAll(c.req.raw),
          });
          return model.chat;
        },
        (model) => html(factoryChatIsland(model))
      ));

      app.get("/factory/island/sidebar", async (c) => wrap(
        async () => buildSidebarModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          showAll: requestedShowAll(c.req.raw),
        }),
        (model) => html(factorySidebarIsland(model.nav, model.selectedObjective))
      ));

      app.get("/factory/island/inspector", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
      ));

      app.get("/factory/island/inspector/tabs", async (c) => wrap(
        async () => buildInspectorTabsModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: requestedFocusKind(c.req.raw),
          focusId: requestedFocusId(c.req.raw),
        }),
        (model) => html(factoryInspectorTabsIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
        }))
      ));

      app.get("/factory/island/inspector/panel", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorPanelIsland(model, {
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
      ));

      app.get("/factory/island/inspector/select", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorSelectionIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
      ));

      app.get("/factory/chat", async (c) => wrap(
        async () => buildChatLink({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanelParam(c.req.raw),
        }),
        (location) => new Response(null, {
          status: 303,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
          },
        })
      ));

      app.get("/factory/chat/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfileId(c.req.raw),
          });
          const chatId = requestedChatId(c.req.raw);
          const jobId = requestedJobId(c.req.raw);
          const selectedJob = jobId ? await ctx.queue.getJob(jobId) : undefined;
          const jobs = await ctx.queue.listJobs({ limit: 120 });
          const objectiveId = await resolveSessionObjectiveId({
            repoRoot: service.git.repoRoot,
            profileId: resolved.root.id,
            chatId,
            objectiveId: requestedObjectiveId(c.req.raw),
            selectedJob,
            jobs,
            allowExplicitFallback: true,
          });
          return {
            stream: resolveChatViewStream({
              repoRoot: service.git.repoRoot,
              profileId: resolved.root.id,
              chatId,
              objectiveId,
              job: selectedJob,
            }),
            objectiveId,
            jobId,
            jobIds: await collectChatSubscriptionJobIds({
              profileId: requestedProfileId(c.req.raw),
              chatId,
              objectiveId,
              runId: requestedRunId(c.req.raw),
              jobId,
            }),
          };
        },
        (body) => ctx.sse.subscribeMany([
          ...(body.stream ? [{ topic: "agent" as const, stream: body.stream }] : []),
          ...(body.objectiveId ? [{ topic: "factory" as const, stream: body.objectiveId }] : []),
          ...body.jobIds.map((jobId) => ({ topic: "jobs" as const, stream: jobId })),
          ...(body.jobId && !body.jobIds.includes(body.jobId) ? [{ topic: "jobs" as const, stream: body.jobId }] : []),
        ], c.req.raw.signal)
      ));

      app.get("/factory/chat/island/chat", async (c) => wrap(
        async () => {
          const model = await buildChatShellModelCached({
            profileId: requestedProfileId(c.req.raw),
            chatId: requestedChatId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
            runId: requestedRunId(c.req.raw),
            jobId: requestedJobId(c.req.raw),
            panel: requestedPanel(c.req.raw),
            focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
            focusId: requestedFocusId(c.req.raw),
          });
          return model.chat;
        },
        (model) => html(factoryChatIsland(model))
      ));

      app.get("/factory/chat/island/sidebar", async (c) => wrap(
        async () => buildSidebarModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          showAll: requestedShowAll(c.req.raw),
        }),
        (model) => html(factorySidebarIsland(model.nav, model.selectedObjective))
      ));

      app.get("/factory/chat/island/inspector", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
      ));

      app.get("/factory/chat/island/inspector/tabs", async (c) => wrap(
        async () => buildInspectorTabsModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: requestedFocusKind(c.req.raw),
          focusId: requestedFocusId(c.req.raw),
        }),
        (model) => html(factoryInspectorTabsIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
        }))
      ));

      app.get("/factory/chat/island/inspector/panel", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorPanelIsland(model, {
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
      ));

      app.get("/factory/chat/island/inspector/select", async (c) => wrap(
        async () => hydrateInspectorPanel(await buildInspectorModelCached({
          profileId: requestedProfileId(c.req.raw),
          chatId: requestedChatId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
          runId: requestedRunId(c.req.raw),
          jobId: requestedJobId(c.req.raw),
          panel: requestedPanel(c.req.raw),
          focusKind: normalizeFocusKind(requestedFocusKind(c.req.raw)),
          focusId: requestedFocusId(c.req.raw),
        })),
        (model) => html(factoryInspectorSelectionIsland(model, {
          tabsTrigger: FACTORY_INSPECTOR_TABS_TRIGGER,
          panelTrigger: FACTORY_INSPECTOR_PANEL_TRIGGER,
        }))
      ));

      app.get("/factory/api/live-output", async (c) => wrap(
        async () => {
          const objectiveId = requestedObjectiveId(c.req.raw);
          const focusKind = requestedFocusKind(c.req.raw);
          const focusId = requestedFocusId(c.req.raw);
          return {
            liveOutput: objectiveId && focusId && (focusKind === "task" || focusKind === "job")
              ? await service.getObjectiveLiveOutput(objectiveId, focusKind as FactoryLiveOutputTargetKind, focusId)
              : undefined,
          };
        },
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives", async (c) => wrap(
        async () => ({
          objectives: await service.listObjectives(),
          board: await service.buildBoardProjection(optionalTrimmedString(c.req.query("objective"))),
        }),
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives/:id", async (c) => wrap(
        async () => ({ objective: await service.getObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives/:id/debug", async (c) => wrap(
        async () => ({ debug: await service.getObjectiveDebug(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives/:id/receipts", async (c) => wrap(
        async () => ({
          receipts: await service.listObjectiveReceipts(
            c.req.param("id"),
            Number.parseInt(c.req.query("limit") ?? "40", 10),
          ),
        }),
        (body) => json(200, body)
      ));

      // ── Receipt browser routes ──────────────────────────────────────
      const receiptDataDir = ctx.dataDir;
      const receiptSse = ctx.sse;

      app.get("/receipt", async (c) => {
        const file = c.req.query("file") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        const files = await listReceiptFiles(receiptDataDir);
        const selected = files.find((f) => f.name === file)?.name ?? files[0]?.name;
        return html(receiptShell({ selected, limit, order, depth }));
      });

      app.get("/receipt/island/folds", async (c) => {
        const selected = c.req.query("selected") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        const files = await listReceiptFiles(receiptDataDir);
        return html(receiptFoldsHtml(files, selected, order, limit, depth));
      });

      app.get("/receipt/island/records", async (c) => {
        const file = c.req.query("file") ?? "";
        if (!file) return html(receiptRecordsHtml({ selected: undefined, records: [], order: "desc", limit: 200, total: 0 }));
        const files = await listReceiptFiles(receiptDataDir);
        const found = files.find((f) => f.name === file);
        if (!found) return html(`<div class="empty">Stream not found.</div>`);
        const records = await readReceiptFile(receiptDataDir, found.name);
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const slice = sliceReceiptRecords(records, order, limit);
        return html(receiptRecordsHtml({ selected: found.name, records: slice, order, limit, total: records.length }));
      });

      app.get("/receipt/island/side", async (c) => {
        const file = c.req.query("file") ?? "";
        const order = parseOrder(c.req.query("order"));
        const limit = parseLimit(c.req.query("limit"));
        const depth = parseInspectorDepth(c.req.query("depth"));
        if (!file) {
          return html(receiptSideHtml({ selected: undefined, order, limit, depth, total: 0, shown: 0 }));
        }
        const files = await listReceiptFiles(receiptDataDir);
        const found = files.find((f) => f.name === file);
        if (!found) {
          return html(receiptSideHtml({ selected: file, order, limit, depth, total: 0, shown: 0 }));
        }
        const records = await readReceiptFile(receiptDataDir, found.name);
        const slice = sliceReceiptRecords(records, order, limit);
        const timeline = buildReceiptTimeline(records, depth);
        return html(receiptSideHtml({
          selected: found.name,
          order,
          limit,
          depth,
          total: records.length,
          shown: slice.length,
          fileMeta: { size: found.size, mtime: found.mtime },
          timeline,
        }));
      });

      app.get("/receipt/stream", async (c) => receiptSse.subscribe("receipt", undefined, c.req.raw.signal));
    },
  };
};

export default createFactoryRoute;
