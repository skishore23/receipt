import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
  readonly orchestration: {
    readonly executionMode: "interactive";
    readonly suspendOnAsyncChild: false;
    readonly allowPollingWhileChildRunning: true;
    readonly finalWhileChildRunning: "allow";
    readonly childDedupe: "none";
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
};

const REMOVED_MANIFEST_KEYS = new Set([
  "enabled",
  "imports",
  "capabilities",
  "toolAllowlist",
  "handoffTargets",
  "routeHints",
  "mode",
  "discoveryBudget",
  "suspendOnAsyncChild",
  "allowPollingWhileChildRunning",
  "finalWhileChildRunning",
  "childDedupe",
  "orchestration",
  "objective",
  "objectivePolicy",
]);

const FACTORY_TOOL_ALLOWLIST = [
  "memory.read",
  "memory.search",
  "memory.summarize",
  "memory.commit",
  "memory.diff",
  "skill.read",
  "agent.delegate",
  "agent.status",
  "jobs.list",
  "repo.status",
  "codex.status",
  "codex.logs",
  "job.control",
  "codex.run",
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

const ensureProfileDir = (profileRoot: string): string =>
  path.join(profileRoot, PROFILE_DIR);

const normalizeCloudProvider = (value: unknown): FactoryChatCloudProvider | undefined => {
  if (value === undefined) return undefined;
  if (value === "aws" || value === "gcp" || value === "azure") return value;
  throw new Error(`factory profile cloudProvider must be one of aws, gcp, or azure`);
};

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
): string => [
  "## Objective Defaults",
  `- Objective creation: ${objectivePolicy.allowObjectiveCreation ? "allowed" : "forbidden"}`,
  `- Default mode: ${objectivePolicy.defaultObjectiveMode}`,
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
  const systemPrompt = [
    "You are the active Factory profile in the product UI.",
    "Answer directly and use Receipt-native tools when needed; do not behave like a wrapper around another assistant.",
    "Sound like a real engineer with a stable point of view. Use natural conversational flow by default and only switch into workflow mechanics when the task actually needs them.",
    "Sound human. Write like an engineer talking to another person, not like a rubric, dispatcher, or workflow console. Avoid robotic fragments and canned evaluation language unless the user explicitly wants a template.",
    "Use prior transcript, receipts, and memory for facts and context, not as a template for phrasing. If older runs sound stiff or robotic, do not imitate that tone.",
    "When the user asks you to evaluate your own answer, judgment, or behavior, treat that as genuine self-reflection: answer in first person, say what you got right or wrong, and do not pivot into grading the user's prompt or handoff unless they explicitly asked for that.",
    "Use available Receipt-native tools to inspect state, dispatch Factory work, inspect receipts, review artifacts, and abort child work when needed.",
    "Profiles are orchestration-only. Do not claim this chat edited code directly.",
    "",
    ...(profileSoul ? [profileSoul, ""] : []),
    renderObjectivePolicy(root, objectivePolicy),
    ...(profileIdentity ? ["", profileIdentity] : []),
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
    toolAllowlist: [...FACTORY_TOOL_ALLOWLIST],
    handoffTargets: [],
    skills: root.skills,
    cloudProvider: root.cloudProvider,
    orchestration: {
      executionMode: "interactive",
      suspendOnAsyncChild: false,
      allowPollingWhileChildRunning: true,
      finalWhileChildRunning: "allow",
      childDedupe: "none",
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
    })),
    systemPrompt,
    promptPath,
    promptHash: sha256(systemPrompt),
    profilePaths,
    fileHashes,
  };
};
