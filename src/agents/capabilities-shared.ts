import { z, type ZodTypeAny } from "zod";

import type { AgentEvent } from "../modules/agent";

export type AgentToolResult = {
  readonly output: string;
  readonly summary: string;
  readonly pauseBudget?: boolean;
  readonly events?: ReadonlyArray<AgentEvent>;
  readonly reports?: ReadonlyArray<Omit<Extract<AgentEvent, { type: "validation.report" }>, "type" | "runId" | "iteration" | "agentId">>;
};

export type AgentToolExecutor<Input extends Record<string, unknown> = Record<string, unknown>> = (
  input: Input,
) => Promise<AgentToolResult>;

export type AgentCapabilityDefinition<Schema extends ZodTypeAny = ZodTypeAny> = {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly tags?: ReadonlyArray<string>;
};

export type AgentCapabilityContext = {
  readonly registry: AgentCapabilityRegistry;
};

export type AgentCapabilitySpec = {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: ZodTypeAny;
  readonly tags?: ReadonlyArray<string>;
  readonly execute: (
    input: Record<string, unknown>,
    context: AgentCapabilityContext,
  ) => Promise<AgentToolResult>;
  readonly isAvailable?: () => boolean;
};

export const capabilityInput = {
  empty: z.object({}).passthrough(),
  listDir: z.object({
    path: z.string().optional(),
  }).passthrough(),
  readFile: z.object({
    path: z.string(),
    startLine: z.number().finite().optional(),
    endLine: z.number().finite().optional(),
    start: z.number().finite().optional(),
    end: z.number().finite().optional(),
    maxChars: z.number().finite().optional(),
  }).passthrough(),
  replaceFile: z.object({
    path: z.string(),
    find: z.string(),
    replace: z.string(),
    all: z.boolean().optional(),
  }).passthrough(),
  writeFile: z.object({
    path: z.string(),
    content: z.string(),
    append: z.boolean().optional(),
  }).passthrough(),
  bash: z.object({
    cmd: z.string(),
    timeoutMs: z.number().finite().optional(),
  }).passthrough(),
  grep: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    maxMatches: z.number().finite().optional(),
  }).passthrough(),
  memoryRead: z.object({
    scope: z.string().optional(),
    limit: z.number().finite().optional(),
  }).passthrough(),
  memorySearch: z.object({
    scope: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().finite().optional(),
  }).passthrough(),
  memorySummarize: z.object({
    scope: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().finite().optional(),
    maxChars: z.number().finite().optional(),
  }).passthrough(),
  memoryCommit: z.object({
    scope: z.string().optional(),
    text: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }).passthrough(),
  memoryDiff: z.object({
    scope: z.string().optional(),
    fromTs: z.number().finite().optional(),
    toTs: z.number().finite().optional(),
  }).passthrough(),
  skillRead: z.object({
    name: z.string().optional(),
  }).passthrough(),
  agentDelegate: z.object({
    agentId: z.string().optional(),
    task: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    timeoutMs: z.number().finite().optional(),
  }).passthrough(),
  agentStatus: z.object({
    jobId: z.string().optional(),
  }).passthrough(),
  agentInspect: z.object({
    file: z.string().optional(),
    maxChars: z.number().finite().optional(),
  }).passthrough(),
  jobsList: z.object({
    limit: z.number().finite().optional(),
    status: z.string().optional(),
    includeCompleted: z.boolean().optional(),
  }).passthrough(),
  repoStatus: z.object({}).passthrough(),
  codexLogs: z.object({
    jobId: z.string().optional(),
  }).passthrough(),
  codexStatus: z.object({
    jobId: z.string().optional(),
    limit: z.number().finite().optional(),
    includeCompleted: z.boolean().optional(),
    waitForChangeMs: z.number().finite().optional(),
  }).passthrough(),
  codexRun: z.object({
    prompt: z.string().optional(),
    task: z.string().optional(),
    timeoutMs: z.number().finite().optional(),
  }).passthrough(),
  profileHandoff: z.object({
    profileId: z.string().optional(),
    reason: z.string().optional(),
    objectiveId: z.string().optional(),
    chatId: z.string().optional(),
  }).passthrough(),
  jobControl: z.object({
    jobId: z.string().optional(),
    command: z.literal("abort").optional(),
    reason: z.string().optional(),
  }).passthrough(),
  factoryDispatch: z.object({
    action: z.enum(["create", "react", "promote", "cancel", "cleanup", "archive"]).optional(),
    objectiveId: z.string().optional(),
    prompt: z.string().optional(),
    note: z.string().optional(),
    title: z.string().optional(),
    baseHash: z.string().optional(),
    objectiveMode: z.enum(["delivery", "investigation"]).optional(),
    severity: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]).optional(),
    checks: z.array(z.string()).optional(),
    channel: z.string().optional(),
    profileId: z.string().optional(),
    reason: z.string().optional(),
  }).passthrough(),
  factoryStatus: z.object({
    objectiveId: z.string().optional(),
    waitForChangeMs: z.number().finite().optional(),
  }).passthrough(),
  factoryOutput: z.object({
    objectiveId: z.string().optional(),
    focusKind: z.enum(["task", "job"]).optional(),
    focusId: z.string().optional(),
    taskId: z.string().optional(),
    jobId: z.string().optional(),
    waitForChangeMs: z.number().finite().optional(),
  }).passthrough(),
  factoryReceipts: z.object({
    objectiveId: z.string().optional(),
    taskId: z.string().optional(),
    candidateId: z.string().optional(),
    types: z.array(z.string()).optional(),
    limit: z.number().finite().optional(),
  }).passthrough(),
} as const;

