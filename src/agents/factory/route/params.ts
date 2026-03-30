import { optionalTrimmedString } from "../../../framework/http";
import { inferObjectiveProfileHint } from "../../../factory-cli/composer";
import { DEFAULT_FACTORY_WORKBENCH_FILTER, type FactoryInspectorPanel, type FactoryInspectorTab, type FactoryViewMode, type FactoryWorkbenchDetailTab, type FactoryWorkbenchFilterKey } from "../../../views/factory-models";
import type { FactoryChatProfile } from "../../../services/factory-chat-profiles";

export const isInspectorPanel = (value: string | undefined): value is FactoryInspectorPanel =>
  value === "overview"
  || value === "analysis"
  || value === "execution"
  || value === "live"
  || value === "receipts";

export const isInspectorTab = (value: string | undefined): value is FactoryInspectorTab =>
  value === "overview" || value === "chat" || value === "notes";

export const isFactoryViewMode = (value: string | undefined): value is FactoryViewMode =>
  value === "default" || value === "mission-control";

export const isWorkbenchFilterKey = (value: string | undefined): value is FactoryWorkbenchFilterKey =>
  value === "objective.running"
  || value === "objective.needs_attention"
  || value === "objective.queued"
  || value === "objective.completed";

export const isTerminalObjectiveStatus = (status: unknown): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

export const objectiveProfileIdForPrompt = (input: {
  readonly prompt: string;
  readonly resolvedProfile: FactoryChatProfile;
  readonly profiles: ReadonlyArray<FactoryChatProfile>;
}): string => {
  if (input.resolvedProfile.id !== "generalist") return input.resolvedProfile.id;
  const hintedProfileId = inferObjectiveProfileHint(input.prompt);
  if (!hintedProfileId) return input.resolvedProfile.id;
  const hintedProfile = input.profiles.find((profile) => profile.id === hintedProfileId);
  return hintedProfile?.id ?? input.resolvedProfile.id;
};

export const makeFactoryRunId = (): string =>
  `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const makeFactoryChatId = (): string =>
  `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const requestedObjectiveId = (req: Request): string | undefined =>
  optionalTrimmedString(new URL(req.url).searchParams.get("objective"));

export const requestedChatId = (req: Request): string | undefined =>
  optionalTrimmedString(new URL(req.url).searchParams.get("chat"));

export const requestedProfileId = (req: Request): string | undefined =>
  optionalTrimmedString(new URL(req.url).searchParams.get("profile"));

export const requestedRunId = (req: Request): string | undefined =>
  optionalTrimmedString(new URL(req.url).searchParams.get("run"));

export const requestedJobId = (req: Request): string | undefined =>
  optionalTrimmedString(new URL(req.url).searchParams.get("job"));

export const requestedFocusId = (req: Request): string | undefined =>
  optionalTrimmedString(new URL(req.url).searchParams.get("focusId"));

export const requestedPanel = (req: Request): FactoryInspectorPanel => {
  const panel = optionalTrimmedString(new URL(req.url).searchParams.get("panel"));
  return isInspectorPanel(panel) ? panel : "overview";
};

export const requestedMode = (req: Request): FactoryViewMode => {
  const mode = optionalTrimmedString(new URL(req.url).searchParams.get("mode"));
  return isFactoryViewMode(mode) ? mode : "default";
};

export const requestedPanelParam = (req: Request): FactoryInspectorPanel | undefined => {
  const panel = optionalTrimmedString(new URL(req.url).searchParams.get("panel"));
  return isInspectorPanel(panel) ? panel : undefined;
};

export const requestedShowAll = (req: Request): boolean =>
  optionalTrimmedString(new URL(req.url).searchParams.get("all")) === "1";

export const requestedInspectorTab = (req: Request): FactoryInspectorTab | undefined => {
  const inspectorTab = optionalTrimmedString(new URL(req.url).searchParams.get("inspectorTab"));
  return isInspectorTab(inspectorTab) ? inspectorTab : undefined;
};

export const normalizedDefaultInspectorTab = (value?: FactoryInspectorTab): FactoryInspectorTab =>
  value === "notes" ? "notes" : "overview";

export const normalizedWorkbenchInspectorTab = (value?: FactoryInspectorTab): FactoryInspectorTab =>
  value === "chat" ? "chat" : "overview";

export const requestedFocusKind = (req: Request): string | undefined =>
  optionalTrimmedString(new URL(req.url).searchParams.get("focusKind"));

export const requestedWorkbenchFilter = (req: Request): FactoryWorkbenchFilterKey => {
  const filter = optionalTrimmedString(new URL(req.url).searchParams.get("filter"));
  if (filter === "all") return DEFAULT_FACTORY_WORKBENCH_FILTER;
  return isWorkbenchFilterKey(filter) ? filter : DEFAULT_FACTORY_WORKBENCH_FILTER;
};

export const requestedWorkbenchDetailTab = (req: Request): FactoryWorkbenchDetailTab | undefined => {
  const detailTab = optionalTrimmedString(new URL(req.url).searchParams.get("detailTab"));
  return detailTab === "review" || detailTab === "queue" || detailTab === "action"
    ? detailTab
    : undefined;
};

export const normalizedWorkbenchDetailTab = (
  value: FactoryWorkbenchDetailTab | undefined,
  hasSelectedObjective: boolean,
): FactoryWorkbenchDetailTab => {
  if (value === "review" || value === "queue" || value === "action") return value;
  return hasSelectedObjective ? "action" : "queue";
};

export const normalizeFocusKind = (value: string | undefined): "task" | "job" | undefined =>
  value === "task" || value === "job" ? value : undefined;
