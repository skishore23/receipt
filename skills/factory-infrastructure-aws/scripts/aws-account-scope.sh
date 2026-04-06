#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: aws-account-scope.sh [--profile <name>]

Emit machine-readable AWS account context for the active CLI session, including
caller identity and EC2 queryable vs not-opted-in regions for the current
account/profile.
EOF
}

requested_profile=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      if [[ $# -lt 2 ]]; then
        echo "missing value for --profile" >&2
        exit 2
      fi
      requested_profile="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

selected_profile="${requested_profile:-${AWS_PROFILE:-}}"
if [[ -z "$selected_profile" ]]; then
  mapfile -t profiles < <(aws configure list-profiles 2>/dev/null || true)
  for profile in "${profiles[@]}"; do
    if [[ "$profile" == "default" ]]; then
      selected_profile="default"
      break
    fi
  done
  if [[ -z "$selected_profile" && "${#profiles[@]}" -gt 0 ]]; then
    selected_profile="${profiles[0]}"
  fi
fi

if [[ -n "$selected_profile" ]]; then
  export AWS_PROFILE="$selected_profile"
fi

export AWS_PAGER="${AWS_PAGER:-}"
export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-1}"
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-standard}"
export AWS_EC2_METADATA_DISABLED="${AWS_EC2_METADATA_DISABLED:-true}"
export AWS_CLI_AUTO_PROMPT="${AWS_CLI_AUTO_PROMPT:-off}"

default_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
if [[ -z "$default_region" ]]; then
  default_region="$(aws configure get region 2>/dev/null || true)"
fi

identity_json="$(aws sts get-caller-identity --output json)"
regions_json="$(aws ec2 describe-regions --all-regions --query 'Regions[].{RegionName:RegionName,OptInStatus:OptInStatus,Endpoint:Endpoint}' --output json)"

SELECTED_PROFILE="$selected_profile" \
DEFAULT_REGION="$default_region" \
IDENTITY_JSON="$identity_json" \
REGIONS_JSON="$regions_json" \
python3 - <<'PY'
import json
import os

QUERYABLE_STATUSES = {"opt-in-not-required", "opted-in"}

regions = []
for entry in json.loads(os.environ["REGIONS_JSON"]):
    region_name = entry.get("RegionName")
    if not region_name:
        continue
    opt_in_status = entry.get("OptInStatus")
    endpoint = entry.get("Endpoint")
    queryable = opt_in_status in QUERYABLE_STATUSES
    regions.append({
        "regionName": region_name,
        "optInStatus": opt_in_status,
        "endpoint": endpoint,
        "queryable": queryable,
    })

payload = {
    "selectedProfile": os.environ.get("SELECTED_PROFILE") or None,
    "defaultRegion": os.environ.get("DEFAULT_REGION") or None,
    "callerIdentity": json.loads(os.environ["IDENTITY_JSON"]),
    "ec2RegionScope": {
        "regions": regions,
        "queryableRegions": [entry["regionName"] for entry in regions if entry["queryable"]],
        "skippedRegions": [
            {
                "regionName": entry["regionName"],
                "optInStatus": entry.get("optInStatus"),
                "endpoint": entry.get("endpoint"),
            }
            for entry in regions
            if not entry["queryable"]
        ],
    },
}

print(json.dumps(payload, indent=2))
PY
