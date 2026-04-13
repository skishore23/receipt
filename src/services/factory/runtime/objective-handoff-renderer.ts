import { optionalTrimmedString } from "../../../framework/http";
import type {
  FactoryInvestigationReport,
  FactoryObjectiveHandoffStatus,
  FactoryTaskPresentationRecord,
} from "../../../modules/factory";
import { renderInvestigationReportText } from "../result-contracts";

export const FACTORY_OBJECTIVE_HANDOFF_RENDER_VERSION = "2026-04-12-table-artifact-v3";

export type FactoryTerminalRenderArtifact = {
  readonly label: string;
  readonly ref: {
    readonly kind: string;
    readonly ref: string;
    readonly label?: string;
  };
  readonly contentPreview?: string;
  readonly contentTruncated?: boolean;
};

export type FactoryTerminalRenderInput = {
  readonly objectiveId: string;
  readonly title: string;
  readonly objectiveMode: "delivery" | "investigation";
  readonly status: FactoryObjectiveHandoffStatus;
  readonly summary: string;
  readonly blocker?: string;
  readonly nextAction?: string;
  readonly sourceUpdatedAt: number;
  readonly task?: {
    readonly taskId: string;
    readonly candidateId?: string;
    readonly summary?: string;
    readonly handoff?: string;
    readonly presentation?: FactoryTaskPresentationRecord;
  };
  readonly report?: FactoryInvestigationReport;
  readonly artifacts: ReadonlyArray<FactoryTerminalRenderArtifact>;
};

const renderArtifactList = (
  artifacts: ReadonlyArray<FactoryTerminalRenderArtifact>,
): string | undefined => {
  if (artifacts.length === 0) return undefined;
  return [
    "Artifacts:",
    ...artifacts.map((artifact) => `- ${artifact.label}: ${artifact.ref.ref}`),
  ].join("\n");
};

const renderArtifactPreview = (
  artifacts: ReadonlyArray<FactoryTerminalRenderArtifact>,
  renderHint?: "table" | "list" | "report" | "generic",
): string | undefined => {
  const previews = artifacts.filter((artifact) => optionalTrimmedString(artifact.contentPreview));
  if (previews.length === 0) return undefined;
  if (renderHint === "table") {
    const tabular = previews.find((artifact) => looksLikeMarkdownTable(artifact.contentPreview));
    return tabular?.contentPreview?.trim();
  }
  const preview = previews[0];
  if (!preview?.contentPreview) return undefined;
  return preview.contentPreview.trim();
};

const looksLikeMarkdownTable = (value: string | undefined): boolean => {
  const body = optionalTrimmedString(value);
  if (!body) return false;
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index]?.trim() ?? "";
    const separator = lines[index + 1]?.trim() ?? "";
    if (!header.includes("|")) continue;
    if (!/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(separator)) continue;
    return true;
  }
  return false;
};

const preferredPresentationRenderHint = (
  input: FactoryTerminalRenderInput,
): "table" | "list" | "report" | "generic" =>
  input.task?.presentation?.renderHint ?? "generic";

const renderPrimaryBody = (
  input: FactoryTerminalRenderInput,
): {
  readonly body: string;
  readonly source: "inline" | "artifact_preview" | "report" | "summary";
} => {
  const inlineBody = optionalTrimmedString(input.task?.presentation?.inlineBody)
    ?? optionalTrimmedString(input.task?.handoff);
  const renderHint = preferredPresentationRenderHint(input);
  const artifactPreview = renderArtifactPreview(input.artifacts, renderHint);
  if (renderHint === "table" || renderHint === "list") {
    if (renderHint === "table") {
      if (inlineBody && looksLikeMarkdownTable(inlineBody)) return { body: inlineBody, source: "inline" };
      if (artifactPreview) return { body: artifactPreview, source: "artifact_preview" };
      return { body: input.summary.trim(), source: "summary" };
    }
    if (inlineBody) return { body: inlineBody, source: "inline" };
    if (artifactPreview) return { body: artifactPreview, source: "artifact_preview" };
  }
  if (input.objectiveMode === "investigation" && input.report) {
    return {
      body: renderInvestigationReportText(input.summary, input.report, undefined, [], input.task?.handoff).trim(),
      source: "report",
    };
  }
  if (inlineBody) return { body: inlineBody, source: "inline" };
  if (artifactPreview) return { body: artifactPreview, source: "artifact_preview" };
  return { body: input.summary.trim(), source: "summary" };
};

export const renderFactoryObjectiveHandoff = (
  input: FactoryTerminalRenderInput,
): string => {
  const primary = renderPrimaryBody(input);
  const artifactList = preferredPresentationRenderHint(input) === "table" || preferredPresentationRenderHint(input) === "list"
    ? undefined
    : renderArtifactList(input.artifacts);
  const sections = [
    primary.body,
    artifactList,
    input.status === "blocked" && input.blocker ? `Blocker: ${input.blocker}` : undefined,
    input.nextAction ? `Next action: ${input.nextAction}` : undefined,
  ]
    .filter((item): item is string => Boolean(item && item.trim()))
    .map((item) => item.trim());
  return sections.join("\n\n").trim();
};
