// ============================================================================
// Runtime visualization — page shell
// ============================================================================

import { CSS_VERSION, iconFactory } from "../ui";
import { actors, stores, sideEffects, delegationSteps } from "./data";
import {
  renderLegend,
  renderPlaneHeader,
  renderActorCard,
  renderPollLoopGroup,
  renderStoreCard,
  renderSideEffectCard,
  renderDelegationLoop,
  renderConcurrencyCallout,
  renderFlowSummary,
} from "./render";

export const runtimeShell = (): string => {
  // Split actors by plane
  const controlActors = actors.filter((a) => a.plane === "control");
  const executionActors = actors.filter((a) => a.plane === "execution");
  const sideEffectActors = actors.filter((a) => a.plane === "side-effects");

  // Control plane: standalone + poll-loop group
  const controlStandalone = controlActors.filter((a) => !a.group);
  const pollLoopActors = controlActors.filter((a) => a.group === "poll-loop");

  // Stores row
  const storeCards = stores.map(renderStoreCard).join("");

  // Side effect subsystem cards
  const sideEffectCards = sideEffects.map(renderSideEffectCard).join("");

  return `<!doctype html>
<html class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Runtime</title>
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
  <script src="/assets/htmx.min.js?v=${CSS_VERSION}"></script>
</head>
<body class="bg-background text-foreground">
  <div class="mx-auto max-w-[1400px] px-4 py-6 space-y-5">

    <!-- Header -->
    <header class="flex items-center justify-between border border-border bg-card px-5 py-4">
      <div>
        <div class="flex items-center gap-2.5">
          ${iconFactory("text-muted-foreground")}
          <h1 class="text-[15px] font-bold tracking-wide text-foreground">RECEIPT RUNTIME</h1>
        </div>
        <p class="mt-1 text-[12px] text-muted-foreground">Complete runtime architecture — actors, data stores, event flows, and handoffs</p>
      </div>
      <a href="/factory" class="inline-flex items-center gap-1.5 border border-border bg-secondary px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition">
        ${iconFactory()} Factory
      </a>
    </header>

    <!-- Legend -->
    ${renderLegend()}

    <!-- Main 3-column grid -->
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">

      <!-- Control Plane -->
      <div class="border ${planeBgFor("control")} p-4 space-y-3">
        ${renderPlaneHeader("Control Plane", "control")}
        ${controlStandalone.map(renderActorCard).join("")}
        ${pollLoopActors.length ? renderPollLoopGroup(pollLoopActors) : ""}
      </div>

      <!-- Execution Plane -->
      <div class="border ${planeBgFor("execution")} p-4 space-y-3">
        ${renderPlaneHeader("Execution Plane", "execution")}
        ${executionActors.map(renderActorCard).join("")}
        ${renderDelegationLoop(delegationSteps)}
      </div>

      <!-- Side Effects -->
      <div class="border ${planeBgFor("side-effects")} p-4 space-y-3">
        ${renderPlaneHeader("Side Effects", "side-effects")}
        ${sideEffectActors.map(renderActorCard).join("")}
        <div class="space-y-2 mt-2">
          <div class="text-[10px] font-bold tracking-widest text-warning/70 uppercase">Subsystems</div>
          ${sideEffectCards}
        </div>
      </div>

    </div>

    <!-- Concurrency -->
    ${renderConcurrencyCallout()}

    <!-- Data Stores -->
    <div class="space-y-2">
      <div class="text-[11px] font-bold tracking-widest text-muted-foreground uppercase px-1">Data Stores</div>
      <div class="flex flex-wrap gap-3">
        ${storeCards}
      </div>
    </div>

    <!-- Flow Summary -->
    ${renderFlowSummary()}

  </div>
</body>
</html>`;
};

// Helper to get plane background classes (mirrors render.ts planeBg)
const planeBgFor = (plane: "control" | "execution" | "side-effects"): string => {
  switch (plane) {
    case "control": return "border-info/15 bg-info/5";
    case "execution": return "border-success/15 bg-success/5";
    case "side-effects": return "border-warning/15 bg-warning/5";
  }
};
