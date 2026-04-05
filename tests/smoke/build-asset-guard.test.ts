import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

const repoRoot = process.cwd();

test("verify-assets fails fast when required frontend assets are missing", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "receipt-assets-guard-"));
  await mkdir(path.join(tempRoot, "node_modules", "htmx.org", "dist"), { recursive: true });
  await mkdir(path.join(tempRoot, "src", "styles"), { recursive: true });
  await writeFile(path.join(tempRoot, "node_modules", "htmx.org", "dist", "htmx.min.js"), "");
  await writeFile(path.join(tempRoot, "src", "styles", "factory.css"), "");

  const proc = Bun.spawn({
    cmd: ["bun", path.join(repoRoot, "scripts", "verify-assets.ts")],
    cwd: tempRoot,
    env: { RECEIPT_ASSET_ROOT: tempRoot },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(exitCode).not.toBe(0);
  expect(stdout).toContain("Build asset verification failed");
  expect(stderr).toContain("HTMX SSE extension");
});
