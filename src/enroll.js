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
 */
function buildInstallScript({ location, domain, token, pubkey, tailscaleAuthKey }) {
  const proto = "https";
  const callbackUrl = `${proto}://${domain}/api/enroll/${token}`;

  return `#!/bin/sh
# ============================================================
#  H2T WiFi Marketing - Gói cài đặt tự động cho "${location.display_name}"
#  Sinh tự động - KHÔNG chia sẻ link này công khai (chứa quyền cài đặt router)
# ============================================================
set -e
echo "=== Bắt đầu cài đặt cho quán: ${location.display_name} ==="

# ---- 1) Cài OpenNDS ----
echo "[1/5] Cài OpenNDS..."
opkg update >/dev/null 2>&1 || true
opkg list-installed 2>/dev/null | grep -q '^opennds ' || opkg install opennds ca-bundle

# ---- 2) Cấu hình OpenNDS trỏ về portal ----
echo "[2/5] Cấu hình OpenNDS..."
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
echo "[3/5] Thêm SSH key quản trị..."
mkdir -p /etc/dropbear
touch /etc/dropbear/authorized_keys
grep -qF "${pubkey}" /etc/dropbear/authorized_keys 2>/dev/null || \\
  echo "${pubkey}" >> /etc/dropbear/authorized_keys
chmod 600 /etc/dropbear/authorized_keys

# ---- 4) Cài Tailscale (mesh VPN để portal SSH vào được dù router sau NAT) ----
echo "[4/5] Cài Tailscale..."
if ! command -v tailscale >/dev/null 2>&1; then
  opkg list-installed 2>/dev/null | grep -q '^tailscale ' || opkg install tailscale || {
    echo "!! opkg không có gói tailscale cho router này."
    echo "!! Vui lòng cài thủ công: https://tailscale.com/kb/1490/openwrt"
    echo "!! Sau khi cài xong, chạy lại lệnh:"
    echo "   tailscale up --authkey=${tailscaleAuthKey} --hostname=${location.gateway_name} --accept-dns=false"
    exit 1
  }
fi
service tailscale enable 2>/dev/null || true
service tailscale start 2>/dev/null || true
sleep 2
tailscale up --authkey="${tailscaleAuthKey}" --hostname="${location.gateway_name}" --accept-dns=false

# ---- 5) Lấy IP Tailscale và báo về portal ----
echo "[5/5] Báo cáo về portal..."
sleep 2
TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
MODEL=$(cat /tmp/sysinfo/model 2>/dev/null || echo "unknown")

if [ -z "$TS_IP" ]; then
  echo "!! Chưa lấy được IP Tailscale, thử lại sau vài giây: tailscale ip -4"
else
  echo "IP Tailscale: $TS_IP"
  uclient-fetch -q -O - --post-data="ts_ip=$TS_IP&model=$MODEL" "${callbackUrl}" 2>/dev/null \\
    || wget -qO- --post-data="ts_ip=$TS_IP&model=$MODEL" "${callbackUrl}" 2>/dev/null \\
    || echo "!! Không tự báo cáo được, vào portal nhập IP thủ công: $TS_IP"
fi

service opennds stop 2>/dev/null || true
sleep 1
service opennds start

echo ""
echo "=== HOÀN TẤT! ==="
echo "Router đã sẵn sàng cho quán ${location.display_name}."
`;
}

module.exports = { generateKeypair, buildInstallScript };
