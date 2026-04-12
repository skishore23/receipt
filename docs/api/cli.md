# CLI API (`receipt`)

Binary entrypoint: `receipt` (runs `src/cli.ts` through Bun).
Repo-local wrapper: `.receipt/bin/receipt` (resolves the repo root correctly when symlinked onto `PATH`).

If not installed globally, run through Bun:
```bash
bun src/cli.ts <command> [args]
```

## Agent-friendly usage

- Prefer the stable `receipt` command surface over one-off shell pipelines when the repo CLI already exposes the data.
- If setup, auth, or repo wiring is unclear, start with `doctor --json`.
- Inside a Factory task worktree, start from the packet, task context summary, and generated receipt-cli surface first; do not default to `factory inspect` there.
- Start with discovery and read commands before control commands: `doctor`, `trace`, `inspect`, `replay`, `dst`, `factory inspect`, `factory replay`, `factory replay-chat`, `factory analyze`, `factory investigate`, `factory audit`.
- Add `--json` when another tool or agent will consume the output.
- For large read payloads, use `--output-file <path>` on `receipt trace|replay|inspect|dst|jobs|memory read|memory search|memory summarize|memory diff|sessions search|sessions read|doctor` and on `receipt factory replay|replay-chat|analyze|parse|investigate|audit`. The command writes the full payload to disk and returns the path instead of printing the whole blob.
- Treat `receipt abort` and `receipt factory react|promote|cancel|cleanup|archive|steer|follow-up|abort-job` as explicit write or control commands.
- Companion skill: `skills/receipt-cli-operator/SKILL.md`.

## Commands

### receipt doctor
- Purpose: report repo wiring, data dir resolution, required binaries, and auth status for the local Receipt runtime.
- Flags:
  - `--json` (recommended for automation).
  - `--output-file <path>` (optional; writes the full report to disk and returns the path).
  - `--repo-root <path>` (optional repo root override for the probe).
- Output:
  - text mode: compact status lines plus blocking issues and warnings.
  - json mode: `{ ok, cwd, requestedRepoRoot, dataDir, configPath, configPresent, openAiApiKey, binaries, repo, auth, blockingIssues, warnings }`.
- Example:
```bash
receipt doctor --json
```

### receipt new <agent-id>
- Purpose: scaffold `src/agents/<agent-id>.agent.ts`.
- Flags:
  - `--template basic|assistant-tool|human-loop|merge` (default `basic`).
- Validation:
  - `agent-id` must match kebab-case: `^[a-z][a-z0-9-]*$`.
  - fails if target file already exists.
- Output: `created src/agents/<agent-id>.agent.ts`.
- Example:
```bash
receipt new release-notes --template assistant-tool
```

### receipt dev
- Purpose: start the local runtime in watch/dev mode.
- Notes:
  - defaults to the local SQLite runtime.
  - use `JOB_BACKEND=resonate receipt dev` or `bun run dev:resonate` for multi-process dispatch.
- Flags: none.
- Output: streams server logs to stdout/stderr.
- Example:
```bash
receipt dev
```

### receipt run <agent-id> --problem <text>
- Purpose: run agent inline (for `defineAgent` specs) or enqueue background job.
- Flags:
  - `--problem <text>` (required; alias: `--prompt`).
  - `--stream <stream>` (default `agents/<agent-id>`).
  - `--run-id <runId>` (default generated).
  - `--run-stream <stream>` (optional override).
- Output (JSON):
  - inline mode: `{ ok, mode: "inline", runId, stream, runStream }`
  - queued mode: `{ ok, mode: "queued", jobId, runId, stream, runStream }`
- Example:
```bash
receipt run factory --problem "Plan a CLI-first migration" --stream agents/factory
```

### receipt trace <run-id|stream>
- Purpose: print a compact line-per-receipt timeline.
- Flags:
  - `--json` (optional; returns `{ stream, receipts: [...] }`).
  - `--output-file <path>` (optional).
- Output:
  - text mode: `<idx> <ISO timestamp> <event-type>` lines.
  - json mode: `{ stream, receipts: [{ index, ts, isoTs, type }] }`.
- Example:
```bash
receipt trace run_abcd1234
```

### receipt replay <run-id|stream>
- Purpose: dump all receipt bodies for the resolved stream.
- Flags:
  - `--output-file <path>` (optional).
