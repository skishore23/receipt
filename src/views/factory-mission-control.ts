import type { FactoryLiveOutputSnapshot } from "../services/factory-service.js";

import { esc } from "./agent-framework.js";

const panelClass = "rounded-[28px] border border-white/10 bg-white/[0.04] shadow-[0_24px_80px_rgba(0,0,0,0.34)] backdrop-blur-2xl";
const softPanelClass = "rounded-[24px] border border-white/10 bg-black/20 backdrop-blur-xl";
const railCardClass = `${softPanelClass} p-4`;
const sectionLabelClass = "text-[11px] font-medium uppercase tracking-[0.28em] text-zinc-500";
const badgeBaseClass = "inline-flex max-w-full items-center justify-center gap-2 rounded-full border px-3 py-1 text-center text-[11px] font-medium uppercase tracking-[0.18em] whitespace-normal leading-4 break-words [overflow-wrap:anywhere]";
const buttonBaseClass = "inline-flex items-center justify-center rounded-full border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] transition";
const primaryButtonClass = `${buttonBaseClass} border-emerald-300/40 bg-emerald-300 text-zinc-950 hover:bg-emerald-200`;
const ghostButtonClass = `${buttonBaseClass} border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.09]`;
const dangerButtonClass = `${buttonBaseClass} border-rose-300/25 bg-rose-400/10 text-rose-100 hover:bg-rose-400/20`;
const navPillClass = "inline-flex items-center rounded-full border px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] transition";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const formatTs = (ts?: number): string =>
  typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toLocaleString() : "";

const shortHash = (hash?: string): string =>
  hash ? hash.slice(0, 10) : "";

const displayLabel = (value?: string): string => {
  const text = value?.trim();
  if (!text) return "";
  return text.replace(/[_-]+/g, " ");
};

const toneForValue = (value?: string): Tone => {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return "neutral";
  if (["completed", "ready_to_promote", "approved", "success", "ready", "promoted"].includes(normalized)) return "success";
  if (["failed", "canceled", "cancelled", "blocked", "error", "changes_requested", "conflicted"].includes(normalized)) return "danger";
  if (["queued", "pending", "waiting_for_slot", "waiting", "needs_attention", "decomposing", "planning"].includes(normalized)) return "warning";
  if (["executing", "running", "active", "integrating", "promoting", "reviewing", "leased"].includes(normalized)) return "info";
  return "neutral";
};

const badgeToneClass = (tone: Tone): string => {
  switch (tone) {
    case "success":
      return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100";
    case "warning":
      return "border-amber-300/25 bg-amber-300/10 text-amber-100";
    case "danger":
      return "border-rose-300/20 bg-rose-300/10 text-rose-100";
    case "info":
      return "border-sky-300/20 bg-sky-300/10 text-sky-100";
    default:
      return "border-white/10 bg-white/[0.04] text-zinc-300";
  }
};

const badge = (label: string, tone: Tone = toneForValue(label)): string =>
  `<span class="${badgeBaseClass} ${badgeToneClass(tone)}">${esc(displayLabel(label) || label)}</span>`;

const navPill = (input: {
  readonly href: string;
  readonly label: string;
  readonly active?: boolean;
  readonly dataFactoryNav?: string;
}): string => {
  const classes = input.active
    ? "border-sky-300/30 bg-sky-300/10 text-sky-100"
    : "border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]";
  return `<a class="${navPillClass} ${classes}" href="${esc(input.href)}"${input.dataFactoryNav ? ` data-factory-nav="${esc(input.dataFactoryNav)}"` : ""}>${esc(input.label)}</a>`;
};

const statPill = (label: string, value: string): string => `<div class="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
  <div class="text-[10px] uppercase tracking-[0.18em] text-zinc-500">${esc(label)}</div>
  <div class="mt-1 break-words text-sm font-medium text-zinc-100 [overflow-wrap:anywhere]">${esc(value)}</div>
</div>`;

const renderCliActionCard = (input: {
  readonly label: string;
  readonly description: string;
  readonly command: string;
  readonly commandBadgeClass?: string;
  readonly span?: string;
}): string => `<div class="${input.span ?? ""} rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-4">
    <span class="flex items-start justify-between gap-3">
      <span class="min-w-0">
        <span class="block text-sm font-semibold text-zinc-100">${esc(input.label)}</span>
        <span class="mt-2 block text-sm leading-6 text-zinc-400">${esc(input.description)}</span>
      </span>
      <span class="${input.commandBadgeClass ?? ghostButtonClass} shrink-0">CLI</span>
    </span>
    <code class="mt-3 block overflow-x-auto rounded-2xl border border-white/10 bg-black/25 px-3 py-3 text-[12px] leading-5 text-zinc-200 [overflow-wrap:anywhere]">${esc(input.command)}</code>
  </div>`;

const sectionTitle = (section: FactoryMissionSectionKey): string =>
  section === "needs_attention"
    ? "Needs Attention"
    : section === "active"
      ? "Active"
      : section === "queued"
        ? "Queued"
        : "Completed";

const emptyState = (title: string, body: string): string => `<section class="${panelClass} px-6 py-6 text-center">
  <div class="mx-auto max-w-2xl">
    <div class="text-base font-semibold text-zinc-100">${esc(title)}</div>
    <div class="mt-3 text-sm leading-6 text-zinc-400">${esc(body)}</div>
  </div>
</section>`;

const controlQuery = (input: {
  readonly objectiveId?: string;
  readonly panel?: FactoryMissionPanel;
  readonly focusKind?: FactoryMissionFocusKind;
  readonly focusId?: string;
}): string => {
  const params = new URLSearchParams();
  if (input.objectiveId) params.set("objective", input.objectiveId);
  if (input.panel) params.set("panel", input.panel);
  if (input.focusKind) params.set("focusKind", input.focusKind);
  if (input.focusId) params.set("focusId", input.focusId);
  const query = params.toString();
  return query ? `?${query}` : "";
};

export type FactoryMissionPanel = "overview" | "execution" | "live" | "receipts" | "debug";
export type FactoryMissionFocusKind = "mission" | "run" | "job" | "task";
export type FactoryMissionSectionKey = "needs_attention" | "active" | "queued" | "completed";

export type FactoryMissionObjectiveNav = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly slotState: string;
  readonly section: FactoryMissionSectionKey;
  readonly summary?: string;
  readonly updatedAt?: number;
  readonly selected: boolean;
  readonly activeTaskCount: number;
  readonly readyTaskCount: number;
  readonly taskCount: number;
  readonly integrationStatus?: string;
  readonly queuePosition?: number;
};

export type FactoryMissionRunSummary = {
  readonly focusId: string;
  readonly runId: string;
  readonly profileId: string;
  readonly profileLabel: string;
  readonly status: string;
  readonly summary: string;
  readonly prompt?: string;
  readonly updatedAt?: number;
  readonly startedAt?: number;
  readonly selected: boolean;
  readonly chatLink: string;
  readonly controlLink: string;
  readonly previewLines: ReadonlyArray<string>;
};

export type FactoryMissionJobSummary = {
  readonly jobId: string;
  readonly agentId: string;
  readonly status: string;
  readonly summary: string;
  readonly updatedAt?: number;
  readonly runId?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly selected: boolean;
  readonly controlLink: string;
  readonly rawLink: string;
};

