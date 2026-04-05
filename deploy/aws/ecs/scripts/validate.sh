#!/usr/bin/env bash
set -euo pipefail

ecs_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

render() {
  local template="$1"
  local output="$2"
  shift 2
  bun "$ecs_dir/scripts/render-template.mjs" "$ecs_dir/$template" "$tmp/$output" "$@"
  node --input-type=module -e "import fs from 'node:fs'; JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))" "$tmp/$output"
}

render taskdef.tpl.json taskdef.json \
  TASK_FAMILY=receipt-api \
  CPU=512 \
  MEMORY=1024 \
  EXECUTION_ROLE_ARN=arn:aws:iam::123456789012:role/receipt-ecs-execution \
  TASK_ROLE_ARN=arn:aws:iam::123456789012:role/receipt-ecs-task \
  CONTAINER_NAME=receipt \
  IMAGE_URI=123456789012.dkr.ecr.us-east-1.amazonaws.com/receipt:latest \
  CONTAINER_PORT=8787 \
  OPENAI_API_KEY_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:receipt/openai \
  LOG_GROUP_NAME=/ecs/receipt \
  AWS_REGION=us-east-1 \
  LOG_STREAM_PREFIX=receipt

render service.tpl.json service.json \
  SERVICE_NAME=receipt \
  CLUSTER_NAME=receipt \
  TASK_DEFINITION_ARN=arn:aws:ecs:us-east-1:123456789012:task-definition/receipt:1 \
  DESIRED_COUNT=2 \
  SUBNET_ID=subnet-12345678 \
  SECURITY_GROUP_ID=sg-12345678

render cluster.tpl.json cluster.json \
  CLUSTER_NAME=receipt

printf 'validated %s\n' "$ecs_dir"
