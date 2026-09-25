# shop-dashboard

Dashboard xem thống kê kinh doanh cho shopbot Telegram, chạy trên Cloudflare
(Worker + D1 + static assets). Dữ liệu đẩy một chiều từ VPS lên bằng
`sync_stats.py` chạy qua cron.

## 🌐 ĐÃ DEPLOY — địa chỉ đang chạy thật
**https://shop-dashboard.nguyenkhang170855.workers.dev**

| Thành phần | Trạng thái |
|---|---|
| Worker `shop-dashboard` | ✅ đang chạy (region APAC) |
| D1 `shop-dashboard` | ✅ 6 bảng, `database_id = 30c6b0a8-5df1-4275-b4e5-ddbc77bac74c` |
| Secrets `SYNC_TOKEN` / `ADMIN_PASSWORD` / `SESSION_SECRET` | ✅ đã nạp |
| VPS `167.179.85.50` — cron mỗi 15 phút | ✅ đang chạy, log xác nhận `HTTP 200` |
| R2 `shop-images` (private) | ✅ đã bật và gắn binding |

**Toàn bộ hệ thống đã hoàn tất.** Không còn việc nào bắt buộc.

⚠️ **CẢNH BÁO DEPLOY:** nếu `wrangler deploy` thất bại giữa đường, nó vẫn kịp ghi đè
Worker đang chạy bằng một bản rỗng chỉ có secret — dashboard sẽ trả 404 toàn bộ.
Đã xảy ra thật một lần. Sau mỗi lần deploy thất bại, **luôn kiểm tra lại** bằng
`node test/prod-verify.mjs`.

Kiểm tra lại bất cứ lúc nào:

```bash
node test/prod-verify.mjs      # 45 kiểm tra, CHẾ ĐỘ CHỈ ĐỌC (an toàn)
node test/r2-verify.mjs        # 20 kiểm tra tính năng ảnh
node test/login-flow.mjs       # 14 kiểm tra luồng đăng nhập (CSP, asset, dự phòng)
node test/ui-check.mjs         # 28 kiểm tra giao diện đã lên đúng chưa
node test/prod-snapshot.mjs    # in số liệu đang hiển thị
ssh root@167.179.85.50 "tail -5 /var/log/shop-sync.log"   # cron còn chạy không
```

---

> **Nguyên tắc bất di bất dịch:** bảng `stock` trong DB bán hàng có cột `content`
> chứa cặp `acc|pass` thật. Cột đó **không bao giờ** được đồng bộ, ghi log, trả
> về API hay hiển thị lên web. Dashboard chỉ nhận **số liệu tổng hợp**.
> Kiểm chứng: `node test/acceptance.mjs` (mục 1).

---

## 1. Kiến trúc

```
┌─────────────────────┐         ┌──────────────────────────┐
│  VPS (bot bán hàng) │         │  Cloudflare              │
│  SQLite shop.db     │         │                          │
│         │           │  HTTPS  │  ┌────────────────────┐  │
│         ▼           │────────▶│  │ Worker (src/)      │  │
│  sync_stats.py      │  POST   │  └─────────┬──────────┘  │
│  (chỉ SELECT số     │  token  │            ▼             │
│   liệu tổng hợp)    │         │  ┌────────────────────┐  │
└─────────────────────┘         │  │ D1 (số liệu)       │  │
                                │  └────────────────────┘  │
   Web KHÔNG bao giờ gọi        │  ┌────────────────────┐  │
   ngược vào VPS.               │  │ R2 (ảnh, PRIVATE)  │  │
                                │  └────────────────────┘  │
                                │  ┌────────────────────┐  │
                                │  │ Static site        │  │
                                │  └────────────────────┘  │
                                └──────────────────────────┘
```

Đường nào từ internet vào DB bán hàng: **không có**. VPS chỉ mở DB ở chế độ
`mode=ro` + `PRAGMA query_only = ON`.

---

## 2. Lược đồ dữ liệu trên D1

Xem [`schema.sql`](./schema.sql). Toàn bộ tiền là `INTEGER` (đồng) — **không
dùng `REAL`**. Thời gian đồng bộ lưu ISO8601 kèm offset `+07:00`.

Ghi chú quan trọng về thời gian: DB bán hàng lưu giờ Việt Nam nhưng **không ghi
kèm offset** (`'2026-09-22 17:08:26'`). Khi đẩy lên Cloudflare phải ghi rõ
`+07:00`, nếu không toàn bộ thống kê theo ngày sẽ lệch 7 tiếng.

---

## 3. Cấu trúc dự án

