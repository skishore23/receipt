import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { stableStringify } from "../prompts/hash.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf-8").digest("hex");

const PROFILE_DIR = "profiles";

export type FactoryChatProfileObjectiveWorktreeMode = "required" | "forbidden";
export type FactoryChatProfileObjectiveValidationMode = "repo_profile" | "none";
export type FactoryChatProfileCapability =
  | "memory.read"
  | "memory.write"
  | "skill.read"
  | "status.read"
  | "async.dispatch"
  | "async.control"
  | "objective.control"
  | "profile.handoff";

export type FactoryChatProfileObjectiveManifest = {
  readonly allowedWorkers?: ReadonlyArray<string>;
  readonly defaultWorker?: string;
  readonly worktreeModeByWorker?: Readonly<Record<string, FactoryChatProfileObjectiveWorktreeMode>>;
  readonly validation?: FactoryChatProfileObjectiveValidationMode;
  readonly maxParallelChildren?: number;
  readonly allowObjectiveCreation?: boolean;
};

export type FactoryChatProfileObjectivePolicyManifest = {
  readonly allowedWorkerTypes?: ReadonlyArray<string>;
  readonly defaultWorkerType?: string;
  readonly worktreeModeByWorker?: Readonly<Record<string, FactoryChatProfileObjectiveWorktreeMode>>;
  readonly defaultValidationMode?: FactoryChatProfileObjectiveValidationMode;
  readonly maxParallelChildren?: number;
  readonly allowObjectiveCreation?: boolean;
};

export type FactoryChatResolvedObjectivePolicy = {
  readonly allowedWorkerTypes: ReadonlyArray<string>;
  readonly defaultWorkerType: string;
  readonly worktreeModeByWorker: Readonly<Record<string, FactoryChatProfileObjectiveWorktreeMode>>;
  readonly defaultValidationMode: FactoryChatProfileObjectiveValidationMode;
  readonly maxParallelChildren: number;
  readonly allowObjectiveCreation: boolean;
};

export type FactoryChatProfileManifest = {
  readonly id?: string;
  readonly label?: string;
  readonly enabled?: boolean;
  readonly default?: boolean;
  readonly imports?: ReadonlyArray<string>;
  readonly capabilities?: ReadonlyArray<string>;
  readonly toolAllowlist?: ReadonlyArray<string>;
  readonly handoffTargets?: ReadonlyArray<string>;
  readonly routeHints?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<string>;
  readonly mode?: "interactive" | "supervisor";
  readonly discoveryBudget?: number;
  readonly suspendOnAsyncChild?: boolean;
  readonly allowPollingWhileChildRunning?: boolean;
  readonly finalWhileChildRunning?: "allow" | "waiting_message" | "reject";
  readonly childDedupe?: "none" | "by_run_and_prompt";
  readonly orchestration?: FactoryChatProfileOrchestrationManifest;
  readonly objective?: FactoryChatProfileObjectiveManifest;
  readonly objectivePolicy?: FactoryChatProfileObjectivePolicyManifest;
};

type FactoryChatNormalizedProfileManifest = {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly default?: boolean;
  readonly imports: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<FactoryChatProfileCapability>;
  readonly toolAllowlist: ReadonlyArray<string>;
  readonly handoffTargets: ReadonlyArray<string>;
  readonly routeHints: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly orchestration: FactoryChatProfileOrchestrationManifest;
  readonly objectivePolicy: FactoryChatProfileObjectivePolicyManifest;
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
  readonly capabilities: ReadonlyArray<FactoryChatProfileCapability>;
  readonly toolAllowlist: ReadonlyArray<string>;
  readonly handoffTargets: ReadonlyArray<string>;
  readonly routeHints: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly orchestration: FactoryChatProfileOrchestrationManifest;
  readonly objectivePolicy: FactoryChatProfileObjectivePolicyManifest;
  readonly dirPath: string;
  readonly mdPath: string;
  readonly mdBody: string;
  readonly mdHash: string;
};

