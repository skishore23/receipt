// ============================================================================
// Theorem Guild prompt templates (loaded from JSON files)
// ============================================================================

import { hashPrompts } from "./hash.js";
import { loadPromptConfig, renderPrompt as renderPromptTemplate } from "./common.js";

export type TheoremPromptConfig = {
  readonly system: Record<string, string>;
  readonly user: Record<string, string>;
};

const emptyPrompts: TheoremPromptConfig = { system: {}, user: {} };

export const loadTheoremPrompts = (): TheoremPromptConfig =>
  loadPromptConfig<TheoremPromptConfig>({
    name: "theorem",
    overridePath: process.env.THEOREM_PROMPTS_PATH,
    empty: emptyPrompts,
    tag: "theorem",
  });

export const renderPrompt = (template: string, vars: Record<string, string>): string =>
  renderPromptTemplate(template, vars);

export const hashTheoremPrompts = (prompts: TheoremPromptConfig): string => hashPrompts(prompts);
