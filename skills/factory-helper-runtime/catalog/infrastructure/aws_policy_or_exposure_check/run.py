#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, summarize_errors, write_json_artifact


def check_s3_bucket(resource_id: str, profile: str | None) -> dict[str, Any]:
    policy_status = aws_cli_json(["s3api", "get-bucket-policy-status", "--bucket", resource_id], profile=profile)
    public_access_block = aws_cli_json(["s3api", "get-public-access-block", "--bucket", resource_id], profile=profile)
    return {
        "bucket": resource_id,
        "policyStatus": policy_status,
        "publicAccessBlock": public_access_block,
    }


def check_iam_role(resource_id: str, profile: str | None) -> dict[str, Any]:
    role = aws_cli_json(["iam", "get-role", "--role-name", resource_id], profile=profile)
    return {
        "roleName": resource_id,
        "role": role,
    }


def check_security_group(resource_id: str, profile: str | None, region: str | None) -> dict[str, Any]:
    security_group = aws_cli_json(["ec2", "describe-security-groups", "--group-ids", resource_id], profile=profile, region=region)
    return {
        "groupId": resource_id,
        "securityGroup": security_group,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check AWS policy or exposure surfaces")
    parser.add_argument("--service", required=True, choices=["s3", "iam", "ec2"])
    parser.add_argument("--check", required=True, choices=["public-access", "trust-policy", "security-group-exposure"])
    parser.add_argument("--resource-id", required=True)
    parser.add_argument("--profile")
    parser.add_argument("--region")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    try:
        if args.service == "s3" and args.check == "public-access":
            data = check_s3_bucket(args.resource_id, args.profile)
        elif args.service == "iam" and args.check == "trust-policy":
            data = check_iam_role(args.resource_id, args.profile)
        elif args.service == "ec2" and args.check == "security-group-exposure":
            data = check_security_group(args.resource_id, args.profile, args.region)
        else:
            emit_result(build_result(
                "error",
                f"Unsupported check combination: {args.service}/{args.check}",
                {},
                errors=["Use s3/public-access, iam/trust-policy, or ec2/security-group-exposure."],
            ))
            return 1
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            f"Unable to run {args.service}/{args.check} for {args.resource_id}.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    artifacts = []
    artifact = write_json_artifact(
        args.output_dir,
        f"aws_policy_or_exposure_check_{args.service}_{args.resource_id}.json",
        data,
        label=f"{args.service} {args.check}",
    )
    if artifact:
        artifacts.append(artifact)
    summary = f"Captured {args.service} {args.check} details for {args.resource_id}."
    emit_result(build_result("ok", summary, data, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
