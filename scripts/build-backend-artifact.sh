#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Build a production artifact for the multiplayer coordinator backend.

Usage:
  scripts/build-backend-artifact.sh [--output-dir <dir>] [--version <version>]

Options:
  --output-dir   Output directory (default: artifacts/releases)
  --version      Artifact version label (default: UTC timestamp + git sha)
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/artifacts/releases"
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
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

require_cmd npm
require_cmd tar
require_cmd git

if [[ -z "$VERSION" ]]; then
  GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "nogit")"
  VERSION="$(date -u +%Y%m%d%H%M%S)-${GIT_SHA}"
fi

ARTIFACT_NAME="coordinator-${VERSION}.tar.gz"
ARTIFACT_PATH="${OUTPUT_DIR%/}/${ARTIFACT_NAME}"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$OUTPUT_DIR"
mkdir -p "$WORK_DIR/server"

cp "$ROOT_DIR/server/multiplayerServer.mjs" "$WORK_DIR/server/multiplayerServer.mjs"

cat > "$WORK_DIR/package.json" <<PKG
{
  "name": "warpdeck-n64-coordinator",
  "private": true,
  "type": "module",
  "version": "${VERSION}",
  "dependencies": {
    "ws": "^8.18.3"
  }
}
PKG

cat > "$WORK_DIR/DEPLOY_INFO" <<INFO
version=${VERSION}
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_repo=n64-emulator
INFO

cd "$WORK_DIR"
npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null

tar -czf "$ARTIFACT_PATH" .

echo "$ARTIFACT_PATH"
