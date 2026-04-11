#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shlex
from hashlib import sha1
import sys
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, queryable_ec2_regions, summarize_errors, write_json_artifact


def unique_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for row in rows:
      marker = json.dumps(row, sort_keys=True)
      if marker in seen:
        continue
      seen.add(marker)
      deduped.append(row)
    return deduped


def render_markdown(summary: dict[str, Any]) -> str:
    counts = summary["counts"]
    lines = [
        f"Generated: {summary['capturedAt']}",
        f"Account: {summary['account']['Account']} ({summary['account']['Arn']})",
        f"Queryable regions: {len(summary['regions'])}",
        f"Public ENIs: {counts['publicEnis']}",
        f"Internet-facing ELBv2 load balancers: {counts['internetFacingLoadBalancers']}",
        f"Internet-facing classic ELBs: {counts['internetFacingClassicElbs']}",
        f"Open security groups: {counts['openSecurityGroups']}",
        f"Public RDS instances: {counts['publicRdsInstances']}",
        f"Public S3 buckets: {counts['publicS3Buckets']}",
    ]
    if summary["warnings"]:
        lines.append("Warnings:")
        for warning in summary["warnings"][:25]:
            lines.append(f"- {warning}")
    if summary.get("evidenceItems"):
        lines.append("")
        lines.append("## Proof")
        for item in summary["evidenceItems"][:25]:
            lines.append(f"### {item['claim_ref']}")
            lines.append(f"- SG ID: {item['parsed'].get('groupId')}")
            lines.append(f"- Region: {item.get('region')}")
            lines.append(f"- Command: {item.get('command')}")
            for rule in item.get("parsed", {}).get("offendingIpPermissions", []):
                cidrs = ", ".join(rule.get("cidrs", [])) or "none"
                lines.append(
                    f"- Rule: {rule.get('ipProtocol')} {rule.get('fromPort')}->{rule.get('toPort')} cidr={cidrs}"
                )
    return "\n".join(lines) + "\n"


def quoted(value: str) -> str:
    return shlex.quote(value)


def evidence_id(seed: str) -> str:
    return f"evidence-{sha1(seed.encode('utf-8')).hexdigest()[:12]}"


