import type { Hono } from "hono";

import type { AgentRegistry } from "./registry.js";

export const compileRoutes = (app: Hono, registry: AgentRegistry): void => {
  registry.manifests.forEach((manifest) => {
    manifest.register(app);
  });
};
