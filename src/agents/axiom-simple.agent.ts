import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import { fold } from "../core/chain.js";
import type { Runtime } from "../core/runtime.js";
import type { Chain } from "../core/types.js";
import { html, parseAt, text, toFormRecord } from "../framework/http.js";
import { axiomSimpleRunFormSchema } from "../framework/schemas.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import type { Topic } from "../framework/sse-hub.js";
import type { AgentCmd, AgentEvent, AgentState } from "../modules/agent.js";
import { initial as initialAgent, reduce as reduceAgent } from "../modules/agent.js";
import type { AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState } from "../modules/axiom-simple.js";
import { initial as initialAxiomSimple, reduce as reduceAxiomSimple } from "../modules/axiom-simple.js";
import { esc } from "../views/agent-framework.js";
import { axiomChatHtml, axiomSideHtml } from "../views/axiom.js";
import {
  axiomSimpleChatHtml,
  axiomSimpleFoldsHtml,
  axiomSimpleShell,
  axiomSimpleSideHtml,
  axiomSimpleTravelHtml,
} from "../views/axiom-simple.js";
import { agentRunStream } from "./agent.streams.js";
import { parseAxiomSimpleConfig } from "./axiom-simple.js";
import {
  buildAxiomSimpleRuns,
  buildAxiomSimpleSteps,
  getLatestAxiomSimpleRunId,
  type AxiomSimpleRunSummary,
  sliceAxiomSimpleChainByStep,
} from "./axiom-simple.runs.js";
import { axiomSimpleRunStream } from "./axiom-simple.streams.js";

const AXIOM_SIMPLE_EXAMPLES = [
  {
    id: "nat-add-zero",
    label: "Nat.add_zero",
    problem: "In Lean 4 with Mathlib, prove theorem axiom_simple_add_zero (n : Nat) : n + 0 = n.",
  },
  {
    id: "list-append-length",
    label: "List append length",
    problem: "In Lean 4 with Mathlib, prove theorem axiom_simple_list_append_length (xs ys : List Nat) : List.length (xs ++ ys) = List.length xs + List.length ys.",
  },
  {
    id: "false-theorem",
    label: "Reject false theorem",
    problem: "Investigate theorem axiom_simple_bad : 2 = 3. If false, surface formal failure or disproof evidence instead of pretending a proof exists.",
  },
] as const;

const DEFAULT_STREAM = "agents/axiom-simple";
const DEFAULT_CHILD_STREAM = "agents/axiom";
const BASE_PATH = "/axiom-simple";

