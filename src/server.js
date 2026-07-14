require("dotenv").config();
const express = require("express");
const crypto  = require("crypto");
const path    = require("path");
const store   = require("./db");
const zalo    = require("./zalo");
const routerCtl = require("./router");
const enroll  = require("./enroll");
const secrets = require("./secrets");
const { createRateLimiter } = require("./rate-limit");
const versioning = require("./version");
const fs = require("fs");
const { themeCss } = require("./portal-themes");
const sessionSync = require("./session-sync");

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false, limit: "8mb" })); // logo base64 lớn
app.use(express.json({ limit: "8mb" }));

const PORT = process.env.PORT || 20140;
const publicLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

if (!secrets.isConfigured()) {
  console.warn("[security] SECRETS_KEY chưa cấu hình (≥16 ký tự) — SSH password lưu plaintext trong DB.");
}
if (!process.env.ADMIN_PASS || process.env.ADMIN_PASS === "doi-mat-khau-nay-ngay") {
  console.warn("[security] Đổi ADMIN_PASS trong .env trước khi đưa lên production.");
}

/* ── helpers ─────────────────────────────────────────────────── */
function parseFasParam(b64) {
  try {
    const out = {};
    Buffer.from(b64, "base64").toString("utf8").split(/[,&]\s*/).forEach(p => {
      const i = p.indexOf("=");
      if (i > 0) out[p.slice(0,i).trim()] = p.slice(i+1).trim();
    });
    return out;
  } catch { return null; }
}
function rhid(hid, key) { return crypto.createHash("sha256").update(hid+key).digest("hex"); }
function validPhone(p)   { return /^(0|\+84)\d{9}$/.test((p||"").replace(/[\s.-]/g,"")); }
function normPhone(p)    { const s=(p||"").replace(/[\s.-]/g,""); return s.startsWith("+84")?"0"+s.slice(3):s; }
function portalPublicBase() {
  return String(process.env.PORTAL_PUBLIC_URL || process.env.DOMAIN || "https://wifi.06.com.vn")
    .trim().replace(/\/$/, "");
}

/** originurl từ CPD thường là IP gateway LAN / connectivity-check → 404 sau auth. */
function isBadPostAuthUrl(raw) {
  if (!raw) return true;
  let s = String(raw).trim();
  try { s = decodeURIComponent(s.replace(/\+/g, " ")); } catch { /* keep */ }
  let u;
  try { u = new URL(s); } catch { return true; }
  if (!/^https?:$/i.test(u.protocol)) return true;
  const host = (u.hostname || "").toLowerCase();
  if (!host || host === "localhost") return true;
  if (/^(192\.168\.|10\.|127\.|0\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
  if (/captive|detectportal|connectivitycheck|clients\d*\.google|msftconnecttest|gstatic\.com|apple\.com|hotspot-detect/i.test(host + u.pathname)) return true;
  return false;
}

function normalizeHttpUrl(raw, base) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("/")) s = `${base}${s}`;
  try { s = decodeURIComponent(s.replace(/\+/g, " ")); } catch { /* keep */ }
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try { return new URL(s).toString(); } catch { return ""; }
}

/** Ưu tiên: success_redirect (editor) → zalo_link → menu → /welcome/:id */
function resolvePostAuthRedirect(loc, originurl) {
  const base = portalPublicBase();
  const candidates = [
    loc.success_redirect,
    loc.zalo_link,
    loc.menu_enabled ? `${base}/menu/${loc.id}` : "",
    `${base}/welcome/${loc.id}`,
    originurl,
  ];
  for (const c of candidates) {
    const url = normalizeHttpUrl(c, base);
    if (url && !isBadPostAuthUrl(url)) return url;
  }
  return "https://www.google.com/";
}

/** OpenNDS gw_address thường đã là "192.168.x.x:2050" — không cộng port lần 2. */
function openNdsAuthUrl(gatewayaddress, gatewayport, tok, redir) {
  let host = String(gatewayaddress || "").trim().replace(/\/$/, "");
  // IPv4:port hoặc [IPv6]:port
  const hasPort = /^(\[[0-9a-fA-F:]+\]|(\d{1,3}\.){3}\d{1,3}):\d+$/.test(host);
  if (!hasPort && gatewayport) host = `${host}:${gatewayport}`;
  const q = new URLSearchParams({
    tok: String(tok || ""),
    redir: redir || "https://www.google.com/",
  });
  return `http://${host}/opennds_auth/?${q.toString()}`;
}
function adminAuth(req, res, next) {
  const [u,p] = Buffer.from((req.headers.authorization||"").split(" ")[1]||"","base64").toString().split(":");
  if (u===process.env.ADMIN_USER && p===process.env.ADMIN_PASS) return next();
  res.set("WWW-Authenticate",'Basic realm="H2T WiFi Admin"');
  res.status(401).send("Yêu cầu đăng nhập");
}

