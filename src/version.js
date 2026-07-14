/**
 * Portal + firmware versioning & release packaging.
 *
 * Portal version  = package.json
 * Firmware version = firmware/VERSION (đóng gói riêng cho router tải về)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FW_DIR = path.join(ROOT, "firmware");
const FW_SRC = path.join(FW_DIR, "src");
const FW_DIST = process.env.FW_DIST
  ? path.resolve(process.env.FW_DIST)
  : path.join(ROOT, "data", "firmware");

function portalVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return pkg.version;
}

function firmwareVersion() {
  const p = path.join(FW_DIR, "VERSION");
  if (!fs.existsSync(p)) return portalVersion();
  return fs.readFileSync(p, "utf8").trim();
}

function ensureDist() {
  fs.mkdirSync(FW_DIST, { recursive: true });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

/**
 * Đóng gói firmware hiện tại -> data/firmware/h2t-router-<ver>.tar.gz
 * + latest.json + latest.env (cho BusyBox router)
 */
function buildFirmwarePackage({ changelog = "", portalDomain = "" } = {}) {
  ensureDist();
  const version = firmwareVersion();
  const staging = path.join(FW_DIST, `.staging-${version}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  // Copy nguồn
  for (const name of ["update.sh", "h2t-check-update.sh"]) {
    const src = path.join(FW_SRC, name);
    if (!fs.existsSync(src)) throw new Error(`Thiếu ${src}`);
    fs.copyFileSync(src, path.join(staging, name));
  }
  fs.writeFileSync(path.join(staging, "VERSION"), version + "\n");
  if (portalDomain) {
    fs.writeFileSync(path.join(staging, "portal_domain"), portalDomain + "\n");
  }

  const filename = `h2t-router-${version}.tar.gz`;
  const outPath = path.join(FW_DIST, filename);

  // Prefer tar CLI (portable); fallback zip không dùng vì OpenWrt expect .tar.gz
  execFileSync("tar", ["-czf", outPath, "-C", staging, "."], { stdio: "pipe" });
  fs.rmSync(staging, { recursive: true, force: true });

  const sha = sha256File(outPath);
  const publishedAt = new Date().toISOString();
  const manifest = {
    version,
    portal_version: portalVersion(),
    filename,
    sha256: sha,
    changelog: changelog || `Firmware ${version}`,
    published_at: publishedAt,
    download_path: `/firmware/download/${filename}`,
  };

  fs.writeFileSync(path.join(FW_DIST, "latest.json"), JSON.stringify(manifest, null, 2));
  // Shell-sourcable cho BusyBox
  const envBody = [
    `VERSION='${version}'`,
    `PORTAL_VERSION='${portalVersion()}'`,
    `FILENAME='${filename}'`,
    `SHA256='${sha}'`,
    `CHANGELOG='${String(changelog || "").replace(/'/g, "'\\''")}'`,
    `PUBLISHED_AT='${publishedAt}'`,
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(FW_DIST, "latest.env"), envBody);

  // Giữ bản copy manifest theo version
  fs.writeFileSync(path.join(FW_DIST, `manifest-${version}.json`), JSON.stringify(manifest, null, 2));

  return { ...manifest, path: outPath, size: fs.statSync(outPath).size };
}

function readLatestManifest() {
  const p = path.join(FW_DIST, "latest.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function firmwareFilePath(filename) {
  // Chặn path traversal
  const base = path.basename(filename);
  if (!/^h2t-router-[\w.-]+\.tar\.gz$/.test(base)) return null;
  const full = path.join(FW_DIST, base);
  if (!fs.existsSync(full)) return null;
  return full;
}

function listBuiltPackages() {
  ensureDist();
  return fs.readdirSync(FW_DIST)
    .filter((f) => /^h2t-router-[\w.-]+\.tar\.gz$/.test(f))
    .map((f) => {
      const full = path.join(FW_DIST, f);
      const st = fs.statSync(full);
      return { filename: f, size: st.size, mtime: st.mtime.toISOString(), sha256: sha256File(full) };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

module.exports = {
  portalVersion,
  firmwareVersion,
  buildFirmwarePackage,
  readLatestManifest,
  firmwareFilePath,
  listBuiltPackages,
  FW_DIST,
};
