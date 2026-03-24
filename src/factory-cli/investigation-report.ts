import type { FactoryObjectiveDetail } from "../services/factory-service";
import type { FactoryObjectivePanel } from "./view-model";

const clip = (value: string | undefined, max = 220): string => {
  const text = value?.trim() ?? "";
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
};

const artifactLines = (detail: FactoryObjectiveDetail): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const report of detail.investigation.reports) {
    for (const ref of Object.values(report.artifactRefs)) {
      const key = `${ref.kind}:${ref.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${ref.label ?? ref.kind}: ${clip(ref.ref, 180)}`);
    }
  }
  return lines;
};

export const investigationReportAvailable = (detail: FactoryObjectiveDetail): boolean =>
  detail.objectiveMode === "investigation"
  && (Boolean(detail.investigation.synthesized) || (detail.status === "completed" && detail.investigation.reports.length > 0));

export const defaultObjectivePanelForDetail = (detail: FactoryObjectiveDetail): FactoryObjectivePanel =>
  investigationReportAvailable(detail) ? "report" : "overview";

export const buildInvestigationReportPanelValue = (detail: FactoryObjectiveDetail) => ({
  objectiveId: detail.objectiveId,
  objectiveMode: detail.objectiveMode,
  severity: detail.severity,
  report: detail.investigation.finalReport,
  synthesized: detail.investigation.synthesized,
  reports: detail.investigation.reports,
  artifacts: artifactLines(detail),
});

export type InvestigationReportSection = {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
};

export const buildInvestigationReportSections = (
  detail: FactoryObjectiveDetail,
): ReadonlyArray<InvestigationReportSection> => {
  if (detail.objectiveMode !== "investigation") {
    return [{
      title: "Report",
      lines: ["This objective is in delivery mode. The report panel is only populated for investigation objectives."],
    }];
  }
  const report = detail.investigation.finalReport;
  const lead = detail.investigation.synthesized
    ? `Investigation is aligned across ${detail.investigation.synthesized.taskIds.length} final report(s).`
    : detail.investigation.reports.length > 0
      ? `Investigation is still in progress with ${detail.investigation.reports.length} report(s) collected so far.`
      : "Investigation has started, but no worker reports have been recorded yet.";
  return [
    {
      title: "Report",
      lines: [
        lead,
        `mode=${detail.objectiveMode} severity=${detail.severity}`,
      ],
    },
    {
      title: "Conclusion",
      lines: [report.conclusion || "No conclusion recorded."],
    },
    {
      title: "Evidence",
      lines: report.evidence.length
        ? report.evidence.map((item) =>
          `${item.title}: ${clip(item.summary, 180)}${item.detail ? ` | ${clip(item.detail, 180)}` : ""}`)
        : ["none yet"],
    },
    {
      title: "Disagreements",
      lines: report.disagreements.length
        ? report.disagreements.map((item) => clip(item, 220))
        : ["none"],
    },
    {
      title: "Scripts Run",
      lines: report.scriptsRun.length
        ? report.scriptsRun.map((item) =>
          `${item.status ?? "ok"}: ${clip(item.command, 120)}${item.summary ? ` | ${clip(item.summary, 120)}` : ""}`)
        : ["none recorded"],
    },
    {
      title: "Artifacts",
      lines: artifactLines(detail).length ? artifactLines(detail) : ["none recorded"],
    },
    {
      title: "Next Steps",
      lines: report.nextSteps.length
        ? report.nextSteps.map((item) => clip(item, 220))
        : ["none"],
    },
  ];
};
