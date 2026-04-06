import fs from "node:fs/promises";
import path from "node:path";

type PackageJson = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
};

const ROOT = process.cwd();
const packageJsonPath = path.join(ROOT, "package.json");
const packageJson = (await Bun.file(packageJsonPath).json()) as PackageJson;

const requiredPackages = [
  "htmx.org",
  "htmx-ext-sse",
  "@tailwindcss/cli",
] as const;

const requiredFiles = [
  {
    label: "htmx runtime",
    path: path.join(ROOT, "node_modules", "htmx.org", "dist", "htmx.min.js"),
    packageName: "htmx.org",
  },
  {
    label: "htmx SSE extension",
    path: path.join(ROOT, "node_modules", "htmx-ext-sse", "sse.js"),
    packageName: "htmx-ext-sse",
  },
] as const;

const missingPackages = requiredPackages.filter((name) =>
  !(packageJson.dependencies?.[name] || packageJson.devDependencies?.[name])
);

if (missingPackages.length > 0) {
  throw new Error(
    `Missing frontend dependency declaration(s) in package.json: ${missingPackages.join(", ")}`
  );
}

for (const entry of requiredFiles) {
  try {
    await fs.access(entry.path);
  } catch {
    throw new Error(
      `Missing frontend asset dependency: ${entry.label} not found at ${path.relative(ROOT, entry.path)}`
      + `; install or restore ${entry.packageName} before running bun run build`
    );
  }
}

