/**
 * =====================================================================
 * src/api/stats.ts — số liệu tổng quan cho dashboard.
 *   GET /api/stats            → StatsResponse (nguồn chân lý duy nhất)
 *   GET /api/stats/daily      → { days: ByDay[] }  (?days=30)
 *   GET /api/stats/products   → { products: ByProduct[] }
 * =====================================================================
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH (CONTRACT.md §0):
 *   Bảng `stock` bên DB bán hàng có cột `content` chứa cặp `acc|pass` thật.
 *   File này CHỈ đọc các con số tổng hợp đã được VPS đếm sẵn ở phía kia
 *   (doanh thu, số đơn, số lượng tồn). KHÔNG có truy vấn nào chạm tới DB bán
 *   hàng, càng không có truy vấn nào đọc nội dung tài khoản. Tồn kho ở đây chỉ
 *   là một CON SỐ (`available`) do `COUNT(*)` bên VPS sinh ra.
 *   Nếu bạn thấy mình sắp thêm một field kiểu `content` / `account` / `password`
 *   vào response → DỪNG LẠI và báo lỗi.
 *
 * QUY TẮC TIỀN: mọi số tiền là số NGUYÊN đồng VN (cột D1 là INTEGER). Không
 *   làm tròn, không đi qua float — sai một đồng là sai sổ sách.
 *
 * QUY TẮC TRUY VẤN: MỌI câu SQL trong file này là prepared statement dùng
 *   `.bind(...)` (placeholder ?1, ?2...). KHÔNG nối chuỗi, KHÔNG nội suy `${}`
 *   vào SQL — kể cả với `LIMIT`, vì SQLite/D1 cho phép bind tham số cho LIMIT.
 *   Nhờ vậy không tồn tại đường SQL injection từ query param.
 *
 * QUY TẮC NGÀY: DB bán hàng lưu thời gian theo giờ VN nhưng KHÔNG kèm offset,
 *   nên MỌI việc chia ngày ở đây đều theo UTC+7 và lấy "hôm nay" từ `vnToday()`
 *   (lib/validate). TUYỆT ĐỐI không dùng ngày UTC của Worker để đóng khung cửa
 *   sổ ngày: từ 00:00 đến 07:00 giờ VN, ngày UTC vẫn là hôm qua, dùng nó sẽ
 *   làm cả biểu đồ lệch một ngày và cắt mất ngày hôm nay.
 */

import { requireAuth } from "../auth";
import {
  jsonOk,
  logLine,
  noStore,
  serverError,
  unauthorized,
  type Env,
} from "../lib/response";
import {
  emptyTotals,
  parseSyncPayload,
  vnToday,
  type ByDay,
  type ByProduct,
  type ByMethod,
  type ByStatus,
  type StockRow,
  type SyncPayload,
  type Totals,
} from "../lib/validate";
import type {
  DailyResponse,
  ProductsResponse,
  StatsResponse,
  SyncMeta,
} from "./api-types";

// ---------------------------------------------------------------------------
// Hằng số
// ---------------------------------------------------------------------------

/**
 * Ngưỡng cảnh báo "dữ liệu cũ": quá 1 giờ (3600 giây) chưa có sync mới thì
 * dashboard hiện băng-rôn cảnh báo. VPS sync định kỳ 15 phút/lần, nên 1 giờ
 * là bốn nhịp liên tiếp thất bại — đủ chắc chắn để báo động mà không báo oan
 * khi chỉ trễ một nhịp mạng.
 */
export const STALE_AFTER_SECONDS = 3600;

/** Cửa sổ ngày mặc định của biểu đồ doanh thu (30 ngày gần nhất, gồm hôm nay). */
export const DAILY_WINDOW_DAYS = 30;

/** Cửa sổ ngày nhỏ nhất / lớn nhất mà `?days=` được phép yêu cầu. */
export const MIN_DAILY_DAYS = 1;
export const MAX_DAILY_DAYS = 90;

/** Số mốc sync gần nhất trả kèm StatsResponse. */
const LAST_SYNCS_LIMIT = 10;

