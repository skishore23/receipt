import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const rootDir = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf-8"));
const packageName = typeof packageJson.name === "string" ? packageJson.name : "";
if (!packageName) {
  throw new Error("package.json name is missing.");
}
const tarballPrefix = `${packageName.replace("@", "").replace("/", "-")}-`;

const run = (command, args, cwd, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code ?? "null"}`));
    });
  });

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-pack-smoke-"));
const installDir = path.join(tempDir, "install-target");

try {
  await run("npm", ["pack"], rootDir);
  const files = await fs.readdir(rootDir);
  const tarball = files
    .filter((name) => name.startsWith(tarballPrefix) && name.endsWith(".tgz"))
    .sort()
    .at(-1);
  if (!tarball) {
    throw new Error(`Unable to find generated ${packageName} tarball.`);
  }

  await fs.mkdir(installDir, { recursive: true });
  await run("npm", ["init", "-y"], installDir);
  await run("npm", ["install", path.join(rootDir, tarball)], installDir);
  await run(path.join(installDir, "node_modules", ".bin", "receipt"), ["help"], installDir);
  console.log("pack smoke passed");
} finally {
  // Keep cleanup best-effort so failures still expose primary issue.
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}