export type FactoryMissionTaskSummary = {
  readonly taskId: string;
  readonly title: string;
  readonly workerType: string;
  readonly status: string;
  readonly summary?: string;
  readonly candidateId?: string;
  readonly candidateStatus?: string;
  readonly jobId?: string;
  readonly jobStatus?: string;
  readonly workspaceExists: boolean;
  readonly workspaceDirty: boolean;
  readonly selected: boolean;
  readonly controlLink: string;
};

export type FactoryMissionReceiptSummary = {
  readonly type: string;
  readonly summary: string;
  readonly ts: number;
  readonly hash: string;
  readonly taskId?: string;
  readonly candidateId?: string;
};

export type FactoryMissionFocusModel =
  | {
      readonly kind: "mission";
      readonly objectiveId: string;
      readonly title: string;
      readonly status: string;
      readonly phase: string;
      readonly summary?: string;
      readonly nextAction?: string;
      readonly blockedReason?: string;
      readonly blockedExplanation?: string;
      readonly debugLink: string;
      readonly receiptsLink: string;
      readonly slotState?: string;
      readonly queuePosition?: number;
      readonly integrationStatus?: string;
      readonly repoProfileStatus?: string;
      readonly latestCommitHash?: string;
      readonly latestDecisionSummary?: string;
      readonly latestDecisionAt?: number;
      readonly checks: ReadonlyArray<string>;
      readonly budgetElapsedMinutes: number;
      readonly budgetMaxMinutes: number;
      readonly taskRunsUsed: number;
      readonly taskRunsMax: number;
    }
  | {
      readonly kind: "run";
      readonly title: string;
      readonly status: string;
      readonly summary: string;
      readonly runId: string;
      readonly profileLabel: string;
      readonly prompt?: string;
      readonly updatedAt?: number;
      readonly startedAt?: number;
      readonly chatLink: string;
      readonly previewLines: ReadonlyArray<string>;
    }
  | {
      readonly kind: "job";
      readonly title: string;
      readonly status: string;
      readonly summary: string;
      readonly jobId: string;
      readonly agentId: string;
      readonly updatedAt?: number;
      readonly runId?: string;
      readonly parentRunId?: string;
      readonly taskId?: string;
      readonly candidateId?: string;
      readonly rawLink: string;
      readonly payload: string;
      readonly result?: string;
      readonly lastError?: string;
      readonly canceledReason?: string;
      readonly active: boolean;
    }
  | {
      readonly kind: "task";
      readonly title: string;
      readonly status: string;
      readonly summary?: string;
      readonly taskId: string;
      readonly workerType: string;
      readonly candidateId?: string;
      readonly candidateStatus?: string;
      readonly jobId?: string;
      readonly jobStatus?: string;
      readonly workspaceExists: boolean;
      readonly workspaceDirty: boolean;
      readonly workspacePath?: string;
      readonly workspaceHead?: string;
      readonly lastMessage?: string;
      readonly stdoutTail?: string;
      readonly stderrTail?: string;
    };

export type FactoryMissionSelectedModel = {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly profileId: string;
  readonly profileLabel: string;
  readonly profilePromptPath: string;
  readonly profileSkills: ReadonlyArray<string>;
  readonly prompt: string;
  readonly summary?: string;
  readonly nextAction?: string;
  readonly blockedReason?: string;
  readonly blockedExplanation?: string;
  readonly slotState: string;
  readonly queuePosition?: number;
  readonly integrationStatus?: string;
  readonly repoProfileStatus?: string;
  readonly latestCommitHash?: string;
  readonly latestDecisionSummary?: string;
  readonly latestDecisionAt?: number;
  readonly activeTaskCount: number;
  readonly readyTaskCount: number;
  readonly taskCount: number;
  readonly checks: ReadonlyArray<string>;
  readonly budgetElapsedMinutes: number;
  readonly budgetMaxMinutes: number;
  readonly taskRunsUsed: number;
  readonly taskRunsMax: number;
  readonly tasks: ReadonlyArray<FactoryMissionTaskSummary>;
  readonly runs: ReadonlyArray<FactoryMissionRunSummary>;
  readonly jobs: ReadonlyArray<FactoryMissionJobSummary>;
  readonly recentReceipts: ReadonlyArray<FactoryMissionReceiptSummary>;
  readonly debugLink: string;
  readonly receiptsLink: string;
  readonly chatLink: string;
  readonly repoProfileSummary?: string;
  readonly debugNextAction?: string;
  readonly activeJobCount: number;
  readonly recentJobCount: number;
  readonly contextPackCount: number;
  readonly worktreeCount: number;
  readonly repoSkillCount: number;
  readonly sharedArtifactCount: number;
  readonly integrationWorkspaceSummary?: string;
  readonly focus: FactoryMissionFocusModel;
};

export type FactoryMissionShellModel = {
  readonly objectiveId?: string;
  readonly panel: FactoryMissionPanel;
  readonly focusKind: FactoryMissionFocusKind;
  readonly focusId?: string;
  readonly objectives: ReadonlyArray<FactoryMissionObjectiveNav>;
  readonly sections: Readonly<Record<FactoryMissionSectionKey, ReadonlyArray<FactoryMissionObjectiveNav>>>;
  readonly selected?: FactoryMissionSelectedModel;
  readonly liveOutput?: FactoryLiveOutputSnapshot;
};

const renderObjectiveLink = (
  currentPanel: FactoryMissionPanel,
  objective: FactoryMissionObjectiveNav,
): string => {
  const href = `/factory/control${controlQuery({
    objectiveId: objective.objectiveId,
    panel: currentPanel,
    focusKind: "mission",
  })}`;
  const selectedClass = objective.selected
    ? "border-sky-300/30 bg-sky-300/10 shadow-[0_16px_48px_rgba(56,189,248,0.12)]"
    : "border-white/10 bg-black/10 hover:border-white/15 hover:bg-white/[0.05]";
  const queueMeta = typeof objective.queuePosition === "number"
    ? `Queue #${objective.queuePosition}`
    : displayLabel(objective.slotState);
  return `<a class="block min-w-0 overflow-hidden rounded-[24px] border px-4 py-4 transition ${selectedClass}" href="${href}" data-factory-nav="objective">
    <div class="flex min-w-0 items-start gap-3 overflow-hidden">
      <div class="min-w-0 flex-1 overflow-hidden">
        <div class="min-w-0 break-words text-sm font-semibold leading-6 text-zinc-100 [display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow-wrap:anywhere]">${esc(objective.title)}</div>
      </div>
      <div class="shrink-0">${badge(objective.status)}</div>
    </div>
    <div class="mt-3 flex flex-wrap gap-2">
      ${badge(`phase ${objective.phase}`, toneForValue(objective.phase))}
      ${badge(`slot ${queueMeta}`, toneForValue(objective.slotState))}
      ${objective.integrationStatus ? badge(`integration ${objective.integrationStatus}`, toneForValue(objective.integrationStatus)) : ""}
    </div>
    ${objective.summary ? `<div class="mt-3 [display:-webkit-box] overflow-hidden break-words text-sm leading-6 text-zinc-400 [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow-wrap:anywhere]">${esc(objective.summary)}</div>` : ""}
    <div class="mt-4 flex flex-wrap gap-2">
      <span class="inline-flex rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-zinc-400">${esc(`${objective.activeTaskCount} active`)}</span>
      <span class="inline-flex rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-zinc-400">${esc(`${objective.readyTaskCount} ready`)}</span>
      <span class="inline-flex rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-zinc-400">${esc(`${objective.taskCount} total`)}</span>
    </div>
    ${objective.updatedAt ? `<div class="mt-3 text-xs text-zinc-500">Updated ${esc(formatTs(objective.updatedAt))}</div>` : ""}
  </a>`;
};

