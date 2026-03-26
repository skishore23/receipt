#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-common.sh"
receipt_docker_prepare prod
export RECEIPT_SERVER_WATCH="${RECEIPT_SERVER_WATCH:-0}"
export RECEIPT_CSS_WATCH="${RECEIPT_CSS_WATCH:-0}"

if [ "$#" -eq 0 ]; then
  receipt_docker_stop_conflicting_projects receipt-prod || true
  if [ "${RECEIPT_IMAGE_EXPLICIT:-0}" = "1" ]; then
    exec docker compose -p receipt-prod -f compose.yaml -f compose.prod.yaml up -d --pull always --remove-orphans
  fi
  exec docker compose -p receipt-prod -f compose.yaml -f compose.prod.yaml up -d --build --remove-orphans
fi

if [ "$1" = "pull" ] && [ "${RECEIPT_IMAGE_EXPLICIT:-0}" != "1" ]; then
  echo "receipt-docker: set RECEIPT_IMAGE to a distributable image reference before pulling." >&2
  exit 1
fi

exec docker compose -p receipt-prod -f compose.yaml -f compose.prod.yaml "$@"
