import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { optionalTrimmedString, trimmedString } from "../../framework/http";

export type FactoryArtifactIssue = {
  readonly path: string;
  readonly summary: string;
  readonly detail?: string;
  readonly status: "warning" | "error";
};

export const isMissingPathError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

export const clipArtifactText = (value: string | undefined, max = 280): string | undefined => {
  if (!value) return undefined;
  const trimmed = trimmedString(value);
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

export const pathExists = async (targetPath: string): Promise<boolean> =>
  fs.access(targetPath).then(() => true).catch((err) => {
    if (isMissingPathError(err)) return false;
    throw err;
  });

export const readTextIfPresent = async (targetPath: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(targetPath, "utf-8");
  } catch (err) {
    if (isMissingPathError(err)) return undefined;
    throw err;
  }
};

export const readdirIfPresent = async (
  targetPath: string,
  opts: { readonly withFileTypes: true },
): Promise<ReadonlyArray<Dirent>> => {
  try {
    return await fs.readdir(targetPath, opts);
  } catch (err) {
    if (isMissingPathError(err)) return [];
    throw err;
  }
};

const uniqueStrings = (items: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(items.filter(Boolean))];

export const resolveArtifactInspectionPaths = (
  artifactPath: string,
  workspacePath: string,
): ReadonlyArray<string> => {
  const candidates = [artifactPath];
  const normalized = artifactPath.replace(/\\/g, "/");
  const marker = "/.receipt/factory/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    candidates.push(path.join(workspacePath, ".receipt", "factory", normalized.slice(markerIndex + marker.length)));
  }
  candidates.push(path.join(workspacePath, ".receipt", "factory", path.basename(artifactPath)));
  return uniqueStrings(candidates);
};

const artifactIssueDetail = (value: unknown): string | undefined => {
  if (typeof value === "string") return clipArtifactText(value, 600);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return clipArtifactText(
    optionalTrimmedString(record.error)
      ?? optionalTrimmedString(record.message)
      ?? optionalTrimmedString(record.summary),
    600,
  );
};

const summarizeArtifactErrors = (errors: ReadonlyArray<unknown>): { readonly count: number; readonly detail?: string } => {
  const details = errors
    .map((item) => artifactIssueDetail(item))
    .filter((item): item is string => Boolean(item));
  return {
    count: errors.length,
    detail: details[0],
  };
};

export const detectArtifactIssues = async (
  workspacePath: string,
  workerArtifacts: ReadonlyArray<{
    readonly label: string;
    readonly path: string | null | undefined;
    readonly summary: string | null | undefined;
  }>,
): Promise<ReadonlyArray<FactoryArtifactIssue>> => {
  const issues: FactoryArtifactIssue[] = [];
  for (const artifact of workerArtifacts) {
    const artifactPath = artifact.path?.trim();
    if (!artifactPath || !artifactPath.toLowerCase().endsWith(".json")) continue;
    const candidates = resolveArtifactInspectionPaths(artifactPath, workspacePath);
    let raw: string | undefined;
    let resolvedPath: string | undefined;
    for (const candidatePath of candidates) {
      raw = await readTextIfPresent(candidatePath);
      if (raw) {
        resolvedPath = candidatePath;
        break;
      }
    }
    if (!raw || !resolvedPath) continue;
    if (raw.length > 1_000_000) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const status = optionalTrimmedString(record.status)?.toLowerCase();
    const errors = Array.isArray(record.errors) ? record.errors : [];
    const errorSummary = summarizeArtifactErrors(errors);
    if (errorSummary.count > 0) {
      issues.push({
        path: resolvedPath,
        summary: `${artifact.label} recorded ${errorSummary.count} captured error${errorSummary.count === 1 ? "" : "s"}.`,
        detail: errorSummary.detail,
        status: "error",
      });
      continue;
    }
    if (status === "error" || status === "failed" || status === "blocked" || status === "partial" || status === "warning") {
      issues.push({
        path: resolvedPath,
        summary: `${artifact.label} reported ${status}.`,
        detail: clipArtifactText(optionalTrimmedString(record.summary), 600),
        status: status === "warning" ? "warning" : "error",
      });
    }
  }
  return issues;
};
