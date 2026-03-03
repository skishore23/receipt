// ============================================================================
// Theorem Guild workflow - Receipt-native mini framework
// ============================================================================

import type { Runtime } from "../core/runtime.js";
import type { TheoremCmd, TheoremEvent, TheoremState } from "../modules/theorem.js";
import { reduce as reduceTheorem, initial as initialTheorem } from "../modules/theorem.js";
import { renderPrompt, type TheoremPromptConfig } from "../prompts/theorem.js";

import { createQueuedEmitter, type EmitFn, type RunLifecycle, type WorkflowSpec } from "../engine/runtime/workflow.js";
import { defineReceiptAgent, runReceiptAgent } from "../engine/runtime/receipt-runtime.js";
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
  fallbackAttemptPayload,
  fallbackCritiquePayload,
  fallbackLemmaPayload,
  fallbackMergePayload,
  fallbackOrchestratorDecision,
  fallbackPatchPayload,
  fallbackProofPayload,
  fallbackVerifyPayload,
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
  type ParsedOrchestratorDecision,
} from "./theorem.structured.js";
import { buildMemorySlice, memoryBudget, type MemoryPhase } from "./theorem.memory.js";
import { theoremBranchStream, theoremRunStream } from "./theorem.streams.js";

// ============================================================================
// Types
// ============================================================================

export type TheoremRunConfig = {
  readonly rounds: number;
  readonly maxDepth: number;
  readonly memoryWindow: number;
  readonly branchThreshold: number;
};

export const THEOREM_DEFAULT_CONFIG: TheoremRunConfig = {
  rounds: 2,
  maxDepth: 2,
  memoryWindow: 60,
  branchThreshold: 2,
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

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

export const parseTheoremConfig = (form: Record<string, string>): TheoremRunConfig => {
  const parseNum = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };

  return normalizeTheoremConfig({
    rounds: parseNum(form.rounds),
    maxDepth: parseNum(form.depth),
    memoryWindow: parseNum(form.memory),
    branchThreshold: parseNum(form.branch),
  });
};

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
    const { runtime, prompts, llmText, apiReady, apiNote } = ctx;
    const { rounds, maxDepth, memoryWindow, branchThreshold, problem: inputProblem } = config;
    const runId = ctx.runId;

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
    const problemText = (resume ? (ctx.state?.problem || inputProblem) : (inputProblem || ctx.state?.problem || "")).trim();

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

    const forkPoint = (await runtime.chain(ctx.stream)).length;
    for (const agentId of agentIds) {
      await ensureAgentBranch(agentId, forkPoint);
    }

    type PromptContextEvent = Extract<TheoremEvent, { type: "prompt.context" }>;
    const emitPromptContext = async (payload: Omit<PromptContextEvent, "type" | "runId">) => {
      await emit({ type: "prompt.context", runId, ...payload });
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
        fallback: fallbackOrchestratorDecision,
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
        const slice = buildMemorySlice(chain, {
          phase,
          window: memoryWindow,
          maxChars: memoryBudget(memoryWindow, phase),
          targetClaimId,
          bracket: currentBracket,
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
          fallback: fallbackAttemptPayload,
          retries: structuredRetries,
        });
        const content = formatAttemptPayload(attemptResult.value);
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
          fallback: fallbackLemmaPayload,
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
                fallback: fallbackCritiquePayload,
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
            fallback: fallbackPatchPayload,
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
          fallback: fallbackMergePayload,
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
          fallback: fallbackMergePayload,
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

      const chainAfterRound = await loadCombinedChain();
      const runSlice = sliceTheoremChain(chainAfterRound, runId);
      const evidence = evaluateRoundRebracketEvidence(runSlice, round, branchThreshold);
      if (evidence.shouldRebracket) {
        const rotation = pickBestBracket(runSlice, currentBracket);
        currentBracket = rotation.bracket;
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

      if (stopAfterRound) break;
    }

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

    const verifyProof = async (proof: string) => {
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
        fallback: fallbackVerifyPayload,
        retries: structuredRetries,
      });
      const verifyOutput = formatVerifyPayload(verifyResult.value);
      await agentStatus("verifier", "done", "verify", rounds);
      const status = verifyResult.value.status;
      await emit({
        type: "verification.report",
        runId,
        agentId: "verifier",
        status,
        content: verifyOutput.trim(),
      });
      return { status, report: verifyOutput.trim() };
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
      verify: { status: "valid" | "needs" | "false"; report: string };
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
        fallback: fallbackProofPayload,
        retries: structuredRetries,
      });
      const proofText = formatProofPayload(finalResult.value);
      const trimmed = trimProof(proofText);
      const verify = await verifyProof(trimmed.content);
      candidateRuns.push({
        content: trimmed.content,
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
        fallback: fallbackProofPayload,
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
    const note = verify.status === "valid"
      ? undefined
      : (noteLine ? noteLine.replace(/notes:/i, "").trim() : `Verifier status: ${verify.status}`);
    await emit({ type: "run.status", runId, status: "completed", agentId: "orchestrator", note });
  },
};

const THEOREM_RECEIPT_RUNTIME = defineReceiptAgent<
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

export const runTheoremGuild = async (input: TheoremRunInput): Promise<void> => {
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
    await runReceiptAgent({
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
      },
      config: { ...input.config, problem: input.problem },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    const failureEvent: TheoremEvent = {
      type: "run.status",
      runId: input.runId,
      status: "failed",
      agentId: "orchestrator",
      note: message,
    };
    await emitRun(failureEvent);
    await emitIndex(failureEvent);
  }
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
