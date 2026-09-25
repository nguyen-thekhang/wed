/**
 * =====================================================================
 * ĐÂY LÀ HỢP ĐỒNG API — đổi tên field ở đây là phá vỡ dashboard.
 * =====================================================================
 *
 * QUY TẮC BẤT DI BẤT DỊCH:
 *   KHÔNG có kiểu nào trong file này được phép chứa nội dung stock (acc|pass).
 *   Không thêm field kiểu `content`, `account`, `password`, `acc`, `pass`.
 *   Tồn kho chỉ là CON SỐ (`available`) đếm bằng COUNT(*) ở phía VPS.
 *
 * QUY TẮC TIỀN:
 *   Mọi field tiền (`revenue`, `wallet_balance_sum`, ...) là số NGUYÊN đồng VN.
 *   Không dùng float, không dùng REAL trong SQL — làm tròn sai một đồng là sai sổ sách.
 *
 * QUY TẮC THỜI GIAN:
 *   - `synced_at`: ISO8601 CÓ offset, ví dụ "2026-09-22T17:30:00+07:00" (do VPS gửi lên).
 *   - `received_at`: giờ UTC do D1 sinh bằng datetime('now') — KHÔNG có offset.
 *   - `date`: 'YYYY-MM-DD' theo giờ VN (UTC+7).
 *
 * Các module khác (`stats.ts`, `logs.ts`, `images.ts`, router, front-end) import
 * kiểu từ ĐÚNG file này. Muốn thêm field thì thêm ở đây, đừng khai báo lại nơi khác.
 */

import type { Totals, ByDay, ByProduct, ByMethod, ByStatus, StockRow } from "../lib/validate";

// ---------------------------------------------------------------------------
// Thời gian / đồng bộ
// ---------------------------------------------------------------------------

/** Một mốc sync đã lưu trong `sync_snapshots` (rút gọn, không kèm payload). */
export interface SyncMeta {
  /** ISO8601 kèm offset +07:00, do VPS gửi lên. */
  synced_at: string;
  /** Giờ UTC (datetime('now')) lúc Worker nhận được. */
  received_at: string;
}

/** Hàng đầy đủ của `sync_snapshots`, chỉ dùng nội bộ server. */
export interface SyncMetaRow {
  synced_at: string;
  received_at: string;
  /** JSON đã validate — CHỈ chứa số liệu tổng hợp, không bao giờ chứa acc|pass. */
  payload_json: string;
}

// ---------------------------------------------------------------------------
// Nhật ký kiểm toán
// ---------------------------------------------------------------------------

/** Một dòng `audit_log`. `detail` KHÔNG bao giờ chứa acc|pass. */
export interface AdminLogRow {
  id: number;
  /** sync | login | login_failed | logout | upload | delete | unlock ... */
  action: string;
  detail: string | null;
  ip: string | null;
  /** UTC, datetime('now'). */
  created_at: string;
}

// ---------------------------------------------------------------------------
// GET /api/stats — hợp đồng chính của dashboard
// ---------------------------------------------------------------------------

/** Toàn bộ dữ liệu trang tổng quan. `GET /api/stats` trả về đúng kiểu này. */
export interface StatsResponse {
  /** ISO +07:00 của lần sync gần nhất; null nếu chưa từng sync. */
  synced_at: string | null;
  /** UTC của lần nhận gần nhất; null nếu chưa từng sync. */
  received_at: string | null;
  /** true nếu quá 1 giờ chưa có sync mới. */
  stale: boolean;
  /** Số giây kể từ lần sync gần nhất; null nếu chưa từng sync. */
  stale_seconds: number | null;
  /** Số 0 nếu chưa có dữ liệu (không bao giờ null/undefined). */
  totals: Totals;
  /** ĐÃ điền đủ 30 ngày gần nhất theo giờ VN, ngày thiếu = 0. */
  by_day: ByDay[];
  by_product: ByProduct[];
  /** bank / wallet / khác. */
  by_method: ByMethod[];
  by_status: ByStatus[];
  stock: StockRow[];
  /** Lịch sử các lần sync gần nhất (chỉ mốc thời gian). */
  last_syncs: SyncMeta[];
}

// ---------------------------------------------------------------------------
// GET /api/logs, GET /api/logs/syncs
// ---------------------------------------------------------------------------

export interface LogsResponse {
  admin_log: AdminLogRow[];
  syncs: SyncMeta[];
}

// ---------------------------------------------------------------------------
// Ảnh (R2 private, truy cập qua Worker có kiểm tra đăng nhập)
// ---------------------------------------------------------------------------

export interface ImageRow {
  id: number;
  /** Khoá trên R2, dạng `img_<uuid>.<ext>`. */
  r2_key: string;
  note: string | null;
  mime: string;
  size_bytes: number;
  sha256: string;
  /** UTC, datetime('now'). */
  created_at: string;
  /** Đường dẫn tải ảnh qua Worker: `/api/images/<r2_key>`. */
  url: string;
}

// ---------------------------------------------------------------------------
// Kiểm tra UID Facebook (LIVE / DIE)
//
// QUY TẮC: ở đây chỉ có dãy số UID công khai do CHÍNH người dùng dán vào.
// KHÔNG có field nào chứa acc|pass, và không đọc gì từ bảng `stock`.
// ---------------------------------------------------------------------------

/**
 * Phán quyết cho một UID.
 *
 * - `live`    : Meta xác nhận object tồn tại (HTTP 302 sang link ảnh).
 * - `die`     : Meta nói object không tồn tại (HTTP 400).
 * - `unknown` : không kết luận được (lỗi mạng, timeout, Meta giới hạn tần suất).
 *
 * `unknown` tồn tại là CỐ Ý: coi lỗi mạng thành `die` sẽ khiến người dùng xoá
 * nhầm tài khoản đang hoạt động. Xem src/api/fbcheck.ts để biết chi tiết.
 */
