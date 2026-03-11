import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonBranchStore, jsonlStore } from "../adapters/jsonl.js";
import { jsonlQueue } from "../adapters/jsonl-queue.js";
import { axleTheoremToSorry } from "../adapters/axle.js";
import type { DelegationTools } from "../adapters/delegation.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import { llmStructured as openAiLlmStructured, llmText as openAiLlmText } from "../adapters/openai.js";
import { runAxiom, normalizeAxiomConfig, type AxiomRunInput } from "../agents/axiom.js";
import { runTheoremGuild, normalizeTheoremConfig, type TheoremAxiomDelegateResult } from "../agents/theorem.js";
import { theoremRunStream } from "../agents/theorem.streams.js";
import { agentRunStream } from "../agents/agent.streams.js";
import { createRuntime } from "../core/runtime.js";
import type { AgentCmd, AgentEvent, AgentState } from "../modules/agent.js";
import { decide as decideAgent, reduce as reduceAgent, initial as initialAgent } from "../modules/agent.js";
import type { JobCmd, JobEvent, JobState } from "../modules/job.js";
import { decide as decideJob, reduce as reduceJob, initial as initialJob } from "../modules/job.js";
import type { TheoremCmd, TheoremEvent, TheoremState } from "../modules/theorem.js";
import { decide as decideTheorem, reduce as reduceTheorem, initial as initialTheorem } from "../modules/theorem.js";
import { loadAxiomPrompts, type AxiomPromptConfig } from "../prompts/axiom.js";
import { loadTheoremPrompts, type TheoremPromptConfig } from "../prompts/theorem.js";
import type { JobExecutionContext, JobHandler } from "../engine/runtime/job-worker.js";

export type AxiomGuildBenchmarkCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type AxiomGuildBenchmarkResult = {
  readonly benchmarkId: string;
  readonly title: string;
  readonly passed: boolean;
  readonly runId: string;
  readonly stream: string;
  readonly workspaceRoot: string;
  readonly checks: ReadonlyArray<AxiomGuildBenchmarkCheck>;
};

export type AxiomGuildBenchmarkCase = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly referenceFile: string;
  readonly theoremName: string;
  readonly problem: string;
};

const hashText = (input: string): string =>
  createHash("sha256").update(input, "utf-8").digest("hex");

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const mkTheoremRuntime = (dir: string) => createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
  jsonlStore<TheoremEvent>(dir),
  jsonBranchStore(dir),
  decideTheorem,
  reduceTheorem,
  initialTheorem
);

const mkAgentRuntime = (dir: string) => createRuntime<AgentCmd, AgentEvent, AgentState>(
  jsonlStore<AgentEvent>(dir),
  jsonBranchStore(dir),
  decideAgent,
  reduceAgent,
  initialAgent
);

const mkJobRuntime = (dir: string) => createRuntime<JobCmd, JobEvent, JobState>(
  jsonlStore<JobEvent>(dir),
  jsonBranchStore(dir),
  decideJob,
  reduceJob,
  initialJob
);

const makeMemoryTools = (): MemoryTools => ({
  read: async () => [],
  search: async () => [],
  summarize: async () => ({ summary: "", entries: [] }),
  commit: async (input) => ({
    id: `mem_${Date.now().toString(36)}`,
    scope: input.scope,
    text: input.text,
    tags: input.tags,
    meta: input.meta,
    ts: Date.now(),
  }),
  diff: async () => [],
  reindex: async () => 0,
});

const makeDelegationTools = (): DelegationTools => ({
  "agent.delegate": async () => ({ output: "", summary: "" }),
  "agent.status": async () => ({ output: "", summary: "" }),
  "agent.inspect": async () => ({ output: "", summary: "" }),
});

