import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  FACTORY_DISPATCH_ACTIONS,
  FACTORY_DISPATCH_OBJECTIVE_MODES,
  type FactoryDispatchAction,
} from "../agents/factory/dispatch";

const PROFILE_DIR = "profiles";
const PROFILE_FILENAME = "PROFILE.md";
const SOUL_FILENAME = "SOUL.md";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf-8").digest("hex");

const unique = (items: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(items.filter(Boolean))];

const normalizeStringList = (value: unknown): ReadonlyArray<string> =>
  unique(Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : []);

export type FactoryChatProfileObjectiveMode = "delivery" | "investigation";
export type FactoryChatTaskExecutionMode = "worktree" | "isolated";
export type FactoryChatCloudProvider = "aws" | "gcp" | "azure";
export type FactoryChatProfileActionPolicy = {
  readonly allowedDispatchActions?: ReadonlyArray<FactoryDispatchAction>;
  readonly allowedCreateModes?: ReadonlyArray<FactoryChatProfileObjectiveMode>;
};
export type FactoryChatResolvedActionPolicy = {
  readonly allowedDispatchActions: ReadonlyArray<FactoryDispatchAction>;
  readonly allowedCreateModes: ReadonlyArray<FactoryChatProfileObjectiveMode>;
};
export type FactoryChatProfileOrchestration = {
  readonly executionMode?: "interactive" | "supervisor";
  readonly discoveryBudget?: number;
  readonly suspendOnAsyncChild?: boolean;
  readonly allowPollingWhileChildRunning?: boolean;
  readonly finalWhileChildRunning?: "allow" | "waiting_message" | "reject";
  readonly childDedupe?: "none" | "by_run_and_prompt";
};

export type FactoryChatResolvedObjectivePolicy = {
  readonly allowedWorkerTypes: ReadonlyArray<string>;
  readonly defaultWorkerType: string;
  readonly defaultTaskExecutionMode: FactoryChatTaskExecutionMode;
  readonly defaultValidationMode: "repo_profile" | "none";
  readonly defaultObjectiveMode: FactoryChatProfileObjectiveMode;
  readonly defaultSeverity: 1 | 2 | 3 | 4 | 5;
  readonly maxParallelChildren: number;
  readonly allowObjectiveCreation: boolean;
};

export type FactoryChatProfile = {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly roles: ReadonlyArray<string>;
  readonly responsibilities: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly cloudProvider?: FactoryChatCloudProvider;
  readonly defaultObjectiveMode?: FactoryChatProfileObjectiveMode;
  readonly defaultValidationMode?: "repo_profile" | "none";
  readonly defaultTaskExecutionMode?: FactoryChatTaskExecutionMode;
  readonly allowObjectiveCreation?: boolean;
  readonly actionPolicy?: FactoryChatProfileActionPolicy;
  readonly orchestration?: FactoryChatProfileOrchestration;
  readonly handoffTargets: ReadonlyArray<string>;
  readonly dirPath: string;
  readonly mdPath: string;
  readonly mdBody: string;
  readonly mdHash: string;
  readonly soulPath?: string;
  readonly soulBody?: string;
  readonly soulHash?: string;
};

export type FactoryChatResolvedProfile = {
  readonly repoRoot: string;
  readonly profileRoot: string;
  readonly root: FactoryChatProfile;
  readonly imports: ReadonlyArray<FactoryChatProfile>;
  readonly stack: ReadonlyArray<FactoryChatProfile>;
  readonly capabilities: ReadonlyArray<string>;
  readonly toolAllowlist: ReadonlyArray<string>;
  readonly handoffTargets: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly cloudProvider?: FactoryChatCloudProvider;
  readonly actionPolicy: FactoryChatResolvedActionPolicy;
  readonly orchestration: {
    readonly executionMode: "interactive" | "supervisor";
    readonly discoveryBudget?: number;
    readonly suspendOnAsyncChild: boolean;
    readonly allowPollingWhileChildRunning: boolean;
    readonly finalWhileChildRunning: "allow" | "waiting_message" | "reject";
    readonly childDedupe: "none" | "by_run_and_prompt";
  };
  readonly objectivePolicy: FactoryChatResolvedObjectivePolicy;
  readonly selectionReason: "requested" | "default";
  readonly resolvedHash: string;
  readonly systemPrompt: string;
  readonly promptPath: string;
  readonly promptHash: string;
  readonly profilePaths: ReadonlyArray<string>;
  readonly fileHashes: Readonly<Record<string, string>>;
};

