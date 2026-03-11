// ============================================================================
// Theorem Guild workflow - Receipt-native mini framework
// ============================================================================

import { createHash } from "node:crypto";

import type { Runtime } from "../core/runtime.js";
import type { TheoremAxiomEvidence, TheoremCmd, TheoremEvent, TheoremState } from "../modules/theorem.js";
import { reduce as reduceTheorem, initial as initialTheorem } from "../modules/theorem.js";
import { renderPrompt, type TheoremPromptConfig } from "../prompts/theorem.js";

import { clampNumber, parseFormNum, type AgentRunControl, createQueuedEmitter, type EmitFn, type RunLifecycle, type WorkflowSpec } from "../engine/runtime/workflow.js";
import { defineAgent, runDefinedAgent } from "../sdk/agent.js";
import {
  THEOREM_WORKFLOW_ID,
  THEOREM_WORKFLOW_VERSION,
  THEOREM_TEAM,
  THEOREM_EXAMPLES,
} from "./theorem.constants.js";
import {
  buildTheoremRuns,
  buildTheoremSteps,
  getLatestTheoremRunId,
  sliceTheoremChain,
  sliceTheoremChainByStep,
  type TheoremRunSummary,
} from "./theorem.runs.js";
import {
  bracketString,
  collectLeaves,
  pickBestBracket,
  treeForBracket,
  type BracketTree,
} from "./theorem.rebracket.js";
import { evaluateRoundRebracketEvidence } from "./theorem.evidence.js";
import {
  callWithStructuredRetries,
  formatAttemptPayload,
  formatCritiquePayload,
  formatLemmaPayload,
  formatMergePayload,
  formatPatchPayload,
  formatProofPayload,
  formatVerifyPayload,
  parseAttemptPayload,
  parseCritiquePayload,
  parseLemmaPayload,
  parseMergePayload,
  parseOrchestratorDecision,
  parsePatchPayload,
  parseProofPayload,
  parseVerifyPayload,
  type AxiomDelegatePayload,
  type ParsedOrchestratorDecision,
} from "./theorem.structured.js";
import type { AxiomTaskHints } from "./axiom/config.js";
import { buildMemorySlice, memoryBudget, type MemoryPhase } from "./theorem.memory.js";
import { theoremBranchStream, theoremRunStream } from "./theorem.streams.js";
import { theoremMergePolicy } from "../engine/merge/theorem-policy.js";
import { buildTheoremRunResult, classifyTheoremFailure, type TheoremFailureClass, type TheoremRunResult } from "./theorem.result.js";

// ============================================================================
// Types
// ============================================================================

export type TheoremRunConfig = {
  readonly rounds: number;
  readonly maxDepth: number;
  readonly memoryWindow: number;
  readonly branchThreshold: number;
};

export type TheoremRunControl = AgentRunControl;
export type TheoremAxiomPolicy = "optional" | "required";

export type TheoremAxiomDelegateResult = {
  readonly status: string;
  readonly summary: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly stream?: string;
  readonly outcome?: string;
  readonly evidence?: ReadonlyArray<Omit<TheoremAxiomEvidence, "phase">>;
  readonly verifiedCandidateContent?: string;
  readonly verifiedCandidateHash?: string;
  readonly verifiedFormalStatementHash?: string;
};

export type { TheoremFailureClass, TheoremRunResult } from "./theorem.result.js";

export const THEOREM_DEFAULT_CONFIG: TheoremRunConfig = {
  rounds: 2,
  maxDepth: 2,
  memoryWindow: 60,
  branchThreshold: 2,
};

export const normalizeTheoremConfig = (input: Partial<TheoremRunConfig>): TheoremRunConfig => ({
  rounds: clampNumber(
    Number.isFinite(input.rounds ?? NaN) ? input.rounds! : THEOREM_DEFAULT_CONFIG.rounds,
    1,
    5
  ),
  maxDepth: clampNumber(
    Number.isFinite(input.maxDepth ?? NaN) ? input.maxDepth! : THEOREM_DEFAULT_CONFIG.maxDepth,
    1,
    4
  ),
  memoryWindow: clampNumber(
    Number.isFinite(input.memoryWindow ?? NaN) ? input.memoryWindow! : THEOREM_DEFAULT_CONFIG.memoryWindow,
    5,
    200
  ),
  branchThreshold: clampNumber(
    Number.isFinite(input.branchThreshold ?? NaN) ? input.branchThreshold! : THEOREM_DEFAULT_CONFIG.branchThreshold,
    1,
    6
  ),
});

const hashText = (input: string): string =>
  createHash("sha256").update(input, "utf-8").digest("hex");

