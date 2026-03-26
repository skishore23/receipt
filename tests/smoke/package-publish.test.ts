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

  expect(pkg.name).toBe("receipt-agent-cli");
  expect(pkg.private).toBe(false);
  expect(pkg.bin?.receipt).toBe("dist/cli.js");
  expect(pkg.engines?.node).toBe(">=20");
  expect(pkg.files?.includes("dist")).toBe(true);
  expect(pkg.scripts?.["pack:smoke"]).toBe("node scripts/smoke-pack-install.mjs");
  expect(pkg.repository?.url).toBe("https://github.com/skishore23/receipt.git");
  expect(pkg.homepage).toBe("https://github.com/skishore23/receipt");
  expect(pkg.bugs?.url).toBe("https://github.com/skishore23/receipt/issues");
});