```
├─ wrangler.toml            # binding D1 + R2 + assets (run_worker_first = true)
├─ schema.sql               # lược đồ D1
├─ tsconfig.json
├─ package.json
├─ src/
│  ├─ index.ts              # router + header bảo mật
│  ├─ auth.ts               # PBKDF2, phiên HMAC, rate limit
│  ├─ api/
│  │  ├─ api-types.ts       # hợp đồng kiểu dữ liệu (freeze)
│  │  ├─ sync.ts            # POST /api/sync (token tĩnh)
│  │  ├─ stats.ts           # số liệu cho dashboard
│  │  ├─ logs.ts            # audit_log + lịch sử sync
│  │  ├─ images.ts          # R2 private
│  │  ├─ auth-routes.ts     # đăng nhập / đăng xuất
│  │  ├─ fbcheck.ts         # kiểm tra UID Facebook live/die
│  │  └─ bluecheck.ts       # theo dõi UID nền tích xanh qua watcher tại máy nhà
│  └─ lib/
│     ├─ validate.ts        # kiểm tra payload sync
│     ├─ uid-input.ts       # chuẩn hoá danh sách UID (dependency-free)
│     ├─ response.ts        # response + audit + so sánh hằng thời gian
│     └─ migrate.ts         # tạo bảng
├─ public/
│  ├─ index.html            # tổng quan: KPI, biểu đồ, bảng
│  ├─ login.html
│  ├─ logs.html             # nhật ký
│  ├─ images.html           # thư viện ảnh
│  ├─ uid.html              # check UID Facebook live/die
│  ├─ tickxanh.html         # theo dõi UID nền tích xanh
│  ├─ css/{app,scroll,preloader}.css
│  └─ js/{scroll,chart,dashboard,logs,images,uid,tickxanh,preloader}.js
├─ sync_stats.py            # chạy trên VPS (chỉ thư viện chuẩn)
├─ bluecheck_watcher.py     # watcher Playwright chạy tại máy nhà
├─ requirements.txt
└─ test/
   ├─ acceptance.mjs        # 106 kiểm tra tĩnh, không cần deploy
   ├─ asset-whitelist.mjs   # 19 kiểm tra: tài nguyên trang đăng nhập phải công khai
   ├─ fbcheck-test.mjs      # 54 kiểm tra tính năng check UID
   ├─ bluecheck-test.mjs    # kiểm tra API và dữ liệu theo dõi tích xanh
   ├─ watcher-test.py       # kiểm tra watcher không phụ thuộc dữ liệu thật
   ├─ live-e2e.mjs          # 61 kiểm tra đầu-cuối với Worker thật
   ├─ live-check.ps1        # kiểm tra 401/redirect nhanh
   ├─ seed-stale.mjs        # dựng snapshot cũ để thử cảnh báo
   ├─ cdp.mjs               # chạy Chrome thật qua DevTools Protocol (không cần puppeteer)
   ├─ ui-preview.mjs        # máy chủ tĩnh phục vụ public/ để xem giao diện
   ├─ ui-audit.mjs          # tràn ngang, vùng chạm, tương phản, chữ cắt, lỗi console
   ├─ ui-nav.mjs            # 75 kiểm tra điều hướng dùng chung (chuột + bàn phím thật)
   ├─ ui-a11y.mjs           # 10 phép kiểm khả năng tiếp cận + giảm chuyển động
   ├─ ui-states.mjs         # 78 kiểm tra trạng thái tải/rỗng/lỗi/khoá + hộp thoại xác nhận
   ├─ ui-chart.mjs          # 28 kiểm tra biểu đồ (tooltip, bàn phím, màu theo token)
   ├─ ui-shot-cdp.mjs       # chụp ảnh giao diện ở 4 mốc màn hình
   └─ ui-shots.mjs          # (cách cũ) chụp bằng chrome --screenshot
```

---

## 4. Triển khai — đúng thứ tự

> **Trạng thái hiện tại: bước 1–5 đã xong.** Các lệnh dưới đây để bạn làm lại
> từ đầu hoặc triển khai cho tài khoản khác. Bước 3 (R2) hiện đang bị bỏ qua có
> chủ ý — xem mục 11.

```bash
# 1. Cài phụ thuộc
npm install

# 2. Tạo D1 và nạp lược đồ
npx wrangler d1 create shop-dashboard
#   -> copy "database_id" vào wrangler.toml (mục [[d1_databases]])
npx wrangler d1 execute shop-dashboard --remote --file=./schema.sql

# 3. Tạo bucket R2 (PRIVATE — KHÔNG bật public access, KHÔNG gắn custom domain)
#    BẮT BUỘC bật R2 trong Cloudflare Dashboard TRƯỚC, nếu không lệnh này lỗi 10042.
npx wrangler r2 bucket create shop-images

# 4. Nạp secret (KHÔNG để trong wrangler.toml)
npx wrangler secret put SYNC_TOKEN       # token cho VPS, tạo bằng: openssl rand -base64 48
npx wrangler secret put ADMIN_PASSWORD   # mật khẩu đăng nhập dashboard
npx wrangler secret put SESSION_SECRET   # khoá ký cookie phiên, tạo bằng: openssl rand -base64 48

# 5. Deploy
npx wrangler deploy
```

> ⚠️ **CẢNH BÁO ĐÃ TỪNG GÂY SẬP DASHBOARD:** nếu `wrangler deploy` thất bại giữa
> đường (ví dụ khai báo binding R2 khi tài khoản chưa bật R2), nó vẫn kịp ghi đè
> Worker đang chạy bằng một bản rỗng chỉ có secret. Dashboard sẽ trả 404 toàn bộ.
> Đã xảy ra thật trong lúc deploy lần đầu. Vì vậy hiện `[[r2_buckets]]` đang được
> **comment lại** trong `wrangler.toml`. Sau mỗi lần deploy thất bại, **luôn
> kiểm tra lại** bằng `node test/prod-verify.mjs`.

