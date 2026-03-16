import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type AgentSeed = {
  readonly agentId: string;
  readonly displayName?: string;
  readonly memoryScope?: string;
};

type AgentSeedFile = {
  readonly agents: AgentSeed[];
};

type HubAgent = {
  readonly agentId: string;
  readonly displayName: string;
  readonly memoryScope: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = path.join(ROOT, "config", "hub-agents.json");

const usage = (): never => {
  console.error("usage: bun scripts/hub-onboard.ts [--url http://127.0.0.1:8787] [--file config/hub-agents.json]");
  process.exit(1);
};

const parseArgs = (argv: ReadonlyArray<string>): { readonly url: string; readonly file: string } => {
  let url = process.env.HUB_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8787"}`;
  let file = DEFAULT_CONFIG;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      url = argv[index + 1] ?? usage();
      index += 1;
      continue;
    }
    if (arg === "--file") {
      file = argv[index + 1] ?? usage();
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage();
    usage();
  }
  return {
    url: url.replace(/\/+$/, ""),
    file: path.resolve(ROOT, file),
  };
};

const readConfig = async (file: string): Promise<AgentSeedFile> => {
  const raw = await fs.readFile(file, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected ${file} to contain an object`);
  }
  const agents = (parsed as { agents?: unknown }).agents;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error(`Expected ${file} to contain a non-empty agents array`);
  }
  const normalized = agents.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Agent entry ${index} in ${file} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    const agentId = typeof candidate.agentId === "string" ? candidate.agentId.trim() : "";
    if (!agentId) throw new Error(`Agent entry ${index} in ${file} is missing agentId`);
    const displayName = typeof candidate.displayName === "string" ? candidate.displayName.trim() : undefined;
    const memoryScope = typeof candidate.memoryScope === "string" ? candidate.memoryScope.trim() : undefined;
    return { agentId, displayName, memoryScope };
  });
  return { agents: normalized };
};

const readExistingAgents = async (baseUrl: string): Promise<ReadonlyMap<string, HubAgent>> => {
  const res = await fetch(`${baseUrl}/hub/api/agents`);
  if (!res.ok) {
    throw new Error(`Failed to read existing agents from ${baseUrl}/hub/api/agents: ${res.status} ${await res.text()}`);
  }
  const payload = await res.json() as { agents?: HubAgent[] };
  const out = new Map<string, HubAgent>();
  for (const agent of payload.agents ?? []) {
    out.set(agent.agentId, agent);
  }
  return out;
};

const registerAgent = async (baseUrl: string, agent: AgentSeed): Promise<HubAgent> => {
  const res = await fetch(`${baseUrl}/hub/api/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(agent),
  });
  if (res.status === 201) {
    const payload = await res.json() as { agent: HubAgent };
    return payload.agent;
  }
  if (res.status === 409) {
    const existing = await readExistingAgents(baseUrl);
    const match = existing.get(agent.agentId);
    if (match) return match;
  }
  throw new Error(`Failed to register ${agent.agentId}: ${res.status} ${await res.text()}`);
};

const main = async (): Promise<void> => {
  const { url, file } = parseArgs(process.argv.slice(2));
  const config = await readConfig(file);
  const existing = await readExistingAgents(url);
  let created = 0;
  let skipped = 0;

  for (const agent of config.agents) {
    const seen = existing.get(agent.agentId);
    if (seen) {
      skipped += 1;
      console.log(`exists ${seen.agentId} ${seen.memoryScope}`);
      continue;
    }
    const registered = await registerAgent(url, agent);
    created += 1;
    console.log(`created ${registered.agentId} ${registered.memoryScope}`);
  }

  console.log(`hub onboarding complete: ${created} created, ${skipped} already present`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
