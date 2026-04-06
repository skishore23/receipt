#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, summarize_errors, write_json_artifact


SERVICE_NAME = "Amazon Elastic Compute Cloud - Compute"
BREAKDOWN_DIMENSIONS = ("USAGE_TYPE", "OPERATION", "REGION", "LINKED_ACCOUNT")


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def iso_date(value: date) -> str:
    return value.isoformat()


def next_day(value: date) -> date:
    return value + timedelta(days=1)


def parse_amount(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def build_service_filter() -> dict[str, Any]:
    return {
        "Dimensions": {
            "Key": "SERVICE",
            "Values": [SERVICE_NAME],
        }
    }


def ce_costs(
    profile: str | None,
    *,
    start: date,
    end: date,
    group_by: list[str] | None = None,
    filter_obj: dict[str, Any] | None = None,
) -> Any:
    args = [
        "ce",
        "get-cost-and-usage",
        "--time-period",
        f"Start={iso_date(start)},End={iso_date(end)}",
        "--granularity",
        "DAILY",
        "--metrics",
        "UnblendedCost",
    ]
    for key in group_by or []:
        args.extend(["--group-by", f"Type=DIMENSION,Key={key}"])
    if filter_obj is not None:
        args.extend(["--filter", json.dumps(filter_obj, separators=(",", ":"))])
    return aws_cli_json(args, profile=profile)


def daily_series(payload: Any, start: date, end: date) -> list[dict[str, Any]]:
    by_day: dict[str, float] = {}
    for bucket in payload.get("ResultsByTime", []) if isinstance(payload, dict) else []:
        if not isinstance(bucket, dict):
            continue
        period = bucket.get("TimePeriod") or {}
        day = str(period.get("Start", "")).strip()
        if not day:
            continue
        amount = (((bucket.get("Total") or {}).get("UnblendedCost") or {}).get("Amount"))
        by_day[day] = parse_amount(amount)

    series: list[dict[str, Any]] = []
    current = start
    while current < end:
        key = iso_date(current)
        series.append({"day": key, "cost": round(by_day.get(key, 0.0), 10)})
        current = next_day(current)
    return series


def total_cost(series: list[dict[str, Any]]) -> float:
    return round(sum(float(item.get("cost", 0.0)) for item in series), 10)


def detect_spikes(series: list[dict[str, Any]], threshold: float = 2.0) -> list[dict[str, Any]]:
    spikes: list[dict[str, Any]] = []
    for idx in range(7, len(series)):
        current = float(series[idx]["cost"])
        window = [float(item["cost"]) for item in series[idx - 7 : idx]]
        baseline = sum(window) / 7.0
        previous_day = float(series[idx - 1]["cost"])
        if baseline <= 0 and current > 0:
            spikes.append(
                {
                    "day": series[idx]["day"],
                    "cost": round(current, 10),
                    "prior7DayAverage": round(baseline, 10),
                    "factor": None,
                    "priorDayCost": round(previous_day, 10),
                    "dayOverDayDelta": round(current - previous_day, 10),
                    "reason": "first positive day after a zero baseline",
                }
            )
            continue
        if baseline > 0 and current >= baseline * threshold:
            spikes.append(
                {
                    "day": series[idx]["day"],
                    "cost": round(current, 10),
                    "prior7DayAverage": round(baseline, 10),
                    "factor": round(current / baseline, 2),
                    "priorDayCost": round(previous_day, 10),
                    "dayOverDayDelta": round(current - previous_day, 10),
                    "reason": f"at least {threshold:.1f}x the previous 7-day average",
                }
            )
    return spikes


def notable_jumps(series: list[dict[str, Any]], limit: int = 5) -> list[dict[str, Any]]:
    jumps: list[dict[str, Any]] = []
    for idx in range(1, len(series)):
        current = float(series[idx]["cost"])
        previous = float(series[idx - 1]["cost"])
        delta = current - previous
        if delta <= 0:
            continue
        pct = None
        if previous > 0:
            pct = round((delta / previous) * 100.0, 1)
        jumps.append(
            {
                "day": series[idx]["day"],
                "cost": round(current, 10),
                "priorDayCost": round(previous, 10),
                "dayOverDayDelta": round(delta, 10),
                "dayOverDayPct": pct,
            }
        )
    jumps.sort(key=lambda item: (item["dayOverDayDelta"], item["cost"]), reverse=True)
    return jumps[:limit]


def parse_grouped_costs(payload: Any) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    for bucket in payload.get("ResultsByTime", []) if isinstance(payload, dict) else []:
        if not isinstance(bucket, dict):
            continue
        day = str((bucket.get("TimePeriod") or {}).get("Start", "")).strip()
        if not day:
            continue
        for group in bucket.get("Groups", []) or []:
            if not isinstance(group, dict):
                continue
            keys = [str(value).strip() for value in group.get("Keys", []) or [] if str(value).strip()]
            if not keys:
                continue
            amount = parse_amount((((group.get("Metrics") or {}).get("UnblendedCost") or {}).get("Amount")))
            groups.append({"day": day, "keys": keys, "cost": round(amount, 10)})
    return groups


def top_groups(groups: list[dict[str, Any]], limit: int = 5) -> list[dict[str, Any]]:
    ranked: dict[tuple[str, ...], float] = defaultdict(float)
    for group in groups:
        ranked[tuple(group["keys"])] += float(group["cost"])
    output = [
        {"keys": list(keys), "cost": round(cost, 10)}
        for keys, cost in sorted(ranked.items(), key=lambda item: item[1], reverse=True)[:limit]
    ]
    return output


def breakdown_day(profile: str | None, day: str, filter_obj: dict[str, Any]) -> dict[str, Any]:
    start = date.fromisoformat(day)
    end = next_day(start)
    breakdown: dict[str, Any] = {}
    warnings: list[str] = []
    for dimension in BREAKDOWN_DIMENSIONS:
        try:
            payload = ce_costs(profile, start=start, end=end, group_by=[dimension], filter_obj=filter_obj)
        except AwsCliError as error:
            warnings.append(f"{dimension}: {summarize_errors(error)}")
            continue
        groups = parse_grouped_costs(payload)
        breakdown[dimension.lower()] = top_groups(groups, limit=5)
    if warnings:
        breakdown["warnings"] = warnings
    return breakdown


def day_series_lookup(series: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {item["day"]: item for item in series}


def main() -> int:
    parser = argparse.ArgumentParser(description="Investigate EC2 Compute cost spikes")
    parser.add_argument("--profile")
    parser.add_argument("--lookback-days", type=int, default=90)
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    if args.lookback_days <= 0:
        emit_result(
            build_result(
                "error",
                "--lookback-days must be positive.",
                {},
                errors=["Use a positive integer lookback window."],
            )
        )
        return 1

    today = utc_today()
    lookback_end = next_day(today)
    lookback_start = today - timedelta(days=args.lookback_days - 1)
    month_start = date(today.year, today.month, 1)
    mtd_end = lookback_end

    try:
        identity = aws_cli_json(["sts", "get-caller-identity"], profile=args.profile)
    except AwsCliError as error:
        emit_result(
            build_result(
                "error",
                "Unable to determine the active AWS caller identity.",
                {},
                errors=[summarize_errors(error)],
            )
        )
        return 1

    service_filter = build_service_filter()
    warnings: list[str] = []

    try:
        lookback_payload = ce_costs(args.profile, start=lookback_start, end=lookback_end, filter_obj=service_filter)
    except AwsCliError as error:
        emit_result(
            build_result(
                "error",
                "Unable to query Cost Explorer for EC2 Compute daily costs.",
                {"callerIdentity": identity, "window": {"start": iso_date(lookback_start), "end": iso_date(lookback_end)}},
                errors=[summarize_errors(error)],
            )
        )
        return 1

    try:
        mtd_payload = ce_costs(args.profile, start=month_start, end=mtd_end, filter_obj=service_filter)
    except AwsCliError as error:
        warnings.append(f"month-to-date query: {summarize_errors(error)}")
        mtd_payload = {}

    lookback_series = daily_series(lookback_payload, lookback_start, lookback_end)
    mtd_series = daily_series(mtd_payload, month_start, mtd_end) if mtd_payload else []

    lookback_total = total_cost(lookback_series)
    mtd_total = total_cost(mtd_series)

    spikes = detect_spikes(lookback_series, threshold=2.0)
    jumps = notable_jumps(lookback_series, limit=5)
    focus_days = spikes if spikes else jumps[:3]

    breakdowns: dict[str, Any] = {}
    for item in focus_days:
        day = str(item["day"])
        breakdowns[day] = breakdown_day(args.profile, day, service_filter)

    peak_day = max(lookback_series, key=lambda item: float(item["cost"])) if lookback_series else None
    peak_info = None
    if peak_day is not None:
        peak_index = next((idx for idx, item in enumerate(lookback_series) if item["day"] == peak_day["day"]), None)
        prior7 = [float(item["cost"]) for item in lookback_series[max(0, (peak_index or 0) - 7) : peak_index or 0]] if peak_index is not None else []
        prior7_avg = round(sum(prior7) / len(prior7), 10) if prior7 else None
        peak_info = {
            "day": peak_day["day"],
            "cost": round(float(peak_day["cost"]), 10),
            "prior7DayAverage": prior7_avg,
            "factor": round(float(peak_day["cost"]) / prior7_avg, 2) if prior7_avg and prior7_avg > 0 else None,
        }

    data = {
        "profile": args.profile,
        "callerIdentity": identity,
        "service": SERVICE_NAME,
        "lookbackDays": args.lookback_days,
        "windows": {
            "lookback": {"start": iso_date(lookback_start), "end": iso_date(lookback_end)},
            "monthToDate": {"start": iso_date(month_start), "end": iso_date(mtd_end)},
        },
        "currency": "USD",
        "dailySeries": lookback_series,
        "monthToDateSeries": mtd_series,
        "totals": {
            "lookback": round(lookback_total, 10),
            "monthToDate": round(mtd_total, 10),
        },
        "spikeDays": spikes,
        "notableJumps": jumps,
        "focusDays": [
            {
                **item,
                "breakdown": breakdowns.get(str(item["day"]), {}),
                "kind": "spike" if item in spikes else "notable-jump",
            }
            for item in focus_days
        ],
        "peakDay": peak_info,
        "notes": [
            "Spikes are identified when a day is at least 2x the previous 7-day moving average.",
            "Notable jumps are the largest positive day-over-day increases in the same window.",
            "Breakdowns are grouped independently by UsageType, Operation, Region, and LinkedAccount.",
        ],
    }
    if warnings:
        data["warnings"] = warnings

    summary_parts = [
        f"Analyzed EC2 Compute daily cost over {args.lookback_days} days and month-to-date.",
        f"Found {len(spikes)} 2x spike day(s)" if spikes else "Found no 2x spike days",
    ]
    if peak_info:
        summary_parts.append(f"Peak day was {peak_info['day']} at ${float(peak_info['cost']):.2f}")
    summary = "; ".join(summary_parts) + "."

    artifacts = []
    artifact = write_json_artifact(
        args.output_dir,
        "aws_ec2_compute_cost_spike.json",
        data,
        label="EC2 Compute cost spike analysis",
        summary=summary,
    )
    if artifact:
        artifacts.append(artifact)

    emit_result(build_result("ok", summary, data, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
