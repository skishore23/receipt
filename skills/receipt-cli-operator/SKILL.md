---
name: receipt-cli-operator
description: Use when Codex should inspect or control this repo through the checked-in `receipt` CLI instead of inventing ad hoc shell pipelines or direct database queries.
---

# Receipt CLI Operator

Use this skill when the task needs repo-native inspection, replay, audit, or explicit Factory control through the `receipt` CLI.

## First Pass

1. Prefer the stable `receipt` command when it is installed or exposed on `PATH`.
2. Inside this repo, `.receipt/bin/receipt` and `bun src/cli.ts` are the fallback entrypoints.
3. If setup, auth, or repo wiring is unclear, run `receipt doctor --json` first.
4. Start with read commands before mutations:
   - `receipt trace`
   - `receipt inspect`
   - `receipt replay`
   - `receipt doctor --json`
   - `receipt factory inspect`
   - `receipt factory replay`
   - `receipt factory replay-chat`
   - `receipt factory analyze`
   - `receipt factory investigate`
   - `receipt factory audit`
5. Add `--json` when another tool, script, or agent will consume the output.
6. If the payload may be large, add `--output-file <path>` and return the path instead of dumping the full blob into the thread.
7. Use stable ids from discovery output before deeper reads or mutations.

## Working Rules

- Prefer the repo CLI over ad hoc SQLite queries or custom log scraping when the CLI already exposes the data you need.
- Keep stdout small and composable. Use file output for large replays, audits, parsed runs, investigations, session reads, job lists, and memory reads.
- Treat `receipt abort` and `receipt factory react|promote|cancel|cleanup|archive|steer|follow-up|abort-job` as explicit write or control commands.
- Do not hide a mutation behind a read command. If the task needs a mutation, say so and run the write command directly.
- When setup is missing, fail clearly with the repo CLI's own error instead of inventing alternate state.

## Validation

- Prefer `--help` first when the exact subcommand or flag surface is unclear.
- When a read command writes to `--output-file`, confirm the command returned the path and that the file exists before depending on it.