Kiểm tra ngay sau khi deploy:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<worker>.workers.dev/api/sync  # phải 401
curl -s -o /dev/null -w "%{http_code}\n" https://<worker>.workers.dev/api/stats          # phải 401
curl -s -o /dev/null -w "%{http_code}\n" https://<worker>.workers.dev/index.html         # phải 302
```

### Nên dùng Cloudflare Access (khuyến nghị mạnh)

Đây là web một người dùng, nên cách bảo vệ tốt nhất là chặn ngay ở tầng hạ tầng,
trước khi request vào tới code:

1. Cloudflare Dashboard → **Zero Trust** → **Access** → **Applications** →
   **Add an application** → **Self-hosted**.
2. Application domain: `<worker>.workers.dev` (hoặc custom domain của bạn).
3. Thêm policy: **Allow** → **Emails** → email của bạn.
4. **Bắt buộc**: tạo một **Service Token** và thêm policy **Service Auth** cho
   đường dẫn `/api/sync`, rồi gắn header `CF-Access-Client-Id` /
   `CF-Access-Client-Secret` vào `sync_stats.py`. Nếu không, Access sẽ chặn luôn
   VPS và sync sẽ chết âm thầm.

Khi đã có Access, lớp đăng nhập bằng mật khẩu trong code vẫn giữ nguyên
(phòng thủ nhiều lớp) — không cần tắt.

---

## 5. Cài đặt trên VPS — ✅ ĐÃ CÀI XONG

> **Trạng thái: đã cài và đang chạy.** Cron tự chạy 15 phút/lần, đã xác nhận
> bằng log thật (`gửi thành công (HTTP 200)`).
>
> Thông tin thực tế đã dùng:
> - VPS: `167.179.85.50`, DB shopbot: `/opt/shopbot/data/shop.db`
> - Script: `/opt/shop-dashboard/sync_stats.py`
> - Biến môi trường: `/etc/shop-sync.env` (quyền `600`)
> - Log: `/var/log/shop-sync.log` (đã cấu hình logrotate)

Các lệnh dưới đây để bạn làm lại hoặc cài cho máy khác:

```bash
# 1. Copy script lên VPS
mkdir -p /opt/shop-dashboard
scp sync_stats.py requirements.txt user@vps:/opt/shop-dashboard/

# 2. Script chỉ dùng thư viện chuẩn Python, KHÔNG cần pip install
python3 --version    # cần >= 3.9

# 3. Tạo file biến môi trường (quyền 600, chỉ user chạy cron đọc được)
sudo tee /etc/shop-sync.env >/dev/null <<'EOF'
SHOP_DB_PATH=/opt/shopbot/data/shop.db
SYNC_URL=https://shop-dashboard.nguyenkhang170855.workers.dev/api/sync
SYNC_TOKEN=<token trong .deploy-secrets>
EOF
sudo chmod 600 /etc/shop-sync.env

# 4. Chạy thử KHÔNG gửi gì lên mạng trước
cd /opt/shop-dashboard
python3 sync_stats.py --db /opt/shopbot/data/shop.db --dry-run
#   -> xem JSON in ra, đối chiếu doanh thu bằng tay

# 5. Chạy thử gửi thật một lần
set -a; . /etc/shop-sync.env; set +a
python3 /opt/shop-dashboard/sync_stats.py -v
```

> ⚠️ **BÀI HỌC ĐÃ TỐN THỜI GIAN:** token phải lấy từ `.deploy-secrets` (token
> thật đã nạp lên Cloudflare). Dùng nhầm token từ file test cũ sẽ ra **HTTP 401**
> và cron chết âm thầm. Luôn chạy `python3 sync_stats.py -v` bằng tay trước khi
> tin vào cron.

### Cron mỗi 15 phút

```bash
crontab -e
```

Thêm dòng:

```cron
*/15 * * * * set -a; . /etc/shop-sync.env; set +a; /usr/bin/python3 /opt/shop-dashboard/sync_stats.py >> /var/log/shop-sync.log 2>&1
```

Chống phình log (bắt buộc, nếu không vài tháng là đầy đĩa):

```bash
sudo tee /etc/logrotate.d/shop-sync >/dev/null <<'EOF'
/var/log/shop-sync.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
EOF
```

Theo dõi:

```bash
tail -f /var/log/shop-sync.log
```

Mã thoát của script: `0` = OK (kể cả khi mạng lỗi, để cron không spam mail),
`2` = thiếu token, `3` = token sai, `4` = payload bị từ chối.

---

## 6. Kiểm thử

### Kiểm tra tĩnh (không cần deploy)

```bash
node test/acceptance.mjs        # 106 kiểm tra
node test/asset-whitelist.mjs   # 19 kiểm tra — chống lỗi 302 làm vỡ trang đăng nhập
```

`acceptance.mjs` bao gồm: không đọc cột `acc|pass`, không nối chuỗi SQL, magic
bytes ảnh, hiệu ứng cuộn + `prefers-reduced-motion`, định dạng tiền, rate limit,
và chạy thật `sync_stats.py` trên DB giả để xác nhận doanh thu chỉ cộng đơn `delivered`.

`asset-whitelist.mjs` đọc `PUBLIC_ASSET_PATHS` từ `src/index.ts` rồi đối chiếu với
mọi tài nguyên cục bộ mà 6 trang HTML tham chiếu. Đây là bài chống hồi quy cho
lỗi thật đã xảy ra: `/css/preloader.css`, `/js/preloader.js` và `/img/logo.svg`
từng thiếu trong danh sách công khai nên bị 302 đá về `/login.html`, khiến trang
đăng nhập hiện màn hình chờ trơ và logo vỡ.

### Kiểm tra giao diện bằng trình duyệt thật (không cần deploy)

Bốn bài đo chạy Chrome thật qua DevTools Protocol, ở 375/768/1024/1440px. Cần
một máy chủ tĩnh phục vụ `public/` ở cửa sổ khác:

```bash
npm run ui:preview     # cửa sổ 1 — phục vụ public/ ở http://127.0.0.1:8899
npm run ui:audit       # tràn ngang, vùng chạm <44px, tương phản, chữ bị cắt, lỗi console
npm run ui:nav         # điều hướng: menu mở/đóng thật, aria-expanded, Escape, desktop
npm run ui:a11y        # 10 phép kiểm khả năng tiếp cận + giảm chuyển động
npm run ui:states      # trạng thái tải / rỗng / lỗi / khoá + hộp thoại xác nhận
npm run ui:chart       # biểu đồ: tooltip vẽ thật, đọc được bằng bàn phím, màu theo token
npm run ui:shots       # chụp ảnh vào .ui-shots/
```

Các bài này **đo** chứ không phán đoán từ đọc mã, và chúng đã bắt được những lỗi
mà đọc mã không thấy: nút menu không có JS, thanh điều hướng vô hình ở desktop,
`aria-busy` sai trạng thái, và hai khối rỗng cùng hiện.

### Kiểm tra đầu-cối (cần Worker đang chạy)

```bash
# Tạo .dev.vars (UTF-8, KHÔNG BOM — xem mục 8.4)
printf 'SYNC_TOKEN=%s\nADMIN_PASSWORD=%s\nSESSION_SECRET=%s\n' \
  "$(openssl rand -base64 48)" "matkhau-test" "$(openssl rand -base64 48)" > .dev.vars

