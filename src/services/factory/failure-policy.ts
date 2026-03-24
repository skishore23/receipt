import { createHash } from "node:crypto";

import type { FactoryCheckResult, FactoryState } from "../../modules/factory";

export type FactoryFailureSignature = {
  readonly digest: string;
  readonly excerpt: string;
};

const ansiRe = /\x1b\[[0-9;]*m/g;
const salientFailureLineRe = /(fail|error|enoent|eperm|expected|received|exited with code|unable to|no such file|missing)/i;

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const normalizeFactoryFailureText = (
  raw: string,
  input: { readonly worktreesDir: string; readonly repoRoot: string },
): string => {
  const worktreePrefix = `${input.worktreesDir.replace(/\\/g, "/")}/`;
  const repoRoot = input.repoRoot.replace(/\\/g, "/");
  const worktreePathRe = new RegExp(`${escapeRegex(worktreePrefix)}[^/\\s'":)]+`, "g");
  return raw
    .replace(/\r\n/g, "\n")
    .replace(ansiRe, "")
    .replace(worktreePathRe, "<worktree>")
    .replaceAll(repoRoot, "<repo>")
    .replace(/task_\d+_candidate_\d+/g, "<candidate>")
    .replace(/objective_[a-z0-9_]+/gi, "<objective>")
    .replace(/\bworker_\d+\b/g, "worker")
    .replace(/\b\d+(?:\.\d+)?ms\b/g, "<ms>")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .trim();
};

export const extractFactoryFailureExcerpt = (
  check: FactoryCheckResult,
  input: { readonly worktreesDir: string; readonly repoRoot: string },
): string => {
  const combined = normalizeFactoryFailureText(`${check.stderr}\n${check.stdout}`, input);
  const lines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("$ "))
    .filter((line) => !/^bun test v/i.test(line))
    .filter((line) => !/^\(pass\)/i.test(line));
  const salient = lines.filter((line) => salientFailureLineRe.test(line));
  const source = salient.length > 0 ? salient : lines;
  return source.slice(0, 12).join("\n").slice(0, 2_000);
};

export const buildFactoryFailureSignature = (
  check: FactoryCheckResult,
  input: { readonly worktreesDir: string; readonly repoRoot: string },
): FactoryFailureSignature => {
  const excerpt = extractFactoryFailureExcerpt(check, input);
  const digest = createHash("sha256")
    .update(`${check.command}\n${check.exitCode ?? "null"}\n${excerpt}`)
    .digest("hex")
    .slice(0, 12);
  return { digest, excerpt };
};

export const priorFactoryFailureSignatureMap = (
  state: FactoryState,
  input: { readonly worktreesDir: string; readonly repoRoot: string },
): ReadonlyMap<string, { readonly source: string; readonly excerpt: string }> => {
  const signatures = new Map<string, { readonly source: string; readonly excerpt: string }>();
  for (const candidateId of state.candidateOrder) {
    const candidate = state.candidates[candidateId];
    if (!candidate) continue;
    for (const check of candidate.checkResults) {
      if (check.ok) continue;
      const { digest, excerpt } = buildFactoryFailureSignature(check, input);
      if (!signatures.has(digest)) {
        signatures.set(digest, {
          source: `${candidate.taskId}/${candidate.candidateId}`,
          excerpt,
        });
      }
    }
  }
  for (const check of state.integration.validationResults) {
    if (check.ok) continue;
    const { digest, excerpt } = buildFactoryFailureSignature(check, input);
    if (!signatures.has(digest)) {
      signatures.set(digest, {
        source: `integration/${state.integration.activeCandidateId ?? "unknown"}`,
        excerpt,
      });
    }
  }
  return signatures;
};

export const buildInheritedFactoryFailureNote = (
  check: FactoryCheckResult,
  classification: {
    readonly digest: string;
    readonly source?: string;
  },
): string => [
  `Deterministic review note: ${check.command} matched a prior failure signature.`,
  `signature=${classification.digest}`,
  classification.source ? `source=${classification.source}` : undefined,
  `This failure is treated as inherited, not as a new regression from the current candidate.`,
].filter(Boolean).join(" ");
