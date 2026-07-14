#!/bin/sh
# OpenNDS binauth — gọi portal khi client logout/timeout (webhook ended_at)
# Cài tự động qua push OpenNDS config. Args: METHOD MAC GATEWAY TOKEN DOMAIN
METHOD="${1:-}"
MAC="${2:-}"
GATEWAY="${3:-}"
TOKEN="${4:-}"
DOMAIN="${5:-wifi.06.com.vn}"

case "$METHOD" in
  auth_client|client_auth|authenticate)
    exit 0
    ;;
  client_deauth|deauth|logout|timeout|idle_timeout|session_end|ndsctl_deauth)
    if [ -n "$MAC" ] && [ -n "$TOKEN" ]; then
      DATA="token=${TOKEN}&mac=${MAC}&event=${METHOD}&gateway_name=${GATEWAY}"
      (wget -q -O - --post-data="$DATA" "https://${DOMAIN}/api/session/end" 2>/dev/null \
        || uclient-fetch -q -O - --post-data="$DATA" "https://${DOMAIN}/api/session/end" 2>/dev/null \
        || curl -fsS -X POST -d "$DATA" "https://${DOMAIN}/api/session/end" 2>/dev/null) || true
    fi
    exit 0
    ;;
esac
exit 0
