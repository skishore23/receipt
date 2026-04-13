import type { FactoryWorkbenchWorkspaceModel, WorkbenchVersionEnvelope } from "../../factory-models";
import { CSS_VERSION, esc, ghostButtonClass } from "../../ui";
import { headerRefreshOn, previewHeaderPath, type PreviewRouteModel } from "../preview-model";
import { renderHeaderProfileSelect } from "../shared";
import type { FactoryWorkbenchHeaderIslandModel } from "../workbench/page";
import { renderPreviewComposerShell } from "./preview-composer";
import { renderPreviewDrawerShell } from "./preview-drawer";
import { renderPreviewRailIsland } from "./preview-rail";
import { renderPreviewFocusIsland, renderPreviewTimelineIsland } from "./preview-thread";
import { previewIslandAttrs, type PreviewRenderContext } from "./rendering";

export const renderPreviewHeaderIsland = (
  header: FactoryWorkbenchHeaderIslandModel,
  workspace: FactoryWorkbenchWorkspaceModel,
  envelope: WorkbenchVersionEnvelope,
  context: PreviewRenderContext,
): string => {
  const detailsLabel = workspace.selectedObjective ? "Inspector" : "Inspector unavailable";
  return `<header id="factory-preview-header" class="border-b border-border px-1 py-1" ${previewIslandAttrs(
    previewHeaderPath(context.routeContext, context.expandedRailSections),
    headerRefreshOn,
    `${envelope.boardVersion}:${envelope.focusVersion}`,
  )}>
    <div class="flex flex-wrap items-center gap-2">
      <div class="ml-auto flex flex-wrap items-center gap-2">
        ${renderHeaderProfileSelect({
          id: "factory-preview-profile-select",
          label: "Switch engineer",
          profiles: header.profiles,
        })}
        <button type="button" data-preview-command="/obj " class="${ghostButtonClass} text-xs">New Objective</button>
        <button type="button" id="factory-preview-drawer-toggle" data-preview-drawer-toggle="true" data-preview-drawer-toggle-label="Inspector" data-preview-drawer-toggle-open-label="Hide inspector" class="${ghostButtonClass} text-xs"${workspace.selectedObjective ? "" : " disabled"}>${esc(detailsLabel)}</button>
      </div>
    </div>
  </header>`;
};

export const renderPreviewShell = (
  input: PreviewRouteModel,
  context: PreviewRenderContext,
): string => `<!doctype html>
<html class="dark h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Factory Preview</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
</head>
<body data-factory-preview data-shell-base="${esc(context.routeContext.shellBase)}" data-profile-id="${esc(context.routeContext.profileId)}" data-chat-id="${esc(context.routeContext.chatId)}" data-objective-id="${esc(context.routeContext.objectiveId ?? "")}" class="h-full overflow-hidden bg-background text-foreground">
  <div class="mx-auto box-border flex h-full min-h-0 flex-col overflow-hidden px-3 py-2 lg:px-4 xl:py-3">
    ${renderPreviewHeaderIsland(input.header, input.workspace, input.envelope, context)}
    <div id="factory-preview-layout" class="mt-1.5 grid min-h-0 flex-1 min-w-0 gap-2 overflow-hidden xl:grid-cols-[180px_minmax(0,1fr)_var(--factory-preview-drawer-width,0px)]" style="--factory-preview-drawer-width: 0px;">
      ${renderPreviewRailIsland(input.workspace, input.envelope, context)}
      <main class="min-w-0 xl:h-full xl:min-h-0 xl:overflow-hidden">
        <div class="flex h-full min-h-0 flex-col overflow-hidden">
          ${renderPreviewFocusIsland(input.workspace, input.header, input.envelope, context)}
          ${renderPreviewTimelineIsland(input.workspace, input.chat, input.envelope, context)}
          ${renderPreviewComposerShell(input.workspace, context)}
        </div>
      </main>
      ${renderPreviewDrawerShell(input.workspace, input.envelope, context)}
    </div>
  </div>
  <script src="/assets/factory-preview.js?v=${CSS_VERSION}"></script>
</body>
</html>`;
