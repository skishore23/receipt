import type { FactoryObjectiveDetail, FactoryArtifactActivity } from "../../../services/factory-types";
import type { FactoryWorkbenchFocus, FactoryWorkbenchTaskCard } from "../../factory-workbench";
import type { FactoryWorkbenchWorkspaceModel, WorkbenchVersionEnvelope } from "../../factory-models";
import {
  badge,
  displayLabel,
  esc,
  formatTs,
  ghostButtonClass,
  iconJob,
  iconMemory,
  iconProject,
  iconReceipt,
  iconSpark,
  iconTask,
  renderEmptyState,
  sectionLabelClass,
  toneForValue,
} from "../../ui";
import { compactStatusText, titleCaseLabel } from "../shared";
import { renderObjectiveSelfImprovementSnapshot } from "../shared/self-improvement";
import { renderMarkdown } from "../shared/markdown";
import {
  buildPreviewSearch,
  detailPresentationStatus,
  drawerSectionRefreshOn,
  DRAWER_SECTIONS,
  engineerInitials,
  executionSummary,
  objectiveHref,
  previewDrawerSectionPath,
  relativeTime,
  ribbonSegments,
  type FactoryPreviewDrawerSectionKey,
  type PreviewSectionDescriptor,
} from "../preview-model";
import { previewIslandAttrs, type PreviewRenderContext } from "./rendering";

const propertyRow = (label: string, value?: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return `<div class="grid gap-1 border border-border bg-background px-3 py-3">
    <div class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">${esc(label)}</div>
    <div class="text-sm leading-6 text-foreground">${esc(trimmed)}</div>
  </div>`;
};

const codeBlock = (label: string, value?: string, tone: "normal" | "danger" = "normal"): string => {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return `<section class="border ${tone === "danger" ? "border-destructive/25 bg-destructive/5" : "border-border bg-background"}">
    <div class="border-b ${tone === "danger" ? "border-destructive/20" : "border-border"} px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] ${tone === "danger" ? "text-destructive" : "text-muted-foreground"}">${esc(label)}</div>
    <pre class="max-h-64 overflow-auto px-3 py-3 text-[11px] leading-5 text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(trimmed)}</pre>
  </section>`;
};

const previewPrimaryActionClass = "inline-flex items-center justify-center border border-primary/40 bg-primary px-2.5 py-1.5 text-[12px] font-semibold text-primary-foreground transition hover:bg-primary/90";

const renderDrawerSectionNav = (
  objectiveSelected: boolean,
): string => {
  if (!objectiveSelected) return "";
  return `<nav aria-label="Inspector sections" class="mt-4 flex flex-wrap gap-2">
    ${DRAWER_SECTIONS.map((section) => `<a href="#factory-preview-drawer-shell-${section.key}" class="inline-flex items-center  border border-border bg-background px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:border-foreground/15 hover:text-foreground">${esc(section.label)}</a>`).join("")}
  </nav>`;
};

const renderDrawerSectionShell = (
  section: PreviewSectionDescriptor,
  envelope: WorkbenchVersionEnvelope,
  context: PreviewRenderContext,
  objectiveSelected: boolean,
): string => `<details id="factory-preview-drawer-shell-${section.key}" class="scroll-mt-24 overflow-hidden border border-border bg-card"${section.openByDefault ? " open" : ""}>
  <summary class="cursor-pointer list-none px-4 py-4 transition hover:bg-muted/20">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-foreground">${esc(section.label)}</div>
        <div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(section.summary)}</div>
      </div>
      <span class="shrink-0  border border-border bg-background px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Open</span>
    </div>
  </summary>
  <div class="border-t border-border px-4 py-4">
    <div id="factory-preview-drawer-${section.key}" data-preview-drawer-section="${esc(section.key)}" ${previewIslandAttrs(
      previewDrawerSectionPath(section.key, context.routeContext, context.expandedRailSections),
      drawerSectionRefreshOn(section.key),
      `${envelope.focusVersion}:${section.key}`,
    )}>
      ${renderEmptyState({
        icon: section.key === "execution"
          ? iconJob("h-4 w-4")
          : section.key === "self-improvement"
            ? iconSpark("h-4 w-4")
          : section.key === "receipts"
            ? iconReceipt("h-4 w-4")
            : section.key === "artifacts"
              ? iconMemory("h-4 w-4")
              : section.key === "tasks"
                ? iconTask("h-4 w-4")
                : iconProject("h-4 w-4"),
        title: objectiveSelected ? `Open ${section.label}` : "Select an objective",
        message: objectiveSelected
          ? `Open this section to load ${section.label.toLowerCase()} without turning the main workspace into a dashboard collage.`
          : "Pick an objective from the rail before opening detail sections.",
        minHeightClass: "min-h-[140px]",
      })}
    </div>
  </div>
</details>`;

