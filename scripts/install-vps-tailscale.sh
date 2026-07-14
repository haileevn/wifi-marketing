#!/usr/bin/env bash
# Cài Tailscale trên VPS portal — SSH router qua mesh 100.x.x.x
set -euo pipefail

HOST="${DEPLOY_HOST:-14.161.29.98}"
USER_NAME="${DEPLOY_USER:-h2t}"
PORT="${DEPLOY_PORT:-22160}"
KEY="${DEPLOY_KEY:-.deploy/id_ed25519_wifi}"

PASS="${SUDO_PASS:-}"
if [[ -z "$PASS" ]]; then
  PASS=$(osascript -e 'text returned of (display dialog "Mat khau sudo h2t tren VPS (Tailscale)" default answer "" with hidden answer)' 2>/dev/null || true)
fi
[[ -n "$PASS" ]] || { echo "Thieu mat khau sudo"; exit 1; }

SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new)
[[ -f "$KEY" ]] && SSH+=(-i "$KEY" -o IdentitiesOnly=yes)

echo "==> Install Tailscale on $USER_NAME@$HOST"
"${SSH[@]}" "${USER_NAME}@${HOST}" bash -s <<EOF
set -euo pipefail
APP=/opt/wifi-marketing
set -a; source "\$APP/.env"; set +a
if command -v tailscale >/dev/null 2>&1 && sudo tailscale status >/dev/null 2>&1; then
  echo "Tailscale already running:"
  sudo tailscale status | head -10
  exit 0
fi
printf '%s\n' $(printf %q "$PASS") | sudo -S bash -c '
  set -e
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  systemctl enable --now tailscaled
'
if [[ -z "\${TAILSCALE_AUTHKEY:-}" ]]; then
  echo "ERROR: TAILSCALE_AUTHKEY missing in .env"
  exit 1
fi
printf '%s\n' $(printf %q "$PASS") | sudo -S tailscale up --reset \
  --authkey="\$TAILSCALE_AUTHKEY" \
  --accept-dns=false \
  --hostname="h2t-wifi-portal" 2>/tmp/ts-up.err || true
sudo tailscale status | head -12
echo "Ping router (if enrolled):"
sudo tailscale ping -c 2 100.65.213.46 2>&1 || true
EOF