npx wrangler d1 execute shop-dashboard --local --file=./schema.sql
npx wrangler dev --local --port 8787        # cửa sổ 1
node test/live-e2e.mjs                      # cửa sổ 2  -> 61 kiểm tra
```

Thử cảnh báo dữ liệu cũ bằng tay:

```bash
node test/seed-stale.mjs 3    # chèn snapshot cũ 3 giờ
# -> mở dashboard, thanh trạng thái phải chuyển ĐỎ
```

---

## 7. Tiêu chí nghiệm thu — kết quả thực đo

| Tiêu chí | Cách kiểm | Kết quả |
|---|---|---|
| Không đọc `stock.content` | `grep -n content sync_stats.py` → 0 kết quả | ✅ |
| Sync không token → 401 | `live-e2e.mjs` mục A | ✅ |
| Cuộn mượt, card trượt lên, có stagger | `acceptance.mjs` mục 5 | ✅ |
| Bật "giảm chuyển động" → tắt hết hiệu ứng | CSS và JS đều kiểm `prefers-reduced-motion` | ✅ |
| Doanh thu chỉ cộng đơn `delivered` | `acceptance.mjs` mục 9 (DB giả) | ✅ |
| Đơn `method = ''` vào nhóm "khác" | `acceptance.mjs` + `live-e2e.mjs` mục C | ✅ |
| Thời gian lưu đúng `+07:00` | `live-e2e.mjs` mục C | ✅ |
| Chạy sync 2 lần không nhân đôi | `acceptance.mjs` mục 9 | ✅ |
| Upload `.exe` đổi tên `.jpg` bị từ chối | `live-e2e.mjs` mục D | ✅ |
| Ảnh không xem được khi chưa đăng nhập | `live-e2e.mjs` mục D | ✅ |
| Dashboard cảnh báo khi dữ liệu cũ > 1 giờ | `live-e2e.mjs` mục I | ✅ |
| Không có SQL nối bằng `+` / template string | `acceptance.mjs` mục 2 | ✅ |

---

## 8. Bốn lỗi thật đã tìm ra và sửa trong quá trình làm

Ghi lại để không ai vô tình làm hỏng lần nữa.

### 8.1. Toàn bộ HTML dashboard lộ cho người chưa đăng nhập

`wrangler.toml` ban đầu để mặc định. Cloudflare phục vụ **asset tĩnh trước** và
chỉ gọi Worker khi không tìm thấy file, nên `GET /` trả thẳng `index.html` mà
không hề chạy qua code kiểm tra đăng nhập (header trả về có `CF-Cache-Status:
HIT`, không có header bảo mật nào của Worker). Assets còn tự đổi
`/index.html` → `307` → `/`, khiến việc chặn đúng chuỗi `/index.html` trong
router trở nên vô nghĩa.

**Sửa:** `run_worker_first = true` trong `[assets]`, và router chuyển sang
nguyên tắc **deny-by-default** — chỉ asset nằm trong danh sách công khai mới
được phục vụ tự do.

### 8.2. Vòng lặp redirect vô tận cho người đã đăng nhập

Sau khi thêm `run_worker_first`, tầng asset trả `307 /index.html → /`, router
chuyển tiếp nguyên `307` đó cho trình duyệt, trình duyệt gọi lại `/`, router lại
phục vụ `index.html`, lại `307` → người dùng **đã** đăng nhập vẫn bị đá về
`/login.html`.

**Sửa:** `serveAsset()` tự đi theo redirect nội bộ (tối đa 3 bước) và chỉ trả
`200` cuối cùng cho trình duyệt.

### 8.3. Dashboard báo "dữ liệu cũ" sai

`readLatestSnapshot` sắp `ORDER BY id DESC`. Khi VPS gửi bù một mốc cũ (hoặc
chạy lại), bản ghi cũ có `id` lớn hơn sẽ thắng → dashboard báo động đỏ trong khi
VPS vừa đồng bộ xong. Cảnh báo kêu sai thì chủ shop sẽ học cách phớt lờ nó —
đúng thứ nguy hiểm nhất với một dashboard.

**Sửa:** `ORDER BY synced_at DESC, id DESC` (lấy mốc đồng bộ mới nhất; `id` chỉ
là tie-break). Đã có test ở `live-e2e.mjs` mục I cho cả hai chiều.

### 8.4. `.dev.vars` phải là UTF-8 không BOM

Trên Windows, `>` của PowerShell ghi ra **UTF-16 LE kèm BOM**, wrangler đọc
không được và mọi secret thành rỗng (`ADMIN_PASSWORD trống` → đăng nhập trả 500).
Dùng `printf` trong Git Bash, hoặc:
```powershell
[System.IO.File]::WriteAllLines("$PWD\.dev.vars", $lines, (New-Object System.Text.UTF8Encoding($false)))
```

### 8.5. Deploy thất bại vẫn ghi đè Worker đang chạy

Lần deploy thứ hai lỗi ở binding R2 (tài khoản chưa bật R2), nhưng nó **vẫn kịp**
thay Worker đang hoạt động bằng một bản rỗng chỉ có secret — dashboard trả 404
toàn bộ. Đây là hành vi của wrangler: xoá secret cũ rồi mới cài code, nên hỏng ở
giữa là để lại trạng thái nửa vời.

**Phòng tránh:** sau MỌI lần deploy thất bại, chạy ngay
`node test/prod-verify.mjs`. Và đừng khai báo binding cho dịch vụ chưa bật.

### 8.6. Token sync: đưa nhầm token từ file test

Token trong file test local khác token thật đã nạp lên Cloudflare. VPS nhận
**HTTP 401** và cron chết âm thầm — log chỉ hiện một dòng ERROR mà không ai đọc.

**Phòng tránh:** token cho VPS phải lấy từ `.deploy-secrets` (nguồn chân lý duy
nhất đã nạp lên Cloudflare). Luôn chạy tay `python3 sync_stats.py -v` trước khi
tin vào cron.

### 8.7. Script test ghi đè dữ liệu thật

Bản đầu của `test/prod-verify.mjs` gửi payload giả (1.234.000 ₫) vào `/api/sync`
thật. Vì `/api/stats` luôn lấy snapshot có `synced_at` mới nhất, payload giả
**che mất số liệu bán hàng thật** cho tới khi sync lại từ VPS.

**Sửa:** script mặc định **chỉ đọc**. Muốn test đường ghi phải đặt rõ
`ALLOW_WRITE_TESTS=1`, và script sẽ in cảnh báo nhắc chạy lại sync thật trên VPS.

> **Bài học chung:** không bao giờ để bộ test chạm vào đường ghi của production
> theo mặc định. Test phải an toàn khi chạy nhầm.

### 8.8. Form đăng nhập im lặng vì CSP chặn JS — LỖI NẶNG NHẤT

Worker gắn `Content-Security-Policy: script-src 'self'` cho **mọi** response.
Trang `login.html` lại nhúng JS xử lý form bằng thẻ `<script>` **inline**. Trình
duyệt chặn thẳng thẻ đó, nên:

- Điền mật khẩu, bấm "Đăng nhập" → **không có gì xảy ra**
- Không báo sai mật khẩu, không báo lỗi mạng, không có phản hồi nào
- Người dùng tưởng sai mật khẩu hoặc web hỏng, mà thực ra JS chưa từng chạy

Bộ test cũ không phát hiện vì chỉ kiểm tra **HTTP status** của `/api/login` — mà
endpoint đó vốn hoạt động tốt. Lỗi nằm ở phía trình duyệt, không phải phía API.

**Sửa hai phần:**
1. Tách JS ra `public/js/login.js`, HTML chỉ còn `<script src="/js/login.js" defer>`.
2. Thêm `/js/login.js` vào `PUBLIC_ASSET_PATHS` — nếu thiếu, file JS bị 302 đá về
   `/login.html` và form **vẫn** đơ (lỗi này cũng đã xảy ra thật).

**Thêm đường dự phòng:** form có `method="post" action="/api/login"`, và
`handleLogin` chấp nhận cả `application/x-www-form-urlencoded`. Nếu JS hỏng hoàn
toàn, form vẫn gửi được theo cách cổ điển.

**Phòng tránh:** xem `test/login-flow.mjs` — nó kiểm tra đúng những thứ đã hỏng:
không còn `<script>` inline, mọi `<script src>` tải được (không 302/404), và
đường dự phòng form-urlencoded chạy thật.

> **Bài học chung:** kiểm tra HTTP status là chưa đủ. Phải kiểm tra cả những gì
> **trình duyệt** cần để chạy trang — CSP, asset tải được, đường dự phòng.

---

## 8.9. Trang "Check UID" (Facebook live / die)

Trang `/uid.html`: dán danh sách UID, bấm **Kiểm tra**, kết quả tách thành 3 khung
— **Tài khoản Live**, **Tài khoản Die**, **Chưa xác định** — mỗi khung có nút Copy.

### Cách phân loại

Worker gọi endpoint công khai của Meta, **không cookie, không đăng nhập, không
proxy, không token**:

```
GET https://graph.facebook.com/v23.0/<uid>/picture?type=normal     (redirect: "manual")
  302                    -> LIVE
  400                    -> DIE
  429 / 5xx / lỗi mạng   -> UNKNOWN
