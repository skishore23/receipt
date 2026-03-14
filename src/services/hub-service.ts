import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { jsonBranchStore, jsonlStore } from "../adapters/jsonl.js";
import type { JsonlQueue } from "../adapters/jsonl-queue.js";
import { type CodexExecutor, type CodexRunControl } from "../adapters/codex-executor.js";
import { HubGit, HubGitError, type HubGitCommit } from "../adapters/hub-git.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import {
  activatableNodes,
  graphProjection,
  runnableNodes,
  type GraphRef,
} from "../core/graph.js";
import { createRuntime, type Runtime } from "../core/runtime.js";
import { makeEventId } from "../framework/http.js";
import type { SseHub } from "../framework/sse-hub.js";
import type { JobCmd, JobEvent, JobRecord, JobState, JobStatus } from "../modules/job.js";
import {
  decide as decideHub,
  initial as initialHub,
  reduce as reduceHub,
  type AgentProfile,
  type Announcement,
  type BoardPost,
  type HubChannel,
  type HubCmd,
  type HubEvent,
  type HubObjectiveSummary,
  type HubState,
  type HubTask,
  type WorkspaceRecord,
} from "../modules/hub.js";
import {
  decideObjective,
  initialObjectiveState,
  objectiveLaneForStatus,
  reduceObjective,
  type ObjectiveCheckResult,
  type ObjectiveCmd,
  type ObjectiveEvent,
  type ObjectiveGraphNodeRecord,
  type ObjectiveLane,
  type ObjectivePassOutcome,
  type ObjectivePassRecord,
  type ObjectivePhase,
  type ObjectiveRecord,
  type ObjectiveState,
  type ObjectiveStatus,
} from "../modules/hub-objective.js";
import { merge, type MergeDecision, type MergePolicy } from "../sdk/merge.js";

const execFileAsync = promisify(execFile);

const HUB_STREAM = "hub/meta";
const OBJECTIVE_STREAM_PREFIX = "hub/objectives";
const DEFAULT_CHANNELS = ["general", "results", "failures"] as const;
const DEFAULT_ROLE_AGENTS = [
  { agentId: "planner-1", displayName: "Planner 1", memoryScope: "hub/agents/planner-1" },
  { agentId: "builder-1", displayName: "Builder 1", memoryScope: "hub/agents/builder-1" },
  { agentId: "reviewer-1", displayName: "Reviewer 1", memoryScope: "hub/agents/reviewer-1" },
] as const satisfies ReadonlyArray<Pick<AgentProfile, "agentId" | "displayName" | "memoryScope">>;
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_CHECKS = ["npm run build"] as const;
const OBJECTIVE_AGENT_BY_PHASE: Readonly<Record<ObjectivePhase, string>> = {
  planner: "planner-1",
  builder: "builder-1",
  reviewer: "reviewer-1",
};
const OBJECTIVE_RESULT_OUTCOMES: Readonly<Record<ObjectivePhase, ReadonlyArray<ObjectivePassOutcome>>> = {
  planner: ["plan_ready", "blocked"],
  builder: ["candidate_ready", "blocked"],
  reviewer: ["approved", "changes_requested", "blocked"],
};
const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

type ObjectivePolicyContext = {
  readonly state: ObjectiveState;
};

const objectiveMergePolicy: MergePolicy<ObjectivePolicyContext, { readonly status: ObjectiveStatus }> = merge({
  id: "hub-objective-linear",
  version: "1",
  candidates: (ctx) => {
    const current = ctx.state.currentPassId ? ctx.state.passes[ctx.state.currentPassId] : undefined;
    return current?.status === "queued" ? [{ id: current.passId, meta: { phase: current.phase } }] : [];
  },
  evidence: (ctx) => ({ status: ctx.state.status }),
  score: (candidate) => ({
    selected: candidate.id ? 1 : 0,
  }),
  choose: (scored) => {
    const first = scored[0];
    return {
      candidateId: first?.candidate.id ?? "",
      reason: first ? "single active candidate path" : "no active candidate",
    } satisfies MergeDecision;
  },
});

const isFastForwardDivergence = (err: unknown): boolean => {
  if (!(err instanceof HubGitError)) return false;
  const message = err.message.toLowerCase();
  return message.includes("unable to fast-forward")
    || message.includes("diverging branches")
    || message.includes("not possible to fast-forward");
};

export class HubServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type WorkspaceView = WorkspaceRecord & {
  readonly exists: boolean;
  readonly dirty: boolean;
  readonly head?: string;
  readonly branch?: string;
};

export type TaskView = HubTask & {
  readonly status: string;
  readonly job?: JobRecord;
};

export type HubCommitView = {
  readonly hash: string;
  readonly subject: string;
  readonly author: string;
  readonly ts: number;
  readonly parents: ReadonlyArray<string>;
};

export type HubAgentView = {
  readonly agentId: string;
  readonly displayName: string;
  readonly memoryScope: string;
};

export type HubObjectiveCard = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: ObjectiveStatus;
  readonly lane: ObjectiveLane;
  readonly currentPhase?: ObjectivePhase;
  readonly assignedAgentId?: string;
  readonly latestSummary?: string;
  readonly latestCommitHash?: string;
  readonly blockedReason?: string;
  readonly approvalState: ObjectiveRecord["approvalState"];
  readonly updatedAt: number;
  readonly activeJobStatus?: JobStatus | "missing";
  readonly activeElapsedMs?: number;
  readonly liveActivity?: string;
};

export type ObjectivePassView = ObjectivePassRecord & {
  readonly jobStatus: JobStatus | "missing";
  readonly job?: JobRecord;
  readonly workspaceExists: boolean;
  readonly workspaceDirty: boolean;
  readonly workspaceHead?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly lastMessage?: string;
  readonly activity?: string;
  readonly elapsedMs?: number;
};

export type HubRepoProjection = {
  readonly repoRoot: string;
  readonly defaultBranch: string;
  readonly sourceHead?: string;
  readonly sourceDirty: boolean;
  readonly sourceChangedFiles: ReadonlyArray<string>;
  readonly sourceBranch?: string;
  readonly mirrorHead?: string;
  readonly mirrorStatus: "fresh" | "stale" | "syncing" | "error";
  readonly mirrorLastSyncAt?: number;
  readonly mirrorLastSyncError?: string;
  readonly objectiveCount: number;
  readonly awaitingConfirmationCount: number;
  readonly agentIds: ReadonlyArray<string>;
};

export type HubBoardProjection = {
  readonly objectives: ReadonlyArray<HubObjectiveCard>;
  readonly lanes: Readonly<Record<ObjectiveLane, ReadonlyArray<HubObjectiveCard>>>;
  readonly selectedObjectiveId?: string;
};

export type HubObjectiveProjection = {
  readonly defaultBranch: string;
  readonly sourceBranch?: string;
  readonly sourceDirty: boolean;
  readonly selectedObjectiveId?: string;
  readonly objective?: ObjectiveDetail;
};

export type HubLiveProjection = {
  readonly selectedObjectiveId?: string;
  readonly objectiveTitle?: string;
  readonly objectiveStatus?: ObjectiveStatus;
  readonly activePass?: ObjectivePassView;
};

export type HubDebugProjection = {
  readonly workspaces: ReadonlyArray<WorkspaceView>;
  readonly posts: ReadonlyArray<BoardPost>;
  readonly tasks: ReadonlyArray<TaskView>;
};

export type HubCommitProjection = {
  readonly defaultBranch: string;
  readonly sourceHead?: string;
  readonly commitCount: number;
  readonly leafCount: number;
  readonly recentCommits: ReadonlyArray<HubCommitView>;
  readonly leaves: ReadonlyArray<HubCommitView>;
  readonly selectedCommit?: HubCommitView & { readonly touchedFiles: ReadonlyArray<string> };
  readonly selectedLineage: ReadonlyArray<HubCommitView>;
  readonly selectedDiff?: string;
};

export type HubProjectionInvalidation =
  | "summary"
  | "board"
  | "objective"
  | "live"
  | "debug"
  | "commits";

export type ObjectiveDetail = HubObjectiveCard & {
  readonly prompt: string;
  readonly channel: string;
  readonly baseHash: string;
  readonly checks: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly passes: ReadonlyArray<ObjectivePassView>;
  readonly latestCheckResults: ReadonlyArray<ObjectiveCheckResult>;
  readonly latestPlanSummary?: string;
  readonly latestPlanHandoff?: string;
  readonly latestBuildSummary?: string;
  readonly latestBuildHandoff?: string;
  readonly latestReviewOutcome?: Extract<ObjectivePassOutcome, "approved" | "changes_requested">;
  readonly latestReviewSummary?: string;
  readonly latestReviewHandoff?: string;
  readonly nextHandoff?: string;
  readonly activePass?: ObjectivePassView;
  readonly graph: ObjectiveGraphProjection;
};

export type ObjectiveGraphProjection = {
  readonly graphId: string;
  readonly status: ObjectiveState["graph"]["status"];
  readonly currentNodeId?: string;
  readonly readyNodeIds: ReadonlyArray<string>;
  readonly nodeOrder: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<ObjectiveGraphNodeRecord>;
};

export type HubDashboardModel = {
  readonly repoRoot: string;
  readonly defaultBranch: string;
  readonly sourceHead?: string;
  readonly sourceDirty: boolean;
  readonly sourceChangedFiles: ReadonlyArray<string>;
  readonly sourceBranch?: string;
  readonly commitCount: number;
  readonly leafCount: number;
  readonly recentCommits: ReadonlyArray<HubCommitView>;
  readonly leaves: ReadonlyArray<HubCommitView>;
  readonly selectedCommit?: HubCommitView & { readonly touchedFiles: ReadonlyArray<string> };
  readonly selectedLineage: ReadonlyArray<HubCommitView>;
  readonly selectedDiff?: string;
  readonly agents: ReadonlyArray<HubAgentView>;
  readonly channels: ReadonlyArray<string>;
  readonly posts: ReadonlyArray<BoardPost>;
  readonly workspaces: ReadonlyArray<WorkspaceView>;
  readonly tasks: ReadonlyArray<TaskView>;
  readonly objectives: ReadonlyArray<HubObjectiveCard>;
  readonly lanes: Readonly<Record<ObjectiveLane, ReadonlyArray<HubObjectiveCard>>>;
  readonly selectedObjective?: ObjectiveDetail;
};

export type HubComposeModel = {
  readonly defaultBranch: string;
  readonly sourceDirty: boolean;
  readonly sourceBranch?: string;
  readonly channels: ReadonlyArray<string>;
  readonly objectiveCount: number;
};

export type HubObjectiveInput = {
  readonly title: string;
  readonly prompt: string;
  readonly baseHash?: string;
  readonly checks?: ReadonlyArray<string>;
  readonly channel?: string;
};

export type HubObjectivePassJobPayload = {
  readonly kind: "hub.objective.pass";
  readonly objectiveId: string;
  readonly passId: string;
  readonly nodeId: string;
  readonly phase: ObjectivePhase;
  readonly passNumber: number;
  readonly agentId: string;
  readonly baseCommit: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly inputRefs: Readonly<Record<string, GraphRef>>;
  readonly promptPath: string;
  readonly resultPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly lastMessagePath: string;
};

type ObjectiveStageSnapshot = {
  readonly summary?: string;
  readonly handoff?: string;
  readonly outcome?: ObjectivePassOutcome;
  readonly commitHash?: string;
};

type HubServiceOptions = {
  readonly dataDir: string;
  readonly queue: JsonlQueue;
  readonly jobRuntime: Runtime<JobCmd, JobEvent, JobState>;
  readonly sse: SseHub;
  readonly codexExecutor: CodexExecutor;
  readonly memoryTools?: MemoryTools;
  readonly repoRoot?: string;
  readonly promptDir?: string;
};