export const renderPreviewDrawerShell = (
  workspace: FactoryWorkbenchWorkspaceModel,
  envelope: WorkbenchVersionEnvelope,
  context: PreviewRenderContext,
): string => `<div id="factory-preview-drawer-backdrop" class="fixed inset-0 z-30 bg-black/50 xl:hidden" style="display:none;"></div>
<aside id="factory-preview-drawer" class="fixed inset-y-0 right-0 z-40 flex w-[94vw] max-w-[420px] flex-col overflow-y-auto overflow-x-hidden border-l border-border bg-background shadow-2xl xl:static xl:h-full xl:min-h-0 xl:w-auto xl:max-w-none xl:border xl:border-border xl:bg-card xl:shadow-[0_30px_120px_rgba(15,23,42,0.16)]" style="display:none;">
  <div class="border-b border-border px-4 py-4 xl:px-5">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="${sectionLabelClass}">Inspector</div>
        <div class="mt-1 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">${esc(workspace.selectedObjective?.title ?? "Objective details")}</div>
        ${workspace.selectedObjective ? `<div class="mt-2 text-xs leading-5 text-muted-foreground">${esc(ribbonSegments(workspace).join(" · "))}</div>` : ""}
      </div>
      <button type="button" data-preview-drawer-close="true" class="${ghostButtonClass} text-xs xl:hidden">Close</button>
    </div>
    ${renderDrawerSectionNav(Boolean(workspace.selectedObjective))}
  </div>
  <div class="factory-scrollbar flex-1 space-y-3 overflow-x-hidden overflow-y-auto px-4 py-4 xl:px-5 xl:pb-5">
    ${DRAWER_SECTIONS.map((section) => renderDrawerSectionShell(section, envelope, context, Boolean(workspace.selectedObjective))).join("")}
  </div>
</aside>`;

const renderPropertiesSection = (
  workspace: FactoryWorkbenchWorkspaceModel,
  detail?: FactoryObjectiveDetail,
): string => {
  const objective = detail ?? workspace.selectedObjective;
  const presentation = detailPresentationStatus(objective);
  if (!objective) {
    return renderEmptyState({
      icon: iconProject("h-4 w-4"),
      title: "No objective selected",
      message: "Select an objective before opening properties.",
      minHeightClass: "min-h-[140px]",
    });
  }
  const selectedSkills = detail
    ? (Array.isArray(detail.profile?.selectedSkills)
        ? detail.profile.selectedSkills.slice(0, 4).join(", ")
        : "")
    : undefined;
  return `<div id="factory-preview-drawer-properties" data-preview-drawer-section="properties">
    <div class="space-y-3">
      <div class="border border-border bg-muted/30 px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          ${badge(presentation.label, presentation.tone)}
          <div class="text-sm leading-6 text-foreground">${esc(ribbonSegments(workspace).join(" · "))}</div>
        </div>
      </div>
      <div class="grid gap-2">
        ${propertyRow("Objective", objective.objectiveId)}
        ${propertyRow("Owner", detail?.profile.rootProfileLabel ?? workspace.selectedObjective?.profileLabel)}
        ${propertyRow("Phase", `${titleCaseLabel(objective.phase) || objective.phase}${detail?.phaseDetail ? ` · ${titleCaseLabel(detail.phaseDetail) || detail.phaseDetail}` : ""}`)}
        ${propertyRow("Updated", typeof objective.updatedAt === "number" ? formatTs(objective.updatedAt) : undefined)}
        ${propertyRow("Tokens", typeof objective.tokensUsed === "number" ? objective.tokensUsed.toLocaleString() : undefined)}
        ${propertyRow("Checks", detail?.checks.length ? detail.checks.join(", ") : undefined)}
        ${propertyRow("Next Action", objective.nextAction)}
      </div>
      <section class="border border-border bg-card px-4 py-4">
        <div class="${sectionLabelClass}">Engineer Profile</div>
        <div class="mt-3 flex items-center gap-3">
          <span class="flex h-9 w-9 items-center justify-center border border-border bg-muted text-xs font-semibold text-foreground">${esc(engineerInitials(detail?.profile.rootProfileLabel ?? workspace.selectedObjective?.profileLabel))}</span>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-foreground">${esc(detail?.profile.rootProfileLabel ?? workspace.selectedObjective?.profileLabel ?? workspace.activeProfileLabel)}</div>
            <div class="text-xs leading-5 text-muted-foreground">${esc(selectedSkills || "Using checked-in Factory profiles and skills only.")}</div>
          </div>
        </div>
      </section>
    </div>
  </div>`;
};

