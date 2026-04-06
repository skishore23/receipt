import type { Hono } from "hono";

import { html, json } from "../../../framework/http";
import {
  buildFactoryWorkbenchShellSnapshot,
  factoryWorkbenchBlockIsland,
  factoryWorkbenchChatBody,
  factoryWorkbenchChatIsland,
  factoryWorkbenchChatShellResponse,
  factoryWorkbenchChatHeaderIsland,
  factoryWorkbenchFocusIsland,
  factoryWorkbenchHeaderIsland,
  factoryWorkbenchRailIsland,
  factoryWorkbenchSelectionResponse,
  factoryWorkbenchShell,
  factoryWorkbenchWorkspaceIsland,
  type FactoryWorkbenchHeaderIslandModel,
} from "../../../views/factory/workbench/page";
import type { FactoryWorkbenchPageModel } from "../../../views/factory-models";
import { buildWorkbenchLink } from "./navigation";
import {
  normalizedWorkbenchDetailTab,
  normalizedWorkbenchInspectorTab,
  requestedProfileId,
  requestedWorkbenchDetailTab,
  requestedWorkbenchFilter,
} from "./params";
import {
  readWorkbenchRequest,
  shouldRedirectWorkbenchRequest,
  type FactoryWorkbenchRequestState,
} from "./workbench-request";

type RouteWrap = <T>(
  fn: () => Promise<T>,
  render: (value: T) => Response,
) => Promise<Response>;

type WorkbenchRequestModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly model: FactoryWorkbenchPageModel;
};

type WorkbenchRequestHeaderModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly model: FactoryWorkbenchHeaderIslandModel;
};

type WorkbenchRequestWorkspaceModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly model: FactoryWorkbenchPageModel["workspace"];
};

type WorkbenchRequestChatModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly model: FactoryWorkbenchPageModel["chat"];
};

type WorkbenchRequestChatShellModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly workspace: FactoryWorkbenchPageModel["workspace"];
  readonly chat: FactoryWorkbenchPageModel["chat"];
};

type WorkbenchRequestSelectionModel = {
  readonly request: FactoryWorkbenchRequestState;
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchPageModel["workspace"];
  readonly chat: FactoryWorkbenchPageModel["chat"];
};

