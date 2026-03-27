#!/usr/bin/env bash
set -euo pipefail

RECEIPT_WORKDIR="${RECEIPT_WORKDIR:-/workspace/receipt}"
PORT="${PORT:-8787}"
RESONATE_HTTP_URL="${RESONATE_URL:-http://127.0.0.1:8001}"
RESONATE_SQLITE_PATH="${RESONATE_SQLITE_PATH:-${RECEIPT_WORKDIR}/.receipt/resonate/resonate.db}"

print_version() {
  local tool="${1}"
  case "${tool}" in
    resonate) resonate --help 2>/dev/null | sed -n '1p' || true ;;
    bun) bun --version 2>/dev/null || true ;;
    node) node --version 2>/dev/null || true ;;
    git) git --version 2>/dev/null || true ;;
    gh) gh --version 2>/dev/null | sed -n '1p' || true ;;
    aws) aws --version 2>&1 | sed -n '1p' || true ;;
    python3) python3 --version 2>/dev/null || true ;;
    jq) jq --version 2>/dev/null || true ;;
    rg) rg --version 2>/dev/null | sed -n '1p' || true ;;
    curl) curl --version 2>/dev/null | sed -n '1p' || true ;;
    sqlite3) sqlite3 --version 2>/dev/null || true ;;
    ss|ps|lsof) command -v "${tool}" 2>/dev/null || true ;;
    *) command -v "${tool}" 2>/dev/null || true ;;
  esac
}

echo "== receipt debug env =="
echo "workdir: ${RECEIPT_WORKDIR}"
echo "job_backend: ${JOB_BACKEND:-resonate}"
echo "data_dir: ${DATA_DIR:-${RECEIPT_WORKDIR}/.receipt/data}"
echo "resonate_url: ${RESONATE_HTTP_URL}"
echo "resonate_sqlite_path: ${RESONATE_SQLITE_PATH}"
echo "codex_home: ${CODEX_HOME:-${HOME:-${RECEIPT_WORKDIR}/.receipt/home}/.codex}"

echo
echo "== tools =="
for tool in resonate bun node git gh aws python3 jq rg curl ps ss lsof sqlite3; do
  if command -v "${tool}" >/dev/null 2>&1; then
    printf "%-8s %s\n" "${tool}" "$(command -v "${tool}")"
    print_version "${tool}" | sed 's/^/  /'
  else
    printf "%-8s missing\n" "${tool}"
  fi
done

echo
echo "== health =="
printf "receipt_http "
curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null && echo "ok" || echo "unreachable"
printf "resonate_http "
curl -fsS "${RESONATE_HTTP_URL}/" >/dev/null && echo "ok" || echo "unreachable"

echo
echo "== key ports =="
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | rg ':(8787|8001|8002|9090|50051)\b' || true
fi

echo
echo "== processes =="
if command -v ps >/dev/null 2>&1; then
  ps -eo pid,ppid,cmd --sort=pid | rg 'resonate|bun|receipt|tailwind' || true
fi

echo
echo "== resonate sqlite =="
if [ -f "${RESONATE_SQLITE_PATH}" ]; then
  ls -lh "${RESONATE_SQLITE_PATH}"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${RESONATE_SQLITE_PATH}" ".tables" || true
  fi
else
  echo "missing: ${RESONATE_SQLITE_PATH}"
fi
