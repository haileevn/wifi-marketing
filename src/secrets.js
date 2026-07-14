/**
 * Mã hoá trường nhạy cảm (SSH password) khi lưu DB.
 * Dùng SECRETS_KEY trong .env (tối thiểu 16 ký tự). Thiếu key = lưu plaintext
 * và log cảnh báo lúc khởi động — chỉ chấp nhận được trong môi trường dev.
 */
const crypto = require("crypto");

const PREFIX = "enc:v1:";

function deriveKey() {
  const raw = process.env.SECRETS_KEY || "";
  if (raw.length < 16) return null;
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(plain) {
  if (!plain) return "";
  const key = deriveKey();
  if (!key) return String(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(stored) {
  if (!stored) return "";
  if (!String(stored).startsWith(PREFIX)) return String(stored); // legacy plaintext
  const key = deriveKey();
  if (!key) throw new Error("SECRETS_KEY thiếu — không giải mã được mật khẩu SSH đã mã hoá.");
  const buf = Buffer.from(String(stored).slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function isConfigured() {
  return !!(process.env.SECRETS_KEY && process.env.SECRETS_KEY.length >= 16);
}

module.exports = { encrypt, decrypt, isConfigured };
