import fs from "node:fs/promises";

import {
  FactoryServiceError,
  type FactoryIntegrationPublishJobPayload,
  type FactoryTaskJobPayload,
} from "../factory-types";

export type FactoryPublishResult = {
  readonly summary: string;
  readonly prUrl: string;
  readonly prNumber: number | null;
  readonly headRefName: string | null;
  readonly baseRefName: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const optionalTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const blockerSummary = (summary: string): string | undefined =>
  /\b(blocked|failed|error|unable|could not)\b/i.test(summary) ? summary : undefined;

const isValidUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

export const parseJsonObjectCandidate = (raw: string): Record<string, unknown> | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const candidates = trimmed.includes("\n")
    ? trimmed.split("\n").map((line) => line.trim()).filter(Boolean).reverse()
    : [trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
};

export const parseFactoryTaskResult = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) throw new FactoryServiceError(500, "missing factory task result.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FactoryServiceError(500, `malformed factory task result.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) throw new FactoryServiceError(500, "factory task result must be an object");
  return parsed;
};

export const normalizeFactoryPublishResult = (raw: Record<string, unknown>): FactoryPublishResult => {
  const summary = optionalTrimmedString(raw.summary);
  if (!summary) throw new FactoryServiceError(500, "factory publish result missing summary");
  const prUrl = optionalTrimmedString(raw.prUrl);
  if (!prUrl || !isValidUrl(prUrl)) {
    throw new FactoryServiceError(500, blockerSummary(summary) ?? "factory publish result missing valid prUrl");
  }
  const prNumber = raw.prNumber === null
    ? null
    : typeof raw.prNumber === "number" && Number.isFinite(raw.prNumber)
      ? Math.max(0, Math.floor(raw.prNumber))
      : undefined;
  if (prNumber === undefined) throw new FactoryServiceError(500, "factory publish result missing prNumber");
  const headRefName = raw.headRefName === null
    ? null
    : optionalTrimmedString(raw.headRefName) ?? undefined;
  if (headRefName === undefined) throw new FactoryServiceError(500, "factory publish result missing headRefName");
  const baseRefName = raw.baseRefName === null
    ? null
    : optionalTrimmedString(raw.baseRefName) ?? undefined;
  if (baseRefName === undefined) throw new FactoryServiceError(500, "factory publish result missing baseRefName");
  return {
    summary,
    prUrl,
    prNumber,
    headRefName,
    baseRefName,
  };
};

export const parseFactoryPublishResult = (raw: string): FactoryPublishResult => {
  if (!raw.trim()) throw new FactoryServiceError(500, "missing factory publish result.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FactoryServiceError(500, `malformed factory publish result.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) throw new FactoryServiceError(500, "factory publish result must be an object");
  return normalizeFactoryPublishResult(parsed);
};

export const resolveFactoryTaskWorkerResult = async (
  payload: Pick<FactoryTaskJobPayload, "resultPath" | "lastMessagePath">,
  execution: { readonly lastMessage?: string; readonly tokensUsed?: number },
): Promise<Record<string, unknown>> => {
  let result: Record<string, unknown> | undefined;
  const rawResult = await fs.readFile(payload.resultPath, "utf-8").catch(() => "");
  if (rawResult.trim()) {
    result = parseFactoryTaskResult(rawResult);
  } else {
    const rawLastMessage = execution.lastMessage?.trim()
      ? execution.lastMessage
      : await fs.readFile(payload.lastMessagePath, "utf-8").catch(() => "");
    result = rawLastMessage ? parseJsonObjectCandidate(rawLastMessage) : undefined;
  }
  if (!result) {
    throw new FactoryServiceError(500, "missing structured factory task result from codex");
  }
  return execution.tokensUsed !== undefined
    ? { ...result, tokensUsed: execution.tokensUsed }
    : result;
};

export const resolveFactoryPublishWorkerResult = async (
  payload: Pick<FactoryIntegrationPublishJobPayload, "resultPath" | "lastMessagePath">,
  execution: { readonly lastMessage?: string },
): Promise<FactoryPublishResult> => {
  const rawResult = await fs.readFile(payload.resultPath, "utf-8").catch(() => "");
  if (rawResult.trim()) return parseFactoryPublishResult(rawResult);
  const rawLastMessage = execution.lastMessage?.trim()
    ? execution.lastMessage
    : await fs.readFile(payload.lastMessagePath, "utf-8").catch(() => "");
  const parsed = rawLastMessage ? parseJsonObjectCandidate(rawLastMessage) : undefined;
  if (!parsed) {
    throw new FactoryServiceError(500, "missing structured factory publish result from codex");
  }
  return normalizeFactoryPublishResult(parsed);
};
