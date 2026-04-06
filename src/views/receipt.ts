// ============================================================================
// Receipt Browser UI — browse SQLite-backed receipt streams
// ============================================================================

import type { ReceiptStreamInfo, ReceiptRecord } from "../adapters/receipt-tools";
import {
  esc,
  liveIslandAttrs,
  sseConnectAttrs,
  softPanelClass,
  sectionLabelClass,
  CSS_VERSION,
} from "./ui";

const receiptFoldsRefreshOn = [
  { kind: "load" },
  { event: "receipt-refresh", throttleMs: 800 },
] as const;

const receiptRecordsRefreshOn = [
  { kind: "load" },
  { event: "receipt-refresh", throttleMs: 900 },
] as const;

const formatReceiptCount = (n: number): string =>
  `${n.toLocaleString()} receipt${n === 1 ? "" : "s"}`;

const formatTime = (ts: number): string => new Date(ts).toLocaleString();

const truncateText = (text: string, max = 160): string => {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "\u2026";
};

const receiptType = (r: ReceiptRecord): string => {
  const body = r.data?.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b.type === "string") return b.type;
  }
  return "raw";
};

const receiptHash = (r: ReceiptRecord): string | undefined => {
  if (typeof r.data?.hash === "string") return r.data.hash;
  return undefined;
};

const receiptTs = (r: ReceiptRecord): string | undefined => {
  const ts = r.data?.ts;
  if (typeof ts === "number") return new Date(ts).toLocaleString();
  if (typeof ts === "string") return ts;
  return undefined;
};

const receiptSummary = (r: ReceiptRecord): string => {
  const body = r.data?.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return truncateText(r.raw, 200);
  const b = body as Record<string, unknown>;
  if (typeof b.message === "string") return truncateText(b.message, 200);
  if (typeof b.problem === "string") return truncateText(b.problem, 200);
  if (typeof b.note === "string") return truncateText(b.note, 200);
  if (typeof b.content === "string") return truncateText(b.content, 200);
  if (typeof b.status === "string") return b.status;
  return truncateText(r.raw, 200);
};

const chipClass = "inline-flex items-center  border border-border bg-secondary px-2 py-1 text-[10px] text-muted-foreground no-underline transition hover:bg-accent";
const chipActiveClass = "border-info/40 bg-info/10 text-info";
const chipLabelClass = "border-transparent bg-transparent text-muted-foreground font-semibold hover:bg-transparent";

const chip = (label: string, href: string, active: boolean): string =>
  `<a class="${chipClass} ${active ? chipActiveClass : ""}" href="${esc(href)}">${esc(label)}</a>`;

const chipLabel = (label: string): string =>
  `<span class="${chipClass} ${chipLabelClass}">${esc(label)}</span>`;

