---
name: factory-infrastructure-aws
description: Use when the Infrastructure Factory profile is running CLI-native cloud investigations and should default to AWS commands, AWS scope, and S3 interpretations unless the objective explicitly names another provider.
---

# Factory Infrastructure AWS

Use this skill when the active Factory profile is `infrastructure` and the work is about cloud resources, permissions, incidents, or inventory gathered through the CLI.

## Primary Goal

Keep infrastructure investigations AWS-only for now. If the prompt is ambiguous and AWS context is mounted, assume AWS and move forward instead of branching into GCP or Azure.

## First Pass

1. Read the task packet and the mounted live cloud context.
2. Treat the mounted AWS account/profile as the default execution target.
3. Read the checked-in worker context skill before using receipt or memory commands.
4. For simple CLI investigations, write a small deterministic shell script in `.receipt/factory/` before you start chaining one-off AWS commands.
5. Run the script from the current worktree and summarize what its output means.

## AWS Defaults

- For infrastructure work in this repo, default to AWS unless the objective explicitly says otherwise.
- Interpret `buckets` as S3 buckets unless the objective names another storage provider.
- Treat the mounted AWS profile/account as authoritative for the current investigation. Do not ask the user to restate it when the packet already provides it.
- S3 bucket listing is account-global. Do not branch by region unless the objective explicitly asks for regional filtering.
- Ignore locally active GCP or Azure sessions unless the objective explicitly requests multi-cloud work.
- If AWS access is unavailable, stop quickly and return the exact AWS CLI error instead of exploring alternate providers.

## Investigation Rules

- Prefer AWS CLI evidence over speculation.
- Default to a small deterministic shell script for provider-sensitive or repeated AWS CLI work. The script should fail fast, emit machine-readable output when practical, and make the exact evidence path reproducible.
- Capture `aws sts get-caller-identity` in the script before resource queries so the account scope is explicit in the evidence.
- For fail-fast behavior, prefer `AWS_PAGER=''`, `AWS_MAX_ATTEMPTS=1`, `AWS_RETRY_MODE=standard`, and `AWS_EC2_METADATA_DISABLED=true`.
- Record the script path and invocation in `report.scriptsRun`, then explain the output in plain language.
- Summarize findings in plain language. Do not return raw command output without interpretation.
- Do not run the broad repo validation suite for a no-code AWS investigation unless the task explicitly owns validation or you changed repo files.