type FactoryChatProfileManifest = {
  readonly id?: string;
  readonly label?: string;
  readonly default?: boolean;
  readonly roles?: ReadonlyArray<string>;
  readonly responsibilities?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<string>;
  readonly cloudProvider?: FactoryChatCloudProvider;
  readonly defaultObjectiveMode?: FactoryChatProfileObjectiveMode;
  readonly defaultValidationMode?: "repo_profile" | "none";
  readonly defaultTaskExecutionMode?: FactoryChatTaskExecutionMode;
  readonly allowObjectiveCreation?: boolean;
  readonly actionPolicy?: FactoryChatProfileActionPolicy;
  readonly orchestration?: {
    readonly executionMode?: "interactive" | "supervisor";
    readonly discoveryBudget?: number;
    readonly suspendOnAsyncChild?: boolean;
    readonly allowPollingWhileChildRunning?: boolean;
    readonly finalWhileChildRunning?: "allow" | "waiting_message" | "reject";
    readonly childDedupe?: "none" | "by_run_and_prompt";
  };
  readonly handoffTargets?: ReadonlyArray<string>;
};

const REMOVED_MANIFEST_KEYS = new Set([
  "enabled",
  "imports",
  "capabilities",
  "toolAllowlist",
  "routeHints",
  "mode",
  "discoveryBudget",
  "suspendOnAsyncChild",
  "allowPollingWhileChildRunning",
  "finalWhileChildRunning",
  "childDedupe",
  "objective",
  "objectivePolicy",
]);

const FACTORY_TOOL_ALLOWLIST = [
  "memory.read",
  "memory.search",
  "memory.summarize",
  "memory.commit",
  "memory.diff",
  "session.search",
  "session.read",
  "skill.read",
  "agent.delegate",
  "agent.status",
  "jobs.list",
  "repo.status",
  "codex.status",
  "codex.logs",
  "job.control",
  "codex.run",
  "profile.handoff",
  "factory.dispatch",
  "factory.status",
  "factory.output",
  "factory.receipts",
] as const;

const DEFAULT_FACTORY_OBJECTIVE_POLICY: FactoryChatResolvedObjectivePolicy = {
  allowedWorkerTypes: ["codex", "infra", "agent"],
  defaultWorkerType: "codex",
  defaultTaskExecutionMode: "worktree",
  defaultValidationMode: "repo_profile",
  defaultObjectiveMode: "delivery",
  defaultSeverity: 1,
  maxParallelChildren: 20,
  allowObjectiveCreation: true,
};

const DEFAULT_FACTORY_ACTION_POLICY: FactoryChatResolvedActionPolicy = {
  allowedDispatchActions: [...FACTORY_DISPATCH_ACTIONS],
  allowedCreateModes: [...FACTORY_DISPATCH_OBJECTIVE_MODES],
};

const ensureProfileDir = (profileRoot: string): string =>
  path.join(profileRoot, PROFILE_DIR);

const normalizeCloudProvider = (value: unknown): FactoryChatCloudProvider | undefined => {
  if (value === undefined) return undefined;
  if (value === "aws" || value === "gcp" || value === "azure") return value;
  throw new Error(`factory profile cloudProvider must be one of aws, gcp, or azure`);
};

const normalizeEnumList = <Value extends string>(
  value: unknown,
  allowed: ReadonlyArray<Value>,
  errorPrefix: string,
): ReadonlyArray<Value> => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${errorPrefix} must be an array`);
  }
  const allowedSet = new Set<string>(allowed);
  const normalized: Value[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${errorPrefix} entries must be strings`);
    }
    const trimmed = item.trim();
    if (!allowedSet.has(trimmed)) {
      throw new Error(`${errorPrefix} contains unsupported value '${trimmed}'`);
    }
    normalized.push(trimmed as Value);
  }
  return unique(normalized) as ReadonlyArray<Value>;
};

