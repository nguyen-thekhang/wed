/**
 * src/lib/validate.ts — validate payload sync VPS → Worker (hợp đồng đã freeze, mục 2 & 3).
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH CỦA DỰ ÁN:
 * Bảng `stock` bên DB bán hàng có cột `content` chứa cặp `acc|pass` THẬT.
 * Module này TUYỆT ĐỐI KHÔNG đọc, không nhận, không validate, không log và không trả về
 * bất kỳ nội dung nào như vậy. Chỉ `COUNT(*)` trên `stock` là được phép, nên payload chỉ
 * mang `{product_id, available, sold}`. Không có field free-text nào có thể chở credential:
 * tên sản phẩm bị CHẶN nếu có hình dạng `acc|pass` (xem `CREDENTIAL_SHAPE` bên dưới).
 * Nếu ai đó định thêm field tự do vào đây → DỪNG LẠI và báo lỗi.
 *
 * Module này KHÔNG import gì từ dự án (dependency-free) để có thể unit-test độc lập.
 */

/** Lỗi validate. Message LUÔN ngắn gọn bằng tiếng Việt và KHÔNG bao giờ chứa giá trị gây lỗi. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
    // Giữ prototype đúng khi biên dịch xuống ES5/ES2015 (an toàn cho bundler).
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/** Số liệu tổng hợp (tiền là số nguyên đồng VN). */
export interface Totals {
  revenue_delivered: number;
  orders_delivered: number;
  orders_all: number;
  users_total: number;
  deposits_confirmed: number;
  wallet_balance_sum: number;
}

/** Doanh thu / số đơn theo ngày, ngày theo giờ VN (UTC+7). */
export interface ByDay {
  date: string;
  revenue: number;
  orders: number;
}

/** Thống kê theo sản phẩm — chỉ tên + số lượng + tiền, KHÔNG có nội dung. */
export interface ByProduct {
  product_id: number;
  name: string;
  sold: number;
  revenue: number;
}

/** Thống kê theo phương thức thanh toán (method đã chuẩn hoá). */
export interface ByMethod {
  method: string;
  orders: number;
  revenue: number;
}

/** Thống kê theo trạng thái đơn. */
export interface ByStatus {
  status: string;
  count: number;
}

/** Tồn kho — CHỈ số lượng. Không có cột nào tương ứng `stock.content`. */
export interface StockRow {
  product_id: number;
  available: number;
  sold: number;
}

/** Payload sync đã validate. Field lạ ở cấp gốc bị BỎ (không bao giờ được lưu). */
export interface SyncPayload {
  synced_at: string;
  totals: Totals;
  by_day: ByDay[];
  by_product: ByProduct[];
  by_method: ByMethod[];
  by_status: ByStatus[];
  stock: StockRow[];
}

/** Giới hạn validate. `body_max_bytes` dùng cho endpoint sync để chặn body quá lớn TRƯỚC khi parse. */
export const LIMITS: {
  by_day: number;
  by_product: number;
  by_method: number;
  by_status: number;
  stock: number;
  name_max: number;
  money_max: number;
  body_max_bytes: number;
} = {
  by_day: 400,
  by_product: 500,
  by_method: 20,
  by_status: 20,
  stock: 500,
  name_max: 200,
  money_max: 1e12,
  body_max_bytes: 1048576,
};

/** Thứ tự cố định của by_status khi trả về. */
const STATUS_ORDER: readonly string[] = ["delivered", "cancelled", "expired", "preorder"];

/** Thứ tự cố định của by_method khi trả về: bank, wallet, rồi khác cuối cùng. */
const METHOD_ORDER: readonly string[] = ["bank", "wallet", "khác"];

/** Các giá trị method được chấp nhận từ sender. */
const METHOD_INPUTS: readonly string[] = ["bank", "wallet", "khác", "other", ""];

/** Method mặc định cho đơn không rõ phương thức. */
const METHOD_OTHER = "khác";

const RE_ISO_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Hình dạng nghi credential: `token|token` không khoảng trắng, không thêm dấu `|`. */
const RE_CREDENTIAL_SHAPE = /^[^\s|]{1,64}\|[^\s|]{1,64}$/;
/** Ký tự điều khiển C0/C1 (gồm \n, \r, \t) — không được phép trong tên sản phẩm. */
const RE_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
/** Khoảng trắng để gộp khi redact. */
const RE_WHITESPACE = /\s+/g;
/** Đoạn nghi credential để thay bằng [redacted] trong log/audit. */
const RE_TOKEN_PAIR = /[^\s|]{1,64}\|[^\s|]{1,64}/g;

