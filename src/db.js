const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const secrets = require("./secrets");

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "wifi.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

function newEnrollToken() {
  return crypto.randomBytes(32).toString("hex");
}

db.exec(`
CREATE TABLE IF NOT EXISTS locations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_name  TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  faskey        TEXT NOT NULL,
  promo_text    TEXT DEFAULT 'Kết nối WiFi miễn phí - nhận ưu đãi thành viên!',
  zalo_link     TEXT DEFAULT '',
  accent_color  TEXT DEFAULT '#B4452C',
  created_at    TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT DEFAULT '',
  first_location_id INTEGER,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (first_location_id) REFERENCES locations(id)
);
CREATE TABLE IF NOT EXISTS visits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL,
  location_id   INTEGER NOT NULL,
  client_mac    TEXT,
  client_ip     TEXT,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (location_id) REFERENCES locations(id)
);
CREATE INDEX IF NOT EXISTS idx_visits_location ON visits(location_id, created_at);
CREATE INDEX IF NOT EXISTS idx_visits_customer ON visits(customer_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS zns_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  campaign    TEXT NOT NULL,
  status      TEXT NOT NULL,
  detail      TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE INDEX IF NOT EXISTS idx_zns_customer ON zns_log(customer_id, campaign);

-- Thông tin router quản lý từ xa qua SSH (cần router có IP truy cập được từ VPS: port-forward hoặc VPN mesh)
CREATE TABLE IF NOT EXISTS routers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id  INTEGER NOT NULL UNIQUE,
  ssh_host     TEXT NOT NULL,
  ssh_port     INTEGER DEFAULT 22,
  ssh_user     TEXT DEFAULT 'root',
  ssh_password TEXT DEFAULT '',
  model        TEXT DEFAULT '',
  last_status  TEXT DEFAULT '',
  last_seen    TEXT DEFAULT '',
  FOREIGN KEY (location_id) REFERENCES locations(id)
);

-- Menu món ăn theo từng quán
CREATE TABLE IF NOT EXISTS menu_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id  INTEGER NOT NULL,
  category     TEXT DEFAULT 'Món chính',
  name         TEXT NOT NULL,
  price        INTEGER DEFAULT 0,
  description  TEXT DEFAULT '',
  image_data   TEXT DEFAULT '',
  available    INTEGER DEFAULT 1,
  sort_order   INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (location_id) REFERENCES locations(id)
);
CREATE INDEX IF NOT EXISTS idx_menu_location ON menu_items(location_id, category, sort_order);

CREATE TABLE IF NOT EXISTS firmware_releases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version       TEXT UNIQUE NOT NULL,
  portal_version TEXT DEFAULT '',
  changelog     TEXT DEFAULT '',
  sha256        TEXT DEFAULT '',
  filename      TEXT NOT NULL,
  size_bytes    INTEGER DEFAULT 0,
  published_at  TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS firmware_push_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id   INTEGER,
  version       TEXT NOT NULL,
  status        TEXT NOT NULL,
  detail        TEXT DEFAULT '',
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (location_id) REFERENCES locations(id)
);
`);

