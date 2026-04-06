#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-common.sh"
receipt_docker_prepare dev

if [ "$#" -eq 0 ]; then
  receipt_docker_stop_conflicting_projects receipt-dev || true
  exec docker compose -p receipt-dev -f compose.yaml -f compose.dev.yaml up --build --remove-orphans
fi

exec docker compose -p receipt-dev -f compose.yaml -f compose.dev.yaml "$@"
