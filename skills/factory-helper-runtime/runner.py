#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shlex
import hashlib
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


RUNTIME_ROOT = Path(__file__).resolve().parent
CATALOG_ROOT = RUNTIME_ROOT / "catalog"
REQUIRED_RESULT_KEYS = {"status", "summary", "artifacts", "data", "capturedAt", "errors"}


def script_status(helper_status: Any, returncode: int) -> str:
    if returncode != 0 or str(helper_status).strip().lower() == "error":
        return "error"
    if str(helper_status).strip().lower() in {"warning", "partial"}:
        return "warning"
    return "ok"


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def compact_map(payload: dict[str, Any]) -> dict[str, str | int | float | bool | None]:
    compact: dict[str, str | int | float | bool | None] = {}
    for key, value in payload.items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            compact[key] = value
        elif isinstance(value, list):
            compact[key] = len(value)
        elif isinstance(value, dict):
            compact[key] = stringify(value)
        else:
            compact[key] = stringify(value)
    return compact


def result_summary_metrics(result: dict[str, Any]) -> dict[str, str | int | float | bool | None]:
    metrics: dict[str, str | int | float | bool | None] = {
        "artifact_count": len(result.get("artifacts", [])) if isinstance(result.get("artifacts"), list) else 0,
        "error_count": len(result.get("errors", [])) if isinstance(result.get("errors"), list) else 0,
        "status": str(result.get("status", "")).strip() or None,
    }
    data = result.get("data")
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, list):
                metrics[key] = len(value)
            elif isinstance(value, (str, int, float, bool)) or value is None:
                metrics[key] = value
    return metrics


def required_runtime_identity(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"missing required runtime identity: {name}")
    return value


def helper_supports_flag(entrypoint_path: str, flag: str) -> bool:
    try:
        return flag in Path(entrypoint_path).read_text(encoding="utf-8")
    except OSError:
        return False


def factory_helper_output_dir() -> str | None:
    explicit = os.getenv("RECEIPT_FACTORY_HELPER_OUTPUT_DIR", "").strip()
    if explicit:
        target = Path(explicit)
    elif os.getenv("RECEIPT_FACTORY_TASK_ID", "").strip():
        target = Path.cwd() / ".receipt" / "factory" / "evidence"
    else:
        return None
    target.mkdir(parents=True, exist_ok=True)
    return str(target)


def attach_execution_records(
    result: dict[str, Any],
    *,
    args: argparse.Namespace,
    entry: dict[str, Any],
    passthrough: list[str],
    returncode: int,
) -> dict[str, Any]:
    command = shlex.join([
        sys.executable,
        str(Path(__file__).resolve()),
        "run",
        "--domain",
        args.domain,
        "--provider",
        args.provider,
        "--json",
        args.helper_id,
        "--",
        *passthrough,
    ])
    run_status = script_status(result.get("status"), returncode)
    helper_data = result.get("data") if isinstance(result.get("data"), dict) else {}
    outputs = compact_map({
        "status": result.get("status"),
        "summary": result.get("summary"),
        "capturedAt": result.get("capturedAt"),
        "profile": helper_data.get("profile"),
        "region": helper_data.get("region"),
        "account_id": helper_data.get("callerIdentity", {}).get("Account") if isinstance(helper_data.get("callerIdentity"), dict) else None,
        "caller_arn": helper_data.get("callerIdentity", {}).get("Arn") if isinstance(helper_data.get("callerIdentity"), dict) else None,
    })
    evidence_record = {
        "objective_id": required_runtime_identity("RECEIPT_FACTORY_OBJECTIVE_ID"),
        "task_id": required_runtime_identity("RECEIPT_FACTORY_TASK_ID"),
        "timestamp": int(os.getenv("RECEIPT_FACTORY_EVIDENCE_TS", "0") or "0") or int(time.time() * 1000),
        "tool_name": "factory_helper_runner",
        "command_or_api": command,
        "inputs": compact_map({
            "helper_id": args.helper_id,
            "provider": args.provider,
            "domain": args.domain,
            "helper_args": shlex.join(passthrough),
            "manifest_path": entry.get("manifestPath"),
            "entrypoint_path": entry.get("entrypointPath"),
        }),
        "outputs": outputs,
        "summary_metrics": result_summary_metrics(result),
    }
    scripts_run = [{
        "command": command,
        "summary": str(result.get("summary", "")).strip() or f"Ran checked-in helper {args.helper_id}.",
        "status": run_status,
    }]
    return {
        **result,
        "evidenceRecords": result.get("evidenceRecords") if isinstance(result.get("evidenceRecords"), list) else [evidence_record],
        "scriptsRun": result.get("scriptsRun") if isinstance(result.get("scriptsRun"), list) else scripts_run,
    }