const KEY_TOTALS: readonly (keyof Totals)[] = [
  "revenue_delivered",
  "orders_delivered",
  "orders_all",
  "users_total",
  "deposits_confirmed",
  "wallet_balance_sum",
];

const MAX_SYNCED_AT_LEN = 40;
const MAX_PRODUCT_ID = 1e9;
/** Lệch giờ Việt Nam so với UTC, tính bằng mili-giây. */
const VN_OFFSET_MS = 7 * 3600000;

/* ------------------------------------------------------------------ */
/* Tiện ích nội bộ                                                     */
/* ------------------------------------------------------------------ */

/** Object thường (plain object), không phải array/null/Date... */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Vì sao mọi số phải là số NGUYÊN hữu hạn: tiền là đồng VN và schema D1 khai báo INTEGER.
 * Nhận float/NaN/Infinity/chuỗi số ("100") sẽ làm SQLite lưu sai kiểu, làm lệch tổng doanh thu
 * và phá tính idempotent của upsert. Sender luôn gửi number thật, nên từ chối JSON number
 * không nguyên là hoàn toàn an toàn. `-0`: Object.is(-0, 0) là false nên bị loại cùng lúc.
 */
function isMoney(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    !Object.is(v, -0) &&
    v >= 0 &&
    v <= LIMITS.money_max
  );
}

/** Số nguyên trong [min, max] — dùng cho product_id và các trường đếm nhỏ. */
function isIntInRange(v: unknown, min: number, max: number): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    !Object.is(v, -0) &&
    v >= min &&
    v <= max
  );
}

function isProductId(v: unknown): v is number {
  return isIntInRange(v, 1, MAX_PRODUCT_ID);
}

/** true nếu `y-m-d` là ngày lịch có thật (loại 2026-02-30, 2026-13-01...). */
function isRealCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1970 || y > 9999) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  return d <= daysInMonth(y, m);
}

/** Số ngày của tháng `m` (1..12) trong năm `y` — xử lý năm nhuận theo lịch Gregorian. */
function daysInMonth(y: number, m: number): number {
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  if (m === 4 || m === 6 || m === 9 || m === 11) return 30;
  return 31;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** true nếu `s` đúng 'YYYY-MM-DD' và là ngày có thật. */
function isDateKey(s: unknown): s is string {
  if (typeof s !== "string" || s.length !== 10 || !RE_DATE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return isRealCalendarDate(y, m, d);
}

/** Kết quả đã kiểm tra của isIsoWithOffset. */
interface IsoParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  frac: string;
  offset: string;
  /** Độ lệch offset so với UTC, tính bằng mili-giây (+07:00 → 25200000). */
  offsetMs: number;
}

function parseIsoWithOffset(s: unknown): IsoParts | null {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_SYNCED_AT_LEN) return null;
  const m = RE_ISO_OFFSET.exec(s);
  if (m === null) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = Number(m[6]);
  const frac = m[7] ?? "";
  const offset = m[8] ?? "";

  // Kiểm tra dải giá trị bằng tay: Date.parse rất dễ dãi (rollover ngày 32 sang tháng sau),
  // nên không thể tin nó để xác nhận một thời điểm lịch có thật.
  if (!isRealCalendarDate(y, mo, d)) return null;
  if (hh > 23 || mi > 59 || ss > 59) return null;

  let offsetMs = 0;
  if (offset !== "Z") {
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    const mag = oh * 3600000 + om * 60000;
    offsetMs = offset.charAt(0) === "-" ? -mag : mag;
  }

  const epoch = Date.UTC(y, mo - 1, d, hh, mi, ss);
  if (!Number.isFinite(epoch)) return null;

  return { y, m: mo, d, hh, mm: mi, ss, frac, offset, offsetMs };
}

/* ------------------------------------------------------------------ */
/* API công khai                                                       */
/* ------------------------------------------------------------------ */

/**
 * true CHỈ KHI `s` là ISO8601 đầy đủ kèm offset số (Z hoặc ±hh:mm) và là thời điểm có thật.
 * "Z" được chấp nhận, nhưng sender trên VPS luôn ghi "+07:00".
 */
export function isIsoWithOffset(s: string): boolean {
  return parseIsoWithOffset(s) !== null;
}

/**
 * Ngày hôm nay theo giờ Việt Nam, dạng 'YYYY-MM-DD'.
 *
 * ĐÂY LÀ CHI TIẾT ĐÚNG ĐẮN QUAN TRỌNG NHẤT: DB bán hàng lưu giờ địa phương VN không kèm offset,
 * nên MỌI việc gom nhóm theo ngày phải làm ở UTC+7. Cách làm: cộng thẳng 7 giờ vào epoch ms
 * rồi đọc bằng các getter UTC — như vậy kết quả không phụ thuộc timezone của máy chạy code
 * (Worker luôn là UTC, nhưng test/dev trên máy VN vẫn phải ra cùng kết quả).
 */
