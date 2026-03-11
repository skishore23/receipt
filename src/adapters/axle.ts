export type AxleMessageBundle = {
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly infos: ReadonlyArray<string>;
};

export type AxleEnvironmentInfo = {
  readonly name: string;
  readonly description?: string;
  readonly [key: string]: unknown;
};

export type AxleDocument = {
  readonly declaration?: string;
  readonly content?: string;
  readonly [key: string]: unknown;
};

export type AxleBaseContentRequest = {
  readonly content: string;
  readonly environment: string;
  readonly ignore_imports?: boolean;
  readonly timeout_seconds?: number;
};

export type AxleCheckRequest = AxleBaseContentRequest & {
  readonly mathlib_linter?: boolean;
};

export type AxleVerifyRequest = AxleCheckRequest & {
  readonly formal_statement: string;
  readonly permitted_sorries?: ReadonlyArray<string>;
  readonly use_def_eq?: boolean;
};

export type AxleRepairRequest = AxleBaseContentRequest & {
  readonly names?: ReadonlyArray<string>;
  readonly repairs?: ReadonlyArray<string>;
  readonly terminal_tactics?: ReadonlyArray<string>;
};

export type AxleExtractTheoremsRequest = AxleBaseContentRequest;

export type AxleRenameRequest = AxleBaseContentRequest & {
  readonly declarations: Readonly<Record<string, string>>;
};

export type AxleNormalizeRequest = AxleBaseContentRequest & {
  readonly normalizations?: ReadonlyArray<string>;
  readonly failsafe?: boolean;
};

export type AxleSimplifyTheoremsRequest = AxleBaseContentRequest & {
  readonly names?: ReadonlyArray<string>;
  readonly indices?: ReadonlyArray<number>;
  readonly simplifications?: ReadonlyArray<string>;
};

export type AxleSorryToLemmaRequest = AxleBaseContentRequest & {
  readonly names?: ReadonlyArray<string>;
  readonly indices?: ReadonlyArray<number>;
  readonly extract_sorries?: boolean;
  readonly extract_errors?: boolean;
};

export type AxleTheoremToSorryRequest = AxleBaseContentRequest & {
  readonly names?: ReadonlyArray<string>;
  readonly indices?: ReadonlyArray<number>;
};

export type AxleTheoremToLemmaRequest = AxleBaseContentRequest & {
  readonly names?: ReadonlyArray<string>;
  readonly indices?: ReadonlyArray<number>;
  readonly target?: "lemma" | "theorem";
};

export type AxleHaveToLemmaRequest = AxleBaseContentRequest & {
  readonly names?: ReadonlyArray<string>;
  readonly indices?: ReadonlyArray<number>;
  readonly include_have_body?: boolean;
  readonly include_whole_context?: boolean;
  readonly reconstruct_callsite?: boolean;
  readonly verbosity?: number;
};

export type AxleHaveToSorryRequest = AxleBaseContentRequest & {
  readonly names?: ReadonlyArray<string>;
  readonly indices?: ReadonlyArray<number>;
};

export type AxleDisproveRequest = AxleBaseContentRequest & {
  readonly names?: ReadonlyArray<string>;
  readonly indices?: ReadonlyArray<number>;
};

export type AxleResult = {
  readonly okay: boolean;
  readonly content: string;
  readonly lean_messages: AxleMessageBundle;
  readonly tool_messages: AxleMessageBundle;
  readonly failed_declarations: ReadonlyArray<string>;
  readonly timings: Readonly<Record<string, number>>;
  readonly repair_stats?: Readonly<Record<string, number>>;
  readonly normalize_stats?: Readonly<Record<string, number>>;
  readonly simplification_stats?: Readonly<Record<string, number>>;
  readonly documents?: Readonly<Record<string, AxleDocument>>;
  readonly lemma_names?: ReadonlyArray<string>;
  readonly disproved_theorems?: ReadonlyArray<string>;
};

type AxleCallOptions = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
};

const DEFAULT_BASE_URL = "https://axle.axiommath.ai";

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
};

const toMessages = (value: unknown): AxleMessageBundle => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { errors: [], warnings: [], infos: [] };
  }
  const obj = value as Record<string, unknown>;
  const toList = (entry: unknown): ReadonlyArray<string> =>
    Array.isArray(entry) ? entry.filter((item): item is string => typeof item === "string") : [];
  return {
    errors: toList(obj.errors),
    warnings: toList(obj.warnings),
    infos: toList(obj.infos),
  };
};

const toNumberRecord = (value: unknown): Readonly<Record<string, number>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
};

const toStringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const toDocuments = (value: unknown): Readonly<Record<string, AxleDocument>> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, AxleDocument> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    out[name] = entry as AxleDocument;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const getUserError = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const userError = (value as Record<string, unknown>).user_error;
  return typeof userError === "string" && userError.trim().length > 0 ? userError.trim() : undefined;
};

