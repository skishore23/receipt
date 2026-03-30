import { displayLabel, esc, liveIslandAttrs, missionControlHotkeyClass, missionControlInsetClass, missionControlPanelClass, missionControlSectionLabelClass, CSS_VERSION } from "../../ui";
import type { FactoryChatShellModel } from "../../factory-models";
import {
  composerCommandsJson,
  composerJobId,
  composerPanelClass,
  composerShellClass,
  composerTextareaClass,
  factoryChatQuery,
  factoryShellIslandBindings,
  isMissionControlMode,
  modeSwitchHref,
  renderHeaderProfileSelect,
  renderShellStatusPills,
  shellHeaderTitle,
  shellProfileSummary,
  workbenchHref,
} from "../shared";
import { factorySidebarIsland } from "../sidebar";
import { factoryChatIsland } from "../workbench";
import { renderFactoryStreamingShell } from "../transcript";
import { factoryInspectorIsland } from "../../factory-inspector";

const renderDefaultFactoryShell = (model: FactoryChatShellModel): string => {
  const routeContext = {
    mode: model.mode,
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    runId: model.runId,
    jobId: model.jobId,
    panel: model.panel,
    inspectorTab: model.inspectorTab,
    focusKind: model.focusKind,
    focusId: model.focusId,
  };
  const shellQuery = factoryChatQuery(routeContext);
  const composerRouteContext = model.inspector.objectiveMissing
    ? {
        mode: model.mode,
        profileId: model.activeProfileId,
        panel: model.panel,
      }
    : routeContext;
  const composerQuery = factoryChatQuery(composerRouteContext);
  const currentJobId = model.inspector.objectiveMissing ? undefined : composerJobId(model);
  const missionControlHref = modeSwitchHref(routeContext, "mission-control");
  const workbenchViewHref = workbenchHref(routeContext);
  const islandBindings = factoryShellIslandBindings(shellQuery);
  const profileSummary = shellProfileSummary(model);
  const newChatHref = `/factory/new-chat${factoryChatQuery({
    mode: model.mode,
    profileId: model.activeProfileId,
  })}`;
  const composerPlaceholder = model.inspector.objectiveMissing
    ? "This thread no longer exists. Send a message to start a new thread."
    : model.objectiveId
      ? "Ask for status, or use /analyze, /react, /promote, /cancel, /cleanup, /archive, /abort-job..."
      : "Send the first message to start a new thread. Slash commands run direct actions.";
  return `<!doctype html>
<html class="dark h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Factory Chat</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
  <script src="/assets/htmx.min.js?v=${CSS_VERSION}"></script>
</head>
<body data-factory-chat data-factory-mode="${esc(model.mode ?? "default")}" data-focus-kind="${esc(model.focusKind ?? "")}" data-focus-id="${esc(model.focusId ?? "")}" class="font-sans antialiased overflow-x-hidden md:h-screen md:overflow-hidden">
  <div class="min-h-screen bg-background text-foreground md:h-screen">
    <div id="factory-live-root" class="flex min-h-screen flex-col md:grid md:h-screen md:min-h-0 md:grid-cols-[248px_minmax(0,1fr)_320px] lg:grid-cols-[256px_minmax(0,1fr)_336px] md:overflow-hidden">
      <aside class="order-2 min-w-0 overflow-hidden border-t border-sidebar-border bg-sidebar text-sidebar-foreground md:order-0 md:min-h-0 md:border-r md:border-t-0">
        <div class="factory-scrollbar max-h-[40vh] overflow-x-hidden overflow-y-auto md:h-full md:max-h-none">
          <div id="factory-sidebar" ${liveIslandAttrs(islandBindings.sidebar)}>
            ${factorySidebarIsland(model.nav, model.inspector.selectedObjective)}
          </div>
        </div>
      </aside>
      <main class="order-1 min-w-0 overflow-hidden bg-background md:order-0 md:min-h-0">
        <div class="flex min-h-screen flex-col md:h-full md:min-h-0">
          <header class="shrink-0 border-b border-border bg-card">
            <div class="flex items-center justify-between gap-3 px-4 py-2.5">
              <div class="min-w-0 flex flex-1 items-center gap-2 overflow-x-auto factory-scrollbar">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 overflow-x-auto factory-scrollbar">
                    <span class="text-[11px] font-medium text-muted-foreground">receipt / factory</span>
                    <h1 id="factory-shell-title" class="min-w-0 truncate text-sm font-semibold text-foreground" data-profile-label>${esc(shellHeaderTitle(model))}</h1>
                    <span id="factory-shell-status-pills" class="contents">${renderShellStatusPills(model)}</span>
                  </div>
                  ${profileSummary ? `<div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(profileSummary)}</div>` : ""}
                </div>
              </div>
              <div id="factory-shell-controls" class="flex shrink-0 items-center gap-1.5">
                ${renderHeaderProfileSelect({
                  id: "factory-shell-profile-select",
                  label: "Profile",
                  profiles: model.nav.profiles,
                })}
                <a
                  class="inline-flex items-center justify-center border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  href="${workbenchViewHref}"
                  aria-label="Open workbench"
                  title="Workbench"
                >
                  Workbench
                </a>
                <a
                  class="inline-flex items-center justify-center border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  href="${missionControlHref}"
                  aria-label="Open mission control"
                  title="Mission control"
                >
                  Mission Control
                </a>
                <a
                  class="inline-flex items-center justify-center border border-primary/20 bg-background px-3 py-2 text-sm font-medium text-primary transition hover:border-primary/35 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  href="${newChatHref}"
                  aria-label="Start a new chat"
                  title="New chat"
                >
                  New Chat
                </a>
              </div>
            </div>
          </header>
          <section id="factory-chat-scroll" class="factory-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div id="factory-chat" data-active-profile-label="${esc(model.activeProfileLabel)}" ${liveIslandAttrs(islandBindings.chat)}>
              ${factoryChatIsland(model.chat)}
            </div>
            <div id="factory-chat-live" class="chat-stack mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pb-4 md:px-8 xl:px-10">
              ${renderFactoryStreamingShell(model.activeProfileLabel, { liveMode: "js" })}
              <div id="factory-chat-optimistic" class="space-y-2" aria-live="polite"></div>
            </div>
          </section>
          <section class="shrink-0 border-t border-border bg-background px-2 py-2 sm:px-3">
            <div class="${composerShellClass}">
              <form id="factory-composer" action="/factory/compose${composerQuery}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
                <input id="factory-composer-current-job" type="hidden" name="currentJobId" value="${esc(currentJobId ?? "")}" />
                <label class="sr-only" for="factory-prompt">Factory prompt</label>
                <div class="${composerPanelClass}">
                  <div class="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
                    <textarea id="factory-prompt" name="prompt" class="${composerTextareaClass} sm:min-h-[104px]" rows="2" placeholder="${esc(composerPlaceholder)}" autofocus aria-autocomplete="list" aria-expanded="false" aria-controls="factory-composer-completions" aria-haspopup="listbox"></textarea>
                    <button id="factory-composer-submit" class="inline-flex min-h-[88px] w-full shrink-0 items-center justify-center border border-primary/40 bg-primary px-6 py-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground sm:w-[8.5rem] sm:min-h-[104px]" type="submit">Send</button>
                  </div>
                  <div id="factory-composer-completions" class="hidden max-h-56 overflow-auto border border-border bg-background shadow-lg" role="listbox" aria-label="Slash command suggestions"></div>
                </div>
                <div id="factory-composer-status" class="mt-2 hidden border border-border bg-muted px-3 py-1.5 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
              </form>
            </div>
          </section>
        </div>
      </main>
      <aside class="order-3 min-w-0 overflow-hidden border-t border-sidebar-border bg-sidebar text-sidebar-foreground md:min-h-0 md:border-l md:border-t-0">
        <div class="factory-scrollbar max-h-[45vh] overflow-x-hidden overflow-y-auto md:h-full md:max-h-none">
          <div id="factory-inspector" class="factory-inspector-panel" ${liveIslandAttrs(islandBindings.inspector)}>
            ${factoryInspectorIsland(model.inspector)}
          </div>
        </div>
      </aside>
    </div>
  </div>
  <script src="/assets/factory-client.js?v=${CSS_VERSION}"></script>
</body>
</html>`;
};