/** Số ngày lịch sử tối đa đọc từ `daily_stats` cho mỗi lần tính cửa sổ. */
const MAX_DAILY_HISTORY_DAYS = MAX_DAILY_DAYS;

/** Số sản phẩm tối đa trả về (khớp trần by_product của hợp đồng sync). */
const MAX_PRODUCTS = 500;

/** Số byte tối đa của `payload_json` mà ta chịu đọc (chặn payload phình bất thường). */
const MAX_PAYLOAD_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Tiện ích nội bộ
// ---------------------------------------------------------------------------

/** Ép một giá trị bất kỳ về chuỗi an toàn (không bao giờ ném lỗi). */
function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return String(value);
  } catch {
    return "";
  }
}

/**
 * Ép một giá trị về số NGUYÊN đồng không âm.
 * NaN / Infinity / số âm / giá trị lạ đều quy về 0 thay vì làm hỏng phép cộng.
 */
function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  return i > 0 ? i : 0;
}

/** Mô tả lỗi ngắn gọn để ghi log — KHÔNG bao giờ chứa nội dung payload. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : "unknown";
}

// ---------------------------------------------------------------------------
// Chuẩn hoá các mảng tổng hợp
//
// `payload_json` đến từ VPS đã được validate lúc nhận, nhưng nó là dữ liệu nằm
// trong DB nên vẫn phải coi là KHÔNG đáng tin: có thể do bản VPS cũ ghi vào,
// có thể bị sửa tay. Mọi giá trị đưa ra response đều được chuẩn hoá lại ở đây.
// ---------------------------------------------------------------------------

/** Tên sản phẩm bị cắt còn 200 ký tự (trần của hợp đồng sync). */
function normaliseByProduct(rows: readonly ByProduct[]): ByProduct[] {
  const out: ByProduct[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    out.push({
      product_id: toCount(row.product_id),
      name: asString(row.name).slice(0, 200),
      sold: toCount(row.sold),
      revenue: toCount(row.revenue),
    });
    if (out.length >= MAX_PRODUCTS) break;
  }
  return out;
}

/** `method` rỗng được gom vào nhóm "khác" theo CONTRACT §1. */
function normaliseByMethod(rows: readonly ByMethod[]): ByMethod[] {
  const out: ByMethod[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const raw = asString(row.method).trim();
    out.push({
      method: raw === "" ? "khác" : raw,
      orders: toCount(row.orders),
      revenue: toCount(row.revenue),
    });
  }
  return out;
}

/** `status` rỗng được gom vào nhóm "khác" (hợp đồng chỉ định nghĩa 4 trạng thái). */
function normaliseByStatus(rows: readonly ByStatus[]): ByStatus[] {
  const out: ByStatus[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const raw = asString(row.status).trim();
    out.push({
      status: raw === "" ? "khác" : raw,
      count: toCount(row.count),
    });
  }
  return out;
}

/** Tồn kho: CHỈ có product_id và hai con số. Không có trường nào chứa nội dung. */
function normaliseStock(rows: readonly StockRow[]): StockRow[] {
  const out: StockRow[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    out.push({
      product_id: toCount(row.product_id),
      available: toCount(row.available),
      sold: toCount(row.sold),
    });
  }
  return out;
}

/** Totals đã chuẩn hoá — thiếu field nào thì field đó là 0. */
function normaliseTotals(raw: Totals | null | undefined): Totals {
  const base = emptyTotals();
  if (raw === null || raw === undefined || typeof raw !== "object") return base;
  return {
    revenue_delivered: toCount(raw.revenue_delivered),
    orders_delivered: toCount(raw.orders_delivered),
    orders_all: toCount(raw.orders_all),
    users_total: toCount(raw.users_total),
    deposits_confirmed: toCount(raw.deposits_confirmed),
    wallet_balance_sum: toCount(raw.wallet_balance_sum),
  };
}

