import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { bindBunWebSocketToLiveHub } from "@receipt/live/bun";

import { html } from "../../../framework/http";
import type { AgentLoaderContext } from "../../../framework/agent-types";
import {
  requestedChatId,
  requestedJobId,
  requestedObjectiveId,
  requestedProfileId,
  requestedRunId,
} from "./params";
import {
  factoryPreviewDrawerSectionIsland,
  factoryPreviewFocusIsland,
  factoryPreviewHeaderIsland,
  factoryPreviewRailIsland,
  factoryPreviewShell,
  factoryPreviewTimelineIsland,
  type FactoryPreviewDrawerSectionKey,
  type FactoryPreviewRailSectionKey,
} from "../../../views/factory/preview";
import type { FactoryWorkbenchRequestState } from "./workbench-request";
import type { WorkbenchVersionEnvelope } from "../../../views/factory-models";
import type { FactoryWorkbenchHeaderIslandModel } from "../../../views/factory/workbench/page";
import type { FactoryWorkbenchWorkspaceModel, FactoryChatIslandModel } from "../../../views/factory-models";
import type { FactoryObjectiveDetail } from "../../../services/factory-types";
import { liveSubscriptionsForFactoryChatEvents } from "./events";

type RouteWrap = <T>(
  fn: () => Promise<T>,
  render: (value: T) => Response,
) => Promise<Response>;

type PreviewSelectionModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly chat: FactoryChatIslandModel;
  readonly detail?: FactoryObjectiveDetail;
};

type PreviewBoardModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
};

type PreviewFocusModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
};

type PreviewChatBodyModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly chat: FactoryChatIslandModel;
};

type PreviewEnvelopeModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly envelope: WorkbenchVersionEnvelope;
};

type PreviewServerTiming = {
  readonly measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
};

type ServerTimingCollector = PreviewServerTiming & {
  readonly apply: (response: Response) => Response;
};

