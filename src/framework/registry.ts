import type { AgentManifest } from "./manifest.js";

export type AgentRegistry = {
  readonly manifests: ReadonlyArray<AgentManifest>;
  readonly byId: (id: string) => AgentManifest | undefined;
};

export const createAgentRegistry = (manifests: ReadonlyArray<AgentManifest>): AgentRegistry => {
  const table = new Map<string, AgentManifest>();
  manifests.forEach((manifest) => {
    if (table.has(manifest.id)) {
      throw new Error(`duplicate agent manifest id: ${manifest.id}`);
    }
    table.set(manifest.id, manifest);
  });

  return {
    manifests,
    byId: (id) => table.get(id),
  };
};
