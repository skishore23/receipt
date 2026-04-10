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
    };
    artifacts: Array<{ path: string }>;
  };
  expect(result.status).toBe("ok");
  expect(result.data.counts).toMatchObject({
    publicEnis: 1,
    internetFacingLoadBalancers: 1,
    internetFacingClassicElbs: 1,
    openSecurityGroups: 1,
    publicRdsInstances: 1,
    publicS3Buckets: 1,
  });
  expect(result.artifacts.some((artifact) => artifact.path.endsWith("aws_internet_exposure_inventory.json"))).toBe(true);
  const markdown = await readFile(path.join(outDir, "aws_internet_exposure_inventory.md"), "utf-8");
  expect(markdown).toContain("Public ENIs: 1");
  expect(markdown).toContain("Public S3 buckets: 1");
  await rm(tempRoot, { recursive: true, force: true });
});
