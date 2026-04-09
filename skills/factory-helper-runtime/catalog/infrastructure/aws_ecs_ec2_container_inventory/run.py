#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable

RUNTIME_ROOT = Path(__file__).resolve().parents[3]

import sys

sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, queryable_ec2_regions, summarize_errors, write_json_artifact


def chunked(items: list[str], size: int) -> Iterable[list[str]]:
    for index in range(0, len(items), size):
        yield items[index : index + size]


def cluster_name(cluster_arn: str) -> str:
    return cluster_arn.rsplit("/", 1)[-1]


def service_or_task_def(task: dict[str, Any]) -> str:
    service_name = str(task.get("serviceName") or "").strip()
    if service_name:
        return service_name
    group = str(task.get("group") or "").strip()
    if group.startswith("service:"):
        return group.split(":", 1)[1]
    task_def = str(task.get("taskDefinitionArn") or "").strip()
    return task_def or group or ""


def first_private_ip(instance: dict[str, Any]) -> str:
    private_ip = instance.get("PrivateIpAddress")
    if isinstance(private_ip, str) and private_ip.strip():
        return private_ip.strip()
    for network_interface in instance.get("NetworkInterfaces", []):
        if not isinstance(network_interface, dict):
            continue
        ip = network_interface.get("PrivateIpAddress")
        if isinstance(ip, str) and ip.strip():
            return ip.strip()
    return ""


def markdown_escape(value: Any) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "\\|").replace("\n", " ").strip()


