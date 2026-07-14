#!/bin/sh
# H2T WiFi — binauth webhook (logout/timeout → portal)
H2T_DIR="/etc/h2t-wifi"
METHOD="${1:-}"
MAC="${2:-}"
[ -z "$MAC" ] && MAC="${clientmac:-${nds_client_mac:-}}"
GATEWAY=$(uci -q get opennds.@opennds[0].gatewayname 2>/dev/null || true)
TOKEN=$(cat "$H2T_DIR/report_token" 2>/dev/null || true)
DOMAIN=$(cat "$H2T_DIR/portal_domain" 2>/dev/null || true)
[ -z "$GATEWAY" ] || [ -z "$TOKEN" ] || [ -z "$DOMAIN" ] && exit 0
case "$METHOD" in
  auth_client|client_auth|authenticate) exit 0 ;;
  client_deauth|deauth|logout|timeout|idle_timeout|session_end|ndsctl_deauth)
    if [ -n "$MAC" ]; then
      DATA="token=$TOKEN&mac=$MAC&event=$METHOD&gateway_name=$GATEWAY"
      (wget -q -O - --post-data="$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null \
        || uclient-fetch -q -O - --post-data="$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null \
        || curl -fsS -X POST -d "$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null) || true
    fi
    exit 0 ;;
esac
exit 0
