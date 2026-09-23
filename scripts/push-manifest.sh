#!/usr/bin/env bash
set -euo pipefail
# 把生成好的 manifest 推进 KV（key: manifest），Worker 30 秒内生效（无需重新部署）
#   bash scripts/push-manifest.sh [manifest.json]
cd "$(dirname "$0")/.."
MANIFEST="${1:-manifest.json}"
head -c 80 "$MANIFEST" >/dev/null 2>&1 || { echo "missing $MANIFEST"; exit 1; }
exec wrangler kv key put --binding=KV "manifest" --path "$MANIFEST"