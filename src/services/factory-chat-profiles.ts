import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { stableStringify } from "../prompts/hash.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf-8").digest("hex");

const PROFILE_DIR = "profiles";

export type FactoryChatProfileManifest = {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly default?: boolean;
  readonly imports?: ReadonlyArray<string>;
  readonly toolAllowlist?: ReadonlyArray<string>;
  readonly handoffTargets?: ReadonlyArray<string>;
  readonly routeHints?: ReadonlyArray<string>;
  readonly orchestration?: FactoryChatProfileOrchestrationManifest;
};

export type FactoryChatProfileOrchestrationManifest = {
  readonly executionMode?: "interactive" | "supervisor";
  readonly discoveryBudget?: number;
  readonly suspendOnAsyncChild?: boolean;
  readonly allowPollingWhileChildRunning?: boolean;
  readonly finalWhileChildRunning?: "allow" | "waiting_message" | "reject";
  readonly childDedupe?: "none" | "by_run_and_prompt";
};

export type FactoryChatResolvedOrchestrationPolicy = {
  readonly executionMode: "interactive" | "supervisor";
  readonly discoveryBudget?: number;
  readonly suspendOnAsyncChild: boolean;
  readonly allowPollingWhileChildRunning: boolean;
  readonly finalWhileChildRunning: "allow" | "waiting_message" | "reject";
  readonly childDedupe: "none" | "by_run_and_prompt";
};

export type FactoryChatProfile = {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly imports: ReadonlyArray<string>;
  readonly toolAllowlist: ReadonlyArray<string>;
  readonly handoffTargets: ReadonlyArray<string>;
  readonly routeHints: ReadonlyArray<string>;
  readonly orchestration: FactoryChatProfileOrchestrationManifest;
  readonly dirPath: string;
  readonly mdPath: string;
  readonly jsonPath: string;
  readonly mdBody: string;
  readonly jsonBody: FactoryChatProfileManifest;
  readonly mdHash: string;
  readonly jsonHash: string;
};

export type FactoryChatResolvedProfile = {
  readonly repoRoot: string;
  readonly profileRoot: string;
  readonly root: FactoryChatProfile;
  readonly imports: ReadonlyArray<FactoryChatProfile>;
  readonly stack: ReadonlyArray<FactoryChatProfile>;
  readonly toolAllowlist: ReadonlyArray<string>;
  readonly handoffTargets: ReadonlyArray<string>;
  readonly orchestration: FactoryChatResolvedOrchestrationPolicy;
  readonly selectionReason: string;
  readonly resolvedHash: string;
  readonly systemPrompt: string;
  readonly promptPath: string;
  readonly promptHash: string;
  readonly profilePaths: ReadonlyArray<string>;
  readonly fileHashes: Readonly<Record<string, string>>;
};

const readJsonFile = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await fs.readFile(filePath, "utf-8")) as T;

const unique = (items: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(items.filter(Boolean))];

const ensureProfileDir = (profileRoot: string): string =>
  path.join(profileRoot, PROFILE_DIR);

const normalizeHintText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const normalizeOrchestrationManifest = (
  raw: FactoryChatProfileOrchestrationManifest | undefined,
): FactoryChatProfileOrchestrationManifest => {
  const executionMode = raw?.executionMode === "supervisor" || raw?.executionMode === "interactive"
    ? raw.executionMode
    : undefined;
  const discoveryBudget = typeof raw?.discoveryBudget === "number" && Number.isFinite(raw.discoveryBudget)
    ? Math.max(0, Math.min(Math.floor(raw.discoveryBudget), 20))
    : undefined;
  const finalWhileChildRunning = raw?.finalWhileChildRunning === "waiting_message" || raw?.finalWhileChildRunning === "reject" || raw?.finalWhileChildRunning === "allow"
    ? raw.finalWhileChildRunning
    : undefined;
  const childDedupe = raw?.childDedupe === "by_run_and_prompt" || raw?.childDedupe === "none"
    ? raw.childDedupe
    : undefined;
  return {
    executionMode,
    discoveryBudget,
    suspendOnAsyncChild: typeof raw?.suspendOnAsyncChild === "boolean" ? raw.suspendOnAsyncChild : undefined,
    allowPollingWhileChildRunning: typeof raw?.allowPollingWhileChildRunning === "boolean" ? raw.allowPollingWhileChildRunning : undefined,
    finalWhileChildRunning,
    childDedupe,
  };
};

