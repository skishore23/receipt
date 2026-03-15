import type { Hono } from "hono";

import { HubGitError } from "../adapters/hub-git.js";
import { LocalCodexExecutor } from "../adapters/codex-executor.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import type { AgentLoaderContext, AgentRouteModule } from "../framework/agent-types.js";
import {
  emptyHtml,
  html,
  json,
  optionalTrimmedString,
  readRecordBody,
  text,
} from "../framework/http.js";
import { HubService, HubServiceError } from "../services/hub-service.js";
import {
  hubCommitsIsland,
  hubDebugIsland,
  hubShell,
  hubSummaryIsland,
} from "../views/hub.js";

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

  return {
    id: "hub",
    kind: "hub",
    paths: {
      shell: "/hub",
      events: "/hub/events",
      state: "/hub/api/state",
    },
    register: (app: Hono) => {
      app.get("/hub", async (c) => {
        const objectiveId = optionalTrimmedString(c.req.query("objective"));
        if (objectiveId) {
          return c.redirect(`/factory?objective=${encodeURIComponent(objectiveId)}`, 302);
        }
        return wrap(
          async () => {
            await service.ensureBootstrap();
            const selectedCommit = optionalTrimmedString(c.req.query("commit"));
            const [summary, commits, debug] = await Promise.all([
              service.buildRepoProjection(),
              service.buildCommitProjection(selectedCommit),
              service.buildDebugProjection(),
            ]);
            return {
              summary,
              commits,
              debug,
            };
          },
          (payload) => html(hubShell({
            summaryIsland: hubSummaryIsland(payload.summary),
            commitsIsland: hubCommitsIsland(payload.commits),
            debugIsland: hubDebugIsland(payload.debug),
          }))
        );
      });

      app.get("/hub/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          return null;
        },
        () => ctx.sse.subscribeMany([{ topic: "receipt" }, { topic: "jobs" }], c.req.raw.signal)
      ));

      app.get("/hub/island/summary", async () => wrap(
        async () => service.buildRepoProjection(),
        (payload) => html(hubSummaryIsland(payload))
      ));

      app.get("/hub/island/commits", async (c) => wrap(
        async () => service.buildCommitProjection(optionalTrimmedString(c.req.query("commit"))),
        (payload) => html(hubCommitsIsland(payload))
      ));

      app.get("/hub/island/debug", async () => wrap(
        async () => service.buildDebugProjection(),
        (payload) => html(hubDebugIsland(payload))
      ));

      app.get("/hub/api/state", async (c) => wrap(
        async () => service.buildStatePayload(optionalTrimmedString(c.req.query("commit"))),
        (payload) => json(200, payload)
      ));

      app.get("/hub/api/agents", async () => wrap(
        async () => ({ agents: await service.listAgents() }),
        (payload) => json(200, payload)
      ));

      app.post("/hub/api/agents", async (c) => wrap(
        async () => ({ agent: await service.createAgent(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))) }),
        (payload) => json(201, payload)
      ));

      app.get("/hub/api/workspaces", async () => wrap(
        async () => ({ workspaces: await service.listActiveWorkspaces() }),
        (payload) => json(200, payload)
      ));

      app.post("/hub/api/workspaces", async (c) => wrap(
        async () => ({ workspace: await service.createWorkspace(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))) }),
        (payload) => json(201, payload)
      ));

      app.get("/hub/api/workspaces/:id", async (c) => wrap(
        async () => ({ workspace: await service.getWorkspace(c.req.param("id")) }),
        (payload) => json(200, payload)
      ));

      app.post("/hub/api/workspaces/:id/remove", async (c) => wrap(
        async () => ({ workspace: await service.removeWorkspace(c.req.param("id")) }),
        (payload) => json(200, payload)
      ));

      app.post("/hub/api/workspaces/:id/announce", async (c) => wrap(
        async () => ({ announcement: await service.announceWorkspace(c.req.param("id"), await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))) }),
        (payload) => json(201, payload)
      ));

      app.get("/hub/api/channels", async () => wrap(
        async () => ({ channels: await service.listChannels() }),
        (payload) => json(200, payload)
      ));

      app.post("/hub/api/channels", async (c) => wrap(
        async () => ({ channel: await service.createChannel(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))) }),
        (payload) => json(201, payload)
      ));

      app.get("/hub/api/channels/:name/posts", async (c) => wrap(
        async () => ({ posts: await service.listPosts(c.req.param("name")) }),
        (payload) => json(200, payload)
      ));

      app.post("/hub/api/channels/:name/posts", async (c) => wrap(
        async () => ({ post: await service.createPost(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message)), undefined, c.req.param("name")) }),
        (payload) => json(201, payload)
      ));

      app.post("/hub/api/posts/:id/replies", async (c) => wrap(
        async () => ({ post: await service.createPost(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message)), c.req.param("id")) }),
        (payload) => json(201, payload)
      ));

      app.get("/hub/api/commits", async (c) => wrap(
        async () => ({ commits: await service.listCommits(Number.parseInt(c.req.query("limit") ?? "40", 10)) }),
        (payload) => json(200, payload)
      ));

      app.get("/hub/api/commits/:hash", async (c) => wrap(
        async () => ({ commit: await service.getCommit(c.req.param("hash")) }),
        (payload) => json(200, payload)
      ));

      app.get("/hub/api/commits/:hash/children", async (c) => wrap(
        async () => ({ commits: await service.getChildren(c.req.param("hash")) }),
        (payload) => json(200, payload)
      ));

      app.get("/hub/api/commits/:hash/lineage", async (c) => wrap(
        async () => ({ commits: await service.getLineage(c.req.param("hash")) }),
        (payload) => json(200, payload)
      ));

      app.get("/hub/api/leaves", async (c) => wrap(
        async () => ({ commits: await service.getLeaves(Number.parseInt(c.req.query("limit") ?? "24", 10)) }),
        (payload) => json(200, payload)
      ));

      app.get("/hub/api/diff/:hashA/:hashB", async (c) => wrap(
        async () => ({ diff: await service.diff(c.req.param("hashA"), c.req.param("hashB")) }),
        (payload) => json(200, payload)
      ));

      app.get("/hub/api/tasks", async () => wrap(
        async () => ({ tasks: await service.listTasks() }),
        (payload) => json(200, payload)
      ));

      app.post("/hub/api/tasks", async (c) => wrap(
        async () => ({ task: await service.createTask(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))) }),
        (payload) => json(201, payload)
      ));

      app.get("/hub/api/tasks/:id", async (c) => wrap(
        async () => ({ task: await service.getTask(c.req.param("id")) }),
        (payload) => json(200, payload)
      ));

      app.post("/hub/ui/agents", async (c) => wrap(
        async () => service.createAgent(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))),
        () => emptyHtml({ "HX-Redirect": "/hub" })
      ));

      app.post("/hub/ui/channels", async (c) => wrap(
        async () => service.createChannel(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))),
        () => emptyHtml({ "HX-Redirect": "/hub" })
      ));

      app.post("/hub/ui/posts", async (c) => wrap(
        async () => service.createPost(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))),
        () => emptyHtml({ "HX-Redirect": "/hub" })
      ));

      app.post("/hub/ui/posts/:id/reply", async (c) => wrap(
        async () => service.createPost(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message)), c.req.param("id")),
        () => emptyHtml({ "HX-Redirect": "/hub" })
      ));

      app.post("/hub/ui/workspaces", async (c) => wrap(
        async () => service.createWorkspace(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))),
        () => emptyHtml({ "HX-Redirect": "/hub" })
      ));

      app.post("/hub/ui/workspaces/:id/announce", async (c) => wrap(
        async () => service.announceWorkspace(c.req.param("id"), await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))),
        () => emptyHtml({ "HX-Redirect": "/hub" })
      ));

      app.post("/hub/ui/tasks", async (c) => wrap(
        async () => service.createTask(await readRecordBody(c.req.raw, (message) => new HubServiceError(400, message))),
        () => emptyHtml({ "HX-Redirect": "/hub" })
      ));
    },
  };
};

export default createHubRoute;
