import { expect, test } from "bun:test";

import { discoverShell, formatShellDiscoveryFailure } from "../../../src/services/factory/check-runner";

test("discoverShell prefers SHELL when it is executable", async () => {
  const result = await discoverShell({
    candidates: ["/custom/shell", "/bin/bash"],
    access: async (candidate) => {
      if (candidate !== "/custom/shell") throw new Error("missing");
    },
  });

  expect(result.shell).toBe("/custom/shell");
  expect(result.attempted).toEqual(["/custom/shell", "/bin/bash"]);
});

test("discoverShell falls back when /bin/bash is missing", async () => {
  const result = await discoverShell({
    candidates: ["/bin/bash", "/usr/bin/bash", "/bin/sh"],
    access: async (candidate) => {
      if (candidate === "/bin/sh") return;
      throw new Error(`missing ${candidate}`);
    },
  });

  expect(result.shell).toBe("/bin/sh");
  expect(result.attempted).toEqual(["/bin/bash", "/usr/bin/bash", "/bin/sh"]);
});

test("discoverShell supports PATH-only shells without hardcoded /bin paths", async () => {
  const result = await discoverShell({
    candidates: ["C:\\tools\\bash.exe", "sh"],
    access: async (candidate) => {
      if (candidate === "sh") return;
      throw new Error(`missing ${candidate}`);
    },
  });

  expect(result.shell).toBe("sh");
  expect(result.attempted).toEqual(["C:\\tools\\bash.exe", "sh"]);
});

test("formatShellDiscoveryFailure includes attempted shells and argv guidance", () => {
  const message = formatShellDiscoveryFailure(["/bin/bash", "/usr/bin/bash"]);

  expect(message).toContain("/bin/bash, /usr/bin/bash");
  expect(message).toContain("argv mode");
});
