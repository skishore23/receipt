import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

test("package metadata: publish-safe cli configuration", async () => {
  const raw = await fs.readFile(path.join(ROOT, "package.json"), "utf-8");
  const pkg = JSON.parse(raw) as {
    readonly name?: string;
    readonly private?: boolean;
    readonly bin?: Record<string, string>;
    readonly engines?: Record<string, string>;
    readonly files?: ReadonlyArray<string>;
    readonly scripts?: Record<string, string>;
    readonly repository?: { readonly url?: string };
    readonly bugs?: { readonly url?: string };
    readonly homepage?: string;
  };
  const expectedRepoUrl = "https://github.com/Julian-Win-Stack/ki-s-startup.git";
  const expectedHomepage = "https://github.com/Julian-Win-Stack/ki-s-startup";
  const expectedBugsUrl = "https://github.com/Julian-Win-Stack/ki-s-startup/issues";

  expect(pkg.name).toBe("receipt-agent-cli");
  expect(pkg.private).toBe(false);
  expect(pkg.bin?.receipt).toBe("dist/cli.js");
  expect(pkg.engines?.node).toBe(">=20");
  expect(pkg.files?.includes("dist")).toBe(true);
  expect(pkg.scripts?.["pack:smoke"]).toBe("node scripts/smoke-pack-install.mjs");
  expect(pkg.repository?.url).toBe(expectedRepoUrl);
  expect(pkg.homepage).toBe(expectedHomepage);
  expect(pkg.bugs?.url).toBe(expectedBugsUrl);
});
