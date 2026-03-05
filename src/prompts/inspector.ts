// ============================================================================
// Receipt Inspector prompt templates (loaded from JSON files)
// ============================================================================

import { hashPrompts } from "./hash.js";
import { loadPromptConfig, renderPrompt as renderPromptTemplate } from "./common.js";

export type InspectorPromptConfig = {
  readonly system: string;
  readonly modes: Record<string, string>;
};

export const loadInspectorPrompts = (): InspectorPromptConfig =>
  loadPromptConfig<InspectorPromptConfig>({
    name: "inspector",
    tag: "inspector",
  });

export const renderPrompt = (template: string, vars: Record<string, string>): string =>
  renderPromptTemplate(template, vars);

export const hashInspectorPrompts = (prompts: InspectorPromptConfig): string => hashPrompts(prompts);
