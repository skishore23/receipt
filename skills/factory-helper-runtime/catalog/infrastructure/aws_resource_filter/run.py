#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, queryable_ec2_regions, summarize_errors, write_json_artifact


RESOURCE_COMMANDS: dict[tuple[str, str], dict[str, Any]] = {
    ("ec2", "instances"): {"command": ["ec2", "describe-instances"], "region_scoped": True},
    ("ec2", "volumes"): {"command": ["ec2", "describe-volumes"], "region_scoped": True},
    ("s3", "buckets"): {"command": ["s3api", "list-buckets"], "region_scoped": False},
    ("rds", "db-instances"): {"command": ["rds", "describe-db-instances"], "region_scoped": True},
    ("lambda", "functions"): {"command": ["lambda", "list-functions"], "region_scoped": True},
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Filter AWS resources with an AWS CLI query")
    parser.add_argument("--service", required=True)
    parser.add_argument("--resource", required=True)
    parser.add_argument("--query", required=True)
    parser.add_argument("--profile")
    parser.add_argument("--region")
    parser.add_argument("--regions")
    parser.add_argument("--all-regions", action="store_true")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    spec = RESOURCE_COMMANDS.get((args.service, args.resource))
    if spec is None:
        emit_result(build_result(
            "error",
            f"Unsupported filter target: {args.service}/{args.resource}",
            {},
            errors=[f"Supported targets: {', '.join(f'{service}/{resource}' for service, resource in RESOURCE_COMMANDS)}"],
        ))
        return 1

    if spec["region_scoped"]:
        if args.regions:
            regions = [item.strip() for item in args.regions.split(",") if item.strip()]
        elif args.all_regions:
            try:
                regions = queryable_ec2_regions(args.profile)
            except AwsCliError as error:
                emit_result(build_result("error", "Unable to resolve queryable regions.", {}, errors=[summarize_errors(error)]))
                return 1
        else:
            regions = [args.region] if args.region else []
        if not regions:
            emit_result(build_result("error", "This filter target requires region scope.", {}, errors=["No region scope was provided."]))
            return 1
    else:
        regions = [args.region] if args.region else []

    results: dict[str, Any] = {}
    artifacts = []
    try:
        targets = regions or [None]
        for region in targets:
            raw = aws_cli_json(spec["command"] + ["--query", args.query], profile=args.profile, region=region)
            results[region or "global"] = raw
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            f"Unable to run the AWS CLI query for {args.service}/{args.resource}.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    data = {
        "service": args.service,
        "resource": args.resource,
        "query": args.query,
        "resultsByRegion": results,
    }
    artifact = write_json_artifact(
        args.output_dir,
        f"aws_resource_filter_{args.service}_{args.resource}.json",
        data,
        label=f"{args.service}/{args.resource} filtered results",
    )
    if artifact:
        artifacts.append(artifact)
    summary = f"Ran a filtered AWS CLI query for {args.service}/{args.resource} across {len(results)} scope target(s)."
    emit_result(build_result("ok", summary, data, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
