#!/bin/sh
# Chạy trên OpenWrt — sửa gatewayname cũ (comtam-q1) → comtam-72phl khớp portal
set -e
DOMAIN="wifi.06.com.vn"
GW="comtam-72phl"
# faskey phải trùng DB portal — lấy từ UCI hiện tại nếu đã đúng, hoặc set lại
# Mặc định trong .env: h2t-wifi-secret-2026 (đổi nếu bạn đã custom)
FASKEY="${1:-}"
if [ -z "$FASKEY" ]; then
  FASKEY=$(uci -q get opennds.@opennds[0].faskey)
fi
if [ -z "$FASKEY" ]; then
  echo "Usage: $0 <faskey>"
  echo "Lay faskey tu portal /admin (cột quan) hoac .env DEFAULT_FASKEY"
  exit 1
fi

echo "BEFORE:"
uci show opennds.@opennds[0] | egrep 'gatewayname|fasremote|faspath|faskey|enabled' || true

uci set opennds.@opennds[0].enabled='1'
uci set opennds.@opennds[0].gatewayname="$GW"
uci set opennds.@opennds[0].gatewayinterface='br-lan'
uci set opennds.@opennds[0].fas_secure_enabled='1'
uci set opennds.@opennds[0].fasremotefqdn="$DOMAIN"
uci set opennds.@opennds[0].fasport='80'
uci set opennds.@opennds[0].faspath='/fas'
uci set opennds.@opennds[0].faskey="$FASKEY"
uci set opennds.@opennds[0].fasssl='0'
uci set opennds.@opennds[0].sessiontimeout='720'
uci commit opennds

/etc/init.d/opennds stop
sleep 2
/etc/init.d/opennds start
sleep 1

echo "AFTER:"
uci get opennds.@opennds[0].gatewayname
uci get opennds.@opennds[0].fasremotefqdn
pgrep -a opennds || /etc/init.d/opennds status || true
echo "OK — disconnect WiFi tren dien thoai, ket noi lai H2T Free Wifi"
