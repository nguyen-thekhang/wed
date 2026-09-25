-- =====================================================================
-- Lược đồ D1 cho shop-dashboard
-- NGUYÊN TẮC BẤT DI BẤT DỊCH: KHÔNG có bảng/cột nào chứa tài khoản/mật khẩu.
-- Tuyệt đối không thêm cột kiểu stock.content vào đây.
-- Mọi số tiền là INTEGER (đồng), KHÔNG dùng REAL.
-- =====================================================================

-- Mỗi lần VPS sync thành công lưu 1 snapshot (đã validate).
CREATE TABLE IF NOT EXISTS sync_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at TEXT NOT NULL,              -- ISO8601 kèm +07:00
  payload_json TEXT NOT NULL,           -- toàn bộ JSON đã validate
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snap_time ON sync_snapshots(synced_at DESC);

-- Doanh thu / số đơn theo ngày (ngày theo giờ VN, 'YYYY-MM-DD').
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,                -- 'YYYY-MM-DD'
  revenue INTEGER NOT NULL DEFAULT 0,   -- số nguyên đồng
  orders INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Thống kê theo sản phẩm (chỉ tên + số lượng + tiền, KHÔNG có nội dung).
CREATE TABLE IF NOT EXISTS product_stats (
  product_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sold INTEGER NOT NULL DEFAULT 0,
  revenue INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Ảnh trong R2 private, truy cập qua Worker có kiểm tra đăng nhập.
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key TEXT NOT NULL UNIQUE,
  note TEXT,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nhật ký kiểm toán: sync, login, login_failed, upload, delete...
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,                 -- sync, login, upload, delete
  detail TEXT,                          -- KHÔNG bao giờ chứa acc|pass
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);

-- Đếm số lần đăng nhập sai theo IP để rate limit (5 lần / 15 phút / IP).
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL           -- epoch giây
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, created_at DESC);

-- Đếm số lần gọi /api/fbcheck theo IP để rate limit (20 lần / 10 phút / IP).
-- CHỈ chứa IP + mốc thời gian. KHÔNG lưu danh sách UID: audit_log chỉ ghi số
-- liệu tổng hợp (total/live/die/unknown), xem src/api/fbcheck.ts.
CREATE TABLE IF NOT EXISTS fbcheck_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL           -- epoch giây
);
CREATE INDEX IF NOT EXISTS idx_fbcheck_attempts_ip ON fbcheck_attempts(ip, created_at DESC);

-- ==========================================================================
-- THEO DÕI TÍCH XANH (blue check) cho profile Facebook công khai
-- ==========================================================================
-- NGUYÊN TẮC: bảng này CHỈ chứa UID (số) + tên hiển thị công khai + mốc thời
-- gian. KHÔNG có cột acc|pass, KHÔNG có cookie, KHÔNG có mật khẩu. Không liên
-- quan gì tới bảng `stock` của shop.
--
-- Ai ghi vào đây:
--   * `bluecheck_watches`  — người dùng thêm UID qua trang web; watcher trên máy
--                            chủ nhà cập nhật `status` mỗi lần check.
--   * `bluecheck_notifications` — Worker tự sinh MỘT lần cho mỗi lần chuyển
--                            sang "đã lên tick xanh", để hiện trong hộp thư.
CREATE TABLE IF NOT EXISTS bluecheck_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,             -- UID Facebook (chữ số)
  name TEXT,                            -- tên công khai, lấy từ <title> trang profile
  status TEXT NOT NULL DEFAULT 'watching',  -- watching | verified | not_found | unknown
  started_at INTEGER NOT NULL,          -- epoch giây — lúc bắt đầu theo dõi
  last_checked_at INTEGER,              -- epoch giây — lần check gần nhất
  verified_at INTEGER,                  -- epoch giây — lúc phát hiện có tick xanh
  checks_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,                      -- mô tả lỗi ngắn, KHÔNG chứa dữ liệu nhạy cảm
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bluecheck_status ON bluecheck_watches(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS bluecheck_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER,                     -- NULL nếu bản ghi watch đã bị xoá
  uid TEXT NOT NULL,
  name TEXT,
  title TEXT NOT NULL,                  -- 'CHÚC MỪNG! TÍCH XANH'
  body TEXT NOT NULL,                   -- nội dung đầy đủ để hiển thị
  watch_minutes INTEGER NOT NULL DEFAULT 0,  -- thời gian đã theo dõi (phút)
  read_at INTEGER,                      -- NULL = chưa đọc
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bluecheck_notif ON bluecheck_notifications(created_at DESC);