function portalRenderArgs(loc, extra) {
  const tid = loc.template_id || "classic";
  return {
    location: loc,
    themeCss: themeCss(tid),
    templateId: tid,
    ...extra,
  };
}

/* ── Portal / FAS ────────────────────────────────────────────── */
app.get("/fas", (req, res) => {
  const p = req.query.fas ? parseFasParam(req.query.fas) : req.query;
  if (!p?.hid || !p?.gatewayname) return res.status(400).render("error",{message:"Thiếu thông tin từ router."});
  const loc = store.findLocationByGateway(p.gatewayname);
  if (!loc) return res.status(404).render("error",{message:`Chưa khai báo quán "${p.gatewayname}".`});
  // Luôn dùng gateway_name đã khai trên portal (tránh leak " Node:xxx" vào form /auth)
  res.render("portal", portalRenderArgs(loc, {
    hid:p.hid, gatewayname:loc.gateway_name,
    gatewayaddress:p.gatewayaddress||"", gatewayport:p.gatewayport||"2050",
    clientmac:p.clientmac||"", clientip:p.clientip||"",
    originurl:p.originurl||"http://google.com", error:null,
    surveyQuestions: loc.survey_enabled ? store.listActiveSurveyQuestions(loc.id) : [],
  }));
});

app.post("/auth", (req, res) => {
  const { hid, gatewayname, gatewayaddress, gatewayport, clientmac, clientip, originurl, phone, name } = req.body;
  const loc = store.findLocationByGateway(gatewayname);
  if (!loc || !hid || !gatewayaddress) return res.status(400).render("error",{message:"Phiên không hợp lệ."});
  const surveyQs = loc.survey_enabled ? store.listActiveSurveyQuestions(loc.id) : [];
  if (!validPhone(phone)) return res.render("portal", portalRenderArgs(loc, {
    hid, gatewayname, gatewayaddress, gatewayport,
    clientmac, clientip, originurl, surveyQuestions: surveyQs,
    error:"Số điện thoại chưa đúng, bạn kiểm tra lại giúp mình nha!" }));
  // Validate khảo sát bắt buộc
  if (surveyQs.length) {
    for (const q of surveyQs) {
      if (!q.required) continue;
      const ans = String(req.body[`survey_${q.id}`] || "").trim();
      if (!ans) {
        return res.render("portal", portalRenderArgs(loc, {
          hid, gatewayname, gatewayaddress, gatewayport,
          clientmac, clientip, originurl, surveyQuestions: surveyQs,
          error:`Vui lòng trả lời: ${q.question_text}` }));
      }
    }
  }
  const ph = normPhone(phone);
  const cid = store.upsertCustomer(ph, (name||"").trim().slice(0,60), loc.id);
  const visit = store.logVisit(cid, loc.id, clientmac, clientip);
  if (surveyQs.length) {
    const answers = {};
    for (const q of surveyQs) answers[q.id] = req.body[`survey_${q.id}`];
    store.saveSurveyAnswers({ visitId: visit.visitId, customerId: cid, locationId: loc.id, answers });
  }
  zalo.onVisit({ customerId:cid, phone:ph, name:(name||"").trim(), locationName:loc.display_name, visitCount:visit.count }).catch(()=>{});
  const redir = resolvePostAuthRedirect(loc, originurl);
  const authUrl = openNdsAuthUrl(gatewayaddress, gatewayport, rhid(hid, loc.faskey), redir);
  res.render("success",{ location:loc, authUrl, redir, clientip: clientip||"", gatewayaddress });
});

/* Trang chào sau khi auth (fallback khi chưa cấu hình success_redirect / zalo) */
app.get("/welcome/:id", (req, res) => {
  const loc = store.findLocationById(req.params.id);
  if (!loc) return res.status(404).render("error",{message:"Không tìm thấy quán."});
  res.render("welcome",{ location: loc });
});

