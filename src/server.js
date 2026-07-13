require("dotenv").config();
const express = require("express");
const crypto  = require("crypto");
const path    = require("path");
const store   = require("./db");
const zalo    = require("./zalo");

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
function safeDecodeURIComponent(value) {
  const input = String(value || "");
  try { return decodeURIComponent(input); }
  catch { return input; }
}

function normalizeGatewayName(value) {
  return safeDecodeURIComponent(value)
    .trim()
    .replace(/\s+Node:[a-fA-F0-9:-]+\s*$/i, "")
    .trim();
}

function buildGatewayBaseUrl(gatewayaddress, gatewayport = "2050") {
  let address = safeDecodeURIComponent(gatewayaddress).trim().replace(/\/+$/, "");
  const port = String(gatewayport || "2050").trim();

  if (!address) return "";

  // openNDS may send a complete URL or an address that already contains :2050.
  if (/^https?:\/\//i.test(address)) return address;
  if (/^\[[0-9a-f:]+\](?::\d+)?$/i.test(address)) {
    return /\]:\d+$/.test(address) ? `http://${address}` : `http://${address}:${port}`;
  }
  if (/:\d+$/.test(address)) return `http://${address}`;

  return `http://${address}:${port}`;
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
  if (!p?.hid || !p?.gatewayname) {
    return res.status(400).render("error", { message: "Thiếu thông tin từ router." });
  }

  const gatewayname = normalizeGatewayName(p.gatewayname);
  const loc = store.findLocationByGateway(gatewayname);

  if (!loc) {
    return res.status(404).render("error", { message: `Chưa khai báo quán "${gatewayname}".` });
  }

  return res.render("portal", {
    location: loc,
    hid: p.hid,
    gatewayname,
    gatewayaddress: safeDecodeURIComponent(p.gatewayaddress || ""),
    gatewayport: p.gatewayport || "2050",
    clientmac: p.clientmac || "",
    clientip: p.clientip || "",
    originurl: safeDecodeURIComponent(p.originurl || "http://neverssl.com"),
    error: null
  });
});

app.post("/auth", (req, res) => {
  const {
    hid,
    gatewayname: rawGatewayName,
    gatewayaddress,
    gatewayport,
    clientmac,
    clientip,
    originurl,
    phone,
    name
  } = req.body;

  const gatewayname = normalizeGatewayName(rawGatewayName);
  const loc = store.findLocationByGateway(gatewayname);

  if (!loc || !hid || !gatewayaddress) {
    return res.status(400).render("error", { message: "Phiên không hợp lệ." });
  }

  if (!validPhone(phone)) {
    return res.render("portal", {
      location: loc,
      hid,
      gatewayname,
      gatewayaddress,
      gatewayport: gatewayport || "2050",
      clientmac,
      clientip,
      originurl,
      error: "Số điện thoại chưa đúng, bạn kiểm tra lại giúp mình nha!"
    });
  }

  const ph = normPhone(phone);
  const customerName = (name || "").trim().slice(0, 60);
  const cid = store.upsertCustomer(ph, customerName, loc.id);
  const cnt = store.logVisit(cid, loc.id, clientmac, clientip);

  zalo.onVisit({
    customerId: cid,
    phone: ph,
    name: customerName,
    locationName: loc.display_name,
    visitCount: cnt
  }).catch(() => {});

  const gatewayBaseUrl = buildGatewayBaseUrl(gatewayaddress, gatewayport);
  if (!gatewayBaseUrl) {
    return res.status(400).render("error", { message: "Không xác định được địa chỉ router." });
  }

  const redirectUrl = safeDecodeURIComponent(originurl || "http://neverssl.com");
  const token = rhid(hid, loc.faskey);
  const authUrl = `${gatewayBaseUrl}/opennds_auth/?tok=${encodeURIComponent(token)}&redir=${encodeURIComponent(redirectUrl)}`;

  console.log("openNDS auth URL:", authUrl);
  return res.redirect(302, authUrl);
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

app.get("/health", (_,res) => res.json({ok:true}));

app.listen(PORT, () => console.log(`H2T WiFi Marketing : http://0.0.0.0:${PORT}`));
