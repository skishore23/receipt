import fs from "node:fs/promises";
import path from "node:path";

type AssetCheck = {
  readonly label: string;
  readonly paths: ReadonlyArray<string>;
};

const root = process.env.RECEIPT_ASSET_ROOT ? path.resolve(process.env.RECEIPT_ASSET_ROOT) : process.cwd();

const checks: ReadonlyArray<AssetCheck> = [
  {
    label: "HTMX runtime",
    paths: ["node_modules/htmx.org/dist/htmx.min.js"],
  },
  {
    label: "HTMX SSE extension",
    paths: ["node_modules/htmx-ext-sse/sse.js", "node_modules/htmx-ext-sse/dist/sse.js"],
  },
  {
    label: "Factory stylesheet source",
    paths: ["src/styles/factory.css"],
  },
];

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(path.join(root, filePath));
    return true;
  } catch {
    return false;
  }
};

const missing: string[] = [];

for (const check of checks) {
  const found = await Promise.all(check.paths.map(async (candidate) => [candidate, await exists(candidate)] as const));
  if (found.some(([, ok]) => ok)) continue;
  missing.push(`${check.label}: ${check.paths.map((candidate) => path.join(root, candidate)).join(" or ")}`);
}

if (missing.length > 0) {
  console.error([
    "Build asset verification failed.",
    "Missing required frontend build dependencies or assets:",
    ...missing.map((entry) => `- ${entry}`),
    "",
    "Restore or install the missing dependency, then rerun `bun run build`.",
  ].join("\n"));
  process.exit(1);
}

console.log("Build asset verification passed.");
