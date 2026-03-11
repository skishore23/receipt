// ============================================================================
// Improvement Harness - deterministic + command-backed evaluation pipeline
// ============================================================================

import { spawn } from "node:child_process";

import type { ImprovementArtifactType } from "../../modules/self-improvement.js";

export type HarnessCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly durationMs?: number;
};

export type HarnessResult = {
  readonly status: "passed" | "failed";
  readonly checks: ReadonlyArray<HarnessCheck>;
  readonly report: string;
};

type CommandResult = {
  readonly ok: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
};

const runCommand = async (
  cmd: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: Readonly<Record<string, string>>
): Promise<CommandResult> =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, {
      cwd,
      env: {
        ...process.env,
        ...(extraEnv ?? {}),
      },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, Math.max(1_000, timeoutMs));

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });

const clip = (text: string, limit = 2_000): string => {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
};

const defaultCommand = (artifactType: ImprovementArtifactType): string =>
  artifactType === "harness_patch"
    ? (() => {
        const cmd = process.env.IMPROVEMENT_HARNESS_CMD;
        if (!cmd || !cmd.trim()) throw new Error("IMPROVEMENT_HARNESS_CMD missing");
        return cmd;
      })()
    : (() => {
        const cmd = process.env.IMPROVEMENT_VALIDATE_CMD;
        if (!cmd || !cmd.trim()) throw new Error("IMPROVEMENT_VALIDATE_CMD missing");
        return cmd;
      })();

export const evaluateImprovementProposal = async (opts: {
  readonly artifactType: ImprovementArtifactType;
  readonly target: string;
  readonly patch: string;
  readonly cwd: string;
}): Promise<HarnessResult> => {
  const checks: HarnessCheck[] = [];

  const nonEmpty = opts.patch.trim().length > 0;
  checks.push({
    name: "patch.non_empty",
    ok: nonEmpty,
    detail: nonEmpty ? "Patch body present." : "Patch is empty.",
  });

  const sizeOk = opts.patch.length <= 120_000;
  checks.push({
    name: "patch.size",
    ok: sizeOk,
    detail: sizeOk ? `Patch size ${opts.patch.length} chars.` : `Patch too large (${opts.patch.length} chars).`,
  });

  const targetSafe = !opts.target.includes("..") && !opts.target.startsWith("/");
  checks.push({
    name: "target.path_safety",
    ok: targetSafe,
    detail: targetSafe ? `Target '${opts.target}' accepted.` : `Unsafe target path '${opts.target}'.`,
  });

  const likelyJson = opts.patch.trim().startsWith("{") || opts.patch.trim().startsWith("[");
  if (likelyJson) {
    let jsonOk = true;
    try {
      JSON.parse(opts.patch);
    } catch {
      jsonOk = false;
    }
    checks.push({
      name: "patch.json_parse",
      ok: jsonOk,
      detail: jsonOk ? "Patch parses as JSON." : "Patch failed JSON parse.",
    });
  }

  const staticOk = checks.every((check) => check.ok);
  if (staticOk) {
    const cmd = defaultCommand(opts.artifactType);
    const command = await runCommand(cmd, opts.cwd, 180_000, {
      IMPROVEMENT_ARTIFACT_TYPE: opts.artifactType,
      IMPROVEMENT_TARGET: opts.target,
      IMPROVEMENT_PATCH: opts.patch,
    });
    checks.push({
      name: "harness.command",
      ok: command.ok,
      durationMs: command.durationMs,
      detail: command.ok
        ? `Command '${cmd}' succeeded in ${command.durationMs}ms.`
        : `Command '${cmd}' failed (code=${String(command.code)}, signal=${String(command.signal)}). stderr: ${clip(command.stderr || command.stdout)}`,
    });
  }

  const status = checks.every((check) => check.ok) ? "passed" : "failed";
  const report = checks
    .map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`)
    .join("\n");

  return {
    status,
    checks,
    report,
  };
};
