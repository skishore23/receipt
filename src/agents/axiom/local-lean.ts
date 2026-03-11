import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type { AgentToolResult } from "../agent.js";
import { exists, resolveWorkspacePath, writeScratchFile } from "./workspace.js";

export type CommandResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly command: string;
  readonly cwd: string;
};

export type LocalLeanRunner = {
  readonly ok: boolean;
  readonly tool: "lake" | "lean";
  readonly command: string;
  readonly argsPrefix: ReadonlyArray<string>;
  readonly cwd: string;
  readonly version?: string;
  readonly note: string;
};

const runCommand = async (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number
): Promise<CommandResult> =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}${String(err.message || err)}`;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(500, timeoutMs));

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        command: [command, ...args].join(" "),
        cwd,
      });
    });
  });

const findProjectRoot = async (workspaceRoot: string, startDir: string): Promise<string | undefined> => {
  let current = path.resolve(startDir);
  const root = path.resolve(workspaceRoot);
  while (current === root || current.startsWith(`${root}${path.sep}`)) {
    if (
      await exists(path.join(current, "lakefile.lean"))
      || await exists(path.join(current, "lakefile.toml"))
      || await exists(path.join(current, "lean-toolchain"))
    ) {
      return current;
    }
    if (current === root) return undefined;
    current = path.dirname(current);
  }
  return undefined;
};

const detectLocalLeanRunner = async (workspaceRoot: string, rawPath?: string): Promise<LocalLeanRunner> => {
  const absTarget = rawPath ? resolveWorkspacePath(workspaceRoot, rawPath) : workspaceRoot;
  const baseDir = (await exists(absTarget) && !(await fs.stat(absTarget)).isDirectory()) ? path.dirname(absTarget) : absTarget;
  const timeoutMs = 5_000;
  const projectRoot = await findProjectRoot(workspaceRoot, baseDir);

  const lakeVersion = await runCommand("lake", ["--version"], projectRoot ?? workspaceRoot, timeoutMs);
  if ((lakeVersion.code ?? 1) === 0 && projectRoot) {
    return {
      ok: true,
      tool: "lake",
      command: "lake",
      argsPrefix: ["env", "lean"],
      cwd: projectRoot,
      version: (lakeVersion.stdout || lakeVersion.stderr).trim().split("\n")[0] || undefined,
      note: `lake env lean from ${projectRoot}`,
    };
  }

  const leanVersion = await runCommand("lean", ["--version"], projectRoot ?? workspaceRoot, timeoutMs);
  if ((leanVersion.code ?? 1) === 0) {
    return {
      ok: true,
      tool: "lean",
      command: "lean",
      argsPrefix: [],
      cwd: projectRoot ?? workspaceRoot,
      version: (leanVersion.stdout || leanVersion.stderr).trim().split("\n")[0] || undefined,
      note: `lean from ${projectRoot ?? workspaceRoot}`,
    };
  }

  const detail = [lakeVersion.stderr.trim(), leanVersion.stderr.trim()].filter(Boolean).join(" | ") || "lake/lean not found";
  return {
    ok: false,
    tool: "lean",
    command: "lean",
    argsPrefix: [],
    cwd: projectRoot ?? workspaceRoot,
    note: detail,
  };
};

export const formatLocalToolOutput = (
  label: string,
  runner: LocalLeanRunner,
  result: CommandResult,
  extra?: ReadonlyArray<string>
): AgentToolResult => {
  const okay = (result.code ?? 1) === 0 && !result.timedOut;
  const lines = [
    `${label}: ${okay ? "okay" : "failed"}; exit=${result.code ?? "null"}; signal=${result.signal ?? "none"}; timed_out=${result.timedOut ? "yes" : "no"}`,
    `runner: ${runner.note}`,
    runner.version ? `version: ${runner.version}` : "",
    `command: ${result.command}`,
    `cwd: ${result.cwd}`,
    ...(extra ?? []),
    result.stdout ? `stdout:\n${result.stdout}` : "stdout:\n(empty)",
    result.stderr ? `stderr:\n${result.stderr}` : "stderr:\n(empty)",
  ].filter(Boolean);
  return {
    output: lines.join("\n"),
    summary: `${label}: ${okay ? "okay" : "failed"}; exit=${result.code ?? "null"}`,
  };
};

export const createLocalLeanHarness = (workspaceRoot: string, scratchDir: string) => {
  const runOnFile = async (rawPath: string, timeoutSeconds: number): Promise<{ readonly runner: LocalLeanRunner; readonly result: CommandResult }> => {
    const abs = resolveWorkspacePath(workspaceRoot, rawPath);
    const runner = await detectLocalLeanRunner(workspaceRoot, rawPath);
    if (!runner.ok) {
      throw new Error(`local Lean unavailable: ${runner.note}`);
    }
    const result = await runCommand(runner.command, [...runner.argsPrefix, abs], runner.cwd, Math.max(5, timeoutSeconds) * 1_000);
    return { runner, result };
  };

  const runOnContent = async (
    content: string,
    timeoutSeconds: number,
    keepScratch = false
  ): Promise<{ readonly runner: LocalLeanRunner; readonly result: CommandResult; readonly rel: string }> => {
    const scratch = await writeScratchFile(workspaceRoot, scratchDir, content);
    try {
      const runner = await detectLocalLeanRunner(workspaceRoot, scratch.rel);
      if (!runner.ok) {
        throw new Error(`local Lean unavailable: ${runner.note}`);
      }
      const result = await runCommand(runner.command, [...runner.argsPrefix, scratch.abs], runner.cwd, Math.max(5, timeoutSeconds) * 1_000);
      return { runner, result, rel: scratch.rel };
    } finally {
      if (!keepScratch) {
        await fs.rm(scratch.abs, { force: true });
      }
    }
  };

  const info = async (rawPath?: string): Promise<LocalLeanRunner> => detectLocalLeanRunner(workspaceRoot, rawPath);

  const build = async (
    rawPath: string | undefined,
    targets: ReadonlyArray<string>,
    timeoutSeconds: number
  ): Promise<{ readonly runner: LocalLeanRunner; readonly result: CommandResult }> => {
    const runner = await detectLocalLeanRunner(workspaceRoot, rawPath);
    if (!runner.ok || runner.tool !== "lake") {
      throw new Error(`lake build unavailable: ${runner.note}`);
    }
    const result = await runCommand("lake", ["build", ...targets], runner.cwd, Math.max(5, timeoutSeconds) * 1_000);
    return { runner, result };
  };

  return {
    runOnFile,
    runOnContent,
    info,
    build,
  };
};

export type LocalLeanHarness = ReturnType<typeof createLocalLeanHarness>;