export const factoryMissionRailIsland = (model: FactoryMissionShellModel): string => {
  const sectionMarkup = (section: FactoryMissionSectionKey): string => {
    const items = model.sections[section];
    return `<section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">${sectionTitle(section)}</div>
        <div class="text-xs text-zinc-500">${esc(String(items.length))}</div>
      </div>
      <div class="mt-4 grid gap-3">
        ${items.length > 0
          ? items.map((objective) => renderObjectiveLink(model.panel, objective)).join("")
          : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">No projects.</div>`}
      </div>
    </section>`;
  };

  return `<div class="space-y-5 px-4 py-5 md:px-5">
    <section class="${railCardClass}">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="${sectionLabelClass}">Factory</div>
          <div class="mt-3 text-lg font-semibold text-white">Project Details</div>
          <div class="mt-2 text-sm leading-6 text-zinc-400">Execution state, logs, receipts, and controls for Factory projects.</div>
        </div>
        <div class="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-xs font-semibold uppercase tracking-[0.2em] text-zinc-200">WD</div>
      </div>
    </section>
    ${sectionMarkup("needs_attention")}
    ${sectionMarkup("active")}
    ${sectionMarkup("queued")}
    ${sectionMarkup("completed")}
  </div>`;
};

const panelTabs = (model: FactoryMissionShellModel): string => {
  const current = model.panel;
  const tabs: ReadonlyArray<{ readonly panel: FactoryMissionPanel; readonly label: string }> = [
    { panel: "overview", label: "Overview" },
    { panel: "execution", label: "Execution" },
    { panel: "live", label: "Live" },
    { panel: "receipts", label: "Receipts" },
    { panel: "debug", label: "Debug" },
  ];
  return `<div class="flex flex-wrap gap-2">
    ${tabs.map((tab) => {
      const href = `/factory/control${controlQuery({
        objectiveId: model.objectiveId,
        panel: tab.panel,
        focusKind: model.focusKind,
        focusId: model.focusId,
      })}`;
      const classes = tab.panel === current
        ? "border-sky-300/30 bg-sky-300/10 text-sky-100"
        : "border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]";
      return `<a class="inline-flex items-center rounded-full border px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] transition ${classes}" href="${href}" data-factory-nav="panel">${esc(tab.label)}</a>`;
    }).join("")}
  </div>`;
};

const renderTaskCard = (task: FactoryMissionTaskSummary): string => `<a class="block rounded-[24px] border ${task.selected ? "border-sky-300/30 bg-sky-300/10" : "border-white/10 bg-black/20 hover:bg-black/30"} px-4 py-4 transition" href="${esc(task.controlLink)}" data-factory-nav="focus">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 flex-1">
      <div class="text-sm font-semibold text-zinc-100">${esc(task.title)}</div>
      <div class="mt-2 text-xs text-zinc-500">${esc(task.taskId)} · ${esc(displayLabel(task.workerType) || task.workerType)}</div>
    </div>
    ${badge(task.jobStatus ?? task.status)}
  </div>
  ${task.summary ? `<div class="mt-3 text-sm leading-6 text-zinc-300">${esc(task.summary)}</div>` : ""}
  <div class="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500">
    ${task.candidateId ? `<span>${esc(task.candidateId)}${task.candidateStatus ? ` · ${esc(displayLabel(task.candidateStatus))}` : ""}</span>` : ""}
    ${task.jobId ? `<span>Job ${esc(task.jobId)}</span>` : ""}
    <span>${esc(task.workspaceExists ? (task.workspaceDirty ? "workspace dirty" : "workspace clean") : "workspace missing")}</span>
  </div>
</a>`;

const renderRunCard = (run: FactoryMissionRunSummary): string => `<a class="block rounded-[24px] border ${run.selected ? "border-sky-300/30 bg-sky-300/10" : "border-white/10 bg-black/20 hover:bg-black/30"} px-4 py-4 transition" href="${esc(run.controlLink)}" data-factory-nav="focus">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 flex-1">
      <div class="text-sm font-semibold text-zinc-100">${esc(run.profileLabel)} · ${esc(run.runId)}</div>
      <div class="mt-2 text-xs text-zinc-500">${run.updatedAt ? `Updated ${esc(formatTs(run.updatedAt))}` : ""}</div>
    </div>
    ${badge(run.status)}
  </div>
  <div class="mt-3 text-sm leading-6 text-zinc-300">${esc(run.summary)}</div>
  ${run.prompt ? `<div class="mt-3 text-xs text-zinc-500">${esc(run.prompt)}</div>` : ""}
  <div class="mt-3">
    <span class="text-xs font-medium uppercase tracking-[0.16em] text-emerald-200">Open run chat</span>
  </div>
</a>`;

const renderJobCard = (job: FactoryMissionJobSummary): string => `<a class="factory-job-card block rounded-[24px] border ${job.selected ? "border-sky-300/30 bg-sky-300/10" : "border-white/10 bg-black/20 hover:bg-black/30"} px-4 py-4 transition" href="${esc(job.controlLink)}" data-factory-nav="focus">
  <div class="factory-job-card__row flex min-w-0 flex-wrap items-start justify-between gap-3 overflow-hidden">
    <div class="factory-job-card__body min-w-0 flex-1 overflow-hidden">
      <div class="factory-job-card__title break-words text-sm font-semibold text-zinc-100 [overflow-wrap:anywhere]">${esc(job.agentId)} · ${esc(job.jobId)}</div>
      <div class="factory-job-card__summary mt-2 break-words text-sm leading-6 text-zinc-400 [overflow-wrap:anywhere]">${esc(job.summary)}</div>
    </div>
    <div class="factory-job-card__status shrink-0">${badge(job.status)}</div>
  </div>
  <div class="factory-job-card__meta mt-3 break-words text-xs text-zinc-500 [overflow-wrap:anywhere]">
    ${job.runId ? `Run ${esc(job.runId)}` : "No run id"}
    ${job.taskId ? ` · Task ${esc(job.taskId)}` : ""}
    ${job.updatedAt ? ` · ${esc(formatTs(job.updatedAt))}` : ""}
  </div>
</a>`;

const scopedCollectionTitle = (
  focus: FactoryMissionFocusModel,
  plural: string,
): string => {
  if (focus.kind === "mission") return plural;
  return `Related ${plural.toLowerCase()}`;
};

const scopedCollectionIntro = (focus: FactoryMissionFocusModel): string | undefined => {
  if (focus.kind === "mission") return undefined;
  if (focus.kind === "run") return `Lists below are scoped to run ${focus.runId} and the child work linked to it.`;
  if (focus.kind === "job") return `Lists below are scoped to job ${focus.jobId}, its run lineage, and the task/candidate it touches.`;
  return `Lists below are scoped to task ${focus.taskId}, its dependency neighborhood, and the jobs/runs attached to that work.`;
};

const renderOverviewPanel = (selected: FactoryMissionSelectedModel): string => `<div class="space-y-6">
  <section class="${panelClass} px-5 py-5">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div class="${sectionLabelClass}">Project</div>
        <div class="mt-2 text-2xl font-semibold text-white">${esc(selected.title)}</div>
        <div class="mt-3 flex flex-wrap gap-2">
          ${badge(selected.status)}
          ${badge(selected.phase)}
          ${badge(selected.slotState)}
          ${selected.integrationStatus ? badge(selected.integrationStatus) : ""}
        </div>
      </div>
      <a class="${ghostButtonClass}" href="${esc(selected.chatLink)}">Back to Chat</a>
    </div>
    ${selected.summary ? `<div class="mt-5 text-sm leading-7 text-zinc-300">${esc(selected.summary)}</div>` : ""}
    <div class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      ${statPill("Integration", selected.integrationStatus ?? "unknown")}
      ${statPill("Tasks", `${selected.activeTaskCount} active / ${selected.readyTaskCount} ready / ${selected.taskCount} total`)}
      ${statPill("Repo profile", selected.repoProfileStatus ?? "unknown")}
      ${statPill("Profile", selected.profileLabel)}
    </div>
    <div class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      ${statPill("Elapsed", `${selected.budgetElapsedMinutes}m / ${selected.budgetMaxMinutes}m`)}
      ${statPill("Task runs", `${selected.taskRunsUsed} / ${selected.taskRunsMax}`)}
      ${statPill("Jobs", `${selected.activeJobCount} active / ${selected.recentJobCount} recent`)}
      ${statPill("Commit", shortHash(selected.latestCommitHash) || "none")}
    </div>
    ${selected.nextAction ? `<div class="mt-5 rounded-[24px] border border-emerald-300/20 bg-emerald-300/10 px-4 py-4">
      <div class="${sectionLabelClass}">Next action</div>
      <div class="mt-2 text-sm leading-6 text-emerald-50">${esc(selected.nextAction)}</div>
    </div>` : ""}
    ${selected.blockedExplanation || selected.blockedReason ? `<div class="mt-5 rounded-[24px] border border-amber-300/20 bg-amber-300/10 px-4 py-4">
      <div class="${sectionLabelClass}">Attention</div>
      <div class="mt-2 text-sm leading-6 text-amber-50">${esc(selected.blockedExplanation ?? selected.blockedReason ?? "")}</div>
    </div>` : ""}
  </section>
  <section class="${panelClass} px-5 py-5">
    <div class="${sectionLabelClass}">Project prompt</div>
    <pre class="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-300 [overflow-wrap:anywhere]">${esc(selected.prompt)}</pre>
  </section>
  <section class="${panelClass} px-5 py-5">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div class="${sectionLabelClass}">Profile Context</div>
        <div class="mt-2 text-lg font-semibold text-white">${esc(selected.profileLabel)} · ${esc(selected.profileId)}</div>
      </div>
      <div class="text-xs text-zinc-500">${esc(selected.profilePromptPath)}</div>
    </div>
    <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      ${statPill("Context packs", String(selected.contextPackCount))}
      ${statPill("Repo skills", String(selected.repoSkillCount))}
      ${statPill("Shared artifacts", String(selected.sharedArtifactCount))}
      ${statPill("Worktrees", String(selected.worktreeCount))}
    </div>
    <div class="mt-5 rounded-[22px] border border-white/10 bg-black/20 px-4 py-4">
      <div class="${sectionLabelClass}">Injected skills</div>
      <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(selected.profileSkills?.length ? selected.profileSkills.join(", ") : "No profile skills selected.")}</div>
    </div>
  </section>
  <section class="${panelClass} px-5 py-5">
    <div class="flex items-center justify-between gap-3">
      <div class="${sectionLabelClass}">Recent receipts</div>
      <a class="${ghostButtonClass}" href="${esc(selected.receiptsLink)}">All Receipts</a>
    </div>
    <div class="mt-4 grid gap-3">
      ${selected.recentReceipts.length > 0
        ? selected.recentReceipts.slice(0, 8).map((receipt) => `<div class="rounded-[22px] border border-white/10 bg-black/20 px-4 py-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="text-sm font-semibold text-zinc-100">${esc(receipt.type)}</div>
              <div class="text-xs text-zinc-500">${esc(formatTs(receipt.ts))}</div>
            </div>
            <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(receipt.summary)}</div>
          </div>`).join("")
        : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">No receipts yet.</div>`}
    </div>
  </section>
</div>`;

const renderExecutionPanel = (selected: FactoryMissionSelectedModel): string => `<div class="space-y-6">
  <section class="${panelClass} px-5 py-5">
    <div class="flex items-center justify-between gap-3">
      <div>
        <div class="${sectionLabelClass}">Tasks</div>
        <div class="mt-2 text-lg font-semibold text-white">${esc(scopedCollectionTitle(selected.focus, "Tasks"))}</div>
      </div>
      <div class="text-xs text-zinc-500">${esc(String(selected.tasks.length))}</div>
    </div>
    ${scopedCollectionIntro(selected.focus) ? `<div class="mt-3 text-sm leading-6 text-zinc-400">${esc(scopedCollectionIntro(selected.focus) ?? "")}</div>` : ""}
    <div class="mt-4 grid gap-3">
      ${selected.tasks.length > 0
        ? selected.tasks.map(renderTaskCard).join("")
        : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">${esc(selected.focus.kind === "mission" ? "No tasks yet." : "No related tasks in this context.")}</div>`}
    </div>
  </section>
  <section class="${panelClass} px-5 py-5">
    <div class="flex items-center justify-between gap-3">
      <div>
        <div class="${sectionLabelClass}">Runs</div>
        <div class="mt-2 text-lg font-semibold text-white">${esc(scopedCollectionTitle(selected.focus, "Runs"))}</div>
      </div>
      <div class="text-xs text-zinc-500">${esc(String(selected.runs.length))}</div>
    </div>
    <div class="mt-4 grid gap-3">
      ${selected.runs.length > 0
        ? selected.runs.map(renderRunCard).join("")
        : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">${esc(selected.focus.kind === "mission" ? "No profile runs yet for this project." : "No related runs in this context.")}</div>`}
    </div>
  </section>
  <section class="${panelClass} px-5 py-5">
    <div class="flex items-center justify-between gap-3">
      <div>
        <div class="${sectionLabelClass}">Jobs</div>
        <div class="mt-2 text-lg font-semibold text-white">${esc(scopedCollectionTitle(selected.focus, "Jobs"))}</div>
      </div>
      <div class="text-xs text-zinc-500">${esc(String(selected.jobs.length))}</div>
    </div>
    <div class="factory-job-list mt-4 grid gap-3">
      ${selected.jobs.length > 0
        ? selected.jobs.map(renderJobCard).join("")
        : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">${esc(selected.focus.kind === "mission" ? "No jobs yet." : "No related jobs in this context.")}</div>`}
    </div>
  </section>
</div>`;

export const factoryMissionLiveOutputIsland = (input: {
  readonly objectiveId?: string;
  readonly focusKind?: FactoryMissionFocusKind;
  readonly focusId?: string;
  readonly snapshot?: FactoryLiveOutputSnapshot;
}): string => {
  const query = input.objectiveId && input.focusKind && input.focusId
    ? `/factory/control/island/live-output${controlQuery({
        objectiveId: input.objectiveId,
        focusKind: input.focusKind,
        focusId: input.focusId,
      })}`
    : undefined;
  const snapshot = input.snapshot;
  return `<div id="factory-live-output"${query ? ` hx-get="${esc(query)}" hx-trigger="load, factory-live-refresh from:body" hx-swap="outerHTML"` : ""}>
    <section class="${panelClass} px-5 py-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="${sectionLabelClass}">Focused output</div>
          <div class="mt-2 text-lg font-semibold text-white">${esc(snapshot?.title ?? "Live output")}</div>
        </div>
        ${snapshot ? badge(snapshot.status) : ""}
      </div>
      ${snapshot ? `<div class="mt-4 space-y-4">
        ${snapshot.summary ? `<div>
          <div class="${sectionLabelClass}">Summary</div>
          <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(snapshot.summary)}</div>
        </div>` : ""}
        ${snapshot.lastMessage ? `<div>
          <div class="${sectionLabelClass}">Last message</div>
          <pre class="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-zinc-200 [overflow-wrap:anywhere]">${esc(snapshot.lastMessage)}</pre>
        </div>` : ""}
        ${snapshot.stderrTail ? `<div>
          <div class="${sectionLabelClass}">stderr tail</div>
          <pre class="mt-2 max-h-40 overflow-auto rounded-[20px] border border-white/10 bg-black/25 px-3 py-3 text-[12px] leading-5 text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(snapshot.stderrTail)}</pre>
        </div>` : ""}
        ${snapshot.stdoutTail ? `<div>
          <div class="${sectionLabelClass}">stdout tail</div>
          <pre class="mt-2 max-h-40 overflow-auto rounded-[20px] border border-white/10 bg-black/25 px-3 py-3 text-[12px] leading-5 text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(snapshot.stdoutTail)}</pre>
        </div>` : ""}
        ${!snapshot.lastMessage && !snapshot.stderrTail && !snapshot.stdoutTail ? `<div class="text-sm leading-6 text-zinc-500">No worktree output is available for this selection.</div>` : ""}
      </div>` : `<div class="mt-4 text-sm leading-6 text-zinc-500">Choose a task or job from Execution to stream its latest worktree output here.</div>`}
    </section>
  </div>`;
};

const renderLivePanel = (model: FactoryMissionShellModel, selected: FactoryMissionSelectedModel): string => {
  const canStream = (model.focusKind === "task" || model.focusKind === "job") && Boolean(model.focusId);
  return `<div class="space-y-6">
    <section class="${panelClass} px-5 py-5">
      <div class="${sectionLabelClass}">Live execution</div>
      <div class="mt-3 text-sm leading-6 text-zinc-300">Project Details streams worktree output for the focused task or job. Select a task/job in Execution or use the focused item in the inspector.</div>
      ${selected.focus.kind === "run" ? `<div class="mt-4 rounded-[22px] border border-white/10 bg-black/20 px-4 py-4 text-sm leading-6 text-zinc-300">
        Run focus does not have worktree logs here. Open the project chat for this run instead.
        <div class="mt-3"><a class="${ghostButtonClass}" href="${esc(selected.focus.chatLink)}">Open Run Chat</a></div>
      </div>` : ""}
      ${!canStream && selected.focus.kind !== "run" ? `<div class="mt-4 rounded-[22px] border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">Focus a task or job to view live output.</div>` : ""}
    </section>
    ${canStream ? factoryMissionLiveOutputIsland({
      objectiveId: model.objectiveId,
      focusKind: model.focusKind,
      focusId: model.focusId,
      snapshot: model.liveOutput,
    }) : ""}
  </div>`;
};

const renderReceiptsPanel = (selected: FactoryMissionSelectedModel): string => `<section class="${panelClass} px-5 py-5">
  <div class="flex items-center justify-between gap-3">
    <div>
      <div class="${sectionLabelClass}">Receipts</div>
      <div class="mt-2 text-lg font-semibold text-white">${esc(selected.focus.kind === "mission" ? "Durable control history" : "Related receipts")}</div>
    </div>
    <a class="${ghostButtonClass}" href="${esc(selected.receiptsLink)}">Receipt JSON</a>
  </div>
  ${selected.focus.kind !== "mission" ? `<div class="mt-3 text-sm leading-6 text-zinc-400">${esc(scopedCollectionIntro(selected.focus) ?? "")}</div>` : ""}
  <div class="mt-4 grid gap-3">
    ${selected.recentReceipts.length > 0
      ? selected.recentReceipts.map((receipt) => `<div class="rounded-[22px] border border-white/10 bg-black/20 px-4 py-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="text-sm font-semibold text-zinc-100">${esc(receipt.type)}</div>
            <div class="text-xs text-zinc-500">${esc(formatTs(receipt.ts))} · ${esc(shortHash(receipt.hash))}</div>
          </div>
          <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(receipt.summary)}</div>
        </div>`).join("")
      : `<div class="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">${esc(selected.focus.kind === "mission" ? "No receipts yet." : "No related receipts in this context.")}</div>`}
  </div>
</section>`;

const renderDebugPanel = (selected: FactoryMissionSelectedModel): string => `<section class="${panelClass} px-5 py-5">
  <div class="flex items-center justify-between gap-3">
    <div>
      <div class="${sectionLabelClass}">Debug</div>
      <div class="mt-2 text-lg font-semibold text-white">Runtime diagnostics</div>
    </div>
    <a class="${ghostButtonClass}" href="${esc(selected.debugLink)}">Debug JSON</a>
  </div>
  <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    ${statPill("Active jobs", String(selected.activeJobCount))}
    ${statPill("Recent jobs", String(selected.recentJobCount))}
    ${statPill("Context packs", String(selected.contextPackCount))}
    ${statPill("Worktrees", String(selected.worktreeCount))}
  </div>
  <div class="mt-5 grid gap-4 lg:grid-cols-2">
    <div class="rounded-[22px] border border-white/10 bg-black/20 px-4 py-4">
      <div class="${sectionLabelClass}">Repo profile</div>
      <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(selected.repoProfileSummary ?? "No repo profile summary available.")}</div>
    </div>
    <div class="rounded-[22px] border border-white/10 bg-black/20 px-4 py-4">
      <div class="${sectionLabelClass}">Next action</div>
      <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(selected.debugNextAction ?? selected.nextAction ?? "No next action.")}</div>
      ${selected.integrationWorkspaceSummary ? `<div class="mt-3 text-xs text-zinc-500">${esc(selected.integrationWorkspaceSummary)}</div>` : ""}
    </div>
  </div>
  <div class="mt-4 grid gap-4 lg:grid-cols-2">
    <div class="rounded-[22px] border border-white/10 bg-black/20 px-4 py-4">
      <div class="${sectionLabelClass}">Initiating profile</div>
      <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(`${selected.profileLabel} (${selected.profileId})`)}</div>
      <div class="mt-2 text-xs text-zinc-500">${esc(selected.profilePromptPath)}</div>
    </div>
    <div class="rounded-[22px] border border-white/10 bg-black/20 px-4 py-4">
      <div class="${sectionLabelClass}">Context sources</div>
      <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(`Profile skills ${selected.profileSkills?.length ?? 0} · Repo skills ${selected.repoSkillCount} · Shared artifacts ${selected.sharedArtifactCount}`)}</div>
      <div class="mt-2 text-xs text-zinc-500">${esc(selected.profileSkills?.length ? selected.profileSkills.join(", ") : "No profile skills selected.")}</div>
    </div>
  </div>
