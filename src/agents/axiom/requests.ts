import type {
  AxleCheckRequest,
  AxleDisproveRequest,
  AxleExtractTheoremsRequest,
  AxleHaveToLemmaRequest,
  AxleHaveToSorryRequest,
  AxleNormalizeRequest,
  AxleRenameRequest,
  AxleRepairRequest,
  AxleSimplifyTheoremsRequest,
  AxleSorryToLemmaRequest,
  AxleTheoremToLemmaRequest,
  AxleTheoremToSorryRequest,
  AxleVerifyRequest,
} from "../../adapters/axle.js";
import type { AxiomRunConfig } from "./config.js";

export type AxiomToolInput = Record<string, unknown>;

const parseBool = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
};

export const requireString = (input: AxiomToolInput, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
};

export const getString = (input: AxiomToolInput, key: string): string | undefined => {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

export const getBoolean = (input: AxiomToolInput, key: string): boolean | undefined =>
  parseBool(input[key]);

export const getNumber = (input: AxiomToolInput, key: string): number | undefined => {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

export const getStringList = (input: AxiomToolInput, key: string): ReadonlyArray<string> | undefined => {
  const value = input[key];
  if (Array.isArray(value)) {
    const entries = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return entries.length > 0 ? entries : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const entries = value.split(/[\n,]/g).map((item) => item.trim()).filter(Boolean);
    return entries.length > 0 ? entries : undefined;
  }
  return undefined;
};

export const getNumberList = (input: AxiomToolInput, key: string): ReadonlyArray<number> | undefined => {
  const value = input[key];
  if (Array.isArray(value)) {
    const nums = value
      .map((entry) => typeof entry === "number" ? entry : (typeof entry === "string" ? Number(entry.trim()) : Number.NaN))
      .filter((entry) => Number.isFinite(entry))
      .map((entry) => Math.trunc(entry));
    return nums.length > 0 ? nums : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const nums = value.split(/[\n,]/g)
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry))
      .map((entry) => Math.trunc(entry));
    return nums.length > 0 ? nums : undefined;
  }
  return undefined;
};

export const getStringRecord = (input: AxiomToolInput, key: string): Readonly<Record<string, string>> | undefined => {
  const value = input[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry !== "string") continue;
      const from = name.trim();
      const to = entry.trim();
      if (!from || !to) continue;
      out[from] = to;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const out: Record<string, string> = {};
    for (const item of value.split(/[\n,]/g).map((entry) => entry.trim()).filter(Boolean)) {
      const [from, to] = item.split("=").map((entry) => entry.trim());
      if (!from || !to) continue;
      out[from] = to;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
};

const toEnvironment = (input: AxiomToolInput, fallback: string): string =>
  getString(input, "environment") ?? fallback;

const toTimeoutSeconds = (input: AxiomToolInput, fallback: number): number =>
  Math.max(5, Math.min(1_800, getNumber(input, "timeoutSeconds") ?? getNumber(input, "timeout_seconds") ?? fallback));

export const toCheckRequest = (input: AxiomToolInput, defaults: AxiomRunConfig, content: string): AxleCheckRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  mathlib_linter: getBoolean(input, "mathlibLinter") ?? getBoolean(input, "mathlib_linter") ?? false,
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});

export const toVerifyRequest = (
  input: AxiomToolInput,
  defaults: AxiomRunConfig,
  content: string,
  formalStatement: string
): AxleVerifyRequest => ({
  ...toCheckRequest(input, defaults, content),
  formal_statement: formalStatement,
  permitted_sorries: getStringList(input, "permittedSorries") ?? getStringList(input, "permitted_sorries"),
  use_def_eq: getBoolean(input, "useDefEq") ?? getBoolean(input, "use_def_eq") ?? true,
});

export const toRepairRequest = (input: AxiomToolInput, defaults: AxiomRunConfig, content: string): AxleRepairRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  names: getStringList(input, "names"),
  repairs: getStringList(input, "repairs"),
  terminal_tactics: getStringList(input, "terminalTactics") ?? getStringList(input, "terminal_tactics") ?? ["grind"],
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});

