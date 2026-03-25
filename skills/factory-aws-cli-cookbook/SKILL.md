---
name: factory-aws-cli-cookbook
description: Use when Codex needs AWS CLI command patterns, pagination, query shaping, or command discovery while working inside the helper-first infrastructure flow.
---

# Factory AWS CLI Cookbook

Use this skill for AWS CLI lookup and shaping while authoring or running checked-in helpers.

## Defaults

- Prefer `aws ... --output json`.
- Use explicit `--profile` and `--region` args when the helper exposes them.
- Keep `AWS_PAGER=''`, `AWS_MAX_ATTEMPTS=1`, `AWS_RETRY_MODE=standard`, and `AWS_EC2_METADATA_DISABLED=true`.
- For region-scoped inventory, discover queryable regions first instead of looping every region blindly.

## Discovery Patterns

- Caller identity: `aws sts get-caller-identity --output json`
- Region scope: `aws ec2 describe-regions --all-regions --query 'Regions[].{RegionName:RegionName,OptInStatus:OptInStatus}' --output json`
- Help lookup: `aws <service> help`
- Command lookup: `aws <service> <operation> help`

## Query Patterns

- Use `--query` for small targeted projections.
- Use `jq` only when the AWS CLI query language is not enough and the runtime already has `jq`.
- Keep helper summaries human-readable; keep large raw payloads in artifacts.

## Guardrails

- Distinguish account-scope failures from per-service denials.
- Do not print raw secret values from logs, parameters, or credentials.
- Prefer checked-in helpers over ad hoc command chains.