export const AXIOM_GUILD_BENCHMARKS: ReadonlyArray<AxiomGuildBenchmarkCase> = [
  {
    id: "infinitely_many_primes",
    title: "Infinitely Many Primes",
    description: "Run the queued axiom-guild path against a real theorem and require final AXLE verify evidence.",
    referenceFile: "InfinitelyManyPrimes.lean",
    theoremName: "infinitely_many_primes",
    problem: [
      "In Lean 4 with Mathlib, prove this theorem:",
      "",
      "theorem infinitely_many_primes : ∀ n : Nat, ∃ p > n, Nat.Prime p := by",
      "  ...",
      "",
      "Use the theorem guild and let queued Axiom subjobs support the proof when useful.",
      "Do not finish unless final AXLE verification succeeds.",
    ].join("\n"),
  },
] as const;

export const getAxiomGuildBenchmarkCase = (id: string): AxiomGuildBenchmarkCase | undefined =>
  AXIOM_GUILD_BENCHMARKS.find((item) => item.id === id);

const buildAxiomJobHandler = (opts: {
  readonly runtime: ReturnType<typeof mkAgentRuntime>;
  readonly workspaceRoot: string;
  readonly prompts: AxiomPromptConfig;
  readonly llmText: typeof openAiLlmText;
  readonly llmStructured: AxiomRunInput["llmStructured"];
}): JobHandler =>
  async (job, _ctx: JobExecutionContext) => {
    const payload = job.payload as Record<string, unknown>;
    const configInput = typeof payload.config === "object" && payload.config
      ? payload.config as Record<string, unknown>
      : {};
    await runAxiom({
      stream: typeof payload.stream === "string" ? payload.stream : "agents/axiom",
      runId: typeof payload.runId === "string" ? payload.runId : `axiom_${Date.now().toString(36)}`,
      problem: typeof payload.problem === "string" ? payload.problem : "",
      config: normalizeAxiomConfig(configInput),
      runtime: opts.runtime,
      prompts: opts.prompts,
      llmText: opts.llmText,
      llmStructured: opts.llmStructured,
      model: process.env.OPENAI_MODEL ?? "gpt-5.2",
      apiReady: true,
      memoryTools: makeMemoryTools(),
      delegationTools: makeDelegationTools(),
      workspaceRoot: opts.workspaceRoot,
    });
    return { ok: true, result: { runId: payload.runId, stream: payload.stream } };
  };

