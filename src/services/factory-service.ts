import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { jsonBranchStore, jsonlStore } from "../adapters/jsonl.js";
import type { JsonlQueue, QueueCommandRecord, QueueJob } from "../adapters/jsonl-queue.js";
import { type CodexExecutor, type CodexRunControl } from "../adapters/codex-executor.js";
import { HubGit, HubGitError } from "../adapters/hub-git.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import {
  DEFAULT_FACTORY_OBJECTIVE_POLICY,
  DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  buildFactoryProjection,
  decideFactory,
  factoryActivatableTasks,
  factoryReadyTasks,
  initialFactoryState,
  normalizeFactoryObjectiveProfileSnapshot,
  normalizeFactoryObjectivePolicy,
  reduceFactory,
  type FactoryBudgetState,
  type FactoryCandidateRecord,
  type FactoryObjectivePhase,
  type FactoryObjectiveSlotState,
  type FactoryRepoProfileRecord,
  type FactoryCheckResult,
  type FactoryCmd,
  type FactoryEvent,
  type FactoryNormalizedObjectivePolicy,
  type FactoryObjectiveProfileSnapshot,
  type FactoryObjectiveProfileWorktreeMode,
  type FactoryObjectiveStatus,
  type FactoryObjectivePolicy,
  type FactoryProjection,
  type FactoryState,
  type FactoryTaskRecord,
  type FactoryTaskStatus,
  type FactoryWorkerType,
  type FactoryCandidateStatus,
} from "../modules/factory.js";
import { repoKeyForRoot, resolveFactoryChatProfile } from "./factory-chat-profiles.js";
import {
  buildFactoryMemoryScriptSource,
  factoryChatCodexArtifactPaths,
  type FactoryChatCodexArtifactPaths,
} from "./factory-codex-artifacts.js";
import { createRuntime, type Runtime } from "../core/runtime.js";
import { type GraphRef } from "../core/graph.js";
import { CONTROL_RECEIPT_TYPES } from "../engine/runtime/control-receipts.js";
import { makeEventId, optionalTrimmedString, requireTrimmedString, trimmedString } from "../framework/http.js";
import type { SseHub } from "../framework/sse-hub.js";
import { resolveCliInvocation } from "../lib/runtime-paths.js";
import type { JobCmd, JobEvent, JobRecord, JobState, JobStatus } from "../modules/job.js";
import {
  type FactoryAction,
  type FactoryActionTaskDraft,
  buildFactoryDecisionSet,
  summarizeFactoryAction,
} from "../engine/merge/factory-policy.js";

const execFileAsync = promisify(execFile);

const FACTORY_STREAM_PREFIX = "factory/objectives";
const DEFAULT_CHECKS = ["npm run build"] as const;
const FACTORY_DATA_DIR = ".receipt/factory";
const FACTORY_SHARED_REPO_PROFILE_DIR = path.join("factory", "repo-profile");
const DEFAULT_FACTORY_PROFILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FACTORY_CONTROL_AGENT_ID = "factory-control";
const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const SUPPORTED_WORKER_TYPES = new Set<FactoryWorkerType>(["codex", "agent", "infra"]);

const resolveRepoRoot = (repoRoot?: string): string =>
  repoRoot?.trim()
  || process.env.RECEIPT_REPO_ROOT?.trim()
  || process.env.HUB_REPO_ROOT?.trim()
  || process.cwd();
const DISCOVERY_ONLY_RE = /\b(search|locate|identify|inspect|find|trace|look\s+for|determine|record)\b/i;
const DIFF_PRODUCING_RE = /\b(edit|change|update|remove|add|implement|write|modify|refactor|fix|test|verify|run|create)\b/i;
const FACTORY_TASK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["approved", "changes_requested", "blocked"] },
    summary: { type: "string" },
    handoff: { type: "string" },
  },
  required: ["outcome", "summary", "handoff"],
  additionalProperties: false,
} as const;
const FACTORY_TASK_CODEX_MODEL =
  process.env.RECEIPT_FACTORY_TASK_MODEL?.trim()
  || process.env.HUB_FACTORY_TASK_MODEL?.trim()
  || "gpt-5.4-mini";

const shortHash = (value: string | undefined): string => value ? value.slice(0, 8) : "none";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const requireNonEmpty = (value: unknown, message: string): string => {
  try {
    return requireTrimmedString(value, message);
  } catch {
    throw new FactoryServiceError(400, message);
  }
};

const fileExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const repoUsesBun = async (
  repoRoot: string,
  packageJson: { readonly packageManager?: string } | undefined,
): Promise<boolean> => {
  const packageManager = packageJson?.packageManager?.trim().toLowerCase();
  if (packageManager?.startsWith("bun@")) return true;
  return await fileExists(path.join(repoRoot, "bun.lock"))
    || await fileExists(path.join(repoRoot, "bun.lockb"));
};

const scriptCommand = (scriptName: string, bunFirst: boolean): string =>
  `${bunFirst ? "bun" : "npm"} run ${scriptName}`;
const clipText = (value: string | undefined, max = 280): string | undefined => {
  if (!value) return undefined;
  const trimmed = trimmedString(value);
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};
const safeWorkspacePart = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
const tailText = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value.trimEnd() : `…${value.slice(value.length - maxChars).trimEnd()}`;
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const prependPath = (dir: string, currentPath: string | undefined): string =>
  currentPath ? `${dir}${path.delimiter}${currentPath}` : dir;
const uniqueChecks = (checks?: ReadonlyArray<string>): ReadonlyArray<string> => {
  const source = (checks ?? DEFAULT_CHECKS)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(source)];
};
const stateRef = (ref: string, label?: string): GraphRef => ({ kind: "state", ref, label });
const fileRef = (ref: string, label?: string): GraphRef => ({ kind: "file", ref, label });
const commitRef = (ref: string, label?: string): GraphRef => ({ kind: "commit", ref, label });
const workspaceRef = (ref: string, label?: string): GraphRef => ({ kind: "workspace", ref, label });
const artifactRef = (ref: string, label?: string): GraphRef => ({ kind: "artifact", ref, label });
const isTerminalJobStatus = (status?: JobStatus | "missing"): boolean =>
  status === "completed" || status === "failed" || status === "canceled";
const isActiveJobStatus = (status?: JobStatus | "missing"): boolean =>
  status === "queued" || status === "leased" || status === "running";
const ansiRe = /\x1b\[[0-9;]*m/g;
const salientFailureLineRe = /(fail|error|enoent|eperm|expected|received|exited with code|unable to|no such file|missing)/i;

const boardSectionForObjective = (
  objective: Pick<FactoryObjectiveCard, "status" | "scheduler">,
): FactoryBoardSection => {
  if (objective.status === "completed" || objective.status === "canceled") return "completed";
  if (objective.status === "blocked" || objective.status === "failed") return "needs_attention";
  if (objective.scheduler.slotState === "queued") return "queued";
  return "active";
};

const objectiveTaskStatusPriority = (status: FactoryTaskStatus): number => {
  switch (status) {
    case "running":
      return 0;
    case "reviewing":
      return 1;
    case "ready":
      return 2;
    case "blocked":
      return 3;
    case "pending":
      return 4;
    case "approved":
      return 5;
    case "integrated":
      return 6;
    case "superseded":
      return 7;
    default:
      return 8;
  }
};

export {
  FactoryServiceError,
  type FactoryServiceOptions,
  type FactoryObjectiveInput,
  type FactoryObjectiveComposeInput,
  type FactoryQueuedJobCommand,
  type FactoryContextSources,
  type FactoryTaskView,
  type FactoryObjectiveCard,
  type FactoryObjectiveDetail,
  type FactoryComposeModel,
  type FactoryBoardSection,
  type FactoryBoardProjection,
  type FactoryLiveProjection,
  type FactoryLiveOutputTargetKind,
  type FactoryLiveOutputSnapshot,
  type FactoryDebugProjection,
  type FactoryTaskJobPayload,
  type FactoryIntegrationJobPayload,
  type FactoryObjectiveControlJobPayload,
  type FactoryObjectiveReceiptSummary,
  type FactoryObjectiveReceiptQuery,
  type FactoryRepoProfileProgress,
} from "./factory-types.js";
import {
  FactoryServiceError,
  type FactoryServiceOptions,
  type FactoryObjectiveInput,
  type FactoryObjectiveComposeInput,
  type FactoryQueuedJobCommand,
  type FactoryContextSources,
  type FactoryTaskView,
  type FactoryObjectiveCard,
  type FactoryObjectiveDetail,
  type FactoryComposeModel,
  type FactoryBoardSection,
  type FactoryBoardProjection,
  type FactoryLiveProjection,
  type FactoryLiveOutputTargetKind,
  type FactoryLiveOutputSnapshot,
  type FactoryDebugProjection,
  type FactoryTaskJobPayload,
  type FactoryIntegrationJobPayload,
  type FactoryObjectiveControlJobPayload,
  type FactoryObjectiveReceiptSummary,
  type FactoryObjectiveReceiptQuery,
  type FactoryRepoProfileProgress,
} from "./factory-types.js";

class FactoryStaleObjectiveError extends Error {
  readonly objectiveId: string;
  readonly expectedPrev: string;

  constructor(objectiveId: string, expectedPrev: string, actualPrev?: string) {
    super(`factory objective ${objectiveId} advanced before applying a mutation (${expectedPrev} -> ${actualPrev ?? "undefined"})`);
    this.objectiveId = objectiveId;
    this.expectedPrev = expectedPrev;
  }
}








type DecomposedTaskSpec = {
  readonly taskId: string;
  readonly title: string;
  readonly prompt: string;
  readonly workerType: FactoryWorkerType;
  readonly dependsOn: ReadonlyArray<string>;
};

type FactoryRepoProfileArtifact = {
  readonly status: FactoryRepoProfileRecord["status"];
  readonly generatedAt: number;
  readonly repoSignature?: string;
  readonly inferredChecks: ReadonlyArray<string>;
  readonly generatedSkillRefs: ReadonlyArray<GraphRef>;
  readonly generatedSkillPaths: ReadonlyArray<string>;
  readonly summary: string;
};

type FactoryRepoProfilePrepareOptions = {
  readonly onProgress?: (progress: FactoryRepoProfileProgress) => void;
};

type FactoryMemoryScopeSpec = {
  readonly key: string;
  readonly scope: string;
  readonly label: string;
  readonly defaultQuery: string;
};

type FactoryContextTaskNode = {
  readonly taskId: string;
  readonly taskKind: FactoryTaskRecord["taskKind"];
  readonly title: string;
  readonly status: FactoryTaskStatus;
  readonly workerType: FactoryWorkerType;
  readonly sourceTaskId?: string;
  readonly sourceCandidateId?: string;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly candidateId?: string;
  readonly candidateStatus?: FactoryCandidateStatus;
  readonly memorySummary?: string;
  readonly children: ReadonlyArray<FactoryContextTaskNode>;
};

type FactoryContextRelatedTask = {
  readonly taskId: string;
  readonly taskKind: FactoryTaskRecord["taskKind"];
  readonly title: string;
  readonly status: FactoryTaskStatus;
  readonly workerType: FactoryWorkerType;
  readonly sourceTaskId?: string;
  readonly sourceCandidateId?: string;
  readonly relations: ReadonlyArray<"focus" | "dependency" | "dependent" | "split_source" | "split_child">;
  readonly latestSummary?: string;
  readonly blockedReason?: string;
  readonly candidateId?: string;
  readonly candidateStatus?: FactoryCandidateStatus;
  readonly memorySummary?: string;
};

type FactoryContextReceipt = {
  readonly type: string;
  readonly at: number;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly summary: string;
};

type FactoryContextObjectiveSlice = {
  readonly frontierTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly recentCompletedTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly integrationTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly recentObjectiveReceipts: ReadonlyArray<FactoryContextReceipt>;
  readonly objectiveMemorySummary?: string;
  readonly integrationMemorySummary?: string;
};

type FactoryContextPack = {
  readonly objectiveId: string;
  readonly title: string;
  readonly prompt: string;
  readonly profile: FactoryObjectiveProfileSnapshot;
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly prompt: string;
    readonly workerType: FactoryWorkerType;
    readonly status: FactoryTaskStatus;
    readonly candidateId: string;
  };
  readonly integration: {
    readonly status: FactoryState["integration"]["status"];
    readonly headCommit?: string;
    readonly activeCandidateId?: string;
    readonly conflictReason?: string;
    readonly lastSummary?: string;
  };
  readonly dependencyTree: ReadonlyArray<FactoryContextTaskNode>;
  readonly relatedTasks: ReadonlyArray<FactoryContextRelatedTask>;
  readonly candidateLineage: ReadonlyArray<{
    readonly candidateId: string;
    readonly parentCandidateId?: string;
    readonly status: FactoryCandidateStatus;
    readonly summary?: string;
    readonly headCommit?: string;
    readonly latestReason?: string;
  }>;
  readonly recentReceipts: ReadonlyArray<FactoryContextReceipt>;
  readonly objectiveSlice: FactoryContextObjectiveSlice;
  readonly memory: {
    readonly overview?: string;
    readonly objective?: string;
    readonly integration?: string;
  };
  readonly contextSources: FactoryContextSources;
};

const decompositionSchema = z.object({
  tasks: z.array(z.object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    workerType: z.string().min(1).default("codex"),
    dependsOn: z.array(z.string().min(1)).max(12).default([]),
  })).min(1).max(8),
});

const repoProfileSchema = z.object({
  summary: z.string().min(1),
  inferredChecks: z.array(z.string().min(1)).min(1).max(6).default(["npm run build"]),
  generatedSkills: z.array(z.object({
    slug: z.string().min(1).max(48),
    title: z.string().min(1).max(120),
    content: z.string().min(1),
  })).max(4).default([]),
});

const normalizeWorkerType = (value: string | undefined): FactoryWorkerType => {
  const normalized = (value ?? "codex").trim().toLowerCase() || "codex";
  return SUPPORTED_WORKER_TYPES.has(normalized) ? normalized : "codex";
};

const taskOrdinalId = (index: number): string => `task_${String(index + 1).padStart(2, "0")}`;

const objectiveStream = (objectiveId: string): string => `${FACTORY_STREAM_PREFIX}/${objectiveId}`;


export class FactoryService {
  readonly dataDir: string;
  readonly queue: JsonlQueue;
  readonly jobRuntime: Runtime<JobCmd, JobEvent, JobState>;
  readonly sse: SseHub;
  readonly codexExecutor: CodexExecutor;
  readonly memoryTools?: MemoryTools;
  readonly git: HubGit;
  readonly profileRoot: string;
  private readonly baselineCheckCache = new Map<string, Promise<{
    readonly digest: string;
    readonly excerpt: string;
  } | undefined>>();

  private readonly runtime: Runtime<FactoryCmd, FactoryEvent, FactoryState>;
  private readonly llmStructured?: FactoryServiceOptions["llmStructured"];
  private objectiveProjectionVersion = 0;
  private objectiveListCache?: {
    readonly version: number;
    readonly cards: ReadonlyArray<FactoryObjectiveCard>;
  };
  private readonly objectiveCardCache = new Map<string, {
    readonly key: string;
    readonly card: FactoryObjectiveCard;
  }>();

  constructor(opts: FactoryServiceOptions) {
    this.dataDir = opts.dataDir;
    this.queue = opts.queue;
    this.jobRuntime = opts.jobRuntime;
    this.sse = opts.sse;
    this.codexExecutor = opts.codexExecutor;
    this.memoryTools = opts.memoryTools;
    this.llmStructured = opts.llmStructured;
    this.git = new HubGit({
      dataDir: opts.dataDir,
      repoRoot: resolveRepoRoot(opts.repoRoot),
    });
    this.profileRoot = path.resolve(opts.profileRoot ?? DEFAULT_FACTORY_PROFILE_ROOT);
    this.runtime = createRuntime<FactoryCmd, FactoryEvent, FactoryState>(
      jsonlStore<FactoryEvent>(opts.dataDir),
      jsonBranchStore(opts.dataDir),
      decideFactory,
      reduceFactory,
      initialFactoryState,
    );
  }

  async ensureBootstrap(): Promise<void> {
    await this.git.ensureReady();
  }

  projectionVersion(): number {
    return this.objectiveProjectionVersion;
  }

  private invalidateObjectiveProjection(objectiveId?: string): void {
    this.objectiveProjectionVersion += 1;
    this.objectiveListCache = undefined;
    if (objectiveId) {
      this.objectiveCardCache.delete(objectiveId);
    } else {
      this.objectiveCardCache.clear();
    }
  }

  private objectiveArtifactsDir(objectiveId: string): string {
    return path.join(this.dataDir, "factory", "artifacts", objectiveId);
  }

  private objectiveProfileArtifactPath(objectiveId: string): string {
    return path.join(this.objectiveArtifactsDir(objectiveId), "profile.snapshot.json");
  }

  private objectiveSkillSelectionArtifactPath(objectiveId: string): string {
    return path.join(this.objectiveArtifactsDir(objectiveId), "profile.skills.json");
  }

  private normalizeProfileWorkerType(
    profile: FactoryObjectiveProfileSnapshot,
    requestedWorkerType: string | undefined,
  ): FactoryWorkerType {
    const requested = normalizeWorkerType(requestedWorkerType);
    const requestedMode = profile.objectivePolicy.worktreeModeByWorker[requested] ?? "required";
    if (
      profile.objectivePolicy.allowedWorkerTypes.includes(requested)
      && requestedMode !== "forbidden"
    ) {
      return requested;
    }
    const fallback = normalizeWorkerType(String(profile.objectivePolicy.defaultWorkerType));
    const fallbackMode = profile.objectivePolicy.worktreeModeByWorker[fallback] ?? "required";
    if (
      profile.objectivePolicy.allowedWorkerTypes.includes(fallback)
      && fallbackMode !== "forbidden"
    ) {
      return fallback;
    }
    const codex = normalizeWorkerType("codex");
    if (profile.objectivePolicy.allowedWorkerTypes.includes(codex)) return codex;
    return normalizeWorkerType(String(DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.defaultWorkerType));
  }

  private objectiveProfileForState(state: FactoryState): FactoryObjectiveProfileSnapshot {
    return normalizeFactoryObjectiveProfileSnapshot(state.profile);
  }

  private objectiveAllowsWorker(state: FactoryState, workerType: string | undefined): boolean {
    const normalized = normalizeWorkerType(workerType);
    return this.objectiveProfileForState(state).objectivePolicy.allowedWorkerTypes.includes(normalized);
  }

  private objectiveWorktreeMode(
    state: FactoryState,
    workerType: string | undefined,
  ): FactoryObjectiveProfileWorktreeMode {
    const normalized = normalizeWorkerType(workerType);
    return this.objectiveProfileForState(state).objectivePolicy.worktreeModeByWorker[normalized] ?? "required";
  }

  private effectiveMaxParallelChildren(state: FactoryState): number {
    return Math.max(
      1,
      Math.min(
        state.policy.concurrency.maxActiveTasks,
        this.objectiveProfileForState(state).objectivePolicy.maxParallelChildren,
      ),
    );
  }

  private buildContextSources(
    state: FactoryState,
    repoSkillPaths: ReadonlyArray<string>,
    sharedArtifactRefs: ReadonlyArray<GraphRef>,
  ): FactoryContextSources {
    return {
      repoSharedMemoryScope: "factory/repo/shared",
      objectiveMemoryScope: `factory/objectives/${state.objectiveId}`,
      integrationMemoryScope: `factory/objectives/${state.objectiveId}/integration`,
      profileSkillRefs: this.objectiveProfileForState(state).selectedSkills,
      repoSkillPaths,
      sharedArtifactRefs,
    };
  }

