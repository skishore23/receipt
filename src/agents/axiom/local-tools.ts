import type { AgentToolExecutor } from "../agent.js";
import type { AxiomRunConfig } from "./config.js";
import type { LocalLeanHarness } from "./local-lean.js";
import { getBoolean, getNumber, getString, getStringList, requireString } from "./requests.js";
import type { CandidateTracker } from "./state.js";
import { formatLocalToolOutput } from "./local-lean.js";

type LocalToolset = {
  readonly specs: Readonly<Record<string, string>>;
  readonly tools: Readonly<Record<string, AgentToolExecutor>>;
};

export const createLocalToolset = (opts: {
  readonly defaults: AxiomRunConfig;
  readonly tracker: CandidateTracker;
  readonly localLean: LocalLeanHarness;
}): LocalToolset => {
  const { defaults, tracker, localLean } = opts;

  return {
    specs: {
      "lean.local.info": '{} - Detect local Lean or lake availability for final validation.',
      "lean.local.check": '{"content": string, "timeoutSeconds"?: number, "keepScratch"?: boolean} - Write scratch Lean content and validate it locally with lake env lean or lean.',
      "lean.local.check_file": '{"path": string, "timeoutSeconds"?: number} - Validate an existing workspace .lean file locally with lake env lean or lean.',
      "lean.local.build": '{"targets"?: string[], "timeoutSeconds"?: number, "path"?: string} - Run lake build in the detected Lean project root.',
    },
    tools: {
      "lean.local.info": async (input) => {
        const runner = await localLean.info(getString(input, "path"));
        return {
          output: [
            `available: ${runner.ok ? "yes" : "no"}`,
            `note: ${runner.note}`,
            runner.version ? `version: ${runner.version}` : "",
            `cwd: ${runner.cwd}`,
          ].filter(Boolean).join("\n"),
          summary: `lean.local.info: ${runner.ok ? "available" : "missing"}`,
        };
      },
      "lean.local.check": async (input) => {
        const content = requireString(input, "content");
        const keepScratch = getBoolean(input, "keepScratch") ?? getBoolean(input, "keep_scratch") ?? false;
        tracker.rememberContentCandidate("lean.local.check", content);
        const timeoutSeconds = Math.max(5, Math.min(1_800, getNumber(input, "timeoutSeconds") ?? getNumber(input, "timeout_seconds") ?? defaults.leanTimeoutSeconds));
        const { runner, result, rel } = await localLean.runOnContent(content, timeoutSeconds, keepScratch);
        return formatLocalToolOutput("lean.local.check", runner, result, [`scratch: ${rel}`]);
      },
      "lean.local.check_file": async (input) => {
        const filePath = requireString(input, "path");
        tracker.rememberFileCandidate("lean.local.check_file", filePath);
        const timeoutSeconds = Math.max(5, Math.min(1_800, getNumber(input, "timeoutSeconds") ?? getNumber(input, "timeout_seconds") ?? defaults.leanTimeoutSeconds));
        const { runner, result } = await localLean.runOnFile(filePath, timeoutSeconds);
        return formatLocalToolOutput("lean.local.check_file", runner, result, [`path: ${filePath}`]);
      },
      "lean.local.build": async (input) => {
        const targets = getStringList(input, "targets") ?? [];
        const timeoutSeconds = Math.max(5, Math.min(1_800, getNumber(input, "timeoutSeconds") ?? getNumber(input, "timeout_seconds") ?? defaults.leanTimeoutSeconds));
        const { runner, result } = await localLean.build(getString(input, "path"), targets, timeoutSeconds);
        return formatLocalToolOutput("lean.local.build", runner, result, targets.length > 0 ? [`targets: ${targets.join(", ")}`] : []);
      },
    },
  };
};
