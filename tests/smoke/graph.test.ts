import assert from "node:assert/strict";
import test from "node:test";

import {
  activatableNodes,
  createGraphState,
  graphProjection,
  runnableNodes,
  type GraphBuckets,
  type GraphNodeBase,
  type GraphState,
} from "../../src/core/graph.ts";

type TestStatus = "pending" | "ready" | "running" | "completed" | "blocked";

type TestNode = GraphNodeBase<TestStatus> & {
  readonly title: string;
};

const buckets: GraphBuckets<TestStatus> = {
  planned: ["pending"],
  ready: ["ready"],
  active: ["running"],
  completed: ["completed"],
  blocked: ["blocked"],
  terminal: ["completed", "blocked"],
};

const withNodes = (
  state: GraphState<TestNode>,
  nodes: ReadonlyArray<TestNode>,
): GraphState<TestNode> => ({
  ...state,
  order: nodes.map((node) => node.nodeId),
  nodes: Object.fromEntries(nodes.map((node) => [node.nodeId, node])),
});

test("graph: dependency activation, multi-active execution, and replay projection stay deterministic", () => {
  const initial = withNodes(createGraphState<TestNode>("graph_demo", 1, "active"), [
    {
      nodeId: "planner",
      title: "Planner",
      dependsOn: [],
      status: "pending",
    },
    {
      nodeId: "builder",
      title: "Builder",
      dependsOn: ["planner"],
      status: "pending",
    },
    {
      nodeId: "reviewer",
      title: "Reviewer",
      dependsOn: ["builder"],
      status: "pending",
    },
  ]);

  assert.deepEqual(activatableNodes(initial, { planned: buckets.planned, completed: buckets.completed }).map((node) => node.nodeId), ["planner"]);
  assert.deepEqual(runnableNodes(initial, { ready: buckets.ready, completed: buckets.completed }).map((node) => node.nodeId), []);

  const plannerReady = withNodes(createGraphState<TestNode>("graph_demo", 2, "active"), [
    {
      nodeId: "planner",
      title: "Planner",
      dependsOn: [],
      status: "ready",
    },
    {
      nodeId: "builder",
      title: "Builder",
      dependsOn: ["planner"],
      status: "pending",
    },
    {
      nodeId: "reviewer",
      title: "Reviewer",
      dependsOn: ["builder"],
      status: "pending",
    },
  ]);

  assert.deepEqual(runnableNodes(plannerReady, { ready: buckets.ready, completed: buckets.completed }).map((node) => node.nodeId), ["planner"]);

  const plannerCompleted = withNodes(createGraphState<TestNode>("graph_demo", 3, "active"), [
    {
      nodeId: "planner",
      title: "Planner",
      dependsOn: [],
      status: "completed",
    },
    {
      nodeId: "builder",
      title: "Builder",
      dependsOn: ["planner"],
      status: "pending",
    },
    {
      nodeId: "reviewer",
      title: "Reviewer",
      dependsOn: ["builder"],
      status: "pending",
    },
  ]);

  assert.deepEqual(activatableNodes(plannerCompleted, { planned: buckets.planned, completed: buckets.completed }).map((node) => node.nodeId), ["builder"]);

  const parallelReady: GraphState<TestNode> = {
    ...withNodes(createGraphState<TestNode>("graph_demo", 4, "active"), [
      {
        nodeId: "builder_a",
        title: "Builder A",
        dependsOn: [],
        status: "ready",
      },
      {
        nodeId: "builder_b",
        title: "Builder B",
        dependsOn: [],
        status: "ready",
      },
    ]),
    activeNodeIds: ["builder_a"],
  };

  assert.deepEqual(
    runnableNodes(parallelReady, { ready: buckets.ready, completed: buckets.completed }).map((node) => node.nodeId),
    ["builder_b"],
  );

  const replayA = graphProjection(plannerCompleted, buckets);
  const replayB = graphProjection(withNodes(createGraphState<TestNode>("graph_demo", 3, "active"), [
    {
      nodeId: "planner",
      title: "Planner",
      dependsOn: [],
      status: "completed",
    },
    {
      nodeId: "builder",
      title: "Builder",
      dependsOn: ["planner"],
      status: "pending",
    },
    {
      nodeId: "reviewer",
      title: "Reviewer",
      dependsOn: ["builder"],
      status: "pending",
    },
  ]), buckets);

  assert.deepEqual(replayA, replayB);
  assert.deepEqual(replayA.completed.map((node) => node.nodeId), ["planner"]);
  assert.deepEqual(replayA.planned.map((node) => node.nodeId), ["builder", "reviewer"]);
});
