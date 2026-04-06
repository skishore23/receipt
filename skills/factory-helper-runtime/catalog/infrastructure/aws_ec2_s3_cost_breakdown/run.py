#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
from pathlib import Path
import sys
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, summarize_errors, write_json_artifact


EC2_SERVICE_HINTS = (
    "ec2 -",
    "amazon elastic compute cloud",
)

S3_SERVICE_HINTS = (
    "simple storage service",
    "amazon s3",
)


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def last_completed_month() -> tuple[str, str]:
    today = utc_today()
    first_of_current = date(today.year, today.month, 1)
    if first_of_current.month == 1:
        start = date(first_of_current.year - 1, 12, 1)
    else:
        start = date(first_of_current.year, first_of_current.month - 1, 1)
    end = first_of_current
    return start.isoformat(), end.isoformat()


def parse_cost(amount: Any) -> float | None:
    try:
        return float(amount)
    except (TypeError, ValueError):
        return None


def service_matches(name: str, hints: tuple[str, ...]) -> bool:
    text = name.strip().lower()
    return any(hint in text for hint in hints)


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare EC2 and S3 cost for a billing period")
    parser.add_argument("--profile")
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    start = args.start
    end = args.end
    if bool(start) ^ bool(end):
        emit_result(build_result(
            "error",
            "Both --start and --end must be provided together.",
            {},
            errors=["Use ISO dates like 2025-01-01 and 2025-02-01."],
        ))
        return 1
    if not start and not end:
        start, end = last_completed_month()

    try:
        identity = aws_cli_json(["sts", "get-caller-identity"], profile=args.profile)
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            "Unable to determine the active AWS caller identity.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    try:
        payload = aws_cli_json(
            [
                "ce",
                "get-cost-and-usage",
                "--time-period",
                f"Start={start},End={end}",
                "--granularity",
                "MONTHLY",
                "--metrics",
                "UnblendedCost",
                "--group-by",
                "Type=DIMENSION,Key=SERVICE",
            ],
            profile=args.profile,
        )
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            "Unable to query Cost Explorer for EC2 and S3 cost.",
            {"callerIdentity": identity, "period": {"start": start, "end": end}},
            errors=[summarize_errors(error)],
        ))
        return 1

    groups = []
    for bucket in payload.get("ResultsByTime", []) if isinstance(payload, dict) else []:
        if not isinstance(bucket, dict):
            continue
        period = bucket.get("TimePeriod") or {}
        period_start = str(period.get("Start", "")).strip()
        period_end = str(period.get("End", "")).strip()
        for group in bucket.get("Groups", []) or []:
            if not isinstance(group, dict):
                continue
            keys = group.get("Keys", []) or []
            service = str(keys[0]).strip() if keys else ""
            amount = (((group.get("Metrics") or {}).get("UnblendedCost") or {}).get("Amount"))
            cost = parse_cost(amount)
            if not service or cost is None:
                continue
            groups.append({
                "service": service,
                "cost": round(cost, 10),
                "period": {"start": period_start, "end": period_end},
            })

    ec2_groups = [item for item in groups if service_matches(item["service"], EC2_SERVICE_HINTS)]
    s3_groups = [item for item in groups if service_matches(item["service"], S3_SERVICE_HINTS)]

    ec2_total = round(sum(item["cost"] for item in ec2_groups), 10)
    s3_total = round(sum(item["cost"] for item in s3_groups), 10)
    overall_total = round(sum(item["cost"] for item in groups), 10)

    ranked_services = sorted(groups, key=lambda item: item["cost"], reverse=True)
    data = {
        "profile": args.profile,
        "callerIdentity": identity,
        "period": {"start": start, "end": end},
        "currency": "USD",
        "serviceGroups": ranked_services,
        "breakdown": {
            "ec2": {
                "matchedServices": ec2_groups,
                "total": ec2_total,
            },
            "s3": {
                "matchedServices": s3_groups,
                "total": s3_total,
            },
        },
        "overallTotal": overall_total,
        "comparison": {
            "delta": round(ec2_total - s3_total, 10),
            "ratio": round(ec2_total / s3_total, 10) if s3_total > 0 else None,
        },
        "notes": [
            "Cost Explorer reports unblended cost grouped by service for the selected period.",
            "Service matching is string-based and may include more than one service row for each label if AWS splits the billing line items.",
        ],
    }

    artifacts = []
    artifact = write_json_artifact(
        args.output_dir,
        "aws_ec2_s3_cost_breakdown.json",
        data,
        label="EC2 vs S3 cost breakdown",
        summary=f"Compared EC2 (${ec2_total:.2f}) and S3 (${s3_total:.2f}) unblended cost for {start} to {end}.",
    )
    if artifact:
        artifacts.append(artifact)

    summary = f"Compared EC2 (${ec2_total:.2f}) and S3 (${s3_total:.2f}) unblended cost for {start} to {end}."
    emit_result(build_result("ok", summary, data, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
