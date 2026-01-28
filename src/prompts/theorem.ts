// ============================================================================
// Theorem Guild prompt templates (loaded from JSON files)
// ============================================================================

import fs from "node:fs";
import path from "node:path";

export type TheoremPromptConfig = {
  readonly system: Record<string, string>;
  readonly user: Record<string, string>;
};

const mergeDeep = (base: Record<string, any>, override: Record<string, any>) => {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object") {
      out[k] = mergeDeep(base[k], v as Record<string, any>);
    } else {
      out[k] = v;
    }
  }
  return out;
};

const emptyPrompts: TheoremPromptConfig = { system: {}, user: {} };

const readJson = (file: string): TheoremPromptConfig =>
  JSON.parse(fs.readFileSync(file, "utf-8")) as TheoremPromptConfig;

export const loadTheoremPrompts = (_baseDir: string): TheoremPromptConfig => {
  const baseFile = path.join(process.cwd(), "prompts", "theorem.prompts.json");
  const overrideFile = process.env.THEOREM_PROMPTS_PATH;

  let base: TheoremPromptConfig = emptyPrompts;
  if (fs.existsSync(baseFile)) {
    try {
      base = readJson(baseFile);
    } catch {
      console.warn(`[theorem] Invalid prompt JSON at ${baseFile}`);
    }
  } else if (!overrideFile) {
    console.warn(`[theorem] Missing prompt file ${baseFile}`);
  }

  if (overrideFile) {
    if (fs.existsSync(overrideFile)) {
      try {
        const override = readJson(overrideFile);
        return mergeDeep(base, override) as TheoremPromptConfig;
      } catch {
        console.warn(`[theorem] Invalid prompt JSON at ${overrideFile}`);
      }
    } else {
      console.warn(`[theorem] Override prompt file not found: ${overrideFile}`);
    }
  }

  return base;
};

export const renderPrompt = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_m, key) => vars[key] ?? "");
