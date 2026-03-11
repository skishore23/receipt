// ============================================================================
// Theorem Guild structured LLM parsing + retry helpers
// ============================================================================

import type { AxiomTaskHints } from "./axiom/config.js";

type LlmTextFn = (opts: { system?: string; user: string }) => Promise<string>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry));
};

const normalizeStatus = (value: string | undefined): "valid" | "needs" | "false" | undefined => {
  const text = (value ?? "").toLowerCase();
  if (text.startsWith("valid")) return "valid";
  if (text.startsWith("false")) return "false";
  if (text.startsWith("needs")) return "needs";
  return undefined;
};

const parseJsonObject = (input: string): Record<string, unknown> | undefined => {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const parseCandidate = (candidate: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return asRecord(parsed);
    } catch {
      return undefined;
    }
  };

  const direct = parseCandidate(trimmed);
  if (direct) return direct;

  const starts: number[] = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === "{") starts.push(i);
  }

  for (const start of starts) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          const parsed = parseCandidate(candidate);
          if (parsed) return parsed;
          break;
        }
      }
    }
  }
  return undefined;
};

const boolWithAliases = (
  obj: Record<string, unknown>,
  snake: string,
  camel: string
): boolean => Boolean(asBoolean(obj[snake]) ?? asBoolean(obj[camel]) ?? false);

const parseReason = (obj: Record<string, unknown>): string | undefined => asString(obj.reason);

export type ParsedOrchestratorDecision = {
  readonly action: "continue" | "done";
  readonly reason?: string;
  readonly skipLemma: boolean;
  readonly skipCritique: boolean;
  readonly skipPatch: boolean;
  readonly skipMerge: boolean;
  readonly focus?: Record<string, string>;
};

export type AxiomDelegatePayload = {
  readonly task: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly hints?: AxiomTaskHints;
};

export type AttemptPayload = {
  readonly attempt: string;
  readonly lemmas: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly axiom?: AxiomDelegatePayload;
};

export type LemmaPayload = {
  readonly lemmas: ReadonlyArray<{ label: string; statement: string; usage?: string }>;
};

export type CritiquePayload = {
  readonly issues: ReadonlyArray<{ ref?: string; detail: string; severity?: string }>;
  readonly summary?: string;
};

export type PatchPayload = {
  readonly patch: string;
  readonly remainingGaps: ReadonlyArray<string>;
};

export type MergePayload = {
  readonly summary: string;
  readonly gaps: ReadonlyArray<string>;
};

export type VerifyPayload = {
  readonly status: "valid" | "needs" | "false";
  readonly notes: ReadonlyArray<string>;
  readonly axiom?: AxiomDelegatePayload;
};

export type ProofPayload = {
  readonly proof: string;
  readonly confidence?: number;
  readonly gaps: ReadonlyArray<string>;
  readonly answer?: string;
};

const parseAxiomDelegate = (obj: Record<string, unknown>): AxiomDelegatePayload | undefined => {
  const task = asString(obj.axiom_task ?? obj.axiomTask);
  if (!task) return undefined;
  const config = asRecord(obj.axiom_config ?? obj.axiomConfig);
  const hintRecord = asRecord(obj.axiom_hints ?? obj.axiomHints);
  const preferredTools = asStringArray(hintRecord?.preferred_tools ?? hintRecord?.preferredTools);
  const reason: AxiomTaskHints["reason"] = (() => {
    const raw = asString(hintRecord?.reason);
    return raw === "name_conflict" || raw === "decompose_theorem" || raw === "extract_have_obligation"
      ? raw
      : undefined;
  })();
  const targetPath = asString(hintRecord?.target_path ?? hintRecord?.targetPath);
  const formalStatementPath = asString(hintRecord?.formal_statement_path ?? hintRecord?.formalStatementPath);
  const declarationName = asString(hintRecord?.declaration_name ?? hintRecord?.declarationName);
  const hints = preferredTools.length > 0 || reason || targetPath || formalStatementPath || declarationName
    ? {
        ...(preferredTools.length > 0 ? { preferredTools } : {}),
        ...(reason ? { reason } : {}),
        ...(targetPath ? { targetPath } : {}),
        ...(formalStatementPath ? { formalStatementPath } : {}),
        ...(declarationName ? { declarationName } : {}),
      }
    : undefined;
  return {
    task,
    config: config ? { ...config } : undefined,
    hints,
  };
};

