import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("aws resource inventory helper aggregates ECS services across clusters per region", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-aws-resource-inventory-"));
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const awsStubPath = path.join(binDir, "aws");
  const stub = [
    "#!/bin/sh",
    "set -eu",
    "cluster=''",
    "prev=''",
    "command=''",
    "resource=''",
    "for arg in \"$@\"; do",
    "  if [ \"$prev\" = '--cluster' ]; then",
    "    cluster=\"$arg\"",
    "  elif [ -z \"$command\" ] && [ \"$arg\" != '--profile' ] && [ \"$arg\" != '--region' ] && [ \"$arg\" != '--output' ] && [ \"$prev\" != '--profile' ] && [ \"$prev\" != '--region' ] && [ \"$prev\" != '--output' ]; then",
    "    command=\"$arg\"",
    "  elif [ -n \"$command\" ] && [ -z \"$resource\" ] && [ \"$arg\" != '--profile' ] && [ \"$arg\" != '--region' ] && [ \"$arg\" != '--output' ] && [ \"$prev\" != '--profile' ] && [ \"$prev\" != '--region' ] && [ \"$prev\" != '--output' ]; then",
    "    resource=\"$arg\"",
    "  fi",
    "  prev=\"$arg\"",
    "done",
    "case \"$command $resource ${cluster-}\" in",
    "  'ecs list-clusters ')",
    "    printf '{\"clusterArns\":[\"arn:aws:ecs:us-east-1:123456789012:cluster/alpha\",\"arn:aws:ecs:us-east-1:123456789012:cluster/bravo\"]}\\n'",
    "    ;;",
    "  'ecs list-services arn:aws:ecs:us-east-1:123456789012:cluster/alpha')",
    "    printf '{\"serviceArns\":[\"arn:aws:ecs:us-east-1:123456789012:service/alpha/api\"]}\\n'",
    "    ;;",
    "  'ecs list-services arn:aws:ecs:us-east-1:123456789012:cluster/bravo')",
    "    printf '{\"serviceArns\":[\"arn:aws:ecs:us-east-1:123456789012:service/bravo/web\",\"arn:aws:ecs:us-east-1:123456789012:service/bravo/worker\"]}\\n'",
    "    ;;",
    "  *)",
    "    echo \"unexpected aws args: $*\" >&2",
    "    exit 1",
    "    ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(awsStubPath, stub, "utf-8");
  await fs.chmod(awsStubPath, 0o755);

  const helperPath = path.join(
    process.cwd(),
    "skills",
    "factory-helper-runtime",
    "catalog",
    "infrastructure",
    "aws_resource_inventory",
    "run.py",
  );
  const { stdout } = await execFileAsync(
    "python3",
    [
      helperPath,
      "--service", "ecs",
      "--resource", "services",
      "--regions", "us-east-1",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf-8",
    },
  );
  const parsed = JSON.parse(stdout) as {
    readonly status: string;
    readonly data: {
      readonly totalCount: number;
      readonly resultsByRegion: Record<string, {
        readonly count: number;
        readonly clusters: string[];
        readonly clusterItemCounts: Record<string, number>;
      }>;
    };
  };

  expect(parsed.status).toBe("ok");
  expect(parsed.data.totalCount).toBe(3);
  expect(parsed.data.resultsByRegion["us-east-1"]).toEqual({
    count: 3,
    clusters: [
      "arn:aws:ecs:us-east-1:123456789012:cluster/alpha",
      "arn:aws:ecs:us-east-1:123456789012:cluster/bravo",
    ],
    clusterItemCounts: {
      "arn:aws:ecs:us-east-1:123456789012:cluster/alpha": 1,
      "arn:aws:ecs:us-east-1:123456789012:cluster/bravo": 2,
    },
    items: [
      "arn:aws:ecs:us-east-1:123456789012:service/alpha/api",
      "arn:aws:ecs:us-east-1:123456789012:service/bravo/web",
      "arn:aws:ecs:us-east-1:123456789012:service/bravo/worker",
    ],
    warnings: [],
  });
});

test("aws resource inventory helper supports RDS cluster inventory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-aws-resource-inventory-rds-"));
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const awsStubPath = path.join(binDir, "aws");
  const stub = [
    "#!/bin/sh",
    "set -eu",
    "prev=''",
    "command=''",
    "resource=''",
    "for arg in \"$@\"; do",
    "  if [ -z \"$command\" ] && [ \"$arg\" != '--profile' ] && [ \"$arg\" != '--region' ] && [ \"$arg\" != '--output' ] && [ \"$prev\" != '--profile' ] && [ \"$prev\" != '--region' ] && [ \"$prev\" != '--output' ]; then",
    "    command=\"$arg\"",
    "  elif [ -n \"$command\" ] && [ -z \"$resource\" ] && [ \"$arg\" != '--profile' ] && [ \"$arg\" != '--region' ] && [ \"$arg\" != '--output' ] && [ \"$prev\" != '--profile' ] && [ \"$prev\" != '--region' ] && [ \"$prev\" != '--output' ]; then",
    "    resource=\"$arg\"",
    "  fi",
    "  prev=\"$arg\"",
    "done",
    "case \"$command $resource\" in",
    "  'rds describe-db-clusters')",
    "    printf '{\"DBClusters\":[{\"DBClusterIdentifier\":\"aurora-main\",\"Engine\":\"aurora-postgresql\"}]}'",
    "    ;;",
    "  *)",
    "    echo \"unexpected aws args: $*\" >&2",
    "    exit 1",
    "    ;;",
    "esac",
  ].join("\n");
  await fs.writeFile(awsStubPath, stub, "utf-8");
  await fs.chmod(awsStubPath, 0o755);

  const helperPath = path.join(
    process.cwd(),
    "skills",
    "factory-helper-runtime",
    "catalog",
    "infrastructure",
    "aws_resource_inventory",
    "run.py",
  );
  const { stdout } = await execFileAsync(
    "python3",
    [
      helperPath,
      "--service", "rds",
      "--resource", "db-clusters",
      "--regions", "us-east-1",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf-8",
    },
  );
  const parsed = JSON.parse(stdout) as {
    readonly status: string;
    readonly data: {
      readonly totalCount: number;
      readonly resultsByRegion: Record<string, {
        readonly count: number;
        readonly items: Array<{ readonly DBClusterIdentifier: string }>;
      }>;
    };
  };

  expect(parsed.status).toBe("ok");
  expect(parsed.data.totalCount).toBe(1);
  expect(parsed.data.resultsByRegion["us-east-1"]).toEqual({
    count: 1,
    items: [{ DBClusterIdentifier: "aurora-main", Engine: "aurora-postgresql" }],
  });
});