def build_security_group_evidence(
    *,
    profile: str | None,
    account_id: str | None,
    region: str,
    group: dict[str, Any],
    output_dir: str | None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    group_id = str(group.get("GroupId") or "").strip()
    command = f"aws ec2 describe-security-groups --group-ids {quoted(group_id)} --region {quoted(region)}"
    raw = aws_cli_json(["ec2", "describe-security-groups", "--group-ids", group_id], profile=profile, region=region)
    offending: list[dict[str, Any]] = []
    for permission in group.get("IpPermissions", []):
        ipv4 = [item.get("CidrIp") for item in permission.get("IpRanges", []) if item.get("CidrIp") == "0.0.0.0/0"]
        ipv6 = [item.get("CidrIpv6") for item in permission.get("Ipv6Ranges", []) if item.get("CidrIpv6") == "::/0"]
        if not ipv4 and not ipv6:
            continue
        offending.append({
            "ipProtocol": permission.get("IpProtocol"),
            "fromPort": permission.get("FromPort"),
            "toPort": permission.get("ToPort"),
            "cidrs": [*ipv4, *ipv6],
        })
    evidence = {
        "id": evidence_id(f"{region}:{group_id}"),
        "type": "cli_output",
        "claim_ref": f"sg:{group_id}",
        "timestamp": build_result("ok", "", {})["capturedAt"],
        "collection_method": "aws ec2 describe-security-groups",
        "command": command,
        "raw": raw,
        "parsed": {
            "groupId": group_id,
            "groupArn": f"arn:aws:ec2:{region}:*:security-group/{group_id}",
            "offendingIpPermissions": offending,
        },
        "resource_arns": [f"arn:aws:ec2:{region}:*:security-group/{group_id}"],
        "region": region,
        "account_id": account_id,
    }
    artifact = write_json_artifact(
        output_dir,
        f"{evidence['id']}.json",
        evidence,
        label=f"Security group evidence {group_id}",
        summary=f"Structured proof for security group {group_id} in {region}.",
    )
    return evidence, artifact


def main() -> int:
    parser = argparse.ArgumentParser(description="Inventory AWS internet exposure surfaces")
    parser.add_argument("--profile")
    parser.add_argument("--region")
    parser.add_argument("--regions")
    parser.add_argument("--all-regions", action="store_true")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    if args.all_regions:
        regions = queryable_ec2_regions(profile=args.profile)
    elif args.regions:
        regions = [item.strip() for item in args.regions.split(",") if item.strip()]
    elif args.region:
        regions = [args.region.strip()]
    else:
        regions = queryable_ec2_regions(profile=args.profile)

    warnings: list[str] = []

    try:
        account = aws_cli_json(["sts", "get-caller-identity"], profile=args.profile)
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            "Unable to capture the active AWS caller identity for internet exposure inventory.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    public_enis: list[dict[str, Any]] = []
    internet_facing_load_balancers: list[dict[str, Any]] = []
    internet_facing_classic_elbs: list[dict[str, Any]] = []
    open_security_groups: list[dict[str, Any]] = []
    security_group_evidence_items: list[dict[str, Any]] = []
    public_rds_instances: list[dict[str, Any]] = []
    public_s3_buckets: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []

    try:
        buckets = aws_cli_json(["s3api", "list-buckets"], profile=args.profile).get("Buckets", [])
    except AwsCliError as error:
        warnings.append(f"s3 list-buckets failed: {summarize_errors(error)}")
        buckets = []

    for bucket in buckets:
        name = str(bucket.get("Name", "")).strip()
        if not name:
            continue
        finding: dict[str, Any] = {
            "bucket": name,
            "policyPublic": None,
            "aclPublic": None,
            "publicAccessBlock": None,
            "notes": [],
        }
        try:
            policy_status = aws_cli_json(["s3api", "get-bucket-policy-status", "--bucket", name], profile=args.profile)
            finding["policyPublic"] = bool(policy_status.get("PolicyStatus", {}).get("IsPublic"))
        except AwsCliError as error:
            finding["notes"].append(f"policy-status:{summarize_errors(error)}")
        try:
            acl = aws_cli_json(["s3api", "get-bucket-acl", "--bucket", name], profile=args.profile)
            grants = acl.get("Grants", [])
            finding["aclPublic"] = any(
                str(grant.get("Grantee", {}).get("URI", "")) in {
                    "http://acs.amazonaws.com/groups/global/AllUsers",
                    "http://acs.amazonaws.com/groups/global/AuthenticatedUsers",
                }
                for grant in grants
            )
        except AwsCliError as error:
            finding["notes"].append(f"bucket-acl:{summarize_errors(error)}")
        try:
            pab = aws_cli_json(["s3api", "get-public-access-block", "--bucket", name], profile=args.profile)
            finding["publicAccessBlock"] = pab.get("PublicAccessBlockConfiguration")
        except AwsCliError:
            finding["notes"].append("no-bucket-public-access-block")
        if finding["policyPublic"] or finding["aclPublic"]:
            public_s3_buckets.append(finding)

    for region in regions:
        try:
            enis = aws_cli_json(
                ["ec2", "describe-network-interfaces", "--filters", "Name=association.public-ip,Values=*", "--query",
                 "NetworkInterfaces[].{networkInterfaceId:NetworkInterfaceId,description:Description,publicIp:Association.PublicIp,privateIp:PrivateIpAddress,instanceId:Attachment.InstanceId,subnetId:SubnetId,securityGroups:Groups[].GroupId}"],
                profile=args.profile,
                region=region,
            )
            for eni in enis:
                row = dict(eni)
                row["region"] = region
                public_enis.append(row)
        except AwsCliError as error:
            warnings.append(f"{region} ENI query failed: {summarize_errors(error)}")

        try:
            groups = aws_cli_json(["ec2", "describe-security-groups"], profile=args.profile, region=region).get("SecurityGroups", [])
            for group in groups:
                open_rules: list[dict[str, Any]] = []
                evidence_item: dict[str, Any] | None = None
                for permission in group.get("IpPermissions", []):
                    ipv4 = [item.get("CidrIp") for item in permission.get("IpRanges", []) if item.get("CidrIp") == "0.0.0.0/0"]
                    ipv6 = [item.get("CidrIpv6") for item in permission.get("Ipv6Ranges", []) if item.get("CidrIpv6") == "::/0"]
                    if not ipv4 and not ipv6:
                        continue
                    open_rules.append({
                        "ipProtocol": permission.get("IpProtocol"),
                        "fromPort": permission.get("FromPort"),
                        "toPort": permission.get("ToPort"),
                        "ipv4": ipv4,
                        "ipv6": ipv6,
                    })
                if open_rules:
                    evidence_item, evidence_artifact = build_security_group_evidence(
                        profile=args.profile,
                        account_id=str(account.get("Account") or "").strip() or None,
                        region=region,
                        group=group,
                        output_dir=args.output_dir,
                    )
                    if evidence_artifact:
                        artifacts.append(evidence_artifact)
                    security_group_evidence_items.append(evidence_item)
                    open_security_groups.append({
                        "region": region,
                        "groupId": group.get("GroupId"),
                        "groupName": group.get("GroupName"),
                        "vpcId": group.get("VpcId"),
                        "openRules": open_rules,
                        "evidenceId": evidence_item["id"] if evidence_item else None,
                    })
        except AwsCliError as error:
            warnings.append(f"{region} security-group query failed: {summarize_errors(error)}")

        try:
            load_balancers = aws_cli_json(["elbv2", "describe-load-balancers"], profile=args.profile, region=region).get("LoadBalancers", [])
            for load_balancer in load_balancers:
                if load_balancer.get("Scheme") != "internet-facing":
                    continue
                internet_facing_load_balancers.append({
                    "region": region,
                    "name": load_balancer.get("LoadBalancerName"),
                    "arn": load_balancer.get("LoadBalancerArn"),
                    "type": load_balancer.get("Type"),
                    "dnsName": load_balancer.get("DNSName"),
                    "state": load_balancer.get("State", {}).get("Code"),
                    "vpcId": load_balancer.get("VpcId"),
                })
        except AwsCliError as error:
            warnings.append(f"{region} elbv2 query failed: {summarize_errors(error)}")

        try:
            classic_elbs = aws_cli_json(["elb", "describe-load-balancers"], profile=args.profile, region=region).get("LoadBalancerDescriptions", [])
            for load_balancer in classic_elbs:
                if load_balancer.get("Scheme", "internet-facing") != "internet-facing":
                    continue
                internet_facing_classic_elbs.append({
                    "region": region,
                    "name": load_balancer.get("LoadBalancerName"),
                    "dnsName": load_balancer.get("DNSName"),
                    "instances": [instance.get("InstanceId") for instance in load_balancer.get("Instances", [])],
                    "securityGroups": load_balancer.get("SecurityGroups", []),
                    "subnets": load_balancer.get("Subnets", []),
                })
        except AwsCliError as error:
            warnings.append(f"{region} classic-elb query failed: {summarize_errors(error)}")

        try:
            instances = aws_cli_json(["rds", "describe-db-instances"], profile=args.profile, region=region).get("DBInstances", [])
            for instance in instances:
                if not instance.get("PubliclyAccessible"):
                    continue
                public_rds_instances.append({
                    "region": region,
                    "dbInstanceIdentifier": instance.get("DBInstanceIdentifier"),
                    "engine": instance.get("Engine"),
                    "status": instance.get("DBInstanceStatus"),
                    "endpoint": instance.get("Endpoint", {}).get("Address"),
                    "port": instance.get("Endpoint", {}).get("Port"),
                })
        except AwsCliError as error:
            warnings.append(f"{region} rds query failed: {summarize_errors(error)}")

    summary = {
        "account": account,
        "regions": regions,
        "counts": {
            "publicEnis": len(public_enis),
            "internetFacingLoadBalancers": len(internet_facing_load_balancers),
            "internetFacingClassicElbs": len(internet_facing_classic_elbs),
            "openSecurityGroups": len(open_security_groups),
            "publicRdsInstances": len(public_rds_instances),
            "publicS3Buckets": len(public_s3_buckets),
        },
        "findings": {
            "publicEnis": unique_rows(public_enis),
            "internetFacingLoadBalancers": unique_rows(internet_facing_load_balancers),
            "internetFacingClassicElbs": unique_rows(internet_facing_classic_elbs),
            "openSecurityGroups": unique_rows(open_security_groups),
            "publicRdsInstances": unique_rows(public_rds_instances),
            "publicS3Buckets": unique_rows(public_s3_buckets),
        },
        "warnings": warnings,
        "evidenceItems": unique_rows(security_group_evidence_items),
        "capturedAt": account and build_result("ok", "", {})["capturedAt"],
    }

    json_artifact = write_json_artifact(
        args.output_dir,
        "aws_internet_exposure_inventory.json",
        summary,
        label="AWS internet exposure inventory",
        summary="Inventory of public ENIs, internet-facing load balancers, open security groups, public RDS, and public S3 buckets.",
    )
    if json_artifact:
        artifacts.append(json_artifact)
        markdown_path = Path(json_artifact["path"]).with_suffix(".md")
        markdown_path.write_text(render_markdown(summary), encoding="utf-8")
        artifacts.append({
            "label": "AWS internet exposure markdown report",
            "path": str(markdown_path),
            "summary": "Top-line counts and warning summary for the exposure inventory.",
        })

    summary_line = (
        f"Inventory captured {summary['counts']['internetFacingLoadBalancers']} internet-facing ELBv2 load balancer(s), "
        f"{summary['counts']['internetFacingClassicElbs']} classic ELB(s), "
        f"{summary['counts']['publicEnis']} public ENI(s), "
        f"{summary['counts']['openSecurityGroups']} open security group(s), "
        f"{summary['counts']['publicRdsInstances']} public RDS instance(s), and "
        f"{summary['counts']['publicS3Buckets']} public S3 bucket(s) across {len(regions)} region(s)."
    )
    if summary["evidenceItems"]:
        summary_line += f" Evidence IDs: {', '.join(item['id'] for item in summary['evidenceItems'][:10])}."
    emit_result(build_result("ok", summary_line, summary, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
