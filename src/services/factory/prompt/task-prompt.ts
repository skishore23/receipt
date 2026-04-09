import type {
  FactoryObjectiveContractRecord,
  FactoryPlanningReceiptRecord,
  FactoryState,
  FactoryTaskRecord,
} from "../../../modules/factory";
import type { FactoryCloudExecutionContext } from "../../factory-cloud-context";
import {
  renderFactoryHelperPromptSection,
  type FactoryHelperContext,
} from "../../factory-helper-catalog";
import type { FactoryTaskJobPayload } from "../../factory-types";
import { renderPlanningReceiptLines } from "../planning";

const renderTaskPromptBody = (input: {
  readonly state: FactoryState;
  readonly task: FactoryTaskRecord;
  readonly payload: FactoryTaskJobPayload;
  readonly taskPrompt: string;
  readonly planningReceipt: FactoryPlanningReceiptRecord;
  readonly objectiveContract: FactoryObjectiveContractRecord;
  readonly cloudExecutionContext?: FactoryCloudExecutionContext;
  readonly helperCatalog?: FactoryHelperContext;
  readonly infrastructureTaskGuidance: ReadonlyArray<string>;
  readonly dependencySummaries: string;
  readonly downstreamSummaries: string;
  readonly memorySummary?: string;
  readonly validationSection: ReadonlyArray<string>;
  readonly manifestPathForPrompt: string;
  readonly contextSummaryPathForPrompt?: string;
  readonly contextPackPathForPrompt: string;
  readonly memoryScriptPathForPrompt: string;
  readonly receiptCliPathForPrompt: string;
  readonly resultPathForPrompt: string;
  readonly liveGuidanceSection?: string;
  readonly factoryCliPrefix: string;
}): string[] => {
  const bootstrapTargets = [
    `AGENTS.md and skills/factory-receipt-worker/SKILL.md`,
    `Manifest: ${input.manifestPathForPrompt}`,
    `Context Pack: ${input.contextPackPathForPrompt}`,
    `Memory Script: ${input.memoryScriptPathForPrompt}`,
    `Receipt CLI Surface: ${input.receiptCliPathForPrompt}`,
    ...(input.contextSummaryPathForPrompt
      ? [`Task Context Summary (quick overview derived from the packet): ${input.contextSummaryPathForPrompt}`]
      : []),
    `Repo skills from the manifest, especially any execution or permissions landscape notes`,
  ];
  const cloudContextSection = input.cloudExecutionContext
    ? [
        `## Live Cloud Context`,
        input.cloudExecutionContext.summary,
        ...input.cloudExecutionContext.guidance.map((item) => `- ${item}`),
        ``,
      ]
    : [];
  return [
    `# Factory Task`,
    ``,
    `Objective: ${input.state.title}`,
    `Objective ID: ${input.state.objectiveId}`,
    `Objective Mode: ${input.state.objectiveMode}`,
    `Severity: ${input.state.severity}`,
    `Task ID: ${input.task.taskId}`,
    `Worker Type: ${input.task.workerType}`,
    `Task Runtime: ${input.payload.executionMode}`,
    `Profile: ${input.payload.profile.rootProfileLabel} (${input.payload.profile.rootProfileId})`,
    `Profile Cloud Provider: ${input.payload.profile.cloudProvider ?? "unspecified"}`,
    `Base Commit: ${input.payload.baseCommit}`,
    `Candidate ID: ${input.payload.candidateId}`,
    ``,
    `## Objective Prompt`,
    input.state.prompt,
    ``,
    `## Task Prompt`,
    input.taskPrompt,
    ``,
    `## Objective Contract`,
    `Acceptance criteria:`,
    input.objectiveContract.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- none",
    `Allowed scope:`,
    input.objectiveContract.allowedScope.map((item) => `- ${item}`).join("\n") || "- none",
    `Disallowed scope:`,
    input.objectiveContract.disallowedScope.map((item) => `- ${item}`).join("\n") || "- none",
    `Required checks:`,
    input.objectiveContract.requiredChecks.map((item) => `- ${item}`).join("\n") || "- none",
    `Proof expectation: ${input.objectiveContract.proofExpectation}`,
    ``,
    ...renderPlanningReceiptLines(input.planningReceipt),
    ``,
    `## Dependencies`,
    input.dependencySummaries,
    ``,
    `## Task Boundary`,
    `Complete only ${input.task.taskId}. Do not absorb downstream work that already belongs to other planned tasks unless a tiny unblock is strictly required.`,
    `Downstream tasks already queued in this objective:`,
    input.downstreamSummaries,
    `If you notice adjacent copy, validation, or follow-up work outside this task's scope, mention it in the final result instead of implementing it here.`,
    ``,
    `## Investigation Contract`,
    input.state.objectiveMode === "investigation"
      ? `This objective is investigation-first. Answer the question as fast as possible with the least tooling.`
      : `This objective is delivery-oriented. Prefer tracked repo changes and keep investigation folded into the implementation task.`,
    ...(input.state.objectiveMode === "investigation"
      ? [
          ``,
          `### Proportionality Ladder (follow in strict order)`,
          `1. Run a matching checked-in helper if one exists. A single helper run that answers the question is the ideal outcome.`,
          `2. If no helper matches, run the raw CLI commands directly (e.g. \`aws ecs list-clusters\`, \`kubectl get pods\`). Two or three CLI calls that answer the question is fine. Produce your result JSON immediately after.`,
          `3. Only extend or create a checked-in helper when the task prompt explicitly asks for reusable tooling or when the same query pattern has failed before. Never build a new helper just to answer a one-off question.`,
          `4. If you have evidence (helper output, CLI output, or artifacts), stop gathering and synthesize your final JSON. Do not refine, re-run, or polish.`,
          ``,
          `### Investigation Budget`,
          `You have a limited output budget. Reserve at least 30% for your final structured JSON result.`,
          `If you have run more than 5 commands without producing evidence, you are over-engineering. Stop and answer with what you have.`,
          `If evidence artifacts exist in the evidence directory, your only remaining job is to synthesize the final JSON.`,
          ``,
          `### Investigation Quality`,
          `Interpret command and script outputs in plain language. Do not just paste logs.`,
          `Do not convert a failed query, denied API, or helper error into "zero results". If a primary evidence path errors or stays incomplete, record that command as warning/error and use outcome "partial" or "blocked" instead of "approved".`,
          `Make a short internal plan before the first tool: name the concrete question, the primary evidence path, the stop condition, and the one follow-up check that would change your answer.`,
        ]
      : [
          `A non-validation task is expected to leave a tracked repo diff unless you are hard blocked.`,
          `Capture implementation and validation results precisely in the final JSON result.`,
          `If validation or evidence collection fails, report the failure directly instead of inferring success from missing output.`,
        ]),
    ``,
    `## Execution Discipline`,
    `Do not run \`${input.factoryCliPrefix} factory promote\`, \`git push\`, or \`gh pr create\` from this task session.`,
    `The controller handles integration and PR publication after an approved candidate. If the objective prompt mentions publishing, satisfy it here by leaving a clean candidate diff plus proof for the controller handoff.`,
    `Tool discipline: emit at most one tool call in each response, then wait for that tool result before issuing the next call. If you need several nearby packet or repo reads, combine them into one shell command instead of batching separate tool calls.`,
    `Use Codex subagents only for bounded sidecar work such as parsing a captured artifact, checking one secondary evidence path, or verifying a concrete claim.`,
    `Keep this task session as the single owner of the final JSON result. Any delegated ask must restate the objective ID, task ID, candidate ID, and exact artifact or question it owns.`,
    `Do not fan out broad parallel exploration when one primary evidence path is already producing enough signal to finish the task.`,
    input.cloudExecutionContext?.preferredProvider
      ? `Local execution context already indicates ${input.cloudExecutionContext.preferredProvider}. Use that provider and its mounted scope by default unless the objective explicitly contradicts it.`
      : `If the local execution context clearly indicates one provider/profile/account, use it instead of asking the user to restate it.`,
    `Do not emit commentary-style progress updates in this child session.`,
    `Never print or persist raw secret, token, password, API key, or credential values in stdout, stderr, artifacts, or the final JSON. Report presence, source, and impact, but redact the value itself.`,
    ``,
    ...(input.infrastructureTaskGuidance.length > 0 ? [...input.infrastructureTaskGuidance, ``] : []),
    ...renderFactoryHelperPromptSection(input.helperCatalog),
    ...cloudContextSection,
    ...input.validationSection,
    ``,
    `## Bootstrap Context`,
    `The prompt is bootstrap only. Follow the checked-in worker bootstrap order: manifest, context pack, then memory script.`,
    `Use the task context summary as a quick overview after the packet, not as a replacement for it.`,
    `The JSON context pack is part of the primary worker interface. Use it whenever you need exact raw fields, refs, or artifact paths.`,
    `Read, in order:`,
    ...bootstrapTargets.map((item, index) => `${index + 1}. ${item}`),
    `Mounted profile skills for this task:`,
    input.payload.profile.selectedSkills.map((skillPath) => `- ${skillPath}`).join("\n") || "- none",
    `Use only the checked-in repo skills named in this packet. Do not load unrelated global skills from ~/.codex or other home-directory skill folders unless this packet explicitly names them.`,
    `Use the generated Receipt CLI surface at ${input.receiptCliPathForPrompt} before ad-hoc \`${input.factoryCliPrefix} ...\` commands.`,
    `Read any mounted infrastructure or cloud profile skill before provider-sensitive commands.`,
    input.payload.executionMode === "worktree"
      ? `Do not call \`${input.factoryCliPrefix} factory inspect\` from inside this task worktree. The packet already mounts recent objective receipts and state, and worktree-side inspect can fail on receipt lock files outside the workspace.`
      : `This task runs in an isolated runtime directory, not a git worktree. Treat repo edits as out of scope unless the controller explicitly reroutes the task into a repo-writing profile.`,
    input.payload.executionMode === "worktree"
      ? `If the packet and memory script are still insufficient, say which evidence is missing in the result instead of probing live objective state from the task worktree.`
      : `If the packet and memory script are still insufficient, say which evidence is missing in the result instead of probing live objective state from the isolated runtime.`,
    ``,
    `## Memory Access`,
    `Use the layered memory script at ${input.memoryScriptPathForPrompt} instead of raw memory dumps.`,
    `Recommended commands:`,
    `- bun ${input.memoryScriptPathForPrompt} context 2800`,
    `- bun ${input.memoryScriptPathForPrompt} objective 1800`,
    `- bun ${input.memoryScriptPathForPrompt} scope task "${input.task.title}" 1400`,
    `- bun ${input.memoryScriptPathForPrompt} search repo "${input.task.title}" 6`,
    `Only write a durable memory note after gathering evidence from the packet, receipts, or repo files.`,
    ``,
    ...(input.liveGuidanceSection ? [input.liveGuidanceSection] : []),
    `## Result Contract`,
    `Return exactly one JSON object matching this schema:`,
    `Write JSON to ${input.resultPathForPrompt} with:`,
    input.state.objectiveMode === "investigation"
      ? `{ "outcome": "approved" | "changes_requested" | "blocked" | "partial", "summary": string, "handoff": string | null, "presentation": { "kind": "inline" | "artifacts" | "investigation_report" | "generic", "inlineBody": string | null, "primaryArtifactLabels": string[] | null, "renderHint": "table" | "report" | "list" | "generic" }, "artifacts": [{ "label": string, "path": string | null, "summary": string | null }], "completion": { "changed": string[], "proof": string[], "remaining": string[] }, "nextAction": string | null, "report": { "conclusion": string, "evidence": [{ "title": string, "summary": string, "detail": string | null }], "evidenceRecords": [{ "objective_id": string, "task_id": string, "timestamp": number, "tool_name": string, "command_or_api": string, "inputs": [{ "key": string, "value": string | number | boolean | null }], "outputs": [{ "key": string, "value": string | number | boolean | null }], "summary_metrics": [{ "key": string, "value": string | number | boolean | null }] }], "scriptsRun": [{ "command": string, "summary": string | null, "status": "ok" | "warning" | "error" | null }], "disagreements": string[], "nextSteps": string[] } | null }`
      : `{ "outcome": "approved" | "changes_requested" | "blocked" | "partial", "summary": string, "handoff": string | null, "presentation": { "kind": "inline" | "artifacts" | "investigation_report" | "generic", "inlineBody": string | null, "primaryArtifactLabels": string[] | null, "renderHint": "table" | "report" | "list" | "generic" }, "artifacts": [{ "label": string, "path": string | null, "summary": string | null }], "scriptsRun": [{ "command": string, "summary": string | null, "status": "ok" | "warning" | "error" | null }], "completion": { "changed": string[], "proof": string[], "remaining": string[] }, "alignment": { "verdict": "aligned" | "uncertain" | "drifted", "satisfied": string[], "missing": string[], "outOfScope": string[], "rationale": string }, "nextAction": string | null }`,
    `Do not write this file yourself.`,
    `Do not write ${input.resultPathForPrompt} yourself. Return exactly that JSON object as your final response and the runtime will persist it there.`,
    `Use presentation to tell the orchestrator how to render the terminal result. Keep summary short and operational rather than chat-ready prose.`,
    `If you want to keep a richer markdown or JSON report, write it as a task artifact and reference it from artifacts. The final response itself must stay strict JSON.`,
    `Use "changes_requested" only when more work is clearly needed; use "blocked" only for a hard blocker; use "partial" when you produced meaningful evidence but could not fully finish.`,
    input.state.objectiveMode === "investigation"
      ? `For investigation tasks, keep "partial" when primary evidence or access stayed incomplete even after good-faith evidence collection.`
      : `For delivery tasks, the controller reruns configured repo checks and ignores worktree-local .receipt artifacts. Do not use "partial" solely because .receipt cleanup or terminal output capture was noisy after the requested code change and proof were completed.`,
    `Before you return final JSON, sanity-check that report.scriptsRun statuses match the actual command outcomes and that any artifact-level errors are reflected in outcome, summary, or next steps.`,
    input.state.objectiveMode === "investigation"
      ? `For investigation tasks, always include the report key and presentation. Use a report object whenever you gathered meaningful evidence; otherwise use null. Always include report.evidenceRecords, even when it is an empty array. Always include completion with changed, proof, and remaining arrays. Use [] for empty lists and null for detail, summary, status, nextAction, handoff, or report when they do not apply. Legacy handoff is still read during migration, but presentation is the primary contract.`
      : `For delivery tasks, keep the envelope small. Always include presentation, scriptsRun, completion, and alignment. Use the alignment block to map the result back to the objective contract before you return final JSON. Legacy handoff is still read during migration, but presentation is the primary contract.`,
    ``,
    `## Starting Hint`,
    input.memorySummary || "No durable task memory yet.",
  ];
};

export const renderFactoryTaskPrompt = (input: {
  readonly state: FactoryState;
  readonly task: FactoryTaskRecord;
  readonly payload: FactoryTaskJobPayload;
  readonly taskPrompt: string;
  readonly planningReceipt: FactoryPlanningReceiptRecord;
  readonly objectiveContract: FactoryObjectiveContractRecord;
  readonly cloudExecutionContext?: FactoryCloudExecutionContext;
  readonly helperCatalog?: FactoryHelperContext;
  readonly infrastructureTaskGuidance: ReadonlyArray<string>;
  readonly dependencySummaries: string;
  readonly downstreamSummaries: string;
  readonly memorySummary?: string;
  readonly validationSection: ReadonlyArray<string>;
  readonly manifestPathForPrompt: string;
  readonly contextSummaryPathForPrompt?: string;
  readonly contextPackPathForPrompt: string;
  readonly memoryScriptPathForPrompt: string;
  readonly receiptCliPathForPrompt: string;
  readonly resultPathForPrompt: string;
  readonly liveGuidanceSection?: string;
  readonly factoryCliPrefix: string;
}): string => renderTaskPromptBody(input).join("\n");