type ParsedPassResult = {
  readonly outcome: ObjectivePassOutcome;
  readonly summary: string;
  readonly handoff: string;
};

const sortedValues = <T extends { readonly createdAt: number }>(record: Readonly<Record<string, T>>): T[] =>
  Object.values(record).sort((a, b) => b.createdAt - a.createdAt);

const shortHash = (value: string | undefined): string => value ? value.slice(0, 8) : "none";

const asTrimmed = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const asOptionalString = (value: unknown): string | undefined => {
  const next = asTrimmed(value);
  return next || undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requireNonEmpty = (value: unknown, message: string): string => {
  const next = asTrimmed(value);
  if (!next) throw new HubServiceError(400, message);
  return next;
};

const asPositiveInt = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const isTerminalJobStatus = (status?: JobStatus | "missing"): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const clipText = (value: string | undefined, max = 280): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const stripTrailingWhitespace = (value: string): string => value.replace(/\s+$/g, "");

const tailText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return stripTrailingWhitespace(value);
  return `…${stripTrailingWhitespace(value.slice(value.length - maxChars))}`;
};

const uniqueChecks = (checks?: ReadonlyArray<string>): ReadonlyArray<string> => {
  const source = (checks ?? DEFAULT_CHECKS)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(source)];
};

const renderTemplate = (template: string, vars: Readonly<Record<string, string>>): string =>
  Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value),
    template
  );

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const prependPath = (dir: string, currentPath: string | undefined): string =>
  currentPath ? `${dir}${path.delimiter}${currentPath}` : dir;

const stateRef = (ref: string, label?: string): GraphRef => ({ kind: "state", ref, label });

const fileRef = (ref: string, label?: string): GraphRef => ({ kind: "file", ref, label });

const commitRef = (ref: string, label?: string): GraphRef => ({ kind: "commit", ref, label });

const workspaceRef = (ref: string, label?: string): GraphRef => ({ kind: "workspace", ref, label });

type PlannedObjectiveNode = {
  readonly phase: ObjectivePhase;
  readonly baseCommit: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly inputRefs: Readonly<Record<string, GraphRef>>;
};

const objectiveStream = (objectiveId: string): string => `${OBJECTIVE_STREAM_PREFIX}/${objectiveId}`;

const laneOrder: ReadonlyArray<ObjectiveLane> = [
  "planner",
  "builder",
  "reviewer",
  "awaiting_confirmation",
  "blocked",
  "completed",
];

export class HubService {
  readonly dataDir: string;
  readonly git: HubGit;

  private readonly queue: JsonlQueue;
  private readonly jobRuntime: Runtime<JobCmd, JobEvent, JobState>;
  private readonly sse: SseHub;
  private readonly codexExecutor: CodexExecutor;
  private readonly memoryTools?: MemoryTools;
  private readonly promptDir: string;
  private readonly hubRuntime: Runtime<HubCmd, HubEvent, HubState>;
  private readonly objectiveRuntime: Runtime<ObjectiveCmd, ObjectiveEvent, ObjectiveState>;
  private bootstrapPromise: Promise<void> | undefined;

  constructor(opts: HubServiceOptions) {
    this.dataDir = opts.dataDir;
    this.queue = opts.queue;
    this.jobRuntime = opts.jobRuntime;
    this.sse = opts.sse;
    this.codexExecutor = opts.codexExecutor;
    this.memoryTools = opts.memoryTools;
    this.promptDir = opts.promptDir ?? path.join(process.cwd(), "prompts", "hub");
    this.hubRuntime = createRuntime<HubCmd, HubEvent, HubState>(
      jsonlStore<HubEvent>(this.dataDir),
      jsonBranchStore(this.dataDir),
      decideHub,
      reduceHub,
      initialHub
    );
    this.objectiveRuntime = createRuntime<ObjectiveCmd, ObjectiveEvent, ObjectiveState>(
      jsonlStore<ObjectiveEvent>(this.dataDir),
      jsonBranchStore(this.dataDir),
      decideObjective,
      reduceObjective,
      initialObjectiveState
    );
    this.git = new HubGit({
      dataDir: opts.dataDir,
      repoRoot: opts.repoRoot ?? process.env.HUB_REPO_ROOT ?? process.cwd(),
    });
  }

