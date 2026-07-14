/**
 * Điều khiển router OpenWrt từ xa qua SSH.
 *
 * ĐIỀU KIỆN BẮT BUỘC: VPS phải SSH được vào IP router.
 * Trong thực tế router ở quán thường sau NAT của nhà mạng (IP động, CGNAT)
 * nên KHÔNG mở được từ Internet trực tiếp. 2 cách giải quyết:
 *
 *   1) Port-forward: router mạng chính (modem) mở port SSH ra ngoài trỏ vào router quán.
 *      Chỉ dùng được nếu nhà mạng cấp IP tĩnh/công khai.
 *   2) VPN mesh (khuyên dùng): cài Tailscale hoặc WireGuard lên router (opkg install tailscale)
 *      và lên VPS, cả 2 join chung 1 mesh network -> VPS SSH vào router qua IP nội bộ Tailscale
 *      (100.x.x.x), hoạt động bất kể router có CGNAT hay không.
 *
 * ssh_host lưu trong DB nên là: IP LAN thật (nếu port-forward) hoặc IP Tailscale (100.x.x.x).
 */
const { NodeSSH } = require("node-ssh");

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

async function connect(router) {
  const ssh = new NodeSSH();
  const opts = {
    host: router.ssh_host,
    port: router.ssh_port || 22,
    username: router.ssh_user || "root",
    readyTimeout: 8000,
  };
  // Ưu tiên SSH key (được sinh tự động qua gói cài đặt) nếu có, fallback về password
  if (router.ssh_privkey) opts.privateKey = router.ssh_privkey;
  else opts.password = router.ssh_password || undefined;

  await ssh.connect(opts);
  return ssh;
}

async function run(router, command) {
  const ssh = await connect(router);
  try {
    const res = await ssh.execCommand(command);
    if (res.code !== 0 && res.stderr) throw new Error(res.stderr.trim());
    return res.stdout.trim();
  } finally {
    ssh.dispose();
  }
}