export type StructuredCallResult<T> = {
  readonly value: T;
  readonly raw: string;
  readonly parsed: boolean;
  readonly attempts: number;
};

export const parseOrchestratorDecision = (raw: string): ParsedOrchestratorDecision | undefined => {
  const obj = parseJsonObject(raw);
  if (!obj) return undefined;
  const actionRaw = (asString(obj.action) ?? "").toLowerCase();
  const action =
    actionRaw === "done" || actionRaw === "stop"
      ? "done"
      : actionRaw === "continue"
        ? "continue"
        : undefined;
  if (!action) return undefined;

  const focusRecord = asRecord(obj.focus);
  const focus: Record<string, string> = {};
  if (focusRecord) {
    for (const [key, value] of Object.entries(focusRecord)) {
      const text = asString(value);
      if (text) focus[key] = text;
    }
  }

  return {
    action,
    reason: parseReason(obj),
    skipLemma: boolWithAliases(obj, "skip_lemma", "skipLemma"),
    skipCritique: boolWithAliases(obj, "skip_critique", "skipCritique"),
    skipPatch: boolWithAliases(obj, "skip_patch", "skipPatch"),
    skipMerge: boolWithAliases(obj, "skip_merge", "skipMerge"),
    focus: Object.keys(focus).length ? focus : undefined,
  };
};

export const parseAttemptPayload = (raw: string): AttemptPayload | undefined => {
  const obj = parseJsonObject(raw);
  if (!obj) return undefined;
  const attempt = asString(obj.attempt);
  if (!attempt) return undefined;
  return {
    attempt,
    lemmas: asStringArray(obj.lemmas),
    gaps: asStringArray(obj.gaps),
    axiom: parseAxiomDelegate(obj),
  };
};

export const formatAttemptPayload = (payload: AttemptPayload): string => {
  const lines: string[] = [
    "Attempt:",
    payload.attempt,
  ];
  if (payload.lemmas.length > 0) {
    lines.push("", "Lemmas:", ...payload.lemmas.map((lemma) => `- ${lemma}`));
  }
  if (payload.gaps.length > 0) {
    lines.push("", "Gaps:", ...payload.gaps.map((gap) => `- ${gap}`));
  }
  return lines.join("\n").trim();
};

export const parseLemmaPayload = (raw: string): LemmaPayload | undefined => {
  const obj = parseJsonObject(raw);
  if (!obj) return undefined;
  if (!Array.isArray(obj.lemmas)) return undefined;
  const lemmas: Array<{ label: string; statement: string; usage?: string }> = [];
  obj.lemmas.forEach((entry, idx) => {
    const record = asRecord(entry);
    if (!record) return;
    const statement = asString(record.statement);
    if (!statement) return;
    const label = asString(record.label) ?? `L${idx + 1}`;
    const usage = asString(record.usage);
    lemmas.push(usage ? { label, statement, usage } : { label, statement });
  });
  if (lemmas.length === 0) return undefined;
  return { lemmas };
};

export const formatLemmaPayload = (payload: LemmaPayload): string =>
  payload.lemmas
    .map((lemma) => `${lemma.label}: ${lemma.statement}${lemma.usage ? ` (use: ${lemma.usage})` : ""}`)
    .join("\n")
    .trim();

export const parseCritiquePayload = (raw: string): CritiquePayload | undefined => {
  const obj = parseJsonObject(raw);
  if (!obj) return undefined;
  const issues: Array<{ ref?: string; detail: string; severity?: string }> = [];
  if (Array.isArray(obj.issues)) {
    obj.issues.forEach((entry) => {
      const record = asRecord(entry);
      if (!record) return;
      const detail = asString(record.detail);
      if (!detail) return;
      const ref = asString(record.ref);
      const severity = asString(record.severity);
      issues.push({
        detail,
        ...(ref ? { ref } : {}),
        ...(severity ? { severity } : {}),
      });
    });
  }
  const summary = asString(obj.summary);
  if (issues.length === 0 && !summary) return undefined;
  return { issues, summary };
};

export const formatCritiquePayload = (payload: CritiquePayload): string => {
  if (payload.issues.length === 0) return payload.summary ?? "No issues found.";
  const lines = payload.issues.map((issue) => {
    const prefix = [issue.severity, issue.ref].filter(Boolean).join(" ");
    return prefix ? `- ${prefix}: ${issue.detail}` : `- ${issue.detail}`;
  });
  return [payload.summary ?? "Issues:", ...lines].join("\n").trim();
};

