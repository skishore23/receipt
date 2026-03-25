#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, summarize_errors, write_json_artifact


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture AWS region scope")
    parser.add_argument("--profile")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    try:
        regions = aws_cli_json(
            [
                "ec2",
                "describe-regions",
                "--all-regions",
                "--query",
                "Regions[].{RegionName:RegionName,OptInStatus:OptInStatus,Endpoint:Endpoint}",
            ],
            profile=args.profile,
        )
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            "Unable to determine AWS region scope.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    queryable = []
    skipped = []
    for item in regions if isinstance(regions, list) else []:
        if not isinstance(item, dict):
            continue
        region_name = str(item.get("RegionName", "")).strip()
        opt_in_status = str(item.get("OptInStatus", "")).strip()
        entry = {
            "regionName": region_name,
            "optInStatus": opt_in_status,
            "endpoint": item.get("Endpoint"),
        }
        if opt_in_status in {"opted-in", "opt-in-not-required"}:
            queryable.append(entry)
        else:
            skipped.append(entry)

    data = {
        "queryableRegions": queryable,
        "skippedRegions": skipped,
    }
    artifacts = []
    artifact = write_json_artifact(args.output_dir, "aws_region_scope.json", data, label="AWS region scope")
    if artifact:
        artifacts.append(artifact)
    summary = f"Discovered {len(queryable)} queryable AWS regions and {len(skipped)} skipped regions."
    emit_result(build_result("ok", summary, data, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
