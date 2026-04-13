import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";

import type { Runtime } from "@receipt/core/runtime";
import { bindBunWebSocketToLiveHub } from "@receipt/live/bun";

import type { MemoryTools } from "../../../adapters/memory-tools";
import { optionalTrimmedString, readRecordBody, json } from "../../../framework/http";
import type { AgentCmd, AgentEvent, AgentState } from "../../../modules/agent";
import {
  factoryChatSessionStream,
  repoKeyForRoot,
  resolveFactoryChatProfile,
  type FactoryChatProfile,
  type FactoryChatProfileObjectiveMode,
} from "../../../services/factory-chat-profiles";
import { writeObjectiveDispatchToSession } from "../session-handoff";
import { readSessionHistory, searchSessionHistory } from "../../../services/session-history";
import { listUserPreferenceEntries, summarizeUserPreferences } from "../../../services/conversation-memory";
import {
  FactoryServiceError,
  type FactoryLiveOutputTargetKind,
  type FactoryService,
} from "../../../services/factory-service";
import { readPersistedObjectiveAuditMetadata } from "../../../services/factory/objective-audit-artifacts";
import { readPersistedSystemImprovementReport } from "../../../services/factory/system-improvement-artifacts";
import {
  buildSystemAutoFixObjectiveInput,
  findExistingSystemAutoFixObjective,
} from "../../../services/factory/system-improvement-autofix";
import {
  buildAutoFixObjectiveInput,
  findExistingAutoFixObjective,
} from "../../../services/factory/objective-audit-autofix";
import {
  inferExplicitDeliveryObjectiveMode,
  parseComposerDraft,
} from "../../../factory-cli/composer";
import type { AgentLoaderContext } from "../../../framework/agent-types";
import type { QueueJob } from "../../../adapters/sqlite-queue";
import {
  buildWorkbenchLink,
  navigationError,
  workbenchNavigationResponse,
} from "./navigation";
import {
  makeFactoryRunId,
  objectiveProfileIdForPrompt,
  requestedChatId,
  requestedFocusId,
  requestedFocusKind,
  requestedJobId,
  requestedObjectiveId,
  requestedProfileId,
  requestedRunId,
} from "./params";
import { readWorkbenchRequest } from "./workbench-request";
import type { FactoryDispatchAction } from "../dispatch";
import { jobObjectiveId } from "../shared";
import { liveSubscriptionsForFactoryChatEvents } from "./events";

type RouteWrap = <T>(
  fn: () => Promise<T>,
  render: (value: T) => Response,
) => Promise<Response>;

type ObjectiveChatBinding = {
  readonly objectiveId: string;
  readonly chatId: string;
  readonly profileId: string;
};

type ResolvedFactoryChatProfile = Awaited<ReturnType<typeof resolveFactoryChatProfile>>;