export const receiptShell = (opts: {
  readonly selected?: string;
  readonly limit: number;
  readonly order: "asc" | "desc";
  readonly depth: number;
}): string => {
  const { selected, limit, order, depth } = opts;
  const selectedName = selected ?? "";

  const orderChips = [
    chip("Newest", `/receipt?file=${encodeURIComponent(selectedName)}&order=desc&limit=${limit}&depth=${depth}`, order === "desc"),
    chip("Oldest", `/receipt?file=${encodeURIComponent(selectedName)}&order=asc&limit=${limit}&depth=${depth}`, order === "asc"),
  ].join("");

  const windowChips = [50, 200, 1000].map((n) =>
    chip(`${n}`, `/receipt?file=${encodeURIComponent(selectedName)}&order=${order}&limit=${n}&depth=${depth}`, limit === n)
  ).join("");

  const depthChips = [1, 2, 3].map((d) =>
    chip(`${d}`, `/receipt?file=${encodeURIComponent(selectedName)}&order=${order}&limit=${limit}&depth=${d}`, depth === d)
  ).join("");

  return `<!doctype html>
<html class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Browser</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
  <script src="/assets/htmx.min.js?v=${CSS_VERSION}"></script>
  <script src="/assets/htmx-ext-sse.js?v=${CSS_VERSION}"></script>
</head>
<body data-receipt-browser ${sseConnectAttrs("/receipt/stream")}>
  <div class="relative flex min-h-screen flex-col lg:grid lg:h-screen lg:min-h-0 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_320px] lg:overflow-hidden">
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(13_73%_55%_/_0.06),transparent_40%),radial-gradient(circle_at_bottom_right,hsl(210_38%_65%_/_0.06),transparent_40%)]"></div>

    <aside class="relative order-2 min-w-0 border-t border-sidebar-border bg-sidebar text-sidebar-foreground lg:order-none lg:min-h-0 lg:border-r lg:border-t-0">
      <div class="factory-scrollbar max-h-[40vh] overflow-x-hidden overflow-y-auto px-4 py-5 lg:h-screen lg:max-h-none md:px-5">
        <div class="text-lg font-bold text-foreground">Receipt Browser</div>
        <div class="mt-1 text-xs text-muted-foreground">Browse receipt chains \u2014 the single source of truth.</div>
        <a class="mt-3 block text-xs text-info no-underline hover:underline" href="/factory">\u2190 Factory</a>
        <div class="mt-5 ${sectionLabelClass}">Streams</div>
        <div id="receipt-folds"
             class="mt-3 grid gap-2"
             ${liveIslandAttrs({
               path: `/receipt/island/folds?selected=${encodeURIComponent(selectedName)}&order=${order}&limit=${limit}&depth=${depth}`,
               refreshOn: receiptFoldsRefreshOn,
             })}>
          <div class="text-xs text-muted-foreground">Loading streams\u2026</div>
        </div>
      </div>
    </aside>

    <main class="relative order-1 min-w-0 bg-background lg:order-none lg:min-h-0">
      <div class="factory-scrollbar flex min-h-screen flex-col px-5 py-6 lg:h-screen lg:min-h-0 lg:overflow-y-auto md:px-8">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-base font-bold text-foreground">Receipts</div>
            <div class="mt-1 text-xs text-muted-foreground">Every event is a receipt. Click to inspect.</div>
          </div>
          <div class="text-xs text-muted-foreground truncate">${selected ? esc(selected) : "No stream selected"}</div>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-2 border border-border bg-muted px-4 py-3">
          ${chipLabel("Order")}${orderChips}
          ${chipLabel("Window")}${windowChips}
          ${chipLabel("Depth")}${depthChips}
        </div>

        <div id="receipt-records"
             class="mt-4 grid gap-2"
             ${liveIslandAttrs({
               path: `/receipt/island/records?file=${encodeURIComponent(selectedName)}&order=${order}&limit=${limit}`,
               refreshOn: receiptRecordsRefreshOn,
             })}>
          <div class="text-xs text-muted-foreground">Loading receipts\u2026</div>
        </div>
      </div>
    </main>

    <aside class="relative hidden min-w-0 border-l border-sidebar-border bg-sidebar text-sidebar-foreground xl:block" id="receipt-side-wrapper">
      <div class="factory-scrollbar h-screen overflow-x-hidden overflow-y-auto px-4 py-5 md:px-5"
           id="receipt-side"
           ${liveIslandAttrs({
             path: `/receipt/island/side?file=${encodeURIComponent(selectedName)}&order=${order}&limit=${limit}&depth=${depth}`,
             refreshOn: receiptRecordsRefreshOn,
           })}>
        <div class="text-xs text-muted-foreground">Loading context\u2026</div>
      </div>
    </aside>
  </div>
  <script src="/assets/factory-client.js?v=${CSS_VERSION}"></script>
  <style>
    [data-receipt-row] .receipt-raw-block { display: none; }
    [data-receipt-row].receipt-expanded .receipt-raw-block { display: block; }
  </style>
</body>
</html>`;
};

export const receiptFoldsHtml = (
  files: ReadonlyArray<ReceiptStreamInfo>,
  selected?: string,
  order: "asc" | "desc" = "desc",
  limit = 200,
  depth = 2,
): string => {
  if (!files.length) return `<div class="text-xs text-muted-foreground">No receipt streams found.</div>`;
  const sorted = [...files].sort((a, b) => b.mtime - a.mtime);
  return sorted.map((f) => {
    const active = f.name === selected;
    const borderClass = active ? "border-info/30" : "border-border hover:border-border";
    return `<a class="block border ${borderClass} bg-muted px-3 py-2.5 no-underline transition" href="/receipt?file=${encodeURIComponent(f.name)}&order=${order}&limit=${limit}&depth=${depth}">
      <div class="text-xs font-semibold text-foreground break-all">${esc(f.name)}</div>
      <div class="mt-1 text-[10px] text-muted-foreground">${formatReceiptCount(f.size)} \u00b7 ${formatTime(f.mtime)}</div>
    </a>`;
  }).join("");
};