</section>`;

export const factoryMissionMainIsland = (model: FactoryMissionShellModel): string => {
  if (!model.selected) {
    return `<div class="space-y-6 px-4 pb-8 pt-6 md:px-8 xl:px-10">
      <div class="flex flex-wrap items-center gap-3">
        ${panelTabs(model)}
      </div>
      ${emptyState("No project selected", "Pick a project from the rail to inspect execution, logs, and receipts.")}
    </div>`;
  }
  const selected = model.selected;
  const panelMarkup = model.panel === "overview"
    ? renderOverviewPanel(selected)
    : model.panel === "execution"
      ? renderExecutionPanel(selected)
      : model.panel === "live"
        ? renderLivePanel(model, selected)
        : model.panel === "receipts"
          ? renderReceiptsPanel(selected)
          : renderDebugPanel(selected);
  return `<div class="space-y-6 px-4 pb-8 pt-6 md:px-8 xl:px-10">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <div class="${sectionLabelClass}">Project Details</div>
        <div class="mt-2 text-2xl font-semibold text-white">${esc(selected.title)}</div>
      </div>
      ${panelTabs(model)}
    </div>
    ${panelMarkup}
  </div>`;
};

const renderMissionFocus = (focus: Extract<FactoryMissionFocusModel, { readonly kind: "mission" }>): string => `<div class="space-y-5">
  <div>
    <div class="${sectionLabelClass}">Project</div>
    <div class="mt-2 text-lg font-semibold text-white">${esc(focus.title)}</div>
    <div class="mt-3 flex flex-wrap gap-2">
      ${badge(focus.status)}
      ${badge(focus.phase)}
      ${focus.slotState ? badge(focus.slotState) : ""}
      ${focus.integrationStatus ? badge(focus.integrationStatus) : ""}
    </div>
  </div>
  <div class="grid gap-2 sm:grid-cols-2">
    ${statPill("Elapsed", `${focus.budgetElapsedMinutes}m / ${focus.budgetMaxMinutes}m`)}
    ${statPill("Task runs", `${focus.taskRunsUsed} / ${focus.taskRunsMax}`)}
    ${statPill("Checks", String(focus.checks.length))}
    ${statPill("Commit", shortHash(focus.latestCommitHash) || "none")}
  </div>
  ${focus.summary ? `<div>
    <div class="${sectionLabelClass}">Summary</div>
    <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(focus.summary)}</div>
  </div>` : ""}
  ${focus.nextAction ? `<div>
    <div class="${sectionLabelClass}">Next action</div>
    <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(focus.nextAction)}</div>
  </div>` : ""}
  ${focus.blockedExplanation || focus.blockedReason ? `<div class="rounded-[22px] border border-amber-300/20 bg-amber-300/10 px-4 py-4 text-sm leading-6 text-amber-50">${esc(focus.blockedExplanation ?? focus.blockedReason ?? "")}</div>` : ""}
  ${focus.latestDecisionSummary ? `<div>
    <div class="${sectionLabelClass}">Latest decision</div>
    <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(focus.latestDecisionSummary)}</div>
    ${focus.latestDecisionAt ? `<div class="mt-2 text-xs text-zinc-500">${esc(formatTs(focus.latestDecisionAt))}</div>` : ""}
  </div>` : ""}
  <div class="flex flex-wrap gap-2">
    <a class="${ghostButtonClass}" href="${esc(focus.debugLink)}">Debug JSON</a>
    <a class="${ghostButtonClass}" href="${esc(focus.receiptsLink)}">Receipts</a>
  </div>
