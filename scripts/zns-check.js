#!/usr/bin/env node
/**
 * Kiểm tra cấu hình ZNS (không gửi tin thật trừ khi --send-test).
 * Usage: node scripts/zns-check.js
 */
require("dotenv").config();
const store = require("../src/db");

const hasApp = !!(process.env.ZALO_APP_ID && process.env.ZALO_APP_SECRET);
const hasTpl = !!process.env.ZNS_TEMPLATE_ID;
const access = store.getSetting("zalo_access_token");
const refresh = store.getSetting("zalo_refresh_token");
const milestone = process.env.ZNS_VISIT_MILESTONE || 3;

console.log("ZNS config check");
console.table({
  ZALO_APP_ID: hasApp ? "set" : "MISSING → dry-run",
  ZNS_TEMPLATE_ID: hasTpl ? process.env.ZNS_TEMPLATE_ID : "MISSING → dry-run",
  access_token: access ? "in DB" : "none",
  refresh_token: refresh ? "in DB" : "none (chạy zalo-set-token.js)",
  milestone: `visit #${milestone}`,
  mode: hasApp && hasTpl ? (refresh ? "LIVE (khi đủ token)" : "LIVE nhưng thiếu refresh_token") : "DRY-RUN",
});

if (!refresh && hasApp) {
  console.log("\nTiếp theo: node scripts/zalo-set-token.js <access_token> <refresh_token>");
}
process.exit(0);
