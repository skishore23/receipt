import { hashPrompts } from "./hash.js";
import { loadPromptConfig, renderPrompt as renderPromptTemplate } from "./common.js";

export type AxiomPromptConfig = {
  readonly system: string;
  readonly user: {
    readonly loop: string;
  };
};

export const loadAxiomPrompts = (): AxiomPromptConfig =>
  loadPromptConfig<AxiomPromptConfig>({
    name: "axiom",
    tag: "axiom",
  });

export const renderPrompt = (template: string, vars: Record<string, string>): string =>
  renderPromptTemplate(template, vars);

export const hashAxiomPrompts = (prompts: AxiomPromptConfig): string => hashPrompts(prompts);