const normalizeResult = (value: unknown): AxleResult => {
  const obj = asRecord(value);
  const userError = getUserError(obj);
  const leanMessages = toMessages(obj.lean_messages);
  const toolMessages = toMessages(obj.tool_messages);
  if (userError) {
    const info = obj.info && typeof obj.info === "object" && !Array.isArray(obj.info) ? obj.info : undefined;
    return {
      okay: false,
      content: typeof obj.content === "string" ? obj.content : "",
      lean_messages: {
        errors: [userError],
        warnings: leanMessages.warnings,
        infos: leanMessages.infos,
      },
      tool_messages: toolMessages,
      failed_declarations: [],
      timings: toNumberRecord(info),
      repair_stats: undefined,
      normalize_stats: undefined,
      simplification_stats: undefined,
      documents: toDocuments(obj.documents),
      lemma_names: toStringList(obj.lemma_names),
      disproved_theorems: toStringList(obj.disproved_theorems),
    };
  }
  return {
    okay: typeof obj.okay === "boolean"
      ? obj.okay
      : leanMessages.errors.length === 0 && toolMessages.errors.length === 0,
    content: typeof obj.content === "string" ? obj.content : "",
    lean_messages: leanMessages,
    tool_messages: toolMessages,
    failed_declarations: toStringList(obj.failed_declarations),
    timings: toNumberRecord(obj.timings),
    repair_stats: obj.repair_stats ? toNumberRecord(obj.repair_stats) : undefined,
    normalize_stats: obj.normalize_stats ? toNumberRecord(obj.normalize_stats) : undefined,
    simplification_stats: obj.simplification_stats ? toNumberRecord(obj.simplification_stats) : undefined,
    documents: toDocuments(obj.documents),
    lemma_names: toStringList(obj.lemma_names),
    disproved_theorems: toStringList(obj.disproved_theorems),
  };
};

const timeoutSignal = (timeoutSeconds: number): AbortSignal | undefined => (
  typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(Math.max(5_000, Math.ceil(timeoutSeconds * 1000) + 5_000))
    : undefined
);

const createHeaders = (apiKey?: string): Headers => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (apiKey?.trim()) headers.set("Authorization", `Bearer ${apiKey.trim()}`);
  return headers;
};

const call = async <Req extends { readonly timeout_seconds?: number }>(
  method: "GET" | "POST",
  pathname: string,
  body: Req | undefined,
  opts: AxleCallOptions
): Promise<unknown> => {
  const baseUrl = (opts.baseUrl?.trim() || process.env.AXLE_API_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = opts.apiKey ?? process.env.AXLE_API_KEY;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: createHeaders(apiKey),
    body: body ? JSON.stringify(body) : undefined,
    signal: timeoutSignal(body?.timeout_seconds ?? 120),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(`AXLE ${pathname} failed with ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 400)}` : ""}`);
  }
  return response.json();
};

export const axleEnvironments = async (opts: AxleCallOptions = {}): Promise<ReadonlyArray<AxleEnvironmentInfo>> => {
  const value = await call("GET", "/v1/environments", undefined, opts);
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "unknown",
      description: typeof item.description === "string" ? item.description : undefined,
      ...item,
    }));
};

export const axleCheck = async (request: AxleCheckRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/check", request, opts));

export const axleVerifyProof = async (request: AxleVerifyRequest, opts: AxleCallOptions = {}): Promise<AxleResult> => {
  const initial = await call("POST", "/api/v1/verify_proof", request, opts);
  if (!request.ignore_imports && getUserError(initial)?.startsWith("Imports mismatch:")) {
    return normalizeResult(await call("POST", "/api/v1/verify_proof", { ...request, ignore_imports: true }, opts));
  }
  return normalizeResult(initial);
};

export const axleRepairProofs = async (request: AxleRepairRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/repair_proofs", request, opts));

export const axleExtractTheorems = async (request: AxleExtractTheoremsRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/extract_theorems", request, opts));

export const axleRename = async (request: AxleRenameRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/rename", request, opts));

export const axleNormalize = async (request: AxleNormalizeRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/normalize", request, opts));

export const axleSimplifyTheorems = async (request: AxleSimplifyTheoremsRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/simplify_theorems", request, opts));

export const axleSorryToLemma = async (request: AxleSorryToLemmaRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/sorry2lemma", request, opts));

export const axleTheoremToSorry = async (request: AxleTheoremToSorryRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/theorem2sorry", request, opts));

export const axleTheoremToLemma = async (request: AxleTheoremToLemmaRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/theorem2lemma", request, opts));

export const axleHaveToLemma = async (request: AxleHaveToLemmaRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/have2lemma", request, opts));

export const axleHaveToSorry = async (request: AxleHaveToSorryRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/have2sorry", request, opts));

export const axleDisprove = async (request: AxleDisproveRequest, opts: AxleCallOptions = {}): Promise<AxleResult> =>
  normalizeResult(await call("POST", "/api/v1/disprove", request, opts));
