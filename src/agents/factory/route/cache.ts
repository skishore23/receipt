import type { Runtime } from "@receipt/core/runtime";

import type { AgentCmd, AgentEvent, AgentState } from "../../../modules/agent";
import type { QueueJob } from "../../../adapters/jsonl-queue";
import type { FactoryChatProfile } from "../../../services/factory-chat-profiles";
import { factoryChatSessionStream, discoverFactoryChatProfiles, resolveFactoryChatProfile } from "../../../services/factory-chat-profiles";
import type { FactoryChatShellModel } from "../../../views/factory-models";
import { projectFactoryChatContextFromReceipts } from "../chat-context";
import {
  readChatContextProjection,
  readChatContextProjectionVersion,
  syncChangedChatContextProjections,
  syncChatContextProjectionStream,
} from "../../../db/projectors";
import type { AgentRunChain } from "../shared";
import type { AgentLoaderContext } from "../../../framework/agent-types";
import { FactoryService } from "../../../services/factory-service";

export type FactoryRouteCache = ReturnType<typeof createFactoryRouteCache>;

export const createFactoryRouteCache = (input: {
  readonly ctx: AgentLoaderContext;
  readonly service: FactoryService;
  readonly profileRoot: string;
  readonly agentRuntime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly chatProjectionDataDir?: string;
}) => {
  const projectionCacheTtlMs = 900;
  const chatShellCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<FactoryChatShellModel>;
  }>();
  const recentJobsCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<ReadonlyArray<QueueJob>>;
  }>();
  const profileCatalogCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: Promise<ReadonlyArray<FactoryChatProfile>>;
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

  const loadRecentJobs = async (limit = 120): Promise<ReadonlyArray<QueueJob>> => withProjectionCache(
    recentJobsCache,
    JSON.stringify({
      limit,
      queueVersion: input.ctx.queue.snapshot?.().version ?? 0,
    }),
    () => input.ctx.queue.listJobs({ limit }),
  );

  const loadFactoryProfiles = async (): Promise<ReadonlyArray<FactoryChatProfile>> => withProjectionCache(
    profileCatalogCache,
    input.profileRoot,
    () => discoverFactoryChatProfiles(input.profileRoot),
  );

  const resolveObjectiveProjectionVersion = async (): Promise<number> => {
    const serviceWithFreshProjection = input.service as FactoryService & {
      readonly projectionVersionFresh?: () => Promise<number>;
    };
    if (typeof serviceWithFreshProjection.projectionVersionFresh === "function") {
      return serviceWithFreshProjection.projectionVersionFresh();
    }
    return typeof input.service.projectionVersion === "function" ? input.service.projectionVersion() : 0;
  };

  const resolveSessionStreamVersion = async (inputStream: {
    readonly profileId?: string;
    readonly chatId?: string;
  }): Promise<string | undefined> => {
    if (!inputStream.chatId) return undefined;
    const resolved = await resolveFactoryChatProfile({
      repoRoot: input.service.git.repoRoot,
      profileRoot: input.profileRoot,
      requestedId: inputStream.profileId,
    });
    const stream = factoryChatSessionStream(input.service.git.repoRoot, resolved.root.id, inputStream.chatId);
    const chain = await input.agentRuntime.chain(stream);
    const head = chain.at(-1);
    if (input.chatProjectionDataDir) {
      await syncChangedChatContextProjections(input.chatProjectionDataDir).catch(() => undefined);
    }
    const projectionVersion = input.chatProjectionDataDir
      ? readChatContextProjectionVersion(input.chatProjectionDataDir, stream)
      : undefined;
    return projectionVersion !== undefined
      ? `chat:${projectionVersion}`
      : (head ? `${chain.length}:${head.hash}` : "0:");
  };

  const fallbackChatContextFromChain = (inputChain: {
    readonly sessionStream: string;
    readonly chain: AgentRunChain;
  }) =>
    projectFactoryChatContextFromReceipts({
      sessionStream: inputChain.sessionStream,
      receipts: inputChain.chain.map((receipt) => ({
        stream: receipt.stream,
        ts: receipt.ts,
        hash: receipt.hash,
        id: receipt.id,
        eventType: receipt.body.type,
        body: receipt.body,
      })),
    });

  const loadChatContextProjectionForSession = async (inputChain: {
    readonly sessionStream: string;
    readonly fallbackChain?: AgentRunChain;
  }) => {
    if (input.chatProjectionDataDir) {
      await syncChatContextProjectionStream(input.chatProjectionDataDir, inputChain.sessionStream).catch(() => undefined);
    }
    return (input.chatProjectionDataDir
      ? readChatContextProjection(input.chatProjectionDataDir, inputChain.sessionStream)
      : undefined)
      ?? (inputChain.fallbackChain ? fallbackChatContextFromChain({
        sessionStream: inputChain.sessionStream,
        chain: inputChain.fallbackChain,
      }) : undefined);
  };

  return {
    loadRecentJobs,
    loadFactoryProfiles,
    resolveObjectiveProjectionVersion,
    resolveSessionStreamVersion,
    loadChatContextProjectionForSession,
    withProjectionCache,
    projectionCacheTtlMs,
    chatShellCache,
  };
};
