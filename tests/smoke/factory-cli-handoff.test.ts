import { expect, test } from "bun:test";

import { renderObjectivePanelText } from "../../src/factory-cli/format";
import { defaultObjectivePanelForDetail } from "../../src/factory-cli/investigation-report";

const detail = {
  objectiveId: "objective_s3",
  title: "show me list of s3 in a table",
  displayState: "Completed",
  phase: "completed",
  phaseDetail: "completed",
  statusAuthority: "objective",
  scheduler: {
    slotState: "released",
  },
  integration: {
    status: "idle",
  },
  objectiveMode: "investigation",
  severity: 1,
  budgetState: {
    elapsedMinutes: 1,
    taskRunsUsed: 1,
  },
  policy: {
    concurrency: {
      maxActiveTasks: 20,
    },
    promotion: {
      autoPromote: false,
    },
    budgets: {
      maxTaskRuns: 50,
    },
  },
  latestCommitHash: undefined,
  nextAction: "Investigation is complete.",
  prompt: "show me list of s3 in a table",
  checks: [],
  latestHandoff: {
    status: "completed",
    summary: "Found five buckets.",
    renderedBody: [
      "| Bucket | Region |",
      "| --- | --- |",
      "| cloudscore1 | us-east-1 |",
    ].join("\n"),
    handoffKey: "handoff_01",
    sourceUpdatedAt: 1,
  },
  tasks: [],
  activeTaskCount: 0,
  readyTaskCount: 0,
  evidenceCards: [],
  activity: [],
  candidates: [],
  recentReceipts: [],
  investigation: {
    synthesized: {
      summary: "Found five buckets.",
      report: {
        conclusion: "Found five buckets.",
        evidence: [],
        scriptsRun: [],
        disagreements: [],
        nextSteps: [],
      },
      taskIds: ["task_01"],
      synthesizedAt: 1,
    },
    reports: [],
    finalReport: {
      conclusion: "Found five buckets.",
      evidence: [],
      scriptsRun: [],
      disagreements: [],
      nextSteps: [],
    },
  },
} as any;

test("factory cli inspect defaults investigation tables to overview", () => {
  expect(defaultObjectivePanelForDetail(detail)).toBe("overview");
});

test("factory cli overview includes tabular durable handoffs", () => {
  const rendered = renderObjectivePanelText(
    detail,
    { activeTasks: [] } as any,
    {} as any,
    "overview",
  );

  expect(rendered).toContain("latest_handoff:");
  expect(rendered).toContain("| Bucket | Region |");
  expect(rendered).toContain("| cloudscore1 | us-east-1 |");
});
