import { expect, test } from "bun:test";

import { execCommandWithShellFallback, parseShellCommand } from "../../src/services/factory/check-runner";

test("parseShellCommand keeps quoted segments intact", () => {
  expect(parseShellCommand(`echo 'hello world' \"x y\"`)).toEqual(["echo", "hello world", "x y"]);
});

test("execCommandWithShellFallback retries with the probed shell after configured shell ENOENT", async () => {
  const calls: Array<{ readonly file: string; readonly args: ReadonlyArray<string> }> = [];
  const execImpl = async (file: string, args: ReadonlyArray<string>) => {
    calls.push({ file, args });
    if (file === "/missing/shell") {
      const error = new Error("spawn ENOENT") as Error & { code?: string };
      error.code = "ENOENT";
      throw error;
    }
    return { stdout: "ok", stderr: "" };
  };

  const result = await execCommandWithShellFallback({
    command: "echo ok",
    cwd: process.cwd(),
    env: process.env,
    shell: "/missing/shell",
    execImpl: execImpl as typeof execImpl,
    resolveShellImpl: () => "/bin/sh",
  });

  expect(result.stdout).toBe("ok");
  expect(calls).toEqual([
    { file: "/missing/shell", args: ["-lc", "echo ok"] },
    { file: "/bin/sh", args: ["-lc", "echo ok"] },
  ]);
});

test("execCommandWithShellFallback runs without a shell when no probed shell is available", async () => {
  const calls: Array<{ readonly file: string; readonly args: ReadonlyArray<string>; readonly options: Record<string, unknown> }> = [];
  const execImpl = async (file: string, args: ReadonlyArray<string>, options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    return { stdout: `${file}:${args.join("|")}`, stderr: "" };
  };

  const result = await execCommandWithShellFallback({
    command: "echo ok",
    cwd: process.cwd(),
    env: process.env,
    execImpl: execImpl as typeof execImpl,
    resolveShellImpl: () => undefined,
  });

  expect(result.stdout).toBe("echo:ok");
  expect(calls[0]?.options).toMatchObject({ shell: false });
});
