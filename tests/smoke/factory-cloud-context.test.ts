import { expect, test } from "bun:test";

import {
  scanFactoryCloudExecutionContext,
  type FactoryCloudCommandResult,
  type FactoryCloudCommandRunner,
} from "../../src/services/factory-cloud-context";

const ok = (stdout: string, stderr = ""): FactoryCloudCommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr,
});

const fail = (stderr: string): FactoryCloudCommandResult => ({
  ok: false,
  exitCode: 1,
  stdout: "",
  stderr,
});

test("factory cloud context: auto-discovers EC2 queryable regions for the active AWS account", async () => {
  const priorAwsProfile = process.env.AWS_PROFILE;
  const priorAwsRegion = process.env.AWS_REGION;
  const priorAwsDefaultRegion = process.env.AWS_DEFAULT_REGION;
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;

  const runner: FactoryCloudCommandRunner = async (command, args) => {
    if (command === "which" && args[0] === "aws") return ok("/opt/homebrew/bin/aws\n");
    if (command === "which" && (args[0] === "gcloud" || args[0] === "az")) return fail("not found");
    if (command === "aws" && args[0] === "--version") {
      return ok("", "aws-cli/2.34.14 Python/3.13.2 Darwin/arm64\n");
    }
    if (command === "aws" && args[0] === "configure" && args[1] === "list-profiles") {
      return ok("default\nlocalstack\n");
    }
    if (command === "aws" && args[0] === "configure" && args[1] === "get" && args[2] === "region") {
      return ok("us-east-1\n");
    }
    if (command === "aws" && args[0] === "sts" && args[1] === "get-caller-identity") {
      return ok(JSON.stringify({
        Account: "445567089271",
        Arn: "arn:aws:iam::445567089271:user/csagent-api-service",
        UserId: "AIDATEST",
      }));
    }
    if (command === "aws" && args[0] === "ec2" && args[1] === "describe-regions") {
      return ok(JSON.stringify([
        {
          RegionName: "us-east-1",
          OptInStatus: "opt-in-not-required",
          Endpoint: "ec2.us-east-1.amazonaws.com",
        },
        {
          RegionName: "us-west-2",
          OptInStatus: "opt-in-not-required",
          Endpoint: "ec2.us-west-2.amazonaws.com",
        },
        {
          RegionName: "af-south-1",
          OptInStatus: "not-opted-in",
          Endpoint: "ec2.af-south-1.amazonaws.com",
        },
      ]));
    }
    return fail(`${command} ${args.join(" ")} was not stubbed`);
  };

  try {
    const context = await scanFactoryCloudExecutionContext(runner);
    expect(context.preferredProvider).toBe("aws");
    expect(context.aws?.selectedProfile).toBe("default");
    expect(context.aws?.callerIdentity?.accountId).toBe("445567089271");
    expect(context.aws?.ec2RegionScope?.queryableRegions).toEqual(["us-east-1", "us-west-2"]);
    expect(context.aws?.ec2RegionScope?.skippedRegions).toEqual([
      {
        regionName: "af-south-1",
        optInStatus: "not-opted-in",
        endpoint: "ec2.af-south-1.amazonaws.com",
      },
    ]);
    expect(context.summary).toContain("EC2 regional scope for this account: 2 queryable regions; skip 1 not-opted-in regions");
    expect(context.guidance).toContain(
      "For cross-region EC2 inventory in this account, use only the mounted queryable regions and skip not-opted-in regions instead of treating their failures as global credential problems.",
    );
    expect(context.guidance).toContain(
      "Mounted AWS caller identity and region scope do not guarantee every service API is authorized. Treat service-specific AccessDenied results separately from account-wide auth failures.",
    );
  } finally {
    if (priorAwsProfile === undefined) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = priorAwsProfile;
    if (priorAwsRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = priorAwsRegion;
    if (priorAwsDefaultRegion === undefined) delete process.env.AWS_DEFAULT_REGION;
    else process.env.AWS_DEFAULT_REGION = priorAwsDefaultRegion;
  }
});