const createServerTimingCollector = (): ServerTimingCollector => {
  const metrics: Array<{ name: string; durationMs: number }> = [];
  return {
    measure: async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
      const startedAt = performance.now();
      try {
        return await run();
      } finally {
        metrics.push({
          name,
          durationMs: Math.max(0, performance.now() - startedAt),
        });
      }
    },
    apply: (response: Response): Response => {
      if (metrics.length === 0) return response;
      const headers = new Headers(response.headers);
      headers.set(
        "Server-Timing",
        metrics.map((metric) => `${metric.name};dur=${metric.durationMs.toFixed(1)}`).join(", "),
      );
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};

const escapeEtagVersion = (value: string): string =>
  value.replace(/[\\"]/g, "");

const etagForVersion = (value: string): string => `W/"${escapeEtagVersion(value)}"`;

const notModifiedResponse = (version: string): Response =>
  new Response(null, {
    status: 304,
    headers: {
      "Cache-Control": "no-store",
      "ETag": etagForVersion(version),
    },
  });

const requestMatchesVersion = (req: Request, version: string): boolean =>
  req.headers.get("if-none-match") === etagForVersion(version);

const versionedHtml = (
  req: Request,
  markup: string,
  version: string,
): Response => {
  const etag = etagForVersion(version);
  if (req.headers.get("if-none-match") === etag) return notModifiedResponse(version);
  return html(markup, {
    "ETag": etag,
  });
};

const readExpandedRailSections = (req: Request): ReadonlyArray<FactoryPreviewRailSectionKey> => {
  const raw = new URL(req.url).searchParams.get("railExpanded");
  if (!raw) return [];
  const allowed = new Set<FactoryPreviewRailSectionKey>([
    "active",
    "needs_attention",
    "completed",
    "archived",
  ]);
  const expanded: FactoryPreviewRailSectionKey[] = [];
  for (const candidate of raw.split(",")) {
    const normalized = candidate.trim();
    if (!allowed.has(normalized as FactoryPreviewRailSectionKey) || expanded.includes(normalized as FactoryPreviewRailSectionKey)) {
      continue;
    }
    expanded.push(normalized as FactoryPreviewRailSectionKey);
  }
  return expanded;
};

export const registerFactoryPreviewRoutes = (input: {
  readonly app: Hono;
  readonly wrap: RouteWrap;
  readonly ctx: AgentLoaderContext;
  readonly loadWorkbenchRequestBoardModel: (
    req: Request,
    timing?: PreviewServerTiming,
  ) => Promise<PreviewBoardModel>;
  readonly loadWorkbenchRequestFocusModel: (
    req: Request,
    timing?: PreviewServerTiming,
  ) => Promise<PreviewFocusModel>;
  readonly loadWorkbenchRequestChatBodyModel: (
    req: Request,
    timing?: PreviewServerTiming,
  ) => Promise<PreviewChatBodyModel>;
  readonly loadWorkbenchRequestSelectionModel: (
    req: Request,
    timing?: PreviewServerTiming,
  ) => Promise<PreviewSelectionModel>;
  readonly loadWorkbenchRequestPreviewStaticEnvelope: (
    req: Request,
    timing?: PreviewServerTiming,
  ) => Promise<PreviewEnvelopeModel>;
  readonly loadWorkbenchRequestPreviewChatEnvelope: (
    req: Request,
    timing?: PreviewServerTiming,
  ) => Promise<PreviewEnvelopeModel>;
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
}) => {
  const {
    app,
    wrap,
    loadWorkbenchRequestBoardModel,
    loadWorkbenchRequestFocusModel,
    loadWorkbenchRequestChatBodyModel,
    loadWorkbenchRequestSelectionModel,
    loadWorkbenchRequestPreviewStaticEnvelope,
    loadWorkbenchRequestPreviewChatEnvelope,
    resolveChatEventSubscriptions,
  } = input;
  const basePath = "/factory-preview" as const;
  const readChatEventSubscriptionRequest = (req: Request) => resolveChatEventSubscriptions({
    profileId: requestedProfileId(req),
    chatId: requestedChatId(req),
    objectiveId: requestedObjectiveId(req),
    runId: requestedRunId(req),
    jobId: requestedJobId(req),
  });

  app.get(basePath, async (c) => {
    const timing = createServerTimingCollector();
    return wrap(
      async () => loadWorkbenchRequestSelectionModel(c.req.raw, timing),
      ({ header, workspace, chat, envelope }) => timing.apply(html(factoryPreviewShell({
        shellBase: basePath,
        header,
        workspace,
        chat,
        envelope,
        expandedRailSections: readExpandedRailSections(c.req.raw),
      }))),
    );
  });

  app.get(`${basePath}/island/header`, async (c) => {
    const timing = createServerTimingCollector();
    return wrap(
      async () => {
        const expandedRailSections = readExpandedRailSections(c.req.raw);
        const { envelope } = await loadWorkbenchRequestPreviewStaticEnvelope(c.req.raw, timing);
        const version = `${envelope.boardVersion}:${envelope.focusVersion}`;
        if (requestMatchesVersion(c.req.raw, version)) {
          return { kind: "not_modified" as const, version };
        }
        const model = await loadWorkbenchRequestBoardModel(c.req.raw, timing);
        return { kind: "render" as const, version, expandedRailSections, model };
      },
      (result) => timing.apply(result.kind === "not_modified"
        ? notModifiedResponse(result.version)
        : versionedHtml(
            c.req.raw,
            factoryPreviewHeaderIsland({
              shellBase: basePath,
              header: result.model.header,
              workspace: result.model.workspace,
              envelope: result.model.envelope,
              expandedRailSections: result.expandedRailSections,
            }),
            result.version,
          )),
    );
  });

  app.get(`${basePath}/island/rail`, async (c) => {
    const timing = createServerTimingCollector();
    return wrap(
      async () => {
        const expandedRailSections = readExpandedRailSections(c.req.raw);
        const { envelope } = await loadWorkbenchRequestPreviewStaticEnvelope(c.req.raw, timing);
        const version = `${envelope.boardVersion}:${expandedRailSections.join(",")}`;
        if (requestMatchesVersion(c.req.raw, version)) {
          return { kind: "not_modified" as const, version };
        }
        const model = await loadWorkbenchRequestFocusModel(c.req.raw, timing);
        return { kind: "render" as const, version, expandedRailSections, model };
      },
      (result) => timing.apply(result.kind === "not_modified"
        ? notModifiedResponse(result.version)
        : versionedHtml(
            c.req.raw,
            factoryPreviewRailIsland({
              shellBase: basePath,
              workspace: result.model.workspace,
              envelope: result.model.envelope,
              expandedRailSections: result.expandedRailSections,
            }),
            result.version,
          )),
    );
  });

  app.get(`${basePath}/island/focus`, async (c) => {
    const timing = createServerTimingCollector();
    return wrap(
      async () => {
        const expandedRailSections = readExpandedRailSections(c.req.raw);
        const { envelope } = await loadWorkbenchRequestPreviewStaticEnvelope(c.req.raw, timing);
        const version = `${envelope.focusVersion}:${envelope.boardVersion}`;
        if (requestMatchesVersion(c.req.raw, version)) {
          return { kind: "not_modified" as const, version };
        }
        const model = await loadWorkbenchRequestBoardModel(c.req.raw, timing);
        return { kind: "render" as const, version, expandedRailSections, model };
      },
      (result) => timing.apply(result.kind === "not_modified"
        ? notModifiedResponse(result.version)
        : versionedHtml(
            c.req.raw,
            factoryPreviewFocusIsland({
              shellBase: basePath,
              header: result.model.header,
              workspace: result.model.workspace,
              envelope: result.model.envelope,
              expandedRailSections: result.expandedRailSections,
            }),
            result.version,
          )),
    );
  });

  app.get(`${basePath}/island/timeline`, async (c) => {
    const timing = createServerTimingCollector();
    return wrap(
      async () => {
        const expandedRailSections = readExpandedRailSections(c.req.raw);
        const { envelope } = await loadWorkbenchRequestPreviewChatEnvelope(c.req.raw, timing);
        const version = envelope.chatVersion;
        if (requestMatchesVersion(c.req.raw, version)) {
          return { kind: "not_modified" as const, version };
        }
        const model = await loadWorkbenchRequestChatBodyModel(c.req.raw, timing);
        return { kind: "render" as const, version, expandedRailSections, model };
      },
      (result) => timing.apply(result.kind === "not_modified"
        ? notModifiedResponse(result.version)
        : versionedHtml(
            c.req.raw,
            factoryPreviewTimelineIsland({
              shellBase: basePath,
              workspace: result.model.workspace,
              chat: result.model.chat,
              envelope: result.model.envelope,
              expandedRailSections: result.expandedRailSections,
            }),
            result.version,
          )),
    );
  });

  app.get(`${basePath}/island/drawer/:section`, async (c) => {
    const timing = createServerTimingCollector();
    return wrap(
      async () => {
        const rawSection = c.req.param("section");
        const section = (
          rawSection === "properties"
          || rawSection === "self-improvement"
          || rawSection === "tasks"
          || rawSection === "artifacts"
          || rawSection === "receipts"
          || rawSection === "execution"
        )
          ? rawSection
          : undefined;
        if (!section) throw new Error(`Unknown preview drawer section: ${rawSection}`);
        const expandedRailSections = readExpandedRailSections(c.req.raw);
        const { envelope } = await loadWorkbenchRequestPreviewStaticEnvelope(c.req.raw, timing);
        const version = `${envelope.focusVersion}:${section}`;
        if (requestMatchesVersion(c.req.raw, version)) {
          return { kind: "not_modified" as const, version };
        }
        const model = await loadWorkbenchRequestSelectionModel(c.req.raw, timing);
        return {
          kind: "render" as const,
          version,
          section,
          expandedRailSections,
          model,
        };
      },
      (result) => timing.apply(result.kind === "not_modified"
        ? notModifiedResponse(result.version)
        : versionedHtml(
            c.req.raw,
            factoryPreviewDrawerSectionIsland({
              shellBase: basePath,
              section: result.section as FactoryPreviewDrawerSectionKey,
              workspace: result.model.workspace,
              envelope: result.model.envelope,
              detail: result.model.detail,
              expandedRailSections: result.expandedRailSections,
            }),
            result.version,
          )),
    );
  });

  app.get(
    `${basePath}/live`,
    upgradeWebSocket(async (c) => {
      const body = await readChatEventSubscriptionRequest(c.req.raw);
      const subscriptions = liveSubscriptionsForFactoryChatEvents(body);
      let connection: { readonly close: () => void } | null = null;
      return {
        onOpen(_event, ws) {
          connection = bindBunWebSocketToLiveHub(input.ctx.sse, subscriptions, ws);
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
};
