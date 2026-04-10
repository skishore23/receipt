import path from "node:path";
import type { MemoryTools } from "../../../adapters/memory-tools";
import type {
  FactoryCmd,
  FactoryCandidateRecord,
  FactoryEvent,
  FactoryObjectiveContractRecord,
  FactoryObjectiveProfileSnapshot,
  FactoryPlanningReceiptRecord,
  FactoryState,
  FactoryTaskRecord,
  FactoryTaskStatus,
} from "../../../modules/factory";
import type { GraphRef } from "@receipt/core/graph";
import type { Runtime } from "@receipt/core/runtime";
import { CONTROL_RECEIPT_TYPES } from "../../../engine/runtime/control-receipts";
import type { FactoryCloudExecutionContext } from "../../factory-cloud-context";
import {
  helperCatalogArtifactRefs,
  loadFactoryHelperContext,
} from "../../factory-helper-catalog";
import {
  FACTORY_TASK_PACKET_DIR,
  buildTaskFilePaths,
} from "../task-packets";
import type {
  FactoryContextPack,
  FactoryContextReceipt,
  FactoryContextRelatedTask,
  FactoryContextTaskNode,
  FactoryMemoryScopeSpec,
} from "../task-packets";
import { summarizeFactoryMemoryScope } from "../memory/store";
import type {
  FactoryContextSources,
  FactoryDebugProjection,
  FactoryObjectiveDetail,
} from "../../factory-types";

type FactoryContextBuilderDeps = {
  readonly runtime: Runtime<FactoryCmd, FactoryEvent, FactoryState>;
  readonly memoryTools?: MemoryTools;
  readonly profileRoot: string;
  readonly latestTaskCandidate: (
    state: FactoryState,
    taskId: string,
  ) => FactoryCandidateRecord | undefined;
  readonly objectiveContractForState: (
    state: FactoryState,
    planning?: FactoryPlanningReceiptRecord,
  ) => FactoryObjectiveContractRecord;
  readonly compactCloudExecutionContextForPacket: (
    context: FactoryCloudExecutionContext,
  ) => FactoryContextPack["cloudExecutionContext"];
  readonly buildContextSources: (
    state: FactoryState,
    repoSkillPaths: ReadonlyArray<string>,
    sharedArtifactRefs: ReadonlyArray<GraphRef>,
  ) => FactoryContextSources;
  readonly objectiveProfileArtifactPath: (objectiveId: string) => string;
  readonly objectiveSkillSelectionArtifactPath: (objectiveId: string) => string;
  readonly summarizeReceipt: (event: FactoryEvent) => string;
  readonly receiptTaskOrCandidateId: (
    event: FactoryEvent,
  ) => { readonly taskId?: string; readonly candidateId?: string };
  readonly objectiveStream: (objectiveId: string) => string;
};

type FactoryDirectCodexProbeContextPackInput = {
  readonly jobId: string;
  readonly prompt: string;
  readonly objectiveId?: string;
  readonly parentRunId?: string;
  readonly parentStream?: string;
  readonly stream?: string;
  readonly supervisorSessionId?: string;
  readonly readOnly: boolean;
  readonly profile: FactoryObjectiveProfileSnapshot;
  readonly cloudExecutionContext: FactoryContextPack["cloudExecutionContext"];
  readonly repoScope: string;
  readonly profileScope: string;
  readonly objectiveScope?: string;
  readonly workerScope: string;
  readonly repoSkillPaths: ReadonlyArray<string>;
  readonly helperRefs: ReadonlyArray<GraphRef>;
  readonly helperCatalog?: Awaited<ReturnType<typeof loadFactoryHelperContext>>;
  readonly memoryScopes: ReadonlyArray<FactoryMemoryScopeSpec>;
  readonly repoMemory?: string;
  readonly profileMemory?: string;
  readonly workerMemory?: string;
  readonly objectiveMemory?: string;
  readonly integrationMemory?: string;
  readonly objectiveDetail?: FactoryObjectiveDetail;
  readonly objectiveDebug?: FactoryDebugProjection;
};

