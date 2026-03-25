import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FactoryCloudProvider } from "./factory-cloud-context";

const execFileAsync = promisify(execFile);

export const FACTORY_HELPER_RUNTIME_ROOT = "skills/factory-helper-runtime";
export const FACTORY_HELPER_RUNTIME_SKILL_PATH = `${FACTORY_HELPER_RUNTIME_ROOT}/SKILL.md`;
export const FACTORY_HELPER_AUTHORING_SKILL_PATH = "skills/factory-helper-authoring/SKILL.md";
export const FACTORY_AWS_CLI_COOKBOOK_SKILL_PATH = "skills/factory-aws-cli-cookbook/SKILL.md";
export const FACTORY_HELPER_RUNNER_RELATIVE_PATH = `${FACTORY_HELPER_RUNTIME_ROOT}/runner.py`;

const FACTORY_HELPER_CATALOG_RELATIVE_ROOT = `${FACTORY_HELPER_RUNTIME_ROOT}/catalog`;
const FACTORY_HELPER_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "aws",
  "check",
  "current",
  "describe",
  "find",
  "for",
  "from",
  "help",
  "how",
  "i",
  "in",
  "infra",
  "infrastructure",
  "is",
  "it",
  "list",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "resource",
  "resources",
  "show",
  "that",
  "the",
  "this",
  "to",
  "what",
  "which",
  "with",
]);
const FACTORY_HELPER_MAX_SELECTIONS = 3;

export type FactoryHelperManifest = {
  readonly id: string;
  readonly version: string;
  readonly provider: FactoryCloudProvider;
  readonly tags: ReadonlyArray<string>;
  readonly description: string;
  readonly entrypoint: string;
  readonly requiredArgs?: ReadonlyArray<string>;
  readonly requiredContext?: ReadonlyArray<string>;
  readonly examples?: ReadonlyArray<string>;
};

export type FactoryHelperCatalogEntry = FactoryHelperManifest & {
  readonly domain: string;
  readonly manifestPath: string;
  readonly entrypointPath: string;
};

export type FactoryHelperSelection = {
  readonly id: string;
  readonly version: string;
  readonly provider: FactoryCloudProvider;
  readonly tags: ReadonlyArray<string>;
  readonly description: string;
  readonly manifestPath: string;
  readonly entrypointPath: string;
  readonly requiredArgs: ReadonlyArray<string>;
  readonly requiredContext: ReadonlyArray<string>;
  readonly examples: ReadonlyArray<string>;
  readonly score: number;
};

export type FactoryHelperContext = {
  readonly runnerPath: string;
  readonly guidance: ReadonlyArray<string>;
  readonly selectedHelpers: ReadonlyArray<FactoryHelperSelection>;
};

export type FactoryHelperResult = {
  readonly status: string;
  readonly summary: string;
  readonly artifacts: ReadonlyArray<{
    readonly label?: string;
    readonly path?: string;
    readonly summary?: string;
  }>;
  readonly data: unknown;
  readonly capturedAt: string;
  readonly errors: ReadonlyArray<string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const pathExists = async (targetPath: string): Promise<boolean> =>
  fs.access(targetPath).then(() => true).catch(() => false);

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const keywordTokens = (value: string): ReadonlyArray<string> =>
  [...new Set(
    normalizeText(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !FACTORY_HELPER_STOP_WORDS.has(token)),
  )];

const validProvider = (value: string | undefined): value is FactoryCloudProvider =>
  value === "aws" || value === "gcp" || value === "azure";

const parseHelperManifest = async (
  manifestPath: string,
  domain: string,
): Promise<FactoryHelperCatalogEntry | undefined> => {
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const version = typeof raw.version === "string" ? raw.version.trim() : "";
    const provider = typeof raw.provider === "string" ? raw.provider.trim() : undefined;
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const entrypoint = typeof raw.entrypoint === "string" ? raw.entrypoint.trim() : "";
    const tags = Array.isArray(raw.tags)
      ? raw.tags.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
    const requiredArgs = Array.isArray(raw.requiredArgs)
      ? raw.requiredArgs.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
    const requiredContext = Array.isArray(raw.requiredContext)
      ? raw.requiredContext.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
    const examples = Array.isArray(raw.examples)
      ? raw.examples.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
    if (!id || !version || !validProvider(provider) || !description || !entrypoint) return undefined;
    const entrypointPath = path.resolve(path.dirname(manifestPath), entrypoint);
    if (!(await pathExists(entrypointPath))) return undefined;
    return {
      id,
      version,
      provider,
      tags,
      description,
      entrypoint,
      requiredArgs,
      requiredContext,
      examples,
      domain,
      manifestPath,
      entrypointPath,
    };
  } catch {
    return undefined;
  }
};