/* ── Test kết nối SSH ──────────────────────────────────────── */
async function testConnection(router) {
  try {
    const out = await run(router, "cat /etc/openwrt_release 2>/dev/null | grep DISTRIB_DESCRIPTION");
    return { ok: true, info: out || "OpenWrt" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ── Đẩy cấu hình OpenNDS xuống router ────────────────────── */
// domain: domain portal (vd wifi.06.com.vn), phải chạy plain HTTP path /fas /auth (xem README)
async function pushOpenNDSConfig(router, location, domain, sessionMinutes = 720, reportToken = "") {
  const cmds = [
    "opkg update >/dev/null 2>&1 || true",
    // OpenWrt 23.05/nft: cần dnsmasq-full cho walled garden + ipset/nftset
    "opkg list-installed | grep -q '^dnsmasq-full ' || (opkg remove dnsmasq --force-depends 2>/dev/null; opkg install dnsmasq-full)",
    "opkg list-installed | grep -q opennds || opkg install opennds ca-bundle",
    "opkg install iptables-nft ip6tables-nft kmod-tun wget curl 2>/dev/null || true",
    `uci set opennds.@opennds[0].enabled='1'`,
    `uci set opennds.@opennds[0].gatewayname='${esc(location.gateway_name)}'`,
    `uci set opennds.@opennds[0].gatewayinterface='br-lan'`,
    `uci set opennds.@opennds[0].fas_secure_enabled='1'`,
    `uci set opennds.@opennds[0].fasremotefqdn='${esc(domain)}'`,
    // HTTPS portal (CloudPanel): fasport 443 + fasssl=1
    `uci set opennds.@opennds[0].fasport='443'`,
    `uci set opennds.@opennds[0].faspath='/fas'`,
    `uci set opennds.@opennds[0].faskey='${esc(location.faskey)}'`,
    `uci set opennds.@opennds[0].fasssl='1'`,
    `uci set opennds.@opennds[0].sessiontimeout='${Number(sessionMinutes)||720}'`,
    ...binauthInstallCmds(location, domain, reportToken),
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
  const ssh = await connect(router);
  try {
    const out = [];
    for (const c of cmds) {
      const res = await ssh.execCommand(c);
      out.push({ cmd: c, stdout: res.stdout, stderr: res.stderr, code: res.code });
      if (res.code !== 0 && !c.includes("opkg list-installed")) {
        // opkg install có thể "fail" nếu đã cài rồi -> không throw, chỉ ghi log
        if (!/already installed|nothing to do/i.test(res.stderr||"")) {
          console.warn(`[router] lệnh "${c}" trả về code ${res.code}: ${res.stderr}`);
        }
      }
    }
    return { ok: true, log: out };
  } finally {
    ssh.dispose();
  }
}

/* ── Đổi tên WiFi (SSID) + mật khẩu từ xa ────────────────── */
// radio: 0 (2.4GHz) hoặc 1 (5GHz); để trống band = áp dụng cho cả 2
async function setWifi(router, { ssid, password, radio }) {
  const radios = radio === undefined || radio === "" ? [0, 1] : [Number(radio)];
  const ssh = await connect(router);
  try {
    for (const r of radios) {
      await ssh.execCommand(`uci set wireless.@wifi-iface[${r}].ssid='${esc(ssid)}'`);
      await ssh.execCommand(`uci set wireless.@wifi-iface[${r}].disabled='0'`);
      if (password && password.length >= 8) {
        await ssh.execCommand(`uci set wireless.@wifi-iface[${r}].encryption='psk2'`);
        await ssh.execCommand(`uci set wireless.@wifi-iface[${r}].key='${esc(password)}'`);
      } else {
        // Không đặt mật khẩu -> mở, khách vào thẳng portal không cần nhập WiFi password
        await ssh.execCommand(`uci set wireless.@wifi-iface[${r}].encryption='none'`);
      }
    }
    await ssh.execCommand("uci commit wireless");
    const res = await ssh.execCommand("wifi reload");
    return { ok: true, stdout: res.stdout };
  } finally {
    ssh.dispose();
  }
}

/* ── Danh sách client đang kết nối (qua ndsctl) ─────────────── */
async function listClients(router) {
  const out = await run(router, "ndsctl json 2>/dev/null || echo '{}'");
  try {
    const data = JSON.parse(out);
    const clients = data.clients || data;
    return Object.entries(clients || {}).map(([mac, info]) => ({
      mac,
      ip: info.ip || "",
      state: info.state || info.client_type || "",
      downloaded: info.downloaded || 0,
      uploaded: info.uploaded || 0,
      active: info.active || "",
    }));
  } catch {
    return [];
  }
}

/* ── Ngắt kết nối 1 client theo MAC ──────────────────────────── */
async function disconnectClient(router, mac) {
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) throw new Error("MAC không hợp lệ");
  return run(router, `ndsctl deauth ${mac}`);
}

/* ── Trạng thái tổng quát router ──────────────────────────────── */
async function getStatus(router) {
  const ssh = await connect(router);
  try {
    const [uptime, ndsStatus, model, clients] = await Promise.all([
      ssh.execCommand("uptime"),
      ssh.execCommand("service opennds status 2>&1 || pgrep opennds"),
      ssh.execCommand("cat /tmp/sysinfo/model 2>/dev/null"),
      ssh.execCommand("ndsctl json 2>/dev/null || echo '{}'"),
    ]);
    let clientCount = 0;
    try { clientCount = Object.keys(JSON.parse(clients.stdout).clients || {}).length; } catch {}
    return {
      ok: true,
      uptime: uptime.stdout.trim(),
      opennds_running: !!(ndsStatus.stdout || "").trim(),
      model: model.stdout.trim(),
      client_count: clientCount,
    };
  } finally {
    ssh.dispose();
  }
}

function esc(s) {
  return String(s || "").replace(/'/g, "'\\''");
}

/**
 * Đẩy gói firmware từ portal xuống router qua SSH:
 * wget/uclient-fetch latest -> tar xz -> update.sh
 */
async function pushFirmwareUpdate(router, { domain, version, filename }) {
  const file = filename || `h2t-router-${version}.tar.gz`;
  const base = `https://${domain}`;
  const cmds = [
    "mkdir -p /tmp/h2t-fw && rm -rf /tmp/h2t-fw/*",
    `cd /tmp/h2t-fw && (uclient-fetch -q -O ${esc(file)} '${base}/firmware/download/${esc(file)}' || wget -qO ${esc(file)} '${base}/firmware/download/${esc(file)}')`,
    `cd /tmp/h2t-fw && mkdir -p extract && tar -xzf ${esc(file)} -C extract`,
    `cd /tmp/h2t-fw/extract && chmod +x update.sh h2t-check-update.sh 2>/dev/null; echo '${esc(domain)}' > /etc/h2t-wifi/portal_domain 2>/dev/null || (mkdir -p /etc/h2t-wifi && echo '${esc(domain)}' > /etc/h2t-wifi/portal_domain)`,
  ];
  if (router.report_token) {
    cmds.push(`mkdir -p /etc/h2t-wifi && echo '${esc(router.report_token)}' > /etc/h2t-wifi/report_token`);
  }
  cmds.push(`cd /tmp/h2t-fw/extract && H2T_FW_VERSION='${esc(version)}' H2T_PORTAL_DOMAIN='${esc(domain)}' ./update.sh`);
  cmds.push("cat /etc/h2t-wifi/VERSION 2>/dev/null || true");

  const ssh = await connect(router);
  try {
    const log = [];
    let installed = "";
    for (const c of cmds) {
      const res = await ssh.execCommand(c);
      log.push({ cmd: c.slice(0, 120), stdout: res.stdout, stderr: res.stderr, code: res.code });
      if (res.code !== 0) {
        throw new Error(res.stderr || res.stdout || `cmd failed: ${c.slice(0, 80)}`);
      }
      if (c.includes("VERSION")) installed = (res.stdout || "").trim();
    }
    return { ok: true, version: installed || version, log };
  } finally {
    ssh.dispose();
  }
}

async function readRemoteFirmwareVersion(router) {
  try {
    const out = await run(router, "cat /etc/h2t-wifi/VERSION 2>/dev/null || echo ''");
    return { ok: true, version: out.trim() };
  } catch (e) {
    return { ok: false, error: e.message, version: "" };
  }
}

module.exports = {
  testConnection, pushOpenNDSConfig, setWifi, listClients, disconnectClient, getStatus,
  pushFirmwareUpdate, readRemoteFirmwareVersion,
};