export const parsePatchPayload = (raw: string): PatchPayload | undefined => {
  const obj = parseJsonObject(raw);
  if (!obj) return undefined;
  const patch = asString(obj.patch);
  if (!patch) return undefined;
  return {
    patch,
    remainingGaps: asStringArray(obj.remaining_gaps ?? obj.remainingGaps),
  };
};

export const formatPatchPayload = (payload: PatchPayload): string => {
  if (payload.remainingGaps.length === 0) return payload.patch;
  return [
    payload.patch,
    "",
    "Remaining gaps:",
    ...payload.remainingGaps.map((gap) => `- ${gap}`),
  ].join("\n").trim();
};

export const parseMergePayload = (raw: string): MergePayload | undefined => {
  const obj = parseJsonObject(raw);
  if (!obj) return undefined;
  const summary = asString(obj.summary);
  if (!summary) return undefined;
  return {
    summary,
    gaps: asStringArray(obj.gaps),
  };
};

export const formatMergePayload = (payload: MergePayload): string => {
  if (payload.gaps.length === 0) return payload.summary;
  return [
    payload.summary,
    "",
    "GAPS:",
    ...payload.gaps.map((gap) => `- ${gap}`),
  ].join("\n").trim();
};

export const parseVerifyPayload = (raw: string): VerifyPayload | undefined => {
  const obj = parseJsonObject(raw);
  if (!obj) return undefined;
  const status = normalizeStatus(asString(obj.status));
  if (!status) return undefined;
  const notes = asStringArray(obj.notes);
  return { status, notes, axiom: parseAxiomDelegate(obj) };
};

export const formatVerifyPayload = (payload: VerifyPayload): string => [
  `Status: ${payload.status}`,
  `Notes: ${payload.notes[0] ?? "No notes."}`,
  ...payload.notes.slice(1).map((note) => `- ${note}`),
].join("\n").trim();

export const parseProofPayload = (raw: string): ProofPayload | undefined => {
  const obj = parseJsonObject(raw);
  if (!obj) return undefined;
  const proof = asString(obj.proof);
  if (!proof) return undefined;
  const confidenceRaw = asNumber(obj.confidence);
  const confidence = confidenceRaw === undefined
    ? undefined
    : Math.max(0, Math.min(1, confidenceRaw));
  return {
    proof,
    confidence,
    gaps: asStringArray(obj.gaps),
    answer: asString(obj.answer),
  };
};

export const formatProofPayload = (payload: ProofPayload): string => {
  const lines: string[] = [payload.proof.trim()];
  if (payload.answer && !/^\s*answer:/im.test(payload.proof)) {
    lines.push(`Answer: ${payload.answer}`);
  }
  if (payload.gaps.length > 0 && !/^\s*gaps?:/im.test(payload.proof)) {
    lines.push("GAPS:");
    lines.push(...payload.gaps.map((gap) => `- ${gap}`));
  }
  if (payload.confidence !== undefined && !/^\s*confidence:/im.test(payload.proof)) {
    lines.push(`Confidence: ${payload.confidence.toFixed(2)}`);
  }
  if (!/\bEND_OF_PROOF\b/.test(payload.proof)) {
    lines.push("END_OF_PROOF");
  }
  return lines.join("\n").trim();
};

export const callWithStructuredRetries = async <T>(opts: {
  readonly llmText: LlmTextFn;
  readonly system?: string;
  readonly user: string;
  readonly parse: (raw: string) => T | undefined;
  readonly retries?: number;
  readonly repairInstruction?: string;
}): Promise<StructuredCallResult<T>> => {
  const retries = Math.max(0, opts.retries ?? 1);
  const repairInstruction = opts.repairInstruction
    ?? "Return JSON only. Do not include markdown fences or extra commentary.";
  let raw = "";

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const user = attempt === 0
      ? opts.user
      : `${opts.user}\n\n${repairInstruction}`;
    raw = await opts.llmText({ system: opts.system, user });
    const parsed = opts.parse(raw);
    if (parsed !== undefined) {
      return {
        value: parsed,
        raw,
        parsed: true,
        attempts: attempt + 1,
      };
    }
  }

  throw new Error(`structured parse failed after ${retries + 1} attempts: ${raw}`);
};
