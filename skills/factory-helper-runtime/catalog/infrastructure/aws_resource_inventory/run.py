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
    ("ecs", "clusters"): {
        "command": ["ecs", "list-clusters"],
        "region_scoped": True,
        "extract": lambda data: data.get("clusterArns", []),
    },
    ("ecs", "tasks"): {
        "command": ["ecs", "list-tasks"],
        "region_scoped": True,
        "cluster_scoped": True,
        "extract": lambda data: data.get("taskArns", []),
    },
    ("ecs", "services"): {
        "command": ["ecs", "list-services"],
        "region_scoped": True,
        "cluster_scoped": True,
        "extract": lambda data: data.get("serviceArns", []),
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
    ("rds", "db-clusters"): {
        "command": ["rds", "describe-db-clusters"],
        "region_scoped": True,
        "extract": lambda data: data.get("DBClusters", []),
    },
    ("lambda", "functions"): {
        "command": ["lambda", "list-functions"],
        "region_scoped": True,
        "extract": lambda data: data.get("Functions", []),
    },
    ("eks", "clusters"): {
        "command": ["eks", "list-clusters"],
        "region_scoped": True,
        "extract": lambda data: data.get("clusters", []),
    },
}


def collect_cluster_scoped_items(spec: dict[str, Any], *, profile: str | None, region: str) -> dict[str, Any]:
    cluster_raw = aws_cli_json(["ecs", "list-clusters"], profile=profile, region=region)
    cluster_arns = [
        cluster
        for cluster in cluster_raw.get("clusterArns", [])
        if isinstance(cluster, str) and cluster.strip()
    ]
    cluster_item_counts: dict[str, int] = {}
    items: list[Any] = []
    warnings: list[str] = []
    for cluster_arn in cluster_arns:
        try:
            raw = aws_cli_json(spec["command"] + ["--cluster", cluster_arn], profile=profile, region=region)
        except AwsCliError as error:
            warnings.append(f"{cluster_arn}: {summarize_errors(error)}")
            continue
        extracted = spec["extract"](raw)
        if not isinstance(extracted, list):
            continue
        cluster_item_counts[cluster_arn] = len(extracted)
        items.extend(extracted)
    return {
        "count": len(items),
        "items": items,
        "clusters": cluster_arns,
        "clusterItemCounts": cluster_item_counts,
        "warnings": warnings,
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
    warnings: list[str] = []
    try:
        targets = regions or [None]
        for region in targets:
            key = region or "global"
            if region and spec.get("cluster_scoped"):
                region_result = collect_cluster_scoped_items(spec, profile=args.profile, region=region)
                warnings.extend(f"{region}: {warning}" for warning in region_result.get("warnings", []))
                by_region[key] = region_result
                continue
            raw = aws_cli_json(spec["command"], profile=args.profile, region=region)
            items = spec["extract"](raw)
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
        "warnings": warnings,
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