export type FactoryChatResolvedProfile = {
  readonly repoRoot: string;
  readonly profileRoot: string;
  readonly root: FactoryChatProfile;
  readonly imports: ReadonlyArray<FactoryChatProfile>;
  readonly stack: ReadonlyArray<FactoryChatProfile>;
  readonly capabilities: ReadonlyArray<FactoryChatProfileCapability>;
  readonly toolAllowlist: ReadonlyArray<string>;
  readonly handoffTargets: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly orchestration: FactoryChatResolvedOrchestrationPolicy;
  readonly objectivePolicy: FactoryChatResolvedObjectivePolicy;
  readonly selectionReason: string;
  readonly resolvedHash: string;
  readonly systemPrompt: string;
  readonly promptPath: string;
  readonly promptHash: string;
  readonly profilePaths: ReadonlyArray<string>;
  readonly fileHashes: Readonly<Record<string, string>>;
};

const unique = (items: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(items.filter(Boolean))];

const PROFILE_CAPABILITY_TOOLS = {
  "memory.read": ["memory.read", "memory.search", "memory.summarize"],
  "memory.write": ["memory.commit", "memory.diff"],
  "skill.read": ["skill.read"],
  "status.read": ["agent.status", "jobs.list", "repo.status", "codex.status", "codex.logs", "factory.status", "factory.output", "factory.receipts"],
  "async.dispatch": ["codex.run", "agent.delegate"],
  "async.control": ["job.control"],
  "objective.control": ["factory.dispatch"],
  "profile.handoff": ["profile.handoff"],
} as const satisfies Record<FactoryChatProfileCapability, ReadonlyArray<string>>;

const FACTORY_OBJECTIVE_WORKTREE_DEFAULTS = {
  codex: "required",
  infra: "required",
  agent: "forbidden",
} as const satisfies Record<string, FactoryChatProfileObjectiveWorktreeMode>;

const DEFAULT_FACTORY_OBJECTIVE_POLICY: FactoryChatResolvedObjectivePolicy = {
  allowedWorkerTypes: Object.keys(FACTORY_OBJECTIVE_WORKTREE_DEFAULTS),
  defaultWorkerType: "codex",
  worktreeModeByWorker: FACTORY_OBJECTIVE_WORKTREE_DEFAULTS,
  defaultValidationMode: "repo_profile",
  maxParallelChildren: 4,
  allowObjectiveCreation: true,
};

const ensureProfileDir = (profileRoot: string): string =>
  path.join(profileRoot, PROFILE_DIR);

const normalizeHintText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const normalizeCapabilities = (raw: ReadonlyArray<string> | undefined): ReadonlyArray<FactoryChatProfileCapability> =>
  unique(Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : []).map((item) => {
      if (item === "repo.read" || item === "repo.write") {
        throw new Error(`factory profile capability '${item}' is no longer allowed; Factory profiles are orchestration-only and must use status, memory, dispatch, and objective tools instead`);
      }
      if (item in PROFILE_CAPABILITY_TOOLS) return item as FactoryChatProfileCapability;
      throw new Error(`unknown factory profile capability '${item}'`);
    });

const expandCapabilitiesToTools = (
  capabilities: ReadonlyArray<FactoryChatProfileCapability>,
): ReadonlyArray<string> =>
  unique(capabilities.flatMap((capability) => [...PROFILE_CAPABILITY_TOOLS[capability]]));

const normalizeObjectiveWorktreeMode = (
  value: unknown,
): FactoryChatProfileObjectiveWorktreeMode | undefined =>
  value === "required" || value === "forbidden" ? value : undefined;