const artifactRef = (ref: string, label?: string): GraphRef => ({ kind: "artifact", ref, label });

const objectiveTaskStatusPriority = (status: FactoryTaskStatus): number => {
  switch (status) {
    case "running":
      return 0;
    case "reviewing":
      return 1;
    case "ready":
      return 2;
    case "blocked":
      return 3;
    case "pending":
      return 4;
    case "approved":
      return 5;
    case "integrated":
      return 6;
    case "superseded":
      return 7;
    default:
      return 8;
  }
};

const collectDependencyClosure = (
  state: FactoryState,
  taskId: string,
  seen = new Set<string>(),
): ReadonlyArray<string> => {
  if (seen.has(taskId)) return [];
  seen.add(taskId);
  const task = state.workflow.tasksById[taskId];
  if (!task) return [];
  const collected: string[] = [];
  for (const depId of task.dependsOn) {
    collected.push(depId);
    for (const nested of collectDependencyClosure(state, depId, seen)) {
      if (!collected.includes(nested)) collected.push(nested);
    }
  }
  return collected;
};

const collectDependentClosure = (
  state: FactoryState,
  taskId: string,
  seen = new Set<string>(),
): ReadonlyArray<string> => {
  if (seen.has(taskId)) return [];
  seen.add(taskId);
  const directDependents = state.workflow.taskIds
    .map((id) => state.workflow.tasksById[id])
    .filter((task): task is FactoryTaskRecord => Boolean(task))
    .filter((task) => task.dependsOn.includes(taskId))
    .map((task) => task.taskId);
  const collected: string[] = [];
  for (const dependentId of directDependents) {
    if (!collected.includes(dependentId)) collected.push(dependentId);
    for (const nested of collectDependentClosure(state, dependentId, seen)) {
      if (!collected.includes(nested)) collected.push(nested);
    }
  }
  return collected;
};

const collectRelatedTaskRelations = (
  state: FactoryState,
  taskId: string,
): ReadonlyMap<string, ReadonlySet<"focus" | "dependency" | "dependent">> => {
  const relations = new Map<string, Set<"focus" | "dependency" | "dependent">>();
  const mark = (targetTaskId: string, relation: "focus" | "dependency" | "dependent"): void => {
    const current = relations.get(targetTaskId) ?? new Set<"focus" | "dependency" | "dependent">();
    current.add(relation);
    relations.set(targetTaskId, current);
  };
  mark(taskId, "focus");
  for (const depId of collectDependencyClosure(state, taskId)) mark(depId, "dependency");
  for (const dependentId of collectDependentClosure(state, taskId)) mark(dependentId, "dependent");
  return relations;
};

const taskRecency = (task: FactoryTaskRecord): number =>
  task.completedAt ?? task.reviewingAt ?? task.startedAt ?? task.readyAt ?? task.createdAt;

const buildContextNode = async (
  deps: FactoryContextBuilderDeps,
  state: FactoryState,
  taskId: string,
): Promise<FactoryContextTaskNode | undefined> => {
  const task = state.workflow.tasksById[taskId];
  if (!task) return undefined;
  const candidate = deps.latestTaskCandidate(state, taskId);
  const memorySummary = await summarizeFactoryMemoryScope({
    memoryTools: deps.memoryTools,
    scope: `factory/objectives/${state.objectiveId}/tasks/${taskId}`,
    query: `${task.title}\n${task.prompt}`,
    maxChars: 320,
    operation: "summarize-scope",
  });
  const children = await Promise.all(task.dependsOn.map((depId) => buildContextNode(deps, state, depId)));
  return {
    taskId: task.taskId,
    taskKind: task.taskKind,
    title: task.title,
    status: task.status,
    workerType: task.workerType,
    sourceTaskId: task.sourceTaskId,
    latestSummary: task.latestSummary,
    blockedReason: task.blockedReason,
    candidateId: candidate?.candidateId,
    candidateStatus: candidate?.status,
    memorySummary,
    children: children.filter((child): child is FactoryContextTaskNode => Boolean(child)),
  };
};

