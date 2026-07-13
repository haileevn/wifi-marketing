/**
 * Zalo ZNS - gửi tin nhắn chăm sóc khách hàng qua Zalo Notification Service
 *
 * Chuẩn bị (1 lần):
 * 1. Tạo Zalo OA (đã xác thực) + app trên developers.zalo.me
 * 2. Đăng ký template ZNS và chờ duyệt -> lấy TEMPLATE_ID
 * 3. Lấy access_token + refresh_token lần đầu qua OAuth
 *    (https://oauth.zaloapp.com/v4/oa/permission) rồi lưu bằng:
 *    node scripts/zalo-set-token.js <access_token> <refresh_token>
 *
 * Sau đó module tự refresh token (access token sống ~25h,
 * refresh token dùng 1 lần - Zalo trả refresh token mới mỗi lần refresh).
 *
 * Nếu chưa cấu hình ZALO_APP_ID: chạy DRY-RUN, chỉ ghi log không gửi thật.
 */
const { db } = require("./db");

const ZNS_API = "https://business.openapi.zalo.me/message/template";
const OAUTH_API = "https://oauth.zaloapp.com/v4/oa/access_token";

/* ---------------- lưu token trong bảng settings (key-value) ---------------- */

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

/* ---------------- refresh access token khi hết hạn ---------------- */

async function getAccessToken() {
  const expiresAt = Number(getSetting("zalo_token_expires") || 0);
  const accessToken = getSetting("zalo_access_token");

  // còn hạn (chừa 10 phút an toàn) thì dùng luôn
  if (accessToken && Date.now() < expiresAt - 10 * 60 * 1000) return accessToken;

  const refreshToken = getSetting("zalo_refresh_token");
  if (!refreshToken) throw new Error("Chưa có refresh_token. Chạy scripts/zalo-set-token.js trước.");

  const res = await fetch(OAUTH_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      secret_key: process.env.ZALO_APP_SECRET,
    },
    body: new URLSearchParams({
      app_id: process.env.ZALO_APP_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Refresh token thất bại: " + JSON.stringify(data));

  setSetting("zalo_access_token", data.access_token);
  setSetting("zalo_refresh_token", data.refresh_token); // Zalo cấp refresh token MỚI mỗi lần
  setSetting("zalo_token_expires", String(Date.now() + Number(data.expires_in) * 1000));
  return data.access_token;
}

/* ---------------- gửi 1 tin ZNS ---------------- */

// phone: 0901234567 -> 84901234567
function toZaloPhone(p) {
  return p.startsWith("0") ? "84" + p.slice(1) : p.replace("+", "");
}

async function sendZns(phone, templateData, trackingId) {
  // Chưa cấu hình -> DRY RUN để dev/test không cần OA thật
  if (!process.env.ZALO_APP_ID || !process.env.ZNS_TEMPLATE_ID) {
    console.log(`[ZNS DRY-RUN] gửi tới ${phone}:`, JSON.stringify(templateData));
    return { dryRun: true };
  }

  const token = await getAccessToken();
  const res = await fetch(ZNS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", access_token: token },
    body: JSON.stringify({
      phone: toZaloPhone(phone),
      template_id: process.env.ZNS_TEMPLATE_ID,
      template_data: templateData,
      tracking_id: trackingId || `h2t-${Date.now()}`,
    }),
  });
  const data = await res.json();
  if (data.error !== 0) throw new Error(`ZNS lỗi ${data.error}: ${data.message}`);
  return data;
}

/* ---------------- campaign: khách ghé lần thứ N thì gửi ưu đãi ---------------- */

/**
 * Gọi sau mỗi lượt kết nối. Không await ở request chính (fire-and-forget)
 * để không làm chậm việc mở mạng cho khách.
 */
async function onVisit({ customerId, phone, name, locationName, visitCount }) {
  const milestone = Number(process.env.ZNS_VISIT_MILESTONE || 3);
  if (visitCount !== milestone) return;

  // chống gửi trùng: mỗi khách chỉ nhận campaign này 1 lần
  const campaign = `visit-${milestone}`;
  const sent = db
    .prepare("SELECT id FROM zns_log WHERE customer_id = ? AND campaign = ? AND status = 'sent'")
    .get(customerId, campaign);
  if (sent) return;

  try {
    const result = await sendZns(
      phone,
      {
        // các key phải TRÙNG với tham số trong template ZNS đã được duyệt
        customer_name: name || "bạn",
        store_name: locationName,
        visit_count: String(visitCount),
        voucher_code: process.env.ZNS_VOUCHER_CODE || "THANQUEN10",
      },
      `${campaign}-${customerId}`
    );
    db.prepare(
      "INSERT INTO zns_log (customer_id, campaign, status, detail) VALUES (?, ?, 'sent', ?)"
    ).run(customerId, campaign, result.dryRun ? "dry-run" : JSON.stringify(result.data || {}));
    console.log(`[ZNS] Đã gửi ưu đãi lượt ${milestone} cho ${phone}`);
  } catch (e) {
    db.prepare(
      "INSERT INTO zns_log (customer_id, campaign, status, detail) VALUES (?, ?, 'failed', ?)"
    ).run(customerId, campaign, e.message);
    console.error(`[ZNS] Gửi thất bại cho ${phone}:`, e.message);
  }
}

module.exports = { sendZns, onVisit, setSetting, getSetting };
