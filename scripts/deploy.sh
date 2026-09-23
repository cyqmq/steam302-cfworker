#!/usr/bin/env bash
# 一键部署本地 Worker（需先手动创建并绑定 KV，见 README「部署·方式 D」）：
#   1. 可选：用 KV_ROUTES_ID / KV_HEALTH_KV_ID 覆盖 wrangler.toml 中的 KV id
#   2. 可选：推送 MANIFEST 到 ROUTES KV
#   3. 可选：绑定自定义域（CF_DOMAIN=demo.example.com）
#   4. wrangler deploy
#
# 需要的环境变量：
#   CLOUDFLARE_API_TOKEN    必填（Worker 脚本 + KV 权限）
#   CLOUDFLARE_ACCOUNT_ID   必填
#   可选  KV_ROUTES_ID      已有 ROUTES 命名空间的 id（若 wrangler.toml 已填好则无需设置）
#   可选  KV_HEALTH_KV_ID   已有 HEALTH_KV 命名空间的 id
#   可选  MANIFEST          路由表 JSON（写入 ROUTES KV，覆盖内置默认）
#   可选  CF_DOMAIN         自定义域名（须已托管在该 Cloudflare 账号）
#
# 注意：本脚本不会自动创建 KV 命名空间——请用
#   wrangler kv namespace create ROUTES / HEALTH_KV
# 把返回的 id 填进 wrangler.toml 的 kv_namespaces（或通过 KV_ROUTES_ID/KV_HEALTH_KV_ID 注入）。
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN 环境变量}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID 环境变量}"

for B in ROUTES HEALTH_KV; do
  ID_VAR="KV_${B}_ID"
  ID="${!ID_VAR:-}"
  if [ -n "$ID" ]; then
    echo "[deploy] KV $B -> id $ID"
    sed -i -E "s/(\"$B\",[[:space:]]*id = \")[^\"]*/\1$ID/" wrangler.toml
  fi
done

if [ -n "${MANIFEST:-}" ]; then
  ID="$(sed -n 's/.*binding = "ROUTES", id = "\([^"]*\)".*/\1/p' wrangler.toml | head -n1)"
  if [ -n "$ID" ] && [ "$ID" != "REPLACE_WITH_ROUTES_KV_ID" ]; then
    echo "[deploy] writing MANIFEST to ROUTES KV"
    printf '%s' "$MANIFEST" | wrangler kv key put manifest --namespace-id "$ID" --path -
  else
    echo "[deploy] skip MANIFEST: ROUTES KV id 未配置"
  fi
fi

if [ -n "${CF_DOMAIN:-}" ]; then
  python3 - "$CF_DOMAIN" <<'PY'
import re, sys
p = "wrangler.toml"
d = open(p).read()
dom = sys.argv[1]
if not re.search(r'^routes\s*=', d, re.M):
    d += "\nroutes = []\n"
m = re.search(r'^routes\s*=\s*\[([^\[\]]*)\]', d, re.M | re.S)
if m:
    # 丢弃注释行与已存在（非注释）的 custom_domain 条目，然后追加目标域名
    lines = [ln for ln in m.group(1).splitlines()
             if ln.strip() and not ln.strip().startswith('#')
             and 'custom_domain' not in ln]
    entry = '  { pattern = "%s", custom_domain = true },' % dom
    body = ("\n" + "\n".join(lines)).rstrip()
    new = "routes = [" + body + "\n" + entry + "\n]"
    d = d[: m.start()] + new + d[m.end():]
open(p, "w").write(d)
PY
  echo "[deploy] custom domain routed: $CF_DOMAIN"
fi

echo "[deploy] deploying..."
wrangler deploy
echo "[deploy] done"