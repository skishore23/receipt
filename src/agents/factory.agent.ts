import path from "node:path";

import type { Hono } from "hono";

import { LocalCodexExecutor } from "../adapters/codex-executor.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import { fold } from "../core/chain.js";
import type { Runtime } from "../core/runtime.js";
import {
  emptyHtml,
  html,
  json,
  optionalTrimmedString,
  readRecordBody,
  requireTrimmedString,
  text,
  trimmedString,
} from "../framework/http.js";
import type { AgentLoaderContext, AgentRouteModule } from "../framework/agent-types.js";
import {
  type AgentRunConfig,
} from "./agent.js";
import { agentRunStream } from "./agent.streams.js";
import {
  FACTORY_CHAT_DEFAULT_CONFIG,
  normalizeFactoryChatConfig,
} from "./factory-chat.js";
import type { AgentCmd, AgentEvent, AgentState } from "../modules/agent.js";
import { initial as initialAgent, reduce as reduceAgent } from "../modules/agent.js";
import {
  discoverFactoryChatProfiles,
  factoryProfileStream,
  resolveFactoryChatProfile,
} from "../services/factory-chat-profiles.js";
import {
  FactoryService,
  FactoryServiceError,
} from "../services/factory-service.js";
import {
  factoryChatIsland,
  factoryChatShell,
  factoryInspectorIsland,
  factorySidebarIsland,
  type FactoryChatIslandModel,
  type FactoryChatItem,
  type FactoryChatObjectiveNav,
  type FactoryChatProfileNav,
  type FactoryChatShellModel,
  type FactoryChatJobNav,
  type FactorySidebarModel,
  type FactorySelectedObjectiveCard,
  type FactoryWorkCard,
} from "../views/factory-chat.js";
import type { QueueJob } from "../adapters/jsonl-queue.js";

