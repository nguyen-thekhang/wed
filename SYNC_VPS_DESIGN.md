# =====================================================================
# Sync thống kê từ VPS lên Cloudflare Worker.
#
# Script này CHỈ ĐỌC DB bán hàng và CHỈ tính số liệu TỔNG HỢP.
# Đọc kỹ hợp đồng trong CONTRACT.md trước khi sửa.
# =====================================================================

## Nguyên tắc bất di bất dịch

> Bảng `stock` có cột `content` chứa `acc|pass` thật đang bán.
> Script **KHÔNG BAO GIỜ** được đọc cột đó.

- Không viết `SELECT content`.
- Không `SELECT *` trên `stock` (dễ vô tình kéo theo `content`).
- Chỉ dùng `COUNT(*)` và `GROUP BY` trên `stock`.
- Không bao giờ ghi nội dung stock vào log hay payload.

Cách tự kiểm tra:

```bash
grep -n "content" sync_stats.py    # phải KHÔNG có kết quả
```

## Chạy thử (không gửi gì lên mạng)

```bash
python3 sync_stats.py --dry-run
```

In JSON ra màn hình để bạn đối chiếu tay trước khi bật cron.

## Cài đặt trên VPS

```bash
cd /opt/shop-dashboard
python3 -m venv venv
./venv/bin/pip install -r requirements.txt   # chỉ cần thư viện chuẩn, file để trống
chmod 600 /etc/shop-sync.env
```

Tạo `/etc/shop-sync.env` (quyền 600, chủ sở hữu là user chạy cron):

```bash
SHOP_DB_PATH=/home/shopbot/shop.db
SYNC_URL=https://shop-dashboard.<subdomain>.workers.dev/api/sync
SYNC_TOKEN=<token y như wrangler secret put SYNC_TOKEN>
```

Chạy tay một lần để chắc chắn:

```bash
set -a; . /etc/shop-sync.env; set +a
./venv/bin/python sync_stats.py -v
```

## Cron: mỗi 15 phút

```cron
*/15 * * * * set -a; . /etc/shop-sync.env; set +a; /opt/shop-dashboard/venv/bin/python /opt/shop-dashboard/sync_stats.py >> /var/log/shop-sync.log 2>&1
```

Cài bằng `crontab -e`. Kiểm tra log:

```bash
tail -f /var/log/shop-sync.log
```

Nên thêm `logrotate` cho `/var/log/shop-sync.log`, nếu không log sẽ phình mãi.