const renderSelfImprovementSection = (
  workspace: FactoryWorkbenchWorkspaceModel,
  context: PreviewRenderContext,
  detail?: FactoryObjectiveDetail,
): string => {
  const objective = detail ?? workspace.selectedObjective;
  if (!objective) {
    return renderEmptyState({
      icon: iconSpark("h-4 w-4"),
      title: "No objective selected",
      message: "Select an objective before opening self-improvement detail.",
      minHeightClass: "min-h-[140px]",
    });
  }
  return `<div id="factory-preview-drawer-self-improvement" data-preview-drawer-section="self-improvement">
    ${renderObjectiveSelfImprovementSnapshot({
      objectiveId: objective.objectiveId,
      selfImprovement: objective.selfImprovement,
      actionButtonClass: previewPrimaryActionClass,
      buildObjectiveHref: (objectiveId, profileId) =>
        objectiveHref(context.routeContext, objectiveId, profileId, context.expandedRailSections),
      buildApplyAction: (objectiveId) =>
        `${context.routeContext.shellBase}/api/objectives/${encodeURIComponent(objectiveId)}/self-improvement/apply${buildPreviewSearch(context.routeContext, context.expandedRailSections)}`,
    }) || renderEmptyState({
      icon: iconSpark("h-4 w-4"),
      title: "No self-improvement snapshot",
      message: "This objective has not produced a self-improvement audit snapshot yet.",
      minHeightClass: "min-h-[140px]",
    })}
  </div>`;
};

const renderTaskCard = (task: FactoryWorkbenchTaskCard): string => `<article class="border ${task.isActive ? "border-primary/30 bg-primary/5" : "border-border bg-background"} px-3 py-3">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0 flex-1">
      <div class="text-sm font-semibold text-foreground">${esc(task.title)}</div>
      <div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(compactStatusText(task.latestSummary ?? task.blockedReason ?? task.prompt, 120) || "No task summary yet.")}</div>
    </div>
    ${badge(titleCaseLabel(task.status) || task.status, toneForValue(task.status))}
  </div>
  <div class="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
    <span class="border border-border bg-card px-2 py-1">${esc(task.taskId)}</span>
    <span class="border border-border bg-card px-2 py-1">${esc(titleCaseLabel(task.workerType) || task.workerType)}</span>
    ${task.dependencySummary ? `<span class="border border-border bg-card px-2 py-1">${esc(task.dependencySummary)}</span>` : ""}
  </div>
</article>`;

const renderTasksSection = (
  workspace: FactoryWorkbenchWorkspaceModel,
  detail?: FactoryObjectiveDetail,
): string => {
  const tasks = workspace.workbench?.tasks ?? [];
  if (!detail || tasks.length === 0) {
    return renderEmptyState({
      icon: iconTask("h-4 w-4"),
      title: "No task detail yet",
      message: detail ? "Tasks will appear here when the selected objective has planned or active work." : "Select an objective before opening task detail.",
      minHeightClass: "min-h-[140px]",
    });
  }
  return `<div id="factory-preview-drawer-tasks" data-preview-drawer-section="tasks" class="space-y-3">
    ${tasks.map((task) => renderTaskCard(task)).join("")}
  </div>`;
};

const collectArtifacts = (detail?: FactoryObjectiveDetail): ReadonlyArray<FactoryArtifactActivity> => {
  if (!detail) return [];
  return detail.tasks.flatMap((task) => task.artifactActivity ?? []).sort((left, right) => right.updatedAt - left.updatedAt);
};

const renderArtifactsSection = (detail?: FactoryObjectiveDetail): string => {
  const artifacts = collectArtifacts(detail);
  if (!detail || artifacts.length === 0) {
    return renderEmptyState({
      icon: iconMemory("h-4 w-4"),
      title: "No recent artifacts",
      message: detail ? "Recent artifacts will appear here after meaningful output is produced." : "Select an objective before opening artifact detail.",
      minHeightClass: "min-h-[140px]",
    });
  }
  return `<div id="factory-preview-drawer-artifacts" data-preview-drawer-section="artifacts" class="space-y-3">
    ${artifacts.slice(0, 12).map((artifact) => `<article class="border border-border bg-background px-3 py-3">
      <div class="text-sm font-semibold text-foreground">${esc(artifact.label)}</div>
      <div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(artifact.path)}</div>
      <div class="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
        <span class="border border-border bg-card px-2 py-1">${esc(relativeTime(artifact.updatedAt))}</span>
        <span class="border border-border bg-card px-2 py-1">${esc(`${artifact.bytes} bytes`)}</span>
      </div>
    </article>`).join("")}
  </div>`;
};