/* ── Preview standalone (không cần FAS) ─────────────────────── */
app.get("/preview/:id", (req, res) => {
  const loc = store.findLocationById(req.params.id);
  if (!loc) return res.status(404).render("error",{message:"Không tìm thấy quán."});
  res.render("portal", portalRenderArgs(loc, {
    hid:"preview", gatewayname:loc.gateway_name,
    gatewayaddress:"127.0.0.1", gatewayport:"2050", clientmac:"", clientip:"",
    originurl:"http://google.com", error:null,
    surveyQuestions: loc.survey_enabled ? store.listActiveSurveyQuestions(loc.id) : [],
  }));
});

/* ── Admin ───────────────────────────────────────────────────── */
app.get("/admin", adminAuth, (req, res) => {
  res.render("admin",{ stats:store.stats(), recent:store.recentVisits(50),
    zns:store.recentZns(30), locations:store.listLocations(),
    defaultFaskey:process.env.DEFAULT_FASKEY||"", saved:req.query.saved==="1",
    portalVersion: versioning.portalVersion(),
    firmwareVersion: versioning.firmwareVersion(),
    firmwareLatest: versioning.readLatestManifest(),
  });
});

app.post("/admin/locations", adminAuth, (req, res) => {
  const { gateway_name, display_name, faskey, promo_text, zalo_link, accent_color } = req.body;
  if (gateway_name && display_name) {
    try { store.addLocation({ gateway_name:gateway_name.trim(), display_name:display_name.trim(),
      faskey:(faskey||process.env.DEFAULT_FASKEY||"changeme").trim(), promo_text, zalo_link, accent_color }); }
    catch(e){ console.error(e.message); }
  }
  res.redirect("/admin?saved=1");
});

/* ── Editor ──────────────────────────────────────────────────── */
app.get("/admin/editor/:id", adminAuth, (req, res) => {
  const loc = store.findLocationById(req.params.id);
  if (!loc) return res.redirect("/admin");
  res.render("editor", { location: loc, saved: req.query.saved==="1" });
});

app.post("/admin/editor/:id", adminAuth, (req, res) => {
  const id = req.params.id;
  const b = req.body;
  store.updateLocationDesign(id, {
    display_name: (b.display_name||"").trim().slice(0,100),
    promo_text:   (b.promo_text||"").trim().slice(0,300),
    zalo_link:    (b.zalo_link||"").trim(),
    success_redirect: (b.success_redirect||"").trim().slice(0,500),
    google_review_url: (b.google_review_url||"").trim().slice(0,500),
    survey_enabled: b.survey_enabled==="1"?1:0,
    survey_title: (b.survey_title||"Khảo sát nhanh").trim().slice(0,80),
    cover_data: (b.cover_data||"").slice(0, 800000),
    accent_color: b.accent_color||"#B4452C",
    logo_data:    (b.logo_data||"").slice(0, 500000), // max ~375KB ảnh
    bg_color:     b.bg_color||"#FFF6EC",
    card_color:   b.card_color||"#FFFFFF",
    text_color:   b.text_color||"#241610",
    headline:     (b.headline||"WiFi Miễn Phí").trim().slice(0,80),
    btn_text:     (b.btn_text||"Kết nối Internet").trim().slice(0,50),
    show_name:    b.show_name==="1"?1:0,
    require_name: b.require_name==="1"?1:0,
    custom_css:   (b.custom_css||"").slice(0,5000),
    template_id:  b.template_id||"classic",
  });
  res.redirect(`/admin/editor/${id}?saved=1`);
});

app.get("/admin/export.csv", adminAuth, (req, res) => {
  const rows = store.exportCustomers();
  const body = rows.map(r=>[r.phone,`"${(r.name||"").replace(/"/g,'""')}"`,`"${r.quan_dau_tien||""}"`,r.created_at,r.so_lan_ghe].join(",")).join("\n");
  res.set("Content-Type","text/csv; charset=utf-8").set("Content-Disposition","attachment; filename=khach-hang.csv");
  res.send("\uFEFF"+"phone,name,quan_dau_tien,ngay_dang_ky,so_lan_ghe\n"+body);
});

