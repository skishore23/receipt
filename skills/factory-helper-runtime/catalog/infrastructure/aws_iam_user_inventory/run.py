#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, summarize_errors, write_json_artifact


def compact_user(item: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "userName": item.get("UserName"),
        "arn": item.get("Arn"),
        "userId": item.get("UserId"),
        "path": item.get("Path"),
        "createDate": item.get("CreateDate"),
        "passwordLastUsed": item.get("PasswordLastUsed"),
    }
    return {key: value for key, value in payload.items() if value not in (None, "")}


def main() -> int:
    parser = argparse.ArgumentParser(description="Inventory AWS IAM users")
    parser.add_argument("--profile")
    parser.add_argument("--count-only", action="store_true")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    try:
        raw = aws_cli_json(["iam", "list-users"], profile=args.profile)
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            "Unable to inventory IAM users.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    users = [
        compact_user(item)
        for item in raw.get("Users", [])
        if isinstance(item, dict)
    ]
    count = len(users)
    profile = args.profile or os.environ.get("AWS_PROFILE")
    data = {
        "profile": profile,
        "count": count,
        "users": [] if args.count_only else users,
    }
    artifacts = []
    artifact = write_json_artifact(
        args.output_dir,
        "aws_iam_user_inventory.json",
        data,
        label="IAM user inventory",
        summary=f"Captured {count} IAM user(s).",
    )
    if artifact:
        artifacts.append(artifact)
    summary = f"Captured {count} IAM user(s) for the active AWS account."
    emit_result(build_result("ok", summary, data, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