export const capabilityDescriptions = {
  ls: '{"path"?: string} — List directory contents. Defaults to workspace root.',
  read: '{"path": string, "startLine"?: number, "endLine"?: number, "start"?: number, "end"?: number, "maxChars"?: number} — Read file contents with optional line range. `start`/`end` are accepted aliases for line-based ranges.',
  replace: '{"path": string, "find": string, "replace": string, "all"?: boolean} — Replace exact text in a file without shelling out. Prefer this for small targeted edits.',
  write: '{"path": string, "content": string, "append"?: boolean} — Write or append to a file.',
  bash: '{"cmd": string, "timeoutMs"?: number} — Execute a shell command (default timeout 20s, max 120s).',
  grep: '{"pattern": string, "path"?: string, "maxMatches"?: number} — Search files using ripgrep.',
  "memory.read": '{"scope"?: string, "limit"?: number} — Read recent memory entries for a scope.',
  "memory.search": '{"scope"?: string, "query": string, "limit"?: number} — Semantic search over memory entries by meaning.',
  "memory.summarize": '{"scope"?: string, "query"?: string, "limit"?: number, "maxChars"?: number} — Summarize memory entries, optionally filtered by query.',
  "memory.commit": '{"scope"?: string, "text": string, "tags"?: string[]} — Persist a new memory entry.',
  "memory.diff": '{"scope"?: string, "fromTs": number, "toTs"?: number} — List memory entries within a timestamp range.',
  "skill.read": '{"name": string} — Get the full parameter spec for any tool by name.',
  "agent.delegate": '{"agentId": string, "task": string, "config"?: object, "timeoutMs"?: number} — Delegate a sub-task to a specialized agent (theorem, writer, agent, axiom, inspector). Blocks until complete or timeout.',
  "agent.status": '{"jobId": string} — Check status and result of a previously delegated job.',
  "agent.inspect": '{"file": string, "maxChars"?: number} — Read another agent\'s event history by stream id such as agents/factory/<repoKey>/<profileId>. Bare .jsonl filenames remain supported only for legacy imports.',
  "jobs.list": '{"limit"?: number, "status"?: string, "includeCompleted"?: boolean} — List recent child jobs for the current session.',
  "repo.status": '{} — Read control-plane git state for the current workspace: HEAD baseHash, branch, dirty/clean state, and a bounded git status --porcelain summary.',
  "codex.logs": '{"jobId"?: string} — Inspect Codex child logs and artifact paths for the current session. Without jobId, use the latest Codex child.',
  "codex.status": '{"jobId"?: string, "limit"?: number, "includeCompleted"?: boolean, "waitForChangeMs"?: number} — Inspect Codex child jobs for the current session. With waitForChangeMs, block briefly until state or logs change.',
  "codex.run": '{"prompt": string, "timeoutMs"?: number} — Queue one read-only Codex child probe for repo inspection or evidence-gathering. If a Codex child is already queued/running for this session, reuse it instead of spawning another.',
  "profile.handoff": '{"profileId": string, "reason": string, "objectiveId"?: string, "chatId"?: string} — Hand the conversation or objective off to another allowed Factory profile and queue the continuation explicitly.',
  "job.control": '{"jobId": string, "command": "abort", "reason"?: string} — Abort a running child job.',
  "factory.dispatch": '{"action"?: "create"|"react"|"promote"|"cancel"|"cleanup"|"archive", "objectiveId"?: string, "prompt"?: string, "note"?: string, "title"?: string, "baseHash"?: string, "objectiveMode"?: "delivery"|"investigation", "severity"?: 1|2|3|4|5, "checks"?: string[], "channel"?: string, "profileId"?: string, "reason"?: string} — Create or operate on a tracked Factory objective.',
  "factory.status": '{"objectiveId"?: string, "waitForChangeMs"?: number} — Inspect objective status, active jobs, recent receipts, and task/integration worktrees. With waitForChangeMs, block briefly until the objective changes.',
  "factory.output": '{"objectiveId"?: string, "focusKind"?: "task"|"job", "focusId"?: string, "taskId"?: string, "jobId"?: string, "waitForChangeMs"?: number} — Inspect live output and log tails for an objective task or job.',
  "factory.receipts": '{"objectiveId"?: string, "taskId"?: string, "candidateId"?: string, "types"?: string[], "limit"?: number} — Inspect a bounded objective-scoped receipt slice for the current project.',
} as const;

