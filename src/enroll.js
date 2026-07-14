/**
 * Enrollment: sinh gói cài đặt tự động cho router.
 *
 * Luồng hoạt động:
 *  1. Admin bấm "Tạo gói cài đặt" trên portal -> server sinh cặp SSH key (ed25519),
 *     lưu private key trong DB (routers.ssh_privkey), nhúng public key vào script cài.
 *  2. Admin copy lệnh 1 dòng, SSH/dán vào router chạy.
 *  3. Script tự: cài OpenNDS + cấu hình theo đúng quán, cài Tailscale + join mesh
 *     bằng authkey, thêm public key vào authorized_keys, rồi tự báo IP Tailscale
 *     về server qua endpoint /api/enroll/:token.
 *  4. Server nhận IP -> lưu vào routers.ssh_host -> từ đó trang quản lý Router
 *     dùng SSH key có sẵn để điều khiển từ xa, không cần nhập gì thêm.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** Sinh cặp khoá ed25519 mới. Yêu cầu package `openssh-client` (ssh-keygen) trên VPS. */
function generateKeypair(comment = "h2t-wifi") {
  const tmpBase = path.join(os.tmpdir(), `h2tkey-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    execFileSync("ssh-keygen", ["-t", "ed25519", "-f", tmpBase, "-N", "", "-C", comment], { stdio: "pipe" });
    const pub = fs.readFileSync(tmpBase + ".pub", "utf8").trim();
    const priv = fs.readFileSync(tmpBase, "utf8");
    return { pub, priv };
  } finally {
    fs.rmSync(tmpBase, { force: true });
    fs.rmSync(tmpBase + ".pub", { force: true });
  }
}

/**
 * Build script cài đặt (POSIX sh, tương thích BusyBox ash trên OpenWrt).
 * Tailscale trên OpenWrt 23.05+ không còn trong feed chính — tải IPK community (GuNanOvO)
 * theo OPENWRT_ARCH (vd mipsel_24kc).
 */
function buildInstallScript({ location, domain, token, pubkey, tailscaleAuthKey, firmwareVersion, reportToken }) {
  const proto = "https";
  const callbackUrl = `${proto}://${domain}/api/enroll/${token}`;
  const fwVer = firmwareVersion || "0.0.0";
  const reportTok = reportToken || "";
  const tsKey = String(tailscaleAuthKey || "").replace(/'/g, "'\\''");
  // Pin bản IPK đã kiểm tra có mipsel_24kc (OpenWrt 23.05 / mt7621)
  const tsVer = process.env.OPENWRT_TAILSCALE_VERSION || "1.98.8";

  return `#!/bin/sh
# ============================================================
#  H2T WiFi Marketing - Gói cài đặt tự động cho "${location.display_name}"
#  Sinh tự động - KHÔNG chia sẻ link này công khai (chứa quyền cài đặt router)
# ============================================================
set -e
echo "=== Bắt đầu cài đặt cho quán: ${location.display_name} ==="

# ---- 1) Cài OpenNDS ----
echo "[1/6] Cài OpenNDS..."
opkg update >/dev/null 2>&1 || true
opkg list-installed 2>/dev/null | grep -q '^opennds ' || opkg install opennds ca-bundle

# ---- 2) Cấu hình OpenNDS trỏ về portal ----
echo "[2/6] Cấu hình OpenNDS..."
uci set opennds.@opennds[0].enabled='1'
uci set opennds.@opennds[0].gatewayname='${location.gateway_name}'
uci set opennds.@opennds[0].gatewayinterface='br-lan'
uci set opennds.@opennds[0].fas_secure_enabled='1'
uci set opennds.@opennds[0].fasremotefqdn='${domain}'
uci set opennds.@opennds[0].fasport='80'
uci set opennds.@opennds[0].faspath='/fas'
uci set opennds.@opennds[0].faskey='${location.faskey}'
uci set opennds.@opennds[0].fasssl='0'
uci set opennds.@opennds[0].sessiontimeout='720'
uci commit opennds
service opennds enable

# ---- 3) Thêm SSH public key để portal điều khiển từ xa ----
echo "[3/6] Thêm SSH key quản trị..."
mkdir -p /etc/dropbear
touch /etc/dropbear/authorized_keys
grep -qF "${pubkey}" /etc/dropbear/authorized_keys 2>/dev/null || \\
  echo "${pubkey}" >> /etc/dropbear/authorized_keys
chmod 600 /etc/dropbear/authorized_keys

# ---- 4) Cài Tailscale (OpenWrt — KHÔNG dùng install.sh của Tailscale.com) ----
echo "[4/6] Cài Tailscale cho OpenWrt..."
install_tailscale_openwrt() {
  opkg update >/dev/null 2>&1 || true
  opkg install kmod-tun ca-bundle 2>/dev/null || true
  # 1) thử feed chính (một số build còn package)
  if opkg list-installed 2>/dev/null | grep -q '^tailscale '; then
    return 0
  fi
  if opkg install tailscale 2>/dev/null; then
    return 0
  fi
  # 2) IPK community theo OPENWRT_ARCH (vd mipsel_24kc)
  ARCH=\$(. /etc/os-release 2>/dev/null; echo "\${OPENWRT_ARCH:-}")
  [ -n "\$ARCH" ] || ARCH=\$(opkg print-architecture 2>/dev/null | awk '\$1=="arch"{print \$2; exit}')
  [ -n "\$ARCH" ] || ARCH=mipsel_24kc
  VER="${tsVer}"
  IPK="tailscale_\${VER}_\${ARCH}.ipk"
  URL1="https://github.com/GuNanOvO/openwrt-tailscale/releases/download/v\${VER}/\${IPK}"
  # mirror (GitHub có thể chậm từ VN)
  URL2="https://ghfast.top/https://github.com/GuNanOvO/openwrt-tailscale/releases/download/v\${VER}/\${IPK}"
  echo "  Arch=\$ARCH → tải \$IPK"
  cd /tmp
  rm -f "\$IPK"
  if command -v uclient-fetch >/dev/null 2>&1; then
    uclient-fetch -q -O "\$IPK" "\$URL1" || uclient-fetch -q -O "\$IPK" "\$URL2" || true
  else
    wget -qO "\$IPK" "\$URL1" || wget -qO "\$IPK" "\$URL2" || true
  fi
  if [ ! -s "\$IPK" ]; then
    echo "!! Không tải được Tailscale IPK cho arch \$ARCH"
    echo "!! Tải tay: \$URL1"
    echo "!! Rồi: opkg install kmod-tun && opkg install /tmp/\$IPK"
    return 1
  fi
  opkg install "/tmp/\$IPK" || opkg install --force-overwrite "/tmp/\$IPK"
}

if ! command -v tailscale >/dev/null 2>&1; then
  install_tailscale_openwrt || {
    echo "!! Cài Tailscale thất bại — dừng enroll (cần mesh VPN)."
    exit 1
  }
fi

# Khởi động daemon (OpenWrt package: /etc/init.d/tailscale → tailscaled)
/etc/init.d/tailscale enable 2>/dev/null || true
/etc/init.d/tailscale stop 2>/dev/null || true
/etc/init.d/tailscale start 2>/dev/null || service tailscale start 2>/dev/null || {
  # fallback trực tiếp
  mkdir -p /var/lib/tailscale /var/run
  (tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock >/tmp/tailscaled.log 2>&1 &) || true
}
# Đợi sock sẵn sàng (tối đa ~20s)
i=0
while [ \$i -lt 20 ]; do
  if tailscale status >/dev/null 2>&1 || [ -S /var/run/tailscale/tailscaled.sock ] || [ -S /tmp/tailscaled.sock ]; then
    break
  fi
  i=\$((i+1)); sleep 1
done
sleep 1
# Auth key chỉ dùng trong biến — không echo
TS_AUTHKEY='${tsKey}'
if [ -z "\$TS_AUTHKEY" ]; then
  echo "!! Server thiếu TAILSCALE_AUTHKEY"
  exit 1
fi
if ! tailscale up --authkey="\$TS_AUTHKEY" --hostname="${location.gateway_name}" --accept-dns=false --advertise-tags=tag:router 2>/tmp/ts-up.err; then
  # Một số build không hỗ trợ --advertise-tags
  if ! tailscale up --authkey="\$TS_AUTHKEY" --hostname="${location.gateway_name}" --accept-dns=false 2>>/tmp/ts-up.err; then
    echo "!! tailscale up thất bại:"
    cat /tmp/ts-up.err 2>/dev/null || true
    echo "!! Thử tay: /etc/init.d/tailscale start && tailscale up --authkey=... --hostname=${location.gateway_name}"
    exit 1
  fi
fi
unset TS_AUTHKEY

# ---- 5) Cài firmware agent H2T (OTA) ----
echo "[5/6] Cài firmware agent H2T ${fwVer}..."
mkdir -p /etc/h2t-wifi /tmp/h2t-fw
echo '${domain}' > /etc/h2t-wifi/portal_domain
${reportTok ? `echo '${reportTok}' > /etc/h2t-wifi/report_token` : "true"}
cd /tmp/h2t-fw
uclient-fetch -q -O fw.tgz "https://${domain}/firmware/download/h2t-router-${fwVer}.tar.gz" 2>/dev/null \\
  || wget -qO fw.tgz "https://${domain}/firmware/download/h2t-router-${fwVer}.tar.gz" 2>/dev/null \\
  || echo "!! Chưa tải được firmware (portal chưa publish?). Bỏ qua, cập nhật sau từ /admin/releases"
if [ -f fw.tgz ]; then
  mkdir -p extract && tar -xzf fw.tgz -C extract
  cd extract && chmod +x update.sh && H2T_FW_VERSION='${fwVer}' H2T_PORTAL_DOMAIN='${domain}' ./update.sh
fi

# ---- 6) Lấy IP Tailscale và báo về portal ----
echo "[6/6] Báo cáo về portal..."
sleep 2
TS_IP=\$(tailscale ip -4 2>/dev/null | head -1)
MODEL=\$(cat /tmp/sysinfo/model 2>/dev/null || echo "unknown")

if [ -z "\$TS_IP" ]; then
  echo "!! Chưa lấy được IP Tailscale, thử lại sau vài giây: tailscale ip -4"
else
  echo "IP Tailscale: \$TS_IP"
  uclient-fetch -q -O - --post-data="ts_ip=\$TS_IP&model=\$MODEL" "${callbackUrl}" 2>/dev/null \\
    || wget -qO- --post-data="ts_ip=\$TS_IP&model=\$MODEL" "${callbackUrl}" 2>/dev/null \\
    || echo "!! Không tự báo cáo được, vào portal nhập IP thủ công: \$TS_IP"
fi

service opennds stop 2>/dev/null || true
sleep 1
service opennds start

echo ""
echo "=== HOÀN TẤT! ==="
echo "Router đã sẵn sàng cho quán ${location.display_name} (firmware ${fwVer})."
`;
}

module.exports = { generateKeypair, buildInstallScript };
