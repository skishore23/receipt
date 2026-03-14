import type { Hono } from "hono";

import { HubGitError } from "../adapters/hub-git.js";
import { LocalCodexExecutor } from "../adapters/codex-executor.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import { html, text } from "../framework/http.js";
import { HubService, HubServiceError } from "../services/hub-service.js";
import { hubDashboard, hubShell } from "../views/hub.js";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const emptyOk = (headers?: Record<string, string>): Response =>
  html("", headers);

const asTrimmed = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const asOptionalString = (value: unknown): string | undefined => {
  const next = asTrimmed(value);
  return next || undefined;
};

const toFormRecord = async (req: Request): Promise<Record<string, unknown>> => {
  const data = await req.formData();
  const out: Record<string, unknown> = {};
  data.forEach((value, key) => {
    if (typeof value === "string") out[key] = value;
  });
  return out;
};

const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const raw = await req.text();
    if (!raw.trim()) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HubServiceError(400, "Malformed JSON body");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HubServiceError(400, "Request body must be an object");
    }
    return parsed as Record<string, unknown>;
  }
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    return toFormRecord(req);
  }
  const raw = await req.text();
  if (!raw.trim()) return {};
  throw new HubServiceError(400, "Unsupported request body");
};

const createHubRoute = (ctx: AgentLoaderContext): AgentRouteModule => {
  const helpers = ctx.helpers ?? {};
  const service = (helpers.hubService as HubService | undefined) ?? new HubService({
    dataDir: ctx.dataDir,
    queue: ctx.queue,
    jobRuntime: ctx.jobRuntime,
    sse: ctx.sse,
    codexExecutor: new LocalCodexExecutor(),
    memoryTools: helpers.memoryTools as MemoryTools | undefined,
  });

  const wrap = async <T>(
    fn: () => Promise<T>,
    render: (value: T) => Response,
  ): Promise<Response> => {
    try {
      return render(await fn());
    } catch (err) {
      if (err instanceof HubServiceError) return text(err.status, err.message);
      if (err instanceof HubGitError) return text(err.status, err.message);
      console.error(err);
      return text(500, "hub server error");
    }
  };

  const renderDashboard = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const model = await service.buildDashboard(
      asOptionalString(url.searchParams.get("commit")),
      asOptionalString(url.searchParams.get("objective")),
    );
    return html(hubDashboard(model));
  };

  return {
    id: "hub",
    kind: "hub",
    paths: {
      shell: "/hub",
      events: "/hub/events",
      state: "/hub/api/state",
    },
    register: (app: Hono) => {
      app.get("/hub", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          return c.req.raw.url;
        },
        () => html(hubShell(new URL(c.req.raw.url).search))
      ));

      app.get("/hub/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          return null;
        },
        () => ctx.sse.subscribeMany([{ topic: "receipt" }, { topic: "jobs" }], c.req.raw.signal)
      ));

      app.get("/hub/island/dashboard", async (c) =>
        renderDashboard(c.req.raw).catch((err) => {
          if (err instanceof HubServiceError) return text(err.status, err.message);
          if (err instanceof HubGitError) return text(err.status, err.message);
          console.error(err);
          return text(500, "hub server error");
        }));

      app.get("/hub/api/state", async (c) => wrap(
        async () => service.buildStatePayload(
          asOptionalString(c.req.query("commit")),
          asOptionalString(c.req.query("objective")),
        ),
        (payload) => jsonResponse(200, payload)
      ));

      app.get("/hub/api/agents", async () => wrap(
        async () => ({ agents: await service.listAgents() }),
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/api/agents", async (c) => wrap(
        async () => ({ agent: await service.createAgent(await readBody(c.req.raw)) }),
        (payload) => jsonResponse(201, payload)
      ));

      app.get("/hub/api/workspaces", async () => wrap(
        async () => ({ workspaces: await service.listActiveWorkspaces() }),
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/api/workspaces", async (c) => wrap(
        async () => ({ workspace: await service.createWorkspace(await readBody(c.req.raw)) }),
        (payload) => jsonResponse(201, payload)
      ));

      app.get("/hub/api/workspaces/:id", async (c) => wrap(
        async () => ({ workspace: await service.getWorkspace(c.req.param("id")) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/api/workspaces/:id/remove", async (c) => wrap(
        async () => ({ workspace: await service.removeWorkspace(c.req.param("id")) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/api/workspaces/:id/announce", async (c) => wrap(
        async () => ({ announcement: await service.announceWorkspace(c.req.param("id"), await readBody(c.req.raw)) }),
        (payload) => jsonResponse(201, payload)
      ));

      app.get("/hub/api/channels", async () => wrap(
        async () => ({ channels: await service.listChannels() }),
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/api/channels", async (c) => wrap(
        async () => ({ channel: await service.createChannel(await readBody(c.req.raw)) }),
        (payload) => jsonResponse(201, payload)
      ));

      app.get("/hub/api/channels/:name/posts", async (c) => wrap(
        async () => ({ posts: await service.listPosts(c.req.param("name")) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/api/channels/:name/posts", async (c) => wrap(
        async () => ({ post: await service.createPost(await readBody(c.req.raw), undefined, c.req.param("name")) }),
        (payload) => jsonResponse(201, payload)
      ));

      app.post("/hub/api/posts/:id/replies", async (c) => wrap(
        async () => ({ post: await service.createPost(await readBody(c.req.raw), c.req.param("id")) }),
        (payload) => jsonResponse(201, payload)
      ));

      app.get("/hub/api/commits", async (c) => wrap(
        async () => ({ commits: await service.listCommits(Number.parseInt(c.req.query("limit") ?? "40", 10)) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.get("/hub/api/commits/:hash", async (c) => wrap(
        async () => ({ commit: await service.getCommit(c.req.param("hash")) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.get("/hub/api/commits/:hash/children", async (c) => wrap(
        async () => ({ commits: await service.getChildren(c.req.param("hash")) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.get("/hub/api/commits/:hash/lineage", async (c) => wrap(
        async () => ({ commits: await service.getLineage(c.req.param("hash")) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.get("/hub/api/leaves", async (c) => wrap(
        async () => ({ commits: await service.getLeaves(Number.parseInt(c.req.query("limit") ?? "24", 10)) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.get("/hub/api/diff/:hashA/:hashB", async (c) => wrap(
        async () => ({ diff: await service.diff(c.req.param("hashA"), c.req.param("hashB")) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.get("/hub/api/tasks", async () => wrap(
        async () => ({ tasks: await service.listTasks() }),
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/api/tasks", async (c) => wrap(
        async () => ({ task: await service.createTask(await readBody(c.req.raw)) }),
        (payload) => jsonResponse(201, payload)
      ));

      app.get("/hub/api/tasks/:id", async (c) => wrap(
        async () => ({ task: await service.getTask(c.req.param("id")) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.get("/hub/api/objectives", async () => wrap(
        async () => ({ objectives: await service.listObjectives() }),
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/api/objectives", async (c) => wrap(
        async () => {
          const body = await readBody(c.req.raw);
          const checksInput = typeof body.checks === "string"
            ? body.checks.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
            : Array.isArray(body.checks)
              ? body.checks.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
              : undefined;
          return {
            objective: await service.createObjective({
              title: asTrimmed(body.title),
              prompt: asTrimmed(body.prompt),
              baseHash: asOptionalString(body.baseHash),
              channel: asOptionalString(body.channel),
              checks: checksInput,
            }),
          };
        },
        (payload) => jsonResponse(201, payload)
      ));

      app.get("/hub/api/objectives/:id", async (c) => wrap(
        async () => ({ objective: await service.getObjective(c.req.param("id")) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/api/objectives/:id/approve", async (c) => wrap(
        async () => ({ objective: await service.approveObjective(c.req.param("id")) }),
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/api/objectives/:id/cancel", async (c) => wrap(
        async () => {
          const body = await readBody(c.req.raw);
          return {
            objective: await service.cancelObjective(c.req.param("id"), asOptionalString(body.reason)),
          };
        },
        (payload) => jsonResponse(200, payload)
      ));

      app.post("/hub/ui/agents", async (c) => wrap(
        async () => service.createAgent(await readBody(c.req.raw)),
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));

      app.post("/hub/ui/channels", async (c) => wrap(
        async () => service.createChannel(await readBody(c.req.raw)),
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));

      app.post("/hub/ui/posts", async (c) => wrap(
        async () => service.createPost(await readBody(c.req.raw)),
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));

      app.post("/hub/ui/posts/:id/reply", async (c) => wrap(
        async () => service.createPost(await readBody(c.req.raw), c.req.param("id")),
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));

      app.post("/hub/ui/workspaces", async (c) => wrap(
        async () => service.createWorkspace(await readBody(c.req.raw)),
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));

      app.post("/hub/ui/workspaces/:id/announce", async (c) => wrap(
        async () => service.announceWorkspace(c.req.param("id"), await readBody(c.req.raw)),
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));

      app.post("/hub/ui/workspaces/:id/remove", async (c) => wrap(
        async () => service.removeWorkspace(c.req.param("id")),
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));

      app.post("/hub/ui/tasks", async (c) => wrap(
        async () => service.createTask(await readBody(c.req.raw)),
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));

      app.post("/hub/ui/objectives", async (c) => wrap(
        async () => {
          const body = await readBody(c.req.raw);
          const checks = asTrimmed(body.checks)
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean);
          await service.createObjective({
            title: asTrimmed(body.title),
            prompt: asTrimmed(body.prompt),
            baseHash: asOptionalString(body.baseHash),
            channel: asOptionalString(body.channel),
            checks,
          });
        },
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));

      app.post("/hub/ui/objectives/:id/approve", async (c) => wrap(
        async () => service.approveObjective(c.req.param("id")),
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));

      app.post("/hub/ui/objectives/:id/cancel", async (c) => wrap(
        async () => service.cancelObjective(c.req.param("id")),
        () => emptyOk({ "HX-Trigger": "hub-refresh" })
      ));
    },
  };
};

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createHubRoute(ctx);

export default factory;