```

Đã kiểm chứng **12/12** từ chính Worker Cloudflare (colo SIN) và ổn định qua 3 lần
chạy liên tiếp cho mỗi UID — xem `test/fbcheck-test.mjs`.

**Vì sao không dùng trang `profile.php`?** Vì nó **không phân biệt được** "đã xoá"
với "đổi sang riêng tư": cả hai đều trả 200 kèm `CometErrorRoot` và câu
"This content isn't available at the moment". Đối chiếu thực tế:

| UID | `profile.php` | `/picture` | Kết luận |
|---|---|---|---|
| `61579461239864` | 301 → `/people/…` | 302 | LIVE |
| `61579588325204` | 200 `CometErrorRoot` | 302 | LIVE (chỉ là riêng tư) |
| `999999999999999` | 200 `CometErrorRoot` | **400** | DIE |

Nếu dựa vào `profile.php`, UID thứ hai sẽ bị gán nhầm là "die".

### Vì sao có nhóm "Chưa xác định"

Lỗi mạng, timeout hay Meta trả 429 đều **không** phải bằng chứng tài khoản chết.
Gộp chúng vào `die` sẽ khiến bạn xoá nhầm tài khoản đang hoạt động — nên chúng
để riêng, có ghi rõ lý do từng UID.

### Cấu hình

```bash
# Bảng rate limit (đã có trong schema.sql)
npx wrangler d1 execute shop-dashboard --remote --file=./schema.sql
```

Bảng `fbcheck_attempts` cũng được Worker tự tạo nếu thiếu, nên tính năng vẫn chạy
được ngay cả khi bạn quên bước trên. Rate limit: **20 lần / 10 phút / IP**.

### Giới hạn thật của tính năng này

- **"Live" = UID còn tồn tại trên Facebook, KHÔNG phải "đăng nhập được".** Một tài
  khoản còn UID nhưng đã bị khoá/checkpoint/vô hiệu hoá vẫn hiện ở nhóm Live.
  Muốn biết trạng thái đăng nhập thì phải thử đăng nhập, việc đó cần cookie và
  mật khẩu — nằm ngoài phạm vi công cụ này và cũng là thứ bạn không nên gửi lên web.
- **Kết quả phụ thuộc IP của Worker.** Nếu Meta bắt đầu chặn IP của Cloudflare,
  mọi UID sẽ rơi vào `unknown` chứ không phải `die` — nhìn màu vàng là biết.
- **Không có cache.** Kiểm tra lại cùng một UID là gọi Meta lại. Rate limit 20
  lần/10 phút được đặt cố ý thấp vì lý do này.

### Kiểm chứng

```bash
node test/fbcheck-test.mjs   # 54 kiểm tra (tĩnh + gọi thật Meta nếu có mạng)
```

---

### 8.10. Theo dõi tích xanh

Trang `/tickxanh.html` theo dõi các UID đã được thêm vào hàng đợi. Người dùng thấy
các nhóm đang theo dõi, đã xác minh và kết quả khác; mọi mốc thời gian của tính
năng này đều là **epoch giây**, không phải chuỗi ISO8601.

#### Vì sao bắt buộc phải có trình duyệt thật

Dấu tích xanh **KHÔNG nằm trong HTML tải về**. Đã thử năm đường đọc dữ liệu:
`profile.php`, `mbasic`, `m.facebook`, embed plugin và Graph Picture. Cả năm
đều không có dấu hiệu đủ tin cậy để xác định tích xanh. Badge được render bởi
JavaScript, vì vậy chỉ tải HTML bằng HTTP là chưa đủ.

Worker Cloudflare **không có trình duyệt**. VPS có Chromium, nhưng IP datacenter
bị Meta chặn: đã kiểm UID có tích xanh và UID thường đều bị đẩy về trang đăng
nhập. Chỉ IP tại máy nhà mới đọc được. Đây là lý do kiến trúc phải là **PUSH**:
watcher chạy tại máy nhà chủ động lấy hàng đợi từ Worker, kiểm tra bằng trình
duyệt rồi đẩy kết quả về Cloudflare. Worker chỉ tiếp nhận kết quả đã kiểm chứng
trong môi trường đọc được; không giả định rằng HTTP fetch có thể thay thế
Chromium.

#### Cách đọc và bằng chứng đã đối chiếu

Watcher đọc trường `show_verified_badge_on_profile` trong dữ liệu React của trang
profile. Bảng dưới đây là các UID đã đối chiếu thực tế, không phải số liệu ước
lượng:

| UID | Kết quả trường React | Ghi chú đã kiểm |
|---|---:|---|
| `61593943230865` | `true` | Có tích xanh, tên **代军军** |
| `61579461239864` | `false` | Không có tích xanh |
| `4` | `true` | Mark Zuckerberg |

#### Bẫy `CometErrorRoot` phải chặn trước khi đọc

Đã gặp thật chuỗi `CometErrorRoot` trong bundle React của **mọi** trang
Facebook. Code từng kiểm tra nó trước khi đọc dấu tích xanh, khiến mọi UID bị
gán nhầm là không tồn tại. Watcher phải **đọc marker này trước**; nếu gặp
`CometErrorRoot` thì không được coi là kết quả xác minh hay tài khoản chết.
Bộ test có trường hợp chặn phản hồi chứa marker để bảo vệ quy tắc này.

#### Chạy watcher trên VPS bằng proxy tĩnh (đang dùng)

Máy nhà tắt thì watcher trên máy nhà cũng dừng. Giải pháp: chạy watcher trên
VPS (luôn bật) và cho nó đi qua **một proxy tĩnh**. IP của VPS là IP datacenter
nên bị Meta chặn; đặt proxy tĩnh phía trước là đủ.

**Vì sao là proxy TĈNH chứ không phải proxy xoay?** Đây là điều quan trọng nhất
cần hiểu trước khi mua:

- Dấu tích xanh chỉ được trả **ổn định khi phiên nhất quán**. Đổi IP giữa chừng
  làm nhiễu chính cái tín hiệu ta cần đọc.
- 12 proxy xoay nghĩa là cùng một UID bị hỏi từ 12 quốc gia trong vài phút —
  đúng mẫu hành vi bot mà Facebook săn.
- IP xoay dùng chung nhiều người thường **bị chặn nặng hơn** IP nhà sạch, không
  nhẹ hơn.

Đã kiểm chứng thật với proxy tĩnh: 3/3 UID cho kết quả đúng (có tích xanh /
chưa có / không tồn tại), không bị đá về trang đăng nhập, không hỏi CAPTCHA.

```bash
# 1) Cài Playwright + venv trên VPS (Chromium đã có sẵn ở /root/.cache/ms-playwright)
python3 -m venv /opt/bluecheck/venv
/opt/bluecheck/venv/bin/pip install playwright