const parseChecks = (value: unknown): ReadonlyArray<string> | undefined => {
  if (typeof value === "string") {
    const lines = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    return lines.length > 0 ? lines : undefined;
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
};

const deriveObjectiveTitle = (prompt: string): string => {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const sentence = compact.split(/[.!?]/)[0] ?? compact;
  return sentence.slice(0, 96).trim();
};

const parsePolicy = (value: unknown): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      throw new FactoryServiceError(400, "Malformed policy JSON");
    }
    throw new FactoryServiceError(400, "Policy must be an object");
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new FactoryServiceError(400, "Policy must be an object");
};

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const tryParseJson = (value: string): Record<string, unknown> | undefined => {
  try {
    return asObject(JSON.parse(value));
  } catch {
    return undefined;
  }
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

const isTerminalJobStatus = (status: string | undefined): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const interestingTools = new Set([
  "agent.delegate",
  "agent.status",
  "job.control",
  "codex.run",
  "factory.dispatch",
  "factory.status",
  "profile.handoff",
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
  const summary = asString(parsed?.summary)
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
      detail: observation.output,
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
      detail: observation.output,
      meta: durationLabel,
      jobId: asString(parsed?.jobId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "job.control") {
    return {
      key: `${observation.tool}-${asString(parsed?.jobId) ?? observation.summary ?? "job-control"}`,
      title: "Job command queued",
      worker: "queue",
      status: asString(parsed?.status) ?? "queued",
      summary: observation.summary ?? "Queued a command for a child job.",
      detail: observation.output,
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
      detail: [
        asString(parsed?.lastMessage),
        asString(parsed?.stderrTail),
        asString(parsed?.stdoutTail),
      ].filter(Boolean).join("\n\n") || observation.output,
      meta: durationLabel,
      link: asString(parsed?.link),
      jobId: asString(parsed?.jobId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "factory.dispatch" || observation.tool === "factory.status") {
    return {
      key: `${observation.tool}-${asString(parsed?.objectiveId) ?? observation.summary ?? "factory"}`,
      title: observation.tool === "factory.status" ? "Factory objective status" : "Factory objective",
      worker: asString(parsed?.worker) ?? "factory",
      status: asString(parsed?.status) ?? "updated",
      summary: asString(parsed?.summary) ?? observation.summary ?? "Factory updated.",
      detail: observation.output,
      meta: [asString(parsed?.action), durationLabel].filter(Boolean).join(" · "),
      link: asString(parsed?.link),
      objectiveId: asString(parsed?.objectiveId),
      running: !isTerminalJobStatus(asString(parsed?.status)),
    };
  }
  if (observation.tool === "profile.handoff") {
    return {
      key: `${observation.tool}-${asString(parsed?.toProfileId) ?? observation.summary ?? "handoff"}`,
      title: "Profile handoff",
      worker: "profile",
      status: asString(parsed?.status) ?? "handoff",
      summary: asString(parsed?.summary) ?? observation.summary ?? "Conversation handed off.",
      detail: observation.output,
      meta: durationLabel,
      link: asString(parsed?.link),
      running: false,
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

const buildChatItemsForRun = (
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
      items.push({
        key: `${runId}-profile-selected-${receipt.hash}`,
        kind: "system",
        title: `Profile ${event.profileId} active`,
        body: `Selection reason: ${event.reason}`,
        meta: new Date(receipt.ts).toLocaleString(),
      });
      continue;
    }
    if (event.type === "profile.handoff") {
      items.push({
        key: `${runId}-profile-handoff-${receipt.hash}`,
        kind: "system",
        title: `Handed off to ${event.toProfileId}`,
        body: event.reason,
        meta: new Date(receipt.ts).toLocaleString(),
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
        input: event.input,
        summary: event.summary,
        error: event.error,
        durationMs: event.durationMs,
      });
      if (event.error) {
        const card = workCardFromObservation({
          tool: event.tool,
          input: event.input,
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
      pending.delete(key);
    }
  }

  const final = reverseFind(chain, (receipt) => receipt.body.type === "response.finalized")?.body;
  if (final?.type === "response.finalized") {
    items.push({
      key: `${runId}-assistant-final`,
      kind: "assistant",
      body: final.content,
      meta: state.statusNote ?? state.status,
    });
  } else if (state.status === "running") {
    items.push({
      key: `${runId}-running`,
      kind: "system",
      title: "Working",
      body: "The active profile is still processing this turn.",
      meta: state.status,
    });
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
    optionalTrimmedString(new URL(req.url).searchParams.get("objective"));

  const requestedProfileId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("profile"));

  const buildShellModel = async (input: {
    readonly profileId?: string;
    readonly objectiveId?: string;
  }): Promise<FactoryChatShellModel> => {
    await service.ensureBootstrap();
    const repoRoot = service.git.repoRoot;
    const resolved = await resolveFactoryChatProfile({
      repoRoot,
      profileRoot,
      requestedId: input.profileId,
    });
    const stream = factoryProfileStream(repoRoot, resolved.root.id);
    const [profiles, objectives, selectedObjective, jobs, indexChain] = await Promise.all([
      discoverFactoryChatProfiles(profileRoot),
      service.listObjectives(),
      input.objectiveId ? service.getObjective(input.objectiveId) : Promise.resolve(undefined),
      ctx.queue.listJobs({ limit: 120 }),
      agentRuntime.chain(stream),
    ]);

    const runIds = collectRunIds(indexChain);
    const runChains = await Promise.all(runIds.map((runId) => agentRuntime.chain(agentRunStream(stream, runId))));
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const chatItems = runChains.flatMap((runChain, index) => buildChatItemsForRun(runIds[index]!, runChain, jobsById));

    const profileNav: ReadonlyArray<FactoryChatProfileNav> = profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      selected: profile.id === resolved.root.id,
    }));
    const objectiveNav: ReadonlyArray<FactoryChatObjectiveNav> = objectives
      .slice(0, 16)
      .map((objective) => ({
        objectiveId: objective.objectiveId,
        title: objective.title,
        status: objective.status,
        phase: objective.phase,
        summary: objective.latestSummary ?? objective.nextAction,
        updatedAt: objective.updatedAt,
        selected: objective.objectiveId === input.objectiveId,
        slotState: objective.scheduler.slotState,
        activeTaskCount: objective.activeTaskCount,
        readyTaskCount: objective.readyTaskCount,
        taskCount: objective.taskCount,
        integrationStatus: objective.integrationStatus,
      }));
    const relevantJobs = jobs
      .filter((job) => {
        const payloadObjectiveId = asString(job.payload.objectiveId);
        const payloadStream = asString(job.payload.stream);
        const parentStream = asString(job.payload.parentStream);
        return payloadStream === stream
          || parentStream === stream
          || payloadObjectiveId === input.objectiveId
          || job.agentId === "factory-codex";
      })
      .slice(0, 12)
      .map((job) => ({
        jobId: job.id,
        agentId: job.agentId,
        status: job.status,
        summary: summarizeJob(job),
        runId: asString(job.payload.runId),
        objectiveId: asString(job.payload.objectiveId) ?? asString(asObject(job.result)?.objectiveId),
        updatedAt: job.updatedAt,
        link: (asString(job.payload.objectiveId) ?? asString(asObject(job.result)?.objectiveId))
          ? `/factory?profile=${encodeURIComponent(resolved.root.id)}&objective=${encodeURIComponent(asString(job.payload.objectiveId) ?? asString(asObject(job.result)?.objectiveId) ?? "")}`
          : undefined,
      } satisfies FactoryChatJobNav));

    const selectedObjectiveCard: FactorySelectedObjectiveCard | undefined = selectedObjective
      ? {
          objectiveId: selectedObjective.objectiveId,
          title: selectedObjective.title,
          status: selectedObjective.status,
          phase: selectedObjective.phase,
          summary: selectedObjective.latestSummary ?? selectedObjective.nextAction,
          debugLink: `/factory/api/objectives/${encodeURIComponent(selectedObjective.objectiveId)}/debug`,
          receiptsLink: `/factory/api/objectives/${encodeURIComponent(selectedObjective.objectiveId)}/receipts?limit=50`,
          nextAction: selectedObjective.nextAction,
          slotState: selectedObjective.scheduler.slotState,
          queuePosition: selectedObjective.scheduler.queuePosition,
          blockedReason: selectedObjective.blockedReason,
          blockedExplanation: selectedObjective.blockedExplanation?.summary,
          integrationStatus: selectedObjective.integrationStatus,
          activeTaskCount: selectedObjective.activeTaskCount,
          readyTaskCount: selectedObjective.readyTaskCount,
          taskCount: selectedObjective.taskCount,
          repoProfileStatus: selectedObjective.repoProfile.status,
          latestCommitHash: selectedObjective.latestCommitHash,
          checks: selectedObjective.checks,
          latestDecisionSummary: selectedObjective.latestDecision?.summary,
          latestDecisionAt: selectedObjective.latestDecision?.at,
        }
      : undefined;

    const chatModel: FactoryChatIslandModel = {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      items: chatItems,
    };
    const sidebarModel: FactorySidebarModel = {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      profiles: profileNav,
      objectives: objectiveNav,
      jobs: relevantJobs,
      selectedObjective: selectedObjectiveCard,
    };
    return {
      activeProfileId: resolved.root.id,
      activeProfileLabel: resolved.root.label,
      objectiveId: input.objectiveId,
      chat: chatModel,
      sidebar: sidebarModel,
    };
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
      app.get("/factory", async (c) => wrap(
        async () => buildShellModel({
          profileId: requestedProfileId(c.req.raw),
          objectiveId: requestedObjectiveId(c.req.raw),
        }),
        (model) => html(factoryChatShell(model))
      ));

      app.get("/factory/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfileId(c.req.raw),
          });
          return factoryProfileStream(service.git.repoRoot, resolved.root.id);
        },
        (stream) => ctx.sse.subscribeMany([
          { topic: "agent", stream },
          { topic: "receipt" },
          { topic: "jobs" },
        ], c.req.raw.signal)
      ));

      app.get("/factory/island/chat", async (c) => wrap(
        async () => {
          const model = await buildShellModel({
            profileId: requestedProfileId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
          });
          return model.chat;
        },
        (model) => html(factoryChatIsland(model))
      ));

      app.get("/factory/island/sidebar", async (c) => wrap(
        async () => {
          const model = await buildShellModel({
            profileId: requestedProfileId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
          });
          return model.sidebar;
        },
        (model) => html(factorySidebarIsland(model))
      ));

      app.get("/factory/island/inspector", async (c) => wrap(
        async () => {
          const model = await buildShellModel({
            profileId: requestedProfileId(c.req.raw),
            objectiveId: requestedObjectiveId(c.req.raw),
          });
          return model.sidebar;
        },
        (model) => html(factoryInspectorIsland(model))
      ));

      app.post("/factory/run", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          const problem = requireTrimmedString(body.problem, "problem required");
          const objectiveId = optionalTrimmedString(body.objective);
          const requestedProfile = optionalTrimmedString(body.profile);
          const resolved = await resolveFactoryChatProfile({
            repoRoot: service.git.repoRoot,
            profileRoot,
            requestedId: requestedProfile,
            problem,
          });
          const stream = factoryProfileStream(service.git.repoRoot, resolved.root.id);
          const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const config: AgentRunConfig = normalizeFactoryChatConfig(FACTORY_CHAT_DEFAULT_CONFIG);
          const created = await ctx.queue.enqueue({
            agentId: "factory",
            lane: "collect",
            sessionKey: `factory-chat:${stream}`,
            singletonMode: "allow",
            maxAttempts: 1,
            payload: {
              kind: "factory.run",
              stream,
              runId,
              problem,
              profileId: resolved.root.id,
              config,
            },
          });
          ctx.sse.publish("jobs", created.id);
          const location = `/factory?profile=${encodeURIComponent(resolved.root.id)}${objectiveId ? `&objective=${encodeURIComponent(objectiveId)}` : ""}&job=${encodeURIComponent(created.id)}&run=${encodeURIComponent(runId)}`;
          if (c.req.header("HX-Request") === "true") {
            return emptyHtml({
              "HX-Replace-Url": location,
              "HX-Trigger": JSON.stringify({
                "factory-run-started": {
                  profileId: resolved.root.id,
                  profileLabel: resolved.root.label,
                  objectiveId: objectiveId ?? "",
                  jobId: created.id,
                  runId,
                  location,
                },
              }),
            });
          }
          return new Response(null, {
            status: 303,
            headers: {
              Location: location,
              "Cache-Control": "no-store",
            },
          });
        },
        (response) => response
      ));

      app.get("/factory/api/objectives", async (c) => wrap(
        async () => ({
          objectives: await service.listObjectives(),
          board: await service.buildBoardProjection(optionalTrimmedString(c.req.query("objective"))),
        }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives", async (c) => wrap(
        async () => {
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          return {
            objective: await service.createObjective({
              title: trimmedString(body.title) ?? deriveObjectiveTitle(requireTrimmedString(body.prompt, "prompt required")),
              prompt: trimmedString(body.prompt),
              baseHash: optionalTrimmedString(body.baseHash),
              checks: parseChecks(body.validationCommands) ?? parseChecks(body.checks),
              channel: optionalTrimmedString(body.channel),
              policy: parsePolicy(body.policy),
            }),
          };
        },
        (body) => json(201, body)
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

      app.post("/factory/api/objectives/:id/react", async (c) => wrap(
        async () => ({ objective: await service.reactObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/promote", async (c) => wrap(
        async () => ({ objective: await service.promoteObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/cancel", async (c) => wrap(
        async () => {
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          return { objective: await service.cancelObjective(c.req.param("id"), optionalTrimmedString(body.reason)) };
        },
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/archive", async (c) => wrap(
        async () => ({ objective: await service.archiveObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/cleanup", async (c) => wrap(
        async () => ({ objective: await service.cleanupObjectiveWorkspaces(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/job/:id/steer", async (c) => wrap(
        async () => {
          const jobId = c.req.param("id");
          const body = await readRecordBody(c.req.raw, (msg) => new FactoryServiceError(400, msg));
          const payload: Record<string, unknown> = {};
          const problem = optionalTrimmedString(body.problem);
          const configRaw = optionalTrimmedString(body.config);
          if (problem) payload.problem = problem;
          if (configRaw) {
            const parsed = parsePolicy(configRaw);
            if (parsed) payload.config = parsed;
          }
          if (Object.keys(payload).length === 0) throw new FactoryServiceError(400, "provide problem and/or config");
          const queued = await ctx.queue.queueCommand({ jobId, command: "steer", payload, by: "factory.ui" });
          if (!queued) throw new FactoryServiceError(404, "job not found");
          ctx.sse.publish("jobs", jobId);
          return "Steer command queued.";
        },
        (msg) => text(202, msg)
      ));

      app.post("/factory/job/:id/follow-up", async (c) => wrap(
        async () => {
          const jobId = c.req.param("id");
          const body = await readRecordBody(c.req.raw, (msg) => new FactoryServiceError(400, msg));
          const note = requireTrimmedString(body.note, "note required");
          const queued = await ctx.queue.queueCommand({ jobId, command: "follow_up", payload: { note }, by: "factory.ui" });
          if (!queued) throw new FactoryServiceError(404, "job not found");
          ctx.sse.publish("jobs", jobId);
          return "Follow-up command queued.";
        },
        (msg) => text(202, msg)
      ));

      app.post("/factory/job/:id/abort", async (c) => wrap(
        async () => {
          const jobId = c.req.param("id");
          const body = await readRecordBody(c.req.raw, (msg) => new FactoryServiceError(400, msg));
          const reason = optionalTrimmedString(body.reason) ?? "abort requested";
          const queued = await ctx.queue.queueCommand({ jobId, command: "abort", payload: { reason }, by: "factory.ui" });
          if (!queued) throw new FactoryServiceError(404, "job not found");
          ctx.sse.publish("jobs", jobId);
          return "Abort command queued.";
        },
        (msg) => text(202, msg)
      ));
    },
  };
};

export default createFactoryRoute;
