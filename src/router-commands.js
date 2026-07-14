/** Shell commands OpenNDS + binauth + authmon — dùng chung SSH push và router pull */

function esc(s) {
  return String(s || "").replace(/'/g, "'\\''");
}

function binauthInstallCmds(location, domain, reportToken) {
  const gw = esc(location.gateway_name);
  const dom = esc(domain);
  const tok = esc(reportToken || "");
  const script = `#!/bin/sh
# H2T WiFi — binauth webhook (logout/timeout → portal)
METHOD="\${1:-}"
MAC="\${2:-}"
[ -z "$MAC" ] && MAC="\${clientmac:-\${nds_client_mac:-}}"
GATEWAY='${gw}'
TOKEN='${tok}'
DOMAIN='${dom}'
case "$METHOD" in
  auth_client|client_auth|authenticate) exit 0 ;;
  client_deauth|deauth|logout|timeout|idle_timeout|session_end|ndsctl_deauth)
    if [ -n "$MAC" ] && [ -n "$TOKEN" ]; then
      DATA="token=$TOKEN&mac=$MAC&event=$METHOD&gateway_name=$GATEWAY"
      (wget -q -O - --post-data="$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null \\
        || uclient-fetch -q -O - --post-data="$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null \\
        || curl -fsS -X POST -d "$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null) || true
    fi
    exit 0 ;;
esac
exit 0
`;
  return [
    "mkdir -p /etc/opennds",
    `cat > /etc/opennds/h2t-binauth.sh << 'H2TBINAUTH'\n${script}\nH2TBINAUTH`,
    "chmod +x /etc/opennds/h2t-binauth.sh",
    `uci set opennds.@opennds[0].binauth='/etc/opennds/h2t-binauth.sh'`,
  ];
}

function authmonInstallCmds(location, domain, reportToken) {
  const gw = esc(location.gateway_name);
  const dom = esc(domain);
  const tok = esc(reportToken || "");
  const script = `#!/bin/sh
# H2T WiFi — authmon: mỗi phút poll ndsctl, MAC biến mất → portal ended_at
GATEWAY='${gw}'
TOKEN='${tok}'
DOMAIN='${dom}'
STATE=/tmp/h2t-authmon-macs.txt
CUR=/tmp/h2t-authmon-cur.txt
report_end() {
  MAC="$1"
  [ -z "$MAC" ] && return 0
  DATA="token=$TOKEN&mac=$MAC&event=authmon_offline&gateway_name=$GATEWAY"
  (wget -q -O - --post-data="$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null \\
    || uclient-fetch -q -O - --post-data="$DATA" "https://$DOMAIN/api/session/end" 2>/dev/null \\
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
`;
  return [
    `cat > /etc/opennds/h2t-authmon.sh << 'H2TAUTHMON'\n${script}\nH2TAUTHMON`,
    "chmod +x /etc/opennds/h2t-authmon.sh",
    "opkg install cron 2>/dev/null || true",
    "/etc/init.d/cron enable 2>/dev/null; /etc/init.d/cron start 2>/dev/null || true",
    "mkdir -p /etc/crontabs",
    "touch /etc/crontabs/root",
    "grep -v h2t-authmon /etc/crontabs/root > /tmp/cron.tmp 2>/dev/null || true",
    "mv /tmp/cron.tmp /etc/crontabs/root 2>/dev/null || true",
    "grep -q h2t-authmon /etc/crontabs/root 2>/dev/null || echo '* * * * * /etc/opennds/h2t-authmon.sh' >> /etc/crontabs/root",
    "/etc/init.d/cron restart 2>/dev/null || true",
  ];
}

function sshAccessCmds() {
  const script = `#!/bin/sh
# Mở SSH trên mọi interface (gồm tailscale0) — VPS SSH qua 100.x.x.x
for n in 0 1 2 3; do
  uci -q get dropbear.@dropbear[\$n] >/dev/null 2>&1 || break
  uci -q delete dropbear.@dropbear[\$n].Interface 2>/dev/null || true
  uci set dropbear.@dropbear[\$n].Interface=''
  uci set dropbear.@dropbear[\$n].Port='22'
  uci set dropbear.@dropbear[\$n].GatewayPorts='on'
done
uci commit dropbear 2>/dev/null || true
mkdir -p /etc/conf.d
echo 'DROPBEAR_EXTRA_ARGS="-p 0.0.0.0:22"' > /etc/conf.d/dropbear
/etc/init.d/dropbear enabled 2>/dev/null; /etc/init.d/dropbear restart 2>/dev/null || true
grep -q Allow-SSH-Tailscale /etc/config/firewall 2>/dev/null || {
  uci add firewall rule >/dev/null
  uci set firewall.@rule[-1].name='Allow-SSH-Tailscale'
  uci set firewall.@rule[-1].src='*'
  uci set firewall.@rule[-1].proto='tcp'
  uci set firewall.@rule[-1].dest_port='22'
  uci set firewall.@rule[-1].target='ACCEPT'
  uci commit firewall
}
/etc/init.d/firewall reload 2>/dev/null || true
iptables -C INPUT -i tailscale0 -p tcp --dport 22 -j ACCEPT 2>/dev/null \\
  || iptables -I INPUT -i tailscale0 -p tcp --dport 22 -j ACCEPT 2>/dev/null || true
`;
  return [
    `cat > /etc/opennds/h2t-ssh-access.sh << 'H2TSSH'\n${script}\nH2TSSH`,
    "chmod +x /etc/opennds/h2t-ssh-access.sh",
    "/etc/opennds/h2t-ssh-access.sh",
  ];
}

function heartbeatInstallCmds(location, domain, reportToken) {
  const gw = esc(location.gateway_name);
  const dom = esc(domain);
  const tok = esc(reportToken || "");
  const script = `#!/bin/sh
# H2T heartbeat — báo trạng thái về portal (Admin không cần SSH)
TOKEN='${tok}'
DOMAIN='${dom}'
GW='${gw}'
[ -z "$TOKEN" ] || [ -z "$DOMAIN" ] && exit 0
TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
MODEL=$(cat /tmp/sysinfo/model 2>/dev/null || echo unknown)
FW=$(cat /etc/h2t-wifi/VERSION 2>/dev/null || echo '')
UPTIME=$(uptime 2>/dev/null | sed 's/^[[:space:]]*//')
OPENNDS=0; pgrep -x opennds >/dev/null 2>&1 && OPENNDS=1
CLIENTS=0
command -v ndsctl >/dev/null 2>&1 && CLIENTS=$(ndsctl json 2>/dev/null | grep -oE '([0-9a-f]{2}:){5}[0-9a-f]{2}' | sort -u | wc -l | tr -d ' ')
SSH22=0; netstat -ln 2>/dev/null | grep -q ':22 ' && SSH22=1 || ss -ln 2>/dev/null | grep -q ':22 ' && SSH22=1
DATA="token=$TOKEN&gateway_name=$GW&ts_ip=$TS_IP&model=$MODEL&firmware_version=$FW&uptime=$UPTIME&opennds=$OPENNDS&client_count=$CLIENTS&ssh_listening=$SSH22"
(wget -q -O - --post-data="$DATA" "https://$DOMAIN/api/router/heartbeat" 2>/dev/null \\
  || uclient-fetch -q -O - --post-data="$DATA" "https://$DOMAIN/api/router/heartbeat" 2>/dev/null \\
  || curl -fsS -X POST -d "$DATA" "https://$DOMAIN/api/router/heartbeat" 2>/dev/null) || true
`;
  return [
    `cat > /etc/opennds/h2t-heartbeat.sh << 'H2THB'\n${script}\nH2THB`,
    "chmod +x /etc/opennds/h2t-heartbeat.sh",
    "grep -v h2t-heartbeat /etc/crontabs/root > /tmp/hb.cron 2>/dev/null || true",
    "mv /tmp/hb.cron /etc/crontabs/root 2>/dev/null || touch /etc/crontabs/root",
    "grep -q h2t-heartbeat /etc/crontabs/root 2>/dev/null || echo '*/5 * * * * /etc/opennds/h2t-heartbeat.sh' >> /etc/crontabs/root",
    "/etc/init.d/cron restart 2>/dev/null || true",
    "/etc/opennds/h2t-heartbeat.sh",
  ];
}


function buildOpenNDSCommandList(location, domain, sessionMinutes = 720, reportToken = "") {
  return [
    ...sshAccessCmds(),
    "opkg list-installed | grep -q '^dnsmasq-full ' || (opkg remove dnsmasq --force-depends 2>/dev/null; opkg install dnsmasq-full)",
    "opkg list-installed | grep -q opennds || opkg install opennds ca-bundle",
    "opkg install iptables-nft ip6tables-nft kmod-tun wget curl 2>/dev/null || true",
    `uci set opennds.@opennds[0].enabled='1'`,
    `uci set opennds.@opennds[0].gatewayname='${esc(location.gateway_name)}'`,
    `uci set opennds.@opennds[0].gatewayinterface='br-lan'`,
    `uci set opennds.@opennds[0].fas_secure_enabled='1'`,
    `uci set opennds.@opennds[0].fasremotefqdn='${esc(domain)}'`,
    `uci set opennds.@opennds[0].fasport='443'`,
    `uci set opennds.@opennds[0].faspath='/fas'`,
    `uci set opennds.@opennds[0].faskey='${esc(location.faskey)}'`,
    `uci set opennds.@opennds[0].fasssl='1'`,
    `uci set opennds.@opennds[0].sessiontimeout='${Number(sessionMinutes) || 720}'`,
    ...binauthInstallCmds(location, domain, reportToken),
    ...authmonInstallCmds(location, domain, reportToken),
    ...heartbeatInstallCmds(location, domain, reportToken),
    `uci -q delete opennds.@opennds[0].walledgarden_fqdn_list`,
    `uci add_list opennds.@opennds[0].walledgarden_fqdn_list='${esc(domain)}'`,
    `uci -q delete opennds.@opennds[0].users_to_router`,
    `uci add_list opennds.@opennds[0].users_to_router='allow udp port 53'`,
    `uci add_list opennds.@opennds[0].users_to_router='allow udp port 67'`,
    `uci add_list opennds.@opennds[0].users_to_router='allow tcp port 22'`,
    `uci add_list opennds.@opennds[0].users_to_router='allow tcp port 443'`,
    `uci add_list opennds.@opennds[0].users_to_router='allow tcp port 80'`,
    `uci commit opennds`,
    `/etc/init.d/dnsmasq restart || true`,
    `service opennds stop; sleep 2; service opennds start`,
  ];
}

module.exports = { esc, binauthInstallCmds, authmonInstallCmds, heartbeatInstallCmds, sshAccessCmds, buildOpenNDSCommandList };
