#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import (
    AwsCliError,
    aws_cli_json,
    build_result,
    evidence_sha256,
    emit_result,
    register_evidence,
    script_runs,
    summarize_errors,
    write_json_artifact,
)


PUBLIC_ACL_URIS = {
    "http://acs.amazonaws.com/groups/global/AllUsers",
    "http://acs.amazonaws.com/groups/global/AuthenticatedUsers",
}


def normalize_region(location_constraint: Any) -> str:
    if location_constraint in (None, "", "null"):
        return "us-east-1"
    value = str(location_constraint).strip()
    if value == "EU":
        return "eu-west-1"
    return value or "unknown"


def versioning_status(bucket_name: str, profile: str | None, region: str, output_dir: str | None) -> tuple[str, list[str]]:
    errors: list[str] = []
    try:
        payload = aws_cli_json(
            ["s3api", "get-bucket-versioning", "--bucket", bucket_name],
            profile=profile,
            region=region,
            output_dir=output_dir,
            run_label=f"{bucket_name}-get-bucket-versioning",
        )
    except AwsCliError as error:
        errors.append(f"{bucket_name}: get-bucket-versioning failed: {summarize_errors(error)}")
        return "unknown", errors
    status = str(payload.get("Status", "")).strip()
    return (status or "Not enabled"), errors


def default_encryption(bucket_name: str, profile: str | None, region: str, output_dir: str | None) -> tuple[str, list[str]]:
    errors: list[str] = []
    try:
        payload = aws_cli_json(
            ["s3api", "get-bucket-encryption", "--bucket", bucket_name],
            profile=profile,
            region=region,
            output_dir=output_dir,
            run_label=f"{bucket_name}-get-bucket-encryption",
        )
    except AwsCliError as error:
        detail = summarize_errors(error)
        if "ServerSideEncryptionConfigurationNotFoundError" in detail or "NoSuchServerSideEncryptionConfiguration" in detail:
            return "Not configured", errors
        errors.append(f"{bucket_name}: get-bucket-encryption failed: {detail}")
        return "unknown", errors

    rules = payload.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
    descriptions: list[str] = []
    for rule in rules if isinstance(rules, list) else []:
        default = rule.get("ApplyServerSideEncryptionByDefault", {})
        algorithm = str(default.get("SSEAlgorithm", "")).strip()
        kms_key = str(default.get("KMSMasterKeyID", "")).strip()
        if algorithm and kms_key and algorithm == "aws:kms":
            descriptions.append(f"{algorithm} ({kms_key})")
        elif algorithm:
            descriptions.append(algorithm)
    return (", ".join(dict.fromkeys(descriptions)) or "Not configured"), errors


def public_access_block(bucket_name: str, profile: str | None, region: str, output_dir: str | None) -> tuple[str, dict[str, Any] | None, list[str]]:
    errors: list[str] = []
    try:
        payload = aws_cli_json(
            ["s3api", "get-public-access-block", "--bucket", bucket_name],
            profile=profile,
            region=region,
            output_dir=output_dir,
            run_label=f"{bucket_name}-get-public-access-block",
        )
    except AwsCliError as error:
        detail = summarize_errors(error)
        if "NoSuchPublicAccessBlockConfiguration" in detail:
            return "Not configured", None, errors
        errors.append(f"{bucket_name}: get-public-access-block failed: {detail}")
        return "unknown", None, errors

    config = payload.get("PublicAccessBlockConfiguration", {})
    flags = [
        bool(config.get("BlockPublicAcls")),
        bool(config.get("IgnorePublicAcls")),
        bool(config.get("BlockPublicPolicy")),
        bool(config.get("RestrictPublicBuckets")),
    ]
    if all(flags):
        status = "Fully enabled"
    elif any(flags):
        status = "Partial"
    else:
        status = "Disabled"
    return status, config if isinstance(config, dict) else None, errors


def policy_public(bucket_name: str, profile: str | None, region: str, output_dir: str | None) -> tuple[bool | None, list[str]]:
    errors: list[str] = []
    try:
        payload = aws_cli_json(
            ["s3api", "get-bucket-policy-status", "--bucket", bucket_name],
            profile=profile,
            region=region,
            output_dir=output_dir,
            run_label=f"{bucket_name}-get-bucket-policy-status",
        )
    except AwsCliError as error:
        detail = summarize_errors(error)
        if "NoSuchBucketPolicy" in detail:
            return False, errors
        errors.append(f"{bucket_name}: get-bucket-policy-status failed: {detail}")
        return None, errors
    status = payload.get("PolicyStatus", {})
    if isinstance(status, dict):
        value = status.get("IsPublic")
        if isinstance(value, bool):
            return value, errors
    return None, errors


