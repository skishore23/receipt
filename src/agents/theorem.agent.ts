import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import type { LlmTextOptions } from "../adapters/openai.js";
import { fold } from "../core/chain.js";
import type { Runtime } from "../core/runtime.js";
import type { Chain } from "../core/types.js";
import type { TheoremCmd, TheoremEvent, TheoremState } from "../modules/theorem.js";
import { reduce as reduceTheorem, initial as initialTheorem } from "../modules/theorem.js";
import {
  THEOREM_TEAM,
  THEOREM_EXAMPLES,
  buildTheoremRuns,
  buildTheoremSteps,
  getLatestTheoremRunId,
  normalizeTheoremConfig,
  parseTheoremConfig,
  runTheoremGuild,
  sliceTheoremChainByStep,
} from "./theorem.js";
import { theoremRunStream } from "./theorem.streams.js";
import {
  theoremShell,
  theoremFoldsHtml,
  theoremTravelHtml,
  theoremChatHtml,
  theoremSideHtml,
} from "../views/theorem.js";
import { html, makeEventId, parseAt, parseBranch, text, toFormRecord } from "../framework/http.js";
import { theoremRunFormSchema } from "../framework/schemas.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import type { RuntimeOp } from "../framework/translators.js";
import { executeRuntimeOps } from "../framework/translators.js";
import { SseHub } from "../framework/sse-hub.js";
import type { EnqueueJobInput } from "../adapters/jsonl-queue.js";

type TheoremRouteDeps = {
  readonly runtime: Runtime<TheoremCmd, TheoremEvent, TheoremState>;
  readonly llmText: (opts: LlmTextOptions) => Promise<string>;
  readonly prompts: Parameters<typeof runTheoremGuild>[0]["prompts"];
  readonly promptHash: string;
  readonly promptPath: string;
  readonly model: string;
  readonly sse: SseHub;
  readonly enqueueJob: (job: EnqueueJobInput) => Promise<void>;
};

type TheoremRunStartIntent = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream: string;
  readonly sourceStream: string;
  readonly sourceChain: Chain<TheoremEvent>;
  readonly at: number | null;
  readonly append?: string;
  readonly resolvedProblem: string;
  readonly config: ReturnType<typeof parseTheoremConfig>;
  readonly resumeRequested: boolean;
};

const mergeTimelineChains = <T extends { readonly id: string; readonly ts: number; readonly stream: string }>(
  chains: ReadonlyArray<ReadonlyArray<T>>
) => {
  const merged = chains.flatMap((chain) => chain);
  merged.sort((a, b) => a.ts - b.ts || a.stream.localeCompare(b.stream) || a.id.localeCompare(b.id));
  return merged;
};

