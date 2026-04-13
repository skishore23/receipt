import type {
  FactoryChatIslandModel,
  FactorySelectedObjectiveCard,
  FactoryWorkbenchWorkspaceModel,
  WorkbenchVersionEnvelope,
} from "../../factory-models";
import { badge, esc, ghostButtonClass, iconChat } from "../../ui";
import type { FactoryWorkbenchHeaderIslandModel } from "../workbench/page";
import {
  activeJobCount,
  focusRefreshOn,
  latestHeartbeatAt,
  latestProgressSummary,
  latestObjectiveSummary,
  objectiveHref,
  previewFocusPath,
  previewStatusForObjective,
  previewTimelinePath,
  relativeTime,
  timelineRefreshOn,
} from "../preview-model";
import { describeTranscriptState, renderTranscriptContent } from "../transcript";
import { renderPreviewEngineerIdentityChip, previewIslandAttrs, type PreviewRenderContext } from "./rendering";

const renderMinimalPreviewIdleState = (): string => `<div class="mx-auto flex w-full max-w-[880px] items-center gap-3 px-1 py-3 text-muted-foreground">
  <span class="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground/80">${iconChat("h-4 w-4")}</span>
  <div class="min-w-0">
    <div class="text-[12px] font-medium text-foreground">Start a conversation</div>
    <div class="text-[12px] leading-5 text-muted-foreground">Pick an objective from the rail or use <span class="font-medium text-foreground">/obj</span>.</div>
  </div>
</div>`;