type ServerTimingCollector = {
  readonly measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
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

const routeContextForWorkspace = (
  request: FactoryWorkbenchRequestState,
  model: FactoryWorkbenchPageModel["workspace"],
) => ({
  profileId: model.activeProfileId,
  chatId: model.chatId,
  objectiveId: model.objectiveId,
  inspectorTab: normalizedWorkbenchInspectorTab(request.inspectorTab),
  detailTab: model.detailTab,
  page: model.page,
  focusKind: model.focusKind,
  focusId: model.focusId,
  filter: model.filter,
});

const routeContextForChat = (
  request: FactoryWorkbenchRequestState,
  model: FactoryWorkbenchPageModel["chat"],
) => ({
  profileId: model.activeProfileId,
  chatId: model.chatId ?? request.chatId,
  objectiveId: model.objectiveId,
  inspectorTab: normalizedWorkbenchInspectorTab(request.inspectorTab),
  detailTab: normalizedWorkbenchDetailTab(request.detailTab, Boolean(model.objectiveId)),
  page: request.page,
  focusKind: request.focusKind,
  focusId: request.focusId,
  filter: request.filter,
});

export const registerFactoryUiRoutes = (input: {
  readonly app: Hono;
  readonly wrap: RouteWrap;
  readonly loadWorkbenchRequestModel: (req: Request, timing?: ServerTimingCollector) => Promise<WorkbenchRequestModel>;
  readonly loadWorkbenchRequestHeaderModel: (req: Request, timing?: ServerTimingCollector) => Promise<WorkbenchRequestHeaderModel>;
  readonly loadWorkbenchRequestWorkspaceModel: (req: Request, timing?: ServerTimingCollector) => Promise<WorkbenchRequestWorkspaceModel>;
  readonly loadWorkbenchRequestChatModel: (req: Request, timing?: ServerTimingCollector) => Promise<WorkbenchRequestChatModel>;
  readonly loadWorkbenchRequestChatShellModel: (req: Request, timing?: ServerTimingCollector) => Promise<WorkbenchRequestChatShellModel>;
  readonly loadWorkbenchRequestSelectionModel: (req: Request, timing?: ServerTimingCollector) => Promise<WorkbenchRequestSelectionModel>;
}) => {
  const {
    app,
    wrap,
    loadWorkbenchRequestModel,
    loadWorkbenchRequestHeaderModel,
    loadWorkbenchRequestWorkspaceModel,
    loadWorkbenchRequestChatModel,
    loadWorkbenchRequestChatShellModel,
    loadWorkbenchRequestSelectionModel,
  } = input;

  const withTiming = <T>(
    load: (timing: ServerTimingCollector) => Promise<T>,
    render: (value: T) => Response,
  ) => wrap(
    async () => {
      const timing = createServerTimingCollector();
      const value = await load(timing);
      return { timing, value };
    },
    ({ timing, value }) => timing.apply(render(value)),
  );

  app.get("/factory/control", async (c) => {
    const url = new URL(c.req.raw.url);
    return new Response(null, {
      status: 303,
      headers: {
        Location: `/factory${url.search}`,
        "Cache-Control": "no-store",
      },
    });
  });

  app.get("/factory/workbench", async (c) => wrap(
    async () => loadWorkbenchRequestModel(c.req.raw),
    ({ model }) => new Response(null, {
      status: 303,
      headers: {
        Location: buildWorkbenchLink({
          profileId: model.activeProfileId,
          chatId: model.chatId,
          objectiveId: model.objectiveId,
          inspectorTab: model.inspectorTab,
          detailTab: model.detailTab,
          page: model.page,
          filter: model.filter,
          focusKind: model.focusKind,
          focusId: model.focusId,
        }),
        "Cache-Control": "no-store",
      },
    }),
  ));

  app.get("/factory/island/workbench/header", async (c) => withTiming(
    (timing) => loadWorkbenchRequestHeaderModel(c.req.raw, timing),
    ({ model }) => html(factoryWorkbenchHeaderIsland(model)),
  ));

  app.get("/factory/island/chat/header", async (c) => withTiming(
    (timing) => loadWorkbenchRequestModel(c.req.raw, timing),
    ({ model }) => html(factoryWorkbenchChatHeaderIsland(model)),
  ));

  app.get("/factory/island/workbench/block", async (c) => withTiming(
    async (timing) => ({
      ...(await loadWorkbenchRequestWorkspaceModel(c.req.raw, timing)),
      blockKey: c.req.query("block")?.trim() || "summary",
    }),
    ({ request, model, blockKey }) => html(factoryWorkbenchBlockIsland(
      model,
      routeContextForWorkspace(request, model),
      blockKey,
    )),
  ));

  app.get("/factory/island/workbench", async (c) => withTiming(
    (timing) => loadWorkbenchRequestWorkspaceModel(c.req.raw, timing),
    ({ request, model }) => html(factoryWorkbenchWorkspaceIsland(
      model,
      routeContextForWorkspace(request, model),
    )),
  ));

  app.get("/factory/island/workbench/focus", async (c) => withTiming(
    (timing) => loadWorkbenchRequestWorkspaceModel(c.req.raw, timing),
    ({ request, model }) => html(factoryWorkbenchFocusIsland(
      model,
      routeContextForWorkspace(request, model),
    )),
  ));

  app.get("/factory/island/workbench/rail", async (c) => withTiming(
    (timing) => loadWorkbenchRequestWorkspaceModel(c.req.raw, timing),
    ({ request, model }) => html(factoryWorkbenchRailIsland(
      model,
      routeContextForWorkspace(request, model),
    )),
  ));

  app.get("/factory/island/chat", async (c) => withTiming(
    (timing) => loadWorkbenchRequestChatModel(c.req.raw, timing),
    ({ request, model }) => html(factoryWorkbenchChatIsland(
      model,
      routeContextForChat(request, model),
    )),
  ));

  app.get("/factory/island/workbench/chat-shell", async (c) => withTiming(
    (timing) => loadWorkbenchRequestChatShellModel(c.req.raw, timing),
    ({ request, workspace, chat }) => html(factoryWorkbenchChatShellResponse(
      workspace,
      chat,
      routeContextForWorkspace(request, workspace),
    )),
  ));

  app.get("/factory/island/workbench/chat-body", async (c) => withTiming(
    (timing) => loadWorkbenchRequestChatShellModel(c.req.raw, timing),
    ({ request, workspace, chat }) => html(factoryWorkbenchChatBody(
      workspace,
      chat,
      routeContextForWorkspace(request, workspace),
    )),
  ));

  app.get("/factory/island/workbench/select", async (c) => withTiming(
    (timing) => loadWorkbenchRequestSelectionModel(c.req.raw, timing),
    ({ request, header, workspace, chat }) => html(factoryWorkbenchSelectionResponse({
      header,
      workspace,
      chat,
      routeContext: routeContextForWorkspace(request, workspace),
    })),
  ));

  app.get("/factory/api/workbench-shell", async (c) => withTiming(
    (timing) => loadWorkbenchRequestModel(c.req.raw, timing),
    ({ request, model }) => {
      const snapshot = buildFactoryWorkbenchShellSnapshot(model);
      return json(200, shouldRedirectWorkbenchRequest(request, model)
        ? {
            ...snapshot,
            location: buildWorkbenchLink({
              profileId: model.activeProfileId,
              chatId: model.chatId,
              objectiveId: model.objectiveId,
              inspectorTab: model.inspectorTab,
              detailTab: model.detailTab,
              page: model.page,
              focusKind: model.focusKind,
              focusId: model.focusId,
              filter: model.filter,
            }),
          }
        : snapshot);
    },
  ));

  app.get("/factory", async (c) => withTiming(
    (timing) => loadWorkbenchRequestModel(c.req.raw, timing),
    ({ request, model }) => {
      if (shouldRedirectWorkbenchRequest(request, model)) {
        return new Response(null, {
          status: 303,
          headers: {
            Location: buildWorkbenchLink({
              profileId: model.activeProfileId,
              chatId: model.chatId,
              objectiveId: model.objectiveId,
              inspectorTab: model.inspectorTab,
              detailTab: model.detailTab,
              page: model.page,
              focusKind: model.focusKind,
              focusId: model.focusId,
              filter: model.filter,
            }),
            "Cache-Control": "no-store",
          },
        });
      }
      return html(factoryWorkbenchShell(model));
    },
  ));

  app.get("/factory/new-chat", async (c) => wrap(
    async () => buildWorkbenchLink({
      profileId: requestedProfileId(c.req.raw) ?? "generalist",
      chatId: readWorkbenchRequest(c.req.raw).chatId,
      inspectorTab: "chat",
      detailTab: requestedWorkbenchDetailTab(c.req.raw) ?? "queue",
      filter: requestedWorkbenchFilter(c.req.raw),
    }),
    (location) => new Response(null, {
      status: 303,
      headers: {
        Location: location,
        "Cache-Control": "no-store",
      },
    }),
  ));
};