export type FbUidVerdict = "live" | "die" | "unknown";

/** Một UID còn sống. */
export interface FbLiveRow {
  uid: string;
  /** true nếu tài khoản có ảnh đại diện công khai; false nếu dùng ảnh mặc định. */
  has_photo: boolean;
}

/** Một UID không còn tồn tại. */
export interface FbDieRow {
  uid: string;
}

/** Một UID không kết luận được, kèm lý do để người dùng biết cần làm gì. */
export interface FbUnknownRow {
  uid: string;
  reason: string;
}

/** 200 của POST /api/fbcheck. */
export interface FbCheckResponse {
  ok: true;
  /** Số UID đã kiểm tra (đã bỏ trùng). */
  total: number;
  live: FbLiveRow[];
  die: FbDieRow[];
  unknown: FbUnknownRow[];
  summary: {
    live: number;
    die: number;
    unknown: number;
    /** Số dòng người dùng dán mà không ra được UID. */
    invalid_lines: number;
  };
}

// ---------------------------------------------------------------------------
// Theo dõi tích xanh (blue check) cho profile Facebook công khai
//
// QUY TẮC: chỉ có UID (số) + tên công khai + mốc thời gian. KHÔNG có field
// nào chứa acc|pass, cookie hay mật khẩu. Không đọc gì từ bảng `stock`.
// ---------------------------------------------------------------------------

/**
 * Trạng thái theo dõi:
 *   - `watching`  : đang chờ, chưa thấy tick xanh.
 *   - `verified`  : ĐÃ LÊN TÍCH XANH — trạng thái cuối, không check lại nữa.
 *   - `not_found` : UID không còn tồn tại trên Facebook.
 *   - `unknown`   : lần check lỗi / bị chặn, sẽ thử lại.
 */
export type BluecheckStatus = "watching" | "verified" | "not_found" | "unknown";

/** Một mục đang theo dõi. */
export interface BluecheckWatch {
  uid: string;
  name: string | null;
  status: BluecheckStatus;
  /** epoch giây — lúc bắt đầu theo dõi. */
  started_at: number;
  last_checked_at: number | null;
  verified_at: number | null;
  checks_count: number;
  last_error: string | null;
  /** Số phút đã theo dõi, tính sẵn để client không phải tự tính lại. */
  watch_minutes: number;
}

/** Một thông báo trong hộp thư. */
export interface BluecheckNotification {
  id: number;
  uid: string;
  name: string | null;
  title: string;
  body: string;
  watch_minutes: number;
  read: boolean;
  /** epoch giây. */
  created_at: number;
}

/** 200 của GET /api/tickxanh. */
export interface BluecheckListResponse {
  ok: true;
  /** Bảng "Đang theo dõi" — chưa có tick xanh. */
  watching: BluecheckWatch[];
  /** Bảng "Đã lên tích xanh". */
  verified: BluecheckWatch[];
  /** Các trạng thái khác (không tồn tại / lỗi) để không bị mất khỏi UI. */
  other: BluecheckWatch[];
  notifications: BluecheckNotification[];
  unread: number;
  summary: { watching: number; verified: number; total: number };
  server_time: number;
}

/** 200 của POST /api/tickxanh. */
export interface BluecheckWatchCreated {
  uid: string;
  name: string | null;
  status: BluecheckStatus;
}

/** Một mục watcher lấy được từ hàng đợi. */
export interface BluecheckQueueItem {
  uid: string;
  name: string | null;
  started_at: number;
}

/** 200 của GET /api/tickxanh/queue (Bearer token). */
export interface BluecheckQueueResponse {
  ok: true;
  items: BluecheckQueueItem[];
  /** Nhịp check mà watcher nên tuân theo (giây). */
  check_interval_seconds: number;
  server_time: number;
}

/** Body mà watcher gửi lên. */
export interface BluecheckReportBody {
  results: Array<{
    uid: string;
    status: BluecheckStatus;
    name?: string | null;
    error?: string | null;
  }>;
}

/** 200 của POST /api/tickxanh/report (Bearer token). */
export interface BluecheckReportResponse {
  ok: true;
  /** Số kết quả đã cập nhật. */
  applied: number;
  /** Số thông báo mới sinh ra. */
  celebrated: number;
  server_time: number;
}

// ---------------------------------------------------------------------------
// Response của các route ghi / route phụ
// ---------------------------------------------------------------------------

/** 200 của POST /api/sync. */
export interface SyncOkResponse {
  ok: true;
  synced_at: string;
  received_at: string;
}

/** 200 của GET /api/stats/daily. */
export interface DailyResponse {
  days: ByDay[];
}

/** 200 của GET /api/stats/products. */
export interface ProductsResponse {
  products: ByProduct[];
}

/** 200 của GET /api/images. */
export interface ImagesResponse {
  images: ImageRow[];
}

/** 201 của POST /api/images. */
export interface ImageUploadResponse {
  ok: true;
  image: ImageRow;
}

/** 200 của POST /api/admin/unlock-login. */
export interface UnlockResponse {
  ok: true;
  /** Số bản ghi login_attempts đã xoá. */
  cleared: number;
}

// ---------------------------------------------------------------------------
// Re-export kiểu từ lib/validate để module khác chỉ cần import từ api-types.
// ---------------------------------------------------------------------------

export type { Totals, ByDay, ByProduct, ByMethod, ByStatus, StockRow };
