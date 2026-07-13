#!/bin/sh
# ============================================================
# Cấu hình OpenNDS trên router OpenWrt / GL.iNet cho 1 quán
# Chạy trực tiếp trên router qua SSH: sh router-setup.sh
# SỬA 3 BIẾN DƯỚI ĐÂY cho từng quán trước khi chạy!
# ============================================================

GATEWAY_NAME="comtam-q1"              # phải trùng gateway_name đã khai trên portal
FAS_KEY="h2t-wifi-secret-2026"        # phải trùng faskey của quán trên portal
FAS_DOMAIN="wifi.06.com.vn"           # domain portal trên Proxmox/VPS (đã trỏ DNS + SSL)

SESSION_MINUTES="720"                 # 12 tiếng, hết hạn khách phải nhập lại

# ------------------------------------------------------------
opkg update
opkg install opennds ca-bundle

uci set opennds.@opennds[0].enabled='1'
uci set opennds.@opennds[0].gatewayname="$GATEWAY_NAME"
uci set opennds.@opennds[0].gatewayinterface='br-lan'

# FAS remote qua HTTPS
uci set opennds.@opennds[0].fas_secure_enabled='1'
uci set opennds.@opennds[0].fasremotefqdn="$FAS_DOMAIN"
uci set opennds.@opennds[0].fasport='443'
uci set opennds.@opennds[0].faspath='/fas'
uci set opennds.@opennds[0].faskey="$FAS_KEY"
uci set opennds.@opennds[0].fasssl='1'

# Thời gian phiên + giới hạn
uci set opennds.@opennds[0].sessiontimeout="$SESSION_MINUTES"
uci set opennds.@opennds[0].preauthidletimeout='10'

# Walled garden: các domain được phép TRƯỚC khi đăng nhập
# (portal tự được whitelist qua fasremotefqdn; thêm domain khác nếu portal cần)
# uci add_list opennds.@opennds[0].walledgarden_fqdn_list='zalo.me'

uci commit opennds
service opennds restart

echo "============================================"
echo "Xong! Gateway: $GATEWAY_NAME -> https://$FAS_DOMAIN/fas"
echo "Test: kết nối WiFi bằng điện thoại, popup portal sẽ tự hiện."
echo "Xem log: logread | grep opennds"
echo "============================================"
