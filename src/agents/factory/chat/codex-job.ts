import fs from "node:fs/promises";
import path from "node:path";

import { CodexControlSignalError, type CodexExecutor, type CodexRunControl, type CodexRunInput } from "../../../adapters/codex-executor";
import type { FactoryService } from "../../../services/factory-service";
import { factoryChatCodexArtifactPaths, readTextTail } from "../../../services/factory-codex-artifacts";
import { buildEvidenceBundle, writeAlignmentMarkdown } from "../../../services/factory-evidence-bundle";
import { diffGitChangedSnapshots, gitChangedFileSnapshots, gitChangedFiles, asString, summarizeChildProgress } from "./input";

const DIRECT_CODEX_MUTATION_MESSAGE = "Direct Codex probes are read-only. This work needs code changes; create or react a Factory objective instead.";

const looksLikeReadOnlyMutationFailure = (message: string): boolean =>
  /\bread[- ]only\b|\bpermission denied\b|\bcannot write\b|\bwrite access\b|\bsandbox\b/i.test(message);

const tail = (value: string | undefined, max = 400): string | undefined => {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
};

export const runFactoryCodexJob = async (input: {
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly jobId: string;
  readonly prompt: string;
  readonly executor: CodexExecutor;
  readonly timeoutMs?: number;
  readonly onProgress?: (update: Record<string, unknown>) => Promise<void>;
  readonly factoryService?: FactoryService;
  readonly payload?: Record<string, unknown>;
}, control?: CodexRunControl): Promise<Record<string, unknown>> => {
  const artifacts = factoryChatCodexArtifactPaths(input.dataDir, input.jobId);
  await fs.mkdir(artifacts.root, { recursive: true });
  const evidenceRoot = path.join(artifacts.root, "artifacts");
  await fs.mkdir(evidenceRoot, { recursive: true });
  const alignmentPath = await writeAlignmentMarkdown({
    rootDir: artifacts.root,
    goal: "Run the requested codex job and capture structured evidence for audit.",
    constraints: [
      "Preserve the existing execution behavior.",
      "Keep the bundle minimally populated even when the job ends blocked, failed, or canceled.",
      "Do not emit secrets into artifacts.",
    ],
    definitionOfDone: [
      "alignment.md exists for every run.",
      "evidence bundle is attached to the terminal job result.",
    ],
    assumptions: [
      "The execution harness may not always emit reusable script records.",
    ],
  });

  let renderedPrompt = input.prompt;
  let readOnly = input.payload?.readOnly === true || asString(input.payload?.mode) === "read_only_probe";
  let env: NodeJS.ProcessEnv | undefined;
  if (input.factoryService && input.payload) {
    const prepared = await input.factoryService.prepareDirectCodexProbePacket({
      jobId: input.jobId,
      prompt: input.prompt,
      profileId: asString(input.payload.profileId),
      objectiveId: asString(input.payload.objectiveId),
      parentRunId: asString(input.payload.parentRunId),
      parentStream: asString(input.payload.parentStream),
      stream: asString(input.payload.stream),
      supervisorSessionId: asString(input.payload.supervisorSessionId),
      readOnly,
    });
    renderedPrompt = prepared.renderedPrompt;
    readOnly = prepared.readOnly;
    env = prepared.env;
  } else {
    await fs.rm(artifacts.resultPath, { force: true });
  }

  let progressStopped = false;
  let lastFingerprint = "";
  const emitProgress = async (): Promise<void> => {
    const [lastMessage, stdoutTail, stderrTail] = await Promise.all([
      readTextTail(artifacts.lastMessagePath, 400),
      readTextTail(artifacts.stdoutPath, 900),
      readTextTail(artifacts.stderrPath, 600),
    ]);
    const update = {
      worker: "codex",
      mode: readOnly ? "read_only_probe" : "workspace_write",
      readOnly,
      status: "running",
      progressAt: Date.now(),
      lastMessage,
      stdoutTail,
      stderrTail,
    };
    const next = {
      ...update,
      summary: summarizeChildProgress(update),
    };
    const fingerprint = JSON.stringify(next);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    await input.onProgress?.(next);
  };
  const progressLoop = (async () => {
    while (!progressStopped) {
      await emitProgress();
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  })();

  const writeResult = async (result: Record<string, unknown>): Promise<void> => {
    await fs.writeFile(artifacts.resultPath, JSON.stringify(result, null, 2), "utf-8");
  };

  let workspacePath = input.repoRoot;
  let sandboxMode: CodexRunInput["sandboxMode"] = readOnly ? "read-only" : "workspace-write";
  let mutationPolicy: NonNullable<CodexRunInput["mutationPolicy"]> = readOnly ? "read_only_probe" : "workspace_edit";
  let initialChangedFileSnapshot = readOnly
    ? await gitChangedFileSnapshots(workspacePath)
    : undefined;

  const runExecutor = () => input.executor.run({
    prompt: renderedPrompt,
    workspacePath,
    promptPath: artifacts.promptPath,
    lastMessagePath: artifacts.lastMessagePath,
    stdoutPath: artifacts.stdoutPath,
    stderrPath: artifacts.stderrPath,
    timeoutMs: input.timeoutMs,
    env,
    sandboxMode,
    mutationPolicy,
  }, control);

  try {
    const result = await runExecutor();
    progressStopped = true;
    await progressLoop;
    await emitProgress();

    const [repoChangedFiles, finalChangedFileSnapshot] = await Promise.all([
      gitChangedFiles(input.repoRoot),
      readOnly ? gitChangedFileSnapshots(workspacePath) : Promise.resolve(undefined),
    ]);
    const changedFiles = readOnly && initialChangedFileSnapshot && finalChangedFileSnapshot
      ? diffGitChangedSnapshots(initialChangedFileSnapshot, finalChangedFileSnapshot)
      : repoChangedFiles;
    if (readOnly && changedFiles.length > 0) {
      const evidenceBundle = await buildEvidenceBundle({
        objectiveId: typeof input.payload?.objectiveId === "string" ? input.payload.objectiveId : input.jobId,
        taskId: typeof input.payload?.taskId === "string" ? input.payload.taskId : input.jobId,
        candidateId: typeof input.payload?.candidateId === "string" ? input.payload.candidateId : input.jobId,
        planSummary: "Structured evidence for codex job execution.",
        alignment: {
          verdict: "aligned",
          satisfied: ["alignment.md emitted", "terminal result captured"],
          missing: [],
          outOfScope: [],
          rationale: "The job completed in read-only failure mode with evidence attached.",
        },
        completion: {
          changed: changedFiles,
          proof: [alignmentPath, artifacts.resultPath],
          remaining: [],
        },
        scriptsRun: [],
        artifactPaths: [
          { label: "prompt", path: artifacts.promptPath },
          { label: "last message", path: artifacts.lastMessagePath },
          { label: "stdout", path: artifacts.stdoutPath },
          { label: "stderr", path: artifacts.stderrPath },
        ],
        links: [],
      });
      const failed = {
        status: "failed",
        worker: "codex",
        mode: "read_only_probe",
        readOnly: true,
        summary: DIRECT_CODEX_MUTATION_MESSAGE,
        lastMessage: asString(result.lastMessage),
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
        ...(typeof result.tokensUsed === "number" ? { tokensUsed: result.tokensUsed } : {}),
        changedFiles,
        ...(readOnly ? { repoChangedFiles } : {}),
        artifacts,
        evidence_attached: true,
        alignment_reported: true,
        evidenceBundle,
      };
      await writeResult(failed);
      throw new Error(DIRECT_CODEX_MUTATION_MESSAGE);
    }

    const evidenceBundle = await buildEvidenceBundle({
      objectiveId: typeof input.payload?.objectiveId === "string" ? input.payload.objectiveId : input.jobId,
      taskId: typeof input.payload?.taskId === "string" ? input.payload.taskId : input.jobId,
      candidateId: typeof input.payload?.candidateId === "string" ? input.payload.candidateId : input.jobId,
      planSummary: "Structured evidence for codex job execution.",
      alignment: {
        verdict: "aligned",
        satisfied: ["alignment.md emitted", "terminal result captured"],
        missing: [],
        outOfScope: [],
        rationale: "The job completed with evidence attached.",
      },
      completion: {
        changed: changedFiles,
        proof: [alignmentPath, artifacts.resultPath],
        remaining: [],
      },
      scriptsRun: [],
      artifactPaths: [
        { label: "prompt", path: artifacts.promptPath },
        { label: "last message", path: artifacts.lastMessagePath },
        { label: "stdout", path: artifacts.stdoutPath },
        { label: "stderr", path: artifacts.stderrPath },
      ],
      links: [],
    });
    const completed = {
      status: "completed",
      worker: "codex",
      mode: readOnly ? "read_only_probe" : "workspace_write",
      readOnly,
      summary: asString(result.lastMessage) ?? "Codex completed.",
      lastMessage: asString(result.lastMessage),
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
      ...(typeof result.tokensUsed === "number" ? { tokensUsed: result.tokensUsed } : {}),
      changedFiles,
      ...(readOnly ? { repoChangedFiles } : {}),
      artifacts,
      evidence_attached: true,
      alignment_reported: true,
      evidenceBundle,
    };
    await writeResult(completed);
    return completed;
  } catch (err) {
    progressStopped = true;
    await progressLoop;
    await emitProgress();

    if (err instanceof CodexControlSignalError && err.signal.kind === "restart") {
      throw err;
    }

    const [lastMessage, stdoutTail, stderrTail, repoChangedFiles, finalChangedFileSnapshot] = await Promise.all([
      readTextTail(artifacts.lastMessagePath, 400),
      readTextTail(artifacts.stdoutPath, 900),
      readTextTail(artifacts.stderrPath, 600),
      gitChangedFiles(input.repoRoot),
      readOnly ? gitChangedFileSnapshots(workspacePath) : Promise.resolve(undefined),
    ]);
    const changedFiles = readOnly && initialChangedFileSnapshot && finalChangedFileSnapshot
      ? diffGitChangedSnapshots(initialChangedFileSnapshot, finalChangedFileSnapshot)
      : repoChangedFiles;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = readOnly && (changedFiles.length > 0 || looksLikeReadOnlyMutationFailure(rawMessage))
      ? DIRECT_CODEX_MUTATION_MESSAGE
      : rawMessage;
    await writeResult({
      status: "failed",
      worker: "codex",
      mode: readOnly ? "read_only_probe" : "workspace_write",
      readOnly,
      summary: message,
      lastMessage,
      stdoutTail,
      stderrTail,
      changedFiles,
      ...(readOnly ? { repoChangedFiles } : {}),
      artifacts,
      evidence_attached: true,
      alignment_reported: true,
      evidenceBundle: await buildEvidenceBundle({
        objectiveId: typeof input.payload?.objectiveId === "string" ? input.payload.objectiveId : input.jobId,
        taskId: typeof input.payload?.taskId === "string" ? input.payload.taskId : input.jobId,
        candidateId: typeof input.payload?.candidateId === "string" ? input.payload.candidateId : input.jobId,
        planSummary: "Structured evidence for codex job execution.",
        alignment: {
          verdict: "uncertain",
          satisfied: ["alignment.md emitted", "terminal result captured"],
          missing: [],
          outOfScope: [],
          rationale: "The job failed and was captured as minimally populated evidence.",
        },
        completion: {
          changed: changedFiles,
          proof: [alignmentPath],
          remaining: [],
        },
        scriptsRun: [],
        artifactPaths: [
          { label: "prompt", path: artifacts.promptPath },
          { label: "last message", path: artifacts.lastMessagePath },
          { label: "stdout", path: artifacts.stdoutPath },
          { label: "stderr", path: artifacts.stderrPath },
        ],
        links: [],
      }),
    });
    throw new Error(message);
  } finally {
    // no-op
  }
};