// Migration: thêm cột design mới nếu chưa có
const existingCols = db.prepare("PRAGMA table_info(locations)").all().map(c => c.name);
const newCols = [
  ["logo_data",    "TEXT DEFAULT ''"],
  ["bg_color",     "TEXT DEFAULT '#FFF6EC'"],
  ["card_color",   "TEXT DEFAULT '#FFFFFF'"],
  ["text_color",   "TEXT DEFAULT '#241610'"],
  ["headline",     "TEXT DEFAULT 'WiFi Miễn Phí'"],
  ["btn_text",     "TEXT DEFAULT 'Kết nối Internet'"],
  ["show_name",    "INTEGER DEFAULT 1"],
  ["require_name", "INTEGER DEFAULT 0"],
  ["custom_css",   "TEXT DEFAULT ''"],
  ["template_id",  "TEXT DEFAULT 'classic'"],
  ["latitude",     "REAL DEFAULT NULL"],
  ["longitude",    "REAL DEFAULT NULL"],
  ["address",      "TEXT DEFAULT ''"],
  ["menu_enabled", "INTEGER DEFAULT 0"],
  ["enroll_token", "TEXT DEFAULT ''"],
  // URL absolute sau khi OpenNDS auth xong (tránh originurl CPD = IP gateway → 404)
  ["success_redirect", "TEXT DEFAULT ''"],
  ["google_review_url", "TEXT DEFAULT ''"],
  ["survey_enabled", "INTEGER DEFAULT 0"],
  ["survey_title", "TEXT DEFAULT 'Khảo sát nhanh'"],
  ["cover_data", "TEXT DEFAULT ''"],
];
for (const [col, def] of newCols) {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE locations ADD COLUMN ${col} ${def}`);
  }
}

// Migration visits: thời gian ra + trạng thái phiên
const visitCols = db.prepare("PRAGMA table_info(visits)").all().map(c => c.name);
const visitNewCols = [
  ["ended_at", "TEXT DEFAULT NULL"],
  ["status", "TEXT DEFAULT 'active'"],
];
for (const [col, def] of visitNewCols) {
  if (!visitCols.includes(col)) {
    db.exec(`ALTER TABLE visits ADD COLUMN ${col} ${def}`);
  }
}

// Khảo sát Q&A theo quán
db.exec(`
CREATE TABLE IF NOT EXISTS survey_questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id   INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  question_type TEXT DEFAULT 'text',
  options       TEXT DEFAULT '[]',
  required      INTEGER DEFAULT 0,
  sort_order    INTEGER DEFAULT 0,
  active        INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (location_id) REFERENCES locations(id)
);
CREATE INDEX IF NOT EXISTS idx_survey_q_loc ON survey_questions(location_id, sort_order);
CREATE TABLE IF NOT EXISTS survey_answers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id      INTEGER NOT NULL,
  customer_id   INTEGER NOT NULL,
  location_id   INTEGER NOT NULL,
  question_id   INTEGER NOT NULL,
  answer_text   TEXT DEFAULT '',
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (visit_id) REFERENCES visits(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (location_id) REFERENCES locations(id),
  FOREIGN KEY (question_id) REFERENCES survey_questions(id)
);
CREATE INDEX IF NOT EXISTS idx_survey_ans_visit ON survey_answers(visit_id);
`);

// Migration cho bảng routers: hỗ trợ SSH key thay vì chỉ mật khẩu
const routerCols = db.prepare("PRAGMA table_info(routers)").all().map(c => c.name);
const routerNewCols = [
  ["ssh_privkey",  "TEXT DEFAULT ''"],
  ["ssh_pubkey",   "TEXT DEFAULT ''"],
  ["enrolled_at",  "TEXT DEFAULT ''"],
  ["firmware_version", "TEXT DEFAULT ''"],
  ["report_token", "TEXT DEFAULT ''"],
];
for (const [col, def] of routerNewCols) {
  if (!routerCols.includes(col)) {
    db.exec(`ALTER TABLE routers ADD COLUMN ${col} ${def}`);
  }
}

// Sinh enroll_token cho các quán chưa có (dữ liệu cũ)
const noToken = db.prepare("SELECT id FROM locations WHERE enroll_token = '' OR enroll_token IS NULL").all();
for (const row of noToken) {
  db.prepare("UPDATE locations SET enroll_token = ? WHERE id = ?").run(newEnrollToken(), row.id);
}

function withDecryptedPassword(router) {
  if (!router) return null;
  try {
    return { ...router, ssh_password: secrets.decrypt(router.ssh_password || "") };
  } catch (e) {
    console.warn("[db] không giải mã được ssh_password:", e.message);
    return { ...router, ssh_password: "" };
  }
}

module.exports = {
  db,

  findLocationByGateway(gw) {
    // OpenNDS FAS thường gửi: "comtam-72phl Node:aabbccddeeff" (và đôi khi còn URL-encoded)
    let name = String(gw || "").trim();
    try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch { /* keep */ }
    name = name.trim();
    // Bỏ suffix " Node:..." mà openNDS gắn thêm
    const base = name.replace(/\s+Node:[0-9a-fA-F:.-]+\s*$/i, "").trim();
    return (
      db.prepare("SELECT * FROM locations WHERE gateway_name = ?").get(base) ||
      db.prepare("SELECT * FROM locations WHERE gateway_name = ?").get(name) ||
      // fallback: prefix match nếu người dùng đổi tên nhưng openNDS cũ còn sót
      db.prepare("SELECT * FROM locations WHERE ? LIKE gateway_name || '%' ORDER BY length(gateway_name) DESC LIMIT 1").get(base)
    );
  },

  findLocationById(id) {
    return db.prepare("SELECT * FROM locations WHERE id = ?").get(id);
  },

  listLocations() {
    return db.prepare("SELECT * FROM locations ORDER BY id").all();
  },

  addLocation({ gateway_name, display_name, faskey, promo_text, zalo_link, accent_color }) {
    const token = newEnrollToken();
    return db.prepare(`
      INSERT INTO locations (gateway_name, display_name, faskey, promo_text, zalo_link, accent_color, enroll_token)
      VALUES (@gateway_name, @display_name, @faskey,
              COALESCE(@promo_text,'Kết nối WiFi miễn phí - nhận ưu đãi thành viên!'),
              COALESCE(@zalo_link,''), COALESCE(@accent_color,'#B4452C'), @token)
    `).run({ gateway_name, display_name, faskey, promo_text, zalo_link, accent_color, token });
  },

  updateLocationDesign(id, d) {
    db.prepare(`UPDATE locations SET
      display_name=@display_name, promo_text=@promo_text, zalo_link=@zalo_link,
      accent_color=@accent_color, logo_data=@logo_data, cover_data=@cover_data,
      bg_color=@bg_color, card_color=@card_color, text_color=@text_color,
      headline=@headline, btn_text=@btn_text, show_name=@show_name, require_name=@require_name,
      custom_css=@custom_css, template_id=@template_id,
      success_redirect=@success_redirect,
      google_review_url=@google_review_url, survey_enabled=@survey_enabled, survey_title=@survey_title
    WHERE id=@id`).run({ id, ...d });
  },

  upsertCustomer(phone, name, locationId) {
    const ex = db.prepare("SELECT * FROM customers WHERE phone = ?").get(phone);
    if (ex) {
      if (name && !ex.name) db.prepare("UPDATE customers SET name=? WHERE id=?").run(name, ex.id);
      return ex.id;
    }
    return db.prepare("INSERT INTO customers (phone,name,first_location_id) VALUES (?,?,?)")
      .run(phone, name || "", locationId).lastInsertRowid;
  },

  /** Ghi nhận phiên vào — gộp nếu cùng khách+quán+MAC còn active trong X phút */
  logVisit(customerId, locationId, mac, ip) {
    const mergeMin = Number(process.env.VISIT_MERGE_MINUTES || 30);
    const macNorm = String(mac || "").toLowerCase();
    const active = db.prepare(`
      SELECT id FROM visits
      WHERE customer_id=? AND location_id=? AND lower(client_mac)=?
        AND ended_at IS NULL AND status='active'
        AND datetime(created_at) > datetime('now', '-' || ? || ' minutes', 'localtime')
      ORDER BY id DESC LIMIT 1
    `).get(customerId, locationId, macNorm, mergeMin);
    if (active) {
      db.prepare("UPDATE visits SET client_ip=? WHERE id=?").run(ip || "", active.id);
      const n = db.prepare("SELECT COUNT(*) AS n FROM visits WHERE customer_id=?").get(customerId).n;
      return { visitId: active.id, merged: true, count: n };
    }
    const visitId = db.prepare(
      "INSERT INTO visits (customer_id,location_id,client_mac,client_ip,status) VALUES (?,?,?,?,'active')"
    ).run(customerId, locationId, macNorm, ip || "").lastInsertRowid;
    const n = db.prepare("SELECT COUNT(*) AS n FROM visits WHERE customer_id=?").get(customerId).n;
    return { visitId, merged: false, count: n };
  },

  endVisitsByMac(locationId, mac) {
    const m = String(mac || "").toLowerCase();
    return db.prepare(`
      UPDATE visits SET ended_at=datetime('now','localtime'), status='ended'
      WHERE location_id=? AND lower(client_mac)=? AND ended_at IS NULL
    `).run(locationId, m).changes;
  },

  endVisitById(visitId) {
    return db.prepare(`
      UPDATE visits SET ended_at=datetime('now','localtime'), status='ended'
      WHERE id=? AND ended_at IS NULL
    `).run(visitId).changes;
  },

  /** Đóng phiên active khi MAC không còn trong danh sách online (cron sync) */
  endStaleActiveVisits(locationId, onlineMacs) {
    const set = new Set((onlineMacs || []).map((m) => String(m).toLowerCase()));
    const active = db.prepare(`
      SELECT id, client_mac FROM visits
      WHERE location_id=? AND ended_at IS NULL AND status='active'
    `).all(locationId);
    const end = db.prepare(`
      UPDATE visits SET ended_at=datetime('now','localtime'), status='ended'
      WHERE id=? AND ended_at IS NULL
    `);
    let n = 0;
    for (const v of active) {
      const mac = String(v.client_mac || "").toLowerCase();
      if (mac && !set.has(mac)) {
        end.run(v.id);
        n++;
      }
    }
    return n;
  },

  findLocationByGatewayForSession(gatewayName) {
    return module.exports.findLocationByGateway(gatewayName);
  },

  surveyAnswerStats(locationId) {
    const rows = db.prepare(`
      SELECT sq.id AS question_id, sq.question_text, sq.question_type,
             sa.answer_text, COUNT(*) AS cnt
      FROM survey_answers sa
      JOIN survey_questions sq ON sq.id = sa.question_id
      WHERE sa.location_id = ?
      GROUP BY sq.id, sa.answer_text
      ORDER BY sq.sort_order, sq.id, cnt DESC
    `).all(locationId);
    const byQ = {};
    for (const r of rows) {
      if (!byQ[r.question_id]) {
        byQ[r.question_id] = {
          question_id: r.question_id,
          question_text: r.question_text,
          question_type: r.question_type,
          total: 0,
          answers: [],
        };
      }
      byQ[r.question_id].total += r.cnt;
      byQ[r.question_id].answers.push({ text: r.answer_text, count: r.cnt });
    }
    return Object.values(byQ);
  },

  listGuestGroups({ locationId = null, limit = 100 } = {}) {
    const where = locationId ? "WHERE l.id = ?" : "";
    const params = locationId ? [locationId, limit] : [limit];
    return db.prepare(`
      SELECT c.id AS customer_id, c.phone, c.name, l.id AS location_id, l.display_name,
        COUNT(v.id) AS visit_count,
        MIN(v.created_at) AS first_in,
        MAX(COALESCE(v.ended_at, v.created_at)) AS last_out,
        SUM(CASE WHEN v.ended_at IS NULL AND v.status='active' THEN 1 ELSE 0 END) AS active_count,
        (SELECT client_mac FROM visits v2 WHERE v2.customer_id=c.id AND v2.location_id=l.id ORDER BY v2.id DESC LIMIT 1) AS last_mac,
        (SELECT client_ip FROM visits v2 WHERE v2.customer_id=c.id AND v2.location_id=l.id ORDER BY v2.id DESC LIMIT 1) AS last_ip
      FROM visits v
      JOIN customers c ON c.id=v.customer_id
      JOIN locations l ON l.id=v.location_id
      ${where}
      GROUP BY c.id, l.id
      ORDER BY last_out DESC
      LIMIT ?
    `).all(...params);
  },

  getGuestDetail(customerId, locationId) {
    const customer = db.prepare("SELECT * FROM customers WHERE id=?").get(customerId);
    const location = db.prepare("SELECT id, display_name, gateway_name FROM locations WHERE id=?").get(locationId);
    if (!customer || !location) return null;
    const sessions = db.prepare(`
      SELECT v.id, v.created_at, v.ended_at, v.status, v.client_mac, v.client_ip,
        CASE WHEN v.ended_at IS NOT NULL
          THEN CAST((julianday(v.ended_at) - julianday(v.created_at)) * 24 * 60 AS INTEGER)
          ELSE NULL END AS duration_min
      FROM visits v
      WHERE v.customer_id=? AND v.location_id=?
      ORDER BY v.id DESC
    `).all(customerId, locationId);
    const answers = db.prepare(`
      SELECT sq.question_text, sq.question_type, sa.answer_text, sa.created_at
      FROM survey_answers sa
      JOIN survey_questions sq ON sq.id=sa.question_id
      WHERE sa.customer_id=? AND sa.location_id=?
      ORDER BY sa.id DESC
    `).all(customerId, locationId);
    const totalVisits = db.prepare(
      "SELECT COUNT(*) AS n FROM visits WHERE customer_id=? AND location_id=?"
    ).get(customerId, locationId).n;
    return { customer, location, sessions, answers, totalVisits };
  },

  listSurveyQuestions(locationId) {
    return db.prepare(
      "SELECT * FROM survey_questions WHERE location_id=? ORDER BY sort_order, id"
    ).all(locationId);
  },

  listActiveSurveyQuestions(locationId) {
    return db.prepare(
      "SELECT * FROM survey_questions WHERE location_id=? AND active=1 ORDER BY sort_order, id"
    ).all(locationId);
  },

  addSurveyQuestion(locationId, q) {
    const opts = Array.isArray(q.options) ? JSON.stringify(q.options) : (q.options || "[]");
    return db.prepare(`
      INSERT INTO survey_questions (location_id, question_text, question_type, options, required, sort_order, active)
      VALUES (?,?,?,?,?,?,1)
    `).run(locationId, q.question_text, q.question_type || "text", opts,
      q.required ? 1 : 0, q.sort_order || 0);
  },

  deleteSurveyQuestion(id) {
    db.prepare("DELETE FROM survey_answers WHERE question_id=?").run(id);
    db.prepare("DELETE FROM survey_questions WHERE id=?").run(id);
  },

  toggleSurveyQuestion(id) {
    db.prepare("UPDATE survey_questions SET active = 1 - active WHERE id=?").run(id);
  },

  setSurveyEnabled(locationId, enabled, title) {
    db.prepare("UPDATE locations SET survey_enabled=?, survey_title=COALESCE(?, survey_title) WHERE id=?")
      .run(enabled ? 1 : 0, title || null, locationId);
  },

  saveSurveyAnswers({ visitId, customerId, locationId, answers }) {
    const ins = db.prepare(`
      INSERT INTO survey_answers (visit_id, customer_id, location_id, question_id, answer_text)
      VALUES (?,?,?,?,?)
    `);
    for (const [qid, text] of Object.entries(answers || {})) {
      const t = String(text || "").trim().slice(0, 500);
      if (!t) continue;
      ins.run(visitId, customerId, locationId, Number(qid), t);
    }
  },

  stats() {
    return {
      totalCustomers: db.prepare("SELECT COUNT(*) AS n FROM customers").get().n,
      totalVisits:    db.prepare("SELECT COUNT(*) AS n FROM visits").get().n,
      today:          db.prepare("SELECT COUNT(*) AS n FROM visits WHERE date(created_at)=date('now','localtime')").get().n,
      byLocation: db.prepare(`
        SELECT l.id, l.display_name, l.gateway_name, l.template_id, l.accent_color,
               COUNT(v.id) AS visits, COUNT(DISTINCT v.customer_id) AS customers,
               SUM(CASE WHEN date(v.created_at)=date('now','localtime') THEN 1 ELSE 0 END) AS today
        FROM locations l LEFT JOIN visits v ON v.location_id=l.id
        GROUP BY l.id ORDER BY l.id
      `).all(),
    };
  },

  recentVisits(limit=50) {
    return db.prepare(`
      SELECT v.created_at, c.phone, c.name, l.display_name, v.client_mac
      FROM visits v JOIN customers c ON c.id=v.customer_id JOIN locations l ON l.id=v.location_id
      ORDER BY v.id DESC LIMIT ?`).all(limit);
  },

  recentZns(limit=30) {
    return db.prepare(`
      SELECT z.created_at, z.campaign, z.status, z.detail, c.phone, c.name
      FROM zns_log z JOIN customers c ON c.id=z.customer_id ORDER BY z.id DESC LIMIT ?`).all(limit);
  },

  exportCustomers() {
    return db.prepare(`
      SELECT c.phone, c.name, l.display_name AS quan_dau_tien, c.created_at, COUNT(v.id) AS so_lan_ghe
      FROM customers c LEFT JOIN locations l ON l.id=c.first_location_id
      LEFT JOIN visits v ON v.customer_id=c.id GROUP BY c.id ORDER BY c.id DESC`).all();
  },

  getSetting(key)        { const r=db.prepare("SELECT value FROM settings WHERE key=?").get(key); return r?r.value:null; },
  setSetting(key, value) { db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,value); },

  /* ── Toạ độ / bản đồ ─────────────────────────────────────── */
  updateLocationCoords(id, lat, lng, address) {
    db.prepare("UPDATE locations SET latitude=?, longitude=?, address=? WHERE id=?").run(lat, lng, address||"", id);
  },
  locationsWithCoords() {
    return db.prepare("SELECT * FROM locations WHERE latitude IS NOT NULL AND longitude IS NOT NULL").all();
  },

  /* ── Routers (điều khiển từ xa qua SSH) ─────────────────────── */
  findRouterByLocation(locationId) {
    return withDecryptedPassword(db.prepare("SELECT * FROM routers WHERE location_id=?").get(locationId));
  },
  findRouterById(id) {
    return withDecryptedPassword(db.prepare("SELECT * FROM routers WHERE id=?").get(id));
  },
  upsertRouter(locationId, { ssh_host, ssh_port, ssh_user, ssh_password, model }) {
    const ex = db.prepare("SELECT id, ssh_password FROM routers WHERE location_id=?").get(locationId);
    // Để trống password trên form = giữ password cũ (không ghi đè bằng chuỗi rỗng)
    const encPass = (ssh_password && ssh_password.length)
      ? secrets.encrypt(ssh_password)
      : (ex ? ex.ssh_password : "");
    if (ex) {
      db.prepare(`UPDATE routers SET ssh_host=?, ssh_port=?, ssh_user=?, ssh_password=?, model=? WHERE location_id=?`)
        .run(ssh_host, ssh_port||22, ssh_user||'root', encPass, model||'', locationId);
      return ex.id;
    }
    return db.prepare(`INSERT INTO routers (location_id, ssh_host, ssh_port, ssh_user, ssh_password, model)
      VALUES (?,?,?,?,?,?)`).run(locationId, ssh_host, ssh_port||22, ssh_user||'root', encPass, model||'').lastInsertRowid;
  },
  clearRouterPassword(locationId) {
    db.prepare("UPDATE routers SET ssh_password='' WHERE location_id=?").run(locationId);
  },
  updateRouterStatus(id, statusJson) {
    db.prepare("UPDATE routers SET last_status=?, last_seen=datetime('now','localtime') WHERE id=?").run(statusJson, id);
  },
  listRoutersWithLocation() {
    return db.prepare(`
      SELECT r.*, l.display_name, l.gateway_name FROM routers r
      JOIN locations l ON l.id=r.location_id ORDER BY l.id`).all().map(withDecryptedPassword);
  },

  /* ── Enrollment tự động (gói cài đặt) ────────────────────────── */
  findLocationByEnrollToken(token) {
    if (!token || token.length < 32) return null;
    return db.prepare("SELECT * FROM locations WHERE enroll_token = ?").get(token);
  },
  regenerateEnrollToken(locationId) {
    const token = newEnrollToken();
    db.prepare("UPDATE locations SET enroll_token = ? WHERE id = ?").run(token, locationId);
    return token;
  },
  // Đảm bảo có 1 router record + SSH keypair cho location này (tạo mới nếu chưa có)
  ensureRouterRecord(locationId, pubkey, privkey) {
    const ex = db.prepare("SELECT * FROM routers WHERE location_id=?").get(locationId);
    if (ex && ex.ssh_pubkey) return withDecryptedPassword(ex);
    if (ex) {
      db.prepare("UPDATE routers SET ssh_pubkey=?, ssh_privkey=? WHERE id=?").run(pubkey, privkey, ex.id);
      return withDecryptedPassword(db.prepare("SELECT * FROM routers WHERE id=?").get(ex.id));
    }
    const id = db.prepare(`INSERT INTO routers (location_id, ssh_host, ssh_pubkey, ssh_privkey)
      VALUES (?, '', ?, ?)`).run(locationId, pubkey, privkey).lastInsertRowid;
    return withDecryptedPassword(db.prepare("SELECT * FROM routers WHERE id=?").get(id));
  },
  // Router tự báo IP Tailscale về sau khi cài xong
  // - Xoá SSH password (đã dùng key)
  // - Hết hạn link cài (ENROLL_ONE_SHOT=1 mặc định) để token lộ không tái sử dụng được
  markRouterEnrolled(locationId, { tsIp, model }) {
    db.prepare(`UPDATE routers SET ssh_host=?, ssh_user='root', ssh_password='', model=?,
      enrolled_at=datetime('now','localtime'), last_seen=datetime('now','localtime') WHERE location_id=?`)
      .run(tsIp, model||'', locationId);
    const oneShot = (process.env.ENROLL_ONE_SHOT || "1") !== "0";
    if (oneShot) this.regenerateEnrollToken(locationId);
  },

  /* ── Menu món ăn ─────────────────────────────────────────── */
  listMenuItems(locationId) {
    return db.prepare("SELECT * FROM menu_items WHERE location_id=? ORDER BY category, sort_order, id").all(locationId);
  },
  addMenuItem(locationId, item) {
    return db.prepare(`INSERT INTO menu_items (location_id, category, name, price, description, image_data, sort_order)
      VALUES (@location_id,@category,@name,@price,@description,@image_data,@sort_order)`)
      .run({ location_id: locationId, category: item.category||'Món chính', name: item.name,
        price: item.price||0, description: item.description||'', image_data: item.image_data||'',
        sort_order: item.sort_order||0 });
  },
  deleteMenuItem(id) { db.prepare("DELETE FROM menu_items WHERE id=?").run(id); },
  toggleMenuItem(id) { db.prepare("UPDATE menu_items SET available = 1 - available WHERE id=?").run(id); },
  setMenuEnabled(locationId, enabled) {
    db.prepare("UPDATE locations SET menu_enabled=? WHERE id=?").run(enabled?1:0, locationId);
  },

  /* ── Firmware releases / OTA ───────────────────────────────── */
  upsertFirmwareRelease({ version, portal_version, changelog, sha256, filename, size_bytes }) {
    db.prepare(`
      INSERT INTO firmware_releases (version, portal_version, changelog, sha256, filename, size_bytes)
      VALUES (@version, @portal_version, @changelog, @sha256, @filename, @size_bytes)
      ON CONFLICT(version) DO UPDATE SET
        portal_version=excluded.portal_version,
        changelog=excluded.changelog,
        sha256=excluded.sha256,
        filename=excluded.filename,
        size_bytes=excluded.size_bytes,
        published_at=datetime('now','localtime')
    `).run({ version, portal_version, changelog: changelog||'', sha256, filename, size_bytes: size_bytes||0 });
  },
  listFirmwareReleases(limit = 20) {
    return db.prepare("SELECT * FROM firmware_releases ORDER BY id DESC LIMIT ?").all(limit);
  },
  getFirmwareRelease(version) {
    return db.prepare("SELECT * FROM firmware_releases WHERE version=?").get(version);
  },
  setRouterFirmwareVersion(locationId, version) {
    db.prepare("UPDATE routers SET firmware_version=?, last_seen=datetime('now','localtime') WHERE location_id=?")
      .run(version, locationId);
  },
  ensureReportToken(locationId) {
    const r = db.prepare("SELECT report_token FROM routers WHERE location_id=?").get(locationId);
    if (r?.report_token) return r.report_token;
    const token = crypto.randomBytes(24).toString("hex");
    const ex = db.prepare("SELECT id FROM routers WHERE location_id=?").get(locationId);
    if (ex) {
      db.prepare("UPDATE routers SET report_token=? WHERE location_id=?").run(token, locationId);
    } else {
      db.prepare("INSERT INTO routers (location_id, ssh_host, report_token) VALUES (?, '', ?)").run(locationId, token);
    }
    return token;
  },
  findRouterByReportToken(token) {
    if (!token || token.length < 24) return null;
    return withDecryptedPassword(
      db.prepare(`
        SELECT r.*, l.gateway_name, l.display_name FROM routers r
        JOIN locations l ON l.id=r.location_id WHERE r.report_token=?
      `).get(token)
    );
  },
  logFirmwarePush(locationId, version, status, detail) {
    db.prepare("INSERT INTO firmware_push_log (location_id, version, status, detail) VALUES (?,?,?,?)")
      .run(locationId || null, version, status, detail || "");
  },
  recentFirmwarePushes(limit = 30) {
    return db.prepare(`
      SELECT p.*, l.display_name, l.gateway_name FROM firmware_push_log p
      LEFT JOIN locations l ON l.id=p.location_id
      ORDER BY p.id DESC LIMIT ?`).all(limit);
  },
};
