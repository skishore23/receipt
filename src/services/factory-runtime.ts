import fs from "node:fs/promises";
import path from "node:path";

import { CodexControlSignalError, LocalCodexExecutor } from "../adapters/codex-executor";
import type { JobBackend } from "../adapters/job-backend";
import {
  createMemoryTools,
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
  type MemoryTools,
} from "../adapters/memory-tools";
import { jsonBranchStore, jsonlStore } from "../adapters/jsonl";
import type { QueueJob } from "../adapters/jsonl-queue";
import { embed, llmStructured } from "../adapters/openai";
import { z } from "zod";
import { createRuntime } from "@receipt/core/runtime";
import type { JobHandler } from "../engine/runtime/job-worker";
import type { SseHub } from "../framework/sse-hub";
import type { JobCmd, JobEvent, JobState } from "../modules/job";
import { FACTORY_CONTROL_AGENT_ID, FactoryService } from "./factory-service";
import type { FactoryObjectiveAuditJobPayload } from "./factory-types";
import { runFactoryCodexJob } from "../agents/factory-chat";
import {
  readFactoryReceiptInvestigation,
  renderFactoryReceiptInvestigationText,
  type FactoryReceiptInvestigation,
} from "../factory-cli/investigate";
import type { AuditRecommendation } from "../factory-cli/analyze";

export type FactoryQueue = JobBackend;
export type FactoryJobRuntime = ReturnType<typeof createRuntime<JobCmd, JobEvent, JobState>>;

type FactoryServiceRuntimeOptions = {
  readonly dataDir: string;
  readonly queue: FactoryQueue;
  readonly jobRuntime: FactoryJobRuntime;
  readonly sse: SseHub;
  readonly repoRoot: string;
  readonly codexBin?: string;
  readonly memoryTools?: MemoryTools;
  readonly redriveQueuedJob?: (job: QueueJob) => Promise<void>;
};

const isNoRetryError = (err: unknown): boolean => {
  if (!err || typeof err !== "object" || !("status" in err)) return false;
  const status = (err as { readonly status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
};

const isTerminalJobStatus = (status: unknown): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const isRetryableAuditLockError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("database is locked");
};

const withObjectiveAuditRetry = async <T>(
  work: () => Promise<T>,
): Promise<T> => {
  let attempts = 0;
  while (true) {
    try {
      return await work();
    } catch (error) {
      attempts += 1;
      if (attempts >= 4 || !isRetryableAuditLockError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempts * 150));
    }
  }
};

type LiveGuidanceKind = "steer" | "follow_up" | "mixed";

type LiveGuidanceCommand = {
  readonly id: string;
  readonly command: "steer" | "follow_up";
  readonly payload?: Record<string, unknown>;
};

const guidanceMessageFromCommand = (command: LiveGuidanceCommand): string | undefined => {
  const payload = command.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const direct = typeof payload.message === "string" && payload.message.trim().length > 0
    ? payload.message.trim()
    : undefined;
  if (direct) return direct;
  if (command.command === "steer" && typeof payload.problem === "string" && payload.problem.trim().length > 0) {
    return payload.problem.trim();
  }
  if (command.command === "follow_up" && typeof payload.note === "string" && payload.note.trim().length > 0) {
    return payload.note.trim();
  }
  return undefined;
};

const coalesceLiveGuidanceSignal = (
  jobId: string,
  commands: ReadonlyArray<LiveGuidanceCommand>,
): {
  readonly kind: "restart";
  readonly note: string;
  readonly meta: Record<string, unknown>;
} | undefined => {
  const liveCommands = commands.filter((command) => command.command === "steer" || command.command === "follow_up");
  if (liveCommands.length === 0) return undefined;
  const messages = [...new Set(liveCommands.map((command) => guidanceMessageFromCommand(command)).filter((item): item is string => Boolean(item)))];
  if (messages.length === 0) return undefined;
  const guidanceKind: LiveGuidanceKind =
    liveCommands.every((command) => command.command === "steer")
      ? "steer"
      : liveCommands.every((command) => command.command === "follow_up")
        ? "follow_up"
        : "mixed";
  const note = messages.join("\n\n");
  return {
    kind: "restart",
    note,
    meta: {
      jobId,
      guidance: note,
      guidanceKind,
      sourceCommandIds: liveCommands.map((command) => command.id),
      appliedAt: Date.now(),
    },
  };
};

