export const MONITOR_AGENT_IDS = [
  "factory",
] as const;

const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  factory: "Orchestrator",
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
