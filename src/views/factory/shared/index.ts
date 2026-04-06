import {
  badgeToneClass,
  displayLabel,
  esc,
  iconCodex,
  iconProject,
  iconQueue,
  iconRun,
  iconTokens,
  toneForValue,
} from "../../ui";
import { COMPOSER_COMMANDS } from "../../../factory-cli/composer";
import type {
  FactoryChatProfileNav,
  FactoryInspectorPanel,
  FactoryInspectorTab,
} from "../../factory-models";

export type FactoryChatRouteContext = {
  readonly profileId: string;
  readonly chatId?: string;
  readonly objectiveId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly panel?: FactoryInspectorPanel;
  readonly inspectorTab?: FactoryInspectorTab;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
};

export const factoryChatQuery = (input: FactoryChatRouteContext): string => {
  const params = new URLSearchParams();
  params.set("profile", input.profileId);
  if (input.chatId) params.set("chat", input.chatId);
  if (input.objectiveId) params.set("objective", input.objectiveId);
  if (input.runId) params.set("run", input.runId);
  if (input.jobId) params.set("job", input.jobId);
  if (input.panel) params.set("panel", input.panel);
  if (input.inspectorTab && input.inspectorTab !== "overview") params.set("inspectorTab", input.inspectorTab);
  if (input.focusKind && input.focusId) {
    params.set("focusKind", input.focusKind);
    params.set("focusId", input.focusId);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
};

export const compactStatusText = (value: string, maxChars = 160): string => {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentence = text.match(/^(.{1,160}?[.!?])(\s|$)/)?.[1] ?? text;
  const clipped = sentence.length > maxChars ? `${sentence.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…` : sentence;
  return clipped;
};

export const titleCaseLabel = (value?: string): string => {
  const label = displayLabel(value);
  return label ? label.replace(/\b\w/g, (match) => match.toUpperCase()) : "";
};

export const shellPill = (label: string, tone: "neutral" | "info" | "success" | "warning" | "danger" = "neutral", icon?: string): string =>
  `<span class="inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] whitespace-nowrap ${badgeToneClass(tone)}">${icon ?? ""}${esc(label)}</span>`;

export const shellHeaderTitle = (model: {
  readonly inspector: { readonly selectedObjective?: { readonly title?: string } };
  readonly objectiveId?: string;
  readonly activeProfileLabel: string;
}): string =>
  model.inspector.selectedObjective?.title
    ?? (!model.objectiveId ? "New chat" : model.activeProfileLabel);

export const shellProfileSummary = (model: {
  readonly chat: { readonly activeProfileSummary?: string };
}): string | undefined => model.chat.activeProfileSummary?.trim() || undefined;

const headerProfileSelectClass = "min-w-[11rem]  border border-border bg-background px-3 py-2 text-sm font-medium text-foreground outline-none transition hover:bg-accent hover:text-foreground focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/30";

export const renderHeaderProfileSelect = (input: {
  readonly id: string;
  readonly label: string;
  readonly profiles: ReadonlyArray<FactoryChatProfileNav>;
}): string => {
  if (input.profiles.length === 0) return "";
  return `<select id="${esc(input.id)}" aria-label="${esc(input.label)}" data-factory-profile-select="true" class="${headerProfileSelectClass}">
    ${input.profiles.map((profile) => `<option value="${esc(profile.href)}"${profile.selected ? " selected" : ""}>${esc(profile.label)}</option>`).join("")}
  </select>`;
};

export const composerCommandsJson = (): string => JSON.stringify(COMPOSER_COMMANDS.map((command) => ({
  name: command.name,
  label: command.label,
  usage: command.usage,
  description: command.description,
  aliases: command.aliases ?? [],
})));

export const composerTextareaClass = "min-h-[88px] w-full flex-[1_1_0%] resize-none  border border-border bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/30 focus:bg-background focus-visible:ring-2 focus-visible:ring-ring/40";
export const composerShellClass = "mx-auto w-full max-w-6xl";
export const composerPanelClass = "relative flex flex-col gap-2";
export const assistantResponseCardClass = "overflow-hidden border border-border/80 bg-card/90";
export const assistantResponseBodyClass = "max-w-[72ch] px-4 py-3 sm:px-5 sm:py-4";

export const isTerminalJobStatusValue = (status?: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

export const composerJobId = (model: {
  readonly jobId?: string;
  readonly inspector: {
    readonly activeCodex?: { readonly jobId?: string };
    readonly liveChildren?: ReadonlyArray<{ readonly status: string; readonly jobId?: string }>;
    readonly jobs: ReadonlyArray<{ readonly status: string; readonly jobId?: string }>;
  };
}): string | undefined => {
  if (model.jobId) return model.jobId;
  if (model.inspector.activeCodex?.jobId) return model.inspector.activeCodex.jobId;
  const liveChild = model.inspector.liveChildren?.find((child) => !isTerminalJobStatusValue(child.status));
  if (liveChild?.jobId) return liveChild.jobId;
  return model.inspector.jobs.find((job) =>
    job.status === "queued" || job.status === "leased" || job.status === "running"
  )?.jobId;
};

export const renderShellStatusPills = (model: {
  readonly inspector: {
    readonly selectedObjective?: {
      readonly displayState?: string;
      readonly phaseDetail?: string;
      readonly phase?: string;
      readonly status?: string;
      readonly queuePosition?: number;
      readonly tokensUsed?: number;
    };
    readonly activeCodex?: { readonly status: string };
    readonly activeRun?: { readonly status: string };
  };
}): string => {
  const pills: string[] = [];
  const objective = model.inspector.selectedObjective;
  if (objective) {
    const phaseLabel = objective.displayState ?? displayLabel(objective.phase) ?? displayLabel(objective.status) ?? "active";
    pills.push(shellPill(`Objective ${phaseLabel}`, toneForValue(objective.displayState ?? objective.phase ?? objective.status), iconProject("h-3 w-3")));
    if (objective.phaseDetail) pills.push(shellPill(displayLabel(objective.phaseDetail) || objective.phaseDetail, "info", iconProject("h-3 w-3")));
    if (typeof objective.queuePosition === "number") pills.push(shellPill(`Queue #${objective.queuePosition}`, "warning", iconQueue("h-3 w-3")));
    if (typeof objective.tokensUsed === "number") pills.push(shellPill(`${objective.tokensUsed.toLocaleString()} tokens`, "info", iconTokens("h-3 w-3")));
  }
  if (model.inspector.activeCodex) {
    pills.push(shellPill(`Codex ${displayLabel(model.inspector.activeCodex.status) || "active"}`, toneForValue(model.inspector.activeCodex.status), iconCodex("h-3 w-3")));
  } else if (model.inspector.activeRun?.status) {
    pills.push(shellPill(`Run ${displayLabel(model.inspector.activeRun.status) || "active"}`, toneForValue(model.inspector.activeRun.status), iconRun("h-3 w-3")));
  }
  return pills.join("");
};
