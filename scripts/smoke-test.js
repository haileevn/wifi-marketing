#!/usr/bin/env node
/**
 * Smoke test cục bộ: khởi động server tạm, gọi các endpoint chính, thoát.
 * Cách dùng: npm run smoke
 */
require("dotenv").config();
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = Number(process.env.SMOKE_PORT || 20149);
const DB = path.join(__dirname, "..", "data", `smoke-${process.pid}.db`);
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "doi-mat-khau-nay-ngay";

function req(method, urlPath, { body, headers, expectStatus } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port: PORT, path: urlPath, method, headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (expectStatus && res.statusCode !== expectStatus) {
            reject(new Error(`${method} ${urlPath} => ${res.statusCode} (expect ${expectStatus}): ${text.slice(0, 200)}`));
            return;
          }
          resolve({ status: res.statusCode, text, headers: res.headers });
        });
      }
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

function authHeader() {
  return "Basic " + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64");
}

async function main() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: DB,
    FW_DIST: path.join(__dirname, "..", "data", `fw-smoke-${process.pid}`),
    ADMIN_USER,
    ADMIN_PASS,
    DEFAULT_FASKEY: "smoke-faskey",
    SECRETS_KEY: "smoke-secrets-key-32b",
    ENROLL_ONE_SHOT: "1",
    TAILSCALE_AUTHKEY: "tskey-auth-smoke-test-only",
  };

  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let boot = "";
  child.stdout.on("data", (d) => (boot += d.toString()));
  child.stderr.on("data", (d) => (boot += d.toString()));

  const started = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (boot.includes("H2T WiFi Marketing") || boot.includes(`:${PORT}`)) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > 12000) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });

  if (!started) {
    child.kill("SIGKILL");
    console.error("FAIL: server không khởi động\n", boot);
    process.exit(1);
  }

  const fails = [];
  try {
    await req("GET", "/health", { expectStatus: 200 });
    const health = await req("GET", "/health", { expectStatus: 200 });
    let healthJson;
    try { healthJson = JSON.parse(health.text); } catch { fails.push("health không phải JSON"); }
    if (healthJson && !healthJson.portal_version) fails.push("health thiếu portal_version");
    if (healthJson && !healthJson.firmware_version) fails.push("health thiếu firmware_version");

    const latest = await req("GET", "/firmware/latest.json", { expectStatus: 200 });
    let latestJson;
    try { latestJson = JSON.parse(latest.text); } catch { fails.push("latest.json invalid"); }
    if (latestJson && !latestJson.filename) fails.push("latest.json thiếu filename");
    await req("GET", "/firmware/latest.env", { expectStatus: 200 });
    if (latestJson?.filename) {
      const dl = await req("GET", `/firmware/download/${latestJson.filename}`, { expectStatus: 200 });
      if (!dl.text || dl.text.length < 50) fails.push("firmware tarball rỗng");
    }

    // Tạo quán qua CLI logic (reuse store after server boot — add via POST)
    const form = new URLSearchParams({
      gateway_name: "smoke-q1",
      display_name: "Smoke Test Q1",
      faskey: "smoke-faskey",
    }).toString();
    await req("POST", "/admin/locations", {
      body: form,
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(form),
      },
      expectStatus: 302,
    });

    const admin = await req("GET", "/admin", {
      headers: { Authorization: authHeader() },
      expectStatus: 200,
    });
    if (!admin.text.includes("Smoke Test Q1")) fails.push("admin không thấy quán vừa tạo");

    // Lấy id quán từ DB bằng require store sẽ conflict — parse từ HTML links
    const m = admin.text.match(/\/admin\/editor\/(\d+)/);
    if (!m) fails.push("không tìm thấy editor link");
    const id = m ? m[1] : "1";

    await req("GET", `/preview/${id}`, { expectStatus: 200 });
    await req("GET", `/admin/editor/${id}`, {
      headers: { Authorization: authHeader() },
      expectStatus: 200,
    });
    await req("GET", `/admin/menu/${id}`, {
      headers: { Authorization: authHeader() },
      expectStatus: 200,
    });
    await req("GET", "/admin/map", {
      headers: { Authorization: authHeader() },
      expectStatus: 200,
    });
    await req("GET", `/admin/router/${id}`, {
      headers: { Authorization: authHeader() },
      expectStatus: 200,
    });
    await req("GET", "/admin/releases", {
      headers: { Authorization: authHeader() },
      expectStatus: 200,
    });

    // FAS thiếu param
    await req("GET", "/fas", { expectStatus: 400 });

    // FAS đủ param preview-like
    const fas = await req("GET", `/fas?hid=testhid&gatewayname=smoke-q1&gatewayaddress=192.168.8.1&gatewayport=2050`, {
      expectStatus: 200,
    });
    if (!fas.text.includes("Smoke Test")) fails.push("portal FAS không render tên quán");

    // Install script có token (extract từ trang router)
    const routerPage = await req("GET", `/admin/router/${id}`, {
      headers: { Authorization: authHeader() },
      expectStatus: 200,
    });
    const tok = routerPage.text.match(/\/install\/([a-f0-9]+)\.sh/);
    if (!tok) {
      fails.push("không thấy enroll token trên trang router");
    } else {
      const install = await req("GET", `/install/${tok[1]}.sh`, { expectStatus: 200 });
      if (!install.text.includes("opennds") || !install.text.includes("tailscale")) {
        fails.push("install script thiếu OpenNDS/Tailscale");
      }
      if (install.text.includes("tskey-auth-smoke-test-only") && /echo.*tskey-auth/.test(install.text)) {
        fails.push("install script echo authkey (leak)");
      }
      // Authkey được nhúng vào biến shell — chấp nhận, nhưng không được xuất hiện trong echo lỗi
      const enrollOk = await req("POST", `/api/enroll/${tok[1]}`, {
        body: "ts_ip=100.64.1.2&model=SmokeRouter",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        expectStatus: 200,
      });
      if (!enrollOk.text.includes('"ok":true')) fails.push("enroll callback thất bại");

      // One-shot: token cũ phải hết hạn
      const again = await req("GET", `/install/${tok[1]}.sh`, { expectStatus: 404 });
      if (!again.text.includes("không hợp lệ") && again.status !== 404) {
        fails.push("one-shot enroll chưa revoke token");
      }
    }

    // Basic auth bắt buộc
    const noAuth = await req("GET", "/admin");
    if (noAuth.status !== 401) fails.push("admin không đòi Basic Auth");
  } catch (e) {
    fails.push(e.message);
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 500);
    try { fs.rmSync(DB, { force: true }); } catch {}
    try { fs.rmSync(DB + "-wal", { force: true }); } catch {}
    try { fs.rmSync(DB + "-shm", { force: true }); } catch {}
    try { fs.rmSync(env.FW_DIST, { recursive: true, force: true }); } catch {}
  }

  if (fails.length) {
    console.error("SMOKE FAIL:");
    fails.forEach((f) => console.error(" -", f));
    process.exit(1);
  }
  console.log("SMOKE OK — health+version, firmware OTA, admin, preview, menu, map, router, FAS, enroll one-shot");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