/**
 * Chuẩn hoá `payload_json` đã đọc từ D1.
 *
 * Luồng: JSON.parse → `parseSyncPayload` (validate lại toàn bộ theo CONTRACT §2)
 * → chuẩn hoá từng mảng. Parse hỏng KHÔNG được làm endpoint trả 500: dashboard
 * phải vẫn mở được (hiện số 0) trước khi có lần sync đầu tiên hoặc khi dữ liệu
 * cũ hỏng. Vì vậy mọi lỗi ở đây được nuốt và trả về payload rỗng.
 */
function parseStoredPayload(
  payloadJson: string,
): { payload: SyncPayload | null; ok: boolean } {
  if (payloadJson.length > MAX_PAYLOAD_BYTES) {
    logLine("snapshot payload quá lớn, bỏ qua", payloadJson.length);
    return { payload: null, ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch (err) {
    logLine("snapshot payload_json không phải JSON hợp lệ", errText(err));
    return { payload: null, ok: false };
  }
  try {
    return { payload: parseSyncPayload(parsed), ok: true };
  } catch (err) {
    logLine("snapshot payload không qua được validate", errText(err));
    return { payload: null, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Đọc D1
// ---------------------------------------------------------------------------

/** Hàng thô của `sync_snapshots` (chỉ đọc, không bao giờ trả payload ra ngoài). */
interface SnapshotRow {
  synced_at: string;
  received_at: string;
  payload_json: string;
}

/** Hàng thô của `daily_stats`. */
interface DailyRow {
  date: string;
  revenue: number;
  orders: number;
}

/**
 * Snapshot mới nhất theo THỜI ĐIỂM ĐỒNG BỘ (`synced_at`), không phải theo `id`.
 *
 * VÌ SAO PHẢI SỬA THÀNH `synced_at DESC` — đây là lỗi đã tái hiện được thật:
 * Bản đầu tiên tôi viết `ORDER BY id DESC` với lập luận "id là thứ tự Worker
 * nhận được". Lập luận đó SAI khi có bản ghi đến muộn hoặc chạy lại:
 *
 *   id=2  synced_at = 2026-09-22T20:13:15+07:00   (vừa đồng bộ xong)
 *   id=3  synced_at = 2026-09-22T17:13:16+07:00   (snapshot cũ, gửi sau)
 *
 * `id DESC` trả về id=3, tức là dashboard báo "dữ liệu cũ 3 giờ" trong khi thực
 * tế VPS vừa đồng bộ xong. Cảnh báo cũ sẽ kêu sai — mà kêu sai thì chủ shop sẽ
 * học cách phớt lờ nó, đúng thứ nguy hiểm nhất với một dashboard.
 *
 * Quy tắc đúng: lấy mốc đồng bộ MỚI NHẤT theo thời gian; nếu trùng thời gian
 * thì lấy bản ghi vào sau (`id DESC`) làm tie-break cho ổn định.
 *
 * Trả `null` khi bảng chưa tồn tại (chưa chạy migrate) hoặc chưa có bản ghi —
 * dashboard hiển thị "chưa có dữ liệu" thay vì lỗi 500.
 */
async function readLatestSnapshot(env: Env): Promise<SnapshotRow | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT synced_at, received_at, payload_json
         FROM sync_snapshots
        ORDER BY synced_at DESC, id DESC
        LIMIT 1`,
    ).first<SnapshotRow>();
    if (row === null || row === undefined) return null;
    return {
      synced_at: asString(row.synced_at),
      received_at: asString(row.received_at),
      payload_json: asString(row.payload_json),
    };
  } catch (err) {
    logLine("đọc sync_snapshots thất bại (bảng chưa migrate?)", errText(err));
    return null;
  }
}

/**
 * `limit` ngày gần nhất của `daily_stats`, trả về THEO CHIỀU GIẢM DẦN.
 *
 * Vì sao phải đọc `daily_stats` chứ không lấy `payload.by_day`:
 * mỗi snapshot chỉ mang theo một cửa sổ ngày (mặc định 30 ngày của VPS). Nếu
 * dashboard cần 60–90 ngày, dữ liệu đó chỉ còn nằm ở bảng `daily_stats` — bảng
 * được upsert theo từng ngày nên lịch sử sống lâu hơn cửa sổ của một snapshot.
 *
 * `LIMIT ?1` là bind tham số hợp lệ trong SQLite/D1; không nối chuỗi SQL.
 */
async function readDailyStats(db: D1Database, limit: number): Promise<DailyRow[]> {
  try {
    const res = await db
      .prepare(
        `SELECT date, revenue, orders
           FROM daily_stats
          ORDER BY date DESC
          LIMIT ?1`,
      )
      .bind(limit)
      .all<DailyRow>();
    return Array.isArray(res.results) ? res.results : [];
  } catch (err) {
    logLine("đọc daily_stats thất bại (bảng chưa migrate?)", errText(err));
    return [];
  }
}

/**
 * `limit` mốc sync gần nhất — CHỈ hai cột thời gian.
 *
 * TUYỆT ĐỐI không SELECT `payload_json` ở đây: đó là quy tắc giữ cho response
 * nhỏ và không bao giờ có đường rò rỉ nội dung snapshot ra ngoài. File này là
 * nơi DUY NHẤT trong stats.ts được phép chạm `payload_json`, và nó chỉ nằm
 * trong bộ nhớ để parse thành số liệu tổng hợp.
 */
async function readRecentSyncs(db: D1Database, limit: number): Promise<SyncMeta[]> {
  try {
    const res = await db
      .prepare(
        `SELECT synced_at, received_at
           FROM sync_snapshots
          ORDER BY synced_at DESC
          LIMIT ?1`,
      )
      .bind(limit)
      .all<SyncMeta>();
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
    logLine("đọc lịch sử sync thất bại (bảng chưa migrate?)", errText(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Hàm thuần (export để test / tái dùng)
// ---------------------------------------------------------------------------

/**
 * Dựng cửa sổ `days` ngày LIÊN TỤC kết thúc ở HÔM NAY THEO GIỜ VN (UTC+7).
 *
 * Vì sao phải là `vnToday()`: DB bán hàng ghi ngày theo giờ Việt Nam nhưng
 * KHÔNG kèm offset, nên "hôm nay" của dữ liệu là hôm nay ở UTC+7. Worker chạy
 * ở UTC; từ 00:00 đến 07:00 giờ VN, `new Date().toISOString()` vẫn là ngày hôm
 * qua. Dùng ngày UTC sẽ làm cửa sổ lệch một ngày và khiến ngày hôm nay luôn
 * bằng 0 — biểu đồ sai một cách âm thầm. Vì vậy mọi việc chia ngày ở đây đều
 * theo UTC+7.
 *
 * Ngày nào không có dòng dữ liệu thì điền `{ revenue: 0, orders: 0 }` để trục
 * biểu đồ không bị đứt. Dòng nằm ngoài cửa sổ (hoặc ngày dị dạng) bị bỏ qua.
 *
 * Kết quả LUÔN xếp tăng dần theo ngày và có ĐÚNG `days` phần tử.
 */
export function buildDailyWindow(rows: readonly ByDay[], days: number): ByDay[] {
  const span = Math.max(MIN_DAILY_DAYS, Math.min(Math.trunc(days), MAX_DAILY_DAYS));

  // Mốc neo: ngày hôm nay theo UTC+7, dựng lại thành UTC nửa đêm để cộng trừ
  // ngày cho chắc chắn (không phụ thuộc DST — VN không có DST).
  const todayVn = vnToday();
  const anchorUtcMs = Date.parse(`${todayVn}T00:00:00Z`);
  if (!Number.isFinite(anchorUtcMs)) {
    // Không thể xảy ra với vnToday(), nhưng thà trả cửa sổ rỗng còn hơn ném lỗi.
    logLine("buildDailyWindow: không parse được mốc ngày VN", todayVn);
    return [];
  }

  // Gom dữ liệu vào map theo ngày; ngày trùng thì LẤY BẢN GHI CUỐI (bảng đã
  // upsert theo PRIMARY KEY date nên thực tế không có ngày trùng).
  const byDate = new Map<string, ByDay>();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const date = asString(row.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    byDate.set(date, {
      date,
      revenue: toCount(row.revenue),
      orders: toCount(row.orders),
    });
  }

  const out: ByDay[] = [];
  for (let offset = span - 1; offset >= 0; offset--) {
    const dayMs = anchorUtcMs - offset * 86_400_000;
    const date = new Date(dayMs).toISOString().slice(0, 10);
    const found = byDate.get(date);
    out.push(
      found === undefined
        ? { date, revenue: 0, orders: 0 }
        : { date, revenue: found.revenue, orders: found.orders },
    );
  }
  return out;
}

/**
 * Tuổi của lần sync gần nhất và kết luận có "cũ" hay không.
 *
 * Quy tắc (CONTRACT §3 — `stale_seconds`):
 *   - `synced_at` là ISO CÓ offset (ví dụ "2026-09-22T17:30:00+07:00"), nên
 *     `Date.parse` cho đúng mốc tuyệt đối; `stale_seconds` là số giây đã trôi
 *     qua kể từ mốc đó.
 *   - Lệch đồng hồ (VPS chạy nhanh hơn Worker) làm hiệu số âm: KẸP VỀ 0 và
 *     KHÔNG coi là cũ. Báo động vì đồng hồ lệch vài giây là báo oan.
 *   - Chưa từng sync (`synced_at === null`) → `stale: true`, `stale_seconds: null`.
 *   - Chuỗi không parse được → coi là CŨ với `stale_seconds: null`. Thà cảnh
 *     báo nhầm còn hơn im lặng hiển thị số liệu chết.
 *   - Hàm này KHÔNG BAO GIỜ ném lỗi (dashboard gọi nó trên đường nóng).
 */
export function computeStaleness(
  syncedAt: string | null,
  now: Date = new Date(),
): { stale: boolean; stale_seconds: number | null } {
  if (syncedAt === null || syncedAt === undefined) {
    return { stale: true, stale_seconds: null };
  }
  const trimmed = asString(syncedAt).trim();
  if (trimmed === "") {
    return { stale: true, stale_seconds: null };
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return { stale: true, stale_seconds: null };
  }

  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) {
    return { stale: true, stale_seconds: null };
  }

  // Lệch đồng hồ / timestamp tương lai → 0 giây, và KHÔNG cũ.
  const seconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  return { stale: seconds > STALE_AFTER_SECONDS, stale_seconds: seconds };
}

/**
 * Đọc `?days=` và KẸP về khoảng hợp lệ. Không bao giờ ném lỗi.
 *
 *   null / rỗng / "abc" / "3.7" / "-5" / "1e9"  → mặc định 30
 *   < 1                                          → 1
 *   > 90                                         → 90
 *
 * Chỉ nhận chuỗi toàn chữ số (sau khi trim): điều này chặn luôn các dạng số kỳ
 * lạ như "0x10", "1e3", " 12abc" mà `Number()` vẫn chấp nhận.
 */
export function parseDaysParam(raw: string | null): number {
  if (raw === null || raw === undefined) return DAILY_WINDOW_DAYS;
  const trimmed = asString(raw).trim();
  // Trần 19 chữ số: đủ rộng để "số quá lớn" vẫn được nhận diện là SỐ (rồi kẹp
  // về 90) chứ không bị coi là rác rồi rơi về mặc định 30. Người dùng gõ
  // ?days=1000 phải thấy 90 ngày, không phải 30.
  if (trimmed === "" || !/^[0-9]{1,19}$/.test(trimmed)) return DAILY_WINDOW_DAYS;

  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return DAILY_WINDOW_DAYS;
  if (n < MIN_DAILY_DAYS) return MIN_DAILY_DAYS;
  if (n > MAX_DAILY_DAYS) return MAX_DAILY_DAYS;
  return n;
}

/** Tổng hợp rỗng — dùng chung cho payload hỏng và payload thiếu field. */
export interface NormalisedSnapshot {
  synced_at: string | null;
  received_at: string | null;
  totals: Totals;
  by_product: ByProduct[];
  by_method: ByMethod[];
  by_status: ByStatus[];
  stock: StockRow[];
}

/** Snapshot rỗng (chưa sync / payload hỏng): mọi số là 0, mọi mảng rỗng. */
export function emptySnapshot(): NormalisedSnapshot {
  return {
    synced_at: null,
    received_at: null,
    totals: emptyTotals(),
    by_product: [],
    by_method: [],
    by_status: [],
    stock: [],
  };
}

// ---------------------------------------------------------------------------
// Nguồn chân lý: computeStats
// ---------------------------------------------------------------------------

/**
 * Toàn bộ số liệu dashboard trong một lần gọi. Ba handler bên dưới chỉ là lớp
 * mỏng bọc quanh hàm này, nên không có chỗ nào có bản sao thứ hai của logic
 * "cũ hay không cũ" hay của logic dựng cửa sổ ngày.
 *
 * Nguồn dữ liệu:
 *   1. `sync_snapshots` (bản mới nhất) → totals, by_product, by_method,
 *      by_status, stock, và mốc thời gian `synced_at` / `received_at`.
 *      Vì sao lấy từ snapshot đã validate thay vì tự SUM lại: snapshot là ảnh
 *      chụp TOÀN PHẦN đã được `parseSyncPayload` kiểm tra (số nguyên hữu hạn,
 *      không âm, đúng danh mục method/status) ngay lúc nhận. Nó là con số mà
 *      VPS — nơi duy nhất nhìn thấy DB bán hàng — chịu trách nhiệm tính đúng.
 *      Tự cộng lại từ `daily_stats`/`product_stats` vừa thừa vừa dễ lệch, vì
 *      mấy bảng đó được upsert theo từng ngày/sản phẩm và không mang theo
 *      `users_total`, `deposits_confirmed`, `wallet_balance_sum`.
 *   2. `daily_stats` (LIMIT <số ngày>) → cửa sổ ngày, để lịch sử sống lâu hơn
 *      cửa sổ 30 ngày mà một snapshot mang theo.
 *
 * Hàm này KHÔNG BAO GIỜ ném lỗi: mọi truy vấn D1 đều được bọc try/catch trong
 * các hàm đọc ở trên, để dashboard hiện số 0 thay vì 500 khi DB còn trống.
 */
export async function computeStats(env: Env): Promise<StatsResponse> {
  const snapshot = await readLatestSnapshot(env);

  let normalised = emptySnapshot();
  if (snapshot !== null) {
    const { payload } = parseStoredPayload(snapshot.payload_json);
    if (payload !== null) {
      normalised = {
        synced_at: asString(payload.synced_at),
        received_at: snapshot.received_at,
        totals: normaliseTotals(payload.totals),
        by_product: normaliseByProduct(payload.by_product),
        by_method: normaliseByMethod(payload.by_method),
        by_status: normaliseByStatus(payload.by_status),
        stock: normaliseStock(payload.stock),
      };
    } else {
      // Payload hỏng nhưng vẫn còn mốc thời gian: giữ lại để băng-rôn "cũ" và
      // trang nhật ký vẫn nói đúng sự thật là "đã từng sync".
      normalised = emptySnapshot();
      normalised.synced_at = snapshot.synced_at === "" ? null : snapshot.synced_at;
      normalised.received_at = snapshot.received_at === "" ? null : snapshot.received_at;
    }
  }

  // Cửa sổ ngày: đọc thẳng từ daily_stats (nguồn lịch sử), KHÔNG dùng
  // payload.by_day — snapshot chỉ mang theo một cửa sổ hữu hạn.
  const dailyRows = await readDailyStats(env.DB, MAX_DAILY_HISTORY_DAYS);
  const byDay = buildDailyWindow(dailyRows, DAILY_WINDOW_DAYS);

  const lastSyncs = await readRecentSyncs(env.DB, LAST_SYNCS_LIMIT);

  const { stale, stale_seconds } = computeStaleness(normalised.synced_at);

  return {
    synced_at: normalised.synced_at,
    received_at: normalised.received_at,
    stale,
    stale_seconds,
    totals: normalised.totals,
    by_day: byDay,
    by_product: normalised.by_product,
    by_method: normalised.by_method,
    by_status: normalised.by_status,
    stock: normalised.stock,
    last_syncs: lastSyncs,
  };
}

// ---------------------------------------------------------------------------
// Handler HTTP
// ---------------------------------------------------------------------------

/**
 * Cổng xác thực dùng chung cho ba route.
 *
 * Router (src/index.ts) cũng đã gọi `requireAuth` trước khi vào đây; kiểm tra
 * lại lần nữa là CỐ Ý: nếu một ngày nào đó route bị gắn vào router mà quên
 * chèn middleware, số liệu kinh doanh vẫn không lộ ra ngoài. Kiểm tra hai lần
 * chỉ tốn một phép so HMAC nhỏ.
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

/**
 * `GET /api/stats` → `StatsResponse`.
 *
 * Không tin BẤT CỨ thứ gì từ client: route này không đọc body, không đọc query
 * param, không đọc header nào ngoài cookie phiên.
 */
export async function handleStats(request: Request, env: Env): Promise<Response> {
  try {
    const denied = await guard(request, env);
    if (denied !== null) return denied;

    const stats = await computeStats(env);
    return jsonOk(stats, 200, noStore());
  } catch (err) {
    // Không bao giờ trả chi tiết lỗi DB ra ngoài; chỉ log mô tả ngắn.
    logLine("handleStats thất bại", errText(err));
    return serverError();
  }
}

/**
 * `GET /api/stats/daily?days=30` → `{ days: ByDay[] }`.
 *
 * Bám đúng hợp đồng: `days` sai định dạng thì KẸP về mặc định 30 (không 400) —
 * `parseDaysParam` không bao giờ ném lỗi. Ngoài `days`, không có input nào khác
 * từ client được sử dụng.
 *
 * Ở đây chỉ đọc `daily_stats` rồi tự dựng cửa sổ, tức là bỏ được hai truy vấn
 * so với `computeStats`. Logic "cũ hay không cũ" KHÔNG bị chép lại: route này
 * đơn giản là không cần tới nó, và nguồn duy nhất của nó vẫn là
 * `computeStaleness` ở trên.
 */
export async function handleDaily(request: Request, env: Env): Promise<Response> {
  try {
    const denied = await guard(request, env);
    if (denied !== null) return denied;

    let raw: string | null = null;
    try {
      raw = new URL(request.url).searchParams.get("days");
    } catch {
      raw = null;
    }
    const days = parseDaysParam(raw);

    const rows = await readDailyStats(env.DB, MAX_DAILY_HISTORY_DAYS);
    const body: DailyResponse = { days: buildDailyWindow(rows, days) };
    return jsonOk(body, 200, noStore());
  } catch (err) {
    logLine("handleDaily thất bại", errText(err));
    return serverError();
  }
}

/**
 * `GET /api/stats/products` → `{ products: ByProduct[] }`.
 *
 * Danh sách sản phẩm nằm trong snapshot mới nhất, nên phải dùng `computeStats`
 * (một truy vấn snapshot) thay vì bịa ra một đường đọc thứ hai — chỉ có MỘT nơi
 * định nghĩa "sản phẩm nào đang bán chạy", không có bản sao logic nào lệch nhau.
 */
export async function handleProducts(request: Request, env: Env): Promise<Response> {
  try {
    const denied = await guard(request, env);
    if (denied !== null) return denied;

    const stats = await computeStats(env);
    const body: ProductsResponse = { products: stats.by_product };
    return jsonOk(body, 200, noStore());
  } catch (err) {
    logLine("handleProducts thất bại", errText(err));
    return serverError();
  }
}

// ---------------------------------------------------------------------------
// Ghi chú kiểm chứng
//
// * `grep -n "content" src/api/stats.ts` phải KHÔNG ra chỗ nào đọc nội dung
//   stock. File này không hề tham chiếu bảng `stock` của DB bán hàng; nó chỉ
//   đọc các trường SỐ đã tổng hợp từ snapshot.
// * `grep -n '\${' src/api/stats.ts` không được xuất hiện bên trong câu SQL.
// * Không có `jsonError` nào trả thông điệp sinh ra từ lỗi DB: `serverError()`
//   là cố định, còn `jsonError` chỉ dùng cho lỗi do chính ta quyết định.
// ---------------------------------------------------------------------------
