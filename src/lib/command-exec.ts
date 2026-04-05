import fs from "node:fs";
import { spawn } from "node:child_process";

export type ShellResolution = {
  readonly shellPath?: string;
  readonly execMode: "shell" | "no-shell";
  readonly source: "config" | "env" | "default" | "fallback" | "none";
};

const DEFAULT_SHELLS = ["/bin/bash", "/usr/bin/bash", "/bin/sh"] as const;

const isExecutableFile = (filePath: string): boolean => {
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolveShell = (input?: {
  readonly configuredShell?: string;
  readonly envShell?: string;
  readonly allowFallback?: boolean;
}): ShellResolution => {
  const configuredShell = input?.configuredShell?.trim();
  if (configuredShell) {
    if (isExecutableFile(configuredShell)) {
      return { shellPath: configuredShell, execMode: "shell", source: "config" };
    }
    return {
      shellPath: isExecutableFile("/bin/sh") ? "/bin/sh" : undefined,
      execMode: isExecutableFile("/bin/sh") ? "shell" : "no-shell",
      source: input?.allowFallback === false ? "config" : "fallback",
    };
  }

  const envShell = input?.envShell?.trim();
  if (envShell && isExecutableFile(envShell)) {
    return { shellPath: envShell, execMode: "shell", source: "env" };
  }

  for (const candidate of DEFAULT_SHELLS) {
    if (isExecutableFile(candidate)) {
      return { shellPath: candidate, execMode: "shell", source: "default" };
    }
  }

  return { execMode: "no-shell", source: "none" };
};

export const selfTestShell = async (resolved: ShellResolution): Promise<void> => {
  if (!resolved.shellPath) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolved.shellPath, ["-lc", "echo receipt-shell-self-test"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`shell self-test failed for ${resolved.shellPath} (code ${code ?? "null"})${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
};

export const logStructuredShellWarning = (details: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ level: "warn", event: "shell_resolution", ...details }));
};
