#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, queryable_ec2_regions, summarize_errors, write_json_artifact


def iso_date(value: date) -> str:
    return value.isoformat()


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def parse_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize_field_name(token: str) -> str:
    text = token.strip()
    if text.startswith("${") and text.endswith("}"):
        text = text[2:-1]
    return text.replace("-", "_")


def is_nat_usage_type(value: str) -> bool:
    text = value.lower()
    return "natgateway" in text or "nat gateway" in text or "nat-gateway" in text


def read_flow_log_configuration() -> dict[str, str] | None:
    destination_type = (os.environ.get("NAT_FLOW_LOGS_DESTINATION_TYPE") or "").strip().lower()
    destination = (os.environ.get("NAT_FLOW_LOGS_DESTINATION") or "").strip()
    role_arn = (os.environ.get("NAT_FLOW_LOGS_ROLE_ARN") or "").strip()
    log_format = (os.environ.get("NAT_FLOW_LOGS_LOG_FORMAT") or "").strip()
    if not destination_type or not destination or not role_arn:
        return None
    if destination_type not in {"cloud-watch-logs", "s3"}:
        return None
    return {
        "destinationType": destination_type,
        "destination": destination,
        "roleArn": role_arn,
        "logFormat": log_format
        or "${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${subnet-id} ${bytes} ${start} ${end} ${action} ${log-status}",
    }


