#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RUNTIME_ROOT / "lib"))

from helper_runtime import AwsCliError, aws_cli_json, build_result, emit_result, summarize_errors, write_json_artifact


def redact_message(message: str) -> str:
    text = message.strip()
    if len(text) > 400:
        return text[:397] + "..."
    return text


def main() -> int:
    parser = argparse.ArgumentParser(description="Sample CloudWatch log events")
    parser.add_argument("--log-group-name", required=True)
    parser.add_argument("--filter-pattern")
    parser.add_argument("--profile")
    parser.add_argument("--region", required=True)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--start-minutes-ago", type=int, default=30)
    parser.add_argument("--output-dir")
    args = parser.parse_args()

    start_time = int((time.time() - args.start_minutes_ago * 60) * 1000)
    command = [
        "logs",
        "filter-log-events",
        "--log-group-name",
        args.log_group_name,
        "--start-time",
        str(start_time),
        "--limit",
        str(max(1, args.limit)),
    ]
    if args.filter_pattern:
        command.extend(["--filter-pattern", args.filter_pattern])

    try:
        payload = aws_cli_json(command, profile=args.profile, region=args.region)
    except AwsCliError as error:
        emit_result(build_result(
            "error",
            f"Unable to sample CloudWatch logs for {args.log_group_name}.",
            {},
            errors=[summarize_errors(error)],
        ))
        return 1

    events = payload.get("events", []) if isinstance(payload, dict) else []
    sampled = []
    for event in events:
        if not isinstance(event, dict):
            continue
        sampled.append({
            "timestamp": event.get("timestamp"),
            "logStreamName": event.get("logStreamName"),
            "message": redact_message(str(event.get("message", ""))),
        })

    data = {
        "region": args.region,
        "logGroupName": args.log_group_name,
        "eventCount": len(sampled),
        "sampleMessages": sampled,
    }
    artifacts = []
    artifact = write_json_artifact(args.output_dir, "aws_log_sample.json", data, label="CloudWatch log sample")
    if artifact:
        artifacts.append(artifact)
    summary = f"Captured {len(sampled)} recent CloudWatch log event sample(s) from {args.log_group_name}."
    emit_result(build_result("ok", summary, data, artifacts=artifacts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