</div>`;

const renderRunFocus = (focus: Extract<FactoryMissionFocusModel, { readonly kind: "run" }>): string => `<div class="space-y-5">
  <div>
    <div class="${sectionLabelClass}">Focused run</div>
    <div class="mt-2 text-lg font-semibold text-white">${esc(focus.profileLabel)} · ${esc(focus.runId)}</div>
    <div class="mt-3 flex flex-wrap gap-2">
      ${badge(focus.status)}
    </div>
  </div>
  <div class="text-sm leading-6 text-zinc-300">${esc(focus.summary)}</div>
  ${focus.prompt ? `<div>
    <div class="${sectionLabelClass}">Prompt</div>
    <div class="mt-2 text-sm leading-6 text-zinc-300">${esc(focus.prompt)}</div>
  </div>` : ""}
  ${focus.previewLines.length > 0 ? `<div>
    <div class="${sectionLabelClass}">Recent chat</div>
    <div class="mt-2 space-y-2">
      ${focus.previewLines.map((line) => `<div class="rounded-[18px] border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-zinc-300">${esc(line)}</div>`).join("")}
    </div>
  </div>` : ""}
  <div class="flex flex-wrap gap-2">
    <a class="${primaryButtonClass}" href="${esc(focus.chatLink)}">Open in Chat</a>
  </div>
