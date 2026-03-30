#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import sys
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, summarize_errors, write_json_artifact


S3_SERVICE_HINTS = (
    "amazon simple storage service",
    "amazon s3",
    "simple storage service",
    "s3",
)

REQUEST_KEYWORDS = (
    "request",
    "getobject",
    "putobject",
    "listobject",
    "headobject",
    "copyobject",
    "selectobject",
    "upload",
)


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def parse_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def as_iso(d: date) -> str:
    return d.isoformat()


def date_range(start: date, end_exclusive: date) -> list[date]:
    days: list[date] = []
    current = start
    while current < end_exclusive:
        days.append(current)
        current += timedelta(days=1)
    return days


def normalize(text: Any) -> str:
    return str(text or "").strip().lower()


def matches_s3_service(name: str) -> bool:
    lowered = normalize(name)
    return any(hint in lowered for hint in S3_SERVICE_HINTS)


def classify_usage_type(usage_type: str, operation: str = "") -> str:
    text = f"{usage_type} {operation}".lower()
    if "replic" in text:
        return "replication"
    if "timedstorage" in text or "bytehrs" in text or "storage" in text:
        return "storage class growth"
    if "datatransfer" in text or "data transfer" in text or "bytes" in text or "transfer" in text:
        return "data transfer"
    if any(keyword in text for keyword in REQUEST_KEYWORDS):
        return "requests"
    return "other"


def service_filter(service_names: list[str]) -> dict[str, Any] | None:
    unique = sorted({name for name in service_names if name})
    if not unique:
        return None
    return {"Dimensions": {"Key": "SERVICE", "Values": unique}}


def query_cost_and_usage(
    profile: str | None,
    *,
    start: date,
    end: date,
    group_by: list[str],
    service_names: list[str] | None = None,
) -> dict[str, Any]:
    args = [
        "ce",
        "get-cost-and-usage",
        "--time-period",
        f"Start={as_iso(start)},End={as_iso(end)}",
        "--granularity",
        "DAILY",
        "--metrics",
        "UnblendedCost",
    ]
    for key in group_by:
        args.extend(["--group-by", f"Type=DIMENSION,Key={key}"])
    if service_names:
        args.extend(["--filter", json.dumps(service_filter(service_names))])
    return aws_cli_json(args, profile=profile)


def extract_daily_series(
    payload: dict[str, Any],
    *,
    start: date,
    end: date,
    group_key_count: int,
) -> dict[date, dict[tuple[str, ...], float]]:
    series: dict[date, dict[tuple[str, ...], float]] = {day: {} for day in date_range(start, end)}
    for bucket in payload.get("ResultsByTime", []) or []:
        if not isinstance(bucket, dict):
            continue
        period = bucket.get("TimePeriod") or {}
        start_text = str(period.get("Start", "")).strip()
        if not start_text:
            continue
        try:
            day = date.fromisoformat(start_text)
        except ValueError:
            continue
        bucket_series = series.setdefault(day, {})
        for group in bucket.get("Groups", []) or []:
            if not isinstance(group, dict):
                continue
            keys = tuple(str(value).strip() for value in (group.get("Keys") or [])[:group_key_count])
            if len(keys) != group_key_count:
                continue
            amount = parse_float((((group.get("Metrics") or {}).get("UnblendedCost") or {}).get("Amount")))
            bucket_series[keys] = bucket_series.get(keys, 0.0) + amount
    return series


def sum_by_day(series: dict[date, dict[tuple[str, ...], float]], *, allowed_keys: set[tuple[str, ...]] | None = None) -> dict[date, float]:
    totals: dict[date, float] = {}
    for day, groups in series.items():
        total = 0.0
        for key, amount in groups.items():
            if allowed_keys is None or key in allowed_keys:
                total += amount
        totals[day] = total
    return totals