const appendLiveOperatorGuidance = (prompt: string, guidanceBlocks: ReadonlyArray<string>): string => {
  const normalizedPrompt = prompt.trimEnd();
  if (guidanceBlocks.length === 0) return normalizedPrompt;
  const section = [
    "## Live Operator Guidance",
    ...guidanceBlocks.map((guidance, index) => `${index + 1}. ${guidance}`),
  ].join("\n\n");
  return `${normalizedPrompt}\n\n${section}\n`;
};

const objectiveAuditArtifactPaths = (dataDir: string, objectiveId: string): {
  readonly root: string;
  readonly jsonPath: string;
  readonly textPath: string;
} => {
  const root = path.join(dataDir, "factory", "artifacts", objectiveId);
  return {
    root,
    jsonPath: path.join(root, "objective.audit.json"),
    textPath: path.join(root, "objective.audit.md"),
  };
};

const AuditRecommendationSchema = z.object({
  recommendations: z.array(z.object({
    summary: z.string(),
    suggestedFix: z.string(),
    autoFix: z.boolean(),
  })),
});

const generateAuditRecommendations = async (
  report: FactoryReceiptInvestigation,
  recentAuditEntries: ReadonlyArray<{ readonly text: string }>,
): Promise<ReadonlyArray<AuditRecommendation>> => {
  const anomalySummary = report.anomalies
    .slice(0, 20)
    .map((a) => `- [${a.severity}] ${a.summary}`)
    .join("\n");
  const assessmentSummary = [
    `Verdict: ${report.assessment.verdict}`,
    `Efficiency: ${report.assessment.efficiency}`,
    `Control churn: ${report.assessment.controlChurn}`,
    `Easy route risk: ${report.assessment.easyRouteRisk}`,
    ...report.assessment.notes.slice(0, 8).map((n) => `- ${n}`),
  ].join("\n");
  const recentHistory = recentAuditEntries
    .slice(0, 10)
    .map((e) => e.text.slice(0, 300))
    .join("\n---\n");
  const whatHappened = report.summary.whatHappened?.join("\n") ?? "";

  try {
    const result = await llmStructured({
      system: [
        "You are an expert software reliability engineer analyzing Factory objective audit reports.",
        "Generate concrete, actionable recommendations for code improvements.",
        "Each recommendation must include:",
        "- summary: what to fix (one sentence)",
        "- suggestedFix: concrete description of the code change (file paths, logic changes)",
        "- autoFix: true ONLY if the fix is well-understood, narrowly scoped, and the same pattern has appeared multiple times in recent audit history. false otherwise.",
        "Look at cross-run patterns in the recent audit history to identify recurring issues.",
        "Do not generate recommendations for external/infrastructure issues (API rate limits, permission denials) unless a code-level mitigation exists.",
        "Return an empty array if no actionable recommendations exist.",
      ].join("\n"),
      user: [
        "## Current Objective Audit",
        whatHappened,
        "",
        "## Assessment",
        assessmentSummary,
        "",
        "## Anomalies",
        anomalySummary || "none",
        "",
        "## Recent Audit History (cross-run patterns)",
        recentHistory || "none",
      ].join("\n"),
      schema: AuditRecommendationSchema,
      schemaName: "AuditRecommendations",
    });
    return result.parsed.recommendations;
  } catch {
    return [];
  }
};

const parseObjectiveAuditPayload = (payload: Record<string, unknown>): FactoryObjectiveAuditJobPayload => {
  if (payload.kind !== "factory.objective.audit") {
    throw new Error("invalid factory objective audit payload");
  }
  const objectiveId = typeof payload.objectiveId === "string" ? payload.objectiveId.trim() : "";
  if (!objectiveId) throw new Error("factory objective audit payload missing objectiveId");
  const objectiveStatus = typeof payload.objectiveStatus === "string" ? payload.objectiveStatus.trim() : "";
  if (!objectiveStatus) throw new Error("factory objective audit payload missing objectiveStatus");
  const objectiveUpdatedAt = typeof payload.objectiveUpdatedAt === "number" && Number.isFinite(payload.objectiveUpdatedAt)
    ? payload.objectiveUpdatedAt
    : Date.now();
  return {
    kind: "factory.objective.audit",
    objectiveId,
    objectiveStatus,
    objectiveUpdatedAt,
  };
};

