import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { packagePath } from "../lib/runtime-paths";
import type { AgentLoaderContext, AgentModule, AgentRouteModule } from "./agent-types";

const exists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const inferAgentsDir = async (): Promise<{ readonly dir: string; readonly suffix: string }> => {
  const srcDir = packagePath(import.meta.url, "src", "agents");
  if (await exists(srcDir)) {
    return { dir: srcDir, suffix: ".agent.ts" };
  }
  throw new Error(`Unable to locate agent source directory at ${srcDir}`);
};

const asRouteModule = (value: unknown): AgentRouteModule | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AgentRouteModule>;
  if (typeof candidate.id !== "string") return undefined;
  if (typeof candidate.register !== "function") return undefined;
  return candidate as AgentRouteModule;
};

const loadFactory = async (file: string): Promise<AgentModule["default"] | undefined> => {
  const mod = await import(pathToFileURL(file).href) as AgentModule;
  if (typeof mod.default === "function") {
    return mod.default;
  }
  if (asRouteModule(mod.default)) {
    return () => asRouteModule(mod.default)!;
  }
  return undefined;
};

export const loadAgentRoutes = async (ctx: AgentLoaderContext): Promise<ReadonlyArray<AgentRouteModule>> => {
  const { dir, suffix } = await inferAgentsDir();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  const modules = (await Promise.all(files.map(loadFactory)))
    .filter((factory): factory is AgentModule["default"] => Boolean(factory));
  const routes = modules.map((factory) => factory(ctx));

  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.id)) {
      throw new Error(`duplicate agent route id '${route.id}'`);
    }
    seen.add(route.id);
  }

  return routes;
};
