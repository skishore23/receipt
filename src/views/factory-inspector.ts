import { esc, sectionLabelClass, softPanelClass, badge, statPill, formatTs, shortHash, ghostButtonClass, dangerButtonClass } from "./ui";
import type {
  FactoryInspectorModel,
  FactoryInspectorRouteModel,
  FactoryInspectorTabsModel,
} from "./factory-models";

const formatBytes = (bytes: number | undefined): string => {
  if (!Number.isFinite(bytes) || !bytes || bytes < 1024) return `${Math.max(0, Math.floor(bytes ?? 0))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

type FactoryInspectorIslandOptions = {
  readonly tabsPath?: string;
  readonly panelPath?: string;
  readonly selectPath?: string;
  readonly tabsTrigger?: string;
  readonly panelTrigger?: string;
  readonly panelOob?: boolean;
};

const inspectorQuery = (model: FactoryInspectorRouteModel, extra?: {
  readonly panel?: FactoryInspectorRouteModel["panel"];
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly jobId?: string;
}): string => {
  const params = new URLSearchParams();
  params.set("profile", model.activeProfileId);
  if (model.chatId) params.set("chat", model.chatId);
  if (model.objectiveId) params.set("thread", model.objectiveId);
  if (model.runId) params.set("run", model.runId);
  if (extra?.jobId ?? model.jobId) params.set("job", extra?.jobId ?? model.jobId!);
  if (extra?.panel ?? model.panel) params.set("panel", extra?.panel ?? model.panel);
  if (extra?.focusKind ?? model.focusKind) params.set("focusKind", extra?.focusKind ?? model.focusKind!);
  if (extra?.focusId ?? model.focusId) params.set("focusId", extra?.focusId ?? model.focusId!);
  const query = params.toString();
  return query ? `?${query}` : "";
};

const renderFocusedArtifacts = (model: FactoryInspectorModel): string => {
  const task = model.workbench?.focusedTask;
  if (!task) return "";
  const artifacts = [
    ["Manifest", task.manifestPath],
    ["Context", task.contextPackPath],
    ["Prompt", task.promptPath],
    ["Memory", task.memoryScriptPath],
    ["Stdout", task.stdoutPath],
    ["Stderr", task.stderrPath],
    ["Last Message", task.lastMessagePath],
  ].flatMap(([label, value]) => value ? [[label, value] as const] : []);
  const packetFiles = artifacts.length > 0
    ? `<details class="rounded-lg border border-border bg-muted px-2.5 py-2">
    <summary class="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Packet Files</summary>
    <div class="mt-2 space-y-2">
      ${artifacts.map(([label, value]) => `<div class="rounded-md border border-border bg-background px-2 py-1.5">
        <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">${esc(label)}</div>
        <code class="mt-1 block text-[11px] leading-5 text-foreground [overflow-wrap:anywhere]">${esc(value)}</code>
      </div>`).join("")}
    </div>
  </details>`
    : "";
  const extraArtifacts = task.artifactActivity?.length
    ? `<details class="rounded-lg border border-border bg-muted px-2.5 py-2">
    <summary class="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Task Artifacts</summary>
    <div class="mt-2 space-y-2">
      ${task.artifactActivity.map((artifact) => `<div class="rounded-md border border-border bg-background px-2 py-1.5">
        <div class="flex items-center justify-between gap-2">
          <div class="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">${esc(artifact.label)}</div>
          <div class="text-[10px] text-muted-foreground">${esc(formatBytes(artifact.bytes))}</div>
        </div>
        <div class="mt-1 text-[10px] text-muted-foreground">${esc(formatTs(artifact.updatedAt))}</div>
        <code class="mt-1 block text-[11px] leading-5 text-foreground [overflow-wrap:anywhere]">${esc(artifact.path)}</code>
      </div>`).join("")}
    </div>
  </details>`
    : "";
  if (!packetFiles && !extraArtifacts) return "";
  return [packetFiles, extraArtifacts].filter(Boolean).join("");
};

const renderMissingObjectivePanel = (model: FactoryInspectorModel): string => {
  const objectiveId = model.objectiveId?.trim();
  return `<div class="space-y-3 px-3 py-3 md:px-4 text-sm">
    <div class="rounded-lg border border-warning/20 bg-warning/5 px-3 py-3 text-warning">Objective not found.</div>
    <div class="text-muted-foreground">The current thread URL points to Factory data that no longer exists${objectiveId ? `: ${esc(objectiveId)}` : "."}</div>
  </div>`;
};

const renderFocusedOutput = (model: FactoryInspectorModel, heading: string): string => {
  const focus = model.workbench?.focus;
  if (!focus) return "";
  return `<div class="space-y-2">
    <div class="${sectionLabelClass} mb-2">${esc(heading)}</div>
    <div class="${softPanelClass} p-3 flex flex-col gap-2">
      <div class="flex justify-between items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="font-semibold text-sm text-foreground">${esc(focus.title)}</div>
          <div class="mt-1 text-[11px] text-muted-foreground">${esc(focus.focusKind === "job" ? `Job ${focus.focusId}` : `Task ${focus.focusId}`)}</div>
        </div>
        ${badge(focus.status)}
      </div>
      ${focus.summary ? `<div class="text-xs text-foreground">${esc(focus.summary)}</div>` : ''}
      ${focus.artifactSummary ? `<div class="text-[11px] text-muted-foreground">${esc(focus.artifactSummary)}</div>` : ''}
      ${focus.lastMessage ? `<pre class="mt-1 text-[10px] p-2 bg-background border border-border rounded text-muted-foreground overflow-x-auto">${esc(focus.lastMessage)}</pre>` : ''}
      ${focus.stdoutTail ? `<pre class="mt-1 text-[10px] p-2 bg-background border border-border rounded text-muted-foreground overflow-x-auto">${esc(focus.stdoutTail)}</pre>` : ''}
      ${focus.stderrTail ? `<pre class="mt-1 text-[10px] p-2 bg-destructive/10 border border-destructive/20 rounded text-destructive overflow-x-auto">${esc(focus.stderrTail)}</pre>` : ''}
    </div>
    ${renderFocusedArtifacts(model)}
  </div>`;
};

const renderOverviewPanel = (model: FactoryInspectorModel): string => {
  if (model.objectiveMissing) return renderMissingObjectivePanel(model);
  const obj = model.selectedObjective;
  const workbench = model.workbench;
  const focusedTask = workbench?.focusedTask;
  const focus = workbench?.focus;
  if (!obj) {
    return `<div class="space-y-3 px-3 py-3 md:px-4 text-muted-foreground text-sm">No objective selected.</div>`;
  }
  
  return `<div class="space-y-4 px-3 py-4 md:px-4">
    <div class="flex flex-col gap-2">
      <div class="text-lg font-semibold text-foreground">${esc(obj.title)}</div>
      <div class="text-sm text-muted-foreground">${esc(obj.objectiveId)}</div>
      <div class="flex flex-wrap gap-2 mt-1">
        ${badge(obj.status)}
        ${obj.phase !== obj.status ? badge(obj.phase) : ''}
        ${obj.integrationStatus ? badge(obj.integrationStatus) : ''}
      </div>
    </div>
    
    ${obj.summary ? `
    <div class="text-sm text-foreground leading-relaxed">
      ${esc(obj.summary)}
    </div>` : ''}

    <div class="grid grid-cols-2 gap-3">
      ${statPill("Slot State", obj.slotState + (obj.queuePosition ? ` (q${obj.queuePosition})` : ''))}
      ${statPill("Tasks", `${obj.activeTaskCount ?? 0} active / ${obj.readyTaskCount ?? 0} ready / ${obj.taskCount ?? 0} total`)}
      ${statPill("Head Commit", shortHash(obj.latestCommitHash) || "None")}
      ${statPill("Checks", obj.checks?.length ? `${obj.checks.length} checks` : "None")}
      ${obj.tokensUsed ? statPill("Codex Tokens", obj.tokensUsed.toLocaleString()) : ''}
    </div>

    ${obj.nextAction ? `
    <div class="flex flex-col gap-1.5 pt-2">
      <div class="${sectionLabelClass}">Next Action</div>
      <div class="text-sm text-muted-foreground">${esc(obj.nextAction)}</div>
    </div>` : ''}

    ${obj.blockedReason ? `
    <div class="flex flex-col gap-1.5 pt-2">
      <div class="${sectionLabelClass}">Blocked Reason</div>
      <div class="text-sm text-warning">${esc(obj.blockedReason)}</div>
      ${obj.blockedExplanation ? `<div class="text-xs text-muted-foreground mt-1">${esc(obj.blockedExplanation)}</div>` : ''}
    </div>` : ''}
    
    ${obj.latestDecisionSummary ? `
    <div class="flex flex-col gap-1.5 pt-2 border-t border-border">
      <div class="${sectionLabelClass}">Latest Decision</div>
      <div class="text-sm text-muted-foreground">${esc(obj.latestDecisionSummary)}</div>
    </div>` : ''}

    ${workbench?.hasActiveExecution && focus ? `
    <div class="flex flex-col gap-2 pt-3 mt-1 border-t border-border">
      <div class="${sectionLabelClass}">Focused Execution</div>
      <div class="${softPanelClass} p-3 flex flex-col gap-2">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold text-foreground">${esc(focus.title)}</div>
            <div class="mt-1 text-[11px] text-muted-foreground">${esc(focus.focusKind === "job" ? `Job ${focus.focusId}` : `Task ${focus.focusId}`)}</div>
          </div>
          ${badge(focus.status)}
        </div>
        ${focus.summary ? `<div class="text-xs text-foreground">${esc(focus.summary)}</div>` : ''}
        ${focus.artifactSummary ? `<div class="text-[11px] text-muted-foreground">${esc(focus.artifactSummary)}</div>` : ''}
        ${focusedTask ? `<div class="rounded-lg border border-border bg-background px-2.5 py-2">
          <div class="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Task Prompt</div>
          <pre class="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-foreground [overflow-wrap:anywhere]">${esc(focusedTask.prompt)}</pre>
        </div>` : ''}
        ${focusedTask ? `<div class="grid grid-cols-2 gap-2">
          ${statPill("Workspace", focusedTask.workspaceExists ? (focusedTask.workspaceDirty ? "Dirty" : "Clean") : "Missing")}
          ${statPill("Candidate", focusedTask.candidateId ?? "None")}
        </div>` : ''}
        ${renderFocusedArtifacts(model)}
      </div>
    </div>` : ''}

    <div class="flex flex-col gap-2 pt-3 mt-1 border-t border-border">
      <div class="${sectionLabelClass}">Quick Actions</div>
      <div class="flex flex-wrap gap-2">
        <button onclick="document.getElementById('factory-prompt').value = '/react '; document.getElementById('factory-prompt').focus();" class="${ghostButtonClass} !py-1 !px-2.5 !text-[10px]">React</button>
        ${['failed', 'canceled'].includes(obj.status) ? `<button onclick="document.getElementById('factory-prompt').value = '/resume '; document.getElementById('factory-prompt').focus();" class="${ghostButtonClass} !py-1 !px-2.5 !text-[10px]">Resume</button>` : ''}
        ${!['completed', 'failed', 'canceled'].includes(obj.status) ? `<button onclick="document.getElementById('factory-prompt').value = '/cancel '; document.getElementById('factory-prompt').focus();" class="${dangerButtonClass} !py-1 !px-2.5 !text-[10px]">Cancel</button>` : ''}
        ${['completed', 'failed', 'canceled'].includes(obj.status) ? `<button onclick="document.getElementById('factory-prompt').value = '/archive '; document.getElementById('factory-prompt').focus();" class="${ghostButtonClass} !py-1 !px-2.5 !text-[10px]">Archive</button>` : ''}
      </div>
    </div>

    ${model.activeCodex ? `
    <div class="flex flex-col gap-2 pt-3 mt-1 border-t border-border">
      <div class="${sectionLabelClass} flex justify-between items-center">
        <span>Active Codex</span>
        <button hx-get="/factory/island/inspector${inspectorQuery(model, { panel: 'live' })}" hx-target="#factory-inspector" hx-swap="innerHTML" class="text-[10px] text-primary hover:underline lowercase tracking-normal font-medium">View all live output &rarr;</button>
      </div>
      <div class="${softPanelClass} p-3 flex flex-col gap-2">
        <div class="text-xs text-foreground">${esc(model.activeCodex.summary)}</div>
        ${model.activeCodex.latestNote ? `<div class="text-xs text-muted-foreground mt-1">${esc(model.activeCodex.latestNote)}</div>` : ''}
        ${model.activeCodex.stdoutTail ? `<pre class="mt-2 text-[10px] p-2 bg-background border border-border rounded text-muted-foreground overflow-x-auto factory-scrollbar">${esc(model.activeCodex.stdoutTail)}</pre>` : ''}
        ${model.activeCodex.stderrTail ? `<pre class="mt-1 text-[10px] p-2 bg-destructive/10 border border-destructive/20 rounded text-destructive overflow-x-auto factory-scrollbar">${esc(model.activeCodex.stderrTail)}</pre>` : ''}
      </div>
    </div>` : ''}
  </div>`;
};

const renderExecutionPanel = (model: FactoryInspectorModel): string => {
  if (model.objectiveMissing) return renderMissingObjectivePanel(model);
  const tasks = model.workbench?.tasks ?? model.tasks;
  if (!tasks || tasks.length === 0) {
    return `<div class="space-y-3 px-3 py-3 md:px-4 text-sm text-muted-foreground">No tasks defined yet.</div>`;
  }
  
  return `<div class="space-y-3 px-3 py-3 md:px-4">
    ${renderFocusedOutput(model, "Focused Output")}
    <div class="${sectionLabelClass} mb-2">Execution Graph</div>
    <div class="space-y-2">
      ${tasks.map((task, idx) => {
        const candidateTokensUsed = "candidateTokensUsed" in task
          ? task.candidateTokensUsed
          : ("candidate" in task ? task.candidate?.tokensUsed : undefined);
        return `
        <a href="/factory${inspectorQuery(model, { focusKind: 'task', focusId: task.taskId })}" class="block ${softPanelClass} p-3 flex flex-col gap-1.5 relative transition hover:bg-accent">
          <div class="absolute -left-2.5 top-5 bottom-0 border-l border-border/50 ${idx === tasks.length - 1 ? 'hidden' : ''}"></div>
          
          <div class="flex items-center justify-between gap-2 relative">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-background border border-border text-[8px] font-bold text-muted-foreground z-10">${idx + 1}</span>
              <span class="text-xs font-semibold text-foreground truncate">${esc(task.title)}</span>
            </div>
            ${badge(task.status)}
          </div>
          
          <div class="pl-5 flex flex-col gap-1">
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">${esc(task.workerType)}</span>
              ${task.taskKind !== 'planned' ? `<span class="text-[10px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded">${esc(task.taskKind)}</span>` : ''}
              ${candidateTokensUsed ? `<span class="text-[10px] text-muted-foreground font-mono bg-background px-1 border border-border rounded">${candidateTokensUsed.toLocaleString()} tokens</span>` : ''}
            </div>
            
            ${task.prompt ? `<div class="text-xs text-muted-foreground line-clamp-2 mt-0.5">${esc(task.prompt)}</div>` : ''}
            ${"dependencySummary" in task && task.dependencySummary ? `<div class="text-xs text-muted-foreground mt-0.5">${esc(task.dependencySummary)}</div>` : ''}
            
            ${task.latestSummary ? `<div class="text-xs text-info/90 mt-1">${esc(task.latestSummary)}</div>` : ''}
            
            ${task.blockedReason ? `<div class="text-xs text-warning mt-1">${esc(task.blockedReason)}</div>` : ''}
          </div>
        </a>
      `;}).join('')}
    </div>
  </div>`;
};

const renderLivePanel = (model: FactoryInspectorModel): string => {
  if (model.objectiveMissing) return renderMissingObjectivePanel(model);
  if (model.workbench?.focus) {
    return `<div class="space-y-3 px-3 py-3 md:px-4">
      ${renderFocusedOutput(model, "Focused Live Output")}
      ${model.workbench.jobs.length ? `<div class="space-y-2">
        <div class="${sectionLabelClass}">Recent Jobs</div>
        ${model.workbench.jobs.map((job) => `<a href="/factory${inspectorQuery(model, { focusKind: 'job', focusId: job.jobId, jobId: job.jobId })}" class="block ${softPanelClass} p-3 transition hover:bg-accent">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-semibold text-foreground">${esc(job.agentId)}</div>
              <div class="mt-1 text-xs text-muted-foreground">${esc(job.summary)}</div>
            </div>
            ${badge(job.status)}
          </div>
        </a>`).join("")}
      </div>` : ""}
    </div>`;
  }
  if (!model.activeCodex && (!model.liveChildren || model.liveChildren.length === 0)) {
    return `<div class="space-y-3 px-3 py-3 md:px-4 text-sm text-muted-foreground">No live execution currently running.</div>`;
  }

  const cards: string[] = [];
  if (model.activeCodex) {
    cards.push(`
      <div class="${softPanelClass} p-3 flex flex-col gap-2">
        <div class="flex justify-between items-start">
          <div class="font-semibold text-sm text-foreground">Active Codex</div>
          ${badge(model.activeCodex.status)}
        </div>
        <div class="text-xs text-foreground">${esc(model.activeCodex.summary)}</div>
        ${model.activeCodex.latestNote ? `<div class="text-xs text-muted-foreground mt-1">${esc(model.activeCodex.latestNote)}</div>` : ''}
        ${model.activeCodex.stdoutTail ? `<pre class="mt-2 text-[10px] p-2 bg-background border border-border rounded text-muted-foreground overflow-x-auto">${esc(model.activeCodex.stdoutTail)}</pre>` : ''}
        ${model.activeCodex.stderrTail ? `<pre class="mt-1 text-[10px] p-2 bg-destructive/10 border border-destructive/20 rounded text-destructive overflow-x-auto">${esc(model.activeCodex.stderrTail)}</pre>` : ''}
      </div>
    `);
  }
  
  if (model.liveChildren && model.liveChildren.length > 0) {
    for (const child of model.liveChildren) {
      cards.push(`
        <div class="${softPanelClass} p-3 flex flex-col gap-2">
          <div class="flex justify-between items-start">
            <div class="font-semibold text-sm text-foreground">${esc(child.worker)} Worker</div>
            ${badge(child.status)}
          </div>
          <div class="text-xs text-foreground">${esc(child.summary)}</div>
          ${child.latestNote ? `<div class="text-xs text-muted-foreground mt-1">${esc(child.latestNote)}</div>` : ''}
          ${child.stdoutTail ? `<pre class="mt-2 text-[10px] p-2 bg-background border border-border rounded text-muted-foreground overflow-x-auto">${esc(child.stdoutTail)}</pre>` : ''}
          ${child.stderrTail ? `<pre class="mt-1 text-[10px] p-2 bg-destructive/10 border border-destructive/20 rounded text-destructive overflow-x-auto">${esc(child.stderrTail)}</pre>` : ''}
        </div>
      `);
    }
  }

  return `<div class="space-y-3 px-3 py-3 md:px-4">
    <div class="${sectionLabelClass} mb-2">Live Output</div>
    ${cards.join('\n')}
  </div>`;
};

const renderReceiptsPanel = (model: FactoryInspectorModel): string => {
  if (model.objectiveMissing) return renderMissingObjectivePanel(model);
  if (!model.receipts || model.receipts.length === 0) {
    return `<div class="space-y-3 px-3 py-3 md:px-4 text-sm text-muted-foreground">No receipts found.</div>`;
  }
  return `<div class="space-y-2 px-3 py-3 md:px-4">
    ${model.receipts.map(r => `
      <div class="${softPanelClass} p-3 flex flex-col gap-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold text-foreground break-all">${esc(r.type)}</span>
          <span class="text-[10px] text-muted-foreground">${formatTs(r.ts)}</span>
        </div>
        <div class="text-xs text-foreground">${esc(r.summary)}</div>
        <div class="flex items-center gap-2 mt-1">
          <span class="text-[10px] text-muted-foreground font-mono bg-background px-1.5 py-0.5 rounded border border-border">${shortHash(r.hash)}</span>
          ${r.taskId ? `<span class="text-[10px] text-primary/80 font-medium">Task: ${esc(r.taskId)}</span>` : ''}
          ${r.candidateId ? `<span class="text-[10px] text-info/80 font-medium">Candidate: ${esc(r.candidateId)}</span>` : ''}
        </div>
      </div>
    `).join('')}
  </div>`;
};

const renderDebugPanel = (model: FactoryInspectorModel): string => {
  if (model.objectiveMissing) return renderMissingObjectivePanel(model);
  if (!model.debugInfo) {
    return `<div class="space-y-3 px-3 py-3 md:px-4 text-sm text-muted-foreground">No debug info available.</div>`;
  }
  return `<div class="space-y-3 px-3 py-3 md:px-4">
    <pre class="text-[11px] leading-5 p-3 rounded-lg border border-border bg-background text-foreground overflow-auto max-h-[70vh] font-mono shadow-inner">${esc(JSON.stringify(model.debugInfo, null, 2))}</pre>
  </div>`;
};

const renderInspectorTabs = (model: FactoryInspectorTabsModel, options?: FactoryInspectorIslandOptions): string => {
  const tabs: ReadonlyArray<{ readonly id: FactoryInspectorRouteModel["panel"]; readonly label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "execution", label: "Tasks" },
    { id: "live", label: "Live Output" },
    { id: "receipts", label: "Receipts" },
    { id: "debug", label: "Debug" }
  ];
  const tabsPath = options?.tabsPath ?? "/factory/island/inspector/tabs";
  const selectPath = options?.selectPath ?? "/factory/island/inspector/select";
  const triggerAttrs = options?.tabsTrigger
    ? ` hx-get="${tabsPath}${inspectorQuery(model)}" hx-trigger="${esc(options.tabsTrigger)}" hx-swap="outerHTML"`
    : "";

  return `<div id="factory-inspector-tabs" class="flex items-center gap-1.5 border-b border-border px-3 py-2.5 overflow-x-auto factory-scrollbar bg-card sticky top-0 z-10"${triggerAttrs}>
    ${tabs.map(t => {
      const active = model.panel === t.id;
      return `<button 
        type="button"
        hx-get="${selectPath}${inspectorQuery(model, { panel: t.id })}" 
        hx-target="#factory-inspector-tabs" 
        hx-swap="outerHTML"
        class="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.15em] transition rounded-md whitespace-nowrap ${active ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground border border-transparent hover:bg-muted hover:text-foreground'}"
      >${esc(t.label)}</button>`;
    }).join('')}
  </div>`;
};

const renderInspectorPanel = (model: FactoryInspectorModel): string => {
  let content = "";
  switch (model.panel) {
    case "overview": content = renderOverviewPanel(model); break;
    case "execution": content = renderExecutionPanel(model); break;
    case "live": content = renderLivePanel(model); break;
    case "receipts": content = renderReceiptsPanel(model); break;
    case "debug": content = renderDebugPanel(model); break;
    default: {
      const exhaustiveCheck: never = model.panel;
      throw new Error(`Unhandled panel type: ${exhaustiveCheck}`);
    }
  }
  return content;
};

export const factoryInspectorTabsIsland = (
  model: FactoryInspectorTabsModel,
  options?: FactoryInspectorIslandOptions,
): string => renderInspectorTabs(model, options);

export const factoryInspectorPanelIsland = (
  model: FactoryInspectorModel,
  options?: FactoryInspectorIslandOptions,
): string => {
  const panelPath = options?.panelPath ?? "/factory/island/inspector/panel";
  const triggerAttrs = options?.panelTrigger
    ? ` hx-get="${panelPath}${inspectorQuery(model)}" hx-trigger="${esc(options.panelTrigger)}" hx-swap="outerHTML"`
    : "";
  const oobAttr = options?.panelOob ? ` hx-swap-oob="outerHTML"` : "";
  return `<div id="factory-inspector-panel" class="min-h-0"${triggerAttrs}${oobAttr}>${renderInspectorPanel(model)}</div>`;
};

export const factoryInspectorSelectionIsland = (
  model: FactoryInspectorModel,
  options?: FactoryInspectorIslandOptions,
): string =>
  factoryInspectorTabsIsland(model, options)
  + factoryInspectorPanelIsland(model, { ...options, panelOob: true });

export const factoryInspectorIsland = (
  model: FactoryInspectorModel,
  options?: FactoryInspectorIslandOptions,
): string =>
  factoryInspectorTabsIsland(model, options)
  + factoryInspectorPanelIsland(model, options);
