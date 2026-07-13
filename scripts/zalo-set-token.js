#!/usr/bin/env node
// Lưu access_token + refresh_token Zalo lần đầu (lấy từ OAuth trên developers.zalo.me)
// Cách dùng: node scripts/zalo-set-token.js <access_token> <refresh_token>
require("dotenv").config();
const zalo = require("../src/zalo");

const [accessToken, refreshToken] = process.argv.slice(2);
if (!accessToken || !refreshToken) {
  console.log("Cách dùng: node scripts/zalo-set-token.js <access_token> <refresh_token>");
  process.exit(1);
}

zalo.setSetting("zalo_access_token", accessToken);
zalo.setSetting("zalo_refresh_token", refreshToken);
zalo.setSetting("zalo_token_expires", String(Date.now() + 24 * 3600 * 1000));
console.log("Đã lưu token Zalo. Module sẽ tự refresh từ giờ (nhớ giữ ZALO_APP_SECRET trong .env).");