  async ensureBootstrap(): Promise<void> {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = (async () => {
        await this.git.ensureReady();
        const state = await this.hubRuntime.state(HUB_STREAM);
        for (const name of DEFAULT_CHANNELS) {
          if (state.channels[name]) continue;
          await this.emitHub({
            type: "channel.created",
            channel: {
              name,
              createdAt: Date.now(),
            },
          });
        }
        const nextState = await this.hubRuntime.state(HUB_STREAM);
        for (const seed of DEFAULT_ROLE_AGENTS) {
          if (nextState.agents[seed.agentId]) continue;
          await this.emitHub({
            type: "agent.registered",
            profile: {
              ...seed,
              createdAt: Date.now(),
            },
          });
        }
        await this.recoverObjectiveSummaries();
        void this.resumeObjectives().catch((err) => {
          console.warn("hub objective resume failed", err);
        });
      })();
    }
    return this.bootstrapPromise;
  }

  async createAgent(body: Record<string, unknown>): Promise<AgentProfile> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    const agentId = requireNonEmpty(body.agentId, "agentId required");
    if (!AGENT_ID_RE.test(agentId)) throw new HubServiceError(400, "invalid agentId");
    if (state.agents[agentId]) throw new HubServiceError(409, "agent already exists");
    const profile: AgentProfile = {
      agentId,
      displayName: asOptionalString(body.displayName) ?? agentId,
      memoryScope: asOptionalString(body.memoryScope) ?? `hub/agents/${agentId}`,
      createdAt: Date.now(),
    };
    await this.emitHub({ type: "agent.registered", profile });
    return profile;
  }

  async listAgents(): Promise<ReadonlyArray<AgentProfile>> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    return Object.values(state.agents).sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  async createChannel(body: Record<string, unknown>): Promise<HubChannel> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    const name = requireNonEmpty(body.name, "name required").toLowerCase();
    if (!CHANNEL_RE.test(name)) throw new HubServiceError(400, "invalid channel name");
    if (state.channels[name]) throw new HubServiceError(409, "channel already exists");
    const channel: HubChannel = { name, createdAt: Date.now() };
    await this.emitHub({ type: "channel.created", channel });
    return channel;
  }

  async listChannels(): Promise<ReadonlyArray<HubChannel>> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    return Object.values(state.channels).sort((a, b) => a.name.localeCompare(b.name));
  }

  async createPost(body: Record<string, unknown>, parentId?: string, forcedChannel?: string): Promise<BoardPost> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    const agentId = requireNonEmpty(body.agentId, "agentId required");
    this.requireAgent(state, agentId);
    const parent = parentId ? state.posts[parentId] : undefined;
    if (parentId && !parent) throw new HubServiceError(404, "post not found");
    const channelName = forcedChannel ?? asOptionalString(body.channel) ?? parent?.channel;
    if (!channelName) throw new HubServiceError(400, "channel required");
    this.requireChannel(state, channelName);
    const post: BoardPost = {
      postId: this.makeId("post"),
      channel: channelName,
      agentId,
      parentId,
      content: requireNonEmpty(body.content, "content required"),
      commitHash: asOptionalString(body.commitHash),
      workspaceId: asOptionalString(body.workspaceId),
      createdAt: Date.now(),
    };
    await this.emitHub({ type: "board.post.created", post });
    return post;
  }

  async listPosts(channel?: string): Promise<ReadonlyArray<BoardPost>> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    if (channel) this.requireChannel(state, channel);
    return sortedValues(state.posts).filter((post) => channel ? post.channel === channel : true);
  }

  async createWorkspace(body: Record<string, unknown>): Promise<WorkspaceRecord> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    const agentId = requireNonEmpty(body.agentId, "agentId required");
    this.requireAgent(state, agentId);
    const workspaceId = asOptionalString(body.workspaceId) ?? this.makeId("ws");
    if (!AGENT_ID_RE.test(workspaceId)) throw new HubServiceError(400, "invalid workspaceId");
    const existing = state.workspaces[workspaceId];
    if (existing && !existing.removedAt) throw new HubServiceError(409, "workspace already exists");
    const created = await this.git.createWorkspace({
      workspaceId,
      agentId,
      baseHash: asOptionalString(body.baseHash),
    });
    const workspace: WorkspaceRecord = {
      workspaceId,
      agentId,
      baseHash: created.baseHash,
      branchName: created.branchName,
      path: created.path,
      createdAt: Date.now(),
    };
    await this.emitHub({ type: "workspace.created", workspace });
    return workspace;
  }

  async listActiveWorkspaces(): Promise<ReadonlyArray<WorkspaceView>> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    return Promise.all(
      Object.values(state.workspaces)
        .filter((workspace) => !workspace.removedAt)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (workspace) => {
          const status = await this.git.worktreeStatus(workspace.path);
          return {
            ...workspace,
            exists: status.exists,
            dirty: status.dirty,
            head: status.head,
            branch: status.branch,
          };
        })
    );
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceView> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    const workspace = this.requireWorkspaceRecord(state, workspaceId);
    const status = await this.git.worktreeStatus(workspace.path);
    return {
      ...workspace,
      exists: status.exists,
      dirty: status.dirty,
      head: status.head,
      branch: status.branch,
    };
  }

  async removeWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    const workspace = this.requireWorkspaceRecord(state, workspaceId);
    if (workspace.removedAt) return workspace;
    await this.git.removeWorkspace(workspace.path);
    const removedAt = Date.now();
    await this.emitHub({
      type: "workspace.removed",
      workspaceId,
      removedAt,
    });
    return {
      ...workspace,
      removedAt,
    };
  }

  async announceWorkspace(workspaceId: string, body: Record<string, unknown>): Promise<Announcement> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    const workspace = await this.requireCleanWorkspace(state, workspaceId);
    const agentId = requireNonEmpty(body.agentId, "agentId required");
    this.requireAgent(state, agentId);
    const channel = asOptionalString(body.channel) ?? "results";
    this.requireChannel(state, channel);
    const content = asOptionalString(body.content) ?? `Announced ${shortHash(workspace.head ?? workspace.baseHash)} from ${workspace.workspaceId}.`;
    const post = await this.createPost({
      agentId,
      channel,
      content,
      commitHash: workspace.head,
      workspaceId,
    });
    const announcement: Announcement = {
      announcementId: this.makeId("announce"),
      agentId,
      workspaceId,
      commitHash: workspace.head ?? workspace.baseHash,
      channel,
      postId: post.postId,
      createdAt: Date.now(),
    };
    await this.emitHub({ type: "announcement.created", announcement });
    return announcement;
  }

  async createTask(body: Record<string, unknown>): Promise<HubTask> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    const agent = this.requireAgent(state, requireNonEmpty(body.agentId, "agentId required"));
    const workspace = await this.requireCleanWorkspace(state, requireNonEmpty(body.workspaceId, "workspaceId required"));
    const prompt = requireNonEmpty(body.prompt, "prompt required");
    const maxIterationsRaw = asPositiveInt(body.maxIterations);
    const maxIterations = maxIterationsRaw === undefined
      ? DEFAULT_MAX_ITERATIONS
      : Math.max(1, Math.min(maxIterationsRaw, 40));
    const taskId = this.makeId("task");
    const job = await this.queue.enqueue({
      agentId: "agent",
      lane: "collect",
      sessionKey: `hub-task:${taskId}`,
      singletonMode: "allow",
      maxAttempts: 2,
      payload: {
        kind: "agent.run",
        stream: "agents/agent",
        problem: prompt,
        config: {
          workspace: workspace.path,
          memoryScope: agent.memoryScope,
          maxIterations,
        },
      },
    });
    const task: HubTask = {
      taskId,
      agentId: agent.agentId,
      workspaceId: workspace.workspaceId,
      prompt,
      jobId: job.id,
      maxIterations,
      createdAt: Date.now(),
    };
    await this.emitHub({ type: "task.created", task });
    return task;
  }

  async listTasks(): Promise<ReadonlyArray<TaskView>> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    const tasks = sortedValues(state.tasks);
    const jobs = await Promise.all(tasks.map((task) => task.jobId ? this.loadFreshJob(task.jobId) : Promise.resolve(undefined)));
    return tasks.map((task, index) => ({
      ...task,
      status: jobs[index]?.status ?? "queued",
      job: jobs[index],
    }));
  }

  async getTask(taskId: string): Promise<TaskView> {
    await this.ensureBootstrap();
    const state = await this.hubRuntime.state(HUB_STREAM);
    const task = state.tasks[taskId];
    if (!task) throw new HubServiceError(404, "task not found");
    const job = task.jobId ? await this.loadFreshJob(task.jobId) : undefined;
    return {
      ...task,
      status: job?.status ?? "queued",
      job,
    };
  }

  async listCommits(limit = 40): Promise<ReadonlyArray<HubCommitView>> {
    await this.ensureBootstrap();
    await this.git.syncFromSource();
    const graph = await this.git.graph();
    return graph.commits.slice(0, Math.max(1, Math.min(limit, 200))).map(this.commitToView);
  }

  async getCommit(hash: string): Promise<HubGitCommit> {
    await this.ensureBootstrap();
    await this.git.syncFromSource();
    return this.git.getCommit(hash);
  }

  async getChildren(hash: string): Promise<ReadonlyArray<HubGitCommit>> {
    await this.ensureBootstrap();
    await this.git.syncFromSource();
    return this.git.getChildren(hash);
  }

  async getLineage(hash: string): Promise<ReadonlyArray<HubGitCommit>> {
    await this.ensureBootstrap();
    await this.git.syncFromSource();
    return this.git.getLineage(hash);
  }

  async getLeaves(limit = 24): Promise<ReadonlyArray<HubCommitView>> {
    await this.ensureBootstrap();
    await this.git.syncFromSource();
    const graph = await this.git.graph();
    return graph.leaves
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((hash) => graph.byHash[hash])
      .filter((commit): commit is HubGitCommit => Boolean(commit))
      .map(this.commitToView);
  }

  async diff(hashA: string, hashB: string): Promise<string> {
    await this.ensureBootstrap();
    await this.git.syncFromSource();
    return this.git.diff(hashA, hashB);
  }

  async createObjective(input: HubObjectiveInput): Promise<ObjectiveDetail> {
    await this.ensureBootstrap();
    const title = requireNonEmpty(input.title, "title required");
    const prompt = requireNonEmpty(input.prompt, "prompt required");
    const checks = uniqueChecks(input.checks);
    const channel = input.channel?.trim() || "results";
    const hubState = await this.hubRuntime.state(HUB_STREAM);
    this.requireChannel(hubState, channel);
    const sourceStatus = await this.git.sourceStatus();
    if (!input.baseHash && sourceStatus.dirty) {
      throw new HubServiceError(
        409,
        "source repository has uncommitted changes. Objectives only see committed Git history. Commit or stash changes first, or provide baseHash explicitly."
      );
    }
    const baseHash = await this.git.resolveBaseHash(input.baseHash);
    const objectiveId = this.makeId("objective");
    const createdAt = Date.now();
    await this.emitObjective(objectiveId, {
      type: "objective.created",
      objectiveId,
      title,
      prompt,
      channel,
      baseHash,
      checks,
      createdAt,
    });
    await this.reactObjective(objectiveId);
    return this.getObjective(objectiveId);
  }

  async listObjectives(): Promise<ReadonlyArray<HubObjectiveCard>> {
    return (await this.buildBoardProjection()).objectives;
  }

  async getObjective(objectiveId: string): Promise<ObjectiveDetail> {
    await this.ensureBootstrap();
    const state = await this.requireObjectiveState(objectiveId);
    return this.buildObjectiveDetail(state);
  }

  async mergeObjective(objectiveId: string): Promise<ObjectiveDetail> {
    await this.ensureBootstrap();
    let state = await this.requireObjectiveState(objectiveId);
    if (state.status !== "awaiting_confirmation") {
      throw new HubServiceError(409, "objective is not ready to merge");
    }
    const candidateCommit = state.latestCommitHash;
    if (!candidateCommit) {
      throw new HubServiceError(409, "objective has no candidate commit to merge");
    }
    let promoted;
    try {
      promoted = await this.git.promoteCommit(candidateCommit);
    } catch (err) {
      if (!isFastForwardDivergence(err)) throw err;
      const source = await this.git.sourceStatus();
      if (!source.head) throw err;
      const reconcile = this.planReconciliationNode(state, source.head);
      await this.emitObjective(objectiveId, {
        type: "objective.resumed",
        objectiveId,
        phase: "builder",
        summary: `Target branch advanced to ${shortHash(source.head)}. Queued a reconciliation builder pass on the latest ${source.branch ?? await this.git.defaultBranch()}.`,
        resumedAt: Date.now(),
      });
      state = await this.requireObjectiveState(objectiveId);
      await this.planObjectiveNode(state, reconcile);
      return this.getObjective(objectiveId);
    }
    const approvedAt = Date.now();
    await this.emitObjective(objectiveId, {
      type: "objective.approved",
      objectiveId,
      approvedAt,
    });
    await this.emitObjective(objectiveId, {
      type: "objective.completed",
      objectiveId,
      summary: `Merged ${shortHash(promoted.mergedHead)} into ${promoted.targetBranch}.`,
      completedAt: Date.now(),
    });
    await this.cleanupObjectiveWorkspaces(state);
    return this.getObjective(objectiveId);
  }

  async approveObjective(objectiveId: string): Promise<ObjectiveDetail> {
    return this.mergeObjective(objectiveId);
  }

  async resumeObjective(objectiveId: string): Promise<ObjectiveDetail> {
    await this.ensureBootstrap();
    const state = await this.requireObjectiveState(objectiveId);
    if (!["blocked", "failed"].includes(state.status)) {
      throw new HubServiceError(409, "objective is not resumable");
    }
    const next = this.planNextObjectiveNode(state);
    if (next === "awaiting_confirmation") {
      throw new HubServiceError(409, "objective is awaiting merge, not resume");
    }
    const phase = next?.phase
      ?? state.currentPhase
      ?? state.passOrder.map((passId) => state.passes[passId]).at(-1)?.phase
      ?? "planner";
    await this.emitObjective(objectiveId, {
      type: "objective.resumed",
      objectiveId,
      phase,
      summary: `Resumed ${phase} pass.`,
      resumedAt: Date.now(),
    });
    await this.reactObjective(objectiveId);
    return this.getObjective(objectiveId);
  }

  async cancelObjective(objectiveId: string, reason?: string): Promise<ObjectiveDetail> {
    await this.ensureBootstrap();
    const state = await this.requireObjectiveState(objectiveId);
    const activePass = state.currentPassId ? state.passes[state.currentPassId] : undefined;
    if (activePass) {
      await this.queue.cancel(activePass.jobId, reason ?? "objective canceled", "hub");
    }
    await this.emitObjective(objectiveId, {
      type: "objective.canceled",
      objectiveId,
      canceledAt: Date.now(),
      reason,
    });
    await this.cleanupObjectiveWorkspaces(state);
    return this.getObjective(objectiveId);
  }

  async cleanupObjective(objectiveId: string): Promise<ObjectiveDetail> {
    await this.ensureBootstrap();
    await this.reactObjective(objectiveId);
    const state = await this.requireObjectiveState(objectiveId);
    if (!["completed", "blocked", "failed", "canceled"].includes(state.status)) {
      throw new HubServiceError(409, "objective workspaces can only be cleaned after the objective stops running");
    }
    await this.cleanupObjectiveWorkspaces(state);
    return this.getObjective(objectiveId);
  }

  async buildRepoProjection(): Promise<HubRepoProjection> {
    await this.ensureBootstrap();
    const [hubState, sourceStatus, defaultBranch] = await Promise.all([
      this.hubRuntime.state(HUB_STREAM),
      this.git.sourceStatus(),
      this.git.defaultBranch(),
    ]);
    const sourceBranch = sourceStatus.branch ?? defaultBranch;
    const mirror = await this.git.mirrorStatus(sourceBranch);
    const sourceHead = sourceStatus.head;
    const mirrorHead = mirror.head;
    const mirrorStale = Boolean(sourceHead && sourceHead !== mirrorHead) || (!mirrorHead && Boolean(sourceHead));
    if (mirrorStale && !mirror.syncing) {
      this.git.scheduleSyncFromSource();
    }
    return {
      repoRoot: this.git.repoRoot,
      defaultBranch,
      sourceHead,
      sourceDirty: sourceStatus.dirty,
      sourceChangedFiles: sourceStatus.changedFiles,
      sourceBranch: sourceStatus.branch,
      mirrorHead,
      mirrorStatus: mirror.lastSyncError
        ? "error"
        : mirror.syncing
          ? "syncing"
          : mirrorStale
            ? "stale"
            : "fresh",
      mirrorLastSyncAt: mirror.lastSyncAt,
      mirrorLastSyncError: mirror.lastSyncError,
      objectiveCount: Object.keys(hubState.objectives).length,
      awaitingConfirmationCount: Object.values(hubState.objectives).filter((objective) => objective.status === "awaiting_confirmation").length,
      agentIds: Object.values(hubState.agents)
        .sort((a, b) => a.agentId.localeCompare(b.agentId))
        .map((agent) => agent.agentId),
    };
  }

  async buildBoardProjection(selectedObjectiveId?: string): Promise<HubBoardProjection> {
    await this.ensureBootstrap();
    const hubState = await this.hubRuntime.state(HUB_STREAM);
    const objectives = Object.values(hubState.objectives).sort((a, b) => b.updatedAt - a.updatedAt);
    const resolvedSelectedObjectiveId = this.resolveSelectedObjectiveId(hubState, selectedObjectiveId);
    const jobs = await Promise.all(
      objectives.map((objective) => objective.currentJobId ? this.loadFreshJob(objective.currentJobId) : Promise.resolve(undefined))
    );
    const cards = objectives.map((objective, index) => this.objectiveToCard(objective, jobs[index]));
    return {
      objectives: cards,
      lanes: {
        planner: cards.filter((objective) => objective.lane === "planner"),
        builder: cards.filter((objective) => objective.lane === "builder"),
        reviewer: cards.filter((objective) => objective.lane === "reviewer"),
        awaiting_confirmation: cards.filter((objective) => objective.lane === "awaiting_confirmation"),
        blocked: cards.filter((objective) => objective.lane === "blocked"),
        completed: cards.filter((objective) => objective.lane === "completed"),
      },
      selectedObjectiveId: resolvedSelectedObjectiveId,
    };
  }

  async buildObjectiveProjection(selectedObjectiveId?: string): Promise<HubObjectiveProjection> {
    await this.ensureBootstrap();
    const hubState = await this.hubRuntime.state(HUB_STREAM);
    const resolvedSelectedObjectiveId = this.resolveSelectedObjectiveId(hubState, selectedObjectiveId);
    const objective = resolvedSelectedObjectiveId
      ? await this.requireObjectiveState(resolvedSelectedObjectiveId).then((state) => this.buildObjectiveDetail(state))
      : undefined;
    const [defaultBranch, sourceStatus] = await Promise.all([
      this.git.defaultBranch(),
      objective?.status === "awaiting_confirmation"
        ? this.git.sourceStatus()
        : Promise.resolve({
          dirty: false,
          head: undefined,
          branch: undefined,
          changedFiles: [],
        }),
    ]);
    return {
      defaultBranch,
      sourceBranch: sourceStatus.branch,
      sourceDirty: sourceStatus.dirty,
      selectedObjectiveId: resolvedSelectedObjectiveId,
      objective,
    };
  }

  async buildLiveProjection(selectedObjectiveId?: string): Promise<HubLiveProjection> {
    await this.ensureBootstrap();
    const hubState = await this.hubRuntime.state(HUB_STREAM);
    const resolvedSelectedObjectiveId = this.resolveSelectedObjectiveId(hubState, selectedObjectiveId);
    if (!resolvedSelectedObjectiveId) {
      return {};
    }
    const state = await this.requireObjectiveState(resolvedSelectedObjectiveId);
    const activePass = state.currentPassId ? state.passes[state.currentPassId] : undefined;
    if (!activePass || activePass.status !== "queued") {
      return {
        selectedObjectiveId: resolvedSelectedObjectiveId,
        objectiveTitle: state.title,
        objectiveStatus: state.status,
      };
    }
    const job = await this.loadFreshJob(activePass.jobId);
    const workspaceStatus = await this.git.worktreeStatus(activePass.workspacePath);
    const live = await this.readPassLiveData(activePass, job);
    return {
      selectedObjectiveId: resolvedSelectedObjectiveId,
      objectiveTitle: state.title,
      objectiveStatus: state.status,
      activePass: {
        ...activePass,
        jobStatus: job?.status ?? "missing",
        job,
        workspaceExists: workspaceStatus.exists,
        workspaceDirty: workspaceStatus.dirty,
        workspaceHead: workspaceStatus.head,
        activity: this.describePassActivity(activePass, job),
        elapsedMs: this.passElapsedMs(activePass, job),
        ...live,
      },
    };
  }

  async buildDebugProjection(): Promise<HubDebugProjection> {
    await this.ensureBootstrap();
    const [workspaces, posts, tasks] = await Promise.all([
      this.listActiveWorkspaces(),
      this.listPosts(),
      this.listTasks(),
    ]);
    return {
      workspaces,
      posts: posts.slice(0, 60),
      tasks,
    };
  }

  async buildCommitProjection(selectedHash?: string): Promise<HubCommitProjection> {
    await this.ensureBootstrap();
    await this.refreshMirrorForExplorer();
    const graph = await this.git.graph();
    const selectedCommit = selectedHash
      ? await this.git.getCommit(selectedHash)
      : graph.commits[0]
        ? await this.git.getCommit(graph.commits[0].hash)
        : undefined;
    const lineage = selectedCommit ? await this.git.getLineage(selectedCommit.hash) : [];
    const diff = selectedCommit?.parents[0]
      ? await this.git.diff(selectedCommit.parents[0], selectedCommit.hash)
      : "";
    const leaves = graph.leaves
      .slice(0, 24)
      .map((hash) => graph.byHash[hash])
      .filter((commit): commit is HubGitCommit => Boolean(commit));
    return {
      defaultBranch: graph.defaultBranch,
      sourceHead: graph.sourceHead,
      commitCount: graph.commits.length,
      leafCount: graph.leaves.length,
      recentCommits: graph.commits.slice(0, 40).map(this.commitToView),
      leaves: leaves.map(this.commitToView),
      selectedCommit: selectedCommit
        ? {
          ...this.commitToView(selectedCommit),
          touchedFiles: selectedCommit.touchedFiles ?? [],
        }
        : undefined,
      selectedLineage: lineage.map(this.commitToView),
      selectedDiff: diff,
    };
  }

  async buildDashboard(selectedHash?: string, selectedObjectiveId?: string): Promise<HubDashboardModel> {
    await this.ensureBootstrap();
    const [hubState, repo, board, objective, debug, commits] = await Promise.all([
      this.hubRuntime.state(HUB_STREAM),
      this.buildRepoProjection(),
      this.buildBoardProjection(selectedObjectiveId),
      this.buildObjectiveProjection(selectedObjectiveId),
      this.buildDebugProjection(),
      this.buildCommitProjection(selectedHash),
    ]);
    return {
      repoRoot: repo.repoRoot,
      defaultBranch: repo.defaultBranch,
      sourceHead: repo.sourceHead,
      sourceDirty: repo.sourceDirty,
      sourceChangedFiles: repo.sourceChangedFiles,
      sourceBranch: repo.sourceBranch,
      commitCount: commits.commitCount,
      leafCount: commits.leafCount,
      recentCommits: commits.recentCommits,
      leaves: commits.leaves,
      selectedCommit: commits.selectedCommit,
      selectedLineage: commits.selectedLineage,
      selectedDiff: commits.selectedDiff,
      agents: Object.values(hubState.agents)
        .sort((a, b) => a.agentId.localeCompare(b.agentId))
        .map((agent) => ({
          agentId: agent.agentId,
          displayName: agent.displayName,
          memoryScope: agent.memoryScope,
        })),
      channels: Object.values(hubState.channels)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((channel) => channel.name),
      posts: debug.posts,
      workspaces: debug.workspaces,
      tasks: debug.tasks,
      objectives: board.objectives,
      lanes: board.lanes,
      selectedObjective: objective.objective,
    };
  }

  async buildComposeModel(): Promise<HubComposeModel> {
    await this.ensureBootstrap();
    const [hubState, sourceStatus, defaultBranch] = await Promise.all([
      this.hubRuntime.state(HUB_STREAM),
      this.git.sourceStatus(),
      this.git.defaultBranch(),
    ]);
    return {
      defaultBranch,
      sourceDirty: sourceStatus.dirty,
      sourceBranch: sourceStatus.branch,
      channels: Object.keys(hubState.channels).sort((a, b) => a.localeCompare(b)),
      objectiveCount: Object.keys(hubState.objectives).length,
    };
  }

  async buildStatePayload(selectedHash?: string, selectedObjectiveId?: string): Promise<Record<string, unknown>> {
    const [repo, board, objective, debug, commits, agents, channels] = await Promise.all([
      this.buildRepoProjection(),
      this.buildBoardProjection(selectedObjectiveId),
      this.buildObjectiveProjection(selectedObjectiveId),
      this.buildDebugProjection(),
      this.buildCommitProjection(selectedHash),
      this.listAgents(),
      this.listChannels(),
    ]);
    return {
      repo: {
        repoRoot: repo.repoRoot,
        defaultBranch: repo.defaultBranch,
        sourceHead: repo.sourceHead,
        dirty: repo.sourceDirty,
        changedFiles: repo.sourceChangedFiles,
        branch: repo.sourceBranch,
        mirrorHead: repo.mirrorHead,
        mirrorStatus: repo.mirrorStatus,
        mirrorLastSyncAt: repo.mirrorLastSyncAt,
        mirrorLastSyncError: repo.mirrorLastSyncError,
      },
      graph: {
        commitCount: commits.commitCount,
        leafCount: commits.leafCount,
        recentCommits: commits.recentCommits,
        leaves: commits.leaves,
        selectedCommit: commits.selectedCommit,
        selectedLineage: commits.selectedLineage,
        selectedDiff: commits.selectedDiff,
      },
      agents,
      channels: channels.map((channel) => channel.name),
      posts: debug.posts,
      workspaces: debug.workspaces,
      tasks: debug.tasks,
      objectives: board.objectives,
      lanes: board.lanes,
      selectedObjective: objective.objective,
    };
  }

  async runObjectivePass(payload: Record<string, unknown>, control?: CodexRunControl): Promise<Record<string, unknown>> {
    await this.ensureBootstrap();
    const parsed = this.parseObjectivePassPayload(payload);
    const state = await this.requireObjectiveState(parsed.objectiveId);
    const pass = state.passes[parsed.passId];
    if (!pass) throw new HubServiceError(404, "objective pass not found");
    const hubState = await this.hubRuntime.state(HUB_STREAM);
    const agent = this.requireAgent(hubState, pass.agentId);
    const workspacePath = await this.ensureObjectiveWorkspace(hubState, pass);
    const files = await this.writePassFiles(state, { ...pass, workspacePath }, agent, parsed.inputRefs);
    const receiptBinDir = await this.ensureWorkspaceReceiptCli(workspacePath);
    await this.codexExecutor.run({
      prompt: files.renderedPrompt,
      workspacePath,
      promptPath: pass.promptPath ?? files.promptPath,
      lastMessagePath: pass.lastMessagePath ?? files.lastMessagePath,
      stdoutPath: pass.stdoutPath ?? files.stdoutPath,
      stderrPath: pass.stderrPath ?? files.stderrPath,
      env: {
        DATA_DIR: this.dataDir,
        PATH: prependPath(receiptBinDir, process.env.PATH),
      },
    }, control);
    const rawResult = await fs.readFile(pass.resultPath ?? files.resultPath, "utf-8").catch(() => "");
    const parsedResult = this.parsePassResult(rawResult, pass.phase);
    await this.applyPassResult(await this.requireObjectiveState(parsed.objectiveId), { ...pass, workspacePath }, parsedResult, agent);
    await this.reactObjective(parsed.objectiveId);
    return {
      objectiveId: parsed.objectiveId,
      passId: pass.passId,
      phase: pass.phase,
      outcome: parsedResult.outcome,
    };
  }

  async reactObjective(objectiveId: string): Promise<void> {
    await this.ensureBootstrap();
    let state = await this.requireObjectiveState(objectiveId);
    const currentNode = state.graph.currentNodeId ? state.graph.nodes[state.graph.currentNodeId] : undefined;
    if (currentNode) {
      await this.reconcileObjectiveNode(state, currentNode);
      return;
    }

    if (state.status === "awaiting_confirmation" || state.status === "blocked" || state.status === "failed" || state.status === "completed" || state.status === "canceled") {
      return;
    }

    const nextActivatable = activatableNodes(state.graph)[0];
    if (nextActivatable) {
      await this.emitObjective(objectiveId, {
        type: "graph.node.ready",
        objectiveId,
        nodeId: nextActivatable.nodeId,
        readyAt: Date.now(),
      });
      state = await this.requireObjectiveState(objectiveId);
    }

    const readyNode = runnableNodes(state.graph)[0];
    if (readyNode) {
      const pass = state.passes[readyNode.passId];
      if (!pass) throw new HubServiceError(500, `missing pass for graph node ${readyNode.nodeId}`);
      await this.dispatchGraphNode(state, readyNode, pass);
      return;
    }

    const nextNode = this.planNextObjectiveNode(state);
    if (!nextNode) {
      return;
    }
    if (nextNode === "awaiting_confirmation") {
      const latestReview = [...state.passOrder]
        .map((passId) => state.passes[passId])
        .reverse()
        .find((pass) => pass.phase === "reviewer" && pass.outcome === "approved");
      await this.emitObjective(objectiveId, {
        type: "objective.awaiting_confirmation",
        objectiveId,
        summary: latestReview?.summary ?? "Review approved. Awaiting confirmation.",
        createdAt: Date.now(),
      });
      return;
    }
    await this.planObjectiveNode(state, nextNode);
  }

  async resumeObjectives(): Promise<void> {
    const hubState = await this.hubRuntime.state(HUB_STREAM);
    const candidates = Object.values(hubState.objectives)
      .filter((objective) => !["completed", "canceled", "failed", "blocked"].includes(objective.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const objective of candidates) {
      await this.reactObjective(objective.objectiveId);
    }
  }

  private async planObjectiveNode(state: ObjectiveState, next: PlannedObjectiveNode): Promise<void> {
    const hubState = await this.hubRuntime.state(HUB_STREAM);
    const agent = this.resolvePhaseAgent(hubState, next.phase);
    const passNumber = state.passOrder.length + 1;
    const workspaceId = `${state.objectiveId}_${next.phase}_${String(passNumber).padStart(2, "0")}`;
    let workspace = hubState.workspaces[workspaceId];
    if (!workspace || workspace.removedAt) {
      const created = await this.git.createWorkspace({
        workspaceId,
        agentId: agent.agentId,
        baseHash: next.baseCommit,
      });
      workspace = {
        workspaceId,
        agentId: agent.agentId,
        baseHash: created.baseHash,
        branchName: created.branchName,
        path: created.path,
        createdAt: Date.now(),
      };
      await this.emitHub({ type: "workspace.created", workspace });
    }
    const files = this.passFilePaths(workspace.path, next.phase, passNumber);
    const pass: Omit<ObjectivePassRecord, "status"> = {
      passId: `${state.objectiveId}_${next.phase}_${String(passNumber).padStart(2, "0")}`,
      phase: next.phase,
      passNumber,
      agentId: agent.agentId,
      jobId: `job_hub_${state.objectiveId}_${next.phase}_${String(passNumber).padStart(2, "0")}`,
      workspaceId,
      workspacePath: workspace.path,
      baseCommit: next.baseCommit,
      dispatchedAt: Date.now(),
      promptPath: files.promptPath,
      resultPath: files.resultPath,
      stdoutPath: files.stdoutPath,
      stderrPath: files.stderrPath,
      lastMessagePath: files.lastMessagePath,
    };
    const node: Omit<ObjectiveGraphNodeRecord, "status" | "outputRefs"> = {
      nodeId: pass.passId,
      kind: pass.phase,
      title: `${pass.phase}-${String(pass.passNumber).padStart(2, "0")}`,
      passId: pass.passId,
      passNumber: pass.passNumber,
      agentId: pass.agentId,
      jobId: pass.jobId,
      workspaceId: pass.workspaceId,
      workspacePath: pass.workspacePath,
      baseCommit: pass.baseCommit,
      dependsOn: next.dependsOn,
      inputRefs: next.inputRefs,
      createdAt: pass.dispatchedAt,
      readyAt: pass.dispatchedAt,
      dispatchedAt: pass.dispatchedAt,
    };
    await this.emitObjective(state.objectiveId, {
      type: "graph.node.planned",
      objectiveId: state.objectiveId,
      node,
      plannedAt: pass.dispatchedAt,
    });
    await this.emitObjective(state.objectiveId, {
      type: "graph.node.ready",
      objectiveId: state.objectiveId,
      nodeId: node.nodeId,
      readyAt: pass.dispatchedAt,
    });
    await this.emitObjective(state.objectiveId, {
      type: "phase.dispatched",
      objectiveId: state.objectiveId,
      pass,
      dispatchedAt: pass.dispatchedAt,
    });
    await this.dispatchGraphNode(
      await this.requireObjectiveState(state.objectiveId),
      { ...node, status: "ready", outputRefs: {} },
      { ...pass, status: "queued" },
    );
  }

  private async dispatchGraphNode(
    state: ObjectiveState,
    node: ObjectiveGraphNodeRecord,
    pass: ObjectivePassRecord,
  ): Promise<void> {
    await this.emitObjective(state.objectiveId, {
      type: "graph.node.dispatched",
      objectiveId: state.objectiveId,
      nodeId: node.nodeId,
      jobId: pass.jobId,
      dispatchedAt: Date.now(),
    });
    await this.enqueueObjectivePass(state.objectiveId, pass, node);
  }

  private async enqueueObjectivePass(
    objectiveId: string,
    pass: ObjectivePassRecord,
    node: Pick<ObjectiveGraphNodeRecord, "nodeId" | "inputRefs">,
  ): Promise<void> {
    const payload: HubObjectivePassJobPayload = {
      kind: "hub.objective.pass",
      objectiveId,
      passId: pass.passId,
      nodeId: node.nodeId,
      phase: pass.phase,
      passNumber: pass.passNumber,
      agentId: pass.agentId,
      baseCommit: pass.baseCommit,
      workspaceId: pass.workspaceId,
      workspacePath: pass.workspacePath,
      inputRefs: node.inputRefs,
      promptPath: pass.promptPath ?? this.passFilePaths(pass.workspacePath, pass.phase, pass.passNumber).promptPath,
      resultPath: pass.resultPath ?? this.passFilePaths(pass.workspacePath, pass.phase, pass.passNumber).resultPath,
      stdoutPath: pass.stdoutPath ?? this.passFilePaths(pass.workspacePath, pass.phase, pass.passNumber).stdoutPath,
      stderrPath: pass.stderrPath ?? this.passFilePaths(pass.workspacePath, pass.phase, pass.passNumber).stderrPath,
      lastMessagePath: pass.lastMessagePath ?? this.passFilePaths(pass.workspacePath, pass.phase, pass.passNumber).lastMessagePath,
    };
    await this.queue.enqueue({
      jobId: pass.jobId,
      agentId: "codex",
      lane: "collect",
      sessionKey: `hub-objective:${payload.objectiveId}`,
      singletonMode: "allow",
      maxAttempts: 2,
      payload,
    });
    this.sse.publish("jobs", pass.jobId);
  }

  private async reconcileObjectiveNode(
    state: ObjectiveState,
    node: ObjectiveGraphNodeRecord,
  ): Promise<void> {
    const pass = state.passes[node.passId];
    if (!pass) throw new HubServiceError(500, `missing pass for graph node ${node.nodeId}`);
    const job = await this.loadFreshJob(pass.jobId);
    if (!job) {
      await this.enqueueObjectivePass(state.objectiveId, pass, node);
      return;
    }
    if (!isTerminalJobStatus(job.status)) return;
    if (job.status === "completed" && pass.status === "queued") {
      await this.emitObjective(state.objectiveId, {
        type: "graph.node.terminal",
        objectiveId: state.objectiveId,
        nodeId: node.nodeId,
        status: "blocked",
        reason: "objective pass completed without durable outcome",
        completedAt: Date.now(),
      });
      await this.emitObjective(state.objectiveId, {
        type: "blocked",
        objectiveId: state.objectiveId,
        phase: pass.phase,
        passId: pass.passId,
        summary: "Objective pass completed without recording an objective event.",
        reason: "objective pass completed without durable outcome",
        completedAt: Date.now(),
      });
      return;
    }
    if ((job.status === "failed" || job.status === "canceled") && pass.status === "queued") {
      const reason = job.lastError ?? job.canceledReason ?? "objective pass failed";
      await this.emitObjective(state.objectiveId, {
        type: "graph.node.terminal",
        objectiveId: state.objectiveId,
        nodeId: node.nodeId,
        status: "blocked",
        reason,
        completedAt: Date.now(),
      });
      await this.emitObjective(state.objectiveId, {
        type: "blocked",
        objectiveId: state.objectiveId,
        phase: pass.phase,
        passId: pass.passId,
        summary: clipText(reason, 240) ?? "Objective pass failed.",
        reason,
        completedAt: Date.now(),
      });
    }
  }

  private planNextObjectiveNode(state: ObjectiveState): PlannedObjectiveNode | "awaiting_confirmation" | undefined {
    const completedNodes = graphProjection(state.graph).completed;
    const lastNode = completedNodes[completedNodes.length - 1];
    if (!lastNode) {
      return {
        phase: "planner",
        baseCommit: state.baseHash,
        dependsOn: [],
        inputRefs: {
          objective: stateRef(`${objectiveStream(state.objectiveId)}:prompt`, "objective prompt"),
          baseCommit: commitRef(state.baseHash, "base commit"),
          checks: stateRef(`${objectiveStream(state.objectiveId)}:checks`, "required checks"),
        },
      };
    }
    const lastPass = state.passes[lastNode.passId];
    if (!lastPass) return undefined;
    if (lastPass.phase === "planner" && lastPass.outcome === "plan_ready") {
      return {
        phase: "builder",
        baseCommit: state.baseHash,
        dependsOn: [lastNode.nodeId],
        inputRefs: this.buildNodeInputRefs(state, state.baseHash, [lastNode.nodeId]),
      };
    }
    if (lastPass.phase === "builder" && lastPass.outcome === "candidate_ready" && lastPass.commitHash) {
      return {
        phase: "reviewer",
        baseCommit: lastPass.commitHash,
        dependsOn: [lastNode.nodeId],
        inputRefs: this.buildNodeInputRefs(state, lastPass.commitHash, [lastNode.nodeId]),
      };
    }
    if (lastPass.phase === "reviewer" && lastPass.outcome === "changes_requested" && lastPass.commitHash) {
      return {
        phase: "builder",
        baseCommit: lastPass.commitHash,
        dependsOn: [lastNode.nodeId],
        inputRefs: this.buildNodeInputRefs(state, lastPass.commitHash, [lastNode.nodeId]),
      };
    }
    if (lastPass.phase === "reviewer" && lastPass.outcome === "approved") {
      return "awaiting_confirmation";
    }
    return undefined;
  }

  private planReconciliationNode(state: ObjectiveState, targetBaseCommit: string): PlannedObjectiveNode {
    const completedNodes = graphProjection(state.graph).completed;
    const lastNode = completedNodes[completedNodes.length - 1];
    const dependsOn = lastNode ? [lastNode.nodeId] : [];
    return {
      phase: "builder",
      baseCommit: targetBaseCommit,
      dependsOn,
      inputRefs: this.buildNodeInputRefs(state, targetBaseCommit, dependsOn),
    };
  }

  private async applyPassResult(
    state: ObjectiveState,
    pass: ObjectivePassRecord,
    result: ParsedPassResult,
    agent: AgentProfile,
  ): Promise<void> {
    const cleanSummary = clipText(result.summary, 1_200) ?? "Objective pass completed.";
    const cleanHandoff = clipText(result.handoff, 4_000) ?? cleanSummary;
    const completedAt = Date.now();

    if (result.outcome === "blocked") {
      await this.emitObjective(state.objectiveId, {
        type: "graph.node.terminal",
        objectiveId: state.objectiveId,
        nodeId: pass.passId,
        status: "blocked",
        reason: cleanHandoff,
        completedAt,
      });
      await this.emitObjective(state.objectiveId, {
        type: "blocked",
        objectiveId: state.objectiveId,
        phase: pass.phase,
        passId: pass.passId,
        summary: cleanSummary,
        reason: cleanHandoff,
        completedAt,
      });
      await this.commitPassMemory(agent, pass.phase, cleanSummary, "blocked");
      return;
    }

    if (pass.phase === "planner") {
      const status = await this.git.worktreeStatus(pass.workspacePath);
      if (status.dirty) {
        throw new HubServiceError(409, "planner pass modified tracked files");
      }
      await this.emitObjective(state.objectiveId, {
        type: "plan.ready",
        objectiveId: state.objectiveId,
        passId: pass.passId,
        summary: cleanSummary,
        handoff: cleanHandoff,
        completedAt,
      });
      await this.emitObjective(state.objectiveId, {
        type: "graph.node.completed",
        objectiveId: state.objectiveId,
        nodeId: pass.passId,
        outputRefs: this.passOutputRefs(state, pass, {
          summary: cleanSummary,
          handoff: cleanHandoff,
        }),
        completedAt,
      });
      await this.commitPassMemory(agent, pass.phase, cleanSummary, "plan_ready");
      return;
    }

    if (pass.phase === "builder") {
      const checkResults = await this.runChecks(state.checks, pass.workspacePath);
      const failedCheck = checkResults.find((check) => !check.ok);
      if (failedCheck) {
        const reason = `Required check failed: ${failedCheck.command}`;
        await this.emitObjective(state.objectiveId, {
          type: "graph.node.terminal",
          objectiveId: state.objectiveId,
          nodeId: pass.passId,
          status: "blocked",
          reason,
          completedAt,
        });
        await this.emitObjective(state.objectiveId, {
          type: "blocked",
          objectiveId: state.objectiveId,
          phase: pass.phase,
          passId: pass.passId,
          summary: cleanSummary,
          reason,
          completedAt,
        });
        return;
      }
      const status = await this.git.worktreeStatus(pass.workspacePath);
      if (!status.dirty) {
        const reason = "builder pass produced no tracked diff";
        await this.emitObjective(state.objectiveId, {
          type: "graph.node.terminal",
          objectiveId: state.objectiveId,
          nodeId: pass.passId,
          status: "blocked",
          reason,
          completedAt,
        });
        await this.emitObjective(state.objectiveId, {
          type: "blocked",
          objectiveId: state.objectiveId,
          phase: pass.phase,
          passId: pass.passId,
          summary: cleanSummary,
          reason,
          completedAt,
        });
        return;
      }
      const committed = await this.git.commitWorkspace(
        pass.workspacePath,
        `[hub][${state.objectiveId}] ${pass.passNumber}:${pass.phase} ${state.title}`
      );
      await this.emitObjective(state.objectiveId, {
        type: "candidate.ready",
        objectiveId: state.objectiveId,
        passId: pass.passId,
        summary: cleanSummary,
        handoff: cleanHandoff,
        commitHash: committed.hash,
        checkResults,
        completedAt,
      });
      await this.emitObjective(state.objectiveId, {
        type: "graph.node.completed",
        objectiveId: state.objectiveId,
        nodeId: pass.passId,
        outputRefs: this.passOutputRefs(state, pass, {
          summary: cleanSummary,
          handoff: cleanHandoff,
          commitHash: committed.hash,
        }),
        completedAt,
      });
      await this.commitPassMemory(agent, pass.phase, cleanSummary, "candidate_ready");
      return;
    }

    const status = await this.git.worktreeStatus(pass.workspacePath);
    if (status.dirty) {
      throw new HubServiceError(409, "reviewer pass modified tracked files");
    }
    const commitHash = status.head ?? pass.baseCommit;
    if (result.outcome === "approved") {
      await this.emitObjective(state.objectiveId, {
        type: "review.approved",
        objectiveId: state.objectiveId,
        passId: pass.passId,
        summary: cleanSummary,
        handoff: cleanHandoff,
        commitHash,
        completedAt,
      });
      await this.emitObjective(state.objectiveId, {
        type: "graph.node.completed",
        objectiveId: state.objectiveId,
        nodeId: pass.passId,
        outputRefs: this.passOutputRefs(state, pass, {
          summary: cleanSummary,
          handoff: cleanHandoff,
          commitHash,
          decision: "approved",
        }),
        completedAt,
      });
      await this.commitPassMemory(agent, pass.phase, cleanSummary, "approved");
      return;
    }
    await this.emitObjective(state.objectiveId, {
      type: "review.changes_requested",
      objectiveId: state.objectiveId,
      passId: pass.passId,
      summary: cleanSummary,
      handoff: cleanHandoff,
      commitHash,
      completedAt,
    });
    await this.emitObjective(state.objectiveId, {
      type: "graph.node.completed",
      objectiveId: state.objectiveId,
      nodeId: pass.passId,
      outputRefs: this.passOutputRefs(state, pass, {
        summary: cleanSummary,
        handoff: cleanHandoff,
        commitHash,
        decision: "changes_requested",
      }),
      completedAt,
    });
    await this.commitPassMemory(agent, pass.phase, cleanSummary, "changes_requested");
  }

  private async runChecks(commands: ReadonlyArray<string>, workspacePath: string): Promise<ReadonlyArray<ObjectiveCheckResult>> {
    const results: ObjectiveCheckResult[] = [];
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

  private async ensureObjectiveWorkspace(
    hubState: HubState,
    pass: ObjectivePassRecord,
  ): Promise<string> {
    const workspace = hubState.workspaces[pass.workspaceId];
    if (workspace) {
      const status = await this.git.worktreeStatus(workspace.path);
      if (status.exists) return workspace.path;
      const restored = await this.git.restoreWorkspace({
        workspaceId: workspace.workspaceId,
        branchName: workspace.branchName,
        workspacePath: workspace.path,
        baseHash: workspace.baseHash,
      });
      return restored.path;
    }
    const fallback = await this.git.worktreeStatus(pass.workspacePath);
    if (fallback.exists) return pass.workspacePath;
    throw new HubServiceError(409, `objective workspace record is missing for ${pass.passId}`);
  }

  private buildNodeInputRefs(
    state: ObjectiveState,
    baseCommit: string,
    dependsOn: ReadonlyArray<string>,
  ): Readonly<Record<string, GraphRef>> {
    const refs: Record<string, GraphRef> = {
      objective: stateRef(`${objectiveStream(state.objectiveId)}:prompt`, "objective prompt"),
      checks: stateRef(`${objectiveStream(state.objectiveId)}:checks`, "required checks"),
      baseCommit: commitRef(baseCommit, "base commit"),
    };
    for (const [index, nodeId] of dependsOn.entries()) {
      const node = state.graph.nodes[nodeId];
      if (!node) continue;
      refs[`depends_on_${index + 1}`] = stateRef(`${objectiveStream(state.objectiveId)}:graph/${nodeId}`, `${node.kind} node`);
      if (node.outputRefs.summary) refs[`summary_${index + 1}`] = node.outputRefs.summary;
      if (node.outputRefs.handoff) refs[`handoff_${index + 1}`] = node.outputRefs.handoff;
      if (node.outputRefs.commit) refs[`commit_${index + 1}`] = node.outputRefs.commit;
      if (node.outputRefs.decision) refs[`decision_${index + 1}`] = node.outputRefs.decision;
      refs[`workspace_${index + 1}`] = workspaceRef(node.workspacePath, `${node.kind} workspace`);
    }
    return refs;
  }

  private passOutputRefs(
    state: ObjectiveState,
    pass: ObjectivePassRecord,
    result: {
      readonly summary: string;
      readonly handoff: string;
      readonly commitHash?: string;
      readonly decision?: string;
    },
  ): Readonly<Record<string, GraphRef>> {
    const refs: Record<string, GraphRef> = {
      summary: stateRef(`${objectiveStream(state.objectiveId)}:passes/${pass.passId}/summary`, `${pass.phase} summary`),
      handoff: stateRef(`${objectiveStream(state.objectiveId)}:passes/${pass.passId}/handoff`, `${pass.phase} handoff`),
      workspace: workspaceRef(pass.workspacePath, `${pass.phase} workspace`),
    };
    if (pass.promptPath) refs.prompt = fileRef(pass.promptPath, `${pass.phase} prompt`);
    if (pass.resultPath) refs.result = fileRef(pass.resultPath, `${pass.phase} result`);
    if (pass.stdoutPath) refs.stdout = fileRef(pass.stdoutPath, `${pass.phase} stdout`);
    if (pass.stderrPath) refs.stderr = fileRef(pass.stderrPath, `${pass.phase} stderr`);
    if (pass.lastMessagePath) refs.lastMessage = fileRef(pass.lastMessagePath, `${pass.phase} last message`);
    if (result.commitHash) refs.commit = commitRef(result.commitHash, `${pass.phase} commit`);
    if (result.decision) refs.decision = stateRef(
      `${objectiveStream(state.objectiveId)}:passes/${pass.passId}/decision`,
      `${pass.phase} decision`,
    );
    return refs;
  }

  private parseObjectivePassPayload(payload: Record<string, unknown>): HubObjectivePassJobPayload {
    if (payload.kind !== "hub.objective.pass") throw new HubServiceError(400, "invalid objective job payload");
    return {
      kind: "hub.objective.pass",
      objectiveId: requireNonEmpty(payload.objectiveId, "objectiveId required"),
      passId: requireNonEmpty(payload.passId, "passId required"),
      nodeId: requireNonEmpty(payload.nodeId, "nodeId required"),
      phase: requireNonEmpty(payload.phase, "phase required") as ObjectivePhase,
      passNumber: asPositiveInt(payload.passNumber) ?? 1,
      agentId: requireNonEmpty(payload.agentId, "agentId required"),
      baseCommit: requireNonEmpty(payload.baseCommit, "baseCommit required"),
      workspaceId: requireNonEmpty(payload.workspaceId, "workspaceId required"),
      workspacePath: requireNonEmpty(payload.workspacePath, "workspacePath required"),
      inputRefs: isRecord(payload.inputRefs) ? payload.inputRefs as Readonly<Record<string, GraphRef>> : {},
      promptPath: requireNonEmpty(payload.promptPath, "promptPath required"),
      resultPath: requireNonEmpty(payload.resultPath, "resultPath required"),
      stdoutPath: requireNonEmpty(payload.stdoutPath, "stdoutPath required"),
      stderrPath: requireNonEmpty(payload.stderrPath, "stderrPath required"),
      lastMessagePath: requireNonEmpty(payload.lastMessagePath, "lastMessagePath required"),
    };
  }

  private async writePassFiles(
    state: ObjectiveState,
    pass: ObjectivePassRecord,
    agent: AgentProfile,
    inputRefs: Readonly<Record<string, GraphRef>>,
  ): Promise<{
    readonly promptPath: string;
    readonly resultPath: string;
    readonly stdoutPath: string;
    readonly stderrPath: string;
    readonly lastMessagePath: string;
    readonly renderedPrompt: string;
  }> {
    const files = this.passFilePaths(pass.workspacePath, pass.phase, pass.passNumber);
    await fs.mkdir(path.dirname(files.promptPath), { recursive: true });
    const previousPass = state.passOrder
      .map((passId) => state.passes[passId])
      .filter((item) => item.passId !== pass.passId)
      .at(-1);
    const objectiveDoc = [
      `# ${state.title}`,
      "",
      `Objective ID: ${state.objectiveId}`,
      `Phase: ${pass.phase}`,
      `Base commit: ${pass.baseCommit}`,
      `Checks: ${state.checks.join(" | ")}`,
      "",
      "## Prompt",
      state.prompt,
    ].join("\n");
    const sharedContext = state.passOrder
      .map((passId) => state.passes[passId])
      .filter((item) => item.passId !== pass.passId)
      .map((item) => [
        `### ${item.phase} pass ${item.passNumber}`,
        item.summary ? `Summary: ${item.summary}` : "",
        item.handoff ? `Handoff: ${item.handoff}` : "",
        item.commitHash ? `Commit: ${item.commitHash}` : "",
        item.outcome ? `Outcome: ${item.outcome}` : "",
      ].filter(Boolean).join("\n"))
      .join("\n\n");
    const memorySummary = await this.loadMemorySummary(agent, state.prompt);
    await fs.writeFile(files.objectivePath, objectiveDoc, "utf-8");
    await fs.writeFile(files.handoffPath, previousPass?.handoff ?? "No prior handoff.", "utf-8");
    await fs.writeFile(files.passMetaPath, JSON.stringify({
      objectiveId: state.objectiveId,
      title: state.title,
      phase: pass.phase,
      passNumber: pass.passNumber,
      agentId: agent.agentId,
      workspaceId: pass.workspaceId,
      baseCommit: pass.baseCommit,
      nodeId: pass.passId,
      inputRefs,
      checks: state.checks,
    }, null, 2), "utf-8");
    await fs.rm(files.resultPath, { force: true });
    const template = await this.loadPhaseTemplate(pass.phase);
    const renderedPrompt = renderTemplate(template, {
      agent_id: agent.agentId,
      title: state.title,
      objective_id: state.objectiveId,
      phase: pass.phase,
      prompt: state.prompt,
      checks: state.checks.map((item) => `- ${item}`).join("\n"),
      base_commit: pass.baseCommit,
      latest_commit: state.latestCommitHash ?? pass.baseCommit,
      latest_summary: state.latestSummary ?? "None.",
      prior_handoff: previousPass?.handoff ?? "None.",
      shared_context: sharedContext || "No prior objective history.",
      private_memory: memorySummary || "No private memory summary available.",
      objective_path: files.objectivePath,
      handoff_path: files.handoffPath,
      result_path: files.resultPath,
      pass_meta_path: files.passMetaPath,
    });
    await fs.writeFile(files.promptPath, renderedPrompt, "utf-8");
    return {
      promptPath: files.promptPath,
      resultPath: files.resultPath,
      stdoutPath: files.stdoutPath,
      stderrPath: files.stderrPath,
      lastMessagePath: files.lastMessagePath,
      renderedPrompt,
    };
  }

  private async ensureWorkspaceReceiptCli(workspacePath: string): Promise<string> {
    const binDir = path.join(workspacePath, ".receipt", "bin");
    const shimPath = path.join(binDir, process.platform === "win32" ? "receipt.cmd" : "receipt");
    const runtimeRoot = process.cwd();
    const cliPath = path.join(runtimeRoot, "src", "cli.ts");
    const tsxLoaderPath = path.join(runtimeRoot, "node_modules", "tsx", "dist", "loader.mjs");
    await fs.mkdir(binDir, { recursive: true });
    const body = process.platform === "win32"
      ? [
          "@echo off",
          `set "DATA_DIR=${this.dataDir}"`,
          `node --import "${tsxLoaderPath}" "${cliPath}" %*`,
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `export DATA_DIR=${shellQuote(this.dataDir)}`,
          `exec node --import ${shellQuote(tsxLoaderPath)} ${shellQuote(cliPath)} "$@"`,
          "",
        ].join("\n");
    await fs.writeFile(shimPath, body, "utf-8");
    if (process.platform !== "win32") {
      await fs.chmod(shimPath, 0o755);
    }
    return binDir;
  }

  private passFilePaths(workspacePath: string, phase: ObjectivePhase, passNumber: number) {
    const root = path.join(workspacePath, ".receipt", "hub");
    const stem = `${phase}-${String(passNumber).padStart(2, "0")}`;
    return {
      objectivePath: path.join(root, "objective.md"),
      handoffPath: path.join(root, "handoff.md"),
      passMetaPath: path.join(root, "pass.json"),
      promptPath: path.join(root, `${stem}.prompt.md`),
      resultPath: path.join(root, "result.json"),
      stdoutPath: path.join(root, `${stem}.stdout.log`),
      stderrPath: path.join(root, `${stem}.stderr.log`),
      lastMessagePath: path.join(root, `${stem}.last-message.md`),
    };
  }

  private async loadPhaseTemplate(phase: ObjectivePhase): Promise<string> {
    const file = path.join(this.promptDir, `${phase}.md`);
    return fs.readFile(file, "utf-8");
  }

  private parsePassResult(raw: string, phase: ObjectivePhase): ParsedPassResult {
    if (!raw.trim()) throw new HubServiceError(500, "missing result.json from codex pass");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new HubServiceError(500, `malformed result.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HubServiceError(500, "result.json must be an object");
    }
    const outcome = requireNonEmpty((parsed as Record<string, unknown>).outcome, "result outcome required") as ObjectivePassOutcome;
    if (!OBJECTIVE_RESULT_OUTCOMES[phase].includes(outcome)) {
      throw new HubServiceError(500, `invalid ${phase} outcome '${outcome}'`);
    }
    return {
      outcome,
      summary: requireNonEmpty((parsed as Record<string, unknown>).summary, "result summary required"),
      handoff: requireNonEmpty((parsed as Record<string, unknown>).handoff, "result handoff required"),
    };
  }

  private async loadMemorySummary(agent: AgentProfile, query: string): Promise<string> {
    if (!this.memoryTools) return "";
    try {
      const { summary } = await this.memoryTools.summarize({
        scope: agent.memoryScope,
        query,
        limit: 8,
        maxChars: 1_200,
      });
      return summary;
    } catch {
      return "";
    }
  }

  private async commitPassMemory(
    agent: AgentProfile,
    phase: ObjectivePhase,
    summary: string,
    outcome: ObjectivePassOutcome | "blocked",
  ): Promise<void> {
    if (!this.memoryTools) return;
    try {
      await this.memoryTools.commit({
        scope: agent.memoryScope,
        text: `[${phase}] ${summary}`,
        tags: ["hub", phase, outcome],
        meta: {
          outcome,
        },
      });
    } catch {
      // Memory is auxiliary for the hub objective flow.
    }
  }

  private async recoverObjectiveSummaries(): Promise<void> {
    const hubState = await this.hubRuntime.state(HUB_STREAM);
    const manifestPath = path.join(this.dataDir, "_streams.json");
    const raw = await fs.readFile(manifestPath, "utf-8").catch(() => "");
    if (!raw.trim()) return;
    let manifest: { readonly byStream?: Record<string, string> };
    try {
      manifest = JSON.parse(raw) as { readonly byStream?: Record<string, string> };
    } catch {
      return;
    }
    const streams = Object.keys(manifest.byStream ?? {})
      .filter((stream) => stream.startsWith(`${OBJECTIVE_STREAM_PREFIX}/`));
    for (const stream of streams) {
      const objectiveId = stream.slice(`${OBJECTIVE_STREAM_PREFIX}/`.length);
      if (hubState.objectives[objectiveId]) continue;
      const state = await this.objectiveRuntime.state(stream);
      if (!state.objectiveId) continue;
      await this.syncObjectiveSummary(state);
    }
  }

  private async emitHub(event: HubEvent): Promise<void> {
    await this.hubRuntime.execute(HUB_STREAM, {
      type: "emit",
      eventId: makeEventId(HUB_STREAM),
      event,
    });
    this.sse.publish("receipt");
  }

  private async emitObjective(objectiveId: string, event: ObjectiveEvent): Promise<void> {
    const stream = objectiveStream(objectiveId);
    await this.objectiveRuntime.execute(stream, {
      type: "emit",
      eventId: makeEventId(stream),
      event,
    });
    const state = await this.objectiveRuntime.state(stream);
    if (state.objectiveId) {
      await this.syncObjectiveSummary(state);
    }
    this.sse.publish("receipt");
  }

  private async syncObjectiveSummary(state: ObjectiveState): Promise<void> {
    const objective = this.toObjectiveSummary(state);
    await this.emitHub({
      type: "objective.synced",
      objective,
    });
  }

  private async cleanupObjectiveWorkspaces(state: ObjectiveState): Promise<void> {
    const hubState = await this.hubRuntime.state(HUB_STREAM);
    const seen = new Set<string>();
    for (const passId of state.passOrder) {
      const pass = state.passes[passId];
      const workspaceId = pass?.workspaceId;
      if (!workspaceId || seen.has(workspaceId)) continue;
      seen.add(workspaceId);
      const workspace = hubState.workspaces[workspaceId];
      if (!workspace || workspace.removedAt) continue;
      try {
        await this.git.removeWorkspace(workspace.path);
        await this.emitHub({
          type: "workspace.removed",
          workspaceId,
          removedAt: Date.now(),
        });
      } catch (err) {
        console.warn(`hub workspace cleanup failed for ${workspaceId}`, err);
      }
    }
  }

  private async buildObjectiveDetail(state: ObjectiveState): Promise<ObjectiveDetail> {
    const passViews = await Promise.all(
      state.passOrder.map(async (passId) => {
        const pass = state.passes[passId];
        const job = await this.loadFreshJob(pass.jobId);
        const workspaceStatus = await this.git.worktreeStatus(pass.workspacePath);
        return {
          ...pass,
          jobStatus: job?.status ?? "missing",
          job,
          workspaceExists: workspaceStatus.exists,
          workspaceDirty: workspaceStatus.dirty,
          workspaceHead: workspaceStatus.head,
          activity: this.describePassActivity(pass, job),
          elapsedMs: this.passElapsedMs(pass, job),
        } satisfies ObjectivePassView;
      })
    );
    const latestPlan = [...passViews]
      .reverse()
      .find((pass) => pass.phase === "planner" && pass.outcome === "plan_ready");
    const latestBuild = [...passViews]
      .reverse()
      .find((pass) => pass.phase === "builder" && pass.outcome === "candidate_ready");
    const latestReview = [...passViews]
      .reverse()
      .find((pass) => pass.phase === "reviewer" && (pass.outcome === "approved" || pass.outcome === "changes_requested"));
    const activePass = passViews.find((pass) => pass.passId === state.currentPassId && pass.status === "queued");
    const activeJob = activePass?.job;
    const card = this.objectiveToCard(this.toObjectiveSummary(state), activeJob);
    return {
      ...card,
      prompt: state.prompt,
      channel: state.channel,
      baseHash: state.baseHash,
      checks: state.checks,
      createdAt: state.createdAt,
      passes: passViews,
      latestCheckResults: state.latestCheckResults,
      latestPlanSummary: latestPlan?.summary,
      latestPlanHandoff: latestPlan?.handoff,
      latestBuildSummary: latestBuild?.summary,
      latestBuildHandoff: latestBuild?.handoff,
      latestReviewOutcome: latestReview?.outcome === "approved" || latestReview?.outcome === "changes_requested"
        ? latestReview.outcome
        : undefined,
      latestReviewSummary: latestReview?.summary,
      latestReviewHandoff: latestReview?.handoff,
      nextHandoff: this.nextHandoffForState(state, {
        planner: latestPlan,
        builder: latestBuild,
        reviewer: latestReview,
      }),
      activePass,
      graph: this.buildObjectiveGraphProjection(state),
    };
  }

  private buildObjectiveGraphProjection(state: ObjectiveState): ObjectiveGraphProjection {
    return {
      graphId: state.graph.graphId,
      status: state.graph.status,
      currentNodeId: state.graph.currentNodeId,
      readyNodeIds: graphProjection(state.graph).ready.map((node) => node.nodeId),
      nodeOrder: state.graph.order,
      nodes: state.graph.order
        .map((nodeId) => state.graph.nodes[nodeId])
        .filter((node): node is ObjectiveGraphNodeRecord => Boolean(node)),
    };
  }

  private toObjectiveSummary(state: ObjectiveState): HubObjectiveSummary {
    const currentPass = state.currentPassId ? state.passes[state.currentPassId] : undefined;
    const latestPlan = this.latestStageSnapshot(state, "planner", ["plan_ready"]);
    const latestBuild = this.latestStageSnapshot(state, "builder", ["candidate_ready"]);
    const latestReview = this.latestStageSnapshot(state, "reviewer", ["approved", "changes_requested"]);
    return {
      objectiveId: state.objectiveId,
      title: state.title,
      prompt: state.prompt,
      channel: state.channel,
      baseHash: state.baseHash,
      checks: state.checks,
      status: state.status,
      lane: state.lane,
      currentPhase: state.currentPhase,
      assignedAgentId: state.assignedAgentId,
      latestCommitHash: state.latestCommitHash,
      latestSummary: state.latestSummary,
      blockedReason: state.blockedReason,
      approvalState: state.approvalState,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      currentPassId: currentPass?.passId,
      currentJobId: currentPass?.jobId,
      currentPassPhase: currentPass?.phase,
      currentPassStatus: currentPass?.status,
      currentPassDispatchedAt: currentPass?.dispatchedAt,
      latestPlanSummary: latestPlan?.summary,
      latestPlanHandoff: latestPlan?.handoff,
      latestBuildSummary: latestBuild?.summary,
      latestBuildHandoff: latestBuild?.handoff,
      latestReviewSummary: latestReview?.summary,
      latestReviewHandoff: latestReview?.handoff,
    };
  }

  private objectiveToCard(objective: HubObjectiveSummary, job?: JobRecord): HubObjectiveCard {
    const activeJob = objective.currentPassStatus === "queued" ? job : undefined;
    const derived = this.deriveObjectiveDisplay(objective, job);
    return {
      objectiveId: objective.objectiveId,
      title: objective.title,
      status: derived.status,
      lane: derived.lane,
      currentPhase: objective.currentPhase,
      assignedAgentId: objective.assignedAgentId,
      latestSummary: derived.latestSummary,
      latestCommitHash: objective.latestCommitHash,
      blockedReason: derived.blockedReason,
      approvalState: objective.approvalState,
      updatedAt: objective.updatedAt,
      activeJobStatus: activeJob?.status ?? (objective.currentPassStatus === "queued" && objective.currentJobId ? "missing" : undefined),
      activeElapsedMs: this.passElapsedMs(
        objective.currentPassStatus === "queued" && objective.currentPassDispatchedAt
          ? { dispatchedAt: objective.currentPassDispatchedAt }
          : undefined,
        activeJob,
      ),
      liveActivity: activeJob?.status === "queued" || activeJob?.status === "leased" || activeJob?.status === "running"
        ? `${objective.currentPhase ?? "pass"} pass is active in Codex.`
        : undefined,
    };
  }

  private async readPassLiveData(
    pass: ObjectivePassRecord,
    job?: JobRecord,
  ): Promise<Pick<ObjectivePassView, "stdoutTail" | "stderrTail" | "lastMessage" | "activity" | "elapsedMs">> {
    const [stdoutTail, stderrTail, lastMessage] = await Promise.all([
      this.readTextTail(pass.stdoutPath, 900),
      this.readTextTail(pass.stderrPath, 600),
      this.readTextTail(pass.lastMessagePath, 400),
    ]);
    const jobStatus = job?.status;
    const activity = clipText(
      jobStatus === "failed"
        ? stderrTail || stdoutTail || lastMessage || pass.error
        : stdoutTail || lastMessage || stderrTail || pass.summary,
      240,
    );
    return {
      stdoutTail,
      stderrTail,
      lastMessage,
      activity,
      elapsedMs: this.passElapsedMs(pass, job),
    };
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

  private deriveObjectiveDisplay(
    objective: Pick<
      HubObjectiveSummary,
      | "status"
      | "lane"
      | "latestSummary"
      | "blockedReason"
      | "currentJobId"
      | "currentPassPhase"
      | "currentPassStatus"
      | "latestPlanSummary"
      | "latestPlanHandoff"
      | "latestBuildSummary"
      | "latestBuildHandoff"
      | "latestReviewSummary"
      | "latestReviewHandoff"
    >,
    job: JobRecord | undefined,
  ): Pick<HubObjectiveCard, "status" | "lane" | "latestSummary" | "blockedReason"> {
    const base = {
      status: objective.status,
      lane: objective.lane || objectiveLaneForStatus(objective.status),
      latestSummary: this.objectiveCardSummary(objective),
      blockedReason: objective.blockedReason,
    } satisfies Pick<HubObjectiveCard, "status" | "lane" | "latestSummary" | "blockedReason">;

    if (!objective.currentJobId || objective.currentPassStatus !== "queued" || !job) return base;
    if (job.status === "failed" || job.status === "canceled") {
      const reason = job.lastError ?? job.canceledReason ?? "objective pass failed";
      return {
        status: "blocked",
        lane: "blocked",
        latestSummary: clipText(reason, 240) ?? "Objective pass failed.",
        blockedReason: reason,
      };
    }
    if (job.status === "completed") {
      return {
        status: "blocked",
        lane: "blocked",
        latestSummary: "Objective pass completed without recording a durable outcome.",
        blockedReason: "objective pass completed without durable outcome",
      };
    }
    return base;
  }

  private latestStageSnapshot(
    state: ObjectiveState,
    phase: ObjectivePhase,
    outcomes?: ReadonlyArray<ObjectivePassOutcome>,
  ): ObjectiveStageSnapshot | undefined {
    for (let index = state.passOrder.length - 1; index >= 0; index -= 1) {
      const pass = state.passes[state.passOrder[index] ?? ""];
      if (!pass || pass.phase !== phase) continue;
      if (outcomes && (!pass.outcome || !outcomes.includes(pass.outcome))) continue;
      return {
        summary: pass.summary,
        handoff: pass.handoff,
        outcome: pass.outcome,
        commitHash: pass.commitHash,
      };
    }
    return undefined;
  }

  private nextHandoffForState(
    state: ObjectiveState,
    stages: {
      readonly planner?: Pick<ObjectivePassRecord, "handoff">;
      readonly builder?: Pick<ObjectivePassRecord, "handoff">;
      readonly reviewer?: Pick<ObjectivePassRecord, "handoff">;
    },
  ): string | undefined {
    if (state.status === "planning") {
      return "Planner is gathering repo context and preparing the builder handoff.";
    }
    if (state.status === "building") {
      return stages.planner?.handoff ?? stages.builder?.handoff;
    }
    if (state.status === "reviewing") {
      return stages.builder?.handoff ?? stages.reviewer?.handoff;
    }
    if (state.status === "awaiting_confirmation") {
      return stages.reviewer?.handoff ?? "Merge the approved candidate into the target branch.";
    }
    if (state.status === "completed") {
      return "Merged into the target branch. Objective closed.";
    }
    if (state.status === "blocked" || state.status === "failed") {
      return state.blockedReason ?? stages.reviewer?.handoff ?? stages.builder?.handoff ?? stages.planner?.handoff;
    }
    if (state.status === "canceled") {
      return "Objective canceled.";
    }
    return undefined;
  }

  private objectiveCardSummary(
    objective: Pick<
      HubObjectiveSummary,
      | "status"
      | "latestSummary"
      | "blockedReason"
      | "currentPassPhase"
      | "currentPassStatus"
      | "latestPlanSummary"
      | "latestPlanHandoff"
      | "latestBuildSummary"
      | "latestBuildHandoff"
      | "latestReviewSummary"
      | "latestReviewHandoff"
    >,
  ): string | undefined {
    if (objective.status === "building" && objective.currentPassStatus === "queued" && objective.currentPassPhase === "builder") {
      return objective.latestSummary
        ?? objective.latestPlanHandoff
        ?? objective.latestPlanSummary;
    }
    if (objective.status === "awaiting_confirmation" || objective.status === "completed") {
      return objective.latestBuildSummary
        ?? objective.latestReviewSummary
        ?? objective.latestSummary;
    }
    if (objective.status === "reviewing") {
      return objective.latestBuildHandoff
        ?? objective.latestBuildSummary
        ?? objective.latestSummary;
    }
    if (objective.status === "building") {
      return objective.latestPlanHandoff
        ?? objective.latestPlanSummary
        ?? objective.latestSummary;
    }
    if (objective.status === "planning") {
      return objective.latestPlanSummary ?? objective.latestSummary;
    }
    if (objective.status === "blocked" || objective.status === "failed") {
      return objective.blockedReason
        ?? objective.latestReviewHandoff
        ?? objective.latestBuildHandoff
        ?? objective.latestPlanHandoff
        ?? objective.latestSummary;
    }
    return objective.latestSummary;
  }

  private describePassActivity(pass: ObjectivePassRecord, job?: JobRecord): string | undefined {
    if (!job) {
      return clipText(pass.error ?? pass.summary, 240);
    }
    if (job.status === "failed") {
      return clipText(job.lastError ?? pass.error ?? pass.summary, 240);
    }
    if (job.status === "canceled") {
      return clipText(job.canceledReason ?? pass.error ?? pass.summary, 240);
    }
    if (job.status === "queued" || job.status === "leased" || job.status === "running") {
      return clipText(`${pass.phase} pass is active in Codex.`, 240);
    }
    return clipText(pass.summary ?? pass.error ?? job.lastError, 240);
  }

  private passElapsedMs(
    pass: Pick<ObjectivePassRecord, "dispatchedAt"> | undefined,
    job: Pick<JobRecord, "status"> | undefined,
  ): number | undefined {
    const jobStatus = job?.status;
    if (!pass) return undefined;
    if (jobStatus === "queued" || jobStatus === "leased" || jobStatus === "running") {
      return Math.max(0, Date.now() - pass.dispatchedAt);
    }
    return undefined;
  }

  private resolveSelectedObjectiveId(state: HubState, preferredId?: string): string | undefined {
    if (preferredId && state.objectives[preferredId]) return preferredId;
    return Object.values(state.objectives)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((objective) => objective.objectiveId)
      .at(0);
  }

  private async refreshMirrorForExplorer(): Promise<void> {
    const source = await this.git.sourceStatus();
    const branch = source.branch ?? await this.git.defaultBranch();
    const mirrorHead = await this.git.mirrorHead(branch);
    if (!source.head || source.head === mirrorHead) return;
    await this.git.syncFromSource();
  }

  private resolvePhaseAgent(state: HubState, phase: ObjectivePhase): AgentProfile {
    const preferred = state.agents[OBJECTIVE_AGENT_BY_PHASE[phase]];
    if (preferred) return preferred;
    const prefix = `${phase}`.toLowerCase();
    const matched = Object.values(state.agents)
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .find((agent) => agent.agentId.toLowerCase().startsWith(prefix));
    if (matched) return matched;
    throw new HubServiceError(409, `no agent profile available for ${phase}`);
  }

  private async requireObjectiveState(objectiveId: string): Promise<ObjectiveState> {
    const state = await this.objectiveRuntime.state(objectiveStream(objectiveId));
    if (!state.objectiveId) throw new HubServiceError(404, "objective not found");
    return state;
  }

  private async loadFreshJob(jobId: string): Promise<JobRecord | undefined> {
    const state = await this.jobRuntime.state(`jobs/${jobId}`) as JobState;
    return state.jobs[jobId];
  }

  private requireAgent(state: HubState, agentId: string): AgentProfile {
    const agent = state.agents[agentId];
    if (!agent) throw new HubServiceError(404, "agent not found");
    return agent;
  }

  private requireChannel(state: HubState, name: string): HubChannel {
    const channel = state.channels[name];
    if (!channel) throw new HubServiceError(404, "channel not found");
    return channel;
  }

  private requireWorkspaceRecord(state: HubState, workspaceId: string): WorkspaceRecord {
    const workspace = state.workspaces[workspaceId];
    if (!workspace) throw new HubServiceError(404, "workspace not found");
    return workspace;
  }

  private async requireActiveWorkspace(state: HubState, workspaceId: string): Promise<WorkspaceView> {
    const workspace = this.requireWorkspaceRecord(state, workspaceId);
    if (workspace.removedAt) throw new HubServiceError(409, "workspace has been removed");
    const status = await this.git.worktreeStatus(workspace.path);
    if (!status.exists) throw new HubServiceError(409, "workspace path is missing");
    return {
      ...workspace,
      exists: status.exists,
      dirty: status.dirty,
      head: status.head,
      branch: status.branch,
    };
  }

  private async requireCleanWorkspace(state: HubState, workspaceId: string): Promise<WorkspaceView> {
    const workspace = await this.requireActiveWorkspace(state, workspaceId);
    if (!workspace.head) throw new HubServiceError(409, "workspace has no HEAD commit");
    if (workspace.dirty) throw new HubServiceError(409, "workspace is dirty");
    return workspace;
  }

  private makeId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  private readonly commitToView = (commit: HubGitCommit): HubCommitView => ({
    hash: commit.hash,
    subject: commit.subject,
    author: commit.author,
    ts: commit.ts,
    parents: commit.parents,
  });
}