</div>`;

const renderJobControls = (focus: Extract<FactoryMissionFocusModel, { readonly kind: "job" }>): string => {
  if (!focus.active) return "";
  return `<div class="mt-5 grid gap-3">
    ${renderCliActionCard({
      label: "Steer job",
      description: "Queue updated instructions for this running Factory child.",
      command: `receipt factory steer ${focus.jobId} --problem \"<updated direction>\"`,
    })}
    ${renderCliActionCard({
      label: "Follow up",
      description: "Attach more operator context without replacing the current goal.",
      command: `receipt factory follow-up ${focus.jobId} --note \"<extra context>\"`,
    })}
    ${renderCliActionCard({
      label: "Abort job",
      description: "Request a clean stop for this job from the CLI-first operator surface.",
      command: `receipt factory abort-job ${focus.jobId} --reason \"abort requested\"`,
      commandBadgeClass: dangerButtonClass,
    })}
  </div>`;
};

const renderJobFocus = (focus: Extract<FactoryMissionFocusModel, { readonly kind: "job" }>): string => `<div class="space-y-5">
  <div>
    <div class="${sectionLabelClass}">Focused job</div>
    <div class="mt-2 text-lg font-semibold text-white">${esc(focus.agentId)} · ${esc(focus.jobId)}</div>
    <div class="mt-3 flex flex-wrap gap-2">
      ${badge(focus.status)}
      ${focus.taskId ? badge(`task ${focus.taskId}`, "info") : ""}
    </div>
  </div>
  <div class="text-sm leading-6 text-zinc-300">${esc(focus.summary)}</div>
  <div class="grid gap-2 sm:grid-cols-2">
    ${statPill("Run", focus.runId ?? "none")}
    ${statPill("Parent", focus.parentRunId ?? "none")}
    ${statPill("Candidate", focus.candidateId ?? "none")}
  </div>
  ${focus.lastError ? `<div class="rounded-[22px] border border-rose-300/20 bg-rose-300/10 px-4 py-4 text-sm leading-6 text-rose-100">${esc(focus.lastError)}</div>` : ""}
  ${focus.canceledReason ? `<div class="rounded-[22px] border border-amber-300/20 bg-amber-300/10 px-4 py-4 text-sm leading-6 text-amber-100">${esc(focus.canceledReason)}</div>` : ""}
  <details class="rounded-[22px] border border-white/10 bg-black/20 p-4">
    <summary class="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">Payload JSON</summary>
    <pre class="mt-3 overflow-x-auto whitespace-pre-wrap text-[12px] leading-5 text-zinc-300 [overflow-wrap:anywhere]">${esc(focus.payload)}</pre>
  </details>
  ${focus.result ? `<details class="rounded-[22px] border border-white/10 bg-black/20 p-4">
    <summary class="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">Result JSON</summary>
    <pre class="mt-3 overflow-x-auto whitespace-pre-wrap text-[12px] leading-5 text-zinc-300 [overflow-wrap:anywhere]">${esc(focus.result)}</pre>
  </details>` : ""}
  <div class="flex flex-wrap gap-2">
    <a class="${ghostButtonClass}" href="${esc(focus.rawLink)}" target="_blank" rel="noreferrer">Job JSON</a>
  </div>
  ${renderJobControls(focus)}
