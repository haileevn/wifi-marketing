#!/usr/bin/env bash
# Sửa PM2 errored do port 20140 bị process root/node cũ chiếm
set -euo pipefail
HOST="${DEPLOY_HOST:-14.161.29.98}"
USER_NAME="${DEPLOY_USER:-h2t}"
PORT="${DEPLOY_PORT:-22160}"
KEY="${DEPLOY_KEY:-.deploy/id_ed25519_wifi}"
PASS="${SUDO_PASS:-}"
if [[ -z "$PASS" ]]; then
  PASS=$(osascript -e 'text returned of (display dialog "sudo h2t — fix PM2 port 20140" default answer "" with hidden answer)' 2>/dev/null || true)
fi
[[ -n "$PASS" ]] || { echo "Thieu sudo password"; exit 1; }
SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new)
[[ -f "$KEY" ]] && SSH+=(-i "$KEY" -o IdentitiesOnly=yes)
"${SSH[@]}" "${USER_NAME}@${HOST}" bash -s <<EOF
set -euo pipefail
printf '%s\n' $(printf %q "$PASS") | sudo -S bash -c '
  pkill -f "node /opt/wifi-marketing/src/server.js" 2>/dev/null || true
  fuser -k 20140/tcp 2>/dev/null || true
  sleep 2
'
cd /opt/wifi-marketing
pm2 delete wifi-portal 2>/dev/null || true
pm2 start src/server.js --name wifi-portal
pm2 save
sleep 2
pm2 list
curl -fsS http://127.0.0.1:20140/health
echo
EOF
