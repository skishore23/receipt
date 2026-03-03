import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import type { LlmTextOptions } from "../adapters/openai.js";
import { fold } from "../core/chain.js";
import type { Runtime } from "../core/runtime.js";
import type { Chain } from "../core/types.js";
import type { WriterCmd, WriterEvent, WriterState } from "../modules/writer.js";
import { reduce as reduceWriter, initial as initialWriter } from "../modules/writer.js";
import {
  WRITER_TEAM,
  WRITER_EXAMPLES,
  runWriterGuild,
  normalizeWriterConfig,
  parseWriterConfig,
} from "./writer.js";
import {
  buildWriterRuns,
  buildWriterSteps,
  getLatestWriterRunId,
  sliceWriterChainByStep,
} from "./writer.runs.js";
import { writerRunStream } from "./writer.streams.js";
import {
  writerShell,
  writerFoldsHtml,
  writerTravelHtml,
  writerChatHtml,
  writerSideHtml,
} from "../views/writer.js";
import { html, makeEventId, parseAt, parseBranch, text, toFormRecord } from "../framework/http.js";
import { writerRunFormSchema } from "../framework/schemas.js";
import type { RunAgentManifest } from "../framework/manifest.js";
import type { RuntimeOp } from "../framework/translators.js";
import { executeRuntimeOps } from "../framework/translators.js";
import { SseHub } from "../framework/sse-hub.js";

type WriterManifestDeps = {
  readonly runtime: Runtime<WriterCmd, WriterEvent, WriterState>;
  readonly llmText: (opts: LlmTextOptions) => Promise<string>;
  readonly prompts: Parameters<typeof runWriterGuild>[0]["prompts"];
  readonly promptHash: string;
  readonly promptPath: string;
  readonly model: string;
  readonly sse: SseHub;
};

type WriterRunStartIntent = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream: string;
  readonly sourceStream: string;
  readonly sourceChain: Chain<WriterEvent>;
  readonly at: number | null;
  readonly append?: string;
  readonly resolvedProblem: string;
  readonly config: ReturnType<typeof parseWriterConfig>;
  readonly prompts: Parameters<typeof runWriterGuild>[0]["prompts"];
  readonly llmText: (opts: LlmTextOptions) => Promise<string>;
  readonly model: string;
  readonly promptHash: string;
  readonly promptPath: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly runtime: Runtime<WriterCmd, WriterEvent, WriterState>;
  readonly sse: SseHub;
  readonly resumeRequested: boolean;
};

const isResumeBranch = (branchName: string): boolean => {
  const segment = branchName.split("/").pop() ?? "";
  return segment.startsWith("resume_");
};

export const translateWriterRunStartIntent = (
  intent: WriterRunStartIntent
): ReadonlyArray<RuntimeOp<WriterCmd>> => {
  const ops: RuntimeOp<WriterCmd>[] = [];
  let runStreamOverride: string | undefined;
  let forkedBranch: string | undefined;

  if (intent.resumeRequested && intent.sourceChain.length > 0) {
    const forkSlice = intent.at === null ? intent.sourceChain : sliceWriterChainByStep(intent.sourceChain, intent.at);
    const forkAt = forkSlice.length;
    const branchId = `resume_${Date.now().toString(36)}_${forkAt}`;
    const branchStream = `${intent.runStream}/branches/${branchId}`;
    ops.push({ type: "fork", stream: intent.sourceStream, at: forkAt, newName: branchStream });
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
    type: "start_run",
    launcher: () => {
      void runWriterGuild({
        stream: intent.stream,
        runId: intent.runId,
        runStream: runStreamOverride,
        problem: intent.append ? `${intent.resolvedProblem}\n\n${intent.append}` : intent.resolvedProblem,
        config: intent.config,
        runtime: intent.runtime,
        prompts: intent.prompts,
        llmText: (opts) => intent.llmText({
          ...opts,
          onDelta: async (delta) => {
            if (!delta) return;
            intent.sse.publishData(
              "writer",
              intent.stream,
              "writer-token",
              JSON.stringify({ runId: intent.runId, delta })
            );
          },
        }),
        model: intent.model,
        promptHash: intent.promptHash,
        promptPath: intent.promptPath,
        apiReady: intent.apiReady,
        apiNote: intent.apiNote,
        broadcast: () => {
          intent.sse.publish("writer", intent.stream);
          intent.sse.publish("receipt");
        },
      });
    },
  });

  const redirectParams = new URLSearchParams({ stream: intent.stream, run: intent.runId });
  if (forkedBranch) redirectParams.set("branch", forkedBranch);
  ops.push({ type: "redirect", header: "HX-Redirect", url: `/writer?${redirectParams.toString()}` });

  return ops;
};

