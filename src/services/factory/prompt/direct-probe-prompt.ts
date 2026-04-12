import type { FactoryObjectivePhase, FactoryObjectiveStatus } from "../../../modules/factory";
import type { FactoryCloudExecutionContext } from "../../factory-cloud-context";
import type { FactoryChatCodexArtifactPaths } from "../../factory-codex-artifacts";
import {
  renderFactoryHelperPromptSection,
  type FactoryHelperContext,
} from "../../factory-helper-catalog";
import type {
  FactoryObjectiveCard,
  FactoryObjectiveReceiptSummary,
} from "../../factory-types";

const objectiveStream = (objectiveId: string): string => `factory/objectives/${objectiveId}`;
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const renderFactoryDirectCodexProbePrompt = (input: {
  readonly prompt: string;
  readonly readOnly: boolean;
  readonly artifactPaths: FactoryChatCodexArtifactPaths;
  readonly objective?: {
    readonly objectiveId: string;
    readonly title: string;
    readonly status: FactoryObjectiveStatus;
    readonly phase: FactoryObjectivePhase;
    readonly latestDecision?: FactoryObjectiveCard["latestDecision"];
    readonly blockedExplanation?: FactoryObjectiveCard["blockedExplanation"];
  };
  readonly cloudExecutionContext: FactoryCloudExecutionContext;
  readonly helperCatalog?: FactoryHelperContext;
  readonly repoSkillPaths: ReadonlyArray<string>;
  readonly recentReceipts: ReadonlyArray<FactoryObjectiveReceiptSummary>;
  readonly profileSelectedSkills: ReadonlyArray<string>;
  readonly repoRoot: string;
  readonly factoryCliPrefix: string;
}): string => {
  const objectiveStreamRef = input.objective ? objectiveStream(input.objective.objectiveId) : undefined;
  return [
    `# Factory Direct Codex Probe`,
    ``,
    `Mode: ${input.readOnly ? "read-only probe" : "workspace-write"}`,
    `Workspace: ${input.repoRoot}`,
    ``,
    `## Operator Request`,
    input.prompt,
    ``,
    `## Probe Tactics`,
    `Start with a short internal plan. If the operator named a file, artifact, receipt, helper, or run, inspect that exact target before broader repo search or memory expansion.`,
    `If you use subagents, keep them as bounded sidecars and restate the probe context plus the exact artifact or question they own.`,
    `A pair of independent sidecars may run in parallel only when the probe cleanly decomposes and neither sidecar blocks the other.`,
    `Do not parallelize broad repo exploration when one named artifact or one primary evidence path can answer the request.`,
    ``,
    `## Read-Only Contract`,
    input.readOnly
      ? `This Codex run is read-only. Inspect receipts, memory, files, and logs, but do not modify tracked files or generate patches. If code changes are required, explain the change and say that Factory must create or react an objective/worktree run.`
      : `This Codex run may edit the workspace.`,
    ``,
    `## Live Cloud Context`,
    input.cloudExecutionContext.summary,
    ...input.cloudExecutionContext.guidance.map((item) => `- ${item}`),
    ``,
    ...renderFactoryHelperPromptSection(input.helperCatalog),
    `## Bootstrap Context`,
    input.objective
      ? `Treat the prompt as bootstrap only. Read AGENTS.md and skills/factory-receipt-worker/SKILL.md before making claims about what context is available.`
      : `Treat the prompt as bootstrap only. Use the packet files, repo files, and memory script first. This direct probe is not a Factory task worktree and does not require Factory worker bootstrap commands.`,
    `Current packet files:`,
    `- Manifest: ${input.artifactPaths.manifestPath}`,
    `- Context Pack: ${input.artifactPaths.contextPackPath}`,
    `- Memory Script: ${input.artifactPaths.memoryScriptPath}`,
    `- Memory Config: ${input.artifactPaths.memoryConfigPath}`,
    `- Result Path: ${input.artifactPaths.resultPath}`,
    `- Prompt Path: ${input.artifactPaths.promptPath}`,
    ``,
    `## Objective-First Query Order`,
    `1. Packet files in this artifact directory`,
    input.objective ? `2. Current objective receipts and debug panels for ${input.objective.objectiveId}` : `2. Repo files/search in the current checkout`,
    `3. Scoped memory through the generated memory script`,
    `4. Broader history only if the packet or current objective explicitly points to it`,
    ``,
    input.objective ? `## Current Objective` : `## Current Context`,
    input.objective
      ? [
          `- Objective: ${input.objective.title} (${input.objective.objectiveId})`,
          `- Status: ${input.objective.status}`,
          `- Phase: ${input.objective.phase}`,
          input.objective.latestDecision ? `- Latest decision: ${input.objective.latestDecision.summary}` : "",
          input.objective.blockedExplanation ? `- Blocked explanation: ${input.objective.blockedExplanation.summary}` : "",
          `- If the packet and memory script are still insufficient, inspect the objective sequentially (not in parallel):`,
          `- ${input.factoryCliPrefix} factory inspect ${shellQuote(input.objective.objectiveId)} --json --panel receipts`,
          `- ${input.factoryCliPrefix} factory inspect ${shellQuote(input.objective.objectiveId)} --json --panel debug`,
          objectiveStreamRef ? `- ${input.factoryCliPrefix} inspect ${shellQuote(objectiveStreamRef)}` : "",
          objectiveStreamRef ? `- ${input.factoryCliPrefix} trace ${shellQuote(objectiveStreamRef)}` : "",
        ].filter(Boolean).join("\n")
      : [
          `- Use the packet, repo files, and memory first. This probe is not a Factory objective and should not call the objective inspect commands.`,
          `- Do not assume skills/factory-receipt-worker/SKILL.md applies unless a real objectiveId is present.`,
          `- Use current repo search/read results before escalating to broader receipt history.`,
        ].join("\n"),
    ``,
    `## Memory Access`,
    `Use the layered memory script at ${input.artifactPaths.memoryScriptPath} instead of pulling large raw memory dumps.`,
    `Recommended commands:`,
    `- bun ${input.artifactPaths.memoryScriptPath} context 2800`,
    `- bun ${input.artifactPaths.memoryScriptPath} objective 1800`,
    `- bun ${input.artifactPaths.memoryScriptPath} overview ${JSON.stringify(input.prompt)} 2400`,
    `- bun ${input.artifactPaths.memoryScriptPath} scope repo ${JSON.stringify(input.prompt)} 1400`,
    `- bun ${input.artifactPaths.memoryScriptPath} scope profile ${JSON.stringify(input.prompt)} 1400`,
    `- bun ${input.artifactPaths.memoryScriptPath} search repo ${JSON.stringify(input.prompt)} 6`,
    ...(input.readOnly ? [] : [`- bun ${input.artifactPaths.memoryScriptPath} commit worker "short durable note"`]),
    ``,
    `## Repo Skills`,
    `Profile-selected skills:`,
    (input.profileSelectedSkills ?? []).map((skill) => `- ${skill}`).join("\n") || "- none",
    `Repo skill artifacts:`,
    input.repoSkillPaths.map((skill) => `- ${skill}`).join("\n") || "- none",
    `If a repo skill covers execution landscape, permissions, or infrastructure guardrails, read it before issuing AWS, IaC, or fleet-wide commands.`,
    ``,
    `## Recent Receipt Evidence`,
    input.recentReceipts.map((receipt) => `- ${receipt.type}: ${receipt.summary}`).join("\n") || "- none",
    ``,
    `## Delivery Boundary`,
    `Use this probe to inspect, summarize, and recommend. If implementation work is needed, say so explicitly and point the parent back to factory.dispatch.`,
  ].join("\n");
};