const processQueuedAxiomJob = async (opts: {
  readonly queue: ReturnType<typeof jsonlQueue>;
  readonly jobId: string;
  readonly handler: JobHandler;
  readonly workerId: string;
  readonly leaseMs: number;
}): Promise<void> => {
  while (true) {
    const current = await opts.queue.getJob(opts.jobId);
    if (!current || current.status === "completed" || current.status === "failed" || current.status === "canceled") {
      return;
    }

    const leased = await opts.queue.leaseNext({
      workerId: opts.workerId,
      leaseMs: opts.leaseMs,
      agentId: current.agentId,
    });
    if (!leased) {
      return;
    }
    if (leased.id !== opts.jobId) {
      await opts.queue.fail(leased.id, opts.workerId, `unexpected leased job ${leased.id}`, true);
      continue;
    }

    const pullCommands = async (
      types?: ReadonlyArray<"steer" | "follow_up" | "abort">
    ) => opts.queue.consumeCommands(leased.id, types);

    const preAbort = await pullCommands(["abort"]);
    if (preAbort.length > 0 || leased.abortRequested) {
      await opts.queue.cancel(leased.id, "abort requested", opts.workerId);
      return;
    }

    await opts.queue.heartbeat(leased.id, opts.workerId, opts.leaseMs);

    try {
      const result = await opts.handler(leased, {
        workerId: opts.workerId,
        pullCommands,
      } as JobExecutionContext);
      const postAbort = await pullCommands(["abort"]);
      if (postAbort.length > 0) {
        await opts.queue.cancel(leased.id, "abort requested", opts.workerId);
        return;
      }
      if (result.ok) {
        await opts.queue.complete(leased.id, opts.workerId, result.result);
      } else {
        await opts.queue.fail(leased.id, opts.workerId, result.error ?? "job failed");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await opts.queue.fail(leased.id, opts.workerId, message);
    }
  }
};

const buildQueuedAxiomDelegate = (opts: {
  readonly queue: ReturnType<typeof jsonlQueue>;
  readonly agentRuntime: ReturnType<typeof mkAgentRuntime>;
  readonly handler: JobHandler;
  readonly workerId: string;
  readonly leaseMs: number;
}) => async (input: {
  readonly task: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}): Promise<TheoremAxiomDelegateResult> => {
  const runId = `bench_axiom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const stream = "agents/axiom";
  const created = await opts.queue.enqueue({
    agentId: "axiom",
    lane: "follow_up",
    sessionKey: `bench:axiom:${runId}`,
    singletonMode: "allow",
    maxAttempts: 2,
    payload: {
      kind: "axiom.run",
      stream,
      runId,
      problem: input.task,
      config: {
        maxIterations: 12,
        maxToolOutputChars: 6_000,
        memoryScope: "axiom",
        workspace: ".",
        leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
        leanTimeoutSeconds: 120,
        autoRepair: true,
        ...(input.config ?? {}),
      },
      isSubAgent: true,
    },
  });

  await processQueuedAxiomJob({
    queue: opts.queue,
    jobId: created.id,
    handler: opts.handler,
    workerId: opts.workerId,
    leaseMs: opts.leaseMs,
  });

  const settled = await opts.queue.waitForJob(created.id, input.timeoutMs ?? 180_000, 200);
  if (!settled) {
    return {
      jobId: created.id,
      runId,
      stream,
      status: "missing",
      outcome: "queue_timeout",
      summary: `Axiom subjob missing (${created.id}).`,
      evidence: [],
    };
  }

  const runChain = await opts.agentRuntime.chain(agentRunStream(stream, runId));
  const finalResponse = [...runChain].reverse().find((receipt) => receipt.body.type === "response.finalized") as
    | { body: Extract<AgentEvent, { type: "response.finalized" }> }
    | undefined;
  const finalStatus = [...runChain].reverse().find((receipt) => receipt.body.type === "run.status") as
    | { body: Extract<AgentEvent, { type: "run.status" }> }
    | undefined;
  const validations = runChain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
    receipt.body.type === "validation.report"
  );
  const toolCalls = runChain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.called" }> } =>
    receipt.body.type === "tool.called"
  );
  const leanTools = [...new Set(toolCalls
    .map((receipt) => receipt.body.tool)
    .filter((tool) => tool.startsWith("lean.")))];
  const axleValidations = validations.filter((receipt) =>
    receipt.body.gate.startsWith("axle")
    && receipt.body.evidence
  );
  const verifyValidations = axleValidations.filter((receipt) => {
    const tool = receipt.body.evidence?.tool;
    return tool === "lean.verify" || tool === "lean.verify_file";
  });
  const successfulVerify = [...verifyValidations].reverse().find((receipt) =>
    receipt.body.ok
    && receipt.body.evidence?.candidateHash
    && receipt.body.evidence?.formalStatementHash
  );
  const theoremToSorryFailure = [...toolCalls].reverse().find((receipt) =>
    (receipt.body.tool === "lean.theorem2sorry" || receipt.body.tool === "lean.theorem2sorry_file")
    && Boolean(receipt.body.error)
  );
  const latestValidation = validations[validations.length - 1];
  const evidence = axleValidations
    .map((receipt) => {
      const item = receipt.body.evidence;
      if (!item?.tool) return undefined;
      return {
        tool: item.tool,
        environment: item.environment,
        candidateHash: item.candidateHash,
        formalStatementHash: item.formalStatementHash,
        ok: receipt.body.ok,
        failedDeclarations: item.failedDeclarations ?? [],
        timings: item.timings,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const outcome = (() => {
    if (finalStatus?.body.status === "failed") return "delegate_failed";
    if (theoremToSorryFailure) return "theorem2sorry_failed";
    if (verifyValidations.length === 0 && axleValidations.length === 0) return "no_axle_validation";
    if (verifyValidations.length === 0) return "no_final_verify";
    if (!successfulVerify) return "axle_verify_failed";
    return "verified";
  })();

  const summary = [
    `status: ${settled.status}`,
    `outcome: ${outcome}`,
    leanTools.length > 0 ? `AXLE tools: ${leanTools.join(", ")}` : "",
    finalStatus?.body.note ? `note: ${finalStatus.body.note}` : "",
    latestValidation?.body.summary ? `validation: ${latestValidation.body.summary}` : "",
    finalResponse?.body.content ?? "",
  ].filter(Boolean).join("\n");

  return {
    jobId: created.id,
    runId,
    stream,
    status: settled.status,
    outcome,
    evidence,
    verifiedCandidateContent: successfulVerify?.body.evidence?.candidateContent,
    verifiedCandidateHash: successfulVerify?.body.evidence?.candidateHash,
    verifiedFormalStatementHash: successfulVerify?.body.evidence?.formalStatementHash,
    summary: summary || JSON.stringify(settled.result ?? { status: settled.status }),
  };
};

export const evaluateAxiomGuildBenchmark = async (opts: {
  readonly benchmark: AxiomGuildBenchmarkCase;
  readonly chain: ReadonlyArray<{ readonly body: TheoremEvent }>;
  readonly runId: string;
  readonly stream: string;
  readonly workspaceRoot: string;
  readonly expectedFormalStatementHash: string;
}): Promise<AxiomGuildBenchmarkResult> => {
  const checks: AxiomGuildBenchmarkCheck[] = [];
  const finalStatus = [...opts.chain].reverse().find((receipt) => receipt.body.type === "run.status") as
    | { body: Extract<TheoremEvent, { type: "run.status" }> }
    | undefined;
  const verification = [...opts.chain].reverse().find((receipt) => receipt.body.type === "verification.report") as
    | { body: Extract<TheoremEvent, { type: "verification.report" }> }
    | undefined;
  const solution = [...opts.chain].reverse().find((receipt) => receipt.body.type === "solution.finalized") as
    | { body: Extract<TheoremEvent, { type: "solution.finalized" }> }
    | undefined;
  const delegateCalls = opts.chain.filter((receipt) =>
    receipt.body.type === "tool.called" && receipt.body.tool === "axiom.delegate"
  );

  checks.push({
    name: "run.completed",
    ok: finalStatus?.body.status === "completed",
    detail: finalStatus ? `status=${finalStatus.body.status}${finalStatus.body.note ? ` note=${finalStatus.body.note}` : ""}` : "missing run.status",
  });
  checks.push({
    name: "axiom.delegate",
    ok: delegateCalls.length > 0,
    detail: delegateCalls.length > 0 ? `delegations=${delegateCalls.length}` : "no axiom.delegate receipts found",
  });
  checks.push({
    name: "final.verify",
    ok: verification?.body.status === "valid"
      && (verification.body.evidence?.tool === "lean.verify" || verification.body.evidence?.tool === "lean.verify_file"),
    detail: verification
      ? `status=${verification.body.status}; tool=${verification.body.evidence?.tool ?? "none"}`
      : "missing verification.report",
  });
  checks.push({
    name: "formal_statement_hash",
    ok: verification?.body.evidence?.formalStatementHash === opts.expectedFormalStatementHash,
    detail: verification?.body.evidence?.formalStatementHash
      ? `hash=${verification.body.evidence.formalStatementHash}`
      : "missing formal statement hash",
  });
  checks.push({
    name: "solution.hash_matches_verify",
    ok: Boolean(
      solution?.body.content
      && verification?.body.evidence?.candidateHash
      && hashText(solution.body.content) === verification.body.evidence.candidateHash
    ),
    detail: solution?.body.content && verification?.body.evidence?.candidateHash
      ? `candidateHash=${verification.body.evidence.candidateHash}`
      : "missing solution or candidate hash",
  });

  return {
    benchmarkId: opts.benchmark.id,
    title: opts.benchmark.title,
    passed: checks.every((check) => check.ok),
    runId: opts.runId,
    stream: opts.stream,
    workspaceRoot: opts.workspaceRoot,
    checks,
  };
};

export const runAxiomGuildBenchmarkCase = async (opts: {
  readonly benchmark: AxiomGuildBenchmarkCase;
  readonly theoremPrompts?: TheoremPromptConfig;
  readonly axiomPrompts?: AxiomPromptConfig;
  readonly llmText?: typeof openAiLlmText;
  readonly llmStructured?: AxiomRunInput["llmStructured"];
  readonly keepWorkspace?: boolean;
}): Promise<AxiomGuildBenchmarkResult> => {
  const root = await mkTmp(`axiom-guild-bench-${opts.benchmark.id}`);
  const dataDir = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspace");
  const theoremRuntime = mkTheoremRuntime(dataDir);
  const agentRuntime = mkAgentRuntime(dataDir);
  const jobRuntime = mkJobRuntime(dataDir);
  const queue = jsonlQueue({ runtime: jobRuntime, stream: "jobs" });
  const llmText = opts.llmText ?? openAiLlmText;
  const llmStructured = opts.llmStructured ?? openAiLlmStructured;
  const theoremPrompts = opts.theoremPrompts ?? loadTheoremPrompts({ name: "axiom-guild", tag: "axiom-guild" });
  const axiomPrompts = opts.axiomPrompts ?? loadAxiomPrompts();
  const usingDefaultLlm = !opts.llmText || !opts.llmStructured;
  const stream = "agents/axiom-guild";
  const runId = `axiom_guild_bench_${opts.benchmark.id}_${Date.now().toString(36)}`;
  const benchmarkWorkerId = `bench_worker_${Date.now().toString(36)}`;
  const benchmarkLeaseMs = 30_000;

  if (usingDefaultLlm && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing; cannot run live Axiom Guild benchmark");
  }

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });

  const referenceContent = await fs.readFile(path.join(process.cwd(), opts.benchmark.referenceFile), "utf-8");
  const theoremToSorry = await axleTheoremToSorry({
    content: referenceContent,
    environment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
    names: [opts.benchmark.theoremName],
    ignore_imports: false,
    timeout_seconds: 120,
  });
  const formalStatementRel = path.join(".receipt", "benchmarks", `${opts.benchmark.id}.formal.lean`);
  const formalStatementAbs = path.join(workspaceRoot, formalStatementRel);
  await fs.mkdir(path.dirname(formalStatementAbs), { recursive: true });
  await fs.writeFile(formalStatementAbs, theoremToSorry.content, "utf-8");
  const formalStatementHash = hashText(theoremToSorry.content);

  const axiomHandler = buildAxiomJobHandler({
    runtime: agentRuntime,
    workspaceRoot,
    prompts: axiomPrompts,
    llmText,
    llmStructured,
  });

  try {
    await runTheoremGuild({
      stream,
      runId,
      problem: opts.benchmark.problem,
      config: normalizeTheoremConfig({
        rounds: 2,
        maxDepth: 2,
        memoryWindow: 60,
        branchThreshold: 2,
      }),
      runtime: theoremRuntime,
      prompts: theoremPrompts,
      llmText,
      model: process.env.OPENAI_MODEL ?? "gpt-5.2",
      apiReady: true,
      axiomPolicy: "required",
      axiomConfig: {
        maxIterations: 12,
        leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
        autoRepair: true,
        formalStatementPath: formalStatementRel,
      },
      axiomDelegate: buildQueuedAxiomDelegate({
        queue,
        agentRuntime,
        handler: axiomHandler,
        workerId: benchmarkWorkerId,
        leaseMs: benchmarkLeaseMs,
      }),
      broadcast: () => undefined,
      workspaceRoot,
      // runTheoremGuild ignores workspaceRoot; included here for parity with eval callers.
    } as Parameters<typeof runTheoremGuild>[0]);

    const chain = await theoremRuntime.chain(theoremRunStream(stream, runId));
    return await evaluateAxiomGuildBenchmark({
      benchmark: opts.benchmark,
      chain,
      runId,
      stream,
      workspaceRoot,
      expectedFormalStatementHash: formalStatementHash,
    });
  } finally {
    if (!opts.keepWorkspace) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
};