const parseActionPolicy = (
  value: unknown,
  dirName: string,
): FactoryChatProfileActionPolicy | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`PROFILE.md for '${dirName}' actionPolicy must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  return {
    allowedDispatchActions: record.allowedDispatchActions === undefined
      ? undefined
      : normalizeEnumList(
        record.allowedDispatchActions,
        FACTORY_DISPATCH_ACTIONS,
        `PROFILE.md for '${dirName}' actionPolicy.allowedDispatchActions`,
      ),
    allowedCreateModes: record.allowedCreateModes === undefined
      ? undefined
      : normalizeEnumList(
        record.allowedCreateModes,
        FACTORY_DISPATCH_OBJECTIVE_MODES,
        `PROFILE.md for '${dirName}' actionPolicy.allowedCreateModes`,
      ),
  };
};

const resolveActionPolicy = (
  value: FactoryChatProfileActionPolicy | undefined,
): FactoryChatResolvedActionPolicy => ({
  allowedDispatchActions: value?.allowedDispatchActions
    ? [...value.allowedDispatchActions]
    : DEFAULT_FACTORY_ACTION_POLICY.allowedDispatchActions,
  allowedCreateModes: value?.allowedCreateModes
    ? [...value.allowedCreateModes]
    : DEFAULT_FACTORY_ACTION_POLICY.allowedCreateModes,
});

const parseManifest = (raw: FactoryChatProfileManifest, dirName: string): FactoryChatProfile => {
  for (const key of Object.keys(raw)) {
    if (REMOVED_MANIFEST_KEYS.has(key)) {
      throw new Error(`PROFILE.md for '${dirName}' uses removed factory profile key '${key}'`);
    }
  }
  const id = (raw.id ?? dirName).trim();
  const label = (raw.label ?? id).trim();
  if (!id) throw new Error(`PROFILE.md for '${dirName}' must define id`);
  if (!label) throw new Error(`PROFILE.md for '${dirName}' must define label`);
  return {
    id,
    label,
    isDefault: raw.default === true,
    roles: normalizeStringList(raw.roles),
    responsibilities: normalizeStringList(raw.responsibilities),
    skills: normalizeStringList(raw.skills),
    cloudProvider: normalizeCloudProvider(raw.cloudProvider),
    defaultObjectiveMode: raw.defaultObjectiveMode === "investigation" || raw.defaultObjectiveMode === "delivery"
      ? raw.defaultObjectiveMode
      : undefined,
    defaultValidationMode: raw.defaultValidationMode === "none" || raw.defaultValidationMode === "repo_profile"
      ? raw.defaultValidationMode
      : undefined,
    defaultTaskExecutionMode: raw.defaultTaskExecutionMode === "isolated" || raw.defaultTaskExecutionMode === "worktree"
      ? raw.defaultTaskExecutionMode
      : undefined,
    allowObjectiveCreation: typeof raw.allowObjectiveCreation === "boolean" ? raw.allowObjectiveCreation : undefined,
    actionPolicy: parseActionPolicy(raw.actionPolicy, dirName),
    orchestration: (() => {
      const orchestration = raw.orchestration;
      if (!orchestration || typeof orchestration !== "object" || Array.isArray(orchestration)) return undefined;
      const value = orchestration as Record<string, unknown>;
      return {
        executionMode: value.executionMode === "interactive" || value.executionMode === "supervisor" ? value.executionMode : undefined,
        discoveryBudget: typeof value.discoveryBudget === "number" && Number.isFinite(value.discoveryBudget)
          ? Math.max(0, Math.floor(value.discoveryBudget))
          : undefined,
        suspendOnAsyncChild: typeof value.suspendOnAsyncChild === "boolean" ? value.suspendOnAsyncChild : undefined,
        allowPollingWhileChildRunning: typeof value.allowPollingWhileChildRunning === "boolean" ? value.allowPollingWhileChildRunning : undefined,
        finalWhileChildRunning: value.finalWhileChildRunning === "allow" || value.finalWhileChildRunning === "waiting_message" || value.finalWhileChildRunning === "reject"
          ? value.finalWhileChildRunning
          : undefined,
        childDedupe: value.childDedupe === "none" || value.childDedupe === "by_run_and_prompt" ? value.childDedupe : undefined,
      };
    })(),
    handoffTargets: normalizeStringList(raw.handoffTargets),
    dirPath: "",
    mdPath: "",
    mdBody: "",
    mdHash: "",
  };
};

const parseProfileMarkdown = (
  raw: string,
  dirName: string,
): {
  readonly manifest: FactoryChatProfile;
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

const renderObjectivePolicy = (
  profile: FactoryChatProfile,
  objectivePolicy: FactoryChatResolvedObjectivePolicy,
  actionPolicy: FactoryChatResolvedActionPolicy,
): string => [
  "## Objective Defaults",
  `- Objective creation: ${objectivePolicy.allowObjectiveCreation ? "allowed" : "forbidden"}`,
  `- Default mode: ${objectivePolicy.defaultObjectiveMode}`,
  `- Allowed create modes: ${actionPolicy.allowedCreateModes.join(", ")}`,
  `- Allowed dispatch actions: ${actionPolicy.allowedDispatchActions.join(", ")}`,
  `- Default validation: ${objectivePolicy.defaultValidationMode}`,
  `- Default task runtime: ${objectivePolicy.defaultTaskExecutionMode}`,
  `- Cloud provider: ${profile.cloudProvider ?? "unspecified"}`,
  `- Skills: ${profile.skills.join(", ") || "none"}`,
  `- Worker model: up to ${objectivePolicy.maxParallelChildren} parallel child runs, default worker ${objectivePolicy.defaultWorkerType}`,
].join("\n");

const renderProfileIdentity = (profile: FactoryChatProfile): string | undefined => {
  const sections: string[] = [];
  if (profile.roles.length > 0) {
    sections.push([
      "## Roles",
      ...profile.roles.map((role) => `- ${role}`),
    ].join("\n"));
  }
  if (profile.responsibilities.length > 0) {
    sections.push([
      "## Responsibilities",
      ...profile.responsibilities.map((responsibility) => `- ${responsibility}`),
    ].join("\n"));
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
};

const renderProfileHandoffs = (profile: FactoryChatProfile): string | undefined => {
  if (profile.handoffTargets.length === 0) return undefined;
  return [
    "## Profile Handoffs",
    `- Allowed handoff targets: ${profile.handoffTargets.join(", ")}`,
    "- Use `profile.handoff` only when another profile should own the next turn of work.",
    "- Always include reason, goal, current state, and done-when context in the handoff.",
  ].join("\n");
};

const renderProfileSoul = (profile: FactoryChatProfile): string | undefined => {
  const soulBody = profile.soulBody?.trim();
  if (!soulBody) return undefined;
  return [
    "## Personality and Voice",
    "Treat the following as the engineer's conversational identity. Keep the flow natural, human, and specific rather than sounding like workflow middleware.",
    "Let this voice evolve with the active profile and relevant skills instead of flattening into generic assistant prose, canned praise, or status-console fragments.",
    "",
    soulBody,
  ].join("\n");
};

export const repoKeyForRoot = (repoRoot: string): string =>
  sha256(path.resolve(repoRoot).replace(/\\/g, "/")).slice(0, 12);

export const factoryProfileStream = (repoRoot: string, profileId: string): string =>
  `agents/factory/${repoKeyForRoot(repoRoot)}/${profileId}`;

export const factoryObjectiveStream = (repoRoot: string, profileId: string, objectiveId: string): string =>
  `${factoryProfileStream(repoRoot, profileId)}/objectives/${encodeURIComponent(objectiveId)}`;

export const factoryChatSessionStream = (repoRoot: string, profileId: string, chatId: string): string =>
  `${factoryProfileStream(repoRoot, profileId)}/sessions/${encodeURIComponent(chatId)}`;

export const factoryChatStream = (repoRoot: string, profileId: string, objectiveId?: string): string =>
  objectiveId?.trim()
    ? factoryObjectiveStream(repoRoot, profileId, objectiveId)
    : factoryProfileStream(repoRoot, profileId);

export const discoverFactoryChatProfiles = async (profileRoot: string): Promise<ReadonlyArray<FactoryChatProfile>> => {
  const profilesDir = ensureProfileDir(profileRoot);
  const entries = await fs.readdir(profilesDir).catch((err) => {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw err;
  });
  const loaded: Array<FactoryChatProfile | undefined> = await Promise.all(entries.map(async (entry): Promise<FactoryChatProfile | undefined> => {
      const dirPath = path.join(profilesDir, entry);
      const stat = await fs.stat(dirPath).catch((err) => {
        if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
        throw err;
      });
      if (!stat?.isDirectory()) return undefined;
      const mdPath = path.join(dirPath, PROFILE_FILENAME);
      const mdRaw = await fs.readFile(mdPath, "utf-8");
      const soulPath = path.join(dirPath, SOUL_FILENAME);
      const soulRaw = await fs.readFile(soulPath, "utf-8").catch((err) => {
        if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
        throw err;
      });
      const parsed = parseProfileMarkdown(mdRaw, entry);
      return {
        ...parsed.manifest,
        dirPath,
        mdPath,
        mdBody: parsed.body,
        mdHash: sha256(mdRaw),
        soulPath: soulRaw ? soulPath : undefined,
        soulBody: soulRaw?.trim() || undefined,
        soulHash: soulRaw ? sha256(soulRaw) : undefined,
      } satisfies FactoryChatProfile;
    }));
  return loaded
    .filter((profile): profile is FactoryChatProfile => profile !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
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
    throw new Error(`no factory profiles found under ${ensureProfileDir(profileRoot)}`);
  }
  const requested = input.requestedId?.trim();
  const root = requested
    ? profiles.find((profile) => profile.id === requested)
    : profiles.find((profile) => profile.isDefault) ?? profiles[0];
  if (!root) {
    throw new Error(`unknown factory profile '${requested}'`);
  }
  const objectivePolicy: FactoryChatResolvedObjectivePolicy = {
    ...DEFAULT_FACTORY_OBJECTIVE_POLICY,
    defaultObjectiveMode: root.defaultObjectiveMode ?? DEFAULT_FACTORY_OBJECTIVE_POLICY.defaultObjectiveMode,
    defaultValidationMode: root.defaultValidationMode ?? DEFAULT_FACTORY_OBJECTIVE_POLICY.defaultValidationMode,
    defaultTaskExecutionMode: root.defaultTaskExecutionMode ?? DEFAULT_FACTORY_OBJECTIVE_POLICY.defaultTaskExecutionMode,
    allowObjectiveCreation: root.allowObjectiveCreation ?? DEFAULT_FACTORY_OBJECTIVE_POLICY.allowObjectiveCreation,
  };
  const actionPolicy = resolveActionPolicy(root.actionPolicy);
  const promptPath = path.relative(profileRoot, root.mdPath).replace(/\\/g, "/");
  const soulPath = root.soulPath
    ? path.relative(profileRoot, root.soulPath).replace(/\\/g, "/")
    : undefined;
  const fileHashes = {
    [promptPath]: root.mdHash,
    ...(soulPath && root.soulHash ? { [soulPath]: root.soulHash } : {}),
  };
  const profilePaths = soulPath ? [promptPath, soulPath] : [promptPath];
  const profileSoul = renderProfileSoul(root);
  const profileIdentity = renderProfileIdentity(root);
  const profileHandoffs = renderProfileHandoffs(root);
  const systemPrompt = [
    "You are the active Factory profile in the product UI.",
    "Answer directly and use Receipt-native tools when needed; do not behave like a wrapper around another assistant.",
    "Sound like a real engineer with a stable point of view. Use natural conversational flow by default and only switch into workflow mechanics when the task actually needs them.",
    "Sound human. Write like an engineer talking to another person, not like a rubric, dispatcher, or workflow console. Avoid robotic fragments and canned evaluation language unless the user explicitly wants a template.",
    "Treat PROFILE.md and SOUL.md as the primary source of personality, tone, and conversational behavior for the active profile. If a generic workflow phrase conflicts with that voice, prefer the profile voice.",
    "Use prior transcript, receipts, and memory for facts and context, not as a template for phrasing. If older runs sound stiff or robotic, do not imitate that tone.",
    "If work is already running, say that plainly in natural language and keep the conversation open. Prefer wording like 'I'm running that now, and we can keep talking while it finishes' over status-console phrasing.",
    "Format replies for the product chat UI. Lead with the answer, keep sections scannable, and choose the response shape that best fits the question. Present structured data clearly in markdown instead of dumping raw JSON.",
    "Do not dump raw JSON, receipt payloads, or command output into chat when you can summarize and format them first. If exact values matter, present them cleanly in markdown.",
    "Let the active profile's role, priorities, and risk posture shape the voice. Infrastructure answers should sound like an infra engineer, software answers should sound like a software engineer, and generalist answers should sound like a pragmatic tech lead.",
    "When the user asks you to evaluate your own answer, judgment, or behavior, treat that as genuine self-reflection: answer in first person, say what you got right or wrong, and do not pivot into grading the user's prompt or handoff unless they explicitly asked for that.",
    "Use available Receipt-native tools to inspect state, dispatch Factory work, inspect receipts, review artifacts, and abort child work when needed.",
    "Profiles are orchestration-only. Do not claim this chat edited code directly.",
    "",
    ...(profileSoul ? [profileSoul, ""] : []),
    renderObjectivePolicy(root, objectivePolicy, actionPolicy),
    ...(profileIdentity ? ["", profileIdentity] : []),
    ...(profileHandoffs ? ["", profileHandoffs] : []),
    "",
    `## Active Profile: ${root.label}`,
    root.mdBody.trim(),
  ].join("\n\n");
  return {
    repoRoot,
    profileRoot,
    root,
    imports: [],
    stack: [root],
    capabilities: [],
    toolAllowlist: root.handoffTargets.length > 0
      ? [...FACTORY_TOOL_ALLOWLIST]
      : FACTORY_TOOL_ALLOWLIST.filter((tool) => tool !== "profile.handoff"),
    handoffTargets: root.handoffTargets,
    skills: root.skills,
    cloudProvider: root.cloudProvider,
    actionPolicy,
    orchestration: {
      executionMode: root.orchestration?.executionMode ?? "interactive",
      discoveryBudget: root.orchestration?.discoveryBudget,
      suspendOnAsyncChild: root.orchestration?.suspendOnAsyncChild ?? false,
      allowPollingWhileChildRunning: root.orchestration?.allowPollingWhileChildRunning ?? true,
      finalWhileChildRunning: root.orchestration?.finalWhileChildRunning ?? "allow",
      childDedupe: root.orchestration?.childDedupe ?? "none",
    },
    objectivePolicy,
    selectionReason: requested ? "requested" : "default",
    resolvedHash: sha256(JSON.stringify({
      profileId: root.id,
      promptPath,
      promptHash: root.mdHash,
      soulPath,
      soulHash: root.soulHash,
      objectivePolicy,
      skills: root.skills,
      cloudProvider: root.cloudProvider,
      actionPolicy,
      handoffTargets: root.handoffTargets,
      orchestration: root.orchestration,
    })),
    systemPrompt,
    promptPath,
    promptHash: sha256(systemPrompt),
    profilePaths,
    fileHashes,
  };
};