# 2) Đặt watcher + cấu hình vào /opt/bluecheck
#    File cấu hình tên phải là bluecheck_config.json (watcher tự tìm theo tên này).
cp bluecheck_watcher.py /opt/bluecheck/watcher.py
cp bluecheck_config.example.json /opt/bluecheck/bluecheck_config.json
chmod 600 /opt/bluecheck/bluecheck_config.json

# 3) Điền token + proxy trong bluecheck_config.json, sau đó thử một vòng
cd /opt/bluecheck
PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright \
  ./venv/bin/python watcher.py --once

# 4) Chạy 24/7 bằng systemd
cp deploy/bluecheck-watcher.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now bluecheck-watcher
journalctl -u bluecheck-watcher -f        # xem log trực tiếp
```

**Về múi giờ trong cấu hình:** đặt `timezone_id` khớp với quốc gia của proxy (proxy
Romania thì `Europe/Bucharest`). Lệch múi giờ là một tín hiệu bất thường nhỏ,
nhưng cứ khớp cho chắc.

**Về mật khẩu proxy trên VPS:** file cấu hình để quyền `600` và thuộc `root`.
Ngoài ra có thể bỏ trống `proxy_password` trong file và nạp qua biến môi trường
`BLUECHECK_PROXY_PASSWORD` để mật khẩu không nằm trên đĩa.

#### Hạn chế vận hành thật

- Mỗi UID cần khoảng **8–15 giây**; tối đa **25 UID mỗi vòng** để không tạo
  tải bất thường lên Facebook.
- Khi Facebook siết IP, UID phải rơi vào **Chưa xác định** chứ không phải
  **Die**. Giữ UID ở nhóm chưa xác định để không mất dữ liệu và có thể thử lại.
- Nếu proxy hết hạn hoặc bị chặn, xem `journalctl -u bluecheck-watcher`: mọi UID
  sẽ chuyển sang *Chưa xác định*, còn lịch sử cũ vẫn nguyên.
- Kết quả phụ thuộc phiên đăng nhập, IP máy nhà và thay đổi giao diện của
  Facebook; vì vậy phải giữ cơ chế báo lỗi rõ ràng, không tự động xoá UID.
- Không đọc, ghi hoặc log cột `content` của bảng `stock`; tính năng này chỉ
  làm việc với UID và kết quả kiểm tra tích xanh.

---

## 9. Những gì CÒN THIẾU so với production

Nói thẳng — đây **không phải** bản hoàn hảo.

**Bảo mật**
- **Chưa có 2FA.** Chỉ một mật khẩu. Cloudflare Access (mục 4) bù được phần lớn,
  nhưng nếu không bật Access thì mật khẩu lộ là mất hết.
- **Rate limit lưu trong D1**, không phải ở tầng edge. Kẻ tấn công phân tán nhiều
  IP vẫn vượt được. Muốn chắc thì dùng Cloudflare Rate Limiting Rules.
- **`SESSION_SECRET` xoay vòng sẽ đá văng mọi phiên** (không thu hồi được từng
  phiên riêng lẻ). Phiên là stateless nên không thể "đăng xuất mọi thiết bị
  khác" — chỉ có đổi secret.
- **Ảnh không được quét nội dung.** Magic bytes chỉ xác nhận đó là ảnh, không
  đảm bảo ảnh không chứa payload. Ảnh được phục vụ với `CSP: default-src
  'none'; sandbox` và `nosniff` nên rủi ro thấp, nhưng chưa re-encode.
- **Chưa có giới hạn dung lượng R2 tổng.** Một mình bạn dùng thì khó tràn,
  nhưng không có trần cứng.

**Vận hành**
- **Chưa có backup tự động cho D1.** D1 có Time Travel 30 ngày, nhưng chưa cấu
  hình export định kỳ ra R2. Xoá nhầm thì phải khôi phục tay.
- **Chưa có cảnh báo khi sync chết.** Dashboard có hiện cảnh báo đỏ khi mở
  trang, nhưng **không ai chủ động báo cho bạn**. Nếu bạn không mở dashboard cả
  tuần thì sẽ không biết cron đã chết. Nên thêm một cron phụ trên VPS gọi
  `/api/health` và báo qua Telegram nếu lỗi, hoặc dùng Cloudflare Alerting trên
  tỉ lệ lỗi 5xx.
- **Chưa có healthcheck cho D1/R2.** `/api/health` chỉ trả `{ok:true}`, không
  kiểm tra DB có thật sự đọc được hay không.
- **Không có retention cho `sync_snapshots`.** Endpoint sync có dọn bản cũ hơn
  90 ngày, nhưng nếu payload phình to thì D1 sẽ tốn dung lượng dần.

**Tính năng**
- **`admin_log` của shopbot KHÔNG được đồng bộ.** Trang nhật ký chỉ hiện
  `audit_log` của Worker (sync, login, upload, delete). Muốn xem lịch sử thao
  tác admin của bot thì phải xem trực tiếp trên VPS.
- **Bộ lọc nhật ký theo ngày** dùng `date(created_at, '+7 hours')` để khớp ngày
  VN. Nếu sau này cần khoảng thời gian (`date_from`/`date_to`) thì phải sửa API.
- **Chưa có so sánh kỳ trước** (tuần này so với tuần trước), chưa có xuất CSV.
- **Trạng thái đơn mới lạ:** `validate.ts` chỉ nhận 4 giá trị
  `delivered|cancelled|expired|preorder` cho `by_status`. Nếu shopbot thêm trạng
  thái mới (ví dụ `refunded`), script sync sẽ gửi lên và **toàn bộ payload bị
  từ chối 400**. Cần nới enum này khi schema shopbot đổi.
- **Biểu đồ chỉ có một chuỗi** (doanh thu). Chưa vẽ được số đơn trên cùng trục.

**Hiệu năng / UI**
- Biểu đồ vẽ một lần, **không có tooltip khi rê chuột** và không zoom.
- `dashboard.js` tự refresh mỗi 5 phút; tab để quên cả ngày vẫn gọi API đều.
- Bảng sản phẩm cắt ở 100 dòng, chưa có phân trang.

**Chưa kiểm chứng được trong môi trường này**
- Chưa render thử trên trình duyệt thật. `scroll.js`, `chart.js` và các trang
  HTML mới chỉ được kiểm bằng `node --check`, kiểm tra tĩnh và DOM giả — chưa ai
  nhìn tận mắt hiệu ứng cuộn trên điện thoại thật.
- Chưa deploy lên Cloudflare thật. Toàn bộ kiểm tra đầu-cuối chạy trên
  `wrangler dev --local` (Miniflare). Hành vi của D1/R2 bản thật có thể khác đôi
  chút, nhất là phần Assets.

---

## 11. Bật R2 (việc DUY NHẤT còn lại bạn cần làm)

Trang **Ảnh** hiện chưa dùng được vì R2 chưa được bật cho tài khoản. Đây là việc
**chỉ bạn làm được** — Cloudflare bắt buộc chấp nhận điều khoản R2 và thêm phương
thức thanh toán qua Dashboard, không có API nào làm thay được (đã thử, API trả
`code: 10042`).

Các bước:

1. Mở https://dash.cloudflare.com/ → chọn tài khoản của bạn.
2. Menu trái → **R2** → **Enable R2** / **Purchase R2**.
3. Chấp nhận điều khoản, thêm phương thức thanh toán nếu được hỏi.
   (R2 có hạn mức miễn phí 10 GB lưu trữ + 1 triệu thao tác Class A/tháng — với
   ảnh của một shop nhỏ thì gần như chắc chắn không mất tiền.)
4. Quay lại máy, chạy:

```bash
npx wrangler r2 bucket create shop-images
```

5. Mở `wrangler.toml`, **bỏ dấu `#`** ở 3 dòng cuối khối R2:

```toml
[[r2_buckets]]
binding = "IMAGES"
bucket_name = "shop-images"
```

6. Deploy lại và kiểm tra:

```bash
npx wrangler deploy
node test/prod-verify.mjs
```

Sau bước này, trang **Ảnh** mới upload/xem được. Trước đó, `/api/images` trả **503**
kèm thông báo tiếng Việt hướng dẫn — cố ý như vậy để không sập trang, và mọi
phần khác của dashboard (thống kê, nhật ký) vẫn chạy bình thường vì không dùng R2.

---

## 12. Ghi chú kỹ thuật đáng nhớ

- **Tiền luôn là số nguyên đồng.** Không có `REAL`/float ở bất kỳ đâu, kể cả
  trong JS (`Math.round` trước khi hiển thị).
- **So sánh token sync bằng so sánh hằng thời gian** (`timingSafeEqualStr`),
  không dùng `===`.
- **Mọi truy vấn D1 đều là prepared statement** có `.bind()`. Không có chuỗi SQL
  nào nối bằng `+` hay template string mang dữ liệu người dùng. (Chỗ duy nhất
  dùng template string là nội suy một **hằng số SQL** khai báo trong chính file —
  nó không mang dữ liệu vào.)
- **`by_day` được điền đủ 30 ngày liên tục**, ngày không có đơn = 0, để biểu đồ
  không bị đứt đoạn.
- **Hiệu ứng cuộn chỉ animate `opacity` và `transform`** — không đụng
  `top/left/width/height/margin` (nguyên nhân số một gây giật).
- **Ảnh phục vụ qua Worker với `requireAuth` trước khi chạm R2.** Bucket không
  bao giờ public, không có presigned URL.
