import { parseComposerDraft } from "../src/factory-cli/composer";

const draft = "/help";
const parsed = parseComposerDraft(draft);

const output = {
  input: draft,
  responseShape: parsed.ok
    ? {
        type: parsed.command.type,
      }
    : {
        error: parsed.error,
      },
};

console.log(JSON.stringify(output));
