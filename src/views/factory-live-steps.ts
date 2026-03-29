import {
  badgeToneClass,
  esc,
  formatTs,
  iconClock,
  iconForRunStepKind,
  iconRun,
  sectionLabelClass,
} from "./ui";
import type { FactoryLiveRunCard } from "./factory-models";

type DisplayStep = NonNullable<FactoryLiveRunCard["steps"]>[number] & {
  readonly displayMeta?: string;
};

const renderStep = (
  step: DisplayStep,
  options: {
    readonly latest: boolean;
    readonly showConnector: boolean;
  },
): string => {
  const labelClass = badgeToneClass(step.tone);
  const activeClass = step.active || options.latest ? "animate-pulse" : "";
  return `<div class="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-3 px-4 py-4 ${options.latest ? "bg-primary/5" : ""}">
    <div class="relative flex justify-center">
      ${options.showConnector ? `<span class="absolute left-1/2 top-10 bottom-[-1rem] w-px -translate-x-1/2 bg-border/70"></span>` : ""}
      <span class="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center l border ${labelClass} shadow-sm ${activeClass}">
        ${iconForRunStepKind(step.kind, "h-4 w-4")}
      </span>
    </div>
    <div class="min-w-0 pt-0.5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="inline-flex items-center  border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${labelClass}">${esc(step.label)}</span>
        ${step.displayMeta ? `<span class="inline-flex items-center gap-1 text-[10px] text-muted-foreground">${iconRun("h-3 w-3")} ${esc(step.displayMeta)}</span>` : ""}
        ${step.at ? `<span class="inline-flex items-center gap-1 text-[10px] text-muted-foreground">${iconClock("h-3 w-3")} ${esc(formatTs(step.at))}</span>` : ""}
      </div>
      <div class="mt-1.5 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">${esc(step.summary)}</div>
      ${step.detail ? `<div class="mt-2 border border-border/70 bg-background/50 px-3 py-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">${esc(step.detail)}</div>` : ""}
    </div>
  </div>`;
};

export const renderFactoryRunSteps = (
  run: FactoryLiveRunCard | undefined,
  options?: {
    readonly title?: string;
    readonly subtitle?: string;
  },
): string => {
  const steps = run?.steps ?? [];
  if (steps.length === 0) return "";
  const displaySteps: DisplayStep[] = steps.map((step, index) => ({
    ...step,
    displayMeta: step.meta && step.meta !== steps[index - 1]?.meta ? step.meta : undefined,
  }));
  const title = options?.title ?? "What's Happening";
  const subtitle = options?.subtitle ?? `${run?.profileLabel ?? "Factory"} is streaming recent reasoning steps for this thread.`;
  return `<section class="overflow-hidden  border border-border bg-card shadow-sm">
    <div class="flex items-start justify-between gap-3 border-b border-border/80 px-4 py-3">
      <div class="flex min-w-0 items-start gap-3">
        <span class="flex h-10 w-10 shrink-0 items-center justify-center l border border-border/80 bg-muted/80 text-primary shadow-sm">
          ${iconRun("h-4 w-4")}
        </span>
        <div class="min-w-0">
          <div class="${sectionLabelClass}">${esc(title)}</div>
          <div class="mt-1 text-xs leading-5 text-muted-foreground">${esc(subtitle)}</div>
        </div>
      </div>
      <div class="shrink-0  border border-border bg-muted px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        ${esc(`${steps.length} step${steps.length === 1 ? "" : "s"}`)}
      </div>
    </div>
    <div class="divide-y divide-border/70">
      ${displaySteps.map((step, index) => renderStep(step, {
        latest: index === displaySteps.length - 1,
        showConnector: index < displaySteps.length - 1,
      })).join("")}
    </div>
  </section>`;
};
