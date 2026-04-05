import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveAssetDir } from "../../src/server/assets";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("server assets: source runtime resolves repo dist assets", async () => {
  const root = await mkTmp("receipt-server-assets-src");
  try {
    const runtimeDir = path.join(root, "src", "server");
    const assetDir = path.join(root, "dist", "assets");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.mkdir(assetDir, { recursive: true });

    const resolved = resolveAssetDir(runtimeDir, { cwd: root });
    expect(resolved).toBe(assetDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("server assets: built runtime prefers sibling dist assets", async () => {
  const root = await mkTmp("receipt-server-assets-dist");
  try {
    const runtimeDir = path.join(root, "dist", "server");
    const assetDir = path.join(root, "dist", "assets");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.mkdir(assetDir, { recursive: true });

    const resolved = resolveAssetDir(runtimeDir, { cwd: root });
    expect(resolved).toBe(assetDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
