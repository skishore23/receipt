import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const outfile = path.join(distDir, "cli.js");

await fs.mkdir(distDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  alias: {
    "react-devtools-core": path.join(rootDir, "scripts", "shims", "react-devtools-core.js"),
  },
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "none",
});

const built = await fs.readFile(outfile, "utf-8");
const normalized = built.replace(/^#!\/usr\/bin\/env bun\r?\n/, "");
if (normalized !== built) {
  await fs.writeFile(outfile, normalized, "utf-8");
}

await fs.chmod(outfile, 0o755);
console.log(`built ${path.relative(rootDir, outfile)}`);
