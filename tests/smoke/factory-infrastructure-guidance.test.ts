import { expect, test } from "bun:test";

import {
  rewriteInfrastructureTaskPromptForExecution,
  renderInfrastructureTaskExecutionGuidance,
} from "../../src/services/factory-infrastructure-guidance";
import type { FactoryCloudExecutionContext } from "../../src/services/factory-cloud-context";

test("factory infrastructure guidance: execution guidance allows partial progress on multi-service AccessDenied", () => {
  const cloudExecutionContext: FactoryCloudExecutionContext = {
    summary: "AWS CLI is available via profile default; active identity arn:aws:iam::445567089271:user/csagent-api-service in account 445567089271 with region us-east-1.",
    availableProviders: ["aws"],
    activeProviders: ["aws"],
    preferredProvider: "aws",
    guidance: [],
    aws: {
      cliPath: "/opt/homebrew/bin/aws",
      version: "aws-cli/2.34.14",
      profiles: ["default"],
      selectedProfile: "default",
      defaultRegion: "us-east-1",
      callerIdentity: {
        accountId: "445567089271",
        arn: "arn:aws:iam::445567089271:user/csagent-api-service",
      },
      ec2RegionScope: {
        regions: [
          { regionName: "us-east-1", optInStatus: "opt-in-not-required", endpoint: "ec2.us-east-1.amazonaws.com", queryable: true },
        ],
        queryableRegions: ["us-east-1"],
        skippedRegions: [],
      },
    },
  };

  const guidance = renderInfrastructureTaskExecutionGuidance({
    profileCloudProvider: "aws",
    objectiveMode: "investigation",
    cloudExecutionContext,
  });

  expect(guidance).toContain(
    "Treat a successful `sts get-caller-identity` as proof of mounted account scope only, not proof that every downstream AWS service API is authorized.",
  );
  expect(guidance).toContain(
    "For broad multi-service AWS inventory, capture exact per-service `AccessDenied` results and continue with the remaining allowed services when the denied API is not central to the task. Only stop immediately on account-scope/auth failures, region-scope discovery failures, or when the denied service is the core requested evidence.",
  );
  expect(guidance).toContain(
    "For vague prompts such as \"show me something interesting\", decide one concrete selection rule, one primary evidence source, and one stop condition before the first AWS command.",
  );
  expect(guidance).toContain(
    "Only rerun a helper or switch helpers to fix a concrete scope, auth, parsing, or redaction issue. Do not keep iterating once you already have a valid finding.",
  );
  expect(guidance).toContain(
    "Never print or persist raw secret, token, password, API key, or credential values in stdout, stderr, artifacts, or the final JSON. Report presence, source, and impact, but redact the value itself.",
  );
});

test("factory infrastructure guidance: broad multi-service prompts do not keep contradictory fail-fast-on-any-denial wording", () => {
  const rewritten = rewriteInfrastructureTaskPromptForExecution({
    profileCloudProvider: "aws",
    objectiveMode: "investigation",
    taskPrompt: "Run targeted AWS CLI inventory across EC2, EBS, RDS, S3, NAT, ELB, and CloudWatch. Output counts and notable outliers. Fail fast if any AWS CLI call is denied and report exact error.",
  });

  expect(rewritten).not.toContain("Fail fast if any AWS CLI call is denied and report exact error.");
  expect(rewritten).toContain("capture exact per-service AccessDenied results and continue with the remaining allowed services");
});