def truncate_text(value: str, limit: int = 4096) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 20] + "...<truncated>"


def build_evidence_record(
    *,
    command: str,
    argv: list[str],
    cwd: str,
    start_time: float,
    end_time: float,
    stdout: str,
    stderr: str,
    returncode: int | None,
    error: str | None = None,
) -> dict[str, Any]:
    payload = {
        "command": command,
        "argv": argv,
        "cwd": cwd,
        "start_time": start_time,
        "end_time": end_time,
        "exit_code": returncode,
        "signal": None,
        "stdout_path": None,
        "stderr_path": None,
        "stdout": truncate_text(stdout),
        "stderr": truncate_text(stderr),
    }
    if error is not None:
        payload["error"] = error
    record_id_source = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    payload["record_id"] = hashlib.sha256(record_id_source.encode("utf-8")).hexdigest()
    return payload


def load_manifest(manifest_path: Path, domain: str) -> dict[str, Any] | None:
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(raw, dict):
        return None
    helper_id = str(raw.get("id", "")).strip()
    version = str(raw.get("version", "")).strip()
    provider = str(raw.get("provider", "")).strip()
    description = str(raw.get("description", "")).strip()
    entrypoint = str(raw.get("entrypoint", "")).strip()
    tags = raw.get("tags")
    if not helper_id or not version or not provider or not description or not entrypoint:
        return None
    if not isinstance(tags, list) or not all(isinstance(item, str) and item.strip() for item in tags):
        return None
    entrypoint_path = (manifest_path.parent / entrypoint).resolve()
    if not entrypoint_path.exists():
        return None
    return {
        "id": helper_id,
        "version": version,
        "provider": provider,
        "tags": [item.strip() for item in tags],
        "description": description,
        "entrypoint": entrypoint,
        "entrypointPath": str(entrypoint_path),
        "manifestPath": str(manifest_path.resolve()),
        "domain": domain,
    }


def catalog_entries(domain: str | None = None, provider: str | None = None) -> list[dict[str, Any]]:
    domains = [domain] if domain else [path.name for path in CATALOG_ROOT.iterdir() if path.is_dir()]
    entries: list[dict[str, Any]] = []
    for domain_name in domains:
        domain_root = CATALOG_ROOT / domain_name
        if not domain_root.exists():
            continue
        for helper_dir in domain_root.iterdir():
            if not helper_dir.is_dir():
                continue
            manifest = load_manifest(helper_dir / "manifest.json", domain_name)
            if not manifest:
                continue
            if provider and manifest["provider"] != provider:
                continue
            entries.append(manifest)
    return sorted(entries, key=lambda item: (item["domain"], item["id"]))


def validate_result(raw: str) -> dict[str, Any]:
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("helper output must be a JSON object")
    missing = sorted(REQUIRED_RESULT_KEYS.difference(parsed.keys()))
    if missing:
        raise ValueError(f"helper output missing required keys: {', '.join(missing)}")
    return parsed


def command_list(args: argparse.Namespace) -> int:
    entries = catalog_entries(domain=args.domain, provider=args.provider)
    if args.json:
        print(json.dumps(entries, indent=2))
    else:
        for entry in entries:
            print(f"{entry['id']} ({entry['provider']})")
            print(f"  {entry['description']}")
    return 0


