#!/usr/bin/env bash
# Áp Tailscale ACL từ docs/tailscale-acl.json qua API.
# Cần: TAILSCALE_API_KEY (hoặc OAuth) + TAILSCALE_TAILNET (vd: example.com / example.ts.net)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
[[ -f "$ROOT/.env" ]] && set -a && source "$ROOT/.env" && set +a

API_KEY="${TAILSCALE_API_KEY:-}"
TAILNET="${TAILSCALE_TAILNET:-}"
ACL_FILE="$ROOT/docs/tailscale-acl.json"

if [[ -z "$API_KEY" || -z "$TAILNET" ]]; then
  echo "Thiếu TAILSCALE_API_KEY hoặc TAILSCALE_TAILNET trong .env"
  echo "Tạo API key: https://login.tailscale.com/admin/settings/keys"
  echo "Puis: echo 'TAILSCALE_API_KEY=tskey-api-...' >> .env"
  echo "     echo 'TAILSCALE_TAILNET=your-tailnet.ts.net' >> .env"
  exit 1
fi

# File mẫu có _comment — strip trước khi PUT
BODY=$(node -e "const j=require('$ACL_FILE'); delete j._comment; process.stdout.write(JSON.stringify(j))")

curl -fsS -X POST "https://api.tailscale.com/api/v2/tailnet/${TAILNET}/acl" \
  -u "${API_KEY}:" \
  -H "Content-Type: application/json" \
  -d "$BODY"
echo
echo "✓ Đã PUT ACL cho tailnet $TAILNET"
echo "Nhắc: authkey enroll gắn tag:router; VPS chạy: tailscale up --advertise-tags=tag:portal"