const normalizeObjectivePolicyManifest = (
  raw: FactoryChatProfileObjectivePolicyManifest | undefined,
): FactoryChatProfileObjectivePolicyManifest => {
  const allowedWorkerTypes = unique(Array.isArray(raw?.allowedWorkerTypes)
    ? raw.allowedWorkerTypes.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase())
    : []);
  const defaultWorkerType = typeof raw?.defaultWorkerType === "string"
    ? raw.defaultWorkerType.trim().toLowerCase() || undefined
    : undefined;
  const worktreeModeByWorker = Object.fromEntries(
    Object.entries(raw?.worktreeModeByWorker ?? {})
      .map(([workerType, mode]) => [workerType.trim().toLowerCase(), normalizeObjectiveWorktreeMode(mode)] as const)
      .filter((entry): entry is readonly [string, FactoryChatProfileObjectiveWorktreeMode] => Boolean(entry[0]) && Boolean(entry[1])),
  );
  const defaultValidationMode = raw?.defaultValidationMode === "none" || raw?.defaultValidationMode === "repo_profile"
    ? raw.defaultValidationMode
    : undefined;
  const maxParallelChildren = typeof raw?.maxParallelChildren === "number" && Number.isFinite(raw.maxParallelChildren)
    ? Math.max(1, Math.min(Math.floor(raw.maxParallelChildren), 8))
    : undefined;
  return {
    allowedWorkerTypes: allowedWorkerTypes.length > 0 ? allowedWorkerTypes : undefined,
    defaultWorkerType,
    worktreeModeByWorker: Object.keys(worktreeModeByWorker).length > 0 ? worktreeModeByWorker : undefined,
    defaultValidationMode,
    maxParallelChildren,
    allowObjectiveCreation: typeof raw?.allowObjectiveCreation === "boolean" ? raw.allowObjectiveCreation : undefined,
  };
};

const normalizeObjectiveManifest = (
  raw: FactoryChatProfileObjectiveManifest | undefined,
): FactoryChatProfileObjectivePolicyManifest =>
  normalizeObjectivePolicyManifest(raw ? {
    allowedWorkerTypes: raw.allowedWorkers,
    defaultWorkerType: raw.defaultWorker,
    worktreeModeByWorker: raw.worktreeModeByWorker,
    defaultValidationMode: raw.validation,
    maxParallelChildren: raw.maxParallelChildren,
    allowObjectiveCreation: raw.allowObjectiveCreation,
  } : undefined);

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

const normalizeOrchestrationShorthand = (
  raw: FactoryChatProfileManifest,
): FactoryChatProfileOrchestrationManifest =>
  normalizeOrchestrationManifest({
    executionMode: raw.mode,
    discoveryBudget: raw.discoveryBudget,
    suspendOnAsyncChild: raw.suspendOnAsyncChild,
    allowPollingWhileChildRunning: raw.allowPollingWhileChildRunning,
    finalWhileChildRunning: raw.finalWhileChildRunning,
    childDedupe: raw.childDedupe,
  });

const mergeOrchestrationManifestEntries = (
  merged: FactoryChatProfileOrchestrationManifest,
  next: FactoryChatProfileOrchestrationManifest,
): FactoryChatProfileOrchestrationManifest => ({
  executionMode: next.executionMode ?? merged.executionMode,
  discoveryBudget: next.discoveryBudget ?? merged.discoveryBudget,
  suspendOnAsyncChild: next.suspendOnAsyncChild ?? merged.suspendOnAsyncChild,
  allowPollingWhileChildRunning: next.allowPollingWhileChildRunning ?? merged.allowPollingWhileChildRunning,
  finalWhileChildRunning: next.finalWhileChildRunning ?? merged.finalWhileChildRunning,
  childDedupe: next.childDedupe ?? merged.childDedupe,
});

