import fs from "node:fs/promises";

import { jsonBranchStore, jsonlStore } from "../adapters/jsonl.js";
import type { JsonlQueue } from "../adapters/jsonl-queue.js";
import type { CodexExecutor } from "../adapters/codex-executor.js";
import { HubGit, type HubGitCommit } from "../adapters/hub-git.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import { createRuntime, type Runtime } from "../core/runtime.js";
import { makeEventId, optionalTrimmedString, requireTrimmedString, trimmedString } from "../framework/http.js";
import type { SseHub } from "../framework/sse-hub.js";
import type { JobCmd, JobEvent, JobRecord, JobState } from "../modules/job.js";
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
  type HubState,
  type HubTask,
  type WorkspaceRecord,
} from "../modules/hub.js";

const HUB_STREAM = "hub/meta";
const DEFAULT_CHANNELS = ["general", "results", "failures"] as const;
const DEFAULT_ROLE_AGENTS = [
  { agentId: "planner-1", displayName: "Planner 1", memoryScope: "hub/agents/planner-1" },
  { agentId: "builder-1", displayName: "Builder 1", memoryScope: "hub/agents/builder-1" },
  { agentId: "reviewer-1", displayName: "Reviewer 1", memoryScope: "hub/agents/reviewer-1" },
] as const satisfies ReadonlyArray<Pick<AgentProfile, "agentId" | "displayName" | "memoryScope">>;
const DEFAULT_MAX_ITERATIONS = 10;
const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

const sortedValues = <T extends { readonly createdAt: number }>(record: Readonly<Record<string, T>>): T[] =>
  Object.values(record).sort((a, b) => b.createdAt - a.createdAt);

const shortHash = (value: string | undefined): string => value ? value.slice(0, 8) : "none";
const requireNonEmpty = (value: unknown, message: string): string => {
  try {
    return requireTrimmedString(value, message);
  } catch {
    throw new HubServiceError(400, message);
  }
};
const asPositiveInt = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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
  readonly agentIds: ReadonlyArray<string>;
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

type HubServiceOptions = {
  readonly dataDir: string;
  readonly queue: JsonlQueue;
  readonly jobRuntime: Runtime<JobCmd, JobEvent, JobState>;
  readonly sse: SseHub;
  readonly codexExecutor: CodexExecutor;
  readonly memoryTools?: MemoryTools;
  readonly repoRoot?: string;
};

export class HubService {
  readonly dataDir: string;
  readonly git: HubGit;

  private readonly queue: JsonlQueue;
  private readonly jobRuntime: Runtime<JobCmd, JobEvent, JobState>;
  private readonly hubRuntime: Runtime<HubCmd, HubEvent, HubState>;
  private bootstrapPromise: Promise<void> | undefined;

  constructor(opts: HubServiceOptions) {
    this.dataDir = opts.dataDir;
    this.queue = opts.queue;
    this.jobRuntime = opts.jobRuntime;
    this.hubRuntime = createRuntime<HubCmd, HubEvent, HubState>(
      jsonlStore<HubEvent>(this.dataDir),
      jsonBranchStore(this.dataDir),
      decideHub,
      reduceHub,
      initialHub,
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
      displayName: optionalTrimmedString(body.displayName) ?? agentId,
      memoryScope: optionalTrimmedString(body.memoryScope) ?? `hub/agents/${agentId}`,
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
    const channelName = forcedChannel ?? optionalTrimmedString(body.channel) ?? parent?.channel;
    if (!channelName) throw new HubServiceError(400, "channel required");
    this.requireChannel(state, channelName);
    const post: BoardPost = {
      postId: this.makeId("post"),
      channel: channelName,
      agentId,
      parentId,
      content: requireNonEmpty(body.content, "content required"),
      commitHash: optionalTrimmedString(body.commitHash),
      workspaceId: optionalTrimmedString(body.workspaceId),
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
    const workspaceId = optionalTrimmedString(body.workspaceId) ?? this.makeId("ws");
    if (!AGENT_ID_RE.test(workspaceId)) throw new HubServiceError(400, "invalid workspaceId");
    const existing = state.workspaces[workspaceId];
    if (existing && !existing.removedAt) throw new HubServiceError(409, "workspace already exists");
    const created = await this.git.createWorkspace({
      workspaceId,
      agentId,
      baseHash: optionalTrimmedString(body.baseHash),
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
        }),
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
    const channel = optionalTrimmedString(body.channel) ?? "results";
    this.requireChannel(state, channel);
    const content = optionalTrimmedString(body.content) ?? `Announced ${shortHash(workspace.head ?? workspace.baseHash)} from ${workspace.workspaceId}.`;
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
      agentIds: Object.values(hubState.agents)
        .sort((a, b) => a.agentId.localeCompare(b.agentId))
        .map((agent) => agent.agentId),
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

  async buildStatePayload(selectedHash?: string): Promise<Record<string, unknown>> {
    const [repo, debug, commits, agents, channels] = await Promise.all([
      this.buildRepoProjection(),
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
    };
  }

  private async emitHub(event: HubEvent): Promise<void> {
    await this.hubRuntime.execute(HUB_STREAM, {
      type: "emit",
      eventId: makeEventId(HUB_STREAM),
      event,
    });
  }

  private async loadFreshJob(jobId: string): Promise<JobRecord | undefined> {
    const state = await this.jobRuntime.state(`jobs/${jobId}`) as JobState;
    return state.jobs[jobId];
  }

  private async refreshMirrorForExplorer(): Promise<void> {
    const source = await this.git.sourceStatus();
    const branch = source.branch ?? await this.git.defaultBranch();
    const mirrorHead = await this.git.mirrorHead(branch);
    if (!source.head || source.head === mirrorHead) return;
    await this.git.syncFromSource();
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
