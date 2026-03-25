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

test("factory helper runtime skills: document helper-first execution and ship seeded AWS helpers", async () => {
  const runtimeSkill = await fs.readFile(new URL("../../skills/factory-helper-runtime/SKILL.md", import.meta.url), "utf-8");
  const authoringSkill = await fs.readFile(new URL("../../skills/factory-helper-authoring/SKILL.md", import.meta.url), "utf-8");
  const cookbookSkill = await fs.readFile(new URL("../../skills/factory-aws-cli-cookbook/SKILL.md", import.meta.url), "utf-8");
  const runner = await fs.readFile(new URL("../../skills/factory-helper-runtime/runner.py", import.meta.url), "utf-8");
  const accountManifest = JSON.parse(await fs.readFile(new URL("../../skills/factory-helper-runtime/catalog/infrastructure/aws_account_scope/manifest.json", import.meta.url), "utf-8")) as {
    readonly id?: string;
    readonly provider?: string;
    readonly entrypoint?: string;
  };
  const inventoryManifest = JSON.parse(await fs.readFile(new URL("../../skills/factory-helper-runtime/catalog/infrastructure/aws_resource_inventory/manifest.json", import.meta.url), "utf-8")) as {
    readonly id?: string;
    readonly tags?: ReadonlyArray<string>;
  };
  const skill = await fs.readFile(new URL("../../skills/factory-infrastructure-aws/SKILL.md", import.meta.url), "utf-8");

  expect(runtimeSkill).toContain("Prefer a checked-in helper over a new `.receipt/factory/*.sh` script.");
  expect(runtimeSkill).toContain("python3 skills/factory-helper-runtime/runner.py run --provider aws --json aws_account_scope");
  expect(authoringSkill).toContain("catalog/<domain>/<helper_id>/");
  expect(authoringSkill).toContain("Emit the canonical result envelope");
  expect(cookbookSkill).toContain("aws sts get-caller-identity --output json");
  expect(cookbookSkill).toContain("aws <service> <operation> help");
  expect(runner).toContain("Factory helper runner");
  expect(accountManifest.id).toBe("aws_account_scope");
  expect(accountManifest.provider).toBe("aws");
  expect(accountManifest.entrypoint).toBe("run.py");
  expect(inventoryManifest.id).toBe("aws_resource_inventory");
  expect(inventoryManifest.tags).toContain("buckets");
  expect(skill).toContain("cloudExecutionContext.aws.ec2RegionScope");
  expect(skill).toContain("checked-in helper catalog");
  expect(skill).toContain("Skip `not-opted-in` regions");
  expect(skill).toContain("Distinguish account-level AWS access failures from per-service IAM denials.");
  expect(skill).toContain("capture exact `AccessDenied` errors per service and continue collecting evidence");
  expect(skill).toContain("return a final investigation report that says the inventory is incomplete due to permissions");
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