const mergeObjectivePolicyManifestEntries = (
  merged: FactoryChatProfileObjectivePolicyManifest,
  next: FactoryChatProfileObjectivePolicyManifest,
): FactoryChatProfileObjectivePolicyManifest => ({
  allowedWorkerTypes: next.allowedWorkerTypes ?? merged.allowedWorkerTypes,
  defaultWorkerType: next.defaultWorkerType ?? merged.defaultWorkerType,
  worktreeModeByWorker: next.worktreeModeByWorker
    ? {
        ...(merged.worktreeModeByWorker ?? {}),
        ...next.worktreeModeByWorker,
      }
    : merged.worktreeModeByWorker,
  defaultValidationMode: next.defaultValidationMode ?? merged.defaultValidationMode,
  maxParallelChildren: next.maxParallelChildren ?? merged.maxParallelChildren,
  allowObjectiveCreation: next.allowObjectiveCreation ?? merged.allowObjectiveCreation,
});

const mergeOrchestrationManifests = (
  stack: ReadonlyArray<FactoryChatProfile>,
): FactoryChatProfileOrchestrationManifest =>
  stack.reduce<FactoryChatProfileOrchestrationManifest>((merged, profile) => {
    return mergeOrchestrationManifestEntries(merged, profile.orchestration);
  }, {});

