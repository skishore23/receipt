// ============================================================================
// Agent Framework UI primitives (shared coordination/context projections)
// ============================================================================

export type FrameworkPalette = "theorem" | "writer" | "neutral";

export type FrameworkMetric = {
  readonly key: string;
  readonly value: string;
};

export type FrameworkContextRow = {
  readonly step?: number;
  readonly title: string;
  readonly meta?: string;
  readonly target?: string;
  readonly content: string;
  readonly ts?: number;
};

export type FrameworkLaneRow = {
  readonly agent: string;
  readonly phase?: string;
  readonly status?: "running" | "idle" | "done" | "failed";
  readonly action?: string;
};

export type FrameworkTrailRow = {
  readonly step?: number;
  readonly kind?: string;
  readonly agent?: string;
  readonly body: string;
  readonly ts?: number;
};

export type FrameworkCoordinationModel = {
  readonly palette?: FrameworkPalette;
  readonly metricsTitle?: string;
  readonly clockLabel?: string;
  readonly metrics?: ReadonlyArray<FrameworkMetric>;
  readonly contextTitle: string;
  readonly contextSubtitle?: string;
  readonly contextNote?: string;
  readonly contextRows: ReadonlyArray<FrameworkContextRow>;
  readonly boardTitle: string;
  readonly boardSubtitle?: string;
  readonly lanes: ReadonlyArray<FrameworkLaneRow>;
  readonly trail: ReadonlyArray<FrameworkTrailRow>;
};

