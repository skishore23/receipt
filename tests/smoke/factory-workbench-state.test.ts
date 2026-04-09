import { expect, test } from "bun:test";

import {
  createWorkbenchRouteState,
  createWorkbenchUiState,
  mergeReplayRoute,
  serializeWorkbenchReplay,
  parseWorkbenchReplay,
  workbenchReducer,
} from "../../src/client/factory-client/workbench-state";

test("factory workbench state: reducer applies inspector, focus, and scope changes deterministically", () => {
  const baseRoute = createWorkbenchRouteState({
    profileId: "generalist",
    chatId: "chat_demo",
    objectiveId: "objective_demo",
    detailTab: "review",
  });
  const booted = createWorkbenchUiState(baseRoute);
  expect(baseRoute.routeKey).toBe("/factory?profile=generalist&chat=chat_demo&objective=objective_demo&detailTab=review");

  const inspectorRoute = createWorkbenchRouteState({
    ...baseRoute,
    inspectorTab: "chat",
  });
  const afterInspector = workbenchReducer(booted, {
    type: "inspector.changed",
    route: inspectorRoute,
  });
  expect(afterInspector.appliedRoute.inspectorTab).toBe("chat");

  const focusRoute = createWorkbenchRouteState({
    ...inspectorRoute,
    focusKind: "task",
    focusId: "task_1",
  });
  const afterFocus = workbenchReducer(afterInspector, {
    type: "focus.changed",
    route: focusRoute,
  });
  expect(afterFocus.appliedRoute.focusKind).toBe("task");
  expect(afterFocus.appliedRoute.focusId).toBe("task_1");

  const scopeRoute = createWorkbenchRouteState({
    ...focusRoute,
    objectiveId: "objective_next",
    focusKind: undefined,
    focusId: undefined,
  });
  const requested = workbenchReducer(afterFocus, {
    type: "route.requested",
    route: scopeRoute,
  });
  expect(requested.desiredRoute.objectiveId).toBe("objective_next");
  expect(requested.appliedRoute.objectiveId).toBe("objective_demo");

  const applied = workbenchReducer(requested, {
    type: "route.applied",
    route: scopeRoute,
  });
  expect(applied.appliedRoute.objectiveId).toBe("objective_next");
  expect(applied.desiredRoute.objectiveId).toBe("objective_next");
});

test("factory workbench state: replay merges only missing view state and preserves ephemeral turn ttl", () => {
  const route = createWorkbenchRouteState({
    profileId: "generalist",
    chatId: "chat_demo",
    objectiveId: "objective_demo",
  });
  const replayed = mergeReplayRoute(route, {
    savedAt: Date.now(),
    route: {
      profileId: "generalist",
      chatId: "chat_demo",
      objectiveId: "objective_old",
      inspectorTab: "notes" as unknown as "overview",
      detailTab: "queue",
      filter: "objective.completed",
      page: 3,
      focusKind: "job",
      focusId: "job_42",
    },
    ephemeralTurn: {
      phase: "pending",
      statusLabel: "Queued",
      summary: "Queued for replay",
      runId: "run_1",
      savedAt: Date.now(),
    },
  });

  expect(replayed.objectiveId).toBe("objective_demo");
  expect(replayed.inspectorTab).toBe("overview");
  expect(replayed.detailTab).toBe("queue");
  expect(replayed.filter).toBe("objective.completed");
  expect(replayed.page).toBe(3);
  expect(replayed.focusKind).toBe("job");
  expect(replayed.focusId).toBe("job_42");

  const serialized = serializeWorkbenchReplay({
    ...createWorkbenchUiState(replayed),
    ephemeralTurn: {
      phase: "pending",
      statusLabel: "Queued",
      summary: "Queued for replay",
      runId: "run_1",
      savedAt: Date.now(),
    },
  }, Date.now());
  const parsed = parseWorkbenchReplay(JSON.stringify(serialized), Date.now());
  expect(parsed?.route.inspectorTab).toBe("overview");
  expect(parsed?.route.detailTab).toBe("queue");
  expect(parsed?.route.filter).toBe("objective.completed");
  expect(parsed?.route.page).toBe(3);
  expect(parsed?.ephemeralTurn?.runId).toBe("run_1");
});

test("factory workbench state: explicit page selection wins over replayed page", () => {
  const route = createWorkbenchRouteState({
    profileId: "generalist",
    chatId: "chat_demo",
    objectiveId: "objective_demo",
    page: 2,
  });

  const replayed = mergeReplayRoute(route, {
    savedAt: Date.now(),
    route: {
      profileId: "generalist",
      chatId: "chat_demo",
      objectiveId: "objective_demo",
      page: 4,
    },
  }, {
    preserveExplicitPage: true,
  });

  expect(replayed.page).toBe(2);
});