const renderMissionControlShell = (model: FactoryChatShellModel): string => {
  const routeContext = {
    mode: model.mode,
    profileId: model.activeProfileId,
    chatId: model.chatId,
    objectiveId: model.objectiveId,
    runId: model.runId,
    jobId: model.jobId,
    panel: model.panel,
    inspectorTab: model.inspectorTab,
    focusKind: model.focusKind,
    focusId: model.focusId,
  };
  const shellQuery = factoryChatQuery(routeContext);
  const composerRouteContext = model.inspector.objectiveMissing
    ? {
        mode: model.mode,
        profileId: model.activeProfileId,
        panel: model.panel,
      }
    : routeContext;
  const composerQuery = factoryChatQuery(composerRouteContext);
  const currentJobId = model.inspector.objectiveMissing ? undefined : composerJobId(model);
  const standardHref = modeSwitchHref(routeContext, "default");
  const workbenchViewHref = workbenchHref(routeContext);
  const islandBindings = factoryShellIslandBindings(shellQuery);
  const profileSummary = shellProfileSummary(model);
  const newChatHref = `/factory/new-chat${factoryChatQuery({
    mode: model.mode,
    profileId: model.activeProfileId,
  })}`;
  const composerPlaceholder = model.inspector.objectiveMissing
    ? "This thread no longer exists. Send a message to start a new thread."
    : model.objectiveId
      ? "Ask for status or use /react, /promote, /cancel, /cleanup, /archive, /abort-job..."
      : "Describe the next operator task to start a new thread.";
  const summary = model.chat.workbench?.summary;
  const statTiles = [
    ["profile", model.activeProfileLabel],
    ["phase", displayLabel(summary?.phase || model.inspector.selectedObjective?.phase || model.inspector.selectedObjective?.status || "idle") || "Idle"],
    ["tasks", `${summary?.activeTaskCount ?? 0} active / ${summary?.taskCount ?? 0} total`],
    ["checks", typeof summary?.checksCount === "number" && summary.checksCount > 0 ? `${summary.checksCount}` : "0"],
  ].map(([label, value]) => `<div class="${missionControlInsetClass} px-3 py-2">
      <div class="${missionControlSectionLabelClass}">${esc(label)}</div>
      <div class="mt-1 text-sm font-semibold text-foreground">${esc(value)}</div>
    </div>`).join("");
  const hotkeys = [
    ["tab", "cycle pane"],
    ["j / k", "queue nav"],
    ["1-5", "inspector"],
    ["c", "composer"],
    ["esc", "clear"],
  ].map(([key, label]) => `<span class="${missionControlHotkeyClass}"><span class="font-semibold text-foreground">${esc(key)}</span><span>${esc(label)}</span></span>`).join("");
  return `<!doctype html>
<html class="dark h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Factory Mission Control</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
  <script src="/assets/htmx.min.js?v=${CSS_VERSION}"></script>
</head>
<body data-factory-chat data-factory-mode="mission-control" data-focus-kind="${esc(model.focusKind ?? "")}" data-focus-id="${esc(model.focusId ?? "")}" class="font-sans antialiased overflow-x-hidden">
  <div class="mission-control-shell min-h-screen bg-background text-foreground">
    <div id="factory-live-root" class="mx-auto flex min-h-screen max-w-[1680px] flex-col gap-3 px-3 py-3 lg:px-4">
      <header class="${missionControlPanelClass} px-4 py-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[11px] font-medium text-muted-foreground">receipt / factory</div>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <h1 id="factory-shell-title" class="min-w-0 truncate text-lg font-semibold tracking-tight text-foreground" data-profile-label>${esc(shellHeaderTitle(model))}</h1>
              <span id="factory-shell-status-pills" class="contents">${renderShellStatusPills(model)}</span>
            </div>
            ${profileSummary ? `<div class="mt-2 max-w-[64ch] text-sm leading-6 text-muted-foreground">${esc(profileSummary)}</div>` : ""}
          </div>
          <div id="factory-shell-controls" class="flex flex-wrap items-center gap-2">
            ${renderHeaderProfileSelect({
              id: "factory-shell-profile-select",
              label: "Profile",
              profiles: model.nav.profiles,
            })}
            <a class="inline-flex items-center justify-center border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground" href="${workbenchViewHref}">Workbench</a>
            <a class="inline-flex items-center justify-center border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground" href="${standardHref}">Standard View</a>
            <a class="inline-flex items-center justify-center border border-primary/30 bg-background px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10" href="${newChatHref}" aria-label="Start a new chat">New Thread</a>
          </div>
        </div>
        <div id="factory-shell-metrics" class="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          ${statTiles}
        </div>
      </header>
      <div class="grid min-h-0 flex-1 gap-3 xl:grid-cols-[300px_minmax(0,1fr)_360px]">
        <aside id="factory-sidebar-shell" data-mission-control-pane="sidebar" data-pane-active="false" class="mission-control-pane min-w-0 ${missionControlPanelClass} overflow-hidden">
          <div class="factory-scrollbar max-h-[42vh] overflow-y-auto xl:h-full xl:max-h-none">
            <div id="factory-sidebar" ${liveIslandAttrs(islandBindings.sidebar)}>
              ${factorySidebarIsland(model.nav, model.inspector.selectedObjective)}
            </div>
          </div>
        </aside>
        <main class="min-w-0">
          <div class="grid gap-3">
            <section id="factory-chat-shell" data-mission-control-pane="chat" data-pane-active="false" class="mission-control-pane min-w-0 ${missionControlPanelClass} overflow-hidden">
              <div id="factory-chat-scroll" class="factory-scrollbar min-h-[360px] overflow-y-auto overscroll-contain xl:max-h-[calc(100vh-18rem)]">
                <div id="factory-chat" data-active-profile-label="${esc(model.activeProfileLabel)}" ${liveIslandAttrs(islandBindings.chat)}>
                  ${factoryChatIsland(model.chat)}
                </div>
                <div id="factory-chat-live" class="chat-stack mx-auto flex w-full max-w-[1440px] flex-col gap-3 px-3 pb-4 md:px-4 xl:px-6">
                  ${renderFactoryStreamingShell(model.activeProfileLabel, { liveMode: "js" })}
                  <div id="factory-chat-optimistic" class="space-y-2" aria-live="polite"></div>
                </div>
              </div>
            </section>
            <section id="factory-composer-shell" data-mission-control-pane="composer" data-pane-active="false" class="mission-control-pane ${missionControlPanelClass} p-3">
              <form id="factory-composer" action="/factory/compose${composerQuery}" method="post" data-composer-commands='${esc(composerCommandsJson())}'>
                <input id="factory-composer-current-job" type="hidden" name="currentJobId" value="${esc(currentJobId ?? "")}" />
                <label class="sr-only" for="factory-prompt">Factory prompt</label>
                <div class="grid gap-3 xl:grid-cols-[minmax(0,1fr)_10rem]">
                  <div class="relative">
                    <textarea id="factory-prompt" name="prompt" class="min-h-[112px] w-full resize-none border border-border/80 bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/30 focus-visible:ring-2 focus-visible:ring-ring/40" rows="3" placeholder="${esc(composerPlaceholder)}" autofocus aria-autocomplete="list" aria-expanded="false" aria-controls="factory-composer-completions" aria-haspopup="listbox"></textarea>
                    <div id="factory-composer-completions" class="hidden mt-2 max-h-56 overflow-auto border border-border bg-background shadow-lg" role="listbox" aria-label="Slash command suggestions"></div>
                  </div>
                  <button id="factory-composer-submit" class="inline-flex min-h-[112px] w-full items-center justify-center border border-primary/40 bg-primary px-6 py-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground" type="submit">Send</button>
                </div>
                <div id="factory-composer-status" class="mt-2 hidden border border-border bg-muted px-3 py-2 text-xs leading-5 text-card-foreground" aria-live="polite"></div>
              </form>
            </section>
          </div>
        </main>
        <aside id="factory-inspector-shell" data-mission-control-pane="inspector" data-pane-active="false" class="mission-control-pane min-w-0 ${missionControlPanelClass} overflow-hidden">
          <div class="factory-scrollbar max-h-[42vh] overflow-y-auto xl:h-full xl:max-h-none">
            <div id="factory-inspector" class="factory-inspector-panel" ${liveIslandAttrs(islandBindings.inspector)}>
              ${factoryInspectorIsland(model.inspector)}
            </div>
          </div>
        </aside>
      </div>
      <footer class="${missionControlPanelClass} px-4 py-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="${missionControlSectionLabelClass}">Hotkeys</div>
          <div class="flex flex-wrap gap-2">${hotkeys}</div>
        </div>
      </footer>
    </div>
  </div>
  <script src="/assets/factory-client.js?v=${CSS_VERSION}"></script>
</body>
</html>`;
};

export const factoryChatShell = (model: FactoryChatShellModel): string =>
  isMissionControlMode(model.mode)
    ? renderMissionControlShell(model)
    : renderDefaultFactoryShell(model);