export const registerFactoryApiRoutes = (input: {
  readonly app: Hono;
  readonly basePath?: "/factory" | "/factory-new" | "/factory-preview";
  readonly wrap: RouteWrap;
  readonly ctx: AgentLoaderContext;
  readonly service: FactoryService;
  readonly profileRoot: string;
  readonly loadFactoryProfiles: () => Promise<ReadonlyArray<FactoryChatProfile>>;
  readonly resolveObjectiveChatBinding: (
    objectiveId: string,
    profileId?: string,
  ) => Promise<ObjectiveChatBinding | undefined>;
  readonly resolveWatchedObjectiveId: (value: string | undefined) => Promise<string | undefined>;
  readonly resolveComposerJob: (objectiveId: string | undefined, preferredJobId: string | undefined) => Promise<QueueJob>;
  readonly assertComposeDispatchActionAllowed: (
    profile: ResolvedFactoryChatProfile,
    action: FactoryDispatchAction,
  ) => void;
  readonly assertComposeCreateModeAllowed: (
    profile: ResolvedFactoryChatProfile,
    objectiveMode: FactoryChatProfileObjectiveMode,
  ) => void;
  readonly resolveChatEventSubscriptions: (inputEvent: {
    readonly profileId?: string;
    readonly chatId?: string;
    readonly objectiveId?: string;
    readonly runId?: string;
    readonly jobId?: string;
  }) => Promise<{
    readonly profileId: string;
    readonly stream?: string;
    readonly objectiveId?: string;
    readonly jobIds: ReadonlyArray<string>;
  }>;
  readonly agentRuntime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly memoryTools?: MemoryTools;
  readonly dataDir?: string;
}) => {
  const {
    app,
    basePath = "/factory",
    wrap,
    ctx,
    service,
    profileRoot,
    loadFactoryProfiles,
    resolveObjectiveChatBinding,
    resolveWatchedObjectiveId,
    resolveComposerJob,
    assertComposeDispatchActionAllowed,
    assertComposeCreateModeAllowed,
    resolveChatEventSubscriptions,
    memoryTools,
    dataDir,
  } = input;
  const repoKey = repoKeyForRoot(service.git.repoRoot);
  const readChatEventSubscriptionRequest = (req: Request) => resolveChatEventSubscriptions({
    profileId: requestedProfileId(req) ?? "generalist",
    chatId: requestedChatId(req),
    objectiveId: requestedObjectiveId(req),
    runId: requestedRunId(req),
    jobId: requestedJobId(req),
  });

  app.post(`${basePath}/compose`, async (c) => {
    const req = c.req.raw;
    try {
      const body = await readRecordBody(req, (message) => new FactoryServiceError(400, message));
      const prompt = optionalTrimmedString(body.prompt);
      if (!prompt) return navigationError(req, 400, "Enter a chat message or slash command.");

      const request = readWorkbenchRequest(req);
      const workbenchLink = (input: Parameters<typeof buildWorkbenchLink>[0]): string =>
        buildWorkbenchLink({
          ...input,
          basePath: request.shellBase,
        });
      const resolved = await resolveFactoryChatProfile({
        repoRoot: service.git.repoRoot,
        profileRoot,
        requestedId: request.profileId,
      });

      if (prompt.startsWith("/")) {
        const parsed = parseComposerDraft(prompt, request.objectiveId);
        if (!parsed.ok) return navigationError(req, 400, parsed.error);
        const command = parsed.command;
        switch (command.type) {
          case "help":
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: request.profileId,
              chatId: request.chatId,
              objectiveId: request.objectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: request.detailTab,
              page: request.page,
              filter: request.filter,
              focusKind: request.focusKind,
              focusId: request.focusId,
            }), {
              chatId: request.chatId,
              objectiveId: request.objectiveId,
              focusKind: request.focusKind,
              focusId: request.focusId,
            });
          case "watch": {
            const nextObjectiveId = await resolveWatchedObjectiveId(command.objectiveId ?? request.objectiveId);
            if (!nextObjectiveId) {
              return navigationError(req, 404, command.objectiveId
                ? `Objective '${command.objectiveId}' was not found.`
                : "Select an objective or provide one to /watch.");
            }
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: request.profileId,
              chatId: request.chatId,
              objectiveId: nextObjectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: "action",
              page: request.page,
              filter: request.filter,
            }), {
              chatId: request.chatId,
              objectiveId: nextObjectiveId,
            });
          }
          case "new": {
            const targetProfileId = objectiveProfileIdForPrompt({
              prompt: command.prompt,
              resolvedProfile: resolved.root,
              profiles: await loadFactoryProfiles(),
            });
            const requestedObjectiveMode = command.objectiveMode ?? inferExplicitDeliveryObjectiveMode(command.prompt);
            const targetProfile = targetProfileId === resolved.root.id
              ? resolved
              : await resolveFactoryChatProfile({
                repoRoot: service.git.repoRoot,
                profileRoot,
                requestedId: targetProfileId,
              });
            assertComposeDispatchActionAllowed(targetProfile, "create");
            assertComposeCreateModeAllowed(
              targetProfile,
              requestedObjectiveMode ?? targetProfile.objectivePolicy.defaultObjectiveMode,
            );
            const created = await service.createObjective({
              title: command.title ?? "Factory objective",
              prompt: command.prompt,
              objectiveMode: requestedObjectiveMode,
              profileId: targetProfileId,
            });
            const dispatchRunId = await writeObjectiveDispatchToSession({
              agentRuntime: input.agentRuntime,
              repoRoot: service.git.repoRoot,
              profileId: targetProfileId,
              chatId: request.chatId,
              objectiveId: created.objectiveId,
              title: command.title ?? "Factory objective",
              prompt: command.prompt,
            });
            const binding = await resolveObjectiveChatBinding(created.objectiveId, targetProfileId);
            const canonicalChatId = binding?.chatId ?? request.chatId;
            ctx.sse.publish("factory", created.objectiveId);
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: targetProfileId,
              chatId: canonicalChatId,
              objectiveId: created.objectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: "action",
              page: request.page,
              filter: request.filter,
            }), {
              chatId: canonicalChatId,
              objectiveId: created.objectiveId,
              live: {
                profileId: targetProfileId,
                chatId: canonicalChatId,
                objectiveId: created.objectiveId,
                runId: dispatchRunId,
              },
            });
          }
          case "react": {
            assertComposeDispatchActionAllowed(resolved, "react");
            if (!request.objectiveId) return navigationError(req, 409, "Select an objective before reacting to it.");
            const detail = await service.reactObjectiveWithNote(request.objectiveId, command.message);
            ctx.sse.publish("factory", detail.objectiveId);
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: request.profileId,
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: request.detailTab,
              page: request.page,
              filter: request.filter,
            }), {
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
            });
          }
          case "note": {
            assertComposeDispatchActionAllowed(resolved, "react");
            if (!request.objectiveId) return navigationError(req, 409, "Select an objective before noting it.");
            await service.addObjectiveNote(request.objectiveId, command.message ?? "");
            const detail = await service.getObjective(request.objectiveId);
            ctx.sse.publish("factory", detail.objectiveId);
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: request.profileId,
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: request.detailTab,
              page: request.page,
              filter: request.filter,
            }), {
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
            });
          }
          case "promote": {
            assertComposeDispatchActionAllowed(resolved, "promote");
            if (!request.objectiveId) return navigationError(req, 409, "Select an objective before promoting it.");
            const detail = await service.promoteObjective(request.objectiveId);
            ctx.sse.publish("factory", detail.objectiveId);
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: request.profileId,
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: request.detailTab,
              page: request.page,
              filter: request.filter,
            }), {
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
            });
          }
          case "cancel": {
            assertComposeDispatchActionAllowed(resolved, "cancel");
            if (!request.objectiveId) return navigationError(req, 409, "Select an objective before canceling it.");
            const detail = await service.cancelObjective(request.objectiveId, command.reason ?? "canceled from workbench");
            ctx.sse.publish("factory", detail.objectiveId);
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: request.profileId,
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: request.detailTab,
              page: request.page,
              filter: request.filter,
            }), {
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
            });
          }
          case "cleanup": {
            assertComposeDispatchActionAllowed(resolved, "cleanup");
            if (!request.objectiveId) return navigationError(req, 409, "Select an objective before cleaning workspaces.");
            const detail = await service.cleanupObjectiveWorkspaces(request.objectiveId);
            ctx.sse.publish("factory", detail.objectiveId);
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: request.profileId,
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: request.detailTab,
              page: request.page,
              filter: request.filter,
            }), {
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
            });
          }
          case "archive": {
            assertComposeDispatchActionAllowed(resolved, "archive");
            if (!request.objectiveId) return navigationError(req, 409, "Select an objective before archiving it.");
            const detail = await service.archiveObjective(request.objectiveId);
            ctx.sse.publish("factory", detail.objectiveId);
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: request.profileId,
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: request.detailTab,
              page: request.page,
              filter: request.filter,
            }), {
              chatId: request.chatId,
              objectiveId: detail.objectiveId,
            });
          }
          case "abort-job": {
            const job = await resolveComposerJob(request.objectiveId, optionalTrimmedString(body.currentJobId) ?? requestedJobId(req));
            const queued = await service.queueJobAbort(
              job.id,
              command.reason ?? "abort requested from workbench",
              "factory.workbench",
            );
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: request.profileId,
              chatId: request.chatId,
              objectiveId: jobObjectiveId(queued.job) ?? request.objectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: request.detailTab,
              page: request.page,
              filter: request.filter,
              focusKind: "job",
              focusId: queued.job.id,
            }), {
              chatId: request.chatId,
              objectiveId: jobObjectiveId(queued.job) ?? request.objectiveId,
              focusKind: "job",
              focusId: queued.job.id,
            });
          }
          case "steer": {
            const job = await resolveComposerJob(request.objectiveId, optionalTrimmedString(body.currentJobId) ?? requestedJobId(req));
            const queued = await service.queueJobSteer(job.id, command.message ?? "", "factory.workbench");
            return workbenchNavigationResponse(req, workbenchLink({
              profileId: request.profileId,
              chatId: request.chatId,
              objectiveId: jobObjectiveId(queued.job) ?? request.objectiveId,
              inspectorTab: request.inspectorTab,
              detailTab: request.detailTab,
              page: request.page,
              filter: request.filter,
              focusKind: "job",
              focusId: queued.job.id,
            }), {
              chatId: request.chatId,
              objectiveId: jobObjectiveId(queued.job) ?? request.objectiveId,
              focusKind: "job",
              focusId: queued.job.id,
            });
          }
          case "follow-up": {
            try {
              const job = await resolveComposerJob(request.objectiveId, optionalTrimmedString(body.currentJobId) ?? requestedJobId(req));
              const queued = await service.queueJobFollowUp(job.id, command.message ?? "", "factory.workbench");
              return workbenchNavigationResponse(req, workbenchLink({
                profileId: request.profileId,
                chatId: request.chatId,
                objectiveId: jobObjectiveId(queued.job) ?? request.objectiveId,
                inspectorTab: request.inspectorTab,
                detailTab: request.detailTab,
                page: request.page,
                filter: request.filter,
                focusKind: "job",
                focusId: queued.job.id,
              }), {
                chatId: request.chatId,
                objectiveId: jobObjectiveId(queued.job) ?? request.objectiveId,
                focusKind: "job",
                focusId: queued.job.id,
              });
            } catch (err) {
              if (!(err instanceof FactoryServiceError) || err.status !== 409 || !request.objectiveId) throw err;
              const detail = await service.getObjective(request.objectiveId);
              if (detail.status !== "blocked") throw err;
              const resumed = await service.reactObjectiveWithNote(request.objectiveId, command.message ?? "");
              ctx.sse.publish("factory", resumed.objectiveId);
              return workbenchNavigationResponse(req, workbenchLink({
                profileId: request.profileId,
                chatId: request.chatId,
                objectiveId: resumed.objectiveId,
                inspectorTab: request.inspectorTab,
                detailTab: request.detailTab,
                page: request.page,
                filter: request.filter,
              }), {
                chatId: request.chatId,
                objectiveId: resumed.objectiveId,
              });
            }
          }
        }
      }

      const stream = factoryChatSessionStream(service.git.repoRoot, resolved.root.id, request.chatId);
      const runId = makeFactoryRunId();
      const created = await ctx.queue.enqueue({
        agentId: "factory",
        lane: "chat",
        sessionKey: `factory-chat:${stream}`,
        singletonMode: "cancel",
        maxAttempts: 1,
        payload: {
          kind: "factory.run",
          stream,
          runId,
          problem: prompt,
          profileId: resolved.root.id,
          chatId: request.chatId,
          ...(request.objectiveId ? { objectiveId: request.objectiveId } : {}),
        },
      });
      ctx.sse.publish("jobs", created.id);
      return workbenchNavigationResponse(req, workbenchLink({
        profileId: request.profileId,
        chatId: request.chatId,
        objectiveId: request.objectiveId,
        inspectorTab: request.inspectorTab,
        detailTab: request.detailTab,
        page: request.page,
        filter: request.filter,
        focusKind: request.focusKind,
        focusId: request.focusId,
      }), {
        chatId: request.chatId,
        objectiveId: request.objectiveId,
        focusKind: request.focusKind,
        focusId: request.focusId,
        live: {
          profileId: request.profileId,
          chatId: request.chatId,
          objectiveId: request.objectiveId,
          runId,
          jobId: created.id,
        },
      });
    } catch (err) {
      if (err instanceof FactoryServiceError) return navigationError(req, err.status, err.message);
      const message = err instanceof Error ? err.message : "factory server error";
      console.error(err);
      return navigationError(req, 500, message);
    }
  });

  app.post(`${basePath}/api/objectives/:id/self-improvement/apply`, async (c) => {
    const req = c.req.raw;
    try {
      if (!dataDir) throw new FactoryServiceError(503, "Objective audit artifacts are not configured.");
      const request = readWorkbenchRequest(req);
      const workbenchLink = (input: Parameters<typeof buildWorkbenchLink>[0]): string =>
        buildWorkbenchLink({
          ...input,
          basePath: request.shellBase,
        });
      const objectiveId = c.req.param("id");
      const body = await readRecordBody(req, (message) => new FactoryServiceError(400, message));
      const rawIndex = optionalTrimmedString(body.recommendationIndex);
      const recommendationIndex = rawIndex ? Number.parseInt(rawIndex, 10) : Number.NaN;
      if (!Number.isInteger(recommendationIndex) || recommendationIndex < 0) {
        throw new FactoryServiceError(400, "Provide a valid recommendation index.");
      }
      const auditMetadata = await readPersistedObjectiveAuditMetadata(dataDir, objectiveId);
      if (!auditMetadata || auditMetadata.recommendationStatus !== "ready") {
        throw new FactoryServiceError(409, "A fresh self-improvement recommendation snapshot is not available.");
      }
      const recommendation = auditMetadata.recommendations[recommendationIndex];
      if (!recommendation) {
        throw new FactoryServiceError(404, "That self-improvement recommendation no longer exists.");
      }
      const sourceObjective = await service.getObjective(objectiveId);
      const existingObjectiveId = await findExistingAutoFixObjective(service, recommendation);
      const autoFixObjective = existingObjectiveId
        ? await service.getObjective(existingObjectiveId).catch(() => undefined)
        : await service.createObjective(buildAutoFixObjectiveInput({
          recommendation,
          sourceObjectiveId: objectiveId,
          patternCounts: new Map(
            auditMetadata.recurringPatterns.map((entry) => [entry.pattern, entry.count] as const),
          ),
          triggerLabel: "Operator-applied self-improvement recommendation.",
        }));
      const targetObjectiveId = autoFixObjective?.objectiveId ?? existingObjectiveId;
      if (!targetObjectiveId) {
        throw new FactoryServiceError(500, "Failed to create or locate the auto-fix objective.");
      }
      const targetProfileId = autoFixObjective?.profile.rootProfileId ?? sourceObjective.profile.rootProfileId;
      ctx.sse.publish("factory", objectiveId);
      ctx.sse.publish("factory", targetObjectiveId);
      return workbenchNavigationResponse(req, workbenchLink({
        profileId: targetProfileId,
        chatId: request.chatId,
        objectiveId: targetObjectiveId,
        inspectorTab: "chat",
        detailTab: "action",
        page: request.page,
        filter: request.filter,
      }), {
        chatId: request.chatId,
        objectiveId: targetObjectiveId,
      });
    } catch (err) {
      if (err instanceof FactoryServiceError) return navigationError(req, err.status, err.message);
      const message = err instanceof Error ? err.message : "factory server error";
      console.error(err);
      return navigationError(req, 500, message);
    }
  });

  app.post(`${basePath}/api/system-improvement/apply`, async (c) => {
    const req = c.req.raw;
    try {
      if (!dataDir) throw new FactoryServiceError(503, "System improvement artifacts are not configured.");
      const request = readWorkbenchRequest(req);
      const workbenchLink = (input: Parameters<typeof buildWorkbenchLink>[0]): string =>
        buildWorkbenchLink({
          ...input,
          basePath: request.shellBase,
        });
      const systemImprovement = await readPersistedSystemImprovementReport(dataDir);
      const recommendation = systemImprovement?.selectedRecommendation ?? systemImprovement?.recommendations[0];
      if (!systemImprovement || !recommendation) {
        throw new FactoryServiceError(409, "A fresh repo-wide system improvement snapshot is not available.");
      }
      const existingObjectiveId = await findExistingSystemAutoFixObjective(service, recommendation);
      const autoFixObjective = existingObjectiveId
        ? await service.getObjective(existingObjectiveId).catch(() => undefined)
        : await service.createObjective(buildSystemAutoFixObjectiveInput({
          recommendation,
          audit: systemImprovement.auditSummary,
          dst: systemImprovement.dstSummary,
          context: systemImprovement.contextSummary,
          triggerLabel: "Operator-applied repo-wide system improvement recommendation.",
        }));
      const targetObjectiveId = autoFixObjective?.objectiveId ?? existingObjectiveId;
      if (!targetObjectiveId) {
        throw new FactoryServiceError(500, "Failed to create or locate the repo-wide auto-fix objective.");
      }
      const targetProfileId = autoFixObjective?.profile.rootProfileId ?? "software";
      ctx.sse.publish("factory", targetObjectiveId);
      if (request.objectiveId) ctx.sse.publish("factory", request.objectiveId);
      return workbenchNavigationResponse(req, workbenchLink({
        profileId: targetProfileId,
        chatId: request.chatId,
        objectiveId: targetObjectiveId,
        inspectorTab: "chat",
        detailTab: "action",
        page: request.page,
        filter: request.filter,
      }), {
        chatId: request.chatId,
        objectiveId: targetObjectiveId,
      });
    } catch (err) {
      if (err instanceof FactoryServiceError) return navigationError(req, err.status, err.message);
      const message = err instanceof Error ? err.message : "factory server error";
      console.error(err);
      return navigationError(req, 500, message);
    }
  });

  app.get(
    `${basePath}/live`,
    upgradeWebSocket(async (c) => {
      const body = await readChatEventSubscriptionRequest(c.req.raw);
      const subscriptions = liveSubscriptionsForFactoryChatEvents(body);
      let connection: { readonly close: () => void } | null = null;
      return {
        onOpen(_event, ws) {
          connection = bindBunWebSocketToLiveHub(ctx.sse, subscriptions, ws);
        },
        onClose() {
          connection?.close();
          connection = null;
        },
        onError() {
          connection?.close();
          connection = null;
        },
      };
    }),
  );

  app.get(`${basePath}/api/live-output`, async (c) => wrap(
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
    (body) => json(200, body),
  ));

  app.get(`${basePath}/api/user-preferences`, async (c) => wrap(
    async () => {
      if (!memoryTools) throw new FactoryServiceError(503, "User preference memory is not configured.");
      const requestedScope = optionalTrimmedString(c.req.query("scope"))?.toLowerCase();
      const scopeMode = requestedScope === "repo" || requestedScope === "global" || requestedScope === "layered"
        ? requestedScope
        : "layered";
      return {
        scopeMode,
        summary: await summarizeUserPreferences({
          memoryTools,
          repoKey,
          runId: "factory_api_user_preferences",
          actor: "factory-api",
          scopeMode,
        }),
        entries: await listUserPreferenceEntries({
          memoryTools,
          repoKey,
          runId: "factory_api_user_preferences",
          actor: "factory-api",
          scopeMode,
        }),
      };
    },
    (body) => json(200, body),
  ));

  app.get(`${basePath}/api/session-history`, async (c) => wrap(
    async () => {
      if (!dataDir) throw new FactoryServiceError(503, "Session history is not configured.");
      const requestedProfile = requestedProfileId(c.req.raw) ?? "generalist";
      const resolvedProfile = await resolveFactoryChatProfile({
        repoRoot: service.git.repoRoot,
        profileRoot,
        requestedId: requestedProfile,
      });
      const query = optionalTrimmedString(c.req.query("query"));
      const chatId = requestedChatId(c.req.raw) ?? optionalTrimmedString(c.req.query("chat"));
      const explicitSessionStream = optionalTrimmedString(c.req.query("sessionStream"));
      const sessionStream = explicitSessionStream
        ?? (chatId ? factoryChatSessionStream(service.git.repoRoot, resolvedProfile.root.id, chatId) : undefined);
      const parsedLimit = Number.parseInt(c.req.query("limit") ?? (query ? "10" : "50"), 10);
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
      if (query) {
        return {
          results: await searchSessionHistory({
            dataDir,
            query,
            repoKey,
            profileId: resolvedProfile.root.id,
            sessionStream,
            limit,
          }),
        };
      }
      if (!sessionStream && !chatId) {
        throw new FactoryServiceError(400, "Provide a chat or sessionStream when reading session history.");
      }
      return {
        messages: await readSessionHistory({
          dataDir,
          ...(sessionStream ? { sessionStream } : { chatId }),
          limit,
        }),
      };
    },
    (body) => json(200, body),
  ));

  app.get(`${basePath}/api/objectives`, async (c) => wrap(
    async () => ({
      objectives: await service.listObjectives(),
      board: await service.buildBoardProjection(optionalTrimmedString(c.req.query("objective"))),
    }),
    (body) => json(200, body),
  ));

  app.get(`${basePath}/api/objectives/:id`, async (c) => wrap(
    async () => ({ objective: await service.getObjective(c.req.param("id")) }),
    (body) => json(200, body),
  ));

  app.get(`${basePath}/api/objectives/:id/debug`, async (c) => wrap(
    async () => ({ debug: await service.getObjectiveDebug(c.req.param("id")) }),
    (body) => json(200, body),
  ));

  app.get(`${basePath}/api/objectives/:id/receipts`, async (c) => wrap(
    async () => ({
      receipts: await service.listObjectiveReceipts(
        c.req.param("id"),
        Number.parseInt(c.req.query("limit") ?? "40", 10),
      ),
    }),
    (body) => json(200, body),
  ));
};
