#!/bin/sh
# Dán/chạy trên OpenWrt — sửa portal auth (faskey, gatewayname, dnsmasq-full, tắt binauth lỗi)
set -e

DOMAIN="wifi.06.com.vn"
GW="comtam-72phl"
FASKEY="h2t-wifi-2026"

echo "=== BEFORE ==="
uci show opennds.@opennds[0] 2>/dev/null | egrep 'gatewayname|faskey|fasremote|fasport|faspath|fas_secure|binauth|enabled' || true
echo "Binauth file:"; uci -q get opennds.@opennds[0].binauth || echo "(none)"

echo "=== Install dnsmasq-full (walled garden) ==="
opkg update >/dev/null 2>&1 || true
if ! opkg list-installed | grep -q '^dnsmasq-full '; then
  opkg install dnsmasq-full 2>/dev/null \
    || { /etc/init.d/dnsmasq stop 2>/dev/null || true
         opkg remove dnsmasq --force-depends 2>/dev/null || true
         opkg install dnsmasq-full; }
  /etc/init.d/dnsmasq enable
  /etc/init.d/dnsmasq start
fi

echo "=== Apply OpenNDS FAS config ==="
uci set opennds.@opennds[0].enabled='1'
uci set opennds.@opennds[0].gatewayname="$GW"
uci set opennds.@opennds[0].gatewayinterface='br-lan'
uci set opennds.@opennds[0].fas_secure_enabled='1'
uci set opennds.@opennds[0].fasremotefqdn="$DOMAIN"
# Client CPD gọi portal qua HTTPS:443 (CloudPanel). Port 80 thường redirect.
# Level 1 FAS: openNDS ghép URL = http://fqdn:fasport/path — dùng 443 + fasssl nếu site force HTTPS.
uci set opennds.@opennds[0].fasport='443'
uci set opennds.@opennds[0].faspath='/fas'
uci set opennds.@opennds[0].faskey="$FASKEY"
uci set opennds.@opennds[0].fasssl='1'
uci set opennds.@opennds[0].sessiontimeout='720'

# Binauth webhook → portal (logout/timeout ghi ended_at)
mkdir -p /etc/opennds
TOKEN=$(cat /etc/h2t-wifi/report_token 2>/dev/null || echo "")
[ -z "$TOKEN" ] && TOKEN="manual"
cat > /etc/opennds/h2t-binauth.sh << BINSCRIPT
#!/bin/sh
METHOD="\${1:-}"; MAC="\${2:-}"; [ -z "\$MAC" ] && MAC="\${clientmac:-\${nds_client_mac:-}}"
GATEWAY="$GW"; TOKEN="$TOKEN"; DOMAIN="$DOMAIN"
case "\$METHOD" in
  auth_client|client_auth|authenticate) exit 0 ;;
  client_deauth|deauth|logout|timeout|idle_timeout|session_end|ndsctl_deauth)
    [ -n "\$MAC" ] && [ -n "\$TOKEN" ] && \\
      (wget -q -O - --post-data="token=\$TOKEN&mac=\$MAC&event=\$METHOD&gateway_name=\$GATEWAY" "https://\$DOMAIN/api/session/end" 2>/dev/null \\
        || uclient-fetch -q -O - --post-data="token=\$TOKEN&mac=\$MAC&event=\$METHOD&gateway_name=\$GATEWAY" "https://\$DOMAIN/api/session/end" 2>/dev/null) || true
    exit 0 ;;
esac
exit 0
BINSCRIPT
chmod +x /etc/opennds/h2t-binauth.sh
uci set opennds.@opennds[0].binauth='/etc/opennds/h2t-binauth.sh'

# DNS + HTTP/HTTPS trước auth (portal)
uci -q delete opennds.@opennds[0].preauthenticated_users
uci add_list opennds.@opennds[0].preauthenticated_users='allow udp port 53'
uci add_list opennds.@opennds[0].preauthenticated_users='allow tcp port 53'
uci add_list opennds.@opennds[0].preauthenticated_users='allow tcp port 80'
uci add_list opennds.@opennds[0].preauthenticated_users='allow tcp port 443'

uci -q delete opennds.@opennds[0].walledgarden_fqdn_list
uci add_list opennds.@opennds[0].walledgarden_fqdn_list="$DOMAIN"

uci commit opennds

/etc/init.d/dnsmasq restart || true
/etc/init.d/opennds stop
sleep 2
/etc/init.d/opennds start
sleep 2

echo "=== AFTER ==="
uci get opennds.@opennds[0].gatewayname
uci get opennds.@opennds[0].faskey
uci get opennds.@opennds[0].fasremotefqdn
uci get opennds.@opennds[0].fasport
uci get opennds.@opennds[0].fasssl
echo "LAN=$(uci get network.lan.ipaddr)"
pgrep -a opennds || true
ndsctl status 2>/dev/null | head -35 || true
echo
echo "OK. Tren dien thoai: quen WiFi -> ket noi lai -> nhap SDT -> BAM 'Mo Internet ngay'"
echo "Roi chay: ndsctl clients   (tim mac, state phai la Authenticated)"
