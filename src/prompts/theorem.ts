// ============================================================================
// Theorem Guild prompt templates (loaded from JSON files)
// ============================================================================

import { hashPrompts } from "./hash.js";
import { loadPromptConfig, renderPrompt as renderPromptTemplate } from "./common.js";

export type TheoremPromptConfig = {
  readonly system: Record<string, string>;
  readonly user: Record<string, string>;
};

export const loadTheoremPrompts = (): TheoremPromptConfig =>
  loadPromptConfig<TheoremPromptConfig>({
    name: "theorem",
    tag: "theorem",
  });

export const renderPrompt = (template: string, vars: Record<string, string>): string =>
  renderPromptTemplate(template, vars);

export const hashTheoremPrompts = (prompts: TheoremPromptConfig): string => hashPrompts(prompts);
