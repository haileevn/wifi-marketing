#!/usr/bin/env node
/**
 * Build + ghi nhận firmware release từ CLI.
 * Usage:
 *   npm run release
 *   npm run release -- --changelog "Fix cron OTA"
 */
require("dotenv").config();
const versioning = require("../src/version");
const store = require("../src/db");

const args = process.argv.slice(2);
let changelog = "";
const i = args.indexOf("--changelog");
if (i >= 0) changelog = args[i + 1] || "";

const built = versioning.buildFirmwarePackage({
  changelog: changelog || `Release firmware ${versioning.firmwareVersion()}`,
});
store.upsertFirmwareRelease({
  version: built.version,
  portal_version: built.portal_version,
  changelog: built.changelog,
  sha256: built.sha256,
  filename: built.filename,
  size_bytes: built.size,
});

console.log("Published firmware:");
console.table({
  firmware: built.version,
  portal: built.portal_version,
  file: built.filename,
  sha256: built.sha256.slice(0, 16) + "…",
  bytes: built.size,
});
console.log("latest.json ->", require("path").join(versioning.FW_DIST, "latest.json"));
