import type { AgentRunInput } from "../agent.js";
import { clampNumber, parseFormNum, type AgentRunControl } from "../../engine/runtime/workflow.js";
import type { AxiomPromptConfig } from "../../prompts/axiom.js";

export const AXIOM_WORKFLOW_ID = "axiom-v1";
export const AXIOM_WORKFLOW_VERSION = "1.0.0";

export type AxiomRequiredValidation = {
  readonly kind: "axle-verify";
  readonly formalStatementPath?: string;
};

export type AxiomTaskHintReason = "name_conflict" | "decompose_theorem" | "extract_have_obligation";

export type AxiomTaskHints = {
  readonly preferredTools?: ReadonlyArray<string>;
  readonly reason?: AxiomTaskHintReason;
  readonly targetPath?: string;
  readonly formalStatementPath?: string;
  readonly declarationName?: string;
};

export type AxiomRunConfig = {
  readonly maxIterations: number;
  readonly maxToolOutputChars: number;
  readonly memoryScope: string;
  readonly workspace: string;
  readonly leanEnvironment: string;
  readonly leanTimeoutSeconds: number;
  readonly autoRepair: boolean;
  readonly localValidationMode: "off" | "prefer" | "require";
  readonly requiredValidation?: AxiomRequiredValidation;
  readonly taskHints?: AxiomTaskHints;
};

export type AxiomRunControl = AgentRunControl;

export type AxiomRunInput = Omit<AgentRunInput, "config" | "prompts"> & {
  readonly config: AxiomRunConfig;
  readonly prompts: AxiomPromptConfig;
};

export const AXIOM_DEFAULT_CONFIG: AxiomRunConfig = {
  maxIterations: 24,
  maxToolOutputChars: 8_000,
  memoryScope: "axiom",
  workspace: ".",
  leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT?.trim() || "lean-4.28.0",
  leanTimeoutSeconds: 120,
  autoRepair: true,
  localValidationMode: "off",
};

const parseBool = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
};

const parseStringList = (value: unknown): ReadonlyArray<string> | undefined => {
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

const parseLocalValidationMode = (value: unknown): AxiomRunConfig["localValidationMode"] | undefined =>
  value === "off" || value === "prefer" || value === "require" ? value : undefined;

const parseRequiredValidation = (value: unknown): AxiomRequiredValidation | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "axle-verify") return undefined;
  const formalStatementPath = typeof record.formalStatementPath === "string" && record.formalStatementPath.trim().length > 0
    ? record.formalStatementPath.trim()
    : undefined;
  return {
    kind: "axle-verify",
    formalStatementPath,
  };
};

const parseTaskHints = (value: unknown): AxiomTaskHints | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const preferredTools = parseStringList(record.preferredTools ?? record.preferred_tools);
  const reason = record.reason === "name_conflict" || record.reason === "decompose_theorem" || record.reason === "extract_have_obligation"
    ? record.reason
    : undefined;
  const targetPath = typeof record.targetPath === "string" && record.targetPath.trim().length > 0
    ? record.targetPath.trim()
    : undefined;
  const formalStatementPath = typeof record.formalStatementPath === "string" && record.formalStatementPath.trim().length > 0
    ? record.formalStatementPath.trim()
    : undefined;
  const declarationName = typeof record.declarationName === "string" && record.declarationName.trim().length > 0
    ? record.declarationName.trim()
    : undefined;

  if (!preferredTools && !reason && !targetPath && !formalStatementPath && !declarationName) return undefined;
  return {
    preferredTools,
    reason,
    targetPath,
    formalStatementPath,
    declarationName,
  };
};

export const normalizeAxiomConfig = (input: Partial<AxiomRunConfig>): AxiomRunConfig => ({
  maxIterations: clampNumber(
    Number.isFinite(input.maxIterations ?? Number.NaN) ? input.maxIterations! : AXIOM_DEFAULT_CONFIG.maxIterations,
    1,
    80
  ),
  maxToolOutputChars: clampNumber(
    Number.isFinite(input.maxToolOutputChars ?? Number.NaN) ? input.maxToolOutputChars! : AXIOM_DEFAULT_CONFIG.maxToolOutputChars,
    400,
    40_000
  ),
  memoryScope: typeof input.memoryScope === "string" && input.memoryScope.trim().length > 0
    ? input.memoryScope.trim()
    : AXIOM_DEFAULT_CONFIG.memoryScope,
  workspace: typeof input.workspace === "string" && input.workspace.trim().length > 0
    ? input.workspace.trim()
    : AXIOM_DEFAULT_CONFIG.workspace,
  leanEnvironment: typeof input.leanEnvironment === "string" && input.leanEnvironment.trim().length > 0
    ? input.leanEnvironment.trim()
    : AXIOM_DEFAULT_CONFIG.leanEnvironment,
  leanTimeoutSeconds: clampNumber(
    Number.isFinite(input.leanTimeoutSeconds ?? Number.NaN) ? input.leanTimeoutSeconds! : AXIOM_DEFAULT_CONFIG.leanTimeoutSeconds,
    5,
    1_800
  ),
  autoRepair: typeof input.autoRepair === "boolean" ? input.autoRepair : AXIOM_DEFAULT_CONFIG.autoRepair,
  localValidationMode: parseLocalValidationMode(input.localValidationMode) ?? AXIOM_DEFAULT_CONFIG.localValidationMode,
  requiredValidation: parseRequiredValidation(input.requiredValidation),
  taskHints: parseTaskHints(input.taskHints),
});

export const parseAxiomConfig = (form: Record<string, string>): AxiomRunConfig =>
  normalizeAxiomConfig({
    maxIterations: parseFormNum(form.maxIterations),
    maxToolOutputChars: parseFormNum(form.maxToolOutputChars),
    memoryScope: form.memoryScope,
    workspace: form.workspace,
    leanEnvironment: form.leanEnvironment,
    leanTimeoutSeconds: parseFormNum(form.leanTimeoutSeconds),
    autoRepair: parseBool(form.autoRepair),
    localValidationMode: parseLocalValidationMode(form.localValidationMode),
  });

export const formatAxiomTaskHints = (hints?: AxiomTaskHints): string => {
  if (!hints) return "";
  const lines = ["Task hints (structured):"];
  if (hints.reason) lines.push(`- reason: ${hints.reason}`);
  if (hints.preferredTools && hints.preferredTools.length > 0) {
    lines.push(`- preferred AXLE tools: ${hints.preferredTools.join(", ")}`);
    lines.push("- use the matching `_file` variant when you are operating on workspace files");
  }
  if (hints.declarationName) lines.push(`- declaration name: ${hints.declarationName}`);
  if (hints.targetPath) lines.push(`- target path: ${hints.targetPath}`);
  if (hints.formalStatementPath) lines.push(`- formal statement path: ${hints.formalStatementPath}`);
  return lines.join("\n");
};

export const applyAxiomTaskHints = (problem: string, hints?: AxiomTaskHints): string => {
  const base = problem.trim();
  const block = formatAxiomTaskHints(hints);
  return block ? `${base}\n\n${block}`.trim() : base;
};
