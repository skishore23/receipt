import { createHash } from "node:crypto";

import type { AxleResult } from "../../adapters/axle.js";
import type { AgentRunInput, AgentToolResult } from "../agent.js";
import { getString, type AxiomToolInput } from "./requests.js";
import { readWorkspaceFile, writeScratchFile, writeWorkspaceFile } from "./workspace.js";

export type LeanCandidate =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly formalStatement?: string;
      readonly sourceTool: string;
    }
  | {
      readonly kind: "content";
      readonly content: string;
      readonly formalStatement?: string;
      readonly sourceTool: string;
    };

export type CandidateTracker = ReturnType<typeof createCandidateTracker>;

export const hashText = (input: string): string =>
  createHash("sha256").update(input, "utf-8").digest("hex");

export const summarizeMessages = (result: AxleResult): string => {
  const bits = [
    result.okay ? "okay" : "not okay",
    `lean_errors=${result.lean_messages.errors.length}`,
    `tool_errors=${result.tool_messages.errors.length}`,
    result.failed_declarations.length > 0 ? `failed=${result.failed_declarations.join(",")}` : "",
    result.documents ? `documents=${Object.keys(result.documents).length}` : "",
    result.lemma_names && result.lemma_names.length > 0 ? `lemmas=${result.lemma_names.length}` : "",
    result.disproved_theorems && result.disproved_theorems.length > 0 ? `disproved=${result.disproved_theorems.length}` : "",
    typeof result.timings.total_ms === "number" ? `total_ms=${result.timings.total_ms}` : "",
  ].filter(Boolean);
  return bits.join("; ");
};

export const formatAxleOutputLines = (label: string, result: AxleResult, extra?: ReadonlyArray<string>): ReadonlyArray<string> => [
  `${label}: ${summarizeMessages(result)}`,
  ...(extra ?? []),
  result.documents ? `documents: ${Object.keys(result.documents).join(", ") || "none"}` : "",
  result.lemma_names ? `lemma_names: ${result.lemma_names.join(", ") || "none"}` : "",
  result.disproved_theorems ? `disproved_theorems: ${result.disproved_theorems.join(", ") || "none"}` : "",
  result.repair_stats ? `repair_stats: ${JSON.stringify(result.repair_stats)}` : "",
  result.normalize_stats ? `normalize_stats: ${JSON.stringify(result.normalize_stats)}` : "",
  result.simplification_stats ? `simplification_stats: ${JSON.stringify(result.simplification_stats)}` : "",
  "lean_errors:",
  ...(result.lean_messages.errors.length > 0 ? result.lean_messages.errors.map((item) => `- ${item}`) : ["- none"]),
  "tool_errors:",
  ...(result.tool_messages.errors.length > 0 ? result.tool_messages.errors.map((item) => `- ${item}`) : ["- none"]),
  "warnings:",
  ...([...result.lean_messages.warnings, ...result.tool_messages.warnings].length > 0
    ? [...result.lean_messages.warnings, ...result.tool_messages.warnings].map((item) => `- ${item}`)
    : ["- none"]),
  "content:",
  result.content || "(empty)",
].filter(Boolean);

export const toToolOutput = (
  label: string,
  result: AxleResult,
  extra?: ReadonlyArray<string>,
  reports?: AgentToolResult["reports"]
): AgentToolResult => ({
  output: formatAxleOutputLines(label, result, extra).join("\n"),
  summary: `${label}: ${summarizeMessages(result)}`,
  reports,
});

export const buildAxleValidationReport = (opts: {
  readonly gate: string;
  readonly label: string;
  readonly result: AxleResult;
  readonly environment: string;
  readonly candidateContent: string;
  readonly target?: string;
  readonly formalStatement?: string;
  readonly extra?: ReadonlyArray<string>;
}): NonNullable<AgentToolResult["reports"]>[number] => ({
  gate: opts.gate,
  ok: opts.result.okay,
  summary: `${opts.label}: ${summarizeMessages(opts.result)}`,
  target: opts.target,
  details: formatAxleOutputLines(opts.label, opts.result, opts.extra).join("\n"),
  evidence: {
    tool: opts.label,
    environment: opts.environment,
    candidateHash: hashText(opts.candidateContent),
    formalStatementHash: opts.formalStatement ? hashText(opts.formalStatement) : undefined,
    failedDeclarations: opts.result.failed_declarations,
    timings: opts.result.timings,
    candidateContent: opts.candidateContent,
    formalStatement: opts.formalStatement,
  },
});

export const createCandidateTracker = (workspaceRoot: string, scratchDir: string) => {
  let latestCandidate: LeanCandidate | undefined;

  const rememberFileCandidate = (tool: string, rawPath: string, formalStatement?: string) => {
    latestCandidate = { kind: "file", path: rawPath, formalStatement, sourceTool: tool };
  };

  const rememberContentCandidate = (tool: string, content: string, formalStatement?: string) => {
    latestCandidate = { kind: "content", content, formalStatement, sourceTool: tool };
  };

  const loadFormalStatement = async (input: AxiomToolInput): Promise<string | undefined> => {
    const inline = getString(input, "formal_statement");
    if (inline) return inline;
    const rawPath = getString(input, "formalStatementPath") ?? getString(input, "formal_statement_path");
    return rawPath ? readWorkspaceFile(workspaceRoot, rawPath) : undefined;
  };

  const inferCandidateFromRun = async (
    runtime: AgentRunInput["runtime"],
    runStream: string
  ): Promise<LeanCandidate | undefined> => {
    if (latestCandidate) return latestCandidate;
    const chain = await runtime.chain(runStream);
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const event = chain[index]?.body;
      if (!event || event.type !== "action.planned" || event.actionType !== "tool") continue;
      const tool = event.name ?? "";
      const payload = event.input ?? {};
      const formalStatement = typeof payload.formal_statement === "string" ? payload.formal_statement : undefined;
      const candidatePath = typeof payload.path === "string" && payload.path.endsWith(".lean") ? payload.path : undefined;
      const candidateContent = typeof payload.content === "string" && payload.content.trim().length > 0 ? payload.content : undefined;
      if (tool === "write" && candidatePath) {
        return { kind: "file", path: candidatePath, sourceTool: tool };
      }
      if (candidatePath && tool.includes("lean")) {
        return { kind: "file", path: candidatePath, formalStatement, sourceTool: tool };
      }
      if (candidateContent && tool.includes("lean")) {
        return { kind: "content", content: candidateContent, formalStatement, sourceTool: tool };
      }
    }
    return undefined;
  };

  return {
    rememberFileCandidate,
    rememberContentCandidate,
    readWorkspaceFile: (rawPath: string) => readWorkspaceFile(workspaceRoot, rawPath),
    writeWorkspaceFile: (rawPath: string, content: string) => writeWorkspaceFile(workspaceRoot, rawPath, content),
    writeScratchFile: (content: string) => writeScratchFile(workspaceRoot, scratchDir, content),
    loadFormalStatement,
    inferCandidateFromRun,
  };
};
