import type { FactoryObjectiveMode } from "../modules/factory";
import type { FactoryCloudExecutionContext } from "./factory-cloud-context";

const AWS_ACCOUNT_SCOPE_HELPER = "skills/factory-infrastructure-aws/scripts/aws-account-scope.sh";
const INVENTORY_PROMPT_RE = /\b(how many|count|list|show|inventory|enumerate|what are|which)\b/i;
const COST_PROMPT_RE = /\b(cost|costs|pricing|price|spend)\b/i;
const AWS_MULTI_SERVICE_RE = /\b(ec2|ebs|snapshot|snapshots|s3|rds|nat|load balancer|load balancers|elb|cloudwatch|eks|elastic ip|elastic ips)\b/gi;
const FAIL_FAST_DENIED_RE = /fail fast if any aws cli call is denied and report exact error\.?/i;

export const cloudProviderDefaultsToAws = (cloudProvider: string | undefined): boolean =>
  cloudProvider === "aws";

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
  if (!cloudProviderDefaultsToAws(input.profileCloudProvider) || input.objectiveMode !== "investigation") return input.taskPrompt;
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
  if (!cloudProviderDefaultsToAws(input.profileCloudProvider) || input.objectiveMode !== "investigation") return [];
  const provider = input.cloudExecutionContext.preferredProvider ?? "aws";
  return [
    `## Script-First Execution`,
    `For infrastructure CLI investigations, prefer a deterministic shell script over ad hoc one-off commands.`,
    `Write the script under .receipt/factory/ when practical, make it emit machine-readable output, and fail fast on CLI, auth, or network errors.`,
    `Run the script from the worktree before interpreting the result, and base the report on the script output rather than memory or speculation.`,
    `After reading AGENTS.md, the task packet, the memory context/objective summaries, and the mounted AWS skill, stop bootstrap and immediately write and run the script. Do not keep exploring unrelated repo files for a simple AWS inventory task.`,
    `If the script succeeds and gives enough evidence to answer the task, stop immediately and return the final JSON result. Do not spend extra turns reformatting already-valid AWS CLI JSON, re-checking git status, or doing optional follow-up probes.`,
    `Treat successful AWS CLI JSON output as sufficient machine-readable evidence unless the task explicitly asks for a different format.`,
    `Record the script path and invocation in report.scriptsRun so the operator can rerun the exact evidence path.`,
    ...(provider === "aws"
      ? [
          `For AWS tasks, capture \`aws sts get-caller-identity\` in the script first so account scope is explicit in the evidence.`,
          `Prefer fail-fast AWS CLI settings like \`AWS_PAGER=''\`, \`AWS_MAX_ATTEMPTS=1\`, \`AWS_RETRY_MODE=standard\`, and \`AWS_EC2_METADATA_DISABLED=true\`.`,
          `Treat a successful \`sts get-caller-identity\` as proof of mounted account scope only, not proof that every downstream AWS service API is authorized.`,
          `For region-scoped AWS inventory, do not blindly loop raw \`aws ec2 describe-regions --all-regions\` output.`,
          `Use the mounted AWS region scope from the context pack when present, or run \`bash ${AWS_ACCOUNT_SCOPE_HELPER}\` first to discover the current account's queryable EC2 regions.`,
          `Treat \`not-opted-in\` regions as skipped scope, not as a global credential failure, and report skipped regions separately when they matter to the investigation.`,
          `For broad multi-service AWS inventory, capture exact per-service \`AccessDenied\` results and continue with the remaining allowed services when the denied API is not central to the task. Only stop immediately on account-scope/auth failures, region-scope discovery failures, or when the denied service is the core requested evidence.`,
        ]
      : []),
  ];
};
