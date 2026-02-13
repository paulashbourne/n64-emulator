#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Deploy multiplayer coordinator artifact to EC2 through SSM.

Usage:
  scripts/deploy-backend.sh --bucket <artifact-bucket> --instance-id <ec2-id> [--artifact <path>] [--prefix coordinator] [--region us-east-1]

Options:
  --bucket       S3 bucket for release artifacts (required)
  --instance-id  EC2 instance ID running the coordinator service (required)
  --artifact     Existing artifact path (.tar.gz). If omitted, builds one.
  --prefix       S3 key prefix for artifacts (default: coordinator)
  --region       AWS region for API calls (default: AWS_REGION or us-east-1)
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUCKET=""
INSTANCE_ID=""
ARTIFACT_PATH=""
PREFIX="coordinator"
REGION="${AWS_REGION:-us-east-1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)
      BUCKET="${2:-}"
      shift 2
      ;;
    --instance-id)
      INSTANCE_ID="${2:-}"
      shift 2
      ;;
    --artifact)
      ARTIFACT_PATH="${2:-}"
      shift 2
      ;;
    --prefix)
      PREFIX="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$BUCKET" || -z "$INSTANCE_ID" ]]; then
  usage
  exit 1
fi

require_cmd aws

if [[ -z "$ARTIFACT_PATH" ]]; then
  require_cmd npm
  ARTIFACT_PATH="$($ROOT_DIR/scripts/build-backend-artifact.sh)"
fi

if [[ ! -f "$ARTIFACT_PATH" ]]; then
  echo "Artifact not found: $ARTIFACT_PATH" >&2
  exit 1
fi

ARTIFACT_BASENAME="$(basename "$ARTIFACT_PATH")"
S3_KEY="${PREFIX%/}/${ARTIFACT_BASENAME}"
S3_URI="s3://${BUCKET}/${S3_KEY}"
S3_LATEST_URI="s3://${BUCKET}/${PREFIX%/}/latest.tar.gz"

echo "[deploy-backend] Uploading artifact: $S3_URI"
aws --region "$REGION" s3 cp "$ARTIFACT_PATH" "$S3_URI"
aws --region "$REGION" s3 cp "$ARTIFACT_PATH" "$S3_LATEST_URI"

PARAMS_FILE="$(mktemp)"
cleanup() {
  rm -f "$PARAMS_FILE"
}
trap cleanup EXIT

cat > "$PARAMS_FILE" <<JSON
{
  "commands": [
    "sudo /usr/local/bin/deploy-n64-coordinator '$S3_URI'",
    "curl -fsS http://127.0.0.1:8787/health",
    "sudo systemctl is-active n64-coordinator"
  ]
}
JSON

echo "[deploy-backend] Sending SSM command"
COMMAND_ID="$(aws --region "$REGION" ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "Deploy Warpdeck64 coordinator" \
  --parameters "file://${PARAMS_FILE}" \
  --query 'Command.CommandId' \
  --output text)"

echo "[deploy-backend] Waiting for command ${COMMAND_ID}"
while true; do
  STATUS="$(aws --region "$REGION" ssm get-command-invocation \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --query 'Status' \
    --output text 2>/dev/null || true)"

  case "$STATUS" in
    Success)
      break
      ;;
    Failed|Cancelled|TimedOut)
      echo "[deploy-backend] Command failed with status: $STATUS" >&2
      aws --region "$REGION" ssm get-command-invocation \
        --command-id "$COMMAND_ID" \
        --instance-id "$INSTANCE_ID" \
        --query '{Status:Status,StdOut:StandardOutputContent,StdErr:StandardErrorContent}' \
        --output json >&2
      exit 1
      ;;
    Pending|InProgress|Delayed|"" )
      sleep 4
      ;;
    *)
      sleep 4
      ;;
  esac
done

aws --region "$REGION" ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,StdOut:StandardOutputContent}' \
  --output json

echo "[deploy-backend] Done"