export const receiptRecordsHtml = (opts: {
  readonly selected?: string;
  readonly records: ReadonlyArray<ReceiptRecord>;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly total: number;
}): string => {
  const { selected, records, order, limit, total } = opts;
  if (!selected) return `<div class="text-xs text-muted-foreground">Select a stream to view receipts.</div>`;
  if (!records.length) return `<div class="text-xs text-muted-foreground">No receipts in this stream.</div>`;

  const countNote = total > records.length
    ? `<div class="text-xs text-muted-foreground">Showing ${records.length} of ${total} receipts (${order}, limit ${limit})</div>`
    : `<div class="text-xs text-muted-foreground">${total} receipts</div>`;

  const rows = records.map((r, idx) => {
    const type = receiptType(r);
    const hash = receiptHash(r);
    const ts = receiptTs(r);
    const summary = receiptSummary(r);
    const rawJson = r.data ? JSON.stringify(r.data, null, 2) : r.raw;

    return `<div class="cursor-pointer border border-border bg-muted px-3 py-2.5 transition hover:border-info/25" data-receipt-row data-idx="${idx}">
      <div class="text-[10px] font-semibold uppercase tracking-[0.1em] text-info/80">${esc(type)}</div>
      ${hash ? `<div class="mt-0.5 font-mono text-[10px] text-muted-foreground">${esc(hash)}</div>` : ""}
      ${ts ? `<div class="text-[10px] text-muted-foreground">${esc(ts)}</div>` : ""}
      <div class="mt-1 text-xs leading-5 text-card-foreground">${esc(summary)}</div>
      <div class="receipt-raw-block mt-2 max-h-[300px] overflow-y-auto  border border-border bg-muted px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap break-all">${esc(rawJson)}</div>
    </div>`;
  }).join("");

  return countNote + rows;
};

export const receiptSideHtml = (opts: {
  readonly selected?: string;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly depth: number;
  readonly total: number;
  readonly shown: number;
  readonly fileMeta?: { readonly size: number; readonly mtime: number };
  readonly timeline?: ReadonlyArray<{ readonly label: string; readonly count: number }>;
}): string => {
  const { selected, order, limit, depth, total, shown, fileMeta, timeline } = opts;
  const cardClass = `${softPanelClass} p-4`;

  const timelineTotal = timeline?.reduce((acc, b) => acc + b.count, 0) ?? 0;
  const timelineRows = timeline?.map((b) => {
    const pct = timelineTotal ? Math.round((b.count / timelineTotal) * 100) : 0;
    return `<div class="grid gap-1.5">
      <div class="text-[11px] text-muted-foreground">${esc(b.label)} \u00b7 ${b.count}</div>
      <div class="relative h-1.5 overflow-hidden  bg-secondary">
        <span class="absolute inset-0 bg-info/70" style="width:${pct}%"></span>
      </div>
    </div>`;
  }).join("") ?? "";

  const orderChips = [
    chip("Newest", `/receipt?file=${encodeURIComponent(selected ?? "")}&order=desc&limit=${limit}&depth=${depth}`, order === "desc"),
    chip("Oldest", `/receipt?file=${encodeURIComponent(selected ?? "")}&order=asc&limit=${limit}&depth=${depth}`, order === "asc"),
  ].join("");

  const limitChips = [50, 200, 1000].map((n) =>
    chip(`${n}`, `/receipt?file=${encodeURIComponent(selected ?? "")}&order=${order}&limit=${n}&depth=${depth}`, limit === n)
  ).join("");

  const depthChips = [1, 2, 3].map((d) =>
    chip(`${d}`, `/receipt?file=${encodeURIComponent(selected ?? "")}&order=${order}&limit=${limit}&depth=${d}`, depth === d)
  ).join("");

  return `
  <section class="${cardClass}">
    <div class="${sectionLabelClass}">Stream</div>
    ${selected ? `<div class="mt-3 grid gap-1.5 text-xs text-card-foreground">
      <div class="truncate">${esc(selected)}</div>
      ${fileMeta ? `<div class="text-muted-foreground">${formatReceiptCount(fileMeta.size)} \u00b7 ${formatTime(fileMeta.mtime)}</div>` : ""}
      <div class="text-muted-foreground">Showing ${shown}/${total} receipts</div>
      <div class="text-muted-foreground">Order: ${order} \u00b7 Limit: ${limit}</div>
    </div>` : `<div class="mt-3 text-xs text-muted-foreground">Select a stream.</div>`}
  </section>

  <section class="${cardClass}">
    <div class="${sectionLabelClass}">Controls</div>
    <div class="mt-3 flex flex-wrap gap-1.5">
      ${chipLabel("Order")}${orderChips}
    </div>
    <div class="mt-2 flex flex-wrap gap-1.5">
      ${chipLabel("Limit")}${limitChips}
    </div>
    <div class="mt-2 flex flex-wrap gap-1.5">
      ${chipLabel("Depth")}${depthChips}
    </div>
  </section>

  ${timelineRows ? `<section class="${cardClass}">
    <div class="${sectionLabelClass}">Window Timeline</div>
    <div class="mt-2 text-[11px] text-muted-foreground">Built from the current result window to keep stream inspection responsive.</div>
    <div class="mt-3 grid gap-2">${timelineRows}</div>
  </section>` : ""}`;
};