  private async writeObjectiveProfileArtifacts(
    objectiveId: string,
    profile: FactoryObjectiveProfileSnapshot,
  ): Promise<ReadonlyArray<GraphRef>> {
    const artifactDir = this.objectiveArtifactsDir(objectiveId);
    const profilePath = this.objectiveProfileArtifactPath(objectiveId);
    const skillsPath = this.objectiveSkillSelectionArtifactPath(objectiveId);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), "utf-8");
    await fs.writeFile(skillsPath, JSON.stringify({
      objectiveId,
      selectedSkills: profile.selectedSkills,
      promptPath: profile.promptPath,
      promptHash: profile.promptHash,
      writtenAt: Date.now(),
    }, null, 2), "utf-8");
    return [
      artifactRef(profilePath, "objective profile snapshot"),
      artifactRef(skillsPath, "objective profile skills"),
    ];
  }

  private async resolveObjectiveProfileSnapshot(profileId?: string): Promise<FactoryObjectiveProfileSnapshot> {
    const resolved = await resolveFactoryChatProfile({
      repoRoot: this.git.repoRoot,
      profileRoot: this.profileRoot,
      requestedId: profileId,
    });
    const objectivePolicy = resolved.objectivePolicy;
    const allowedWorkerTypes = objectivePolicy.allowedWorkerTypes.map((workerType) => normalizeWorkerType(workerType));
    const defaultWorkerType = allowedWorkerTypes.includes(normalizeWorkerType(objectivePolicy.defaultWorkerType))
      ? normalizeWorkerType(objectivePolicy.defaultWorkerType)
      : allowedWorkerTypes[0] ?? normalizeWorkerType(String(DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy.defaultWorkerType));
    return {
      rootProfileId: resolved.root.id,
      rootProfileLabel: resolved.root.label,
      resolvedProfileHash: resolved.resolvedHash,
      promptHash: resolved.promptHash,
      promptPath: resolved.promptPath,
      selectedSkills: resolved.skills,
      objectivePolicy: {
        allowedWorkerTypes,
        defaultWorkerType,
        worktreeModeByWorker: Object.fromEntries(
          Object.entries(objectivePolicy.worktreeModeByWorker).map(([workerType, mode]) => [
            normalizeWorkerType(workerType),
            mode,
          ]),
        ),
        defaultValidationMode: objectivePolicy.defaultValidationMode,
        maxParallelChildren: objectivePolicy.maxParallelChildren,
        allowObjectiveCreation: objectivePolicy.allowObjectiveCreation,
      },
    };
  }

  async prepareRepoProfile(
    opts: FactoryRepoProfilePrepareOptions = {},
  ): Promise<FactoryRepoProfileRecord> {
    opts.onProgress?.({
      step: "bootstrap",
      message: "Checking git repository and Factory workspace state",
    });
    await this.ensureBootstrap();
    const artifact = await this.generateSharedRepoProfile(opts);
    opts.onProgress?.({
      step: "complete",
      message: "Repository profile is ready",
    });
    return {
      status: artifact.status,
      generatedAt: artifact.generatedAt,
      inferredChecks: artifact.inferredChecks,
      generatedSkillRefs: artifact.generatedSkillRefs,
      summary: artifact.summary,
    };
  }

  async createObjective(input: FactoryObjectiveInput): Promise<FactoryObjectiveDetail> {
    await this.ensureBootstrap();
    const title = requireNonEmpty(input.title, "title required");
    const prompt = requireNonEmpty(input.prompt, "prompt required");
    const channel = input.channel?.trim() || "results";
    const profile = await this.resolveObjectiveProfileSnapshot(input.profileId);
    if (!profile.objectivePolicy.allowObjectiveCreation) {
      throw new FactoryServiceError(
        403,
        `profile '${profile.rootProfileId}' is not allowed to create Factory objectives`,
      );
    }
    const checks = input.checks?.length
      ? uniqueChecks(input.checks)
      : profile.objectivePolicy.defaultValidationMode === "none"
        ? []
        : uniqueChecks(undefined);
    const checksSource = input.checks?.length
      ? "explicit"
      : profile.objectivePolicy.defaultValidationMode === "none"
        ? "profile"
        : "default";
    const policy = normalizeFactoryObjectivePolicy(input.policy);
    const sourceStatus = await this.git.sourceStatus();
    if (!input.baseHash && sourceStatus.dirty) {
      throw new FactoryServiceError(
        409,
        "source repository has uncommitted changes. Factory objectives only see committed Git history. Commit or stash changes first, or provide baseHash explicitly.",
      );
    }
    const objectiveId = this.makeId("objective");
    const baseHash = await this.git.resolveBaseHash(input.baseHash);
    const createdAt = Date.now();
    await this.writeObjectiveProfileArtifacts(objectiveId, profile);
    const hasActiveSlot = await this.hasActiveObjectiveSlot();
    await this.emitObjectiveBatch(objectiveId, [
      {
        type: "objective.created",
        objectiveId,
        title,
        prompt,
        channel,
        baseHash,
        checks,
        checksSource,
        profile,
        policy,
        createdAt,
      },
      hasActiveSlot
        ? {
            type: "objective.slot.queued",
            objectiveId,
            queuedAt: createdAt + 1,
          }
        : {
            type: "objective.slot.admitted",
            objectiveId,
            admittedAt: createdAt + 1,
          },
    ]);
    if (input.startImmediately && !hasActiveSlot) {
      await this.processObjectiveStartup(objectiveId, "startup");
    } else {
      await this.enqueueObjectiveControl(objectiveId, "startup");
    }
    return this.getObjective(objectiveId);
  }

  async listObjectives(): Promise<ReadonlyArray<FactoryObjectiveCard>> {
    const cached = this.objectiveListCache;
    if (cached && cached.version === this.objectiveProjectionVersion) {
      return cached.cards;
    }
    const states = await this.listObjectiveStates();
    const queuePositions = this.queuePositionsForStates(states);
    const details = await Promise.all(
      states.map((state) => this.buildObjectiveCard(state, queuePositions.get(state.objectiveId))),
    );
    const cards = details.sort((a, b) => b.updatedAt - a.updatedAt);
    this.objectiveListCache = {
      version: this.objectiveProjectionVersion,
      cards,
    };
    return cards;
  }

  async getObjectiveState(objectiveId: string): Promise<FactoryState> {
    await this.ensureBootstrap();
    const state = await this.runtime.state(objectiveStream(objectiveId));
    if (!state.objectiveId) throw new FactoryServiceError(404, "factory objective not found");
    return state;
  }

  async getObjective(objectiveId: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    const states = await this.listObjectiveStates();
    const queuePositions = this.queuePositionsForStates(states);
    return this.buildObjectiveDetail(state, queuePositions.get(objectiveId));
  }

  async getObjectiveDebug(objectiveId: string): Promise<FactoryDebugProjection> {
    const state = await this.getObjectiveState(objectiveId);
    const states = await this.listObjectiveStates();
    const queuePositions = this.queuePositionsForStates(states);
    return this.buildObjectiveDebug(state, queuePositions.get(objectiveId));
  }

  async listObjectiveReceipts(
    objectiveId: string,
    limitOrQuery: number | FactoryObjectiveReceiptQuery = 40,
  ): Promise<ReadonlyArray<FactoryObjectiveReceiptSummary>> {
    await this.getObjectiveState(objectiveId);
    const chain = await this.runtime.chain(objectiveStream(objectiveId));
    const query = typeof limitOrQuery === "number" ? { limit: limitOrQuery } : limitOrQuery;
    const limit = Math.max(1, Math.min(query.limit ?? 40, 200));
    const typeFilter = new Set((query.types ?? []).map((type) => type.trim()).filter(Boolean));
    return this.summarizedReceipts(chain, 200)
      .filter((receipt) => !query.taskId || receipt.taskId === query.taskId)
      .filter((receipt) => !query.candidateId || receipt.candidateId === query.candidateId)
      .filter((receipt) => typeFilter.size === 0 || typeFilter.has(receipt.type))
      .slice(-limit);
  }

  async buildBoardProjection(selectedObjectiveId?: string): Promise<FactoryBoardProjection> {
    const objectives = (await this.listObjectives())
      .filter((objective) => !objective.archivedAt)
      .map((objective) => ({
        ...objective,
        section: boardSectionForObjective(objective),
      }));
    const resolvedSelectedObjectiveId = this.resolveSelectedObjectiveId(objectives, selectedObjectiveId);
    return {
      objectives,
      sections: {
        needs_attention: objectives.filter((objective) => objective.section === "needs_attention"),
        active: objectives.filter((objective) => objective.section === "active"),
        queued: objectives.filter((objective) => objective.section === "queued"),
        completed: objectives.filter((objective) => objective.section === "completed"),
      },
      selectedObjectiveId: resolvedSelectedObjectiveId,
    };
  }

  async buildComposeModel(): Promise<FactoryComposeModel> {
    let repoProfile = await this.loadSharedRepoProfileArtifact();
    if (!repoProfile && await this.repoProfileArtifactExists()) {
      repoProfile = await this.generateSharedRepoProfile();
    }
    const [sourceStatus, defaultBranch, objectives] = await Promise.all([
      this.git.sourceStatus(),
      this.git.defaultBranch(),
      this.listObjectives(),
    ]);
    return {
      defaultBranch,
      sourceDirty: sourceStatus.dirty,
      sourceBranch: sourceStatus.branch,
      objectiveCount: objectives.filter((objective) => !objective.archivedAt).length,
      defaultPolicy: DEFAULT_FACTORY_OBJECTIVE_POLICY,
      repoProfile: repoProfile ?? {
        status: "missing",
        inferredChecks: [],
        generatedSkillRefs: [],
        summary: "",
      },
      defaultValidationCommands: repoProfile?.inferredChecks?.length ? repoProfile.inferredChecks : [...DEFAULT_CHECKS],
    };
  }

  async buildLiveProjection(selectedObjectiveId?: string): Promise<FactoryLiveProjection> {
    const board = await this.buildBoardProjection(selectedObjectiveId);
    const objectiveId = board.selectedObjectiveId;
    if (!objectiveId) {
      return {
        activeTasks: [],
        recentJobs: [],
      };
    }
    const [detail, jobs] = await Promise.all([
      this.getObjective(objectiveId),
      this.queue.listJobs({ limit: 40 }),
    ]);
    const activeTasks = detail.tasks.filter((task) => isActiveJobStatus(task.jobStatus));
    const recentJobs = jobs
      .filter((job) => (job.payload as Record<string, unknown>).objectiveId === objectiveId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8);
    return {
      selectedObjectiveId: objectiveId,
      objectiveTitle: detail.title,
      objectiveStatus: detail.status,
      phase: detail.phase,
      activeTasks,
      recentJobs,
    };
  }

  async getObjectiveLiveOutput(
    objectiveId: string,
    focusKind: FactoryLiveOutputTargetKind,
    focusId: string,
  ): Promise<FactoryLiveOutputSnapshot> {
    await this.getObjectiveState(objectiveId);
    if (focusKind === "task") {
      const detail = await this.getObjective(objectiveId);
      const task = detail.tasks.find((item) => item.taskId === focusId);
      if (!task) throw new FactoryServiceError(404, "factory task not found");
      return {
        objectiveId,
        focusKind,
        focusId,
        title: task.title,
        status: task.jobStatus ?? task.status,
        active: isActiveJobStatus(task.jobStatus),
        summary: task.latestSummary ?? task.candidate?.summary,
        taskId: task.taskId,
        candidateId: task.candidateId,
        jobId: task.jobId,
        lastMessage: task.lastMessage,
        stdoutTail: task.stdoutTail,
        stderrTail: task.stderrTail,
      };
    }

    const job = await this.queue.getJob(focusId);
    if (!job) throw new FactoryServiceError(404, "job not found");
    const payload = job.payload as Record<string, unknown>;
    if (optionalTrimmedString(payload.objectiveId) !== objectiveId) {
      throw new FactoryServiceError(404, "job does not belong to objective");
    }

    const result = isRecord(job.result) ? job.result : undefined;
    const payloadKind = optionalTrimmedString(payload.kind);
    const summary = optionalTrimmedString(result?.summary)
      ?? optionalTrimmedString(result?.message)
      ?? job.lastError
      ?? optionalTrimmedString(payload.problem)
      ?? optionalTrimmedString(payload.task)
      ?? payloadKind
      ?? `${job.agentId} job`;
    let title = `${job.agentId} job`;
    let taskId = optionalTrimmedString(payload.taskId);
    let candidateId = optionalTrimmedString(payload.candidateId);
    let lastMessage: string | undefined;
    let stdoutTail: string | undefined;
    let stderrTail: string | undefined;

    if (payloadKind === "factory.task.run") {
      title = taskId ? `Task ${taskId}` : "Task run";
      lastMessage = await this.readTextTail(optionalTrimmedString(payload.lastMessagePath), 400);
      stdoutTail = await this.readTextTail(optionalTrimmedString(payload.stdoutPath), 900);
      stderrTail = await this.readTextTail(optionalTrimmedString(payload.stderrPath), 600);
    } else if (payloadKind === "factory.integration.validate") {
      title = candidateId ? `Integration ${candidateId}` : "Integration validation";
      stdoutTail = await this.readTextTail(optionalTrimmedString(payload.stdoutPath), 900);
      stderrTail = await this.readTextTail(optionalTrimmedString(payload.stderrPath), 600);
    }

    return {
      objectiveId,
      focusKind,
      focusId,
      title,
      status: job.status,
      active: isActiveJobStatus(job.status),
      summary,
      taskId,
      candidateId,
      jobId: job.id,
      lastMessage,
      stdoutTail,
      stderrTail,
    };
  }

  async composeObjective(input: FactoryObjectiveComposeInput): Promise<FactoryObjectiveDetail> {
    const prompt = requireNonEmpty(input.prompt, "prompt required");
    const objectiveId = optionalTrimmedString(input.objectiveId);
    if (objectiveId) {
      return this.reactObjectiveWithNote(objectiveId, prompt);
    }
    return this.createObjective({
      title: optionalTrimmedString(input.title) ?? clipText(prompt, 96) ?? "Factory objective",
      prompt,
      baseHash: input.baseHash,
      checks: input.checks,
      channel: input.channel,
      policy: input.policy,
      profileId: input.profileId,
      startImmediately: input.startImmediately,
    });
  }

  async addObjectiveNote(objectiveId: string, message: string): Promise<void> {
    await this.getObjectiveState(objectiveId);
    const normalized = message.trim();
    if (!normalized) return;
    await this.emitObjective(objectiveId, {
      type: "objective.operator.noted",
      objectiveId,
      message: normalized,
      notedAt: Date.now(),
    });
  }

  async reactObjectiveWithNote(objectiveId: string, message?: string): Promise<FactoryObjectiveDetail> {
    const normalized = optionalTrimmedString(message);
    if (normalized) await this.addObjectiveNote(objectiveId, normalized);
    await this.reactObjective(objectiveId);
    return this.getObjective(objectiveId);
  }

  async promoteObjective(objectiveId: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    if (state.integration.status !== "ready_to_promote" || !state.integration.activeCandidateId) {
      throw new FactoryServiceError(409, "objective is not ready to promote");
    }
    await this.promoteIntegration(state, state.integration.activeCandidateId);
    return this.getObjective(objectiveId);
  }

  async cancelObjective(objectiveId: string, reason?: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    await this.cancelObjectiveTaskJobs(state, reason ?? "factory objective canceled");
    await this.emitObjective(objectiveId, {
      type: "objective.canceled",
      objectiveId,
      canceledAt: Date.now(),
      reason,
    });
    await this.rebalanceObjectiveSlots();
    return this.getObjective(objectiveId);
  }

  async archiveObjective(objectiveId: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    await this.cancelObjectiveTaskJobs(state, "factory objective archived");
    if (!state.archivedAt) {
      await this.emitObjective(objectiveId, {
        type: "objective.archived",
        objectiveId,
        archivedAt: Date.now(),
      });
    }
    await this.rebalanceObjectiveSlots();
    return this.getObjective(objectiveId);
  }

  async cleanupObjectiveWorkspaces(objectiveId: string): Promise<FactoryObjectiveDetail> {
    const state = await this.getObjectiveState(objectiveId);
    const workspacePaths = new Set<string>();
    for (const taskId of state.taskOrder) {
      const task = state.graph.nodes[taskId];
      if (task?.workspacePath) workspacePaths.add(task.workspacePath);
    }
    const diskEntries = await fs.readdir(this.git.worktreesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of diskEntries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(`${objectiveId}_`) && !entry.name.startsWith(`factory_integration_${objectiveId}`)) continue;
      workspacePaths.add(path.join(this.git.worktreesDir, entry.name));
    }
    if (state.integration.branchRef?.kind === "workspace") {
      workspacePaths.add(state.integration.branchRef.ref);
    }
    await Promise.all(
      [...workspacePaths].map(async (workspacePath) => {
        await this.git.removeWorkspace(workspacePath).catch(() => undefined);
      }),
    );
    return this.getObjective(objectiveId);
  }

  async queueJobSteer(
    jobId: string,
    input: {
      readonly problem?: string;
      readonly config?: Record<string, unknown>;
      readonly by?: string;
    },
  ): Promise<FactoryQueuedJobCommand> {
    const payload: Record<string, unknown> = {};
    const problem = optionalTrimmedString(input.problem);
    if (problem) payload.problem = problem;
    if (input.config && isRecord(input.config) && Object.keys(input.config).length > 0) payload.config = input.config;
    if (Object.keys(payload).length === 0) throw new FactoryServiceError(400, "provide problem and/or config");
    return this.queueJobCommand(jobId, {
      command: "steer",
      payload,
      by: input.by ?? "factory.cli",
    });
  }

  async queueJobFollowUp(
    jobId: string,
    note: string,
    by = "factory.cli",
  ): Promise<FactoryQueuedJobCommand> {
    return this.queueJobCommand(jobId, {
      command: "follow_up",
      payload: { note: requireNonEmpty(note, "note required") },
      by,
    });
  }

  async queueJobAbort(
    jobId: string,
    reason?: string,
    by = "factory.cli",
  ): Promise<FactoryQueuedJobCommand> {
    return this.queueJobCommand(jobId, {
      command: "abort",
      payload: { reason: optionalTrimmedString(reason) ?? "abort requested" },
      by,
    });
  }

  async resumeObjectives(): Promise<void> {
    await this.rebalanceObjectiveSlots();
    const objectives = await this.listObjectives();
    for (const objective of objectives.filter((item) =>
      !item.archivedAt
      && !["completed", "failed", "canceled"].includes(item.status)
      && item.scheduler.slotState === "active"
    )) {
      await this.enqueueObjectiveControl(objective.objectiveId, "admitted");
    }
  }

  private async queueJobCommand(
    jobId: string,
    input: {
      readonly command: "steer" | "follow_up" | "abort";
      readonly payload?: Record<string, unknown>;
      readonly by?: string;
    },
  ): Promise<FactoryQueuedJobCommand> {
    const existing = await this.queue.getJob(jobId);
    if (!existing) throw new FactoryServiceError(404, "job not found");
    const command = await this.queue.queueCommand({
      jobId,
      command: input.command,
      payload: input.payload,
      by: input.by,
    });
    if (!command) throw new FactoryServiceError(404, "job not found");
    this.sse.publish("jobs", jobId);
    return {
      job: await this.queue.getJob(jobId) ?? existing,
      command,
    };
  }

  private objectiveElapsedMinutes(state: FactoryState, now = Date.now()): number {
    if (!state.createdAt) return 0;
    return Math.max(0, Math.floor((now - state.createdAt) / 60_000));
  }

  private isTerminalObjectiveStatus(status: FactoryObjectiveStatus): boolean {
    return status === "completed" || status === "failed" || status === "canceled";
  }

  private releasesObjectiveSlot(status: FactoryObjectiveStatus): boolean {
    return this.isTerminalObjectiveStatus(status) || status === "blocked";
  }

  private async cancelObjectiveTaskJobs(
    state: FactoryState,
    reason: string,
  ): Promise<void> {
    for (const taskId of state.taskOrder) {
      const task = state.graph.nodes[taskId];
      if (!task?.jobId) continue;
      await this.queue.cancel(task.jobId, reason, "factory");
    }
  }

  private async listObjectiveStates(): Promise<ReadonlyArray<FactoryState>> {
    await this.ensureBootstrap();
    const streams = await this.discoverObjectiveStreams();
    const states = await Promise.all(
      streams.map(async (stream) => this.runtime.state(stream)),
    );
    return states
      .filter((state) => Boolean(state.objectiveId))
      .sort((a, b) => a.createdAt - b.createdAt || a.objectiveId.localeCompare(b.objectiveId));
  }

  private queuePositionsForStates(states: ReadonlyArray<FactoryState>): ReadonlyMap<string, number> {
    const queued = states
      .filter((state) =>
        Boolean(state.objectiveId)
        && !state.archivedAt
        && !this.isTerminalObjectiveStatus(state.status)
        && state.scheduler.slotState === "queued",
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.objectiveId.localeCompare(b.objectiveId));
    return new Map(queued.map((state, index) => [state.objectiveId, index + 1] as const));
  }

  private deriveObjectivePhase(
    state: FactoryState,
    projection?: { readonly activeTasks: number; readonly readyTasks: number },
  ): FactoryObjectivePhase {
    if (state.status === "completed") return "completed";
    if (state.status === "blocked" || state.status === "failed" || state.status === "canceled") return "blocked";
    if (state.scheduler.slotState === "queued") return "waiting_for_slot";
    if (state.status === "decomposing") return "preparing_repo";
    if (state.status === "planning") return "planning_graph";
    if (state.status === "integrating") return "integrating";
    if (state.status === "promoting" || state.integration.status === "ready_to_promote" || state.integration.status === "promoting" || state.integration.status === "promoted") {
      return "promoting";
    }
    if (state.status === "executing" && projection && projection.activeTasks === 0 && projection.readyTasks === 0) {
      return "blocked";
    }
    return "executing";
  }

  private deriveLatestDecision(state: FactoryState): FactoryObjectiveCard["latestDecision"] | undefined {
    if (state.latestRebracket) {
      return {
        summary: state.latestRebracket.reason,
        at: state.latestRebracket.appliedAt,
        source: state.latestRebracket.source,
        selectedActionId: state.latestRebracket.selectedActionId,
      };
    }
    if (state.plan.adoptedAt && state.plan.summary) {
      return {
        summary: state.plan.summary,
        at: state.plan.adoptedAt,
        source: "plan",
      };
    }
    if (state.plan.proposedAt && state.plan.summary) {
      return {
        summary: state.plan.summary,
        at: state.plan.proposedAt,
        source: "plan",
      };
    }
    if (state.integration.status === "ready_to_promote" && state.integration.lastSummary) {
      return {
        summary: state.integration.lastSummary,
        at: state.integration.updatedAt,
        source: "system",
      };
    }
    return undefined;
  }

  private deriveNextAction(state: FactoryState, queuePosition?: number): string | undefined {
    if (state.status === "blocked") return "Review the blocking receipt and react or cancel the objective.";
    if (state.scheduler.slotState === "queued") {
      return queuePosition
        ? `Waiting for the repo execution slot (${queuePosition} in queue).`
        : "Waiting for the repo execution slot.";
    }
    if (state.status === "decomposing") return "Preparing the repo profile and generated skill bundle.";
    if (state.status === "planning") return "Adopting the first task graph.";
    if (state.integration.status === "ready_to_promote" && !state.policy.promotion.autoPromote) {
      return "Promote the integration branch into source when ready.";
    }
    if (state.integration.status === "conflicted") return "Resolve the integration conflict or let reconciliation tasks run.";
    const readyCount = factoryReadyTasks(state).length;
    if (readyCount > 0) {
      return readyCount === 1
        ? "One task is ready to dispatch."
        : `${readyCount} tasks are ready to dispatch.`;
    }
    if (state.graph.activeNodeIds.length > 0) return "Wait for the active task pass to finish.";
    if (state.integration.status === "queued" || state.integration.status === "merging" || state.integration.status === "validating") {
      return "Wait for integration validation to finish.";
    }
    if (state.status === "completed") return "Objective is complete.";
    return undefined;
  }

  private buildBudgetState(
    state: FactoryState,
    now = Date.now(),
    policyBlockedReason?: string,
  ): FactoryBudgetState {
    return {
      taskRunsUsed: state.taskRunsUsed,
      candidatePassesByTask: state.candidatePassesByTask,
      reconciliationTasksUsed: state.reconciliationTasksUsed,
      elapsedMinutes: this.objectiveElapsedMinutes(state, now),
      lastMutationAt: state.lastMutationAt,
      lastDispatchAt: state.lastDispatchAt,
      policyBlockedReason: policyBlockedReason ?? this.derivePolicyBlockedReason(state, now),
    };
  }

  private derivePolicyBlockedReason(state: FactoryState, now = Date.now()): string | undefined {
    const elapsedMinutes = this.objectiveElapsedMinutes(state, now);
    if (elapsedMinutes > state.policy.budgets.maxObjectiveMinutes) {
      return `Policy blocked: objective exceeded maxObjectiveMinutes (${elapsedMinutes}/${state.policy.budgets.maxObjectiveMinutes}).`;
    }
    if (state.taskRunsUsed >= state.policy.budgets.maxTaskRuns) {
      return `Policy blocked: objective exhausted maxTaskRuns (${state.taskRunsUsed}/${state.policy.budgets.maxTaskRuns}).`;
    }
    if (state.blockedReason?.startsWith("Policy blocked:")) return state.blockedReason;
    return undefined;
  }

  private taskReworkPolicyBlockedReason(state: FactoryState, task: FactoryTaskRecord): string | undefined {
    const latest = this.latestTaskCandidate(state, task.taskId);
    if (!latest || !["changes_requested", "rejected", "conflicted"].includes(latest.status)) return undefined;
    const passes = state.candidatePassesByTask[task.taskId] ?? 0;
    if (passes < state.policy.budgets.maxCandidatePassesPerTask) return undefined;
    return `Policy blocked: ${task.taskId} exhausted maxCandidatePassesPerTask (${passes}/${state.policy.budgets.maxCandidatePassesPerTask}).`;
  }

  private resolveSelectedObjectiveId(
    objectives: ReadonlyArray<{ readonly objectiveId: string }>,
    preferredId?: string,
  ): string | undefined {
    if (preferredId && objectives.some((objective) => objective.objectiveId === preferredId)) return preferredId;
    return objectives[0]?.objectiveId;
  }

  private async hasActiveObjectiveSlot(): Promise<boolean> {
    const states = await this.listObjectiveStates();
    return states.some((state) =>
      !state.archivedAt
      && !this.releasesObjectiveSlot(state.status)
      && state.scheduler.slotState === "active"
      && !state.scheduler.releasedAt,
    );
  }

  private async enqueueObjectiveControl(
    objectiveId: string,
    reason: FactoryObjectiveControlJobPayload["reason"],
  ): Promise<void> {
    const created = await this.queue.enqueue({
      agentId: FACTORY_CONTROL_AGENT_ID,
      lane: "collect",
      sessionKey: `factory:objective:${objectiveId}`,
      singletonMode: "allow",
      maxAttempts: 2,
      payload: {
        kind: "factory.objective.control",
        objectiveId,
        reason,
      } satisfies FactoryObjectiveControlJobPayload,
    });
    this.sse.publish("jobs", created.id);
  }

  async runObjectiveControl(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (payload.kind !== "factory.objective.control") {
      throw new FactoryServiceError(400, "invalid factory control payload");
    }
    const objectiveId = requireNonEmpty(payload.objectiveId, "objectiveId required");
    const reason = payload.reason === "admitted" ? "admitted" : "startup";
    await this.ensureBootstrap();
    await this.processObjectiveStartup(objectiveId, reason);
    return {
      objectiveId,
      status: "completed",
      reason,
    };
  }

  private repoProfileDir(): string {
    return path.join(this.dataDir, FACTORY_SHARED_REPO_PROFILE_DIR);
  }

  private repoProfileArtifactPath(): string {
    return path.join(this.repoProfileDir(), "profile.json");
  }

  private repoProfileSkillsDir(): string {
    return path.join(this.repoProfileDir(), "skills");
  }

  private async currentRepoProfileSignature(): Promise<string> {
    const [packageJsonRaw, readmeRaw] = await Promise.all([
      fs.readFile(path.join(this.git.repoRoot, "package.json"), "utf-8").catch(() => ""),
      fs.readFile(path.join(this.git.repoRoot, "README.md"), "utf-8").catch(() => ""),
    ]);
    return createHash("sha256")
      .update(this.git.repoRoot)
      .update("\n--package.json--\n")
      .update(packageJsonRaw)
      .update("\n--README.md--\n")
      .update(readmeRaw)
      .digest("hex");
  }

  private async repoProfileArtifactExists(): Promise<boolean> {
    try {
      await fs.access(this.repoProfileArtifactPath());
      return true;
    } catch {
      return false;
    }
  }

  private async loadSharedRepoProfileArtifact(): Promise<FactoryRepoProfileArtifact | undefined> {
    try {
      const raw = await fs.readFile(this.repoProfileArtifactPath(), "utf-8");
      const parsed = JSON.parse(raw) as FactoryRepoProfileArtifact;
      if (!parsed || typeof parsed !== "object") return undefined;
      if (!Array.isArray(parsed.inferredChecks) || !Array.isArray(parsed.generatedSkillPaths) || !Array.isArray(parsed.generatedSkillRefs)) {
        return undefined;
      }
      const signature = await this.currentRepoProfileSignature();
      if (typeof parsed.repoSignature !== "string" || parsed.repoSignature !== signature) {
        return undefined;
      }
      return {
        status: parsed.status,
        generatedAt: parsed.generatedAt,
        repoSignature: parsed.repoSignature,
        inferredChecks: parsed.inferredChecks.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
        generatedSkillRefs: parsed.generatedSkillRefs.filter((item): item is GraphRef => isRecord(item) && typeof item.kind === "string" && typeof item.ref === "string"),
        generatedSkillPaths: parsed.generatedSkillPaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
      };
    } catch {
      return undefined;
    }
  }

  private async inferRepoProfileFallback(): Promise<{
    readonly summary: string;
    readonly inferredChecks: ReadonlyArray<string>;
    readonly generatedSkills: ReadonlyArray<{ readonly slug: string; readonly title: string; readonly content: string }>;
  }> {
    const packageJsonPath = path.join(this.git.repoRoot, "package.json");
    const readmePath = path.join(this.git.repoRoot, "README.md");
    const packageJsonRaw = await fs.readFile(packageJsonPath, "utf-8").catch(() => "");
    const readmeRaw = await fs.readFile(readmePath, "utf-8").catch(() => "");
    const packageJson = (() => {
      if (!packageJsonRaw.trim()) return undefined;
      try {
        return JSON.parse(packageJsonRaw) as {
          readonly name?: string;
          readonly packageManager?: string;
          readonly scripts?: Record<string, string>;
        };
      } catch {
        return undefined;
      }
    })();
    const scripts = packageJson?.scripts ?? {};
    const bunFirst = await repoUsesBun(this.git.repoRoot, packageJson);
    const inferredChecks = [
      "build" in scripts ? scriptCommand("build", bunFirst) : undefined,
      "test" in scripts ? scriptCommand("test", bunFirst) : undefined,
      "lint" in scripts ? scriptCommand("lint", bunFirst) : undefined,
    ].filter((item): item is string => Boolean(item));
    const checks = inferredChecks.length ? inferredChecks : [...DEFAULT_CHECKS];
    const summary = [
      `Repo ${packageJson?.name ?? path.basename(this.git.repoRoot)} is prepared for Factory objectives.`,
      bunFirst ? "Bun was detected as the package runner." : "npm-compatible scripts were detected for validation.",
      Object.keys(scripts).length
        ? `Primary scripts: ${Object.keys(scripts).slice(0, 8).join(", ")}.`
        : "No package.json scripts were detected, so Factory will fall back to basic validation commands.",
      readmeRaw.trim()
        ? `README focus: ${clipText(readmeRaw.replace(/\s+/g, " "), 220) ?? ""}`
        : "No README summary was available.",
    ].join(" ");
    return {
      summary,
      inferredChecks: checks,
      generatedSkills: [{
        slug: "repo-operating-notes",
        title: "Repo Operating Notes",
        content: [
          "# Repo Operating Notes",
          "",
          summary,
          "",
          "## Validation Commands",
          ...checks.map((check) => `- ${check}`),
          "",
          "## Factory Guidance",
          "- Reuse existing repository conventions before introducing new build or test paths.",
          "- Prefer the repository's current package manager and script names.",
          "- Keep task changes aligned with committed Git history and objective integration flow.",
        ].join("\n"),
      }],
    };
  }

  private async generateSharedRepoProfile(
    opts: FactoryRepoProfilePrepareOptions = {},
  ): Promise<FactoryRepoProfileArtifact> {
    const existing = await this.loadSharedRepoProfileArtifact();
    if (existing) {
      opts.onProgress?.({
        step: "cache",
        message: "Reusing cached repository profile",
      });
      return existing;
    }

    opts.onProgress?.({
      step: "scan",
      message: "Reading package.json, README, and repository layout",
    });
    const fallback = await this.inferRepoProfileFallback();
    const generatedAt = Date.now();
    const repoSignature = await this.currentRepoProfileSignature();
    let profile = fallback;
    let status: FactoryRepoProfileRecord["status"] = "ready";

    opts.onProgress?.({
      step: "infer_checks",
      message: `Detected validation commands: ${fallback.inferredChecks.join(" | ") || "none"}`,
    });

    if (this.llmStructured) {
      opts.onProgress?.({
        step: "llm",
        message: "Generating repo summary and skills with OpenAI",
      });
      const topEntries = (await fs.readdir(this.git.repoRoot, { withFileTypes: true }).catch(() => []))
        .map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
        }))
        .slice(0, 40);
      const checkedInSkills = await this.collectCheckedInRepoSkillPaths();
      const packageJsonRaw = await fs.readFile(path.join(this.git.repoRoot, "package.json"), "utf-8").catch(() => "");
      const readmeRaw = await fs.readFile(path.join(this.git.repoRoot, "README.md"), "utf-8").catch(() => "");
      try {
        const { parsed } = await this.llmStructured({
          schema: repoProfileSchema,
          schemaName: "factory_repo_profile",
          system: [
            "You are preparing a software repo for Receipt Factory objectives.",
            "Infer the best default validation commands for this repo.",
            "Write a short repo summary and generate concise repo-specific skill markdown files that future code workers can use.",
            "Do not invent commands that do not match the repository's likely tooling.",
          ].join("\n"),
          user: JSON.stringify({
            repoRoot: this.git.repoRoot,
            topEntries,
            checkedInSkills,
            packageJson: packageJsonRaw ? JSON.parse(packageJsonRaw) : undefined,
            readme: clipText(readmeRaw.replace(/\s+/g, " "), 2_000),
            fallback,
          }, null, 2),
        });
        profile = {
          summary: parsed.summary,
          inferredChecks: parsed.inferredChecks.length ? parsed.inferredChecks : fallback.inferredChecks,
          generatedSkills: parsed.generatedSkills.length ? parsed.generatedSkills : fallback.generatedSkills,
        };
      } catch {
        status = "ready";
      }
    }

    opts.onProgress?.({
      step: "write_skills",
      message: "Writing generated repository skills and notes",
    });
    await fs.mkdir(this.repoProfileSkillsDir(), { recursive: true });
    const generatedSkillPaths: string[] = [];
    const generatedSkillRefs: GraphRef[] = [];
    for (const [index, skill] of profile.generatedSkills.entries()) {
      const fileName = `${String(index + 1).padStart(2, "0")}-${skill.slug.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase()}.md`;
      const filePath = path.join(this.repoProfileSkillsDir(), fileName);
      await fs.writeFile(filePath, skill.content.trimEnd() + "\n", "utf-8");
      generatedSkillPaths.push(filePath);
      generatedSkillRefs.push(artifactRef(filePath, skill.title));
    }
    const artifact: FactoryRepoProfileArtifact = {
      status,
      generatedAt,
      repoSignature,
      inferredChecks: profile.inferredChecks,
      generatedSkillRefs,
      generatedSkillPaths,
      summary: profile.summary,
    };
    opts.onProgress?.({
      step: "persist",
      message: "Saving repository profile cache",
    });
    await fs.mkdir(this.repoProfileDir(), { recursive: true });
    await fs.writeFile(this.repoProfileArtifactPath(), JSON.stringify(artifact, null, 2), "utf-8");
    return artifact;
  }

  private async ensureRepoProfileForObjective(state: FactoryState): Promise<void> {
    if (state.repoProfile.status === "ready" && state.repoProfile.generatedAt) return;
    const requestedAt = Date.now();
    await this.emitObjective(state.objectiveId, {
      type: "repo.profile.requested",
      objectiveId: state.objectiveId,
      requestedAt,
    });
    const prior = await this.loadSharedRepoProfileArtifact();
    const artifact = prior ?? await this.generateSharedRepoProfile();
    await this.emitObjective(state.objectiveId, {
      type: "repo.profile.generated",
      objectiveId: state.objectiveId,
      generatedAt: artifact.generatedAt,
      status: artifact.status,
      inferredChecks: artifact.inferredChecks,
      generatedSkillRefs: artifact.generatedSkillRefs,
      summary: artifact.summary,
      source: prior ? "reused" : "generated",
    });
  }

  private async planObjective(state: FactoryState): Promise<void> {
    if (state.taskOrder.length > 0) return;
    const { tasks, fallback } = await this.decomposeObjective(state);
    const proposedAt = Date.now();
    const summary = tasks.length === 1
      ? `Adopted a single-task execution plan for ${state.title}.`
      : `Adopted a ${tasks.length}-task graph for ${state.title}.`;
    const taskRecords = tasks.map((spec, index) => {
      const createdAt = proposedAt + index + 2;
      const taskId = spec.taskId;
      return {
        nodeId: taskId,
        taskId,
        taskKind: "planned",
        title: spec.title,
        prompt: spec.prompt,
        workerType: this.normalizeProfileWorkerType(this.objectiveProfileForState(state), spec.workerType),
        baseCommit: state.baseHash,
        dependsOn: spec.dependsOn,
        status: "pending",
        skillBundlePaths: [],
        contextRefs: [
          stateRef(`${objectiveStream(state.objectiveId)}:objective`, "objective"),
          commitRef(state.baseHash, "base commit"),
        ],
        artifactRefs: {},
        createdAt,
      } satisfies FactoryTaskRecord;
    });
    await this.emitObjectiveBatch(state.objectiveId, [
      {
        type: "objective.plan.proposed",
        objectiveId: state.objectiveId,
        taskCount: taskRecords.length,
        summary: fallback ? `${summary} Factory used the deterministic fallback planner.` : summary,
        fallback,
        proposedAt,
      },
      ...taskRecords.map((task) => ({
        type: "task.added" as const,
        objectiveId: state.objectiveId,
        task,
        createdAt: task.createdAt,
      })),
      {
        type: "objective.plan.adopted",
        objectiveId: state.objectiveId,
        taskIds: taskRecords.map((task) => task.taskId),
        summary: fallback ? `${summary} Factory used the deterministic fallback planner.` : summary,
        fallback,
        adoptedAt: proposedAt + taskRecords.length + 2,
      },
    ]);
  }

  private async rebalanceObjectiveSlots(): Promise<void> {
    const states = await this.listObjectiveStates();
    for (const state of states) {
      if (
        state.scheduler.slotState === "active"
        && !state.scheduler.releasedAt
        && (this.releasesObjectiveSlot(state.status) || Boolean(state.archivedAt))
      ) {
        await this.emitObjective(state.objectiveId, {
          type: "objective.slot.released",
          objectiveId: state.objectiveId,
          releasedAt: Date.now(),
          reason: state.archivedAt
            ? "slot released after objective archived"
            : `slot released after objective entered ${state.status}`,
        });
      }
    }

    const refreshed = await this.listObjectiveStates();
    const active = refreshed.find((state) =>
      !state.archivedAt
      && !this.releasesObjectiveSlot(state.status)
      && state.scheduler.slotState === "active"
      && !state.scheduler.releasedAt,
    );
    if (active) return;

    const next = refreshed.find((state) =>
      !state.archivedAt
      && !this.releasesObjectiveSlot(state.status)
      && (state.scheduler.slotState === "queued" || !state.scheduler.slotState || state.scheduler.releasedAt),
    );
    if (!next) return;
    await this.emitObjective(next.objectiveId, {
      type: "objective.slot.admitted",
      objectiveId: next.objectiveId,
      admittedAt: Date.now(),
    });
    await this.enqueueObjectiveControl(next.objectiveId, "admitted");
  }

  private async processObjectiveStartup(
    objectiveId: string,
    _reason: FactoryObjectiveControlJobPayload["reason"],
  ): Promise<void> {
    await this.rebalanceObjectiveSlots();
    const state = await this.getObjectiveState(objectiveId);
    if (this.isTerminalObjectiveStatus(state.status) || state.status === "blocked") {
      await this.rebalanceObjectiveSlots();
      return;
    }
    if (state.scheduler.slotState !== "active") return;
    await this.reactObjective(objectiveId);
    await this.rebalanceObjectiveSlots();
  }

  private async syncFailedActiveTasks(state: FactoryState): Promise<void> {
    for (const taskId of [...state.graph.activeNodeIds]) {
      const task = state.graph.nodes[taskId];
      if (!task?.jobId) continue;
      const job = await this.loadFreshJob(task.jobId);
      if (!job || !isTerminalJobStatus(job.status)) continue;
      if ((job.status === "failed" || job.status === "canceled") && (task.status === "running" || task.status === "reviewing")) {
        await this.emitObjective(state.objectiveId, {
          type: "task.blocked",
          objectiveId: state.objectiveId,
          taskId,
          reason: job.lastError ?? job.canceledReason ?? "factory task failed",
          blockedAt: Date.now(),
        });
      }
    }
  }

  async reactObjective(objectiveId: string): Promise<void> {
    await this.rebalanceObjectiveSlots();
    const refreshState = () => this.getObjectiveState(objectiveId);
    let state = await refreshState();

    if (this.isTerminalObjectiveStatus(state.status)) {
      await this.rebalanceObjectiveSlots();
      return;
    }
    if (state.status === "blocked" || state.scheduler.slotState === "queued") return;

    await this.syncFailedActiveTasks(state);
    state = await refreshState();
    if (this.isTerminalObjectiveStatus(state.status) || state.status === "blocked") {
      await this.rebalanceObjectiveSlots();
      return;
    }

    const elapsedBlockedReason = this.derivePolicyBlockedReason(state);
    if (elapsedBlockedReason) {
      await this.emitObjective(objectiveId, {
        type: "objective.blocked",
        objectiveId,
        reason: elapsedBlockedReason,
        summary: elapsedBlockedReason,
        blockedAt: Date.now(),
      });
      await this.rebalanceObjectiveSlots();
      return;
    }

    if (state.repoProfile.status !== "ready" || !state.repoProfile.generatedAt) {
      await this.ensureRepoProfileForObjective(state);
      state = await refreshState();
    }

    if (state.taskOrder.length === 0) {
      await this.planObjective(state);
      state = await refreshState();
    }

    const activatable = factoryActivatableTasks(state);
    for (const task of activatable) {
      await this.emitObjective(objectiveId, {
        type: "task.ready",
        objectiveId,
        taskId: task.taskId,
        readyAt: Date.now(),
      });
    }
    if (activatable.length > 0) state = await refreshState();

    for (const task of factoryReadyTasks(state)) {
      const blockedReason = this.taskReworkPolicyBlockedReason(state, task);
      if (blockedReason) {
        await this.emitObjective(objectiveId, {
          type: "task.blocked",
          objectiveId,
          taskId: task.taskId,
          reason: blockedReason,
          blockedAt: Date.now(),
        });
      }
    }
    state = await refreshState();

    const activeCount = state.graph.activeNodeIds.length;
    const capacity = Math.max(0, this.effectiveMaxParallelChildren(state) - activeCount);
    const dispatchPolicyBlockedReason = state.taskRunsUsed >= state.policy.budgets.maxTaskRuns
      ? `Policy blocked: objective exhausted maxTaskRuns (${state.taskRunsUsed}/${state.policy.budgets.maxTaskRuns}).`
      : undefined;
    const decisionSet = buildFactoryDecisionSet(state, {
      now: Date.now(),
      dispatchLimit: capacity,
      policyBlockedReason: dispatchPolicyBlockedReason,
    });

    const basedOn = await this.currentHeadHash(objectiveId);
    for (const selectedAction of decisionSet.actions) {
      const reason = summarizeFactoryAction(selectedAction);
      try {
        await this.applyAction(state, selectedAction, reason, 1.0, "runtime", { basedOn });
      } catch (err) {
        if (err instanceof FactoryStaleObjectiveError) break;
        throw err;
      }
      state = await refreshState();
    }

    state = await refreshState();
    const postActionActivatable = factoryActivatableTasks(state);
    for (const task of postActionActivatable) {
      await this.emitObjective(objectiveId, {
        type: "task.ready",
        objectiveId,
        taskId: task.taskId,
        readyAt: Date.now(),
      });
    }
    if (postActionActivatable.length > 0) {
      state = await refreshState();
      const postBasedOn = await this.currentHeadHash(objectiveId);
      const postCapacity = Math.max(0, this.effectiveMaxParallelChildren(state) - state.graph.activeNodeIds.length);
      if (postCapacity > 0) {
        const postDecisionSet = buildFactoryDecisionSet(state, {
          now: Date.now(),
          dispatchLimit: postCapacity,
        });
        for (const selectedAction of postDecisionSet.actions) {
          if (selectedAction.type !== "dispatch_child") continue;
          const reason = summarizeFactoryAction(selectedAction);
          try {
            await this.applyAction(state, selectedAction, reason, 1.0, "runtime", { basedOn: postBasedOn });
          } catch (err) {
            if (err instanceof FactoryStaleObjectiveError) break;
            throw err;
          }
          state = await refreshState();
        }
      }
    }

    state = await refreshState();
    const finalProjection = buildFactoryProjection(state);
    const completionReady = (
      finalProjection.tasks.length > 0
      && finalProjection.tasks.every((task) => ["integrated", "superseded"].includes(task.status))
      && state.integration.status === "promoted"
      && state.status !== "completed"
    );
    const emptyBlockedReady = (
      finalProjection.tasks.length > 0
      && finalProjection.readyTasks.length === 0
      && finalProjection.activeTasks.length === 0
      && state.integration.status === "idle"
      && finalProjection.tasks.every((task) => ["blocked", "superseded"].includes(task.status))
      && state.status !== "blocked"
    );

    if (completionReady) {
      await this.emitObjective(objectiveId, {
        type: "objective.completed",
        objectiveId,
        summary: state.integration.lastSummary ?? "Factory objective completed.",
        completedAt: Date.now(),
      });
    } else if (emptyBlockedReady) {
      await this.emitObjective(objectiveId, {
        type: "objective.blocked",
        objectiveId,
        reason: "No runnable tasks remained.",
        summary: "Factory objective is blocked with no runnable tasks.",
        blockedAt: Date.now(),
      });
    }

    await this.rebalanceObjectiveSlots();
  }

  async runTask(payload: Record<string, unknown>, control?: CodexRunControl): Promise<Record<string, unknown>> {
    await this.ensureBootstrap();
    const parsed = this.parseTaskPayload(payload);
    const state = await this.getObjectiveState(parsed.objectiveId);
    const task = state.graph.nodes[parsed.taskId];
    if (!task) throw new FactoryServiceError(404, "factory task not found");
    const workspaceStatus = await this.git.worktreeStatus(parsed.workspacePath);
    let rebuiltPacket = false;
    if (!workspaceStatus.exists) {
      await this.git.restoreWorkspace({
        workspaceId: parsed.workspaceId,
        branchName: `hub/${parsed.workerType}/${parsed.workspaceId}`,
        workspacePath: parsed.workspacePath,
        baseHash: parsed.baseCommit,
      });
      rebuiltPacket = true;
    }
    const manifestPresent = await fs.access(parsed.manifestPath).then(() => true).catch(() => false);
    if (rebuiltPacket || !manifestPresent) {
      await this.writeTaskPacket(state, task, parsed.candidateId, parsed.workspacePath);
    }
    const renderedPrompt = await this.renderTaskPrompt(state, task, parsed);
    const receiptBinDir = await this.ensureWorkspaceReceiptCli(parsed.workspacePath);
    const resultSchemaPath = this.taskResultSchemaPath(parsed.resultPath);
    await fs.mkdir(path.dirname(resultSchemaPath), { recursive: true });
    await fs.writeFile(resultSchemaPath, JSON.stringify(FACTORY_TASK_RESULT_SCHEMA, null, 2), "utf-8");
    const execution = await this.codexExecutor.run({
      prompt: renderedPrompt,
      workspacePath: parsed.workspacePath,
      promptPath: parsed.promptPath,
      lastMessagePath: parsed.lastMessagePath,
      stdoutPath: parsed.stdoutPath,
      stderrPath: parsed.stderrPath,
      model: FACTORY_TASK_CODEX_MODEL,
      outputSchemaPath: resultSchemaPath,
      reasoningEffort: "low",
      objectiveId: parsed.objectiveId,
      taskId: parsed.taskId,
      candidateId: parsed.candidateId,
      integrationRef: parsed.integrationRef,
      contextRefs: parsed.contextRefs,
      skillBundlePaths: parsed.skillBundlePaths,
      repoSkillPaths: parsed.repoSkillPaths,
      env: {
        DATA_DIR: this.dataDir,
        PATH: prependPath(receiptBinDir, process.env.PATH),
      },
    }, control);
    const taskResult = await this.resolveTaskWorkerResult(parsed.resultPath, execution);
    await fs.writeFile(parsed.resultPath, JSON.stringify(taskResult, null, 2), "utf-8");
    await this.applyTaskWorkerResult(parsed, taskResult);
    await this.reactObjective(parsed.objectiveId);
    return {
      objectiveId: parsed.objectiveId,
      taskId: parsed.taskId,
      candidateId: parsed.candidateId,
      status: "completed",
    };
  }

  async applyTaskWorkerResult(payload: FactoryTaskJobPayload, rawResult: Record<string, unknown>): Promise<void> {
    const state = await this.getObjectiveState(payload.objectiveId);
    const task = state.graph.nodes[payload.taskId];
    if (!task) throw new FactoryServiceError(404, "factory task not found");
    const summary = requireNonEmpty(rawResult.summary, "task result summary required");
    const handoff = optionalTrimmedString(rawResult.handoff) ?? summary;
    const outcome = optionalTrimmedString(rawResult.outcome) ?? "approved";
    const completedAt = Date.now();

    if (outcome === "blocked") {
      await this.emitObjective(payload.objectiveId, {
        type: "task.blocked",
        objectiveId: payload.objectiveId,
        taskId: payload.taskId,
        reason: handoff,
        blockedAt: completedAt,
      });
      return;
    }

    const checkResults = await this.runChecks(state.checks, payload.workspacePath);
    const failedCheck = checkResults.find((check) => !check.ok);
    const status = await this.git.worktreeStatus(payload.workspacePath);
    if (!status.dirty) {
      const noDiffReason = `factory task produced no tracked diff: ${summary}`;
      await this.commitTaskMemory(state, task, payload.candidateId, `${summary}\n\n${handoff}`, "blocked_no_diff");
      await this.emitObjective(payload.objectiveId, {
        type: "task.blocked",
        objectiveId: payload.objectiveId,
        taskId: payload.taskId,
        reason: noDiffReason,
        blockedAt: completedAt,
      });
      return;
    }

    const committed = await this.git.commitWorkspace(
      payload.workspacePath,
      `[factory][${payload.objectiveId}] ${payload.taskId} ${state.title}`
    );
    const resultRefs = {
      manifest: fileRef(payload.manifestPath, "task manifest"),
      prompt: fileRef(payload.promptPath, "task prompt"),
      result: fileRef(payload.resultPath, "task result"),
      stdout: fileRef(payload.stdoutPath, "task stdout"),
      stderr: fileRef(payload.stderrPath, "task stderr"),
      lastMessage: fileRef(payload.lastMessagePath, "task last message"),
      contextPack: fileRef(payload.contextPackPath, "task recursive context pack"),
      memoryScript: fileRef(payload.memoryScriptPath, "task memory script"),
      memoryConfig: fileRef(payload.memoryConfigPath, "task memory config"),
      commit: commitRef(committed.hash, "candidate commit"),
    } satisfies Readonly<Record<string, GraphRef>>;

    await this.emitObjective(payload.objectiveId, {
      type: "candidate.produced",
      objectiveId: payload.objectiveId,
      candidateId: payload.candidateId,
      taskId: payload.taskId,
      headCommit: committed.hash,
      summary,
      handoff,
      checkResults,
      artifactRefs: resultRefs,
      producedAt: completedAt,
    });
    await this.emitObjective(payload.objectiveId, {
      type: "task.review.requested",
      objectiveId: payload.objectiveId,
      taskId: payload.taskId,
      reviewRequestedAt: completedAt,
    });

    if (failedCheck) {
      const classification = await this.classifyFailedCheck(state, failedCheck, payload.baseCommit);
      const inheritedOnly = classification.inherited;
      const reviewStatus: Extract<FactoryCandidateStatus, "approved" | "changes_requested" | "rejected"> =
        inheritedOnly && outcome === "approved" ? "approved" : "changes_requested";
      const reviewSummary = inheritedOnly
        ? `${summary} (checks only reproduced an inherited failure in ${failedCheck.command})`
        : `Verification failed: ${failedCheck.command}`;
      const reviewHandoff = inheritedOnly
        ? `${handoff}\n\n${this.inheritedFailureNote(failedCheck, classification)}`
        : handoff;
      await this.emitObjective(payload.objectiveId, {
        type: "candidate.reviewed",
        objectiveId: payload.objectiveId,
        candidateId: payload.candidateId,
        taskId: payload.taskId,
        status: reviewStatus,
        summary: reviewSummary,
        handoff: reviewHandoff,
        reviewedAt: completedAt,
      });
      await this.commitTaskMemory(state, task, payload.candidateId, reviewSummary, reviewStatus);
      return;
    }

    const reviewStatus: Extract<FactoryCandidateStatus, "approved" | "changes_requested" | "rejected"> =
      outcome === "changes_requested" ? "changes_requested" : outcome === "rejected" ? "rejected" : "approved";
    await this.emitObjective(payload.objectiveId, {
      type: "candidate.reviewed",
      objectiveId: payload.objectiveId,
      candidateId: payload.candidateId,
      taskId: payload.taskId,
      status: reviewStatus,
      summary,
      handoff,
      reviewedAt: completedAt,
    });
    await this.commitTaskMemory(state, task, payload.candidateId, summary, reviewStatus);
  }

  async runIntegrationValidation(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = this.parseIntegrationPayload(payload);
    const state = await this.getObjectiveState(parsed.objectiveId);
    const startedAt = Date.now();
    await this.emitObjective(parsed.objectiveId, {
      type: "integration.validating",
      objectiveId: parsed.objectiveId,
      candidateId: parsed.candidateId,
      startedAt,
    });
    const results = await this.runChecks(parsed.checks, parsed.workspacePath);
    const failed = results.find((result) => !result.ok);
    const raw = JSON.stringify({ results }, null, 2);
    await fs.mkdir(path.dirname(parsed.resultPath), { recursive: true });
    await fs.writeFile(parsed.resultPath, raw, "utf-8");
    await fs.writeFile(parsed.stdoutPath, results.map((result) => result.stdout).join("\n"), "utf-8");
    await fs.writeFile(parsed.stderrPath, results.map((result) => result.stderr).join("\n"), "utf-8");
    if (failed) {
      const classification = await this.classifyFailedCheck(state, failed, state.integration.headCommit ?? state.baseHash);
      if (classification.inherited) {
        const head = await this.git.worktreeStatus(parsed.workspacePath);
        const summary = `Integration checks only reproduced inherited failures for ${parsed.candidateId}.`;
        await this.emitObjective(parsed.objectiveId, {
          type: "integration.ready_to_promote",
          objectiveId: parsed.objectiveId,
          candidateId: parsed.candidateId,
          headCommit: head.head ?? state.integration.headCommit ?? state.baseHash,
          validationResults: results,
          summary,
          readyAt: Date.now(),
        });
        await this.commitIntegrationMemory(
          state,
          parsed.candidateId,
          `${summary}\n\n${this.inheritedFailureNote(failed, classification)}`,
          ["integration", "ready_to_promote", "inherited_failures"],
        );
        await this.reactObjective(parsed.objectiveId);
        return { objectiveId: parsed.objectiveId, candidateId: parsed.candidateId, status: "completed" };
      }
      await this.commitIntegrationMemory(state, parsed.candidateId, `Integration validation failed: ${failed.command}`, ["integration", "failed"]);
      await this.emitObjective(parsed.objectiveId, {
        type: "integration.conflicted",
        objectiveId: parsed.objectiveId,
        candidateId: parsed.candidateId,
        reason: `integration validation failed: ${failed.command}`,
        conflictedAt: Date.now(),
      });
      await this.spawnReconciliationTask(state, parsed.candidateId, `Resolve integration failure in ${failed.command}.`);
      await this.reactObjective(parsed.objectiveId);
      return { objectiveId: parsed.objectiveId, candidateId: parsed.candidateId, status: "failed" };
    }
    const head = await this.git.worktreeStatus(parsed.workspacePath);
    await this.emitObjective(parsed.objectiveId, {
      type: "integration.ready_to_promote",
      objectiveId: parsed.objectiveId,
      candidateId: parsed.candidateId,
      headCommit: head.head ?? state.integration.headCommit ?? state.baseHash,
      validationResults: results,
      summary: `Integration checks passed for ${parsed.candidateId}.`,
      readyAt: Date.now(),
    });
    await this.commitIntegrationMemory(state, parsed.candidateId, `Integration checks passed for ${parsed.candidateId}.`, ["integration", "ready_to_promote"]);
    await this.reactObjective(parsed.objectiveId);
    return { objectiveId: parsed.objectiveId, candidateId: parsed.candidateId, status: "completed" };
  }

  async loadFreshJob(jobId: string): Promise<JobRecord | undefined> {
    return this.queue.getJob(jobId);
  }

  private nextTaskOrdinal(state: FactoryState): number {
    return state.taskOrder
      .map((taskId) => /^task_(\d+)$/i.exec(taskId)?.[1])
      .map((value) => Number.parseInt(value ?? "", 10))
      .filter((value) => Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0);
  }

  private nextTaskId(state: FactoryState, offset = 0): string {
    return taskOrdinalId(this.nextTaskOrdinal(state) + offset);
  }

  private async dispatchTask(
    state: FactoryState,
    task: FactoryTaskRecord,
    opts?: {
      readonly expectedPrev?: string;
      readonly prefixEvents?: ReadonlyArray<FactoryEvent>;
    },
  ): Promise<void> {
    const profile = this.objectiveProfileForState(state);
    const workerType = this.normalizeProfileWorkerType(profile, String(task.workerType));
    if (!this.objectiveAllowsWorker(state, workerType)) {
      throw new FactoryServiceError(
        409,
        `worker '${workerType}' is not allowed by objective profile '${profile.rootProfileId}'`,
      );
    }
    if (this.objectiveWorktreeMode(state, workerType) === "forbidden") {
      throw new FactoryServiceError(
        409,
        `worker '${workerType}' is configured without a task worktree in objective profile '${profile.rootProfileId}'`,
      );
    }
    if (state.graph.activeNodeIds.length >= this.effectiveMaxParallelChildren(state)) {
      throw new FactoryServiceError(
        409,
        `objective already has ${state.graph.activeNodeIds.length} active child runs; profile limit is ${this.effectiveMaxParallelChildren(state)}`,
      );
    }
    const candidateId = this.resolveDispatchCandidateId(state, task);
    const candidateCreated = !state.candidates[candidateId]
      ? (() => {
        const createdAt = Date.now();
        const priorCandidate = this.latestTaskCandidate(state, task.taskId);
        return {
          type: "candidate.created",
          objectiveId: state.objectiveId,
          createdAt,
          candidate: {
            candidateId,
          taskId: task.taskId,
          status: "planned",
          parentCandidateId: priorCandidate?.candidateId,
          baseCommit: priorCandidate?.headCommit ?? this.resolveTaskBaseCommit(state, task),
          checkResults: [],
            artifactRefs: {},
            createdAt,
            updatedAt: createdAt,
          },
        } satisfies FactoryEvent;
      })()
      : undefined;

    const workspaceId = `${state.objectiveId}_${task.taskId}_${candidateId}`;
    const workspace = await this.ensureTaskWorkspace(state, task, workspaceId);
    const initialManifest = await this.writeTaskPacket(state, task, candidateId, workspace.path);
    const jobId = `job_factory_${state.objectiveId}_${task.taskId}_${candidateId}`;
    await this.emitObjectiveBatch(state.objectiveId, [
      ...(opts?.prefixEvents ?? []),
      ...(candidateCreated ? [candidateCreated] : []),
      {
        type: "task.dispatched",
        objectiveId: state.objectiveId,
        taskId: task.taskId,
        candidateId,
        jobId,
        workspaceId,
        workspacePath: workspace.path,
        skillBundlePaths: initialManifest.skillBundlePaths,
        contextRefs: initialManifest.contextRefs,
        startedAt: Date.now(),
      },
    ], opts?.expectedPrev);
    state = await this.getObjectiveState(state.objectiveId);
    const refreshedTask = state.graph.nodes[task.taskId] ?? task;
    const manifest = await this.writeTaskPacket(state, refreshedTask, candidateId, workspace.path);

    const payload: FactoryTaskJobPayload = {
      kind: "factory.task.run",
      objectiveId: state.objectiveId,
      taskId: task.taskId,
      workerType,
      candidateId,
      baseCommit: this.resolveTaskBaseCommit(state, task),
      workspaceId,
      workspacePath: workspace.path,
      promptPath: manifest.promptPath,
      resultPath: manifest.resultPath,
      stdoutPath: manifest.stdoutPath,
      stderrPath: manifest.stderrPath,
      lastMessagePath: manifest.lastMessagePath,
      manifestPath: manifest.manifestPath,
      contextPackPath: manifest.contextPackPath,
      memoryScriptPath: manifest.memoryScriptPath,
      memoryConfigPath: manifest.memoryConfigPath,
      repoSkillPaths: manifest.repoSkillPaths,
      skillBundlePaths: manifest.skillBundlePaths,
      profile,
      profilePromptHash: profile.promptHash,
      profileSkillRefs: profile.selectedSkills,
      sharedArtifactRefs: manifest.sharedArtifactRefs,
      contextRefs: manifest.contextRefs,
      integrationRef: state.integration.branchRef,
      problem: task.prompt,
      config: {
        workspace: workspace.path,
        memoryScope: `factory/objectives/${state.objectiveId}/tasks/${task.taskId}`,
        maxIterations: 6,
      },
    };
    const created = await this.queue.enqueue({
      jobId,
      agentId: "codex",
      lane: "collect",
      sessionKey: `factory:${state.objectiveId}:${task.taskId}`,
      singletonMode: "allow",
      maxAttempts: 2,
      payload,
    });
    this.sse.publish("jobs", created.id);
  }

  private async applyAction(
    state: FactoryState,
    action: FactoryAction,
    reason: string,
    confidence: number,
    source: "orchestrator" | "fallback" | "runtime",
    opts: {
      readonly basedOn?: string;
      readonly frontierTaskIds?: ReadonlyArray<string>;
      readonly prefixEvents?: ReadonlyArray<FactoryEvent>;
    } = {},
  ): Promise<void> {
    const appliedAt = Date.now();
    const basedOn = opts.basedOn ?? await this.currentHeadHash(state.objectiveId);
    const rebracket = opts.prefixEvents?.find((event): event is Extract<FactoryEvent, { readonly type: "rebracket.applied" }> => event.type === "rebracket.applied")
      ?? {
        type: "rebracket.applied",
        objectiveId: state.objectiveId,
        frontierTaskIds: opts.frontierTaskIds ?? state.taskOrder,
        selectedActionId: action.actionId,
        reason,
        confidence,
        source,
        basedOn,
        appliedAt,
      } satisfies FactoryEvent;
    const prefixEvents = opts.prefixEvents?.length
      ? [...opts.prefixEvents, ...(opts.prefixEvents.includes(rebracket) ? [] : [rebracket])]
      : [rebracket];

    if (action.type === "dispatch_child" && action.taskId) {
      const task = state.graph.nodes[action.taskId];
      if (!task) return;
      await this.dispatchTask(state, task, {
        expectedPrev: basedOn,
        prefixEvents,
      });
      return;
    }
    if (action.type === "queue_integration" && action.candidateId) {
      await this.queueIntegration(state, action.candidateId, {
        expectedPrev: basedOn,
        prefixEvents,
      });
      return;
    }
    if (action.type === "promote_integration" && action.candidateId) {
      await this.promoteIntegration(state, action.candidateId, {
        expectedPrev: basedOn,
        prefixEvents,
      });
      return;
    }
    if (action.type === "split_task" && action.taskId && action.tasks?.length) {
      await this.applySplitTaskAction(state, action.taskId, action.tasks, reason, prefixEvents, basedOn);
      return;
    }
    if (action.type === "reassign_task" && action.taskId && action.workerType) {
      const nextWorkerType = this.normalizeProfileWorkerType(this.objectiveProfileForState(state), action.workerType);
      const events: FactoryEvent[] = [...prefixEvents, {
        type: "task.worker.reassigned",
        objectiveId: state.objectiveId,
        taskId: action.taskId,
        workerType: nextWorkerType,
        reason,
        basedOn,
        updatedAt: appliedAt,
      }];
      const current = state.graph.nodes[action.taskId];
      if (current?.status === "blocked") {
        events.push({
          type: "task.unblocked",
          objectiveId: state.objectiveId,
          taskId: action.taskId,
          readyAt: appliedAt + 1,
        });
      }
      await this.emitObjectiveBatch(state.objectiveId, events, basedOn);
      return;
    }
    if (action.type === "update_dependencies" && action.taskId && action.dependsOn) {
      const events: FactoryEvent[] = [...prefixEvents, {
        type: "task.dependency.updated",
        objectiveId: state.objectiveId,
        taskId: action.taskId,
        dependsOn: action.dependsOn,
        reason,
        basedOn,
        updatedAt: appliedAt,
      }];
      const current = state.graph.nodes[action.taskId];
      if (current?.status === "blocked") {
        events.push({
          type: "task.unblocked",
          objectiveId: state.objectiveId,
          taskId: action.taskId,
          readyAt: appliedAt + 1,
        });
      }
      await this.emitObjectiveBatch(state.objectiveId, events, basedOn);
      return;
    }
    if (action.type === "unblock_task" && action.taskId) {
      await this.emitObjectiveBatch(state.objectiveId, [...prefixEvents, {
        type: "task.unblocked",
        objectiveId: state.objectiveId,
        taskId: action.taskId,
        readyAt: appliedAt,
      }], basedOn);
      return;
    }
    if (action.type === "supersede_task" && action.taskId) {
      const dependencyUpdates = this.buildDependencyReplacementEvents(
        state,
        action.taskId,
        state.graph.nodes[action.taskId]?.dependsOn ?? [],
        reason,
        basedOn,
        appliedAt,
      );
      await this.emitObjectiveBatch(state.objectiveId, [
        ...prefixEvents,
        ...dependencyUpdates,
        {
          type: "task.superseded",
          objectiveId: state.objectiveId,
          taskId: action.taskId,
          reason,
          supersededAt: appliedAt + dependencyUpdates.length,
        },
      ], basedOn);
      return;
    }
    if (action.type === "block_objective") {
      const blockReason = action.summary ?? reason;
      await this.emitObjectiveBatch(state.objectiveId, [...prefixEvents, {
        type: "objective.blocked",
        objectiveId: state.objectiveId,
        reason: blockReason,
        summary: blockReason,
        blockedAt: appliedAt,
      }], basedOn);
    }
  }

  private async applySplitTaskAction(
    state: FactoryState,
    sourceTaskId: string,
    drafts: ReadonlyArray<FactoryActionTaskDraft>,
    reason: string,
    prefixEvents: ReadonlyArray<FactoryEvent>,
    basedOn: string | undefined,
  ): Promise<void> {
    const source = state.graph.nodes[sourceTaskId];
    if (!source) return;
    const createdAt = Date.now();
    const newTasks: FactoryTaskRecord[] = [];
    let previousNewTaskId: string | undefined;
    for (const [index, draft] of drafts.entries()) {
      const taskId = this.nextTaskId(state, index);
      const dependsOn = index === 0
        ? [...new Set(source.dependsOn)]
        : [previousNewTaskId!];
      newTasks.push({
        nodeId: taskId,
        taskId,
        taskKind: "split",
        title: clipText(draft.title, 120) ?? draft.title,
        prompt: draft.prompt,
        workerType: this.normalizeProfileWorkerType(this.objectiveProfileForState(state), String(draft.workerType)),
        sourceTaskId,
        baseCommit: this.resolveTaskBaseCommit(state, source),
        dependsOn,
        status: "pending",
        skillBundlePaths: [],
        contextRefs: [
          stateRef(`${objectiveStream(state.objectiveId)}:task/${sourceTaskId}`, `source task ${sourceTaskId}`),
          ...source.contextRefs,
        ],
        artifactRefs: {},
        createdAt: createdAt + index,
        basedOn,
      });
      previousNewTaskId = taskId;
    }
    const dependencyUpdates = this.buildDependencyReplacementEvents(
      state,
      sourceTaskId,
      previousNewTaskId ? [previousNewTaskId] : [...source.dependsOn],
      reason,
      basedOn,
      createdAt + newTasks.length,
    );
    await this.emitObjectiveBatch(state.objectiveId, [
      ...prefixEvents,
      {
        type: "task.split",
        objectiveId: state.objectiveId,
        sourceTaskId,
        tasks: newTasks,
        reason,
        basedOn,
        createdAt,
      },
      ...dependencyUpdates,
      {
        type: "task.superseded",
        objectiveId: state.objectiveId,
        taskId: sourceTaskId,
        reason,
        supersededAt: createdAt + newTasks.length + dependencyUpdates.length,
      },
    ], basedOn);
  }

  private async queueIntegration(
    state: FactoryState,
    candidateId: string,
    opts?: {
      readonly expectedPrev?: string;
      readonly prefixEvents?: ReadonlyArray<FactoryEvent>;
    },
  ): Promise<void> {
    const candidate = state.candidates[candidateId];
    if (!candidate?.headCommit) throw new FactoryServiceError(409, "candidate has no commit to integrate");
    const workspace = await this.git.ensureIntegrationWorkspace(state.objectiveId, state.integration.headCommit ?? state.baseHash);
    const now = Date.now();
    await this.emitObjectiveBatch(state.objectiveId, [
      ...(opts?.prefixEvents ?? []),
      {
        type: "integration.queued",
        objectiveId: state.objectiveId,
        candidateId,
        branchName: workspace.branchName,
        branchRef: workspaceRef(workspace.path, "integration workspace"),
        queuedAt: now,
      },
      {
        type: "integration.merging",
        objectiveId: state.objectiveId,
        candidateId,
        startedAt: now + 1,
      },
    ], opts?.expectedPrev);

    try {
      const merged = await this.git.mergeCommitIntoWorkspace(
        workspace.path,
        candidate.headCommit,
        `[factory][${state.objectiveId}] integrate ${candidateId}`
      );
      await this.emitObjective(state.objectiveId, {
        type: "merge.applied",
        objectiveId: state.objectiveId,
        candidateId,
        taskId: candidate.taskId,
        summary: `Integrated ${candidateId} into ${workspace.branchName}.`,
        mergeCommit: merged.hash,
        appliedAt: Date.now(),
      });
      await this.emitObjective(state.objectiveId, {
        type: "task.integrated",
        objectiveId: state.objectiveId,
        taskId: candidate.taskId,
        summary: `Integrated ${candidateId}.`,
        integratedAt: Date.now(),
      });
      await this.enqueueIntegrationValidation(state.objectiveId, candidateId, workspace.path, state.checks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emitObjective(state.objectiveId, {
        type: "candidate.conflicted",
        objectiveId: state.objectiveId,
        candidateId,
        reason: message,
        conflictedAt: Date.now(),
      });
      await this.emitObjective(state.objectiveId, {
        type: "integration.conflicted",
        objectiveId: state.objectiveId,
        candidateId,
        reason: message,
        conflictedAt: Date.now(),
      });
      await this.spawnReconciliationTask(state, candidateId, `Reconcile ${candidateId} against the integration branch.`);
      await this.commitIntegrationMemory(state, candidateId, `Integration merge conflicted for ${candidateId}: ${message}`, ["integration", "conflicted"]);
      await this.reactObjective(state.objectiveId);
    }
  }

  private async enqueueIntegrationValidation(
    objectiveId: string,
    candidateId: string,
    workspacePath: string,
    checks: ReadonlyArray<string>,
  ): Promise<void> {
    const files = this.integrationFilePaths(workspacePath, candidateId);
    const payload: FactoryIntegrationJobPayload = {
      kind: "factory.integration.validate",
      objectiveId,
      candidateId,
      workspacePath,
      stdoutPath: files.stdoutPath,
      stderrPath: files.stderrPath,
      resultPath: files.resultPath,
      checks,
    };
    const created = await this.queue.enqueue({
      jobId: `job_factory_validate_${objectiveId}_${candidateId}`,
      agentId: "codex",
      lane: "collect",
      sessionKey: `factory:integration:${objectiveId}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload,
    });
    this.sse.publish("jobs", created.id);
  }

  private async promoteIntegration(
    state: FactoryState,
    candidateId: string,
    opts?: {
      readonly expectedPrev?: string;
      readonly prefixEvents?: ReadonlyArray<FactoryEvent>;
    },
  ): Promise<void> {
    const workspace = await this.git.ensureIntegrationWorkspace(state.objectiveId, state.integration.headCommit ?? state.baseHash);
    const status = await this.git.worktreeStatus(workspace.path);
    const commit = status.head ?? state.integration.headCommit;
    if (!commit) throw new FactoryServiceError(409, "integration branch has no HEAD to promote");
    await this.emitObjectiveBatch(state.objectiveId, [
      ...(opts?.prefixEvents ?? []),
      {
        type: "integration.promoting",
        objectiveId: state.objectiveId,
        candidateId,
        startedAt: Date.now(),
      },
    ], opts?.expectedPrev);
    let promoted: Awaited<ReturnType<HubGit["promoteCommit"]>>;
    try {
      promoted = await this.git.promoteCommit(commit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.match(/uncommitted changes/i)) {
        await this.emitObjective(state.objectiveId, {
          type: "integration.ready_to_promote",
          objectiveId: state.objectiveId,
          candidateId,
          headCommit: commit,
          validationResults: state.integration.validationResults,
          summary: state.integration.lastSummary ?? `Integration checks passed for ${candidateId}.`,
          readyAt: Date.now(),
        });
        await this.emitObjective(state.objectiveId, {
          type: "objective.blocked",
          objectiveId: state.objectiveId,
          reason: `Promotion blocked: ${message}`,
          summary: `Promotion blocked until the source branch is clean.`,
          blockedAt: Date.now(),
        });
        await this.commitIntegrationMemory(state, candidateId, `Promotion blocked until the source branch is clean.`, ["integration", "blocked"]);
        await this.rebalanceObjectiveSlots();
        return;
      }
      const freshBase = await this.git.resolveBaseHash();
      await this.git.ensureIntegrationWorkspace(state.objectiveId, freshBase, { resetToBase: true });
      await this.emitObjective(state.objectiveId, {
        type: "candidate.conflicted",
        objectiveId: state.objectiveId,
        candidateId,
        reason: message,
        conflictedAt: Date.now(),
      });
      await this.emitObjective(state.objectiveId, {
        type: "integration.conflicted",
        objectiveId: state.objectiveId,
        candidateId,
        reason: message,
        headCommit: freshBase,
        conflictedAt: Date.now(),
      });
      await this.spawnReconciliationTask(
        state,
        candidateId,
        `Reconcile ${candidateId} against the current source branch after promotion conflict.`,
        freshBase,
      );
      await this.commitIntegrationMemory(state, candidateId, `Promotion conflicted for ${candidateId}: ${message}`, ["integration", "conflicted"]);
      await this.reactObjective(state.objectiveId);
      return;
    }
    await this.emitObjective(state.objectiveId, {
      type: "integration.promoted",
      objectiveId: state.objectiveId,
      candidateId,
      promotedCommit: promoted.mergedHead,
      summary: `Promoted ${shortHash(promoted.mergedHead)} into ${promoted.targetBranch}.`,
      promotedAt: Date.now(),
    });
    await this.commitIntegrationMemory(state, candidateId, `Promoted ${shortHash(promoted.mergedHead)} into ${promoted.targetBranch}.`, ["integration", "promoted"]);
    await this.emitObjective(state.objectiveId, {
      type: "objective.completed",
      objectiveId: state.objectiveId,
      summary: `Factory objective completed with ${shortHash(promoted.mergedHead)} on ${promoted.targetBranch}.`,
      completedAt: Date.now(),
    });
    await this.rebalanceObjectiveSlots();
  }

  private async spawnReconciliationTask(
    state: FactoryState,
    candidateId: string,
    reason: string,
    baseCommit?: string,
  ): Promise<void> {
    const current = await this.getObjectiveState(state.objectiveId);
    const candidate = current.candidates[candidateId];
    if (!candidate) return;
    if (current.reconciliationTasksUsed >= current.policy.budgets.maxReconciliationTasks) {
      const blockedReason = `Policy blocked: objective exhausted maxReconciliationTasks (${current.reconciliationTasksUsed}/${current.policy.budgets.maxReconciliationTasks}).`;
      await this.emitObjective(current.objectiveId, {
        type: "objective.blocked",
        objectiveId: current.objectiveId,
        reason: blockedReason,
        summary: blockedReason,
        blockedAt: Date.now(),
      });
      return;
    }
    const basedOn = await this.currentHeadHash(current.objectiveId);
    const taskId = this.nextTaskId(current);
    const createdAt = Date.now();
    try {
      await this.emitObjectiveBatch(current.objectiveId, [{
        type: "task.added",
        objectiveId: current.objectiveId,
        createdAt,
        task: {
          nodeId: taskId,
          taskId,
          taskKind: "reconciliation",
          title: `Reconcile ${candidateId}`,
          prompt: `${reason}\nCurrent candidate: ${candidateId}\nObjective: ${current.prompt}`,
          workerType: this.normalizeProfileWorkerType(current.profile, "codex"),
          sourceTaskId: candidate.taskId,
          sourceCandidateId: candidateId,
          baseCommit: baseCommit ?? current.integration.headCommit ?? current.baseHash,
          dependsOn: [],
          status: "pending",
          skillBundlePaths: [],
          contextRefs: [
            stateRef(`${objectiveStream(current.objectiveId)}:task/${candidate.taskId}`, "prior task"),
            commitRef(baseCommit ?? current.integration.headCommit ?? current.baseHash, "integration head"),
          ],
          artifactRefs: {},
          createdAt,
          basedOn,
        },
      }], basedOn);
    } catch (err) {
      if (err instanceof FactoryStaleObjectiveError) {
        await this.spawnReconciliationTask(current, candidateId, reason, baseCommit);
        return;
      }
      throw err;
    }
  }

  private summarizedReceipts(
    chain: ReadonlyArray<{ readonly body: FactoryEvent; readonly hash: string; readonly ts: number }>,
    limit = 40,
  ): ReadonlyArray<{
    readonly type: string;
    readonly hash: string;
    readonly ts: number;
    readonly summary: string;
    readonly taskId?: string;
    readonly candidateId?: string;
  }> {
    return [...chain]
      .filter((receipt) => !CONTROL_RECEIPT_TYPES.has(receipt.body.type as never))
      .slice(-Math.max(1, Math.min(limit, 200)))
      .map((receipt) => {
        const ref = this.receiptTaskOrCandidateId(receipt.body);
        return {
          type: receipt.body.type,
          hash: receipt.hash,
          ts: receipt.ts,
          summary: this.summarizeReceipt(receipt.body),
          taskId: ref.taskId,
          candidateId: ref.candidateId,
        };
      });
  }

  private buildBlockedExplanation(
    state: FactoryState,
    receipts: ReadonlyArray<{
      readonly type: string;
      readonly hash: string;
      readonly ts: number;
      readonly summary: string;
      readonly taskId?: string;
      readonly candidateId?: string;
    }>,
  ): FactoryObjectiveCard["blockedExplanation"] | undefined {
    if (!state.blockedReason && state.status !== "blocked" && state.integration.status !== "conflicted") return undefined;
    const match = [...receipts]
      .reverse()
      .find((receipt) =>
        receipt.type === "objective.blocked"
        || receipt.type === "task.blocked"
        || receipt.type === "integration.conflicted"
        || receipt.type === "candidate.conflicted",
      );
    if (!match) {
      return state.blockedReason
        ? { summary: state.blockedReason }
        : undefined;
    }
    return {
      summary: match.summary,
      taskId: match.taskId,
      candidateId: match.candidateId,
      receiptType: match.type,
      receiptHash: match.hash,
    };
  }

  private buildEvidenceCards(
    receipts: ReadonlyArray<{
      readonly type: string;
      readonly hash: string;
      readonly ts: number;
      readonly summary: string;
      readonly taskId?: string;
      readonly candidateId?: string;
    }>,
  ): FactoryObjectiveDetail["evidenceCards"] {
    return receipts
      .filter((receipt) =>
        receipt.type === "objective.plan.proposed"
        || receipt.type === "objective.plan.adopted"
        || receipt.type === "rebracket.applied"
        || receipt.type === "objective.blocked"
        || receipt.type === "task.blocked"
        || receipt.type === "integration.conflicted"
        || receipt.type === "merge.applied"
        || receipt.type === "integration.ready_to_promote"
        || receipt.type === "integration.promoted",
      )
      .slice(-12)
      .map((receipt) => ({
        kind:
          receipt.type === "rebracket.applied" ? "decision"
          : receipt.type.startsWith("objective.plan") ? "plan"
          : receipt.type === "merge.applied" ? "merge"
          : receipt.type === "integration.ready_to_promote" || receipt.type === "integration.promoted" ? "promotion"
          : "blocked",
        title:
          receipt.type === "rebracket.applied" ? "Latest decision"
          : receipt.type === "objective.plan.proposed" ? "Plan proposed"
          : receipt.type === "objective.plan.adopted" ? "Plan adopted"
          : receipt.type === "merge.applied" ? "Integration merge"
          : receipt.type === "integration.ready_to_promote" ? "Ready to promote"
          : receipt.type === "integration.promoted" ? "Promoted"
          : "Blocked or conflicted",
        summary: receipt.summary,
        at: receipt.ts,
        taskId: receipt.taskId,
        candidateId: receipt.candidateId,
        receiptHash: receipt.hash,
        receiptType: receipt.type,
      }));
  }

  private buildActivity(
    tasks: ReadonlyArray<FactoryTaskView>,
    jobs: ReadonlyArray<QueueJob>,
    receipts: ReadonlyArray<{
      readonly type: string;
      readonly hash: string;
      readonly ts: number;
      readonly summary: string;
      readonly taskId?: string;
      readonly candidateId?: string;
    }>,
  ): FactoryObjectiveDetail["activity"] {
    const taskEntries = tasks
      .filter((task) => task.startedAt || task.reviewingAt || task.completedAt)
      .map((task) => ({
        kind: "task" as const,
        title: task.taskId,
        summary: `${task.title} [${task.status}]`,
        at: task.completedAt ?? task.reviewingAt ?? task.startedAt ?? task.createdAt,
        taskId: task.taskId,
        candidateId: task.candidateId,
      }));
    const jobEntries = jobs.slice(0, 10).map((job) => ({
      kind: "job" as const,
      title: job.id,
      summary: `${job.agentId} ${job.status}`,
      at: job.updatedAt,
      taskId: typeof (job.payload as Record<string, unknown>).taskId === "string" ? String((job.payload as Record<string, unknown>).taskId) : undefined,
      candidateId: typeof (job.payload as Record<string, unknown>).candidateId === "string" ? String((job.payload as Record<string, unknown>).candidateId) : undefined,
    }));
    const receiptEntries = receipts.slice(-12).map((receipt) => ({
      kind: "receipt" as const,
      title: receipt.type,
      summary: receipt.summary,
      at: receipt.ts,
      taskId: receipt.taskId,
      candidateId: receipt.candidateId,
    }));
    return [...taskEntries, ...jobEntries, ...receiptEntries]
      .sort((a, b) => b.at - a.at)
      .slice(0, 24);
  }

  private async buildObjectiveCard(
    state: FactoryState,
    queuePosition?: number,
    receipts?: ReadonlyArray<{
      readonly type: string;
      readonly hash: string;
      readonly ts: number;
      readonly summary: string;
      readonly taskId?: string;
      readonly candidateId?: string;
    }>,
  ): Promise<FactoryObjectiveCard> {
    const cacheKey = `${state.updatedAt}:${queuePosition ?? ""}`;
    const cached = this.objectiveCardCache.get(state.objectiveId);
    if (cached?.key === cacheKey) return cached.card;
    const projection = buildFactoryProjection(state);
    const latestCandidate = projection.candidates.at(-1);
    const resolvedReceipts = receipts ?? this.summarizedReceipts(await this.runtime.chain(objectiveStream(state.objectiveId)), 60);
    const slotState = state.scheduler.slotState ?? "active";
    const card = {
      objectiveId: state.objectiveId,
      title: state.title,
      status: state.status,
      phase: this.deriveObjectivePhase(state, {
        activeTasks: projection.activeTasks.length,
        readyTasks: projection.readyTasks.length,
      }),
      scheduler: {
        slotState,
        queuePosition,
      },
      repoProfile: state.repoProfile,
      archivedAt: state.archivedAt,
      updatedAt: state.updatedAt,
      latestSummary: state.latestSummary,
      blockedReason: state.blockedReason,
      blockedExplanation: this.buildBlockedExplanation(state, resolvedReceipts),
      latestDecision: this.deriveLatestDecision(state),
      nextAction: this.deriveNextAction(state, queuePosition),
      activeTaskCount: projection.activeTasks.length,
      readyTaskCount: projection.readyTasks.length,
      taskCount: projection.tasks.length,
      integrationStatus: state.integration.status,
      latestCommitHash: state.integration.promotedCommit ?? state.integration.headCommit ?? latestCandidate?.headCommit,
      profile: this.objectiveProfileForState(state),
    };
    this.objectiveCardCache.set(state.objectiveId, {
      key: cacheKey,
      card,
    });
    return card;
  }

  private async buildObjectiveDetail(state: FactoryState, queuePosition?: number): Promise<FactoryObjectiveDetail> {
    const [chain, jobs, repoSkillPaths] = await Promise.all([
      this.runtime.chain(objectiveStream(state.objectiveId)),
      this.queue.listJobs({ limit: 80 }),
      this.collectRepoSkillPaths(),
    ]);
    const receipts = this.summarizedReceipts(chain, 60);
    const sharedArtifactRefs = [
      artifactRef(this.objectiveProfileArtifactPath(state.objectiveId), "objective profile snapshot"),
      artifactRef(this.objectiveSkillSelectionArtifactPath(state.objectiveId), "objective profile skills"),
      ...state.repoProfile.generatedSkillRefs,
    ];
    const tasks = await Promise.all(
      state.taskOrder.map(async (taskId) => {
        const task = state.graph.nodes[taskId];
        const job = task?.jobId ? await this.loadFreshJob(task.jobId) : undefined;
        const workspaceStatus = task?.workspacePath
          ? await this.git.worktreeStatus(task.workspacePath)
          : { exists: false, dirty: false };
        const filePaths = task?.workspacePath ? this.taskFilePaths(task.workspacePath, task.taskId) : undefined;
        return {
          ...task,
          candidate: task?.candidateId ? state.candidates[task.candidateId] : undefined,
          jobStatus: job?.status ?? (task?.jobId ? "missing" : undefined),
          job,
          workspaceExists: workspaceStatus.exists,
          workspaceDirty: workspaceStatus.dirty,
          workspaceHead: workspaceStatus.head,
          elapsedMs: task?.startedAt ? Math.max(0, Date.now() - task.startedAt) : undefined,
          stdoutPath: filePaths?.stdoutPath,
          stderrPath: filePaths?.stderrPath,
          lastMessagePath: filePaths?.lastMessagePath,
          stdoutTail: filePaths ? await this.readTextTail(filePaths.stdoutPath, 900) : undefined,
          stderrTail: filePaths ? await this.readTextTail(filePaths.stderrPath, 600) : undefined,
          lastMessage: filePaths ? await this.readTextTail(filePaths.lastMessagePath, 400) : undefined,
        } satisfies FactoryTaskView;
      })
    );
    const objectiveJobs = jobs
      .filter((job) => {
        const payload = job.payload as Record<string, unknown>;
        return payload.objectiveId === state.objectiveId;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      ...await this.buildObjectiveCard(state, queuePosition, receipts),
      prompt: state.prompt,
      channel: state.channel,
      baseHash: state.baseHash,
      checks: state.checks,
      profile: this.objectiveProfileForState(state),
      policy: state.policy,
      contextSources: this.buildContextSources(state, repoSkillPaths, sharedArtifactRefs),
      budgetState: this.buildBudgetState(state),
      createdAt: state.createdAt,
      tasks,
      candidates: state.candidateOrder
        .map((candidateId) => state.candidates[candidateId])
        .filter((candidate): candidate is FactoryCandidateRecord => Boolean(candidate)),
      integration: state.integration,
      recentReceipts: receipts,
      evidenceCards: this.buildEvidenceCards(receipts),
      activity: this.buildActivity(tasks, objectiveJobs, receipts),
      latestRebracket: state.latestRebracket,
    };
  }

  private async buildObjectiveDebug(state: FactoryState, queuePosition?: number): Promise<FactoryDebugProjection> {
    const [detail, chain, jobs] = await Promise.all([
      this.buildObjectiveDetail(state, queuePosition),
      this.runtime.chain(objectiveStream(state.objectiveId)),
      this.queue.listJobs({ limit: 80 }),
    ]);
    const objectiveJobs = jobs
      .filter((job) => {
        const payload = job.payload as Record<string, unknown>;
        return payload.objectiveId === state.objectiveId;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const activeJobs = objectiveJobs.filter((job) => !isTerminalJobStatus(job.status)).slice(0, 12);
    const taskWorktrees = await Promise.all(
      detail.tasks.map(async (task) => {
        const status = task.workspacePath
          ? await this.git.worktreeStatus(task.workspacePath)
          : { exists: false, dirty: false };
        return {
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          exists: status.exists,
          dirty: status.dirty,
          head: status.head,
          branch: status.branch,
        };
      }),
    );
    const integrationWorktree = state.integration.branchRef?.kind === "workspace"
      ? await this.git.worktreeStatus(state.integration.branchRef.ref).then((status) => ({
        workspacePath: state.integration.branchRef?.kind === "workspace" ? state.integration.branchRef.ref : undefined,
        exists: status.exists,
        dirty: status.dirty,
        head: status.head,
        branch: status.branch,
      }))
      : undefined;
    return {
      objectiveId: state.objectiveId,
      title: state.title,
      status: state.status,
      phase: detail.phase,
      scheduler: detail.scheduler,
      repoProfile: detail.repoProfile,
      latestDecision: detail.latestDecision,
      nextAction: detail.nextAction,
      profile: detail.profile,
      policy: state.policy,
      contextSources: detail.contextSources,
      budgetState: detail.budgetState,
      recentReceipts: this.summarizedReceipts(chain, 40).map((receipt) => ({
        type: receipt.type,
        hash: receipt.hash,
        ts: receipt.ts,
        summary: receipt.summary,
      })),
      activeJobs,
      lastJobs: objectiveJobs.slice(0, 20),
      taskWorktrees,
      integrationWorktree,
      latestContextPacks: detail.tasks.map((task) => {
        if (!task.workspacePath) {
          return {
            taskId: task.taskId,
            candidateId: task.candidateId,
            contextPackPath: undefined,
            memoryScriptPath: undefined,
          };
        }
        const files = this.taskFilePaths(task.workspacePath, task.taskId);
        return {
          taskId: task.taskId,
          candidateId: task.candidateId,
          contextPackPath: files.contextPackPath,
          memoryScriptPath: files.memoryScriptPath,
        };
      }),
    };
  }

  private async emitObjectiveBatch(
    objectiveId: string,
    events: ReadonlyArray<FactoryEvent>,
    expectedPrev?: string,
  ): Promise<void> {
    if (events.length === 0) return;
    const stream = objectiveStream(objectiveId);
    try {
      await this.runtime.execute(stream, {
        type: "emit",
        eventId: makeEventId(stream),
        events,
        expectedPrev,
      });
    } catch (err) {
      if (
        typeof expectedPrev === "string"
        && err instanceof Error
        && err.message.startsWith("Expected prev hash ")
      ) {
        const actualPrev = /but head is (.+)$/.exec(err.message)?.[1];
        throw new FactoryStaleObjectiveError(objectiveId, expectedPrev, actualPrev);
      }
      throw err;
    }
    this.invalidateObjectiveProjection(objectiveId);
    this.sse.publish("factory", objectiveId);
    this.sse.publish("receipt");
  }

  private async emitObjective(objectiveId: string, event: FactoryEvent): Promise<void> {
    await this.emitObjectiveBatch(objectiveId, [event]);
  }

  private async currentHeadHash(objectiveId: string): Promise<string | undefined> {
    const chain = await this.runtime.chain(objectiveStream(objectiveId));
    return chain[chain.length - 1]?.hash;
  }

  private async discoverObjectiveStreams(): Promise<ReadonlyArray<string>> {
    const discovered = new Set<string>();
    const manifestPath = path.join(this.dataDir, "_streams.json");
    const raw = await fs.readFile(manifestPath, "utf-8").catch(() => "");
    if (raw.trim()) {
      try {
        const manifest = JSON.parse(raw) as { readonly byStream?: Record<string, string> };
        for (const stream of Object.keys(manifest.byStream ?? {})) {
          if (stream.startsWith(`${FACTORY_STREAM_PREFIX}/`)) {
            discovered.add(stream);
          }
        }
      } catch {
        // fall through to file scan
      }
    }
    const files = await fs.readdir(this.dataDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(this.dataDir, file);
      const firstLine = (await fs.readFile(filePath, "utf-8").catch(() => ""))
        .split(/\r?\n/)
        .find((line) => line.trim());
      if (!firstLine) continue;
      try {
        const parsed = JSON.parse(firstLine) as { readonly stream?: string };
        if (typeof parsed.stream === "string" && parsed.stream.startsWith(`${FACTORY_STREAM_PREFIX}/`)) {
          discovered.add(parsed.stream);
        }
      } catch {
        // ignore unrelated or corrupt files here; the runtime will surface corruption on actual reads
      }
    }
    return [...discovered];
  }

  private async decomposeObjective(
    state: FactoryState,
  ): Promise<{
    readonly tasks: ReadonlyArray<DecomposedTaskSpec>;
    readonly fallback: boolean;
  }> {
    const title = state.title;
    const prompt = state.prompt;
    const profile = this.objectiveProfileForState(state);
    if (this.llmStructured) {
      try {
        const { parsed } = await this.llmStructured({
          schema: decompositionSchema,
          schemaName: "factory_task_decomposition",
          system: [
            "Decompose the objective into a small DAG of implementation tasks.",
            `Return only actionable implementation or validation tasks. Use workerType ${profile.objectivePolicy.defaultWorkerType} unless a specialist is clearly better.`,
            `Allowed worker types for this objective: ${profile.objectivePolicy.allowedWorkerTypes.join(", ")}.`,
            "Avoid pure search, locate, identify, or report-only tasks when the overall objective is to change code.",
            "Fold discovery work into the implementation task prompt unless the objective is explicitly investigation-only.",
            "Each non-validation task should be expected to produce a tracked repository diff.",
            "Keep dependency edges between task IDs by referring to earlier returned task ids like task_01, task_02.",
          ].join("\n"),
          user: JSON.stringify({ title, prompt }, null, 2),
        });
        const normalized = this.normalizeDecomposedTasks(parsed.tasks, profile);
        if (normalized.length > 0) {
          return {
            tasks: normalized,
            fallback: false,
          };
        }
      } catch {
        // fall through to deterministic fallback
      }
    }
    return {
      tasks: [{
        taskId: taskOrdinalId(0),
        title: clipText(title, 120) ?? title,
        prompt,
        workerType: profile.objectivePolicy.defaultWorkerType,
        dependsOn: [],
      }],
      fallback: true,
    };
  }

  private normalizeDecomposedTasks(
    tasks: ReadonlyArray<{
      readonly title: string;
      readonly prompt: string;
      readonly workerType: string;
      readonly dependsOn: ReadonlyArray<string>;
    }>,
    profile: FactoryObjectiveProfileSnapshot,
  ): ReadonlyArray<DecomposedTaskSpec> {
    const normalized: DecomposedTaskSpec[] = [];
    for (const [index, task] of tasks.entries()) {
      const taskId = taskOrdinalId(index);
      const title = clipText(task.title, 120) ?? task.title.trim();
      const prompt = task.prompt.trim();
      if (!title || !prompt) continue;
      const dependsOn = this.normalizeDecompositionDependencies(index, task.dependsOn);
      normalized.push({
        taskId,
        title,
        prompt,
        workerType: this.normalizeProfileWorkerType(profile, task.workerType),
        dependsOn,
      });
    }
    return this.collapseDiscoveryOnlyTasks(normalized);
  }

  private collapseDiscoveryOnlyTasks(tasks: ReadonlyArray<DecomposedTaskSpec>): ReadonlyArray<DecomposedTaskSpec> {
    let current = tasks.map((task) => ({
      ...task,
      dependsOn: [...task.dependsOn],
    }));
    let changed = true;
    while (changed) {
      changed = false;
      const removedTaskIds = new Set<string>();
      const inheritedDeps = new Map<string, string[]>();
      const inheritedPrompts = new Map<string, string[]>();
      for (const task of current) {
        if (!this.isDiscoveryOnlyTask(task)) continue;
        const children = current.filter((candidate) => candidate.dependsOn.includes(task.taskId));
        if (children.length === 0) continue;
        changed = true;
        removedTaskIds.add(task.taskId);
        for (const child of children) {
          inheritedDeps.set(child.taskId, [
            ...(inheritedDeps.get(child.taskId) ?? []),
            ...task.dependsOn,
          ]);
          inheritedPrompts.set(child.taskId, [
            ...(inheritedPrompts.get(child.taskId) ?? []),
            `Before making changes, ${task.prompt}`,
          ]);
        }
      }
      if (!changed) break;
      const filtered = current
        .filter((task) => !removedTaskIds.has(task.taskId))
        .map((task) => ({
          ...task,
          prompt: [...(inheritedPrompts.get(task.taskId) ?? []), task.prompt].join("\n\n"),
          dependsOn: [...new Set([
            ...(inheritedDeps.get(task.taskId) ?? []),
            ...task.dependsOn.filter((depId) => !removedTaskIds.has(depId)),
          ])],
        }));
      const idMap = new Map(filtered.map((task, index) => [task.taskId, taskOrdinalId(index)] as const));
      current = filtered.map((task, index) => ({
        ...task,
        taskId: taskOrdinalId(index),
        dependsOn: [...new Set(task.dependsOn
          .map((depId) => idMap.get(depId))
          .filter((depId): depId is string => Boolean(depId)))],
      }));
    }
    return current;
  }

  private isDiscoveryOnlyTask(task: Pick<DecomposedTaskSpec, "title" | "prompt">): boolean {
    const text = `${task.title}\n${task.prompt}`;
    return DISCOVERY_ONLY_RE.test(text) && !DIFF_PRODUCING_RE.test(text);
  }

  private normalizeDecompositionDependencies(
    taskIndex: number,
    requested: ReadonlyArray<string>,
  ): ReadonlyArray<string> {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const dep of requested) {
      const trimmed = dep.trim();
      const match = /^task_(\d+)$/i.exec(trimmed);
      if (!match) continue;
      const ordinal = Number.parseInt(match[1] ?? "", 10);
      if (!Number.isFinite(ordinal) || ordinal <= 0 || ordinal >= taskIndex + 1) continue;
      const canonical = taskOrdinalId(ordinal - 1);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      normalized.push(canonical);
    }
    return normalized;
  }

  private normalizeExistingDependencies(
    state: FactoryState,
    taskId: string,
    requested: ReadonlyArray<string>,
  ): ReadonlyArray<string> {
    const taskIndex = state.taskOrder.indexOf(taskId);
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const depId of requested) {
      const trimmed = depId.trim();
      if (!trimmed || trimmed === taskId || seen.has(trimmed)) continue;
      const dep = state.graph.nodes[trimmed];
      if (!dep || dep.status === "superseded") continue;
      const depIndex = state.taskOrder.indexOf(trimmed);
      if (taskIndex >= 0 && depIndex >= taskIndex) continue;
      if (this.dependsTransitivelyOn(state, trimmed, taskId)) continue;
      seen.add(trimmed);
      normalized.push(trimmed);
    }
    return normalized;
  }

  private directDependents(
    state: FactoryState,
    taskId: string,
  ): ReadonlyArray<FactoryTaskRecord> {
    return state.taskOrder
      .map((id) => state.graph.nodes[id])
      .filter((task): task is FactoryTaskRecord => Boolean(task))
      .filter((task) => task.dependsOn.includes(taskId));
  }

  private buildDependencyReplacementEvents(
    state: FactoryState,
    sourceTaskId: string,
    replacementDependsOn: ReadonlyArray<string>,
    reason: string,
    basedOn: string | undefined,
    updatedAt: number,
  ): ReadonlyArray<FactoryEvent> {
    const replacement = [...new Set(replacementDependsOn.filter((depId) => depId && depId !== sourceTaskId))];
    const events: FactoryEvent[] = [];
    for (const [index, dependent] of this.directDependents(state, sourceTaskId).entries()) {
      const nextDependsOn = [...new Set(dependent.dependsOn.flatMap((depId) =>
        depId === sourceTaskId ? replacement : [depId]
      ))];
      if (
        nextDependsOn.length === dependent.dependsOn.length
        && nextDependsOn.every((depId, dependencyIndex) => depId === dependent.dependsOn[dependencyIndex])
      ) {
        continue;
      }
      events.push({
        type: "task.dependency.updated",
        objectiveId: state.objectiveId,
        taskId: dependent.taskId,
        dependsOn: nextDependsOn,
        reason,
        basedOn,
        updatedAt: updatedAt + index,
      });
    }
    return events;
  }

  private dependsTransitivelyOn(
    state: FactoryState,
    taskId: string,
    targetTaskId: string,
    seen = new Set<string>(),
  ): boolean {
    if (seen.has(taskId)) return false;
    seen.add(taskId);
    const task = state.graph.nodes[taskId];
    if (!task) return false;
    if (task.dependsOn.includes(targetTaskId)) return true;
    return task.dependsOn.some((depId) => this.dependsTransitivelyOn(state, depId, targetTaskId, seen));
  }

  private isMutationAction(actionType: FactoryAction["type"]): boolean {
    return actionType === "split_task"
      || actionType === "reassign_task"
      || actionType === "update_dependencies"
      || actionType === "unblock_task"
      || actionType === "supersede_task";
  }

  private latestTaskCandidate(state: FactoryState, taskId: string): FactoryCandidateRecord | undefined {
    for (let index = state.candidateOrder.length - 1; index >= 0; index -= 1) {
      const candidateId = state.candidateOrder[index];
      const candidate = state.candidates[candidateId];
      if (candidate?.taskId === taskId) return candidate;
    }
    return undefined;
  }

  private nextCandidateId(state: FactoryState, taskId: string): string {
    const ordinal = state.candidateOrder
      .map((candidateId) => state.candidates[candidateId])
      .filter((candidate): candidate is FactoryCandidateRecord => candidate?.taskId === taskId)
      .map((candidate) => /^.+_candidate_(\d+)$/i.exec(candidate.candidateId)?.[1])
      .map((value) => Number.parseInt(value ?? "", 10))
      .filter((value) => Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0);
    return `${taskId}_candidate_${String(ordinal + 1).padStart(2, "0")}`;
  }

  private resolveDispatchCandidateId(state: FactoryState, task: FactoryTaskRecord): string {
    const latest = this.latestTaskCandidate(state, task.taskId);
    if (!latest) return `${task.taskId}_candidate_01`;
    if (["planned", "running", "awaiting_review"].includes(latest.status)) return latest.candidateId;
    return this.nextCandidateId(state, task.taskId);
  }

  private collectDependencyClosure(
    state: FactoryState,
    taskId: string,
    seen = new Set<string>(),
  ): ReadonlyArray<string> {
    if (seen.has(taskId)) return [];
    seen.add(taskId);
    const task = state.graph.nodes[taskId];
    if (!task) return [];
    const collected: string[] = [];
    for (const depId of task.dependsOn) {
      collected.push(depId);
      for (const nested of this.collectDependencyClosure(state, depId, seen)) {
        if (!collected.includes(nested)) collected.push(nested);
      }
    }
    return collected;
  }

  private async summarizeScope(scope: string, query: string, maxChars: number): Promise<string | undefined> {
    if (!this.memoryTools) return undefined;
    try {
      const { summary } = await this.memoryTools.summarize({
        scope,
        query,
        limit: 6,
        maxChars,
      });
      return summary.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async buildContextNode(
    state: FactoryState,
    taskId: string,
  ): Promise<FactoryContextTaskNode | undefined> {
    const task = state.graph.nodes[taskId];
    if (!task) return undefined;
    const candidate = this.latestTaskCandidate(state, taskId);
    const memorySummary = await this.summarizeScope(
      `factory/objectives/${state.objectiveId}/tasks/${taskId}`,
      `${task.title}\n${task.prompt}`,
      320,
    );
    const children = await Promise.all(task.dependsOn.map((depId) => this.buildContextNode(state, depId)));
    return {
      taskId: task.taskId,
      taskKind: task.taskKind,
      title: task.title,
      status: task.status,
      workerType: task.workerType,
      sourceTaskId: task.sourceTaskId,
      sourceCandidateId: task.sourceCandidateId,
      latestSummary: task.latestSummary,
      blockedReason: task.blockedReason,
      candidateId: candidate?.candidateId,
      candidateStatus: candidate?.status,
      memorySummary,
      children: children.filter((child): child is FactoryContextTaskNode => Boolean(child)),
    };
  }

  private async buildRelatedContextTask(
    state: FactoryState,
    taskId: string,
    relations: ReadonlySet<"focus" | "dependency" | "dependent" | "split_source" | "split_child">,
  ): Promise<FactoryContextRelatedTask | undefined> {
    const task = state.graph.nodes[taskId];
    if (!task) return undefined;
    const candidate = this.latestTaskCandidate(state, taskId);
    const memorySummary = await this.summarizeScope(
      `factory/objectives/${state.objectiveId}/tasks/${taskId}`,
      `${task.title}\n${task.prompt}`,
      320,
    );
    const relationOrder = ["focus", "dependency", "dependent", "split_source", "split_child"] as const;
    return {
      taskId: task.taskId,
      taskKind: task.taskKind,
      title: task.title,
      status: task.status,
      workerType: task.workerType,
      sourceTaskId: task.sourceTaskId,
      sourceCandidateId: task.sourceCandidateId,
      relations: relationOrder.filter((relation) => relations.has(relation)),
      latestSummary: task.latestSummary,
      blockedReason: task.blockedReason,
      candidateId: candidate?.candidateId,
      candidateStatus: candidate?.status,
      memorySummary,
    };
  }

  private summarizeReceipt(event: FactoryEvent): string {
    switch (event.type) {
      case "repo.profile.requested":
        return "Repo profile requested.";
      case "repo.profile.generated":
        return `Repo profile ${event.source === "reused" ? "reused" : "generated"}: ${event.summary}`;
      case "objective.plan.proposed":
        return `Plan proposed: ${event.summary}`;
      case "objective.plan.adopted":
        return `Plan adopted: ${event.summary}`;
      case "objective.operator.noted":
        return `Operator note: ${event.message}`;
      case "objective.slot.queued":
        return "Objective queued for the repo execution slot.";
      case "objective.slot.admitted":
        return "Objective admitted to the repo execution slot.";
      case "objective.slot.released":
        return `Objective released its slot: ${event.reason}`;
      case "task.added":
        return `${event.task.taskId} added: ${event.task.title}`;
      case "task.split":
        return `${event.sourceTaskId} split into ${event.tasks.map((task) => task.taskId).join(", ")}`;
      case "task.worker.reassigned":
        return `${event.taskId} reassigned to ${event.workerType}: ${event.reason}`;
      case "task.dependency.updated":
        return `${event.taskId} deps -> ${event.dependsOn.join(", ") || "none"}: ${event.reason}`;
      case "task.blocked":
        return `${event.taskId} blocked: ${event.reason}`;
      case "task.unblocked":
        return `${event.taskId} unblocked`;
      case "task.superseded":
        return `${event.taskId} superseded: ${event.reason}`;
      case "candidate.produced":
        return `${event.candidateId} produced: ${event.summary}`;
      case "candidate.reviewed":
        return `${event.candidateId} ${event.status}: ${event.summary}`;
      case "candidate.conflicted":
        return `${event.candidateId} conflicted: ${event.reason}`;
      case "integration.conflicted":
        return `integration conflicted: ${event.reason}`;
      case "integration.ready_to_promote":
        return `integration ready: ${event.summary}`;
      case "integration.promoted":
        return `promoted: ${event.summary}`;
      case "rebracket.applied":
        return `orchestration chose ${event.selectedActionId ?? "none"}: ${event.reason}`;
      default:
        return event.type;
    }
  }

  private receiptTaskOrCandidateId(event: FactoryEvent): { readonly taskId?: string; readonly candidateId?: string } {
    switch (event.type) {
      case "task.added":
        return { taskId: event.task.taskId };
      case "task.split":
        return { taskId: event.sourceTaskId };
      case "task.dependency.updated":
      case "task.worker.reassigned":
      case "task.ready":
      case "task.review.requested":
      case "task.approved":
      case "task.integrated":
      case "task.blocked":
      case "task.unblocked":
      case "task.superseded":
        return { taskId: event.taskId };
      case "task.dispatched":
        return { taskId: event.taskId, candidateId: event.candidateId };
      case "candidate.created":
        return { taskId: event.candidate.taskId, candidateId: event.candidate.candidateId };
      case "candidate.produced":
      case "candidate.reviewed":
        return { taskId: event.taskId, candidateId: event.candidateId };
      case "candidate.conflicted":
      case "merge.candidate.scored":
      case "integration.queued":
      case "integration.merging":
      case "integration.validating":
      case "integration.ready_to_promote":
      case "integration.promoting":
      case "integration.promoted":
        return { candidateId: event.candidateId };
      case "merge.applied":
        return { taskId: event.taskId, candidateId: event.candidateId };
      case "integration.conflicted":
        return { candidateId: event.candidateId };
      default:
        return {};
    }
  }

  private buildSplitIndex(chain: ReadonlyArray<{ readonly body: FactoryEvent }>): {
    readonly childrenBySource: ReadonlyMap<string, ReadonlyArray<string>>;
    readonly parentByChild: ReadonlyMap<string, string>;
  } {
    const childrenBySource = new Map<string, string[]>();
    const parentByChild = new Map<string, string>();
    for (const receipt of chain) {
      const event = receipt.body;
      if (event.type !== "task.split") continue;
      const children = event.tasks.map((task) => task.taskId);
      childrenBySource.set(event.sourceTaskId, [...(childrenBySource.get(event.sourceTaskId) ?? []), ...children]);
      for (const child of children) parentByChild.set(child, event.sourceTaskId);
    }
    return { childrenBySource, parentByChild };
  }

  private collectDependentClosure(
    state: FactoryState,
    taskId: string,
    seen = new Set<string>(),
  ): ReadonlyArray<string> {
    if (seen.has(taskId)) return [];
    seen.add(taskId);
    const directDependents = state.taskOrder
      .map((id) => state.graph.nodes[id])
      .filter((task): task is FactoryTaskRecord => Boolean(task))
      .filter((task) => task.dependsOn.includes(taskId))
      .map((task) => task.taskId);
    const collected: string[] = [];
    for (const dependentId of directDependents) {
      if (!collected.includes(dependentId)) collected.push(dependentId);
      for (const nested of this.collectDependentClosure(state, dependentId, seen)) {
        if (!collected.includes(nested)) collected.push(nested);
      }
    }
    return collected;
  }

  private collectSplitClosure(
    taskId: string,
    splitIndex: {
      readonly childrenBySource: ReadonlyMap<string, ReadonlyArray<string>>;
      readonly parentByChild: ReadonlyMap<string, string>;
    },
    seen = new Set<string>(),
  ): ReadonlyArray<{ readonly taskId: string; readonly relation: "split_source" | "split_child" }> {
    if (seen.has(taskId)) return [];
    seen.add(taskId);
    const collected: Array<{ readonly taskId: string; readonly relation: "split_source" | "split_child" }> = [];
    const parent = splitIndex.parentByChild.get(taskId);
    if (parent) {
      collected.push({ taskId: parent, relation: "split_source" });
      for (const nested of this.collectSplitClosure(parent, splitIndex, seen)) {
        if (!collected.some((item) => item.taskId === nested.taskId && item.relation === nested.relation)) collected.push(nested);
      }
    }
    for (const child of splitIndex.childrenBySource.get(taskId) ?? []) {
      collected.push({ taskId: child, relation: "split_child" });
      for (const nested of this.collectSplitClosure(child, splitIndex, seen)) {
        if (!collected.some((item) => item.taskId === nested.taskId && item.relation === nested.relation)) collected.push(nested);
      }
    }
    return collected;
  }

  private collectContextSubgraphRelations(
    state: FactoryState,
    taskId: string,
    splitIndex: {
      readonly childrenBySource: ReadonlyMap<string, ReadonlyArray<string>>;
      readonly parentByChild: ReadonlyMap<string, string>;
    },
  ): ReadonlyMap<string, ReadonlySet<"focus" | "dependency" | "dependent" | "split_source" | "split_child">> {
    const relations = new Map<string, Set<"focus" | "dependency" | "dependent" | "split_source" | "split_child">>();
    const mark = (targetTaskId: string, relation: "focus" | "dependency" | "dependent" | "split_source" | "split_child"): void => {
      const current = relations.get(targetTaskId) ?? new Set<"focus" | "dependency" | "dependent" | "split_source" | "split_child">();
      current.add(relation);
      relations.set(targetTaskId, current);
    };
    mark(taskId, "focus");
    for (const depId of this.collectDependencyClosure(state, taskId)) mark(depId, "dependency");
    for (const dependentId of this.collectDependentClosure(state, taskId)) mark(dependentId, "dependent");
    for (const relation of this.collectSplitClosure(taskId, splitIndex)) mark(relation.taskId, relation.relation);
    return relations;
  }

  private taskRecency(task: FactoryTaskRecord): number {
    return task.completedAt ?? task.reviewingAt ?? task.startedAt ?? task.readyAt ?? task.createdAt;
  }

  private async buildObjectiveSliceTasks(
    state: FactoryState,
    taskIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<FactoryContextRelatedTask>> {
    const items = await Promise.all(
      taskIds.map((taskId) =>
        this.buildRelatedContextTask(
          state,
          taskId,
          new Set<"focus" | "dependency" | "dependent" | "split_source" | "split_child">(),
        )
      ),
    );
    return items.filter((item): item is FactoryContextRelatedTask => Boolean(item));
  }

  private async buildTaskContextPack(
    state: FactoryState,
    task: FactoryTaskRecord,
    candidateId: string,
  ): Promise<FactoryContextPack> {
    const chain = await this.runtime.chain(objectiveStream(state.objectiveId));
    const splitIndex = this.buildSplitIndex(chain);
    const dependencyIds = this.collectDependencyClosure(state, task.taskId);
    const dependencyTree = await Promise.all(task.dependsOn.map((depId) => this.buildContextNode(state, depId)));
    const subgraphRelations = this.collectContextSubgraphRelations(state, task.taskId, splitIndex);
    const relatedTasks = await Promise.all(
      [...subgraphRelations.entries()].map(([relatedTaskId, relations]) =>
        this.buildRelatedContextTask(state, relatedTaskId, relations)
      ),
    );
    const lineage = state.candidateOrder
      .map((id) => state.candidates[id])
      .filter((candidate): candidate is FactoryCandidateRecord => candidate?.taskId === task.taskId)
      .map((candidate) => ({
        candidateId: candidate.candidateId,
        parentCandidateId: candidate.parentCandidateId,
        status: candidate.status,
        summary: candidate.summary,
        headCommit: candidate.headCommit,
        latestReason: candidate.latestReason,
      }));
    const relatedTaskIds = new Set<string>([...subgraphRelations.keys(), ...dependencyIds]);
    const relatedCandidateIds = new Set<string>([
      candidateId,
      ...lineage.map((candidate) => candidate.candidateId),
      ...state.candidateOrder
        .map((id) => state.candidates[id])
        .filter((candidate): candidate is FactoryCandidateRecord => Boolean(candidate) && relatedTaskIds.has(candidate.taskId))
        .map((candidate) => candidate.candidateId),
    ]);
    const recentReceipts = [...chain]
      .reverse()
      .filter((receipt) => {
        const ref = this.receiptTaskOrCandidateId(receipt.body);
        return (ref.taskId && relatedTaskIds.has(ref.taskId))
          || (ref.candidateId && relatedCandidateIds.has(ref.candidateId))
          || receipt.body.type.startsWith("integration.")
          || receipt.body.type === "rebracket.applied";
      })
      .slice(0, 12)
      .reverse()
      .map((receipt) => {
        const ref = this.receiptTaskOrCandidateId(receipt.body);
        return {
          type: receipt.body.type,
          at: receipt.ts,
          taskId: ref.taskId,
          candidateId: ref.candidateId,
          summary: this.summarizeReceipt(receipt.body),
        } satisfies FactoryContextReceipt;
      });
    const focusedReceiptKeys = new Set(recentReceipts.map((receipt) => `${receipt.type}:${receipt.at}:${receipt.summary}`));
    const objectiveTasks = state.taskOrder
      .map((taskId) => state.graph.nodes[taskId])
      .filter((node): node is FactoryTaskRecord => Boolean(node));
    const frontierTaskIds = objectiveTasks
      .filter((item) => ["ready", "running", "reviewing", "blocked"].includes(item.status))
      .sort((a, b) =>
        objectiveTaskStatusPriority(a.status) - objectiveTaskStatusPriority(b.status)
        || this.taskRecency(b) - this.taskRecency(a)
        || a.taskId.localeCompare(b.taskId)
      )
      .slice(0, 12)
      .map((item) => item.taskId);
    const recentCompletedTaskIds = objectiveTasks
      .filter((item) => ["approved", "integrated", "blocked", "superseded"].includes(item.status))
      .sort((a, b) => this.taskRecency(b) - this.taskRecency(a) || a.taskId.localeCompare(b.taskId))
      .slice(0, 8)
      .map((item) => item.taskId);
    const integrationTaskIds = objectiveTasks
      .filter((item) => {
        const candidateIdForTask = item.candidateId;
        if (!candidateIdForTask) return false;
        return state.integration.activeCandidateId === candidateIdForTask
          || state.integration.queuedCandidateIds.includes(candidateIdForTask);
      })
      .map((item) => item.taskId);
    const recentObjectiveReceipts = [...chain]
      .filter((receipt) => !CONTROL_RECEIPT_TYPES.has(receipt.body.type as never))
      .reverse()
      .map((receipt) => {
        const ref = this.receiptTaskOrCandidateId(receipt.body);
        return {
          type: receipt.body.type,
          at: receipt.ts,
          taskId: ref.taskId,
          candidateId: ref.candidateId,
          summary: this.summarizeReceipt(receipt.body),
        } satisfies FactoryContextReceipt;
      })
      .filter((receipt) => !focusedReceiptKeys.has(`${receipt.type}:${receipt.at}:${receipt.summary}`))
      .slice(0, 20)
      .reverse();
    const [overview, objectiveMemory, integrationMemory] = await Promise.all([
      this.summarizeScope(`factory/objectives/${state.objectiveId}`, `${state.title}\n${task.title}`, 520),
      this.summarizeScope(`factory/objectives/${state.objectiveId}`, state.title, 360),
      this.summarizeScope(`factory/objectives/${state.objectiveId}/integration`, `${state.title}\nintegration`, 360),
    ]);
    const repoSkillPaths = await this.collectRepoSkillPaths();
    const sharedArtifactRefs = [
      artifactRef(this.objectiveProfileArtifactPath(state.objectiveId), "objective profile snapshot"),
      artifactRef(this.objectiveSkillSelectionArtifactPath(state.objectiveId), "objective profile skills"),
      ...state.repoProfile.generatedSkillRefs,
    ];
    const [frontierTasks, recentCompletedTasks, integrationTasks] = await Promise.all([
      this.buildObjectiveSliceTasks(state, frontierTaskIds),
      this.buildObjectiveSliceTasks(state, recentCompletedTaskIds),
      this.buildObjectiveSliceTasks(state, integrationTaskIds),
    ]);
    return {
      objectiveId: state.objectiveId,
      title: state.title,
      prompt: state.prompt,
      profile: this.objectiveProfileForState(state),
      task: {
        taskId: task.taskId,
        title: task.title,
        prompt: task.prompt,
        workerType: task.workerType,
        status: task.status,
        candidateId,
      },
      integration: {
        status: state.integration.status,
        headCommit: state.integration.headCommit,
        activeCandidateId: state.integration.activeCandidateId,
        conflictReason: state.integration.conflictReason,
        lastSummary: state.integration.lastSummary,
      },
      dependencyTree: dependencyTree.filter((node): node is FactoryContextTaskNode => Boolean(node)),
      relatedTasks: relatedTasks
        .filter((node): node is FactoryContextRelatedTask => Boolean(node))
        .sort((a, b) => state.taskOrder.indexOf(a.taskId) - state.taskOrder.indexOf(b.taskId)),
      candidateLineage: lineage,
      recentReceipts,
      objectiveSlice: {
        frontierTasks,
        recentCompletedTasks,
        integrationTasks,
        recentObjectiveReceipts,
        objectiveMemorySummary: objectiveMemory,
        integrationMemorySummary: integrationMemory,
      },
      memory: {
        overview,
        objective: objectiveMemory,
        integration: integrationMemory,
      },
      contextSources: this.buildContextSources(state, repoSkillPaths, sharedArtifactRefs),
    };
  }

  private resolveTaskBaseCommit(state: FactoryState, task: FactoryTaskRecord): string {
    if (task.candidateId) {
      const candidate = state.candidates[task.candidateId];
      if (candidate?.headCommit) return candidate.headCommit;
    }
    return state.integration.headCommit ?? task.baseCommit ?? state.baseHash;
  }

  private async ensureTaskWorkspace(
    state: FactoryState,
    task: FactoryTaskRecord,
    workspaceId: string,
  ): Promise<{ readonly path: string; readonly branchName: string; readonly baseHash: string }> {
    const baseHash = this.resolveTaskBaseCommit(state, task);
    const workerType = this.normalizeProfileWorkerType(this.objectiveProfileForState(state), String(task.workerType));
    const workspacePath = path.join(this.git.worktreesDir, workspaceId);
    const branchName = `hub/${workerType}/${workspaceId}`;
    const existing = await this.git.worktreeStatus(workspacePath);
    if (existing.exists) {
      return {
        path: workspacePath,
        branchName: existing.branch ?? branchName,
        baseHash: existing.head ?? baseHash,
      };
    }
    const created = await this.git.createWorkspace({
      workspaceId,
      agentId: String(workerType),
      baseHash,
    });
    return created;
  }

  private memoryScopesForTask(
    state: FactoryState,
    task: FactoryTaskRecord,
    candidateId: string,
  ): ReadonlyArray<FactoryMemoryScopeSpec> {
    const baseQuery = `${state.title}\n${task.title}\n${task.prompt}`;
    const scopes: FactoryMemoryScopeSpec[] = [
      {
        key: "agent",
        scope: `factory/agents/${String(task.workerType)}`,
        label: `Agent memory (${String(task.workerType)})`,
        defaultQuery: baseQuery,
      },
      {
        key: "repo",
        scope: "factory/repo/shared",
        label: "Repo shared memory",
        defaultQuery: `${state.title}\n${task.title}`,
      },
      {
        key: "objective",
        scope: `factory/objectives/${state.objectiveId}`,
        label: "Objective memory",
        defaultQuery: state.title,
      },
      {
        key: "task",
        scope: `factory/objectives/${state.objectiveId}/tasks/${task.taskId}`,
        label: "Task memory",
        defaultQuery: task.title,
      },
      {
        key: "candidate",
        scope: `factory/objectives/${state.objectiveId}/candidates/${candidateId}`,
        label: "Candidate memory",
        defaultQuery: `${candidateId}\n${task.title}`,
      },
      {
        key: "integration",
        scope: `factory/objectives/${state.objectiveId}/integration`,
        label: "Integration memory",
        defaultQuery: `${state.title}\nintegration`,
      },
    ];
    return scopes;
  }

  private buildMemoryScriptSource(configPath: string): string {
    return buildFactoryMemoryScriptSource(configPath);
  }

  private taskFilePaths(workspacePath: string, taskId: string) {
    const root = path.join(workspacePath, FACTORY_DATA_DIR);
    return {
      manifestPath: path.join(root, `${taskId}.manifest.json`),
      contextPackPath: path.join(root, `${taskId}.context-pack.json`),
      promptPath: path.join(root, `${taskId}.prompt.md`),
      resultPath: path.join(root, `${taskId}.result.json`),
      stdoutPath: path.join(root, `${taskId}.stdout.log`),
      stderrPath: path.join(root, `${taskId}.stderr.log`),
      lastMessagePath: path.join(root, `${taskId}.last-message.md`),
      skillBundlePath: path.join(root, `${taskId}.skill-bundle.json`),
      memoryScriptPath: path.join(root, `${taskId}.memory.cjs`),
      memoryConfigPath: path.join(root, `${taskId}.memory-scopes.json`),
    };
  }

  private integrationFilePaths(workspacePath: string, candidateId: string) {
    const root = path.join(workspacePath, FACTORY_DATA_DIR);
    return {
      resultPath: path.join(root, `${candidateId}.integration.json`),
      stdoutPath: path.join(root, `${candidateId}.integration.stdout.log`),
      stderrPath: path.join(root, `${candidateId}.integration.stderr.log`),
    };
  }

  private async writeTaskPacket(
    state: FactoryState,
    task: FactoryTaskRecord,
    candidateId: string,
    workspacePath: string,
  ): Promise<{
    readonly manifestPath: string;
    readonly contextPackPath: string;
    readonly promptPath: string;
    readonly resultPath: string;
    readonly stdoutPath: string;
    readonly stderrPath: string;
    readonly lastMessagePath: string;
    readonly memoryScriptPath: string;
    readonly memoryConfigPath: string;
    readonly repoSkillPaths: ReadonlyArray<string>;
    readonly skillBundlePaths: ReadonlyArray<string>;
    readonly sharedArtifactRefs: ReadonlyArray<GraphRef>;
    readonly contextRefs: ReadonlyArray<GraphRef>;
  }> {
    const profile = this.objectiveProfileForState(state);
    const files = this.taskFilePaths(workspacePath, task.taskId);
    await fs.mkdir(path.dirname(files.manifestPath), { recursive: true });
    await fs.rm(files.resultPath, { force: true });
    const repoSkillPaths = await this.collectRepoSkillPaths();
    const memoryScopes = this.memoryScopesForTask(state, task, candidateId);
    const contextPack = await this.buildTaskContextPack(state, task, candidateId);
    const sharedArtifactRefs = contextPack.contextSources.sharedArtifactRefs;
    const skillBundle = {
      objectiveId: state.objectiveId,
      taskId: task.taskId,
      title: task.title,
      workerType: task.workerType,
      profile,
      selectedSkills: profile.selectedSkills,
      repoSkillPaths,
      generatedAt: Date.now(),
    };
    await fs.writeFile(files.skillBundlePath, JSON.stringify(skillBundle, null, 2), "utf-8");
    const manifest = {
      objective: {
        objectiveId: state.objectiveId,
        title: state.title,
        prompt: state.prompt,
        baseHash: state.baseHash,
        checks: state.checks,
      },
      profile,
      task: {
        taskId: task.taskId,
        title: task.title,
        prompt: task.prompt,
        workerType: task.workerType,
        baseCommit: this.resolveTaskBaseCommit(state, task),
        dependsOn: task.dependsOn,
      },
      candidate: state.candidates[candidateId] ?? {
        candidateId,
        taskId: task.taskId,
      },
      integration: state.integration,
      memory: {
        scriptPath: files.memoryScriptPath,
        configPath: files.memoryConfigPath,
        scopes: memoryScopes,
      },
      context: {
        packPath: files.contextPackPath,
      },
      contextSources: contextPack.contextSources,
      contextRefs: [
        ...task.contextRefs,
        ...sharedArtifactRefs,
        artifactRef(files.contextPackPath, "recursive context pack"),
      ],
      sharedArtifactRefs,
      repoSkillPaths,
      skillBundlePaths: [files.skillBundlePath],
      traceRefs: [
        stateRef(objectiveStream(state.objectiveId), "factory objective stream"),
        ...task.dependsOn.map((depId) => stateRef(`${objectiveStream(state.objectiveId)}:task/${depId}`, depId)),
      ],
    };
    const memoryConfig = {
      objectiveId: state.objectiveId,
      taskId: task.taskId,
      candidateId,
      contextPackPath: files.contextPackPath,
      defaultQuery: `${state.title}\n${task.title}\n${task.prompt}`,
      defaultLimit: 6,
      defaultMaxChars: 2400,
      scopes: memoryScopes,
    };
    await fs.writeFile(files.contextPackPath, JSON.stringify(contextPack, null, 2), "utf-8");
    await fs.writeFile(files.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    await fs.writeFile(files.memoryConfigPath, JSON.stringify(memoryConfig, null, 2), "utf-8");
    await fs.writeFile(files.memoryScriptPath, this.buildMemoryScriptSource(files.memoryConfigPath), "utf-8");
    if (process.platform !== "win32") await fs.chmod(files.memoryScriptPath, 0o755);
    return {
      manifestPath: files.manifestPath,
      contextPackPath: files.contextPackPath,
      promptPath: files.promptPath,
      resultPath: files.resultPath,
      stdoutPath: files.stdoutPath,
      stderrPath: files.stderrPath,
      lastMessagePath: files.lastMessagePath,
      memoryScriptPath: files.memoryScriptPath,
      memoryConfigPath: files.memoryConfigPath,
      repoSkillPaths,
      skillBundlePaths: [files.skillBundlePath],
      sharedArtifactRefs,
      contextRefs: [
        ...task.contextRefs,
        ...sharedArtifactRefs,
        artifactRef(files.contextPackPath, "recursive context pack"),
      ],
    };
  }

  async prepareDirectCodexProbePacket(input: {
    readonly jobId: string;
    readonly prompt: string;
    readonly profileId?: string;
    readonly objectiveId?: string;
    readonly parentRunId?: string;
    readonly parentStream?: string;
    readonly stream?: string;
    readonly supervisorSessionId?: string;
    readonly readOnly?: boolean;
  }): Promise<{
    readonly artifactPaths: FactoryChatCodexArtifactPaths;
    readonly renderedPrompt: string;
    readonly readOnly: boolean;
    readonly env: NodeJS.ProcessEnv;
  }> {
    const readOnly = input.readOnly !== false;
    const artifactPaths = factoryChatCodexArtifactPaths(this.dataDir, input.jobId);
    await fs.mkdir(artifactPaths.root, { recursive: true });
    await fs.rm(artifactPaths.resultPath, { force: true });
    const profile = await this.resolveObjectiveProfileSnapshot(input.profileId).catch(() => ({
      rootProfileId: input.profileId ?? "default",
      rootProfileLabel: input.profileId ?? "default",
      resolvedProfileHash: "",
      promptHash: "",
      promptPath: undefined as string | undefined,
      selectedSkills: [] as ReadonlyArray<string>,
      objectivePolicy: DEFAULT_FACTORY_OBJECTIVE_PROFILE.objectivePolicy,
    }));
    const includeFactoryObjectiveSkills = Boolean(input.objectiveId);
    const repoSkillPaths = (await this.collectRepoSkillPaths()).filter((skillPath) =>
      includeFactoryObjectiveSkills
      || (!skillPath.includes("/skills/factory-receipt-worker/")
        && !skillPath.includes("/skills/factory-run-orchestrator/"))
    );
    const repoKey = repoKeyForRoot(this.git.repoRoot);
    const repoScope = `repos/${repoKey}`;
    const profileScope = `${repoScope}/profiles/${profile.rootProfileId}`;
    const objectiveScope = input.objectiveId ? `${profileScope}/objectives/${input.objectiveId}` : undefined;
    const workerScope = `${repoScope}/subagents/codex`;

    const memoryScopes = [
      {
        key: "repo",
        scope: repoScope,
        label: "Repo memory",
        defaultQuery: input.prompt,
      },
      {
        key: "profile",
        scope: profileScope,
        label: `Profile memory (${profile.rootProfileLabel})`,
        defaultQuery: input.prompt,
      },
      ...(objectiveScope ? [{
        key: "objective",
        scope: objectiveScope,
        label: "Objective memory",
        defaultQuery: input.prompt,
      }, {
        key: "integration",
        scope: `factory/objectives/${input.objectiveId}/integration`,
        label: "Integration memory",
        defaultQuery: input.prompt,
      }] : []),
      {
        key: "worker",
        scope: workerScope,
        label: "Codex worker memory",
        defaultQuery: input.prompt,
      },
    ] satisfies ReadonlyArray<FactoryMemoryScopeSpec>;

    const [
      repoMemory,
      profileMemory,
      workerMemory,
      objectiveDetail,
      objectiveDebug,
      objectiveReceipts,
      objectiveMemory,
      integrationMemory,
    ] = await Promise.all([
      this.summarizeScope(repoScope, input.prompt, 360),
      this.summarizeScope(profileScope, input.prompt, 360),
      this.summarizeScope(workerScope, input.prompt, 280),
      input.objectiveId ? this.getObjective(input.objectiveId) : Promise.resolve(undefined),
      input.objectiveId ? this.getObjectiveDebug(input.objectiveId) : Promise.resolve(undefined),
      input.objectiveId ? this.listObjectiveReceipts(input.objectiveId, { limit: 20 }) : Promise.resolve([]),
      objectiveScope ? this.summarizeScope(objectiveScope, input.prompt, 360) : Promise.resolve(undefined),
      input.objectiveId ? this.summarizeScope(`factory/objectives/${input.objectiveId}/integration`, input.prompt, 360) : Promise.resolve(undefined),
    ]);

    const frontierTasks = (objectiveDetail?.tasks ?? [])
      .filter((task) => ["ready", "running", "reviewing", "blocked"].includes(task.status))
      .slice(0, 10)
      .map((task) => ({
        taskId: task.taskId,
        taskKind: task.taskKind,
        title: task.title,
        status: task.status,
        workerType: task.workerType,
        sourceTaskId: task.sourceTaskId,
        sourceCandidateId: task.sourceCandidateId,
        relations: ["focus"] as const,
        latestSummary: task.latestSummary,
        blockedReason: task.blockedReason,
        candidateId: task.candidateId,
        candidateStatus: task.candidate?.status,
      }));
    const recentCompletedTasks = (objectiveDetail?.tasks ?? [])
      .filter((task) => ["approved", "integrated", "blocked", "superseded"].includes(task.status))
      .slice(0, 8)
      .map((task) => ({
        taskId: task.taskId,
        taskKind: task.taskKind,
        title: task.title,
        status: task.status,
        workerType: task.workerType,
        sourceTaskId: task.sourceTaskId,
        sourceCandidateId: task.sourceCandidateId,
        relations: ["focus"] as const,
        latestSummary: task.latestSummary,
        blockedReason: task.blockedReason,
        candidateId: task.candidateId,
        candidateStatus: task.candidate?.status,
      }));
    const integrationTaskIds = new Set<string>();
    if (objectiveDetail?.integration.activeCandidateId) {
      const activeTask = objectiveDetail.tasks.find((task) => task.candidateId === objectiveDetail.integration.activeCandidateId);
      if (activeTask) integrationTaskIds.add(activeTask.taskId);
    }
    for (const candidateId of objectiveDetail?.integration.queuedCandidateIds ?? []) {
      const queuedTask = objectiveDetail?.tasks.find((task) => task.candidateId === candidateId);
      if (queuedTask) integrationTaskIds.add(queuedTask.taskId);
    }
    const integrationTasks = (objectiveDetail?.tasks ?? [])
      .filter((task) => integrationTaskIds.has(task.taskId))
      .slice(0, 8)
      .map((task) => ({
        taskId: task.taskId,
        taskKind: task.taskKind,
        title: task.title,
        status: task.status,
        workerType: task.workerType,
        sourceTaskId: task.sourceTaskId,
        sourceCandidateId: task.sourceCandidateId,
        relations: ["focus"] as const,
        latestSummary: task.latestSummary,
        blockedReason: task.blockedReason,
        candidateId: task.candidateId,
        candidateStatus: task.candidate?.status,
      }));

    const contextPack = {
      ...(input.objectiveId ? { objectiveId: input.objectiveId } : {}),
      probeId: input.jobId,
      title: objectiveDetail?.title ?? "Direct Codex Probe",
      prompt: input.prompt,
      mode: input.objectiveId
        ? (readOnly ? "read_only_direct_codex_probe" : "direct_codex")
        : (readOnly ? "read_only_repo_probe" : "direct_repo_probe"),
      profile,
      task: {
        taskId: `direct_codex_${input.jobId}`,
        title: objectiveDetail?.title ? `Direct probe for ${objectiveDetail.title}` : "Direct Codex Probe",
        prompt: input.prompt,
        workerType: "codex",
        status: "running",
        candidateId: input.jobId,
      },
      ...(objectiveDetail ? {
        integration: objectiveDetail.integration,
      } : {}),
      dependencyTree: [],
      relatedTasks: frontierTasks,
      candidateLineage: [],
      recentReceipts: objectiveReceipts.slice(-12).map((receipt) => ({
        type: receipt.type,
        at: receipt.ts,
        taskId: receipt.taskId,
        candidateId: receipt.candidateId,
        summary: receipt.summary,
      })),
      ...(objectiveDetail ? {
        objectiveSlice: {
          frontierTasks,
          recentCompletedTasks,
          integrationTasks,
          recentObjectiveReceipts: objectiveReceipts.map((receipt) => ({
            type: receipt.type,
            at: receipt.ts,
            taskId: receipt.taskId,
            candidateId: receipt.candidateId,
            summary: receipt.summary,
          })),
          objectiveMemorySummary: objectiveMemory,
          integrationMemorySummary: integrationMemory,
        },
      } : {}),
      memory: {
        overview: [repoMemory, profileMemory, objectiveMemory, workerMemory].filter(Boolean).join("\n\n") || undefined,
        objective: objectiveMemory,
        integration: integrationMemory,
      },
      contextSources: {
        repoSharedMemoryScope: repoScope,
        objectiveMemoryScope: objectiveScope ?? profileScope,
        integrationMemoryScope: input.objectiveId ? `factory/objectives/${input.objectiveId}/integration` : workerScope,
        profileSkillRefs: profile.selectedSkills,
        repoSkillPaths,
        sharedArtifactRefs: [],
      },
      latestDecision: objectiveDetail?.latestDecision,
      blockedExplanation: objectiveDetail?.blockedExplanation,
      evidenceCards: objectiveDetail?.evidenceCards.slice(-8) ?? [],
      activeJobs: objectiveDebug?.activeJobs.slice(0, 8) ?? [],
      latestContextPacks: objectiveDebug?.latestContextPacks ?? [],
      session: {
        jobId: input.jobId,
        parentRunId: input.parentRunId,
        parentStream: input.parentStream,
        stream: input.stream,
        supervisorSessionId: input.supervisorSessionId,
      },
    };

    const memoryConfig = {
      objectiveId: input.objectiveId,
      taskId: `direct_codex_${input.jobId}`,
      candidateId: input.jobId,
      contextPackPath: artifactPaths.contextPackPath,
      defaultQuery: input.prompt,
      defaultLimit: 6,
      defaultMaxChars: 2400,
      scopes: memoryScopes,
    };
    const manifest = {
      kind: "factory.codex.probe",
      mode: readOnly ? "read_only" : "workspace_write",
      run: {
        jobId: input.jobId,
        parentRunId: input.parentRunId,
        parentStream: input.parentStream,
        stream: input.stream,
        supervisorSessionId: input.supervisorSessionId,
      },
      objective: objectiveDetail ? {
        objectiveId: objectiveDetail.objectiveId,
        title: objectiveDetail.title,
        status: objectiveDetail.status,
        phase: objectiveDetail.phase,
        latestSummary: objectiveDetail.latestSummary,
        nextAction: objectiveDetail.nextAction,
        latestDecision: objectiveDetail.latestDecision,
        blockedExplanation: objectiveDetail.blockedExplanation,
      } : undefined,
      profile,
      memory: {
        scriptPath: artifactPaths.memoryScriptPath,
        configPath: artifactPaths.memoryConfigPath,
        scopes: memoryScopes,
      },
      context: {
        packPath: artifactPaths.contextPackPath,
      },
      repoSkillPaths,
      traceRefs: [
        ...(input.objectiveId ? [stateRef(objectiveStream(input.objectiveId), "factory objective stream")] : []),
        ...(input.parentStream ? [stateRef(input.parentStream, "parent Factory run stream")] : []),
      ],
      contract: {
        readOnly,
        summary: readOnly
          ? "This Codex probe is read-only. Use it for inspection, receipts, and diagnosis. Code changes must go through a Factory objective."
          : "This Codex run may edit the workspace.",
        objectiveBacked: Boolean(input.objectiveId),
      },
    };

    await fs.writeFile(artifactPaths.contextPackPath, JSON.stringify(contextPack, null, 2), "utf-8");
    await fs.writeFile(artifactPaths.manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    await fs.writeFile(artifactPaths.memoryConfigPath, JSON.stringify(memoryConfig, null, 2), "utf-8");
    await fs.writeFile(artifactPaths.memoryScriptPath, buildFactoryMemoryScriptSource(artifactPaths.memoryConfigPath), "utf-8");
    if (process.platform !== "win32") await fs.chmod(artifactPaths.memoryScriptPath, 0o755);

    const receiptBinDir = await this.ensureWorkspaceReceiptCli(this.git.repoRoot);
    const renderedPrompt = this.renderDirectCodexProbePrompt({
      prompt: input.prompt,
      readOnly,
      artifactPaths,
      manifest,
      objective: objectiveDetail ? {
        objectiveId: objectiveDetail.objectiveId,
        title: objectiveDetail.title,
        status: objectiveDetail.status,
        phase: objectiveDetail.phase,
        latestDecision: objectiveDetail.latestDecision,
        blockedExplanation: objectiveDetail.blockedExplanation,
      } : undefined,
      repoSkillPaths,
      recentReceipts: objectiveReceipts.slice(-10),
    });

    return {
      artifactPaths,
      renderedPrompt,
      readOnly,
      env: {
        DATA_DIR: this.dataDir,
        RECEIPT_DATA_DIR: this.dataDir,
        PATH: prependPath(receiptBinDir, process.env.PATH),
      },
    };
  }

  private async renderTaskPrompt(
    state: FactoryState,
    task: FactoryTaskRecord,
    payload: FactoryTaskJobPayload,
  ): Promise<string> {
    const dependencySummaries = task.dependsOn
      .map((depId) => state.graph.nodes[depId])
      .filter((dep): dep is FactoryTaskRecord => Boolean(dep))
      .map((dep) => `- ${dep.taskId}: ${dep.latestSummary ?? dep.title}`)
      .join("\n") || "- none";
    const downstreamSummaries = state.taskOrder
      .map((taskId) => state.graph.nodes[taskId])
      .filter((candidate): candidate is FactoryTaskRecord => Boolean(candidate) && candidate.dependsOn.includes(task.taskId))
      .map((candidate) => `- ${candidate.taskId}: ${candidate.title}`)
      .join("\n") || "- none";
    const memorySummary = await this.loadMemorySummary(`factory/objectives/${state.objectiveId}/tasks/${task.taskId}`, task.prompt);
    const validationSection = this.renderTaskValidationSection(state, task);
    return [
      `# Factory Task`,
      ``,
      `Objective: ${state.title}`,
      `Objective ID: ${state.objectiveId}`,
      `Task ID: ${task.taskId}`,
      `Worker Type: ${task.workerType}`,
      `Profile: ${payload.profile.rootProfileLabel} (${payload.profile.rootProfileId})`,
      `Base Commit: ${payload.baseCommit}`,
      `Candidate ID: ${payload.candidateId}`,
      ``,
      `## Objective Prompt`,
      state.prompt,
      ``,
      `## Task Prompt`,
      task.prompt,
      ``,
      `## Dependencies`,
      dependencySummaries,
      ``,
      `## Task Boundary`,
      `Complete only ${task.taskId}. Do not absorb downstream work that already belongs to other planned tasks unless a tiny unblock is strictly required.`,
      `Downstream tasks already queued in this objective:`,
      downstreamSummaries,
      `If you notice adjacent copy, validation, or follow-up work outside this task's scope, mention it in the handoff instead of implementing it here.`,
      ``,
      ...validationSection,
      ``,
      `## Bootstrap Context`,
      `The prompt is bootstrap only. Prefer the packet files and memory script over broad repo exploration.`,
      `Read, in order:`,
      `1. AGENTS.md and skills/factory-receipt-worker/SKILL.md`,
      `2. Manifest: ${payload.manifestPath}`,
      `3. Context Pack: ${payload.contextPackPath}`,
      `4. Memory Script: ${payload.memoryScriptPath}`,
      `Use current-objective inspection only if the packet or memory script is insufficient, and run these sequentially, not in parallel:`,
      `- receipt factory inspect ${state.objectiveId} --json --panel receipts`,
      `- receipt factory inspect ${state.objectiveId} --json --panel debug`,
      ``,
      `## Memory Access`,
      `Use the layered memory script at ${payload.memoryScriptPath} instead of raw memory dumps.`,
      `Recommended commands:`,
      `- node ${payload.memoryScriptPath} context 2800`,
      `- node ${payload.memoryScriptPath} objective 1800`,
      `- node ${payload.memoryScriptPath} scope task "${task.title}" 1400`,
      `- node ${payload.memoryScriptPath} search repo "${task.title}" 6`,
      `Only write a durable memory note after gathering evidence from the packet, receipts, or repo files.`,
      ``,
      `## Result Contract`,
      `Write JSON to ${payload.resultPath} with:`,
      `{ "outcome": "approved" | "changes_requested" | "blocked", "summary": string, "handoff": string }`,
      `Do not write this file yourself. Return exactly that JSON object as your final response and the runtime will persist it to the result path.`,
      `Use "changes_requested" only when more work is clearly needed; use "blocked" only for a hard blocker.`,
      ``,
      `## Starting Hint`,
      memorySummary || "No durable task memory yet.",
    ].join("\n");
  }

  private renderTaskValidationSection(state: FactoryState, task: FactoryTaskRecord): string[] {
    if (!this.shouldDeferBroadValidation(state, task)) {
      return [
        `## Checks`,
        state.checks.map((check) => `- ${check}`).join("\n") || "- none",
        `Run the relevant repo validation for this task and capture failures precisely in the handoff.`,
      ];
    }
    return [
      `## Validation Guidance`,
      `A later task in this objective owns the broad repo validation suite.`,
      `Do not run the full repo checks here unless this task is itself the validation pass or a tiny targeted check is strictly needed to de-risk the change.`,
      ...(state.checks.length > 0
        ? [
            `Reserved full-suite commands for later:`,
            state.checks.map((check) => `- ${check}`).join("\n"),
          ]
        : []),
    ];
  }

  private shouldDeferBroadValidation(state: FactoryState, task: FactoryTaskRecord): boolean {
    if (this.taskOwnsBroadValidation(task)) return false;
    const taskIndex = state.taskOrder.indexOf(task.taskId);
    const laterTaskIds = taskIndex >= 0 ? state.taskOrder.slice(taskIndex + 1) : [];
    return laterTaskIds
      .map((taskId) => state.graph.nodes[taskId])
      .some((candidate) => Boolean(candidate) && this.taskOwnsBroadValidation(candidate));
  }

  private taskOwnsBroadValidation(task: Pick<FactoryTaskRecord, "title" | "prompt">): boolean {
    const haystack = `${task.title}\n${task.prompt}`.toLowerCase();
    return haystack.includes("validation suite")
      || haystack.includes("run validation")
      || haystack.includes("lint")
      || haystack.includes("typecheck")
      || haystack.includes("build");
  }

  private renderDirectCodexProbePrompt(input: {
    readonly prompt: string;
    readonly readOnly: boolean;
    readonly artifactPaths: FactoryChatCodexArtifactPaths;
    readonly manifest: Record<string, unknown>;
    readonly objective?: {
      readonly objectiveId: string;
      readonly title: string;
      readonly status: FactoryObjectiveStatus;
      readonly phase: FactoryObjectivePhase;
      readonly latestDecision?: FactoryObjectiveCard["latestDecision"];
      readonly blockedExplanation?: FactoryObjectiveCard["blockedExplanation"];
    };
    readonly repoSkillPaths: ReadonlyArray<string>;
    readonly recentReceipts: ReadonlyArray<FactoryObjectiveReceiptSummary>;
  }): string {
    const objectiveStreamRef = input.objective ? objectiveStream(input.objective.objectiveId) : undefined;
    return [
      `# Factory Direct Codex Probe`,
      ``,
      `Mode: ${input.readOnly ? "read-only probe" : "workspace-write"}`,
      `Workspace: ${this.git.repoRoot}`,
      ``,
      `## Operator Request`,
      input.prompt,
      ``,
      `## Read-Only Contract`,
      input.readOnly
        ? `This Codex run is read-only. Inspect receipts, memory, files, and logs, but do not modify tracked files or generate patches. If code changes are required, explain the change and say that Factory must create or react an objective/worktree run.`
        : `This Codex run may edit the workspace.`,
      ``,
      `## Bootstrap Context`,
      input.objective
        ? `Treat the prompt as bootstrap only. Read AGENTS.md and skills/factory-receipt-worker/SKILL.md before making claims about what context is available.`
        : `Treat the prompt as bootstrap only. Use the packet files, repo files, and memory script first. This direct probe is not a Factory task worktree and does not require Factory worker bootstrap commands.`,
      `Current packet files:`,
      `- Manifest: ${input.artifactPaths.manifestPath}`,
      `- Context Pack: ${input.artifactPaths.contextPackPath}`,
      `- Memory Script: ${input.artifactPaths.memoryScriptPath}`,
      `- Memory Config: ${input.artifactPaths.memoryConfigPath}`,
      `- Result Path: ${input.artifactPaths.resultPath}`,
      `- Prompt Path: ${input.artifactPaths.promptPath}`,
      ``,
      `## Objective-First Query Order`,
      `1. Packet files in this artifact directory`,
      input.objective ? `2. Current objective receipts and debug panels for ${input.objective.objectiveId}` : `2. Repo files/search in the current checkout`,
      `3. Scoped memory through the generated memory script`,
      `4. Broader history only if the packet or current objective explicitly points to it`,
      ``,
      input.objective ? `## Current Objective` : `## Current Context`,
      input.objective
        ? [
            `- Objective: ${input.objective.title} (${input.objective.objectiveId})`,
            `- Status: ${input.objective.status}`,
            `- Phase: ${input.objective.phase}`,
            input.objective.latestDecision ? `- Latest decision: ${input.objective.latestDecision.summary}` : "",
            input.objective.blockedExplanation ? `- Blocked explanation: ${input.objective.blockedExplanation.summary}` : "",
            `- If the packet and memory script are still insufficient, inspect the objective sequentially (not in parallel):`,
            `- receipt factory inspect ${input.objective.objectiveId} --json --panel receipts`,
            `- receipt factory inspect ${input.objective.objectiveId} --json --panel debug`,
            objectiveStreamRef ? `- receipt inspect ${objectiveStreamRef}` : "",
            objectiveStreamRef ? `- receipt trace ${objectiveStreamRef}` : "",
          ].filter(Boolean).join("\n")
        : [
            `- Use the packet, repo files, and memory first. This probe is not a Factory objective and should not call receipt factory inspect.`,
            `- Do not assume skills/factory-receipt-worker/SKILL.md applies unless a real objectiveId is present.`,
            `- Use current repo search/read results before escalating to broader receipt history.`,
          ].join("\n"),
      ``,
      `## Memory Access`,
      `Use the layered memory script at ${input.artifactPaths.memoryScriptPath} instead of pulling large raw memory dumps.`,
      `Recommended commands:`,
      `- node ${input.artifactPaths.memoryScriptPath} context 2800`,
      `- node ${input.artifactPaths.memoryScriptPath} objective 1800`,
      `- node ${input.artifactPaths.memoryScriptPath} overview ${JSON.stringify(input.prompt)} 2400`,
      `- node ${input.artifactPaths.memoryScriptPath} scope repo ${JSON.stringify(input.prompt)} 1400`,
      `- node ${input.artifactPaths.memoryScriptPath} scope profile ${JSON.stringify(input.prompt)} 1400`,
      `- node ${input.artifactPaths.memoryScriptPath} search repo ${JSON.stringify(input.prompt)} 6`,
      ...(input.readOnly ? [] : [`- node ${input.artifactPaths.memoryScriptPath} commit worker "short durable note"`]),
      ``,
      `## Repo Skills`,
      input.repoSkillPaths.map((skill) => `- ${skill}`).join("\n") || "- none",
      ``,
      `## Recent Receipt Evidence`,
      input.recentReceipts.map((receipt) => `- ${receipt.type}: ${receipt.summary}`).join("\n") || "- none",
      ``,
      `## Delivery Boundary`,
      `Use this probe to inspect, summarize, and recommend. If implementation work is needed, say so explicitly and point the parent back to factory.dispatch.`,
    ].join("\n");
  }

  private parseTaskPayload(payload: Record<string, unknown>): FactoryTaskJobPayload {
    if (payload.kind !== "factory.task.run") throw new FactoryServiceError(400, "invalid factory task payload");
    return {
      kind: "factory.task.run",
      objectiveId: requireNonEmpty(payload.objectiveId, "objectiveId required"),
      taskId: requireNonEmpty(payload.taskId, "taskId required"),
      workerType: normalizeWorkerType(requireNonEmpty(payload.workerType, "workerType required")),
      candidateId: requireNonEmpty(payload.candidateId, "candidateId required"),
      baseCommit: requireNonEmpty(payload.baseCommit, "baseCommit required"),
      workspaceId: requireNonEmpty(payload.workspaceId, "workspaceId required"),
      workspacePath: requireNonEmpty(payload.workspacePath, "workspacePath required"),
      promptPath: requireNonEmpty(payload.promptPath, "promptPath required"),
      resultPath: requireNonEmpty(payload.resultPath, "resultPath required"),
      stdoutPath: requireNonEmpty(payload.stdoutPath, "stdoutPath required"),
      stderrPath: requireNonEmpty(payload.stderrPath, "stderrPath required"),
      lastMessagePath: requireNonEmpty(payload.lastMessagePath, "lastMessagePath required"),
      manifestPath: requireNonEmpty(payload.manifestPath, "manifestPath required"),
      contextPackPath: requireNonEmpty(payload.contextPackPath, "contextPackPath required"),
      memoryScriptPath: requireNonEmpty(payload.memoryScriptPath, "memoryScriptPath required"),
      memoryConfigPath: requireNonEmpty(payload.memoryConfigPath, "memoryConfigPath required"),
      repoSkillPaths: Array.isArray(payload.repoSkillPaths) ? payload.repoSkillPaths.filter((item): item is string => typeof item === "string") : [],
      skillBundlePaths: Array.isArray(payload.skillBundlePaths) ? payload.skillBundlePaths.filter((item): item is string => typeof item === "string") : [],
      profile: normalizeFactoryObjectiveProfileSnapshot(payload.profile),
      profilePromptHash: optionalTrimmedString(payload.profilePromptHash) ?? "",
      profileSkillRefs: Array.isArray(payload.profileSkillRefs) ? payload.profileSkillRefs.filter((item): item is string => typeof item === "string") : [],
      sharedArtifactRefs: Array.isArray(payload.sharedArtifactRefs)
        ? payload.sharedArtifactRefs.filter((item): item is GraphRef => isRecord(item) && typeof item.kind === "string" && typeof item.ref === "string")
        : [],
      contextRefs: Array.isArray(payload.contextRefs) ? payload.contextRefs.filter((item): item is GraphRef => isRecord(item) && typeof item.kind === "string" && typeof item.ref === "string") : [],
      integrationRef: isRecord(payload.integrationRef) && typeof payload.integrationRef.kind === "string" && typeof payload.integrationRef.ref === "string"
        ? payload.integrationRef as GraphRef
        : undefined,
      problem: requireNonEmpty(payload.problem, "problem required"),
      config: isRecord(payload.config) ? payload.config : {},
    };
  }

  private parseIntegrationPayload(payload: Record<string, unknown>): FactoryIntegrationJobPayload {
    if (payload.kind !== "factory.integration.validate") {
      throw new FactoryServiceError(400, "invalid factory integration payload");
    }
    return {
      kind: "factory.integration.validate",
      objectiveId: requireNonEmpty(payload.objectiveId, "objectiveId required"),
      candidateId: requireNonEmpty(payload.candidateId, "candidateId required"),
      workspacePath: requireNonEmpty(payload.workspacePath, "workspacePath required"),
      stdoutPath: requireNonEmpty(payload.stdoutPath, "stdoutPath required"),
      stderrPath: requireNonEmpty(payload.stderrPath, "stderrPath required"),
      resultPath: requireNonEmpty(payload.resultPath, "resultPath required"),
      checks: Array.isArray(payload.checks) ? payload.checks.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
    };
  }

  private taskResultSchemaPath(resultPath: string): string {
    return resultPath.replace(/\.json$/i, ".schema.json");
  }

  private parseJsonObjectCandidate(raw: string): Record<string, unknown> | undefined {
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
  }

  private async resolveTaskWorkerResult(
    resultPath: string,
    execution: { readonly stdout: string; readonly lastMessage?: string },
  ): Promise<Record<string, unknown>> {
    const rawResult = await fs.readFile(resultPath, "utf-8").catch(() => "");
    if (rawResult.trim()) return this.parseTaskResult(rawResult);
    const fromLastMessage = execution.lastMessage ? this.parseJsonObjectCandidate(execution.lastMessage) : undefined;
    if (fromLastMessage) return fromLastMessage;
    const fromStdout = this.parseJsonObjectCandidate(execution.stdout);
    if (fromStdout) return fromStdout;
    throw new FactoryServiceError(500, "missing structured factory task result from codex");
  }

  private parseTaskResult(raw: string): Record<string, unknown> {
    if (!raw.trim()) throw new FactoryServiceError(500, "missing factory task result.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new FactoryServiceError(500, `malformed factory task result.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isRecord(parsed)) throw new FactoryServiceError(500, "factory task result must be an object");
    return parsed;
  }

  private async ensureWorkspaceReceiptCli(workspacePath: string): Promise<string> {
    const binDir = path.join(workspacePath, ".receipt", "bin");
    const shimPath = path.join(binDir, process.platform === "win32" ? "receipt.cmd" : "receipt");
    const { command, args, entryPath } = resolveCliInvocation(import.meta.url);
    await fs.mkdir(binDir, { recursive: true });
    const body = process.platform === "win32"
      ? [
          "@echo off",
          `set "DATA_DIR=${this.dataDir}"`,
          `set "RECEIPT_DATA_DIR=${this.dataDir}"`,
          `"${command}" "${entryPath}" %*`,
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `export DATA_DIR=${shellQuote(this.dataDir)}`,
          `export RECEIPT_DATA_DIR=${shellQuote(this.dataDir)}`,
          `exec ${shellQuote(command)} ${args.map((arg) => shellQuote(arg)).join(" ")} "$@"`,
          "",
        ].join("\n");
    await fs.writeFile(shimPath, body, "utf-8");
    if (process.platform !== "win32") await fs.chmod(shimPath, 0o755);
    return binDir;
  }

  private async loadMemorySummary(scope: string, query: string): Promise<string> {
    if (!this.memoryTools) return "";
    try {
      const { summary } = await this.memoryTools.summarize({
        scope,
        query,
        limit: 8,
        maxChars: 1_200,
      });
      return summary;
    } catch {
      return "";
    }
  }

  private async commitTaskMemory(
    state: FactoryState,
    task: FactoryTaskRecord,
    candidateId: string,
    summary: string,
    outcome: string,
  ): Promise<void> {
    if (!this.memoryTools) return;
    try {
      const scopes = this.memoryScopesForTask(state, task, candidateId);
      const byKey = new Map(scopes.map((scope) => [scope.key, scope]));
      await Promise.all([
        this.memoryTools.commit({
          scope: byKey.get("agent")?.scope ?? `factory/agents/${String(task.workerType)}`,
          text: `[${state.objectiveId}/${task.taskId}] ${summary}`,
          tags: ["factory", "agent", String(task.workerType), outcome],
        }),
        this.memoryTools.commit({
          scope: byKey.get("repo")?.scope ?? "factory/repo/shared",
          text: `[${state.objectiveId}/${task.taskId}] ${summary}`,
          tags: ["factory", "repo", outcome],
        }),
        this.memoryTools.commit({
          scope: byKey.get("objective")?.scope ?? `factory/objectives/${state.objectiveId}`,
          text: `[${task.taskId}] ${summary}`,
          tags: ["factory", task.taskId, outcome],
        }),
        this.memoryTools.commit({
          scope: byKey.get("task")?.scope ?? `factory/objectives/${state.objectiveId}/tasks/${task.taskId}`,
          text: summary,
          tags: ["factory", "task", outcome],
        }),
        this.memoryTools.commit({
          scope: byKey.get("candidate")?.scope ?? `factory/objectives/${state.objectiveId}/candidates/${candidateId}`,
          text: summary,
          tags: ["factory", "candidate", candidateId, outcome],
        }),
      ]);
    } catch {
      // memory is auxiliary
    }
  }

  private async commitIntegrationMemory(
    state: FactoryState,
    candidateId: string,
    summary: string,
    tags: ReadonlyArray<string>,
  ): Promise<void> {
    if (!this.memoryTools) return;
    try {
      await Promise.all([
        this.memoryTools.commit({
          scope: `factory/objectives/${state.objectiveId}`,
          text: `[integration/${candidateId}] ${summary}`,
          tags: ["factory", ...tags],
        }),
        this.memoryTools.commit({
          scope: `factory/objectives/${state.objectiveId}/integration`,
          text: summary,
          tags: ["factory", ...tags],
        }),
      ]);
    } catch {
      // memory is auxiliary
    }
  }

  private async collectCheckedInRepoSkillPaths(): Promise<ReadonlyArray<string>> {
    const root = path.join(this.git.repoRoot, "skills");
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(target);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name === "SKILL.md" || entry.name.endsWith(".md")) out.push(target);
      }
    };
    await walk(root);
    return out.sort((a, b) => a.localeCompare(b));
  }

  private async collectRepoSkillPaths(): Promise<ReadonlyArray<string>> {
    const [checkedIn, sharedProfile] = await Promise.all([
      this.collectCheckedInRepoSkillPaths(),
      this.loadSharedRepoProfileArtifact(),
    ]);
    return [...new Set([
      ...checkedIn,
      ...(sharedProfile?.generatedSkillPaths ?? []),
    ])].sort((a, b) => a.localeCompare(b));
  }

  private async runChecks(commands: ReadonlyArray<string>, workspacePath: string): Promise<ReadonlyArray<FactoryCheckResult>> {
    const results: FactoryCheckResult[] = [];
    for (const command of commands) {
      const startedAt = Date.now();
      try {
        const { stdout, stderr } = await execFileAsync("/bin/sh", ["-lc", command], {
          cwd: workspacePath,
          encoding: "utf-8",
          env: process.env,
          maxBuffer: 16 * 1024 * 1024,
        });
        results.push({
          command,
          ok: true,
          exitCode: 0,
          stdout,
          stderr,
          startedAt,
          finishedAt: Date.now(),
        });
      } catch (err) {
        const failure = err as Error & { stdout?: string; stderr?: string; code?: number };
        results.push({
          command,
          ok: false,
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? failure.message,
          startedAt,
          finishedAt: Date.now(),
        });
        break;
      }
    }
    return results;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private normalizeFailureText(raw: string): string {
    const worktreePrefix = `${this.git.worktreesDir.replace(/\\/g, "/")}/`;
    const repoRoot = this.git.repoRoot.replace(/\\/g, "/");
    const worktreePathRe = new RegExp(`${this.escapeRegex(worktreePrefix)}[^/\\s'":)]+`, "g");
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
  }

  private checkFailureExcerpt(check: FactoryCheckResult): string {
    const combined = this.normalizeFailureText(`${check.stderr}\n${check.stdout}`);
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
  }

  private checkFailureSignature(check: FactoryCheckResult): {
    readonly digest: string;
    readonly excerpt: string;
  } {
    const excerpt = this.checkFailureExcerpt(check);
    const digest = createHash("sha256")
      .update(`${check.command}\n${check.exitCode ?? "null"}\n${excerpt}`)
      .digest("hex")
      .slice(0, 12);
    return { digest, excerpt };
  }

  private priorFailureSignatureMap(state: FactoryState): ReadonlyMap<string, { readonly source: string; readonly excerpt: string }> {
    const signatures = new Map<string, { readonly source: string; readonly excerpt: string }>();
    for (const candidateId of state.candidateOrder) {
      const candidate = state.candidates[candidateId];
      if (!candidate) continue;
      for (const check of candidate.checkResults) {
        if (check.ok) continue;
        const { digest, excerpt } = this.checkFailureSignature(check);
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
      const { digest, excerpt } = this.checkFailureSignature(check);
      if (!signatures.has(digest)) {
        signatures.set(digest, {
          source: `integration/${state.integration.activeCandidateId ?? "unknown"}`,
          excerpt,
        });
      }
    }
    return signatures;
  }

  private async baselineFailureSignature(
    state: FactoryState,
    command: string,
    baseHash: string,
  ): Promise<{
    readonly digest: string;
    readonly excerpt: string;
  } | undefined> {
    const cacheKey = `${state.objectiveId}:${baseHash}:${command}`;
    const existing = this.baselineCheckCache.get(cacheKey);
    if (existing) return existing;

    const pending = (async () => {
      const workspaceId = `factory_baseline_${safeWorkspacePart(state.objectiveId)}_${createHash("sha1").update(command).digest("hex").slice(0, 10)}`;
      const workspacePath = path.join(this.git.worktreesDir, workspaceId);
      const branchName = `hub/baseline/${workspaceId}`;
      try {
        const workspace = await this.git.restoreWorkspace({
          workspaceId,
          branchName,
          workspacePath,
          baseHash,
        });
        const [result] = await this.runChecks([command], workspace.path);
        if (!result || result.ok) return undefined;
        return this.checkFailureSignature(result);
      } catch {
        return undefined;
      } finally {
        await this.git.removeWorkspace(workspacePath).catch(() => undefined);
      }
    })();

    this.baselineCheckCache.set(cacheKey, pending);
    return pending;
  }

  private async classifyFailedCheck(
    state: FactoryState,
    check: FactoryCheckResult,
    baseHash: string = state.baseHash,
  ): Promise<{
    readonly inherited: boolean;
    readonly digest: string;
    readonly excerpt: string;
    readonly source?: string;
  }> {
    const { digest, excerpt } = this.checkFailureSignature(check);
    const prior = this.priorFailureSignatureMap(state).get(digest);
    if (prior) {
      return {
        inherited: true,
        digest,
        excerpt,
        source: prior.source,
      };
    }
    const baseline = await this.baselineFailureSignature(state, check.command, baseHash);
    return {
      inherited: Boolean(baseline && baseline.digest === digest),
      digest,
      excerpt,
      source: baseline && baseline.digest === digest
        ? `baseline/${baseHash.slice(0, 8)}`
        : undefined,
    };
  }

  private inheritedFailureNote(check: FactoryCheckResult, classification: {
    readonly digest: string;
    readonly source?: string;
  }): string {
    return [
      `Deterministic review note: ${check.command} matched a prior failure signature.`,
      `signature=${classification.digest}`,
      classification.source ? `source=${classification.source}` : undefined,
      `This failure is treated as inherited, not as a new regression from the current candidate.`,
    ].filter(Boolean).join(" ");
  }

  private async readTextTail(filePath: string | undefined, maxChars: number): Promise<string | undefined> {
    if (!filePath) return undefined;
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const trimmed = raw.trim();
      return trimmed ? tailText(trimmed, maxChars) : undefined;
    } catch {
      return undefined;
    }
  }

  private makeId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
