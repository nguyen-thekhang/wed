/**
 * =====================================================================
 * src/api/logs.ts — trang "Nhật ký" của dashboard.
 *   GET /api/logs?date=YYYY-MM-DD&limit=200 → LogsResponse
 *   GET /api/logs/syncs?limit=50            → { syncs: SyncMeta[] }
 * =====================================================================
 *
 * NHẬT KÝ NÀY LÀ NHẬT KÝ CỦA WORKER, KHÔNG PHẢI CỦA SHOP — đọc kỹ trước khi
 * thắc mắc "sao thiếu log":
 *   Bảng `admin_log` bên DB bán hàng (VPS) KHÔNG được sync lên Cloudflare.
 *   Chỉ các CON SỐ tổng hợp (doanh thu, số đơn, tồn kho) được đẩy lên theo
 *   CONTRACT §2; nội dung từng dòng nhật ký của shop không nằm trong payload.
 *   Vì vậy trang "Nhật ký" hiển thị bảng `audit_log` của chính Worker — bảng
 *   này ghi lại MỌI việc Worker làm: mỗi lần sync nhận được, đăng nhập thành
 *   công / thất bại, upload ảnh, xoá ảnh, mở khoá đăng nhập...
 *   Muốn xem log gốc của shop thì phải vào VPS, không phải ở đây.
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH (CONTRACT.md §0):
 *   Bảng `stock` bên DB bán hàng có cột `content` chứa cặp `acc|pass` thật.
 *   File này chỉ đọc `audit_log` (do code của chính ta ghi, chỉ chứa số liệu
 *   tổng hợp) và hai cột thời gian của `sync_snapshots`. Không có truy vấn nào
 *   chạm tới DB bán hàng, không có field nào có thể mang nội dung tài khoản.
 *   `sanitiseDetail()` bên dưới là lưới an toàn cuối cùng cho `detail`.
 *
 * QUY TẮC TRUY VẤN: MỌI câu SQL là prepared statement dùng `.bind(...)`
 *   (placeholder ?1, ?2...). KHÔNG nối chuỗi, KHÔNG nội suy `${}` — kể cả với
 *   `LIMIT`, vì SQLite/D1 cho phép bind tham số cho LIMIT. Nhờ vậy `date` và
 *   `limit` từ query param không bao giờ trở thành một phần của câu SQL.
 */

import { requireAuth } from "../auth";
import { logLine, noStore, serverError, unauthorized, type Env } from "../lib/response";
import { jsonError, jsonOk } from "../lib/response";
import type { AdminLogRow, LogsResponse, SyncMeta } from "./api-types";

// ---------------------------------------------------------------------------
// Hằng số
// ---------------------------------------------------------------------------

/** Số dòng nhật ký mặc định trả về. */
export const DEFAULT_LOG_LIMIT = 200;

/** Trần số dòng nhật ký một lần gọi — chặn response phình to. */
export const MAX_LOG_LIMIT = 500;

/** Số mốc sync mặc định trả về. */
export const DEFAULT_SYNC_LIMIT = 50;

/** Trần số mốc sync một lần gọi. */
export const MAX_SYNC_LIMIT = 200;

/** Độ dài tối đa của `detail` sau khi làm sạch (ngắn hơn trần 500 lúc ghi). */
export const MAX_DETAIL_LENGTH = 300;

/** Regex ngày hợp lệ, khớp CONTRACT §2 (`date` là 'YYYY-MM-DD' theo giờ VN). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Tiện ích nội bộ
// ---------------------------------------------------------------------------

/** Ép giá trị bất kỳ về chuỗi an toàn (không bao giờ ném lỗi). */
function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return String(value);
  } catch {
    return "";
  }
}

/** Số nguyên không âm; NaN / Infinity / số âm đều quy về 0. */
function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  return i > 0 ? i : 0;
}

/** Mô tả lỗi ngắn gọn để ghi log — KHÔNG bao giờ chứa nội dung dòng dữ liệu. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : "unknown";
}

/** Kẹp `limit` về khoảng [1, max]; giá trị rác → `fallback`. */
function clampLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === undefined) return fallback;
  const trimmed = asString(raw).trim();
  // Chỉ nhận chuỗi toàn chữ số: chặn "0x10", "1e3", "12abc", "-5", "3.9"...
  if (trimmed === "" || !/^[0-9]{1,6}$/.test(trimmed)) return fallback;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n > max ? max : n;
}

