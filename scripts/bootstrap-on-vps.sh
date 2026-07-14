#!/usr/bin/env bash
# Chạy MỘT LẦN trên VPS (sau khi bạn SSH được bằng passphrase key).
# Cài pubkey deploy (không passphrase) + clone/pull portal + PM2.
#
# Từ máy local (sau khi SSH thủ công vào VPS):
#   scp -P 22160 scripts/bootstrap-on-vps.sh h2t@14.161.29.98:/tmp/
#   scp -P 22160 .deploy/id_ed25519_wifi.pub h2t@14.161.29.98:/tmp/wifi-deploy.pub
#   ssh -p 22160 h2t@14.161.29.98 'bash /tmp/bootstrap-on-vps.sh /tmp/wifi-deploy.pub'
set -euo pipefail

PUBKEY_FILE="${1:-/tmp/wifi-deploy.pub}"
APP_DIR="${DEPLOY_PATH:-/opt/wifi-marketing}"
PM2_NAME="${PM2_NAME:-wifi-portal}"

if [[ ! -f "$PUBKEY_FILE" ]]; then
  echo "Missing pubkey file: $PUBKEY_FILE"
  exit 1
fi

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
PUB=$(cat "$PUBKEY_FILE")
grep -qF "$PUB" "$HOME/.ssh/authorized_keys" || echo "$PUB" >> "$HOME/.ssh/authorized_keys"
echo "✓ Deploy pubkey installed"

if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo mkdir -p "$APP_DIR"
  sudo chown -R "$(whoami)" "$APP_DIR"
  git clone https://github.com/haileevn/wifi-marketing.git "$APP_DIR"
fi

cd "$APP_DIR"
git fetch origin && git checkout main && git pull --ff-only origin main
npm install --omit=dev
[[ -f .env ]] || cp .env.example .env
npm run release -- --changelog "Bootstrap $(git rev-parse --short HEAD)"
command -v pm2 >/dev/null || npm install -g pm2
pm2 restart "$PM2_NAME" --update-env || pm2 start src/server.js --name "$PM2_NAME"
pm2 save
curl -fsS "http://127.0.0.1:${PORT:-20140}/health" || true
echo
echo "Bootstrap done. From laptop (no passphrase):"
echo "  DEPLOY_HOST=14.161.29.98 DEPLOY_USER=$(whoami) DEPLOY_PORT=22160 DEPLOY_KEY=.deploy/id_ed25519_wifi ./scripts/deploy.sh"