- Output (JSON): `{ stream, receipts: [...] }`.
- Example:
```bash
receipt replay agents/factory/runs/run_abcd1234
```

### receipt dst [<prefix>]
- Purpose: audit receipt streams for integrity, replayability, and deterministic replay stability; with `--context`, also audit historical Factory task packets.
- Flags:
  - `<prefix>` optional stream-prefix filter such as `factory/objectives/` or `memory/`.
  - `--context` (optional; includes Factory task packet checks for historical `factory.task.run` jobs).
  - `--json` (optional; returns the full audit report).
  - `--limit <n>` (optional; text mode only, limits listed streams/runs).
  - `--strict` (optional; exits non-zero when receipt or context failures are present).
  - `--output-file <path>` (optional).
- Output:
  - text mode: summary counts, failing streams first, plus the optional Factory context section.
  - json mode: `{ scannedAt, dataDir, streamCount, kinds, statusCounts, integrityFailures, replayFailures, deterministicFailures, streams, context? }`.
- Notes:
  - context JSON includes per-run `warnings` and `issues`; compatibility drift such as older prompt wording can surface as warnings without failing integrity.
  - empty historical Factory objective streams and legacy events unknown to the current reducer are tolerated during the replay summary pass.
- Example:
```bash
receipt dst factory/objectives/ --json --strict
receipt dst --context --json
```

### receipt inspect <run-id|stream>
- Purpose: show stream head summary.
- Flags:
  - `--output-file <path>` (optional).
- Output (JSON): `{ stream, count, head }`.
- Example:
```bash
receipt inspect run_abcd1234
```

### receipt fork <run-id|stream> --at <index>
- Purpose: fork a stream at receipt index into a branch stream.
- Flags:
  - `--at <non-negative integer>` (required).
  - `--name <branch-name>` (optional; default generated).
- Output (JSON): `{ ok, stream, at, branch }`.
- Example:
```bash
receipt fork run_abcd1234 --at 12 --name agents/factory/runs/run_abcd1234/branches/hotfix
```

### receipt jobs
- Purpose: list jobs from queue index.
- Flags:
  - `--status queued|leased|running|completed|failed|canceled`.
  - `--limit <n>` (default 50, clamped to `1..500`).
  - `--output-file <path>` (optional).
- Output (JSON): `{ jobs: [...] }`.
- Example:
```bash
receipt jobs --status running --limit 20
```

### receipt abort <job-id>
- Purpose: enqueue abort command for a job.
- Flags:
  - `--reason <text>` (default `abort requested`).
- Output (JSON): `{ ok: true, jobId, commandId }`.
- Example:
```bash
receipt abort job_abcd1234 --reason "cancel stale run"
```

### receipt memory read <scope>
- Purpose: read the latest memory entries for a scope from the receipt-backed memory runtime.
- Flags:
  - `--limit <n>` (optional; clamped by the memory adapter).
  - `--output-file <path>` (optional).
- Output (JSON): `{ entries: [...] }`.
- Side effects: appends an audited `memory.accessed` receipt for the scope.
- Example:
```bash
receipt memory read factory/objectives/demo --limit 5
```

### receipt memory search <scope>
- Purpose: keyword or embedding search over a memory scope.
- Flags:
  - `--query <text>` or trailing query text (required).
  - `--limit <n>` (optional).
  - `--output-file <path>` (optional).
- Output (JSON): `{ entries: [...] }`.
- Side effects: appends an audited `memory.accessed` receipt for the scope.
- Example:
```bash
receipt memory search factory/repo/shared --query "integration conflict" --limit 6
```

### receipt memory summarize <scope>
- Purpose: build a bounded summary for a memory scope.
- Flags:
  - `--query <text>` (optional).
  - `--limit <n>` (optional).
  - `--max-chars <n>` (optional).
  - `--output-file <path>` (optional).
- Output (JSON): `{ summary, entries }`.
- Side effects: appends an audited `memory.accessed` receipt for the scope.
- Example:
```bash
receipt memory summarize factory/objectives/demo --query "promotion" --max-chars 1200
```

### receipt memory commit <scope>
- Purpose: append a durable memory entry to a scope.
- Flags:
  - `--text <text>` or trailing text (required).
  - `--tags a,b,c` (optional).
- Output (JSON): `{ entry }`.
- Example:
```bash
receipt memory commit factory/objectives/demo/tasks/task_01 --text "Need reconciliation against new source head" --tags factory,task
```

