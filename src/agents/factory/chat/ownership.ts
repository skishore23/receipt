type FactoryChatAutoHandoffDecision = {
  readonly targetProfileId: string;
  readonly reason: string;
  readonly goal: string;
  readonly currentState: string;
  readonly doneWhen: string;
};

type FactoryChatAutoDispatchDecision = {
  readonly prompt: string;
  readonly objectiveMode: "investigation";
  readonly reason: string;
};

const normalizeProblem = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const titleCaseFirst = (value: string): string =>
  value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;

const trimTrailingPunctuation = (value: string): string =>
  value.replace(/[.?!\s]+$/g, "").trim();

const countMatches = (text: string, patterns: ReadonlyArray<RegExp>): number =>
  patterns.reduce((total, pattern) => total + (pattern.test(text) ? 1 : 0), 0);

const INFRA_STRONG = [
  /\baws\b/i,
  /\bec2\b/i,
  /\bs3\b/i,
  /\brds\b/i,
  /\biam\b/i,
  /\bsts\b/i,
  /\bvpc\b/i,
  /\bsubnet\b/i,
  /\bsecurity group\b/i,
  /\bcloudwatch\b/i,
  /\beventbridge\b/i,
  /\bautoscaling\b/i,
  /\bcloudfront\b/i,
  /\blambda\b/i,
  /\broute\s*53\b/i,
  /\borganizations?\b/i,
  /\beks\b/i,
  /\becs\b/i,
  /\becr\b/i,
  /\bssm\b/i,
  /\bdescribe-instances\b/i,
] as const;

const INFRA_MEDIUM = [
  /\bregion\b/i,
  /\binstance(s)?\b/i,
  /\baccount(s)?\b/i,
  /\bfleet\b/i,
  /\bcluster\b/i,
  /\bcost\b/i,
  /\bbilling\b/i,
] as const;

const SOFTWARE_STRONG = [
  /\bfix\b/i,
  /\bbug\b/i,
  /\bimplement\b/i,
  /\brefactor\b/i,
  /\brename\b/i,
  /\bbuild failing\b/i,
  /\bcompile\b/i,
  /\btest(s)? failing\b/i,
  /\bui\b/i,
  /\bfrontend\b/i,
  /\bbackend\b/i,
  /\bcomponent\b/i,
  /\bendpoint\b/i,
  /\btypescript\b/i,
  /\bjavascript\b/i,
  /\breact\b/i,
  /\bcss\b/i,
] as const;

const QA_STRONG = [
  /\bqa\b/i,
  /\bregression\b/i,
  /\bsmoke test\b/i,
  /\bacceptance\b/i,
  /\bready\b/i,
  /\breadiness\b/i,
  /\breview\b/i,
  /\bverify\b/i,
  /\bvalidation\b/i,
] as const;

const selectAutoHandoffTarget = (
  problem: string,
  handoffTargets: ReadonlyArray<string>,
): string | undefined => {
  const normalized = normalizeProblem(problem);
  if (!normalized) return undefined;
  const infraScore = countMatches(normalized, INFRA_STRONG) * 2 + countMatches(normalized, INFRA_MEDIUM);
  const softwareScore = countMatches(normalized, SOFTWARE_STRONG) * 2;
  const qaScore = countMatches(normalized, QA_STRONG) * 2;
  const scores = [
    { profileId: "infrastructure", score: infraScore },
    { profileId: "software", score: softwareScore },
    { profileId: "qa", score: qaScore },
  ].filter((entry) => handoffTargets.includes(entry.profileId));
  const best = scores.sort((left, right) => right.score - left.score)[0];
  if (!best || best.score < 2) return undefined;
  return best.profileId;
};

export const decideFactoryChatAutoHandoff = (input: {
  readonly currentProfileId: string;
  readonly handoffTargets: ReadonlyArray<string>;
  readonly problem: string;
  readonly responseStyle: "conversational" | "work";
  readonly hasBoundObjective: boolean;
}): FactoryChatAutoHandoffDecision | undefined => {
  if (input.currentProfileId !== "generalist") return undefined;
  if (input.responseStyle !== "work") return undefined;
  if (input.hasBoundObjective) return undefined;
  const targetProfileId = selectAutoHandoffTarget(input.problem, input.handoffTargets);
  if (!targetProfileId) return undefined;
  const goalText = trimTrailingPunctuation(normalizeProblem(input.problem));
  const goal = goalText ? titleCaseFirst(goalText) : "Take ownership of the user's request";
  switch (targetProfileId) {
    case "infrastructure":
      return {
        targetProfileId,
        reason: "This is clearly AWS or cloud investigation work, which infrastructure should own.",
        goal,
        currentState: "The Tech Lead received an infrastructure-specific request in chat and should hand it to infrastructure before answering from general knowledge.",
        doneWhen: "Infrastructure owns the next turn and can answer with concrete findings or start tracked investigation work if needed.",
      };
    case "software":
      return {
        targetProfileId,
        reason: "This is clearly software delivery or debugging work, which software should own.",
        goal,
        currentState: "The Tech Lead received a software-specific request in chat and should hand it to software before giving generic implementation advice.",
        doneWhen: "Software owns the next turn and can inspect the repo or start tracked delivery work if needed.",
      };
    case "qa":
      return {
        targetProfileId,
        reason: "This is clearly QA, validation, or readiness work, which QA should own.",
        goal,
        currentState: "The Tech Lead received a QA-specific request in chat and should hand it to QA before answering with generic review advice.",
        doneWhen: "QA owns the next turn and can assess readiness, regression risk, and the required validation work.",
      };
    default:
      return undefined;
  }
};

export const decideFactoryChatAutoDispatch = (input: {
  readonly currentProfileId: string;
  readonly problem: string;
  readonly responseStyle: "conversational" | "work";
  readonly hasBoundObjective: boolean;
}): FactoryChatAutoDispatchDecision | undefined => {
  if (input.currentProfileId !== "infrastructure") return undefined;
  if (input.responseStyle !== "work") return undefined;
  if (input.hasBoundObjective) return undefined;
  const prompt = normalizeProblem(input.problem);
  if (!prompt) return undefined;
  return {
    prompt,
    objectiveMode: "investigation",
    reason: "Infrastructure profile starts substantive AWS/cloud requests in tracked investigation objectives.",
  };
};