/**
 * Làm sạch `audit_log.detail` trước khi trả ra ngoài.
 *
 * `detail` do CHÍNH code của ta ghi và theo thiết kế chỉ chứa số liệu tổng hợp
 * (ví dụ "nhận snapshot: 30 ngày, 12 sản phẩm, doanh thu=..., đơn=..."). Dù vậy
 * vẫn cho đi qua đây vì hai lý do:
 *   1. Cắt còn tối đa 300 ký tự — một dòng log bất thường không thể làm phình
 *      response của cả trang nhật ký.
 *   2. Gỡ MỌI ký tự điều khiển (charCode < 0x20 và 0x7F, kể cả xuống dòng):
 *      ký tự điều khiển có thể dùng để giả mạo định dạng bảng hoặc chèn nội
 *      dung lạ vào giao diện.
 *
 * Đầu vào null / rỗng → trả `null` (không trả chuỗi rỗng) để client phân biệt
 * được "không có chi tiết" với "chi tiết rỗng".
 *
 * LƯU Ý: hàm này KHÔNG phải nơi phát hiện acc|pass — `writeAudit` (lib/response)
 * đã chặn cặp `acc|pass` ngay lúc ghi, và nội dung stock không bao giờ được
 * đưa vào audit. Đây chỉ là lớp phòng ngừa thứ hai.
 */
export function sanitiseDetail(s: string | null): string | null {
  if (s === null || s === undefined) return null;

  let cleaned = "";
  try {
    const input = asString(s);
    for (let i = 0; i < input.length && cleaned.length < MAX_DETAIL_LENGTH; i++) {
      const code = input.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) continue;
      cleaned += input[i];
    }
  } catch {
    return null;
  }

  return cleaned === "" ? null : cleaned;
}

/**
 * Cổng xác thực dùng chung cho hai route.
 *
 * Router (src/index.ts) cũng đã gọi `requireAuth`; kiểm tra lại lần nữa là CỐ Ý
 * — nhật ký chứa IP người dùng nên không được lộ nếu có ai đó quên middleware.
 */
async function guard(request: Request, env: Env): Promise<Response | null> {
  try {
    if (!(await requireAuth(request, env))) return unauthorized();
    return null;
  } catch (err) {
    logLine("requireAuth lỗi", errText(err));
    return unauthorized();
  }
}

// ---------------------------------------------------------------------------
// Đọc D1
// ---------------------------------------------------------------------------

/** Hàng thô của `audit_log`. `detail` sẽ được làm sạch trước khi trả ra. */
interface AuditRowRaw {
  id: number | string;
  action: string | null;
  detail: string | null;
  ip: string | null;
  created_at: string | null;
}

/** Hàng thô của `sync_snapshots` — CHỈ hai cột thời gian, không có payload. */
interface SyncRowRaw {
  synced_at: string | null;
  received_at: string | null;
}

/**
 * Đọc `audit_log` của WORKER, mới nhất trước.
 *
 * Lọc theo NGÀY VIỆT NAM bằng `date(created_at, '+7 hours') = ?1`:
 *   `created_at` do `datetime('now')` sinh ra là giờ UTC (không kèm offset),
 *   ví dụ một sự kiện lúc 00:30 ngày 22/09 giờ VN được lưu là
 *   "2026-09-21 17:30:00". Nếu lọc thẳng `date(created_at) = '2026-09-22'` thì
 *   dòng đó bị rơi nhầm sang ngày 21 và cả 7 tiếng đầu ngày của người dùng
 *   Việt Nam sẽ nằm sai trang. Cộng thêm 7 giờ NGAY TRONG SQL rồi mới cắt ngày
 *   để khớp đúng "ngày theo giờ VN" mà người dùng nhìn thấy trên lịch.
 *
 * `date = null` nghĩa là không lọc, lấy mới nhất trên mọi ngày.
 *
 * Bọc try/catch: bảng chưa kịp migrate thì trả mảng rỗng (trang hiện "chưa có
 * nhật ký") thay vì 500.
 */
export async function listAudit(
  db: D1Database,
  date: string | null,
  limit: number,
): Promise<AdminLogRow[]> {
  const cap = clampLimit(String(limit), DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT);

  try {
    const res =
      date === null
        ? await db
            .prepare(
              `SELECT id, action, detail, ip, created_at
                 FROM audit_log
                ORDER BY id DESC
                LIMIT ?1`,
            )
            .bind(cap)
            .all<AuditRowRaw>()
        : await db
            .prepare(
              `SELECT id, action, detail, ip, created_at
                 FROM audit_log
                WHERE date(created_at, '+7 hours') = ?1
                ORDER BY id DESC
                LIMIT ?2`,
            )
            .bind(date, cap)
            .all<AuditRowRaw>();

    const rows = Array.isArray(res.results) ? res.results : [];
    const out: AdminLogRow[] = [];
    for (const row of rows) {
      if (row === null || row === undefined) continue;
      out.push({
        id: toCount(row.id),
        action: asString(row.action).slice(0, 100),
        // Làm sạch trước khi ra khỏi tiến trình: cắt 300 ký tự, gỡ ký tự điều khiển.
        detail: sanitiseDetail(row.detail),
        ip: row.ip === null || row.ip === undefined ? null : asString(row.ip).slice(0, 64),
        created_at: asString(row.created_at),
      });
    }
    return out;
  } catch (err) {
    logLine("đọc audit_log thất bại (bảng chưa migrate?)", errText(err));
    return [];
  }
}