def acl_public(bucket_name: str, profile: str | None, region: str, output_dir: str | None) -> tuple[bool | None, list[str], list[str]]:
    errors: list[str] = []
    reasons: list[str] = []
    try:
        payload = aws_cli_json(
            ["s3api", "get-bucket-acl", "--bucket", bucket_name],
            profile=profile,
            region=region,
            output_dir=output_dir,
            run_label=f"{bucket_name}-get-bucket-acl",
        )
    except AwsCliError as error:
        errors.append(f"{bucket_name}: get-bucket-acl failed: {summarize_errors(error)}")
        return None, reasons, errors
    grants = payload.get("Grants", [])
    if not isinstance(grants, list):
        return False, reasons, errors
    for grant in grants:
        if not isinstance(grant, dict):
            continue
        grantee = grant.get("Grantee", {})
        if not isinstance(grantee, dict):
            continue
        uri = str(grantee.get("URI", "")).strip()
        if uri in PUBLIC_ACL_URIS:
            permission = str(grant.get("Permission", "")).strip() or "unknown"
            reasons.append(f"{uri}:{permission}")
    return (bool(reasons), reasons, errors)


def bucket_artifact_dir(output_dir: str | None, bucket_name: str) -> Path | None:
    if not output_dir:
        return None
    target = Path(output_dir) / "aws" / "s3" / bucket_name
    target.mkdir(parents=True, exist_ok=True)
    return target


def write_bucket_json(target_dir: Path | None, filename: str, payload: Any) -> str | None:
    if target_dir is None:
        return None
    path = target_dir / filename
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return str(path)