export const createWriterManifest = (deps: WriterManifestDeps): RunAgentManifest => {
  const { runtime, llmText, prompts, promptHash, promptPath, model, sse } = deps;

  const loadWriterRunChain = async (
    baseStream: string,
    runId: string,
    branchStream?: string | null
  ) => {
    const runStream = writerRunStream(baseStream, runId);
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

  const loadWriterDescendantChains = async (rootStream: string) => {
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

  const buildWriterRunReceiptCount = async (
    baseStream: string,
    runId: string,
    runChainLength: number,
    fallback: number
  ): Promise<number> => {
    const runStream = writerRunStream(baseStream, runId);
    const descendants = await loadWriterDescendantChains(runStream);
    const resumeDeltaCount = descendants
      .filter((desc) => isResumeBranch(desc.name))
      .reduce((sum, desc) => sum + desc.chain.slice(desc.forkAt).length, 0);
    return Math.max(fallback, runChainLength + resumeDeltaCount);
  };

  return {
    id: "writer",
    kind: "run",
    paths: {
      shell: "/writer",
      folds: "/writer/island/folds",
      travelIsland: "/writer/island/travel",
      travel: "/writer/travel",
      chat: "/writer/island/chat",
      side: "/writer/island/side",
      run: "/writer/run",
      stream: "/writer/stream",
    },
    register: (app: Hono) => {
      app.get("/writer", async (c) => {
        const stream = c.req.query("stream") ?? "writer";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const chain = await runtime.chain(stream);
        const latest = getLatestWriterRunId(chain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        return html(writerShell(stream, WRITER_EXAMPLES, activeRun, wantsEmpty ? null : at, branchParam ?? undefined));
      });

      app.get("/writer/island/folds", async (c) => {
        const stream = c.req.query("stream") ?? "writer";
        const runParam = c.req.query("run");
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestWriterRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const runs = buildWriterRuns(indexChain);
        const runsWithCounts = await Promise.all(runs.map(async (run) => {
          const runStream = writerRunStream(stream, run.runId);
          const runChain = await runtime.chain(runStream);
          const count = await buildWriterRunReceiptCount(stream, run.runId, runChain.length, run.count);
          const startedAt = runChain.length > 0 ? runChain[0]?.ts : run.startedAt;
          return { ...run, count, startedAt };
        }));
        return html(writerFoldsHtml(stream, runsWithCounts, activeRun, wantsEmpty ? null : at));
      });

      app.get("/writer/island/travel", async (c) => {
        const stream = c.req.query("stream") ?? "writer";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestWriterRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        if (!activeRun) return html(writerTravelHtml({ stream, at: null, total: 0 }));
        const runData = await loadWriterRunChain(stream, activeRun, branchParam);
        const steps = buildWriterSteps(runData.chain);
        const totalSteps = Math.max(steps.length, runData.chain.length);
        return html(writerTravelHtml({
          stream,
          runId: activeRun,
          branch: runData.isBranch ? runData.chainStream : undefined,
          at: wantsEmpty ? null : at,
          total: totalSteps,
        }));
      });

      app.get("/writer/travel", async (c) => {
        const stream = c.req.query("stream") ?? "writer";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestWriterRunId(indexChain);
        const activeRun = runParam?.trim() ? runParam : (latest ?? undefined);
        if (!activeRun) {
          return html("", { "HX-Push-Url": `/writer?stream=${encodeURIComponent(stream)}&run=new` });
        }

        const runs = buildWriterRuns(indexChain);
        const runsWithCounts = await Promise.all(runs.map(async (run) => {
          const runStream = writerRunStream(stream, run.runId);
          const runChain = await runtime.chain(runStream);
          const count = await buildWriterRunReceiptCount(stream, run.runId, runChain.length, run.count);
          const startedAt = runChain.length > 0 ? runChain[0]?.ts : run.startedAt;
          return { ...run, count, startedAt };
        }));

        const runData = await loadWriterRunChain(stream, activeRun, branchParam);
        const steps = buildWriterSteps(runData.chain);
        const totalSteps = Math.max(steps.length, runData.chain.length);
        const normalizedAt = at === null ? null : Math.max(0, Math.min(at, totalSteps));
        const viewAt = normalizedAt !== null && normalizedAt < totalSteps ? normalizedAt : null;
        const viewChain = viewAt === null ? runData.chain : sliceWriterChainByStep(runData.chain, viewAt);
        const state = fold(viewChain, reduceWriter, initialWriter);
        const team = WRITER_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));
        const branches = await runtime.branches();
        const activeBranch = runData.isBranch ? runData.chainStream : undefined;

        const urlParams = new URLSearchParams({ stream, run: activeRun });
        if (activeBranch) urlParams.set("branch", activeBranch);
        if (viewAt !== null) urlParams.set("at", String(viewAt));
        const nextUrl = `/writer?${urlParams.toString()}`;
        const atParam = String(viewAt ?? "");
        const branchParamForQuery = activeBranch ?? "";

        return html(`
<div id="wg-folds" class="folds" hx-swap-oob="outerHTML"
     hx-get="/writer/island/folds?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:writer-refresh throttle:800ms" hx-swap="innerHTML">${writerFoldsHtml(stream, runsWithCounts, activeRun, viewAt)}</div>
<div id="wg-travel" class="travel-island" hx-swap-oob="outerHTML"
     hx-get="/writer/island/travel?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:writer-refresh throttle:700ms" hx-swap="innerHTML">${writerTravelHtml({ stream, runId: activeRun, branch: activeBranch, at: viewAt, total: totalSteps })}</div>
<div id="wg-chat" class="run-area" hx-swap-oob="outerHTML"
     hx-get="/writer/island/chat?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:writer-refresh throttle:1200ms" hx-swap="innerHTML">${writerChatHtml(viewChain)}</div>
<div id="wg-side" class="activity" hx-swap-oob="outerHTML"
     hx-get="/writer/island/side?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&branch=${encodeURIComponent(branchParamForQuery)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:writer-refresh throttle:800ms" hx-swap="innerHTML">${writerSideHtml(
          state,
          viewChain,
          viewAt,
          totalSteps,
          stream,
          activeRun,
          team,
          runData.chainStream,
          activeBranch,
          branches,
          viewChain
        )}</div>`, { "HX-Push-Url": nextUrl });
      });

      app.get("/writer/island/chat", async (c) => {
        const stream = c.req.query("stream") ?? "writer";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestWriterRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const runData = (!wantsEmpty && activeRun)
          ? await loadWriterRunChain(stream, activeRun, branchParam)
          : { chain: [], chainStream: stream, isBranch: false };
        const viewChain = at === null ? runData.chain : sliceWriterChainByStep(runData.chain, at);
        return html(writerChatHtml(viewChain));
      });

      app.get("/writer/island/side", async (c) => {
        const stream = c.req.query("stream") ?? "writer";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestWriterRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const runData = (!wantsEmpty && activeRun)
          ? await loadWriterRunChain(stream, activeRun, branchParam)
          : { chain: [], chainStream: stream, isBranch: false };
        const viewChain = at === null ? runData.chain : sliceWriterChainByStep(runData.chain, at);
        const state = fold(viewChain, reduceWriter, initialWriter);
        const team = WRITER_TEAM.map((agent) => ({ id: agent.id, name: agent.name }));
        const steps = buildWriterSteps(runData.chain);
        const totalSteps = Math.max(steps.length, runData.chain.length);
        const branches = await runtime.branches();
        const activityChain = viewChain;
        return html(writerSideHtml(
          state,
          viewChain,
          wantsEmpty ? null : at,
          totalSteps,
          stream,
          activeRun,
          team,
          runData.chainStream,
          runData.isBranch ? runData.chainStream : undefined,
          branches,
          activityChain
        ));
      });

      app.post(
        "/writer/run",
        zValidator("form", writerRunFormSchema, (result) => {
          if (!result.success) return text(400, "problem required");
        }),
        async (c) => {
        const stream = c.req.query("stream") ?? "writer";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const at = parseAt(c.req.query("at"));
        const formRaw = toFormRecord(c.req.valid("form"));

        const problem = formRaw.problem?.trim();
        const append = formRaw.append?.trim();
        const runId = runParam?.trim().length ? runParam.trim() : `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const runStream = writerRunStream(stream, runId);
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
        const existingState = sourceChain.length > 0 ? fold(sourceChain, reduceWriter, initialWriter) : undefined;
        const resolvedProblem = existingState?.problem || problem || "";
        if (!resolvedProblem) return text(400, "problem required");
        const hasConfigInput = formRaw.parallel !== undefined;
        let config = parseWriterConfig(formRaw);
        if (!hasConfigInput && existingState?.config) {
          config = normalizeWriterConfig({ maxParallel: existingState.config.maxParallel });
        }

        const apiReady = Boolean(process.env.OPENAI_API_KEY);
        const apiNote = apiReady ? undefined : "OPENAI_API_KEY not set";

        const ops = translateWriterRunStartIntent({
          stream,
          runId,
          runStream,
          sourceStream,
          sourceChain,
          at,
          append,
          resolvedProblem,
          config,
          runtime,
          llmText,
          prompts,
          model,
          promptHash,
          promptPath,
          apiReady,
          apiNote,
          sse,
          resumeRequested: Boolean(runParam?.trim().length),
        });

        const redirect = await executeRuntimeOps(ops, {
          fork: async (op) => {
            await runtime.fork(op.stream, op.at, op.newName);
          },
          emit: async (op) => {
            await runtime.execute(op.stream, op.cmd);
          },
          startRun: async (op) => {
            await op.launcher();
          },
          broadcast: async (op) => {
            sse.publish(op.topic, op.stream);
          },
        });

        if (!redirect) return html("", { "HX-Redirect": `/writer?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(runId)}` });
        return html("", { [redirect.header]: redirect.url });
        }
      );

      app.get("/writer/stream", async (c) => {
        const stream = c.req.query("stream") ?? "writer";
        return sse.subscribe("writer", stream, c.req.raw.signal);
      });
    },
  };
};
