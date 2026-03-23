import { test, expect } from "bun:test";
import fs from "node:fs/promises";

test("factory context instructions: repo AGENTS bootstrap workers from the packet and receipt surfaces", async () => {
  const body = await fs.readFile(new URL("../../AGENTS.md", import.meta.url), "utf-8");

  expect(body).toContain("skills/factory-receipt-worker/SKILL.md");
  expect(body).toContain(".receipt/factory/<taskId>.manifest.json");
  expect(body).toContain(".receipt/factory/<taskId>.context-pack.json");
  expect(body).toContain(".receipt/factory/<taskId>.memory.cjs");
  expect(body).toContain("Do not call `receipt factory inspect` from inside a task worktree by default.");
  expect(body).toContain("Do not assume direct access to:");
});

test("factory context instructions: checked-in skill covers commands, memory scopes, and failure review", async () => {
  const skill = await fs.readFile(new URL("../../skills/factory-receipt-worker/SKILL.md", import.meta.url), "utf-8");
  const commands = await fs.readFile(new URL("../../skills/factory-receipt-worker/references/command-recipes.md", import.meta.url), "utf-8");
  const scopes = await fs.readFile(new URL("../../skills/factory-receipt-worker/references/memory-scopes.md", import.meta.url), "utf-8");
  const failures = await fs.readFile(new URL("../../skills/factory-receipt-worker/references/failure-review.md", import.meta.url), "utf-8");

  expect(skill).toContain("Treat the worktree packet and receipt surfaces as the primary worker context.");
  expect(skill).toContain("Do not run `receipt factory inspect` from inside a task worktree");
  expect(skill).toContain("references/command-recipes.md");
  expect(commands).toContain("receipt inspect factory/objectives/<objectiveId>");
  expect(commands).toContain("Do not call `receipt factory inspect` from inside a task worktree by default.");
  expect(commands).toContain("receipt memory summarize factory/objectives/<objectiveId>/candidates/<candidateId>");
  expect(scopes).toContain("factory/objectives/<objectiveId>/integration");
  expect(failures).toContain("Call a failure inherited only when");
  expect(failures).toContain("Do not call a failure inherited when:");
});

test("factory infrastructure aws skill: documents region-aware account scope handling and ships a reusable helper", async () => {
  const skill = await fs.readFile(new URL("../../skills/factory-infrastructure-aws/SKILL.md", import.meta.url), "utf-8");
  const helper = await fs.readFile(new URL("../../skills/factory-infrastructure-aws/scripts/aws-account-scope.sh", import.meta.url), "utf-8");

  expect(skill).toContain("cloudExecutionContext.aws.ec2RegionScope");
  expect(skill).toContain("scripts/aws-account-scope.sh");
  expect(skill).toContain("Skip `not-opted-in` regions");
  expect(helper).toContain("aws sts get-caller-identity");
  expect(helper).toContain("describe-regions --all-regions");
  expect(helper).toContain("\"ec2RegionScope\"");
});

test("factory orchestration docs and skills: profiles stay orchestration-only and decisions stay receipt-aware", async () => {
  const profileDoc = await fs.readFile(new URL("../../docs/factory-profile-orchestration.md", import.meta.url), "utf-8");
  const agentDoc = await fs.readFile(new URL("../../docs/factory-agent-orchestration.md", import.meta.url), "utf-8");
  const orchestratorSkill = await fs.readFile(new URL("../../skills/factory-run-orchestrator/SKILL.md", import.meta.url), "utf-8");
  const orchestratorPrompt = await fs.readFile(new URL("../../prompts/factory/orchestrator.md", import.meta.url), "utf-8");

  expect(profileDoc).toContain("Legacy `repo.read` and `repo.write` capabilities are rejected.");
  expect(profileDoc).toContain("codex.logs");
  expect(profileDoc).toContain("factory.output");
  expect(profileDoc).toContain("factory.receipts");
  expect(profileDoc).toContain("read-only probe");
  expect(agentDoc).toContain("`codex.run` in Factory chat is now a read-only probe");
  expect(agentDoc).toContain("hand it back to `factory.dispatch`");
  expect(orchestratorSkill).toContain("factory.receipts");
  expect(orchestratorSkill).toContain("factory.output");
  expect(orchestratorSkill).toContain("codex.logs");
  expect(orchestratorSkill).toContain("read-only probe");
  expect(orchestratorPrompt).toContain("Ground the choice in the provided receipts, evidence cards, active jobs, and current objective state.");
  expect(orchestratorPrompt).toContain("Prefer existing active or queued work over duplicate dispatch.");
});
