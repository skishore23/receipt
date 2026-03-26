#!/usr/bin/env bash
set -euo pipefail

RECEIPT_WORKDIR="${RECEIPT_WORKDIR:-/workspace/receipt}"
PORT="${PORT:-8787}"
RESONATE_HTTP_URL="${RESONATE_URL:-http://127.0.0.1:8001}"
RESONATE_SQLITE_PATH="${RESONATE_SQLITE_PATH:-${RECEIPT_WORKDIR}/.receipt/resonate/resonate.db}"
DATA_DIR="${DATA_DIR:-${RECEIPT_WORKDIR}/.receipt/data}"
RECEIPT_DOCKER_MODE="${RECEIPT_DOCKER_MODE:-dev}"
HOST_AUTH_ROOT="${RECEIPT_HOST_AUTH_ROOT:-/mnt/host-auth}"
HOME="${HOME:-${RECEIPT_WORKDIR}/.receipt/home}"
CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
RECEIPT_CSS_WATCH="${RECEIPT_CSS_WATCH:-0}"

copy_optional_file() {
  local source_path="${1}"
  local target_path="${2}"
  if [ ! -f "${source_path}" ]; then
    return 0
  fi
  mkdir -p "$(dirname "${target_path}")"
  cp "${source_path}" "${target_path}"
}

copy_optional_dir() {
  local source_path="${1}"
  local target_path="${2}"
  local rel_path
  local source_entry
  local target_entry
  if [ ! -d "${source_path}" ]; then
    return 0
  fi
  if [ -z "$(find "${source_path}" -mindepth 1 -print -quit 2>/dev/null)" ]; then
    return 0
  fi
  mkdir -p "${target_path}"
  find "${target_path}" \( -type s -o -type p -o -type b -o -type c \) -delete 2>/dev/null || true
  while IFS= read -r -d '' rel_path; do
    source_entry="${source_path}/${rel_path#./}"
    target_entry="${target_path}/${rel_path#./}"
    if [ -d "${source_entry}" ] && [ ! -L "${source_entry}" ]; then
      if [ -e "${target_entry}" ] && [ ! -d "${target_entry}" ]; then
        rm -rf "${target_entry}"
      fi
      mkdir -p "${target_entry}"
      continue
    fi
    mkdir -p "$(dirname "${target_entry}")"
    if [ -d "${target_entry}" ] && [ ! -L "${target_entry}" ]; then
      rm -rf "${target_entry}"
    fi
    cp -P "${source_entry}" "${target_entry}"
  done < <(cd "${source_path}" && find . -mindepth 1 \( -type d -o -type f -o -type l \) -print0)
}

sync_host_auth() {
  copy_optional_file "${HOST_AUTH_ROOT}/codex/auth.json" "${CODEX_HOME}/auth.json"
  copy_optional_file "${HOST_AUTH_ROOT}/codex/config.toml" "${CODEX_HOME}/config.toml"
  copy_optional_file "${HOST_AUTH_ROOT}/codex/version.json" "${CODEX_HOME}/version.json"
  copy_optional_file "${HOST_AUTH_ROOT}/codex/.codex-global-state.json" "${CODEX_HOME}/.codex-global-state.json"
  copy_optional_dir "${HOST_AUTH_ROOT}/aws" "${HOME}/.aws"
  copy_optional_dir "${HOST_AUTH_ROOT}/gh" "${HOME}/.config/gh"
  copy_optional_dir "${HOST_AUTH_ROOT}/ssh" "${HOME}/.ssh"
  copy_optional_file "${HOST_AUTH_ROOT}/gitconfig" "${HOME}/.gitconfig"
  copy_optional_file "${HOST_AUTH_ROOT}/git-credentials" "${HOME}/.git-credentials"
}

cd "${RECEIPT_WORKDIR}"
export HOME CODEX_HOME DATA_DIR RECEIPT_DATA_DIR="${RECEIPT_DATA_DIR:-${DATA_DIR}}"
export PATH="${RECEIPT_WORKDIR}/.receipt/bin:${RECEIPT_WORKDIR}/node_modules/.bin:${PATH}"

mkdir -p \
  "$(dirname "${RESONATE_SQLITE_PATH}")" \
  "${DATA_DIR}" \
  "${HOME}" \
  "${CODEX_HOME}" \
  "${CODEX_HOME}/runtime" \
  "${RECEIPT_WORKDIR}/.receipt"

sync_host_auth

if [ "${RECEIPT_DOCKER_MODE}" = "dev" ]; then
  if [ ! -d node_modules ] || [ ! -e node_modules/.bin/tailwindcss ]; then
    echo "[entrypoint] installing Bun dependencies"
    bun install --frozen-lockfile
  fi

  echo "[entrypoint] preparing runtime assets"
  bun run assets:prepare
  bun run css:build

  if [ "${RECEIPT_CSS_WATCH}" = "1" ]; then
    echo "[entrypoint] starting CSS watcher"
    bun run css:watch &
    asset_pid=$!
  fi
else
  if [ ! -e node_modules/.bin/tailwindcss ]; then
    echo "[entrypoint] production image is missing dependencies" >&2
    exit 1
  fi
  if [ ! -f dist/assets/factory.css ]; then
    echo "[entrypoint] production image is missing built assets" >&2
    exit 1
  fi
fi

shutdown() {
  local exit_code="${1:-0}"
  trap - INT TERM
  if [ -n "${asset_pid:-}" ] && kill -0 "${asset_pid}" 2>/dev/null; then
    kill "${asset_pid}" 2>/dev/null || true
  fi
  if [ -n "${app_pid:-}" ] && kill -0 "${app_pid}" 2>/dev/null; then
    kill "${app_pid}" 2>/dev/null || true
  fi
  if [ -n "${resonate_pid:-}" ] && kill -0 "${resonate_pid}" 2>/dev/null; then
    kill "${resonate_pid}" 2>/dev/null || true
  fi
  wait "${asset_pid:-}" 2>/dev/null || true
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