export const toExtractRequest = (input: AxiomToolInput, defaults: AxiomRunConfig, content: string): AxleExtractTheoremsRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});

export const toNormalizeRequest = (input: AxiomToolInput, defaults: AxiomRunConfig, content: string): AxleNormalizeRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  normalizations: getStringList(input, "normalizations"),
  failsafe: getBoolean(input, "failsafe") ?? true,
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});

export const toSimplifyRequest = (input: AxiomToolInput, defaults: AxiomRunConfig, content: string): AxleSimplifyTheoremsRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  names: getStringList(input, "names"),
  indices: getNumberList(input, "indices"),
  simplifications: getStringList(input, "simplifications"),
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});

export const toSorryToLemmaRequest = (input: AxiomToolInput, defaults: AxiomRunConfig, content: string): AxleSorryToLemmaRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  names: getStringList(input, "names"),
  indices: getNumberList(input, "indices"),
  extract_sorries: getBoolean(input, "extractSorries") ?? getBoolean(input, "extract_sorries") ?? true,
  extract_errors: getBoolean(input, "extractErrors") ?? getBoolean(input, "extract_errors") ?? true,
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});

export const toTheoremToSorryRequest = (input: AxiomToolInput, defaults: AxiomRunConfig, content: string): AxleTheoremToSorryRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  names: getStringList(input, "names"),
  indices: getNumberList(input, "indices"),
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});

export const toRenameRequest = (input: AxiomToolInput, defaults: AxiomRunConfig, content: string): AxleRenameRequest => {
  const declarations = getStringRecord(input, "declarations") ?? (() => {
    const oldName = getString(input, "oldName") ?? getString(input, "old_name");
    const newName = getString(input, "newName") ?? getString(input, "new_name");
    return oldName && newName ? { [oldName]: newName } : undefined;
  })();
  if (!declarations || Object.keys(declarations).length === 0) {
    throw new Error("declarations or oldName/newName is required");
  }
  return {
    content,
    declarations,
    environment: toEnvironment(input, defaults.leanEnvironment),
    ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
    timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
  };
};

export const toTheoremToLemmaRequest = (
  input: AxiomToolInput,
  defaults: AxiomRunConfig,
  content: string
): AxleTheoremToLemmaRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  names: getStringList(input, "names"),
  indices: getNumberList(input, "indices"),
  target: (getString(input, "target") === "theorem" ? "theorem" : "lemma"),
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});

export const toHaveToLemmaRequest = (
  input: AxiomToolInput,
  defaults: AxiomRunConfig,
  content: string
): AxleHaveToLemmaRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  names: getStringList(input, "names"),
  indices: getNumberList(input, "indices"),
  include_have_body: getBoolean(input, "includeHaveBody") ?? getBoolean(input, "include_have_body") ?? false,
  include_whole_context: getBoolean(input, "includeWholeContext") ?? getBoolean(input, "include_whole_context") ?? true,
  reconstruct_callsite: getBoolean(input, "reconstructCallsite") ?? getBoolean(input, "reconstruct_callsite") ?? false,
  verbosity: Math.max(0, Math.min(2, getNumber(input, "verbosity") ?? 0)),
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});

export const toHaveToSorryRequest = (
  input: AxiomToolInput,
  defaults: AxiomRunConfig,
  content: string
): AxleHaveToSorryRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  names: getStringList(input, "names"),
  indices: getNumberList(input, "indices"),
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});

export const toDisproveRequest = (input: AxiomToolInput, defaults: AxiomRunConfig, content: string): AxleDisproveRequest => ({
  content,
  environment: toEnvironment(input, defaults.leanEnvironment),
  names: getStringList(input, "names"),
  indices: getNumberList(input, "indices"),
  ignore_imports: getBoolean(input, "ignoreImports") ?? getBoolean(input, "ignore_imports") ?? false,
  timeout_seconds: toTimeoutSeconds(input, defaults.leanTimeoutSeconds),
});
