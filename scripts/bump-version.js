#!/usr/bin/env node
/** Bump patch version in package.json + firmware/VERSION (đồng bộ portal & firmware). */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const fwPath = path.join(root, "firmware", "VERSION");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const parts = String(pkg.version || "1.0.0").split(".").map((n) => parseInt(n, 10) || 0);
const kind = process.argv[2] || "patch";
if (kind === "minor") parts[1] = (parts[1] || 0) + 1, parts[2] = 0;
else if (kind === "major") parts[0] = (parts[0] || 1) + 1, parts[1] = 0, parts[2] = 0;
else parts[2] = (parts[2] || 0) + 1;

const ver = `${parts[0]}.${parts[1]}.${parts[2]}`;
pkg.version = ver;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
fs.writeFileSync(fwPath, ver + "\n");
console.log(`Bumped → ${ver} (package.json + firmware/VERSION)`);