const extractPrimaryDeclarationName = (content: string): string | undefined => {
  const match = content.match(/\b(?:theorem|lemma)\s+([A-Za-z0-9_'.]+)/);
  return match?.[1];
};

const softTrim = (text: string, headChars: number, tailChars: number): string => {
  if (text.length <= headChars + tailChars + 16) return text;
  return `${text.slice(0, headChars)}\n\n[... trimmed ...]\n\n${text.slice(-tailChars)}`;
};

const isPromptSectionHeader = (line: string): boolean =>
  /^(Problem|Memory|Latest summary \(if any\)|Summary|Attempts|Attempt|Critiques|Verifier notes|Current proof|Proof|Task|Return JSON only in this schema|Left \(.*\)|Right \(.*\)|Merge these leaves for .+):$/.test(line.trim());

const trimPromptSectionBody = (body: string, limit: number): string => {
  const trimmed = body.trim();
  if (trimmed.length <= limit) return trimmed;
  const headChars = Math.max(120, Math.floor(limit * 0.55));
  const tailChars = Math.max(80, Math.floor(limit * 0.25));
  return softTrim(trimmed, headChars, tailChars);
};

export const compactTheoremPrompt = (text: string, targetChars: number): string => {
  if (text.length <= targetChars) return text;

  const lines = text.split("\n");
  const sections: Array<{ header: string; body: string }> = [];
  let currentHeader: string | undefined;
  let currentBody: string[] = [];

  const flushSection = () => {
    if (!currentHeader) return;
    sections.push({
      header: currentHeader,
      body: currentBody.join("\n").trim(),
    });
  };

  for (const line of lines) {
    if (isPromptSectionHeader(line)) {
      flushSection();
      currentHeader = line.trim();
      currentBody = [];
      continue;
    }
    currentBody.push(line);
  }
  flushSection();

  if (sections.length <= 1) {
    const compactLines = lines.filter((line) => line.trim().length > 0);
    const head = compactLines.slice(0, 24).join("\n");
    const tail = compactLines.slice(-16).join("\n");
    const merged = `${head}\n\n[... compacted context ...]\n\n${tail}`.trim();
    if (merged.length <= targetChars) return merged;
    return softTrim(merged, Math.floor(targetChars * 0.6), Math.floor(targetChars * 0.3));
  }

  const sectionWeight = (header: string): number => {
    if (/^Problem:$/.test(header)) return 3;
    if (/^Task:$/.test(header)) return 2;
    if (/^Return JSON only in this schema:$/.test(header)) return 2;
    if (/^(Left \(.*\)|Right \(.*\)|Summary:|Proof:|Current proof:|Verifier notes:|Attempts:|Attempt:|Merge these leaves for .+:)$/.test(header)) {
      return 2;
    }
    return 1;
  };

  const fixedChars = sections.reduce((total, section) => total + section.header.length + 2, 0) + Math.max(0, (sections.length - 1) * 2);
  const minBodyBudget = 120;
  const minRequired = fixedChars + (sections.length * minBodyBudget);
  if (minRequired > targetChars) {
    return softTrim(text, Math.floor(targetChars * 0.6), Math.floor(targetChars * 0.3));
  }

  const totalWeight = sections.reduce((total, section) => total + sectionWeight(section.header), 0);
  let remaining = targetChars - fixedChars;
  let remainingWeight = totalWeight;
  const rendered = sections.map((section, index) => {
    const weight = sectionWeight(section.header);
    const sectionsLeft = sections.length - index;
    const minReservedForRest = (sectionsLeft - 1) * minBodyBudget;
    const proportional = Math.floor((remaining * weight) / Math.max(1, remainingWeight));
    const budget = Math.max(minBodyBudget, Math.min(section.body.length, remaining - minReservedForRest, proportional || minBodyBudget));
    remaining -= budget;
    remainingWeight -= weight;
    return `${section.header}\n${trimPromptSectionBody(section.body, budget)}`.trim();
  }).join("\n\n");

  if (rendered.length <= targetChars) return rendered;
  return softTrim(rendered, Math.floor(targetChars * 0.65), Math.floor(targetChars * 0.25));
};

const mergeTaskHints = (
  base: AxiomTaskHints | undefined,
  extra: AxiomTaskHints | undefined
): AxiomTaskHints | undefined => {
  if (!base && !extra) return undefined;
  const preferredTools = [...new Set([...(extra?.preferredTools ?? []), ...(base?.preferredTools ?? [])])];
  return {
    ...(preferredTools.length > 0 ? { preferredTools } : {}),
    reason: extra?.reason ?? base?.reason,
    targetPath: extra?.targetPath ?? base?.targetPath,
    formalStatementPath: extra?.formalStatementPath ?? base?.formalStatementPath,
    declarationName: extra?.declarationName ?? base?.declarationName,
  };
};

const inferAxiomTaskHints = (opts: {
  readonly phase: "attempt" | "verify";
  readonly content: string;
  readonly notes?: ReadonlyArray<string>;
  readonly formalStatementPath?: string;
}): AxiomTaskHints | undefined => {
  const noteText = opts.notes?.join("\n") ?? "";
  const haystack = `${opts.content}\n${noteText}`;
  const declarationName = extractPrimaryDeclarationName(opts.content);
  const nameConflict = /already declared|has already been declared|name conflict|collid|namespace|rename/i.test(haystack);
  const haveObligation = /\bhave\b/.test(opts.content) || /have statement|callsite|extract have/i.test(noteText);
  const decompose = opts.content.length > 1_600 || /monolithic|decompose|split into lemmas|intermediate lemma/i.test(noteText);

  const preferredTools = [
    ...(nameConflict ? ["lean.rename"] : []),
    ...(haveObligation ? ["lean.have2lemma", "lean.have2sorry"] : []),
    ...(decompose && !haveObligation ? ["lean.theorem2lemma"] : []),
    ...(opts.phase === "verify" ? ["lean.theorem2sorry", "lean.verify"] : ["lean.check", "lean.repair"]),
  ];

  const reason = nameConflict
    ? "name_conflict"
    : haveObligation
      ? "extract_have_obligation"
      : decompose
        ? "decompose_theorem"
        : undefined;

  if (preferredTools.length === 0 && !reason && !opts.formalStatementPath && !declarationName) return undefined;
  return {
    ...(preferredTools.length > 0 ? { preferredTools } : {}),
    ...(reason ? { reason } : {}),
    ...(opts.formalStatementPath ? { formalStatementPath: opts.formalStatementPath } : {}),
    ...(declarationName ? { declarationName } : {}),
  };
};

export const parseTheoremConfig = (form: Record<string, string>): TheoremRunConfig =>
  normalizeTheoremConfig({
    rounds: parseFormNum(form.rounds),
    maxDepth: parseFormNum(form.depth),
    memoryWindow: parseFormNum(form.memory),
    branchThreshold: parseFormNum(form.branch),
  });

type TheoremWorkflowConfig = TheoremRunConfig & {
  readonly problem: string;
};

type TheoremWorkflowDeps = {
  readonly runtime: Runtime<TheoremCmd, TheoremEvent, TheoremState>;
  readonly prompts: TheoremPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly emitIndex: (event: TheoremEvent) => Promise<void>;
  readonly control?: TheoremRunControl;
  readonly axiomDelegate?: (input: {
    readonly task: string;
    readonly config?: Readonly<Record<string, unknown>>;
    readonly timeoutMs?: number;
  }) => Promise<TheoremAxiomDelegateResult>;
  readonly axiomPolicy?: TheoremAxiomPolicy;
  readonly axiomConfig?: Readonly<Record<string, unknown>>;
};

export type TheoremRunInput = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream?: string;
  readonly problem: string;
  readonly config: TheoremRunConfig;
  readonly runtime: Runtime<TheoremCmd, TheoremEvent, TheoremState>;
  readonly prompts: TheoremPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly broadcast?: () => void;
  readonly now?: () => number;
  readonly control?: TheoremRunControl;
  readonly axiomDelegate?: TheoremWorkflowDeps["axiomDelegate"];
  readonly axiomPolicy?: TheoremAxiomPolicy;
  readonly axiomConfig?: TheoremWorkflowDeps["axiomConfig"];
};

// ============================================================================
// Workflow spec
// ============================================================================

const THEOREM_LIFECYCLE: RunLifecycle<TheoremWorkflowDeps, TheoremEvent, TheoremState, TheoremWorkflowConfig> = {
  reducer: reduceTheorem,
  initial: initialTheorem,
  init: (ctx, runId, config) => [
    { type: "problem.set", runId, problem: config.problem, agentId: "orchestrator" },
    {
      type: "run.configured",
      runId,
      agentId: "orchestrator",
      workflow: { id: THEOREM_WORKFLOW_ID, version: THEOREM_WORKFLOW_VERSION },
      config: { rounds: config.rounds, depth: config.maxDepth, memoryWindow: config.memoryWindow, branchThreshold: config.branchThreshold },
      model: ctx.model,
      promptHash: ctx.promptHash,
      promptPath: ctx.promptPath,
    },
  ],
};

const THEOREM_WORKFLOW: WorkflowSpec<TheoremWorkflowDeps, TheoremWorkflowConfig, TheoremEvent, TheoremState> = {
  id: THEOREM_WORKFLOW_ID,
  version: THEOREM_WORKFLOW_VERSION,
  lifecycle: THEOREM_LIFECYCLE,
  run: async (ctx, config) => {
    const { runtime, prompts, llmText: llmRaw, apiReady, apiNote, control } = ctx;
    const { rounds, maxDepth, memoryWindow, branchThreshold, problem: inputProblem } = config;
    const runId = ctx.runId;
    const axiomPolicy = ctx.axiomPolicy ?? "optional";
    const axiomConfig = ctx.axiomConfig;

    const agentBranchEmitters = new Map<string, EmitFn<TheoremEvent>>();
    const agentBranchStreams = new Map<string, string>();
    const agentIds = THEOREM_TEAM.map((agent) => agent.id).filter((id) => id !== "orchestrator");

    const emitMain = async (event: TheoremEvent) => {
      await ctx.emit(event);
    };

    const ensureAgentBranch = async (agentId: string, forkAt?: number) => {
      if (agentId === "orchestrator") return;
      if (agentBranchEmitters.has(agentId)) return;

      const branchName = theoremBranchStream(ctx.stream, agentId);
      agentBranchStreams.set(agentId, branchName);

      const existing = await runtime.branch(branchName);
      let forkPoint = forkAt;
      if (!existing) {
        forkPoint = forkPoint ?? (await runtime.chain(ctx.stream)).length;
        await runtime.fork(ctx.stream, forkPoint, branchName);
        await emitMain({
          type: "branch.created",
          runId,
          branchId: branchName,
          forkAt: forkPoint,
          note: `Agent branch for ${agentId}`,
        });
      }

      const emitBranch = createQueuedEmitter({
        runtime,
        stream: branchName,
        wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as TheoremCmd),
        onError: (err) => console.error(`theorem branch emit failed (${agentId})`, err),
      });
      agentBranchEmitters.set(agentId, emitBranch);
    };

    const shouldRouteToBranch = (event: TheoremEvent): boolean => {
      switch (event.type) {
        case "attempt.proposed":
        case "lemma.proposed":
        case "critique.raised":
        case "patch.applied":
          return true;
        default:
          return false;
      }
    };

    const shouldRouteToMain = (event: TheoremEvent): boolean => {
      switch (event.type) {
        case "summary.made":
        case "solution.finalized":
        case "verification.report":
          return true;
        default:
          return !shouldRouteToBranch(event);
      }
    };

    const emit = async (event: TheoremEvent) => {
      const agentId = "agentId" in event ? event.agentId : undefined;
      if (agentId && shouldRouteToBranch(event)) {
        await ensureAgentBranch(agentId);
        const emitBranch = agentBranchEmitters.get(agentId);
        if (emitBranch) await emitBranch(event);
        return;
      }
      if (shouldRouteToMain(event)) {
        await emitMain(event);
      }
    };

    const emitFailure = async (failure: NonNullable<Extract<TheoremEvent, { type: "failure.report" }>["failure"]>) => {
      await emit({
        type: "failure.report",
        runId,
        agentId: "orchestrator",
        failure,
      });
    };

    const isContextOverflow = (err: unknown): boolean => {
      const message = err instanceof Error ? err.message : String(err);
      return /context|token|maximum context|input too large|prompt too long/i.test(message);
    };

    const applyContextPolicy = async (stage: string, user: string): Promise<string> => {
      const HARD_THRESHOLD = 50_000;
      const SOFT_THRESHOLD = 12_000;
      let next = user;
      if (next.length > HARD_THRESHOLD) {
        const before = next.length;
        next = compactTheoremPrompt(next, 12_000);
        await emit({
          type: "context.pruned",
          runId,
          agentId: "orchestrator",
          stage,
          mode: "hard",
          before,
          after: next.length,
          note: "hard section-preserving trim applied",
        });
      } else if (next.length > SOFT_THRESHOLD) {
        const before = next.length;
        next = compactTheoremPrompt(next, 7_000);
        await emit({
          type: "context.pruned",
          runId,
          agentId: "orchestrator",
          stage,
          mode: "soft",
          before,
          after: next.length,
          note: "soft section-preserving trim applied",
        });
      }
      return next;
    };

    const llmText = async (opts: { system?: string; user: string }): Promise<string> => {
      const stage = "agent-loop";
      if (await checkAbort(`${stage}.before_llm`)) {
        throw new Error(`canceled at ${stage}.before_llm`);
      }
      const pruned = await applyContextPolicy(stage, opts.user);
      try {
        const out = await llmRaw({ system: opts.system, user: pruned });
        if (await checkAbort(`${stage}.after_llm`)) {
          throw new Error(`canceled at ${stage}.after_llm`);
        }
        return out;
      } catch (err) {
        if (!isContextOverflow(err)) throw err;
        const compacted = compactTheoremPrompt(pruned, 7_000);
        await emit({
          type: "context.compacted",
          runId,
          agentId: "orchestrator",
          stage,
          reason: "overflow",
          before: pruned.length,
          after: compacted.length,
          note: "retry after overflow",
        });
        await emit({
          type: "overflow.recovered",
          runId,
          agentId: "orchestrator",
          stage,
          note: "recovered by compacting prompt and retrying once",
        });
        const out = await llmRaw({ system: opts.system, user: compacted });
        if (await checkAbort(`${stage}.after_overflow_retry`)) {
          throw new Error(`canceled at ${stage}.after_overflow_retry`);
        }
        return out;
      }
    };

    const checkAbort = async (stage: string): Promise<boolean> => {
      if (!control?.checkAbort) return false;
      const aborted = await control.checkAbort();
      if (!aborted) return false;
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: `canceled at ${stage}`,
      });
      return true;
    };

    const applyControlCommands = async (): Promise<void> => {
      if (!control?.pullCommands) return;
      const commands = await control.pullCommands();
      for (const command of commands) {
        const payload = command.payload ?? {};
        if (typeof payload.problem === "string" && payload.problem.trim().length > 0) {
          const nextProblem = payload.problem.trim();
          problemText = nextProblem;
          await emit({
            type: "problem.set",
            runId,
            agentId: "orchestrator",
            problem: problemText,
          });
          continue;
        }
        if (typeof payload.note === "string" && payload.note.trim().length > 0) {
          const append = `Follow-up:\n${payload.note.trim()}`;
          problemText = `${problemText}\n\n${append}`.trim();
          await emit({
            type: "problem.appended",
            runId,
            agentId: "orchestrator",
            append,
          });
        }
      }
    };

    const loadCombinedChain = async () => {
      const mainChain = await runtime.chain(ctx.stream);
      if (agentBranchStreams.size === 0) return mainChain;
      const branchChains = await Promise.all(
        [...agentBranchStreams.values()].map((stream) => runtime.chain(stream))
      );
      const combined = [...mainChain, ...branchChains.flat()];
      combined.sort((a, b) => a.ts - b.ts || a.stream.localeCompare(b.stream) || a.id.localeCompare(b.id));
      return combined;
    };

    const claimId = (prefix: string) => `${prefix}_${ctx.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const agentStatus = async (
      agentId: string,
      status: "running" | "idle" | "done",
      phase?: string,
      round?: number,
      note?: string
    ) => emit({ type: "agent.status", runId, agentId, status, phase, round, note });

    const existingChain = await runtime.chain(ctx.stream);
    const resume = Boolean(ctx.resume);
    let problemText = (resume ? (ctx.state?.problem || inputProblem) : (inputProblem || ctx.state?.problem || "")).trim();

    if (!problemText) {
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: "problem required",
      });
      return;
    }

    if (!apiReady) {
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: apiNote ?? "OPENAI_API_KEY not set",
      });
      await emit({
        type: "solution.finalized",
        runId,
        agentId: "orchestrator",
        content: apiNote ?? "OPENAI_API_KEY not set",
        confidence: 0,
        gaps: ["Missing OPENAI_API_KEY"],
      });
      return;
    }

    await applyControlCommands();
    if (await checkAbort("bootstrap")) return;

    const forkPoint = (await runtime.chain(ctx.stream)).length;
    for (const agentId of agentIds) {
      await ensureAgentBranch(agentId, forkPoint);
    }

    type PromptContextEvent = Extract<TheoremEvent, { type: "prompt.context" }>;
    const emitPromptContext = async (payload: Omit<PromptContextEvent, "type" | "runId">) => {
      await emit({ type: "prompt.context", runId, ...payload });
    };

    const runAxiomDelegate = async (opts: {
      readonly request?: AxiomDelegatePayload;
      readonly agentId: string;
      readonly round: number;
      readonly phase: "attempt" | "verify";
      readonly targetClaimId?: string;
    }): Promise<{
      readonly summary: string;
      readonly outcome?: string;
      readonly evidence: ReadonlyArray<TheoremAxiomEvidence>;
      readonly verifiedCandidateContent?: string;
      readonly verifiedCandidateHash?: string;
      readonly verifiedFormalStatementHash?: string;
    }> => {
      const request = opts.request;
      if (!request?.task?.trim()) {
        return { summary: "", evidence: [] };
      }

      const input = {
        task: request.task,
        config: request.config,
        hints: request.hints,
        phase: opts.phase,
        round: opts.round,
        ...(opts.targetClaimId ? { targetClaimId: opts.targetClaimId } : {}),
      } as Record<string, unknown>;
      const started = Date.now();

      if (!ctx.axiomDelegate) {
        await emit({
          type: "tool.called",
          runId,
          agentId: opts.agentId,
          tool: "axiom.delegate",
          input,
          summary: "failed",
          durationMs: Date.now() - started,
          error: "axiom delegate unavailable",
        });
        return { summary: "Axiom worker unavailable.", outcome: "delegate_unavailable", evidence: [] };
      }

      try {
        const result = await ctx.axiomDelegate({
          task: request.task,
          config: request.config,
          timeoutMs: 180_000,
        });
        const evidence = (result.evidence ?? []).map((item) => ({
          ...item,
          phase: opts.phase,
          subJobId: result.jobId ?? item.subJobId,
          subRunId: result.runId ?? item.subRunId,
        }));
        await emit({
          type: "tool.called",
          runId,
          agentId: opts.agentId,
          tool: "axiom.delegate",
          input,
          summary: `status=${result.status}${result.outcome ? `; outcome=${result.outcome}` : ""}${result.runId ? `; run=${result.runId}` : ""}`,
          durationMs: Date.now() - started,
        });
        await emit({
          type: "subagent.merged",
          runId,
          agentId: opts.agentId,
          subJobId: result.jobId ?? `axiom_${opts.round}_${Date.now().toString(36)}`,
          subRunId: result.runId ?? `axiom_${opts.round}_${Date.now().toString(36)}`,
          task: request.task,
          summary: result.summary,
          outcome: result.outcome,
          evidence,
        });
        return {
          summary: result.summary.trim(),
          outcome: result.outcome,
          evidence,
          verifiedCandidateContent: result.verifiedCandidateContent,
          verifiedCandidateHash: result.verifiedCandidateHash,
          verifiedFormalStatementHash: result.verifiedFormalStatementHash,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await emit({
          type: "tool.called",
          runId,
          agentId: opts.agentId,
          tool: "axiom.delegate",
          input,
          summary: "failed",
          durationMs: Date.now() - started,
          error: message,
        });
        return { summary: `Axiom worker failed: ${message}`, outcome: "delegate_failed", evidence: [] };
      }
    };

    const withAxiomDefaults = (request?: AxiomDelegatePayload, opts?: {
      readonly phase: "attempt" | "verify";
      readonly content: string;
      readonly notes?: ReadonlyArray<string>;
    }): AxiomDelegatePayload | undefined => {
      if (!request?.task?.trim()) return undefined;
      const formalStatementPath = typeof axiomConfig?.formalStatementPath === "string"
        ? axiomConfig.formalStatementPath
        : undefined;
      const taskHints = mergeTaskHints(
        inferAxiomTaskHints({
          phase: opts?.phase ?? "attempt",
          content: opts?.content ?? request.task,
          notes: opts?.notes,
          formalStatementPath,
        }),
        request.hints
      );
      const mergedConfig = {
        ...(axiomConfig ?? {}),
        ...(request.config ?? {}),
        ...(taskHints ? { taskHints } : {}),
        ...(opts?.phase === "verify" && axiomPolicy === "required"
          ? {
              requiredValidation: {
                kind: "axle-verify" as const,
                ...(formalStatementPath ? { formalStatementPath } : {}),
              },
            }
          : {}),
      };
      return {
        task: request.task.trim(),
        config: Object.keys(mergedConfig).length > 0 ? mergedConfig : undefined,
        hints: taskHints,
      };
    };

    const buildForcedAxiomTask = (opts: {
      readonly phase: "attempt" | "verify";
      readonly agentId: string;
      readonly round: number;
      readonly content: string;
      readonly notes?: ReadonlyArray<string>;
    }): AxiomDelegatePayload => {
      const formalStatementPath = typeof axiomConfig?.formalStatementPath === "string"
        ? axiomConfig.formalStatementPath
        : undefined;
      const taskHints = inferAxiomTaskHints({
        phase: opts.phase,
        content: opts.content,
        notes: opts.notes,
        formalStatementPath,
      });
      const intro = opts.phase === "verify"
        ? "Use AXLE as the required ground-truth verifier for this theorem guild run."
        : "Use AXLE to formalize or stress-test this theorem branch.";
      const label = opts.phase === "verify" ? "Candidate proof" : "Branch attempt";
      const requirements = opts.phase === "verify"
        ? [
            "- work in Lean 4 with Mathlib",
            "- produce or load the exact sorried formal statement for the candidate using `lean.theorem2sorry` or `lean.theorem2sorry_file`",
            "- run `lean.verify` or `lean.verify_file` against that exact formal statement as the final gate",
            "- if a theorem name conflicts with Mathlib, wrap the candidate in a unique namespace or rename the declaration before verification",
            "- if verification passes, keep the verified candidate unchanged and report the exact AXLE verification result",
            "- if verification fails, report the failure diagnostics and do not claim success",
          ]
        : [
            "- work in Lean 4 with Mathlib when formalization is needed",
            "- use AXLE check, verify, repair, simplification, or disproval tools as appropriate",
            "- explain whether the branch is valid, needs repair, or is false",
            "- if a Lean artifact is produced, keep it minimal and executable",
          ];
      return {
        task: [
          intro,
          `Problem:`,
          problemText,
          ...(opts.phase === "verify" && formalStatementPath
            ? ["", "Formal statement artifact:", formalStatementPath]
            : []),
          "",
          `${label}:`,
          opts.content,
          "",
          "Requirements:",
          ...requirements,
        ].join("\n").trim(),
        config: {
          ...(axiomConfig ?? {}),
          ...(taskHints ? { taskHints } : {}),
          ...(opts.phase === "verify" && axiomPolicy === "required"
            ? {
                requiredValidation: {
                  kind: "axle-verify" as const,
                  ...(formalStatementPath ? { formalStatementPath } : {}),
                },
              }
            : {}),
        },
        hints: taskHints,
      };
    };

    const structuredRetries = 2;

    const existingRebrackets = existingChain.filter((r) => r.body.type === "rebracket.applied") as Array<{
      body: Extract<TheoremEvent, { type: "rebracket.applied" }>;
    }>;
    let currentBracket = existingRebrackets[existingRebrackets.length - 1]?.body.bracket
      ?? "(((A o B) o C) o D)";

    const explorers = THEOREM_TEAM.filter((a) => a.id.startsWith("explorer"));

    const summaryEvents = existingChain.filter((r) => r.body.type === "summary.made") as Array<{
      body: Extract<TheoremEvent, { type: "summary.made" }>;
    }>;
    const latestSummaryEvent = summaryEvents[summaryEvents.length - 1]?.body;
    const summaryClaimId = latestSummaryEvent?.claimId;
    let summaryText = summaryClaimId
      ? summaryEvents.filter((r) => r.body.claimId === summaryClaimId).map((r) => r.body.content).join("")
      : "";
    let focusHints: Record<string, string> = {};
    const runOrchestratorDecision = async (
      prompt: string,
      system: string
    ): Promise<{ decision: ParsedOrchestratorDecision; raw: string }> => {
      const parsed = await callWithStructuredRetries({
        llmText,
        system,
        user: prompt,
        parse: parseOrchestratorDecision,
        retries: structuredRetries,
      });
      return { decision: parsed.value, raw: parsed.raw.trim() };
    };

    const hasSeed = existingRebrackets.some((r) => /initial bracket seed/i.test(r.body.note ?? ""));
    const completedRounds = resume ? Math.max(0, existingRebrackets.length - (hasSeed ? 1 : 0)) : 0;
    let startRound = resume ? Math.min(rounds, completedRounds + 1) : 1;
    let skipRounds = false;

    if (startRound === 1 && prompts.user.orchestrate) {
      const orchestratePrompt = renderPrompt(prompts.user.orchestrate, {
        problem: problemText,
        summary: summaryText ? `Summary:\n${summaryText}` : "",
        attempts: "(none yet)",
      });
      await emitPromptContext({
        agentId: "orchestrator",
        phase: "orchestrate",
        title: "Orchestrator pre-round",
        round: 0,
        content: orchestratePrompt,
      });
      const { decision, raw } = await runOrchestratorDecision(
        orchestratePrompt,
        prompts.system.orchestrator ?? ""
      );
      const done = decision.action === "done";
      focusHints = decision.focus ?? {};
      await emit({
        type: "orchestrator.decision",
        runId,
        agentId: "orchestrator",
        round: 0,
        action: done ? "done" : "continue",
        reason: decision.reason ?? "Pre-round decision",
        skipLemma: decision.skipLemma,
        skipCritique: decision.skipCritique,
        skipPatch: decision.skipPatch,
        skipMerge: decision.skipMerge,
        focus: decision.focus,
        raw,
      });
      if (done) {
        skipRounds = true;
        startRound = rounds + 1;
      }
    }

    if (startRound > rounds && !skipRounds) return;

    for (let round = startRound; round <= rounds; round += 1) {
      await applyControlCommands();
      if (await checkAbort(`round-${round}`)) return;
      await emit({
        type: "run.status",
        runId,
        status: "running",
        agentId: "orchestrator",
        note: `Round ${round}/${rounds}`,
      });

      const chainBefore = await loadCombinedChain();
      const runSliceBefore = sliceTheoremChain(chainBefore, runId);
      let memoryTruncated = false;
      const memoryFor = async (
        phase: MemoryPhase,
        chain: typeof runSliceBefore,
        targetClaimId?: string
      ) => {
        const started = Date.now();
        const input = {
          phase,
          window: memoryWindow,
          maxChars: memoryBudget(memoryWindow, phase),
          targetClaimId,
          bracket: currentBracket,
        };
        const slice = buildMemorySlice(chain, input);
        await emit({
          type: "tool.called",
          runId,
          agentId: "orchestrator",
          tool: "memory.summarize",
          input,
          summary: `chars:${slice.text.length};items:${slice.items.length};truncated:${slice.truncated ? "1" : "0"}`,
          durationMs: Date.now() - started,
        });
        if (slice.truncated) memoryTruncated = true;
        if (slice.text || slice.items.length > 0) {
          await emit({
            type: "memory.slice",
            runId,
            agentId: "orchestrator",
            phase,
            window: memoryWindow,
            bracket: currentBracket,
            maxChars: slice.maxChars,
            chars: slice.text.length,
            itemCount: slice.items.length,
            items: slice.items,
            truncated: slice.truncated,
            targetClaimId,
          });
        }
        return slice.text;
      };
      const memoryAttempt = await memoryFor("attempt", runSliceBefore);

      await emit({
        type: "phase.parallel",
        runId,
        phase: "attempt",
        agents: explorers.map((a) => a.id),
        round,
      });
      await Promise.all(explorers.map((agent) => agentStatus(agent.id, "running", "attempt", round)));
      const roundAttempts = await Promise.all(explorers.map(async (agent) => {
        const attemptId = claimId(`attempt_r${round}`);
        const focusHint = focusHints[agent.id];
        const focusBlock = focusHint ? `Focus:\n${focusHint}\n\n` : "";
        const memoryBlock = memoryAttempt ? `Memory:\n${memoryAttempt}` : "";
        const summaryBlock = summaryText ? `Latest summary:\n${summaryText}` : "";
        const prompt = renderPrompt(prompts.user.attempt ?? "", {
          problem: problemText,
          focus: focusBlock,
          memory: memoryBlock,
          summary: summaryBlock,
        });

        await emitPromptContext({
          agentId: agent.id,
          phase: "attempt",
          title: "Attempt prompt",
          round,
          claimId: attemptId,
          content: prompt,
        });
        const attemptResult = await callWithStructuredRetries({
          llmText,
          system: prompts.system[agent.id] ?? "",
          user: prompt,
          parse: parseAttemptPayload,
          retries: structuredRetries,
        });
        let content = formatAttemptPayload(attemptResult.value);
        const axiomRequest = withAxiomDefaults(attemptResult.value.axiom, {
          phase: "attempt",
          content,
        });
        const axiomResult = await runAxiomDelegate({
          request: axiomRequest,
          agentId: agent.id,
          round,
          phase: "attempt",
          targetClaimId: attemptId,
        });
        if (axiomResult.summary) {
          content = `${content}\n\nAXIOM Worker:\n${axiomResult.summary}`.trim();
        }
        const attemptEvent: TheoremEvent = {
          type: "attempt.proposed",
          runId,
          claimId: attemptId,
          agentId: agent.id,
          content,
        };
        await emit(attemptEvent);
        await agentStatus(agent.id, "done", "attempt", round);
        return { id: attemptId, agentId: agent.id, content };
      }));
      if (await checkAbort(`round-${round}-attempts`)) return;

      const attemptText = roundAttempts.map((a) => `# ${a.agentId}\n${a.content}`).join("\n\n");

      let skipLemma = false;
      let skipCritique = false;
      let skipPatch = false;
      let skipMerge = false;
      let stopAfterRound = false;

      if (prompts.user.orchestrate) {
        const orchestratePrompt = renderPrompt(prompts.user.orchestrate, {
          problem: problemText,
          summary: summaryText ? `Summary:\n${summaryText}` : "",
          attempts: attemptText,
        });
        await emitPromptContext({
          agentId: "orchestrator",
          phase: "orchestrate",
          title: "Orchestrator decision",
          round,
          content: orchestratePrompt,
        });
        const { decision, raw } = await runOrchestratorDecision(
          orchestratePrompt,
          prompts.system.orchestrator ?? ""
        );
        const done = decision.action === "done";
        skipLemma = decision.skipLemma;
        skipCritique = decision.skipCritique;
        skipPatch = decision.skipPatch;
        skipMerge = decision.skipMerge;
        focusHints = decision.focus ?? {};
        stopAfterRound = done;
        await emit({
          type: "orchestrator.decision",
          runId,
          agentId: "orchestrator",
          round,
          action: done ? "done" : "continue",
          reason: decision.reason,
          skipLemma,
          skipCritique,
          skipPatch,
          skipMerge,
          focus: decision.focus,
          raw,
        });
      }
      if (await checkAbort(`round-${round}-orchestrate`)) return;

      const lemmaId = claimId(`lemma_r${round}`);
      let lemmaOutput = "";
      if (!skipLemma) {
        const memoryLemma = await memoryFor("lemma", runSliceBefore);
        await agentStatus("lemma_miner", "running", "lemma", round);
        const lemmaPrompt = renderPrompt(prompts.user.lemma ?? "", {
          problem: problemText,
          memory: memoryLemma ? `Memory:\n${memoryLemma}` : "",
          attempts: attemptText,
        });
        await emitPromptContext({
          agentId: "lemma_miner",
          phase: "lemma",
          title: "Lemma prompt",
          round,
          claimId: lemmaId,
          content: lemmaPrompt,
        });
        const lemmaResult = await callWithStructuredRetries({
          llmText,
          system: prompts.system.lemma_miner ?? "",
          user: lemmaPrompt,
          parse: parseLemmaPayload,
          retries: structuredRetries,
        });
        lemmaOutput = formatLemmaPayload(lemmaResult.value);
        await emit({
          type: "lemma.proposed",
          runId,
          claimId: lemmaId,
          agentId: "lemma_miner",
          content: lemmaOutput,
        });
        await agentStatus("lemma_miner", "done", "lemma", round);
      }
      if (await checkAbort(`round-${round}-lemma`)) return;

      const patches: Array<{ id: string; targetId: string; content: string }> = [];

      const critiques = skipCritique
        ? []
        : await (async () => {
            await emit({
              type: "phase.parallel",
              runId,
              phase: "critique",
              agents: roundAttempts.map((a) => a.agentId),
              round,
            });
            await agentStatus("skeptic", "running", "critique", round);
            const results = await Promise.all(roundAttempts.map(async (attempt) => {
              const critiqueId = claimId(`critique_r${round}`);
              const memoryCritique = await memoryFor("critique", runSliceBefore, attempt.id);
              const critiquePrompt = renderPrompt(prompts.user.critique ?? "", {
                problem: problemText,
                memory: memoryCritique ? `Memory:\n${memoryCritique}` : "",
                attempt: attempt.content,
              });
              await emitPromptContext({
                agentId: "skeptic",
                phase: "critique",
                title: "Critique prompt",
                round,
                claimId: critiqueId,
                targetClaimId: attempt.id,
                content: critiquePrompt,
              });
              const critiqueResult = await callWithStructuredRetries({
                llmText,
                system: prompts.system.skeptic ?? "",
                user: critiquePrompt,
                parse: parseCritiquePayload,
                retries: structuredRetries,
              });
              const critiqueContent = formatCritiquePayload(critiqueResult.value);
              await emit({
                type: "critique.raised",
                runId,
                claimId: critiqueId,
                agentId: "skeptic",
                targetClaimId: attempt.id,
                content: critiqueContent,
              });
              return { id: critiqueId, targetId: attempt.id, content: critiqueContent };
            }));
            await agentStatus("skeptic", "done", "critique", round);
            return results;
          })();
      if (await checkAbort(`round-${round}-critique`)) return;

      if (!skipPatch) {
        await emit({
          type: "phase.parallel",
          runId,
          phase: "patch",
          agents: roundAttempts.map((a) => a.agentId),
          round,
        });
        await agentStatus("verifier", "running", "patch", round);
        await Promise.all(roundAttempts.map(async (attempt) => {
          const patchId = claimId(`patch_r${round}`);
          const memoryPatch = await memoryFor("patch", runSliceBefore, attempt.id);
          const critiquesForAttempt = critiques
            .filter((critique) => critique.targetId === attempt.id)
            .map((critique) => critique.content)
            .join("\n");
          const patchPrompt = renderPrompt(prompts.user.patch ?? "", {
            problem: problemText,
            memory: memoryPatch ? `Memory:\n${memoryPatch}` : "",
            attempt: attempt.content,
            critiques: critiquesForAttempt || "No critique.",
          });
          await emitPromptContext({
            agentId: "verifier",
            phase: "patch",
            title: "Patch prompt",
            round,
            claimId: patchId,
            targetClaimId: attempt.id,
            content: patchPrompt,
          });
          const patchResult = await callWithStructuredRetries({
            llmText,
            system: prompts.system.verifier ?? "",
            user: patchPrompt,
            parse: parsePatchPayload,
            retries: structuredRetries,
          });
          const patchContent = formatPatchPayload(patchResult.value);
          patches.push({ id: patchId, targetId: attempt.id, content: patchContent });
          await emit({
            type: "patch.applied",
            runId,
            claimId: patchId,
            agentId: "verifier",
            targetClaimId: attempt.id,
            content: patchContent,
          });
        }));
        await agentStatus("verifier", "done", "patch", round);
      }
      if (await checkAbort(`round-${round}-patch`)) return;

      const chainAfterCrit = await loadCombinedChain();
      const runSliceAfterCrit = sliceTheoremChain(chainAfterCrit, runId);
      const memoryMerge = skipMerge ? "" : await memoryFor("merge", runSliceAfterCrit);

      type MergeValue = { text: string; uses: string[] };
      const attemptByAgent = new Map(roundAttempts.map((attempt) => [attempt.agentId, attempt] as const));
      const explorerA = attemptByAgent.get("explorer_a");
      const explorerB = attemptByAgent.get("explorer_b");
      const explorerC = attemptByAgent.get("explorer_c");
      const criticPodUses = [
        !skipLemma && lemmaOutput.trim() ? lemmaId : undefined,
        ...critiques.map((c) => c.id),
        ...patches.map((p) => p.id),
      ].filter((value): value is string => Boolean(value));
      const leafOutputs: Record<string, MergeValue> = {
        A: {
          text: explorerA?.content ?? "",
          uses: explorerA?.id ? [explorerA.id] : [],
        },
        B: {
          text: explorerB?.content ?? "",
          uses: explorerB?.id ? [explorerB.id] : [],
        },
        C: {
          text: explorerC?.content ?? "",
          uses: explorerC?.id ? [explorerC.id] : [],
        },
        D: {
          text: [
            lemmaOutput.trim(),
            ...critiques.map((c) => c.content.trim()),
            ...patches.map((p) => p.content.trim()),
          ].filter(Boolean).join("\n\n"),
          uses: criticPodUses,
        },
      };

      const mergePair = async (left: MergeValue, right: MergeValue, node: BracketTree): Promise<MergeValue> => {
        await agentStatus("synthesizer", "running", "merge", round);
        const mergePrompt = renderPrompt(prompts.user.merge_pair ?? "", {
          problem: problemText,
          memory: memoryMerge ? `Memory:\n${memoryMerge}` : "",
          left: left.text,
          right: right.text,
          left_bracket: bracketString(node[0]),
          right_bracket: bracketString(node[1]),
          bracket: bracketString(node),
        });
        await emitPromptContext({
          agentId: "synthesizer",
          phase: "merge",
          title: `Merge pair ${bracketString(node)}`,
          round,
          content: mergePrompt,
        });
        const merged = await callWithStructuredRetries({
          llmText,
          system: prompts.system.synthesizer ?? "",
          user: mergePrompt,
          parse: parseMergePayload,
          retries: structuredRetries,
        });
        const content = formatMergePayload(merged.value);
        const uses = [...new Set([...left.uses, ...right.uses])];
        await emit({
          type: "summary.made",
          runId,
          claimId: claimId(`merge_r${round}`),
          agentId: "synthesizer",
          bracket: bracketString(node),
          content,
          uses,
        });
        await agentStatus("synthesizer", "done", "merge", round);
        return { text: content, uses };
      };

      const mergeLeaves = async (node: BracketTree): Promise<MergeValue> => {
        const leaves = collectLeaves(node);
        const entries = leaves.map((leaf) => leafOutputs[leaf] ?? { text: "", uses: [] });
        const payload = leaves
          .map((leaf, idx) => `${leaf}:\n${entries[idx]?.text ?? ""}`)
          .join("\n\n");
        const uses = [...new Set(entries.flatMap((entry) => entry.uses))];
        await agentStatus("synthesizer", "running", "merge", round);
        const mergePrompt = renderPrompt(prompts.user.merge_leaves ?? "", {
          problem: problemText,
          memory: memoryMerge ? `Memory:\n${memoryMerge}` : "",
          payload,
          bracket: bracketString(node),
        });
        await emitPromptContext({
          agentId: "synthesizer",
          phase: "merge",
          title: `Merge leaves ${bracketString(node)}`,
          round,
          content: mergePrompt,
        });
        const merged = await callWithStructuredRetries({
          llmText,
          system: prompts.system.synthesizer ?? "",
          user: mergePrompt,
          parse: parseMergePayload,
          retries: structuredRetries,
        });
        const content = formatMergePayload(merged.value);
        await emit({
          type: "summary.made",
          runId,
          claimId: claimId(`merge_r${round}`),
          agentId: "synthesizer",
          bracket: bracketString(node),
          content,
          uses,
        });
        await agentStatus("synthesizer", "done", "merge", round);
        return { text: content, uses };
      };

      const solveNode = async (node: BracketTree, depth: number): Promise<MergeValue> => {
        if (typeof node === "string") return leafOutputs[node] ?? { text: "", uses: [] };
        if (depth <= 1) return mergeLeaves(node);
        const left = await solveNode(node[0], depth - 1);
        const right = await solveNode(node[1], depth - 1);
        return mergePair(left, right, node);
      };

      if (skipMerge) {
        summaryText = [attemptText, lemmaOutput].filter(Boolean).join("\n\n");
      } else {
        const tree = treeForBracket(currentBracket);
        const merged = await solveNode(tree, maxDepth);
        summaryText = merged.text;
      }
      if (await checkAbort(`round-${round}-merge`)) return;

      const chainAfterRound = await loadCombinedChain();
      const runSlice = sliceTheoremChain(chainAfterRound, runId);
      const mergeCtx = {
        chain: runSlice,
        round,
        branchThreshold,
        currentBracket,
      } as const;
      const mergeEvidence = theoremMergePolicy.evidence(mergeCtx);
      await emit({
        type: "merge.evidence.computed",
        runId,
        agentId: "orchestrator",
        mergePolicyId: theoremMergePolicy.id,
        mergePolicyVersion: theoremMergePolicy.version,
        note: mergeEvidence.note,
      });
      const mergeScored = theoremMergePolicy
        .candidates(mergeCtx)
        .map((candidate) => ({
          candidate,
          score: theoremMergePolicy.score(candidate, mergeEvidence, mergeCtx),
        }));
      for (const scored of mergeScored) {
        await emit({
          type: "merge.candidate.scored",
          runId,
          agentId: "orchestrator",
          mergePolicyId: theoremMergePolicy.id,
          candidateId: scored.candidate.id,
          score: scored.score,
        });
      }

      const evidence = evaluateRoundRebracketEvidence(runSlice, round, branchThreshold);
      let mergeReason = "rotation skipped";
      if (evidence.shouldRebracket) {
        const rotation = pickBestBracket(runSlice, currentBracket);
        currentBracket = rotation.bracket;
        mergeReason = rotation.note;
        await emit({
          type: "rebracket.applied",
          runId,
          agentId: "orchestrator",
          bracket: rotation.bracket,
          score: evidence.score,
          note: `${rotation.note}; ${evidence.note}${memoryTruncated ? "; memory truncated" : "; memory stable"}`,
        });
      } else {
        await emit({
          type: "rebracket.applied",
          runId,
          agentId: "orchestrator",
          bracket: currentBracket,
          score: evidence.score,
          note: `Rotation skipped (${evidence.note}${memoryTruncated ? "; memory truncated" : "; memory stable"})`,
        });
      }
      await emit({
        type: "merge.applied",
        runId,
        agentId: "orchestrator",
        mergePolicyId: theoremMergePolicy.id,
        mergePolicyVersion: theoremMergePolicy.version,
        candidateId: currentBracket,
        reason: mergeReason,
      });

      if (stopAfterRound) break;
    }

    if (await checkAbort("finalize")) return;

    const endMarker = "END_OF_PROOF";
    const finalId = claimId("solution");
    const synth = prompts.system.synthesizer ?? "";
    const verifierSys = prompts.system.verifier ?? "";

    const trimProof = (text: string): { content: string; gaps: string[]; confidence: number } => {
      let confidence = 0.5;
      const confLine = text.split("\n").find((line) => line.toLowerCase().startsWith("confidence:"));
      if (confLine) {
        const value = Number(confLine.replace(/confidence:/i, "").trim());
        if (!Number.isNaN(value)) confidence = Math.max(0, Math.min(1, value));
      }
      const trimmed = text.includes(endMarker)
        ? text.split(endMarker)[0].trim()
        : text.trim();
      const gaps = text.includes(endMarker) ? [] : ["Missing END_OF_PROOF marker"];
      return { content: trimmed, gaps, confidence };
    };

    const verifyProof = async (proof: string): Promise<{
      readonly status: "valid" | "needs" | "false";
      readonly report: string;
      readonly evidence?: TheoremAxiomEvidence;
      readonly verifiedContent?: string;
    }> => {
      await agentStatus("verifier", "running", "verify", rounds);
      const verifyPrompt = renderPrompt(prompts.user.verify ?? "", { proof });
      await emitPromptContext({
        agentId: "verifier",
        phase: "verify",
        title: "Verify proof",
        round: rounds,
        content: verifyPrompt,
      });
      const verifyResult = await callWithStructuredRetries({
        llmText,
        system: verifierSys,
        user: verifyPrompt,
        parse: parseVerifyPayload,
        retries: structuredRetries,
      });
      let verifyOutput = formatVerifyPayload(verifyResult.value);
      const verifyAxiomRequest = withAxiomDefaults(verifyResult.value.axiom, {
        phase: "verify",
        content: proof,
        notes: verifyResult.value.notes,
      })
        ?? (axiomPolicy === "required"
          ? buildForcedAxiomTask({
              phase: "verify",
              agentId: "verifier",
              round: rounds,
              content: proof,
              notes: verifyResult.value.notes,
            })
          : undefined);
      const axiomResult = await runAxiomDelegate({
        request: verifyAxiomRequest,
        agentId: "verifier",
        round: rounds,
        phase: "verify",
        targetClaimId: finalId,
      });
      if (axiomResult.summary) {
        verifyOutput = `${verifyOutput}\n\nAXIOM Worker:\n${axiomResult.summary}`.trim();
      }
      await agentStatus("verifier", "done", "verify", rounds);
      const finalVerifyEvidence = [...axiomResult.evidence].reverse().find((item) =>
        item.phase === "verify" && (item.tool === "lean.verify" || item.tool === "lean.verify_file")
      );
      let verifiedContent = axiomResult.verifiedCandidateContent;
      let status = verifyResult.value.status;

      if (axiomPolicy === "required") {
        if (!finalVerifyEvidence) {
          status = "needs";
          verifyOutput = `${verifyOutput}\n\nAXIOM verification evidence missing: final queued subrun did not emit successful lean.verify evidence.`.trim();
        } else if (!finalVerifyEvidence.ok) {
          status = verifyResult.value.status === "false" ? "false" : "needs";
        } else if (
          !verifiedContent
          || !axiomResult.verifiedCandidateHash
          || hashText(verifiedContent) !== axiomResult.verifiedCandidateHash
          || finalVerifyEvidence.candidateHash !== axiomResult.verifiedCandidateHash
          || finalVerifyEvidence.formalStatementHash !== axiomResult.verifiedFormalStatementHash
        ) {
          status = "needs";
          verifiedContent = undefined;
          verifyOutput = `${verifyOutput}\n\nAXIOM artifact mismatch: verified candidate hash or formal-statement hash did not match the merged theorem artifact.`.trim();
        } else {
          status = "valid";
        }
      } else if (finalVerifyEvidence?.ok && verifiedContent && axiomResult.verifiedCandidateHash === hashText(verifiedContent)) {
        status = "valid";
      }

      await emit({
        type: "verification.report",
        runId,
        agentId: "verifier",
        status,
        content: verifyOutput.trim(),
        evidence: finalVerifyEvidence,
      });
      return {
        status,
        report: verifyOutput.trim(),
        evidence: finalVerifyEvidence,
        verifiedContent,
      };
    };

    const passKRaw = Number.parseInt(process.env.THEOREM_PASS_K ?? "2", 10);
    const passK = clampNumber(Number.isFinite(passKRaw) ? passKRaw : 2, 1, 4);
    const finalPrompt = renderPrompt(prompts.user.final ?? "", {
      problem: problemText,
      summary: summaryText ? `Summary:\n${summaryText}` : "",
    });

    await agentStatus("synthesizer", "running", "final", rounds, `pass@k=${passK}`);
    const candidateRuns: Array<{
      content: string;
      gaps: string[];
      confidence: number;
      verify: {
        status: "valid" | "needs" | "false";
        report: string;
        evidence?: TheoremAxiomEvidence;
        verifiedContent?: string;
      };
    }> = [];
    const statusScore = (status: "valid" | "needs" | "false"): number =>
      status === "valid" ? 2 : status === "needs" ? 1 : 0;

    for (let k = 0; k < passK; k += 1) {
      const candidatePrompt = passK > 1
        ? `${finalPrompt}\n\nCandidate ${k + 1}/${passK}: prefer a distinct valid route if possible.`
        : finalPrompt;
      await emitPromptContext({
        agentId: "synthesizer",
        phase: "final",
        title: passK > 1 ? `Final proof candidate ${k + 1}/${passK}` : "Final proof",
        round: rounds,
        content: candidatePrompt,
      });
      const finalResult = await callWithStructuredRetries({
        llmText,
        system: synth,
        user: candidatePrompt,
        parse: parseProofPayload,
        retries: structuredRetries,
      });
      const proofText = formatProofPayload(finalResult.value);
      const trimmed = trimProof(proofText);
      const verify = await verifyProof(trimmed.content);
      candidateRuns.push({
        content: verify.verifiedContent ?? trimmed.content,
        gaps: trimmed.gaps,
        confidence: trimmed.confidence,
        verify,
      });
    }
    await agentStatus("synthesizer", "done", "final", rounds, `pass@k=${passK}`);

    candidateRuns.sort((a, b) =>
      statusScore(b.verify.status) - statusScore(a.verify.status)
      || b.confidence - a.confidence
    );
    const bestCandidate = candidateRuns[0];
    if (!bestCandidate) {
      throw new Error("No final proof candidate generated");
    }
    let { content, gaps, confidence, verify } = bestCandidate;

    const maxVerifyRounds = 3;
    for (let i = 0; i < maxVerifyRounds && verify.status !== "valid"; i += 1) {
      await agentStatus("synthesizer", "running", "revise", rounds);
      const verifyReport = `${verify.report}\n\nRequirements:\n- Address each verifier note explicitly.\n- Add a short \"Resolution checklist\" section mapping each note to the fix.\n- If a note cannot be resolved, add a GAP with the reason.\n- Keep the same format and end with END_OF_PROOF.`;
      const revisePrompt = renderPrompt(prompts.user.revise ?? "", {
        problem: problemText,
        verify_report: verifyReport,
        proof: content,
      });
      await emitPromptContext({
        agentId: "synthesizer",
        phase: "revise",
        title: "Revise proof",
        round: rounds,
        targetClaimId: finalId,
        content: revisePrompt,
      });
      const revised = await callWithStructuredRetries({
        llmText,
        system: synth,
        user: revisePrompt,
        parse: parseProofPayload,
        retries: structuredRetries,
      });
      await agentStatus("synthesizer", "done", "revise", rounds);
      const next = trimProof(formatProofPayload(revised.value));
      content = next.content;
      gaps = next.gaps;
      confidence = next.confidence;
      await emit({
        type: "patch.applied",
        runId,
        claimId: claimId("solution_patch"),
        agentId: "synthesizer",
        targetClaimId: finalId,
        content,
      });
      verify = await verifyProof(content);
      if (verify.verifiedContent) {
        content = verify.verifiedContent;
      }
    }

    const mergedGaps = verify.status === "valid"
      ? gaps
      : [...gaps, `Verifier status: ${verify.status}`];
    await emit({
      type: "solution.finalized",
      runId,
      agentId: "synthesizer",
      content,
      confidence,
      gaps: mergedGaps,
    });
    const noteLine = verify.report.split("\n").find((line) => line.toLowerCase().startsWith("notes:"));
    const failureDetail = noteLine ? noteLine.replace(/notes:/i, "").trim() : `Verifier status: ${verify.status}`;
    const note = verify.status === "valid"
      ? undefined
      : `Final verification failed: ${failureDetail}`;
    const terminalVerificationFailure = axiomPolicy === "required" && verify.status !== "valid";
    if (terminalVerificationFailure) {
      const failureClass = classifyTheoremFailure({
        status: verify.status,
        content: verify.report,
        evidence: verify.evidence,
        updatedAt: ctx.now(),
      }, axiomPolicy === "required") ?? "verification_failed";
      await emitFailure({
        stage: "verification",
        failureClass,
        message: note ?? `Final verification failed: ${verify.status}`,
        details: verify.report,
        retryable: true,
        evidence: verify.evidence ? { ...verify.evidence } : undefined,
      });
    }
    await emit({
      type: "run.status",
      runId,
      status: terminalVerificationFailure ? "failed" : "completed",
      agentId: "orchestrator",
      note,
    });
  },
};