def extract_access_denied_action(message: str) -> str | None:
    patterns = [
        r"not authorized to perform: ([a-z0-9:*.-]+)",
        r"AccessDeniedException.*?([a-z0-9:*.-]+)",
        r"User .*? is not authorized to perform: ([a-z0-9:*.-]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, message, re.IGNORECASE | re.DOTALL)
        if match:
            return match.group(1)
    return None


def extract_failed_api_call(message: str, default_call: str) -> str:
    for candidate in [
        "DescribeFlowLogs",
        "CreateFlowLogs",
        "DescribeNatGateways",
        "DescribeNetworkInterfaces",
        "GetMetricStatistics",
        "StartQuery",
    ]:
        if candidate.lower() in message.lower():
            return candidate
    return default_call


def build_region_scope(profile: str | None, args: argparse.Namespace) -> list[str]:
    if args.regions:
        return [item.strip() for item in args.regions.split(",") if item.strip()]
    if args.region:
        return [args.region.strip()]
    if args.all_regions:
        return queryable_ec2_regions(profile)
    return queryable_ec2_regions(profile)


def ce_dimension_values(profile: str | None, dimension: str, start: str, end: str) -> list[str]:
    payload = aws_cli_json(
        [
            "ce",
            "get-dimension-values",
            "--dimension",
            dimension,
            "--time-period",
            f"Start={start},End={end}",
            "--context",
            "COST_AND_USAGE",
        ],
        profile=profile,
    )
    values: list[str] = []
    for item in payload.get("DimensionValues", []) if isinstance(payload, dict) else []:
        if isinstance(item, dict):
            value = str(item.get("Value", "")).strip()
            if value:
                values.append(value)
    return sorted(dict.fromkeys(values))


def ce_query(
    profile: str | None,
    *,
    start: str,
    end: str,
    group_keys: list[str] | None = None,
    filter_obj: dict[str, Any] | None = None,
    subcommand: str = "get-cost-and-usage",
) -> Any:
    args = ["ce", subcommand, "--time-period", f"Start={start},End={end}", "--granularity", "DAILY", "--metrics", "UnblendedCost"]
    for key in group_keys or []:
        args.extend(["--group-by", f"Type=DIMENSION,Key={key}"])
    if filter_obj is not None:
        args.extend(["--filter", json.dumps(filter_obj, separators=(",", ":"))])
    return aws_cli_json(args, profile=profile)


def flatten_cost_groups(payload: Any) -> dict[tuple[str, ...], dict[str, float]]:
    series: dict[tuple[str, ...], dict[str, float]] = defaultdict(dict)
    for bucket in payload.get("ResultsByTime", []) if isinstance(payload, dict) else []:
        if not isinstance(bucket, dict):
            continue
        day = str((bucket.get("TimePeriod") or {}).get("Start", "")).strip()
        if not day:
            continue
        for group in bucket.get("Groups", []) or []:
            if not isinstance(group, dict):
                continue
            keys = tuple(str(value).strip() for value in group.get("Keys", []) or [])
            if not keys:
                continue
            amount = (((group.get("Metrics") or {}).get("UnblendedCost") or {}).get("Amount"))
            try:
                series[keys][day] = float(amount)
            except (TypeError, ValueError):
                continue
    return series


def rank_costs(payload: Any) -> list[dict[str, Any]]:
    ranked: list[dict[str, Any]] = []
    for keys, day_costs in flatten_cost_groups(payload).items():
        ranked.append(
            {
                "keys": list(keys),
                "totalCost": round(sum(day_costs.values()), 10),
                "dailyCost": [{"day": day, "cost": round(cost, 10)} for day, cost in sorted(day_costs.items())],
            }
        )
    ranked.sort(key=lambda item: item["totalCost"], reverse=True)
    return ranked


def detect_spike_start(series: list[dict[str, Any]]) -> dict[str, Any] | None:
    values = [float(item.get("value", 0.0)) for item in series]
    days = [str(item.get("day")) for item in series]
    if not values:
        return None
    first_nonzero = next((idx for idx, value in enumerate(values) if value > 0), None)
    if first_nonzero is None:
        return None
    if first_nonzero < 7:
        return {"day": days[first_nonzero], "value": values[first_nonzero], "baseline": 0.0, "factor": None, "reason": "first non-zero day"}
    for idx in range(7, len(values)):
        baseline = median(values[idx - 7 : idx])
        current = values[idx]
        if baseline <= 0 and current > 0:
            return {"day": days[idx], "value": current, "baseline": baseline, "factor": None, "reason": "first positive day after zero baseline"}
        if baseline > 0 and current >= baseline * 2:
            return {
                "day": days[idx],
                "value": current,
                "baseline": baseline,
                "factor": round(current / baseline, 2),
                "reason": "at least 2x the previous 7-day median",
            }
    peak_index = max(range(len(values)), key=lambda idx: values[idx])
    return {
        "day": days[peak_index],
        "value": values[peak_index],
        "baseline": median(values[max(0, peak_index - 7) : peak_index]) if peak_index else 0.0,
        "factor": None,
        "reason": "peak day in the observed window",
    }


def list_nat_gateways(profile: str | None, regions: list[str]) -> tuple[list[dict[str, Any]], list[str]]:
    nat_gateways: list[dict[str, Any]] = []
    warnings: list[str] = []
    for region in regions:
        try:
            payload = aws_cli_json(["ec2", "describe-nat-gateways"], profile=profile, region=region)
        except AwsCliError as error:
            warnings.append(f"{region}: {summarize_errors(error)}")
            continue
        for nat in payload.get("NatGateways", []) if isinstance(payload, dict) else []:
            if not isinstance(nat, dict):
                continue
            nat_gateways.append(
                {
                    "region": region,
                    "natGatewayId": nat.get("NatGatewayId"),
                    "state": nat.get("State"),
                    "vpcId": nat.get("VpcId"),
                    "subnetId": nat.get("SubnetId"),
                    "connectivityType": nat.get("ConnectivityType"),
                    "createTime": nat.get("CreateTime"),
                    "failureCode": nat.get("FailureCode"),
                    "failureMessage": nat.get("FailureMessage"),
                    "tags": nat.get("Tags", []),
                    "addresses": nat.get("NatGatewayAddresses", []),
                }
            )
    nat_gateways.sort(key=lambda item: (str(item.get("region", "")), str(item.get("natGatewayId", ""))))
    return nat_gateways, warnings


def query_nat_metrics(profile: str | None, nat_gateway: dict[str, Any], start: date, end: date) -> tuple[dict[str, Any], list[str]]:
    region = str(nat_gateway.get("region") or "").strip()
    nat_id = str(nat_gateway.get("natGatewayId") or "").strip()
    if not region or not nat_id:
        return {}, ["missing NAT gateway id or region"]
    per_day: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    warnings: list[str] = []
    for metric_name in ["BytesOutToDestination", "BytesInFromSource"]:
        try:
            payload = aws_cli_json(
                [
                    "cloudwatch",
                    "get-metric-statistics",
                    "--namespace",
                    "AWS/NATGateway",
                    "--metric-name",
                    metric_name,
                    "--start-time",
                    f"{iso_date(start)}T00:00:00Z",
                    "--end-time",
                    f"{iso_date(end + timedelta(days=1))}T00:00:00Z",
                    "--period",
                    "86400",
                    "--statistics",
                    "Sum",
                    "--dimensions",
                    f"Name=NatGatewayId,Value={nat_id}",
                ],
                profile=profile,
                region=region,
            )
        except AwsCliError as error:
            warnings.append(f"{region}/{nat_id}/{metric_name}: {summarize_errors(error)}")
            continue
        for point in payload.get("Datapoints", []) if isinstance(payload, dict) else []:
            if not isinstance(point, dict):
                continue
            ts = parse_timestamp(point.get("Timestamp"))
            if ts is None:
                continue
            day = ts.astimezone(timezone.utc).date().isoformat()
            try:
                per_day[day][metric_name] += float(point.get("Sum", 0.0))
            except (TypeError, ValueError):
                continue
    days = [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
    bytes_out_series: list[dict[str, Any]] = []
    bytes_in_series: list[dict[str, Any]] = []
    total_series: list[dict[str, Any]] = []
    total_sum = 0.0
    for day in days:
        key = iso_date(day)
        out_value = per_day[key].get("BytesOutToDestination", 0.0)
        in_value = per_day[key].get("BytesInFromSource", 0.0)
        total_value = out_value + in_value
        total_sum += total_value
        bytes_out_series.append({"day": key, "value": round(out_value, 3)})
        bytes_in_series.append({"day": key, "value": round(in_value, 3)})
        total_series.append({"day": key, "value": round(total_value, 3)})
    return (
        {
            "region": region,
            "natGatewayId": nat_id,
            "bytesOutToDestination": bytes_out_series,
            "bytesInFromSource": bytes_in_series,
            "totalBytes": total_series,
            "totalBytesSum": round(total_sum, 3),
            "spikeStart": detect_spike_start(total_series),
        },
        warnings,
    )


def list_subnets(profile: str | None, region: str, vpc_id: str | None) -> tuple[list[dict[str, Any]], str | None]:
    if not vpc_id:
        return [], None
    try:
        payload = aws_cli_json(["ec2", "describe-subnets", "--filters", f"Name=vpc-id,Values={vpc_id}"], profile=profile, region=region)
    except AwsCliError as error:
        return [], summarize_errors(error)
    subnets: list[dict[str, Any]] = []
    for subnet in payload.get("Subnets", []) if isinstance(payload, dict) else []:
        if not isinstance(subnet, dict):
            continue
        name = None
        for tag in subnet.get("Tags", []) or []:
            if isinstance(tag, dict) and str(tag.get("Key", "")).strip() == "Name":
                value = str(tag.get("Value", "")).strip()
                name = value or None
                break
        subnets.append(
            {
                "subnetId": subnet.get("SubnetId"),
                "name": name,
                "availabilityZone": subnet.get("AvailabilityZone"),
                "cidrBlock": subnet.get("CidrBlock"),
                "mapPublicIpOnLaunch": subnet.get("MapPublicIpOnLaunch"),
            }
        )
    return subnets, None


def list_network_interfaces(profile: str | None, region: str, vpc_id: str | None) -> tuple[list[dict[str, Any]], str | None]:
    if not vpc_id:
        return [], None
    try:
        payload = aws_cli_json(["ec2", "describe-network-interfaces", "--filters", f"Name=vpc-id,Values={vpc_id}"], profile=profile, region=region)
    except AwsCliError as error:
        return [], summarize_errors(error)
    interfaces: list[dict[str, Any]] = []
    for eni in payload.get("NetworkInterfaces", []) if isinstance(payload, dict) else []:
        if not isinstance(eni, dict):
            continue
        interfaces.append(
            {
                "networkInterfaceId": eni.get("NetworkInterfaceId"),
                "description": eni.get("Description"),
                "privateIpAddress": eni.get("PrivateIpAddress"),
                "status": eni.get("Status"),
                "subnetId": eni.get("SubnetId"),
                "attachment": eni.get("Attachment"),
                "groups": eni.get("Groups", []),
            }
        )
    return interfaces, None


def list_private_subnet_ids(profile: str | None, region: str, vpc_id: str | None) -> tuple[list[str], str | None]:
    subnets, warning = list_subnets(profile, region, vpc_id)
    subnet_ids = []
    for subnet in subnets:
        subnet_id = str(subnet.get("subnetId") or "").strip()
        if subnet_id and not bool(subnet.get("mapPublicIpOnLaunch")):
            subnet_ids.append(subnet_id)
    return subnet_ids, warning


def flow_log_resources(profile: str | None, region: str, resource_ids: list[str]) -> tuple[list[dict[str, Any]], str | None]:
    if not resource_ids:
        return [], None
    try:
        payload = aws_cli_json(
            ["ec2", "describe-flow-logs", "--filter", f"Name=resource-id,Values={','.join(resource_ids)}"],
            profile=profile,
            region=region,
        )
    except AwsCliError as error:
        return [], summarize_errors(error)
    flow_logs: list[dict[str, Any]] = []
    for item in payload.get("FlowLogs", []) if isinstance(payload, dict) else []:
        if not isinstance(item, dict):
            continue
        flow_logs.append(
            {
                "flowLogId": item.get("FlowLogId"),
                "resourceId": item.get("ResourceId"),
                "resourceType": item.get("ResourceType"),
                "trafficType": item.get("TrafficType"),
                "logDestinationType": item.get("LogDestinationType"),
                "logGroupName": item.get("LogGroupName"),
                "deliverLogsStatus": item.get("DeliverLogsStatus"),
                "logFormat": str(item.get("LogFormat", "")).strip(),
            }
        )
    return flow_logs, None


def create_flow_logs(
    profile: str | None,
    region: str,
    resource_type: str,
    resource_ids: list[str],
    config: dict[str, str],
) -> tuple[dict[str, Any] | None, str | None]:
    if not resource_ids:
        return None, None
    command = [
        "ec2",
        "create-flow-logs",
        "--resource-type",
        resource_type,
        "--resource-ids",
        ",".join(resource_ids),
        "--traffic-type",
        "ALL",
        "--deliver-logs-permission-arn",
        config["roleArn"],
        "--log-destination-type",
        config["destinationType"],
        "--log-format",
        config["logFormat"],
    ]
    if config["destinationType"] == "cloud-watch-logs":
        command.extend(["--log-group-name", config["destination"]])
    else:
        command.extend(["--log-destination", config["destination"]])
    try:
        payload = aws_cli_json(command, profile=profile, region=region)
    except AwsCliError as error:
        return None, summarize_errors(error)
    return payload if isinstance(payload, dict) else {}, None


def build_flow_log_query(log_format: str) -> str | None:
    fields = [normalize_field_name(token) for token in log_format.split() if token.strip()]
    if not fields or "bytes" not in fields:
        return None
    pattern = " ".join(["*"] * len(fields))
    grouped = [name for name in ["subnetId", "interfaceId", "srcAddr", "dstAddr", "pktSrcAddr", "pktDstAddr", "pktSrcAwsService", "pktDstAwsService"] if name in fields]
    group_clause = ", ".join(grouped) if grouped else "interfaceId"
    return (
        'fields @message\n'
        f'| parse @message "{pattern}" as {", ".join(fields)}\n'
        f'| stats sum(toNumber(bytes)) as bytes by {group_clause}\n'
        "| sort bytes desc\n"
        "| limit 20"
    )


def poll_logs_insights(profile: str | None, region: str, query_id: str) -> dict[str, Any] | None:
    for _ in range(20):
        try:
            payload = aws_cli_json(["logs", "get-query-results", "--query-id", query_id], profile=profile, region=region)
        except AwsCliError:
            return None
        status = str(payload.get("status", "")).strip()
        if status in {"Complete", "Failed", "Cancelled", "Timeout"}:
            return payload if status == "Complete" else None
        time.sleep(1)
    return None


def query_flow_logs(profile: str | None, region: str, vpc_id: str, candidate_subnet_ids: set[str], start: date, end: date) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    try:
        payload = aws_cli_json(["ec2", "describe-flow-logs"], profile=profile, region=region)
    except AwsCliError as error:
        return [], [f"{region}: {summarize_errors(error)}"]
    flow_logs: list[dict[str, Any]] = []
    for item in payload.get("FlowLogs", []) if isinstance(payload, dict) else []:
        if not isinstance(item, dict):
            continue
        resource_id = str(item.get("ResourceId", "")).strip()
        if resource_id != vpc_id and resource_id not in candidate_subnet_ids:
            continue
        if str(item.get("LogDestinationType", "")).strip() != "cloud-watch-logs":
            continue
        log_group_name = str(item.get("LogGroupName", "")).strip()
        if not log_group_name:
            continue
        flow_logs.append(
            {
                "flowLogId": item.get("FlowLogId"),
                "resourceId": resource_id,
                "resourceType": item.get("ResourceType"),
                "trafficType": item.get("TrafficType"),
                "logGroupName": log_group_name,
                "logFormat": str(item.get("LogFormat", "")).strip(),
                "deliverLogsStatus": item.get("DeliverLogsStatus"),
            }
        )
    queried: list[dict[str, Any]] = []
    start_epoch = int(datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).timestamp())
    end_epoch = int(datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc).timestamp())
    for flow_log in flow_logs[:3]:
        query = build_flow_log_query(str(flow_log.get("logFormat") or ""))
        result = {
            "region": region,
            "flowLogId": flow_log.get("flowLogId"),
            "resourceId": flow_log.get("resourceId"),
            "resourceType": flow_log.get("resourceType"),
            "trafficType": flow_log.get("trafficType"),
            "logGroupName": flow_log.get("logGroupName"),
            "logFormat": flow_log.get("logFormat"),
            "topRows": [],
            "warnings": [],
        }
        if query is None:
            result["warnings"].append("log format could not be converted into a Logs Insights query")
            queried.append(result)
            continue
        try:
            started = aws_cli_json(
                [
                    "logs",
                    "start-query",
                    "--log-group-name",
                    str(flow_log.get("logGroupName")),
                    "--start-time",
                    str(start_epoch),
                    "--end-time",
                    str(end_epoch),
                    "--query-string",
                    query,
                ],
                profile=profile,
                region=region,
            )
        except AwsCliError as error:
            result["warnings"].append(summarize_errors(error))
            queried.append(result)
            continue
        query_id = str(started.get("queryId", "")).strip()
        if not query_id:
            result["warnings"].append("Logs Insights returned no query id")
            queried.append(result)
            continue
        final_payload = poll_logs_insights(profile, region, query_id)
        if not final_payload:
            result["warnings"].append("Logs Insights query did not complete")
            queried.append(result)
            continue
        rows: list[dict[str, str]] = []
        for row in final_payload.get("results", []) if isinstance(final_payload, dict) else []:
            if not isinstance(row, list):
                continue
            parsed: dict[str, str] = {}
            for cell in row:
                if isinstance(cell, dict):
                    field = str(cell.get("field", "")).strip()
                    value = str(cell.get("value", "")).strip()
                    if field:
                        parsed[field] = value
            rows.append(parsed)
        result["topRows"] = rows
        queried.append(result)
    return queried, warnings


