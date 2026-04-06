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
4. For region-scoped AWS inventory, use the mounted `cloudExecutionContext.aws.ec2RegionScope` when present.
5. Prefer the checked-in helper catalog and AWS CLI cookbook before inventing a new command chain.
6. Run the best matching helper and summarize what its output means.

## AWS Defaults

- For infrastructure work in this repo, default to AWS unless the objective explicitly says otherwise.
- Interpret `buckets` as S3 buckets unless the objective names another storage provider.
- Treat the mounted AWS profile/account as authoritative for the current investigation. Do not ask the user to restate it when the packet already provides it.
- S3 bucket listing is account-global. Do not branch by region unless the objective explicitly asks for regional filtering.
- Ignore locally active GCP or Azure sessions unless the objective explicitly requests multi-cloud work.
- If AWS access is unavailable, stop quickly and return the exact AWS CLI error instead of exploring alternate providers.

## Investigation Rules

- Prefer AWS CLI evidence over speculation.
- Default to the checked-in helper catalog for provider-sensitive or repeated AWS CLI work. Helpers should fail fast, emit machine-readable output, and make the exact evidence path reproducible.
- Use the `aws_account_scope` helper when account scope should be explicit in the evidence.
- For fail-fast behavior, prefer `AWS_PAGER=''`, `AWS_MAX_ATTEMPTS=1`, `AWS_RETRY_MODE=standard`, and `AWS_EC2_METADATA_DISABLED=true`.
- Distinguish account-level AWS access failures from per-service IAM denials. A working `sts get-caller-identity` only proves the mounted identity is usable; it does not prove every `Describe*` or `List*` API is allowed.
- For regional AWS services such as EC2, do not blindly iterate raw `aws ec2 describe-regions --all-regions` output.
- Treat only `opt-in-not-required` and `opted-in` regions as queryable for cross-region EC2 inventory. Skip `not-opted-in` regions and report them separately when relevant.
- If an EC2 call fails in a `not-opted-in` region, treat that as region scope for the current account, not as proof that the overall AWS credentials are globally invalid.
- For broad multi-service inventory or cost-validation tasks, capture exact `AccessDenied` errors per service and continue collecting evidence from the remaining allowed services when the denied API is not the core task scope.
- If access gaps still leave you with usable evidence, return a final investigation report that says the inventory is incomplete due to permissions; reserve a hard blocked outcome for zero-evidence failures that prevent a meaningful report.
- Use the checked-in helper runtime when you need a reusable JSON snapshot of the current AWS account, profile, EC2 region scope, resource inventory, alarm summary, or log sample.
- If a helper succeeds and answers the task, stop and return the final JSON result immediately. Do not spend extra turns reformatting already-valid AWS CLI JSON or running optional follow-up checks.
- Record the helper runner command in `report.scriptsRun`, then explain the output in plain language.
- Summarize findings in plain language. Do not return raw command output without interpretation.
- Do not run the broad repo validation suite for a no-code AWS investigation unless the task explicitly owns validation or you changed repo files.
