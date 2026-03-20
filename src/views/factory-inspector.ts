import { esc, sectionLabelClass, softPanelClass, badge, statPill, formatTs, shortHash, ghostButtonClass, dangerButtonClass } from "./ui.js";
import type { FactoryInspectorModel } from "./factory-models.js";

const renderOverviewPanel = (model: FactoryInspectorModel): string => {
  const obj = model.selectedObjective;
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

    <div class="flex flex-col gap-2 pt-3 mt-1 border-t border-border">
      <div class="${sectionLabelClass}">Quick Actions</div>
      <div class="flex flex-wrap gap-2">
        <button onclick="document.getElementById('factory-prompt').value = '/steer '; document.getElementById('factory-prompt').focus();" class="${ghostButtonClass} !py-1 !px-2.5 !text-[10px]">Steer</button>
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
        <button hx-get="/factory/island/inspector?panel=live&thread=${encodeURIComponent(obj.objectiveId)}" hx-target="#factory-inspector" hx-swap="innerHTML" class="text-[10px] text-primary hover:underline lowercase tracking-normal font-medium">View all live output &rarr;</button>
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
  if (!model.tasks || model.tasks.length === 0) {
    return `<div class="space-y-3 px-3 py-3 md:px-4 text-sm text-muted-foreground">No tasks defined yet.</div>`;
  }
  
  return `<div class="space-y-3 px-3 py-3 md:px-4">
    <div class="${sectionLabelClass} mb-2">Execution Graph</div>
    <div class="space-y-2">
      ${model.tasks.map((task, idx) => `
        <div class="${softPanelClass} p-3 flex flex-col gap-1.5 relative">
          <div class="absolute -left-2.5 top-5 bottom-0 border-l border-border/50 ${idx === model.tasks!.length - 1 ? 'hidden' : ''}"></div>
          
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
              ${task.candidate?.tokensUsed ? `<span class="text-[10px] text-muted-foreground font-mono bg-background px-1 border border-border rounded">${task.candidate.tokensUsed.toLocaleString()} tokens</span>` : ''}
            </div>
            
            ${task.prompt ? `<div class="text-xs text-muted-foreground line-clamp-2 mt-0.5">${esc(task.prompt)}</div>` : ''}
            
            ${task.latestSummary ? `<div class="text-xs text-info/90 mt-1">${esc(task.latestSummary)}</div>` : ''}
            
            ${task.blockedReason ? `<div class="text-xs text-warning mt-1">${esc(task.blockedReason)}</div>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  </div>`;
};

const renderLivePanel = (model: FactoryInspectorModel): string => {
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
  if (!model.debugInfo) {
    return `<div class="space-y-3 px-3 py-3 md:px-4 text-sm text-muted-foreground">No debug info available.</div>`;
  }
  return `<div class="space-y-3 px-3 py-3 md:px-4">
    <pre class="text-[11px] leading-5 p-3 rounded-lg border border-border bg-background text-foreground overflow-auto max-h-[70vh] font-mono shadow-inner">${esc(JSON.stringify(model.debugInfo, null, 2))}</pre>
  </div>`;
};

const renderInspectorTabs = (model: FactoryInspectorModel): string => {
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "execution", label: "Tasks" },
    { id: "live", label: "Live Output" },
    { id: "receipts", label: "Receipts" },
    { id: "debug", label: "Debug" }
  ];
  
  const objId = model.selectedObjective?.objectiveId;
  const threadParam = objId ? `&thread=${encodeURIComponent(objId)}` : "";
  
  return `<div class="flex items-center gap-1.5 border-b border-border px-3 py-2.5 overflow-x-auto factory-scrollbar bg-card sticky top-0 z-10">
    ${tabs.map(t => {
      const active = model.panel === t.id;
      return `<button 
        hx-get="/factory/island/inspector?panel=${t.id}${threadParam}" 
        hx-target="#factory-inspector" 
        hx-swap="innerHTML"
        class="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.15em] transition rounded-md whitespace-nowrap ${active ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground border border-transparent hover:bg-muted hover:text-foreground'}"
      >${esc(t.label)}</button>`;
    }).join('')}
  </div>`;
};

export const factoryInspectorIsland = (model: FactoryInspectorModel): string => {
  const tabs = renderInspectorTabs(model);
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
  return tabs + content;
};
