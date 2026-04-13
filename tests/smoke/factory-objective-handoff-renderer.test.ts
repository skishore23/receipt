import { expect, test } from "bun:test";

import { buildChatItemsFromConversation } from "../../src/agents/factory/chat-items";
import { renderFactoryObjectiveHandoff } from "../../src/services/factory/runtime/objective-handoff-renderer";

const baseInput = {
  objectiveId: "objective_demo",
  title: "Show me list of s3 in table format",
  status: "completed" as const,
  sourceUpdatedAt: 1,
  blocker: undefined,
  nextAction: undefined,
};

test("factory objective handoff renderer prefers table artifact previews over investigation report prose", () => {
  const rendered = renderFactoryObjectiveHandoff({
    ...baseInput,
    objectiveMode: "investigation",
    summary: "Found five S3 buckets.",
    task: {
      taskId: "task_01",
      presentation: {
        kind: "artifacts",
        renderHint: "table",
        primaryArtifactLabels: ["S3 bucket inventory markdown"],
      },
    },
    report: {
      conclusion: "Found five S3 buckets and rendered them in table form.",
      evidence: [{
        title: "S3 bucket inventory table",
        summary: "The helper captured five buckets.",
      }],
      scriptsRun: [],
      disagreements: [],
      nextSteps: [],
    },
    artifacts: [{
      label: "S3 bucket inventory markdown",
      ref: {
        kind: "artifact",
        ref: "/tmp/aws_s3_bucket_inventory.md",
      },
      contentPreview: [
        "| Bucket | Region |",
        "| --- | --- |",
        "| cloudscore1 | us-east-1 |",
      ].join("\n"),
    }],
  });

  expect(rendered).toContain("| Bucket | Region |");
  expect(rendered).not.toContain("Conclusion");
  expect(rendered).not.toContain("Handoff");
  expect(rendered).not.toContain("Artifacts:");
});

test("factory objective handoff renderer keeps investigation report prose for report hints", () => {
  const rendered = renderFactoryObjectiveHandoff({
    ...baseInput,
    objectiveMode: "investigation",
    summary: "Found five S3 buckets.",
    task: {
      taskId: "task_01",
      presentation: {
        kind: "investigation_report",
        renderHint: "report",
      },
      handoff: "Worker handoff body.",
    },
    report: {
      conclusion: "Found five S3 buckets and rendered them in table form.",
      evidence: [{
        title: "S3 bucket inventory table",
        summary: "The helper captured five buckets.",
      }],
      scriptsRun: [],
      disagreements: [],
      nextSteps: [],
    },
    artifacts: [],
  });

  expect(rendered).toContain("Conclusion");
  expect(rendered).toContain("Handoff");
  expect(rendered).toContain("Worker handoff body.");
});

test("factory objective handoff renderer prefers markdown artifact tables over prose inline handoffs when the render hint is table", () => {
  const rendered = renderFactoryObjectiveHandoff({
    ...baseInput,
    objectiveMode: "investigation",
    summary: "Found five S3 buckets.",
    task: {
      taskId: "task_01",
      presentation: {
        kind: "investigation_report",
        renderHint: "table",
        inlineBody: "I interpreted s3 as S3 buckets and wrote the inventory artifact.",
        primaryArtifactLabels: ["S3 bucket inventory markdown", "S3 bucket inventory"],
      },
      handoff: "I interpreted s3 as S3 buckets and wrote the inventory artifact.",
    },
    report: {
      conclusion: "Found five S3 buckets.",
      evidence: [{
        title: "S3 bucket inventory table",
        summary: "The helper captured five buckets.",
      }],
      scriptsRun: [],
      disagreements: [],
      nextSteps: [],
    },
    artifacts: [{
      label: "S3 bucket inventory",
      ref: {
        kind: "artifact",
        ref: "/tmp/aws_s3_bucket_inventory.json",
      },
      contentPreview: "{\"total\":5}",
    }, {
      label: "S3 bucket inventory markdown",
      ref: {
        kind: "artifact",
        ref: "/tmp/aws_s3_bucket_inventory.md",
      },
      contentPreview: [
        "| Bucket | Region |",
        "| --- | --- |",
        "| cloudscore1 | us-east-1 |",
      ].join("\n"),
    }],
  });

  expect(rendered).toContain("| Bucket | Region |");
  expect(rendered).not.toContain("I interpreted s3 as S3 buckets and wrote the inventory artifact.");
  expect(rendered).not.toContain("Conclusion");
});

test("factory objective handoff renderer does not fall back to prose handoffs for table hints", () => {
  const rendered = renderFactoryObjectiveHandoff({
    ...baseInput,
    objectiveMode: "investigation",
    summary: "Found five S3 buckets.",
    task: {
      taskId: "task_01",
      presentation: {
        kind: "investigation_report",
        renderHint: "table",
        inlineBody: "I interpreted s3 as S3 buckets and wrote the inventory artifact.",
        primaryArtifactLabels: ["S3 bucket inventory markdown"],
      },
      handoff: "I interpreted s3 as S3 buckets and wrote the inventory artifact.",
    },
    report: {
      conclusion: "Found five S3 buckets.",
      evidence: [],
      scriptsRun: [],
      disagreements: [],
      nextSteps: [],
    },
    artifacts: [{
      label: "S3 bucket inventory markdown",
      ref: {
        kind: "artifact",
        ref: "/tmp/aws_s3_bucket_inventory.md",
      },
      contentPreview: "Inventory artifact generated successfully.",
    }],
  });

  expect(rendered).toBe("Found five S3 buckets.");
  expect(rendered).not.toContain("I interpreted s3 as S3 buckets and wrote the inventory artifact.");
  expect(rendered).not.toContain("Conclusion");
});

test("factory chat conversation handoffs render as assistant replies without a synthetic title card", () => {
  const items = buildChatItemsFromConversation([{
    role: "assistant",
    text: "| Bucket | Region |\n| --- | --- |\n| cloudscore1 | us-east-1 |",
    runId: "run_s3_handoff",
    ts: 1,
    refs: [],
    objectiveHandoff: {
      objectiveId: "objective_s3",
      title: "Show me list of s3 in table format",
      status: "blocked",
    },
  }]);

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    kind: "assistant",
    meta: "Blocked handoff",
  });
  expect("title" in (items[0] ?? {})).toBe(false);
});

test("factory chat conversation fallback blocked handoffs stay conversational", async () => {
  const { describeTranscriptState, renderTranscriptContent } = await import("../../src/views/factory/transcript");
  const model = {
    activeProfileId: "infrastructure",
    activeProfileLabel: "Infrastructure",
    activeProfilePrimaryRole: "Infrastructure engineer",
    objectiveId: "objective_s3",
    items: [],
    selectedThread: {
      objectiveId: "objective_s3",
      title: "Show me list of s3 in table format",
      status: "blocked",
      blockedReason: "The worker needs another pass to attach the final table artifact.",
      nextAction: "React with guidance to rerun the inventory and return only the table.",
      updatedAt: 1,
    },
  } as any;

  const transcript = renderTranscriptContent(model);
  const state = describeTranscriptState(model);

  expect(state.lastItemKind).toBe("assistant");
  expect(transcript.body).toContain("Blocked handoff");
  expect(transcript.body).toContain("Show me list of s3 in table format is blocked right now.");
  expect(transcript.body).toContain("Smallest next step:");
  expect(transcript.body).not.toContain("Objective blocked");
  expect(transcript.body).not.toContain("handed back to Chat");
});
