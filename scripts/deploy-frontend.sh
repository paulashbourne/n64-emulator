#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Deploy the Vite frontend to S3 + CloudFront.

Usage:
  scripts/deploy-frontend.sh --bucket <frontend-bucket> --distribution-id <cloudfront-id> [--region us-east-1] [--full-invalidation]

Options:
  --bucket             Target S3 bucket for static assets (required)
  --distribution-id    CloudFront distribution ID (required)
  --region             AWS region for API calls (default: AWS_REGION or us-east-1)
  --full-invalidation  Invalidate all CloudFront paths (slower, costlier)
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
DISTRIBUTION_ID=""
REGION="${AWS_REGION:-us-east-1}"
FULL_INVALIDATION="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)
      BUCKET="${2:-}"
      shift 2
      ;;
    --distribution-id)
      DISTRIBUTION_ID="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --full-invalidation)
      FULL_INVALIDATION="true"
      shift
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

if [[ -z "$BUCKET" || -z "$DISTRIBUTION_ID" ]]; then
  usage
  exit 1
fi

require_cmd npm
require_cmd aws

echo "[deploy-frontend] Installing dependencies"
cd "$ROOT_DIR"
npm ci

echo "[deploy-frontend] Building frontend"
npm run build

echo "[deploy-frontend] Uploading non-index assets (short cache)"
aws --region "$REGION" s3 sync "$ROOT_DIR/dist/" "s3://$BUCKET/" \
  --delete \
  --exclude "index.html" \
  --cache-control "public,max-age=3600"

if [[ -d "$ROOT_DIR/dist/assets" ]]; then
  echo "[deploy-frontend] Uploading hashed assets (immutable cache)"
  aws --region "$REGION" s3 sync "$ROOT_DIR/dist/assets/" "s3://$BUCKET/assets/" \
    --delete \
    --cache-control "public,max-age=31536000,immutable"
fi

echo "[deploy-frontend] Uploading index.html (no-cache)"
aws --region "$REGION" s3 cp "$ROOT_DIR/dist/index.html" "s3://$BUCKET/index.html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html; charset=utf-8"

if [[ "$FULL_INVALIDATION" == "true" ]]; then
  INVALIDATION_PATHS=("/*")
else
  INVALIDATION_PATHS=("/" "/index.html")
fi

echo "[deploy-frontend] Creating CloudFront invalidation: ${INVALIDATION_PATHS[*]}"
aws --region "$REGION" cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "${INVALIDATION_PATHS[@]}" >/dev/null

echo "[deploy-frontend] Done"
