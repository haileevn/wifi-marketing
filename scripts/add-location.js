#!/usr/bin/env node
// Thêm quán từ dòng lệnh:
// node scripts/add-location.js comtam-q1 "Cơm Tấm Ông Mập Q1" my-faskey
require("dotenv").config();
const store = require("../src/db");

const [gateway_name, display_name, faskey] = process.argv.slice(2);
if (!gateway_name || !display_name) {
  console.log('Cách dùng: node scripts/add-location.js <gatewayname> "<Tên quán>" [faskey]');
  process.exit(1);
}

store.addLocation({
  gateway_name,
  display_name,
  faskey: faskey || process.env.DEFAULT_FASKEY || "changeme",
});
console.log(`Đã thêm quán "${display_name}" (gateway: ${gateway_name})`);
console.log("Danh sách quán hiện tại:");
console.table(store.listLocations().map(l => ({ id: l.id, gateway: l.gateway_name, ten: l.display_name })));
