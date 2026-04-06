from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class AwsCliError(RuntimeError):
    def __init__(self, command: list[str], message: str, stdout: str = "", stderr: str = "") -> None:
        super().__init__(message)
        self.command = command
        self.stdout = stdout
        self.stderr = stderr


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def ensure_output_dir(output_dir: str | None) -> Path | None:
    if not output_dir:
        return None
    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)
    return target


def build_result(
    status: str,
    summary: str,
    data: Any,
    *,
    artifacts: list[dict[str, Any]] | None = None,
    errors: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "summary": summary,
        "artifacts": artifacts or [],
        "data": data,
        "capturedAt": utc_now(),
        "errors": errors or [],
    }


def emit_result(result: dict[str, Any]) -> None:
    print(json.dumps(result, indent=2))


def write_json_artifact(
    output_dir: str | None,
    filename: str,
    payload: Any,
    *,
    label: str,
    summary: str | None = None,
) -> dict[str, Any] | None:
    target_dir = ensure_output_dir(output_dir)
    if target_dir is None:
        return None
    target_path = target_dir / filename
    target_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    artifact: dict[str, Any] = {
        "label": label,
        "path": str(target_path),
    }
    if summary:
        artifact["summary"] = summary
    return artifact


def _aws_env() -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("AWS_PAGER", "")
    env.setdefault("AWS_MAX_ATTEMPTS", "1")
    env.setdefault("AWS_RETRY_MODE", "standard")
    env.setdefault("AWS_EC2_METADATA_DISABLED", "true")
    return env


def _aws_command(
    aws_args: list[str],
    *,
    profile: str | None = None,
    region: str | None = None,
    json_output: bool,
) -> subprocess.CompletedProcess[str]:
    command = ["aws"]
    if profile:
        command.extend(["--profile", profile])
    if region:
        command.extend(["--region", region])
    command.extend(aws_args)
    if json_output and "--output" not in aws_args:
        command.extend(["--output", "json"])
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        env=_aws_env(),
        check=False,
    )
    if completed.returncode != 0:
        raise AwsCliError(
            command,
            f"AWS CLI failed with exit code {completed.returncode}",
            stdout=completed.stdout,
            stderr=completed.stderr,
        )
    return completed


def aws_cli_json(
    aws_args: list[str],
    *,
    profile: str | None = None,
    region: str | None = None,
) -> Any:
    completed = _aws_command(aws_args, profile=profile, region=region, json_output=True)
    stdout = completed.stdout.strip()
    if not stdout:
        return {}
    return json.loads(stdout)


def aws_cli_text(
    aws_args: list[str],
    *,
    profile: str | None = None,
    region: str | None = None,
) -> str:
    completed = _aws_command(aws_args, profile=profile, region=region, json_output=False)
    return completed.stdout


def queryable_ec2_regions(profile: str | None = None) -> list[str]:
    raw = aws_cli_json(
        [
            "ec2",
            "describe-regions",
            "--all-regions",
            "--query",
            "Regions[].{RegionName:RegionName,OptInStatus:OptInStatus}",
        ],
        profile=profile,
    )
    regions: list[str] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        region_name = str(item.get("RegionName", "")).strip()
        opt_in_status = str(item.get("OptInStatus", "")).strip()
        if region_name and opt_in_status in {"opted-in", "opt-in-not-required"}:
            regions.append(region_name)
    return regions


def summarize_errors(error: AwsCliError) -> str:
    stderr = (error.stderr or "").strip()
    stdout = (error.stdout or "").strip()
    detail = stderr or stdout or str(error)
    return detail[:600]