</div>`;

const renderTaskFocus = (focus: Extract<FactoryMissionFocusModel, { readonly kind: "task" }>): string => `<div class="space-y-5">
  <div>
    <div class="${sectionLabelClass}">Focused task</div>
    <div class="mt-2 text-lg font-semibold text-white">${esc(focus.title)}</div>
    <div class="mt-3 flex flex-wrap gap-2">
      ${badge(focus.jobStatus ?? focus.status)}
      ${badge(focus.workerType)}
    </div>
  </div>
  ${focus.summary ? `<div class="text-sm leading-6 text-zinc-300">${esc(focus.summary)}</div>` : ""}
  <div class="grid gap-2 sm:grid-cols-2">
    ${statPill("Task", focus.taskId)}
    ${statPill("Candidate", focus.candidateId ?? "none")}
    ${statPill("Job", focus.jobId ?? "none")}
    ${statPill("Workspace", focus.workspaceExists ? (focus.workspaceDirty ? "dirty" : "clean") : "missing")}
  </div>
  ${focus.workspacePath ? `<div class="text-xs text-zinc-500">${esc(focus.workspacePath)}</div>` : ""}
  ${focus.workspaceHead ? `<div class="text-xs text-zinc-500">HEAD ${esc(shortHash(focus.workspaceHead))}</div>` : ""}
  ${focus.lastMessage ? `<div>
    <div class="${sectionLabelClass}">Last message</div>
    <pre class="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-zinc-300 [overflow-wrap:anywhere]">${esc(focus.lastMessage)}</pre>
  </div>` : ""}
  ${(focus.stdoutTail || focus.stderrTail) ? `<div class="rounded-[22px] border border-white/10 bg-black/20 px-4 py-4 text-sm leading-6 text-zinc-300">Open the Live panel to follow ongoing task output.</div>` : ""}
</div>`;

const renderObjectiveActions = (selected: FactoryMissionSelectedModel): string => {
  return `<div class="grid gap-3">
    ${renderCliActionCard({
      label: "Advance project",
      description: "Re-evaluate this project and dispatch the next eligible step from the CLI.",
      command: `receipt factory react ${selected.objectiveId} --message \"<operator note>\"`,
      commandBadgeClass: primaryButtonClass,
    })}
    ${renderCliActionCard({
      label: "Promote to source",
      description: "Merge the ready integration branch into the source branch.",
      command: `receipt factory promote ${selected.objectiveId}`,
    })}
    ${renderCliActionCard({
      label: "Remove worktrees",
      description: "Delete this project's task worktrees and integration workspace from disk.",
      command: `receipt factory cleanup ${selected.objectiveId}`,
    })}
    ${renderCliActionCard({
      label: "Stop project",
      description: "Stop active jobs and mark this project as canceled.",
      command: `receipt factory cancel ${selected.objectiveId} --reason \"cancel requested\"`,
      commandBadgeClass: dangerButtonClass,
    })}
    ${renderCliActionCard({
      label: "Archive project",
      description: "Hide this project from the main list without deleting its receipts.",
      command: `receipt factory archive ${selected.objectiveId}`,
    })}
  </div>`;
};

export const factoryMissionInspectorIsland = (model: FactoryMissionShellModel): string => {
  if (!model.selected) {
    return `<div class="space-y-5 px-4 py-5 md:px-5">
      <section class="${railCardClass}">
        <div class="${sectionLabelClass}">Focused item</div>
        <div class="mt-4 text-sm leading-6 text-zinc-500">Pick a project from the rail to inspect state, focus runs/jobs/tasks, and send operator guidance.</div>
      </section>
    </div>`;
  }

  const selected = model.selected;
  const focusMarkup = selected.focus.kind === "mission"
    ? renderMissionFocus(selected.focus)
    : selected.focus.kind === "run"
      ? renderRunFocus(selected.focus)
      : selected.focus.kind === "job"
        ? renderJobFocus(selected.focus)
        : renderTaskFocus(selected.focus);

  return `<div class="space-y-5 px-4 py-5 md:px-5">
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Focused item</div>
        ${badge(selected.focus.status)}
      </div>
      <div class="mt-4">
        ${focusMarkup}
      </div>
    </section>
    <section class="${railCardClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="${sectionLabelClass}">Project actions</div>
        <a class="${ghostButtonClass}" href="${esc(selected.chatLink)}">Back to Chat</a>
      </div>
      <div class="mt-4">
        ${renderObjectiveActions(selected)}
      </div>
    </section>
  </div>`;
};

export const factoryMissionControlShell = (model: FactoryMissionShellModel): string => `<!doctype html>
<html class="h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Factory Project Details</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css" />
  <script src="/assets/htmx.min.js"></script>
