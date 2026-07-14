#!/usr/bin/env bash
# Chạy trên VPS tại /opt/wifi-marketing (root hoặc user có quyền).
set -euo pipefail
APP="${DEPLOY_PATH:-/opt/wifi-marketing}"
cd "$APP"
echo "=== H2T WiFi update @ $(hostname) ==="
echo "BEFORE: $(git log -1 --oneline 2>/dev/null || echo 'no-git')"
if [ ! -d .git ]; then
  git init
  git remote add origin https://github.com/haileevn/wifi-marketing.git
fi
git remote set-url origin https://github.com/haileevn/wifi-marketing.git
git fetch origin
git checkout -B main origin/main
git reset --hard origin/main
# Preserve .env
npm install --omit=dev
npm run release -- --changelog "Deploy $(git rev-parse --short HEAD)" || true
if command -v pm2 >/dev/null; then
  pm2 restart wifi-portal --update-env || pm2 start "$APP/src/server.js" --name wifi-portal --cwd "$APP"
  pm2 save || true
else
  echo "WARN: pm2 không có — khởi động tay: node src/server.js"
fi
sleep 1
echo -n "LOCAL: "; curl -fsS http://127.0.0.1:${PORT:-20140}/health || echo fail
echo
echo -n "PUBLIC: "; curl -fsS https://wifi.06.com.vn/health || echo fail
echo
echo "AFTER: $(git log -1 --oneline)"
echo DEPLOY_DONE
