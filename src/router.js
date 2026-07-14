/**
 * Điều khiển router OpenWrt từ xa qua SSH.
 * VPS phải join Tailscale mesh (tag:portal) mới SSH được IP 100.x.x.x.
 * Fallback: router tự pull qua /api/router/pull-config.sh?token=...
 */
const { NodeSSH } = require("node-ssh");
const { buildOpenNDSCommandList, esc } = require("./router-commands");

const SSH_TIMEOUT = Number(process.env.SSH_READY_TIMEOUT || 25000);
const SSH_RETRIES = Number(process.env.SSH_RETRIES || 2);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function enrichSshError(err, router) {
  const msg = err?.message || String(err);
  const host = router?.ssh_host || "?";
  const port = router?.ssh_port || 22;
  if (/ECONNREFUSED/i.test(msg)) {
    return new Error(
      `connect ECONNREFUSED ${host}:${port} — Router chưa mở SSH trên Tailscale. ` +
      "Chạy lệnh Pull config trên router (Admin → Router), đợi 2 phút rồi Làm mới. " +
      "Trạng thái vẫn hiện qua heartbeat sau khi pull."
    );
  }
  if (/handshake|timed out|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(msg)) {
    return new Error(
      `${msg} — Không SSH được ${host}:${port}. Kiểm tra Tailscale trên VPS/router hoặc dùng Pull trên router.`
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

async function connect(router) {
  const ssh = new NodeSSH();
  const opts = {
    host: router.ssh_host,
    port: router.ssh_port || 22,
    username: router.ssh_user || "root",
    readyTimeout: SSH_TIMEOUT,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  };
  if (router.ssh_privkey) opts.privateKey = router.ssh_privkey;
  else opts.password = router.ssh_password || undefined;

  let lastErr;
  for (let attempt = 0; attempt <= SSH_RETRIES; attempt++) {
    try {
      await ssh.connect(opts);
      return ssh;
    } catch (e) {
      lastErr = e;
      if (attempt < SSH_RETRIES) await sleep(1500 * (attempt + 1));
    }
  }
  throw enrichSshError(lastErr, router);
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

async function testConnection(router) {
  try {
    const out = await run(router, "cat /etc/openwrt_release 2>/dev/null | grep DISTRIB_DESCRIPTION");
    return { ok: true, info: out || "OpenWrt" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pushOpenNDSConfig(router, location, domain, sessionMinutes = 720, reportToken = "") {
  const cmds = buildOpenNDSCommandList(location, domain, sessionMinutes, reportToken);
  const ssh = await connect(router);
  try {
    const out = [];
    for (const c of cmds) {
      const res = await ssh.execCommand(c);
      out.push({ cmd: c, stdout: res.stdout, stderr: res.stderr, code: res.code });
      if (res.code !== 0 && !c.includes("opkg list-installed")) {
        if (!/already installed|nothing to do/i.test(res.stderr || "")) {
          console.warn(`[router] lệnh "${c}" trả về code ${res.code}: ${res.stderr}`);
        }
      }
    }
    return { ok: true, log: out };
  } finally {
    ssh.dispose();
  }
}

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

async function disconnectClient(router, mac) {
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) throw new Error("MAC không hợp lệ");
  return run(router, `ndsctl deauth ${mac}`);
}

async function getStatus(router) {
  const ssh = await connect(router);
  try {
    const [uptime, ndsStatus, model, clients, fwVer] = await Promise.all([
      ssh.execCommand("uptime"),
      ssh.execCommand("service opennds status 2>&1 || pgrep opennds"),
      ssh.execCommand("cat /tmp/sysinfo/model 2>/dev/null"),
      ssh.execCommand("ndsctl json 2>/dev/null || echo '{}'"),
      ssh.execCommand("cat /etc/h2t-wifi/VERSION 2>/dev/null || echo ''"),
    ]);
    let clientCount = 0;
    try { clientCount = Object.keys(JSON.parse(clients.stdout).clients || {}).length; } catch {}
    return {
      ok: true,
      uptime: uptime.stdout.trim(),
      opennds_running: !!(ndsStatus.stdout || "").trim(),
      model: model.stdout.trim(),
      client_count: clientCount,
      firmware_version: (fwVer.stdout || "").trim(),
    };
  } finally {
    ssh.dispose();
  }
}

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
  pushFirmwareUpdate, readRemoteFirmwareVersion, connect, enrichSshError,
};
