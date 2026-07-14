#!/bin/sh
# Chạy trên OpenWrt (mt7621 / mipsel_24kc) — KHÔNG dùng curl install.sh của Tailscale.com
set -e
VER="${TAILSCALE_VER:-1.98.8}"
ARCH=$(. /etc/os-release 2>/dev/null; echo "${OPENWRT_ARCH:-mipsel_24kc}")
IPK="tailscale_${VER}_${ARCH}.ipk"
URL="https://github.com/GuNanOvO/openwrt-tailscale/releases/download/v${VER}/${IPK}"
MIRROR="https://ghfast.top/https://github.com/GuNanOvO/openwrt-tailscale/releases/download/v${VER}/${IPK}"

echo "Arch=$ARCH → $IPK"
opkg update || true
opkg install kmod-tun ca-bundle || true
cd /tmp
rm -f "$IPK"
uclient-fetch -O "$IPK" "$URL" 2>/dev/null || wget -O "$IPK" "$URL" || \
  uclient-fetch -O "$IPK" "$MIRROR" || wget -O "$IPK" "$MIRROR"
opkg install "./$IPK" || opkg install --force-overwrite "./$IPK"
/etc/init.d/tailscale enable
/etc/init.d/tailscale start
echo "OK. Tiep: tailscale up --authkey=tskey-auth-... --hostname=TEN-QUAN --accept-dns=false"
tailscale version || true
