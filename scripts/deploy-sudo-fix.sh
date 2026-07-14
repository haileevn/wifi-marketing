#!/usr/bin/env bash
# Một lần trên máy dev: sửa quyền /opt/wifi-marketing trên VPS rồi deploy.
set -euo pipefail

HOST="${DEPLOY_HOST:-14.161.29.98}"
USER_NAME="${DEPLOY_USER:-h2t}"
PORT="${DEPLOY_PORT:-22160}"
KEY="${DEPLOY_KEY:-.deploy/id_ed25519_wifi}"
REMOTE_PATH="${DEPLOY_PATH:-/opt/wifi-marketing}"

PASS="${SUDO_PASS:-}"
if [[ -z "$PASS" ]]; then
  PASS=$(osascript -e 'text returned of (display dialog "Mat khau sudo user h2t tren VPS" default answer "" with hidden answer)' 2>/dev/null || true)
fi
[[ -n "$PASS" ]] || { echo "Thieu mat khau sudo"; exit 1; }

SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new)
[[ -f "$KEY" ]] && SSH+=(-i "$KEY" -o IdentitiesOnly=yes)

echo "==> Fix ownership $REMOTE_PATH on $USER_NAME@$HOST"
"${SSH[@]}" "${USER_NAME}@${HOST}" bash -s <<EOF
set -euo pipefail
printf '%s\n' $(printf %q "$PASS") | sudo -S chown -R "\$(whoami):\$(whoami)" "$REMOTE_PATH"
cd "$REMOTE_PATH"
git -c safe.directory="$REMOTE_PATH" fetch origin
git -c safe.directory="$REMOTE_PATH" checkout main
git -c safe.directory="$REMOTE_PATH" pull --ff-only origin main
npm install --omit=dev
pm2 restart wifi-portal --update-env || pm2 start src/server.js --name wifi-portal
pm2 save
curl -fsS "http://127.0.0.1:\${PORT:-20140}/health"
echo "OK \$(git -c safe.directory=$REMOTE_PATH rev-parse --short HEAD)"
EOF

curl -fsS "https://wifi.06.com.vn/health" && echo
