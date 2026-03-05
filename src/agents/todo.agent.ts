import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import type { Runtime } from "../core/runtime.js";
import type { TodoCmd, TodoEvent, TodoState } from "../modules/todo.js";
import { shell, stateHtml, timelineHtml, timeHtml, verifyHtml, oobAll, branchSelectorHtml } from "../views/html.js";
import { html, parseAt, parseDepth, clampDepth, text } from "../framework/http.js";
import { todoCmdFormSchema } from "../framework/schemas.js";
import type { RuntimeOp } from "../framework/translators.js";
import { executeRuntimeOps } from "../framework/translators.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import { SseHub } from "../framework/sse-hub.js";

type TodoRouteDeps = {
  readonly runtime: Runtime<TodoCmd, TodoEvent, TodoState>;
  readonly sse: SseHub;
};

type TodoCmdIntent = {
  readonly stream: string;
  readonly cmd: TodoCmd;
};

const toCmd = (form: { readonly text?: string; readonly type?: string; readonly id?: string }): TodoCmd | null => {
  if (form.text?.trim()) return { type: "add", text: form.text };
  if (form.type === "toggle" && form.id) return { type: "toggle", id: form.id };
  if (form.type === "delete" && form.id) return { type: "delete", id: form.id };
  return null;
};

export const translateTodoCmdIntent = (intent: TodoCmdIntent): ReadonlyArray<RuntimeOp<TodoCmd>> => [
  { type: "emit", stream: intent.stream, cmd: intent.cmd },
  { type: "broadcast", topic: "receipt" },
];

export const createTodoRoute = (deps: TodoRouteDeps): AgentRouteModule => ({
  id: "todo",
  kind: "todo",
  paths: {
    shell: "/",
    state: "/island/state",
    timeline: "/island/timeline",
    time: "/island/time",
    verify: "/island/verify",
    branches: "/island/branches",
    travel: "/travel",
    cmd: "/cmd",
  },
  register: (app: Hono) => {
    const { runtime, sse } = deps;

    app.get("/", async (c) => {
      const stream = c.req.query("stream") ?? "todo";
      return html(shell(stream));
    });

    app.get("/island/state", async (c) => {
      const stream = c.req.query("stream") ?? "todo";
      const at = parseAt(c.req.query("at"));
      const fullChain = await runtime.chain(stream);
      const chain = at === null ? fullChain : fullChain.slice(0, at);
      const total = fullChain.length;
      const state = at === null ? await runtime.state(stream) : await runtime.stateAt(stream, at);
      return html(stateHtml(stream, chain, state, at, total));
    });

    app.get("/island/timeline", async (c) => {
      const stream = c.req.query("stream") ?? "todo";
      const at = parseAt(c.req.query("at"));
      const requestedDepth = parseDepth(c.req.query("depth"));
      const chain = await runtime.chain(stream);
      const total = chain.length;
      const depth = clampDepth(total, requestedDepth);
      const slice = depth === total ? chain : chain.slice(total - depth);
      return html(timelineHtml(stream, slice, at));
    });

    app.get("/island/time", async (c) => {
      const stream = c.req.query("stream") ?? "todo";
      const at = parseAt(c.req.query("at"));
      const total = (await runtime.chain(stream)).length;
      return html(timeHtml(stream, at, total));
    });

    app.get("/island/verify", async (c) => {
      const stream = c.req.query("stream") ?? "todo";
      const at = parseAt(c.req.query("at"));
      const chain = at === null ? await runtime.chain(stream) : await runtime.chainAt(stream, at);
      return html(verifyHtml(chain));
    });

    app.get("/island/branches", async (c) => {
      const stream = c.req.query("stream") ?? "todo";
      const at = parseAt(c.req.query("at"));
      const branches = await runtime.branches();
      const children = await runtime.children(stream);
      const current = await runtime.branch(stream);
      return html(branchSelectorHtml(stream, branches, children, current, at));
    });

    app.get("/travel", async (c) => {
      const stream = c.req.query("stream") ?? "todo";
      const at = parseAt(c.req.query("at"));
      const fullChain = await runtime.chain(stream);
      const total = fullChain.length;
      const chain = at === null ? fullChain : fullChain.slice(0, at);
      const state = at === null ? await runtime.state(stream) : await runtime.stateAt(stream, at);
      const branches = await runtime.branches();
      const children = await runtime.children(stream);
      const current = await runtime.branch(stream);
      return html(oobAll(stream, chain, state, at, total, branches, children, current));
    });

    app.post(
      "/cmd",
      zValidator("form", todoCmdFormSchema, (result) => {
        if (!result.success) return text(400, "bad");
      }),
      async (c) => {
      const stream = c.req.query("stream") ?? "todo";
      const form = c.req.valid("form");
      const cmd = toCmd(form);
      if (!cmd) return text(400, "bad");

      const ops = translateTodoCmdIntent({ stream, cmd });
      await executeRuntimeOps(ops, {
        fork: async () => {},
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
      return html("", { "HX-Trigger": "refresh" });
      }
    );
  },
});

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createTodoRoute({
    runtime: ctx.runtimes.todo as Runtime<TodoCmd, TodoEvent, TodoState>,
    sse: ctx.sse,
  });

export default factory;
