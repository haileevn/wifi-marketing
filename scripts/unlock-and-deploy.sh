#!/usr/bin/env bash
# Dialog passphrase → ssh-add → deploy VPS (macOS).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${DEPLOY_KEY:-$HOME/.ssh/luong_h2t_ed25519}"
HOST="${DEPLOY_HOST:-14.161.29.98}"
USER_NAME="${DEPLOY_USER:-h2t}"
PORT="${DEPLOY_PORT:-22160}"

if [[ ! -f "$KEY" ]]; then
  echo "Không thấy key: $KEY"
  exit 1
fi

PASS=$(osascript <<'APPLESCRIPT'
display dialog "Passphrase SSH key luong_h2t_ed25519 — deploy H2T WiFi lên VPS" default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" with title "H2T Deploy"
if button returned of result is "Cancel" then
  return ""
end if
return text returned of result
APPLESCRIPT
) || true

if [[ -z "$PASS" ]]; then
  echo "Đã hủy / không nhập passphrase."
  exit 2
fi

if ! ssh-keygen -y -P "$PASS" -f "$KEY" >/dev/null 2>&1; then
  echo "Passphrase không đúng."
  exit 3
fi

eval "$(ssh-agent -s)" >/dev/null
expect <<EOF
spawn ssh-add "$KEY"
expect {
  "Enter passphrase" { send -- "$PASS\r"; exp_continue }
  eof
}
EOF
ssh-add -l

echo "==> Thử cài deploy key không-passphrase lên VPS (một lần)"
PUB_WIFI="$ROOT/.deploy/id_ed25519_wifi.pub"
if [[ -f "$PUB_WIFI" ]]; then
  PUB=$(cat "$PUB_WIFI")
  ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=10 \
    "${USER_NAME}@${HOST}" \
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qF '$PUB' ~/.ssh/authorized_keys || echo '$PUB' >> ~/.ssh/authorized_keys && echo pubkey_ok" \
    && echo "✓ Đã gắn .deploy/id_ed25519_wifi.pub vào authorized_keys"
fi

export DEPLOY_HOST="$HOST" DEPLOY_USER="$USER_NAME" DEPLOY_PORT="$PORT" DEPLOY_KEY="$KEY"
bash "$ROOT/scripts/deploy.sh"

echo "==> Health công khai:"
curl -fsS https://wifi.06.com.vn/health || true
echo
