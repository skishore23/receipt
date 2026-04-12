import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

const helperPath = path.resolve("skills/factory-helper-runtime/catalog/infrastructure/aws_internet_exposure_inventory/run.py");

test("aws internet exposure inventory helper summarizes public surfaces from stubbed aws responses", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aws-exposure-helper-"));
  const binDir = path.join(tempRoot, "bin");
  const outDir = path.join(tempRoot, "out");
  await mkdir(binDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  const stubAws = path.join(binDir, "aws");
  await writeFile(stubAws, `#!/usr/bin/env python3
import json
import sys

raw_args = sys.argv[1:]
args = []
i = 0
while i < len(raw_args):
    if raw_args[i] in {"--profile", "--region", "--output"} and i + 1 < len(raw_args):
        i += 2
        continue
    args.append(raw_args[i])
    i += 1

def out(payload):
    print(json.dumps(payload))

if args[:2] == ["sts", "get-caller-identity"]:
    out({"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/test","UserId":"U123"})
elif args[:3] == ["ec2", "describe-regions", "--all-regions"]:
    out([{"RegionName":"us-east-1","OptInStatus":"opt-in-not-required"}])
elif args[:2] == ["s3api", "list-buckets"]:
    out({"Buckets":[{"Name":"public-bucket"},{"Name":"private-bucket"}]})
elif args[:2] == ["s3api", "get-bucket-policy-status"]:
    bucket = args[args.index("--bucket")+1]
    out({"PolicyStatus":{"IsPublic": bucket == "public-bucket"}})
elif args[:2] == ["s3api", "get-bucket-acl"]:
    bucket = args[args.index("--bucket")+1]
    grants = [{"Grantee":{"URI":"http://acs.amazonaws.com/groups/global/AllUsers"}}] if bucket == "public-bucket" else []
    out({"Grants": grants})
elif args[:2] == ["s3api", "get-public-access-block"]:
    bucket = args[args.index("--bucket")+1]
    if bucket == "private-bucket":
        print("NoSuchPublicAccessBlockConfiguration", file=sys.stderr)
        sys.exit(255)
    out({"PublicAccessBlockConfiguration":{"BlockPublicAcls":False}})
elif args[:2] == ["ec2", "describe-network-interfaces"]:
    out([{"networkInterfaceId":"eni-1","description":"public","publicIp":"1.2.3.4","privateIp":"10.0.0.5","instanceId":"i-1","subnetId":"subnet-1","securityGroups":["sg-1"]}])
elif args[:2] == ["ec2", "describe-security-groups"]:
    out({"SecurityGroups":[{"GroupId":"sg-1","GroupName":"open","VpcId":"vpc-1","IpPermissions":[{"IpProtocol":"tcp","FromPort":443,"ToPort":443,"IpRanges":[{"CidrIp":"0.0.0.0/0"}],"Ipv6Ranges":[]}]}]})
elif args[:2] == ["elbv2", "describe-load-balancers"]:
    out({"LoadBalancers":[{"LoadBalancerName":"public-alb","LoadBalancerArn":"arn:alb","Type":"application","DNSName":"alb.example.com","Scheme":"internet-facing","State":{"Code":"active"},"VpcId":"vpc-1"}]})
elif args[:2] == ["elb", "describe-load-balancers"]:
    out({"LoadBalancerDescriptions":[{"LoadBalancerName":"classic-public","DNSName":"classic.example.com","Scheme":"internet-facing","Instances":[],"SecurityGroups":["sg-1"],"Subnets":["subnet-1"]}]})
elif args[:2] == ["cloudfront", "list-distributions"]:
    out({"DistributionList":{"Items":[{"Id":"dist-1","ARN":"arn:cloudfront::dist-1","DomainName":"d111.cloudfront.net","Enabled":True,"Status":"Deployed","Aliases":{"Items":["cdn.example.com"]},"Origins":{"Items":[{"Id":"origin-1"}]}}]}})
elif args[:2] == ["apigateway", "get-rest-apis"]:
    out({"items":[{"id":"api-public","name":"public-rest","endpointConfiguration":{"types":["EDGE"]}},{"id":"api-private","name":"private-rest","endpointConfiguration":{"types":["PRIVATE"]}}]})
elif args[:2] == ["apigatewayv2", "get-apis"]:
    out({"Items":[{"ApiId":"http-public","Name":"public-http","ProtocolType":"HTTP","ApiEndpoint":"https://http-public.execute-api.us-east-1.amazonaws.com","DisableExecuteApiEndpoint":False},{"ApiId":"http-disabled","Name":"disabled-http","ProtocolType":"HTTP","ApiEndpoint":"https://http-disabled.execute-api.us-east-1.amazonaws.com","DisableExecuteApiEndpoint":True}]})
elif args[:2] == ["lambda", "list-functions"]:
    out({"Functions":[{"FunctionName":"public-url-fn","FunctionArn":"arn:aws:lambda:us-east-1:123456789012:function:public-url-fn"},{"FunctionName":"public-policy-fn","FunctionArn":"arn:aws:lambda:us-east-1:123456789012:function:public-policy-fn"},{"FunctionName":"private-fn","FunctionArn":"arn:aws:lambda:us-east-1:123456789012:function:private-fn"}]})
elif args[:2] == ["lambda", "get-function-url-config"]:
    function_name = args[args.index("--function-name")+1]
    if function_name == "public-url-fn":
        out({"AuthType":"NONE","FunctionUrl":"https://lambda-url.example.com"})
    else:
        print("ResourceNotFoundException", file=sys.stderr)
        sys.exit(255)
elif args[:2] == ["lambda", "get-policy"]:
    function_name = args[args.index("--function-name")+1]
    if function_name == "public-policy-fn":
        out({"Policy": json.dumps({"Statement":[{"Sid":"publicInvoke","Principal":"*","Action":"lambda:InvokeFunction"}]})})
    else:
        print("ResourceNotFoundException", file=sys.stderr)
        sys.exit(255)
elif args[:2] == ["rds", "describe-db-instances"]:
    out({"DBInstances":[{"DBInstanceIdentifier":"db-public","Engine":"postgres","DBInstanceStatus":"available","PubliclyAccessible":True,"Endpoint":{"Address":"db.example.com","Port":5432}}]})
else:
    print("unexpected args: " + " ".join(args), file=sys.stderr)
    sys.exit(2)
`, "utf-8");
  await chmod(stubAws, 0o755);

  const proc = Bun.spawn([
    "python3",
    helperPath,
    "--all-regions",
    "--output-dir",
    outDir,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const result = JSON.parse(stdout) as {
    status: string;
    data: {
      counts: Record<string, number>;
      findings: Record<string, unknown[]>;
    };
    artifacts: Array<{ path: string }>;
  };
  expect(result.status).toBe("ok");
  expect(result.data.counts).toMatchObject({
    cloudFrontDistributions: 1,
    publicApiGatewayRestApis: 1,
    publicApiGatewayV2Apis: 1,
    publicEnis: 1,
    internetFacingLoadBalancers: 1,
    internetFacingClassicElbs: 1,
    openSecurityGroups: 1,
    publicLambdaUrls: 1,
    publicLambdaPolicies: 1,
    publicRdsInstances: 1,
    publicS3Buckets: 1,
  });
  expect(result.data.findings.cloudFrontDistributions).toHaveLength(1);
  expect(result.data.findings.publicApiGatewayRestApis).toHaveLength(1);
  expect(result.data.findings.publicApiGatewayV2Apis).toHaveLength(1);
  expect(result.data.findings.publicLambdaUrls).toHaveLength(1);
  expect(result.data.findings.publicLambdaPolicies).toHaveLength(1);
  expect(result.artifacts.some((artifact) => artifact.path.endsWith("aws_internet_exposure_inventory.json"))).toBe(true);
  const markdown = await readFile(path.join(outDir, "aws_internet_exposure_inventory.md"), "utf-8");
  expect(markdown).toContain("CloudFront distributions: 1");
  expect(markdown).toContain("Public REST APIs: 1");
  expect(markdown).toContain("Public ENIs: 1");
  expect(markdown).toContain("Public Lambda URLs: 1");
  expect(markdown).toContain("Public S3 buckets: 1");
  await rm(tempRoot, { recursive: true, force: true });
});
