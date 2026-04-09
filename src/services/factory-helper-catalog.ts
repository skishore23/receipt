import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FactoryCloudProvider } from "./factory-cloud-context";
import { resolveBunRuntime } from "../lib/runtime-paths";

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

const isMissingPathError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const pathExists = async (targetPath: string): Promise<boolean> =>
  fs.access(targetPath).then(() => true).catch((err) => {
    if (isMissingPathError(err)) return false;
    throw err;
  });

const prependPath = (dir: string, currentPath: string | undefined): string =>
  currentPath ? `${dir}${path.delimiter}${currentPath}` : dir;

const prependPaths = (entries: ReadonlyArray<string | undefined>, currentPath: string | undefined): string =>
  entries
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .reduceRight<string>((acc, entry) => prependPath(entry, acc), currentPath ?? "");

const helperRuntimeBunPathEntries = (): ReadonlyArray<string> => {
  const resolvedBun = resolveBunRuntime().trim();
  const candidates = [
    process.env.RECEIPT_BUN_BIN?.trim() ? path.dirname(process.env.RECEIPT_BUN_BIN.trim()) : undefined,
    resolvedBun && resolvedBun !== "bun" ? path.dirname(resolvedBun) : undefined,
    process.env.BUN_INSTALL?.trim() ? path.join(process.env.BUN_INSTALL.trim(), "bin") : undefined,
    process.env.HOME?.trim() ? path.join(process.env.HOME.trim(), ".bun", "bin") : undefined,
  ];
  return [...new Set(candidates.filter((entry): entry is string => Boolean(entry)))];
};

const helperRuntimeEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: prependPaths(helperRuntimeBunPathEntries(), process.env.PATH),
});

const readdirIfPresent = async (targetPath: string): Promise<ReadonlyArray<Dirent>> => {
  try {
    return await fs.readdir(targetPath, { withFileTypes: true });
  } catch (err) {
    if (isMissingPathError(err)) return [];
    throw err;
  }
};

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
    : (await readdirIfPresent(catalogRoot))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  const manifests = await Promise.all(domains.flatMap(async (domainName) => {
    const domainRoot = path.join(catalogRoot, domainName);
    const entries = await readdirIfPresent(domainRoot);
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
      "Run a matching checked-in helper first. If it answers the question, produce your result immediately.",
      "If no helper matches, run the equivalent raw CLI commands directly. Do not build a new helper just to answer a one-off question.",
      "Only create or extend a checked-in helper when the task prompt explicitly requests reusable tooling or the same query pattern has been asked before.",
      "For live cloud/account/runtime questions, rerun the matching helper and treat stored helper metadata as a starting point, not as fresh evidence.",
      "Helper manifests list required args, required context, and example invocations so the current packet can expose what each helper needs before you decide whether to use it.",
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
    `Helper runner: ${context.runnerPath}`,
    ...context.guidance.map((item) => `- ${item}`),
    "",
    "### Escalation order (follow strictly)",
    "1. Run a selected helper below if one matches. A single helper run that answers the question is the ideal outcome.",
    "2. If no helper matches, check whether an existing helper can be extended with a small RESOURCE_SPECS addition (a few lines). Extend it, run it, and answer.",
    "3. If extending is not viable, run the equivalent raw CLI commands directly (e.g. `aws ecs list-clusters`, `kubectl get pods`). Answer from the CLI output.",
    "4. Only create a new helper from scratch when the task prompt explicitly asks for reusable tooling.",
    "5. Never spend more than 2 tool calls deciding which path to take. Pick one and execute.",
  ];
  if (context.selectedHelpers.length === 0) {
    lines.push("");
    lines.push("No checked-in helper matched this task. Follow steps 2-4 above.");
    lines.push("Do not invent a runtime-local `.receipt/factory/*.sh` script.");
  } else {
    lines.push("");
    lines.push("Selected helpers for this scope:");
    for (const helper of context.selectedHelpers) {
      lines.push(`- helper: ${helper.id} | ${helper.description} | tags ${helper.tags.join(", ")}`);
      lines.push(`  manifest: ${helper.manifestPath}`);
      lines.push(`  entrypoint: ${helper.entrypointPath}`);
      if (helper.requiredArgs.length > 0) lines.push(`  required args: ${helper.requiredArgs.join(", ")}`);
      lines.push(...helper.requiredContext.map((item) => `  context: ${item}`));
      lines.push(...helper.examples.slice(0, 2).map((item) =>
        `  example: python3 ${context.runnerPath} run --provider ${helper.provider} --json ${helper.id} -- ${item}`));
    }
    lines.push("- Stop once one or two helper runs produce enough evidence to answer. Record commands in report.scriptsRun.");
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
      env: helperRuntimeEnv(),
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
