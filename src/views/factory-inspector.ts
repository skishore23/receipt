import { esc, sectionLabelClass, softPanelClass } from "./ui.js";
import type { FactoryInspectorModel } from "./factory-models.js";

const renderOverviewPanel = (model: FactoryInspectorModel): string => {
  return `<div class="space-y-3 px-3 py-3 md:px-4">Overview Panel</div>`;
};

const renderExecutionPanel = (model: FactoryInspectorModel): string => {
  return `<div class="space-y-3 px-3 py-3 md:px-4">Execution Graph</div>`;
};

const renderLivePanel = (model: FactoryInspectorModel): string => {
  return `<div class="space-y-3 px-3 py-3 md:px-4">Live Logs</div>`;
};

const renderReceiptsPanel = (model: FactoryInspectorModel): string => {
  return `<div class="space-y-3 px-3 py-3 md:px-4">Receipts</div>`;
};

const renderDebugPanel = (model: FactoryInspectorModel): string => {
  return `<div class="space-y-3 px-3 py-3 md:px-4">Debug</div>`;
};

export const factoryInspectorIsland = (model: FactoryInspectorModel): string => {
  switch (model.panel) {
    case "overview": return renderOverviewPanel(model);
    case "execution": return renderExecutionPanel(model);
    case "live": return renderLivePanel(model);
    case "receipts": return renderReceiptsPanel(model);
    case "debug": return renderDebugPanel(model);
    default: {
      const exhaustiveCheck: never = model.panel;
      throw new Error(`Unhandled panel type: ${exhaustiveCheck}`);
    }
  }
};
