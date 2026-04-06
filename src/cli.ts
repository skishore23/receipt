#!/usr/bin/env bun

import { runCliCommand } from "./cli/commands";
import { ROOT } from "./cli/runtime";
import { isInteractiveTerminal, parseArgs, printUsage } from "./cli/shared";
import { handleFactoryCommand } from "./factory-cli/commands";

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.command) {
    if (isInteractiveTerminal()) {
      await handleFactoryCommand(ROOT, [], {});
      return;
    }
    printUsage();
    return;
  }

  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    printUsage();
    return;
  }

  await runCliCommand(parsed);
};

const exitCli = (): void => {
  if (process.env.RECEIPT_CLI_NO_FORCE_EXIT === "1") return;
  const code = process.exitCode ?? 0;
  process.stdout.write("", () => {
    process.stderr.write("", () => {
      process.exit(code);
    });
  });
};

main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    exitCli();
  });
