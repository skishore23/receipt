#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, queryable_ec2_regions, summarize_errors, write_json_artifact


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso8601(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def tag_value(tags: Any, key: str) -> str | None:
    if not isinstance(tags, list):
        return None
    for item in tags:
        if isinstance(item, dict) and str(item.get("Key", "")).strip() == key:
            value = item.get("Value")
            if value is None:
                return None
            text = str(value).strip()
            return text or None
    return None


def normalize_instance_ids(value: Any) -> list[str]:
    ids: list[str] = []
    if not isinstance(value, dict):
        return ids
    for item in value.get("items", []) or []:
        if isinstance(item, dict):
            instance_id = str(item.get("instanceId", "")).strip()
            if instance_id:
                ids.append(instance_id)
    return ids


def extract_instance_ids_from_ct_event(ct_event: dict[str, Any], lookup_event: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()

    def add(raw: Any) -> None:
        if not raw:
            return
        text = str(raw).strip()
        if text and text.startswith("i-") and text not in seen:
            seen.add(text)
            ids.append(text)

    request = ct_event.get("requestParameters")
    if isinstance(request, dict):
        for item in normalize_instance_ids(request.get("instancesSet")):
            add(item)

    response = ct_event.get("responseElements")
    if isinstance(response, dict):
        for item in normalize_instance_ids(response.get("instancesSet")):
            add(item)

    for resource in lookup_event.get("Resources", []) or []:
        if isinstance(resource, dict):
            add(resource.get("ResourceName"))

    return ids


def extract_name_from_tag_spec(node: Any) -> str | None:
    if isinstance(node, dict):
        key = node.get("Key")
        if key is None:
            key = node.get("key")
        value = node.get("Value")
        if value is None:
            value = node.get("value")
        if str(key).strip() == "Name" and value is not None:
            text = str(value).strip()
            return text or None
        for item in node.values():
            found = extract_name_from_tag_spec(item)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = extract_name_from_tag_spec(item)
            if found:
                return found
    return None


def extract_launch_metadata(ct_event: dict[str, Any]) -> dict[str, str | None]:
    metadata = {
        "launchName": None,
        "availabilityZone": None,
    }
    request = ct_event.get("requestParameters")
    if isinstance(request, dict):
        metadata["launchName"] = extract_name_from_tag_spec(request.get("tagSpecificationSet")) or extract_name_from_tag_spec(request.get("tags"))
        placement = request.get("placement")
        if isinstance(placement, dict):
            az = placement.get("availabilityZone")
            if az is not None:
                text = str(az).strip()
                metadata["availabilityZone"] = text or None
    response = ct_event.get("responseElements")
    if isinstance(response, dict):
        instances_set = response.get("instancesSet")
        if isinstance(instances_set, dict):
            for item in instances_set.get("items", []) or []:
                if not isinstance(item, dict):
                    continue
                placement = item.get("placement")
                if isinstance(placement, dict):
                    az = placement.get("availabilityZone")
                    if az is not None:
                        text = str(az).strip()
                        metadata["availabilityZone"] = text or metadata["availabilityZone"]
                if metadata["launchName"]:
                    break
    return metadata


def summarize_actor(ct_event: dict[str, Any]) -> dict[str, str | None]:
    user_identity = ct_event.get("userIdentity")
    actor = {
        "principalArn": None,
        "principalType": None,
        "invokedBy": None,
        "actorSummary": None,
    }
    if not isinstance(user_identity, dict):
        return actor

    principal_type = str(user_identity.get("type", "")).strip() or None
    arn = str(user_identity.get("arn", "")).strip() or None
    invoked_by = str(user_identity.get("invokedBy", "")).strip() or None
    principal_id = str(user_identity.get("principalId", "")).strip() or None

    session_context = user_identity.get("sessionContext")
    session_issuer_arn = None
    if isinstance(session_context, dict):
        session_issuer = session_context.get("sessionIssuer")
        if isinstance(session_issuer, dict):
            session_issuer_arn = str(session_issuer.get("arn", "")).strip() or None

    actor_arn = session_issuer_arn or arn
    if principal_type == "AWSService" and invoked_by:
        actor_summary = f"AWSService:{invoked_by}"
        if actor_arn:
            actor_summary = f"{actor_summary} ({actor_arn})"
    elif actor_arn:
        actor_summary = actor_arn
    elif invoked_by:
        actor_summary = f"invokedBy:{invoked_by}"
    else:
        actor_summary = principal_id

    actor["principalArn"] = actor_arn
    actor["principalType"] = principal_type
    actor["invokedBy"] = invoked_by
    actor["actorSummary"] = actor_summary
    return actor


def build_region_scope(args: argparse.Namespace) -> list[str]:
    explicit = [item.strip() for item in (args.regions or "").split(",") if item.strip()] if args.regions else []
    provided = [value for value in [args.region] if value]
    if explicit and provided:
        raise ValueError("Use only one of --region or --regions.")
    if explicit:
        return explicit
    if provided:
        return provided
    if args.all_regions:
        return queryable_ec2_regions(args.profile)
    return queryable_ec2_regions(args.profile)


def cloudtrail_events_for_region(profile: str | None, region: str, start: datetime, end: datetime, event_name: str) -> tuple[list[dict[str, Any]], str | None]:
    try:
        payload = aws_cli_json(
            [
                "cloudtrail",
                "lookup-events",
                "--lookup-attributes",
                f"AttributeKey=EventName,AttributeValue={event_name}",
                "--start-time",
                isoformat(start),
                "--end-time",
                isoformat(end),
                "--max-results",
                "50",
            ],
            profile=profile,
            region=region,
        )
    except AwsCliError as error:
        return [], summarize_errors(error)

    events: list[dict[str, Any]] = []
    for item in payload.get("Events", []) if isinstance(payload, dict) else []:
        if not isinstance(item, dict):
            continue
        event_id = str(item.get("EventId", "")).strip() or None
        event_time = item.get("EventTime")
        ct_raw = item.get("CloudTrailEvent")
        ct_event: dict[str, Any] = {}
        if ct_raw:
            try:
                ct_event = json.loads(ct_raw)
            except Exception:
                ct_event = {}
        instance_ids = extract_instance_ids_from_ct_event(ct_event, item)
        actor = summarize_actor(ct_event)
        response = ct_event.get("responseElements") if isinstance(ct_event, dict) else None
        succeeded = False
        if isinstance(response, dict):
            instances_set = response.get("instancesSet")
            if isinstance(instances_set, dict):
                succeeded = bool(instances_set.get("items"))
        events.append(
            {
                "eventId": event_id,
                "eventTime": event_time if isinstance(event_time, str) else str(event_time),
                "eventName": str(item.get("EventName", "")).strip() or event_name,
                "region": region,
                "sourceIPAddress": ct_event.get("sourceIPAddress"),
                "awsRegion": ct_event.get("awsRegion") or region,
                "principalArn": actor["principalArn"],
                "principalType": actor["principalType"],
                "invokedBy": actor["invokedBy"],
                "actorSummary": actor["actorSummary"],
                "instanceIds": instance_ids,
                "cloudTrailEvent": ct_event,
                "lookupUsername": item.get("Username"),
                "succeeded": succeeded and not ct_event.get("errorCode"),
                "errorCode": ct_event.get("errorCode"),
            }
        )
    return events, None


def describe_terminated_instances(profile: str | None, region: str) -> tuple[list[dict[str, Any]], str | None]:
    try:
        payload = aws_cli_json(
            [
                "ec2",
                "describe-instances",
                "--filters",
                "Name=instance-state-name,Values=terminated",
            ],
            profile=profile,
            region=region,
        )
    except AwsCliError as error:
        return [], summarize_errors(error)

    instances: list[dict[str, Any]] = []
    for reservation in payload.get("Reservations", []) if isinstance(payload, dict) else []:
        if not isinstance(reservation, dict):
            continue
        for inst in reservation.get("Instances", []) or []:
            if not isinstance(inst, dict):
                continue
            instance_id = str(inst.get("InstanceId", "")).strip()
            if not instance_id:
                continue
            instances.append(
                {
                    "instanceId": instance_id,
                    "name": tag_value(inst.get("Tags"), "Name"),
                    "state": str((inst.get("State") or {}).get("Name", "")).strip() or None,
                    "availabilityZone": ((inst.get("Placement") or {}).get("AvailabilityZone")),
                    "stateTransitionReason": inst.get("StateTransitionReason"),
                    "launchTime": inst.get("LaunchTime"),
                    "tags": inst.get("Tags"),
                }
            )
    return instances, None


def describe_asg_membership(profile: str | None, region: str, instance_ids: list[str]) -> tuple[dict[str, dict[str, Any]], str | None]:
    if not instance_ids:
        return {}, None
    try:
        payload = aws_cli_json(
            [
                "autoscaling",
                "describe-auto-scaling-instances",
                "--instance-ids",
                *instance_ids,
            ],
            profile=profile,
            region=region,
        )
    except AwsCliError as error:
        return {}, summarize_errors(error)

    membership: dict[str, dict[str, Any]] = {}
    for item in payload.get("AutoScalingInstances", []) if isinstance(payload, dict) else []:
        if not isinstance(item, dict):
            continue
        instance_id = str(item.get("InstanceId", "")).strip()
        if not instance_id:
            continue
        membership[instance_id] = {
            "autoScalingGroupName": item.get("AutoScalingGroupName"),
            "lifecycleState": item.get("LifecycleState"),
            "healthStatus": item.get("HealthStatus"),
            "protectedFromScaleIn": item.get("ProtectedFromScaleIn"),
        }
    return membership, None


def describe_scaling_activities(profile: str | None, region: str, group_name: str) -> tuple[list[dict[str, Any]], str | None]:
    try:
        payload = aws_cli_json(
            [
                "autoscaling",
                "describe-scaling-activities",
                "--auto-scaling-group-name",
                group_name,
                "--include-deleted-groups",
                "--max-items",
                "100",
            ],
            profile=profile,
            region=region,
        )
    except AwsCliError as error:
        return [], summarize_errors(error)

    activities: list[dict[str, Any]] = []
    for item in payload.get("Activities", []) if isinstance(payload, dict) else []:
        if not isinstance(item, dict):
            continue
        activities.append(
            {
                "activityId": item.get("ActivityId"),
                "cause": item.get("Cause"),
                "description": item.get("Description"),
                "statusCode": item.get("StatusCode"),
                "statusMessage": item.get("StatusMessage"),
                "startTime": item.get("StartTime"),
                "progress": item.get("Progress"),
            }
        )
    return activities, None


def match_activities(activities: list[dict[str, Any]], instance_id: str) -> list[dict[str, Any]]:
    matched: list[dict[str, Any]] = []
    for activity in activities:
        haystack = " ".join(
            str(activity.get(field, "") or "")
            for field in ("cause", "description", "statusMessage")
        )
        if instance_id in haystack:
            matched.append(activity)
    return matched


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit terminated EC2 instances")
    parser.add_argument("--profile")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--region")
    parser.add_argument("--regions")
    parser.add_argument("--all-regions", action="store_true")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    try:
        regions = build_region_scope(args)
    except ValueError as error:
        emit_result(build_result("error", "Invalid region scope provided.", {}, errors=[str(error)]))
        return 1

    if not regions:
        emit_result(build_result("error", "Unable to determine queryable regions.", {}, errors=["No queryable EC2 regions were found for the mounted profile."]))
        return 1

    end_time = utc_now()
    start_time = end_time - timedelta(days=max(1, args.days))

    findings_by_region: dict[str, Any] = {}
    terminate_events_by_instance_by_region: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    terminate_attempts_by_instance_by_region: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    launch_events_by_instance_by_region: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    run_errors: list[str] = []
    any_success = False

    for region in regions:
        region_payload: dict[str, Any] = {
            "region": region,
            "window": {"start": isoformat(start_time), "end": isoformat(end_time)},
        }

        term_events, term_error = cloudtrail_events_for_region(args.profile, region, start_time, end_time, "TerminateInstances")
        if term_error:
            region_payload["cloudTrailTerminateError"] = term_error
            run_errors.append(f"{region} cloudtrail TerminateInstances: {term_error}")
        else:
            any_success = True
        region_payload["cloudTrailTerminateEvents"] = term_events

        for event in term_events:
            for instance_id in event.get("instanceIds", []) or []:
                terminate_attempts_by_instance_by_region[region][str(instance_id)].append(event)
                if event.get("succeeded"):
                    terminate_events_by_instance_by_region[region][str(instance_id)].append(event)

        launch_events, launch_error = cloudtrail_events_for_region(args.profile, region, start_time, end_time, "RunInstances")
        if launch_error:
            region_payload["cloudTrailRunError"] = launch_error
            run_errors.append(f"{region} cloudtrail RunInstances: {launch_error}")
        else:
            any_success = True
        region_payload["cloudTrailRunEvents"] = launch_events
        for event in launch_events:
            if not event.get("succeeded"):
                continue
            metadata = extract_launch_metadata(event.get("cloudTrailEvent") or {})
            for instance_id in event.get("instanceIds", []) or []:
                launch_events_by_instance_by_region[region][str(instance_id)] = {
                    "eventId": event.get("eventId"),
                    "eventTime": event.get("eventTime"),
                    "launchName": metadata.get("launchName"),
                    "availabilityZone": metadata.get("availabilityZone"),
                    "sourceIPAddress": event.get("sourceIPAddress"),
                    "principalArn": event.get("principalArn"),
                    "principalType": event.get("principalType"),
                    "actorSummary": event.get("actorSummary"),
                }

        describe_rows, describe_error = describe_terminated_instances(args.profile, region)
        if describe_error:
            region_payload["describeInstancesError"] = describe_error
            run_errors.append(f"{region} ec2 describe-instances terminated: {describe_error}")
        else:
            any_success = True
        region_payload["terminatedInstances"] = describe_rows
        region_payload["terminatedInstancesById"] = {
            row["instanceId"]: row
            for row in describe_rows
            if isinstance(row, dict) and row.get("instanceId")
        }
        failed_rows = []
        for instance_id, attempts in terminate_attempts_by_instance_by_region.get(region, {}).items():
            if terminate_events_by_instance_by_region.get(region, {}).get(instance_id):
                continue
            failed_rows.append(
                {
                    "instanceId": instance_id,
                    "attempts": [
                        {
                            "eventId": attempt.get("eventId"),
                            "eventTime": attempt.get("eventTime"),
                            "principalArn": attempt.get("principalArn"),
                            "principalType": attempt.get("principalType"),
                            "sourceIPAddress": attempt.get("sourceIPAddress"),
                            "errorCode": attempt.get("errorCode"),
                        }
                        for attempt in attempts
                    ],
                }
            )
        if failed_rows:
            region_payload["failedTerminateAttempts"] = failed_rows

        find_ids = [row["instanceId"] for row in describe_rows if isinstance(row, dict) and row.get("instanceId")]
        memberships, asg_error = describe_asg_membership(args.profile, region, find_ids)
        if asg_error:
            region_payload["asgMembershipError"] = asg_error
            run_errors.append(f"{region} autoscaling describe-auto-scaling-instances: {asg_error}")
        if memberships:
            region_payload["asgMembership"] = memberships
            group_names = sorted({str(item.get("autoScalingGroupName", "")).strip() for item in memberships.values() if item.get("autoScalingGroupName")})
            asg_activities: dict[str, list[dict[str, Any]]] = {}
            asg_activity_errors: dict[str, str] = {}
            for group_name in group_names:
                activities, activity_error = describe_scaling_activities(args.profile, region, group_name)
                if activity_error:
                    asg_activity_errors[group_name] = activity_error
                    run_errors.append(f"{region} autoscaling describe-scaling-activities {group_name}: {activity_error}")
                else:
                    asg_activities[group_name] = activities
            if asg_activities:
                region_payload["asgActivities"] = asg_activities
            if asg_activity_errors:
                region_payload["asgActivityErrors"] = asg_activity_errors

        findings_by_region[region] = region_payload

    merged_rows: list[dict[str, Any]] = []
    for region, payload in findings_by_region.items():
        described_by_id = payload.get("terminatedInstancesById", {}) if isinstance(payload, dict) else {}
        terminate_events_by_instance = terminate_events_by_instance_by_region.get(region, {})
        candidate_instance_ids = sorted(set(terminate_events_by_instance.keys()))
        for instance_id in candidate_instance_ids:
            events = terminate_events_by_instance.get(instance_id, [])
            if not events:
                continue
            sorted_events = sorted(
                events,
                key=lambda item: parse_iso8601(str(item.get("eventTime", "")) or "") or end_time,
            )
            primary_event = sorted_events[0]
            row = described_by_id.get(instance_id, {}) if isinstance(described_by_id, dict) else {}
            memberships = payload.get("asgMembership", {}) if isinstance(payload, dict) else {}
            membership = memberships.get(instance_id, {}) if isinstance(memberships, dict) else {}
            group_name = membership.get("autoScalingGroupName")
            launch_event = launch_events_by_instance_by_region.get(region, {}).get(instance_id, {})
            asg_activities = {}
            if group_name and isinstance(payload, dict):
                asg_activities = payload.get("asgActivities", {}) or {}
            matched_activities: list[dict[str, Any]] = []
            if group_name and isinstance(asg_activities, dict):
                matched_activities = match_activities(asg_activities.get(group_name, []) or [], instance_id)
            merged_rows.append(
                {
                    "instanceId": instance_id,
                    "name": row.get("name") or launch_event.get("launchName"),
                    "terminationTimestamp": primary_event.get("eventTime"),
                    "region": region,
                    "availabilityZone": row.get("availabilityZone") or launch_event.get("availabilityZone"),
                    "launchAvailabilityZone": launch_event.get("availabilityZone"),
                    "launchName": launch_event.get("launchName"),
                    "whoOrWhatTerminated": primary_event.get("actorSummary"),
                    "principalArn": primary_event.get("principalArn"),
                    "principalType": primary_event.get("principalType"),
                    "invokedBy": primary_event.get("invokedBy"),
                    "sourceIp": primary_event.get("sourceIPAddress"),
                    "cloudTrailEventIds": [event.get("eventId") for event in sorted_events if event.get("eventId")],
                    "cloudTrailEventId": primary_event.get("eventId"),
                    "cloudTrailRegions": sorted({str(event.get("region", "")).strip() for event in sorted_events if event.get("region")}),
                    "stateTransitionReason": row.get("stateTransitionReason"),
                    "launchTime": row.get("launchTime"),
                    "launchEventId": launch_event.get("eventId"),
                    "launchEventTime": launch_event.get("eventTime"),
                    "autoScalingGroupName": group_name,
                    "autoScalingLifecycleState": membership.get("lifecycleState"),
                    "autoScalingActivities": matched_activities,
                    "cloudTrailEvidence": [
                        {
                            "eventId": event.get("eventId"),
                            "eventTime": event.get("eventTime"),
                            "sourceIPAddress": event.get("sourceIPAddress"),
                            "actorSummary": event.get("actorSummary"),
                            "principalArn": event.get("principalArn"),
                            "principalType": event.get("principalType"),
                            "invokedBy": event.get("invokedBy"),
                        }
                        for event in sorted_events
                    ],
                }
            )

        describe_only_rows = []
        for instance_id, row in (described_by_id or {}).items():
            if instance_id in terminate_events_by_instance:
                continue
            describe_only_rows.append(
                {
                    "instanceId": instance_id,
                    "name": row.get("name") or launch_event.get("launchName"),
                    "region": region,
                    "availabilityZone": row.get("availabilityZone") or launch_event.get("availabilityZone"),
                    "launchAvailabilityZone": launch_event.get("availabilityZone"),
                    "launchName": launch_event.get("launchName"),
                    "stateTransitionReason": row.get("stateTransitionReason"),
                    "launchTime": row.get("launchTime"),
                    "launchEventId": launch_event.get("eventId"),
                    "launchEventTime": launch_event.get("eventTime"),
                    "note": "Terminated in EC2, but no successful TerminateInstances CloudTrail event was found within the search window.",
                }
            )
        if describe_only_rows:
            region_payload["unattributedTerminatedInstances"] = describe_only_rows
            merged_rows.extend(describe_only_rows)

    merged_rows.sort(
        key=lambda row: (
            parse_iso8601(str(row.get("terminationTimestamp", "")) or "") or end_time,
            str(row.get("instanceId", "")),
        ),
        reverse=True,
    )

    event_count = sum(len(region_events) for region_events_by_instance in terminate_events_by_instance_by_region.values() for region_events in region_events_by_instance.values())
    failed_event_count = sum(len(region_events) for region_events_by_instance in terminate_attempts_by_instance_by_region.values() for region_events in region_events_by_instance.values()) - event_count
    asg_matches = sum(1 for row in merged_rows if row.get("autoScalingGroupName"))
    termination_instance_count = len(merged_rows)
    if termination_instance_count == 0 and any_success:
        status = "ok"
    elif termination_instance_count == 0 and run_errors:
        status = "error"
    elif run_errors:
        status = "partial"
    else:
        status = "ok"

    summary = (
        f"Found {termination_instance_count} terminated EC2 instance(s) with {event_count} successful CloudTrail terminate event(s) "
        f"across {len(regions)} queryable region(s); {asg_matches} instance(s) had Auto Scaling context."
    )
    if failed_event_count:
        summary += f" Also saw {failed_event_count} failed terminate attempt(s) with no success."
    if termination_instance_count == 0 and not run_errors:
        summary = f"No TerminateInstances events were found in the last {args.days} day(s) across {len(regions)} queryable region(s)."

    data = {
        "profile": args.profile,
        "days": max(1, args.days),
        "window": {"start": isoformat(start_time), "end": isoformat(end_time)},
        "regions": regions,
        "terminatedInstances": merged_rows,
        "terminatedInstanceCount": termination_instance_count,
        "cloudTrailEventCount": event_count,
        "failedCloudTrailEventCount": failed_event_count,
        "autoScalingMatchedCount": asg_matches,
        "regionFindings": findings_by_region,
        "errors": run_errors,
    }

    artifacts = []
    artifact = write_json_artifact(
        args.output_dir,
        "ec2_terminated_instance_audit.json",
        data,
        label="EC2 terminated instance audit",
        summary=summary,
    )
    if artifact:
        artifacts.append(artifact)

    emit_result(build_result(status, summary, data, artifacts=artifacts, errors=run_errors))
    return 0 if status != "error" else 1


if __name__ == "__main__":
    raise SystemExit(main())
