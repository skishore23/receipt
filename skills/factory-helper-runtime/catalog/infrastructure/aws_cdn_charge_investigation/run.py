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


def iso_date(value: date) -> str:
    return value.isoformat()


def iso_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def normalize_key(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return text


def usage_category(service: str, usage_type: str) -> str:
    text = f"{service} {usage_type}".lower()
    if "invalidat" in text:
        return "invalidations"
    if "request" in text:
        return "requests"
    if any(token in text for token in ["data transfer", "datatransfer", "bytes", "bandwidth", "traffic"]):
        return "data_transfer"
    if "accelerator" in text and "hour" in text:
        return "hours"
    if "accelerator" in text and "byte" in text:
        return "data_transfer"
    return "other"


def looks_like_cdn_service(service: str) -> bool:
    text = service.lower()
    return "cloudfront" in text or "global accelerator" in text or text == "aws global accelerator" or text == "amazon cloudfront"


def ce_query(
    profile: str | None,
    *,
    start: str,
    end: str,
    group_keys: list[str],
    filter_obj: dict[str, Any] | None = None,
) -> Any:
    args = [
        "ce",
        "get-cost-and-usage",
        "--time-period",
        f"Start={start},End={end}",
        "--granularity",
        "DAILY",
        "--metrics",
        "UnblendedCost",
    ]
    for key in group_keys:
        args.extend(["--group-by", f"Type=DIMENSION,Key={key}"])
    if filter_obj is not None:
        args.extend(["--filter", json.dumps(filter_obj, separators=(",", ":"))])
    return aws_cli_json(args, profile=profile)


def flatten_cost_groups(payload: Any) -> dict[tuple[str, str], list[dict[str, Any]]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for bucket in payload.get("ResultsByTime", []) if isinstance(payload, dict) else []:
        if not isinstance(bucket, dict):
            continue
        day = str(((bucket.get("TimePeriod") or {}).get("Start")) or "").strip()
        if not day:
            continue
        for group in bucket.get("Groups", []) or []:
            if not isinstance(group, dict):
                continue
            keys = [normalize_key(value) for value in group.get("Keys", []) or []]
            if len(keys) < 2:
                continue
            amount = (((group.get("Metrics") or {}).get("UnblendedCost") or {}).get("Amount"))
            try:
                cost = float(amount)
            except (TypeError, ValueError):
                continue
            grouped[(keys[0], keys[1])].append({"day": day, "cost": round(cost, 10)})
    return grouped


def summarize_cost_payload(payload: Any) -> dict[str, Any]:
    grouped = flatten_cost_groups(payload)
    service_totals: dict[str, float] = defaultdict(float)
    service_usage_totals: dict[tuple[str, str], float] = defaultdict(float)
    by_service: dict[str, dict[str, Any]] = {}
    first_nonzero_days: list[str] = []

    for (service, usage_type), daily_rows in grouped.items():
        if not looks_like_cdn_service(service):
            continue
        total = round(sum(float(item.get("cost", 0.0)) for item in daily_rows), 10)
        daily_rows = sorted(daily_rows, key=lambda item: str(item.get("day", "")))
        first_nonzero = next((row for row in daily_rows if float(row.get("cost", 0.0)) > 0.0), None)
        category = usage_category(service, usage_type)
        service_totals[service] += total
        service_usage_totals[(service, usage_type)] += total
        first_nonzero_day = str(first_nonzero.get("day")) if first_nonzero else None
        if first_nonzero_day:
            first_nonzero_days.append(first_nonzero_day)
        entry = by_service.setdefault(
            service,
            {
                "service": service,
                "totalCost": 0.0,
                "usageTypes": [],
                "driverTotals": defaultdict(float),
                "firstNonZeroDays": [],
            },
        )
        entry["totalCost"] = round(float(entry["totalCost"]) + total, 10)
        entry["usageTypes"].append(
            {
                "usageType": usage_type,
                "category": category,
                "totalCost": total,
                "dailyCost": daily_rows,
                "firstNonZeroDay": first_nonzero_day,
            }
        )
        entry["driverTotals"][category] += total
        if first_nonzero_day:
            entry["firstNonZeroDays"].append(first_nonzero_day)

    service_rows = []
    for service, info in by_service.items():
        usage_rows = sorted(info["usageTypes"], key=lambda item: item["totalCost"], reverse=True)
        driver_rows = [
            {"category": category, "totalCost": round(total, 10)}
            for category, total in sorted(info["driverTotals"].items(), key=lambda item: item[1], reverse=True)
            if total > 0
        ]
        service_rows.append(
            {
                "service": service,
                "totalCost": round(float(info["totalCost"]), 10),
                "usageTypes": usage_rows,
                "drivers": driver_rows,
                "firstObservedDay": min(info["firstNonZeroDays"]) if info["firstNonZeroDays"] else None,
            }
        )

    service_rows.sort(key=lambda item: item["totalCost"], reverse=True)
    first_any = min(first_nonzero_days) if first_nonzero_days else None
    return {
        "services": service_rows,
        "serviceTotals": [
            {"service": service, "totalCost": round(total, 10)}
            for service, total in sorted(service_totals.items(), key=lambda item: item[1], reverse=True)
        ],
        "serviceUsageTotals": [
            {"service": service, "usageType": usage_type, "totalCost": round(total, 10)}
            for (service, usage_type), total in sorted(service_usage_totals.items(), key=lambda item: item[1], reverse=True)
        ],
        "firstObservedDay": first_any,
    }


def lookup_events(
    profile: str | None,
    *,
    region: str,
    start: datetime,
    end: datetime,
    event_name: str,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    next_token: str | None = None
    while True:
        args = [
            "cloudtrail",
            "lookup-events",
            "--start-time",
            iso_timestamp(start),
            "--end-time",
            iso_timestamp(end),
            "--lookup-attributes",
            f"AttributeKey=EventName,AttributeValue={event_name}",
            "--max-results",
            "50",
        ]
        if next_token:
            args.extend(["--next-token", next_token])
        payload = aws_cli_json(args, profile=profile, region=region)
        for item in payload.get("Events", []) if isinstance(payload, dict) else []:
            if not isinstance(item, dict):
                continue
            event_time = parse_timestamp(item.get("EventTime"))
            resources = []
            resource_keys = set()
            for resource in item.get("Resources", []) or []:
                if not isinstance(resource, dict):
                    continue
                resource_name = normalize_key(resource.get("ResourceName"))
                resource_type = normalize_key(resource.get("ResourceType"))
                if resource_name:
                    resources.append({"resourceName": resource_name, "resourceType": resource_type or None})
                    resource_keys.add(resource_name)
                    resource_keys.add(resource_name.rsplit("/", 1)[-1])
                    resource_keys.add(resource_name.rsplit(":", 1)[-1])
            results.append(
                {
                    "eventName": normalize_key(item.get("EventName")),
                    "eventTime": event_time.isoformat().replace("+00:00", "Z") if event_time else None,
                    "username": normalize_key(item.get("Username")) or None,
                    "resources": resources,
                    "resourceKeys": sorted(key for key in resource_keys if key),
                }
            )
        next_token = normalize_key(payload.get("NextToken")) if isinstance(payload, dict) else ""
        if not next_token:
            break
    results.sort(key=lambda item: str(item.get("eventTime") or ""))
    return results


def index_events(events: list[dict[str, Any]]) -> dict[str, dict[str, list[dict[str, Any]]]]:
    indexed: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for event in events:
        event_name = str(event.get("eventName") or "").strip()
        if not event_name:
            continue
        for key in event.get("resourceKeys", []) or []:
            key_text = str(key).strip()
            if key_text:
                indexed[key_text][event_name].append(event)
    return indexed


def merge_event_indexes(*indexes: dict[str, dict[str, list[dict[str, Any]]]]) -> dict[str, dict[str, list[dict[str, Any]]]]:
    merged: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for index in indexes:
        for resource_key, event_map in index.items():
            for event_name, events in event_map.items():
                merged[resource_key][event_name].extend(events)
    return merged


def first_event_time(events: list[dict[str, Any]], wanted_name: str) -> str | None:
    candidates = [str(event.get("eventTime") or "").strip() for event in events if str(event.get("eventName") or "") == wanted_name]
    candidates = [item for item in candidates if item]
    return min(candidates) if candidates else None


def list_cloudfront_distributions(profile: str | None, create_event_index: dict[str, dict[str, list[dict[str, Any]]]]) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    try:
        payload = aws_cli_json(["cloudfront", "list-distributions"], profile=profile)
    except AwsCliError as error:
        return [], [f"CloudFront list-distributions: {summarize_errors(error)}"]

    items = (((payload.get("DistributionList") or {}).get("Items")) or []) if isinstance(payload, dict) else []
    distributions: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        dist_id = normalize_key(item.get("Id"))
        if not dist_id:
            continue
        detail = item
        try:
            detail_payload = aws_cli_json(["cloudfront", "get-distribution", "--id", dist_id], profile=profile)
            if isinstance(detail_payload, dict) and isinstance(detail_payload.get("Distribution"), dict):
                detail = detail_payload["Distribution"]
        except AwsCliError as error:
            warnings.append(f"CloudFront get-distribution {dist_id}: {summarize_errors(error)}")

        recent_events = create_event_index.get(dist_id, {})
        created_time = normalize_key(detail.get("CreatedTime")) or first_event_time(recent_events.get("CreateDistribution", []), "CreateDistribution")
        last_modified_time = normalize_key(detail.get("LastModifiedTime")) or first_event_time(recent_events.get("UpdateDistribution", []), "UpdateDistribution")
        distributions.append(
            {
                "id": dist_id,
                "arn": normalize_key(detail.get("ARN")) or None,
                "domainName": normalize_key(detail.get("DomainName")) or None,
                "status": normalize_key(detail.get("Status")) or None,
                "enabled": detail.get("Enabled"),
                "createdTime": created_time or None,
                "lastModifiedTime": last_modified_time or None,
                "comment": normalize_key(detail.get("Comment")) or None,
            }
        )

    distributions.sort(key=lambda item: str(item.get("id") or ""))
    return distributions, warnings


def list_global_accelerators(
    profile: str | None,
    region: str,
    create_event_index: dict[str, dict[str, list[dict[str, Any]]]],
) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    try:
        payload = aws_cli_json(["globalaccelerator", "list-accelerators"], profile=profile, region=region)
    except AwsCliError as error:
        return [], [f"Global Accelerator list-accelerators ({region}): {summarize_errors(error)}"]

    items = (payload.get("Accelerators") or []) if isinstance(payload, dict) else []
    accelerators: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        arn = normalize_key(item.get("AcceleratorArn"))
        name = normalize_key(item.get("Name"))
        detail = item
        if arn:
            try:
                detail_payload = aws_cli_json(["globalaccelerator", "describe-accelerator", "--accelerator-arn", arn], profile=profile, region=region)
                if isinstance(detail_payload, dict) and isinstance(detail_payload.get("Accelerator"), dict):
                    detail = detail_payload["Accelerator"]
            except AwsCliError as error:
                warnings.append(f"Global Accelerator describe-accelerator {arn}: {summarize_errors(error)}")

        event_keys = {arn, name}
        recent_events: list[dict[str, Any]] = []
        for key in event_keys:
            if key:
                recent_events.extend(create_event_index.get(key, {}).get("CreateAccelerator", []))
        created_time = normalize_key(detail.get("CreatedTime")) or first_event_time(recent_events, "CreateAccelerator")
        update_events: list[dict[str, Any]] = []
        for key in event_keys:
            if key:
                update_events.extend(create_event_index.get(key, {}).get("UpdateAccelerator", []))
        last_modified_time = normalize_key(detail.get("LastModifiedTime")) or first_event_time(update_events, "UpdateAccelerator")
        accelerators.append(
            {
                "name": name or None,
                "arn": arn or None,
                "status": normalize_key(detail.get("Status")) or None,
                "enabled": detail.get("Enabled"),
                "ipAddressType": normalize_key(detail.get("IpAddressType")) or None,
                "createdTime": created_time or None,
                "lastModifiedTime": last_modified_time or None,
                "dnsName": normalize_key(detail.get("DnsName")) or None,
            }
        )

    accelerators.sort(key=lambda item: str(item.get("name") or item.get("arn") or ""))
    return accelerators, warnings


def event_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(events, key=lambda item: str(item.get("eventTime") or ""))
    first = ordered[0]["eventTime"] if ordered else None
    last = ordered[-1]["eventTime"] if ordered else None
    return {
        "count": len(ordered),
        "firstEventTime": first,
        "lastEventTime": last,
        "events": ordered,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Investigate recent CDN cost and control-plane changes")
    parser.add_argument("--profile")
    parser.add_argument("--lookback-days", type=int, default=30)
    parser.add_argument("--cloudtrail-region", default="us-east-1")
    parser.add_argument("--accelerator-region", default="us-west-2")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    try:
        caller = aws_cli_json(["sts", "get-caller-identity"], profile=args.profile)
    except AwsCliError as error:
        emit_result(build_result("error", "Unable to determine the active AWS account scope.", {}, errors=[summarize_errors(error)]))
        return 1

    today = utc_today()
    last30_start = today - timedelta(days=max(args.lookback_days, 30))
    mtd_start = today.replace(day=1)
    last30_end = today
    mtd_end = today
    last30_start_s = iso_date(last30_start)
    last30_end_s = iso_date(last30_end)
    mtd_start_s = iso_date(mtd_start)
    mtd_end_s = iso_date(mtd_end)
    trail_start = datetime.combine(last30_start, datetime.min.time(), tzinfo=timezone.utc)
    trail_end = datetime.combine(today + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)

    warnings: list[str] = []
    artifacts: list[dict[str, Any]] = []

    cost_windows: dict[str, dict[str, Any]] = {}
    for label, start_s, end_s in [
        ("last30Days", last30_start_s, last30_end_s),
        ("monthToDate", mtd_start_s, mtd_end_s),
    ]:
        try:
            payload = ce_query(args.profile, start=start_s, end=end_s, group_keys=["SERVICE", "USAGE_TYPE"])
            cost_windows[label] = summarize_cost_payload(payload)
        except AwsCliError as error:
            warnings.append(f"Cost Explorer {label}: {summarize_errors(error)}")
            cost_windows[label] = {"services": [], "serviceTotals": [], "serviceUsageTotals": [], "firstObservedDay": None}

    all_cloudtrail_events: dict[str, dict[str, Any]] = {}
    for event_name in ["CreateDistribution", "UpdateDistribution", "CreateAccelerator", "UpdateAccelerator"]:
        try:
            events = lookup_events(args.profile, region=args.cloudtrail_region, start=trail_start, end=trail_end, event_name=event_name)
            all_cloudtrail_events[event_name] = event_summary(events)
        except AwsCliError as error:
            warnings.append(f"CloudTrail {event_name}: {summarize_errors(error)}")
            all_cloudtrail_events[event_name] = {"count": 0, "firstEventTime": None, "lastEventTime": None, "events": []}

    cloudfront_create_index = index_events(all_cloudtrail_events.get("CreateDistribution", {}).get("events", []))
    cloudfront_update_index = index_events(all_cloudtrail_events.get("UpdateDistribution", {}).get("events", []))
    ga_create_index = index_events(all_cloudtrail_events.get("CreateAccelerator", {}).get("events", []))
    ga_update_index = index_events(all_cloudtrail_events.get("UpdateAccelerator", {}).get("events", []))

    cloudfront_event_index = merge_event_indexes(cloudfront_create_index, cloudfront_update_index)
    cloudfront_distributions, cf_warnings = list_cloudfront_distributions(args.profile, cloudfront_event_index)
    warnings.extend(cf_warnings)

    ga_event_index = merge_event_indexes(ga_create_index, ga_update_index)
    global_accelerators, ga_warnings = list_global_accelerators(args.profile, args.accelerator_region, ga_event_index)
    warnings.extend(ga_warnings)

    evidence = {
        "callerIdentity": caller,
        "lookbackDays": max(args.lookback_days, 30),
        "windows": {
            "last30Days": {"start": last30_start_s, "end": last30_end_s, **cost_windows["last30Days"]},
            "monthToDate": {"start": mtd_start_s, "end": mtd_end_s, **cost_windows["monthToDate"]},
        },
        "cloudFront": {
            "distributions": cloudfront_distributions,
            "cloudTrail": {
                "CreateDistribution": all_cloudtrail_events.get("CreateDistribution", {}),
                "UpdateDistribution": all_cloudtrail_events.get("UpdateDistribution", {}),
            },
        },
        "globalAccelerator": {
            "accelerators": global_accelerators,
            "cloudTrail": {
                "CreateAccelerator": all_cloudtrail_events.get("CreateAccelerator", {}),
                "UpdateAccelerator": all_cloudtrail_events.get("UpdateAccelerator", {}),
            },
        },
        "warnings": warnings,
    }

    for window in evidence["windows"].values():
        window["services"] = [item for item in window.get("services", []) if looks_like_cdn_service(str(item.get("service") or ""))]
        window["serviceTotals"] = [item for item in window.get("serviceTotals", []) if looks_like_cdn_service(str(item.get("service") or ""))]
        window["serviceUsageTotals"] = [item for item in window.get("serviceUsageTotals", []) if looks_like_cdn_service(str(item.get("service") or ""))]

    first_charge_candidates = [
        day
        for window in evidence["windows"].values()
        for day in [window.get("firstObservedDay")]
        if isinstance(day, str) and day
    ]
    first_charge_day = min(first_charge_candidates) if first_charge_candidates else None

    cdn_service_summaries = []
    for window_name, window in evidence["windows"].items():
        for service_entry in window.get("services", []) or []:
            cdn_service_summaries.append(
                {
                    "window": window_name,
                    "service": service_entry.get("service"),
                    "totalCost": service_entry.get("totalCost"),
                    "firstObservedDay": service_entry.get("firstObservedDay"),
                    "drivers": service_entry.get("drivers", []),
                    "usageTypes": [
                        {
                            "usageType": item.get("usageType"),
                            "category": item.get("category"),
                            "totalCost": item.get("totalCost"),
                            "firstNonZeroDay": item.get("firstNonZeroDay"),
                        }
                        for item in service_entry.get("usageTypes", []) or []
                    ],
                }
            )

    cloudfront_recent_creates = all_cloudtrail_events.get("CreateDistribution", {}).get("events", []) or []
    cloudfront_recent_updates = all_cloudtrail_events.get("UpdateDistribution", {}).get("events", []) or []
    ga_recent_creates = all_cloudtrail_events.get("CreateAccelerator", {}).get("events", []) or []
    ga_recent_updates = all_cloudtrail_events.get("UpdateAccelerator", {}).get("events", []) or []

    summary_bits: list[str] = []
    if cdn_service_summaries:
        leading = sorted(cdn_service_summaries, key=lambda item: float(item.get("totalCost") or 0.0), reverse=True)[0]
        driver_text = ", ".join(
            f"{item.get('category')} ${float(item.get('totalCost') or 0.0):.2f}"
            for item in leading.get("drivers", [])[:3]
        )
        summary_bits.append(
            f"CDN spend is present for {leading.get('service')} in the {leading.get('window')} window, led by {driver_text or 'unclassified usage'}."
        )
        if first_charge_day:
            summary_bits.append(f"First observed non-zero CDN spend in the inspected window appears on {first_charge_day}.")
    else:
        summary_bits.append("No CloudFront or Global Accelerator spend surfaced in the inspected Cost Explorer windows.")

    if cloudfront_recent_creates or cloudfront_recent_updates:
        summary_bits.append(
            f"CloudFront CloudTrail shows {len(cloudfront_recent_creates)} creates and {len(cloudfront_recent_updates)} updates in the last 30 days."
        )
    if ga_recent_creates or ga_recent_updates:
        summary_bits.append(
            f"Global Accelerator CloudTrail shows {len(ga_recent_creates)} creates and {len(ga_recent_updates)} updates in the last 30 days."
        )
    if not cloudfront_recent_creates and not cloudfront_recent_updates and not ga_recent_creates and not ga_recent_updates:
        summary_bits.append("No CloudTrail create or update events were returned for CloudFront or Global Accelerator in the last 30 days.")

    summary = " ".join(summary_bits)
    status = "warning" if warnings else "ok"
    if not cdn_service_summaries and not warnings:
        status = "ok"
    elif warnings and not cdn_service_summaries:
        status = "warning"

    artifact = write_json_artifact(args.output_dir, "aws_cdn_charge_investigation.json", evidence, label="CDN charge investigation")
    if artifact:
        artifacts.append(artifact)

    result = build_result(status, summary, evidence, artifacts=artifacts, errors=warnings)
    emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