def command_run(args: argparse.Namespace) -> int:
    entries = catalog_entries(domain=args.domain, provider=args.provider)
    entry = next((item for item in entries if item["id"] == args.helper_id), None)
    if entry is None:
        payload = {
            "status": "error",
            "summary": f"No helper found for id={args.helper_id} provider={args.provider} domain={args.domain}",
            "artifacts": [],
            "data": {},
            "capturedAt": "",
            "errors": [f"Helper {args.helper_id} was not found in the checked-in catalog."],
        }
        print(json.dumps(payload, indent=2))
        return 1
    passthrough = list(args.helper_args or [])
    if passthrough[:1] == ["--"]:
        passthrough = passthrough[1:]
    if "--output-dir" not in passthrough:
        default_output_dir = factory_helper_output_dir()
        if default_output_dir and helper_supports_flag(entry["entrypointPath"], "--output-dir"):
            passthrough = [*passthrough, "--output-dir", default_output_dir]
    command = ["python3", entry["entrypointPath"], *passthrough]
    command_text = shlex.join(command)
    start_time = time.time()
    completed: subprocess.CompletedProcess[str] | None = None
    helper_error: Exception | None = None
    result: dict[str, Any] | None = None
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )
        stdout = completed.stdout.strip()
        result = validate_result(stdout)
        result = attach_execution_records(
            result,
            args=args,
            entry=entry,
            passthrough=passthrough,
            returncode=completed.returncode,
        )
    except Exception as error:
        helper_error = error
        payload = {
            "status": "error",
            "summary": f"Helper {args.helper_id} failed before emitting runtime-validated output",
            "artifacts": [],
            "data": {
                "stdout": stdout if "stdout" in locals() else "",
                "stderr": completed.stderr.strip() if "completed" in locals() else "",
            },
            "capturedAt": "",
            "errors": [str(error)],
        }
        result = payload
    finally:
        end_time = time.time()
        stdout_text = completed.stdout if completed is not None else ""
        stderr_text = completed.stderr if completed is not None else ""
        evidence_record = build_evidence_record(
            command=command_text,
            argv=command,
            cwd=str(Path.cwd()),
            start_time=start_time,
            end_time=end_time,
            stdout=stdout_text,
            stderr=stderr_text,
            returncode=completed.returncode if completed is not None else None,
            error=str(helper_error) if helper_error is not None else None,
        )
        if result is not None:
            existing_records = result.get("evidenceRecords") if isinstance(result.get("evidenceRecords"), list) else []
            result["evidenceRecords"] = [*existing_records, evidence_record]
    if result is None:
        result = {
            "status": "error",
            "summary": f"Helper {args.helper_id} failed before emitting runtime-validated output",
            "artifacts": [],
            "data": {},
            "capturedAt": "",
            "errors": ["runner produced no result"],
            "evidenceRecords": [build_evidence_record(
                command=command_text,
                argv=command,
                cwd=str(Path.cwd()),
                start_time=start_time,
                end_time=time.time(),
                stdout="",
                stderr="",
                returncode=None,
                error="runner produced no result",
            )],
        }
        print(json.dumps(result, indent=2))
        return 1
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(result.get("summary", ""))
    return completed.returncode if completed is not None else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Factory helper runner")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="List checked-in helpers")
    list_parser.add_argument("--domain", default="infrastructure")
    list_parser.add_argument("--provider")
    list_parser.add_argument("--json", action="store_true")
    list_parser.set_defaults(func=command_list)

    run_parser = subparsers.add_parser("run", help="Run one checked-in helper")
    run_parser.add_argument("helper_id")
    run_parser.add_argument("--domain", default="infrastructure")
    run_parser.add_argument("--provider", required=True)
    run_parser.add_argument("--json", action="store_true")
    run_parser.add_argument("helper_args", nargs=argparse.REMAINDER)
    run_parser.set_defaults(func=command_run)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
