import type { FactoryService } from "../../services/factory-service";
import type { FactoryChatObjectiveNav } from "../../views/factory-models";
import { projectAgentRun } from "./run-projection";
import type { AgentRunChain } from "./shared";

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
  runIds.filter((runId, index) => {
    const chain = runChains[index];
    return chain ? projectAgentRun(chain).state.status !== "running" : false;
  });

const CONVERSATIONAL_PROMPT_RE =
  /^(?:hi|hello|hey|yo|sup|what's up|how are you(?: doing)?|who are you|what are you|what can you do|thanks|thank you|good (?:morning|afternoon|evening)|good night|ok(?:ay)?|cool|nice)\b[\s?!.,'"]*$/i;

const DELIVERY_SIGNAL_RE =
  /\b(?:fix|implement|change|update|edit|refactor|debug|investigate|analyze|review|check|build|test|file|code|repo|branch|commit|diff|task|objective|thread|deploy|aws|ec2|s3|lambda|bug|error|failure|ci|pr)\b/i;

export const looksLikeConversationalPrompt = (prompt: string): boolean => {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact || compact.length > 120) return false;
  if (DELIVERY_SIGNAL_RE.test(compact)) return false;
  return CONVERSATIONAL_PROMPT_RE.test(compact);
};