def recent_change_summary(profile: str | None, region: str, vpc_id: str, subnet_ids: list[str]) -> tuple[list[dict[str, Any]], str | None]:
    resource_names = [vpc_id, *subnet_ids[:5]]
    event_names = [
        "CreateRoute",
        "ReplaceRoute",
        "DeleteRoute",
        "AssociateRouteTable",
        "DisassociateRouteTable",
        "ModifySubnetAttribute",
        "ModifyNetworkInterfaceAttribute",
        "CreateNatGateway",
        "DeleteNatGateway",
        "RunInstances",
    ]
    events: list[dict[str, Any]] = []
    for resource_name in resource_names:
        try:
            payload = aws_cli_json(
                [
                    "cloudtrail",
                    "lookup-events",
                    "--lookup-attributes",
                    f"AttributeKey=ResourceName,AttributeValue={resource_name}",
                    "--max-results",
                    "10",
                ],
                profile=profile,
                region=region,
            )
        except AwsCliError as error:
            return [], summarize_errors(error)
        for item in payload.get("Events", []) if isinstance(payload, dict) else []:
            if not isinstance(item, dict):
                continue
            event_name = str(item.get("EventName", "")).strip()
            if event_name not in event_names:
                continue
            events.append(
                {
                    "resourceName": resource_name,
                    "eventName": event_name,
                    "eventTime": item.get("EventTime"),
                    "username": item.get("Username"),
                }
            )
    return events, None


