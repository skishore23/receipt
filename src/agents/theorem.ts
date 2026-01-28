// ============================================================================
// Theorem Guild workflow - Receipt-native mini framework
// ============================================================================

import { createHash } from "node:crypto";

import type { Runtime } from "../core/runtime.js";
import type { TheoremCmd, TheoremEvent, TheoremState } from "../modules/theorem.js";
import { renderPrompt, type TheoremPromptConfig } from "../prompts/theorem.js";

import { createQueuedEmitter, runWorkflow, type WorkflowSpec } from "./workflow.js";
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
import { buildMemorySlice, memoryBudget, type MemoryPhase } from "./theorem.memory.js";

// ============================================================================
// Types
// ============================================================================

export type TheoremRunConfig = {
  readonly rounds: number;
  readonly maxDepth: number;
  readonly memoryWindow: number;
  readonly branchThreshold: number;
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
};

export type TheoremRunInput = {
  readonly stream: string;
  readonly runId: string;
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
// Prompt hash (reproducibility)
// ============================================================================

const sortKeys = (x: unknown): unknown => {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x as object).sort()) {
    out[k] = sortKeys((x as Record<string, unknown>)[k]);
  }
  return out;
};

export const hashTheoremPrompts = (prompts: TheoremPromptConfig): string =>
  createHash("sha256")
    .update(JSON.stringify(sortKeys(prompts)))
    .digest("hex");

// ============================================================================
// Workflow spec
// ============================================================================

