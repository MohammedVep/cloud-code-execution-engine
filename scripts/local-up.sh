#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI is required but not installed. Install Docker Desktop or Colima + docker CLI."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required but not available."
  exit 1
fi

echo "Building runner image..."
docker build -t ccee-runner:local -f services/runner/Dockerfile .

echo "Starting local stack..."
docker compose up --build -d

echo "API available at http://localhost:8080"
