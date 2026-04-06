import { z } from "zod";

import type { FactoryChatResponseStyle } from "../chat-context";

export type FactoryChatTurnAnalysis = {
  readonly responseStyle: FactoryChatResponseStyle;
  readonly includeBoundObjectiveContext: boolean;
};

const FactoryChatTurnAnalysisSchema = z.object({
  responseStyle: z.enum(["conversational", "work"]),
  includeBoundObjectiveContext: z.boolean(),
}).strict();

const FALLBACK_ANALYSIS: FactoryChatTurnAnalysis = {
  responseStyle: "work",
  includeBoundObjectiveContext: true,
};

const parseJsonObject = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty model output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("model output is not valid JSON");
  }
};

export const analyzeFactoryChatTurn = async (input: {
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly llmStructured?: (opts: {
    readonly system?: string;
    readonly user: string;
    readonly schema: typeof FactoryChatTurnAnalysisSchema;
    readonly schemaName: string;
  }) => Promise<{ readonly parsed: FactoryChatTurnAnalysis; readonly raw: string }>;
  readonly apiReady: boolean;
  readonly problem: string;
}): Promise<FactoryChatTurnAnalysis> => {
  if (!input.apiReady) return FALLBACK_ANALYSIS;
  const problem = input.problem.replace(/\s+/g, " ").trim();
  if (!problem) return FALLBACK_ANALYSIS;
  const user = [
    "Analyze the user turn for the Factory product chat.",
    "",
    "Return JSON only:",
    "{\"responseStyle\":\"conversational\"|\"work\",\"includeBoundObjectiveContext\":boolean}",
    "",
    "Choose `responseStyle: conversational` for purely meta, social, or personal chat turns.",
    "Choose `responseStyle: work` for product, repo, debugging, operational, analytical, delivery, or factual work.",
    "Set `includeBoundObjectiveContext: false` only when the answer should stay lightweight and does not need bound objective or runtime context.",
    "Set `includeBoundObjectiveContext: true` whenever current objective, receipts, runtime state, repo context, or live work could matter.",
    "",
    `User turn: ${problem}`,
  ].join("\n");
  try {
    if (input.llmStructured) {
      const result = await input.llmStructured({
        user,
        schema: FactoryChatTurnAnalysisSchema,
        schemaName: "FactoryChatTurnAnalysis",
      });
      return FactoryChatTurnAnalysisSchema.parse(result.parsed);
    }
    const raw = await input.llmText({ user });
    return FactoryChatTurnAnalysisSchema.parse(parseJsonObject(raw));
  } catch {
    return FALLBACK_ANALYSIS;
  }
};