### receipt memory diff <scope>
- Purpose: list entries between timestamps for a memory scope.
- Flags:
  - `--from-ts <epoch-ms>` (required).
  - `--to-ts <epoch-ms>` (optional; defaults to now).
  - `--output-file <path>` (optional).
- Output (JSON): `{ entries: [...] }`.
- Side effects: appends an audited `memory.accessed` receipt for the scope.
- Example:
```bash
receipt memory diff factory/objectives/demo --from-ts 1710000000000
```

### receipt factory
- Purpose: primary CLI-first operator surface for Factory workflows.
- Notes:
  - `receipt factory` with no subcommand opens the board/TUI when interactive, or prints the board snapshot with `--json`.
  - `/factory` web pages are inspect-only; create/react/job-control flows should use these CLI commands instead.
  - large read payloads can be written with `--output-file <path>` on `replay`, `replay-chat`, `analyze`, `parse`, `investigate`, and `audit`.
- Subcommands:
  - `init` prepares `.receipt/config.json`.
  - `run` creates a new objective and stays attached until terminal/manual-promotion state.
  - `create` creates a tracked objective and returns immediately.
  - `compose` creates a new objective, or with `--objective <id>` adds a note and reacts the existing objective.
  - `watch` opens or prints a selected objective.
  - `inspect` prints a selected objective panel.
  - `resume` reacts an objective and stays attached until terminal/manual-promotion state.
  - `react`, `promote`, `cancel`, `cleanup`, `archive` mutate an objective once and return structured output.
  - `steer`, `follow-up`, `abort-job` queue commands for a Factory-visible job.
- Common flags:
  - `run`, `create`, and `compose` accept `--objective-mode delivery|investigation`.
  - `run`, `create`, and `compose` accept `--severity 1|2|3|4|5`.
  - `watch`, `inspect`, `run`, and `resume` accept `--panel overview|report|tasks|candidates|evidence|activity|live|debug|receipts`.
  - completed investigation objectives prefer the `report` panel by default when a synthesized report is available.
- JSON output:
  - objective mutations return `{ ok, kind: "objective", action, objectiveId, objective, note? }`
  - job mutations return `{ ok, kind: "job", action, jobId, job, commandId }`
- Examples:
```bash
receipt factory create --prompt "Plan a CLI-first Factory migration"
receipt factory run --profile infrastructure --objective-mode investigation --severity 2 --prompt "Investigate current AWS access posture"
receipt factory compose --objective objective_demo --prompt "Tighten the next pass and keep receipts concise."
receipt factory inspect objective_demo --panel report
receipt factory react objective_demo --message "Advance using the latest operator note."
receipt factory steer job_demo --message "Retarget this run to the live-output bug."
receipt factory follow-up job_demo --message "Keep the receipt links stable."
receipt factory abort-job job_demo --reason "cancel stale run"
```

### receipt factory codex-probe
- Purpose: run an isolated Codex status probe through the real Factory Codex runtime, so you can inspect direct progress capture and queue-integrated status transitions without touching existing Factory jobs.
- Notes:
  - does not require `receipt factory init`.
  - uses an isolated probe data dir under `.receipt/data/probes/<probe-id>` by default.
- Flags:
  - `--mode direct|queue|both` (default `both`).
  - `--reply <text>` (used to build the default safe prompt).
  - `--prompt <text>` (overrides the default prompt).
  - `--timeout-ms <n>` (default `120000`, clamped to `30000..900000`).
  - `--poll-ms <n>` (default `250`, clamped to `50..10000`).
  - `--probe-dir <path>` (optional custom isolated data dir).
  - `--repo-root <path>` (optional repo root override).
  - `--json` (optional structured output).
- Output:
  - text mode: direct and/or queue snapshot timeline plus artifact file paths.
  - json mode: `{ ok, mode, prompt, repoRoot, dataDir, codexBin, timeoutMs, pollMs, direct?, queue? }`.
- Example:
```bash
receipt factory codex-probe --mode both --reply status-ok
```

## Resolution Rules
- `run-id|stream` arguments:
  - if value contains `/`, treated as stream directly.
  - otherwise resolved by stream names stored in SQLite and `/runs/<runId>` suffix lookup.
- Data directory:
  - uses `DATA_DIR` env var or defaults to `<cwd>/.receipt/data`.

## Exit Behavior
- Success: exit code `0`.
- Errors: prints `error: <message>` and exits non-zero.
