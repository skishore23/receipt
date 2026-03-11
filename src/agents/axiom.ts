import path from "node:path";

import { runAgent } from "./agent.js";
import type { AgentRunResult } from "./agent.result.js";
import {
  applyAxiomTaskHints,
  AXIOM_DEFAULT_CONFIG,
  AXIOM_WORKFLOW_ID,
  AXIOM_WORKFLOW_VERSION,
  normalizeAxiomConfig,
  parseAxiomConfig,
  type AxiomRequiredValidation,
  type AxiomRunConfig,
  type AxiomRunControl,
  type AxiomRunInput,
  type AxiomTaskHintReason,
  type AxiomTaskHints,
} from "./axiom/config.js";
import { createAxleToolset } from "./axiom/axle-tools.js";
import { createAxiomFinalizer } from "./axiom/finalizer.js";
import { createLocalLeanHarness } from "./axiom/local-lean.js";
import { createLocalToolset } from "./axiom/local-tools.js";
import { createCandidateTracker } from "./axiom/state.js";

export {
  AXIOM_DEFAULT_CONFIG,
  AXIOM_WORKFLOW_ID,
  AXIOM_WORKFLOW_VERSION,
  normalizeAxiomConfig,
  parseAxiomConfig,
  type AxiomRequiredValidation,
  type AxiomRunConfig,
  type AxiomRunControl,
  type AxiomRunInput,
  type AxiomTaskHintReason,
  type AxiomTaskHints,
};

const SCRATCH_DIR = ".receipt/axiom-scratch";

export const runAxiom = async (input: AxiomRunInput): Promise<AgentRunResult> => {
  const resolvedWorkspaceRoot = path.resolve(
    path.isAbsolute(input.config.workspace)
      ? input.config.workspace
      : path.join(input.workspaceRoot, input.config.workspace)
  );
  const tracker = createCandidateTracker(resolvedWorkspaceRoot, SCRATCH_DIR);
  const localLean = createLocalLeanHarness(resolvedWorkspaceRoot, SCRATCH_DIR);
  const axleToolset = createAxleToolset(input.config, tracker);
  const localToolset = createLocalToolset({
    defaults: input.config,
    tracker,
    localLean,
  });
  const finalizer = createAxiomFinalizer({
    defaults: input.config,
    tracker,
    localLean,
  });

  return runAgent({
    ...input,
    problem: applyAxiomTaskHints(input.problem, input.config.taskHints),
    config: input.config,
    prompts: input.prompts,
    workflowId: AXIOM_WORKFLOW_ID,
    workflowVersion: AXIOM_WORKFLOW_VERSION,
    extraConfig: {
      leanEnvironment: input.config.leanEnvironment,
      leanTimeoutSeconds: input.config.leanTimeoutSeconds,
      autoRepair: input.config.autoRepair,
      localValidationMode: input.config.localValidationMode,
      requiredValidation: input.config.requiredValidation,
      taskHints: input.config.taskHints,
    },
    extraToolSpecs: {
      ...axleToolset.specs,
      ...localToolset.specs,
    },
    extraTools: {
      ...axleToolset.tools,
      ...localToolset.tools,
    },
    finalizer,
  });
};
