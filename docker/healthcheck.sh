#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8787}"
RESONATE_HTTP_URL="${RESONATE_URL:-http://127.0.0.1:8001}"

resonate_ready() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "${RESONATE_HTTP_URL}/" || true)"
  [ -n "${code}" ] && [ "${code}" != "000" ]
}

command -v resonate >/dev/null
curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null
resonate_ready
