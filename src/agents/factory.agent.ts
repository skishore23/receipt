import type { Hono } from "hono";

import {
  emptyHtml,
  html,
  json,
  optionalTrimmedString,
  readRecordBody,
  text,
  trimmedString,
} from "../framework/http.js";
import type { AgentLoaderContext, AgentRouteModule } from "../framework/agent-types.js";
import { LocalCodexExecutor } from "../adapters/codex-executor.js";
import type { MemoryTools } from "../adapters/memory-tools.js";
import { FactoryService, FactoryServiceError } from "../services/factory-service.js";
import {
  factoryBoardIsland,
  factoryComposeIsland,
  factoryDebugIsland,
  factoryLiveIsland,
  factoryObjectiveIsland,
  factoryShell,
} from "../views/factory.js";

const parseChecks = (value: unknown): ReadonlyArray<string> | undefined => {
  if (typeof value === "string") {
    const lines = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    return lines.length ? lines : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  return undefined;
};

const parsePolicy = (value: unknown): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      throw new FactoryServiceError(400, "Malformed policy JSON");
    }
    throw new FactoryServiceError(400, "Policy must be an object");
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new FactoryServiceError(400, "Policy must be an object");
};

const createFactoryRoute = (ctx: AgentLoaderContext): AgentRouteModule => {
  const helpers = ctx.helpers ?? {};
  const service = (helpers.factoryService as FactoryService | undefined) ?? new FactoryService({
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
      if (err instanceof FactoryServiceError) return text(err.status, err.message);
      console.error(err);
      return text(500, "factory server error");
    }
  };

  const selectedObjectiveId = (req: Request): string | undefined =>
    optionalTrimmedString(new URL(req.url).searchParams.get("objective"));

  const objectiveRedirect = (objectiveId?: string): Response =>
    emptyHtml({ "HX-Redirect": objectiveId ? `/factory?objective=${encodeURIComponent(objectiveId)}` : "/factory" });

  return {
    id: "factory",
    kind: "factory",
    paths: {
      shell: "/factory",
      state: "/factory/api/objectives",
      events: "/factory/events",
    },
    register: (app: Hono) => {
      app.get("/factory", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          const objectiveId = selectedObjectiveId(c.req.raw);
          const board = await service.buildBoardProjection(objectiveId);
          const resolvedObjectiveId = board.selectedObjectiveId;
          const [compose, objective, live, debug] = await Promise.all([
            service.buildComposeModel(),
            resolvedObjectiveId ? service.getObjective(resolvedObjectiveId) : Promise.resolve(undefined),
            service.buildLiveProjection(resolvedObjectiveId),
            resolvedObjectiveId ? service.getObjectiveDebug(resolvedObjectiveId) : Promise.resolve(undefined),
          ]);
          return {
            compose,
            board,
            objective,
            live,
            debug,
          };
        },
        (payload) => html(factoryShell({
          composeIsland: factoryComposeIsland(payload.compose),
          boardIsland: factoryBoardIsland(payload.board),
          objectiveIsland: factoryObjectiveIsland(payload.objective),
          liveIsland: factoryLiveIsland(payload.live),
          debugIsland: factoryDebugIsland(payload.debug),
        }))
      ));

      app.get("/factory/events", async (c) => wrap(
        async () => {
          await service.ensureBootstrap();
          return null;
        },
        () => ctx.sse.subscribeMany([{ topic: "receipt" }, { topic: "jobs" }], c.req.raw.signal)
      ));

      app.get("/factory/island/compose", async () => wrap(
        async () => service.buildComposeModel(),
        (model) => html(factoryComposeIsland(model))
      ));

      app.get("/factory/island/board", async (c) => wrap(
        async () => service.buildBoardProjection(selectedObjectiveId(c.req.raw)),
        (board) => html(factoryBoardIsland(board))
      ));

      app.get("/factory/island/objective", async (c) => wrap(
        async () => {
          const objectiveId = selectedObjectiveId(c.req.raw);
          return objectiveId ? service.getObjective(objectiveId) : Promise.resolve(undefined);
        },
        (objective) => html(factoryObjectiveIsland(objective))
      ));

      app.get("/factory/island/live", async (c) => wrap(
        async () => service.buildLiveProjection(selectedObjectiveId(c.req.raw)),
        (live) => html(factoryLiveIsland(live))
      ));

      app.get("/factory/island/debug", async (c) => wrap(
        async () => {
          const objectiveId = selectedObjectiveId(c.req.raw);
          return objectiveId ? service.getObjectiveDebug(objectiveId) : Promise.resolve(undefined);
        },
        (debug) => html(factoryDebugIsland(debug))
      ));

      app.get("/factory/api/objectives", async (c) => wrap(
        async () => ({
          objectives: await service.listObjectives(),
          board: await service.buildBoardProjection(optionalTrimmedString(c.req.query("objective"))),
        }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives", async (c) => wrap(
        async () => {
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          return {
            objective: await service.createObjective({
              title: trimmedString(body.title),
              prompt: trimmedString(body.prompt),
              baseHash: optionalTrimmedString(body.baseHash),
              checks: parseChecks(body.checks),
              channel: optionalTrimmedString(body.channel),
              policy: parsePolicy(body.policy),
            }),
          };
        },
        (body) => json(201, body)
      ));

      app.get("/factory/api/objectives/:id", async (c) => wrap(
        async () => ({ objective: await service.getObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives/:id/debug", async (c) => wrap(
        async () => ({ debug: await service.getObjectiveDebug(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.get("/factory/api/objectives/:id/receipts", async (c) => wrap(
        async () => ({
          receipts: await service.listObjectiveReceipts(
            c.req.param("id"),
            Number.parseInt(c.req.query("limit") ?? "40", 10),
          ),
        }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/react", async (c) => wrap(
        async () => {
          await service.reactObjective(c.req.param("id"));
          return { objective: await service.getObjective(c.req.param("id")) };
        },
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/promote", async (c) => wrap(
        async () => ({ objective: await service.promoteObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/cancel", async (c) => wrap(
        async () => {
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          return { objective: await service.cancelObjective(c.req.param("id"), optionalTrimmedString(body.reason)) };
        },
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/archive", async (c) => wrap(
        async () => ({ objective: await service.archiveObjective(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/api/objectives/:id/cleanup", async (c) => wrap(
        async () => ({ objective: await service.cleanupObjectiveWorkspaces(c.req.param("id")) }),
        (body) => json(200, body)
      ));

      app.post("/factory/ui/objectives", async (c) => wrap(
        async () => {
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          const created = await service.createObjective({
            title: trimmedString(body.title),
            prompt: trimmedString(body.prompt),
            baseHash: optionalTrimmedString(body.baseHash),
            checks: parseChecks(body.checks),
            channel: optionalTrimmedString(body.channel),
            policy: parsePolicy(body.policy),
          });
          return created.objectiveId;
        },
        (objectiveId) => objectiveRedirect(objectiveId)
      ));

      app.post("/factory/ui/objectives/:id/react", async (c) => wrap(
        async () => {
          await service.reactObjective(c.req.param("id"));
          return c.req.param("id");
        },
        (objectiveId) => objectiveRedirect(objectiveId)
      ));

      app.post("/factory/ui/objectives/:id/promote", async (c) => wrap(
        async () => {
          await service.promoteObjective(c.req.param("id"));
          return c.req.param("id");
        },
        (objectiveId) => objectiveRedirect(objectiveId)
      ));

      app.post("/factory/ui/objectives/:id/cancel", async (c) => wrap(
        async () => {
          const body = await readRecordBody(c.req.raw, (message) => new FactoryServiceError(400, message));
          await service.cancelObjective(c.req.param("id"), optionalTrimmedString(body.reason));
          return c.req.param("id");
        },
        (objectiveId) => objectiveRedirect(objectiveId)
      ));

      app.post("/factory/ui/objectives/:id/archive", async (c) => wrap(
        async () => {
          await service.archiveObjective(c.req.param("id"));
          return undefined;
        },
        () => objectiveRedirect(undefined)
      ));

      app.post("/factory/ui/objectives/:id/cleanup", async (c) => wrap(
        async () => {
          await service.cleanupObjectiveWorkspaces(c.req.param("id"));
          return c.req.param("id");
        },
        (objectiveId) => objectiveRedirect(objectiveId)
      ));
    },
  };
};

export default createFactoryRoute;