export const helperCatalogQueryText = (input: {
  readonly objectiveTitle?: string;
  readonly objectivePrompt: string;
  readonly taskTitle?: string;
  readonly taskPrompt?: string;
}): string =>
  [
    input.objectiveTitle,
    input.objectivePrompt,
    input.taskTitle,
    input.taskPrompt,
  ].filter(Boolean).join("\n");

export const loadFactoryHelperCatalog = async (
  profileRoot: string,
  domain?: string,
): Promise<ReadonlyArray<FactoryHelperCatalogEntry>> => {
  const catalogRoot = path.join(profileRoot, FACTORY_HELPER_CATALOG_RELATIVE_ROOT);
  const domains = domain
    ? [domain]
    : (await fs.readdir(catalogRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  const manifests = await Promise.all(domains.flatMap(async (domainName) => {
    const domainRoot = path.join(catalogRoot, domainName);
    const entries = await fs.readdir(domainRoot, { withFileTypes: true }).catch(() => []);
    return Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseHelperManifest(path.join(domainRoot, entry.name, "manifest.json"), domainName)));
  }));
  return manifests.flat().filter((entry): entry is FactoryHelperCatalogEntry => Boolean(entry));
};

const scoreHelperSelection = (
  entry: FactoryHelperCatalogEntry,
  input: {
    readonly provider: FactoryCloudProvider;
    readonly tokens: ReadonlyArray<string>;
  },
): number => {
  if (entry.provider !== input.provider) return 0;
  const searchable = new Set<string>([
    ...entry.tags,
    ...keywordTokens(entry.id.replace(/_/g, " ")),
    ...keywordTokens(entry.description),
  ]);
  const overlap = input.tokens.filter((token) => searchable.has(token)).length;
  if (overlap === 0) return 0;
  const genericBoost = entry.id === "aws_resource_inventory" || entry.id === "aws_account_scope" ? 2 : 0;
  return overlap * 10 + genericBoost;
};

