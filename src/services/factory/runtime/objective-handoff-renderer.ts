import { optionalTrimmedString } from "../../../framework/http";
import type {
  FactoryInvestigationReport,
  FactoryObjectiveHandoffStatus,
  FactoryTaskPresentationRecord,
} from "../../../modules/factory";
import { renderInvestigationReportText } from "../result-contracts";

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
): string | undefined => {
  const preview = artifacts.find((artifact) => optionalTrimmedString(artifact.contentPreview));
  if (!preview?.contentPreview) return undefined;
  return preview.contentPreview.trim();
};

const renderPrimaryBody = (input: FactoryTerminalRenderInput): string => {
  if (input.objectiveMode === "investigation" && input.report) {
    return renderInvestigationReportText(input.summary, input.report, undefined, [], input.task?.handoff).trim();
  }
  const inlineBody = optionalTrimmedString(input.task?.presentation?.inlineBody)
    ?? optionalTrimmedString(input.task?.handoff);
  if (inlineBody) return inlineBody;
  const artifactPreview = renderArtifactPreview(input.artifacts);
  if (artifactPreview) return artifactPreview;
  return input.summary.trim();
};

export const renderFactoryObjectiveHandoff = (
  input: FactoryTerminalRenderInput,
): string => {
  const sections = [
    renderPrimaryBody(input),
    renderArtifactList(input.artifacts),
    input.status === "blocked" && input.blocker ? `Blocker: ${input.blocker}` : undefined,
    input.nextAction ? `Next action: ${input.nextAction}` : undefined,
  ]
    .filter((item): item is string => Boolean(item && item.trim()))
    .map((item) => item.trim());
  return sections.join("\n\n").trim();
};
