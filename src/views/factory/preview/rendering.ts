import {
  esc,
  liveIslandAttrs,
  statusDot,
  type Tone,
} from "../../ui";
import type { FactoryWorkbenchRouteContext } from "../workbench/page";
import {
  engineerInitials,
  type FactoryPreviewRailSectionKey,
} from "../preview-model";

export type PreviewRenderContext = {
  readonly routeContext: FactoryWorkbenchRouteContext;
  readonly expandedRailSections: ReadonlyArray<FactoryPreviewRailSectionKey>;
};

export const previewIslandAttrs = (
  path: string,
  refreshOn: ReadonlyArray<{ readonly event: string; readonly throttleMs?: number }>,
  version: string,
): string => `${liveIslandAttrs({
  path,
  refreshOn,
  clientOnly: true,
})} data-refresh-swap="outerHTML" data-island-version="${esc(version)}"`;

export const renderPreviewEngineerIdentityChip = (input: {
  readonly label?: string;
  readonly role?: string;
  readonly tone: Tone;
  readonly compact?: boolean;
}): string => {
  const label = input.label?.trim();
  if (!label) return "";
  const role = input.role?.trim();
  if (input.compact) {
    return `<div class="inline-flex items-center gap-1.5 border border-border bg-background px-2 py-1 text-foreground">
      <span class="flex h-5 w-5 items-center justify-center border border-border bg-muted text-[8px] font-semibold text-foreground">${esc(engineerInitials(label))}</span>
      <span class="max-w-[72px] truncate text-[5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">${esc(label)}</span>
      ${statusDot(input.tone)}
    </div>`;
  }
  return `<div class="inline-flex items-center gap-2 border border-border bg-background px-3 py-2 text-xs text-foreground">
    <span class="flex h-7 w-7 items-center justify-center border border-border bg-muted text-[11px] font-semibold text-foreground">${esc(engineerInitials(label))}</span>
    <span class="flex flex-col">
      <span class="font-semibold text-foreground">${esc(label)}</span>
      ${role ? `<span class="text-[11px] text-muted-foreground">${esc(role)}</span>` : ""}
    </span>
    ${statusDot(input.tone)}
  </div>`;
};
