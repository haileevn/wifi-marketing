#!/usr/bin/env bash
# Usage: ./scripts/set-tailscale-authkey.sh 'tskey-auth-xxxx'
# Hoặc: TAILSCALE_AUTHKEY=tskey-auth-xxx ./scripts/set-tailscale-authkey.sh
set -euo pipefail
KEY_FILE="${DEPLOY_KEY:-$(cd "$(dirname "$0")/.." && pwd)/.deploy/id_ed25519_wifi}"
HOST="${DEPLOY_HOST:-14.161.29.98}"
PORT="${DEPLOY_PORT:-22160}"
USER_NAME="${DEPLOY_USER:-h2t}"
AUTH="${1:-${TAILSCALE_AUTHKEY:-}}"
if [[ -z "$AUTH" || "$AUTH" != tskey-* ]]; then
  echo "Usage: $0 tskey-auth-...."
  echo "Tao key: https://login.tailscale.com/admin/settings/keys (Reusable, tag:router)"
  exit 1
fi
echo "Nhap mat khau sudo h2t neu duoc hoi..."
PASS="${SUDO_PASS:-}"
if [[ -z "$PASS" ]]; then
  PASS=$(osascript -e 'text returned of (display dialog "Mat khau sudo h2t" default answer "" with hidden answer)' 2>/dev/null || true)
fi
[[ -n "$PASS" ]] || { echo "Thieu sudo password"; exit 1; }

ssh -i "$KEY_FILE" -o BatchMode=yes -o IdentitiesOnly=yes -p "$PORT" "${USER_NAME}@${HOST}" \
  "printf '%s\n' $(printf %q "$PASS") | sudo -S bash -c $(printf %q "set -e
cd /opt/wifi-marketing
touch .env
grep -q '^TAILSCALE_AUTHKEY=' .env && sed -i 's|^TAILSCALE_AUTHKEY=.*|TAILSCALE_AUTHKEY=${AUTH}|' .env || echo 'TAILSCALE_AUTHKEY=${AUTH}' >> .env
grep -q '^OPENWRT_TAILSCALE_VERSION=' .env || echo 'OPENWRT_TAILSCALE_VERSION=1.98.8' >> .env
pm2 restart wifi-portal --update-env
sleep 1
curl -fsS http://127.0.0.1:20140/health
echo
grep '^TAILSCALE_AUTHKEY=' .env | sed 's/=.*/=***/'
echo AUTHKEY_SET
")"