const THEOREM_WORKFLOW: WorkflowSpec<TheoremWorkflowDeps, TheoremWorkflowConfig, TheoremEvent> = {
  id: THEOREM_WORKFLOW_ID,
  version: THEOREM_WORKFLOW_VERSION,
  run: async (ctx, config) => {
    const { runtime, prompts, llmText, model, promptHash, promptPath, apiReady, apiNote } = ctx;
    const { rounds, maxDepth, memoryWindow, branchThreshold, problem } = config;
    const runId = ctx.runId;

    const claimId = (prefix: string) => `${prefix}_${ctx.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const agentStatus = async (
      agentId: string,
      status: "running" | "idle" | "done",
      phase?: string,
      round?: number,
      note?: string
    ) => ctx.emit({ type: "agent.status", runId, agentId, status, phase, round, note });

    await ctx.emit({ type: "problem.set", runId, problem, agentId: "orchestrator" });
    await ctx.emit({
      type: "run.configured",
      runId,
      agentId: "orchestrator",
      workflow: { id: THEOREM_WORKFLOW_ID, version: THEOREM_WORKFLOW_VERSION },
      config: { rounds, depth: maxDepth, memoryWindow, branchThreshold },
      model,
      promptHash,
      promptPath,
    });

    if (!apiReady) {
      await ctx.emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: apiNote ?? "OPENAI_API_KEY not set",
      });
      await ctx.emit({
        type: "solution.finalized",
        runId,
        agentId: "orchestrator",
        content: apiNote ?? "OPENAI_API_KEY not set",
        confidence: 0,
        gaps: ["Missing OPENAI_API_KEY"],
      });
      return;
    }

    let currentBracket = "(((A o B) o C) o D)";
    await ctx.emit({
      type: "rebracket.applied",
      runId,
      agentId: "orchestrator",
      bracket: currentBracket,
      score: 0,
      note: "Initial bracket seed",
    });
    await ctx.emit({
      type: "run.status",
      runId,
      status: "running",
      agentId: "orchestrator",
      note: `Round 1/${rounds}`,
    });

    const explorers = THEOREM_TEAM.filter((a) => a.id.startsWith("explorer"));
    const branchByAgent = new Map<string, string>();
    let branchesEnabled = false;

    let summaryText = "";

    for (let round = 1; round <= rounds; round += 1) {
      await ctx.emit({
        type: "run.status",
        runId,
        status: "running",
        agentId: "orchestrator",
        note: `Round ${round}/${rounds}`,
      });

      const chainBefore = await runtime.chain(ctx.stream);
      const runSliceBefore = sliceTheoremChain(chainBefore, runId);
      const memoryFor = (phase: MemoryPhase, chain: typeof runSliceBefore, targetClaimId?: string) =>
        buildMemorySlice(chain, {
          phase,
          window: memoryWindow,
          maxChars: memoryBudget(memoryWindow, phase),
          targetClaimId,
        });
      const memoryAttempt = memoryFor("attempt", runSliceBefore);
      const memoryLemma = memoryFor("lemma", runSliceBefore);

      await ctx.emit({
        type: "phase.parallel",
        runId,
        phase: "attempt",
        agents: explorers.map((a) => a.id),
        round,
      });
      await Promise.all(explorers.map((agent) => agentStatus(agent.id, "running", "attempt", round)));
      const roundAttempts = await Promise.all(explorers.map(async (agent) => {
        const attemptId = claimId(`attempt_r${round}`);
        const memoryBlock = memoryAttempt ? `Memory:\n${memoryAttempt}` : "";
        const summaryBlock = summaryText ? `Latest summary:\n${summaryText}` : "";
        const prompt = renderPrompt(prompts.user.attempt ?? "", {
          problem,
          memory: memoryBlock,
          summary: summaryBlock,
        });

        const output = await llmText({ system: prompts.system[agent.id] ?? "", user: prompt });
        const content = output.trim().length ? output : "No output.";
        const attemptEvent: TheoremEvent = {
          type: "attempt.proposed",
          runId,
          claimId: attemptId,
          agentId: agent.id,
          content,
        };
        await ctx.emit(attemptEvent);
        const branchName = branchByAgent.get(agent.id);
        if (branchName) {
          await runtime.execute(branchName, { type: "emit", event: attemptEvent } as TheoremCmd);
        }
        await agentStatus(agent.id, "done", "attempt", round);
        return { id: attemptId, agentId: agent.id, content };
      }));

      const attemptText = roundAttempts.map((a) => `# ${a.agentId}\n${a.content}`).join("\n\n");

      const lemmaId = claimId(`lemma_r${round}`);
      await agentStatus("lemma_miner", "running", "lemma", round);
      const lemmaPrompt = renderPrompt(prompts.user.lemma ?? "", {
        problem,
        memory: memoryLemma ? `Memory:\n${memoryLemma}` : "",
        attempts: attemptText,
      });
      const lemmaOutput = await llmText({
        system: prompts.system.lemma_miner ?? "",
        user: lemmaPrompt,
      });
      await ctx.emit({
        type: "lemma.proposed",
        runId,
        claimId: lemmaId,
        agentId: "lemma_miner",
        content: lemmaOutput.trim().length ? lemmaOutput : "No lemmas produced.",
      });
      await agentStatus("lemma_miner", "done", "lemma", round);

      const patches: Array<{ targetId: string; content: string }> = [];

      await ctx.emit({
        type: "phase.parallel",
        runId,
        phase: "critique",
        agents: roundAttempts.map((a) => a.agentId),
        round,
      });
      await agentStatus("skeptic", "running", "critique", round);
      const critiques = await Promise.all(roundAttempts.map(async (attempt) => {
        const critiqueId = claimId(`critique_r${round}`);
        const memoryCritique = memoryFor("critique", runSliceBefore, attempt.id);
        const critiquePrompt = renderPrompt(prompts.user.critique ?? "", {
          problem,
          memory: memoryCritique ? `Memory:\n${memoryCritique}` : "",
          attempt: attempt.content,
        });
        const critique = await llmText({
          system: prompts.system.skeptic ?? "",
          user: critiquePrompt,
        });
        const critiqueContent = critique.trim().length ? critique : "No critique.";
        await ctx.emit({
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

      if (!branchesEnabled) {
        const critiqueSignals = critiques.filter((c) =>
          /gap|invalid|counterexample|contradiction/i.test(c.content)
        ).length;
        if (critiqueSignals >= branchThreshold) {
          branchesEnabled = true;
          const forkPoint = (await runtime.chain(ctx.stream)).length;
          for (const agent of explorers) {
            const branchName = `${runId}:${agent.id}:r${round}`;
            await runtime.fork(ctx.stream, forkPoint, branchName);
            branchByAgent.set(agent.id, branchName);
            await ctx.emit({
              type: "branch.created",
              runId,
              branchId: branchName,
              forkAt: forkPoint,
              note: `Branch triggered after critiques (r${round})`,
            });
          }
        }
      }

      await ctx.emit({
        type: "phase.parallel",
        runId,
        phase: "patch",
        agents: roundAttempts.map((a) => a.agentId),
        round,
      });
      await agentStatus("verifier", "running", "patch", round);
      await Promise.all(roundAttempts.map(async (attempt) => {
        const patchId = claimId(`patch_r${round}`);
        const memoryPatch = memoryFor("patch", runSliceBefore, attempt.id);
        const patchPrompt = renderPrompt(prompts.user.patch ?? "", {
          problem,
          memory: memoryPatch ? `Memory:\n${memoryPatch}` : "",
          attempt: attempt.content,
          critiques: critiques.map((c) => c.content).join("\n"),
        });
        const patch = await llmText({
          system: prompts.system.verifier ?? "",
          user: patchPrompt,
        });
        const patchContent = patch.trim().length ? patch : "No patch.";
        patches.push({ targetId: attempt.id, content: patchContent });
        await ctx.emit({
          type: "patch.applied",
          runId,
          claimId: patchId,
          agentId: "verifier",
          targetClaimId: attempt.id,
          content: patchContent,
        });
      }));
      await agentStatus("verifier", "done", "patch", round);

      const chainAfterCrit = await runtime.chain(ctx.stream);
      const runSliceAfterCrit = sliceTheoremChain(chainAfterCrit, runId);
      const memoryMerge = memoryFor("merge", runSliceAfterCrit);

      const leafOutputs: Record<string, string> = {
        A: roundAttempts.find((a) => a.agentId === "explorer_a")?.content ?? "",
        B: roundAttempts.find((a) => a.agentId === "explorer_b")?.content ?? "",
        C: roundAttempts.find((a) => a.agentId === "explorer_c")?.content ?? "",
        D: [
          lemmaOutput.trim(),
          ...critiques.map((c) => c.content.trim()),
          ...patches.map((p) => p.content.trim()),
        ].filter(Boolean).join("\n\n"),
      };

      const mergePair = async (left: string, right: string, node: BracketTree): Promise<string> => {
        await agentStatus("synthesizer", "running", "merge", round);
        const mergePrompt = renderPrompt(prompts.user.merge_pair ?? "", {
          problem,
          memory: memoryMerge ? `Memory:\n${memoryMerge}` : "",
          left,
          right,
          left_bracket: bracketString(node[0]),
          right_bracket: bracketString(node[1]),
          bracket: bracketString(node),
        });
        const merged = await llmText({
          system: prompts.system.synthesizer ?? "",
          user: mergePrompt,
        });
        const content = merged.trim().length ? merged : `${left}\n\n${right}`.trim();
        await ctx.emit({
          type: "summary.made",
          runId,
          claimId: claimId(`merge_r${round}`),
          agentId: "synthesizer",
          bracket: bracketString(node),
          content,
        });
        await agentStatus("synthesizer", "done", "merge", round);
        return content;
      };

      const mergeLeaves = async (node: BracketTree): Promise<string> => {
        const leaves = collectLeaves(node);
        const payload = leaves.map((leaf) => `${leaf}:\n${leafOutputs[leaf] ?? ""}`).join("\n\n");
        await agentStatus("synthesizer", "running", "merge", round);
        const mergePrompt = renderPrompt(prompts.user.merge_leaves ?? "", {
          problem,
          memory: memoryMerge ? `Memory:\n${memoryMerge}` : "",
          payload,
          bracket: bracketString(node),
        });
        const merged = await llmText({
          system: prompts.system.synthesizer ?? "",
          user: mergePrompt,
        });
        const content = merged.trim().length ? merged : payload.trim();
        await ctx.emit({
          type: "summary.made",
          runId,
          claimId: claimId(`merge_r${round}`),
          agentId: "synthesizer",
          bracket: bracketString(node),
          content,
        });
        await agentStatus("synthesizer", "done", "merge", round);
        return content;
      };

      const solveNode = async (node: BracketTree, depth: number): Promise<string> => {
        if (typeof node === "string") return leafOutputs[node] ?? "";
        if (depth <= 1) return mergeLeaves(node);
        const left = await solveNode(node[0], depth - 1);
        const right = await solveNode(node[1], depth - 1);
        return mergePair(left, right, node);
      };

      const tree = treeForBracket(currentBracket);
      summaryText = await solveNode(tree, maxDepth);

      const chainAfterRound = await runtime.chain(ctx.stream);
      const runSlice = sliceTheoremChain(chainAfterRound, runId);
      const rotation = pickBestBracket(runSlice, currentBracket);
      currentBracket = rotation.bracket;
      await ctx.emit({
        type: "rebracket.applied",
        runId,
        agentId: "orchestrator",
        bracket: rotation.bracket,
        score: rotation.score,
        note: rotation.note,
      });
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
      const verifyOutput = await llmText({
        system: verifierSys,
        user: renderPrompt(prompts.user.verify ?? "", { proof }),
      });
      await agentStatus("verifier", "done", "verify", rounds);
      const statusLine = verifyOutput.split("\n").find((line) => line.toLowerCase().startsWith("status:"));
      let status: "valid" | "needs" | "false" = "needs";
      if (statusLine) {
        const val = statusLine.replace(/status:/i, "").trim().toLowerCase();
        if (val.startsWith("valid")) status = "valid";
        else if (val.startsWith("false")) status = "false";
        else status = "needs";
      }
      await ctx.emit({
        type: "verification.report",
        runId,
        agentId: "verifier",
        status,
        content: verifyOutput.trim(),
      });
      return { status, report: verifyOutput.trim() };
    };

    await agentStatus("synthesizer", "running", "final", rounds);
    let proofText = await llmText({
      system: synth,
      user: renderPrompt(prompts.user.final ?? "", {
        problem,
        summary: summaryText ? `Summary:\n${summaryText}` : "",
      }),
    });
    await agentStatus("synthesizer", "done", "final", rounds);

    let { content, gaps, confidence } = trimProof(proofText);
    let verify = await verifyProof(content);

    const maxVerifyRounds = 2;
    for (let i = 0; i < maxVerifyRounds && verify.status !== "valid"; i += 1) {
      await agentStatus("synthesizer", "running", "revise", rounds);
      const revised = await llmText({
        system: synth,
        user: renderPrompt(prompts.user.revise ?? "", {
          problem,
          verify_report: verify.report,
          proof: content,
        }),
      });
      await agentStatus("synthesizer", "done", "revise", rounds);
      const next = trimProof(revised);
      content = next.content;
      gaps = next.gaps;
      confidence = next.confidence;
      await ctx.emit({
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
      : [...gaps, "Verifier flagged gaps"];
    await ctx.emit({
      type: "solution.finalized",
      runId,
      agentId: "synthesizer",
      content,
      confidence,
      gaps: mergedGaps,
    });
    await ctx.emit({ type: "run.status", runId, status: "completed", agentId: "orchestrator" });
  },
};

// ============================================================================
// Public run entry
// ============================================================================

export const runTheoremGuild = async (input: TheoremRunInput): Promise<void> => {
  const now = input.now ?? Date.now;
  const emit = createQueuedEmitter({
    runtime: input.runtime,
    stream: input.stream,
    wrap: (event) => ({ type: "emit", event } as TheoremCmd),
    onEmit: () => input.broadcast?.(),
    onError: (err) => console.error("theorem emit failed", err),
  });

  try {
    await runWorkflow(
      THEOREM_WORKFLOW,
      {
        stream: input.stream,
        runId: input.runId,
        emit,
        now,
        runtime: input.runtime,
        prompts: input.prompts,
        llmText: input.llmText,
        model: input.model,
        promptHash: input.promptHash,
        promptPath: input.promptPath,
        apiReady: input.apiReady,
        apiNote: input.apiNote,
      },
      { ...input.config, problem: input.problem }
    );
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    await emit({
      type: "run.status",
      runId: input.runId,
      status: "failed",
      agentId: "orchestrator",
      note: message,
    });
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