export const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 3)}...`;

const paletteVars = (palette: FrameworkPalette): string => {
  if (palette === "theorem") return "--fw-accent: 107,220,255; --fw-accent-2: 255,211,106;";
  if (palette === "writer") return "--fw-accent: 255,204,128; --fw-accent-2: 141,220,255;";
  return "--fw-accent: 130,180,255; --fw-accent-2: 180,210,255;";
};

const statusClass = (status?: string): string => {
  if (status === "running") return "running";
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  return "idle";
};

const kindClass = (kind?: string): string =>
  kind ? `fw-kind-${kind.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}` : "";

export const frameworkCoordinationHtml = (model: FrameworkCoordinationModel): string => {
  const metrics = model.metrics ?? [];
  const contextRows = model.contextRows;
  const trailRows = model.trail;
  const laneRows = model.lanes;
  const vars = paletteVars(model.palette ?? "neutral");
  const showSummary = metrics.length > 0;

  const summaryHtml = showSummary
    ? `<section class="fw-summary">
      <div class="fw-summary-head">
        <div class="fw-summary-title">${esc(model.metricsTitle ?? "Coordination status")}</div>
        ${model.clockLabel ? `<div class="fw-summary-meta">${esc(model.clockLabel)}</div>` : ""}
      </div>
      <div class="fw-summary-grid">
        ${metrics.map((metric) => `<div class="fw-pill"><span class="fw-key">${esc(metric.key)}</span><span class="fw-val">${esc(metric.value)}</span></div>`).join("")}
      </div>
    </section>`
    : "";

  const contextHtml = contextRows.length
    ? contextRows.map((row, idx) => {
      const step = row.step ?? (contextRows.length - idx);
      const when = row.ts ? new Date(row.ts).toLocaleTimeString() : "";
      return `<div class="fw-context-row">
        <div class="fw-context-step">${step}</div>
        <div class="fw-context-main">
          <div class="fw-context-top">
            <div class="fw-context-title">${esc(row.title)}</div>
            ${when ? `<div class="fw-context-when">${esc(when)}</div>` : ""}
          </div>
          ${row.meta ? `<div class="fw-context-meta">${esc(row.meta)}</div>` : ""}
          ${row.target ? `<div class="fw-context-target">${esc(row.target)}</div>` : ""}
          <div class="fw-context-body">${esc(truncate(row.content || "No prompt content.", 420))}</div>
        </div>
      </div>`;
    }).join("")
    : `<div class="empty">No context snapshots yet.</div>`;

  const lanesHtml = laneRows.length
    ? laneRows.map((lane) => {
      const status = statusClass(lane.status);
      return `<div class="fw-lane-row ${status}">
        <div class="fw-lane-main">
          <div class="fw-lane-agent">${esc(lane.agent)}</div>
          <div class="fw-lane-phase">${esc(lane.phase ?? "Waiting")}</div>
        </div>
        <div class="fw-lane-status ${status}">${esc(status)}</div>
        <div class="fw-lane-action">${esc(truncate(lane.action ?? "Waiting for assignment.", 180))}</div>
      </div>`;
    }).join("")
    : `<div class="empty">No active agents yet.</div>`;

  const trailHtml = trailRows.length
    ? trailRows.map((trail, idx) => {
      const step = trail.step ?? (trailRows.length - idx);
      const when = trail.ts ? new Date(trail.ts).toLocaleTimeString() : "";
      return `<div class="fw-trail-row ${kindClass(trail.kind)}">
        <div class="fw-trail-step">S${step}</div>
        <div class="fw-trail-main">
          <div class="fw-trail-top">
            <div class="fw-trail-agent">${esc(trail.agent ?? "System")}</div>
            ${when ? `<div class="fw-trail-time">${esc(when)}</div>` : ""}
          </div>
          <div class="fw-trail-body">${esc(trail.body)}</div>
        </div>
      </div>`;
    }).join("")
    : `<div class="empty">No coordination trail yet.</div>`;

  return `<div class="fw-root" style="${vars}">
    ${summaryHtml}
    <section class="fw-context">
      <div class="fw-head">${esc(model.contextTitle)}</div>
      ${model.contextSubtitle ? `<div class="fw-sub">${esc(model.contextSubtitle)}</div>` : ""}
      <div class="fw-context-list">${contextHtml}</div>
      ${model.contextNote ? `<div class="fw-note">${esc(model.contextNote)}</div>` : ""}
    </section>
    <section class="fw-board">
      <div class="fw-head">${esc(model.boardTitle)}</div>
      ${model.boardSubtitle ? `<div class="fw-sub">${esc(model.boardSubtitle)}</div>` : ""}
      <div class="fw-lane-list">${lanesHtml}</div>
      <div class="fw-trail-list">${trailHtml}</div>
    </section>
  </div>
  <style>
    .fw-root { display: grid; gap: 12px; }
    .fw-summary {
      border-radius: 14px;
      border: 1px solid rgba(var(--fw-accent-2), 0.35);
      background: linear-gradient(130deg, rgba(var(--fw-accent-2), 0.12), rgba(var(--fw-accent), 0.08));
      padding: 12px 14px;
      display: grid;
      gap: 10px;
    }
    .fw-summary-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .fw-summary-title { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
    .fw-summary-meta { font-size: 11px; color: rgba(255,255,255,0.62); }
    .fw-summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .fw-pill {
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(15,17,24,0.62);
      padding: 7px 9px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .fw-key { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(255,255,255,0.55); }
    .fw-val {
      font-size: 11px;
      color: rgba(255,255,255,0.9);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fw-context,
    .fw-board { display: grid; gap: 10px; }
    .fw-head {
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.55);
    }
    .fw-sub { font-size: 12px; color: rgba(255,255,255,0.68); line-height: 1.45; }
    .fw-note { font-size: 11px; color: rgba(255,255,255,0.5); }
    .fw-context-list { display: grid; gap: 10px; }
    .fw-context-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(18,20,28,0.7);
      padding: 10px 12px;
    }
    .fw-context-step {
      width: 24px;
      height: 24px;
      border-radius: 999px;
      border: 1px solid rgba(var(--fw-accent), 0.35);
      background: rgba(var(--fw-accent), 0.1);
      color: rgba(var(--fw-accent), 0.95);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
    }
    .fw-context-main { display: grid; gap: 4px; min-width: 0; }
    .fw-context-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .fw-context-title { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.92); }
    .fw-context-when { font-size: 10px; color: rgba(255,255,255,0.5); }
    .fw-context-meta { font-size: 10px; color: rgba(255,255,255,0.55); }
    .fw-context-target { font-size: 10px; color: rgba(255,255,255,0.65); }
    .fw-context-body {
      font-family: "IBM Plex Mono", monospace;
      font-size: 11px;
      line-height: 1.45;
      color: rgba(255,255,255,0.84);
      white-space: pre-wrap;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(12,14,18,0.7);
      padding: 8px;
    }
    .fw-lane-list { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    .fw-lane-row {
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(18,20,28,0.65);
      padding: 10px 12px;
      display: grid;
      gap: 6px;
    }
    .fw-lane-row.running { border-color: rgba(var(--fw-accent), 0.45); }
    .fw-lane-row.done { border-color: rgba(110,243,160,0.35); }
    .fw-lane-row.failed { border-color: rgba(255,107,107,0.35); }
    .fw-lane-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .fw-lane-agent { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.92); }
    .fw-lane-phase { font-size: 11px; color: rgba(255,255,255,0.6); }
    .fw-lane-status {
      width: fit-content;
      font-size: 9px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.2);
      padding: 3px 8px;
      color: rgba(255,255,255,0.75);
      background: rgba(255,255,255,0.06);
    }
    .fw-lane-status.running {
      border-color: rgba(var(--fw-accent), 0.5);
      color: rgba(var(--fw-accent), 0.95);
      background: rgba(var(--fw-accent), 0.12);
    }
    .fw-lane-status.done {
      border-color: rgba(110,243,160,0.5);
      color: rgba(110,243,160,0.95);
      background: rgba(110,243,160,0.12);
    }
    .fw-lane-status.failed {
      border-color: rgba(255,107,107,0.5);
      color: rgba(255,107,107,0.95);
      background: rgba(255,107,107,0.12);
    }
    .fw-lane-action { font-size: 12px; color: rgba(255,255,255,0.82); line-height: 1.4; }
    .fw-trail-list { display: grid; gap: 8px; }
    .fw-trail-row {
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.6);
      padding: 8px 10px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
    }
    .fw-kind-attempt { border-color: rgba(var(--fw-accent), 0.35); }
    .fw-kind-lemma { border-color: rgba(110,243,160,0.3); }
    .fw-kind-critique { border-color: rgba(255,107,107,0.35); }
    .fw-kind-patch { border-color: rgba(195,139,255,0.35); }
    .fw-kind-branch, .fw-kind-parallel, .fw-kind-status { border-color: rgba(var(--fw-accent-2), 0.35); }
    .fw-kind-summary, .fw-kind-final { border-color: rgba(var(--fw-accent), 0.45); }
    .fw-trail-step {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.18);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: rgba(255,255,255,0.72);
      background: rgba(255,255,255,0.05);
    }
    .fw-trail-main { display: grid; gap: 2px; min-width: 0; }
    .fw-trail-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .fw-trail-agent { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.82); }
    .fw-trail-time { font-size: 10px; color: rgba(255,255,255,0.52); }
    .fw-trail-body { font-size: 12px; color: rgba(255,255,255,0.86); line-height: 1.4; }
  </style>`;
};