const THEOREM_RECEIPT_RUNTIME = defineAgent<
  TheoremCmd,
  TheoremWorkflowDeps,
  TheoremEvent,
  TheoremState,
  TheoremWorkflowConfig
>({
  id: THEOREM_WORKFLOW_ID,
  version: THEOREM_WORKFLOW_VERSION,
  reducer: reduceTheorem,
  initial: initialTheorem,
  lifecycle: {
    init: THEOREM_LIFECYCLE.init,
    resume: THEOREM_LIFECYCLE.resume,
    shouldIndex: THEOREM_LIFECYCLE.shouldIndex,
  },
  run: THEOREM_WORKFLOW.run,
});

// ============================================================================
// Public run entry
// ============================================================================

export const runTheoremGuild = async (input: TheoremRunInput): Promise<TheoremRunResult> => {
  const now = input.now ?? Date.now;
  const baseStream = input.stream;
  const runStream = input.runStream ?? theoremRunStream(baseStream, input.runId);
  const emitRun = createQueuedEmitter({
    runtime: input.runtime,
    stream: runStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as TheoremCmd),
    onEmit: () => input.broadcast?.(),
    onError: (err) => console.error("theorem emit failed", err),
  });
  const emitIndex = createQueuedEmitter({
    runtime: input.runtime,
    stream: baseStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as TheoremCmd),
    onError: (err) => console.error("theorem index emit failed", err),
  });

  try {
    await runDefinedAgent({
      spec: THEOREM_RECEIPT_RUNTIME,
      ctx: {
        stream: runStream,
        runId: input.runId,
        emit: emitRun,
        now,
        runtime: input.runtime,
        prompts: input.prompts,
        llmText: input.llmText,
        model: input.model,
        promptHash: input.promptHash,
        promptPath: input.promptPath,
        apiReady: input.apiReady,
        apiNote: input.apiNote,
        emitIndex,
        control: input.control,
        axiomDelegate: input.axiomDelegate,
        axiomPolicy: input.axiomPolicy,
        axiomConfig: input.axiomConfig,
      },
      config: { ...input.config, problem: input.problem },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    const failureReportEvent: TheoremEvent = {
      type: "failure.report",
      runId: input.runId,
      agentId: "orchestrator",
      failure: {
        stage: "runtime",
        failureClass: "runtime_error",
        message,
        retryable: true,
      },
    };
    await emitRun(failureReportEvent);
    await emitIndex(failureReportEvent);
    const statusEvent: TheoremEvent = {
      type: "run.status",
      runId: input.runId,
      status: "failed",
      agentId: "orchestrator",
      note: message,
    };
    await emitRun(statusEvent);
    await emitIndex(statusEvent);
  }
  const state = await input.runtime.state(runStream);
  return buildTheoremRunResult({
    runId: input.runId,
    stream: baseStream,
    runStream,
    state,
    requiresFinalAxiomVerify: input.axiomPolicy === "required",
  });
};

// ============================================================================
// Re-exports for server/views
// ============================================================================

export {
  THEOREM_WORKFLOW_ID,
  THEOREM_WORKFLOW_VERSION,
  THEOREM_TEAM,
  THEOREM_EXAMPLES,
  buildTheoremRuns,
  buildTheoremSteps,
  getLatestTheoremRunId,
  sliceTheoremChain,
  sliceTheoremChainByStep,
  type TheoremRunSummary,
};
