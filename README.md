# H2T WiFi Marketing — Hệ thống multi-tenant cho chuỗi quán

Khách vào quán → kết nối WiFi → popup portal hiện ra → nhập SĐT → được ra Internet.
Data khách đổ về 1 server trung tâm trên Proxmox, quản lý mọi quán trong 1 dashboard.

## Kiến trúc

```
Quán 1: GL-MT3000 (OpenNDS) ─┐
Quán 2: GL-MT3000 (OpenNDS) ─┼──HTTPS──> Proxmox VM: Node.js portal (PM2)
Quán 3: GL-MT3000 (OpenNDS) ─┘             wifi.06.com.vn (Nginx/CloudPanel proxy)
                                            └── SQLite: khách hàng, lượt ghé
```

- Mỗi quán 1 router, nhận diện bằng `gatewayname` (vd: `comtam-q1`, `comtam-q7`).
- Portal xác thực OpenNDS FAS level 1: tính `rhid = SHA256(hid + faskey)` rồi
  redirect khách về `http://<gateway>:<port>/opennds_auth/?tok=<rhid>`.

## 1. Tạo VM/LXC trên Proxmox

LXC Ubuntu 22.04/24.04 là đủ nhẹ: 1 vCPU, 512MB-1GB RAM, 8GB disk.

```bash
apt update && apt install -y curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
npm install -g pm2
```

## 2. Deploy portal

```bash
cd /opt && git clone <repo> wifi-marketing && cd wifi-marketing
npm install
cp .env.example .env && nano .env   # đổi ADMIN_PASS và DEFAULT_FASKEY!

# Thêm quán đầu tiên
node scripts/add-location.js comtam-q1 "Cơm Tấm Ông Mập Q1"

pm2 start src/server.js --name wifi-portal
pm2 save && pm2 startup
```

## 3. Trỏ domain + SSL

Trên CloudPanel (hoặc Nginx thuần): tạo site `wifi.06.com.vn`
reverse proxy về `http://<IP-VM-proxmox>:20140`, bật Let's Encrypt.

> Portal PHẢI truy cập được từ Internet (router ở quán gọi ra), hoặc
> qua VPN/Tailscale nếu bạn muốn giữ nội bộ.

## 4. Cấu hình router mỗi quán

Sửa 3 biến đầu file `scripts/router-setup.sh` (GATEWAY_NAME, FAS_KEY, FAS_DOMAIN)
rồi copy lên router chạy:

```bash
scp scripts/router-setup.sh root@192.168.8.1:/tmp/
ssh root@192.168.8.1 "sh /tmp/router-setup.sh"
```

Lưu ý: `GATEWAY_NAME` và `FAS_KEY` phải trùng với quán đã khai trên portal
(qua `/admin` hoặc CLI), nếu lệch khách sẽ không mở được mạng.

## 5. Kiểm tra

1. Điện thoại kết nối WiFi quán → popup "Sign in to network" tự bật portal.
2. Nhập SĐT → thấy trang "Xong rồi, mời bạn dùng mạng" → ra Internet được.
3. Vào `https://wifi.06.com.vn/admin` xem lượt kết nối vừa ghi nhận.
4. Debug trên router: `logread | grep opennds`.

## Vận hành

- **Dashboard**: `/admin` (Basic Auth theo .env) — thống kê theo quán, 50 lượt gần nhất.
- **Export**: `/admin/export.csv` — tải toàn bộ SĐT khách để chạy Zalo ZNS/OA.
- **Thêm quán mới**: thêm trên `/admin` → mua thêm 1 router → chạy router-setup.sh với gatewayname mới. 5 phút/quán.
- **Backup**: `data/wifi.db` (SQLite WAL) — cron rsync về nơi khác mỗi đêm.

## Mở rộng về sau

- Bắn ZNS/tin Zalo OA tự động khi khách quay lại lần thứ N (đã có bảng visits đếm sẵn).
- Voucher sinh nhật: thêm cột birthday vào customers, cron quét mỗi sáng.
- Tích hợp POS hiện có: tra SĐT khách khi order để cộng điểm thành viên.

## Pháp lý

Portal đã có dòng đồng ý thu thập SĐT (Nghị định 13/2023 về bảo vệ dữ liệu cá nhân).
Không chia sẻ data cho bên thứ ba, và nên có kênh cho khách yêu cầu xóa số.
