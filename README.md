# H2T WiFi Marketing — Hệ thống multi-tenant cho chuỗi quán

Khách vào quán → kết nối WiFi → popup portal → nhập SĐT → ra Internet.
Data đổ về 1 server trung tâm (Proxmox), quản lý mọi quán trong 1 dashboard.

## Kiến trúc

```
Quán 1: GL-MT3000 (OpenNDS) ─┐
Quán 2: GL-MT3000 (OpenNDS) ─┼──HTTPS──> Proxmox VM: Node.js portal (PM2)
Quán 3: GL-MT3000 (OpenNDS) ─┘             wifi.06.com.vn (Nginx/CloudPanel)
                                            └── SQLite: khách, visits, menu, routers
                 ▲
                 └── Tailscale mesh (tuỳ chọn): VPS SSH điều khiển router sau NAT
```

- Mỗi quán 1 router, nhận diện bằng `gatewayname` (vd: `comtam-q1`).
- Portal xác thực OpenNDS FAS level 1: `rhid = SHA256(hid + faskey)` rồi
  redirect về `http://<gateway>:<port>/opennds_auth/?tok=<rhid>`.

## Tính năng chính

| Khu vực | Đường dẫn | Mô tả |
|--------|-----------|--------|
| Portal WiFi | `/fas`, `/auth` | Form SĐT + auth OpenNDS |
| Preview | `/preview/:id` | Xem portal không cần router |
| Dashboard | `/admin` | Thống kê, danh sách quán, export CSV |
| Editor giao diện | `/admin/editor/:id` | Logo, màu, template, CSS |
| Menu món | `/menu/:id`, `/admin/menu/:id` | Menu công khai + CRUD admin |
| Bản đồ | `/admin/map` | Gắn toạ độ các quán |
| Router từ xa | `/admin/router/:id` | SSH / Tailscale enroll, đẩy OpenNDS, SSID, clients |
| Health | `/health` | Probe cho Nginx/monitoring |

## 1. Tạo VM/LXC trên Proxmox

LXC Ubuntu 22.04/24.04: 1 vCPU, 512MB–1GB RAM, 8GB disk.

```bash
apt update && apt install -y curl git build-essential python3 openssh-client
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
npm install -g pm2
```

## 2. Deploy portal

```bash
cd /opt && git clone https://github.com/haileevn/wifi-marketing.git wifi-marketing && cd wifi-marketing
npm install
cp .env.example .env && nano .env   # bắt buộc đổi ADMIN_PASS, DEFAULT_FASKEY, SECRETS_KEY

node scripts/add-location.js comtam-q1 "Cơm Tấm Ông Mập Q1"

pm2 start src/server.js --name wifi-portal
pm2 save && pm2 startup
```

Smoke test local:

```bash
cp .env.example .env
# chỉnh PORT/ADMIN_* nếu cần
npm install
npm run smoke
```

## 3. Trỏ domain + SSL

CloudPanel / Nginx: site `wifi.06.com.vn` → reverse proxy `http://<IP-VM>:20140`, Let's Encrypt.

Portal phải truy cập được từ Internet (router quán gọi ra), hoặc qua VPN nếu giữ nội bộ.

## 4. Cấu hình router mỗi quán

### Cách A — Gói cài tự động (khuyên dùng)

1. Thêm quán trên `/admin`.
2. Mở `/admin/router/:id` → copy lệnh `curl …/install/<token>.sh | sh`.
3. SSH vào router, dán lệnh. Script tự: OpenNDS + SSH key + Tailscale + báo IP về portal.
4. Sau enroll thành công (mặc định **one-shot**), token cũ hết hạn — tạo lại nếu cần cài lại.

Yêu cầu: `TAILSCALE_AUTHKEY` trong `.env` trên VPS.

### Cách B — Script thủ công

Sửa `GATEWAY_NAME`, `FAS_KEY`, `FAS_DOMAIN` trong `scripts/router-setup.sh`:

```bash
scp scripts/router-setup.sh root@192.168.8.1:/tmp/
ssh root@192.168.8.1 "sh /tmp/router-setup.sh"
```

`GATEWAY_NAME` / `FAS_KEY` phải khớp quán trên portal.

## 5. Kiểm tra

1. Điện thoại kết nối WiFi quán → popup portal.
2. Nhập SĐT → trang thành công → ra Internet.
3. `/admin` xem lượt kết nối; `/admin/export.csv` tải SĐT.
4. Router: `logread | grep opennds`.
5. Menu (nếu bật): `/menu/:id` sau khi thêm món ở `/admin/menu/:id`.

## Vận hành

- **Dashboard** `/admin` — Basic Auth theo `.env`.
- **Thêm quán** — form trên `/admin` hoặc `npm run add-location`.
- **Menu** — bật + CRUD theo quán; khách xem `/menu/:id`.
- **Bản đồ** — ghim lat/lng trên `/admin/map`.
- **Router** — đẩy OpenNDS, đổi SSID, xem/ngắt client qua SSH key (enroll) hoặc password.
- **Backup** — `data/wifi.db` (WAL); cron rsync mỗi đêm. Không commit DB lên git.

## Bảo mật & rotate / revoke

| Tài sản | Rủi ro | Cách xử lý |
|--------|--------|------------|
| `ADMIN_PASS` | Dashboard lộ | Đổi ngay khi deploy; Basic Auth + HTTPS bắt buộc |
| `SECRETS_KEY` | SSH password trong DB | ≥16 ký tự; dùng để AES-256-GCM; đổi key = không đọc được password cũ |
| `enroll_token` | Ai có link cài được router | Token 64 hex; rate-limit `/install` & `/api/enroll`; nút **Tạo lại / thu hồi** trên `/admin/router`; mặc định `ENROLL_ONE_SHOT=1` (revoke sau enroll) |
| `TAILSCALE_AUTHKEY` | Join mesh trái phép | Tag `tag:router`; ACL chỉ VPS → router; **không echo** authkey ra log lỗi; rotate trên Tailscale Admin nếu lộ |
| SSH password | Lộ qua HTML/DB | Form không render lại password; ưu tiên SSH key sau enroll; password cũ bị xoá khi enroll OK |
| Private key trong DB | DB dump = takeover router | Bảo vệ file `data/wifi.db`, quyền filesystem, backup mã hoá |

Checklist khi nghi ngờ lộ:

1. `/admin/router/:id` → **Tạo lại / thu hồi link**.
2. Tailscale Admin → revoke / rotate auth key + xoá node lạ.
3. Đổi `ADMIN_PASS` + `SECRETS_KEY` (password SSH cũ đã mã hoá bằng key cũ sẽ cần nhập lại).
4. Trên router: xoá key lạ trong `/etc/dropbear/authorized_keys`, `tailscale logout` nếu cần.

## Zalo ZNS

Để trống `ZALO_*` = dry-run (chỉ ghi `zns_log`). Milestone visit cấu hình bằng `ZNS_VISIT_MILESTONE`.

## Pháp lý

Portal có dòng đồng ý thu thập SĐT (NĐ 13/2023). Không chia sẻ data bên thứ ba; có kênh xoá số khi khách yêu cầu.