export const translateTheoremRunStartIntent = (
  intent: TheoremRunStartIntent
): ReadonlyArray<RuntimeOp<TheoremCmd>> => {
  const ops: RuntimeOp<TheoremCmd>[] = [];
  let runStreamOverride: string | undefined;
  let forkedBranch: string | undefined;
  const queuedProblem = intent.append ? `${intent.resolvedProblem}\n\n${intent.append}` : intent.resolvedProblem;
  const queueJobId = `theorem_${intent.runId}_${Date.now().toString(36)}`;

  if (intent.resumeRequested && intent.sourceChain.length > 0) {
    const forkSlice = intent.at === null ? intent.sourceChain : sliceTheoremChainByStep(intent.sourceChain, intent.at);
    const forkAt = forkSlice.length;
    const branchId = `resume_${Date.now().toString(36)}_${forkAt}`;
    const branchStream = `${intent.runStream}/branches/${branchId}`;
    ops.push({ type: "fork", stream: intent.sourceStream, at: forkAt, newName: branchStream });

    const noteBits = [
      "resume fork",
      intent.sourceStream !== intent.runStream ? `from ${intent.sourceStream}` : "",
      intent.at !== null ? `at step ${intent.at}` : "",
    ].filter(Boolean);
    ops.push({
      type: "emit",
      stream: intent.runStream,
      cmd: {
        type: "emit",
        eventId: makeEventId(intent.runStream),
        event: {
          type: "branch.created",
          runId: intent.runId,
          branchId: branchStream,
          forkAt,
          note: noteBits.join(" "),
        },
      },
    });
    runStreamOverride = branchStream;
    forkedBranch = branchStream;
  }

  if (intent.append && runStreamOverride) {
    ops.push({
      type: "emit",
      stream: runStreamOverride,
      cmd: {
        type: "emit",
        eventId: makeEventId(runStreamOverride),
        event: { type: "problem.appended", runId: intent.runId, append: intent.append, agentId: "orchestrator" },
      },
    });
  }

  ops.push({
    type: "enqueue_job",
    job: {
      jobId: queueJobId,
      agentId: "theorem",
      lane: "collect",
      sessionKey: `theorem:${intent.stream}`,
      singletonMode: "cancel",
      maxAttempts: 2,
      payload: {
        kind: "theorem.run",
        stream: intent.stream,
        runId: intent.runId,
        runStream: runStreamOverride,
        problem: queuedProblem,
        config: intent.config,
      },
    },
  });

  const redirectParams = new URLSearchParams({ stream: intent.stream, run: intent.runId });
  if (forkedBranch) redirectParams.set("branch", forkedBranch);
  redirectParams.set("job", queueJobId);
  ops.push({ type: "redirect", header: "HX-Redirect", url: `/theorem?${redirectParams.toString()}` });

  return ops;
};