const renderObjectiveAuditMemoryText = (input: {
  readonly objectiveId: string;
  readonly objectiveStatus: string;
  readonly verdict: string;
  readonly easyRouteRisk: string;
  readonly efficiency: string;
  readonly controlChurn: string;
  readonly notes: ReadonlyArray<string>;
  readonly recommendations: ReadonlyArray<AuditRecommendation>;
  readonly autoFixObjectiveId?: string;
  readonly jsonPath: string;
  readonly textPath: string;
}): string => {
  const lines = [
    "Summary",
    `${input.objectiveId} finished ${input.objectiveStatus} with verdict=${input.verdict}, easy_route_risk=${input.easyRouteRisk}, efficiency=${input.efficiency}, control_churn=${input.controlChurn}.`,
    "",
    "Assessment",
    `- Verdict: ${input.verdict}`,
    `- Easy route risk: ${input.easyRouteRisk}`,
    `- Efficiency: ${input.efficiency}`,
    `- Control churn: ${input.controlChurn}`,
    "",
    "Notes",
    ...(input.notes.length > 0 ? input.notes.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Recommendations",
    ...(input.recommendations.length > 0
      ? input.recommendations.map((r) =>
          `- ${r.summary}${r.autoFix ? " [auto-fix]" : ""}`)
      : ["- none"]),
    ...(input.autoFixObjectiveId
      ? ["", "Auto-fix", `- Triggered: ${input.autoFixObjectiveId} (delivery, severity 1)`]
      : []),
    "",
    "Artifacts",
    `- JSON: ${input.jsonPath}`,
    `- Text: ${input.textPath}`,
  ];
  return lines.join("\n");
};

const createDefaultMemoryTools = (dataDir: string): MemoryTools => {
  const memoryRuntime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    jsonlStore<MemoryEvent>(dataDir),
    jsonBranchStore(dataDir),
    decideMemory,
    reduceMemory,
    initialMemoryState,
  );
  return createMemoryTools({
    dir: dataDir,
    runtime: memoryRuntime,
    embed: process.env.OPENAI_API_KEY ? embed : undefined,
  });
};

export const createFactoryServiceRuntime = (opts: FactoryServiceRuntimeOptions): {
  readonly service: FactoryService;
  readonly memoryTools: MemoryTools;
} => {
  const memoryTools = opts.memoryTools ?? createDefaultMemoryTools(opts.dataDir);

  const service = new FactoryService({
    dataDir: opts.dataDir,
    queue: opts.queue,
    jobRuntime: opts.jobRuntime,
    sse: opts.sse,
    codexExecutor: new LocalCodexExecutor({ bin: opts.codexBin }),
    memoryTools,
    repoRoot: opts.repoRoot,
    redriveQueuedJob: opts.redriveQueuedJob,
  });

  return {
    service,
    memoryTools,
  };
};

