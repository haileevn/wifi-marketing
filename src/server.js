require("dotenv").config();
const express = require("express");
const crypto  = require("crypto");
const path    = require("path");
const store   = require("./db");
const zalo    = require("./zalo");
const routerCtl = require("./router");
const enroll  = require("./enroll");

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false, limit: "8mb" })); // logo base64 lớn
app.use(express.json({ limit: "8mb" }));

const PORT = process.env.PORT || 20140;

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
function adminAuth(req, res, next) {
  const [u,p] = Buffer.from((req.headers.authorization||"").split(" ")[1]||"","base64").toString().split(":");
  if (u===process.env.ADMIN_USER && p===process.env.ADMIN_PASS) return next();
  res.set("WWW-Authenticate",'Basic realm="H2T WiFi Admin"');
  res.status(401).send("Yêu cầu đăng nhập");
}

/* ── Portal / FAS ────────────────────────────────────────────── */
app.get("/fas", (req, res) => {
  const p = req.query.fas ? parseFasParam(req.query.fas) : req.query;
  if (!p?.hid || !p?.gatewayname) return res.status(400).render("error",{message:"Thiếu thông tin từ router."});
  const loc = store.findLocationByGateway(p.gatewayname);
  if (!loc) return res.status(404).render("error",{message:`Chưa khai báo quán "${p.gatewayname}".`});
  res.render("portal",{ location:loc, hid:p.hid, gatewayname:p.gatewayname,
    gatewayaddress:p.gatewayaddress||"", gatewayport:p.gatewayport||"2050",
    clientmac:p.clientmac||"", clientip:p.clientip||"",
    originurl:p.originurl||"http://google.com", error:null });
});

app.post("/auth", (req, res) => {
  const { hid, gatewayname, gatewayaddress, gatewayport, clientmac, clientip, originurl, phone, name } = req.body;
  const loc = store.findLocationByGateway(gatewayname);
  if (!loc || !hid || !gatewayaddress) return res.status(400).render("error",{message:"Phiên không hợp lệ."});
  if (!validPhone(phone)) return res.render("portal",{ location:loc, hid, gatewayname, gatewayaddress, gatewayport,
    clientmac, clientip, originurl, error:"Số điện thoại chưa đúng, bạn kiểm tra lại giúp mình nha!" });
  const ph = normPhone(phone);
  const cid = store.upsertCustomer(ph, (name||"").trim().slice(0,60), loc.id);
  const cnt = store.logVisit(cid, loc.id, clientmac, clientip);
  zalo.onVisit({ customerId:cid, phone:ph, name:(name||"").trim(), locationName:loc.display_name, visitCount:cnt }).catch(()=>{});
  const authUrl = `http://${gatewayaddress}:${gatewayport}/opennds_auth/?tok=${rhid(hid,loc.faskey)}&redir=${encodeURIComponent(originurl||"http://google.com")}`;
  res.render("success",{ location:loc, authUrl });
});

/* ── Preview standalone (không cần FAS) ─────────────────────── */
app.get("/preview/:id", (req, res) => {
  const loc = store.findLocationById(req.params.id);
  if (!loc) return res.status(404).render("error",{message:"Không tìm thấy quán."});
  res.render("portal",{ location:loc, hid:"preview", gatewayname:loc.gateway_name,
    gatewayaddress:"127.0.0.1", gatewayport:"2050", clientmac:"", clientip:"",
    originurl:"http://google.com", error:null });
});

/* ── Admin ───────────────────────────────────────────────────── */
app.get("/admin", adminAuth, (req, res) => {
  res.render("admin",{ stats:store.stats(), recent:store.recentVisits(50),
    zns:store.recentZns(30), locations:store.listLocations(),
    defaultFaskey:process.env.DEFAULT_FASKEY||"", saved:req.query.saved==="1" });
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
  res.render("router-manage",{ location:loc, router, host: req.get("host"), regen: req.query.regen==="1" });
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
    const result = await routerCtl.pushOpenNDSConfig(router, loc, domain, req.body.session_minutes);
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

app.get("/health", (_,res) => res.json({ok:true}));

/* ── Gói cài đặt tự động cho router ─────────────────────────── */

// Tải script cài đặt (public bằng token bí mật trong URL, không cần đăng nhập vì router gọi trực tiếp)
app.get("/install/:token.sh", (req, res) => {
  const loc = store.findLocationByEnrollToken(req.params.token);
  if (!loc) return res.status(404).type("text/plain").send("echo 'Link không hợp lệ hoặc đã bị thu hồi.'");

  if (!process.env.TAILSCALE_AUTHKEY) {
    return res.status(500).type("text/plain")
      .send("echo 'Server chưa cấu hình TAILSCALE_AUTHKEY trong .env. Liên hệ quản trị viên.'");
  }

  // Sinh keypair lần đầu nếu quán này chưa có
  let router = store.findRouterByLocation(loc.id);
  if (!router || !router.ssh_pubkey) {
    const { pub, priv } = enroll.generateKeypair(`h2t-${loc.gateway_name}`);
    router = store.ensureRouterRecord(loc.id, pub, priv);
  }

  const domain = req.get("host");
  const script = enroll.buildInstallScript({
    location: loc, domain, token: loc.enroll_token,
    pubkey: router.ssh_pubkey, tailscaleAuthKey: process.env.TAILSCALE_AUTHKEY,
  });
  res.type("text/x-shellscript").send(script);
});

// Router tự gọi về sau khi cài xong (không cần Basic Auth vì router không đăng nhập được kiểu đó)
app.post("/api/enroll/:token", (req, res) => {
  const loc = store.findLocationByEnrollToken(req.params.token);
  if (!loc) return res.status(404).json({ ok:false, error:"invalid token" });
  const { ts_ip, model } = req.body;
  if (!ts_ip) return res.status(400).json({ ok:false, error:"missing ts_ip" });
  store.markRouterEnrolled(loc.id, { tsIp: ts_ip, model });
  res.json({ ok:true });
});

// Tạo lại token (vô hiệu hoá link cũ) — dùng khi nghi ngờ link bị lộ
app.post("/admin/locations/:id/regen-token", adminAuth, (req, res) => {
  store.regenerateEnrollToken(req.params.id);
  res.redirect(`/admin/router/${req.params.id}?regen=1`);
});

app.listen(PORT, () => console.log(`H2T WiFi Marketing : http://0.0.0.0:${PORT}`));
