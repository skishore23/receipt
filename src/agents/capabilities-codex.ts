import {
  capabilityDefinition,
  capabilityDescriptions,
  capabilityInput,
} from "./capabilities-shared";

export const jobsListCapability = capabilityDefinition({
  id: "jobs.list",
  description: capabilityDescriptions["jobs.list"],
  inputSchema: capabilityInput.jobsList,
});

export const repoStatusCapability = capabilityDefinition({
  id: "repo.status",
  description: capabilityDescriptions["repo.status"],
  inputSchema: capabilityInput.repoStatus,
});

export const codexLogsCapability = capabilityDefinition({
  id: "codex.logs",
  description: capabilityDescriptions["codex.logs"],
  inputSchema: capabilityInput.codexLogs,
});

export const codexStatusCapability = capabilityDefinition({
  id: "codex.status",
  description: capabilityDescriptions["codex.status"],
  inputSchema: capabilityInput.codexStatus,
});

export const codexRunCapability = capabilityDefinition({
  id: "codex.run",
  description: capabilityDescriptions["codex.run"],
  inputSchema: capabilityInput.codexRun,
});

export const jobControlCapability = capabilityDefinition({
  id: "job.control",
  description: capabilityDescriptions["job.control"],
  inputSchema: capabilityInput.jobControl,
});
