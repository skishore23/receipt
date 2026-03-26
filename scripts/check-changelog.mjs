import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, "package.json");
const changelogPath = path.join(rootDir, "CHANGELOG.md");

const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
if (!version) {
  throw new Error("package.json version is missing.");
}

const changelog = await fs.readFile(changelogPath, "utf-8");
const versionHeader = `## [${version}]`;
if (!changelog.includes(versionHeader)) {
  throw new Error(`CHANGELOG.md is missing an entry for ${versionHeader}.`);
}

console.log(`changelog check passed for ${versionHeader}`);
