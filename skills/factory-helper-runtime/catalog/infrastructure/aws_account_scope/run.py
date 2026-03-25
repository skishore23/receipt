#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, aws_cli_text, build_result, emit_result, summarize_errors, write_json_artifact


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture AWS account scope")
    parser.add_argument("--profile")
    parser.add_argument("--region")
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    try:
        identity = aws_cli_json(["sts", "get-caller-identity"], profile=args.profile, region=args.region)
        profiles = [
            line.strip()
            for line in aws_cli_text(["configure", "list-profiles"]).splitlines()
            if line.strip()
        ]
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            "Unable to determine the active AWS account scope.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    data = {
        "profile": args.profile or os.environ.get("AWS_PROFILE"),
        "region": args.region or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"),
        "callerIdentity": identity,
        "availableProfiles": profiles,
    }
    artifacts = []
    artifact = write_json_artifact(args.output_dir, "aws_account_scope.json", data, label="AWS account scope")
    if artifact:
        artifacts.append(artifact)
    summary = "Captured the active AWS caller identity and CLI profile context."
    emit_result(build_result("ok", summary, data, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