export const capabilityDefinition = <Schema extends ZodTypeAny>(
  definition: AgentCapabilityDefinition<Schema>,
): AgentCapabilityDefinition<Schema> => definition;

export const createCapabilitySpec = <Schema extends ZodTypeAny>(
  definition: AgentCapabilityDefinition<Schema>,
  execute: (
    input: z.output<Schema>,
    context: AgentCapabilityContext,
  ) => Promise<AgentToolResult>,
  options?: {
    readonly isAvailable?: () => boolean;
  },
): AgentCapabilitySpec => ({
  ...definition,
  execute: (input, context) => execute(input as z.output<Schema>, context),
  ...(options?.isAvailable ? { isAvailable: options.isAvailable } : {}),
});

export class AgentCapabilityRegistry {
  private readonly capabilities: ReadonlyArray<AgentCapabilitySpec>;
  private readonly byId: ReadonlyMap<string, AgentCapabilitySpec>;

  constructor(input: {
    readonly capabilities: ReadonlyArray<AgentCapabilitySpec>;
    readonly allowlist?: ReadonlyArray<string>;
  }) {
    const allow = input.allowlist?.length ? new Set(input.allowlist) : undefined;
    const byId = new Map<string, AgentCapabilitySpec>();
    for (const capability of input.capabilities) {
      if (capability.isAvailable && !capability.isAvailable()) continue;
      if (allow && !allow.has(capability.id)) continue;
      byId.set(capability.id, capability);
    }
    this.capabilities = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
    this.byId = byId;
  }

  list(): ReadonlyArray<AgentCapabilitySpec> {
    return this.capabilities;
  }

  ids(): ReadonlyArray<string> {
    return this.capabilities.map((capability) => capability.id);
  }

  get(id: string): AgentCapabilitySpec | undefined {
    return this.byId.get(id);
  }

  describe(id: string): string | undefined {
    return this.get(id)?.description;
  }

  renderToolHelp(): string {
    return this.capabilities.map((capability) => `- ${capability.id}: ${capability.description}`).join("\n");
  }

  async execute(id: string, rawInput: Record<string, unknown>): Promise<AgentToolResult> {
    const capability = this.get(id);
    if (!capability) throw new Error(`unknown tool '${id}'`);
    const parsed = capability.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? `invalid input for '${id}'`;
      throw new Error(message);
    }
    return capability.execute(parsed.data as Record<string, unknown>, { registry: this });
  }
}
