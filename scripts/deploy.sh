#!/usr/bin/env bash
# Deploy portal lên VPS/Proxmox (SSH).
# Cách dùng:
#   DEPLOY_HOST=user@ip DEPLOY_PATH=/opt/wifi-marketing ./scripts/deploy.sh
#   ./scripts/deploy.sh user@14.x.x.x
set -euo pipefail

HOST="${1:-${DEPLOY_HOST:-}}"
REMOTE_PATH="${DEPLOY_PATH:-/opt/wifi-marketing}"
BRANCH="${DEPLOY_BRANCH:-main}"
PM2_NAME="${PM2_NAME:-wifi-portal}"

if [[ -z "$HOST" ]]; then
  echo "Usage: DEPLOY_HOST=user@host ./scripts/deploy.sh"
  echo "   or: ./scripts/deploy.sh user@host"
  echo ""
  echo "Hiện chưa có SSH key tới wifi.06.com.vn từ máy này — thêm key vào VPS rồi chạy lại."
  exit 1
fi

echo "==> Deploy $BRANCH -> $HOST:$REMOTE_PATH"
ssh -o StrictHostKeyChecking=accept-new "$HOST" bash -s <<EOF
set -euo pipefail
cd "$REMOTE_PATH"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
npm install --omit=dev
npm run release -- --changelog "Deploy \$(git rev-parse --short HEAD)"
# Giữ .env hiện có; chỉ nhắc nếu thiếu SECRETS_KEY
if ! grep -q '^SECRETS_KEY=.' .env 2>/dev/null; then
  echo "WARN: SECRETS_KEY thiếu trong .env"
fi
pm2 restart "$PM2_NAME" --update-env || pm2 start src/server.js --name "$PM2_NAME"
pm2 save
curl -fsS http://127.0.0.1:\${PORT:-20140}/health || curl -fsS https://wifi.06.com.vn/health || true
echo "Deploy OK"
EOF
