#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

export HOST_HOME="${HOST_HOME:-${HOME}}"
export LOCAL_UID="${LOCAL_UID:-$(id -u)}"
export LOCAL_GID="${LOCAL_GID:-$(id -g)}"
export PORT="${PORT:-8787}"
export CHAT_WORKER_PROCESSES="${CHAT_WORKER_PROCESSES:-10}"
export CONTROL_WORKER_PROCESSES="${CONTROL_WORKER_PROCESSES:-4}"
export CODEX_WORKER_PROCESSES="${CODEX_WORKER_PROCESSES:-6}"
export CHAT_JOB_CONCURRENCY="${CHAT_JOB_CONCURRENCY:-50}"
export ORCHESTRATION_JOB_CONCURRENCY="${ORCHESTRATION_JOB_CONCURRENCY:-20}"
export CODEX_JOB_CONCURRENCY="${CODEX_JOB_CONCURRENCY:-30}"
export JOB_CONCURRENCY="${JOB_CONCURRENCY:-12}"
export RESONATE_QUEUE_REFRESH_MS="${RESONATE_QUEUE_REFRESH_MS:-1000}"
export RESONATE_STARTUP_SETTLE_MS="${RESONATE_STARTUP_SETTLE_MS:-1000}"

mkdir -p \
  "${ROOT}/.receipt/resonate" \
  "${ROOT}/.receipt/data" \
  "${HOST_HOME}/.codex"

if [ ! -f "${HOST_HOME}/.codex/version.json" ] && [ ! -f "${HOST_HOME}/.codex/config.toml" ]; then
  echo "[receipt-docker] warning: ${HOST_HOME}/.codex does not look initialized; Codex auth may fail until the host CLI is signed in." >&2
fi

if [ "$#" -eq 0 ]; then
  exec docker compose up --build --remove-orphans
fi

exec docker compose "$@"
