import type { Flags } from "../cli.types";

export type ParsedArgs = {
  readonly command?: string;
  readonly args: ReadonlyArray<string>;
  readonly flags: Flags;
};

export const isInteractiveTerminal = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY);

export const printUsage = (): void => {
  console.log(`receipt <command> [args]

In this repo, prefer:
  bun run factory
  bun src/cli.ts factory

Commands:
  receipt new <agent-id> [--template basic|assistant-tool|human-loop|merge]
  receipt dev
  receipt run <agent-id> --problem <text> [--stream agents/<agentId>] [--run-id <runId>] [--max-iterations <n>] [--workspace <path>]
  receipt trace <run-id|stream>
  receipt replay <run-id|stream>
  receipt dst [<prefix>] [--json] [--limit <n>] [--strict]
  receipt fork <run-id|stream> --at <index> [--name <branch-name>]
  receipt inspect <run-id|stream>
  receipt migrate sqlite [--data-dir <path>] [--db-path <path>] [--force-rebuild]
  receipt jobs [list] [--status queued|leased|running|completed|failed|canceled] [--limit <n>]
  receipt jobs enqueue <agent-id> [--lane chat|collect|steer|follow_up] [--payload-json <json>] [--job-id <id>] [--max-attempts <n>] [--session-key <key>] [--singleton-mode allow|cancel|steer]
  receipt jobs wait <job-id> [--timeout-ms <n>]
  receipt jobs steer <job-id> [--payload-json <json>]
  receipt jobs follow-up <job-id> [--payload-json <json>]
  receipt jobs abort <job-id> [--reason <text>]
  receipt abort <job-id> [--reason <text>]
  receipt memory <read|search|summarize|commit|diff> <scope> [options]
  receipt factory [init|run|create|compose|watch|inspect|replay|replay-chat|analyze|parse|resume|react|promote|cancel|cleanup|archive|abort-job|codex-probe]`);
};

export const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  const normalized = [...argv];
  while (normalized[0] === "--") normalized.shift();
  const [command, ...rest] = normalized;
  const args: string[] = [];
  const flags: Record<string, string | boolean | ReadonlyArray<string>> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--") {
      args.push(...rest.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    const eq = trimmed.indexOf("=");
    if (eq >= 0) {
      const key = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      const prior = flags[key];
      flags[key] = Array.isArray(prior)
        ? [...prior, value]
        : typeof prior === "string"
          ? [prior, value]
          : value;
      continue;
    }

    const key = trimmed;
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    const prior = flags[key];
    flags[key] = Array.isArray(prior)
      ? [...prior, next]
      : typeof prior === "string"
        ? [prior, next]
        : next;
    i += 1;
  }

  return { command, args, flags };
};

export const asString = (flags: Flags, key: string): string | undefined => {
  const value = flags[key];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === "string" ? value : undefined;
};

export const asIntegerFlag = (flags: Flags, ...keys: ReadonlyArray<string>): number | undefined => {
  for (const key of keys) {
    const raw = asString(flags, key);
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) continue;
    return Math.floor(parsed);
  }
  return undefined;
};

export const parseNumberFlag = (flags: Flags, key: string): number | undefined => {
  const raw = asString(flags, key);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return parsed;
};

export const parseJsonFlag = (flags: Flags, key: string): Record<string, unknown> | undefined => {
  const raw = asString(flags, key);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${key} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
};
