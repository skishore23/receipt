#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


RUNTIME_ROOT = Path(__file__).resolve().parent
CATALOG_ROOT = RUNTIME_ROOT / "catalog"
REQUIRED_RESULT_KEYS = {"status", "summary", "artifacts", "data", "capturedAt", "errors"}


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
    completed = subprocess.run(
        ["python3", entry["entrypointPath"], *passthrough],
        capture_output=True,
        text=True,
        check=False,
    )
    stdout = completed.stdout.strip()
    try:
        result = validate_result(stdout)
    except Exception as error:
        payload = {
            "status": "error",
            "summary": f"Helper {args.helper_id} returned malformed JSON output",
            "artifacts": [],
            "data": {
                "stdout": stdout,
                "stderr": completed.stderr.strip(),
            },
            "capturedAt": "",
            "errors": [str(error)],
        }
        print(json.dumps(payload, indent=2))
        return 1
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(result.get("summary", ""))
    return completed.returncode


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