const runIdForNewRun = (): string =>
  `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

const ensurePendingRunSummary = (
  runs: ReadonlyArray<AxiomSimpleRunSummary>,
  activeRun?: string,
): ReadonlyArray<AxiomSimpleRunSummary> => {
  if (!activeRun) return runs;
  if (runs.some((run) => run.runId === activeRun)) return runs;
  return [
    {
      runId: activeRun,
      problem: "Waiting for first orchestration receipt...",
      status: "running",
      count: 0,
      startedAt: undefined,
    },
    ...runs,
  ];
};

const buildParentView = async (
  runtime: Runtime<AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState>,
  stream: string,
  runId?: string,
  at?: number | null,
): Promise<{
  readonly runChain: Chain<AxiomSimpleEvent>;
  readonly viewChain: Chain<AxiomSimpleEvent>;
  readonly state: AxiomSimpleState;
  readonly totalSteps: number;
  readonly viewAt: number | null;
}> => {
  if (!runId) {
    return {
      runChain: [],
      viewChain: [],
      state: initialAxiomSimple,
      totalSteps: 0,
      viewAt: null,
    };
  }

  const runChain = await runtime.chain(axiomSimpleRunStream(stream, runId));
  const steps = buildAxiomSimpleSteps(runChain);
  const totalSteps = steps.length > 0 ? steps.length : runChain.length;
  const normalizedAt = at === null || at === undefined
    ? null
    : Math.max(0, Math.min(at, totalSteps));
  const viewAt = normalizedAt !== null && normalizedAt < totalSteps ? normalizedAt : null;
  const viewChain = viewAt === null ? runChain : sliceAxiomSimpleChainByStep(runChain, viewAt);
  const state = fold(viewChain, reduceAxiomSimple, initialAxiomSimple);
  return { runChain, viewChain, state, totalSteps, viewAt };
};

const workerTravelHtml = (opts: {
  readonly stream: string;
  readonly runId: string;
  readonly at: number | null;
  readonly total: number;
}): string => {
  const maxAt = Math.max(0, opts.total);
  const currentAt = opts.at === null ? maxAt : Math.max(0, Math.min(opts.at, maxAt));
  const isPast = currentAt < maxAt;
  const params = (nextAt?: number | null): string => {
    const q = new URLSearchParams({
      stream: opts.stream,
      run: opts.runId,
      partial: "1",
    });
    if (nextAt !== undefined && nextAt !== null && nextAt < maxAt) q.set("at", String(nextAt));
    return `${BASE_PATH}/worker?${q.toString()}`;
  };

  return `<section class="as-worker-travel">
    <div class="worker-travel-head">
      <div>
        <div class="worker-travel-title">Child Run Travel</div>
        <div class="worker-travel-meta">Independent AXLE receipt scrubber for this worker run.</div>
      </div>
      <div class="worker-travel-pill ${isPast ? "past" : "live"}">${isPast ? "past view" : "live head"}</div>
    </div>
    <div class="worker-travel-row">
      <div class="worker-travel-actions">
        <button type="button" ${currentAt <= 0 ? "disabled" : ""}
          hx-get="${params(0)}" hx-target="#as-worker-shell" hx-swap="innerHTML">Start</button>
        <button type="button" ${currentAt <= 0 ? "disabled" : ""}
          hx-get="${params(Math.max(0, currentAt - 1))}" hx-target="#as-worker-shell" hx-swap="innerHTML">Back</button>
        <button type="button" ${currentAt >= maxAt ? "disabled" : ""}
          hx-get="${params(Math.min(maxAt, currentAt + 1))}" hx-target="#as-worker-shell" hx-swap="innerHTML">Forward</button>
        <button type="button" ${currentAt >= maxAt ? "disabled" : ""}
          hx-get="${params(null)}" hx-target="#as-worker-shell" hx-swap="innerHTML">Live</button>
      </div>
      <form class="worker-travel-scrub">
        <input type="hidden" name="stream" value="${esc(opts.stream)}" />
        <input type="hidden" name="run" value="${esc(opts.runId)}" />
        <input type="hidden" name="partial" value="1" />
        <input class="worker-travel-slider" type="range" min="0" max="${maxAt}" value="${currentAt}" name="at"
          hx-get="${BASE_PATH}/worker" hx-include="closest form" hx-trigger="change delay:90ms" hx-target="#as-worker-shell" hx-swap="innerHTML" />
      </form>
      <div class="worker-travel-step">Receipt ${currentAt} / ${maxAt}</div>
    </div>
  </section>`;
};

const workerPendingHtml = (runId: string): string =>
  `<div class="empty">Run <code>${esc(runId)}</code> is queued. Waiting for AXLE receipts...</div>`;

const workerPartialHtml = (opts: {
  readonly stream: string;
  readonly runId: string;
  readonly at: number | null;
  readonly total: number;
  readonly chain: Chain<AgentEvent>;
  readonly state: AgentState;
}): string => {
  const content = opts.chain.length > 0
    ? `<div class="as-worker-grid">
        <main class="as-worker-main">${axiomChatHtml(opts.chain, opts.runId)}</main>
        <aside class="as-worker-side">${axiomSideHtml({
          state: opts.state,
          chain: opts.chain,
          at: opts.at,
          total: opts.total,
          runId: opts.runId,
        })}</aside>
      </div>`
    : workerPendingHtml(opts.runId);

  return `<div class="as-worker-stack">
    <section class="as-worker-header">
      <div>
        <div class="as-worker-title">Axiom Worker Drill-Down</div>
        <div class="as-worker-sub">Full child run detail for <code>${esc(opts.runId)}</code> on <code>${esc(opts.stream)}</code>.</div>
      </div>
      <a class="as-worker-back" href="${BASE_PATH}?stream=${encodeURIComponent(DEFAULT_STREAM)}">Back to Axiom Simple</a>
    </section>
    ${workerTravelHtml({ stream: opts.stream, runId: opts.runId, at: opts.at, total: opts.total })}
    ${content}
    <style>
      .as-worker-stack { display: grid; gap: 18px; }
      .as-worker-header,
      .as-worker-travel {
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(10,18,19,0.88);
        padding: 16px 18px;
      }
      .as-worker-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .as-worker-title { font-size: 15px; font-weight: 700; }
      .as-worker-sub {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.45;
        color: rgba(255,255,255,0.66);
      }
      .as-worker-back {
        color: rgba(120,215,201,0.95);
        text-decoration: none;
        font-size: 12px;
      }
      .worker-travel-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .worker-travel-title {
        font-size: 13px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .worker-travel-meta {
        margin-top: 4px;
        font-size: 12px;
        line-height: 1.45;
        color: rgba(255,255,255,0.66);
      }
      .worker-travel-pill {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.18);
        padding: 4px 8px;
      }
      .worker-travel-pill.live { color: rgba(141,240,187,0.95); border-color: rgba(141,240,187,0.35); }
      .worker-travel-pill.past { color: rgba(255,217,120,0.95); border-color: rgba(255,217,120,0.35); }
      .worker-travel-row { display: grid; gap: 10px; margin-top: 12px; }
      .worker-travel-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .worker-travel-actions button {
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.04);
        color: inherit;
        border-radius: 999px;
        padding: 6px 10px;
        cursor: pointer;
      }
      .worker-travel-actions button[disabled] { opacity: 0.45; cursor: not-allowed; }
      .worker-travel-slider { width: 100%; }
      .worker-travel-step { font-size: 11px; color: rgba(255,255,255,0.66); }
      .as-worker-grid {
        display: grid;
        gap: 18px;
        grid-template-columns: minmax(0, 1fr) 320px;
      }
      @media (max-width: 1180px) {
        .as-worker-grid { grid-template-columns: 1fr; }
      }
    </style>
  </div>`;
};

const workerShellHtml = (opts: {
  readonly stream: string;
  readonly runId: string;
  readonly at: number | null;
}): string => {
  const q = new URLSearchParams({
    stream: opts.stream,
    run: opts.runId,
    partial: "1",
  });
  if (opts.at !== null) q.set("at", String(opts.at));

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt - Axiom Worker</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.1/sse.js"></script>
  <style>
    :root {
      --bg: #071114;
      --ink: #edf4f2;
      --line: rgba(255,255,255,0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(920px 540px at 70% 0%, rgba(91,108,64,0.22), transparent),
        radial-gradient(760px 440px at 10% 80%, rgba(34,95,88,0.2), transparent),
        var(--bg);
    }
    .app {
      width: min(1440px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 22px 0 32px;
    }
    .empty {
      border-radius: 14px;
      border: 1px dashed rgba(255,255,255,0.14);
      padding: 18px;
      color: rgba(255,255,255,0.62);
      text-align: center;
      background: rgba(10,18,19,0.72);
    }
    code { font-family: "IBM Plex Mono", monospace; }
  </style>
</head>
<body hx-ext="sse" sse-connect="${BASE_PATH}/stream?topic=agent&stream=${encodeURIComponent(opts.stream)}">
  <div class="app">
    <div id="as-worker-shell"
         hx-get="${BASE_PATH}/worker?${q.toString()}"
         hx-trigger="load, sse:agent-refresh throttle:900ms"
         hx-swap="innerHTML">
      ${workerPendingHtml(opts.runId)}
    </div>
  </div>
</body>
</html>`;
};