export const createTheoremRoute = (deps: TheoremRouteDeps): AgentRouteModule => {
  const { runtime, enqueueJob, sse } = deps;

  const loadTheoremRunChain = async (
    baseStream: string,
    runId: string,
    branchStream?: string | null
  ) => {
    const runStream = theoremRunStream(baseStream, runId);
    const branchPrefix = `${runStream}/branches/`;
    const canUseBranch = branchStream && branchStream.startsWith(branchPrefix);

    if (canUseBranch) {
      const branchChain = await runtime.chain(branchStream);
      if (branchChain.length > 0) {
        return { chain: branchChain, chainStream: branchStream, isBranch: true };
      }
    }

    const runChain = await runtime.chain(runStream);
    if (runChain.length > 0) {
      return { chain: runChain, chainStream: runStream, isBranch: false };
    }

    return { chain: [], chainStream: runStream, isBranch: false };
  };

  const loadTheoremDescendantChains = async (rootStream: string) => {
    const out: Array<{ readonly name: string; readonly forkAt: number; readonly chain: Awaited<ReturnType<typeof runtime.chain>> }> = [];
    const queue: string[] = [rootStream];

    while (queue.length > 0) {
      const parent = queue.shift();
      if (!parent) break;
      const children = await runtime.children(parent);
      for (const child of children) {
        const chain = await runtime.chain(child.name);
        out.push({
          name: child.name,
          forkAt: Math.max(0, child.forkAt ?? 0),
          chain,
        });
        queue.push(child.name);
      }
    }

    return out;
  };

  const buildTheoremDisplayChain = async (
    baseStream: string,
    runId: string
  ): Promise<Awaited<ReturnType<typeof runtime.chain>>> => {
    const runStream = theoremRunStream(baseStream, runId);
    const runChain = await runtime.chain(runStream);
    const descendants = await loadTheoremDescendantChains(runStream);
    const branchDeltas = descendants.map((desc) => desc.chain.slice(desc.forkAt));
    return mergeTimelineChains([runChain, ...branchDeltas]);
  };

  const buildTheoremRunReceiptCount = async (
    baseStream: string,
    runId: string,
    runChainLength: number,
    fallback: number
  ): Promise<number> => {
    const runStream = theoremRunStream(baseStream, runId);
    const descendants = await loadTheoremDescendantChains(runStream);
    const deltaCount = descendants.reduce((sum, desc) => sum + desc.chain.slice(desc.forkAt).length, 0);
    return Math.max(fallback, runChainLength + deltaCount);
  };

  const buildTravelStepTotal = (displayChain: Awaited<ReturnType<typeof runtime.chain>>): number => {
    const steps = buildTheoremSteps(displayChain);
    return steps.length > 0 ? steps.length : displayChain.length;
  };

  return {
    id: "theorem",
    kind: "run",
    paths: {
      shell: "/theorem",
      folds: "/theorem/island/folds",
      travelIsland: "/theorem/island/travel",
      travel: "/theorem/travel",
      chat: "/theorem/island/chat",
      side: "/theorem/island/side",
      run: "/theorem/run",
      stream: "/theorem/stream",
    },
    register: (app: Hono) => {
      app.get("/theorem", async (c) => {
        const stream = c.req.query("stream") ?? "agents/theorem";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const chain = await runtime.chain(stream);
        const latest = getLatestTheoremRunId(chain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        return html(theoremShell(stream, THEOREM_EXAMPLES, activeRun, wantsEmpty ? null : at, branchParam ?? undefined));
      });

      app.get("/theorem/island/folds", async (c) => {
        const stream = c.req.query("stream") ?? "agents/theorem";
        const runParam = c.req.query("run");
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestTheoremRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const runs = buildTheoremRuns(indexChain);
        const runsWithCounts = await Promise.all(runs.map(async (run) => {
          const runStream = theoremRunStream(stream, run.runId);
          const runChain = await runtime.chain(runStream);
          const count = await buildTheoremRunReceiptCount(stream, run.runId, runChain.length, run.count);
          const startedAt = runChain.length > 0 ? runChain[0]?.ts : run.startedAt;
          return { ...run, count, startedAt };
        }));
        return html(theoremFoldsHtml(stream, runsWithCounts, activeRun, wantsEmpty ? null : at));
      });

      app.get("/theorem/island/travel", async (c) => {
        const stream = c.req.query("stream") ?? "agents/theorem";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestTheoremRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        if (!activeRun) return html(theoremTravelHtml({ stream, at: null, total: 0 }));

        const runData = await loadTheoremRunChain(stream, activeRun, branchParam);
        const displayChain = !runData.isBranch
          ? await buildTheoremDisplayChain(stream, activeRun)
          : runData.chain;
        const totalSteps = buildTravelStepTotal(displayChain);
        return html(theoremTravelHtml({
          stream,
          runId: activeRun,
          branch: runData.isBranch ? runData.chainStream : undefined,
          at: wantsEmpty ? null : at,
          total: totalSteps,
        }));
      });

      app.get("/theorem/travel", async (c) => {
        const stream = c.req.query("stream") ?? "agents/theorem";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestTheoremRunId(indexChain);
        const activeRun = runParam?.trim() ? runParam : (latest ?? undefined);
        if (!activeRun) {
          return html("", { "HX-Push-Url": `/theorem?stream=${encodeURIComponent(stream)}&run=new` });
        }

        const runs = buildTheoremRuns(indexChain);
        const runsWithCounts = await Promise.all(runs.map(async (run) => {
          const runStream = theoremRunStream(stream, run.runId);
          const runChain = await runtime.chain(runStream);
          const count = await buildTheoremRunReceiptCount(stream, run.runId, runChain.length, run.count);
          const startedAt = runChain.length > 0 ? runChain[0]?.ts : run.startedAt;
          return { ...run, count, startedAt };
        }));

        const runData = await loadTheoremRunChain(stream, activeRun, branchParam);
        const displayChain = !runData.isBranch
          ? await buildTheoremDisplayChain(stream, activeRun)
          : runData.chain;
        const totalSteps = buildTravelStepTotal(displayChain);
        const normalizedAt = at === null ? null : Math.max(0, Math.min(at, totalSteps));
        const viewAt = normalizedAt !== null && normalizedAt < totalSteps ? normalizedAt : null;
        const viewChain = viewAt === null ? displayChain : sliceTheoremChainByStep(displayChain, viewAt);
        const stateFromView = fold(viewChain, reduceTheorem, initialTheorem);
        const stateResolved =
          runData.isBranch
            ? await (async () => {
                const runStream = theoremRunStream(stream, activeRun);
                const mainChain = await runtime.chain(runStream);
                const mainState = fold(mainChain, reduceTheorem, initialTheorem);
                return { ...stateFromView, branches: mainState.branches };
              })()
            : stateFromView;
        const team = THEOREM_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));
        const activeBranch = runData.isBranch ? runData.chainStream : undefined;

        const urlParams = new URLSearchParams({ stream, run: activeRun });
        if (activeBranch) urlParams.set("branch", activeBranch);
        if (viewAt !== null) urlParams.set("at", String(viewAt));
        const nextUrl = `/theorem?${urlParams.toString()}`;
        const atParam = String(viewAt ?? "");
        const branchParamForQuery = activeBranch ?? "";

        return html(`
<div id="tg-folds" class="folds" hx-swap-oob="outerHTML"
     hx-get="/theorem/island/folds?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:800ms" hx-swap="innerHTML">${theoremFoldsHtml(stream, runsWithCounts, activeRun, viewAt)}</div>
<div id="tg-travel" class="travel-island" hx-swap-oob="outerHTML"
     hx-get="/theorem/island/travel?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:700ms" hx-swap="innerHTML">${theoremTravelHtml({ stream, runId: activeRun, branch: activeBranch, at: viewAt, total: totalSteps })}</div>
<div id="tg-chat" class="run-area" hx-swap-oob="outerHTML"
     hx-get="/theorem/island/chat?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:1200ms" hx-swap="innerHTML">${theoremChatHtml(viewChain)}</div>
<div id="tg-side" class="activity" hx-swap-oob="outerHTML"
     hx-get="/theorem/island/side?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:800ms" hx-swap="innerHTML">${theoremSideHtml(
          stateResolved,
          viewChain,
          viewAt,
          totalSteps,
          stream,
          activeRun,
          team,
          runData.chainStream,
          activeBranch,
          viewChain
        )}</div>`, { "HX-Push-Url": nextUrl });
      });

      app.get("/theorem/island/chat", async (c) => {
        const stream = c.req.query("stream") ?? "agents/theorem";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestTheoremRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const runData = (!wantsEmpty && activeRun)
          ? await loadTheoremRunChain(stream, activeRun, branchParam)
          : { chain: [], chainStream: stream, isBranch: false };
        const displayChain = (!wantsEmpty && activeRun && !runData.isBranch)
          ? await buildTheoremDisplayChain(stream, activeRun)
          : runData.chain;
        const viewChain = at === null ? displayChain : sliceTheoremChainByStep(displayChain, at);
        return html(theoremChatHtml(viewChain));
      });

      app.get("/theorem/island/side", async (c) => {
        const stream = c.req.query("stream") ?? "agents/theorem";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestTheoremRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const runData = (!wantsEmpty && activeRun)
          ? await loadTheoremRunChain(stream, activeRun, branchParam)
          : { chain: [], chainStream: stream, isBranch: false };
        const displayChain = (!wantsEmpty && activeRun && !runData.isBranch)
          ? await buildTheoremDisplayChain(stream, activeRun)
          : runData.chain;
        const viewChain = at === null ? displayChain : sliceTheoremChainByStep(displayChain, at);
        const stateFromView = fold(viewChain, reduceTheorem, initialTheorem);
        const state =
          runData.isBranch && activeRun
            ? (() => {
                const runStream = theoremRunStream(stream, activeRun);
                return runtime.chain(runStream).then((mainChain) => {
                  const mainState = fold(mainChain, reduceTheorem, initialTheorem);
                  return { ...stateFromView, branches: mainState.branches };
                });
              })()
            : Promise.resolve(stateFromView);
        const stateResolved = await state;
        const team = THEOREM_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));
        const steps = buildTheoremSteps(displayChain);
        const totalSteps = steps.length > 0 ? steps.length : displayChain.length;
        return html(theoremSideHtml(
          stateResolved,
          viewChain,
          wantsEmpty ? null : at,
          totalSteps,
          stream,
          activeRun,
          team,
          runData.chainStream,
          runData.isBranch ? runData.chainStream : undefined,
          viewChain
        ));
      });

      app.post(
        "/theorem/run",
        zValidator("form", theoremRunFormSchema, (result) => {
          if (!result.success) return text(400, "problem required");
        }),
        async (c) => {
        const stream = c.req.query("stream") ?? "agents/theorem";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const at = parseAt(c.req.query("at"));
        const formRaw = toFormRecord(c.req.valid("form"));

        const problem = formRaw.problem?.trim();
        const append = formRaw.append?.trim();
        const runId = runParam?.trim().length ? runParam.trim() : `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const runStream = theoremRunStream(stream, runId);
        const branchPrefix = `${runStream}/branches/`;
        let sourceStream = runStream;
        let sourceChain = await runtime.chain(runStream);
        if (branchParam && branchParam.startsWith(branchPrefix)) {
          const branchChain = await runtime.chain(branchParam);
          if (branchChain.length > 0) {
            sourceStream = branchParam;
            sourceChain = branchChain;
          }
        }
        const existingState = sourceChain.length > 0 ? fold(sourceChain, reduceTheorem, initialTheorem) : undefined;
        const resolvedProblem = existingState?.problem || problem || "";
        if (!resolvedProblem) return text(400, "problem required");

        const hasConfigInput = formRaw.rounds !== undefined || formRaw.depth !== undefined || formRaw.memory !== undefined || formRaw.branch !== undefined;
        let config = parseTheoremConfig(formRaw);
        if (!hasConfigInput && existingState?.config) {
          config = normalizeTheoremConfig({
            rounds: existingState.config.rounds,
            maxDepth: existingState.config.depth,
            memoryWindow: existingState.config.memoryWindow,
            branchThreshold: existingState.config.branchThreshold,
          });
        }

        const ops = translateTheoremRunStartIntent({
          stream,
          runId,
          runStream,
          sourceStream,
          sourceChain,
          at,
          append,
          resolvedProblem,
          config,
          resumeRequested: Boolean(runParam?.trim().length),
        });

        const redirect = await executeRuntimeOps(ops, {
          fork: async (op) => {
            await runtime.fork(op.stream, op.at, op.newName);
          },
          emit: async (op) => {
            await runtime.execute(op.stream, op.cmd);
          },
          startRun: async () => {},
          enqueueJob: async (op) => {
            await enqueueJob(op.job);
            sse.publish("jobs", op.job.jobId);
            sse.publish("receipt");
          },
          broadcast: async (op) => {
            sse.publish(op.topic, op.stream);
          },
        });

        if (!redirect) return html("", { "HX-Redirect": `/theorem?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(runId)}` });
        return html("", { [redirect.header]: redirect.url });
        }
      );

      app.get("/theorem/stream", async (c) => {
        const stream = c.req.query("stream") ?? "agents/theorem";
        return sse.subscribe("theorem", stream, c.req.raw.signal);
      });
    },
  };
};

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createTheoremRoute({
    runtime: ctx.runtimes.theorem as Runtime<TheoremCmd, TheoremEvent, TheoremState>,
    llmText: ctx.llmText,
    prompts: ctx.prompts.theorem as Parameters<typeof runTheoremGuild>[0]["prompts"],
    promptHash: ctx.promptHashes.theorem ?? "",
    promptPath: ctx.promptPaths.theorem ?? "prompts/theorem.prompts.json",
    model: ctx.models.theorem ?? "gpt-5.2",
    sse: ctx.sse,
    enqueueJob: ctx.enqueueJob,
  });

export default factory;
