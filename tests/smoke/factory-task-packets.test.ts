import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FactoryState, FactoryTaskRecord } from "../../src/modules/factory";
import {
  buildTaskFilePaths,
  buildTaskMemoryScopes,
  listTaskArtifactActivity,
  listTaskReadableArtifacts,
  renderTaskContextSummary,
  summarizeTaskArtifactActivity,
  summarizeReadableTaskArtifacts,
} from "../../src/services/factory/task-packets";

const tempDir = (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("factory task packets: task file paths stay under the packet directory", () => {
  const files = buildTaskFilePaths("/tmp/factory-workspace", "task_01");

  expect(files.manifestPath).toBe("/tmp/factory-workspace/.receipt/factory/task_01.manifest.json");
  expect(files.contextPackPath).toBe("/tmp/factory-workspace/.receipt/factory/task_01.context-pack.json");
  expect(files.memoryScriptPath).toBe("/tmp/factory-workspace/.receipt/factory/task_01.memory.cjs");
});

test("factory task packets: memory scopes use the effective task prompt override", () => {
  const state = {
    objectiveId: "objective_demo",
    title: "Refactor packet helpers",
  } as FactoryState;
  const task = {
    taskId: "task_01",
    title: "Extract packet helpers",
    prompt: "old prompt",
    workerType: "codex",
  } as FactoryTaskRecord;

  const scopes = buildTaskMemoryScopes(state, task, "task_01_candidate_01", "effective prompt");

  expect(scopes.map((scope) => scope.key)).toEqual([
    "agent",
    "repo",
    "objective",
    "task",
    "candidate",
    "integration",
  ]);
  expect(scopes[0]?.defaultQuery).toBe("Refactor packet helpers\nExtract packet helpers\neffective prompt");
  expect(scopes[4]?.scope).toBe("factory/objectives/objective_demo/candidates/task_01_candidate_01");
  expect(scopes.filter((s) => s.readOnly).map((s) => s.key)).toEqual(["agent", "repo"]);
  expect(scopes.filter((s) => !s.readOnly).map((s) => s.key)).toEqual(["objective", "task", "candidate", "integration"]);
});

test("factory task packets: artifact activity ignores known files and summarizes extras", async () => {
  const workspacePath = await tempDir("receipt-factory-task-packets");
  const files = buildTaskFilePaths(workspacePath, "task_01");
  const packetDir = path.dirname(files.manifestPath);
  await fs.mkdir(packetDir, { recursive: true });

  await fs.writeFile(files.manifestPath, "{}", "utf-8");
  await fs.writeFile(files.resultPath, "{}", "utf-8");
  await fs.writeFile(path.join(packetDir, "task_01.notes.txt"), "notes", "utf-8");
  await fs.writeFile(path.join(packetDir, "task_01.evidence.json"), "{\"ok\":true}", "utf-8");
  await fs.writeFile(path.join(packetDir, "task_02.evidence.json"), "{\"skip\":true}", "utf-8");

  const newer = new Date("2024-01-01T00:00:02.000Z");
  const older = new Date("2024-01-01T00:00:01.000Z");
  await fs.utimes(path.join(packetDir, "task_01.notes.txt"), newer, newer);
  await fs.utimes(path.join(packetDir, "task_01.evidence.json"), older, older);

  const activity = await listTaskArtifactActivity(
    workspacePath,
    "task_01",
    (resultPath) => path.join(path.dirname(resultPath), "schema.json"),
  );

  expect(activity.map((artifact) => artifact.label)).toEqual([
    "task_01.notes.txt",
    "task_01.evidence.json",
  ]);
  expect(summarizeTaskArtifactActivity(activity)).toBe("Recent task artifacts: task_01.notes.txt, task_01.evidence.json.");
});

test("factory task packets: readable artifacts include evidence directory files and readable packet artifacts", async () => {
  const workspacePath = await tempDir("receipt-factory-readable-artifacts");
  const files = buildTaskFilePaths(workspacePath, "task_01");
  const packetDir = path.dirname(files.manifestPath);
  const evidenceDir = path.join(packetDir, "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });

  await fs.writeFile(path.join(evidenceDir, "inventory.json"), "{\"instances\":[]}", "utf-8");
  await fs.writeFile(path.join(packetDir, "task_01.summary.md"), "# summary", "utf-8");
  await fs.writeFile(path.join(packetDir, "task_01.binary.bin"), "skip", "utf-8");

  const readable = await listTaskReadableArtifacts(workspacePath, [
    {
      path: path.join(packetDir, "task_01.summary.md"),
      label: "task_01.summary.md",
      updatedAt: Date.now(),
      bytes: 9,
    },
    {
      path: path.join(packetDir, "task_01.binary.bin"),
      label: "task_01.binary.bin",
      updatedAt: Date.now(),
      bytes: 4,
    },
  ]);

  expect(readable.map((artifact) => artifact.label)).toEqual([
    "inventory.json",
    "task_01.summary.md",
  ]);
  expect(summarizeReadableTaskArtifacts(readable)).toBe("Mounted evidence artifacts: inventory.json, task_01.summary.md.");
});

test("factory task packets: readable artifacts prioritize evidence files ahead of packet metadata", async () => {
  const workspacePath = await tempDir("receipt-factory-readable-priority");
  const files = buildTaskFilePaths(workspacePath, "task_01", "synthesizing");
  const packetDir = path.dirname(files.manifestPath);
  const evidenceDir = path.join(packetDir, "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });

  await fs.writeFile(path.join(evidenceDir, "aws_s3_bucket_inventory.json"), "{\"buckets\":[]}", "utf-8");
  await fs.writeFile(path.join(packetDir, "task_01.evidence.json"), "{\"scriptsRun\":[]}", "utf-8");
  await fs.writeFile(files.contextPackPath, "{\"task\":{}}", "utf-8");
  await fs.writeFile(files.manifestPath, "{\"task\":{}}", "utf-8");

  const readable = await listTaskReadableArtifacts(workspacePath, [
    {
      path: files.contextPackPath,
      label: path.basename(files.contextPackPath),
      updatedAt: Date.now(),
      bytes: 12,
    },
    {
      path: files.manifestPath,
      label: path.basename(files.manifestPath),
      updatedAt: Date.now(),
      bytes: 12,
    },
    {
      path: path.join(packetDir, "task_01.evidence.json"),
      label: "task_01.evidence.json",
      updatedAt: Date.now(),
      bytes: 18,
    },
  ]);

  expect(readable.map((artifact) => artifact.label).slice(0, 3)).toEqual([
    "aws_s3_bucket_inventory.json",
    "task_01.evidence.json",
    "task_01.synthesizing.context-pack.json",
  ]);
});

test("factory task packets: context summary includes controller bootstrap seed and primary evidence path", () => {
  const summary = renderTaskContextSummary({
    objectiveId: "objective_demo",
    title: "Investigate CDN spend",
    prompt: "Find the spend driver.",
    objectiveMode: "investigation",
    severity: 1,
    contract: {
      acceptanceCriteria: ["Answer the investigation goal."],
      allowedScope: ["Use existing evidence."],
      disallowedScope: ["Make changes."],
      requiredChecks: ["Capture evidence."],
      proofExpectation: "Use evidence and conclude.",
    },
    profile: {
      rootProfileId: "infrastructure",
      rootProfileLabel: "Infrastructure",
    },
    task: {
      taskId: "task_01",
      title: "Investigate CDN spend",
      prompt: "Find the spend driver.",
      workerType: "codex",
      executionMode: "worktree",
      status: "running",
      taskPhase: "synthesizing",
      candidateId: "task_01_candidate_01",
    },
    integration: {
      status: "idle",
    },
    dependencyTree: [],
    relatedTasks: [],
    candidateLineage: [],
    recentReceipts: [],
    objectiveSlice: {
      frontierTasks: [],
      recentCompletedTasks: [],
      integrationTasks: [],
      recentObjectiveReceipts: [],
    },
    memory: {},
    investigation: {
      reports: [],
    },
    helperCatalog: {
      runnerPath: "/Users/kishore/receipt/skills/factory-helper-runtime/runner.py",
      selectedHelpers: [
        {
          id: "aws_cdn_charge_investigation",
          description: "Investigate CDN spend.",
          provider: "aws",
          examples: ["--days 7 --output-dir .receipt/factory/evidence"],
        },
      ],
    } as never,
    contextSources: {
      repoSharedMemoryScope: "factory/repo/shared",
      objectiveMemoryScope: "factory/objectives/objective_demo",
      integrationMemoryScope: "factory/objectives/objective_demo/integration",
      profileSkillRefs: ["skills/factory-infrastructure-aws/SKILL.md"],
      repoSkillPaths: [
        "/Users/kishore/receipt/skills/factory-receipt-worker/SKILL.md",
        "/Users/kishore/receipt/skills/factory-infrastructure-aws/SKILL.md",
      ],
      sharedArtifactRefs: [],
    },
  } as never, {
    mountedReadableArtifacts: [
      { path: "/tmp/.receipt/factory/evidence/aws_cdn_charge_investigation.json", label: "aws_cdn_charge_investigation.json", bytes: 128 },
    ],
  });

  expect(summary).toContain("Task Phase: synthesizing");
  expect(summary).toContain("## Bootstrap Seed");
  expect(summary).toContain("Controller precomputed this seed from the manifest, context pack, scoped memory, recent receipts, and mounted evidence.");
  expect(summary).toContain("Exact packet paths from the workspace root: .receipt/factory/task_01.context.md, .receipt/factory/task_01.context-pack.json, .receipt/factory/task_01.memory.cjs.");
  expect(summary).toContain("When joining packet-relative paths to the workspace root, do not prefix them with a leading slash.");
  expect(summary).toContain("Checked-in worker skill path: /Users/kishore/receipt/skills/factory-receipt-worker/SKILL.md.");
  expect(summary).toContain("Checked-in profile skill path: /Users/kishore/receipt/skills/factory-infrastructure-aws/SKILL.md.");
  expect(summary).toContain("Primary evidence path: inspect /tmp/.receipt/factory/evidence/aws_cdn_charge_investigation.json (aws_cdn_charge_investigation.json) before new external queries.");
  expect(summary).toContain("Stop condition: once one helper run or a small number of direct CLI calls answers the question, emit the final JSON immediately.");
  expect(summary).toContain("Synthesis reporting: if mounted evidence already answers the question, return final JSON directly and prefer report.evidenceRecords: [] over timestamp reconstruction.");
  expect(summary).toContain("Synthesis reporting: use mounted artifact paths and already-captured helper commands as proof; do not run timestamp-only bookkeeping commands.");
  expect(summary).toContain("- aws_cdn_charge_investigation.json: /tmp/.receipt/factory/evidence/aws_cdn_charge_investigation.json");
});

test("factory task packets: resource inventory bootstrap command follows the task scope instead of generic s3 defaults", () => {
  const summary = renderTaskContextSummary({
    objectiveId: "objective_rds",
    title: "RDS alarm closure",
    prompt: "Investigate the current RDS estate and alarm posture in the active AWS account.",
    objectiveMode: "investigation",
    severity: 1,
    contract: {
      acceptanceCriteria: ["Answer the investigation goal."],
      allowedScope: ["Use checked-in helpers first."],
      disallowedScope: ["Do unrelated work."],
      requiredChecks: ["Capture durable evidence."],
      proofExpectation: "Use evidence and conclude.",
    },
    profile: {
      rootProfileId: "infrastructure",
      rootProfileLabel: "Infrastructure",
    },
    task: {
      taskId: "task_01",
      title: "RDS alarm closure",
      prompt: "Inventory active RDS instances and clusters, correlate alarm state, and conclude whether any database or alarm condition currently needs attention.",
      workerType: "codex",
      executionMode: "worktree",
      status: "running",
      candidateId: "task_01_candidate_01",
    },
    integration: {
      status: "idle",
    },
    dependencyTree: [],
    relatedTasks: [],
    candidateLineage: [],
    recentReceipts: [],
    objectiveSlice: {
      frontierTasks: [],
      recentCompletedTasks: [],
      integrationTasks: [],
      recentObjectiveReceipts: [],
    },
    memory: {},
    investigation: {
      reports: [],
    },
    helperCatalog: {
      runnerPath: "/Users/kishore/receipt/skills/factory-helper-runtime/runner.py",
      selectedHelpers: [
        {
          id: "aws_resource_inventory",
          description: "List or count common AWS resources by service and resource type.",
          provider: "aws",
          examples: [
            "--service rds --resource db-instances --all-regions --output-dir .receipt/factory/evidence",
            "--service s3 --resource buckets --output-dir .receipt/factory/evidence",
          ],
        },
      ],
    } as never,
    contextSources: {
      repoSharedMemoryScope: "factory/repo/shared",
      objectiveMemoryScope: "factory/objectives/objective_rds",
      integrationMemoryScope: "factory/objectives/objective_rds/integration",
      profileSkillRefs: ["skills/factory-aws-cli-cookbook/SKILL.md"],
      repoSkillPaths: [
        "/Users/kishore/receipt/skills/factory-receipt-worker/SKILL.md",
        "/Users/kishore/receipt/skills/factory-aws-cli-cookbook/SKILL.md",
      ],
      sharedArtifactRefs: [],
    },
  } as never);

  expect(summary).toContain("Primary evidence path: run the selected helper aws_resource_inventory first.");
  expect(summary).toContain("Primary evidence command: python3 /Users/kishore/receipt/skills/factory-helper-runtime/runner.py run --provider aws --json aws_resource_inventory -- --service rds --resource db-instances --all-regions --output-dir .receipt/factory/evidence");
  expect(summary).not.toContain("--service s3 --resource buckets");
});

test("factory task packets: bootstrap seed picks the best matching helper instead of the first catalog hit", () => {
  const natSummary = renderTaskContextSummary({
    objectiveId: "objective_nat",
    title: "NAT vs EC2 egress attribution",
    prompt: "Investigate whether NAT gateway or EC2 egress is driving network spend.",
    objectiveMode: "investigation",
    severity: 1,
    contract: {
      acceptanceCriteria: ["Answer the investigation goal."],
      allowedScope: ["Use checked-in helpers first."],
      disallowedScope: ["Do unrelated work."],
      requiredChecks: ["Capture durable evidence."],
      proofExpectation: "Use evidence and conclude.",
    },
    profile: {
      rootProfileId: "infrastructure",
      rootProfileLabel: "Infrastructure",
    },
    task: {
      taskId: "task_01",
      title: "NAT vs EC2 egress attribution",
      prompt: "Determine whether NAT Gateway, EC2 transfer, or other network paths dominate egress cost.",
      workerType: "codex",
      executionMode: "worktree",
      status: "running",
      candidateId: "task_01_candidate_01",
    },
    integration: {
      status: "idle",
    },
    dependencyTree: [],
    relatedTasks: [],
    candidateLineage: [],
    recentReceipts: [],
    objectiveSlice: {
      frontierTasks: [],
      recentCompletedTasks: [],
      integrationTasks: [],
      recentObjectiveReceipts: [],
    },
    memory: {},
    investigation: {
      reports: [],
    },
    helperCatalog: {
      runnerPath: "/Users/kishore/receipt/skills/factory-helper-runtime/runner.py",
      selectedHelpers: [
        {
          id: "aws_s3_cost_spike",
          description: "Investigate S3 cost spikes.",
          provider: "aws",
          examples: ["--profile default --lookback-days 90 --output-dir .receipt/factory/evidence"],
        },
        {
          id: "nat_gateway_cost_spike",
          description: "Investigate NAT Gateway cost spikes.",
          provider: "aws",
          examples: ["--profile default --lookback-days 90 --output-dir .receipt/factory/evidence"],
        },
      ],
    } as never,
    contextSources: {
      repoSharedMemoryScope: "factory/repo/shared",
      objectiveMemoryScope: "factory/objectives/objective_nat",
      integrationMemoryScope: "factory/objectives/objective_nat/integration",
      profileSkillRefs: ["skills/factory-aws-cli-cookbook/SKILL.md"],
      repoSkillPaths: [
        "/Users/kishore/receipt/skills/factory-receipt-worker/SKILL.md",
        "/Users/kishore/receipt/skills/factory-aws-cli-cookbook/SKILL.md",
      ],
      sharedArtifactRefs: [],
    },
  } as never);

  expect(natSummary).toContain("Primary evidence path: run the selected helper nat_gateway_cost_spike first.");

  const rdsSummary = renderTaskContextSummary({
    objectiveId: "objective_rds_priority",
    title: "RDS backup and exposure posture",
    prompt: "Determine whether any RDS databases are public, whether backups are enabled, and whether alarm coverage exists.",
    objectiveMode: "investigation",
    severity: 1,
    contract: {
      acceptanceCriteria: ["Answer the investigation goal."],
      allowedScope: ["Use checked-in helpers first."],
      disallowedScope: ["Do unrelated work."],
      requiredChecks: ["Capture durable evidence."],
      proofExpectation: "Use evidence and conclude.",
    },
    profile: {
      rootProfileId: "infrastructure",
      rootProfileLabel: "Infrastructure",
    },
    task: {
      taskId: "task_01",
      title: "RDS backup and exposure posture",
      prompt: "Inspect RDS instances, backup retention, public accessibility, and alarm coverage.",
      workerType: "codex",
      executionMode: "worktree",
      status: "running",
      candidateId: "task_01_candidate_01",
    },
    integration: {
      status: "idle",
    },
    dependencyTree: [],
    relatedTasks: [],
    candidateLineage: [],
    recentReceipts: [],
    objectiveSlice: {
      frontierTasks: [],
      recentCompletedTasks: [],
      integrationTasks: [],
      recentObjectiveReceipts: [],
    },
    memory: {},
    investigation: {
      reports: [],
    },
    helperCatalog: {
      runnerPath: "/Users/kishore/receipt/skills/factory-helper-runtime/runner.py",
      selectedHelpers: [
        {
          id: "aws_alarm_summary",
          description: "Summarize CloudWatch alarms.",
          provider: "aws",
          examples: ["--all-regions --output-dir .receipt/factory/evidence"],
        },
        {
          id: "aws_resource_inventory",
          description: "List common AWS resources.",
          provider: "aws",
          examples: ["--service rds --resource db-instances --all-regions --output-dir .receipt/factory/evidence"],
        },
      ],
    } as never,
    contextSources: {
      repoSharedMemoryScope: "factory/repo/shared",
      objectiveMemoryScope: "factory/objectives/objective_rds_priority",
      integrationMemoryScope: "factory/objectives/objective_rds_priority/integration",
      profileSkillRefs: ["skills/factory-aws-cli-cookbook/SKILL.md"],
      repoSkillPaths: [
        "/Users/kishore/receipt/skills/factory-receipt-worker/SKILL.md",
        "/Users/kishore/receipt/skills/factory-aws-cli-cookbook/SKILL.md",
      ],
      sharedArtifactRefs: [],
    },
  } as never);

  expect(rdsSummary).toContain("Primary evidence path: run the selected helper aws_resource_inventory first.");
  expect(rdsSummary).not.toContain("Primary evidence path: run the selected helper aws_alarm_summary first.");
});
