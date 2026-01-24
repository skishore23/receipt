// ============================================================================
// HTML Views — Functors from Chain → HTML
// 
// Each view is a pure function that transforms chain/state into HTML.
// Views compose. The UI is just a composition of views.
// ============================================================================

import type { Chain, View, Branch } from "../core/types.js";
import type { TodoEvent, TodoState } from "../modules/todo.js";
import { fold, verify, stateView } from "../core/chain.js";
import { reduce, initial } from "../modules/todo.js";

// ============================================================================
// Escape (security)
// ============================================================================

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const short = (s: string): string =>
  s.length <= 8 ? s : `${s.slice(0, 4)}…${s.slice(-3)}`;

// ============================================================================
// View: State → HTML (the todo list)
// ============================================================================

export const stateHtml = (stream: string, chain: Chain<TodoEvent>, state: TodoState, at: number | null, total: number): string => {
  const todos = Object.values(state.todos).sort((a, b) => b.createdAt - a.createdAt);
  const isPast = at !== null && at < total;

  const form = isPast
    ? `<div class="notice">Viewing receipt ${at} of ${total}</div>`
    : `<form hx-post="/cmd?stream=${encodeURIComponent(stream)}" hx-swap="none">
        <input type="text" name="text" placeholder="Add todo..." required />
        <button>Add</button>
      </form>`;

  const rows = todos.length
    ? todos.map(t => todoHtml(stream, isPast, t.id, t.text, t.done)).join("")
    : `<div class="empty">No todos</div>`;

  const n = at ?? total;

  // Visual fold diagram with hover showing event types
  const receiptBadge = (idx: number): string => {
    const r = chain[idx];
    if (!r) return `<span class="fold-receipt">r${idx + 1}</span>`;
    const eventType = (r.body as { type?: string }).type ?? "event";
    const shortType = eventType.replace("todo.", "");
    const time = new Date(r.ts).toLocaleTimeString();
    return `<span class="fold-receipt" title="${esc(eventType)} @ ${time}">r${idx + 1}<span class="fold-hint">${esc(shortType)}</span></span>`;
  };

  const foldDiagram = n === 0 
    ? `<div class="fold-viz"><span class="fold-state" title="Initial state">∅</span></div>`
    : `<div class="fold-viz">
        <span class="fold-state" title="Initial state: empty">∅</span>
        ${Array.from({length: Math.min(n, 8)}, (_, i) => 
          `<span class="fold-arrow">→</span>${receiptBadge(i)}`
        ).join('')}
        ${n > 8 ? `<span class="fold-arrow">→</span><span class="fold-ellipsis" title="${n - 8} more receipts">···${n-8} more</span>` : ''}
        <span class="fold-arrow">→</span><span class="fold-state current" title="Current state: ${Object.keys(state.todos).length} todos">S</span>
      </div>`;

  return `${form}<div class="todos">${rows}</div>
<div class="meta">${foldDiagram}</div>`;
};

const todoHtml = (stream: string, disabled: boolean, id: string, text: string, done: boolean): string => {
  const cls = done ? "todo done" : "todo";
  if (disabled) {
    return `<div class="${cls}"><input type="checkbox" ${done ? "checked" : ""} disabled /><span>${esc(text)}</span></div>`;
  }
  return `<div class="${cls}">
    <input type="checkbox" ${done ? "checked" : ""} hx-post="/cmd?stream=${encodeURIComponent(stream)}" hx-vals='{"type":"toggle","id":"${id}"}' hx-swap="none" />
    <span>${esc(text)}</span>
    <button hx-post="/cmd?stream=${encodeURIComponent(stream)}" hx-vals='{"type":"delete","id":"${id}"}' hx-swap="none">×</button>
  </div>`;
};

// ============================================================================
// View: Chain → HTML (the timeline)
// ============================================================================

