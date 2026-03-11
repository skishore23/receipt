import type { AgentEvent } from "../../modules/agent.js";
import type { AgentFinalizer } from "../agent.js";
import type { AxiomRunConfig } from "./config.js";
import type { LocalLeanHarness } from "./local-lean.js";
import type { CandidateTracker } from "./state.js";
import { formatLocalToolOutput } from "./local-lean.js";

export const createAxiomFinalizer = (opts: {
  readonly defaults: AxiomRunConfig;
  readonly tracker: CandidateTracker;
  readonly localLean: LocalLeanHarness;
}): AgentFinalizer => async (ctx) => {
  const { defaults, tracker, localLean } = opts;

  if (defaults.requiredValidation?.kind === "axle-verify") {
    const chain = await ctx.runtime.chain(ctx.runStream);
    const verifyReceipts = chain.filter((receipt): receipt is typeof receipt & {
      body: Extract<AgentEvent, { type: "validation.report" }>;
    } => {
      const body = receipt.body;
      return body.type === "validation.report"
        && body.gate === "axle-verify"
        && (body.evidence?.tool === "lean.verify" || body.evidence?.tool === "lean.verify_file");
    });
    const latestVerify = verifyReceipts[verifyReceipts.length - 1];
    const successfulVerify = [...verifyReceipts].reverse().find((receipt) =>
      receipt.body.ok
      && typeof receipt.body.evidence?.candidateHash === "string"
      && receipt.body.evidence.candidateHash.length > 0
      && typeof receipt.body.evidence?.formalStatementHash === "string"
      && receipt.body.evidence.formalStatementHash.length > 0
    );

    if (!latestVerify) {
      const target = defaults.requiredValidation.formalStatementPath
        ? ` using ${defaults.requiredValidation.formalStatementPath}`
        : "";
      return {
        accept: false,
        note: `This task requires AXLE verification. Before finalizing, call lean.verify or lean.verify_file${target} so the run emits a real axle-verify validation report with candidate and formal-statement hashes; text-only success claims are insufficient.`,
      };
    }
    if (!latestVerify.body.ok) {
      return {
        accept: false,
        note: `AXLE verification ran and failed (${latestVerify.body.summary}). Repair the candidate, then rerun lean.verify or lean.verify_file before finalizing.`,
      };
    }
    if (!successfulVerify) {
      return {
        accept: false,
        note: "AXLE verification did not emit the required candidate and formal-statement hashes. Rerun lean.verify or lean.verify_file and keep the verified artifact unchanged before finalizing.",
      };
    }
  }

  if (defaults.localValidationMode === "off") return { accept: true };

  const candidate = await tracker.inferCandidateFromRun(ctx.runtime, ctx.runStream);
  if (!candidate) {
    const summary = "no Lean candidate file or content was found for local validation";
    await ctx.emit({
      type: "validation.report",
      runId: ctx.runId,
      iteration: ctx.iteration,
      agentId: "orchestrator",
      gate: "local-lean",
      ok: false,
      summary,
    });
    return defaults.localValidationMode === "require"
      ? { accept: false, note: summary }
      : { accept: true, text: `${ctx.text}\n\nLocal Lean validation skipped: ${summary}.` };
  }

  try {
    if (candidate.kind === "file") {
      const { runner, result } = await localLean.runOnFile(candidate.path, defaults.leanTimeoutSeconds);
      const ok = (result.code ?? 1) === 0 && !result.timedOut;
      await ctx.emit({
        type: "validation.report",
        runId: ctx.runId,
        iteration: ctx.iteration,
        agentId: "orchestrator",
        gate: "local-lean",
        ok,
        target: candidate.path,
        summary: ok ? `validated ${candidate.path} via ${runner.note}` : `validation failed for ${candidate.path}`,
        details: formatLocalToolOutput("lean.local.check_file", runner, result, [`path: ${candidate.path}`]).output,
      });
      if (!ok) {
        return { accept: false, note: `local Lean validation failed for ${candidate.path}` };
      }
      return { accept: true, text: `${ctx.text}\n\nLocal Lean validation passed on ${candidate.path}.` };
    }

    const { runner, result, rel } = await localLean.runOnContent(candidate.content, defaults.leanTimeoutSeconds);
    const ok = (result.code ?? 1) === 0 && !result.timedOut;
    await ctx.emit({
      type: "validation.report",
      runId: ctx.runId,
      iteration: ctx.iteration,
      agentId: "orchestrator",
      gate: "local-lean",
      ok,
      target: rel,
      summary: ok ? `validated scratch Lean content via ${runner.note}` : "validation failed for scratch Lean content",
      details: formatLocalToolOutput("lean.local.check", runner, result, [`scratch: ${rel}`]).output,
    });
    if (!ok) {
      return { accept: false, note: "local Lean validation failed for scratch Lean content" };
    }
    return { accept: true, text: `${ctx.text}\n\nLocal Lean validation passed on generated Lean content.` };
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    await ctx.emit({
      type: "validation.report",
      runId: ctx.runId,
      iteration: ctx.iteration,
      agentId: "orchestrator",
      gate: "local-lean",
      ok: false,
      summary,
    });
    return defaults.localValidationMode === "require"
      ? { accept: false, note: summary }
      : { accept: true, text: `${ctx.text}\n\nLocal Lean validation unavailable: ${summary}.` };
  }
};