const mergeOrchestrationManifests = (
  stack: ReadonlyArray<FactoryChatProfile>,
): FactoryChatProfileOrchestrationManifest =>
  stack.reduce<FactoryChatProfileOrchestrationManifest>((merged, profile) => {
    const next = profile.orchestration;
    return {
      executionMode: next.executionMode ?? merged.executionMode,
      discoveryBudget: next.discoveryBudget ?? merged.discoveryBudget,
      suspendOnAsyncChild: next.suspendOnAsyncChild ?? merged.suspendOnAsyncChild,
      allowPollingWhileChildRunning: next.allowPollingWhileChildRunning ?? merged.allowPollingWhileChildRunning,
      finalWhileChildRunning: next.finalWhileChildRunning ?? merged.finalWhileChildRunning,
      childDedupe: next.childDedupe ?? merged.childDedupe,
    };
  }, {});

const resolveOrchestrationPolicy = (
  raw: FactoryChatProfileOrchestrationManifest,
): FactoryChatResolvedOrchestrationPolicy => {
  const executionMode = raw.executionMode ?? "interactive";
  const supervisorDefaults = executionMode === "supervisor"
    ? {
      suspendOnAsyncChild: true,
      allowPollingWhileChildRunning: false,
      finalWhileChildRunning: "waiting_message" as const,
      childDedupe: "by_run_and_prompt" as const,
    }
    : {
      suspendOnAsyncChild: false,
      allowPollingWhileChildRunning: true,
      finalWhileChildRunning: "allow" as const,
      childDedupe: "none" as const,
    };
  return {
    executionMode,
    discoveryBudget: raw.discoveryBudget,
    suspendOnAsyncChild: raw.suspendOnAsyncChild ?? supervisorDefaults.suspendOnAsyncChild,
    allowPollingWhileChildRunning: raw.allowPollingWhileChildRunning ?? supervisorDefaults.allowPollingWhileChildRunning,
    finalWhileChildRunning: raw.finalWhileChildRunning ?? supervisorDefaults.finalWhileChildRunning,
    childDedupe: raw.childDedupe ?? supervisorDefaults.childDedupe,
  };
};

const renderOrchestrationPolicy = (policy: FactoryChatResolvedOrchestrationPolicy): string => [
  "## Orchestration Policy",
  `- Execution mode: ${policy.executionMode}`,
  `- Discovery budget: ${typeof policy.discoveryBudget === "number" ? String(policy.discoveryBudget) : "unbounded"}`,
  `- Suspend on async child: ${policy.suspendOnAsyncChild ? "yes" : "no"}`,
  `- Allow polling while child running: ${policy.allowPollingWhileChildRunning ? "yes" : "no"}`,
  `- Final while child running: ${policy.finalWhileChildRunning}`,
  `- Child dedupe: ${policy.childDedupe}`,
].join("\n");

const bestRouteHintMatch = (
  profiles: ReadonlyArray<FactoryChatProfile>,
  problem: string | undefined,
): { readonly profile: FactoryChatProfile; readonly reason: string } | undefined => {
  const haystack = normalizeHintText(problem?.trim().toLowerCase() ?? "");
  if (!haystack) return undefined;
  const paddedHaystack = ` ${haystack} `;
  const scored = profiles.map((profile) => ({
    profile,
    score: profile.routeHints.reduce((total, hint) => {
      const normalizedHint = normalizeHintText(hint);
      if (!normalizedHint) return total;
      return total + (paddedHaystack.includes(` ${normalizedHint} `) ? 1 : 0);
    }, 0),
  })).sort((a, b) => b.score - a.score || Number(b.profile.isDefault) - Number(a.profile.isDefault));
  return (scored[0]?.score ?? 0) > 0
    ? { profile: scored[0]!.profile, reason: "route_hint" }
    : undefined;
};

