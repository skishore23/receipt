import path from "node:path";

import {
  axleCheck,
  axleDisprove,
  axleEnvironments,
  axleExtractTheorems,
  axleHaveToLemma,
  axleHaveToSorry,
  axleNormalize,
  axleRename,
  axleRepairProofs,
  axleSimplifyTheorems,
  axleSorryToLemma,
  axleTheoremToLemma,
  axleTheoremToSorry,
  axleVerifyProof,
  type AxleCheckRequest,
  type AxleDisproveRequest,
  type AxleExtractTheoremsRequest,
  type AxleHaveToLemmaRequest,
  type AxleHaveToSorryRequest,
  type AxleNormalizeRequest,
  type AxleRenameRequest,
  type AxleRepairRequest,
  type AxleResult,
  type AxleSimplifyTheoremsRequest,
  type AxleSorryToLemmaRequest,
  type AxleTheoremToLemmaRequest,
  type AxleTheoremToSorryRequest,
  type AxleVerifyRequest,
} from "../../adapters/axle.js";
import type { AgentToolExecutor } from "../agent.js";
import type { AxiomRunConfig } from "./config.js";
import {
  getBoolean,
  getString,
  requireString,
  toCheckRequest,
  toDisproveRequest,
  toExtractRequest,
  toHaveToLemmaRequest,
  toHaveToSorryRequest,
  toNormalizeRequest,
  toRenameRequest,
  toRepairRequest,
  toSimplifyRequest,
  toSorryToLemmaRequest,
  toTheoremToLemmaRequest,
  toTheoremToSorryRequest,
  toVerifyRequest,
  type AxiomToolInput,
} from "./requests.js";
import type { CandidateTracker } from "./state.js";
import { buildAxleValidationReport, summarizeMessages, toToolOutput } from "./state.js";

type AxleToolset = {
  readonly specs: Readonly<Record<string, string>>;
  readonly tools: Readonly<Record<string, AgentToolExecutor>>;
};

type TransformSpec<Req> = {
  readonly name: string;
  readonly call: (request: Req) => Promise<AxleResult>;
  readonly buildRequest: (input: AxiomToolInput, content: string) => Req;
  readonly rememberOutput?: boolean;
  readonly extraLines?: (request: Req, result: AxleResult) => ReadonlyArray<string>;
};

const createContentTransformTool = <Req extends { environment: string }>(
  tracker: CandidateTracker,
  spec: TransformSpec<Req>
): AgentToolExecutor =>
  async (input) => {
    const content = requireString(input, "content");
    tracker.rememberContentCandidate(spec.name, content);
    const request = spec.buildRequest(input, content);
    const result = await spec.call(request);
    if (spec.rememberOutput ?? true) {
      tracker.rememberContentCandidate(spec.name, result.content || content);
    }
    return toToolOutput(spec.name, result, spec.extraLines?.(request, result));
  };

const createFileTransformTool = <Req extends { environment: string }>(
  tracker: CandidateTracker,
  spec: TransformSpec<Req> & {
    readonly outputPath?: (input: AxiomToolInput, filePath: string) => string;
  }
): AgentToolExecutor =>
  async (input) => {
    const filePath = requireString(input, "path");
    const outputPath = spec.outputPath?.(input, filePath) ?? (getString(input, "outputPath") ?? getString(input, "output_path") ?? filePath);
    const content = await tracker.readWorkspaceFile(filePath);
    tracker.rememberFileCandidate(spec.name, filePath);
    const request = spec.buildRequest(input, content);
    const result = await spec.call(request);
    await tracker.writeWorkspaceFile(outputPath, result.content);
    tracker.rememberFileCandidate(spec.name, outputPath);
    return toToolOutput(spec.name, result, [
      `path: ${filePath}`,
      outputPath !== filePath ? `output_path: ${outputPath}` : "",
      ...(spec.extraLines?.(request, result) ?? []),
    ].filter(Boolean));
  };