def build_daily_table(days: list[date], costs: dict[date, float]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, day in enumerate(days):
        cost = costs.get(day, 0.0)
        trailing_avg = None
        ratio = None
        threshold = None
        spike = False
        if index >= 7:
            trailing_values = [costs.get(days[i], 0.0) for i in range(index - 7, index)]
            trailing_avg = sum(trailing_values) / 7.0
            threshold = trailing_avg * 2.0
            if trailing_avg > 0:
                ratio = cost / trailing_avg
                spike = cost > threshold
            else:
                spike = cost > 0
        rows.append(
            {
                "date": as_iso(day),
                "cost": round(cost, 6),
                "trailing7DayAvg": round(trailing_avg, 6) if trailing_avg is not None else None,
                "spikeThreshold": round(threshold, 6) if threshold is not None else None,
                "ratioToTrailingAvg": round(ratio, 6) if ratio is not None else None,
                "isSpike": spike,
            }
        )
    return rows


def top_service_rows(service_series: dict[date, dict[tuple[str, ...], float]], service_names: list[str]) -> list[dict[str, Any]]:
    totals: dict[str, float] = defaultdict(float)
    for groups in service_series.values():
        for key, amount in groups.items():
            service = key[0]
            if service in service_names:
                totals[service] += amount
    ranked = sorted(totals.items(), key=lambda item: item[1], reverse=True)
    return [{"service": service, "cost": round(cost, 6)} for service, cost in ranked]


def collect_breakdown_rows(
    series: dict[date, dict[tuple[str, ...], float]],
    *,
    days: list[date],
    spike_day: date,
    labels: list[str],
    category_fn: Any | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    spike_index = days.index(spike_day)
    for key, _ in series.get(spike_day, {}).items():
        spike_cost = series.get(spike_day, {}).get(key, 0.0)
        trailing_values = [series.get(days[i], {}).get(key, 0.0) for i in range(max(0, spike_index - 7), spike_index)]
        if len(trailing_values) < 7:
            continue
        trailing_avg = sum(trailing_values) / 7.0
        delta = spike_cost - trailing_avg
        if trailing_avg > 0:
            ratio = spike_cost / trailing_avg
        else:
            ratio = None if spike_cost == 0 else float("inf")
        item = {
            "key": {label: value for label, value in zip(labels, key)},
            "spikeCost": round(spike_cost, 6),
            "trailing7DayAvg": round(trailing_avg, 6),
            "delta": round(delta, 6),
            "ratioToTrailingAvg": round(ratio, 6) if ratio not in (None, float("inf")) else None,
        }
        if category_fn is not None:
            item["category"] = category_fn(*key)
        rows.append(item)
    rows.sort(key=lambda row: row["delta"], reverse=True)
    return rows


def aggregate_categories(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    totals: dict[str, float] = defaultdict(float)
    for row in rows:
        category = row.get("category") or "other"
        totals[category] += parse_float(row.get("delta"))
    ranked = sorted(totals.items(), key=lambda item: item[1], reverse=True)
    return [{"category": category, "delta": round(delta, 6)} for category, delta in ranked if delta > 0]


def render_table(headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return "_No rows._"
    widths = [len(header) for header in headers]
    for row in rows:
        for index, value in enumerate(row):
            widths[index] = max(widths[index], len(value))
    header_line = "| " + " | ".join(header.ljust(widths[i]) for i, header in enumerate(headers)) + " |"
    separator = "| " + " | ".join("-" * widths[i] for i in range(len(headers))) + " |"
    body = ["| " + " | ".join(row[i].ljust(widths[i]) for i in range(len(headers))) + " |" for row in rows]
    return "\n".join([header_line, separator, *body])


def render_markdown_report(data: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("# S3 cost spike investigation")
    lines.append("")
    lines.append(f"- Account: `{data['callerIdentity'].get('Account', 'unknown')}`")
    lines.append(f"- Period: `{data['period']['start']}` to `{data['period']['end']}`")
    lines.append(f"- Lookback days: `{data['lookbackDays']}`")
    lines.append(f"- S3 service names: {', '.join(f'`{name}`' for name in data['s3ServiceNames']) or '_none_'}")
    lines.append("")

    spike_rows = []
    for spike in data["spikes"]:
        spike_rows.append(
            [
                spike["date"],
                f"{spike['cost']:.2f}",
                f"{spike['trailing7DayAvg']:.2f}",
                f"{spike['ratioToTrailingAvg']:.2f}" if spike["ratioToTrailingAvg"] is not None else "n/a",
                spike["driverCategory"] or "n/a",
            ]
        )
    lines.append("## Spike days")
    lines.append(render_table(["Date", "Cost", "Trailing 7-day avg", "Ratio", "Likely driver"], spike_rows))
    lines.append("")

    service_rows = [[row["service"], f"{row['cost']:.2f}"] for row in data["serviceRows"][:10]]
    lines.append("## S3 service rows")
    lines.append(render_table(["Service", "Cost"], service_rows))
    lines.append("")

    for spike in data["spikes"]:
        lines.append(f"## Breakdown for {spike['date']}")
        for section_key, section_title in (
            ("usageType", "Usage type"),
            ("operation", "Operation"),
            ("region", "Region"),
            ("linkedAccount", "Linked account"),
        ):
            rows = spike["breakdowns"].get(section_key, [])
            table_rows = []
            for row in rows[:10]:
                key = row["key"]
                if isinstance(key, dict):
                    label = ", ".join(f"{k}={v}" for k, v in key.items())
                else:
                    label = str(key)
                table_rows.append(
                    [
                        label,
                        f"{row['spikeCost']:.2f}",
                        f"{row['trailing7DayAvg']:.2f}",
                        f"{row['delta']:.2f}",
                        row.get("category") or "",
                    ]
                )
            lines.append(f"### {section_title}")
            lines.append(render_table(["Key", "Spike-day cost", "Trailing 7-day avg", "Delta", "Category"], table_rows))
            lines.append("")
        category_rows = [[row["category"], f"{row['delta']:.2f}"] for row in spike.get("driverCategories", [])]
        lines.append("### Driver categories")
        lines.append(render_table(["Category", "Delta"], category_rows))
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Investigate S3 cost spikes using Cost Explorer")
    parser.add_argument("--profile")
    parser.add_argument("--lookback-days", type=int, default=90)
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    if args.lookback_days < 8:
        emit_result(
            build_result(
                "error",
                "--lookback-days must be at least 8 to compute a trailing 7-day average.",
                {},
                errors=["Use 60 to 90 days for this investigation."],
            )
        )
        return 1

    end = utc_today()
    start = end - timedelta(days=args.lookback_days)

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

    errors: list[str] = []

    try:
        service_payload = query_cost_and_usage(
            args.profile,
            start=start,
            end=end,
            group_by=["SERVICE"],
        )
    except AwsCliError as error:
        emit_result(
            build_result(
                "error",
                "Unable to query Cost Explorer for S3 service costs.",
                {"callerIdentity": identity, "period": {"start": as_iso(start), "end": as_iso(end)}},
                errors=[summarize_errors(error)],
            )
        )
        return 1

    service_series = extract_daily_series(service_payload, start=start, end=end, group_key_count=1)
    all_service_names = sorted({key[0] for groups in service_series.values() for key in groups})
    s3_service_names = sorted([name for name in all_service_names if matches_s3_service(name)])

    if not s3_service_names:
        data = {
            "callerIdentity": identity,
            "lookbackDays": args.lookback_days,
            "period": {"start": as_iso(start), "end": as_iso(end)},
            "currency": "USD",
            "s3ServiceNames": [],
            "serviceRows": [],
            "dailySeries": [],
            "spikes": [],
            "notes": ["No S3-related service rows matched the helper's service-name heuristics."],
        }
        artifact = write_json_artifact(
            args.output_dir,
            "aws_s3_cost_spike.json",
            data,
            label="S3 cost spike investigation",
            summary="No S3-related service rows were matched from Cost Explorer service groups.",
        )
        artifacts = [artifact] if artifact else []
        if args.output_dir:
            markdown_path = Path(args.output_dir) / "aws_s3_cost_spike.md"
            markdown_path.write_text(render_markdown_report(data), encoding="utf-8")
            artifacts.append(
                {
                    "label": "S3 cost spike report",
                    "path": str(markdown_path),
                    "summary": "Markdown report for the S3 cost spike investigation.",
                }
            )
        emit_result(
            build_result(
                "warning",
                "No S3-related service rows were found in Cost Explorer for the selected period.",
                data,
                artifacts=artifacts,
                errors=errors,
            )
        )
        return 0

    s3_daily_totals = sum_by_day(service_series, allowed_keys={(name,) for name in s3_service_names})
    days = date_range(start, end)
    daily_rows = build_daily_table(days, s3_daily_totals)
    spike_days = [date.fromisoformat(row["date"]) for row in daily_rows if row["isSpike"]]

    spikes: list[dict[str, Any]] = []
    breakdown_errors: list[str] = []

    for spike_day in spike_days:
        window_start = spike_day - timedelta(days=7)
        window_end = spike_day + timedelta(days=1)

        breakdown_specs = [
            ("usageType", ["USAGE_TYPE"], ["UsageType"], classify_usage_type),
            ("operation", ["OPERATION"], ["Operation"], None),
            ("region", ["REGION"], ["Region"], None),
            ("linkedAccount", ["LINKED_ACCOUNT"], ["LinkedAccount"], None),
        ]
        breakdowns: dict[str, list[dict[str, Any]]] = {}

        for section_key, group_keys, labels, classifier in breakdown_specs:
            try:
                payload = query_cost_and_usage(
                    args.profile,
                    start=window_start,
                    end=window_end,
                    group_by=group_keys,
                    service_names=s3_service_names,
                )
            except AwsCliError as error:
                breakdown_errors.append(f"{section_key} breakdown on {as_iso(spike_day)}: {summarize_errors(error)}")
                breakdowns[section_key] = []
                continue

            series = extract_daily_series(payload, start=window_start, end=window_end, group_key_count=len(group_keys))
            rows = collect_breakdown_rows(
                series,
                days=date_range(window_start, window_end),
                spike_day=spike_day,
                labels=labels,
                category_fn=classifier,
            )
            breakdowns[section_key] = rows

        usage_rows = breakdowns.get("usageType", [])
        driver_categories = aggregate_categories(usage_rows)
        driver_category = driver_categories[0]["category"] if driver_categories else None

        spike_cost = s3_daily_totals.get(spike_day, 0.0)
        spike_row = next((row for row in daily_rows if row["date"] == as_iso(spike_day)), {})

        spikes.append(
            {
                "date": as_iso(spike_day),
                "cost": round(spike_cost, 6),
                "trailing7DayAvg": spike_row.get("trailing7DayAvg"),
                "ratioToTrailingAvg": spike_row.get("ratioToTrailingAvg"),
                "driverCategory": driver_category,
                "driverCategories": driver_categories,
                "breakdowns": breakdowns,
            }
        )

    data = {
        "callerIdentity": identity,
        "lookbackDays": args.lookback_days,
        "period": {"start": as_iso(start), "end": as_iso(end)},
        "currency": "USD",
        "s3ServiceNames": s3_service_names,
        "serviceRows": top_service_rows(service_series, s3_service_names),
        "dailySeries": daily_rows,
        "spikes": spikes,
        "notes": [
            "Daily S3 totals are derived from Cost Explorer service rows matching S3-related service names.",
            "A spike is flagged when daily cost is greater than 2x the trailing 7-day average.",
        ],
    }

    artifacts = []
    if args.output_dir:
        artifacts.append(
            write_json_artifact(
                args.output_dir,
                "aws_s3_cost_spike.json",
                data,
                label="S3 cost spike investigation",
                summary=f"Analyzed S3 daily cost from {as_iso(start)} to {as_iso(end)} and found {len(spikes)} spike day(s).",
            )
        )
        markdown_path = Path(args.output_dir) / "aws_s3_cost_spike.md"
        markdown_path.write_text(render_markdown_report(data), encoding="utf-8")
        artifacts.append(
            {
                "label": "S3 cost spike report",
                "path": str(markdown_path),
                "summary": "Markdown report with spike-day tables and breakdowns.",
            }
        )
    artifacts = [artifact for artifact in artifacts if artifact]

    status = "ok"
    if breakdown_errors:
        errors.extend(breakdown_errors)
        status = "warning"

    if spikes:
        largest_spike = max(spikes, key=lambda item: item["cost"])
        summary = (
            f"Found {len(spikes)} S3 spike day(s) over {as_iso(start)} to {as_iso(end)}; "
            f"largest spike by cost was on {largest_spike['date']}."
        )
    else:
        summary = f"No S3 day exceeded 2x its trailing 7-day average between {as_iso(start)} and {as_iso(end)}."

    emit_result(
        build_result(
            status,
            summary,
            data,
            artifacts=artifacts,
            errors=errors,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
