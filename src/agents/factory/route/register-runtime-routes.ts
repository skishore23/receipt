import type { Hono } from "hono";

import { html } from "../../../framework/http";
import { runtimeDashboardIsland, runtimeShell, type RuntimeDashboardModel } from "../../../views/runtime";

type RouteWrap = <T>(
  fn: () => Promise<T>,
  render: (value: T) => Response,
) => Promise<Response>;

export const registerRuntimeRoutes = (input: {
  readonly app: Hono;
  readonly wrap: RouteWrap;
  readonly loadRuntimeDashboard: () => Promise<RuntimeDashboardModel>;
}) => {
  const { app, wrap, loadRuntimeDashboard } = input;

  app.get("/runtime", async () => wrap(
    () => loadRuntimeDashboard(),
    (model) => html(runtimeShell({
      dashboardHtml: runtimeDashboardIsland(model),
    })),
  ));

  app.get("/runtime/island", async () => wrap(
    () => loadRuntimeDashboard(),
    (model) => html(runtimeDashboardIsland(model)),
  ));
};
