import { test, expect } from "bun:test";
import fs from "node:fs/promises";

test("factory context instructions: repo AGENTS bootstrap workers from the packet and receipt surfaces", async () => {
  const body = await fs.readFile(new URL("../../AGENTS.md", import.meta.url), "utf-8");

  expect(body).toContain("skills/factory-receipt-worker/SKILL.md");
  expect(body).toContain(".receipt/factory/<taskId>.manifest.json");
  expect(body).toContain(".receipt/factory/<taskId>.context-pack.json");
  expect(body).toContain(".receipt/factory/<taskId>.memory.cjs");
  expect(body).toContain("receipt factory inspect <objectiveId> --json --panel debug");
  expect(body).toContain("receipt factory inspect <objectiveId> --json --panel receipts");
  expect(body).toContain("Do not assume direct access to:");
});

test("factory context instructions: checked-in skill covers commands, memory scopes, and failure review", async () => {
  const skill = await fs.readFile(new URL("../../skills/factory-receipt-worker/SKILL.md", import.meta.url), "utf-8");
  const commands = await fs.readFile(new URL("../../skills/factory-receipt-worker/references/command-recipes.md", import.meta.url), "utf-8");
  const scopes = await fs.readFile(new URL("../../skills/factory-receipt-worker/references/memory-scopes.md", import.meta.url), "utf-8");
  const failures = await fs.readFile(new URL("../../skills/factory-receipt-worker/references/failure-review.md", import.meta.url), "utf-8");

  expect(skill).toContain("Treat the worktree packet and receipt surfaces as the primary worker context.");
  expect(skill).toContain("references/command-recipes.md");
  expect(commands).toContain("receipt inspect factory/objectives/<objectiveId>");
  expect(commands).toContain("receipt memory summarize factory/objectives/<objectiveId>/candidates/<candidateId>");
  expect(scopes).toContain("factory/objectives/<objectiveId>/integration");
  expect(failures).toContain("Call a failure inherited only when");
  expect(failures).toContain("Do not call a failure inherited when:");
});
