#!/usr/bin/env bun

import fs from "node:fs/promises";

const [templatePath, outputPath, ...pairs] = process.argv.slice(2);

if (!templatePath || !outputPath) {
  console.error("usage: render-template.mjs <template> <output> [KEY=VALUE ...]");
  process.exit(1);
}

const values = Object.fromEntries(
  pairs.map((pair) => {
    const index = pair.indexOf("=");
    if (index === -1) {
      throw new Error(`invalid placeholder assignment: ${pair}`);
    }
    return [pair.slice(0, index), pair.slice(index + 1)];
  }),
);

const template = await fs.readFile(templatePath, "utf8");
const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
  if (!(key in values)) {
    throw new Error(`missing placeholder value for ${key}`);
  }
  return values[key];
});

await fs.writeFile(outputPath, rendered);