export const createAxleToolset = (defaults: AxiomRunConfig, tracker: CandidateTracker): AxleToolset => {
  const runCycle = async (input: AxiomToolInput, content: string, formalStatement?: string) => {
    const autoRepair = getBoolean(input, "autoRepair") ?? getBoolean(input, "auto_repair") ?? defaults.autoRepair;
    const initial = formalStatement
      ? await axleVerifyProof(toVerifyRequest(input, defaults, content, formalStatement))
      : await axleCheck(toCheckRequest(input, defaults, content));

    let final = initial;
    let repaired = false;
    let repairStats: Readonly<Record<string, number>> | undefined;

    if (!initial.okay && autoRepair) {
      const repairedResult = await axleRepairProofs(toRepairRequest(input, defaults, content));
      repairStats = repairedResult.repair_stats;
      repaired = repairedResult.content.trim() !== content.trim()
        || Object.values(repairStats ?? {}).some((count) => count > 0);
      final = formalStatement
        ? await axleVerifyProof(toVerifyRequest(input, defaults, repairedResult.content || content, formalStatement))
        : await axleCheck(toCheckRequest(input, defaults, repairedResult.content || content));
    }

    return { initial, final, repaired, repairStats };
  };

  const tools: Record<string, AgentToolExecutor> = {};

  tools["lean.environments"] = async () => {
    const environments = await axleEnvironments();
    const output = environments.map((env) => `${env.name}${env.description ? ` - ${env.description}` : ""}`).join("\n");
    return {
      output: output || "(no environments returned)",
      summary: `environments: ${environments.length}`,
    };
  };

  tools["lean.check"] = async (input) => {
    const content = requireString(input, "content");
    tracker.rememberContentCandidate("lean.check", content);
    const request = toCheckRequest(input, defaults, content);
    const result = await axleCheck(request);
    return toToolOutput("lean.check", result, undefined, [
      buildAxleValidationReport({
        gate: "axle-check",
        label: "lean.check",
        result,
        environment: request.environment,
        candidateContent: content,
      }),
    ]);
  };

  tools["lean.verify"] = async (input) => {
    const content = requireString(input, "content");
    const formalStatement = requireString(input, "formal_statement");
    tracker.rememberContentCandidate("lean.verify", content, formalStatement);
    const request = toVerifyRequest(input, defaults, content, formalStatement);
    const result = await axleVerifyProof(request);
    return toToolOutput("lean.verify", result, undefined, [
      buildAxleValidationReport({
        gate: "axle-verify",
        label: "lean.verify",
        result,
        environment: request.environment,
        candidateContent: content,
        formalStatement,
      }),
    ]);
  };

  tools["lean.repair"] = createContentTransformTool<AxleRepairRequest>(tracker, {
    name: "lean.repair",
    call: axleRepairProofs,
    buildRequest: (input, content) => toRepairRequest(input, defaults, content),
  });

  tools["lean.extract_theorems"] = createContentTransformTool<AxleExtractTheoremsRequest>(tracker, {
    name: "lean.extract_theorems",
    call: axleExtractTheorems,
    buildRequest: (input, content) => toExtractRequest(input, defaults, content),
    rememberOutput: false,
  });

  tools["lean.normalize"] = createContentTransformTool<AxleNormalizeRequest>(tracker, {
    name: "lean.normalize",
    call: axleNormalize,
    buildRequest: (input, content) => toNormalizeRequest(input, defaults, content),
  });

  tools["lean.simplify"] = createContentTransformTool<AxleSimplifyTheoremsRequest>(tracker, {
    name: "lean.simplify",
    call: axleSimplifyTheorems,
    buildRequest: (input, content) => toSimplifyRequest(input, defaults, content),
  });

  tools["lean.sorry2lemma"] = createContentTransformTool<AxleSorryToLemmaRequest>(tracker, {
    name: "lean.sorry2lemma",
    call: axleSorryToLemma,
    buildRequest: (input, content) => toSorryToLemmaRequest(input, defaults, content),
  });

  tools["lean.theorem2sorry"] = createContentTransformTool<AxleTheoremToSorryRequest>(tracker, {
    name: "lean.theorem2sorry",
    call: axleTheoremToSorry,
    buildRequest: (input, content) => toTheoremToSorryRequest(input, defaults, content),
  });

  tools["lean.rename"] = createContentTransformTool<AxleRenameRequest>(tracker, {
    name: "lean.rename",
    call: axleRename,
    buildRequest: (input, content) => toRenameRequest(input, defaults, content),
    extraLines: (request) => [`declarations: ${JSON.stringify(request.declarations)}`],
  });

  tools["lean.theorem2lemma"] = createContentTransformTool<AxleTheoremToLemmaRequest>(tracker, {
    name: "lean.theorem2lemma",
    call: axleTheoremToLemma,
    buildRequest: (input, content) => toTheoremToLemmaRequest(input, defaults, content),
    extraLines: (request) => [
      request.target ? `target: ${request.target}` : "",
      request.names?.length ? `names: ${request.names.join(", ")}` : "",
      request.indices?.length ? `indices: ${request.indices.join(", ")}` : "",
    ].filter(Boolean),
  });

  tools["lean.have2lemma"] = createContentTransformTool<AxleHaveToLemmaRequest>(tracker, {
    name: "lean.have2lemma",
    call: axleHaveToLemma,
    buildRequest: (input, content) => toHaveToLemmaRequest(input, defaults, content),
    extraLines: (request, result) => [
      request.include_have_body ? "include_have_body: true" : "",
      request.reconstruct_callsite ? "reconstruct_callsite: true" : "",
      result.lemma_names?.length ? `lemma_names: ${result.lemma_names.join(", ")}` : "",
    ].filter(Boolean),
  });

  tools["lean.have2sorry"] = createContentTransformTool<AxleHaveToSorryRequest>(tracker, {
    name: "lean.have2sorry",
    call: axleHaveToSorry,
    buildRequest: (input, content) => toHaveToSorryRequest(input, defaults, content),
  });

  tools["lean.disprove"] = async (input) => {
    const content = requireString(input, "content");
    tracker.rememberContentCandidate("lean.disprove", content);
    const result = await axleDisprove(toDisproveRequest(input, defaults, content));
    return toToolOutput("lean.disprove", result);
  };

  tools["lean.cycle"] = async (input) => {
    const content = requireString(input, "content");
    const formalStatement = getString(input, "formal_statement");
    tracker.rememberContentCandidate("lean.cycle", content, formalStatement);
    const { initial, final, repaired, repairStats } = await runCycle(input, content, formalStatement);
    tracker.rememberContentCandidate("lean.cycle", final.content || content, formalStatement);
    return toToolOutput("lean.cycle", final, [
      `initial: ${summarizeMessages(initial)}`,
      `repaired: ${repaired ? "yes" : "no"}`,
      `repair_stats: ${repairStats ? JSON.stringify(repairStats) : "none"}`,
    ]);
  };

  tools["lean.check_file"] = async (input) => {
    const filePath = requireString(input, "path");
    tracker.rememberFileCandidate("lean.check_file", filePath);
    const candidateContent = await tracker.readWorkspaceFile(filePath);
    const request = toCheckRequest(input, defaults, candidateContent);
    const result = await axleCheck(request);
    return toToolOutput("lean.check_file", result, [`path: ${filePath}`], [
      buildAxleValidationReport({
        gate: "axle-check",
        label: "lean.check_file",
        result,
        environment: request.environment,
        candidateContent,
        target: filePath,
        extra: [`path: ${filePath}`],
      }),
    ]);
  };

  tools["lean.verify_file"] = async (input) => {
    const filePath = requireString(input, "path");
    const formalStatement = await tracker.loadFormalStatement(input);
    if (!formalStatement) throw new Error("formal_statement or formalStatementPath is required");
    tracker.rememberFileCandidate("lean.verify_file", filePath, formalStatement);
    const candidateContent = await tracker.readWorkspaceFile(filePath);
    const request = toVerifyRequest(input, defaults, candidateContent, formalStatement);
    const result = await axleVerifyProof(request);
    return toToolOutput("lean.verify_file", result, [`path: ${filePath}`], [
      buildAxleValidationReport({
        gate: "axle-verify",
        label: "lean.verify_file",
        result,
        environment: request.environment,
        candidateContent,
        target: filePath,
        formalStatement,
        extra: [`path: ${filePath}`],
      }),
    ]);
  };

  tools["lean.repair_file"] = createFileTransformTool<AxleRepairRequest>(tracker, {
    name: "lean.repair_file",
    call: axleRepairProofs,
    buildRequest: (input, content) => toRepairRequest(input, defaults, content),
  });

  tools["lean.normalize_file"] = createFileTransformTool<AxleNormalizeRequest>(tracker, {
    name: "lean.normalize_file",
    call: axleNormalize,
    buildRequest: (input, content) => toNormalizeRequest(input, defaults, content),
  });

  tools["lean.simplify_file"] = createFileTransformTool<AxleSimplifyTheoremsRequest>(tracker, {
    name: "lean.simplify_file",
    call: axleSimplifyTheorems,
    buildRequest: (input, content) => toSimplifyRequest(input, defaults, content),
  });

  tools["lean.sorry2lemma_file"] = createFileTransformTool<AxleSorryToLemmaRequest>(tracker, {
    name: "lean.sorry2lemma_file",
    call: axleSorryToLemma,
    buildRequest: (input, content) => toSorryToLemmaRequest(input, defaults, content),
  });

  tools["lean.theorem2sorry_file"] = createFileTransformTool<AxleTheoremToSorryRequest>(tracker, {
    name: "lean.theorem2sorry_file",
    call: axleTheoremToSorry,
    buildRequest: (input, content) => toTheoremToSorryRequest(input, defaults, content),
  });

  tools["lean.rename_file"] = createFileTransformTool<AxleRenameRequest>(tracker, {
    name: "lean.rename_file",
    call: axleRename,
    buildRequest: (input, content) => toRenameRequest(input, defaults, content),
    extraLines: (request) => [`declarations: ${JSON.stringify(request.declarations)}`],
  });

  tools["lean.theorem2lemma_file"] = createFileTransformTool<AxleTheoremToLemmaRequest>(tracker, {
    name: "lean.theorem2lemma_file",
    call: axleTheoremToLemma,
    buildRequest: (input, content) => toTheoremToLemmaRequest(input, defaults, content),
    extraLines: (request) => [
      request.target ? `target: ${request.target}` : "",
      request.names?.length ? `names: ${request.names.join(", ")}` : "",
      request.indices?.length ? `indices: ${request.indices.join(", ")}` : "",
    ].filter(Boolean),
  });

  tools["lean.have2lemma_file"] = createFileTransformTool<AxleHaveToLemmaRequest>(tracker, {
    name: "lean.have2lemma_file",
    call: axleHaveToLemma,
    buildRequest: (input, content) => toHaveToLemmaRequest(input, defaults, content),
    extraLines: (request, result) => [
      request.include_have_body ? "include_have_body: true" : "",
      request.reconstruct_callsite ? "reconstruct_callsite: true" : "",
      result.lemma_names?.length ? `lemma_names: ${result.lemma_names.join(", ")}` : "",
    ].filter(Boolean),
  });

  tools["lean.have2sorry_file"] = createFileTransformTool<AxleHaveToSorryRequest>(tracker, {
    name: "lean.have2sorry_file",
    call: axleHaveToSorry,
    buildRequest: (input, content) => toHaveToSorryRequest(input, defaults, content),
  });

  tools["lean.disprove_file"] = async (input) => {
    const filePath = requireString(input, "path");
    tracker.rememberFileCandidate("lean.disprove_file", filePath);
    const result = await axleDisprove(toDisproveRequest(input, defaults, await tracker.readWorkspaceFile(filePath)));
    return toToolOutput("lean.disprove_file", result, [`path: ${filePath}`]);
  };

  tools["lean.extract_theorems_file"] = async (input) => {
    const filePath = requireString(input, "path");
    const outputDir = getString(input, "outputDir") ?? getString(input, "output_dir");
    const result = await axleExtractTheorems(toExtractRequest(input, defaults, await tracker.readWorkspaceFile(filePath)));
    if (outputDir && result.documents) {
      for (const [name, doc] of Object.entries(result.documents)) {
        const slug = name.replace(/[^A-Za-z0-9_.-]+/g, "_");
        await tracker.writeWorkspaceFile(path.join(outputDir, `${slug}.lean`), typeof doc.content === "string" ? doc.content : result.content);
      }
    }
    tracker.rememberFileCandidate("lean.extract_theorems_file", filePath);
    return toToolOutput("lean.extract_theorems_file", result, [
      `path: ${filePath}`,
      outputDir ? `output_dir: ${outputDir}` : "",
    ].filter(Boolean));
  };

  tools["lean.cycle_file"] = async (input) => {
    const filePath = requireString(input, "path");
    const outputPath = getString(input, "outputPath") ?? getString(input, "output_path") ?? filePath;
    const formalStatement = await tracker.loadFormalStatement(input);
    const content = await tracker.readWorkspaceFile(filePath);
    const { initial, final, repaired, repairStats } = await runCycle(
      formalStatement ? { ...input, formal_statement: formalStatement } : input,
      content,
      formalStatement
    );
    await tracker.writeWorkspaceFile(outputPath, final.content || content);
    tracker.rememberFileCandidate("lean.cycle_file", outputPath, formalStatement);
    return toToolOutput("lean.cycle_file", final, [
      `path: ${filePath}`,
      `output_path: ${outputPath}`,
      `initial: ${summarizeMessages(initial)}`,
      `repaired: ${repaired ? "yes" : "no"}`,
      `repair_stats: ${repairStats ? JSON.stringify(repairStats) : "none"}`,
    ]);
  };

  return {
    specs: {
      "lean.environments": "{} - List available AXLE Lean environments.",
      "lean.check": '{"content": string, "environment"?: string, "mathlibLinter"?: boolean, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Compile Lean source with AXLE and return compiler/tool messages.',
      "lean.verify": '{"content": string, "formal_statement": string, "environment"?: string, "permittedSorries"?: string[], "mathlibLinter"?: boolean, "useDefEq"?: boolean, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Verify a candidate Lean proof against a formal statement with AXLE.',
      "lean.repair": '{"content": string, "environment"?: string, "names"?: string[], "repairs"?: string[], "terminalTactics"?: string[], "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Apply AXLE repair passes to Lean code.',
      "lean.extract_theorems": '{"content": string, "environment"?: string, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Extract standalone theorem documents from Lean code using AXLE.',
      "lean.normalize": '{"content": string, "environment"?: string, "normalizations"?: string[], "failsafe"?: boolean, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Normalize Lean code using AXLE.',
      "lean.simplify": '{"content": string, "environment"?: string, "names"?: string[], "indices"?: number[], "simplifications"?: string[], "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Simplify theorem proofs using AXLE.',
      "lean.sorry2lemma": '{"content": string, "environment"?: string, "names"?: string[], "indices"?: number[], "extractSorries"?: boolean, "extractErrors"?: boolean, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Replace sorries or unsolved errors with generated lemma obligations using AXLE.',
      "lean.theorem2sorry": '{"content": string, "environment"?: string, "names"?: string[], "indices"?: number[], "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Strip proofs from selected theorems by replacing them with `sorry` using AXLE.',
      "lean.rename": '{"content": string, "declarations"?: Record<string, string>, "oldName"?: string, "newName"?: string, "environment"?: string, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Rename declarations and update references throughout the Lean source.',
      "lean.theorem2lemma": '{"content": string, "names"?: string[], "indices"?: number[], "target"?: "lemma" | "theorem", "environment"?: string, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Convert theorem declarations to lemmas, or back to theorems with `target: \"theorem\"`.',
      "lean.have2lemma": '{"content": string, "names"?: string[], "indices"?: number[], "includeHaveBody"?: boolean, "includeWholeContext"?: boolean, "reconstructCallsite"?: boolean, "verbosity"?: number, "environment"?: string, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Lift `have` blocks into top-level lemmas for focused repair.',
      "lean.have2sorry": '{"content": string, "names"?: string[], "indices"?: number[], "environment"?: string, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Replace `have` proof bodies with `sorry` while preserving theorem structure.',
      "lean.disprove": '{"content": string, "environment"?: string, "names"?: string[], "indices"?: number[], "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Ask AXLE to disprove candidate theorems.',
      "lean.cycle": '{"content": string, "formal_statement"?: string, "autoRepair"?: boolean, ...lean.verify/lean.repair options} - Run AXLE check or verify, optionally repair, then re-run with the repaired content.',
      "lean.check_file": '{"path": string, "environment"?: string, "mathlibLinter"?: boolean, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Read a workspace .lean file and check it with AXLE.',
      "lean.verify_file": '{"path": string, "formal_statement"?: string, "formalStatementPath"?: string, "environment"?: string, ...} - Verify a workspace Lean file against a formal statement string or file.',
      "lean.repair_file": '{"path": string, "outputPath"?: string, "environment"?: string, ...} - Repair a workspace Lean file with AXLE and write the result back to disk.',
      "lean.normalize_file": '{"path": string, "outputPath"?: string, "environment"?: string, "normalizations"?: string[], "failsafe"?: boolean, ...} - Normalize a workspace Lean file with AXLE and write the result back to disk.',
      "lean.simplify_file": '{"path": string, "outputPath"?: string, "environment"?: string, "names"?: string[], "indices"?: number[], "simplifications"?: string[], ...} - Simplify theorems in a workspace Lean file with AXLE and write the result back to disk.',
      "lean.sorry2lemma_file": '{"path": string, "outputPath"?: string, "environment"?: string, "names"?: string[], "indices"?: number[], "extractSorries"?: boolean, "extractErrors"?: boolean, ...} - Convert sorries/errors in a workspace Lean file into lemmas and write the result back to disk.',
      "lean.theorem2sorry_file": '{"path": string, "outputPath"?: string, "environment"?: string, "names"?: string[], "indices"?: number[], ...} - Replace proofs in a workspace Lean file with `sorry` for selected theorems and write the result back to disk.',
      "lean.rename_file": '{"path": string, "outputPath"?: string, "declarations"?: Record<string, string>, "oldName"?: string, "newName"?: string, "environment"?: string, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Rename declarations in a workspace Lean file and update references.',
      "lean.theorem2lemma_file": '{"path": string, "outputPath"?: string, "names"?: string[], "indices"?: number[], "target"?: "lemma" | "theorem", "environment"?: string, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Convert theorem declarations to lemmas in a workspace Lean file.',
      "lean.have2lemma_file": '{"path": string, "outputPath"?: string, "names"?: string[], "indices"?: number[], "includeHaveBody"?: boolean, "includeWholeContext"?: boolean, "reconstructCallsite"?: boolean, "verbosity"?: number, "environment"?: string, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Extract `have` blocks into top-level lemmas inside a workspace Lean file.',
      "lean.have2sorry_file": '{"path": string, "outputPath"?: string, "names"?: string[], "indices"?: number[], "environment"?: string, "ignoreImports"?: boolean, "timeoutSeconds"?: number} - Replace `have` proof bodies with `sorry` in a workspace Lean file.',
      "lean.disprove_file": '{"path": string, "environment"?: string, "names"?: string[], "indices"?: number[], ...} - Run AXLE disproval checks against a workspace Lean file.',
      "lean.extract_theorems_file": '{"path": string, "outputDir"?: string, "environment"?: string, ...} - Extract standalone theorem documents from a workspace Lean file using AXLE and optionally write them to an output directory.',
      "lean.cycle_file": '{"path": string, "outputPath"?: string, "formal_statement"?: string, "formalStatementPath"?: string, "autoRepair"?: boolean, ...} - Read a workspace Lean file, run AXLE check/verify with optional repair, and write final content to disk.',
    },
    tools,
  };
};
