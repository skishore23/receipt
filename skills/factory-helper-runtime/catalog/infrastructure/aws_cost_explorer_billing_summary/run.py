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


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def iso(value: date) -> str:
    return value.isoformat()


def month_start(value: date) -> date:
    return date(value.year, value.month, 1)


def previous_month_range(today: date) -> tuple[date, date]:
    current = month_start(today)
    if current.month == 1:
        start = date(current.year - 1, 12, 1)
    else:
        start = date(current.year, current.month - 1, 1)
    return start, current


def parse_amount(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def ce_query(
    profile: str | None,
    *,
    start: str,
    end: str,
    granularity: str,
    group_by: list[str] | None = None,
) -> Any:
    args = [
        "ce",
        "get-cost-and-usage",
        "--time-period",
        f"Start={start},End={end}",
        "--granularity",
        granularity,
        "--metrics",
        "UnblendedCost",
    ]
    for key in group_by or []:
        args.extend(["--group-by", f"Type=DIMENSION,Key={key}"])
    return aws_cli_json(args, profile=profile)


def sum_total_cost(payload: Any) -> float:
    total = 0.0
    for bucket in payload.get("ResultsByTime", []) if isinstance(payload, dict) else []:
        if not isinstance(bucket, dict):
            continue
        amount = (((bucket.get("Total") or {}).get("UnblendedCost") or {}).get("Amount"))
        value = parse_amount(amount)
        if value is not None:
            total += value
            continue
        for group in bucket.get("Groups", []) or []:
            if not isinstance(group, dict):
                continue
            group_amount = (((group.get("Metrics") or {}).get("UnblendedCost") or {}).get("Amount"))
            group_value = parse_amount(group_amount)
            if group_value is not None:
                total += group_value
    return round(total, 10)


def rank_service_costs(payload: Any) -> list[dict[str, Any]]:
    service_totals: dict[str, float] = defaultdict(float)
    for bucket in payload.get("ResultsByTime", []) if isinstance(payload, dict) else []:
        if not isinstance(bucket, dict):
            continue
        for group in bucket.get("Groups", []) or []:
            if not isinstance(group, dict):
                continue
            keys = group.get("Keys", []) or []
            service = str(keys[0]).strip() if keys else ""
            value = parse_amount((((group.get("Metrics") or {}).get("UnblendedCost") or {}).get("Amount")))
            if service and value is not None:
                service_totals[service] += value
    ranked = [
        {"service": service, "cost": round(cost, 10)}
        for service, cost in sorted(service_totals.items(), key=lambda item: item[1], reverse=True)
    ]
    return ranked


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
    lines.append("# AWS billing details")
    lines.append("")
    lines.append(f"- Account: `{data['callerIdentity'].get('Account', 'unknown')}`")
    lines.append(f"- ARN: `{data['callerIdentity'].get('Arn', 'unknown')}`")
    lines.append(f"- Currency: `{data['currency']}`")
    lines.append("")

    total_rows = []
    for row in data["totals"]:
        total_rows.append(
            [
                row["label"],
                row["start"],
                row["end"],
                f"{row['cost']:.2f}",
            ]
        )
    lines.append("## Totals")
    lines.append(render_table(["Period", "Start", "End", "Unblended cost (USD)"], total_rows))
    lines.append("")

    for section in ("lastFullMonth", "monthToDate"):
        breakdown = data["serviceBreakdowns"][section]
        rows = [[row["service"], f"{row['cost']:.2f}"] for row in breakdown["topServices"]]
        title = "Last full month" if section == "lastFullMonth" else "Current month-to-date"
        lines.append(f"## {title}")
        lines.append(f"- Window: `{breakdown['start']}` to `{breakdown['end']}`")
        lines.append(f"- Total cost: `${breakdown['totalCost']:.2f}`")
        lines.append(render_table(["Service", "Unblended cost (USD)"], rows))
        lines.append("")

    if data.get("notes"):
        lines.append("## Notes")
        for note in data["notes"]:
            lines.append(f"- {note}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize AWS billing details using Cost Explorer")
    parser.add_argument("--profile")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    today = utc_today()
    last30_start = today - timedelta(days=30)
    mtd_start = month_start(today)
    last_month_start, last_month_end = previous_month_range(today)

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
    fallback_notes: list[str] = []

    total_specs = [
        ("last30Days", "Last 30 days", last30_start, today),
        ("monthToDate", "Month-to-date", mtd_start, today),
    ]

    breakdown_specs = [
        ("lastFullMonth", "Last full month", last_month_start, last_month_end),
        ("monthToDate", "Current month-to-date", mtd_start, today),
    ]

    totals: list[dict[str, Any]] = []
    breakdowns: dict[str, dict[str, Any]] = {}

    for key, label, start, end in total_specs:
        try:
            payload = ce_query(args.profile, start=iso(start), end=iso(end), granularity="MONTHLY")
        except AwsCliError as error:
            error_text = summarize_errors(error)
            errors.append(f"{label}: {error_text}")
            if any(token in error_text for token in ("429", "ThrottlingException", "TooManyRequests", "Rate exceeded")):
                fallback_notes.append(
                    "Cost Explorer throttled this query; retry with backoff or use the billing console export/CUR as a fallback."
                )
            totals.append({"key": key, "label": label, "start": iso(start), "end": iso(end), "cost": None})
            continue
        totals.append(
            {
                "key": key,
                "label": label,
                "start": iso(start),
                "end": iso(end),
                "cost": sum_total_cost(payload),
            }
        )

    for key, label, start, end in breakdown_specs:
        try:
            payload = ce_query(args.profile, start=iso(start), end=iso(end), granularity="MONTHLY", group_by=["SERVICE"])
        except AwsCliError as error:
            error_text = summarize_errors(error)
            errors.append(f"{label}: {error_text}")
            if any(token in error_text for token in ("429", "ThrottlingException", "TooManyRequests", "Rate exceeded")):
                fallback_notes.append(
                    "Cost Explorer throttled this query; retry with backoff or use the billing console export/CUR as a fallback."
                )
            breakdowns[key] = {
                "label": label,
                "start": iso(start),
                "end": iso(end),
                "totalCost": None,
                "serviceRows": [],
                "topServices": [],
                "distinctServices": 0,
            }
            continue
        service_rows = rank_service_costs(payload)
        breakdowns[key] = {
            "label": label,
            "start": iso(start),
            "end": iso(end),
            "totalCost": sum(row["cost"] for row in service_rows),
            "serviceRows": service_rows,
            "topServices": service_rows[:15],
            "distinctServices": len(service_rows),
        }

    data = {
        "profile": args.profile,
        "callerIdentity": identity,
        "currency": "USD",
        "asOf": iso(today),
        "totals": totals,
        "serviceBreakdowns": breakdowns,
        "notes": [
            "Costs are unblended Cost Explorer values grouped by SERVICE.",
            "Time windows use UTC dates and Cost Explorer end dates are exclusive.",
        ]
        + fallback_notes,
    }

    artifacts = []
    json_artifact = write_json_artifact(
        args.output_dir,
        "aws_cost_explorer_billing_summary.json",
        data,
        label="AWS Cost Explorer billing summary",
        summary="Structured Cost Explorer totals and service breakdowns for the requested billing windows.",
    )
    if json_artifact:
        artifacts.append(json_artifact)

    if args.output_dir:
        markdown_path = Path(args.output_dir) / "aws_cost_explorer_billing_summary.md"
        markdown_path.write_text(render_markdown_report(data), encoding="utf-8")
        artifacts.append(
            {
                "label": "AWS billing summary report",
                "path": str(markdown_path),
                "summary": "Markdown report with totals and service breakdown tables.",
            }
        )

    status = "ok" if not errors else "warning"
    available_totals = [row for row in totals if row.get("cost") is not None]
    available_breakdowns = [item for item in breakdowns.values() if item.get("topServices")]
    if errors and not available_totals and not available_breakdowns:
        status = "error"

    summary_parts = []
    if totals and totals[0].get("cost") is not None and totals[1].get("cost") is not None:
        summary_parts.append(
            f"Last 30 days cost was ${float(totals[0]['cost']):.2f} and month-to-date cost was ${float(totals[1]['cost']):.2f}."
        )
    elif available_totals:
        summary_parts.append(f"Collected {len(available_totals)} of 2 requested total-cost windows.")
    if "lastFullMonth" in breakdowns and breakdowns["lastFullMonth"].get("topServices"):
        summary_parts.append(
            f"Last full month top service was {breakdowns['lastFullMonth']['topServices'][0]['service']} at ${float(breakdowns['lastFullMonth']['topServices'][0]['cost']):.2f}."
        )
    if "monthToDate" in breakdowns and breakdowns["monthToDate"].get("topServices"):
        summary_parts.append(
            f"Current month-to-date top service was {breakdowns['monthToDate']['topServices'][0]['service']} at ${float(breakdowns['monthToDate']['topServices'][0]['cost']):.2f}."
        )
    summary = " ".join(summary_parts) if summary_parts else "Cost Explorer queries completed with no usable billing rows."

    emit_result(build_result(status, summary, data, artifacts=[artifact for artifact in artifacts if artifact], errors=errors))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
