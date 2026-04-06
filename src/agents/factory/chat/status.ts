import type { QueueJob } from "../../../adapters/sqlite-queue";
import type { FactoryService } from "../../../services/factory-service";
import { factoryChatCodexArtifactPaths, readTextTail } from "../../../services/factory-codex-artifacts";
import { asString, listChildJobsForRun, reusableInfrastructureRefs, summarizeObjectiveReceipts, normalizeJobSnapshot } from "./input";
import { isActiveJobStatus } from "../../orchestration-utils";
import { isObjectiveContinuationBoundary } from "../dispatch";

export const codexJobSnapshot = async (job: QueueJob, dataDir?: string): Promise<Record<string, unknown>> => {
  const base = normalizeJobSnapshot(job);
  if (job.agentId !== "codex" || !dataDir) return base;
  const artifacts = factoryChatCodexArtifactPaths(dataDir, job.id);
  const [lastMessage, stdoutTail, stderrTail] = await Promise.all([
    readTextTail(artifacts.lastMessagePath, 400),
    readTextTail(artifacts.stdoutPath, 900),
    readTextTail(artifacts.stderrPath, 600),
  ]);
  return {
    ...base,
    artifacts,
    lastMessage: lastMessage ?? base.lastMessage,
    stdoutTail: stdoutTail ?? base.stdoutTail,
    stderrTail: stderrTail ?? base.stderrTail,
  };
};

export const buildFactorySituation = async (input: {
  readonly queue: import("../../../adapters/sqlite-queue").SqliteQueue;
  readonly runId: string;
  readonly stream: string;
  readonly profile: { readonly root: { readonly label: string; readonly id: string } };
  readonly getCurrentObjectiveId: () => string | undefined;
  readonly factoryService: FactoryService;
  readonly dataDir?: string;
  readonly detailLevel?: "full" | "light";
}): Promise<string> => {
  const lines = [`Profile: ${input.profile.root.label} (${input.profile.root.id})`];
  const objectiveId = input.getCurrentObjectiveId();
  if (input.detailLevel === "light") {
    if (objectiveId) {
      lines.push(`Bound objective: ${objectiveId}`);
      lines.push("Chat-first conversational turn. Use objective tools or explicit work-follow-up only if current objective details are actually needed.");
    } else {
      lines.push("Chat-first conversational turn. No objective detail is loaded unless the turn asks for active work context.");
    }
    return lines.join("\n");
  }
  const childJobs = await listChildJobsForRun(input.queue, input.runId);
  const activeChildren = childJobs.filter((job) => isActiveJobStatus(job.status));
  const canInspectObjective = typeof input.factoryService.getObjective === "function"
    && typeof input.factoryService.getObjectiveDebug === "function"
    && typeof input.factoryService.listObjectiveReceipts === "function";
  if (objectiveId && canInspectObjective) {
    try {
      const [detail, debug, receipts] = await Promise.all([
        input.factoryService.getObjective(objectiveId),
        input.factoryService.getObjectiveDebug(objectiveId),
        input.factoryService.listObjectiveReceipts(objectiveId, { limit: 8 }),
      ]);
      lines.push(`Objective: ${detail.title} (${detail.objectiveId})`);
      lines.push(`Status: ${detail.status} · phase ${detail.phase} · integration ${detail.integration.status}`);
      lines.push(`Mode: ${detail.objectiveMode} · severity ${detail.severity}`);
      lines.push(
        isObjectiveContinuationBoundary(detail)
          ? "Continuation rule: this bound objective is terminal or blocked. Historical/meta questions can answer directly, but fresh work should continue the thread by reacting with a note so Factory can create and bind a follow-up objective."
          : "Continuation rule: this bound objective is still live. Follow-up work that is clearly about this objective should react in place; unrelated fresh work should start a new objective instead of being forced into the current one.",
      );
      if (detail.latestDecision?.summary) lines.push(`Latest decision: ${detail.latestDecision.summary}`);
      if (detail.blockedExplanation?.summary) lines.push(`Blocked: ${detail.blockedExplanation.summary}`);
      const planPreview = detail.tasks.slice(0, 6).map((task) =>
        `- ${task.taskId} [${task.status}] ${task.title}${(task.dependsOn ?? []).length > 0 ? ` · depends on ${(task.dependsOn ?? []).join(", ")}` : ""}`
      );
      if (planPreview.length > 0) {
        lines.push("Plan:");
        lines.push(...planPreview);
      }
      const activeJobs = debug.activeJobs.slice(0, 3);
      if (activeJobs.length > 0) {
        lines.push("Active jobs:");
        lines.push(...activeJobs.map((job) => `- ${job.id}: ${job.agentId} ${job.status}`));
      }
      const receiptLines = summarizeObjectiveReceipts(receipts, 5);
      if (receiptLines.length > 0) {
        lines.push("Recent receipts:");
        lines.push(...receiptLines);
      }
      const reusableRefs = reusableInfrastructureRefs(detail.contextSources?.sharedArtifactRefs);
      if (reusableRefs.knowledge.length > 0) {
        lines.push("Checked-in helper manifests:");
        lines.push(...reusableRefs.knowledge.slice(0, 3).map((ref) => `- ${ref}`));
      }
      if (reusableRefs.scripts.length > 0) {
        lines.push("Checked-in helper entrypoints:");
        lines.push(...reusableRefs.scripts.slice(0, 4).map((ref) => `- ${ref}`));
        lines.push("Freshness rule: for live cloud/account/runtime questions, rerun the best matching checked-in helper before finalizing; do not answer from saved output alone.");
      }
    } catch (err: unknown) {
      const status = typeof err === "object" && err !== null && "status" in err
        ? (err as { readonly status?: unknown }).status
        : undefined;
      const message = err instanceof Error ? err.message : undefined;
      if (status === 404 || message?.includes("not found")) {
        lines.push(`Objective: ${objectiveId}`);
        lines.push("Objective has not been created yet.");
      } else {
        throw err;
      }
    }
  } else if (objectiveId) {
    lines.push(`Objective: ${objectiveId}`);
    lines.push("Objective detail is not available in this runtime.");
  } else if (activeChildren.length > 0) {
    lines.push("Active child jobs:");
    const snapshots = await Promise.all(activeChildren.slice(0, 3).map((job) => codexJobSnapshot(job, input.dataDir)));
    lines.push(...snapshots.map((snapshot) =>
      `- ${String(snapshot.jobId)}: ${String(snapshot.worker)} ${String(snapshot.status)}${asString(snapshot.summary) ? ` · ${String(snapshot.summary)}` : ""}`
    ));
  } else {
    lines.push("No active objective or child work.");
  }
  return lines.join("\n");
};
