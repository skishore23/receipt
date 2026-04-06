// ============================================================================
// Agent prompt templates (loaded from JSON files)
// ============================================================================

import { hashPrompts } from "./hash";
import { loadPromptConfig, renderPrompt as renderPromptTemplate } from "./common";

export type AgentPromptConfig = {
  readonly system: string;
  readonly user: {
    readonly loop: string;
  };
};

export const loadAgentPrompts = (): AgentPromptConfig =>
  loadPromptConfig<AgentPromptConfig>({
    name: "agent",
    tag: "agent",
  });

export const renderPrompt = (template: string, vars: Record<string, string>): string =>
  renderPromptTemplate(template, vars);

export const hashAgentPrompts = (prompts: AgentPromptConfig): string => hashPrompts(prompts);
