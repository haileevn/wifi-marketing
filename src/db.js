const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "wifi.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

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
];
for (const [col, def] of newCols) {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE locations ADD COLUMN ${col} ${def}`);
  }
}

module.exports = {
  db,

  findLocationByGateway(gw) {
    return db.prepare("SELECT * FROM locations WHERE gateway_name = ?").get(gw);
  },

  findLocationById(id) {
    return db.prepare("SELECT * FROM locations WHERE id = ?").get(id);
  },

  listLocations() {
    return db.prepare("SELECT * FROM locations ORDER BY id").all();
  },

  addLocation({ gateway_name, display_name, faskey, promo_text, zalo_link, accent_color }) {
    return db.prepare(`
      INSERT INTO locations (gateway_name, display_name, faskey, promo_text, zalo_link, accent_color)
      VALUES (@gateway_name, @display_name, @faskey,
              COALESCE(@promo_text,'Kết nối WiFi miễn phí - nhận ưu đãi thành viên!'),
              COALESCE(@zalo_link,''), COALESCE(@accent_color,'#B4452C'))
    `).run({ gateway_name, display_name, faskey, promo_text, zalo_link, accent_color });
  },

  updateLocationDesign(id, d) {
    db.prepare(`UPDATE locations SET
      display_name=@display_name, promo_text=@promo_text, zalo_link=@zalo_link,
      accent_color=@accent_color, logo_data=@logo_data, bg_color=@bg_color,
      card_color=@card_color, text_color=@text_color, headline=@headline,
      btn_text=@btn_text, show_name=@show_name, require_name=@require_name,
      custom_css=@custom_css, template_id=@template_id
    WHERE id=@id`).run({ id, ...d });
  },

  upsertCustomer(phone, name, locationId) {
    const ex = db.prepare("SELECT * FROM customers WHERE phone = ?").get(phone);
    if (ex) {
      if (name && !ex.name) db.prepare("UPDATE customers SET name=? WHERE id=?").run(name, ex.id);
      return ex.id;
    }
    return db.prepare("INSERT INTO customers (phone,name,first_location_id) VALUES (?,?,?)").run(phone, name||"", locationId).lastInsertRowid;
  },

  logVisit(customerId, locationId, mac, ip) {
    db.prepare("INSERT INTO visits (customer_id,location_id,client_mac,client_ip) VALUES (?,?,?,?)").run(customerId, locationId, mac||"", ip||"");
    return db.prepare("SELECT COUNT(*) AS n FROM visits WHERE customer_id=?").get(customerId).n;
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
};
