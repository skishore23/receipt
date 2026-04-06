import fs from "node:fs";

import { packagePath } from "../lib/runtime-paths";

const readJson = <T>(file: string): T =>
  JSON.parse(fs.readFileSync(file, "utf-8")) as T;

export const loadPromptConfig = <T extends Record<string, unknown>>(opts: {
  readonly name: string;
  readonly tag: string;
}): T => {
  const baseFile = packagePath(import.meta.url, "prompts", `${opts.name}.prompts.json`);
  if (!fs.existsSync(baseFile)) {
    throw new Error(`[${opts.tag}] Missing prompt file ${baseFile}`);
  }
  try {
    return readJson<T>(baseFile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[${opts.tag}] Invalid prompt JSON at ${baseFile}: ${message}`);
  }
};

export const renderPrompt = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Missing template variable: {{${key}}}`);
    return value;
  });