export const runFactoryObjectiveAudit = async (input: {
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly memoryTools: MemoryTools;
  readonly payload: Record<string, unknown>;
  readonly factoryService?: FactoryService;
}): Promise<Record<string, unknown>> => {
  const parsed = parseObjectiveAuditPayload(input.payload);
  const report = await withObjectiveAuditRetry(() =>
    readFactoryReceiptInvestigation(input.dataDir, input.repoRoot, parsed.objectiveId)
  );
  const artifacts = objectiveAuditArtifactPaths(input.dataDir, parsed.objectiveId);
  await fs.mkdir(artifacts.root, { recursive: true });
  await fs.writeFile(artifacts.jsonPath, JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(
    artifacts.textPath,
    renderFactoryReceiptInvestigationText(report, { timelineLimit: 20, contextChars: 1_600 }),
    "utf-8",
  );

  // Read recent audit entries for cross-run patterns
  const recentAuditEntries = await input.memoryTools.read({
    scope: "factory/audits/repo",
    limit: 20,
  }).catch(() => []);

  // Generate LLM recommendations
  const recommendations = await generateAuditRecommendations(report, recentAuditEntries);

  // Auto-fix: create a delivery objective if the LLM flagged a recommendation for auto-fix
  let autoFixObjectiveId: string | undefined;
  if (input.factoryService) {
    const autoFixRec = recommendations.find((rec) => rec.autoFix);
    if (autoFixRec) {
      try {
        const objective = await input.factoryService.createObjective({
          title: autoFixRec.summary.slice(0, 96),
          prompt: [
            "Auto-fix triggered by audit recommendation.",
            "",
            "## What to fix",
            autoFixRec.suggestedFix,
          ].join("\n"),
          objectiveMode: "delivery",
          severity: 1,
          channel: "auto-fix",
          startImmediately: true,
        });
        autoFixObjectiveId = objective.objectiveId;
      } catch {
        // auto-fix is best-effort
      }
    }
  }

  const memoryText = renderObjectiveAuditMemoryText({
    objectiveId: parsed.objectiveId,
    objectiveStatus: parsed.objectiveStatus,
    verdict: report.assessment.verdict,
    easyRouteRisk: report.assessment.easyRouteRisk,
    efficiency: report.assessment.efficiency,
    controlChurn: report.assessment.controlChurn,
    notes: [
      ...report.assessment.notes.slice(0, 6),
      `alignment=${report.assessment.alignmentVerdict}`,
      report.assessment.correctiveSteerIssued
        ? `corrective_steer=issued aligned_after_correction=${report.assessment.alignedAfterCorrection ? "yes" : "no"}`
        : "corrective_steer=none",
    ],
    recommendations: recommendations.slice(0, 6),
    autoFixObjectiveId,
    jsonPath: artifacts.jsonPath,
    textPath: artifacts.textPath,
  });
  await withObjectiveAuditRetry(async () => {
    await Promise.all([
      input.memoryTools.commit({
      scope: `factory/audits/objectives/${parsed.objectiveId}`,
      text: memoryText,
      tags: ["factory", "audit", parsed.objectiveStatus, report.assessment.verdict],
    }),
      input.memoryTools.commit({
      scope: "factory/audits/repo",
      text: `[${parsed.objectiveId}] ${memoryText}`,
      tags: ["factory", "audit", "repo", parsed.objectiveStatus, report.assessment.verdict],
    }),
    ]);
  });

  return {
    objectiveId: parsed.objectiveId,
    objectiveStatus: parsed.objectiveStatus,
    objectiveUpdatedAt: parsed.objectiveUpdatedAt,
    verdict: report.assessment.verdict,
    easyRouteRisk: report.assessment.easyRouteRisk,
    efficiency: report.assessment.efficiency,
    controlChurn: report.assessment.controlChurn,
    alignmentVerdict: report.assessment.alignmentVerdict,
    correctiveSteerIssued: report.assessment.correctiveSteerIssued,
    alignedAfterCorrection: report.assessment.alignedAfterCorrection,
    jsonPath: artifacts.jsonPath,
    textPath: artifacts.textPath,
    recommendations: recommendations.length,
    autoFixObjectiveId,
  };
};

export const createFactoryWorkerHandlers = (service: FactoryService): Record<typeof FACTORY_CONTROL_AGENT_ID | "codex", JobHandler> => ({
  [FACTORY_CONTROL_AGENT_ID]: async (job, ctx) => {
    await ctx.pullCommands(["abort", "steer"]);
    try {
      const auditMemoryTools = service.memoryTools;
      const result = job.payload.kind === "factory.objective.audit"
        ? await runFactoryObjectiveAudit({
            dataDir: service.dataDir,
            repoRoot: service.git.repoRoot,
            memoryTools: auditMemoryTools ?? (() => { throw new Error("factory objective audit requires memory tools"); })(),
            payload: job.payload as Record<string, unknown>,
            factoryService: service,
          })
        : await service.runObjectiveControl(job.payload as Record<string, unknown>);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        result: {
          ...(typeof job.payload.objectiveId === "string" ? { objectiveId: job.payload.objectiveId } : {}),
          status: "failed",
          message,
        },
        noRetry: isNoRetryError(err),
      };
    }
  },
  codex: async (job, ctx) => {
    try {
      const result = job.payload.kind === "factory.task.run"
        ? await service.runTask(job.payload, {
          shouldAbort: async () => {
            const latest = await service.queue.getJob(job.id);
            return latest?.abortRequested === true
              || isTerminalJobStatus(latest?.status);
          },
          pollSignal: async () => {
            const commands = await ctx.pullCommands(["abort", "steer", "follow_up"]);
            if (commands.some((command) => command.command === "abort")) return { kind: "abort" as const };
            const restart = coalesceLiveGuidanceSignal(
              job.id,
              commands
                .filter((command): command is typeof command & { readonly command: "steer" | "follow_up" } =>
                  command.command === "steer" || command.command === "follow_up")
                .map((command) => ({
                  id: command.id,
                  command: command.command,
                  payload: command.payload,
                })),
            );
            if (restart) return restart;
            const latest = await service.queue.getJob(job.id);
            if (latest?.abortRequested === true || isTerminalJobStatus(latest?.status)) return { kind: "abort" };
            return undefined;
          },
          onProgress: async (update) => {
            await service.queue.progress(job.id, ctx.workerId, {
              worker: "codex",
              ...update,
            });
          },
          onChildSpawn: async (update) => {
            ctx.registerLeaseProcess({
              pid: update.pid,
              label: "codex child",
            });
          },
          onChildExit: async () => {
            ctx.clearLeaseProcess();
          },
        })
        : job.payload.kind === "factory.codex.run" || job.payload.kind === "codex.run"
          ? await (async () => {
            const payload = job.payload as Record<string, unknown>;
            const basePrompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
            if (!basePrompt) {
              throw new Error(job.payload.kind === "factory.codex.run" ? "factory codex prompt required" : "codex prompt required");
            }
            const timeoutMs = typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
              ? Math.max(30_000, Math.min(Math.floor(payload.timeoutMs), 900_000))
              : 180_000;
            const guidanceHistory: string[] = [];
            while (true) {
              try {
                return await runFactoryCodexJob({
                  dataDir: service.dataDir,
                  repoRoot: service.git.repoRoot,
                  jobId: job.id,
                  prompt: appendLiveOperatorGuidance(basePrompt, guidanceHistory),
                  timeoutMs,
                  executor: service.codexExecutor,
                  factoryService: service,
                  payload,
                  onProgress: async (update) => {
                    await service.queue.progress(job.id, ctx.workerId, update);
                  },
                }, {
                  shouldAbort: async () => {
                    const latest = await service.queue.getJob(job.id);
                    return latest?.abortRequested === true || isTerminalJobStatus(latest?.status);
                  },
                  pollSignal: async () => {
                    const commands = await ctx.pullCommands(["abort", "steer", "follow_up"]);
                    if (commands.some((command) => command.command === "abort")) return { kind: "abort" as const };
                    const restart = coalesceLiveGuidanceSignal(
                      job.id,
                      commands
                        .filter((command): command is typeof command & { readonly command: "steer" | "follow_up" } =>
                          command.command === "steer" || command.command === "follow_up")
                        .map((command) => ({
                          id: command.id,
                          command: command.command,
                          payload: command.payload,
                        })),
                    );
                    if (restart) return restart;
                    const latest = await service.queue.getJob(job.id);
                    if (latest?.abortRequested === true || isTerminalJobStatus(latest?.status)) return { kind: "abort" };
                    return undefined;
                  },
                  onChildSpawn: async (update) => {
                    ctx.registerLeaseProcess({
                      pid: update.pid,
                      label: "codex child",
                    });
                  },
                  onChildExit: async () => {
                    ctx.clearLeaseProcess();
                  },
                });
              } catch (error) {
                if (!(error instanceof CodexControlSignalError) || error.signal.kind !== "restart") throw error;
                const guidance = typeof error.signal.note === "string" ? error.signal.note.trim() : "";
                if (guidance) guidanceHistory.push(guidance);
                continue;
              }
            }
          })()
        : job.payload.kind === "factory.integration.validate"
          ? await service.runIntegrationValidation(job.payload)
        : job.payload.kind === "factory.integration.publish"
          ? await service.runIntegrationPublish(job.payload, {
              shouldAbort: async () => {
                const aborts = await ctx.pullCommands(["abort"]);
                const latest = await service.queue.getJob(job.id);
                return aborts.length > 0
                  || job.abortRequested === true
                  || isTerminalJobStatus(latest?.status);
              },
              onChildSpawn: async (update) => {
                ctx.registerLeaseProcess({
                  pid: update.pid,
                  label: "codex child",
                });
              },
              onChildExit: async () => {
                ctx.clearLeaseProcess();
              },
            })
          : (() => {
            throw new Error(`unsupported codex payload kind: ${String(job.payload.kind ?? "unknown")}`);
          })();
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        result: {
          ...(typeof job.payload.objectiveId === "string" ? { objectiveId: job.payload.objectiveId } : {}),
          status: "failed",
          message,
        },
        noRetry: isNoRetryError(err),
      };
    }
  },
});
