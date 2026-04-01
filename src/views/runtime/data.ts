// ============================================================================
// Runtime visualization — data model
// ============================================================================

export type RuntimePlane = "control" | "execution" | "side-effects";

export type RuntimeActor = {
  id: string;
  label: string;
  plane: RuntimePlane;
  group?: string;
  icon: string;
  impl: string;            // concrete module + function/class name
  owns: string;
  reads: string[];
  writes: string[];
  emits?: string[];
  handoff?: string;
};

export type RuntimeStore = {
  name: string;
  kind: string;
  description: string;
};

export type RuntimeSideEffect = {
  label: string;
  kind: "realtime" | "projection" | "background";
  description: string;
};

export type RuntimeDelegationStep = {
  step: string;
  description: string;
};

// ── Actors ──────────────────────────────────────────────────────────────────

export const actors: readonly RuntimeActor[] = [
  {
    id: "http-commands",
    label: "HTTP Commands",
    plane: "control",
    icon: "iconCodex",
    impl: "handlers.ts → register() Hono routes",
    owns: "Translate external requests into orchestration state",
    reads: ["request payload", "auth / tenant scope", "session / thread context"],
    writes: ["sessions", "threads", "work_items", "runs"],
    handoff: "Readiness Engine (via poll)",
  },
  {
    id: "readiness-engine",
    label: "Readiness Engine",
    plane: "control",
    group: "poll-loop",
    icon: "iconJob",
    impl: "selectors.ts → factoryReadyTasks() · factoryActivatableTasks()",
    owns: "Select next actionable readiness decision",
    reads: ["work_items", "runs", "wait_entries", "run_leases"],
    writes: ["ReadinessDecision (in-memory)"],
    handoff: "Lease Controller",
  },
  {
    id: "lease-controller",
    label: "Lease Controller",
    plane: "control",
    group: "poll-loop",
    icon: "iconWorker",
    impl: "job-worker.ts → JobWorker · jsonl-queue.ts → leaseNext() · heartbeat()",
    owns: "Acquire, renew, release exclusive run ownership",
    reads: ["readiness decision", "run snapshot", "work_item state"],
    writes: ["run_leases", "runs.status", "work_items.status", "run.started / run.resumed events"],
    handoff: "Run Driver",
  },
  {
    id: "run-driver",
    label: "Run Driver",
    plane: "execution",
    icon: "iconRun",
    impl: "resonate-runtime.ts → runDriver() · agent.ts → runAgent() iteration loop",
    owns: "One leased execution turn",
    reads: ["thread context", "summaries", "memory", "pending waits", "tool policy"],
    writes: ["items", "session_messages", "usage_ledger", "runs", "event_outbox"],
    emits: ["domain events → event_outbox", "incl. message.posted"],
    handoff: "Tool Executor · or complete · or wait",
  },
  {
    id: "tool-executor",
    label: "Tool Executor",
    plane: "execution",
    icon: "iconAgent",
    impl: "capabilityRegistry.execute() · codex-executor.ts → LocalCodexExecutor.run()",
    owns: "Validate, dispatch, and resolve tool calls",
    reads: ["tool registry", "agent runtime policy", "MCP-backed tool config"],
    writes: ["tool_executions", "wait_entries", "child runs"],
    emits: ["tool events → event_outbox"],
    handoff: "Outcomes back to Run Driver",
  },
  {
    id: "outbox-worker",
    label: "Outbox Worker",
    plane: "side-effects",
    icon: "iconQueue",
    impl: "event-outbox drainer · SSE hub push · projection handlers",
    owns: "Drain queued side effects by topic",
    reads: ["event_outbox (switched by topic)"],
    writes: ["outbox delivery state"],
    emits: ["realtime SSE", "projections", "background jobs"],
  },
] as const;

// ── Data stores ─────────────────────────────────────────────────────────────

export const stores: readonly RuntimeStore[] = [
  { name: "work_items", kind: "DEPENDENCY GRAPH", description: "Schedulable nodes; readiness lives here" },
  { name: "work_item_edges", kind: "DEPENDENCY GRAPH", description: "Explicit edges that gate execution order" },
  { name: "runs", kind: "RUN TREE", description: "Execution attempts; parentRunId / rootRunId form the delegation tree" },
  { name: "wait_entries", kind: "WAIT GRAPH", description: "Blocked dependencies + external waits; targetRunId links child delivery" },
  { name: "run_leases", kind: "LEASE TABLE", description: "Temporary worker ownership; expiresAt drives stale-run recovery" },
  { name: "items", kind: "RUN TRANSCRIPT", description: "message · function_call · function_call_output · reasoning" },
  { name: "session_messages", kind: "UI TRANSCRIPT", description: "Assistant messages written on run completion; source of message.posted" },
  { name: "event_outbox", kind: "SIDE-EFFECT QUEUE", description: "Delivery queue switched by topic: realtime · projection · background" },
] as const;

// ── Side effects ────────────────────────────────────────────────────────────

export const sideEffects: readonly RuntimeSideEffect[] = [
  { label: "Realtime", kind: "realtime", description: "Push committed events → UI SSE stream" },
  { label: "Projection", kind: "projection", description: "Thread / run context projection (run.created · run.requeued · work_item.ready · work_item.reopened · message.posted)" },
  { label: "Background", kind: "background", description: "Thread title naming (thread.naming_requested)" },
] as const;

// ── Child-run delegation loop ───────────────────────────────────────────────

export const delegationSteps: readonly RuntimeDelegationStep[] = [
  { step: "1", description: "delegate_to_agent creates child run + wait_entry(targetRunId)" },
  { step: "2", description: "Readiness engine picks up child run; executes independently" },
  { step: "3", description: "deliver_resolved_child_run resolves wait; parent run resumes" },
] as const;
