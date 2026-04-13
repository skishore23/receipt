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

type FactoryChatBoundObjectiveDispatchDecision = {
  readonly action: "create" | "react";
  readonly prompt?: string;
  readonly note?: string;
  readonly reason: string;
};

const normalizeProblem = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const STATUS_OR_META = [
  /\bstatus\b/i,
  /\bprogress\b/i,
  /\bupdate\b/i,
  /\bwhat happened\b/i,
  /\bwhat's happening\b/i,
  /\bhow('?s| is) it going\b/i,
  /\bis it done\b/i,
  /\bdid it finish\b/i,
  /\bcurrent state\b/i,
  /\blatest state\b/i,
  /\bmonitor(ing)?\b/i,
  /\bwatch(ing)?\b/i,
  /\bwait(ing)?\b/i,
] as const;

const SEPARATE_OBJECTIVE = [
  /\bnew objective\b/i,
  /\bseparate objective\b/i,
  /\bdifferent objective\b/i,
  /\bseparately\b/i,
  /\bin parallel\b/i,
  /\bunrelated\b/i,
] as const;

const CONTROL_INTENT = [
  /\bpromote\b/i,
  /\bcancel\b/i,
  /\barchive\b/i,
  /\bcleanup\b/i,
  /\bcurrent thread\b/i,
  /\bthread objective\b/i,
] as const;

const FOLLOW_UP_WORK = [
  /\badd\b/i,
  /\banaly[sz]e\b/i,
  /\bcollect\b/i,
  /\bdebug\b/i,
  /\bfix\b/i,
  /\bgather\b/i,
  /\bimplement\b/i,
  /\binclude\b/i,
  /\binvestigate\b/i,
  /\brefactor\b/i,
  /\breview\b/i,
  /\brerun\b/i,
  /\bretry\b/i,
  /\bresume\b/i,
  /\bship\b/i,
  /\btest\b/i,
  /\btrace\b/i,
  /\bupdate\b/i,
  /\bvalidate\b/i,
  /\bverify\b/i,
] as const;

const REFERENTIAL_CONTINUATION = [
  /\bit\b/i,
  /\bthis\b/i,
  /\bthat\b/i,
  /\bsame\b/i,
  /\bcurrent\b/i,
  /\bexisting\b/i,
  /\bcontinue\b/i,
  /\bresume\b/i,
  /\brerun\b/i,
  /\bretry\b/i,
  /\bagain\b/i,
] as const;

const KEYWORD_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "check",
  "current",
  "debug",
  "does",
  "dont",
  "from",
  "have",
  "into",
  "just",
  "keep",
  "latest",
  "make",
  "more",
  "need",
  "please",
  "show",
  "still",
  "tell",
  "that",
  "them",
  "there",
  "they",
  "this",
  "those",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "work",
  "would",
]);

const titleCaseFirst = (value: string): string =>
  value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;

const trimTrailingPunctuation = (value: string): string =>
  value.replace(/[.?!\s]+$/g, "").trim();

const countMatches = (text: string, patterns: ReadonlyArray<RegExp>): number =>
  patterns.reduce((total, pattern) => total + (pattern.test(text) ? 1 : 0), 0);

const tokenizeKeywords = (value: string): Set<string> =>
  new Set(
    normalizeProblem(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 4 && !KEYWORD_STOPWORDS.has(token))
  );

const hasKeywordOverlap = (problem: string, objectiveSummary: string): boolean => {
  const left = tokenizeKeywords(problem);
  const right = tokenizeKeywords(objectiveSummary);
  if (left.size < 2 || right.size < 2) return true;
  for (const token of left) {
    if (right.has(token)) return true;
  }
  return false;
};

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

export const decideFactoryChatBoundObjectiveDispatch = (input: {
  readonly problem: string;
  readonly responseStyle: "conversational" | "work";
  readonly boundObjective?: {
    readonly status?: string;
    readonly title?: string;
    readonly latestSummary?: string;
    readonly nextAction?: string;
  };
}): FactoryChatBoundObjectiveDispatchDecision | undefined => {
  if (input.responseStyle !== "work") return undefined;
  if (!input.boundObjective) return undefined;
  const prompt = normalizeProblem(input.problem);
  if (!prompt) return undefined;
  if (countMatches(prompt, STATUS_OR_META) > 0) return undefined;
  if (countMatches(prompt, CONTROL_INTENT) > 0) return undefined;
  if (countMatches(prompt, SEPARATE_OBJECTIVE) > 0) {
    return {
      action: "create",
      prompt,
      reason: "The user explicitly asked for separate tracked work.",
    };
  }
  if (countMatches(prompt, FOLLOW_UP_WORK) === 0) return undefined;
  const objectiveSummary = [
    input.boundObjective.title,
    input.boundObjective.latestSummary,
    input.boundObjective.nextAction,
  ].filter(Boolean).join("\n");
  const seemsReferential = countMatches(prompt, REFERENTIAL_CONTINUATION) > 0;
  const noObjectiveOverlap = objectiveSummary.length > 0 && hasKeywordOverlap(prompt, objectiveSummary) === false;
  if (!seemsReferential && noObjectiveOverlap) {
    return {
      action: "create",
      prompt,
      reason: "The follow-up looks unrelated to the currently bound objective, so it should start a fresh objective.",
    };
  }
  return {
    action: "react",
    note: prompt,
    reason: input.boundObjective.status === "completed"
      || input.boundObjective.status === "failed"
      || input.boundObjective.status === "canceled"
      ? "The user is asking for fresh work after a terminal objective, so continue via a follow-up objective."
      : "The user is asking for substantive follow-up work on the bound objective.",
  };
};