def main() -> int:
    parser = argparse.ArgumentParser(description="Investigate NAT Gateway cost spikes")
    parser.add_argument("--profile")
    parser.add_argument("--region")
    parser.add_argument("--regions")
    parser.add_argument("--all-regions", action="store_true")
    parser.add_argument("--lookback-days", type=int, default=180)
    parser.add_argument("--top-n", type=int, default=3)
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    try:
        caller = aws_cli_json(["sts", "get-caller-identity"], profile=args.profile, region=args.region)
    except AwsCliError as error:
        emit_result(build_result("error", "Unable to determine the active AWS account scope.", {}, errors=[summarize_errors(error)]))
        return 1

    regions = build_region_scope(args.profile, args)
    if not regions:
        emit_result(build_result("error", "Unable to resolve any queryable AWS regions.", {}, errors=["No queryable regions were returned."]))
        return 1

    today = utc_today()
    start = today - timedelta(days=max(args.lookback_days, 14))
    end = today
    start_s = iso_date(start)
    end_s = iso_date(end)

    warnings: list[str] = []
    artifacts: list[dict[str, Any]] = []

    try:
        service_values = ce_dimension_values(args.profile, "SERVICE", start_s, end_s)
        usage_values = ce_dimension_values(args.profile, "USAGE_TYPE", start_s, end_s)
    except AwsCliError as error:
        emit_result(build_result("error", "Unable to query Cost Explorer dimension values.", {}, errors=[summarize_errors(error)]))
        return 1

    nat_usage_values = [value for value in usage_values if is_nat_usage_type(value) or "nat" in value.lower()]
    service_totals_payload: Any = {}
    nat_usage_payload: Any = {}
    service_usage_payload: Any = {}
    resource_payload: Any = {}

    try:
        service_totals_payload = ce_query(args.profile, start=start_s, end=end_s, group_keys=["SERVICE"])
    except AwsCliError as error:
        warnings.append(f"Cost Explorer service totals: {summarize_errors(error)}")

    if nat_usage_values:
        nat_filter = {"Dimensions": {"Key": "USAGE_TYPE", "Values": nat_usage_values}}
        try:
            nat_usage_payload = ce_query(args.profile, start=start_s, end=end_s, group_keys=["USAGE_TYPE"], filter_obj=nat_filter)
        except AwsCliError as error:
            warnings.append(f"Cost Explorer NAT usage types: {summarize_errors(error)}")
        try:
            service_usage_payload = ce_query(args.profile, start=start_s, end=end_s, group_keys=["SERVICE", "USAGE_TYPE"], filter_obj=nat_filter)
        except AwsCliError as error:
            warnings.append(f"Cost Explorer NAT service usage types: {summarize_errors(error)}")
        try:
            resource_start = iso_date(max(start, today - timedelta(days=14)))
            resource_payload = ce_query(
                args.profile,
                start=resource_start,
                end=end_s,
                group_keys=["RESOURCE_ID", "USAGE_TYPE"],
                filter_obj=nat_filter,
                subcommand="get-cost-and-usage-with-resources",
            )
        except AwsCliError as error:
            warnings.append(f"Cost Explorer resource-level data: {summarize_errors(error)}")
    else:
        warnings.append("No NAT-related Cost Explorer usage types were returned for the observed window.")

    service_totals = rank_costs(service_totals_payload)
    nat_usage_totals = rank_costs(nat_usage_payload)
    service_usage_totals = rank_costs(service_usage_payload)
    resource_totals = rank_costs(resource_payload)

    nat_gateways, nat_warnings = list_nat_gateways(args.profile, regions)
    warnings.extend(nat_warnings)

    nat_gateway_metrics: list[dict[str, Any]] = []
    nat_gateway_candidates: list[dict[str, Any]] = []
    flow_log_preflight: list[dict[str, Any]] = []
    permission_gap: dict[str, Any] | None = None
    flow_log_config = read_flow_log_configuration()
    for nat in nat_gateways:
        metric_data, metric_warnings = query_nat_metrics(args.profile, nat, start, end)
        warnings.extend(metric_warnings)
        if not metric_data:
            continue
        nat_gateway_metrics.append({**nat, **metric_data})
        nat_gateway_candidates.append(
            {
                "region": nat.get("region"),
                "natGatewayId": nat.get("natGatewayId"),
                "vpcId": nat.get("vpcId"),
                "subnetId": nat.get("subnetId"),
                "totalBytes": float(metric_data.get("totalBytesSum") or 0.0),
                "spikeStart": metric_data.get("spikeStart"),
                "connectivityType": nat.get("connectivityType"),
            }
        )
    nat_gateway_candidates.sort(key=lambda item: item["totalBytes"], reverse=True)
    top_nat_gateways = nat_gateway_candidates[: max(args.top_n, 1)]

    flow_log_evidence: list[dict[str, Any]] = []
    for driver in top_nat_gateways[:2]:
        region = str(driver.get("region") or "").strip()
        vpc_id = str(driver.get("vpcId") or "").strip()
        if not region or not vpc_id:
            continue
        subnet_ids, subnet_warning = list_private_subnet_ids(args.profile, region, vpc_id)
        if subnet_warning:
            warnings.append(f"{region}/{vpc_id}: {subnet_warning}")
        resource_ids = [vpc_id, *subnet_ids]
        existing_flow_logs, flow_warning = flow_log_resources(args.profile, region, resource_ids)
        if flow_warning:
            warnings.append(f"{region}/{vpc_id}: describe-flow-logs: {flow_warning}")
        if not existing_flow_logs and flow_log_config:
            created: list[dict[str, Any]] = []
            create_error: str | None = None
            for resource_type, ids in [("VPC", [vpc_id]), ("Subnet", subnet_ids)]:
                if not ids:
                    continue
                created_payload, create_warning = create_flow_logs(args.profile, region, resource_type, ids, flow_log_config)
                created.append({"resourceType": resource_type, "resourceIds": ids, "response": created_payload})
                if create_warning:
                    create_error = create_warning
                    warnings.append(f"{region}/{vpc_id}: create-flow-logs {resource_type}: {create_warning}")
                    continue
            flow_log_preflight.append(
                {
                    "region": region,
                    "vpcId": vpc_id,
                    "privateSubnetIds": subnet_ids,
                    "existingFlowLogs": existing_flow_logs,
                    "createAttempts": created,
                    "configuration": {
                        "destinationType": flow_log_config["destinationType"],
                        "destination": flow_log_config["destination"],
                    },
                    "createError": create_error,
                }
            )
            if create_error:
                action = extract_access_denied_action(create_error)
                if action and permission_gap is None:
                    permission_gap = {
                        "region": region,
                        "vpcId": vpc_id,
                        "missingPermission": action,
                        "failedCall": extract_failed_api_call(create_error, "ec2 create-flow-logs"),
                        "reason": "Flow Logs enablement was denied.",
                    }
        elif not existing_flow_logs:
            flow_log_preflight.append(
                {
                    "region": region,
                    "vpcId": vpc_id,
                    "privateSubnetIds": subnet_ids,
                    "existingFlowLogs": [],
                    "createAttempts": [],
                    "configuration": None,
                    "createError": "No flow log destination configured.",
                }
            )
        subnets, subnet_warning = list_subnets(args.profile, region, vpc_id)
        if subnet_warning:
            warnings.append(f"{region}/{vpc_id}: {subnet_warning}")
        interfaces, eni_warning = list_network_interfaces(args.profile, region, vpc_id)
        if eni_warning:
            warnings.append(f"{region}/{vpc_id}: {eni_warning}")
        candidate_subnet_ids = {str(item.get("subnetId") or "").strip() for item in subnets if str(item.get("subnetId") or "").strip()}
        candidate_subnet_ids.update(str(item.get("networkInterfaceId") or "").strip() for item in interfaces if str(item.get("networkInterfaceId") or "").strip())
        queried, flow_warnings = query_flow_logs(args.profile, region, vpc_id, candidate_subnet_ids, start, end)
        warnings.extend(flow_warnings)
        if queried:
            flow_log_evidence.append({"region": region, "vpcId": vpc_id, "subnets": subnets, "networkInterfaces": interfaces, "flowLogs": queried})
        elif not existing_flow_logs:
            change_events, change_warning = recent_change_summary(args.profile, region, vpc_id, subnet_ids)
            if change_warning:
                warnings.append(f"{region}/{vpc_id}: cloudtrail lookup-events: {change_warning}")
            flow_log_evidence.append(
                {
                    "region": region,
                    "vpcId": vpc_id,
                    "subnets": subnets,
                    "networkInterfaces": interfaces,
                    "flowLogs": [],
                    "recentChanges": change_events,
                }
            )

    top_flow_log_rows: list[dict[str, Any]] = []
    for item in flow_log_evidence:
        for flow_log in item.get("flowLogs", []) or []:
            for row in flow_log.get("topRows", []) or []:
                top_flow_log_rows.append(
                    {
                        "region": item.get("region"),
                        "vpcId": item.get("vpcId"),
                        "resourceId": flow_log.get("resourceId"),
                        "logGroupName": flow_log.get("logGroupName"),
                        "row": row,
                    }
                )

    top_flow_log_rows.sort(key=lambda item: float(str(item.get("row", {}).get("bytes", "0")).strip() or 0.0), reverse=True)

    top_service = service_totals[0] if service_totals else {}
    top_nat_usage = nat_usage_totals[0] if nat_usage_totals else {}
    top_resource = resource_totals[0] if resource_totals else {}

    summary_data = {
        "callerIdentity": caller,
        "window": {"start": start_s, "end": end_s, "lookbackDays": args.lookback_days},
        "regions": regions,
        "costExplorer": {
            "serviceValues": service_values,
            "usageTypeValues": usage_values,
            "natUsageTypes": nat_usage_values,
            "serviceTotals": service_totals[:10],
            "natUsageTotals": nat_usage_totals,
            "serviceUsageTotals": service_usage_totals[:10],
            "resourceTotals": resource_totals[:10],
            "topServiceName": (top_service.get("keys") or ["unknown"])[0],
            "topServiceCost": top_service.get("totalCost", 0.0),
            "topNatUsageType": (top_nat_usage.get("keys") or ["unknown"])[0],
            "topNatUsageCost": top_nat_usage.get("totalCost", 0.0),
            "topResourceId": (top_resource.get("keys") or [None])[0],
        },
        "natGateways": nat_gateways,
        "natGatewayMetrics": nat_gateway_metrics,
        "topDrivers": top_nat_gateways,
        "flowLogPreflight": flow_log_preflight,
        "flowLogs": flow_log_evidence,
        "topFlowLogRows": top_flow_log_rows[:20],
        "needsHumanAction": [],
        "warnings": warnings,
    }
    if permission_gap and not nat_gateway_metrics and not top_flow_log_rows:
        summary_data["needsHumanAction"] = [permission_gap]

    artifact = write_json_artifact(args.output_dir, "nat_gateway_cost_spike.json", summary_data, label="NAT Gateway cost spike investigation")
    if artifact:
        artifacts.append(artifact)

    summary_bits: list[str] = []
    if top_nat_usage:
        summary_bits.append(f"Cost Explorer highlights {top_nat_usage.get('keys', ['unknown'])[0]} as the leading NAT-related usage type.")
    if top_nat_gateways:
        lead = top_nat_gateways[0]
        spike = lead.get("spikeStart") if isinstance(lead.get("spikeStart"), dict) else {}
        summary_bits.append(
            f"Top NAT gateway driver is {lead.get('natGatewayId')} in {lead.get('region')} with a spike around {spike.get('day') or 'an unresolved day'}."
        )
    if top_flow_log_rows:
        row = top_flow_log_rows[0].get("row", {})
        summary_bits.append(
            f"Flow logs point at {row.get('subnetId') or row.get('interfaceId') or 'unknown'} with destination {row.get('dstAddr') or row.get('pktDstAddr') or 'unknown'}."
        )
    elif flow_log_evidence:
        summary_bits.append("VPC Flow Logs were present but no parsed top rows were returned from the sampled windows.")
    else:
        summary_bits.append("No matching CloudWatch VPC Flow Logs were found for the top NAT gateway VPCs and subnets.")
    summary = " ".join(summary_bits) if summary_bits else "NAT Gateway investigation completed, but the AWS evidence did not isolate a dominant driver."
    if summary_data["needsHumanAction"]:
        summary_bits.append("VPC Flow Logs were unavailable, creation was denied, and NAT Gateway fallback attribution was used.")
    status = "warning" if warnings or not top_nat_gateways or summary_data["needsHumanAction"] else "ok"

    emit_result(build_result(status, summary, summary_data, artifacts=artifacts, errors=warnings))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
