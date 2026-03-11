export const MONITOR_AGENT_IDS = [
  "agent",
  "theorem",
  "axiom-guild",
  "axiom-simple",
  "axiom",
  "writer",
  "inspector",
] as const;

const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  theorem: "Theorem Guild",
  "axiom-guild": "Proof Guild",
  "axiom-simple": "Axiom Simple",
  axiom: "Lean Worker",
  agent: "General Agent",
  writer: "Writer",
  inspector: "Receipt Inspector",
};

const titleCaseWord = (value: string): string =>
  value.length <= 1 ? value.toUpperCase() : `${value[0]?.toUpperCase() ?? ""}${value.slice(1).toLowerCase()}`;

const prettifyAgentId = (agentId: string): string =>
  agentId
    .split(/[._-]+/g)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");

export const getAgentDisplayName = (agentId?: string, agentName?: string): string => {
  const explicit = typeof agentName === "string" ? agentName.trim() : "";
  if (explicit) return explicit;
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id) return "Unknown Agent";
  return AGENT_DISPLAY_NAMES[id] ?? prettifyAgentId(id);
};

export const getAgentDisplayMeta = (agentId?: string, agentName?: string): {
  readonly label: string;
  readonly rawId?: string;
} => {
  const rawId = typeof agentId === "string" && agentId.trim().length > 0 ? agentId.trim() : undefined;
  const label = getAgentDisplayName(rawId, agentName);
  return {
    label,
    ...(rawId && rawId !== label ? { rawId } : {}),
  };
};
