# Configuration Reference

## Runtime and Server

| Variable | Default | Impact |
|---|---|---|
| `PORT` | `8787` | HTTP server listen port. |
| `DATA_DIR` | `<cwd>/.receipt/data` | Root directory for JSONL streams, queue, and memory storage. |
| `JOB_WORKER_ID` | `worker_<pid>` | Worker identity for leasing and heartbeats. |
| `JOB_POLL_MS` | `100` | Queue polling interval in milliseconds. |
| `JOB_LEASE_MS` | `30000` | Lease duration for worker-owned jobs. |
| `JOB_CONCURRENCY` | `2` | Max concurrent job executions per worker. |
| `SUBJOB_WAIT_MS` | `1500` | Delegate wait timeout when summarizing a sub-job inline. |
| `SUBJOB_WAIT_POLL_MS` | `250` | Poll interval while waiting on sub-jobs. |
| `SUBJOB_JOIN_WAIT_MS` | `180000` | Async join timeout when merging sub-agent results. |
| `HEARTBEAT_<AGENT>_INTERVAL_MS` | unset | Enables periodic collect-lane enqueue heartbeat for `<AGENT>` (minimum 1000ms). |

## OpenAI and Model Calls

| Variable | Default | Impact |
|---|---|---|
| `OPENAI_API_KEY` | unset | Required for live LLM/embedding calls; without it, factory agent runs fail gracefully with status notes. |
| `OPENAI_MODEL` | `gpt-5.2` | Default model for factory agent text calls. |
| `OPENAI_MAX_RETRIES` | `3` | Retry attempts on rate limits. |
| `OPENAI_RETRY_BASE_MS` | `500` | Base backoff for rate-limit retry. |

## Planner Tuning

| Variable | Default | Impact |
|---|---|---|
| `PLANNER_STEP_TIMEOUT_MS` | `90000` | Timeout budget used by factory planning step execution. |

Prompt templates are loaded from checked-in files:
- `prompts/agent.prompts.json`

## Improvement Harness

| Variable | Required? | Impact |
|---|---|---|
| `IMPROVEMENT_VALIDATE_CMD` | Required for `prompt_patch`/`policy_patch` validation | Command executed by `/improvement/:id/validate`. |
| `IMPROVEMENT_HARNESS_CMD` | Required for `harness_patch` validation | Command executed by `/improvement/:id/validate` for harness artifacts. |
