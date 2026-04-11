import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { sqliteBranchStore, sqliteReceiptStore } from "../../src/adapters/sqlite";
import { sqliteQueue, type QueueJob } from "../../src/adapters/sqlite-queue";
import { createRuntime } from "@receipt/core/runtime";
import { SseHub } from "../../src/framework/sse-hub";
import {
  DEFAULT_FACTORY_OBJECTIVE_PROFILE,
  initialFactoryState,
  normalizeFactoryObjectivePolicy,
  reduceFactory,
  type FactoryEvent,
  type FactoryState,
} from "../../src/modules/factory";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job";
import {
  FactoryService,
  type FactoryIntegrationJobPayload,
  type FactoryIntegrationPublishJobPayload,
  type FactoryTaskJobPayload,
} from "../../src/services/factory-service";

const execFileAsync = promisify(execFile);
const FACTORY_POLICY_TIMEOUT_MS = 120_000;

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
};

const createSourceRepo = async (): Promise<string> => {
  const repoDir = await createTempDir("receipt-factory-policy-source");
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "Factory Policy Test"]);
  await git(repoDir, ["config", "user.email", "factory-policy@example.com"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "# factory policy test\n", "utf-8");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["branch", "-M", "main"]);
  return repoDir;
};

const runObjectiveStartup = async (service: FactoryService, objectiveId: string): Promise<void> => {
  await service.runObjectiveControl({
    kind: "factory.objective.control",
    objectiveId,
    reason: "startup",
  });
};

const createJobRuntime = (dataDir: string) =>
  createRuntime<JobCmd, JobEvent, JobState>(
    sqliteReceiptStore<JobEvent>(dataDir),
    sqliteBranchStore(dataDir),
    decideJob,
    reduceJob,
    initialJob,
  );

