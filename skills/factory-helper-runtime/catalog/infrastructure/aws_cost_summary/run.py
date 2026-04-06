#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class ClassifiedFallback:
    mode: str
    error_type: str
    error_message: str
    warning_code: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def classify_exception(error: Exception) -> ClassifiedFallback | None:
    error_type = error.__class__.__name__
    message = str(error).strip() or error_type

    if error_type in {"NoCredentialsError", "PartialCredentialsError"}:
        return ClassifiedFallback("offline", error_type, message, "aws_credentials_unavailable")

    response = getattr(error, "response", {}) or {}
    if isinstance(response, dict):
        code = str((response.get("Error") or {}).get("Code", "")).strip()
        if code in {"ExpiredToken", "UnrecognizedClientException"}:
            return ClassifiedFallback("offline", error_type, message, "aws_auth_expired")

    if error_type in {"EndpointConnectionError", "ConnectTimeoutError", "ReadTimeoutError"}:
        return ClassifiedFallback("offline", error_type, message, "aws_endpoint_unreachable")

    return None


def build_result(fallback: ClassifiedFallback | None, *, simulated_error: Exception | None) -> dict[str, Any]:
    if fallback is None:
        return {
            "status": "ok",
            "summary": "AWS cost summary mode resolved without fallback.",
            "artifacts": [],
            "data": {
                "mode": "auto",
                "resolvedMode": "online",
                "error": None,
                "report": {"status": "ok"},
            },
            "capturedAt": utc_now(),
            "errors": [],
        }

    error_payload = {
        "type": fallback.error_type,
        "message": fallback.error_message,
    }
    return {
        "status": "ok",
        "summary": f"Fell back to offline fixtures after {fallback.error_type}.",
        "artifacts": [],
        "data": {
            "mode": "auto",
            "resolvedMode": fallback.mode,
            "error": error_payload,
            "warning": {
                "code": fallback.warning_code,
                "message": "Auto mode classified a recoverable AWS client failure and selected offline fixtures.",
            },
            "report": {
                "status": "ok",
                "source": "offline-fixtures",
                "error": error_payload,
            },
        },
        "capturedAt": utc_now(),
        "errors": [],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--simulate", choices=[
        "NoCredentialsError",
        "PartialCredentialsError",
        "ExpiredToken",
        "UnrecognizedClientException",
        "EndpointConnectionError",
        "ConnectTimeoutError",
        "ReadTimeoutError",
    ])
    args = parser.parse_args(argv)

    simulated_error: Exception | None = None
    if args.simulate:
        if args.simulate == "ExpiredToken":
            class ClientError(Exception):
                def __init__(self) -> None:
                    super().__init__("ExpiredToken")
                    self.response = {"Error": {"Code": "ExpiredToken"}}

            simulated_error = ClientError()
        elif args.simulate == "UnrecognizedClientException":
            class ClientError(Exception):
                def __init__(self) -> None:
                    super().__init__("UnrecognizedClientException")
                    self.response = {"Error": {"Code": "UnrecognizedClientException"}}

            simulated_error = ClientError()
        else:
            simulated_error = type(args.simulate, (Exception,), {})("simulated failure")

    fallback = classify_exception(simulated_error) if simulated_error else None
    result = build_result(fallback, simulated_error=simulated_error)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