export const loadFactoryHelperContext = async (input: {
  readonly profileRoot: string;
  readonly provider: FactoryCloudProvider | undefined;
  readonly objectiveTitle?: string;
  readonly objectivePrompt: string;
  readonly taskTitle?: string;
  readonly taskPrompt?: string;
  readonly domain?: string;
}): Promise<FactoryHelperContext | undefined> => {
  if (!input.provider) return undefined;
  const provider = input.provider;
  const queryText = helperCatalogQueryText(input);
  const tokens = keywordTokens(queryText);
  const catalog = await loadFactoryHelperCatalog(input.profileRoot, input.domain ?? "infrastructure");
  const selectedHelpers = catalog
    .map((entry) => ({
      entry,
      score: scoreHelperSelection(entry, {
        provider,
        tokens,
      }),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || left.entry.id.localeCompare(right.entry.id)
    )
    .slice(0, FACTORY_HELPER_MAX_SELECTIONS)
    .map(({ entry, score }) => ({
      id: entry.id,
      version: entry.version,
      provider: entry.provider,
      tags: entry.tags,
      description: entry.description,
      manifestPath: entry.manifestPath,
      entrypointPath: entry.entrypointPath,
      requiredArgs: entry.requiredArgs ?? [],
      requiredContext: entry.requiredContext ?? [],
      examples: entry.examples ?? [],
      score,
    }));
  return {
    runnerPath: path.join(input.profileRoot, FACTORY_HELPER_RUNNER_RELATIVE_PATH),
    guidance: [
      "Use checked-in helpers first for AWS investigations instead of generating a task-local script.",
      "If no helper matches the ask closely enough, stop and return a structured no-matching-helper outcome plus the helper you would author next.",
      "For live cloud/account/runtime questions, rerun the matching helper and treat stored helper metadata as a starting point, not as fresh evidence.",
      "Never invent helper arguments or placeholder identifiers. If a helper requires a concrete resource id and the packet, prompt, receipts, or prior helper output does not provide one, discover candidates first with a generic helper or stop and report the missing identifier.",
    ],
    selectedHelpers,
  };
};

export const renderFactoryHelperPromptSection = (
  context: FactoryHelperContext | undefined,
): ReadonlyArray<string> => {
  if (!context) return [];
  const lines = [
    "## Helper-First Execution",
    `Use the checked-in helper runner at ${context.runnerPath}.`,
    ...context.guidance.map((item) => `- ${item}`),
  ];
  if (context.selectedHelpers.length === 0) {
    lines.push("- No checked-in helper matched this task. Do not invent a runtime-local `.receipt/factory/*.sh` script. Return a structured no-matching-helper outcome and name the missing helper to author.");
  } else {
    lines.push("Selected helpers for this scope:");
    for (const helper of context.selectedHelpers) {
      lines.push(`- helper: ${helper.id} | ${helper.description} | tags ${helper.tags.join(", ")}`);
      lines.push(`- manifest: ${helper.manifestPath}`);
      lines.push(`- entrypoint: ${helper.entrypointPath}`);
      if (helper.requiredArgs.length > 0) lines.push(`- required args: ${helper.requiredArgs.join(", ")}`);
      lines.push(...helper.requiredContext.map((item) => `- context requirement: ${item}`));
      lines.push(...helper.examples.slice(0, 2).map((item) =>
        `- example: python3 ${context.runnerPath} run --provider ${helper.provider} --json ${helper.id} -- ${item}`));
    }
    lines.push("- Combine only a small number of helpers. Stop once one or two helper runs produce enough evidence to answer.");
    lines.push("- Record helper runner commands in report.scriptsRun so operators can rerun the exact path.");
  }
  lines.push("");
  return lines;
};

export const helperCatalogArtifactRefs = (
  context: FactoryHelperContext | undefined,
): ReadonlyArray<{
  readonly ref: string;
  readonly label: string;
}> => {
  if (!context) return [];
  const seen = new Set<string>();
  const refs: Array<{ readonly ref: string; readonly label: string }> = [];
  const push = (ref: string, label: string): void => {
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    refs.push({ ref, label });
  };
  push(context.runnerPath, "helper runner");
  for (const helper of context.selectedHelpers) {
    push(helper.manifestPath, "checked-in helper manifest");
    push(helper.entrypointPath, "checked-in helper entrypoint");
  }
  return refs;
};

export const runFactoryHelper = async (input: {
  readonly profileRoot: string;
  readonly helperId: string;
  readonly provider: FactoryCloudProvider;
  readonly domain?: string;
  readonly helperArgs?: ReadonlyArray<string>;
}): Promise<FactoryHelperResult> => {
  const runnerPath = path.join(input.profileRoot, FACTORY_HELPER_RUNNER_RELATIVE_PATH);
  const args = [
    runnerPath,
    "run",
    "--provider",
    input.provider,
    "--domain",
    input.domain ?? "infrastructure",
    "--json",
    input.helperId,
    "--",
    ...(input.helperArgs ?? []),
  ];
  try {
    const { stdout } = await execFileAsync("python3", args, {
      cwd: input.profileRoot,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return JSON.parse(stdout) as FactoryHelperResult;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      readonly stdout?: string;
      readonly stderr?: string;
    };
    const raw = (typeof err.stdout === "string" && err.stdout.trim()) || "";
    if (raw) {
      try {
        return JSON.parse(raw) as FactoryHelperResult;
      } catch {
        // fall through
      }
    }
    throw new Error((typeof err.stderr === "string" && err.stderr.trim()) || err.message || "helper runner failed");
  }
};
