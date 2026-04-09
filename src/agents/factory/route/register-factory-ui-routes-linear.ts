import type { Hono } from "hono";

import { html, json } from "../../../framework/http";
import {
  buildFactoryWorkbenchShellSnapshot,
  type FactoryWorkbenchHeaderIslandModel,
  type FactoryWorkbenchRouteContext,
} from "../../../views/factory/workbench/page";
import {
  factoryWorkbenchLinearBackgroundRootResponse,
  factoryWorkbenchLinearBlockIsland,
  factoryWorkbenchLinearChatBody,
  factoryWorkbenchLinearChatIsland,
  factoryWorkbenchLinearChatPaneIsland,
  factoryWorkbenchLinearChatShellResponse,
  factoryWorkbenchLinearFocusIsland,
  factoryWorkbenchLinearRailIsland,
  factoryWorkbenchLinearSelectionResponse,
  factoryWorkbenchLinearShell,
  factoryWorkbenchLinearWorkspaceIsland,
} from "../../../views/factory/workbench/page-linear";
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
): FactoryWorkbenchRouteContext => ({
  shellBase: request.shellBase,
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
): FactoryWorkbenchRouteContext => ({
  shellBase: request.shellBase,
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

export const registerFactoryLinearUiRoutes = (input: {
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
  const basePath: "/factory-new" = "/factory-new";

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

  const isHtmxRequest = (req: Request): boolean =>
    req.headers.get("HX-Request") === "true";

  const redirectToShell = (req: Request): Response => {
    const url = new URL(req.url);
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${basePath}${url.search}`,
        "Cache-Control": "no-store",
      },
    });
  };

  app.use(`${basePath}/island/*`, async (c, next): Promise<void | Response> => {
    if (!isHtmxRequest(c.req.raw)) return redirectToShell(c.req.raw);
    await next();
    c.header("Vary", "HX-Request");
  });

  app.get(basePath, async (c) => withTiming(
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
              basePath,
            }),
            "Cache-Control": "no-store",
          },
        });
      }
      return html(factoryWorkbenchLinearShell(model, basePath));
    },
  ));

  app.get(`${basePath}/workbench`, async (c) => wrap(
    async () => loadWorkbenchRequestModel(c.req.raw),
    ({ request, model }) => new Response(null, {
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
          basePath: request.shellBase,
        }),
        "Cache-Control": "no-store",
      },
    }),
  ));

  app.get(`${basePath}/api/workbench-shell`, async (c) => withTiming(
    (timing) => loadWorkbenchRequestModel(c.req.raw, timing),
    ({ request, model }) => {
      const snapshot = buildFactoryWorkbenchShellSnapshot(model, request.shellBase);
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
              basePath: request.shellBase,
            }),
          }
        : snapshot);
    },
  ));

  app.get(`${basePath}/island/workbench/background-root`, async (c) => withTiming(
    async (timing) => {
      const [headerResult, workspaceResult] = await Promise.all([
        loadWorkbenchRequestHeaderModel(c.req.raw, timing),
        loadWorkbenchRequestWorkspaceModel(c.req.raw, timing),
      ]);
      return {
        request: workspaceResult.request,
        header: headerResult.model,
        workspace: workspaceResult.model,
      };
    },
    ({ request, header, workspace }) => html(factoryWorkbenchLinearBackgroundRootResponse({
      header,
      workspace,
      routeContext: routeContextForWorkspace(request, workspace),
    })),
  ));

  app.get(`${basePath}/island/workbench`, async (c) => withTiming(
    (timing) => loadWorkbenchRequestWorkspaceModel(c.req.raw, timing),
    ({ request, model }) => html(factoryWorkbenchLinearWorkspaceIsland(
      model,
      routeContextForWorkspace(request, model),
    )),
  ));

  app.get(`${basePath}/island/workbench/focus`, async (c) => withTiming(
    (timing) => loadWorkbenchRequestWorkspaceModel(c.req.raw, timing),
    ({ request, model }) => html(factoryWorkbenchLinearFocusIsland(
      model,
      routeContextForWorkspace(request, model),
    )),
  ));

  app.get(`${basePath}/island/workbench/rail`, async (c) => withTiming(
    (timing) => loadWorkbenchRequestWorkspaceModel(c.req.raw, timing),
    ({ request, model }) => html(factoryWorkbenchLinearRailIsland(
      model,
      routeContextForWorkspace(request, model),
    )),
  ));

  app.get(`${basePath}/island/workbench/block`, async (c) => withTiming(
    async (timing) => ({
      ...(await loadWorkbenchRequestWorkspaceModel(c.req.raw, timing)),
      blockKey: c.req.query("block")?.trim() || "summary",
    }),
    ({ request, model, blockKey }) => html(factoryWorkbenchLinearBlockIsland(
      model,
      routeContextForWorkspace(request, model),
      blockKey,
    )),
  ));

  app.get(`${basePath}/island/chat`, async (c) => withTiming(
    (timing) => loadWorkbenchRequestChatModel(c.req.raw, timing),
    ({ request, model }) => html(factoryWorkbenchLinearChatIsland(
      model,
      routeContextForChat(request, model),
    )),
  ));

  app.get(`${basePath}/island/workbench/chat-shell`, async (c) => withTiming(
    (timing) => loadWorkbenchRequestChatShellModel(c.req.raw, timing),
    ({ request, workspace, chat }) => html(factoryWorkbenchLinearChatShellResponse(
      workspace,
      chat,
      routeContextForWorkspace(request, workspace),
    )),
  ));

  app.get(`${basePath}/island/workbench/chat-pane`, async (c) => withTiming(
    (timing) => loadWorkbenchRequestChatShellModel(c.req.raw, timing),
    ({ request, workspace, chat }) => html(factoryWorkbenchLinearChatPaneIsland(
      workspace,
      chat,
      routeContextForWorkspace(request, workspace),
    )),
  ));

  app.get(`${basePath}/island/workbench/chat-body`, async (c) => withTiming(
    (timing) => loadWorkbenchRequestChatShellModel(c.req.raw, timing),
    ({ request, chat, workspace }) => html(factoryWorkbenchLinearChatBody(
      chat,
      routeContextForWorkspace(request, workspace),
    )),
  ));

  app.get(`${basePath}/island/workbench/select`, async (c) => withTiming(
    (timing) => loadWorkbenchRequestSelectionModel(c.req.raw, timing),
    ({ request, header, workspace, chat }) => html(factoryWorkbenchLinearSelectionResponse({
      header,
      workspace,
      chat,
      routeContext: routeContextForWorkspace(request, workspace),
    })),
  ));

  app.get(`${basePath}/new-chat`, async (c) => wrap(
    async () => {
      const request = readWorkbenchRequest(c.req.raw);
      return buildWorkbenchLink({
        profileId: requestedProfileId(c.req.raw) ?? "generalist",
        chatId: request.chatId,
        inspectorTab: "chat",
        detailTab: requestedWorkbenchDetailTab(c.req.raw) ?? "queue",
        filter: requestedWorkbenchFilter(c.req.raw),
        basePath: request.shellBase,
      });
    },
    (location) => new Response(null, {
      status: 303,
      headers: {
        Location: location,
        "Cache-Control": "no-store",
      },
    }),
  ));
};
