import type { Hono } from "hono";

import { html, json } from "../../../framework/http";
import {
  buildFactoryWorkbenchShellSnapshot,
  factoryWorkbenchBlockIsland,
  factoryWorkbenchChatIsland,
  factoryWorkbenchChatHeaderIsland,
  factoryWorkbenchHeaderIsland,
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

const routeContextForWorkspace = (
  request: FactoryWorkbenchRequestState,
  model: FactoryWorkbenchPageModel["workspace"],
) => ({
  profileId: model.activeProfileId,
  chatId: request.chatId,
  objectiveId: model.objectiveId,
  inspectorTab: normalizedWorkbenchInspectorTab(request.inspectorTab),
  detailTab: model.detailTab,
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
  focusKind: request.focusKind,
  focusId: request.focusId,
  filter: request.filter,
});

export const registerFactoryUiRoutes = (input: {
  readonly app: Hono;
  readonly wrap: RouteWrap;
  readonly loadWorkbenchRequestModel: (req: Request) => Promise<WorkbenchRequestModel>;
  readonly loadWorkbenchRequestHeaderModel: (req: Request) => Promise<WorkbenchRequestHeaderModel>;
  readonly loadWorkbenchRequestWorkspaceModel: (req: Request) => Promise<WorkbenchRequestWorkspaceModel>;
  readonly loadWorkbenchRequestChatModel: (req: Request) => Promise<WorkbenchRequestChatModel>;
}) => {
  const {
    app,
    wrap,
    loadWorkbenchRequestModel,
    loadWorkbenchRequestHeaderModel,
    loadWorkbenchRequestWorkspaceModel,
    loadWorkbenchRequestChatModel,
  } = input;

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
          filter: model.filter,
          focusKind: model.focusKind,
          focusId: model.focusId,
        }),
        "Cache-Control": "no-store",
      },
    }),
  ));

  app.get("/factory/island/workbench/header", async (c) => wrap(
    async () => loadWorkbenchRequestHeaderModel(c.req.raw),
    ({ model }) => html(factoryWorkbenchHeaderIsland(model)),
  ));

  app.get("/factory/island/chat/header", async (c) => wrap(
    async () => loadWorkbenchRequestModel(c.req.raw),
    ({ model }) => html(factoryWorkbenchChatHeaderIsland(model)),
  ));

  app.get("/factory/island/workbench/block", async (c) => wrap(
    async () => ({
      ...(await loadWorkbenchRequestWorkspaceModel(c.req.raw)),
      blockKey: c.req.query("block")?.trim() || "summary",
    }),
    ({ request, model, blockKey }) => html(factoryWorkbenchBlockIsland(
      model,
      routeContextForWorkspace(request, model),
      blockKey,
    )),
  ));

  app.get("/factory/island/workbench", async (c) => wrap(
    async () => loadWorkbenchRequestWorkspaceModel(c.req.raw),
    ({ request, model }) => html(factoryWorkbenchWorkspaceIsland(
      model,
      routeContextForWorkspace(request, model),
    )),
  ));

  app.get("/factory/island/chat", async (c) => wrap(
    async () => loadWorkbenchRequestChatModel(c.req.raw),
    ({ request, model }) => html(factoryWorkbenchChatIsland(
      model,
      routeContextForChat(request, model),
    )),
  ));

  app.get("/factory/api/workbench-shell", async (c) => wrap(
    async () => loadWorkbenchRequestModel(c.req.raw),
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
              focusKind: model.focusKind,
              focusId: model.focusId,
              filter: model.filter,
            }),
          }
        : snapshot);
    },
  ));

  app.get("/factory", async (c) => wrap(
    async () => loadWorkbenchRequestModel(c.req.raw),
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
