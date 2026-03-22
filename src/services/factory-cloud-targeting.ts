import type { FactoryCloudExecutionContext } from "./factory-cloud-context";

const AWS_INFRA_GUIDANCE =
  "Infrastructure profile currently defaults to AWS. Ignore other mounted cloud sessions and fail fast with the exact AWS CLI error if AWS access is unavailable.";

const stripConflictingGuidance = (text: string): string =>
  text
    .replace(/\s*Multiple cloud providers are active locally\. Confirm the intended provider before using high-confidence counts\./g, "")
    .replace(/\s*Cloud CLIs are installed locally, but no single active provider context was detected\./g, "")
    .replace(/\s*One provider is clearly usable from the local CLI context \(aws\)\. Use it by default instead of asking the user to restate provider or scope\./g, "")
    .trim();

const uniq = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values.filter(Boolean))];

export const resolveFactoryCloudExecutionContext = (
  profileId: string | undefined,
  context: FactoryCloudExecutionContext,
): FactoryCloudExecutionContext => {
  if (profileId !== "infrastructure") return context;
  const summary = [
    stripConflictingGuidance(context.summary),
    AWS_INFRA_GUIDANCE,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  return {
    ...context,
    preferredProvider: "aws",
    guidance: uniq([
      AWS_INFRA_GUIDANCE,
      ...context.guidance.map(stripConflictingGuidance).filter(Boolean),
    ]),
    summary,
  };
};