/* ── Admin: Khách & phiên WiFi ───────────────────────────────── */
app.get("/admin/guests", adminAuth, async (req, res) => {
  const locId = req.query.location ? Number(req.query.location) : null;
  const groups = store.listGuestGroups({ locationId: locId, limit: 200 });
  const onlineMap = {};
  for (const loc of store.listLocations()) {
    const router = store.findRouterByLocation(loc.id);
    if (!router?.ssh_host) continue;
    try {
      const clients = await routerCtl.listClients(router);
      onlineMap[loc.id] = clients
        .filter(c => /auth|pre/i.test(c.state || ""))
        .map(c => String(c.mac || "").toLowerCase());
    } catch { onlineMap[loc.id] = []; }
  }
  for (const g of groups) {
    const macs = onlineMap[g.location_id] || [];
    g.is_online = !!(g.last_mac && macs.includes(String(g.last_mac).toLowerCase()) && g.active_count > 0);
  }
  res.render("guests", {
    groups, locations: store.listLocations(),
    filterLocation: locId, saved: req.query.saved === "1",
  });
});

app.get("/admin/guests/detail", adminAuth, (req, res) => {
  const customerId = Number(req.query.customer_id);
  const locationId = Number(req.query.location_id);
  const detail = store.getGuestDetail(customerId, locationId);
  if (!detail) return res.status(404).json({ ok: false, error: "Không tìm thấy khách." });
  res.json({ ok: true, ...detail });
});

