// ============================================================================
// Writer Guild prompt templates (loaded from JSON files)
// ============================================================================

import { hashPrompts } from "./hash.js";
import { loadPromptConfig, renderPrompt as renderPromptTemplate } from "./common.js";

export type WriterPromptConfig = {
  readonly system: Record<string, string>;
  readonly user: Record<string, string>;
};

export const loadWriterPrompts = (): WriterPromptConfig =>
  loadPromptConfig<WriterPromptConfig>({
    name: "writer",
    tag: "writer",
  });

export const renderPrompt = (template: string, vars: Record<string, string>): string =>
  renderPromptTemplate(template, vars);

export const hashWriterPrompts = (prompts: WriterPromptConfig): string => hashPrompts(prompts);
