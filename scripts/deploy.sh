#!/usr/bin/env bash
# Deploy portal lên VPS/Proxmox (SSH).
#
# Cách dùng (theo SSH quen thuộc của H2T):
#   DEPLOY_HOST=14.161.29.98 DEPLOY_USER=h2t DEPLOY_PORT=22155 \
#   DEPLOY_KEY=~/.ssh/luong_h2t_ed25519 ./scripts/deploy.sh
#
# Hoặc sau khi cài deploy key (scripts/bootstrap-on-vps.sh):
#   DEPLOY_HOST=14.161.29.98 DEPLOY_USER=h2t DEPLOY_PORT=22155 \
#   DEPLOY_KEY=.deploy/id_ed25519_wifi ./scripts/deploy.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-${1:-}}"
USER_NAME="${DEPLOY_USER:-h2t}"
PORT="${DEPLOY_PORT:-22155}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/luong_h2t_ed25519}"
REMOTE_PATH="${DEPLOY_PATH:-/opt/wifi-marketing}"
BRANCH="${DEPLOY_BRANCH:-main}"
PM2_NAME="${PM2_NAME:-wifi-portal}"

if [[ -z "$HOST" ]]; then
  echo "Usage:"
  echo "  DEPLOY_HOST=14.161.29.98 DEPLOY_USER=h2t DEPLOY_PORT=22155 ./scripts/deploy.sh"
  exit 1
fi

SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new)
if [[ -f "$KEY" ]]; then
  SSH+=(-i "$KEY" -o IdentitiesOnly=yes)
fi
TARGET="${USER_NAME}@${HOST}"

echo "==> Deploy $BRANCH -> $TARGET:$PORT $REMOTE_PATH"
"${SSH[@]}" "$TARGET" bash -s <<EOF
set -euo pipefail
APP="$REMOTE_PATH"
if [[ ! -d "\$APP/.git" ]]; then
  sudo mkdir -p "\$APP"
  sudo chown -R "\$(whoami)" "\$APP"
  git clone https://github.com/haileevn/wifi-marketing.git "\$APP"
fi
cd "\$APP"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
npm install --omit=dev
npm run release -- --changelog "Deploy \$(git rev-parse --short HEAD)"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "WARN: created .env from example — điền ADMIN_PASS/SECRETS_KEY/TAILSCALE_AUTHKEY"
fi
pm2 restart "$PM2_NAME" --update-env || pm2 start src/server.js --name "$PM2_NAME"
pm2 save
curl -fsS "http://127.0.0.1:\${PORT:-20140}/health" || true
echo "Deploy OK \$(git rev-parse --short HEAD)"
EOF

echo "==> Verify public health"
curl -fsS "https://wifi.06.com.vn/health" || true
echo
