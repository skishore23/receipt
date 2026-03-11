import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const ROUTE_FILES = [
  "src/server.ts",
  "src/agents/todo.agent.ts",
  "src/agents/writer.agent.ts",
  "src/agents/theorem.agent.ts",
  "src/agents/axiom-simple.agent.ts",
  "src/agents/monitor.agent.ts",
  "src/agents/inspector.agent.ts",
] as const;

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");

test("docs: HTTP API reference covers all public route handlers", async () => {
  const endpointPattern = /app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;
  const endpointSet = new Set<string>();

  for (const file of ROUTE_FILES) {
    const source = await fs.readFile(path.join(ROOT, file), "utf-8");
    for (const match of source.matchAll(endpointPattern)) {
      const method = match[1]?.toUpperCase();
      const route = match[2];
      if (!method || !route) continue;
      endpointSet.add(`${method} ${route}`);
    }
  }

  const documented = await fs.readFile(path.join(ROOT, "docs/api/http.md"), "utf-8");
  const endpoints = [...endpointSet].sort((a, b) => a.localeCompare(b));

  for (const endpoint of endpoints) {
    const [method, ...parts] = endpoint.split(" ");
    const route = parts.join(" ");
    const headingPattern = new RegExp(`^###\\s+${escapeRegex(method)}\\s+${escapeRegex(route)}\\s*$`, "m");
    assert.match(documented, headingPattern, `missing endpoint documentation for ${endpoint}`);
  }
});
