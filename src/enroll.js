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

# ---- 1) Cài OpenNDS + dnsmasq-full ----
echo "[1/6] Cài OpenNDS + dnsmasq-full..."
opkg update >/dev/null 2>&1 || true
if ! opkg list-installed 2>/dev/null | grep -q '^dnsmasq-full '; then
  /etc/init.d/dnsmasq stop 2>/dev/null || true
  opkg remove dnsmasq --force-depends 2>/dev/null || true
  opkg install dnsmasq-full || true
  /etc/init.d/dnsmasq enable 2>/dev/null || true
  /etc/init.d/dnsmasq start 2>/dev/null || true
fi
opkg list-installed 2>/dev/null | grep -q '^opennds ' || opkg install opennds ca-bundle

# ---- 2) Cấu hình OpenNDS trỏ về portal ----
echo "[2/6] Cấu hình OpenNDS..."
uci set opennds.@opennds[0].enabled='1'
uci set opennds.@opennds[0].gatewayname='${location.gateway_name}'
uci set opennds.@opennds[0].gatewayinterface='br-lan'
uci set opennds.@opennds[0].fas_secure_enabled='1'
uci set opennds.@opennds[0].fasremotefqdn='${domain}'
uci set opennds.@opennds[0].fasport='443'
uci set opennds.@opennds[0].faspath='/fas'
uci set opennds.@opennds[0].faskey='${location.faskey}'
uci set opennds.@opennds[0].fasssl='1'
uci set opennds.@opennds[0].sessiontimeout='720'
uci -q delete opennds.@opennds[0].binauth || true
uci -q delete opennds.@opennds[0].walledgarden_fqdn_list
uci add_list opennds.@opennds[0].walledgarden_fqdn_list='${domain}'
uci -q delete opennds.@opennds[0].users_to_router
uci add_list opennds.@opennds[0].users_to_router='allow udp port 53'
uci add_list opennds.@opennds[0].users_to_router='allow udp port 67'
uci add_list opennds.@opennds[0].users_to_router='allow tcp port 22'
uci add_list opennds.@opennds[0].users_to_router='allow tcp port 443'
uci add_list opennds.@opennds[0].users_to_router='allow tcp port 80'
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
  # Dependencies bắt buộc trên OpenWrt 23.05 (nft): thiếu iptables → tailscaled thoát ngay
  opkg install kmod-tun ca-bundle 2>/dev/null || true
  opkg install iptables-nft ip6tables-nft iptables-mod-conntrack-extra 2>/dev/null \\
    || opkg install iptables ip6tables 2>/dev/null || true
  modprobe tun 2>/dev/null || insmod tun 2>/dev/null || true
  mkdir -p /var/run/tailscale /var/lib/tailscale

  # 1) feed chính
  if opkg list-installed 2>/dev/null | grep -q '^tailscale '; then
    return 0
  fi
  if opkg install tailscale 2>/dev/null; then
    return 0
  fi
  # 2) IPK community (nhẹ hơn — router RAM nhỏ)
  ARCH=\$(. /etc/os-release 2>/dev/null; echo "\${OPENWRT_ARCH:-}")
  [ -n "\$ARCH" ] || ARCH=\$(opkg print-architecture 2>/dev/null | awk '\$1=="arch"{print \$2; exit}')
  [ -n "\$ARCH" ] || ARCH=mipsel_24kc
  VER="${tsVer}"
  for CAND in "tailscale_\${VER}_\${ARCH}.ipk" "tailscale_\${VER}_\${ARCH}_24kf.ipk"; do
    URL1="https://github.com/GuNanOvO/openwrt-tailscale/releases/download/v\${VER}/\${CAND}"
    URL2="https://ghfast.top/https://github.com/GuNanOvO/openwrt-tailscale/releases/download/v\${VER}/\${CAND}"
    echo "  Thử \$CAND..."
    cd /tmp
    rm -f "\$CAND"
    uclient-fetch -q -O "\$CAND" "\$URL1" 2>/dev/null || wget -qO "\$CAND" "\$URL1" 2>/dev/null \\
      || uclient-fetch -q -O "\$CAND" "\$URL2" 2>/dev/null || wget -qO "\$CAND" "\$URL2" 2>/dev/null || true
    [ -s "\$CAND" ] || continue
    if opkg install --force-depends --force-overwrite "/tmp/\$CAND" 2>/dev/null; then
      return 0
    fi
  done
  echo "!! Không cài được Tailscale IPK"
  return 1
}

if ! command -v tailscale >/dev/null 2>&1; then
  install_tailscale_openwrt || {
    echo "!! Cài Tailscale thất bại — dừng enroll (cần mesh VPN)."
    exit 1
  }
fi

# Khởi động daemon (state mặc định OpenWrt: /etc/tailscale/tailscaled.state)
mkdir -p /etc/tailscale /var/run/tailscale
# nftables OpenWrt 23.05 — bắt buộc để tailscaled không thoát ngay
export TS_DEBUG_FIREWALL_MODE=auto
uci -q set tailscale.settings.state_file='/etc/tailscale/tailscaled.state' || true
uci -q commit tailscale 2>/dev/null || true
/etc/init.d/tailscale enable 2>/dev/null || true
/etc/init.d/tailscale stop 2>/dev/null || true
/etc/init.d/tailscale start 2>/dev/null || {
  echo "!! init.d start fail — chạy tay tailscaled"
  TS_DEBUG_FIREWALL_MODE=auto /usr/sbin/tailscaled \\
    --state=/etc/tailscale/tailscaled.state --port=41641 >/tmp/tailscaled.log 2>&1 &
}
# Đợi sock sẵn sàng (tối đa ~25s)
i=0
while [ \$i -lt 25 ]; do
  if tailscale status >/dev/null 2>&1; then break; fi
  if [ -S /var/run/tailscale/tailscaled.sock ]; then
    # sock có nhưng CLI chưa sẵn — đợi thêm
    sleep 1; break
  fi
  i=\$((i+1)); sleep 1
done
sleep 1
if ! tailscale status >/dev/null 2>&1; then
  echo "!! tailscaled chưa chạy. Log:"
  logread 2>/dev/null | grep -i tailscale | tail -20 || true
  cat /tmp/tailscaled.log 2>/dev/null | tail -30 || true
  echo "!! Cài iptables: opkg install iptables-nft ip6tables-nft kmod-tun"
  exit 1
fi
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
