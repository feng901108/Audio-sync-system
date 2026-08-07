#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== 扫描音乐库 ==="
echo "时间: $(date)"

docker compose exec -T mopidy mopidy --config /etc/mopidy/mopidy.conf local scan

echo "扫描完成: $(date)"
