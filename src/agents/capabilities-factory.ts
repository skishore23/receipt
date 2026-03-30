import {
  capabilityDefinition,
  capabilityDescriptions,
  capabilityInput,
} from "./capabilities-shared";

export const factoryDispatchCapability = capabilityDefinition({
  id: "factory.dispatch",
  description: capabilityDescriptions["factory.dispatch"],
  inputSchema: capabilityInput.factoryDispatch,
});

export const factoryStatusCapability = capabilityDefinition({
  id: "factory.status",
  description: capabilityDescriptions["factory.status"],
  inputSchema: capabilityInput.factoryStatus,
});

export const factoryOutputCapability = capabilityDefinition({
  id: "factory.output",
  description: capabilityDescriptions["factory.output"],
  inputSchema: capabilityInput.factoryOutput,
});

export const factoryReceiptsCapability = capabilityDefinition({
  id: "factory.receipts",
  description: capabilityDescriptions["factory.receipts"],
  inputSchema: capabilityInput.factoryReceipts,
});

export const profileHandoffCapability = capabilityDefinition({
  id: "profile.handoff",
  description: capabilityDescriptions["profile.handoff"],
  inputSchema: capabilityInput.profileHandoff,
});