export function vnToday(now: Date = new Date()): string {
  const t = now.getTime();
  if (!Number.isFinite(t)) {
    throw new ValidationError("Thời gian không hợp lệ");
  }
  const shifted = new Date(t + VN_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/**
 * Đổi một chuỗi ISO có offset thành ngày theo giờ VN (UTC+7).
 * Chuỗi "+07:00" thì phần ngày chính là 10 ký tự đầu, nhưng vẫn đi qua phép dịch UTC+7 thật
 * để "Z"/offset khác cũng được gom đúng theo ngày Việt Nam.
 */
export function vnDateOf(iso: string): string {
  const p = parseIsoWithOffset(iso);
  if (p === null) {
    throw new ValidationError("Thời gian ISO không hợp lệ");
  }
  const epoch = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - p.offsetMs;
  const shifted = new Date(epoch + VN_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/**
 * Chuẩn hoá phương thức thanh toán.
 *
 * QUY TẮC ĐÃ CHỐT: chuỗi rỗng "" là BÌNH THƯỜNG và được gom vào nhóm "khác" (tiêu chí
 * nghiệm thu: đơn có method = '' VẪN PHẢI được đếm trong nhóm "khác", không được bỏ).
 * "other" là bí danh cũng gom về "khác". "bank"/"wallet" giữ nguyên.
 */
export function normaliseMethod(m: string): string {
  if (m === "" || m === "other") return METHOD_OTHER;
  return m;
}

/** Totals toàn số 0 — dùng khi chưa có dữ liệu sync. */
export function emptyTotals(): Totals {
  return {
    revenue_delivered: 0,
    orders_delivered: 0,
    orders_all: 0,
    users_total: 0,
    deposits_confirmed: 0,
    wallet_balance_sum: 0,
  };
}

/** Payload rỗng (mảng rỗng + totals 0) — dùng cho script mirror trên VPS và giá trị mặc định. */
export function emptyPayload(syncedAt: string): SyncPayload {
  return {
    synced_at: syncedAt,
    totals: emptyTotals(),
    by_day: [],
    by_product: [],
    by_method: [],
    by_status: [],
    stock: [],
  };
}

/**
 * Làm sạch text để ghi audit/log: gộp khoảng trắng, bỏ ký tự điều khiển, cắt ngắn,
 * và thay mọi đoạn có hình dạng credential "token|token" bằng "[redacted]".
 * Không bao giờ được ném lỗi (dùng cho cả input không tin cậy).
 */
export function redactText(s: unknown, max = 200): string {
  let out = "";
  if (typeof s === "string") {
    out = s;
  } else if (s === null || s === undefined) {
    return "";
  } else if (typeof s === "number" || typeof s === "boolean" || typeof s === "bigint") {
    out = String(s);
  } else {
    // Object/array/symbol/function: KHÔNG stringify (có thể lộ nội dung) — chỉ mô tả loại.
    out = `[${Array.isArray(s) ? "array" : typeof s}]`;
  }

  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  out = out.replace(RE_CONTROL_CHARS, " ").replace(RE_WHITESPACE, " ").trim();
  if (out.length === 0 || limit === 0) return "";

  // Cắt trước rồi mới redact để đoạn "acc|pass" nằm vắt qua mép cắt không lọt ra ngoài.
  if (out.length > limit) out = out.slice(0, limit);

  return out.replace(RE_TOKEN_PAIR, "[redacted]").trim();
}

/**
 * Validate payload sync thô thành `SyncPayload`.
 * Ném `ValidationError` (message tiếng Việt ngắn, KHÔNG chứa giá trị gây lỗi) nếu sai.
 * Field lạ ở cấp gốc bị BỎ hoàn toàn (chỉ các key hợp lệ được trả về nên không gì khác được lưu).
 */
export function parseSyncPayload(raw: unknown): SyncPayload {
  if (!isPlainObject(raw)) {
    throw new ValidationError("Payload phải là object JSON");
  }

  for (const k of ["synced_at", "totals", "by_day", "by_product", "by_method", "by_status", "stock"]) {
    if (!Object.prototype.hasOwnProperty.call(raw, k) || raw[k] === undefined) {
      throw new ValidationError("Payload thiếu trường bắt buộc");
    }
  }

  const syncedAtRaw = raw["synced_at"];
  if (!isIsoWithOffset(syncedAtRaw as string)) {
    throw new ValidationError("synced_at phải là ISO8601 kèm offset, ví dụ +07:00");
  }

  const byDay = parseByDay(raw["by_day"]);
  const byProduct = parseByProduct(raw["by_product"]);
  const byMethod = parseByMethod(raw["by_method"]);
  const byStatus = parseByStatus(raw["by_status"]);
  const stock = parseStock(raw["stock"]);

  return {
    synced_at: syncedAtRaw as string,
    totals: parseTotals(raw["totals"]),
    by_day: byDay,
    by_product: byProduct,
    by_method: byMethod,
    by_status: byStatus,
    stock: stock,
  };
}

/* ------------------------------------------------------------------ */
/* Validate từng phần                                                  */
/* ------------------------------------------------------------------ */

function requireArray(v: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new ValidationError(`${label} phải là mảng`);
  }
  if (v.length > max) {
    throw new ValidationError(`${label} vượt quá ${max} phần tử`);
  }
  return v;
}

function parseTotals(v: unknown): Totals {
  if (!isPlainObject(v)) {
    throw new ValidationError("totals phải là object");
  }
  const out = emptyTotals();
  for (const k of KEY_TOTALS) {
    if (!Object.prototype.hasOwnProperty.call(v, k) || v[k] === undefined) {
      throw new ValidationError("totals thiếu trường bắt buộc");
    }
    const n = v[k];
    if (!isMoney(n)) {
      throw new ValidationError(`totals.${k} phải là số nguyên không âm`);
    }
    out[k] = n;
  }
  return out;
}

/**
 * by_day: dedupe theo date GIỮ BẢN GHI CUỐI CÙNG (idempotency — consumer upsert theo date),
 * rồi sắp xếp tăng dần theo ngày.
 */
function parseByDay(v: unknown): ByDay[] {
  const arr = requireArray(v, LIMITS.by_day, "by_day");
  const map = new Map<string, ByDay>();
  for (const item of arr) {
    if (!isPlainObject(item)) {
      throw new ValidationError("by_day chứa phần tử không phải object");
    }
    const date = item["date"];
    if (!isDateKey(date)) {
      throw new ValidationError("by_day.date phải là ngày YYYY-MM-DD có thật");
    }
    const revenue = item["revenue"];
    const orders = item["orders"];
    if (!isMoney(revenue)) {
      throw new ValidationError("by_day.revenue phải là số nguyên không âm");
    }
    if (!isMoney(orders)) {
      throw new ValidationError("by_day.orders phải là số nguyên không âm");
    }
    // Map.set ghi đè: lần xuất hiện sau thắng.
    map.set(date, { date, revenue, orders });
  }
  return Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * by_product: dedupe theo product_id giữ bản cuối, sắp xếp theo revenue GIẢM dần
 * (hoà thì theo product_id tăng dần để kết quả tất định), tối đa LIMITS.by_product.
 */
function parseByProduct(v: unknown): ByProduct[] {
  const arr = requireArray(v, LIMITS.by_product, "by_product");
  const map = new Map<number, ByProduct>();
  for (const item of arr) {
    if (!isPlainObject(item)) {
      throw new ValidationError("by_product chứa phần tử không phải object");
    }
    const productId = item["product_id"];
    if (!isProductId(productId)) {
      throw new ValidationError("by_product.product_id phải là số nguyên trong khoảng cho phép");
    }
    const name = validateProductName(item["name"]);
    const sold = item["sold"];
    const revenue = item["revenue"];
    if (!isMoney(sold)) {
      throw new ValidationError("by_product.sold phải là số nguyên không âm");
    }
    if (!isMoney(revenue)) {
      throw new ValidationError("by_product.revenue phải là số nguyên không âm");
    }
    map.set(productId, { product_id: productId, name, sold, revenue });
  }
  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue || a.product_id - b.product_id);
}

/**
 * Tên sản phẩm: chuỗi, đã trim, 1..LIMITS.name_max ký tự, KHÔNG chứa ký tự điều khiển/xuống dòng.
 *
 * CHỐNG SMUGGLING CREDENTIAL: tên sản phẩm là field free-text DUY NHẤT trong payload sync,
 * nên nó là đường duy nhất có thể tuồn cặp `acc|pass` từ VPS lên Worker. Vì vậy tên có dạng
 * `token|token` (không khoảng trắng, chỉ đúng một dấu `|`) bị TỪ CHỐI thẳng — không cắt, không
 * "làm sạch", mà từ chối cả payload. Tên sản phẩm thật của shop không bao giờ có hình dạng này;
 * nếu gặp, đó là dấu hiệu payload đang bị lợi dụng làm kênh chở credential.
 */
function validateProductName(v: unknown): string {
  if (typeof v !== "string") {
    throw new ValidationError("by_product.name phải là chuỗi");
  }
  const name = v.trim();
  if (name.length === 0) {
    throw new ValidationError("by_product.name không được rỗng");
  }
  if (name.length > LIMITS.name_max) {
    throw new ValidationError(`by_product.name vượt quá ${LIMITS.name_max} ký tự`);
  }
  if (RE_CONTROL_CHARS.test(name)) {
    // test() với regex có cờ /g là stateful → reset lastIndex sau mỗi lần dùng.
    RE_CONTROL_CHARS.lastIndex = 0;
    throw new ValidationError("by_product.name chứa ký tự điều khiển");
  }
  RE_CONTROL_CHARS.lastIndex = 0;
  if (RE_CREDENTIAL_SHAPE.test(name)) {
    throw new ValidationError("by_product.name có dạng giống cặp tài khoản|mật khẩu");
  }
  return name;
}

/**
 * by_method: chỉ nhận bank | wallet | khác | other | "" (giá trị khác → từ chối).
 * "" và "other" chuẩn hoá về "khác" (đơn method = '' VẪN được đếm, không bị bỏ).
 * KHÔNG cộng dồn — sender đã tổng hợp sẵn; dedupe giữ bản cuối theo method đã chuẩn hoá.
 */
function parseByMethod(v: unknown): ByMethod[] {
  const arr = requireArray(v, LIMITS.by_method, "by_method");
  const map = new Map<string, ByMethod>();
  for (const item of arr) {
    if (!isPlainObject(item)) {
      throw new ValidationError("by_method chứa phần tử không phải object");
    }
    const rawMethod = item["method"];
    if (typeof rawMethod !== "string" || !METHOD_INPUTS.includes(rawMethod)) {
      throw new ValidationError("by_method.method không được hỗ trợ");
    }
    const method = normaliseMethod(rawMethod);
    const orders = item["orders"];
    const revenue = item["revenue"];
    if (!isMoney(orders)) {
      throw new ValidationError("by_method.orders phải là số nguyên không âm");
    }
    if (!isMoney(revenue)) {
      throw new ValidationError("by_method.revenue phải là số nguyên không âm");
    }
    map.set(method, { method, orders, revenue });
  }
  const out = Array.from(map.values());
  out.sort((a, b) => methodRank(a.method) - methodRank(b.method));
  return out;
}

/** Xếp hạng method: bank (0), wallet (1), khác (2) — "khác" luôn cuối. */
function methodRank(m: string): number {
  const i = METHOD_ORDER.indexOf(m);
  return i === -1 ? METHOD_ORDER.length : i;
}

/** by_status: chỉ 4 trạng thái hợp lệ, dedupe giữ bản cuối, sắp theo thứ tự cố định. */
function parseByStatus(v: unknown): ByStatus[] {
  const arr = requireArray(v, LIMITS.by_status, "by_status");
  const map = new Map<string, ByStatus>();
  for (const item of arr) {
    if (!isPlainObject(item)) {
      throw new ValidationError("by_status chứa phần tử không phải object");
    }
    const status = item["status"];
    if (typeof status !== "string" || !STATUS_ORDER.includes(status)) {
      throw new ValidationError("by_status.status không được hỗ trợ");
    }
    const count = item["count"];
    if (!isMoney(count)) {
      throw new ValidationError("by_status.count phải là số nguyên không âm");
    }
    map.set(status, { status, count });
  }
  const out = Array.from(map.values());
  out.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  return out;
}

/** stock: chỉ số lượng (COUNT(*) trên stock), dedupe theo product_id giữ bản cuối. */
function parseStock(v: unknown): StockRow[] {
  const arr = requireArray(v, LIMITS.stock, "stock");
  const map = new Map<number, StockRow>();
  for (const item of arr) {
    if (!isPlainObject(item)) {
      throw new ValidationError("stock chứa phần tử không phải object");
    }
    const productId = item["product_id"];
    if (!isProductId(productId)) {
      throw new ValidationError("stock.product_id phải là số nguyên trong khoảng cho phép");
    }
    const available = item["available"];
    const sold = item["sold"];
    if (!isMoney(available)) {
      throw new ValidationError("stock.available phải là số nguyên không âm");
    }
    if (!isMoney(sold)) {
      throw new ValidationError("stock.sold phải là số nguyên không âm");
    }
    map.set(productId, { product_id: productId, available, sold });
  }
  return Array.from(map.values()).sort((a, b) => a.product_id - b.product_id);
}