const dispatchActionLabel = (action: FactoryDispatchAction): string => {
  switch (action) {
    case "create":
      return "create objectives";
    case "react":
      return "react objective work";
    case "promote":
      return "promote objectives";
    case "cancel":
      return "cancel objectives";
    case "cleanup":
      return "clean up objective workspaces";
    case "archive":
      return "archive objectives";
  }
};

type FactoryChatActionPolicySubject = {
  readonly label: string;
  readonly actionPolicy: FactoryChatResolvedActionPolicy;
};

export const factoryChatResolvedProfileActionSubject = (
  profile: FactoryChatResolvedProfile,
): FactoryChatActionPolicySubject => ({
  label: profile.root.label,
  actionPolicy: profile.actionPolicy,
});

export const assertFactoryProfileDispatchActionAllowed = (
  profile: FactoryChatActionPolicySubject,
  action: FactoryDispatchAction,
): void => {
  if (profile.actionPolicy.allowedDispatchActions.includes(action)) return;
  throw new Error(`${profile.label} cannot ${dispatchActionLabel(action)}.`);
};

export const assertFactoryProfileCreateModeAllowed = (
  profile: FactoryChatActionPolicySubject,
  objectiveMode: FactoryChatProfileObjectiveMode,
): void => {
  if (profile.actionPolicy.allowedCreateModes.includes(objectiveMode)) return;
  throw new Error(`${profile.label} cannot create ${objectiveMode} objectives.`);
};