const focusStatusLine = (
  workspace: FactoryWorkbenchWorkspaceModel,
  selectedObjective: FactorySelectedObjectiveCard,
): string => {
  const loading = workspace.workbench?.focus?.loading;
  const message = loading?.summary || latestProgressSummary(workspace) || latestObjectiveSummary(selectedObjective);
  const jobs = activeJobCount(workspace);
  const heartbeatAt = latestHeartbeatAt(workspace);
  const meta = [
    loading?.detail,
    jobs > 0 ? `${jobs} active job${jobs === 1 ? "" : "s"}` : undefined,
    heartbeatAt ? `updated ${relativeTime(heartbeatAt)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return `${message ? `<div class="mt-2 max-w-[76ch] text-[13px] leading-6 text-muted-foreground [overflow-wrap:anywhere]">${esc(message)}</div>` : ""}${meta.length > 0 ? `<div class="mt-3 flex flex-wrap items-center gap-2">
    ${meta.map((item) => `<span class="inline-flex items-center  border border-border bg-background px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">${esc(item)}</span>`).join("")}
  </div>` : ""}${loading?.highlights?.length ? `<div class="mt-3 space-y-1.5 max-w-[76ch]">
    ${loading.highlights.map((line) => `<div class="text-[12px] leading-5 text-muted-foreground">${esc(line)}</div>`).join("")}
  </div>` : ""}${loading?.nextAction ? `<div class="mt-3 max-w-[76ch]  border border-border bg-muted/25 px-3 py-2 text-[12px] leading-5 text-muted-foreground">${esc(loading.nextAction)}</div>` : ""}`;
};

export const renderPreviewFocusIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  header: FactoryWorkbenchHeaderIslandModel,
  envelope: WorkbenchVersionEnvelope,
  context: PreviewRenderContext,
): string => {
  const selectedObjective = workspace.selectedObjective;
  if (!selectedObjective) {
    return `<section id="factory-preview-focus" class="hidden" ${previewIslandAttrs(
      previewFocusPath(context.routeContext, context.expandedRailSections),
      focusRefreshOn,
      `${envelope.focusVersion}:${envelope.boardVersion}`,
    )}></section>`;
  }
  const presentation = previewStatusForObjective(selectedObjective);
  return `<section id="factory-preview-focus" class="min-w-0 shrink-0 overflow-hidden border-b border-border pb-3" ${previewIslandAttrs(
    previewFocusPath(context.routeContext, context.expandedRailSections),
    focusRefreshOn,
    `${envelope.focusVersion}:${envelope.boardVersion}`,
  )}>
    <div class="mx-auto w-full max-w-[880px] px-1">
      <div class="flex flex-wrap items-center gap-2.5">
        ${renderPreviewEngineerIdentityChip({
          label: selectedObjective.profileLabel ?? header.activeProfileLabel,
          role: header.currentRole,
          tone: presentation.tone,
          compact: true,
        })}
        <h1 class="min-w-0 text-xl font-semibold text-foreground [overflow-wrap:anywhere]">${esc(selectedObjective.title)}</h1>
        ${badge(presentation.label, presentation.tone)}
        ${workspace.workbench?.focus?.loading?.label && workspace.workbench.focus.loading.label !== presentation.label
          ? badge(workspace.workbench.focus.loading.label, workspace.workbench.focus.loading.tone)
          : ""}
        <button type="button" data-preview-drawer-toggle="true" data-preview-drawer-toggle-label="Inspector" data-preview-drawer-toggle-open-label="Hide inspector" class="${ghostButtonClass} text-xs">Inspector</button>
      </div>
      ${focusStatusLine(workspace, selectedObjective)}
    </div>
  </section>`;
};

export const renderPreviewTimelineIsland = (
  workspace: FactoryWorkbenchWorkspaceModel,
  chat: FactoryChatIslandModel,
  envelope: WorkbenchVersionEnvelope,
  context: PreviewRenderContext,
): string => {
  if (!workspace.selectedObjective) {
    return `<section id="factory-preview-timeline" class="min-w-0 overflow-hidden xl:flex xl:min-h-0 xl:flex-1 xl:flex-col" ${previewIslandAttrs(
      previewTimelinePath(context.routeContext, context.expandedRailSections),
      timelineRefreshOn,
      envelope.chatVersion,
    )}>
      <div id="factory-preview-timeline-root" class="px-1 py-4 xl:min-h-0 xl:flex-1" data-active-profile-label="${esc(chat.activeProfileLabel)}" data-active-run-id="${esc(chat.runId ?? "")}" data-known-run-ids="${esc((chat.knownRunIds ?? []).join(","))}" data-terminal-run-ids="${esc((chat.terminalRunIds ?? []).join(","))}" data-transcript-signature="idle" data-last-item-kind="">
        ${renderMinimalPreviewIdleState()}
      </div>
    </section>`;
  }
  const transcript = renderTranscriptContent(chat, {
    objectiveHref: (objectiveId) => objectiveHref(context.routeContext, objectiveId),
    emptyState: {
      title: workspace.selectedObjective ? "Waiting for the next update." : "Start a new objective conversation.",
      message: workspace.selectedObjective
        ? "Meaningful handoffs, progress updates, needs-input prompts, and completion summaries land here."
        : "Pick an objective from the rail or start one with /obj to make the chat pane the center of gravity.",
    },
  });
  const transcriptState = describeTranscriptState(chat);
  return `<section id="factory-preview-timeline" class="min-w-0 overflow-hidden xl:flex xl:min-h-0 xl:flex-1 xl:flex-col" ${previewIslandAttrs(
    previewTimelinePath(context.routeContext, context.expandedRailSections),
    timelineRefreshOn,
    envelope.chatVersion,
  )}>
    <div id="factory-preview-timeline-root" class="factory-scrollbar px-1 py-4 xl:min-h-0 xl:flex-1 xl:overflow-y-auto" data-active-profile-label="${esc(chat.activeProfileLabel)}" data-active-run-id="${esc(chat.runId ?? "")}" data-known-run-ids="${esc((chat.knownRunIds ?? []).join(","))}" data-terminal-run-ids="${esc((chat.terminalRunIds ?? []).join(","))}" data-transcript-signature="${esc(transcriptState.signature)}" data-last-item-kind="${esc(transcriptState.lastItemKind ?? "")}">
      <div class="mx-auto w-full max-w-[880px] space-y-4">
        ${transcript.body}
        <div id="factory-preview-ephemeral" class="space-y-4 pb-1" aria-live="polite"></div>
      </div>
    </div>
  </section>`;
};
