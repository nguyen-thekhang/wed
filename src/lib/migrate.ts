/**
 * src/lib/migrate.ts — Tạo lược đồ D1 và các tiện ích kiểm tra / reset.
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH (CONTRACT.md mục 0):
 * KHÔNG có bảng hay cột nào ở đây chứa tài khoản/mật khẩu.
 * Tuyệt đối không thêm cột kiểu `stock.content` vào DDL này.
 * Mọi số tiền là INTEGER (đồng), KHÔNG dùng REAL.
 *
 * DDL dưới đây PHẢI khớp từng chữ với `schema.sql` ở gốc repo.
 */

/**
 * DDL của toàn bộ lược đồ, mirror y hệt `schema.sql`
 * (cùng cột, cùng default, cùng index, tất cả đều `IF NOT EXISTS`).
 *
 * Đây là hằng số tĩnh 100% — KHÔNG có bất kỳ giá trị nào do người dùng nhập
 * đi vào chuỗi này, nên không có nguy cơ SQL injection từ phía DDL.
 */
const SCHEMA_SQL = `-- =====================================================================
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
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, created_at DESC);`;

/** Danh sách bảng mà `runSelfTest()` kỳ vọng có trong D1. */
const EXPECTED_TABLES: readonly string[] = [
  "sync_snapshots",
  "daily_stats",
  "product_stats",
  "images",
  "audit_log",
  "login_attempts",
];

/**
 * Số ngày giữ lại nhật ký kiểm toán khi reset dữ liệu dev.
 * `resetNonSnapshotData()` chỉ xoá audit_log cũ hơn mốc này.
 */
const AUDIT_RETENTION_DAYS = 90;

/** Trả về DDL dưới dạng chuỗi (đã bao gồm mọi CREATE TABLE/INDEX IF NOT EXISTS). */
export function ensureSchemaSql(): string {
  return SCHEMA_SQL;
}

/**
 * Tách DDL thành từng câu lệnh riêng.
 *
 * Ở đây chỉ cần cắt theo dấu `;` — các câu lệnh trong DDL này KHÔNG chứa dấu
 * chấm phẩy bên trong chuỗi literal hay trigger, nên không cần parser đầy đủ.
 * Sau khi cắt, bỏ các mảnh rỗng và mảnh chỉ gồm chú thích.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  for (const chunk of sql.split(";")) {
    const stmt = chunk.trim();
    if (stmt === "") continue;
    out.push(stmt);
  }
  return out;
}

/**
 * Chạy DDL để tạo lược đồ nếu chưa có (idempotent nhờ `IF NOT EXISTS`).
 *
 * AN TOÀN: toàn bộ câu lệnh đến từ hằng số `SCHEMA_SQL` trong file này.
 * KHÔNG có bất kỳ dữ liệu nào do người dùng nhập đi vào các chuỗi SQL này,
 * nên không thể bị SQL injection. Tuyệt đối không sửa hàm này để nhận DDL
 * từ tham số bên ngoài.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  const statements = splitStatements(SCHEMA_SQL);
  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }
}

/**
 * Tự kiểm tra lược đồ: bảng nào đã có, bảng nào còn thiếu.
 *
 * Chỉ đọc `sqlite_master` (metadata), không đọc dữ liệu nghiệp vụ.
 */
export async function runSelfTest(
  db: D1Database,
): Promise<{ ok: boolean; tables: string[]; missing: string[] }> {
  const result = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();

  const rows = result && Array.isArray(result.results) ? result.results : [];

  const tables: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row && typeof row.name === "string" ? row.name : "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    tables.push(name);
  }
  tables.sort();

  const missing = EXPECTED_TABLES.filter((name) => !seen.has(name));

  return { ok: missing.length === 0, tables, missing };
}

/**
 * Xoá dữ liệu KHÔNG phải snapshot — CHỈ DÙNG CHO MÔI TRƯỜNG LOCAL/DEV.
 *
 * - `sync_snapshots` được GIỮ NGUYÊN (đó là dữ liệu nguồn của dashboard).
 * - Xoá sạch: daily_stats, product_stats, images, login_attempts.
 * - audit_log: chỉ xoá các bản ghi CŨ HƠN 90 ngày.
 *
 * KHÔNG BAO GIỜ gọi hàm này trên production.
 * Mọi câu lệnh đều là prepared statement, không nối chuỗi.
 */
export async function resetNonSnapshotData(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM daily_stats").run();
  await db.prepare("DELETE FROM product_stats").run();
  await db.prepare("DELETE FROM images").run();
  await db.prepare("DELETE FROM login_attempts").run();

  // Cắt tỉa audit_log cũ hơn 90 ngày (so với giờ UTC của SQLite).
  await db
    .prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)")
    .bind(`-${AUDIT_RETENTION_DAYS} days`)
    .run();
}