const parseManifest = (raw: FactoryChatProfileManifest, dirName: string): FactoryChatProfileManifest => ({
  id: (raw.id ?? dirName).trim(),
  label: (raw.label ?? raw.id ?? dirName).trim(),
  enabled: raw.enabled !== false,
  default: raw.default === true,
  imports: unique(Array.isArray(raw.imports) ? raw.imports.filter((item): item is string => typeof item === "string").map((item) => item.trim()) : []),
  toolAllowlist: unique(Array.isArray(raw.toolAllowlist) ? raw.toolAllowlist.filter((item): item is string => typeof item === "string").map((item) => item.trim()) : []),
  handoffTargets: unique(Array.isArray(raw.handoffTargets) ? raw.handoffTargets.filter((item): item is string => typeof item === "string").map((item) => item.trim()) : []),
  routeHints: unique(Array.isArray(raw.routeHints) ? raw.routeHints.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()) : []),
  orchestration: normalizeOrchestrationManifest(raw.orchestration),
});

export const repoKeyForRoot = (repoRoot: string): string =>
  sha256(path.resolve(repoRoot).replace(/\\/g, "/")).slice(0, 12);

export const factoryProfileStream = (repoRoot: string, profileId: string): string =>
  `agents/factory/${repoKeyForRoot(repoRoot)}/${profileId}`;

export const factoryObjectiveStream = (repoRoot: string, profileId: string, objectiveId: string): string =>
  `${factoryProfileStream(repoRoot, profileId)}/objectives/${encodeURIComponent(objectiveId)}`;

export const factoryChatStream = (repoRoot: string, profileId: string, objectiveId?: string): string =>
  objectiveId?.trim()
    ? factoryObjectiveStream(repoRoot, profileId, objectiveId)
    : factoryProfileStream(repoRoot, profileId);

export const discoverFactoryChatProfiles = async (profileRoot: string): Promise<ReadonlyArray<FactoryChatProfile>> => {
  const profilesDir = ensureProfileDir(profileRoot);
  const entries = await fs.readdir(profilesDir, { withFileTypes: true }).catch(() => []);
  const loaded = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const dirPath = path.join(profilesDir, entry.name);
      const mdPath = path.join(dirPath, "PROFILE.md");
      const jsonPath = path.join(dirPath, "profile.json");
      const [mdBody, manifestRaw] = await Promise.all([
        fs.readFile(mdPath, "utf-8"),
        readJsonFile<FactoryChatProfileManifest>(jsonPath),
      ]);
      const manifest = parseManifest(manifestRaw, entry.name);
      return {
        id: manifest.id,
        label: manifest.label,
        enabled: manifest.enabled,
        isDefault: manifest.default === true,
        imports: manifest.imports ?? [],
        toolAllowlist: manifest.toolAllowlist ?? [],
        handoffTargets: manifest.handoffTargets ?? [],
        routeHints: manifest.routeHints ?? [],
        orchestration: manifest.orchestration ?? {},
        dirPath,
        mdPath,
        jsonPath,
        mdBody,
        jsonBody: manifest,
        mdHash: sha256(mdBody),
        jsonHash: sha256(stableStringify(manifest)),
      } satisfies FactoryChatProfile;
    }));
  return loaded
    .filter((profile) => profile.enabled)
    .sort((a, b) => a.id.localeCompare(b.id));
};

