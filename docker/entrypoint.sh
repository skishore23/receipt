#!/usr/bin/env bash
set -euo pipefail

RECEIPT_WORKDIR="${RECEIPT_WORKDIR:-/workspace/receipt}"
PORT="${PORT:-8787}"
RESONATE_HTTP_URL="${RESONATE_URL:-http://127.0.0.1:8001}"
RESONATE_SQLITE_PATH="${RESONATE_SQLITE_PATH:-${RECEIPT_WORKDIR}/.receipt/resonate/resonate.db}"
HOME="${HOME:-/tmp/receipt-home}"
CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"

cd "${RECEIPT_WORKDIR}"

mkdir -p \
  "$(dirname "${RESONATE_SQLITE_PATH}")" \
  "${HOME}" \
  "${CODEX_HOME}" \
  "${RECEIPT_WORKDIR}/.receipt"

if [ ! -d node_modules ] || [ ! -e node_modules/.bin/tailwindcss ]; then
  echo "[entrypoint] installing Bun dependencies"
  bun install --frozen-lockfile
fi

echo "[entrypoint] preparing runtime assets"
bun run assets:prepare
bun run css:build

shutdown() {
  local exit_code="${1:-0}"
  trap - INT TERM
  if [ -n "${app_pid:-}" ] && kill -0 "${app_pid}" 2>/dev/null; then
    kill "${app_pid}" 2>/dev/null || true
  fi
  if [ -n "${resonate_pid:-}" ] && kill -0 "${resonate_pid}" 2>/dev/null; then
    kill "${resonate_pid}" 2>/dev/null || true
  fi
  wait "${app_pid:-}" 2>/dev/null || true
  wait "${resonate_pid:-}" 2>/dev/null || true
  exit "${exit_code}"
}

trap 'shutdown 143' INT TERM

echo "[entrypoint] starting Resonate with SQLite at ${RESONATE_SQLITE_PATH}"
resonate serve --aio-store-sqlite-path "${RESONATE_SQLITE_PATH}" &
resonate_pid=$!

resonate_ready() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "${RESONATE_HTTP_URL}/" || true)"
  [ -n "${code}" ] && [ "${code}" != "000" ]
}

for _ in $(seq 1 60); do
  if resonate_ready; then
    break
  fi
  sleep 1
done

if ! resonate_ready; then
  echo "[entrypoint] Resonate failed to become healthy" >&2
  exit 1
fi

if [ "${JOB_BACKEND:-resonate}" = "resonate" ]; then
  echo "[entrypoint] starting Receipt Resonate runtime"
  bun scripts/start-resonate-runtime.mjs &
else
  echo "[entrypoint] starting Receipt on port ${PORT}"
  bun src/server.ts &
fi
app_pid=$!

wait -n "${resonate_pid}" "${app_pid}"
shutdown "$?"