export const timelineHtml = (stream: string, chain: Chain<TodoEvent>, at: number | null): string => {
  const total = chain.length;
  if (!total) return `<div class="empty">No receipts</div>`;

  const currentIdx = at ?? total;
  const items = [...chain].reverse().slice(0, 30);

  return `<div class="timeline">${items.map((r, i) => {
    const idx = total - i;
    const active = idx === currentIdx;
    const t = new Date(r.ts).toLocaleTimeString();
    return `<div class="r${active ? " active" : ""}" hx-get="/travel?stream=${encodeURIComponent(stream)}&at=${idx}" hx-swap="none">
      <code>${esc(r.body.type)}</code> <span>#${idx}</span>
      <small>${esc(t)} · ${esc(short(r.hash))}</small>
    </div>`;
  }).join("")}</div>`;
};

// ============================================================================
// View: Chain → HTML (verification badge)
// ============================================================================

export const verifyHtml = (chain: Chain<TodoEvent>): string => {
  const result = verify(chain);
  const ok = result.ok;
  return `<div class="badge ${ok ? "ok" : "bad"}">
    <span class="dot"></span>
    <span>${ok ? `Verified · ${result.count}` : "Invalid"}</span>
  </div>`;
};

// ============================================================================
// View: Time control (timeline navigator)
// ============================================================================

export const timeHtml = (stream: string, at: number | null, total: number): string => {
  if (total === 0) return `<div class="time"><div class="empty">No receipts yet. Add a todo to create evidence.</div></div>`;

  const current = at ?? total;
  const isPast = at !== null && at < total;

  // Navigation controls
  const canBack = current > 0;
  const canForward = current < total;

  return `<div class="time">
    <div class="nav">
      <div class="nav-btns">
        <button ${canBack ? "" : "disabled"} hx-get="/travel?stream=${encodeURIComponent(stream)}&at=0" hx-swap="none" title="Beginning">⏮</button>
        <button ${canBack ? "" : "disabled"} hx-get="/travel?stream=${encodeURIComponent(stream)}&at=${current - 1}" hx-swap="none" title="Step back">◀</button>
        <span class="pos ${isPast ? "past" : ""}">${current} / ${total}</span>
        <button ${canForward ? "" : "disabled"} hx-get="/travel?stream=${encodeURIComponent(stream)}&at=${current + 1}" hx-swap="none" title="Step forward">▶</button>
        <button ${isPast ? "" : "disabled"} hx-get="/travel?stream=${encodeURIComponent(stream)}" hx-swap="none" title="Present">⏭</button>
      </div>
      ${isPast ? `<span class="mode">Time traveling</span>` : `<span class="mode live">Live</span>`}
    </div>
    <div class="track">
      <div class="bar" style="width: ${(current / total) * 100}%"></div>
      <input type="range" min="0" max="${total}" value="${current}" name="at"
             hx-get="/travel?stream=${encodeURIComponent(stream)}" hx-trigger="change" hx-swap="none" hx-include="this" />
    </div>
  </div>`;
};

// ============================================================================
// View: Branch Selector
// ============================================================================

export const branchSelectorHtml = (
  stream: string,
  allBranches: Branch[],
  children: Branch[],
  current: Branch | undefined,
  at: number | null
): string => {
  const hasBranches = allBranches.length > 0;
  const showFork = at !== null && at > 0;

  // Branch tree: show parent if we have one, then current, then children
  const parentLink = current?.parent
    ? `<a class="branch-link parent" href="/?stream=${encodeURIComponent(current.parent)}" title="Parent branch">↑ ${esc(current.parent)}</a>`
    : "";

  const childLinks = children.length > 0
    ? children.map(c => 
        `<a class="branch-link child" href="/?stream=${encodeURIComponent(c.name)}" title="Forked at receipt ${c.forkAt}">↳ ${esc(c.name)}</a>`
      ).join("")
    : "";

  // Fork form (only show when time traveling)
  const forkForm = showFork
    ? `<form class="fork-form" action="/fork?stream=${encodeURIComponent(stream)}" method="POST">
        <input type="hidden" name="at" value="${at}" />
        <input type="text" name="name" placeholder="branch name" required />
        <button type="submit" title="Fork from receipt ${at}">⑂ Fork</button>
      </form>`
    : "";

  return `<div class="branches">
    <div class="branch-tree">
      ${parentLink}
      <span class="branch-current" title="Current branch">${esc(stream)}</span>
      ${childLinks}
    </div>
    ${forkForm}
  </div>`;
};