/**
 * Đọc các mốc sync gần nhất, mới nhất trước — CHỈ hai cột thời gian.
 *
 * QUY TẮC BẮT BUỘC: TUYỆT ĐỐI không SELECT `payload_json` ở đây. Payload vốn
 * chỉ chứa số liệu tổng hợp (không có acc|pass), nhưng nguyên tắc là nguyên
 * tắc: response chỉ mang đúng thứ màn hình cần, không mang theo cả ảnh chụp
 * JSON để rồi có ngày ai đó vô tình render thẳng nó ra trang.
 *
 * `LIMIT ?1` là bind tham số hợp lệ trong SQLite/D1, không nối chuỗi SQL.
 */
export async function listSyncs(db: D1Database, limit: number): Promise<SyncMeta[]> {
  const cap = clampLimit(String(limit), DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT);

  try {
    const res = await db
      .prepare(
        `SELECT synced_at, received_at
           FROM sync_snapshots
          ORDER BY synced_at DESC
          LIMIT ?1`,
      )
      .bind(cap)
      .all<SyncRowRaw>();

    const rows = Array.isArray(res.results) ? res.results : [];
    const out: SyncMeta[] = [];
    for (const row of rows) {
      if (row === null || row === undefined) continue;
      out.push({
        synced_at: asString(row.synced_at),
        received_at: asString(row.received_at),
      });
    }
    return out;
  } catch (err) {
    // Bảng chưa được tạo (migrate chưa chạy) → coi như chưa có lần sync nào.
    logLine("đọc sync_snapshots thất bại (bảng chưa migrate?)", errText(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Handler HTTP
// ---------------------------------------------------------------------------

/**
 * `GET /api/logs?date=YYYY-MM-DD&limit=200` → `LogsResponse`.
 *
 * `date` không bắt buộc. Nếu CÓ mà không đúng `^\d{4}-\d{2}-\d{2}$` → 400
 * `bad_request`. Ở đây CỐ Ý không "kẹp" giá trị sai về null: người dùng gõ
 * nhầm ngày thì im lặng trả về toàn bộ nhật ký sẽ khiến họ tưởng bộ lọc hỏng.
 * Chuỗi đã qua regex nên chỉ gồm chữ số và dấu gạch — và dù sao nó vẫn được
 * bind như tham số, không bao giờ nối vào câu SQL.
 *
 * `limit` mặc định 200, kẹp 1..500.
 */
export async function handleLogs(request: Request, env: Env): Promise<Response> {
  try {
    const denied = await guard(request, env);
    if (denied !== null) return denied;

    let dateParam: string | null = null;
    let limitParam: string | null = null;
    try {
      const params = new URL(request.url).searchParams;
      const rawDate = params.get("date");
      dateParam = rawDate === null ? null : rawDate.trim();
      limitParam = params.get("limit");
    } catch {
      // URL dị dạng: coi như không lọc, dùng limit mặc định.
      dateParam = null;
      limitParam = null;
    }

    let date: string | null = null;
    if (dateParam !== null && dateParam !== "") {
      if (!DATE_RE.test(dateParam)) {
        return jsonError("bad_request", "Ngày không hợp lệ, cần dạng YYYY-MM-DD", 400);
      }
      date = dateParam;
    }

    const limit = clampLimit(limitParam, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT);

    const adminLog = await listAudit(env.DB, date, limit);
    const syncs = await listSyncs(env.DB, DEFAULT_SYNC_LIMIT);

    const body: LogsResponse = { admin_log: adminLog, syncs };
    return jsonOk(body, 200, noStore());
  } catch (err) {
    // Không bao giờ đưa chi tiết lỗi DB vào body; chỉ log mô tả ngắn.
    logLine("handleLogs thất bại", errText(err));
    return serverError();
  }
}

/**
 * `GET /api/logs/syncs?limit=50` → `{ syncs: SyncMeta[] }`.
 *
 * `limit` mặc định 50, kẹp 1..200. Giá trị rác → mặc định (không 400), vì đây
 * chỉ là tuỳ chọn hiển thị.
 */
export async function handleSyncLogs(request: Request, env: Env): Promise<Response> {
  try {
    const denied = await guard(request, env);
    if (denied !== null) return denied;

    let limitParam: string | null = null;
    try {
      limitParam = new URL(request.url).searchParams.get("limit");
    } catch {
      limitParam = null;
    }

    const limit = clampLimit(limitParam, DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT);
    const syncs = await listSyncs(env.DB, limit);

    return jsonOk({ syncs }, 200, noStore());
  } catch (err) {
    logLine("handleSyncLogs thất bại", errText(err));
    return serverError();
  }
}

// ---------------------------------------------------------------------------
// Ghi chú kiểm chứng
//
// * `grep -n "payload_json" src/api/logs.ts` chỉ được ra trong phần chú thích
//   giải thích vì sao KHÔNG select cột đó — không có câu SQL nào đọc nó.
// * `grep -n '\${' src/api/logs.ts` không được xuất hiện bên trong câu SQL.
// * Không có `content` / `account` / `password`: file này chỉ chạm audit_log và
//   hai cột thời gian của sync_snapshots.
// ---------------------------------------------------------------------------