const mergeObjectivePolicyManifests = (
  stack: ReadonlyArray<FactoryChatProfile>,
): FactoryChatProfileObjectivePolicyManifest =>
  stack.reduce<FactoryChatProfileObjectivePolicyManifest>((merged, profile) => {
    return mergeObjectivePolicyManifestEntries(merged, profile.objectivePolicy);
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

const resolveObjectivePolicy = (
  raw: FactoryChatProfileObjectivePolicyManifest,
): FactoryChatResolvedObjectivePolicy => {
  const worktreeModeByWorker = {
    ...FACTORY_OBJECTIVE_WORKTREE_DEFAULTS,
    ...(raw.worktreeModeByWorker ?? {}),
  };
  const fallbackDefaultWorkerType = raw.defaultWorkerType?.trim().toLowerCase() || DEFAULT_FACTORY_OBJECTIVE_POLICY.defaultWorkerType;
  const allowedWorkerTypes = unique(
    (raw.allowedWorkerTypes?.length
      ? raw.allowedWorkerTypes
      : [
          ...DEFAULT_FACTORY_OBJECTIVE_POLICY.allowedWorkerTypes,
          fallbackDefaultWorkerType,
          ...Object.keys(worktreeModeByWorker),
        ]).map((item) => item.trim().toLowerCase()),
  );
  const defaultWorkerType = allowedWorkerTypes.includes(fallbackDefaultWorkerType)
    ? fallbackDefaultWorkerType
    : allowedWorkerTypes[0] ?? DEFAULT_FACTORY_OBJECTIVE_POLICY.defaultWorkerType;
  return {
    allowedWorkerTypes,
    defaultWorkerType,
    worktreeModeByWorker,
    defaultValidationMode: raw.defaultValidationMode ?? DEFAULT_FACTORY_OBJECTIVE_POLICY.defaultValidationMode,
    maxParallelChildren: raw.maxParallelChildren ?? DEFAULT_FACTORY_OBJECTIVE_POLICY.maxParallelChildren,
    allowObjectiveCreation: raw.allowObjectiveCreation ?? DEFAULT_FACTORY_OBJECTIVE_POLICY.allowObjectiveCreation,
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

const renderCapabilities = (
  capabilities: ReadonlyArray<FactoryChatProfileCapability>,
  tools: ReadonlyArray<string>,
): string => [
  "## Capabilities",
  `- Capability groups: ${capabilities.join(", ") || "none"}`,
  `- Tool surface: ${tools.join(", ") || "none"}`,
].join("\n");

const renderObjectivePolicy = (policy: FactoryChatResolvedObjectivePolicy, skills: ReadonlyArray<string>): string => [
  "## Objective Policy",
  `- Objective creation: ${policy.allowObjectiveCreation ? "allowed" : "forbidden"}`,
  `- Default worker: ${policy.defaultWorkerType}`,
  `- Allowed workers: ${policy.allowedWorkerTypes.join(", ") || "none"}`,
  `- Max parallel children: ${String(policy.maxParallelChildren)}`,
  `- Default validation: ${policy.defaultValidationMode}`,
  `- Worktree rules: ${Object.entries(policy.worktreeModeByWorker).map(([workerType, mode]) => `${workerType}=${mode}`).join(", ") || "none"}`,
  `- Injected skills: ${skills.join(", ") || "none"}`,
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

const parseManifest = (raw: FactoryChatProfileManifest, dirName: string): FactoryChatNormalizedProfileManifest => {
  const capabilities = normalizeCapabilities(raw.capabilities);
  const explicitTools = unique(Array.isArray(raw.toolAllowlist)
    ? raw.toolAllowlist.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : []);
  return {
    id: (raw.id ?? dirName).trim(),
    label: (raw.label ?? raw.id ?? dirName).trim(),
    enabled: raw.enabled !== false,
    default: raw.default === true,
    imports: unique(Array.isArray(raw.imports) ? raw.imports.filter((item): item is string => typeof item === "string").map((item) => item.trim()) : []),
    capabilities,
    toolAllowlist: unique([...expandCapabilitiesToTools(capabilities), ...explicitTools]),
    handoffTargets: unique(Array.isArray(raw.handoffTargets) ? raw.handoffTargets.filter((item): item is string => typeof item === "string").map((item) => item.trim()) : []),
    routeHints: unique(Array.isArray(raw.routeHints) ? raw.routeHints.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()) : []),
    skills: unique(Array.isArray(raw.skills) ? raw.skills.filter((item): item is string => typeof item === "string").map((item) => item.trim()) : []),
    orchestration: mergeOrchestrationManifestEntries(
      normalizeOrchestrationManifest(raw.orchestration),
      normalizeOrchestrationShorthand(raw),
    ),
    objectivePolicy: mergeObjectivePolicyManifestEntries(
      normalizeObjectivePolicyManifest(raw.objectivePolicy),
      normalizeObjectiveManifest(raw.objective),
    ),
  };
};

const parseProfileMarkdown = (
  raw: string,
  dirName: string,
): {
  readonly manifest: FactoryChatNormalizedProfileManifest;
  readonly body: string;
} => {
  if (!raw.startsWith("---\n")) {
    return {
      manifest: parseManifest({}, dirName),
      body: raw.trim(),
    };
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error(`PROFILE.md for '${dirName}' has an unterminated frontmatter block`);
  }
  const frontmatterRaw = raw.slice(4, end).trim();
  const body = raw.slice(end + 5).trim();
  let parsed: unknown = {};
  if (frontmatterRaw) {
    try {
      parsed = JSON.parse(frontmatterRaw);
    } catch (err) {
      throw new Error(
        `PROFILE.md for '${dirName}' has invalid JSON frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`PROFILE.md for '${dirName}' frontmatter must be a JSON object`);
  }
  return {
    manifest: parseManifest(parsed as FactoryChatProfileManifest, dirName),
    body,
  };
};

export const repoKeyForRoot = (repoRoot: string): string =>
  sha256(path.resolve(repoRoot).replace(/\\/g, "/")).slice(0, 12);

export const factoryProfileStream = (repoRoot: string, profileId: string): string =>
  `agents/factory/${repoKeyForRoot(repoRoot)}/${profileId}`;

export const factoryObjectiveStream = (repoRoot: string, profileId: string, objectiveId: string): string =>
  `${factoryProfileStream(repoRoot, profileId)}/objectives/${encodeURIComponent(objectiveId)}`;

export const factoryChatSessionStream = (repoRoot: string, profileId: string, chatId: string): string =>
  `${factoryProfileStream(repoRoot, profileId)}/sessions/${encodeURIComponent(chatId)}`;

export const factoryChatStream = (repoRoot: string, profileId: string, objectiveId?: string, chatId?: string): string =>
  objectiveId?.trim()
    ? factoryObjectiveStream(repoRoot, profileId, objectiveId)
    : chatId?.trim()
      ? factoryChatSessionStream(repoRoot, profileId, chatId)
      : factoryProfileStream(repoRoot, profileId);

export const discoverFactoryChatProfiles = async (profileRoot: string): Promise<ReadonlyArray<FactoryChatProfile>> => {
  const profilesDir = ensureProfileDir(profileRoot);
  const entries = await fs.readdir(profilesDir, { withFileTypes: true }).catch(() => []);
  const loaded = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const dirPath = path.join(profilesDir, entry.name);
      const mdPath = path.join(dirPath, "PROFILE.md");
      const mdRaw = await fs.readFile(mdPath, "utf-8");
      const parsed = parseProfileMarkdown(mdRaw, entry.name);
      const manifest = parsed.manifest;
      return {
        id: manifest.id,
        label: manifest.label,
        enabled: manifest.enabled,
        isDefault: manifest.default === true,
        imports: manifest.imports ?? [],
        capabilities: manifest.capabilities ?? [],
        toolAllowlist: manifest.toolAllowlist ?? [],
        handoffTargets: manifest.handoffTargets ?? [],
        routeHints: manifest.routeHints ?? [],
        skills: manifest.skills ?? [],
        orchestration: manifest.orchestration ?? {},
        objectivePolicy: manifest.objectivePolicy ?? {},
        dirPath,
        mdPath,
        mdBody: parsed.body,
        mdHash: sha256(mdRaw),
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
  const mergedCapabilities = unique(stack.flatMap((profile) => [...profile.capabilities])) as ReadonlyArray<FactoryChatProfileCapability>;
  const mergedToolAllowlist = unique(stack.flatMap((profile) => [...profile.toolAllowlist]));
  const mergedHandoffTargets = unique(stack.flatMap((profile) => [...profile.handoffTargets]));
  const mergedSkills = unique(stack.flatMap((profile) => [...profile.skills]));
  const orchestration = resolveOrchestrationPolicy(mergeOrchestrationManifests(stack));
  const objectivePolicy = resolveObjectivePolicy(mergeObjectivePolicyManifests(stack));
  const profilePaths = stack.map((profile) => path.relative(profileRoot, profile.mdPath).replace(/\\/g, "/"));
  const fileHashes = Object.fromEntries(stack.map((profile) => [
    path.relative(profileRoot, profile.mdPath).replace(/\\/g, "/"),
    profile.mdHash,
  ]));
  const resolvedHash = sha256(stableStringify({
    root: selection.profile.id,
    imports: imported.map((profile) => profile.id),
    capabilities: mergedCapabilities,
    toolAllowlist: mergedToolAllowlist,
    skills: mergedSkills,
    objectivePolicy,
    orchestration,
    fileHashes,
  }));
  const systemPrompt = [
    "You are the active Factory profile in the product UI.",
    "Answer directly and use Receipt-native tools when needed; do not behave like a wrapper around another assistant.",
    "Use available Receipt-native tools to answer directly, inspect state, queue work, run Codex, dispatch Factory, or hand off profiles when appropriate.",
    "Do not output self-descriptive capability JSON or schema-like blobs about what you can do. The UI already projects your profile, tools, and status; answer the user's actual request directly.",
    "",
    renderOrchestrationPolicy(orchestration),
    "",
    renderCapabilities(mergedCapabilities, mergedToolAllowlist),
    "",
    renderObjectivePolicy(objectivePolicy, mergedSkills),
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
    capabilities: mergedCapabilities,
    toolAllowlist: mergedToolAllowlist,
    handoffTargets: mergedHandoffTargets,
    skills: mergedSkills,
    orchestration,
    objectivePolicy,
    selectionReason: selection.reason,
    resolvedHash,
    systemPrompt,
    promptPath: path.relative(profileRoot, selection.profile.mdPath).replace(/\\/g, "/"),
    promptHash: sha256(systemPrompt),
    profilePaths,
    fileHashes,
  };
};
