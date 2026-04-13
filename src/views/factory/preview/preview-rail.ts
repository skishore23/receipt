import type { FactoryWorkbenchWorkspaceModel, WorkbenchVersionEnvelope } from "../../factory-models";
import { badge, esc, iconCheckCircle, iconNext, iconProject, iconQueue, iconSpark, sectionLabelClass, statusDot } from "../../ui";
import {
  objectiveHref,
  objectiveRowSummary,
  previewRailPath,
  previewStatusForBoardObjective,
  railRefreshOn,
  relativeTime,
  routeHref,
  sortByUpdatedAtDesc,
} from "../preview-model";
import { engineerInitials } from "../preview-model";
import { previewIslandAttrs, type PreviewRenderContext } from "./rendering";

const renderObjectiveRow = (
  context: PreviewRenderContext,
  objective: FactoryWorkbenchWorkspaceModel["board"]["objectives"][number],
): string => {
  const selected = context.routeContext.objectiveId === objective.objectiveId;
  const presentation = previewStatusForBoardObjective(objective);
  const updated = relativeTime(objective.updatedAt);
  return `<a href="${esc(objectiveHref(context.routeContext, objective.objectiveId, objective.profile.rootProfileId, context.expandedRailSections))}" class="block min-w-0 max-w-full overflow-hidden rounded-md px-1.5 py-1.5 no-underline transition ${selected ? "bg-primary/10" : "hover:bg-muted/15"}">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-start gap-1.5">
          ${presentation.key === "running" ? statusDot("info") : ""}
          <div class="min-w-0 text-[12px] font-medium leading-5 text-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden [overflow-wrap:anywhere]">${esc(objective.title)}</div>
        </div>
        <div class="mt-0.5 text-[10px] leading-4.5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:1] overflow-hidden [overflow-wrap:anywhere]">${esc(objectiveRowSummary(objective))}</div>
      </div>
      <div class="shrink-0 self-start text-[10px]">${badge(presentation.label, presentation.tone)}</div>
    </div>
    <div class="mt-1 flex min-w-0 items-center justify-between gap-2 text-[10px] text-muted-foreground">
      <div class="flex min-w-0 items-center gap-2">
        <span class="flex h-4 w-4 items-center justify-center border border-border/70 bg-background text-[8px] font-semibold text-foreground">${esc(engineerInitials(objective.profile.rootProfileLabel))}</span>
        <span class="truncate">${esc(objective.profile.rootProfileLabel)}</span>
      </div>
      <span class="shrink-0">${esc(updated || "just now")}</span>
    </div>
  </a>`;
};

const renderRailSection = (
  context: PreviewRenderContext,
  sectionKey: "active" | "needs_attention" | "completed" | "archived",
  title: string,
  objectives: ReadonlyArray<FactoryWorkbenchWorkspaceModel["board"]["objectives"][number]>,
  emptyMessage: string,
): string => {
  const expanded = context.expandedRailSections.includes(sectionKey);
  const visibleObjectives = expanded ? objectives : objectives.slice(0, 3);
  const hiddenCount = Math.max(0, objectives.length - visibleObjectives.length);
  const nextExpandedRailSections = expanded
    ? context.expandedRailSections.filter((key) => key !== sectionKey)
    : [...context.expandedRailSections, sectionKey];
  return `<section class="min-w-0 space-y-1 overflow-hidden">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">${sectionIcon(sectionKey)}<span>${esc(title)}</span></div>
      <div class="text-[10px] text-muted-foreground">${esc(String(objectives.length))}</div>
    </div>
    ${objectives.length > 0
      ? `<div class="space-y-0.5">${visibleObjectives.map((objective) => renderObjectiveRow(context, objective)).join("")}</div>`
      : `<div class="px-1 text-[11px] leading-5 text-muted-foreground">${esc(emptyMessage)}</div>`}
    ${objectives.length > 3
      ? `<div class="flex items-center justify-between gap-2 px-1">
          <div class="min-w-0 text-[10px] leading-5 text-muted-foreground">${expanded ? "Showing all objectives." : `Showing 3 of ${objectives.length}.`}</div>
          <a href="${esc(routeHref(context.routeContext, {}, nextExpandedRailSections))}" class="shrink-0 text-[10px] font-medium text-foreground underline-offset-4 hover:underline">${expanded ? "Show less" : `Show ${hiddenCount} more`}</a>
        </div>`
      : ""}
  </section>`;
};

const sectionIcon = (sectionKey: "active" | "needs_attention" | "completed" | "archived"): string => {
  if (sectionKey === "active") return iconSpark("h-3.5 w-3.5");
  if (sectionKey === "needs_attention") return iconQueue("h-3.5 w-3.5");
  if (sectionKey === "completed") return iconCheckCircle("h-3.5 w-3.5");
  return iconNext("h-3.5 w-3.5");
};

export const renderPreviewRailIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  envelope: WorkbenchVersionEnvelope,
  context: PreviewRenderContext,
): string => {
  const activeObjectives = sortByUpdatedAtDesc([
    ...workspace.board.sections.active,
    ...workspace.board.sections.queued,
  ]);
  const attentionObjectives = sortByUpdatedAtDesc(workspace.board.sections.needs_attention);
  const completedObjectives = sortByUpdatedAtDesc(workspace.board.sections.completed);
  const archivedObjectives = sortByUpdatedAtDesc(workspace.board.sections.archived);
  const sectionDivider = '<div class="mx-1 h-px bg-border/70"></div>';
  return `<aside id="factory-preview-rail" class="min-w-[200px] space-y-2 overflow-hidden px-1.5 py-1 xl:h-full xl:min-h-0 xl:overflow-y-auto xl:border-r xl:border-border xl:pr-3" ${previewIslandAttrs(
    previewRailPath(context.routeContext, context.expandedRailSections),
    railRefreshOn,
    `${envelope.boardVersion}:${context.expandedRailSections.join(",")}`,
  )}>
    <div class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">${iconProject("h-3.5 w-3.5")}<span>Objectives</span></div>
    ${[
      renderRailSection(context, "active", "Active", activeObjectives, "No active or queued objectives for this profile yet."),
      renderRailSection(context, "needs_attention", "Needs Attention", attentionObjectives, "No blocked or needs-input objectives right now."),
      renderRailSection(context, "completed", "Completed", completedObjectives, "Completed objectives will appear here."),
      renderRailSection(context, "archived", "Archived", archivedObjectives, "Archived objectives stay quiet here."),
    ].join(sectionDivider)}
  </aside>`;
};
