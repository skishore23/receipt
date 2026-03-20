const nodeList = (state) => state.order
    .map((nodeId) => state.nodes[nodeId])
    .filter((node) => Boolean(node));
const statusSet = (values) => new Set(values ?? []);
const inStatuses = (node, statuses) => statuses.has(node.status);
const depsSatisfied = (state, node, completed) => node.dependsOn.every((depId) => {
    const dep = state.nodes[depId];
    return Boolean(dep) && completed.has(dep.status);
});
export const createGraphState = (graphId, updatedAt, status) => ({
    graphId,
    status,
    activeNodeIds: [],
    order: [],
    nodes: {},
    updatedAt,
});
export const graphNodeList = nodeList;
export const graphProjection = (state, buckets) => {
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
export const runnableNodes = (state, buckets) => {
    const ready = statusSet(buckets.ready);
    const completed = statusSet(buckets.completed);
    return nodeList(state).filter((node) => !state.activeNodeIds.includes(node.nodeId)
        && inStatuses(node, ready)
        && depsSatisfied(state, node, completed));
};
export const activatableNodes = (state, buckets) => {
    const planned = statusSet(buckets.planned);
    const completed = statusSet(buckets.completed);
    return nodeList(state).filter((node) => !state.activeNodeIds.includes(node.nodeId)
        && inStatuses(node, planned)
        && depsSatisfied(state, node, completed));
};