const latestFactoryJob = async (
  queue: ReturnType<typeof sqliteQueue>,
  objectiveId: string,
  kind: "factory.task.run" | "factory.integration.validate" | "factory.integration.publish",
): Promise<QueueJob> => {
  const jobs = await queue.listJobs({ limit: 40 });
  const match = jobs
    .filter((job) => job.payload.kind === kind && job.payload.objectiveId === objectiveId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  expect(match).toBeTruthy();
  return match;
};

const createFactoryService = async (opts?: {
  readonly codexOutcome?: "approved" | "changes_requested" | "blocked" | "partial";
  readonly publishMode?: "success" | "missing_metadata" | "blocked" | "error" | "transient_then_success";
  readonly completionRemaining?: ReadonlyArray<string>;
  readonly alignment?: {
    readonly verdict?: "aligned" | "uncertain" | "drifted";
    readonly satisfied?: ReadonlyArray<string>;
    readonly missing?: ReadonlyArray<string>;
    readonly outOfScope?: ReadonlyArray<string>;
    readonly rationale?: string;
  };
}): Promise<{
  readonly service: FactoryService;
  readonly queue: ReturnType<typeof sqliteQueue>;
  readonly repoRoot: string;
  readonly publishRuns: { count: number };
}> => {
  const dataDir = await createTempDir("receipt-factory-policy");
  const repoRoot = await createSourceRepo();
  const queue = sqliteQueue({ runtime: createJobRuntime(dataDir), stream: "jobs" });
  const codexOutcome = opts?.codexOutcome ?? "approved";
  const publishMode = opts?.publishMode ?? "success";
  const completionRemaining = opts?.completionRemaining ?? [];
  const defaultAlignment = {
    verdict: "aligned" as const,
    satisfied: [
      "Implemented the requested delivery change.",
      completionRemaining.length === 0
        ? "Left no remaining delivery work in completion.remaining."
        : "Returned the requested delivery result so policy tests can exercise non-alignment gates explicitly.",
    ],
    missing: [] as string[],
    outOfScope: [] as string[],
    rationale: "The worker stub is treated as aligned unless a test explicitly asks for uncertain or drifted alignment.",
  };
  const alignment = {
    verdict: opts?.alignment?.verdict ?? defaultAlignment.verdict,
    satisfied: opts?.alignment?.satisfied ? [...opts.alignment.satisfied] : [...defaultAlignment.satisfied],
    missing: opts?.alignment?.missing ? [...opts.alignment.missing] : [...defaultAlignment.missing],
    outOfScope: opts?.alignment?.outOfScope ? [...opts.alignment.outOfScope] : [...defaultAlignment.outOfScope],
    rationale: opts?.alignment?.rationale ?? defaultAlignment.rationale,
  };
  const publishRuns = { count: 0 };
  const service = new FactoryService({
    dataDir,
    queue,
    jobRuntime: createJobRuntime(dataDir),
    sse: new SseHub(),
    codexExecutor: {
      run: async (input) => {
        await fs.writeFile(input.promptPath, input.prompt, "utf-8");
        await fs.writeFile(input.stdoutPath, "", "utf-8");
        await fs.writeFile(input.stderrPath, "", "utf-8");
        if (input.taskId === "publish") {
          publishRuns.count += 1;
          if (publishMode === "error") {
            throw new Error("gh pr create failed: GraphQL permission denied");
          }
          const publishStructured = publishMode === "missing_metadata"
            ? {
                summary: "Attempted to publish the PR but the final metadata was incomplete.",
                handoff: "Publish attempted, but the final PR metadata was incomplete so the controller must block and surface the failure.",
                prNumber: 17,
                headRefName: "codex/objective-demo",
                baseRefName: "main",
              }
            : publishMode === "transient_then_success" && publishRuns.count === 1
              ? {
                  summary: "Publish blocked by network access to GitHub: the branch could not be pushed and `gh pr create` failed with `error connecting to api.github.com`.",
                  handoff: "Publish was blocked by transient GitHub connectivity. Retry the publish worker once before giving up.",
                  prUrl: "",
                  prNumber: null,
                  headRefName: "codex/objective-demo",
                  baseRefName: "main",
                }
            : publishMode === "blocked"
              ? {
                  summary: "Publish blocked: could not push the branch or open a GitHub PR from this environment.",
                  handoff: "Publish could not proceed from this environment. Block the objective and surface the publish failure explicitly.",
                  prUrl: "",
                  prNumber: null,
                  headRefName: null,
                  baseRefName: null,
                }
            : {
                summary: "Published PR #17.",
                handoff: "Publish completed successfully. The objective can transition to completed with the recorded PR metadata.",
                prUrl: "https://github.com/example/receipt/pull/17",
                prNumber: 17,
                headRefName: "codex/objective-demo",
                baseRefName: "main",
              };
          const raw = JSON.stringify(publishStructured);
          await fs.writeFile(input.lastMessagePath, raw, "utf-8");
          return { exitCode: 0, signal: null, stdout: raw, stderr: "", lastMessage: raw };
        }
        await fs.writeFile(path.join(input.workspacePath, "POLICY_TEST.txt"), `${codexOutcome}:${input.candidateId ?? "candidate"}\n`, "utf-8");
        const structured = {
          outcome: codexOutcome,
          summary: codexOutcome === "approved"
            ? "Approved output ready."
            : codexOutcome === "changes_requested"
              ? "Another pass is required."
              : codexOutcome === "partial"
                ? "Task produced a usable diff, but validation capture was incomplete."
                : "Task is blocked.",
          handoff: codexOutcome === "approved"
            ? "Worker completed and is handing the candidate back for review."
            : codexOutcome === "changes_requested"
              ? "Worker needs another pass before the objective can continue."
              : codexOutcome === "partial"
                ? "Worker completed the requested code change, but validation capture stayed noisy so the controller should decide whether repo-side checks are sufficient."
                : "Worker is blocked and is handing the blocker back to the controller.",
          artifacts: [],
          scriptsRun: [{
            command: "git status --short",
            summary: codexOutcome === "approved"
              ? "Verified the task workspace state after the worker stub completed."
              : codexOutcome === "partial"
                ? "Captured the current workspace state for the partial delivery result."
                : codexOutcome === "changes_requested"
                  ? "Captured the workspace state before requesting another pass."
                  : "Captured the workspace state while surfacing the blocker.",
            status: codexOutcome === "blocked" ? "warning" : "ok",
          }],
          completion: {
            changed: codexOutcome === "approved" || codexOutcome === "partial" ? ["Updated POLICY_TEST.txt in the task workspace."] : [],
            proof: ["POLICY_TEST.txt was written by the worker stub."],
            remaining: completionRemaining.length > 0
              ? [...completionRemaining]
              : codexOutcome === "changes_requested"
                ? ["Run another pass."]
                : codexOutcome === "partial"
                  ? ["Capture a final clean completion of validation if the orchestration layer needs a terminal success marker."]
                : codexOutcome === "blocked"
                  ? ["Blocked."]
                  : [],
          },
          alignment,
          report: {
            conclusion: codexOutcome === "approved"
              ? "The worker stub returned a complete structured result."
              : codexOutcome === "partial"
                ? "The worker stub returned a structured partial result."
                : codexOutcome === "changes_requested"
                  ? "The worker stub requested another pass with a structured handoff."
                  : "The worker stub surfaced a structured blocker for the controller.",
            evidence: [{
              title: "Worker stub output",
              summary: "POLICY_TEST.txt was written in the task workspace by the policy test stub.",
              detail: null,
            }],
            evidenceRecords: [],
            scriptsRun: [{
              command: "git status --short",
              summary: codexOutcome === "approved"
                ? "Verified the task workspace state after the worker stub completed."
                : codexOutcome === "partial"
                  ? "Captured the current workspace state for the partial delivery result."
                  : codexOutcome === "changes_requested"
                    ? "Captured the workspace state before requesting another pass."
                    : "Captured the workspace state while surfacing the blocker.",
              status: codexOutcome === "blocked" ? "warning" : "ok",
            }],
            disagreements: [],
            nextSteps: completionRemaining.length > 0
              ? [...completionRemaining]
              : codexOutcome === "changes_requested"
                ? ["Run another pass."]
                : codexOutcome === "partial"
                  ? ["Capture a final clean completion of validation if the orchestration layer needs a terminal success marker."]
                  : codexOutcome === "blocked"
                    ? ["Resolve the blocker before retrying."]
                    : [],
          },
          nextAction: codexOutcome === "approved"
            ? null
            : codexOutcome === "changes_requested"
              ? "Run another pass."
              : codexOutcome === "partial"
                ? "If needed, rerun validation in a way that yields a clean terminal success marker."
              : "Blocked.",
        };
        const raw = JSON.stringify(structured);
        await fs.writeFile(input.lastMessagePath, raw, "utf-8");
        return { exitCode: 0, signal: null, stdout: raw, stderr: "", lastMessage: raw };
      },
    },
    repoRoot,
  });
  return { service, queue, repoRoot, publishRuns };
};

const buildState = (events: ReadonlyArray<FactoryEvent>): FactoryState =>
  events.reduce(reduceFactory, initialFactoryState);

const inheritedFailureCommand =
  "printf 'ENOENT: no such file or directory, open %s/InfinitelyManyPrimes.lean\\n' \"$PWD\" >&2; exit 1";

test("factory policy: direct codex probes without an objective stay repo-scoped and avoid Factory worker bootstrap", async () => {
  const { service } = await createFactoryService();

  const packet = await service.prepareDirectCodexProbePacket({
    jobId: "job_repo_probe",
    prompt: "Inspect the current sidebar naming and summarize what needs to change.",
    profileId: "software",
    readOnly: true,
    parentRunId: "run_parent",
    parentStream: "agents/agent",
    stream: "agents/factory/demo",
    supervisorSessionId: "session_repo_probe",
  });

  const manifest = await fs.readFile(packet.artifactPaths.manifestPath, "utf-8");
  const contextPack = await fs.readFile(packet.artifactPaths.contextPackPath, "utf-8");
  const parsedManifest = JSON.parse(manifest) as {
    readonly repoSkillPaths?: ReadonlyArray<string>;
    readonly profile?: {
      readonly selectedSkills?: ReadonlyArray<string>;
    };
  };

  expect(packet.readOnly).toBe(true);
  expect(contextPack).toContain("\"mode\": \"read_only_repo_probe\"");
  expect(contextPack).toContain("\"probeId\": \"job_repo_probe\"");
  expect(contextPack).not.toContain("\"objectiveId\"");
  expect(manifest).toContain("\"objectiveBacked\": false");
  expect(parsedManifest.repoSkillPaths ?? []).not.toContain("skills/factory-receipt-worker/SKILL.md");
  expect(parsedManifest.repoSkillPaths ?? []).not.toContain("skills/factory-run-orchestrator/SKILL.md");
  expect(parsedManifest.profile?.selectedSkills ?? []).toContain("skills/factory-run-orchestrator/SKILL.md");
  expect(packet.renderedPrompt).toContain("This direct probe is not a Factory task worktree");
  expect(packet.renderedPrompt).toContain("should not call the objective inspect commands");
  expect(packet.renderedPrompt).toContain("Do not assume skills/factory-receipt-worker/SKILL.md applies unless a real objectiveId is present.");
  expect(packet.renderedPrompt).toContain("Start with a short internal plan.");
  expect(packet.renderedPrompt).toContain("If the operator named a file, artifact, receipt, helper, or run, inspect that exact target before broader repo search or memory expansion.");
  expect(packet.renderedPrompt).toContain("If you use subagents, keep them as bounded sidecars");
  expect(packet.renderedPrompt).toContain("Do not parallelize broad repo exploration when one named artifact or one primary evidence path can answer the request.");
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: task packets tell workers to inspect objective receipts sequentially", async () => {
  const { service, queue } = await createFactoryService();

  const created = await service.createObjective({
    title: "Sequential inspect prompt",
    prompt: "Rename the sidebar label and keep receipt bootstrap reliable.",
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as Record<string, unknown>);
  const promptPath = String(taskJob.payload.promptPath);
  const prompt = await fs.readFile(promptPath, "utf-8");

  expect(prompt).toMatch(/Do not call `.+ factory inspect` from inside this task worktree\./);
  expect(prompt).not.toContain(`factory inspect '${created.objectiveId}' --json --panel receipts`);
  expect(prompt).not.toContain(`factory inspect '${created.objectiveId}' --json --panel debug`);
  expect(prompt).toContain("Do not absorb downstream work");
  expect(prompt).toContain("## Planning Receipt");
  expect(prompt).toContain("Acceptance Criteria:");
  expect(prompt).toContain("Validation Plan:");
  expect(prompt).toContain("Do not write this file yourself.");
  expect(prompt).toContain("## Checks");
  expect(prompt).toContain("Run the relevant repo validation for this task");
  expect(prompt).not.toContain("A later task in this objective owns the broad repo validation suite.");
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: delivery task prompts keep publish in the controller lane", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });

  const created = await service.createObjective({
    title: "Controller-owned publish lane",
    prompt: "Ship the fix through a PR after the task is ready.",
    profileId: "software",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const prompt = await fs.readFile(String(taskJob.payload.promptPath), "utf-8");

  expect(prompt).toContain("factory promote`, `git push`, or `gh pr create` from this task session.");
  expect(prompt).toContain("The controller handles integration and PR publication after an approved candidate.");
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: validation-owned task packets include the full repo checks", async () => {
  const { service, queue } = await createFactoryService();

  const created = await service.createObjective({
    title: "Validation prompt owner",
    prompt: "Run the final validation suite.",
    checks: ["git status --short", "bun test"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const prompt = await fs.readFile(String(taskJob.payload.promptPath), "utf-8");

  expect(prompt).toContain("## Checks");
  expect(prompt).toContain("- git status --short");
  expect(prompt).toContain("- bun test");
  expect(prompt).toContain("Run the relevant repo validation for this task");
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: delivery task schema and prompt require scriptsRun and completion", async () => {
  const { service, queue } = await createFactoryService();

  const created = await service.createObjective({
    title: "Strict delivery schema",
    prompt: "Change a small repo file and summarize the result.",
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);

  const prompt = await fs.readFile(String(taskJob.payload.promptPath), "utf-8");
  const resultPath = String(taskJob.payload.resultPath);
  const schemaPath = resultPath.replace(/\.json$/i, ".schema.json");
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf-8")) as {
    readonly required?: ReadonlyArray<string>;
  };

  expect(prompt).toContain(`"scriptsRun": [{ "command": string, "summary": string | null, "status": "ok" | "warning" | "error" | null }]`);
  expect(prompt).toContain(`"completion": { "changed": string[], "proof": string[], "remaining": string[] }`);
  expect(prompt).toContain(`"alignment": { "verdict": "aligned" | "uncertain" | "drifted", "satisfied": string[], "missing": string[], "outOfScope": string[], "rationale": string }`);
  expect(prompt).toContain(`"handoff": string | null`);
  expect(prompt).toContain("Always include presentation, scriptsRun, completion, and alignment.");
  expect(prompt).toContain("Legacy handoff is still read during migration, but presentation is the primary contract.");
  expect(schema.required).toContain("presentation");
  expect(schema.required).toContain("scriptsRun");
  expect(schema.required).toContain("completion");
  expect(schema.required).toContain("alignment");
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: investigation task schema keeps scriptsRun inside report and requires completion", async () => {
  const { service, queue } = await createFactoryService();

  const created = await service.createObjective({
    title: "Strict investigation schema",
    prompt: "Inventory the mounted AWS account.",
    objectiveMode: "investigation",
    profileId: "infrastructure",
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);

  const prompt = await fs.readFile(String(taskJob.payload.promptPath), "utf-8");
  const resultPath = String(taskJob.payload.resultPath);
  const schemaPath = resultPath.replace(/\.json$/i, ".schema.json");
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf-8")) as {
    readonly properties?: Record<string, unknown>;
    readonly required?: ReadonlyArray<string>;
  };

  expect(prompt).toContain(`{ "status": "answered" | "partial" | "blocked", "conclusion": string, "findings": [{ "title": string, "summary": string, "confidence": "confirmed" | "inferred" | "uncertain", "evidenceRefLabels": string[] }], "uncertainties": string[], "nextAction": string | null }`);
  expect(prompt).toContain("Keep the semantic payload small. The controller will build presentation, artifact refs, completion, and the final investigation report from mounted evidence and telemetry.");
  expect(prompt).toContain("Every finding must reference one or more evidenceRefLabels already present in the packet, mounted artifacts, or command output.");
  expect(schema.properties?.status).toBeTruthy();
  expect(schema.properties?.conclusion).toBeTruthy();
  expect(schema.properties?.findings).toBeTruthy();
  expect(schema.required).toEqual(["status", "conclusion", "findings", "uncertainties", "nextAction"]);
}, 120_000);

test("factory policy: objectives record a planning receipt and expose it on detail", async () => {
  const { service } = await createFactoryService();

  const created = await service.createObjective({
    title: "Planning receipt objective",
    prompt: "Build a small feature plan and execute it.",
    profileId: "software",
  });

  const detail = await service.getObjective(created.objectiveId);

  expect(detail.planning?.goal).toBe("Build a small feature plan and execute it.");
  expect(detail.planning?.taskGraph.map((task) => task.taskId)).toEqual(["task_01"]);
  expect(detail.planning?.acceptanceCriteria.length).toBeGreaterThan(0);
  expect(detail.planning?.validationPlan.length).toBeGreaterThan(0);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "planning.receipt")).toBe(true);
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: service rejects createObjective when the profile create mode is not allowed", async () => {
  const { service } = await createFactoryService();

  await expect(service.createObjective({
    title: "Invalid infrastructure delivery objective",
    prompt: "Fix the dashboard route.",
    profileId: "infrastructure",
    objectiveMode: "delivery",
  })).rejects.toMatchObject({
    status: 409,
    message: "Infrastructure cannot create delivery objectives.",
  });
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: service rejects promoteObjective when the objective profile is not allowed to promote", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });

  const created = await service.createObjective({
    title: "Generalist-owned promotion objective",
    prompt: "Ship a small delivery change.",
    profileId: "generalist",
    policy: {
      promotion: { autoPromote: false },
    },
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const validateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(validateJob.payload as FactoryIntegrationJobPayload);

  await expect(service.promoteObjective(created.objectiveId)).rejects.toMatchObject({
    status: 409,
    message: "Tech Lead cannot promote objectives.",
  });
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: promotion gate blocks when task completion reports remaining work", async () => {
  const { service, queue } = await createFactoryService({
    completionRemaining: ["Wire the final publish behavior before shipping."],
    alignment: {
      verdict: "aligned",
      satisfied: ["Implemented the requested delivery change."],
      missing: [],
      outOfScope: [],
      rationale: "The worker stayed within scope, but intentionally left remaining work for the promotion gate to catch.",
    },
  });

  const created = await service.createObjective({
    title: "Promotion gate objective",
    prompt: "Implement a small delivery change and leave one remaining item.",
    profileId: "software",
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const validationJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(validationJob.payload as FactoryIntegrationJobPayload);

  const detail = await service.getObjective(created.objectiveId);

  expect(detail.status).toBe("blocked");
  expect(detail.blockedReason).toContain("still reports remaining work");
  expect(detail.tasks[0]?.completion?.remaining).toEqual(["Wire the final publish behavior before shipping."]);
  expect(detail.recentReceipts.some((receipt) => receipt.type === "integration.ready_to_promote")).toBe(false);
}, 120_000);

test("factory policy: controller can clear delivery partials when repo checks resolve validation-only uncertainty", async () => {
  const { service, queue } = await createFactoryService({
    codexOutcome: "partial",
    completionRemaining: [
      "Confirm or clean up the untracked `.receipt/codex-home-runtime/` artifact if the controller requires a pristine worktree.",
      "Capture a final clean completion of validation if the orchestration layer needs a terminal success marker.",
    ],
    alignment: {
      verdict: "aligned",
      satisfied: [
        "Applied the requested delivery change.",
        "Stayed within the requested delivery scope.",
      ],
      missing: [],
      outOfScope: [],
      rationale: "The worker completed the requested delivery change; only controller-side validation cleanup remained.",
    },
  });

  const created = await service.createObjective({
    title: "Controller-resolved partial objective",
    prompt: "Apply a small delivery change and let the controller resolve validation-only noise.",
    profileId: "software",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const validateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(validateJob.payload as FactoryIntegrationJobPayload);
  const publishJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.publish");
  await service.runIntegrationPublish(publishJob.payload as FactoryIntegrationPublishJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  const candidate = detail.candidates.find((item) => item.candidateId === "task_01_candidate_01");

  expect(detail.status).toBe("completed");
  expect(detail.integration.status).toBe("promoted");
  expect(candidate?.status).toBe("integrated");
  expect(candidate?.summary ?? "").toContain("Controller verification cleared the partial delivery handoff");
  expect(detail.tasks[0]?.completion?.remaining ?? []).toEqual([]);
  expect(detail.tasks[0]?.completion?.proof ?? []).toContain("Controller reran the configured checks successfully.");
}, 120_000);

test("factory policy: uncertain delivery alignment queues one corrective follow-up task", async () => {
  const { service, queue } = await createFactoryService({
    alignment: {
      verdict: "uncertain",
      satisfied: ["Applied the requested delivery change."],
      missing: ["Confirm the shipped behavior satisfies the requested delivery objective end to end."],
      outOfScope: [],
      rationale: "The worker changed the file but did not explicitly confirm the objective contract.",
    },
  });

  const created = await service.createObjective({
    title: "Alignment correction objective",
    prompt: "Apply a small delivery change and explicitly confirm contract alignment.",
    profileId: "software",
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(firstJob.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  const followUpTask = detail.tasks.find((task) => task.taskId !== "task_01");
  const nextJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  const nextPayload = nextJob.payload as FactoryTaskJobPayload;

  expect(detail.status).toBe("executing");
  expect(detail.recentReceipts.some((receipt) =>
    receipt.type === "objective.operator.noted"
    && receipt.summary.includes("Alignment correction for this objective")
  )).toBe(true);
  expect(followUpTask?.sourceTaskId).toBe("task_01");
  expect(nextPayload.taskId).toBe(followUpTask?.taskId);
  expect(detail.tasks[0]?.status).toBe("superseded");
}, 120_000);

test("factory policy: unresolved drift after one corrective pass stays blocked", async () => {
  const { service, queue } = await createFactoryService({
    alignment: {
      verdict: "drifted",
      satisfied: ["Changed the requested file."],
      missing: ["Implement the requested delivery behavior."],
      outOfScope: ["Unrequested UI copy cleanup."],
      rationale: "The worker produced a diff, but it drifted into unrelated work instead of satisfying the requested objective.",
    },
  });

  const created = await service.createObjective({
    title: "Alignment drift objective",
    prompt: "Implement a small delivery change without drifting into unrelated work.",
    profileId: "software",
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(firstJob.payload as FactoryTaskJobPayload);
  const correctiveJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  const correctivePayload = correctiveJob.payload as FactoryTaskJobPayload;
  expect(correctivePayload.taskId).not.toBe("task_01");
  await service.runTask(correctivePayload);

  const detail = await service.getObjective(created.objectiveId);

  expect(detail.status).toBe("blocked");
  expect(detail.blockedReason ?? "").toContain("Alignment gate blocked");
  expect(detail.blockedReason ?? "").toContain("Out-of-scope work: Unrequested UI copy cleanup.");
  expect(detail.recentReceipts.some((receipt) => receipt.type === "integration.ready_to_promote")).toBe(false);
}, 120_000);

test("factory policy: objectives default to higher parallel capacity and still normalize dispatch policy", async () => {
  const { service } = await createFactoryService();

  const created = await service.createObjective({
    title: "Dispatch cap objective",
    prompt: "Create three independent tasks.",
    profileId: "software",
    policy: {
      throttles: { maxDispatchesPerReact: 1 },
    },
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);
  const ready = await service.getObjective(created.objectiveId);

  expect(ready.policy.concurrency.maxActiveTasks).toBe(20);
  expect(ready.policy.throttles.maxDispatchesPerReact).toBe(1);
  expect(ready.profile.rootProfileId).toBe("software");
  expect(ready.profile.objectivePolicy.defaultTaskExecutionMode).toBe("worktree");
  expect(ready.profile.objectivePolicy.maxParallelChildren).toBe(20);
  expect(ready.activeTaskCount).toBeGreaterThanOrEqual(1);
  expect(ready.taskCount).toBeGreaterThanOrEqual(ready.activeTaskCount);
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: maxTaskRuns blocks further dispatch and surfaces a deterministic reason", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "changes_requested" });

  const created = await service.createObjective({
    title: "Task run cap objective",
    prompt: "Keep iterating until approved.",
    policy: {
      budgets: { maxTaskRuns: 1 },
    },
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const job = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(job.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("blocked");
  expect(detail.budgetState.policyBlockedReason ?? "").toMatch(/maxTaskRuns/);
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: maxCandidatePassesPerTask blocks rework after the configured cap", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "changes_requested" });

  const created = await service.createObjective({
    title: "Candidate pass cap objective",
    prompt: "Keep revising until approved.",
    policy: {
      budgets: { maxCandidatePassesPerTask: 1 },
    },
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const job = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(job.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.tasks[0]?.status).toBe("blocked");
  expect(detail.tasks[0]?.blockedReason ?? "").toMatch(/maxCandidatePassesPerTask/);
}, 10_000);

test("factory objective detail: blocked explanations stay focused on the current blocker without downstream workflow text", async () => {
  const { service, queue } = await createFactoryService({
    codexOutcome: "blocked",
  });

  const created = await service.createObjective({
    title: "Blocked dependency summary objective",
    prompt: "Investigate AWS spend drivers and summarize the blockers.",
    objectiveMode: "investigation",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const job = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(job.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("blocked");
  expect(detail.blockedExplanation?.receiptType).toBe("objective.handoff");
  expect(detail.blockedExplanation?.summary ?? "").not.toContain("Waiting tasks:");
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: base-commit check failures are treated as inherited on the first candidate pass", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });

  const created = await service.createObjective({
    title: "Inherited failure objective",
    prompt: "Keep progress moving when verify only reproduces the same inherited failure.",
    checks: [inheritedFailureCommand],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(firstJob.payload as FactoryTaskJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  const approved = detail.candidates.find((candidate) => candidate.candidateId === "task_01_candidate_01");
  expect(["approved", "integrated"]).toContain(approved?.status);
  expect(approved?.summary ?? "").toMatch(/inherited failure/i);
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: autoPromote false stops at ready_to_promote until promotion is explicit", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });

  const created = await service.createObjective({
    title: "Manual promotion objective",
    prompt: "Require an explicit source promotion step.",
    profileId: "software",
    policy: {
      promotion: { autoPromote: false },
    },
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const validateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(validateJob.payload as FactoryIntegrationJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.integration.status).toBe("ready_to_promote");
  expect(detail.status).not.toBe("completed");

  const promoted = await service.promoteObjective(created.objectiveId);
  expect(promoted.status).toBe("promoting");
  expect(promoted.integration.status).toBe("promoting");

  const publishJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.publish");
  await service.runIntegrationPublish(publishJob.payload as FactoryIntegrationPublishJobPayload);

  const published = await service.getObjective(created.objectiveId);
  expect(published.status).toBe("completed");
  expect(published.integration.status).toBe("promoted");
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: software delivery objectives auto-publish and expose PR metadata", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });

  const created = await service.createObjective({
    title: "Software publish objective",
    prompt: "Ship the fix through a PR.",
    profileId: "software",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const validateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(validateJob.payload as FactoryIntegrationJobPayload);

  const publishJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.publish");
  const publishResult = await service.runIntegrationPublish(publishJob.payload as FactoryIntegrationPublishJobPayload);
  expect(publishResult.status).toBe("completed");

  const published = await service.getObjective(created.objectiveId);
  const debug = await service.getObjectiveDebug(created.objectiveId);
  expect(published.status).toBe("completed");
  expect(published.profile.rootProfileId).toBe("software");
  expect(published.integration.status).toBe("promoted");
  expect(published.prUrl).toBe("https://github.com/example/receipt/pull/17");
  expect(published.prNumber).toBe(17);
  expect(published.recentReceipts.some((receipt) =>
    receipt.type === "worker.handoff"
    && receipt.candidateId === "task_01_candidate_01"
    && /integration_publish published handoff/i.test(receipt.summary)
  )).toBe(true);
  expect(published.recentReceipts.some((receipt) =>
    receipt.type === "objective.handoff"
    && /objective completed handoff/i.test(receipt.summary)
  )).toBe(true);
  expect(published.latestHandoff?.status).toBe("completed");
  expect(published.integration.prUrl).toBe("https://github.com/example/receipt/pull/17");
  expect(published.integration.prNumber).toBe(17);
  expect(debug.prUrl).toBe("https://github.com/example/receipt/pull/17");
  expect(debug.prNumber).toBe(17);
}, 20_000);

test("factory policy: publish retries transient GitHub connectivity failures before blocking", async () => {
  const { service, queue, publishRuns } = await createFactoryService({
    codexOutcome: "approved",
    publishMode: "transient_then_success",
  });

  const created = await service.createObjective({
    title: "Software publish retry objective",
    prompt: "Retry one transient GitHub publish failure before blocking the objective.",
    profileId: "software",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const validateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(validateJob.payload as FactoryIntegrationJobPayload);

  const publishJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.publish");
  const publishResult = await service.runIntegrationPublish(publishJob.payload as FactoryIntegrationPublishJobPayload);
  expect(publishResult.status).toBe("completed");
  expect(publishRuns.count).toBe(2);

  const published = await service.getObjective(created.objectiveId);
  expect(published.status).toBe("completed");
  expect(published.integration.status).toBe("promoted");
  expect(published.prUrl).toBe("https://github.com/example/receipt/pull/17");
}, 20_000);

test("factory policy: publish failures block the objective when PR metadata is missing", async () => {
  const { service, queue } = await createFactoryService({
    codexOutcome: "approved",
    publishMode: "missing_metadata",
  });

  const created = await service.createObjective({
    title: "Software publish failure objective",
    prompt: "Do not treat publish as complete without a PR link.",
    profileId: "software",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const validateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(validateJob.payload as FactoryIntegrationJobPayload);
  const publishJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.publish");
  const publishResult = await service.runIntegrationPublish(publishJob.payload as FactoryIntegrationPublishJobPayload);
  expect(publishResult.status).toBe("failed");

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("blocked");
  expect(detail.integration.status).toBe("conflicted");
  expect(detail.prUrl).toBeUndefined();
  expect(detail.recentReceipts.some((receipt) =>
    receipt.type === "worker.handoff"
    && receipt.candidateId === "task_01_candidate_01"
    && /integration_publish failed handoff/i.test(receipt.summary)
  )).toBe(true);
  expect(detail.recentReceipts.some((receipt) =>
    receipt.type === "objective.handoff"
    && /objective blocked handoff/i.test(receipt.summary)
  )).toBe(true);
  expect(detail.latestHandoff?.status).toBe("blocked");
  expect(detail.blockedReason ?? "").toContain("factory publish result missing valid prUrl");
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: publish failures preserve an explicit worker blocker summary", async () => {
  const { service, queue } = await createFactoryService({
    codexOutcome: "approved",
    publishMode: "blocked",
  });

  const created = await service.createObjective({
    title: "Software publish blocker objective",
    prompt: "Surface the real publish blocker.",
    profileId: "software",
    checks: ["git status --short"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const taskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(taskJob.payload as FactoryTaskJobPayload);
  const validateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(validateJob.payload as FactoryIntegrationJobPayload);
  const publishJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.publish");
  const publishResult = await service.runIntegrationPublish(publishJob.payload as FactoryIntegrationPublishJobPayload);
  expect(publishResult.status).toBe("failed");

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.status).toBe("blocked");
  expect(detail.integration.status).toBe("conflicted");
  expect(detail.prUrl).toBeUndefined();
  expect(detail.blockedReason ?? "").toContain("Publish blocked: could not push the branch or open a GitHub PR from this environment.");
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: integration validation can pass through inherited failures without reconciliation churn", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });

  const created = await service.createObjective({
    title: "Inherited integration failure objective",
    prompt: "Do not spawn reconciliation work when integration only reproduces inherited failures.",
    policy: {
      promotion: { autoPromote: false },
    },
    checks: [inheritedFailureCommand],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstTaskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(firstTaskJob.payload as FactoryTaskJobPayload);

  const firstValidateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  await service.runIntegrationValidation(firstValidateJob.payload as FactoryIntegrationJobPayload);

  const detail = await service.getObjective(created.objectiveId);
  expect(detail.integration.status).toBe("ready_to_promote");
  expect(detail.integration.lastSummary ?? "").toMatch(/inherited failures/i);
  expect(detail.tasks.some((task) => task.taskKind === "reconciliation")).toBe(false);
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory policy: integration validation failures block the objective instead of spawning reconciliation work", async () => {
  const { service, queue } = await createFactoryService({ codexOutcome: "approved" });
  const created = await service.createObjective({
    title: "Validation failure objective",
    prompt: "Block on failing integration validation and wait for react.",
    checks: ["true"],
  });
  await runObjectiveStartup(service, created.objectiveId);

  const firstTaskJob = await latestFactoryJob(queue, created.objectiveId, "factory.task.run");
  await service.runTask(firstTaskJob.payload as FactoryTaskJobPayload);
  const validateJob = await latestFactoryJob(queue, created.objectiveId, "factory.integration.validate");
  const validatePayload = validateJob.payload as FactoryIntegrationJobPayload;
  await fs.writeFile(path.join(validatePayload.workspacePath, "INTEGRATION_ONLY"), "marker\n", "utf-8");
  await service.runIntegrationValidation({
    ...validatePayload,
    checks: ["sh -lc '[ ! -f INTEGRATION_ONLY ]'"],
  });

  const after = await service.getObjective(created.objectiveId);
  expect(after.status).toBe("blocked");
  expect(after.blockedReason ?? "").toMatch(/Integration validation failed/i);
  expect(after.tasks.some((task) => task.taskKind === "reconciliation")).toBe(false);
}, FACTORY_POLICY_TIMEOUT_MS);

test("factory reducer: blocked task clears the latest running candidate status", () => {
  const baseCreatedAt = Date.now();
  const state = buildState([
    {
      type: "objective.created",
      objectiveId: "objective_candidate_block",
      title: "Candidate blocker",
      prompt: "Investigate spend drivers.",
      channel: "results",
      baseHash: "abc1234",
      checks: ["bun run build"],
      checksSource: "explicit",
      profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
      policy: normalizeFactoryObjectivePolicy(),
      createdAt: baseCreatedAt,
    },
    {
      type: "task.added",
      objectiveId: "objective_candidate_block",
      createdAt: baseCreatedAt + 1,
      task: {
        nodeId: "task_03",
        taskId: "task_03",
        taskKind: "planned",
        title: "Inventory spend drivers",
        prompt: "Query ELB, EBS, NAT, and CloudWatch.",
        workerType: "codex",
        baseCommit: "abc1234",
        dependsOn: [],
        status: "pending",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: baseCreatedAt + 1,
      },
    },
    {
      type: "candidate.created",
      objectiveId: "objective_candidate_block",
      createdAt: baseCreatedAt + 2,
      candidate: {
        candidateId: "task_03_candidate_01",
        taskId: "task_03",
        status: "planned",
        baseCommit: "abc1234",
        checkResults: [],
        artifactRefs: {},
        createdAt: baseCreatedAt + 2,
        updatedAt: baseCreatedAt + 2,
      },
    },
    {
      type: "task.dispatched",
      objectiveId: "objective_candidate_block",
      taskId: "task_03",
      candidateId: "task_03_candidate_01",
      jobId: "job_task_03",
      workspaceId: "ws_task_03",
      workspacePath: "/tmp/ws_task_03",
      skillBundlePaths: [],
      contextRefs: [],
      startedAt: baseCreatedAt + 3,
    },
    {
      type: "task.blocked",
      objectiveId: "objective_candidate_block",
      taskId: "task_03",
      reason: "AccessDenied: User is not authorized to perform elasticloadbalancing:DescribeLoadBalancers because no identity-based policy allows the action.",
      blockedAt: baseCreatedAt + 4,
    },
  ]);

  expect(state.workflow.tasksById.task_03?.status).toBe("blocked");
  expect(state.candidates.task_03_candidate_01?.status).toBe("changes_requested");
  expect(state.candidates.task_03_candidate_01?.latestReason).toContain("DescribeLoadBalancers");
});

test("factory reducer: successful promotion clears stale blocker state", () => {
  const baseCreatedAt = Date.now();
  const state = buildState([
    {
      type: "objective.created",
      objectiveId: "objective_publish_recovery",
      title: "Promotion recovery",
      prompt: "Recover from a publish blocker.",
      channel: "results",
      baseHash: "abc1234",
      checks: ["bun run build"],
      checksSource: "explicit",
      profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
      policy: normalizeFactoryObjectivePolicy(),
      createdAt: baseCreatedAt,
    },
    {
      type: "integration.conflicted",
      objectiveId: "objective_publish_recovery",
      candidateId: "task_01_candidate_01",
      reason: "Publishing failed: factory publish result missing valid prUrl",
      headCommit: "abc1234",
      conflictedAt: baseCreatedAt + 1,
    },
    {
      type: "objective.blocked",
      objectiveId: "objective_publish_recovery",
      reason: "Publishing failed: factory publish result missing valid prUrl",
      summary: "Publishing failed: factory publish result missing valid prUrl",
      blockedAt: baseCreatedAt + 2,
    },
    {
      type: "integration.promoted",
      objectiveId: "objective_publish_recovery",
      candidateId: "task_01_candidate_01",
      promotedCommit: "def5678",
      summary: "Published PR #2.",
      prUrl: "https://github.com/example/receipt/pull/2",
      prNumber: 2,
      headRefName: "hub/integration/objective_publish_recovery",
      baseRefName: "main",
      promotedAt: baseCreatedAt + 3,
    },
    {
      type: "objective.completed",
      objectiveId: "objective_publish_recovery",
      summary: "Published PR #2.",
      completedAt: baseCreatedAt + 4,
    },
  ]);

  expect(state.status).toBe("completed");
  expect(state.blockedReason).toBeUndefined();
  expect(state.integration.status).toBe("promoted");
  expect(state.integration.conflictReason).toBeUndefined();
  expect(state.integration.prUrl).toBe("https://github.com/example/receipt/pull/2");
  expect(state.integration.prNumber).toBe(2);
});

test("factory reducer: resuming work clears the latest objective handoff", () => {
  const baseCreatedAt = Date.now();
  const state = buildState([
    {
      type: "objective.created",
      objectiveId: "objective_resume_handoff",
      title: "Resume after blocker",
      prompt: "Continue once the blocker is resolved.",
      channel: "results",
      baseHash: "abc1234",
      checks: ["bun run build"],
      checksSource: "explicit",
      profile: DEFAULT_FACTORY_OBJECTIVE_PROFILE,
      policy: normalizeFactoryObjectivePolicy(),
      createdAt: baseCreatedAt,
    },
    {
      type: "task.added",
      objectiveId: "objective_resume_handoff",
      createdAt: baseCreatedAt + 1,
      task: {
        nodeId: "task_01",
        taskId: "task_01",
        taskKind: "planned",
        title: "Resume delivery",
        prompt: "Pick up the next attempt.",
        workerType: "codex",
        baseCommit: "abc1234",
        dependsOn: [],
        status: "pending",
        skillBundlePaths: [],
        contextRefs: [],
        artifactRefs: {},
        createdAt: baseCreatedAt + 1,
      },
    },
    {
      type: "objective.blocked",
      objectiveId: "objective_resume_handoff",
      reason: "Need operator guidance before continuing.",
      summary: "Need operator guidance before continuing.",
      blockedAt: baseCreatedAt + 2,
    },
    {
      type: "objective.handoff",
      objectiveId: "objective_resume_handoff",
      title: "Resume after blocker",
      status: "blocked",
      summary: "Need operator guidance before continuing.",
      blocker: "Need operator guidance before continuing.",
      nextAction: "Use /react with the missing guidance.",
      handoffKey: "handoff_resume_blocked",
      sourceUpdatedAt: baseCreatedAt + 2,
    },
    {
      type: "task.unblocked",
      objectiveId: "objective_resume_handoff",
      taskId: "task_01",
      readyAt: baseCreatedAt + 3,
    },
  ]);

  expect(state.status).toBe("planning");
  expect(state.blockedReason).toBeUndefined();
  expect(state.latestHandoff).toBeUndefined();
  expect(state.workflow.tasksById.task_01?.status).toBe("ready");
});