app.post("/admin/guests/disconnect", adminAuth, async (req, res) => {
  const locationId = Number(req.body.location_id);
  const mac = String(req.body.mac || "").trim();
  const customerId = Number(req.body.customer_id) || null;
  if (!locationId || !mac) return res.json({ ok: false, error: "Thiếu location_id hoặc MAC." });
  const router = store.findRouterByLocation(locationId);
  if (!router?.ssh_host) return res.json({ ok: false, error: "Router chưa kết nối SSH." });
  try {
    await routerCtl.disconnectClient(router, mac);
    store.endVisitsByMac(locationId, mac);
    res.json({ ok: true, customer_id: customerId });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ── Admin: Khảo sát Q&A ─────────────────────────────────────── */
app.get("/admin/survey/:id", adminAuth, (req, res) => {
  const loc = store.findLocationById(req.params.id);
  if (!loc) return res.redirect("/admin");
  res.render("survey-admin", {
    location: loc,
    questions: store.listSurveyQuestions(loc.id),
    stats: store.surveyAnswerStats(loc.id),
    saved: req.query.saved === "1",
  });
});

app.post("/admin/survey/:id/settings", adminAuth, (req, res) => {
  store.setSurveyEnabled(req.params.id, req.body.enabled === "1", req.body.survey_title);
  res.redirect(`/admin/survey/${req.params.id}?saved=1`);
});

app.post("/admin/survey/:id/add", adminAuth, (req, res) => {
  const text = (req.body.question_text || "").trim();
  if (text) {
    const opts = (req.body.options || "").split("\n").map(s => s.trim()).filter(Boolean);
    store.addSurveyQuestion(req.params.id, {
      question_text: text.slice(0, 200),
      question_type: req.body.question_type || "text",
      options: opts,
      required: req.body.required === "1",
      sort_order: Number(req.body.sort_order) || 0,
    });
  }
  res.redirect(`/admin/survey/${req.params.id}?saved=1`);
});

app.post("/admin/survey/:id/:qid/toggle", adminAuth, (req, res) => {
  store.toggleSurveyQuestion(req.params.qid);
  res.redirect(`/admin/survey/${req.params.id}?saved=1`);
});

app.post("/admin/survey/:id/:qid/delete", adminAuth, (req, res) => {
  store.deleteSurveyQuestion(req.params.qid);
  res.redirect(`/admin/survey/${req.params.id}?saved=1`);
});

/* ── Menu công khai (khách xem sau khi kết nối WiFi) ────────────── */
app.get("/menu/:id", (req, res) => {
  const loc = store.findLocationById(req.params.id);
  if (!loc) return res.status(404).render("error",{message:"Không tìm thấy quán."});
  const items = store.listMenuItems(loc.id);
  const byCategory = {};
  for (const it of items) {
    if (!byCategory[it.category]) byCategory[it.category] = [];
    byCategory[it.category].push(it);
  }
  res.render("menu",{ location:loc, byCategory });
});

/* ── Admin: quản lý Menu ─────────────────────────────────────── */
app.get("/admin/menu/:id", adminAuth, (req, res) => {
  const loc = store.findLocationById(req.params.id);
  if (!loc) return res.redirect("/admin");
  res.render("menu-admin",{ location:loc, items:store.listMenuItems(loc.id) });
});

app.post("/admin/menu/:id", adminAuth, (req, res) => {
  const { category, name, price, description, image_data } = req.body;
  if (name) store.addMenuItem(req.params.id, { category, name, price:Number(price)||0, description, image_data });
  res.redirect(`/admin/menu/${req.params.id}`);
});

app.post("/admin/menu/:id/:itemId/delete", adminAuth, (req, res) => {
  store.deleteMenuItem(req.params.itemId);
  res.redirect(`/admin/menu/${req.params.id}`);
});

app.post("/admin/menu/:id/:itemId/toggle", adminAuth, (req, res) => {
  store.toggleMenuItem(req.params.itemId);
  res.redirect(`/admin/menu/${req.params.id}`);
});

app.post("/admin/menu/:id/enable", adminAuth, (req, res) => {
  store.setMenuEnabled(req.params.id, req.body.enabled === "1");
  res.redirect(`/admin/menu/${req.params.id}`);
});

/* ── Admin: Bản đồ các điểm ──────────────────────────────────── */
app.get("/admin/map", adminAuth, (req, res) => {
  res.render("map",{ locations: store.listLocations() });
});

app.post("/admin/locations/:id/coords", adminAuth, (req, res) => {
  const { latitude, longitude, address } = req.body;
  store.updateLocationCoords(req.params.id, parseFloat(latitude)||null, parseFloat(longitude)||null, address);
  res.json({ ok:true });
});

/* ── Admin: Quản lý Router từ xa (SSH) ───────────────────────── */
app.get("/admin/router/:id", adminAuth, (req, res) => {
  const loc = store.findLocationById(req.params.id);
  if (!loc) return res.redirect("/admin");
  const router = store.findRouterByLocation(loc.id);
  // Không gửi plaintext password ra HTML — chỉ báo đã có mật khẩu hay chưa
  const routerSafe = router ? { ...router, ssh_password: undefined, has_password: !!(router.ssh_password), ssh_privkey: undefined } : null;
  res.render("router-manage",{
    location:loc, router: routerSafe, host: req.get("host"),
    regen: req.query.regen==="1", saved: req.query.saved==="1",
    oneShot: (process.env.ENROLL_ONE_SHOT || "1") !== "0",
  });
});

app.post("/admin/router/:id", adminAuth, (req, res) => {
  const { ssh_host, ssh_port, ssh_user, ssh_password, model } = req.body;
  if (ssh_host) store.upsertRouter(req.params.id, { ssh_host, ssh_port:Number(ssh_port)||22, ssh_user, ssh_password, model });
  res.redirect(`/admin/router/${req.params.id}?saved=1`);
});

// Test kết nối SSH
app.post("/admin/router/:id/test", adminAuth, async (req, res) => {
  const router = store.findRouterByLocation(req.params.id);
  if (!router) return res.json({ ok:false, error:"Chưa cấu hình router." });
  const result = await routerCtl.testConnection(router);
  res.json(result);
});

// Đẩy cấu hình OpenNDS xuống router (tự động, khớp với location hiện tại)
app.post("/admin/router/:id/push-config", adminAuth, async (req, res) => {
  const loc = store.findLocationById(req.params.id);
  const router = store.findRouterByLocation(req.params.id);
  if (!loc || !router) return res.json({ ok:false, error:"Thiếu thông tin quán hoặc router." });
  try {
    const domain = req.body.domain || req.get("host");
    const token = store.ensureReportToken(loc.id);
    const result = await routerCtl.pushOpenNDSConfig(router, loc, domain, req.body.session_minutes, token);
    store.updateRouterStatus(router.id, JSON.stringify({ lastPush: "ok" }));
    res.json(result);
  } catch (e) {
    res.json({ ok:false, error: e.message });
  }
});

// Đổi SSID/mật khẩu WiFi từ xa
app.post("/admin/router/:id/wifi", adminAuth, async (req, res) => {
  const router = store.findRouterByLocation(req.params.id);
  if (!router) return res.json({ ok:false, error:"Chưa cấu hình router." });
  try {
    const result = await routerCtl.setWifi(router, { ssid:req.body.ssid, password:req.body.password, radio:req.body.radio });
    res.json(result);
  } catch (e) {
    res.json({ ok:false, error: e.message });
  }
});

// Danh sách client đang kết nối (poll AJAX)
app.get("/admin/router/:id/clients", adminAuth, async (req, res) => {
  const router = store.findRouterByLocation(req.params.id);
  if (!router) return res.json({ ok:false, error:"Chưa cấu hình router.", clients:[] });
  try {
    const clients = await routerCtl.listClients(router);
    res.json({ ok:true, clients });
  } catch (e) {
    res.json({ ok:false, error: e.message, clients:[] });
  }
});

// Ngắt kết nối 1 khách
app.post("/admin/router/:id/disconnect", adminAuth, async (req, res) => {
  const router = store.findRouterByLocation(req.params.id);
  if (!router) return res.json({ ok:false, error:"Chưa cấu hình router." });
  try {
    const out = await routerCtl.disconnectClient(router, req.body.mac);
    store.endVisitsByMac(Number(req.params.id), req.body.mac);
    res.json({ ok:true, out });
  } catch (e) {
    res.json({ ok:false, error: e.message });
  }
});

// Trạng thái tổng quát router (uptime, model, số client)
app.get("/admin/router/:id/status", adminAuth, async (req, res) => {
  const router = store.findRouterByLocation(req.params.id);
  if (!router) return res.json({ ok:false, error:"Chưa cấu hình router." });
  try {
    const status = await routerCtl.getStatus(router);
    store.updateRouterStatus(router.id, JSON.stringify(status));
    res.json(status);
  } catch (e) {
    res.json({ ok:false, error: e.message });
  }
});

app.get("/health", (_,res) => res.json({
  ok: true,
  portal_version: versioning.portalVersion(),
  firmware_version: versioning.firmwareVersion(),
  firmware_latest: versioning.readLatestManifest()?.version || null,
}));

/* ── Firmware OTA (public download + report) ───────────────── */
app.get("/firmware/latest.json", publicLimiter, (req, res) => {
  const m = versioning.readLatestManifest();
  if (!m) return res.status(404).json({ error: "Chưa publish firmware nào. Vào /admin/releases." });
  res.set("Cache-Control", "no-store").json(m);
});

app.get("/firmware/latest.env", publicLimiter, (req, res) => {
  const p = path.join(versioning.FW_DIST, "latest.env");
  if (!fs.existsSync(p)) return res.status(404).type("text/plain").send("# no release\n");
  res.set("Cache-Control", "no-store").type("text/plain").send(fs.readFileSync(p, "utf8"));
});

app.get("/firmware/download/:file", publicLimiter, (req, res) => {
  const full = versioning.firmwareFilePath(req.params.file);
  if (!full) return res.status(404).send("Not found");
  res.set("Cache-Control", "no-store");
  res.download(full, path.basename(full));
});

app.post("/api/firmware/report", publicLimiter, (req, res) => {
  const token = (req.body.token || "").trim();
  const version = (req.body.version || "").trim().slice(0, 32);
  const gateway = (req.body.gateway_name || "").trim();
  const router = store.findRouterByReportToken(token);
  if (!router) return res.status(404).json({ ok:false, error:"invalid token" });
  if (gateway && router.gateway_name && gateway !== router.gateway_name) {
    return res.status(403).json({ ok:false, error:"gateway mismatch" });
  }
  if (version) store.setRouterFirmwareVersion(router.location_id, version);
  res.json({ ok:true, version });
});

/* ── Admin: Releases ─────────────────────────────────────────── */
app.get("/admin/releases", adminAuth, (req, res) => {
  res.render("releases", {
    portalVersion: versioning.portalVersion(),
    firmwareVersion: versioning.firmwareVersion(),
    latest: versioning.readLatestManifest(),
    releases: store.listFirmwareReleases(30),
    packages: versioning.listBuiltPackages(),
    pushes: store.recentFirmwarePushes(30),
    locations: store.listLocations().map(l => {
      const r = store.findRouterByLocation(l.id);
      return { ...l, router: r ? { ssh_host: r.ssh_host, firmware_version: r.firmware_version } : null };
    }),
    published: req.query.published === "1",
    pushed: req.query.pushed === "1",
  });
});

app.post("/admin/releases/publish", adminAuth, (req, res) => {
  try {
    const changelog = (req.body.changelog || "").trim().slice(0, 2000);
    const domain = req.body.domain || req.get("host");
    const built = versioning.buildFirmwarePackage({ changelog, portalDomain: domain });
    store.upsertFirmwareRelease({
      version: built.version,
      portal_version: built.portal_version,
      changelog: built.changelog,
      sha256: built.sha256,
      filename: built.filename,
      size_bytes: built.size,
    });
    res.redirect("/admin/releases?published=1");
  } catch (e) {
    console.error(e);
    res.status(500).send("Publish thất bại: " + e.message);
  }
});

app.post("/admin/router/:id/push-firmware", adminAuth, async (req, res) => {
  const loc = store.findLocationById(req.params.id);
  const router = store.findRouterByLocation(req.params.id);
  if (!loc || !router?.ssh_host) return res.json({ ok:false, error:"Chưa có router SSH." });
  const latest = versioning.readLatestManifest();
  if (!latest) return res.json({ ok:false, error:"Chưa publish firmware." });
  store.ensureReportToken(loc.id);
  const routerFresh = store.findRouterByLocation(loc.id);
  try {
    const domain = req.body.domain || req.get("host");
    const result = await routerCtl.pushFirmwareUpdate(routerFresh, {
      domain, version: latest.version, filename: latest.filename,
    });
    store.setRouterFirmwareVersion(loc.id, result.version || latest.version);
    store.logFirmwarePush(loc.id, latest.version, "ok", JSON.stringify(result.log||[]).slice(0, 2000));
    res.json(result);
  } catch (e) {
    store.logFirmwarePush(loc.id, latest.version, "failed", e.message);
    res.json({ ok:false, error: e.message });
  }
});

app.post("/admin/releases/push-all", adminAuth, async (req, res) => {
  const latest = versioning.readLatestManifest();
  if (!latest) return res.json({ ok:false, error:"Chưa publish firmware." });
  const domain = req.body.domain || req.get("host");
  const results = [];
  for (const loc of store.listLocations()) {
    const router = store.findRouterByLocation(loc.id);
    if (!router?.ssh_host) {
      results.push({ id: loc.id, name: loc.display_name, ok:false, error:"no ssh" });
      continue;
    }
    store.ensureReportToken(loc.id);
    try {
      const r = store.findRouterByLocation(loc.id);
      const out = await routerCtl.pushFirmwareUpdate(r, {
        domain, version: latest.version, filename: latest.filename,
      });
      store.setRouterFirmwareVersion(loc.id, out.version || latest.version);
      store.logFirmwarePush(loc.id, latest.version, "ok", "push-all");
      results.push({ id: loc.id, name: loc.display_name, ok:true, version: out.version });
    } catch (e) {
      store.logFirmwarePush(loc.id, latest.version, "failed", e.message);
      results.push({ id: loc.id, name: loc.display_name, ok:false, error: e.message });
    }
  }
  res.json({ ok:true, version: latest.version, results });
});

/* ── Gói cài đặt tự động cho router ─────────────────────────── */

// Tải script cài đặt (public bằng token bí mật trong URL — rate-limit + token dài)
app.get("/install/:token.sh", publicLimiter, (req, res) => {
  const token = String(req.params.token || "").replace(/\.sh$/i, "");
  const loc = store.findLocationByEnrollToken(token);
  if (!loc) return res.status(404).type("text/plain").send("echo 'Link không hợp lệ hoặc đã bị thu hồi.'");

  if (!process.env.TAILSCALE_AUTHKEY) {
    return res.status(500).type("text/plain")
      .send("echo 'Server chưa cấu hình TAILSCALE_AUTHKEY trong .env. Liên hệ quản trị viên.'");
  }

  // Đảm bảo đã có gói firmware để enroll tải
  if (!versioning.readLatestManifest()) {
    try {
      const built = versioning.buildFirmwarePackage({
        changelog: "Auto-publish on first enroll",
        portalDomain: req.get("host"),
      });
      store.upsertFirmwareRelease({
        version: built.version, portal_version: built.portal_version,
        changelog: built.changelog, sha256: built.sha256,
        filename: built.filename, size_bytes: built.size,
      });
    } catch (e) {
      console.warn("[firmware] auto-publish failed:", e.message);
    }
  }

  // Sinh keypair lần đầu nếu quán này chưa có
  let router = store.findRouterByLocation(loc.id);
  if (!router || !router.ssh_pubkey) {
    const { pub, priv } = enroll.generateKeypair(`h2t-${loc.gateway_name}`);
    router = store.ensureRouterRecord(loc.id, pub, priv);
  }
  const reportToken = store.ensureReportToken(loc.id);
  const fw = versioning.readLatestManifest();

  const domain = req.get("host");
  const script = enroll.buildInstallScript({
    location: loc, domain, token: loc.enroll_token,
    pubkey: router.ssh_pubkey, tailscaleAuthKey: process.env.TAILSCALE_AUTHKEY,
    firmwareVersion: fw?.version || versioning.firmwareVersion(),
    reportToken,
  });
  res.set("Cache-Control", "no-store");
  res.type("text/x-shellscript").send(script);
});

// Router tự gọi về sau khi cài xong (không cần Basic Auth)
app.post("/api/enroll/:token", publicLimiter, (req, res) => {
  const loc = store.findLocationByEnrollToken(req.params.token);
  if (!loc) return res.status(404).json({ ok:false, error:"invalid token" });
  const ts_ip = (req.body.ts_ip || "").trim();
  const model = (req.body.model || "").trim().slice(0, 80);
  // Chỉ chấp nhận IP Tailscale (CGNAT range 100.64.0.0/10) hoặc IPv4 hợp lệ
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ts_ip)) {
    return res.status(400).json({ ok:false, error:"missing or invalid ts_ip" });
  }
  store.markRouterEnrolled(loc.id, { tsIp: ts_ip, model });
  const fw = versioning.readLatestManifest();
  if (fw) store.setRouterFirmwareVersion(loc.id, fw.version);
  res.json({ ok:true, one_shot: (process.env.ENROLL_ONE_SHOT || "1") !== "0", firmware_version: fw?.version || null });
});

/* ── Session webhook (binauth / router) + manual sync ─────────── */
app.post("/api/session/end", publicLimiter, (req, res) => {
  const token = String(req.body.token || req.query.token || "").trim();
  const mac = String(req.body.mac || "").trim();
  const gateway = String(req.body.gateway_name || "").trim();
  const event = String(req.body.event || "logout").trim();
  const router = store.findRouterByReportToken(token);
  if (!router) return res.status(403).json({ ok: false, error: "invalid token" });
  let loc = router.location_id ? store.findLocationById(router.location_id) : null;
  if (gateway && loc && loc.gateway_name !== gateway) {
    const alt = store.findLocationByGateway(gateway);
    if (alt) loc = alt;
  }
  if (!loc || !mac) return res.status(400).json({ ok: false, error: "missing mac or location" });
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) {
    return res.status(400).json({ ok: false, error: "invalid mac" });
  }
  const ended = store.endVisitsByMac(loc.id, mac);
  res.json({ ok: true, ended, event, location_id: loc.id });
});

