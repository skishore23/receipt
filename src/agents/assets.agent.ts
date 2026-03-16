import fs from "node:fs";

import type { Hono } from "hono";

import type { AgentLoaderContext, AgentRouteModule } from "../framework/agent-types.js";
import { packagePath, resolveDependencyPath } from "../lib/runtime-paths.js";

const HTMX_PATH = resolveDependencyPath(import.meta.url, "htmx.org/dist/htmx.min.js");
const FACTORY_CSS_PATH = packagePath(import.meta.url, "dist", "assets", "factory.css");

type StaticAsset = {
  readonly path: string;
  readonly contentType: string;
  readonly cache: string;
};

const serveStatic = (asset: StaticAsset): Response => {
  if (!fs.existsSync(asset.path)) {
    return new Response(`asset not found: ${asset.path}`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new Response(fs.readFileSync(asset.path), {
    status: 200,
    headers: { "Content-Type": asset.contentType, "Cache-Control": asset.cache },
  });
};

const createAssetsRoute = (_ctx: AgentLoaderContext): AgentRouteModule => ({
  id: "assets",
  kind: "assets",
  register: (app: Hono) => {
    app.get("/assets/htmx.min.js", () =>
      serveStatic({ path: HTMX_PATH, contentType: "application/javascript; charset=utf-8", cache: "public, max-age=3600" }),
    );
    app.get("/assets/factory.css", () =>
      serveStatic({ path: FACTORY_CSS_PATH, contentType: "text/css; charset=utf-8", cache: "public, max-age=60" }),
    );
  },
});

export default createAssetsRoute;
