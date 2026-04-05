import fs from "node:fs/promises";

import {
  FactoryServiceError,
  type FactoryIntegrationPublishJobPayload,
  type FactoryTaskJobPayload,
} from "../factory-types";
import { normalizeStructuredEvidenceRecord } from "./result-contracts";

export type FactoryPublishResult = {
  readonly summary: string;
  readonly handoff: string;
  readonly prUrl: string;
  readonly prNumber: number | null;
  readonly headRefName: string | null;
  readonly baseRefName: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isMissingPathError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

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
  const candidates = [
    trimmed,
    ...(
      trimmed.includes("\n")
        ? trimmed.split("\n").map((line) => line.trim()).filter(Boolean).reverse()
        : []
    ),
  ];
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

export const normalizeFactoryPublishResult = (raw: Record<string, unknown>): FactoryPublishResult => {
  const summary = optionalTrimmedString(raw.summary);
  if (!summary) throw new FactoryServiceError(500, "factory publish result missing summary");
  const handoff = optionalTrimmedString(raw.handoff) ?? summary;
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
    handoff,
    prUrl,
    prNumber,
    headRefName,
    baseRefName,
  };
};

const readTextIfPresent = async (targetPath: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(targetPath, "utf-8");
  } catch (err) {
    if (isMissingPathError(err)) return undefined;
    throw err;
  }
};

export const resolveFactoryTaskWorkerResult = async (
  payload: Pick<FactoryTaskJobPayload, "lastMessagePath" | "resultPath">,
  execution: { readonly lastMessage?: string; readonly tokensUsed?: number },
): Promise<Record<string, unknown>> => {
  const rawLastMessage = execution.lastMessage?.trim()
    ? execution.lastMessage
    : await readTextIfPresent(payload.lastMessagePath) ?? "";
  const result = parseJsonObjectCandidate(rawLastMessage)
    ?? parseJsonObjectCandidate(await readTextIfPresent(payload.resultPath) ?? "");
  if (!result) {
    throw new FactoryServiceError(500, "missing structured factory task result from codex");
  }
  const scriptsRun = Array.isArray(result.scriptsRun) ? result.scriptsRun : [];
  const structuredEvidence = normalizeStructuredEvidenceRecord(result.structuredEvidence, {
    logs: [
      payload.lastMessagePath,
      payload.resultPath,
    ].filter((item): item is string => Boolean(item)),
    artifacts: [],
    alignmentReason: "Alignment validation was not performed by the worker; the controller recorded a fallback evidence bundle.",
  });
  return execution.tokensUsed !== undefined
    ? { ...result, scriptsRun, structuredEvidence, tokensUsed: execution.tokensUsed }
    : { ...result, scriptsRun, structuredEvidence };
};

export const resolveFactoryPublishWorkerResult = async (
  payload: Pick<FactoryIntegrationPublishJobPayload, "lastMessagePath">,
  execution: { readonly lastMessage?: string },
): Promise<FactoryPublishResult> => {
  const rawLastMessage = execution.lastMessage?.trim()
    ? execution.lastMessage
    : await readTextIfPresent(payload.lastMessagePath) ?? "";
  const parsed = rawLastMessage ? parseJsonObjectCandidate(rawLastMessage) : undefined;
  if (!parsed) {
    throw new FactoryServiceError(500, "missing structured factory publish result from codex");
  }
  return normalizeFactoryPublishResult(parsed);
};