const selectProfile = (
  profiles: ReadonlyArray<FactoryChatProfile>,
  requestedId: string | undefined,
  problem: string | undefined,
  allowDefaultOverride = false,
): { readonly profile: FactoryChatProfile; readonly reason: string } => {
  const requested = requestedId?.trim();
  if (requested) {
    const match = profiles.find((profile) => profile.id === requested);
    if (!match) throw new Error(`unknown factory profile '${requested}'`);
    if (!allowDefaultOverride || !match.isDefault) {
      return { profile: match, reason: "requested" };
    }
    const routed = bestRouteHintMatch(profiles, problem);
    if (routed && routed.profile.id !== match.id) return routed;
    return { profile: match, reason: "requested" };
  }
  const routed = bestRouteHintMatch(profiles, problem);
  if (routed) return routed;
  return { profile: profiles.find((profile) => profile.isDefault) ?? profiles[0], reason: "default" };
};

export const resolveFactoryChatProfile = async (input: {
  readonly repoRoot: string;
  readonly profileRoot?: string;
  readonly requestedId?: string;
  readonly problem?: string;
  readonly allowDefaultOverride?: boolean;
}): Promise<FactoryChatResolvedProfile> => {
  const repoRoot = path.resolve(input.repoRoot);
  const profileRoot = path.resolve(input.profileRoot ?? repoRoot);
  const profiles = await discoverFactoryChatProfiles(profileRoot);
  if (profiles.length === 0) {
    throw new Error(`no enabled factory profiles found under ${ensureProfileDir(profileRoot)}`);
  }
  const byId = new Map(profiles.map((profile) => [profile.id, profile] as const));
  const selection = selectProfile(
    profiles,
    input.requestedId,
    input.problem,
    input.allowDefaultOverride === true,
  );
  const seen = new Set<string>();
  const imported: FactoryChatProfile[] = [];
  const walkImports = (profile: FactoryChatProfile): void => {
    for (const importId of profile.imports) {
      if (seen.has(importId)) continue;
      const importedProfile = byId.get(importId);
      if (!importedProfile) continue;
      seen.add(importId);
      walkImports(importedProfile);
      imported.push(importedProfile);
    }
  };
  walkImports(selection.profile);
  const stack = [...imported, selection.profile];
  const mergedToolAllowlist = unique(stack.flatMap((profile) => [...profile.toolAllowlist]));
  const mergedHandoffTargets = unique(stack.flatMap((profile) => [...profile.handoffTargets]));
  const orchestration = resolveOrchestrationPolicy(mergeOrchestrationManifests(stack));
  const profilePaths = stack.flatMap((profile) => [
    path.relative(profileRoot, profile.mdPath).replace(/\\/g, "/"),
    path.relative(profileRoot, profile.jsonPath).replace(/\\/g, "/"),
  ]);
  const fileHashes = Object.fromEntries(stack.flatMap((profile) => [
    [path.relative(profileRoot, profile.mdPath).replace(/\\/g, "/"), profile.mdHash],
    [path.relative(profileRoot, profile.jsonPath).replace(/\\/g, "/"), profile.jsonHash],
  ]));
  const resolvedHash = sha256(stableStringify({
    root: selection.profile.id,
    imports: imported.map((profile) => profile.id),
    fileHashes,
  }));
  const systemPrompt = [
    "You are the active Factory profile the operator is talking to.",
    "You are not a generic chat wrapper around another assistant.",
    "Use available Receipt-native tools to answer directly, inspect state, queue work, run Codex, dispatch Factory, or hand off profiles when appropriate.",
    "",
    renderOrchestrationPolicy(orchestration),
    "",
    ...imported.map((profile) => `## Imported Profile: ${profile.label}\n${profile.mdBody.trim()}`),
    `## Active Profile: ${selection.profile.label}\n${selection.profile.mdBody.trim()}`,
  ].join("\n\n");
  return {
    repoRoot,
    profileRoot,
    root: selection.profile,
    imports: imported,
    stack,
    toolAllowlist: mergedToolAllowlist,
    handoffTargets: mergedHandoffTargets,
    orchestration,
    selectionReason: selection.reason,
    resolvedHash,
    systemPrompt,
    promptPath: path.relative(profileRoot, selection.profile.mdPath).replace(/\\/g, "/"),
    promptHash: resolvedHash,
    profilePaths,
    fileHashes,
  };
};
