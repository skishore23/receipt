import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const ASSETS_DEST = path.join(ROOT, "dist", "assets");
await fs.mkdir(ASSETS_DEST, { recursive: true });
await fs.copyFile(path.join(ROOT, "node_modules", "htmx.org", "dist", "htmx.min.js"), path.join(ASSETS_DEST, "htmx.min.js"));
const clientBuild = await Bun.build({
  entrypoints: [path.join(ROOT, "src", "client", "factory-client.ts")],
  outdir: ASSETS_DEST,
  target: "browser",
  format: "iife",
  minify: false,
});
if (!clientBuild.success) {
  throw new Error(clientBuild.logs.map((log) => log.message).join("\n"));
}
