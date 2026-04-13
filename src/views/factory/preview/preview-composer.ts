import type { FactorySelectedObjectiveCard, FactoryWorkbenchWorkspaceModel } from "../../factory-models";
import { esc } from "../../ui";
import {
  composerCommandsJson,
  composerPanelClass,
  composerShellClass,
  composerTextareaClass,
} from "../shared";
import { composeAction, currentComposerJobId } from "../preview-model";
import type { PreviewRenderContext } from "./rendering";

const workbenchComposerPlaceholder = (selectedObjective?: FactorySelectedObjectiveCard): string => {
  if (!selectedObjective) return "Ask a new question, or use /obj to create an objective directly.";
  if (selectedObjective.status === "blocked") {
    return "Use /react <guidance> or /steer <guidance> to continue the selected objective.";
  }
  if (selectedObjective.status === "completed" || selectedObjective.status === "failed" || selectedObjective.status === "canceled") {
    return "Use /obj to start follow-up work, or plain text to discuss the next step.";
  }
  return "Chat with Factory, or use /note, /react, /follow-up, /steer, or /obj to direct the selected objective.";
};

export const renderPreviewComposerShell = (
  workspace: FactoryWorkbenchWorkspaceModel,
  context: PreviewRenderContext,
): string => `<div class="${composerShellClass} shrink-0 overflow-x-hidden">
  <section id="factory-preview-composer-shell" class="border-t border-border bg-background px-3 py-3">
    <form id="factory-preview-composer" action="${esc(composeAction(context.routeContext, context.expandedRailSections))}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
      <input id="factory-preview-current-job" type="hidden" name="currentJobId" value="${esc(currentComposerJobId(workspace) ?? "")}" />
      <label class="sr-only" for="factory-preview-prompt">Factory prompt</label>
      <div class="${composerPanelClass} mx-auto max-w-[880px]">
        <textarea id="factory-preview-prompt" name="prompt" class="${composerTextareaClass}" rows="2" placeholder="${esc(workbenchComposerPlaceholder(workspace.selectedObjective))}"></textarea>
        <div class="flex items-center justify-end gap-3">
          <button id="factory-preview-composer-submit" class="inline-flex items-center justify-center border border-primary/40 bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground" type="submit">Send</button>
        </div>
      </div>
      <div id="factory-preview-composer-status" class="mt-3 hidden border border-border bg-muted px-3 py-2 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
    </form>
  </section>
</div>`;
