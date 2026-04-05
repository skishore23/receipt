#!/usr/bin/env bash
set -euo pipefail

repo_name="${REPOSITORY_NAME:-receipt}"
cluster_name="${CLUSTER_NAME:-receipt}"
service_name="${SERVICE_NAME:-receipt}"
task_family="${TASK_FAMILY:-receipt-api}"
container_name="${CONTAINER_NAME:-receipt}"
region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
image_tag="${IMAGE_TAG:-latest}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ecs_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$ecs_dir/../../.." && pwd)"

repo_uri="$("$script_dir/bootstrap-ecr.sh" "$repo_name")"
image_uri="$repo_uri:$image_tag"

aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "${repo_uri%%/*}"
docker build -t "$image_uri" "$repo_root"
docker push "$image_uri"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

bun "$script_dir/render-template.mjs" "$ecs_dir/taskdef.tpl.json" "$tmp/taskdef.json" \
  TASK_FAMILY="$task_family" \
  CPU="${CPU:-512}" \
  MEMORY="${MEMORY:-1024}" \
  EXECUTION_ROLE_ARN="${EXECUTION_ROLE_ARN:?EXECUTION_ROLE_ARN is required}" \
  TASK_ROLE_ARN="${TASK_ROLE_ARN:?TASK_ROLE_ARN is required}" \
  CONTAINER_NAME="$container_name" \
  IMAGE_URI="$image_uri" \
  CONTAINER_PORT="${CONTAINER_PORT:-8787}" \
  OPENAI_API_KEY_SECRET_ARN="${OPENAI_API_KEY_SECRET_ARN:?OPENAI_API_KEY_SECRET_ARN is required}" \
  LOG_GROUP_NAME="${LOG_GROUP_NAME:-/ecs/receipt}" \
  AWS_REGION="$region" \
  LOG_STREAM_PREFIX="${LOG_STREAM_PREFIX:-receipt}"

task_def_arn="$(aws ecs register-task-definition --region "$region" --cli-input-json "file://$tmp/taskdef.json" --query 'taskDefinition.taskDefinitionArn' --output text)"
aws ecs update-service --region "$region" --cluster "$cluster_name" --service "$service_name" --task-definition "$task_def_arn" --force-new-deployment >/dev/null
aws ecs wait services-stable --region "$region" --cluster "$cluster_name" --services "$service_name"

printf '%s\n' "$task_def_arn"
