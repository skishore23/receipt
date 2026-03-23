import type { FactoryAwsExecutionContext, FactoryCloudExecutionContext } from "./factory-cloud-context";

const AWS_INFRA_GUIDANCE =
  "Infrastructure profile is AWS-only for now. Ignore other mounted cloud sessions and fail fast with the exact AWS CLI error if AWS access is unavailable.";

const buildAwsInfraSummary = (aws: FactoryAwsExecutionContext | undefined): string => {
  if (!aws) {
    return `${AWS_INFRA_GUIDANCE} No live AWS CLI context was detected from this machine.`;
  }
  if (!aws.callerIdentity) {
    return [
      AWS_INFRA_GUIDANCE,
      `AWS CLI is available${aws.selectedProfile ? ` via profile ${aws.selectedProfile}` : ""}, but no active caller identity was confirmed.`,
    ].join(" ");
  }
  return [
    AWS_INFRA_GUIDANCE,
    `AWS CLI is available${aws.selectedProfile ? ` via profile ${aws.selectedProfile}` : ""}; active identity ${aws.callerIdentity.arn} in account ${aws.callerIdentity.accountId}${aws.defaultRegion ? ` with region ${aws.defaultRegion}` : ""}.`,
  ].join(" ");
};

const buildAwsInfraGuidance = (aws: FactoryAwsExecutionContext | undefined): ReadonlyArray<string> => {
  const guidance = [AWS_INFRA_GUIDANCE];
  if (aws?.callerIdentity) {
    guidance.push(`AWS bucket listing is global for the active account ${aws.callerIdentity.accountId}; region is secondary unless the objective asks for regional filtering.`);
  }
  return guidance;
};

export const resolveFactoryCloudExecutionContext = (
  profileId: string | undefined,
  context: FactoryCloudExecutionContext,
): FactoryCloudExecutionContext => {
  if (profileId !== "infrastructure") return context;
  const aws = context.aws;
  return {
    summary: buildAwsInfraSummary(aws),
    availableProviders: aws ? ["aws"] : [],
    activeProviders: aws?.callerIdentity ? ["aws"] : [],
    preferredProvider: "aws",
    guidance: buildAwsInfraGuidance(aws),
    aws,
  };
};
