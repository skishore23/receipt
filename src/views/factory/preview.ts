import type { FactoryObjectiveDetail } from "../../services/factory-types";
import type { FactoryChatIslandModel, FactoryWorkbenchWorkspaceModel, WorkbenchVersionEnvelope } from "../factory-models";
import type { FactoryWorkbenchShellBase } from "./workbench/route";
import type { FactoryWorkbenchHeaderIslandModel } from "./workbench/page";
import {
  buildPreviewRouteContext,
  previewRouteContext,
  type FactoryPreviewDrawerSectionKey,
  type FactoryPreviewRailSectionKey,
  type PreviewRouteModel,
} from "./preview-model";
import { renderPreviewDrawerSectionIsland } from "./preview/preview-drawer";
import { renderPreviewRailIsland } from "./preview/preview-rail";
import { renderPreviewShell, renderPreviewHeaderIsland } from "./preview/preview-shell";
import { renderPreviewFocusIsland, renderPreviewTimelineIsland } from "./preview/preview-thread";
import type { PreviewRenderContext } from "./preview/rendering";

export type { FactoryPreviewDrawerSectionKey, FactoryPreviewRailSectionKey } from "./preview-model";

const previewContext = (
  routeContext: ReturnType<typeof previewRouteContext>,
  expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey>,
): PreviewRenderContext => ({
  routeContext,
  expandedRailSections,
});

const workspaceRouteContext = (
  shellBase: FactoryWorkbenchShellBase,
  workspace: FactoryWorkbenchWorkspaceModel,
) => buildPreviewRouteContext({
  shellBase,
  profileId: workspace.activeProfileId,
  chatId: workspace.chatId,
  objectiveId: workspace.objectiveId,
  inspectorTab: workspace.inspectorTab,
  detailTab: workspace.detailTab,
  page: workspace.page,
  focusKind: workspace.focusKind,
  focusId: workspace.focusId,
  filter: workspace.filter,
});

export const factoryPreviewShell = (input: PreviewRouteModel): string => {
  const expandedRailSections = input.expandedRailSections ?? [];
  const routeContext = previewRouteContext(input);
  return renderPreviewShell(input, previewContext(routeContext, expandedRailSections));
};

export const factoryPreviewHeaderIsland = (input: {
  readonly shellBase: FactoryWorkbenchShellBase;
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly expandedRailSections?: ReadonlyArray<FactoryPreviewRailSectionKey>;
}): string =>
  renderPreviewHeaderIsland(
    input.header,
    input.workspace,
    input.envelope,
    previewContext(workspaceRouteContext(input.shellBase, input.workspace), input.expandedRailSections ?? []),
  );

export const factoryPreviewRailIsland = (input: {
  readonly shellBase: FactoryWorkbenchShellBase;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly expandedRailSections?: ReadonlyArray<FactoryPreviewRailSectionKey>;
}): string => renderPreviewRailIsland(
  input.workspace,
  input.envelope,
  previewContext(workspaceRouteContext(input.shellBase, input.workspace), input.expandedRailSections ?? []),
);

export const factoryPreviewFocusIsland = (input: {
  readonly shellBase: FactoryWorkbenchShellBase;
  readonly header: FactoryWorkbenchHeaderIslandModel;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly expandedRailSections?: ReadonlyArray<FactoryPreviewRailSectionKey>;
}): string => renderPreviewFocusIsland(
  input.workspace,
  input.header,
  input.envelope,
  previewContext(workspaceRouteContext(input.shellBase, input.workspace), input.expandedRailSections ?? []),
);

export const factoryPreviewTimelineIsland = (input: {
  readonly shellBase: FactoryWorkbenchShellBase;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly chat: FactoryChatIslandModel;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly expandedRailSections?: ReadonlyArray<FactoryPreviewRailSectionKey>;
}): string => renderPreviewTimelineIsland(
  input.workspace,
  input.chat,
  input.envelope,
  previewContext(workspaceRouteContext(input.shellBase, input.workspace), input.expandedRailSections ?? []),
);

export const factoryPreviewDrawerSectionIsland = (input: {
  readonly shellBase: FactoryWorkbenchShellBase;
  readonly section: FactoryPreviewDrawerSectionKey;
  readonly workspace: FactoryWorkbenchWorkspaceModel;
  readonly envelope: WorkbenchVersionEnvelope;
  readonly detail?: FactoryObjectiveDetail;
  readonly expandedRailSections?: ReadonlyArray<FactoryPreviewRailSectionKey>;
}): string => renderPreviewDrawerSectionIsland({
  section: input.section,
  workspace: input.workspace,
  envelope: input.envelope,
  detail: input.detail,
  context: previewContext(workspaceRouteContext(input.shellBase, input.workspace), input.expandedRailSections ?? []),
});
