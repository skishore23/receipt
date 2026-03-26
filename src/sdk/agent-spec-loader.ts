import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { packagePath } from "../lib/runtime-paths";
import type { ModernAgentSpec } from "./agent";

const candidateAgentPath = (agentId: string): string =>
  path.join(packagePath(import.meta.url, "src", "agents"), `${agentId}.agent.ts`);

const isAgentSpec = (value: unknown): value is ModernAgentSpec<any, any, Record<string, unknown>> => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.version === "string"
    && typeof candidate.view === "function"
    && typeof candidate.actions === "function"
    && typeof candidate.goal === "function"
    && Boolean(candidate.receipts)
    && typeof candidate.receipts === "object";
};

export const loadDefinedAgentSpec = async (agentId: string): Promise<ModernAgentSpec<any, any, Record<string, unknown>> | undefined> => {
  const filePath = candidateAgentPath(agentId);
  if (!fs.existsSync(filePath)) return undefined;
  const mod = await import(pathToFileURL(filePath).href);
  return isAgentSpec(mod.default) ? mod.default : undefined;
};
