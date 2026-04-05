import { expect, test } from "bun:test";

import { parseComposerDraft, resolveComposerCommand } from "../../../factory-cli/composer";

test("help command resolves to a deterministic parsed command", () => {
  expect(resolveComposerCommand("help")).toEqual({
    name: "help",
    label: "/help",
    usage: "/help or /?",
    description: "Show slash command help.",
    aliases: ["?", "help"],
  });

  expect(parseComposerDraft("/help")).toEqual({
    ok: true,
    command: { type: "help" },
  });

  expect(parseComposerDraft("/?")).toEqual({
    ok: true,
    command: { type: "help" },
  });
});