// ============================================================================
// OOB Response (all islands with hx-swap-oob)
// ============================================================================

export const oobAll = (
  stream: string,
  chain: Chain<TodoEvent>,
  state: TodoState,
  at: number | null,
  total: number,
  branches: Branch[],
  children: Branch[],
  current: Branch | undefined
): string => `
<div id="time-island" hx-swap-oob="innerHTML">${timeHtml(stream, at, total)}</div>
<div id="branches-island" hx-swap-oob="innerHTML">${branchSelectorHtml(stream, branches, children, current, at)}</div>
<div id="state-island" hx-swap-oob="innerHTML">${stateHtml(stream, chain, state, at, total)}</div>
<div id="timeline-island" hx-swap-oob="innerHTML">${timelineHtml(stream, chain, at)}</div>
<div id="verify-island" hx-swap-oob="innerHTML">${verifyHtml(chain)}</div>`;

// ============================================================================
// Page Shell (static, loads islands)
// ============================================================================

export const shell = (stream: string): string => `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt</title>
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <style>
    :root { --bg: #0b0c10; --card: #12141a; --ink: #e8e8ea; --muted: #888; --line: rgba(255,255,255,.08); --ok: #37d67a; --bad: #ff4d4f; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--ink); }
    .wrap { max-width: 900px; margin: 40px auto; padding: 0 16px; }
    h1 { margin: 0 0 4px; font-size: 28px; }
    .sub { color: var(--muted); font-size: 14px; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
    .card h2 { margin: 0 0 12px; font-size: 12px; text-transform: uppercase; color: var(--muted); letter-spacing: .05em; }
    form { display: flex; gap: 8px; margin-bottom: 12px; }
    input[type="text"] { flex: 1; background: rgba(255,255,255,.05); border: 1px solid var(--line); color: var(--ink); padding: 8px 12px; border-radius: 8px; }
    button { background: rgba(255,255,255,.1); border: 1px solid var(--line); color: var(--ink); padding: 8px 12px; border-radius: 8px; cursor: pointer; }
    button:hover { background: rgba(255,255,255,.15); }
    .todos { display: grid; gap: 6px; }
    .todo { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(255,255,255,.02); border: 1px solid var(--line); border-radius: 8px; }
    .todo.done span { color: var(--muted); text-decoration: line-through; }
    .todo span { flex: 1; }
    .todo button { padding: 4px 8px; font-size: 12px; }
    .timeline { display: grid; gap: 6px; }
    .r { padding: 8px 10px; background: rgba(255,255,255,.02); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
    .r:hover { background: rgba(255,255,255,.04); }
    .r.active { border-color: var(--ok); background: rgba(55,214,122,.05); }
    .r code { color: var(--ink); }
    .r small { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 99px; font-size: 13px; }
    .badge .dot { width: 8px; height: 8px; border-radius: 50%; }
    .badge.ok .dot { background: var(--ok); }
    .badge.bad .dot { background: var(--bad); }
    .time { padding: 12px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 16px; background: rgba(255,255,255,.02); }
    .time .nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .time .nav-btns { display: flex; align-items: center; gap: 4px; }
    .time .nav-btns button { padding: 6px 10px; font-size: 14px; min-width: 36px; }
    .time .nav-btns button:disabled { opacity: 0.3; cursor: not-allowed; }
    .time .pos { font-family: monospace; font-size: 14px; padding: 0 12px; min-width: 60px; text-align: center; }
    .time .pos.past { color: var(--ok); }
    .time .mode { font-size: 11px; padding: 4px 8px; border-radius: 4px; background: rgba(255,255,255,.05); }
    .time .mode.live { background: rgba(55,214,122,.15); color: var(--ok); }
    .time .track { position: relative; height: 24px; }
    .time .bar { position: absolute; top: 10px; left: 0; height: 4px; background: var(--ok); border-radius: 2px; pointer-events: none; z-index: 1; }
    .time input[type="range"] { position: absolute; top: 0; left: 0; width: 100%; height: 24px; accent-color: var(--ok); background: transparent; cursor: pointer; }
    .meta, .empty, .notice { font-size: 12px; color: var(--muted); margin-top: 12px; }
    .fold-viz { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; font-size: 11px; font-family: monospace; padding: 8px 0; }
    .fold-state { background: var(--ok); color: var(--bg); padding: 2px 6px; border-radius: 4px; font-weight: 600; cursor: help; }
    .fold-state.current { background: #5ce1e6; }
    .fold-receipt { background: rgba(255,255,255,.08); padding: 2px 5px; border-radius: 3px; cursor: help; position: relative; }
    .fold-receipt:hover { background: rgba(255,255,255,.15); }
    .fold-receipt .fold-hint { display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--card); border: 1px solid var(--line); padding: 2px 6px; border-radius: 4px; white-space: nowrap; font-size: 10px; color: var(--ok); margin-bottom: 4px; }
    .fold-receipt:hover .fold-hint { display: block; }
    .fold-arrow { color: var(--muted); font-size: 10px; }
    .fold-ellipsis { color: var(--muted); font-style: italic; cursor: help; }
    .notice { padding: 8px; background: rgba(55,214,122,.1); border: 1px solid var(--ok); border-radius: 6px; }
    .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line); }
    .composition-hint { font-size: 12px; color: var(--muted); line-height: 1.5; }
    .composition-hint code { color: var(--ok); font-size: 11px; }
    .branches { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; padding: 8px 12px; background: rgba(255,255,255,.02); border: 1px solid var(--line); border-radius: 8px; }
    .branch-tree { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .branch-link { color: var(--muted); text-decoration: none; padding: 2px 6px; border-radius: 4px; }
    .branch-link:hover { background: rgba(255,255,255,.08); color: var(--ink); }
    .branch-link.parent { color: #888; }
    .branch-link.child { color: #5ce1e6; font-size: 12px; }
    .branch-current { color: var(--ok); font-weight: 600; padding: 2px 6px; background: rgba(55,214,122,.1); border-radius: 4px; }
    .fork-form { display: flex; gap: 6px; }
    .fork-form input[type="text"] { width: 120px; padding: 4px 8px; font-size: 12px; }
    .fork-form button { padding: 4px 10px; font-size: 12px; background: rgba(92,225,230,.15); border-color: rgba(92,225,230,.3); }
    .fork-form button:hover { background: rgba(92,225,230,.25); }
  </style>
</head>
<body>
  <div class="wrap">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <div>
        <h1>Receipt</h1>
        <div class="sub">stream: ${esc(stream)} · state = fold(chain)</div>
      </div>
      <div id="verify-island" hx-get="/island/verify?stream=${encodeURIComponent(stream)}" hx-trigger="load, refresh from:body" hx-swap="innerHTML"></div>
    </div>
    <div id="time-island" hx-get="/island/time?stream=${encodeURIComponent(stream)}" hx-trigger="load, refresh from:body" hx-swap="innerHTML"></div>
    <div id="branches-island" hx-get="/island/branches?stream=${encodeURIComponent(stream)}" hx-trigger="load, refresh from:body" hx-swap="innerHTML"></div>
    <div class="grid">
      <div class="card">
        <h2>State</h2>
        <div id="state-island" hx-get="/island/state?stream=${encodeURIComponent(stream)}" hx-trigger="load, refresh from:body" hx-swap="innerHTML"></div>
      </div>
      <div class="card">
        <h2>Chain</h2>
        <div id="timeline-island" hx-get="/island/timeline?stream=${encodeURIComponent(stream)}" hx-trigger="load, refresh from:body" hx-swap="innerHTML"></div>
      </div>
    </div>
    <div class="footer">
      <div class="composition-hint">
        State flows through each receipt. Replay from any point gives the same result — snapshots are just cached waypoints.
      </div>
    </div>
  </div>
</body>
</html>`;
