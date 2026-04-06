import path from "node:path";

import { readRepoStatus } from "../lib/repo-status";
import type { FactoryService } from "../services/factory-service";
import type { AgentToolExecutor } from "./capabilities";
import type { AgentFinalizer, AgentRunInput } from "./agent";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type FactoryLiveWaitState = {
  surfaced: boolean;
};

export type FactoryLiveFinalResponsePolicy = "allow" | "waiting_message" | "reject";

export type ActiveChildProgress = {
  readonly jobId?: string;
  readonly summary?: string;
  readonly detail?: string;
};

const INITIAL_FACTORY_LIVE_WAIT_MS = 120;
const LIVE_PROGRESS_FINAL_TEXT_RE =
  /\b(queued|running|active|keep this chat open|live update|live updates|in progress|waiting|monitoring|watching|not finished|ask for status|check status)\b/i;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export const clampWaitMs = (value: unknown, max = 20_000): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Math.floor(value), max))
    : 0;

export const effectiveFactoryLiveWaitMs = (
  requestedWaitMs: number,
  live: boolean,
  state: FactoryLiveWaitState,
): number =>
  !live || requestedWaitMs <= 0 || state.surfaced
    ? requestedWaitMs
    : Math.min(requestedWaitMs, INITIAL_FACTORY_LIVE_WAIT_MS);

export const waitForSnapshotChange = async <T>(
  initial: T,
  waitMs: number,
  snapshot: () => Promise<T>,
): Promise<{ readonly value: T; readonly waitedMs: number; readonly changed: boolean }> => {
  if (waitMs <= 0) return { value: initial, waitedMs: 0, changed: false };
  const startedAt = Date.now();
  const initialFingerprint = JSON.stringify(initial);
  let current = initial;
  while (Date.now() - startedAt < waitMs) {
    const remaining = waitMs - (Date.now() - startedAt);
    await delay(Math.min(1_000, Math.max(50, remaining)));
    current = await snapshot();
    if (JSON.stringify(current) !== initialFingerprint) {
      return {
        value: current,
        waitedMs: Date.now() - startedAt,
        changed: true,
      };
    }
  }
  return {
    value: current,
    waitedMs: Date.now() - startedAt,
    changed: false,
  };
};

export const deriveObjectiveTitle = (prompt: string): string => {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return "Factory objective";
  const sentence = compact.split(/[.!?]/)[0] ?? compact;
  return sentence.slice(0, 96).trim() || "Factory objective";
};

export const isActiveJobStatus = (status: string | undefined): boolean =>
  status === "queued" || status === "leased" || status === "running";

export const createRepoStatusTool = (repoRoot: string): AgentToolExecutor =>
  async () => {
    const status = await readRepoStatus(path.resolve(repoRoot));
    return {
      output: JSON.stringify({
        worker: "repo",
        action: "status",
        ...status,
      }, null, 2),
      summary: `${status.branch}@${status.baseHash.slice(0, 8)} ${status.dirty ? `dirty (${status.changedCount})` : "clean"}`,
    };
  };

export const renderActiveChildProgressText = (progress: ActiveChildProgress): string =>
  [
    progress.jobId ? `Child work is still running as ${progress.jobId}.` : "Child work is still running.",
    progress.detail ?? progress.summary,
    "Keep this chat open for live updates.",
  ].filter(Boolean).join("\n\n");

export const createLiveFactoryFinalizer = (input: {
  readonly factoryService?: Pick<FactoryService, "getObjective">;
  readonly getCurrentObjectiveId: () => string | undefined;
  readonly liveWaitState: FactoryLiveWaitState;
  readonly finalWhileChildRunning?: FactoryLiveFinalResponsePolicy;
  readonly describeActiveChild?: () => Promise<ActiveChildProgress | undefined>;
}): AgentFinalizer =>
  async ({ text }) => {
    if (LIVE_PROGRESS_FINAL_TEXT_RE.test(text)) return { accept: true };
    const finalWhileChildRunning = input.finalWhileChildRunning ?? "waiting_message";

    const activeChild = await input.describeActiveChild?.();
    if (activeChild?.summary || activeChild?.detail || activeChild?.jobId) {
      if (finalWhileChildRunning === "allow") return { accept: true };
      if (finalWhileChildRunning === "reject") {
        return {
          accept: false,
          note: `child work is still running${activeChild.jobId ? ` as ${activeChild.jobId}` : ""}; continue monitoring before finalizing`,
        };
      }
      return {
        accept: true,
        text: renderActiveChildProgressText(activeChild),
      };
    }

    if (!input.liveWaitState.surfaced || !input.factoryService) return { accept: true };
    const objectiveId = input.getCurrentObjectiveId();
    if (!objectiveId) return { accept: true };
    const detail = await input.factoryService.getObjective(objectiveId).catch(() => undefined);
    if (!detail || detail.archivedAt || detail.status === "blocked" || detail.status === "completed" || detail.status === "failed" || detail.status === "canceled") {
      return { accept: true };
    }
    if (finalWhileChildRunning === "allow") return { accept: true };
    if (finalWhileChildRunning === "reject") {
      return {
        accept: false,
        note: `${detail.title || detail.objectiveId} is still ${detail.status}${detail.phase ? ` (${detail.phase})` : ""}; continue monitoring with factory.status or factory.output`,
      };
    }
    return {
      accept: true,
      text: [
        "Work is still running in this chat.",
        `${detail.title || detail.objectiveId} is ${detail.status}${detail.phase ? ` (${detail.phase})` : ""}.`,
        asString(detail.latestSummary),
        "Keep this chat open for live updates.",
      ].filter(Boolean).join("\n\n"),
    };
  };

export const combineFinalizers = (
  first: AgentFinalizer,
  second?: AgentRunInput["finalizer"],
): AgentFinalizer =>
  async (input) => {
    const firstResult = await first(input);
    if (!firstResult.accept || !second) return firstResult;
    const secondResult = await second(input);
    return {
      accept: secondResult.accept,
      text: secondResult.text ?? firstResult.text,
      note: secondResult.note ?? firstResult.note,
    };
  };
