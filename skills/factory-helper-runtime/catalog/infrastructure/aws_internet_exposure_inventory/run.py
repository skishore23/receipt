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


PUBLIC_ACL_URIS = {
    "http://acs.amazonaws.com/groups/global/AllUsers",
    "http://acs.amazonaws.com/groups/global/AuthenticatedUsers",
}


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


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def quoted(value: str) -> str:
    return shlex.quote(value)


def evidence_id(seed: str) -> str:
    return f"evidence-{sha1(seed.encode('utf-8')).hexdigest()[:12]}"


def expected_missing(detail: str, *markers: str) -> bool:
    normalized = detail.lower()
    return any(marker.lower() in normalized for marker in markers)


def render_markdown(summary: dict[str, Any]) -> str:
    counts = summary["counts"]
    lines = [
        f"Generated: {summary['capturedAt']}",
        f"Account: {summary['account']['Account']} ({summary['account']['Arn']})",
        f"Queryable regions: {len(summary['regions'])}",
        f"CloudFront distributions: {counts['cloudFrontDistributions']}",
        f"Public REST APIs: {counts['publicApiGatewayRestApis']}",
        f"Public HTTP/WebSocket APIs: {counts['publicApiGatewayV2Apis']}",
        f"Public ENIs: {counts['publicEnis']}",
        f"Internet-facing ELBv2 load balancers: {counts['internetFacingLoadBalancers']}",
        f"Internet-facing classic ELBs: {counts['internetFacingClassicElbs']}",
        f"Open security groups: {counts['openSecurityGroups']}",
        f"Public Lambda URLs: {counts['publicLambdaUrls']}",
        f"Public Lambda policies: {counts['publicLambdaPolicies']}",
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
                lines.append(f"- Rule: {rule.get('ipProtocol')} {rule.get('fromPort')}->{rule.get('toPort')} cidr={cidrs}")
    return "\n".join(lines) + "\n"


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
    for permission in as_list(group.get("IpPermissions")):
        if not isinstance(permission, dict):
            continue
        ipv4 = [item.get("CidrIp") for item in as_list(permission.get("IpRanges")) if isinstance(item, dict) and item.get("CidrIp") == "0.0.0.0/0"]
        ipv6 = [item.get("CidrIpv6") for item in as_list(permission.get("Ipv6Ranges")) if isinstance(item, dict) and item.get("CidrIpv6") == "::/0"]
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


def list_cloudfront_distributions(profile: str | None) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    try:
        payload = aws_cli_json(["cloudfront", "list-distributions"], profile=profile)
    except AwsCliError as error:
        warnings.append(f"cloudfront query failed: {summarize_errors(error)}")
        return [], warnings
    distribution_list = as_dict(payload.get("DistributionList"))
    results: list[dict[str, Any]] = []
    for item in as_list(distribution_list.get("Items")):
        if not isinstance(item, dict):
            continue
        if item.get("Enabled") is False:
            continue
        results.append({
            "id": item.get("Id"),
            "arn": item.get("ARN"),
            "domainName": item.get("DomainName"),
            "aliases": as_list(as_dict(item.get("Aliases")).get("Items")),
            "status": item.get("Status"),
            "origins": len(as_list(as_dict(item.get("Origins")).get("Items"))),
        })
    return results, warnings


def list_public_rest_apis(profile: str | None, region: str) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    try:
        payload = aws_cli_json(["apigateway", "get-rest-apis"], profile=profile, region=region)
    except AwsCliError as error:
        warnings.append(f"{region} api-gateway-rest query failed: {summarize_errors(error)}")
        return [], warnings
    results: list[dict[str, Any]] = []
    for item in as_list(payload.get("items")):
        if not isinstance(item, dict):
            continue
        endpoint_types = [str(value).strip() for value in as_list(as_dict(item.get("endpointConfiguration")).get("types")) if str(value).strip()]
        if endpoint_types and all(endpoint == "PRIVATE" for endpoint in endpoint_types):
            continue
        api_id = str(item.get("id") or "").strip()
        if not api_id:
            continue
        results.append({
            "region": region,
            "id": api_id,
            "name": item.get("name"),
            "endpointTypes": endpoint_types or ["EDGE"],
            "executeApiEndpoint": f"https://{api_id}.execute-api.{region}.amazonaws.com",
        })
    return results, warnings


def list_public_v2_apis(profile: str | None, region: str) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    try:
        payload = aws_cli_json(["apigatewayv2", "get-apis"], profile=profile, region=region)
    except AwsCliError as error:
        warnings.append(f"{region} api-gateway-v2 query failed: {summarize_errors(error)}")
        return [], warnings
    results: list[dict[str, Any]] = []
    for item in as_list(payload.get("Items")):
        if not isinstance(item, dict):
            continue
        if item.get("DisableExecuteApiEndpoint") is True:
            continue
        endpoint = str(item.get("ApiEndpoint") or "").strip()
        if not endpoint:
            continue
        results.append({
            "region": region,
            "apiId": item.get("ApiId"),
            "name": item.get("Name"),
            "protocolType": item.get("ProtocolType"),
            "apiEndpoint": endpoint,
        })
    return results, warnings


def function_policy_is_public(policy_document: dict[str, Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    for statement in as_list(policy_document.get("Statement")):
        if not isinstance(statement, dict):
            continue
        principal = statement.get("Principal")
        principal_values: list[str] = []
        if principal == "*":
            principal_values.append("*")
        elif isinstance(principal, dict):
            for value in principal.values():
                if isinstance(value, list):
                    principal_values.extend(str(item).strip() for item in value if str(item).strip())
                elif value is not None:
                    principal_values.append(str(value).strip())
        actions = statement.get("Action")
        action_values = [actions] if isinstance(actions, str) else as_list(actions)
        normalized_actions = [str(value).strip() for value in action_values if str(value).strip()]
        if "*" not in principal_values:
            continue
        if not any(action in {"*", "lambda:*", "lambda:InvokeFunction", "lambda:InvokeFunctionUrl"} for action in normalized_actions):
            continue
        sid = str(statement.get("Sid") or "statement").strip()
        reasons.append(f"{sid}:{','.join(normalized_actions) or 'unknown-action'}")
    return bool(reasons), reasons


def collect_lambda_public_surfaces(profile: str | None, region: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    try:
        payload = aws_cli_json(["lambda", "list-functions"], profile=profile, region=region)
    except AwsCliError as error:
        warnings.append(f"{region} lambda list-functions failed: {summarize_errors(error)}")
        return [], [], warnings

    public_urls: list[dict[str, Any]] = []
    public_policies: list[dict[str, Any]] = []
    for function in as_list(payload.get("Functions")):
        if not isinstance(function, dict):
            continue
        function_name = str(function.get("FunctionName") or "").strip()
        function_arn = str(function.get("FunctionArn") or "").strip()
        if not function_name:
            continue

        try:
            url_config = aws_cli_json(["lambda", "get-function-url-config", "--function-name", function_name], profile=profile, region=region)
            if str(url_config.get("AuthType") or "").strip() == "NONE":
                public_urls.append({
                    "region": region,
                    "functionName": function_name,
                    "functionArn": function_arn,
                    "functionUrl": url_config.get("FunctionUrl"),
                    "authType": url_config.get("AuthType"),
                })
        except AwsCliError as error:
            detail = summarize_errors(error)
            if not expected_missing(detail, "ResourceNotFoundException", "FunctionUrlConfig not found", "The resource you requested does not exist"):
                warnings.append(f"{region} lambda url config failed for {function_name}: {detail}")

        try:
            raw_policy = aws_cli_json(["lambda", "get-policy", "--function-name", function_name], profile=profile, region=region)
            policy_string = str(raw_policy.get("Policy") or "").strip()
            policy_document = json.loads(policy_string) if policy_string else {}
            is_public, reasons = function_policy_is_public(as_dict(policy_document))
            if is_public:
                public_policies.append({
                    "region": region,
                    "functionName": function_name,
                    "functionArn": function_arn,
                    "statementReasons": reasons,
                })
        except AwsCliError as error:
            detail = summarize_errors(error)
            if not expected_missing(detail, "ResourceNotFoundException", "ResourceNotFound", "The resource you requested does not exist"):
                warnings.append(f"{region} lambda policy query failed for {function_name}: {detail}")
        except json.JSONDecodeError as error:
            warnings.append(f"{region} lambda policy parse failed for {function_name}: {error}")

    return public_urls, public_policies, warnings


def collect_s3_public_buckets(profile: str | None) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    try:
        buckets = as_list(as_dict(aws_cli_json(["s3api", "list-buckets"], profile=profile)).get("Buckets"))
    except AwsCliError as error:
        warnings.append(f"s3 list-buckets failed: {summarize_errors(error)}")
        return [], warnings

    public_s3_buckets: list[dict[str, Any]] = []
    for bucket in buckets:
        if not isinstance(bucket, dict):
            continue
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
            policy_status = aws_cli_json(["s3api", "get-bucket-policy-status", "--bucket", name], profile=profile)
            finding["policyPublic"] = bool(as_dict(policy_status.get("PolicyStatus")).get("IsPublic"))
        except AwsCliError as error:
            detail = summarize_errors(error)
            if expected_missing(detail, "NoSuchBucketPolicy"):
                finding["policyPublic"] = False
            else:
                finding["notes"].append(f"policy-status:{detail}")
        try:
            acl = aws_cli_json(["s3api", "get-bucket-acl", "--bucket", name], profile=profile)
            finding["aclPublic"] = any(
                str(as_dict(grant.get("Grantee")).get("URI", "")) in PUBLIC_ACL_URIS
                for grant in as_list(acl.get("Grants"))
                if isinstance(grant, dict)
            )
        except AwsCliError as error:
            finding["notes"].append(f"bucket-acl:{summarize_errors(error)}")
        try:
            pab = aws_cli_json(["s3api", "get-public-access-block", "--bucket", name], profile=profile)
            finding["publicAccessBlock"] = as_dict(pab.get("PublicAccessBlockConfiguration"))
        except AwsCliError as error:
            detail = summarize_errors(error)
            if expected_missing(detail, "NoSuchPublicAccessBlockConfiguration"):
                finding["notes"].append("no-bucket-public-access-block")
            else:
                finding["notes"].append(f"public-access-block:{detail}")
        if finding["policyPublic"] or finding["aclPublic"]:
            public_s3_buckets.append(finding)

    return public_s3_buckets, warnings


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
    public_rest_apis: list[dict[str, Any]] = []
    public_v2_apis: list[dict[str, Any]] = []
    cloudfront_distributions: list[dict[str, Any]] = []
    open_security_groups: list[dict[str, Any]] = []
    security_group_evidence_items: list[dict[str, Any]] = []
    public_lambda_urls: list[dict[str, Any]] = []
    public_lambda_policies: list[dict[str, Any]] = []
    public_rds_instances: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []

    cloudfront_distributions, cloudfront_warnings = list_cloudfront_distributions(args.profile)
    warnings.extend(cloudfront_warnings)

    public_s3_buckets, s3_warnings = collect_s3_public_buckets(args.profile)
    warnings.extend(s3_warnings)

    for region in regions:
        try:
            enis = aws_cli_json(
                [
                    "ec2",
                    "describe-network-interfaces",
                    "--filters",
                    "Name=association.public-ip,Values=*",
                    "--query",
                    "NetworkInterfaces[].{networkInterfaceId:NetworkInterfaceId,description:Description,publicIp:Association.PublicIp,privateIp:PrivateIpAddress,instanceId:Attachment.InstanceId,subnetId:SubnetId,securityGroups:Groups[].GroupId}",
                ],
                profile=args.profile,
                region=region,
            )
            for eni in as_list(enis):
                if not isinstance(eni, dict):
                    continue
                row = dict(eni)
                row["region"] = region
                public_enis.append(row)
        except AwsCliError as error:
            warnings.append(f"{region} ENI query failed: {summarize_errors(error)}")

        try:
            groups = as_list(as_dict(aws_cli_json(["ec2", "describe-security-groups"], profile=args.profile, region=region)).get("SecurityGroups"))
            for group in groups:
                if not isinstance(group, dict):
                    continue
                open_rules: list[dict[str, Any]] = []
                evidence_item: dict[str, Any] | None = None
                for permission in as_list(group.get("IpPermissions")):
                    if not isinstance(permission, dict):
                        continue
                    ipv4 = [item.get("CidrIp") for item in as_list(permission.get("IpRanges")) if isinstance(item, dict) and item.get("CidrIp") == "0.0.0.0/0"]
                    ipv6 = [item.get("CidrIpv6") for item in as_list(permission.get("Ipv6Ranges")) if isinstance(item, dict) and item.get("CidrIpv6") == "::/0"]
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
            load_balancers = as_list(as_dict(aws_cli_json(["elbv2", "describe-load-balancers"], profile=args.profile, region=region)).get("LoadBalancers"))
            for load_balancer in load_balancers:
                if not isinstance(load_balancer, dict):
                    continue
                if load_balancer.get("Scheme") != "internet-facing":
                    continue
                internet_facing_load_balancers.append({
                    "region": region,
                    "name": load_balancer.get("LoadBalancerName"),
                    "arn": load_balancer.get("LoadBalancerArn"),
                    "type": load_balancer.get("Type"),
                    "dnsName": load_balancer.get("DNSName"),
                    "state": as_dict(load_balancer.get("State")).get("Code"),
                    "vpcId": load_balancer.get("VpcId"),
                })
        except AwsCliError as error:
            warnings.append(f"{region} elbv2 query failed: {summarize_errors(error)}")

        try:
            classic_elbs = as_list(as_dict(aws_cli_json(["elb", "describe-load-balancers"], profile=args.profile, region=region)).get("LoadBalancerDescriptions"))
            for load_balancer in classic_elbs:
                if not isinstance(load_balancer, dict):
                    continue
                if load_balancer.get("Scheme", "internet-facing") != "internet-facing":
                    continue
                internet_facing_classic_elbs.append({
                    "region": region,
                    "name": load_balancer.get("LoadBalancerName"),
                    "dnsName": load_balancer.get("DNSName"),
                    "instances": [as_dict(instance).get("InstanceId") for instance in as_list(load_balancer.get("Instances"))],
                    "securityGroups": as_list(load_balancer.get("SecurityGroups")),
                    "subnets": as_list(load_balancer.get("Subnets")),
                })
        except AwsCliError as error:
            warnings.append(f"{region} classic-elb query failed: {summarize_errors(error)}")

        rest_apis, rest_api_warnings = list_public_rest_apis(args.profile, region)
        public_rest_apis.extend(rest_apis)
        warnings.extend(rest_api_warnings)

        v2_apis, v2_api_warnings = list_public_v2_apis(args.profile, region)
        public_v2_apis.extend(v2_apis)
        warnings.extend(v2_api_warnings)

        lambda_urls, lambda_policies, lambda_warnings = collect_lambda_public_surfaces(args.profile, region)
        public_lambda_urls.extend(lambda_urls)
        public_lambda_policies.extend(lambda_policies)
        warnings.extend(lambda_warnings)

        try:
            instances = as_list(as_dict(aws_cli_json(["rds", "describe-db-instances"], profile=args.profile, region=region)).get("DBInstances"))
            for instance in instances:
                if not isinstance(instance, dict):
                    continue
                if not instance.get("PubliclyAccessible"):
                    continue
                endpoint = as_dict(instance.get("Endpoint"))
                public_rds_instances.append({
                    "region": region,
                    "dbInstanceIdentifier": instance.get("DBInstanceIdentifier"),
                    "engine": instance.get("Engine"),
                    "status": instance.get("DBInstanceStatus"),
                    "endpoint": endpoint.get("Address"),
                    "port": endpoint.get("Port"),
                })
        except AwsCliError as error:
            warnings.append(f"{region} rds query failed: {summarize_errors(error)}")

    summary = {
        "account": account,
        "regions": regions,
        "counts": {
            "cloudFrontDistributions": len(cloudfront_distributions),
            "publicApiGatewayRestApis": len(public_rest_apis),
            "publicApiGatewayV2Apis": len(public_v2_apis),
            "publicEnis": len(public_enis),
            "internetFacingLoadBalancers": len(internet_facing_load_balancers),
            "internetFacingClassicElbs": len(internet_facing_classic_elbs),
            "openSecurityGroups": len(open_security_groups),
            "publicLambdaUrls": len(public_lambda_urls),
            "publicLambdaPolicies": len(public_lambda_policies),
            "publicRdsInstances": len(public_rds_instances),
            "publicS3Buckets": len(public_s3_buckets),
        },
        "findings": {
            "cloudFrontDistributions": unique_rows(cloudfront_distributions),
            "publicApiGatewayRestApis": unique_rows(public_rest_apis),
            "publicApiGatewayV2Apis": unique_rows(public_v2_apis),
            "publicEnis": unique_rows(public_enis),
            "internetFacingLoadBalancers": unique_rows(internet_facing_load_balancers),
            "internetFacingClassicElbs": unique_rows(internet_facing_classic_elbs),
            "openSecurityGroups": unique_rows(open_security_groups),
            "publicLambdaUrls": unique_rows(public_lambda_urls),
            "publicLambdaPolicies": unique_rows(public_lambda_policies),
            "publicRdsInstances": unique_rows(public_rds_instances),
            "publicS3Buckets": unique_rows(public_s3_buckets),
        },
        "warnings": warnings,
        "evidenceItems": unique_rows(security_group_evidence_items),
        "capturedAt": build_result("ok", "", {})["capturedAt"],
    }

    json_artifact = write_json_artifact(
        args.output_dir,
        "aws_internet_exposure_inventory.json",
        summary,
        label="AWS internet exposure inventory",
        summary="Inventory of public CDN, API Gateway, ENI, load balancer, security group, Lambda, RDS, and S3 exposure surfaces.",
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
        f"Inventory captured {summary['counts']['cloudFrontDistributions']} CloudFront distribution(s), "
        f"{summary['counts']['publicApiGatewayRestApis']} public REST API(s), "
        f"{summary['counts']['publicApiGatewayV2Apis']} public HTTP/WebSocket API(s), "
        f"{summary['counts']['internetFacingLoadBalancers']} internet-facing ELBv2 load balancer(s), "
        f"{summary['counts']['internetFacingClassicElbs']} classic ELB(s), "
        f"{summary['counts']['publicEnis']} public ENI(s), "
        f"{summary['counts']['openSecurityGroups']} open security group(s), "
        f"{summary['counts']['publicLambdaUrls']} public Lambda URL(s), "
        f"{summary['counts']['publicLambdaPolicies']} public Lambda policy surface(s), "
        f"{summary['counts']['publicRdsInstances']} public RDS instance(s), and "
        f"{summary['counts']['publicS3Buckets']} public S3 bucket(s) across {len(regions)} region(s)."
    )
    if summary["evidenceItems"]:
        summary_line += f" Evidence IDs: {', '.join(item['id'] for item in summary['evidenceItems'][:10])}."
    emit_result(build_result("ok", summary_line, summary, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
