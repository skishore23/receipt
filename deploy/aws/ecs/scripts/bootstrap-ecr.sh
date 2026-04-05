#!/usr/bin/env bash
set -euo pipefail

repo_name="${1:-receipt}"
region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

aws ecr create-repository --repository-name "$repo_name" --region "$region" >/dev/null 2>&1 || true
aws ecr describe-repositories --repository-names "$repo_name" --region "$region" \
  --query 'repositories[0].repositoryUri' --output text