app.post("/admin/session/sync", adminAuth, async (req, res) => {
  try {
    const ended = await sessionSync.syncAll();
    res.json({ ok: true, ended });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Tạo lại token (vô hiệu hoá link cũ) — dùng khi nghi ngờ link bị lộ
app.post("/admin/locations/:id/regen-token", adminAuth, (req, res) => {
  store.regenerateEnrollToken(req.params.id);
  res.redirect(`/admin/router/${req.params.id}?regen=1`);
});

// Auto-publish firmware lần đầu khi server start (nếu chưa có)
try {
  if (!versioning.readLatestManifest()) {
    const built = versioning.buildFirmwarePackage({ changelog: "Initial firmware package" });
    store.upsertFirmwareRelease({
      version: built.version, portal_version: built.portal_version,
      changelog: built.changelog, sha256: built.sha256,
      filename: built.filename, size_bytes: built.size,
    });
    console.log(`[firmware] published ${built.version} (${built.filename})`);
  }
} catch (e) {
  console.warn("[firmware] bootstrap failed:", e.message);
}

sessionSync.startSessionSync();

app.listen(PORT, () => console.log(`H2T WiFi Marketing v${versioning.portalVersion()} : http://0.0.0.0:${PORT} (fw ${versioning.firmwareVersion()})`));