def render_markdown_table(rows: list[dict[str, Any]]) -> str:
    columns = [
        "region",
        "cluster",
        "serviceOrTaskDef",
        "taskArn",
        "containerName",
        "containerInstanceArn",
        "ec2InstanceId",
        "privateIp",
        "image",
        "lastStatus",
        "startedAt",
        "cpu",
        "memory",
    ]
    lines = [
        "| " + " | ".join(columns) + " |",
        "| " + " | ".join(["---"] * len(columns)) + " |",
    ]
    for row in rows:
        lines.append(
            "| "
            + " | ".join(markdown_escape(row.get(column, "")) for column in columns)
            + " |"
        )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Inventory ECS containers running on EC2")
    parser.add_argument("--profile")
    parser.add_argument("--region")
    parser.add_argument("--regions")
    parser.add_argument("--all-regions", action="store_true")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    if args.regions:
        regions = [item.strip() for item in args.regions.split(",") if item.strip()]
    elif args.all_regions:
        try:
            regions = queryable_ec2_regions(args.profile)
        except AwsCliError as error:
            emit_result(build_result("error", "Unable to resolve queryable regions for ECS inventory.", {}, errors=[summarize_errors(error)]))
            return 1
    elif args.region:
        regions = [args.region]
    else:
        try:
            regions = queryable_ec2_regions(args.profile)
        except AwsCliError as error:
            emit_result(build_result("error", "Unable to resolve queryable regions for ECS inventory.", {}, errors=[summarize_errors(error)]))
            return 1

    region_errors: list[str] = []
    region_cluster_counts: dict[str, int] = {}
    rows: list[dict[str, Any]] = []
    unique_clusters: set[str] = set()
    unique_tasks: set[str] = set()
    unique_ec2_tasks: set[str] = set()
    unique_container_instances: set[str] = set()
    unique_ec2_instances: set[str] = set()
    running_task_count = 0

    for region in regions:
        try:
            cluster_arns = aws_cli_json(["ecs", "list-clusters", "--query", "clusterArns[]"], profile=args.profile, region=region)
        except AwsCliError as error:
            region_errors.append(f"{region}: {summarize_errors(error)}")
            continue

        if not isinstance(cluster_arns, list):
            cluster_arns = []
        region_cluster_counts[region] = len(cluster_arns)
        if not cluster_arns:
            continue

        for cluster_arn in cluster_arns:
            if not isinstance(cluster_arn, str) or not cluster_arn.strip():
                continue
            unique_clusters.add(cluster_arn)
            try:
                task_arns = aws_cli_json(
                    ["ecs", "list-tasks", "--cluster", cluster_arn, "--desired-status", "RUNNING", "--query", "taskArns[]"],
                    profile=args.profile,
                    region=region,
                )
            except AwsCliError as error:
                region_errors.append(f"{region} {cluster_name(cluster_arn)} list-tasks: {summarize_errors(error)}")
                continue

            if not isinstance(task_arns, list):
                task_arns = []
            running_task_count += len(task_arns)
            if not task_arns:
                continue

            task_payloads: list[dict[str, Any]] = []
            for task_batch in chunked([task for task in task_arns if isinstance(task, str) and task.strip()], 100):
                if not task_batch:
                    continue
                try:
                    response = aws_cli_json(
                        ["ecs", "describe-tasks", "--cluster", cluster_arn, "--tasks", *task_batch],
                        profile=args.profile,
                        region=region,
                    )
                except AwsCliError as error:
                    region_errors.append(f"{region} {cluster_name(cluster_arn)} describe-tasks: {summarize_errors(error)}")
                    continue
                tasks = response.get("tasks", []) if isinstance(response, dict) else []
                if isinstance(tasks, list):
                    task_payloads.extend(item for item in tasks if isinstance(item, dict))
                failures = response.get("failures", []) if isinstance(response, dict) else []
                for failure in failures if isinstance(failures, list) else []:
                    if isinstance(failure, dict):
                        region_errors.append(
                            f"{region} {cluster_name(cluster_arn)} task failure: {json.dumps(failure, sort_keys=True)}"
                        )

            ec2_tasks = [task for task in task_payloads if str(task.get("launchType") or "").upper() == "EC2"]
            unique_ec2_tasks.update(str(task.get("taskArn") or "") for task in ec2_tasks if str(task.get("taskArn") or "").strip())
            if not ec2_tasks:
                continue

            container_instance_arns = sorted(
                {
                    str(task.get("containerInstanceArn") or "").strip()
                    for task in ec2_tasks
                    if str(task.get("containerInstanceArn") or "").strip()
                }
            )
            container_instance_map: dict[str, str] = {}
            if container_instance_arns:
                unique_container_instances.update(container_instance_arns)
                for arn_batch in chunked(container_instance_arns, 100):
                    try:
                        response = aws_cli_json(
                            ["ecs", "describe-container-instances", "--cluster", cluster_arn, "--container-instances", *arn_batch],
                            profile=args.profile,
                            region=region,
                        )
                    except AwsCliError as error:
                        region_errors.append(f"{region} {cluster_name(cluster_arn)} describe-container-instances: {summarize_errors(error)}")
                        continue
                    for container_instance in response.get("containerInstances", []) if isinstance(response, dict) else []:
                        if not isinstance(container_instance, dict):
                            continue
                        arn = str(container_instance.get("containerInstanceArn") or "").strip()
                        ec2_instance_id = str(container_instance.get("ec2InstanceId") or "").strip()
                        if arn and ec2_instance_id:
                            container_instance_map[arn] = ec2_instance_id
                            unique_ec2_instances.add(ec2_instance_id)

            ec2_instance_map: dict[str, dict[str, Any]] = {}
            region_ec2_instance_ids = sorted(set(container_instance_map.values()))
            if region_ec2_instance_ids:
                for id_batch in chunked(region_ec2_instance_ids, 100):
                    try:
                        response = aws_cli_json(
                            ["ec2", "describe-instances", "--instance-ids", *id_batch],
                            profile=args.profile,
                            region=region,
                        )
                    except AwsCliError as error:
                        region_errors.append(f"{region} {cluster_name(cluster_arn)} describe-instances: {summarize_errors(error)}")
                        continue
                    reservations = response.get("Reservations", []) if isinstance(response, dict) else []
                    for reservation in reservations if isinstance(reservations, list) else []:
                        if not isinstance(reservation, dict):
                            continue
                        for instance in reservation.get("Instances", []):
                            if not isinstance(instance, dict):
                                continue
                            instance_id = str(instance.get("InstanceId") or "").strip()
                            if instance_id:
                                ec2_instance_map[instance_id] = instance

            for task in ec2_tasks:
                task_arn = str(task.get("taskArn") or "").strip()
                container_instance_arn = str(task.get("containerInstanceArn") or "").strip()
                ec2_instance_id = container_instance_map.get(container_instance_arn, "")
                instance = ec2_instance_map.get(ec2_instance_id, {})
                private_ip = first_private_ip(instance) if isinstance(instance, dict) else ""
                task_started_at = str(task.get("startedAt") or "").strip()
                task_cpu = str(task.get("cpu") or "").strip()
                task_memory = str(task.get("memory") or "").strip()
                for container in task.get("containers", []):
                    if not isinstance(container, dict):
                        continue
                    rows.append(
                        {
                            "region": region,
                            "cluster": cluster_name(cluster_arn),
                            "serviceOrTaskDef": service_or_task_def(task),
                            "taskArn": task_arn,
                            "containerName": str(container.get("name") or "").strip(),
                            "containerInstanceArn": container_instance_arn,
                            "ec2InstanceId": ec2_instance_id,
                            "privateIp": private_ip,
                            "image": str(container.get("image") or "").strip(),
                            "lastStatus": str(container.get("lastStatus") or "").strip(),
                            "startedAt": str(container.get("startedAt") or task_started_at).strip(),
                            "cpu": str(container.get("cpu") or task_cpu).strip(),
                            "memory": str(container.get("memory") or task_memory).strip(),
                        }
                    )

    rows.sort(key=lambda row: (row.get("region", ""), row.get("cluster", ""), row.get("taskArn", ""), row.get("containerName", "")))

    markdown_report = [
        "# ECS containers on EC2",
        "",
        f"- Regions scanned: {len(regions)}",
        f"- Regions with ECS clusters: {sum(1 for count in region_cluster_counts.values() if count)}",
        f"- Clusters found: {len(unique_clusters)}",
        f"- Running tasks discovered: {running_task_count}",
        f"- EC2 launch tasks: {len(unique_ec2_tasks)}",
        f"- Unique container instances: {len(unique_container_instances)}",
        f"- Unique EC2 instances: {len(unique_ec2_instances)}",
        f"- Container rows: {len(rows)}",
    ]
    if region_errors:
        markdown_report.extend(["", "## Region warnings"])
        markdown_report.extend([f"- {error}" for error in region_errors])
    markdown_report.extend(["", "## Table", "", render_markdown_table(rows)])
    if not rows:
        markdown_report.extend(["", "No ECS containers on EC2 were found in the scanned regions."])

    summary = (
        f"Scanned {len(regions)} region(s); found {len(unique_clusters)} ECS cluster(s), "
        f"{running_task_count} running task(s), {len(unique_ec2_tasks)} EC2 launch task(s), and {len(rows)} container row(s)."
    )
    if not rows and not region_errors:
        summary = f"No ECS containers on EC2 were found across {len(regions)} queryable region(s)."
    elif region_errors:
        summary += f" Encountered {len(region_errors)} region/API warning(s)."

    if rows and region_errors:
        status = "partial"
    elif not rows and region_errors:
        status = "error"
    else:
        status = "ok"

    data = {
        "profile": args.profile,
        "regions": regions,
        "regionClusterCounts": region_cluster_counts,
        "regionsWithClusters": [region for region, count in region_cluster_counts.items() if count],
        "clusterCount": len(unique_clusters),
        "runningTaskCount": running_task_count,
        "ec2TaskCount": len(unique_ec2_tasks),
        "containerInstanceCount": len(unique_container_instances),
        "ec2InstanceCount": len(unique_ec2_instances),
        "containerRowCount": len(rows),
        "rows": rows,
        "warnings": region_errors,
    }

    artifacts: list[dict[str, Any]] = []
    json_artifact = write_json_artifact(
        args.output_dir,
        "aws_ecs_ec2_container_inventory.json",
        data,
        label="ECS EC2 container inventory",
        summary=summary,
    )
    if json_artifact:
        artifacts.append(json_artifact)

    if args.output_dir:
        output_dir = Path(args.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        markdown_path = output_dir / "aws_ecs_ec2_container_inventory.md"
        markdown_path.write_text("\n".join(markdown_report) + "\n", encoding="utf-8")
        artifacts.append(
            {
                "label": "ECS EC2 container markdown report",
                "path": str(markdown_path),
                "summary": "Markdown inventory table and counts.",
            }
        )

    emit_result(build_result(status, summary, data, artifacts=artifacts, errors=region_errors))
    return 0 if status != "error" else 1


if __name__ == "__main__":
    raise SystemExit(main())