const renderReceiptsSection = (detail?: FactoryObjectiveDetail): string => {
  const receipts = detail?.recentReceipts ?? [];
  if (!detail || receipts.length === 0) {
    return renderEmptyState({
      icon: iconReceipt("h-4 w-4"),
      title: "No recent receipts",
      message: detail ? "Receipt-backed events will appear here as the selected objective changes." : "Select an objective before opening receipt detail.",
      minHeightClass: "min-h-[140px]",
    });
  }
  return `<div id="factory-preview-drawer-receipts" data-preview-drawer-section="receipts" class="space-y-3">
    ${[...receipts].slice(-10).reverse().map((receipt) => `<article class="border border-border bg-background px-3 py-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold text-foreground">${esc(displayLabel(receipt.type) || receipt.type)}</div>
          <div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(compactStatusText(receipt.summary, 140) || receipt.summary)}</div>
        </div>
        <span class="text-[11px] text-muted-foreground">${esc(relativeTime(receipt.ts))}</span>
      </div>
      <div class="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
        <span class="border border-border bg-card px-2 py-1">${esc(receipt.hash.slice(0, 10))}</span>
        ${receipt.taskId ? `<span class="border border-border bg-card px-2 py-1">${esc(receipt.taskId)}</span>` : ""}
        ${receipt.candidateId ? `<span class="border border-border bg-card px-2 py-1">${esc(receipt.candidateId)}</span>` : ""}
      </div>
    </article>`).join("")}
  </div>`;
};

const renderExecutionSummary = (focus?: FactoryWorkbenchFocus): string => {
  if (!focus) return "";
  return `<section class="border border-border bg-muted/25 px-4 py-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold text-foreground">${esc(focus.title)}</div>
        <div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(executionSummary(focus))}</div>
      </div>
      ${badge(titleCaseLabel(focus.status) || focus.status, toneForValue(focus.status))}
    </div>
    <div class="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
      ${focus.focusKind === "task" && focus.taskId ? `<span class="border border-border bg-background px-2 py-1">${esc(focus.taskId)}</span>` : ""}
      ${focus.jobId ? `<span class="border border-border bg-background px-2 py-1">${esc(focus.jobId)}</span>` : ""}
      ${focus.candidateId ? `<span class="border border-border bg-background px-2 py-1">${esc(focus.candidateId)}</span>` : ""}
    </div>
  </section>`;
};

const renderExecutionSection = (
  workspace: FactoryWorkbenchWorkspaceModel,
  detail?: FactoryObjectiveDetail,
): string => {
  const focus = workspace.workbench?.focus;
  const markdown = detail?.latestHandoff?.renderedBody?.trim();
  if (!detail || (!focus && !workspace.activeRun && !workspace.activeCodex)) {
    return renderEmptyState({
      icon: iconJob("h-4 w-4"),
      title: "Execution detail is idle",
      message: detail ? "Execution logs and live output will appear here when the selected objective has active work." : "Select an objective before opening execution detail.",
      minHeightClass: "min-h-[160px]",
    });
  }
  return `<div id="factory-preview-drawer-execution" data-preview-drawer-section="execution" class="space-y-3">
    ${renderExecutionSummary(focus)}
    ${focus?.stdoutTail ? codeBlock("Recent Output", focus.stdoutTail) : ""}
    ${focus?.stderrTail ? codeBlock("Recent Error Output", focus.stderrTail, "danger") : ""}
    ${markdown ? `<section class="border border-border bg-background px-4 py-4">
      <div class="${sectionLabelClass}">Latest Handoff Summary</div>
      <div class="mt-3 factory-markdown text-sm leading-6 text-foreground">${renderMarkdown(markdown)}</div>
    </section>` : ""}
    ${detail.recentReceipts.length > 0 ? `<a href="/receipt" class="${ghostButtonClass} text-xs inline-flex">Open Receipts</a>` : ""}
  </div>`;
};

export const renderPreviewDrawerSectionIsland = (input: {
  readonly section: FactoryPreviewDrawerSectionKey;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly detail?: FactoryObjectiveDetail;
  readonly context: PreviewRenderContext;
}): string => {
  const version = `${input.envelope.focusVersion}:${input.section}`;
  const content = (() => {
    switch (input.section) {
      case "properties":
        return renderPropertiesSection(input.workspace, input.detail);
      case "self-improvement":
        return renderSelfImprovementSection(input.workspace, input.context, input.detail);
      case "tasks":
        return renderTasksSection(input.workspace, input.detail);
      case "artifacts":
        return renderArtifactsSection(input.detail);
      case "receipts":
        return renderReceiptsSection(input.detail);
      case "execution":
        return renderExecutionSection(input.workspace, input.detail);
    }
  })();
  return `<div id="factory-preview-drawer-${input.section}" data-preview-drawer-section="${esc(input.section)}" ${previewIslandAttrs(
    previewDrawerSectionPath(input.section, input.context.routeContext, input.context.expandedRailSections),
    drawerSectionRefreshOn(input.section),
    version,
  )}>
    ${content}
  </div>`;
};
