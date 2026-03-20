export type GraphRefKind =
  | "state"
  | "artifact"
  | "file"
  | "workspace"
  | "commit"
  | "job"
  | "prompt";

export type GraphRef = {
  readonly kind: GraphRefKind;
  readonly ref: string;
  readonly label?: string;
};

export type GraphRunStatus =
  | "active"
  | "waiting"
  | "completed"
  | "blocked"
  | "failed"
  | "canceled";

export type GraphNodeBase<TStatus extends string = string> = {
  readonly nodeId: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly status: TStatus;
};

export type GraphState<
  TNode extends GraphNodeBase<string>,
  TRunStatus extends string = GraphRunStatus,
> = {
  readonly graphId: string;
  readonly status: TRunStatus;
  readonly activeNodeIds: ReadonlyArray<string>;
  readonly order: ReadonlyArray<string>;
  readonly nodes: Readonly<Record<string, TNode>>;
  readonly updatedAt: number;
};

export type GraphBuckets<TStatus extends string> = {
  readonly planned: ReadonlyArray<TStatus>;
  readonly ready: ReadonlyArray<TStatus>;
  readonly active?: ReadonlyArray<TStatus>;
  readonly completed: ReadonlyArray<TStatus>;
  readonly blocked?: ReadonlyArray<TStatus>;
  readonly terminal: ReadonlyArray<TStatus>;
};

export type GraphProjection<TNode extends GraphNodeBase<string>> = {
  readonly active: ReadonlyArray<TNode>;
  readonly planned: ReadonlyArray<TNode>;
  readonly ready: ReadonlyArray<TNode>;
  readonly completed: ReadonlyArray<TNode>;
  readonly blocked: ReadonlyArray<TNode>;
  readonly terminal: ReadonlyArray<TNode>;
};

const nodeList = <TNode extends GraphNodeBase<string>>(state: GraphState<TNode, string>): TNode[] =>
  state.order
    .map((nodeId) => state.nodes[nodeId])
    .filter((node): node is TNode => Boolean(node));

const statusSet = <TStatus extends string>(values: ReadonlyArray<TStatus> | undefined): ReadonlySet<TStatus> =>
  new Set(values ?? []);

const inStatuses = <TNode extends GraphNodeBase<string>>(
  node: TNode,
  statuses: ReadonlySet<TNode["status"]>,
): boolean => statuses.has(node.status);

const depsSatisfied = <TNode extends GraphNodeBase<string>>(
  state: GraphState<TNode, string>,
  node: TNode,
  completed: ReadonlySet<TNode["status"]>,
): boolean =>
  node.dependsOn.every((depId) => {
    const dep = state.nodes[depId];
    return Boolean(dep) && completed.has(dep.status);
  });

export const createGraphState = <
  TNode extends GraphNodeBase<string>,
  TRunStatus extends string = GraphRunStatus,
>(
  graphId: string,
  updatedAt: number,
  status: TRunStatus,
): GraphState<TNode, TRunStatus> => ({
  graphId,
  status,
  activeNodeIds: [],
  order: [],
  nodes: {},
  updatedAt,
});

export const graphNodeList = nodeList;

export const graphProjection = <TNode extends GraphNodeBase<string>>(
  state: GraphState<TNode, string>,
  buckets: GraphBuckets<TNode["status"]>,
): GraphProjection<TNode> => {
  const nodes = nodeList(state);
  const planned = statusSet(buckets.planned);
  const ready = statusSet(buckets.ready);
  const active = statusSet(buckets.active);
  const completed = statusSet(buckets.completed);
  const blocked = statusSet(buckets.blocked);
  const terminal = statusSet(buckets.terminal);
  return {
    active: nodes.filter((node) => state.activeNodeIds.includes(node.nodeId) || inStatuses(node, active)),
    planned: nodes.filter((node) => inStatuses(node, planned)),
    ready: nodes.filter((node) => inStatuses(node, ready)),
    completed: nodes.filter((node) => inStatuses(node, completed)),
    blocked: nodes.filter((node) => inStatuses(node, blocked)),
    terminal: nodes.filter((node) => inStatuses(node, terminal)),
  };
};

export const runnableNodes = <TNode extends GraphNodeBase<string>>(
  state: GraphState<TNode, string>,
  buckets: Pick<GraphBuckets<TNode["status"]>, "ready" | "completed">,
): ReadonlyArray<TNode> => {
  const ready = statusSet(buckets.ready);
  const completed = statusSet(buckets.completed);
  return nodeList(state).filter((node) =>
    !state.activeNodeIds.includes(node.nodeId)
    && inStatuses(node, ready)
    && depsSatisfied(state, node, completed)
  );
};

export const activatableNodes = <TNode extends GraphNodeBase<string>>(
  state: GraphState<TNode, string>,
  buckets: Pick<GraphBuckets<TNode["status"]>, "planned" | "completed">,
): ReadonlyArray<TNode> => {
  const planned = statusSet(buckets.planned);
  const completed = statusSet(buckets.completed);
  return nodeList(state).filter((node) =>
    !state.activeNodeIds.includes(node.nodeId)
    && inStatuses(node, planned)
    && depsSatisfied(state, node, completed)
  );
};
