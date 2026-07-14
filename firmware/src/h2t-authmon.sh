#!/bin/sh
# H2T WiFi — authmon: poll ndsctl mỗi phút, MAC offline → portal
H2T_DIR="/etc/h2t-wifi"
GATEWAY=$(uci -q get opennds.@opennds[0].gatewayname 2>/dev/null || true)
TOKEN=$(cat "$H2T_DIR/report_token" 2>/dev/null || true)
DOMAIN=$(cat "$H2T_DIR/portal_domain" 2>/dev/null || true)
[ -z "$GATEWAY" ] || [ -z "$TOKEN" ] || [ -z "$DOMAIN" ] && exit 0
STATE=/tmp/h2t-authmon-macs.txt
CUR=/tmp/h2t-authmon-cur.txt
report_end() {
  MAC="$1"
  [ -z "$MAC" ] && return 0
  DATA="token=$TOKEN&mac=$MAC&event=authmon_offline&gateway_name=$GATEWAY"
  (wget -q -O - --post-data="$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null \
    || uclient-fetch -q -O - --post-data="$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null \
    || curl -fsS -X POST -d "$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null) || true
}
: > "$CUR"
ndsctl clients 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    *MAC:*) _mac=$(echo "$line" | awk '{print $2}' | tr 'A-Z' 'a-z') ;;
    *State:*)
      echo "$line" | grep -qiE 'Auth|Preauth' && [ -n "$_mac" ] && echo "$_mac" >> "$CUR"
      _mac=""
      ;;
  esac
done
sort -u "$CUR" -o "$CUR" 2>/dev/null || true
if [ -f "$STATE" ]; then
  while IFS= read -r oldmac; do
    [ -z "$oldmac" ] && continue
    grep -qxF "$oldmac" "$CUR" 2>/dev/null || report_end "$oldmac"
  done < "$STATE"
fi
cp "$CUR" "$STATE" 2>/dev/null || true
