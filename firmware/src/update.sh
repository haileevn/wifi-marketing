#!/bin/sh
# ============================================================
# H2T WiFi Marketing — Router firmware update
# Chạy trên OpenWrt/GL.iNet. Được đóng gói theo từng version release.
# ============================================================
set -e

H2T_DIR="/etc/h2t-wifi"
VERSION_FILE="$H2T_DIR/VERSION"
AGENT="/usr/sbin/h2t-check-update"
CRON_MARKER="# h2t-wifi-check-update"

# VERSION được inject lúc build (hoặc đọc từ file kèm gói)
NEW_VERSION="${H2T_FW_VERSION:-}"
if [ -z "$NEW_VERSION" ] && [ -f "./VERSION" ]; then
  NEW_VERSION=$(cat ./VERSION | tr -d ' \n\r')
fi
if [ -z "$NEW_VERSION" ]; then
  echo "!! Thiếu VERSION trong gói firmware"
  exit 1
fi

echo "=== H2T firmware update -> $NEW_VERSION ==="
mkdir -p "$H2T_DIR"
echo "$NEW_VERSION" > "$VERSION_FILE"

# Cài agent kiểm tra update định kỳ
if [ -f "./h2t-check-update.sh" ]; then
  cp ./h2t-check-update.sh "$AGENT"
  chmod 755 "$AGENT"
fi

# Ghi domain portal (nếu có sẵn từ env enroll / file)
if [ -n "$H2T_PORTAL_DOMAIN" ]; then
  echo "$H2T_PORTAL_DOMAIN" > "$H2T_DIR/portal_domain"
elif [ -f "./portal_domain" ]; then
  cp ./portal_domain "$H2T_DIR/portal_domain"
fi

# Cron mỗi 6 giờ — không trùng nếu đã có
if command -v crontab >/dev/null 2>&1; then
  TMP=$(mktemp 2>/dev/null || echo /tmp/h2t-cron.$$)
  crontab -l 2>/dev/null | grep -v "$CRON_MARKER" > "$TMP" || true
  echo "15 */6 * * * $AGENT $CRON_MARKER" >> "$TMP"
  crontab "$TMP" 2>/dev/null || true
  rm -f "$TMP"
fi

# Đảm bảo OpenNDS còn chạy (không đổi gateway nếu đã cấu hình)
if command -v service >/dev/null 2>&1; then
  service opennds enabled >/dev/null 2>&1 || service opennds enable 2>/dev/null || true
  if ! pgrep -x opennds >/dev/null 2>&1; then
    service opennds start 2>/dev/null || true
  fi
fi

# Binauth + authmon (session ended_at chính xác)
if [ -f "./h2t-binauth.sh" ]; then
  mkdir -p /etc/opennds
  cp ./h2t-binauth.sh /etc/opennds/h2t-binauth.sh
  chmod 755 /etc/opennds/h2t-binauth.sh
  uci set opennds.@opennds[0].binauth='/etc/opennds/h2t-binauth.sh' 2>/dev/null || true
  uci commit opennds 2>/dev/null || true
fi
if [ -f "./h2t-authmon.sh" ]; then
  cp ./h2t-authmon.sh /etc/opennds/h2t-authmon.sh
  chmod 755 /etc/opennds/h2t-authmon.sh
  opkg install cron 2>/dev/null || true
  /etc/init.d/cron enable 2>/dev/null; /etc/init.d/cron start 2>/dev/null || true
  mkdir -p /etc/crontabs
  touch /etc/crontabs/root
  grep -v h2t-authmon /etc/crontabs/root > /tmp/h2t-cron.tmp 2>/dev/null || true
  mv /tmp/h2t-cron.tmp /etc/crontabs/root 2>/dev/null || true
  grep -q h2t-authmon /etc/crontabs/root 2>/dev/null || echo '* * * * * /etc/opennds/h2t-authmon.sh' >> /etc/crontabs/root
  /etc/init.d/cron restart 2>/dev/null || true
fi

# Báo version về portal nếu có domain + token báo cáo
REPORT_URL=""
DOMAIN=$(cat "$H2T_DIR/portal_domain" 2>/dev/null || true)
TOKEN=$(cat "$H2T_DIR/report_token" 2>/dev/null || true)
GW=$(uci -q get opennds.@opennds[0].gatewayname 2>/dev/null || true)
if [ -n "$DOMAIN" ] && [ -n "$TOKEN" ] && [ -n "$GW" ]; then
  REPORT_URL="https://$DOMAIN/api/firmware/report"
  uclient-fetch -q -O - --post-data="gateway_name=$GW&version=$NEW_VERSION&token=$TOKEN" "$REPORT_URL" 2>/dev/null \
    || wget -qO- --post-data="gateway_name=$GW&version=$NEW_VERSION&token=$TOKEN" "$REPORT_URL" 2>/dev/null \
    || true
fi

echo "✓ Đã cài firmware H2T $NEW_VERSION"
echo "  Version file: $VERSION_FILE"
[ -x "$AGENT" ] && echo "  Agent: $AGENT"