def summarize_signal(is_public: bool | None) -> str:
    if is_public is True:
        return "public"
    if is_public is False:
        return "private"
    return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description="Inventory S3 buckets with security metadata")
    parser.add_argument("--profile")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    try:
        identity = aws_cli_json(["sts", "get-caller-identity"], profile=args.profile, output_dir=args.output_dir, run_label="get-caller-identity")
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            "Unable to determine the active AWS caller identity.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    try:
        buckets_payload = aws_cli_json(
            ["s3api", "list-buckets", "--query", "Buckets[].{Name:Name,CreationDate:CreationDate}"],
            profile=args.profile,
            output_dir=args.output_dir,
            run_label="list-buckets",
        )
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            "Unable to list S3 buckets.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    records: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []
    evidence_rows: list[dict[str, Any]] = []
    errors: list[str] = []
    region_counts: Counter[str] = Counter()
    public_buckets: list[dict[str, Any]] = []
    unknown_public: list[str] = []

    for item in buckets_payload if isinstance(buckets_payload, list) else []:
        if not isinstance(item, dict):
            continue
        bucket_name = str(item.get("Name", "")).strip()
        if not bucket_name:
            continue
        creation_date = str(item.get("CreationDate", "")).strip()
        bucket_dir = bucket_artifact_dir(args.output_dir, bucket_name)

        resolved_region = "us-east-1"
        bucket_artifacts: dict[str, str | None] = {}

        try:
            location_payload = aws_cli_json(
                ["s3api", "get-bucket-location", "--bucket", bucket_name],
                profile=args.profile,
                region=resolved_region,
                output_dir=args.output_dir,
                run_label=f"{bucket_name}-get-bucket-location",
            )
        except AwsCliError as error:
            location_payload = {"error": summarize_errors(error)}
        bucket_artifacts["getBucketLocation"] = write_bucket_json(bucket_dir, "get_bucket_location.json", location_payload)
        region = normalize_region(location_payload.get("LocationConstraint")) if isinstance(location_payload, dict) else "unknown"
        resolved_region = region if region != "unknown" else "us-east-1"

        try:
            pab_payload = aws_cli_json(
                ["s3api", "get-public-access-block", "--bucket", bucket_name],
                profile=args.profile,
                region=resolved_region,
                output_dir=args.output_dir,
                run_label=f"{bucket_name}-get-public-access-block",
            )
        except AwsCliError as error:
            pab_payload = {"error": summarize_errors(error)}
        bucket_artifacts["getPublicAccessBlock"] = write_bucket_json(bucket_dir, "get_public_access_block.json", pab_payload)

        try:
            acl_payload = aws_cli_json(
                ["s3api", "get-bucket-acl", "--bucket", bucket_name],
                profile=args.profile,
                region=resolved_region,
                output_dir=args.output_dir,
                run_label=f"{bucket_name}-get-bucket-acl",
            )
        except AwsCliError as error:
            acl_payload = {"error": summarize_errors(error)}
        bucket_artifacts["getBucketAcl"] = write_bucket_json(bucket_dir, "get_bucket_acl.json", acl_payload)

        try:
            policy_payload = aws_cli_json(
                ["s3api", "get-bucket-policy-status", "--bucket", bucket_name],
                profile=args.profile,
                region=resolved_region,
                output_dir=args.output_dir,
                run_label=f"{bucket_name}-get-bucket-policy-status",
            )
        except AwsCliError as error:
            policy_payload = {"error": summarize_errors(error)}
        bucket_artifacts["getBucketPolicyStatus"] = write_bucket_json(bucket_dir, "get_bucket_policy_status.json", policy_payload)

        versioning, version_errors = versioning_status(bucket_name, args.profile, resolved_region, args.output_dir)
        encryption, encryption_errors = default_encryption(bucket_name, args.profile, resolved_region, args.output_dir)

        pab_config = None
        pab_status = "unknown"
        pab_errors: list[str] = []
        if isinstance(pab_payload, dict):
            config = pab_payload.get("PublicAccessBlockConfiguration", {})
            if isinstance(config, dict):
                pab_config = config
                flags = [
                    bool(config.get("BlockPublicAcls")),
                    bool(config.get("IgnorePublicAcls")),
                    bool(config.get("BlockPublicPolicy")),
                    bool(config.get("RestrictPublicBuckets")),
                ]
                if all(flags):
                    pab_status = "Fully enabled"
                elif any(flags):
                    pab_status = "Partial"
                else:
                    pab_status = "Disabled"
        elif "error" in pab_payload:
            pab_errors.append(f"{bucket_name}: get-public-access-block failed: {pab_payload['error']}")

        policy_is_public: bool | None = None
        policy_errors: list[str] = []
        if isinstance(policy_payload, dict):
            status_payload = policy_payload.get("PolicyStatus", {})
            if isinstance(status_payload, dict):
                value = status_payload.get("IsPublic")
                if isinstance(value, bool):
                    policy_is_public = value
        elif "error" in policy_payload:
            policy_errors.append(f"{bucket_name}: get-bucket-policy-status failed: {policy_payload['error']}")

        acl_is_public: bool | None = None
        acl_reasons: list[str] = []
        acl_errors: list[str] = []
        if isinstance(acl_payload, dict):
            grants = acl_payload.get("Grants", [])
            if isinstance(grants, list):
                for grant in grants:
                    if not isinstance(grant, dict):
                        continue
                    grantee = grant.get("Grantee", {})
                    if not isinstance(grantee, dict):
                        continue
                    uri = str(grantee.get("URI", "")).strip()
                    if uri in PUBLIC_ACL_URIS:
                        permission = str(grant.get("Permission", "")).strip() or "unknown"
                        acl_reasons.append(f"{uri}:{permission}")
                acl_is_public = bool(acl_reasons)
            else:
                acl_is_public = False
        elif "error" in acl_payload:
            acl_errors.append(f"{bucket_name}: get-bucket-acl failed: {acl_payload['error']}")

        errors.extend(version_errors)
        errors.extend(encryption_errors)
        errors.extend(pab_errors)
        errors.extend(policy_errors)
        errors.extend(acl_errors)

        if policy_is_public is True or acl_is_public is True:
            public_access = "yes"
            signals = []
            if policy_is_public is True:
                signals.append("policy")
            if acl_is_public is True:
                signals.append("acl")
            public_buckets.append({
                "name": bucket_name,
                "region": region,
                "signals": signals,
                "aclReasons": acl_reasons,
            })
        elif policy_is_public is False and acl_is_public is False:
            public_access = "no"
            signals = []
        else:
            public_access = "unknown"
            signals = []
            unknown_public.append(bucket_name)

        region_counts[region] += 1
        record = {
            "bucketName": bucket_name,
            "region": region,
            "creationDate": creation_date,
            "versioningStatus": versioning,
            "defaultEncryption": encryption,
            "publicAccessBlockStatus": pab_status,
            "publicAccessBlockConfiguration": pab_config,
            "policyIsPublic": policy_is_public,
            "aclIsPublic": acl_is_public,
            "aclPublicReasons": acl_reasons,
            "publicAccess": public_access,
            "publicAccessSignals": signals,
        }
        records.append(record)
        evidence_rows.append({
            "bucket": bucket_name,
            "region": region,
            "public_acl_signal": summarize_signal(acl_is_public),
            "public_policy_signal": summarize_signal(policy_is_public),
            "pab_enabled": pab_status == "Fully enabled",
            "artifacts": bucket_artifacts,
        })

    total_count = len(records)
    summary_rows = [
        {
            "region": region,
            "bucketCount": count,
            "publicBucketCount": sum(1 for record in records if record["region"] == region and record["publicAccess"] == "yes"),
        }
        for region, count in sorted(region_counts.items())
    ]

    data = {
        "profile": args.profile,
        "callerIdentity": identity,
        "buckets": records,
        "summary": {
            "bucketCount": total_count,
            "publicBucketCount": len(public_buckets),
            "unknownPublicAccessCount": len(unknown_public),
            "countsByRegion": summary_rows,
            "publicBuckets": public_buckets,
            "unknownPublicAccessBuckets": unknown_public,
        },
        "errors": errors,
    }

    if args.output_dir:
        target_dir = Path(args.output_dir) / "aws" / "s3"
        target_dir.mkdir(parents=True, exist_ok=True)
        list_buckets_path = target_dir / "list_buckets.json"
        list_buckets_payload = {"callerIdentity": identity, "buckets": buckets_payload}
        list_buckets_path.write_text(json.dumps(list_buckets_payload, indent=2) + "\n", encoding="utf-8")

        evidence_summary = {
            "buckets": evidence_rows,
        }
        evidence_summary_path = target_dir / "evidence_summary.json"
        evidence_summary_path.write_text(json.dumps(evidence_summary, indent=2) + "\n", encoding="utf-8")

        artifacts.extend([
            {
                "label": "S3 list buckets raw response",
                "path": str(list_buckets_path),
                "summary": f"Captured the raw ListBuckets response for {len(records)} buckets.",
            },
            {
                "label": "S3 normalized evidence summary",
                "path": str(evidence_summary_path),
                "summary": "Normalized per-bucket evidence for region and public exposure signals.",
            },
        ])
        artifacts.append(register_evidence("s3_inventory", str(list_buckets_path), "1", evidence_sha256(list_buckets_path)))
        artifacts.append(register_evidence("s3_inventory", str(evidence_summary_path), "1", evidence_sha256(evidence_summary_path)))
        for row in evidence_rows:
            bucket_dir = bucket_artifact_dir(args.output_dir, row["bucket"])
            if bucket_dir is None:
                continue
            for rel_name in [
                "get_bucket_location.json",
                "get_public_access_block.json",
                "get_bucket_acl.json",
                "get_bucket_policy_status.json",
            ]:
                file_path = bucket_dir / rel_name
                if file_path.exists():
                    artifacts.append({
                        "label": f"S3 {row['bucket']} {rel_name}",
                        "path": str(file_path),
                        "summary": "Captured raw AWS CLI response for this bucket.",
                    })
                    artifacts.append(register_evidence("s3_inventory", str(file_path), "1", evidence_sha256(file_path)))

    artifact_data = {
        "table": [
            {
                "bucket": record["bucketName"],
                "region": record["region"],
                "creationDate": record["creationDate"],
                "versioning": record["versioningStatus"],
                "defaultEncryption": record["defaultEncryption"],
                "publicAccessBlock": record["publicAccessBlockStatus"],
                "publicAccess": record["publicAccess"],
            }
            for record in records
        ],
        "summary": data["summary"],
        "records": records,
    }
    json_artifact = write_json_artifact(args.output_dir, "aws_s3_bucket_inventory.json", artifact_data, label="S3 bucket inventory", summary=f"Captured {total_count} buckets.")
    if json_artifact:
        artifacts.append(json_artifact)

    if args.output_dir:
        target_dir = Path(args.output_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        md_path = target_dir / "aws_s3_bucket_inventory.md"
        lines = [
            "# S3 bucket inventory",
            "",
            "| Bucket | Region | Created | Versioning | Default encryption | Public access block | Public access |",
            "| --- | --- | --- | --- | --- | --- | --- |",
        ]
        for row in artifact_data["table"]:
            lines.append(
                f"| {row['bucket']} | {row['region']} | {row['creationDate']} | {row['versioning']} | {row['defaultEncryption']} | {row['publicAccessBlock']} | {row['publicAccess']} |"
            )
        lines.extend([
            "",
            "## Counts by region",
            "",
        ])
        for item in summary_rows:
            lines.append(f"- {item['region']}: {item['bucketCount']} buckets, {item['publicBucketCount']} public")
        lines.extend([
            "",
            "## Public buckets",
            "",
        ])
        if public_buckets:
            for item in public_buckets:
                signal_text = ", ".join(item["signals"]) if item["signals"] else "unknown"
                lines.append(f"- {item['name']} ({item['region']}): {signal_text}")
        else:
            lines.append("- None detected")
        md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        artifacts.append({
            "label": "S3 bucket inventory markdown",
            "path": str(md_path),
            "summary": f"Rendered a concise table for {total_count} buckets.",
        })

    status = "ok" if not errors else "warning"
    summary = f"Captured {total_count} S3 buckets; {len(public_buckets)} have public policy or ACL signals."
    if errors:
        summary += f" Encountered {len(errors)} API warning(s)."
    result = build_result(status, summary, data, artifacts=artifacts, errors=errors)
    result["scriptsRun"] = script_runs()
    emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