const buildRelatedContextTask = async (
  deps: FactoryContextBuilderDeps,
  state: FactoryState,
  taskId: string,
  relations: ReadonlySet<"focus" | "dependency" | "dependent">,
): Promise<FactoryContextRelatedTask | undefined> => {
  const task = state.workflow.tasksById[taskId];
  if (!task) return undefined;
  const candidate = deps.latestTaskCandidate(state, taskId);
  const memorySummary = await summarizeFactoryMemoryScope({
    memoryTools: deps.memoryTools,
    scope: `factory/objectives/${state.objectiveId}/tasks/${taskId}`,
    query: `${task.title}\n${task.prompt}`,
    maxChars: 320,
    operation: "summarize-scope",
  });
  const relationOrder = ["focus", "dependency", "dependent"] as const;
  return {
    taskId: task.taskId,
    taskKind: task.taskKind,
    title: task.title,
    status: task.status,
    workerType: task.workerType,
    sourceTaskId: task.sourceTaskId,
    relations: relationOrder.filter((relation) => relations.has(relation)),
    latestSummary: task.latestSummary,
    blockedReason: task.blockedReason,
    candidateId: candidate?.candidateId,
    candidateStatus: candidate?.status,
    memorySummary,
  };
};

const buildObjectiveSliceTasks = async (
  deps: FactoryContextBuilderDeps,
  state: FactoryState,
  taskIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<FactoryContextRelatedTask>> => {
  const items = await Promise.all(
    taskIds.map((taskId) =>
      buildRelatedContextTask(
        deps,
        state,
        taskId,
        new Set<"focus" | "dependency" | "dependent">(),
      ))
  );
  return items.filter((item): item is FactoryContextRelatedTask => Boolean(item));
};

export const buildFactoryTaskContextPack = async (
  deps: FactoryContextBuilderDeps,
  state: FactoryState,
  task: FactoryTaskRecord,
  candidateId: string,
  profile: FactoryObjectiveProfileSnapshot,
  cloudExecutionContext: FactoryCloudExecutionContext | undefined,
  repoSkillPaths: ReadonlyArray<string>,
  taskPrompt = task.prompt,
): Promise<FactoryContextPack> => {
  const contextPackBuiltAt = Date.now();
  const chain = await deps.runtime.chain(deps.objectiveStream(state.objectiveId));
  const dependencyIds = collectDependencyClosure(state, task.taskId);
  const dependencyTree = await Promise.all(task.dependsOn.map((depId) => buildContextNode(deps, state, depId)));
  const relatedTaskRelations = collectRelatedTaskRelations(state, task.taskId);
  const relatedTasks = await Promise.all(
    [...relatedTaskRelations.entries()].map(([relatedTaskId, relations]) =>
      buildRelatedContextTask(deps, state, relatedTaskId, relations)
    ),
  );
  const syntheticCurrentCandidate = state.candidates[candidateId]
    ? undefined
    : {
        candidateId,
        taskId: task.taskId,
        status: "planned",
        parentCandidateId: deps.latestTaskCandidate(state, task.taskId)?.candidateId,
        baseCommit: task.baseCommit,
        checkResults: [],
        artifactRefs: {},
        createdAt: contextPackBuiltAt,
        updatedAt: contextPackBuiltAt,
        scriptsRun: undefined,
        summary: undefined,
        handoff: undefined,
        headCommit: undefined,
        latestReason: undefined,
      } satisfies FactoryCandidateRecord;
  const lineage = [
    ...state.candidateOrder
      .map((id) => state.candidates[id])
      .filter((candidate): candidate is FactoryCandidateRecord => candidate?.taskId === task.taskId),
    ...(syntheticCurrentCandidate ? [syntheticCurrentCandidate] : []),
  ].map((candidate) => ({
    candidateId: candidate.candidateId,
    parentCandidateId: candidate.parentCandidateId,
    status: candidate.status,
    summary: candidate.summary,
    handoff: candidate.handoff,
    headCommit: candidate.headCommit,
    latestReason: candidate.latestReason,
    scriptsRun: candidate.scriptsRun,
  }));
  const relatedTaskIds = new Set<string>([...relatedTaskRelations.keys(), ...dependencyIds]);
  const relatedCandidateIds = new Set<string>([
    candidateId,
    ...lineage.map((candidate) => candidate.candidateId),
    ...state.candidateOrder
      .map((id) => state.candidates[id])
      .filter((candidate): candidate is FactoryCandidateRecord => Boolean(candidate) && relatedTaskIds.has(candidate.taskId))
      .map((candidate) => candidate.candidateId),
  ]);
  const recentReceipts = [...chain]
    .reverse()
    .filter((receipt) => {
      const ref = deps.receiptTaskOrCandidateId(receipt.body);
      return (ref.taskId && relatedTaskIds.has(ref.taskId))
        || (ref.candidateId && relatedCandidateIds.has(ref.candidateId))
        || receipt.body.type.startsWith("integration.")
        || receipt.body.type === "rebracket.applied";
    })
    .slice(0, 12)
    .reverse()
    .map((receipt) => {
      const ref = deps.receiptTaskOrCandidateId(receipt.body);
      return {
        type: receipt.body.type,
        at: receipt.ts,
        taskId: ref.taskId,
        candidateId: ref.candidateId,
        summary: deps.summarizeReceipt(receipt.body),
      } satisfies FactoryContextReceipt;
    });
  if (syntheticCurrentCandidate) {
    recentReceipts.push(
      {
        type: "candidate.created",
        at: contextPackBuiltAt,
        taskId: task.taskId,
        candidateId,
        summary: "candidate.created",
      },
      {
        type: "task.dispatched",
        at: contextPackBuiltAt + 1,
        taskId: task.taskId,
        candidateId,
        summary: "task.dispatched",
      },
    );
  }
  const focusedReceiptKeys = new Set(recentReceipts.map((receipt) => `${receipt.type}:${receipt.at}:${receipt.summary}`));
  const objectiveTasks = state.workflow.taskIds
    .map((taskId) => state.workflow.tasksById[taskId])
    .filter((node): node is FactoryTaskRecord => Boolean(node));
  const frontierTaskIds = objectiveTasks
    .filter((item) => ["ready", "running", "reviewing", "blocked"].includes(item.status))
    .sort((a, b) =>
      objectiveTaskStatusPriority(a.status) - objectiveTaskStatusPriority(b.status)
      || taskRecency(b) - taskRecency(a)
      || a.taskId.localeCompare(b.taskId)
    )
    .slice(0, 12)
    .map((item) => item.taskId);
  const recentCompletedTaskIds = objectiveTasks
    .filter((item) => ["approved", "integrated", "blocked", "superseded"].includes(item.status))
    .sort((a, b) => taskRecency(b) - taskRecency(a) || a.taskId.localeCompare(b.taskId))
    .slice(0, 8)
    .map((item) => item.taskId);
  const integrationTaskIds = objectiveTasks
    .filter((item) => {
      const candidateIdForTask = item.candidateId;
      if (!candidateIdForTask) return false;
      return state.integration.activeCandidateId === candidateIdForTask
        || state.integration.queuedCandidateIds.includes(candidateIdForTask);
    })
    .map((item) => item.taskId);
  const recentObjectiveReceipts = [...chain]
    .filter((receipt) => !CONTROL_RECEIPT_TYPES.has(receipt.body.type as never))
    .reverse()
    .map((receipt) => {
      const ref = deps.receiptTaskOrCandidateId(receipt.body);
      return {
        type: receipt.body.type,
        at: receipt.ts,
        taskId: ref.taskId,
        candidateId: ref.candidateId,
        summary: deps.summarizeReceipt(receipt.body),
      } satisfies FactoryContextReceipt;
    })
    .filter((receipt) => !focusedReceiptKeys.has(`${receipt.type}:${receipt.at}:${receipt.summary}`))
    .slice(0, 20)
    .reverse();
  const contract = deps.objectiveContractForState(state);
  const [overview, objectiveMemory, integrationMemory, repoAuditMemory] = await Promise.all([
    summarizeFactoryMemoryScope({
      memoryTools: deps.memoryTools,
      scope: `factory/objectives/${state.objectiveId}`,
      query: `${state.title}\n${task.title}`,
      maxChars: 520,
      operation: "summarize-scope",
    }),
    summarizeFactoryMemoryScope({
      memoryTools: deps.memoryTools,
      scope: `factory/objectives/${state.objectiveId}`,
      query: state.title,
      maxChars: 360,
      operation: "summarize-scope",
    }),
    summarizeFactoryMemoryScope({
      memoryTools: deps.memoryTools,
      scope: `factory/objectives/${state.objectiveId}/integration`,
      query: `${state.title}\nintegration`,
      maxChars: 360,
      operation: "summarize-scope",
    }),
    summarizeFactoryMemoryScope({
      memoryTools: deps.memoryTools,
      scope: "factory/audits/repo",
      query: `${state.title}\n${task.title}`,
      maxChars: 400,
      operation: "summarize-scope",
    }),
  ]);
  const helperCatalog = await loadFactoryHelperContext({
    profileRoot: deps.profileRoot,
    provider: profile.cloudProvider ?? cloudExecutionContext?.preferredProvider,
    objectiveTitle: state.title,
    objectivePrompt: state.prompt,
    taskTitle: task.title,
    taskPrompt,
    domain: "infrastructure",
  });
  const sharedArtifactRefs = [
    artifactRef(deps.objectiveProfileArtifactPath(state.objectiveId), "objective profile snapshot"),
    artifactRef(deps.objectiveSkillSelectionArtifactPath(state.objectiveId), "objective profile skills"),
    ...helperCatalogArtifactRefs(helperCatalog).map((ref) => artifactRef(ref.ref, ref.label)),
  ];
  const [frontierTasks, recentCompletedTasks, integrationTasks] = await Promise.all([
    buildObjectiveSliceTasks(deps, state, frontierTaskIds),
    buildObjectiveSliceTasks(deps, state, recentCompletedTaskIds),
    buildObjectiveSliceTasks(deps, state, integrationTaskIds),
  ]);
  const packet = buildTaskFilePaths("", task.taskId, task.executionPhase);
  return {
    objectiveId: state.objectiveId,
    title: state.title,
    prompt: state.prompt,
    objectiveMode: state.objectiveMode,
    severity: state.severity,
    planning: state.planning,
    contract,
    cloudExecutionContext: cloudExecutionContext
      ? deps.compactCloudExecutionContextForPacket(cloudExecutionContext)
      : undefined,
    profile,
    task: {
      taskId: task.taskId,
      title: task.title,
      prompt: taskPrompt,
      workerType: task.workerType,
      executionMode: task.executionMode ?? profile.objectivePolicy.defaultTaskExecutionMode,
      status: task.status,
      taskPhase: task.executionPhase,
      candidateId,
    },
    integration: {
      status: state.integration.status,
      headCommit: state.integration.headCommit,
      activeCandidateId: state.integration.activeCandidateId,
      conflictReason: state.integration.conflictReason,
      lastSummary: state.integration.lastSummary,
    },
    dependencyTree: dependencyTree.filter((node): node is FactoryContextTaskNode => Boolean(node)),
    relatedTasks: relatedTasks
      .filter((node): node is FactoryContextRelatedTask => Boolean(node))
      .sort((a, b) => state.workflow.taskIds.indexOf(a.taskId) - state.workflow.taskIds.indexOf(b.taskId)),
    candidateLineage: lineage,
    recentReceipts,
    objectiveSlice: {
      frontierTasks,
      recentCompletedTasks,
      integrationTasks,
      recentObjectiveReceipts,
      objectiveMemorySummary: objectiveMemory,
      integrationMemorySummary: integrationMemory,
    },
    memory: {
      overview,
      objective: objectiveMemory,
      integration: integrationMemory,
      repoAudit: repoAuditMemory,
    },
    investigation: {
      reports: state.investigation.reportOrder
        .map((taskId) => state.investigation.reports[taskId])
        .filter((report) => Boolean(report)),
      synthesized: state.investigation.synthesized,
    },
    packetPaths: {
      root: FACTORY_TASK_PACKET_DIR,
      manifestPath: path.posix.join(FACTORY_TASK_PACKET_DIR, path.basename(packet.manifestPath)),
      contextSummaryPath: path.posix.join(FACTORY_TASK_PACKET_DIR, path.basename(packet.contextSummaryPath)),
      contextPackPath: path.posix.join(FACTORY_TASK_PACKET_DIR, path.basename(packet.contextPackPath)),
      memoryScriptPath: path.posix.join(FACTORY_TASK_PACKET_DIR, path.basename(packet.memoryScriptPath)),
      receiptCliPath: path.posix.join(FACTORY_TASK_PACKET_DIR, path.basename(packet.receiptCliPath)),
      evidenceDir: path.posix.join(FACTORY_TASK_PACKET_DIR, "evidence"),
    },
    helperCatalog,
    contextSources: {
      ...deps.buildContextSources(state, repoSkillPaths, sharedArtifactRefs),
      profileSkillRefs: profile.selectedSkills,
    },
  };
};

export const buildFactoryDirectCodexProbeContextPack = (
  input: FactoryDirectCodexProbeContextPackInput,
): Record<string, unknown> => {
  const frontierTasks = (input.objectiveDetail?.tasks ?? [])
    .filter((task) => ["ready", "running", "reviewing", "blocked"].includes(task.status))
    .slice(0, 10)
    .map((task) => ({
      taskId: task.taskId,
      taskKind: task.taskKind,
      title: task.title,
      status: task.status,
      workerType: task.workerType,
      sourceTaskId: task.sourceTaskId,
      relations: ["focus"] as const,
      latestSummary: task.latestSummary,
      blockedReason: task.blockedReason,
      candidateId: task.candidateId,
      candidateStatus: task.candidate?.status,
    }));
  const recentCompletedTasks = (input.objectiveDetail?.tasks ?? [])
    .filter((task) => ["approved", "integrated", "blocked", "superseded"].includes(task.status))
    .slice(0, 8)
    .map((task) => ({
      taskId: task.taskId,
      taskKind: task.taskKind,
      title: task.title,
      status: task.status,
      workerType: task.workerType,
      sourceTaskId: task.sourceTaskId,
      relations: ["focus"] as const,
      latestSummary: task.latestSummary,
      blockedReason: task.blockedReason,
      candidateId: task.candidateId,
      candidateStatus: task.candidate?.status,
    }));
  const integrationTaskIds = new Set<string>();
  if (input.objectiveDetail?.integration.activeCandidateId) {
    const activeTask = input.objectiveDetail.tasks.find(
      (task) => task.candidateId === input.objectiveDetail?.integration.activeCandidateId,
    );
    if (activeTask) integrationTaskIds.add(activeTask.taskId);
  }
  for (const candidateId of input.objectiveDetail?.integration.queuedCandidateIds ?? []) {
    const queuedTask = input.objectiveDetail?.tasks.find((task) => task.candidateId === candidateId);
    if (queuedTask) integrationTaskIds.add(queuedTask.taskId);
  }
  const integrationTasks = (input.objectiveDetail?.tasks ?? [])
    .filter((task) => integrationTaskIds.has(task.taskId))
    .slice(0, 8)
    .map((task) => ({
      taskId: task.taskId,
      taskKind: task.taskKind,
      title: task.title,
      status: task.status,
      workerType: task.workerType,
      sourceTaskId: task.sourceTaskId,
      relations: ["focus"] as const,
      latestSummary: task.latestSummary,
      blockedReason: task.blockedReason,
      candidateId: task.candidateId,
      candidateStatus: task.candidate?.status,
    }));

  return {
    ...(input.objectiveId ? { objectiveId: input.objectiveId } : {}),
    probeId: input.jobId,
    title: input.objectiveDetail?.title ?? "Direct Codex Probe",
    prompt: input.prompt,
    mode: input.objectiveId
      ? (input.readOnly ? "read_only_direct_codex_probe" : "direct_codex")
      : (input.readOnly ? "read_only_repo_probe" : "direct_repo_probe"),
    cloudExecutionContext: input.cloudExecutionContext,
    profile: input.profile,
    task: {
      taskId: `direct_codex_${input.jobId}`,
      title: input.objectiveDetail?.title ? `Direct probe for ${input.objectiveDetail.title}` : "Direct Codex Probe",
      prompt: input.prompt,
      workerType: "codex",
      status: "running",
      candidateId: input.jobId,
    },
    ...(input.objectiveDetail ? {
      integration: input.objectiveDetail.integration,
    } : {}),
    dependencyTree: [],
    relatedTasks: frontierTasks,
    candidateLineage: [],
    recentReceipts: (input.objectiveDetail?.recentReceipts ?? []).slice(-12).map((receipt) => ({
      type: receipt.type,
      at: receipt.ts,
      taskId: receipt.taskId,
      candidateId: receipt.candidateId,
      summary: receipt.summary,
    })),
    ...(input.objectiveDetail ? {
      objectiveSlice: {
        frontierTasks,
        recentCompletedTasks,
        integrationTasks,
        recentObjectiveReceipts: input.objectiveDetail.recentReceipts.map((receipt) => ({
          type: receipt.type,
          at: receipt.ts,
          taskId: receipt.taskId,
          candidateId: receipt.candidateId,
          summary: receipt.summary,
        })),
        objectiveMemorySummary: input.objectiveMemory,
        integrationMemorySummary: input.integrationMemory,
      },
    } : {}),
    memory: {
      overview: [input.repoMemory, input.profileMemory, input.objectiveMemory, input.workerMemory].filter(Boolean).join("\n\n") || undefined,
      objective: input.objectiveMemory,
      integration: input.integrationMemory,
    },
    contextSources: {
      repoSharedMemoryScope: input.repoScope,
      objectiveMemoryScope: input.objectiveScope ?? input.profileScope,
      integrationMemoryScope: input.objectiveId ? `factory/objectives/${input.objectiveId}/integration` : input.workerScope,
      profileSkillRefs: input.profile.selectedSkills,
      repoSkillPaths: input.repoSkillPaths,
      sharedArtifactRefs: input.helperRefs,
    },
    helperCatalog: input.helperCatalog,
    latestDecision: input.objectiveDetail?.latestDecision,
    blockedExplanation: input.objectiveDetail?.blockedExplanation,
    evidenceCards: input.objectiveDetail?.evidenceCards.slice(-8) ?? [],
    activeJobs: input.objectiveDebug?.activeJobs.slice(0, 8) ?? [],
    latestContextPacks: input.objectiveDebug?.latestContextPacks ?? [],
    session: {
      jobId: input.jobId,
      parentRunId: input.parentRunId,
      parentStream: input.parentStream,
      stream: input.stream,
      supervisorSessionId: input.supervisorSessionId,
    },
  };
};
