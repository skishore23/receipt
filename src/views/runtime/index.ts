import { CSS_VERSION, iconFactory, iconReceipt, sseConnectAttrs } from "../ui";

export type { RuntimeDashboardModel } from "./data";
export { runtimeDashboardIsland } from "./render";

export const runtimeShell = (input: {
  readonly dashboardHtml: string;
  readonly receiptStreamPath?: string;
}): string => `<!doctype html>
<html class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt Runtime</title>
  <link rel="stylesheet" href="/assets/factory.css?v=${CSS_VERSION}" />
  <script src="/assets/htmx.min.js?v=${CSS_VERSION}"></script>
  <script src="/assets/htmx-ext-sse.js?v=${CSS_VERSION}"></script>
</head>
<body class="bg-background text-foreground" data-receipt-runtime ${sseConnectAttrs(input.receiptStreamPath ?? "/receipt/stream")}>
  <div class="mx-auto max-w-[1500px] px-4 py-6 space-y-5">
    <header class="border border-border bg-card px-5 py-4">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-2.5">
            ${iconFactory("text-muted-foreground")}
            <h1 class="text-[15px] font-bold tracking-wide text-foreground">RECEIPT RUNTIME</h1>
          </div>
          <p class="mt-1 text-[12px] text-muted-foreground">Original runtime architecture map, now backed by live projections, receipts, and active run state.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <a href="/factory" class="inline-flex items-center gap-1.5 border border-border bg-secondary px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition">
            ${iconFactory()} Factory
          </a>
          <a href="/receipt" class="inline-flex items-center gap-1.5 border border-border bg-secondary px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition">
            ${iconReceipt()} Receipts
          </a>
        </div>
      </div>
    </header>
    ${input.dashboardHtml}
  </div>
</body>
</html>`;
