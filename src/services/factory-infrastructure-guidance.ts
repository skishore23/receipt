import type { FactoryObjectiveMode } from "../modules/factory";
import type { FactoryCloudExecutionContext } from "./factory-cloud-context";

const HELPER_RUNNER = "skills/factory-helper-runtime/runner.py";
const INVENTORY_PROMPT_RE = /\b(how many|count|list|show|inventory|enumerate|what are|which)\b/i;
const COST_PROMPT_RE = /\b(cost|costs|pricing|price|spend)\b/i;
const AWS_MULTI_SERVICE_RE = /\b(ec2|ebs|snapshot|snapshots|s3|rds|nat|load balancer|load balancers|elb|cloudwatch|eks|elastic ip|elastic ips)\b/gi;
const CLOUD_CONTEXT_HINT_RE = /\b(?:aws|gcp|azure|cloud\b|ec2|s3|rds|lambda|eks|ecr|ecs|iam|vpc|route53|cloudformation|cloudwatch|bigquery|pubsub|gcloud|google cloud|terraform|kubernetes|k8s|helm)\b/i;
const FAIL_FAST_DENIED_RE = /fail fast if any aws cli call is denied and report exact error\.?/i;

const isAwsCloudProvider = (cloudProvider: string | undefined): boolean =>
  cloudProvider === "aws";

export const taskNeedsCloudExecutionContext = (input: {
  readonly profileId?: string;
  readonly profileCloudProvider?: string;
  readonly taskTitle?: string;
  readonly taskPrompt: string;
}): boolean =>
  input.profileId === "infrastructure"
  || Boolean(input.profileCloudProvider?.trim())
  || CLOUD_CONTEXT_HINT_RE.test(`${input.taskTitle ?? ""}\n${input.taskPrompt}`);

const countAwsServiceMentions = (prompt: string): number => {
  const services = new Set(
    (prompt.match(AWS_MULTI_SERVICE_RE) ?? [])
      .map((service) => service.trim().toLowerCase()),
  );
  return services.size;
};

const isBroadAwsMultiServiceInventoryPrompt = (prompt: string): boolean => {
  if (!INVENTORY_PROMPT_RE.test(prompt) && !COST_PROMPT_RE.test(prompt)) return false;
  if (/\bbroad multi-service\b|\bkey spend services\b|\bcost contributors\b/i.test(prompt)) return true;
  return countAwsServiceMentions(prompt) >= 3;
};

export const rewriteInfrastructureTaskPromptForExecution = (input: {
  readonly profileCloudProvider?: string;
  readonly objectiveMode: FactoryObjectiveMode;
  readonly taskPrompt: string;
}): string => {
  if (!isAwsCloudProvider(input.profileCloudProvider) || input.objectiveMode !== "investigation") return input.taskPrompt;
  if (!FAIL_FAST_DENIED_RE.test(input.taskPrompt)) return input.taskPrompt;
  if (!isBroadAwsMultiServiceInventoryPrompt(input.taskPrompt)) return input.taskPrompt;
  return input.taskPrompt.replace(
    FAIL_FAST_DENIED_RE,
    "If AWS CLI account access or region-scope discovery fails, stop immediately and report the exact error. Otherwise capture exact per-service AccessDenied results and continue with the remaining allowed services; only treat a denied API as blocking when that service is central to the requested evidence.",
  );
};

export const renderInfrastructureTaskExecutionGuidance = (input: {
  readonly profileCloudProvider?: string;
  readonly objectiveMode: FactoryObjectiveMode;
  readonly cloudExecutionContext: FactoryCloudExecutionContext;
}): ReadonlyArray<string> => {
  if (input.objectiveMode !== "investigation") return [];
  const provider = input.profileCloudProvider
    ?? input.cloudExecutionContext.preferredProvider
    ?? (input.cloudExecutionContext.activeProviders.length === 1
      ? input.cloudExecutionContext.activeProviders[0]
      : input.cloudExecutionContext.availableProviders.length === 1
        ? input.cloudExecutionContext.availableProviders[0]
        : undefined);
  const generic = [
    `## Helper-First Execution`,
    `For infrastructure CLI investigations, prefer a checked-in helper over ad hoc one-off commands or a task-local script.`,
    `For vague prompts such as "show me something interesting", decide one concrete selection rule, one primary evidence source, and one stop condition before the first cloud command.`,
    `After reading AGENTS.md, the task packet, the memory context/objective summaries, and the mounted helper skills, stop bootstrap and run the best matching checked-in helper. Do not keep exploring unrelated repo files for a simple cloud inventory task.`,
    `Run helpers through \`python3 ${HELPER_RUNNER} run --provider ${provider ?? "<provider>"} --json <helper-id> -- ...\` and base the report on the helper output rather than memory or speculation.`,
    `Use one primary evidence path. Only widen the investigation to a second service when the first path is empty, contradictory, or permission-blocked.`,
    `If the helper succeeds and gives enough evidence to answer the task, stop immediately and return the final JSON result. Do not spend extra turns reformatting already-valid CLI JSON, re-checking git status, or doing optional follow-up probes.`,
    `Only rerun a helper or switch helpers to fix a concrete scope, auth, parsing, or redaction issue. Do not keep iterating once you already have a valid finding.`,
    `If the helper catalog misses the required behavior and the contract is clear enough, use the mounted helper authoring skill to add or extend a checked-in helper under \`skills/factory-helper-runtime/catalog/\`, then run it instead of stopping at a no-helper result.`,
    `Never print or persist raw secret, token, password, API key, or credential values in stdout, stderr, artifacts, or the final JSON. Report presence, source, and impact, but redact the value itself.`,
    `Treat successful helper JSON output as sufficient machine-readable evidence unless the task explicitly asks for a different format.`,
    `Record the helper runner command in report.scriptsRun so the operator can rerun the exact evidence path.`,
    `If no checked-in helper matches the ask, create or extend a checked-in helper when the missing behavior is clear. Only stop when the helper contract is still ambiguous or repo edits are explicitly out of scope. Do not invent a new .receipt/factory script.`,
  ];
  return [
    ...generic,
    ...(provider === "aws"
      ? [
          `For AWS tasks, prefer the checked-in \`aws_account_scope\` and \`aws_region_scope\` helpers when account or region scope is part of the evidence path.`,
          `Prefer fail-fast AWS CLI settings like \`AWS_PAGER=''\`, \`AWS_MAX_ATTEMPTS=1\`, \`AWS_RETRY_MODE=standard\`, and \`AWS_EC2_METADATA_DISABLED=true\`.`,
          `Treat a successful \`sts get-caller-identity\` as proof of mounted account scope only, not proof that every downstream AWS service API is authorized.`,
          `For region-scoped AWS inventory, do not blindly loop raw \`aws ec2 describe-regions --all-regions\` output.`,
          `Use the mounted AWS region scope from the context pack when present, or run the checked-in \`aws_region_scope\` helper first to discover the current account's queryable EC2 regions.`,
          `Treat \`not-opted-in\` regions as skipped scope, not as a global credential failure, and report skipped regions separately when they matter to the investigation.`,
          `For broad multi-service AWS inventory, capture exact per-service \`AccessDenied\` results and continue with the remaining allowed services when the denied API is not central to the task. Only stop immediately on account-scope/auth failures, region-scope discovery failures, or when the denied service is the core requested evidence.`,
        ]
      : []),
  ];
};