type AxiomSimpleRouteDeps = {
  readonly runtime: Runtime<AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState>;
  readonly childRuntime: Runtime<AgentCmd, AgentEvent, AgentState>;
  readonly enqueueJob: AgentLoaderContext["enqueueJob"];
  readonly sse: AgentLoaderContext["sse"];
};

const createAxiomSimpleRoute = (deps: AxiomSimpleRouteDeps): AgentRouteModule => {
  const { runtime, childRuntime, enqueueJob, sse } = deps;

  return {
    id: "axiom-simple",
    kind: "run",
    paths: {
      shell: BASE_PATH,
      run: `${BASE_PATH}/run`,
      folds: `${BASE_PATH}/island/folds`,
      travelIsland: `${BASE_PATH}/island/travel`,
      travel: `${BASE_PATH}/travel`,
      chat: `${BASE_PATH}/island/chat`,
      side: `${BASE_PATH}/island/side`,
      stream: `${BASE_PATH}/stream`,
      worker: `${BASE_PATH}/worker`,
    },
    register: (app: Hono) => {
      app.get("/axiom-simple", async (c) => {
        const stream = c.req.query("stream") ?? DEFAULT_STREAM;
        const runParam = c.req.query("run");
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestAxiomSimpleRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        return html(axiomSimpleShell(stream, AXIOM_SIMPLE_EXAMPLES, activeRun, wantsEmpty ? null : at, {
          basePath: BASE_PATH,
          title: "Receipt - Axiom Simple",
        }));
      });

      app.post(
        "/axiom-simple/run",
        zValidator("form", axiomSimpleRunFormSchema, (result) => {
          if (!result.success) return text(400, "problem required");
        }),
        async (c) => {
          const stream = c.req.query("stream") ?? DEFAULT_STREAM;
          const form = toFormRecord(c.req.valid("form"));
          const problem = form.problem?.trim() ?? "";
          if (!problem) return text(400, "problem required");

          const runId = runIdForNewRun();
          const config = parseAxiomSimpleConfig(form);
          const jobId = `axiom_simple_${runId}_${Date.now().toString(36)}`;

          await enqueueJob({
            jobId,
            agentId: "axiom-simple",
            lane: "collect",
            sessionKey: `axiom-simple:${stream}`,
            singletonMode: "cancel",
            maxAttempts: 2,
            payload: {
              kind: "axiom-simple.run",
              stream,
              runId,
              problem,
              config,
            },
          });
          sse.publish("jobs", jobId);
          sse.publish("receipt");

          const redirect = new URLSearchParams({ stream, run: runId, job: jobId });
          return html("", { "HX-Redirect": `${BASE_PATH}?${redirect.toString()}` });
        }
      );

      app.get("/axiom-simple/island/folds", async (c) => {
        const stream = c.req.query("stream") ?? DEFAULT_STREAM;
        const runParam = c.req.query("run");
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestAxiomSimpleRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const runs = ensurePendingRunSummary(buildAxiomSimpleRuns(indexChain), activeRun);
        return html(axiomSimpleFoldsHtml(stream, runs, activeRun, wantsEmpty ? null : at, { basePath: BASE_PATH }));
      });

      app.get("/axiom-simple/island/travel", async (c) => {
        const stream = c.req.query("stream") ?? DEFAULT_STREAM;
        const runParam = c.req.query("run");
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestAxiomSimpleRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const parentView = await buildParentView(runtime, stream, activeRun, wantsEmpty ? null : at);
        return html(axiomSimpleTravelHtml({
          stream,
          runId: activeRun,
          at: parentView.viewAt,
          total: parentView.totalSteps,
          basePath: BASE_PATH,
        }));
      });

      app.get("/axiom-simple/travel", async (c) => {
        const stream = c.req.query("stream") ?? DEFAULT_STREAM;
        const runParam = c.req.query("run");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestAxiomSimpleRunId(indexChain);
        const activeRun = runParam?.trim() ? runParam : (latest ?? undefined);
        if (!activeRun) {
          return html("", { "HX-Push-Url": `${BASE_PATH}?stream=${encodeURIComponent(stream)}&run=new` });
        }

        const runs = ensurePendingRunSummary(buildAxiomSimpleRuns(indexChain), activeRun);
        const parentView = await buildParentView(runtime, stream, activeRun, at);
        const atParam = parentView.viewAt === null ? "" : String(parentView.viewAt);
        const nextUrlParams = new URLSearchParams({ stream, run: activeRun });
        if (parentView.viewAt !== null) nextUrlParams.set("at", String(parentView.viewAt));

        const chatHtml = parentView.viewChain.length > 0
          ? axiomSimpleChatHtml(parentView.state, parentView.viewChain, { basePath: BASE_PATH })
          : workerPendingHtml(activeRun);
        const sideHtml = parentView.viewChain.length > 0
          ? axiomSimpleSideHtml(parentView.state, parentView.viewChain, { basePath: BASE_PATH })
          : `<div class="empty">Run <code>${esc(activeRun)}</code> is queued. Waiting for orchestration evidence...</div>`;

        return html(`
<div id="as-folds" class="folds" hx-swap-oob="outerHTML"
     hx-get="${BASE_PATH}/island/folds?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:800ms" hx-swap="innerHTML">${axiomSimpleFoldsHtml(stream, runs, activeRun, parentView.viewAt, { basePath: BASE_PATH })}</div>
<div id="as-travel" class="travel-island" hx-swap-oob="outerHTML"
     hx-get="${BASE_PATH}/island/travel?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:700ms" hx-swap="innerHTML">${axiomSimpleTravelHtml({
          stream,
          runId: activeRun,
          at: parentView.viewAt,
          total: parentView.totalSteps,
          basePath: BASE_PATH,
        })}</div>
<div id="as-chat" class="run-area" hx-swap-oob="outerHTML"
     hx-get="${BASE_PATH}/island/chat?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:1000ms" hx-swap="innerHTML">${chatHtml}</div>
<div id="as-side" class="activity" hx-swap-oob="outerHTML"
     hx-get="${BASE_PATH}/island/side?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(activeRun)}&at=${encodeURIComponent(atParam)}"
     hx-trigger="load, sse:theorem-refresh throttle:800ms" hx-swap="innerHTML">${sideHtml}</div>`, {
          "HX-Push-Url": `${BASE_PATH}?${nextUrlParams.toString()}`,
        });
      });

      app.get("/axiom-simple/island/chat", async (c) => {
        const stream = c.req.query("stream") ?? DEFAULT_STREAM;
        const runParam = c.req.query("run");
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestAxiomSimpleRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const parentView = await buildParentView(runtime, stream, activeRun, wantsEmpty ? null : at);
        if (!activeRun) return html(`<div class="empty">No run selected.</div>`);
        if (parentView.viewChain.length === 0) return html(workerPendingHtml(activeRun));
        return html(axiomSimpleChatHtml(parentView.state, parentView.viewChain, { basePath: BASE_PATH }));
      });

      app.get("/axiom-simple/island/side", async (c) => {
        const stream = c.req.query("stream") ?? DEFAULT_STREAM;
        const runParam = c.req.query("run");
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const indexChain = await runtime.chain(stream);
        const latest = getLatestAxiomSimpleRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const parentView = await buildParentView(runtime, stream, activeRun, wantsEmpty ? null : at);
        if (!activeRun) {
          return html(`<div class="empty">Select a run to inspect orchestration evidence and linked child workers.</div>`);
        }
        if (parentView.viewChain.length === 0) {
          return html(`<div class="empty">Run <code>${esc(activeRun)}</code> is queued. Waiting for orchestration evidence...</div>`);
        }
        return html(axiomSimpleSideHtml(parentView.state, parentView.viewChain, { basePath: BASE_PATH }));
      });

      app.get("/axiom-simple/stream", async (c) => {
        const stream = c.req.query("stream") ?? DEFAULT_STREAM;
        const topicRaw = c.req.query("topic");
        const topic: Topic = topicRaw === "agent" || topicRaw === "writer" || topicRaw === "receipt" || topicRaw === "jobs"
          ? topicRaw
          : "theorem";
        return sse.subscribe(topic, stream, c.req.raw.signal);
      });

      app.get("/axiom-simple/worker", async (c) => {
        const stream = c.req.query("stream") ?? DEFAULT_CHILD_STREAM;
        const runId = c.req.query("run")?.trim();
        const at = parseAt(c.req.query("at"));
        const partial = c.req.query("partial") === "1";
        if (!runId) return text(400, "run required");

        const runChain = await childRuntime.chain(agentRunStream(stream, runId));
        const total = runChain.length;
        const normalizedAt = at === null || at === undefined ? null : Math.max(0, Math.min(at, total));
        const viewAt = normalizedAt !== null && normalizedAt < total ? normalizedAt : null;
        const viewChain = viewAt === null ? runChain : runChain.slice(0, viewAt);
        const state = fold(viewChain, reduceAgent, initialAgent);

        if (partial) {
          return html(workerPartialHtml({
            stream,
            runId,
            at: viewAt,
            total,
            chain: viewChain,
            state,
          }));
        }

        return html(workerShellHtml({
          stream,
          runId,
          at: viewAt,
        }));
      });
    },
  };
};

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createAxiomSimpleRoute({
    runtime: ctx.runtimes["axiom-simple"] as Runtime<AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState>,
    childRuntime: ctx.runtimes.axiom as Runtime<AgentCmd, AgentEvent, AgentState>,
    enqueueJob: ctx.enqueueJob,
    sse: ctx.sse,
  });

export default factory;
