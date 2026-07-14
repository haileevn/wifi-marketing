/**
 * Router tự kéo cấu hình/firmware từ portal (không cần VPS SSH vào router).
 * Dùng report_token — router chạy: wget .../api/router/pull-config.sh?token=...
 */
const { buildOpenNDSCommandList, esc } = require("./router-commands");
const versioning = require("./version");

function buildPullConfigScript(location, domain, reportToken, sessionMinutes = 720) {
  const cmds = [
    "opkg update >/dev/null 2>&1 || true",
    "mkdir -p /etc/h2t-wifi",
    `echo '${esc(reportToken)}' > /etc/h2t-wifi/report_token`,
    `echo '${esc(domain)}' > /etc/h2t-wifi/portal_domain`,
    ...buildOpenNDSCommandList(location, domain, sessionMinutes, reportToken),
  ];
  const body = cmds.map((c) => `${c} || echo "WARN: ${c.slice(0, 60)}..."`).join("\n");
  return `#!/bin/sh
# H2T WiFi — pull config (portal v${versioning.portalVersion()})
set -e
echo "=== H2T pull-config ${location.gateway_name} ==="
${body}
echo "✓ pull-config OK"
`;
}

function buildPullFirmwareScript(domain, reportToken, version, filename) {
  const file = filename || `h2t-router-${version}.tar.gz`;
  const base = `https://${domain}`;
  return `#!/bin/sh
# H2T WiFi — pull firmware ${version}
set -e
mkdir -p /etc/h2t-wifi /tmp/h2t-fw
echo '${esc(reportToken)}' > /etc/h2t-wifi/report_token
echo '${esc(domain)}' > /etc/h2t-wifi/portal_domain
cd /tmp/h2t-fw && rm -rf ./*
(uclient-fetch -q -O ${esc(file)} '${base}/firmware/download/${esc(file)}' \\
  || wget -qO ${esc(file)} '${base}/firmware/download/${esc(file)}')
mkdir -p extract && tar -xzf ${esc(file)} -C extract
cd extract && chmod +x update.sh *.sh 2>/dev/null || true
H2T_FW_VERSION='${esc(version)}' H2T_PORTAL_DOMAIN='${esc(domain)}' ./update.sh
GW=$(uci -q get opennds.@opennds[0].gatewayname 2>/dev/null || true)
TOKEN=$(cat /etc/h2t-wifi/report_token 2>/dev/null || true)
VER=$(cat /etc/h2t-wifi/VERSION 2>/dev/null || echo '${esc(version)}')
[ -n "$GW" ] && [ -n "$TOKEN" ] && \\
  (wget -q -O - --post-data="gateway_name=$GW&version=$VER&token=$TOKEN" "https://${esc(domain)}/api/firmware/report" 2>/dev/null \\
    || uclient-fetch -q -O - --post-data="gateway_name=$GW&version=$VER&token=$TOKEN" "https://${esc(domain)}/api/firmware/report" 2>/dev/null) || true
echo "✓ firmware ${version} OK"
`;
}

module.exports = { buildPullConfigScript, buildPullFirmwareScript };
