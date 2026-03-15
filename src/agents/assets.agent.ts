import fs from "node:fs";
import path from "node:path";

import type { Hono } from "hono";

import type { AgentLoaderContext, AgentRouteModule } from "../framework/agent-types.js";

const HTMX_PATH = path.join(process.cwd(), "node_modules", "htmx.org", "dist", "htmx.min.js");

const createAssetsRoute = (_ctx: AgentLoaderContext): AgentRouteModule => ({
  id: "assets",
  kind: "assets",
  register: (app: Hono) => {
    app.get("/assets/htmx.min.js", () => {
      if (!fs.existsSync(HTMX_PATH)) {
        return new Response("htmx asset not found", {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      return new Response(fs.readFileSync(HTMX_PATH), {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    });
  },
});

export default createAssetsRoute;
