#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, queryable_ec2_regions, summarize_errors, write_json_artifact


RESOURCE_SPECS: dict[tuple[str, str], dict[str, Any]] = {
    ("ec2", "instances"): {
        "command": ["ec2", "describe-instances"],
        "region_scoped": True,
        "extract": lambda data: [
            instance
            for reservation in data.get("Reservations", [])
            if isinstance(reservation, dict)
            for instance in reservation.get("Instances", [])
            if isinstance(instance, dict)
        ],
    },
    ("ec2", "volumes"): {
        "command": ["ec2", "describe-volumes"],
        "region_scoped": True,
        "extract": lambda data: data.get("Volumes", []),
    },
    ("s3", "buckets"): {
        "command": ["s3api", "list-buckets"],
        "region_scoped": False,
        "extract": lambda data: data.get("Buckets", []),
    },
    ("rds", "db-instances"): {
        "command": ["rds", "describe-db-instances"],
        "region_scoped": True,
        "extract": lambda data: data.get("DBInstances", []),
    },
    ("lambda", "functions"): {
        "command": ["lambda", "list-functions"],
        "region_scoped": True,
        "extract": lambda data: data.get("Functions", []),
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Inventory AWS resources")
    parser.add_argument("--service", required=True)
    parser.add_argument("--resource", required=True)
    parser.add_argument("--profile")
    parser.add_argument("--region")
    parser.add_argument("--regions")
    parser.add_argument("--all-regions", action="store_true")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    spec = RESOURCE_SPECS.get((args.service, args.resource))
    if spec is None:
        emit_result(build_result(
            "error",
            f"Unsupported inventory target: {args.service}/{args.resource}",
            {},
            errors=[f"Supported targets: {', '.join(f'{service}/{resource}' for service, resource in RESOURCE_SPECS)}"],
        ))
        return 1

    if spec["region_scoped"]:
        if args.regions:
            regions = [item.strip() for item in args.regions.split(",") if item.strip()]
        elif args.all_regions:
            try:
                regions = queryable_ec2_regions(args.profile)
            except AwsCliError as error:
                emit_result(build_result(
                    "error",
                    "Unable to resolve queryable regions for inventory.",
                    {},
                    errors=[summarize_errors(error)],
                ))
                return 1
        else:
            regions = [args.region] if args.region else []
        if not regions:
            emit_result(build_result(
                "error",
                f"{args.service}/{args.resource} requires --region, --regions, or --all-regions",
                {},
                errors=["No region scope was provided."],
            ))
            return 1
    else:
        regions = [args.region] if args.region else []

    by_region: dict[str, Any] = {}
    artifacts = []
    try:
        targets = regions or [None]
        for region in targets:
            raw = aws_cli_json(spec["command"], profile=args.profile, region=region)
            items = spec["extract"](raw)
            key = region or "global"
            by_region[key] = {
                "count": len(items) if isinstance(items, list) else None,
                "items": items,
            }
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            f"Unable to inventory {args.service}/{args.resource}.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    total_count = sum(
        value.get("count", 0)
        for value in by_region.values()
        if isinstance(value, dict) and isinstance(value.get("count"), int)
    )
    data = {
        "service": args.service,
        "resource": args.resource,
        "regions": list(by_region.keys()),
        "resultsByRegion": by_region,
        "totalCount": total_count,
    }
    artifact = write_json_artifact(
        args.output_dir,
        f"aws_resource_inventory_{args.service}_{args.resource}.json",
        data,
        label=f"{args.service}/{args.resource} inventory",
        summary=f"Captured {total_count} resources.",
    )
    if artifact:
        artifacts.append(artifact)
    summary = f"Captured {total_count} {args.service}/{args.resource} resources across {len(by_region)} scope target(s)."
    emit_result(build_result("ok", summary, data, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
