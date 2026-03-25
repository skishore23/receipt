#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, queryable_ec2_regions, summarize_errors, write_json_artifact


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize CloudWatch alarms")
    parser.add_argument("--profile")
    parser.add_argument("--region")
    parser.add_argument("--regions")
    parser.add_argument("--all-regions", action="store_true")
    parser.add_argument("--state-value")
    parser.add_argument("--name-prefix")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    if args.regions:
        regions = [item.strip() for item in args.regions.split(",") if item.strip()]
    elif args.all_regions:
        try:
            regions = queryable_ec2_regions(args.profile)
        except AwsCliError as error:
            emit_result(build_result("error", "Unable to resolve regions for CloudWatch alarms.", {}, errors=[summarize_errors(error)]))
            return 1
    else:
        regions = [args.region] if args.region else []
    if not regions:
        emit_result(build_result("error", "CloudWatch alarm summary requires region scope.", {}, errors=["No region scope was provided."]))
        return 1

    by_region: dict[str, Any] = {}
    overall_states: Counter[str] = Counter()
    try:
        for region in regions:
            command = ["cloudwatch", "describe-alarms"]
            if args.state_value:
                command.extend(["--state-value", args.state_value])
            if args.name_prefix:
                command.extend(["--alarm-name-prefix", args.name_prefix])
            alarms = aws_cli_json(command, profile=args.profile, region=region)
            metric_alarms = alarms.get("MetricAlarms", []) if isinstance(alarms, dict) else []
            composite_alarms = alarms.get("CompositeAlarms", []) if isinstance(alarms, dict) else []
            state_counts = Counter(
                str(alarm.get("StateValue", "")).strip()
                for alarm in [*metric_alarms, *composite_alarms]
                if isinstance(alarm, dict)
            )
            overall_states.update(state_counts)
            by_region[region] = {
                "metricAlarmCount": len(metric_alarms),
                "compositeAlarmCount": len(composite_alarms),
                "stateCounts": dict(state_counts),
            }
    except AwsCliError as error:
        emit_result(build_result("error", "Unable to summarize CloudWatch alarms.", {}, errors=[summarize_errors(error)]))
        return 1

    data = {
        "regions": regions,
        "resultsByRegion": by_region,
        "stateCounts": dict(overall_states),
    }
    artifacts = []
    artifact = write_json_artifact(args.output_dir, "aws_alarm_summary.json", data, label="CloudWatch alarm summary")
    if artifact:
        artifacts.append(artifact)
    summary = f"Summarized CloudWatch alarms across {len(regions)} region(s)."
    emit_result(build_result("ok", summary, data, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
