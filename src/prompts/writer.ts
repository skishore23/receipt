// ============================================================================
// Writer Guild prompt templates (loaded from JSON files)
// ============================================================================

import { hashPrompts } from "./hash.js";
import { loadPromptConfig, renderPrompt as renderPromptTemplate } from "./common.js";

export type WriterPromptConfig = {
  readonly system: Record<string, string>;
  readonly user: Record<string, string>;
};

const emptyPrompts: WriterPromptConfig = { system: {}, user: {} };

export const loadWriterPrompts = (): WriterPromptConfig =>
  loadPromptConfig<WriterPromptConfig>({
    name: "writer",
    overridePath: process.env.WRITER_PROMPTS_PATH,
    empty: emptyPrompts,
    tag: "writer",
  });

export const renderPrompt = (template: string, vars: Record<string, string>): string =>
  renderPromptTemplate(template, vars);

export const hashWriterPrompts = (prompts: WriterPromptConfig): string => hashPrompts(prompts);
