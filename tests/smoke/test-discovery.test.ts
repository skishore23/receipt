import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");

test("bun test discovery is pinned to the checked-in tests root", async () => {
  const bunfig = await fs.readFile(path.join(ROOT, "bunfig.toml"), "utf-8");
  expect(bunfig).toMatch(/\[test\]/);
  expect(bunfig).toMatch(/root\s*=\s*"tests"/);
});
