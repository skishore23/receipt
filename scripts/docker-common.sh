#!/usr/bin/env bash
set -euo pipefail

receipt_docker_prepare() {
  local mode="${1}"
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  export ROOT
  cd "${ROOT}"

  export HOST_HOME="${HOST_HOME:-${HOME}}"
  export LOCAL_UID="${LOCAL_UID:-$(id -u)}"
  export LOCAL_GID="${LOCAL_GID:-$(id -g)}"
  export PORT="${PORT:-8787}"
  if [ "${mode}" = "dev" ]; then
    export CHAT_WORKER_PROCESSES="${CHAT_WORKER_PROCESSES:-2}"
    export CONTROL_WORKER_PROCESSES="${CONTROL_WORKER_PROCESSES:-4}"
    export CODEX_WORKER_PROCESSES="${CODEX_WORKER_PROCESSES:-2}"
  else
    export CHAT_WORKER_PROCESSES="${CHAT_WORKER_PROCESSES:-10}"
    export CONTROL_WORKER_PROCESSES="${CONTROL_WORKER_PROCESSES:-4}"
    export CODEX_WORKER_PROCESSES="${CODEX_WORKER_PROCESSES:-6}"
  fi
  export CHAT_JOB_CONCURRENCY="${CHAT_JOB_CONCURRENCY:-50}"
  export ORCHESTRATION_JOB_CONCURRENCY="${ORCHESTRATION_JOB_CONCURRENCY:-20}"
  export CODEX_JOB_CONCURRENCY="${CODEX_JOB_CONCURRENCY:-30}"
  export JOB_CONCURRENCY="${JOB_CONCURRENCY:-12}"
  if [ "${mode}" = "dev" ]; then
    export RESONATE_QUEUE_REFRESH_MS="${RESONATE_QUEUE_REFRESH_MS:-1000}"
  else
    export RESONATE_QUEUE_REFRESH_MS="${RESONATE_QUEUE_REFRESH_MS:-1000}"
  fi
  export RESONATE_STARTUP_SETTLE_MS="${RESONATE_STARTUP_SETTLE_MS:-1000}"
  export RECEIPT_SERVER_WATCH="${RECEIPT_SERVER_WATCH:-api}"
  export RECEIPT_CSS_WATCH="${RECEIPT_CSS_WATCH:-1}"

  local state_root="${ROOT}/.receipt"
  local stub_root="${state_root}/docker/stubs"
  mkdir -p \
    "${state_root}/data" \
    "${state_root}/resonate" \
    "${state_root}/home" \
    "${state_root}/home/.codex" \
    "${stub_root}/codex" \
    "${stub_root}/aws" \
    "${stub_root}/gh" \
    "${stub_root}/ssh"
  : > "${stub_root}/codex/auth.json"
  : > "${stub_root}/codex/config.toml"
  : > "${stub_root}/codex/version.json"
  : > "${stub_root}/codex/.codex-global-state.json"
  : > "${stub_root}/gitconfig"
  : > "${stub_root}/git-credentials"
  : > "${stub_root}/ssh-auth"

  if [ -f "${HOST_HOME}/.codex/auth.json" ]; then
    export RECEIPT_DOCKER_CODEX_AUTH_SOURCE="${HOST_HOME}/.codex/auth.json"
  else
    export RECEIPT_DOCKER_CODEX_AUTH_SOURCE="${stub_root}/codex/auth.json"
  fi
  if [ -f "${HOST_HOME}/.codex/config.toml" ]; then
    export RECEIPT_DOCKER_CODEX_CONFIG_SOURCE="${HOST_HOME}/.codex/config.toml"
  else
    export RECEIPT_DOCKER_CODEX_CONFIG_SOURCE="${stub_root}/codex/config.toml"
  fi
  if [ -f "${HOST_HOME}/.codex/version.json" ]; then
    export RECEIPT_DOCKER_CODEX_VERSION_SOURCE="${HOST_HOME}/.codex/version.json"
  else
    export RECEIPT_DOCKER_CODEX_VERSION_SOURCE="${stub_root}/codex/version.json"
  fi
  if [ -f "${HOST_HOME}/.codex/.codex-global-state.json" ]; then
    export RECEIPT_DOCKER_CODEX_STATE_SOURCE="${HOST_HOME}/.codex/.codex-global-state.json"
  else
    export RECEIPT_DOCKER_CODEX_STATE_SOURCE="${stub_root}/codex/.codex-global-state.json"
  fi
  if [ -d "${HOST_HOME}/.aws" ]; then
    export RECEIPT_DOCKER_AWS_SOURCE="${HOST_HOME}/.aws"
  else
    export RECEIPT_DOCKER_AWS_SOURCE="${stub_root}/aws"
  fi
  if [ -d "${HOST_HOME}/.config/gh" ]; then
    export RECEIPT_DOCKER_GH_SOURCE="${HOST_HOME}/.config/gh"
  else
    export RECEIPT_DOCKER_GH_SOURCE="${stub_root}/gh"
  fi
  if [ -d "${HOST_HOME}/.ssh" ]; then
    export RECEIPT_DOCKER_SSH_SOURCE="${HOST_HOME}/.ssh"
  else
    export RECEIPT_DOCKER_SSH_SOURCE="${stub_root}/ssh"
  fi
  if [ -f "${HOST_HOME}/.gitconfig" ]; then
    export RECEIPT_DOCKER_GITCONFIG_SOURCE="${HOST_HOME}/.gitconfig"
  else
    export RECEIPT_DOCKER_GITCONFIG_SOURCE="${stub_root}/gitconfig"
  fi
  if [ -f "${HOST_HOME}/.git-credentials" ]; then
    export RECEIPT_DOCKER_GIT_CREDENTIALS_SOURCE="${HOST_HOME}/.git-credentials"
  else
    export RECEIPT_DOCKER_GIT_CREDENTIALS_SOURCE="${stub_root}/git-credentials"
  fi

  export RECEIPT_DOCKER_SSH_AUTH_TARGET="/tmp/receipt-ssh-agent.sock"
  if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK}" ]; then
    export RECEIPT_DOCKER_SSH_AUTH_SOURCE="${SSH_AUTH_SOCK}"
    export RECEIPT_DOCKER_FORWARD_SSH_AUTH_SOCK="${RECEIPT_DOCKER_SSH_AUTH_TARGET}"
  else
    export RECEIPT_DOCKER_SSH_AUTH_SOURCE="${stub_root}/ssh-auth"
    export RECEIPT_DOCKER_FORWARD_SSH_AUTH_SOCK=""
  fi

  if [ -n "${RECEIPT_IMAGE:-}" ]; then
    export RECEIPT_IMAGE_EXPLICIT=1
  else
    export RECEIPT_IMAGE="receipt:prod"
    export RECEIPT_IMAGE_EXPLICIT=0
  fi

  if [ "${mode}" = "dev" ] && [ ! -f "${HOST_HOME}/.codex/auth.json" ] && [ ! -f "${HOST_HOME}/.codex/config.toml" ]; then
    echo "[receipt-docker] warning: ${HOST_HOME}/.codex does not look initialized; Codex auth may fail until the host CLI is signed in." >&2
  fi
}

receipt_docker_stop_conflicting_projects() {
  local target_project="${1}"
  local project
  local container_ids
  local stopped_any=0
  local projects=("receipt" "receipt-dev" "receipt-prod")

  for project in "${projects[@]}"; do
    if [ "${project}" = "${target_project}" ]; then
      continue
    fi
    container_ids="$(docker ps -q --filter "label=com.docker.compose.project=${project}")"
    if [ -n "${container_ids}" ]; then
      echo "[receipt-docker] stopping conflicting ${project} stack" >&2
      docker rm -f ${container_ids} >/dev/null 2>&1 || true
      stopped_any=1
    fi
  done

  return "${stopped_any}"
}
