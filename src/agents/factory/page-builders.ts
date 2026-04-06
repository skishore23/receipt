import type { FactoryService } from "../../services/factory-service";
import type { FactoryChatObjectiveNav } from "../../views/factory-models";
import { projectAgentRun } from "./run-projection";
import type { AgentRunChain } from "./shared";
import { deriveObjectiveDisplayState } from "../../views/factory/supervision";

type FactoryObjectiveListItem = Awaited<ReturnType<FactoryService["listObjectives"]>>[number];

export const compareObjectivesByRecency = (
  left: FactoryObjectiveListItem,
  right: FactoryObjectiveListItem,
): number =>
  right.updatedAt - left.updatedAt
  || right.objectiveId.localeCompare(left.objectiveId);

export const toObjectiveNavCard = (
  objective: FactoryObjectiveListItem,
  selectedObjectiveId?: string,
): FactoryChatObjectiveNav => ({
  objectiveId: objective.objectiveId,
  profileId: objective.profile.rootProfileId,
  profileLabel: objective.profile.rootProfileLabel,
  title: objective.title,
  status: objective.status,
  phase: objective.phase,
  displayState: deriveObjectiveDisplayState(objective),
  phaseDetail: objective.phaseDetail,
  statusAuthority: objective.statusAuthority,
  hasAuthoritativeLiveJob: objective.hasAuthoritativeLiveJob,
  blockedReason: objective.blockedReason,
  blockedExplanation: objective.blockedExplanation?.summary,
  summary: objective.latestSummary ?? objective.nextAction,
  updatedAt: objective.updatedAt,
  selected: objective.objectiveId === selectedObjectiveId,
  slotState: objective.scheduler.slotState,
  activeTaskCount: objective.activeTaskCount,
  readyTaskCount: objective.readyTaskCount,
  taskCount: objective.taskCount,
  integrationStatus: objective.integrationStatus,
  tokensUsed: objective.tokensUsed,
});

export const buildObjectiveNavCards = (
  objectives: ReadonlyArray<FactoryObjectiveListItem>,
  selectedObjectiveId?: string,
  options?: {
    readonly includeArchivedSelectedOnly?: boolean;
  },
): ReadonlyArray<FactoryChatObjectiveNav> =>
  [...objectives]
    .filter((objective) =>
      options?.includeArchivedSelectedOnly
        ? !objective.archivedAt || objective.objectiveId === selectedObjectiveId
        : true)
    .sort(compareObjectivesByRecency)
    .map((objective) => toObjectiveNavCard(objective, selectedObjectiveId));

export const collectTerminalRunIds = (
  runIds: ReadonlyArray<string>,
  runChains: ReadonlyArray<AgentRunChain>,
): ReadonlyArray<string> =>
  runIds.filter((_runId, index) => {
    const chain = runChains[index];
    return chain ? projectAgentRun(chain).state.status !== "running" : false;
  });