</head>
<body class="overflow-x-hidden lg:h-screen lg:overflow-hidden" data-objective="${esc(model.objectiveId ?? "")}" data-panel="${esc(model.panel)}" data-focus-kind="${esc(model.focusKind)}" data-focus-id="${esc(model.focusId ?? "")}">
  <div class="relative min-h-screen bg-background text-foreground lg:h-screen">
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(110,231,183,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(96,165,250,0.16),transparent_30%),linear-gradient(180deg,rgba(8,10,14,0.94),rgba(8,10,14,1))]"></div>
    <div class="relative flex min-h-screen flex-col lg:grid lg:h-screen lg:min-h-0 lg:grid-cols-[320px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)_360px]">
      <aside class="order-2 min-w-0 border-t border-white/10 bg-black/30 lg:order-none lg:min-h-0 lg:border-r lg:border-t-0">
        <div class="factory-scrollbar max-h-[40vh] overflow-x-hidden overflow-y-auto lg:h-screen lg:max-h-none">
          <div id="factory-mission-rail" hx-get="/factory/control/island/rail${controlQuery({ objectiveId: model.objectiveId, panel: model.panel, focusKind: model.focusKind, focusId: model.focusId })}" hx-trigger="load, factory-rail-refresh from:body" hx-swap="innerHTML">
            ${factoryMissionRailIsland(model)}
          </div>
        </div>
      </aside>
      <main class="order-1 min-w-0 bg-black/20 lg:order-none lg:min-h-0">
        <div class="flex min-h-screen flex-col lg:h-screen lg:min-h-0">
	          <header class="border-b border-white/10 bg-black/20 backdrop-blur-xl">
	            <div class="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4 md:px-8 xl:px-10">
	              <div class="min-w-0">
	                <div class="${sectionLabelClass}">Project Details</div>
	                <div class="mt-3 text-lg font-semibold text-white">Factory</div>
	                <div class="mt-3 flex flex-wrap gap-2">
                    ${navPill({
                      href: model.selected?.chatLink ?? "/factory",
                      label: model.selected ? "Project" : "Chat",
                    })}
                    ${navPill({
                      href: `/factory/control${controlQuery({
                        objectiveId: model.objectiveId,
                        panel: model.panel,
                        focusKind: model.focusKind,
                        focusId: model.focusId,
                      })}`,
                      label: "Project Details",
                      active: true,
                    })}
                  </div>
	                <div class="mt-3 text-sm leading-6 text-zinc-400">Execution state, logs, receipts, and operator controls for the selected project.</div>
	              </div>
	              <div class="flex flex-wrap items-center gap-2">
	                ${model.selected ? `<a class="${ghostButtonClass}" href="${esc(model.selected.chatLink)}">Back to Chat</a>` : ""}
	              </div>
	            </div>
	          </header>
          <section id="factory-mission-scroll" class="factory-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div id="factory-mission-main" hx-get="/factory/control/island/main${controlQuery({ objectiveId: model.objectiveId, panel: model.panel, focusKind: model.focusKind, focusId: model.focusId })}" hx-trigger="load, factory-main-refresh from:body" hx-swap="innerHTML">
              ${factoryMissionMainIsland(model)}
            </div>
          </section>
        </div>
      </main>
      <aside class="order-3 min-w-0 border-t border-white/10 bg-black/30 xl:min-h-0 xl:border-l xl:border-t-0">
        <div class="factory-scrollbar max-h-[45vh] overflow-x-hidden overflow-y-auto xl:h-screen xl:max-h-none">
          <div id="factory-mission-inspector" hx-get="/factory/control/island/inspector${controlQuery({ objectiveId: model.objectiveId, panel: model.panel, focusKind: model.focusKind, focusId: model.focusId })}" hx-trigger="load, factory-inspector-refresh from:body" hx-swap="innerHTML">
            ${factoryMissionInspectorIsland(model)}
          </div>
        </div>
      </aside>
    </div>
  </div>
  <script>
    (function () {
      var controlSource = null;

      var getState = function () {
        return {
          objective: document.body.dataset.objective || "",
          panel: document.body.dataset.panel || "overview",
          focusKind: document.body.dataset.focusKind || "mission",
          focusId: document.body.dataset.focusId || "",
        };
      };

      var applyUrl = function (url) {
        document.body.dataset.objective = url.searchParams.get("objective") || "";
        document.body.dataset.panel = url.searchParams.get("panel") || "overview";
        document.body.dataset.focusKind = url.searchParams.get("focusKind") || "mission";
        document.body.dataset.focusId = url.searchParams.get("focusId") || "";
        history.replaceState({}, "", url.pathname + url.search);
        updateIslandUrls();
        connectControl();
      };

      var query = function () {
        var state = getState();
        var params = new URLSearchParams();
        if (state.objective) params.set("objective", state.objective);
        if (state.panel) params.set("panel", state.panel);
        if (state.focusKind) params.set("focusKind", state.focusKind);
        if (state.focusId) params.set("focusId", state.focusId);
        var built = params.toString();
        return built ? "?" + built : "";
      };

      var updateIslandUrls = function () {
        var q = query();
        var rail = document.getElementById("factory-mission-rail");
        var main = document.getElementById("factory-mission-main");
        var inspector = document.getElementById("factory-mission-inspector");
        if (rail) rail.setAttribute("hx-get", "/factory/control/island/rail" + q);
        if (main) main.setAttribute("hx-get", "/factory/control/island/main" + q);
        if (inspector) inspector.setAttribute("hx-get", "/factory/control/island/inspector" + q);
      };

      var refreshRail = function () {
        document.body.dispatchEvent(new CustomEvent("factory-rail-refresh", { bubbles: true }));
      };

      var refreshMain = function () {
        document.body.dispatchEvent(new CustomEvent("factory-main-refresh", { bubbles: true }));
      };

      var refreshInspector = function () {
        document.body.dispatchEvent(new CustomEvent("factory-inspector-refresh", { bubbles: true }));
      };

      var refreshLive = function () {
        document.body.dispatchEvent(new CustomEvent("factory-live-refresh", { bubbles: true }));
      };

      var hasLiveFocus = function () {
        var focusKind = document.body.dataset.focusKind || "mission";
        var focusId = document.body.dataset.focusId || "";
        return (focusKind === "task" || focusKind === "job") && Boolean(focusId);
      };

      var refreshFromStream = function () {
        refreshRail();
        refreshMain();
        refreshInspector();
        if (hasLiveFocus()) refreshLive();
      };

      var connectControl = function () {
        if (controlSource) controlSource.close();
        controlSource = new EventSource("/factory/control/events" + query());
        controlSource.addEventListener("factory-refresh", refreshFromStream);
        controlSource.addEventListener("receipt-refresh", refreshFromStream);
        controlSource.addEventListener("job-refresh", function () {
          refreshRail();
          refreshMain();
          refreshInspector();
          if (hasLiveFocus()) refreshLive();
        });
      };

      document.addEventListener("click", function (event) {
        var target = event.target;
        if (!(target instanceof HTMLElement)) return;
        var link = target.closest("[data-factory-nav]");
        if (!(link instanceof HTMLAnchorElement)) return;
        event.preventDefault();
        var url = new URL(link.href, window.location.origin);
        applyUrl(url);
        var mode = link.getAttribute("data-factory-nav") || "";
        if (mode === "objective") {
          refreshRail();
          refreshMain();
          refreshInspector();
          return;
        }
        refreshMain();
        refreshInspector();
      });

      document.addEventListener("DOMContentLoaded", function () {
        updateIslandUrls();
        connectControl();
      });

      document.addEventListener("htmx:afterRequest", function (event) {
        var detail = event && event.detail;
        var elt = detail && detail.elt;
        if (!elt || !(elt instanceof HTMLElement) || detail.failed) return;
        if (elt.tagName === "FORM") {
          refreshMain();
          refreshInspector();
          if (hasLiveFocus()) refreshLive();
        }
      });

      window.addEventListener("beforeunload", function () {
        if (controlSource) controlSource.close();
      });
    })();
  </script>
</body>
</html>`;
