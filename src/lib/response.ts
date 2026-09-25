/**
 * src/lib/response.ts — Tiện ích response / header / log / audit dùng chung.
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH (CONTRACT.md mục 0):
 * Bảng `stock` bên DB bán hàng có cột `content` chứa cặp `acc|pass` thật.
 * Module này KHÔNG BAO GIỜ đọc, ghi log, lưu audit hay trả về cột đó.
 * Chỉ được `COUNT(*)` trên `stock` để biết tồn kho — và việc đó nằm ở VPS,
 * không nằm ở đây.
 *
 * Mọi response lỗi LUÔN có dạng: { "error": { "code": "...", "message": "..." } }
 */

/** Biến môi trường / binding của Worker (theo wrangler.toml + CONTRACT.md mục 3). */
export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  SYNC_TOKEN: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  /**
   * Token riêng cho watcher theo dõi tích xanh (đọc/ghi /api/tickxanh/queue
   * và /api/tickxanh/report). Tách khỏi SYNC_TOKEN và ADMIN_PASSWORD: nếu lộ
   * watcher token thì kẻ xấu cũng chỉ giả vờ báo "lên tick xanh", không đụng
   * được vào đăng nhập hay đồng bộ số liệu.
   */
  BLUECHECK_TOKEN?: string;
  SESSION_COOKIE?: string;
  SESSION_TTL_SECONDS?: string;
}

/** Kiểu JSON hợp lệ (dùng cho các cấu trúc JSON nội bộ). */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Tiền tố log thống nhất cho toàn bộ Worker. */
const LOG_PREFIX = "[shop-dashboard]";

/**
 * Content-Type cho mọi response JSON.
 *
 * BẮT BUỘC phải set tay: khi ta truyền `headers` là một đối tượng `Headers`
 * (do `noStore()` tạo) thì runtime sẽ KHÔNG tự suy ra Content-Type từ body,
 * và mặc định rơi về `text/plain;charset=UTF-8`. Hệ quả là `res.json()` ở
 * phía dashboard sẽ ném lỗi. Vì vậy mọi response JSON đều set tường minh.
 */
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Tập header bảo mật + chống cache mà MỌI response của dashboard phải có.
 * Dùng `Record<string, string>` để dễ gộp và tra cứu theo tên (không phân biệt hoa thường).
 */
const BASE_SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

/** Ghi log nội bộ. Không bao giờ ném lỗi vì thiếu console. */
function safeLog(...parts: unknown[]): void {
  try {
    // eslint-disable-next-line no-console
    console.log(LOG_PREFIX, ...parts);
  } catch {
    /* bỏ qua: log lỗi không được làm hỏng request */
  }
}

/** Chuẩn hoá tên header về dạng thường để tra cứu/gộp không phân biệt hoa thường. */
function normKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Chuyển `HeadersInit` (Headers | string[][] | Record<string,string>) thành
 * mảng cặp [tên, giá trị]. Không dùng `Headers` để giữ nguyên thứ tự và
 * tránh phụ thuộc vào hành vi gộp của implementation.
 */
function entriesOf(init?: HeadersInit): Array<[string, string]> {
  if (!init) return [];
  if (typeof Headers !== "undefined" && init instanceof Headers) {
    const out: Array<[string, string]> = [];
    init.forEach((value, key) => {
      out.push([key, value]);
    });
    return out;
  }
  if (Array.isArray(init)) {
    const out: Array<[string, string]> = [];
    for (const pair of init as ReadonlyArray<ReadonlyArray<string>>) {
      if (!pair || pair.length < 2) continue;
      const key = pair[0];
      const value = pair[1];
      if (typeof key === "string" && typeof value === "string") out.push([key, value]);
    }
    return out;
  }
  if (typeof init === "object") {
    const src = init as Record<string, unknown>;
    const out: Array<[string, string]> = [];
    for (const key of Object.keys(src)) {
      const value = src[key];
      if (value === undefined || value === null) continue;
      out.push([key, String(value)]);
    }
    return out;
  }
  return [];
}

/**
 * `noStore()` — header chống cache + bảo mật cho mọi response.
 *
 * Trả về `Headers` với Cache-Control/Pragma/nosniff/Referrer-Policy/X-Frame-Options.
 * Header của người gọi được GỘP THÊM; header nền tảng luôn thắng, người gọi
 * không thể ghi đè (tránh vô tình tắt `no-store` hoặc `nosniff`).
 */
export function noStore(headers?: HeadersInit): Headers {
  const out = new Headers();
  const taken = new Set<string>();

  // 1) Header nền tảng trước — luôn thắng.
  for (const name of Object.keys(BASE_SECURITY_HEADERS)) {
    const value = BASE_SECURITY_HEADERS[name];
    if (value === undefined) continue;
    out.set(name, value);
    taken.add(normKey(name));
  }

  // 2) Header của người gọi — chỉ thêm những tên chưa bị chiếm.
  for (const [name, value] of entriesOf(headers)) {
    const key = normKey(name);
    if (key === "" || taken.has(key)) continue;
    out.set(name, value);
    taken.add(key);
  }

  return out;
}

/**
 * Response JSON thành công (mặc định 200).
 * Luôn kèm bộ header `noStore()`; header thêm của người gọi không ghi đè được
 * các header bảo mật nền tảng.
 */
export function jsonOk(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = noStore(extraHeaders);
  // Content-Type luôn do ta quyết định, người gọi không ghi đè được.
  headers.set("Content-Type", JSON_CONTENT_TYPE);
  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * Response JSON lỗi.
 * Body LUÔN là `{ error: { code, message } }` (CONTRACT.md mục 4).
 */
export function jsonError(code: string, message: string, status: number): Response {
  const body = JSON.stringify({ error: { code, message } });
  const headers = noStore();
  headers.set("Content-Type", JSON_CONTENT_TYPE);
  return new Response(body, { status, headers });
}

/** 401 — chưa đăng nhập / phiên không hợp lệ. */
export function unauthorized(message = "Cần đăng nhập"): Response {
  return jsonError("unauthorized", message, 401);
}

/**
 * 500 — lỗi phía server.
 *
 * KHÔNG nhận tham số, KHÔNG bao giờ trả stack trace hay message gốc của lỗi.
 * Handler gọi hàm này cần tự ghi log chi tiết bằng `logLine()` trước đó
 * (nhưng TUYỆT ĐỐI không log nội dung stock / payload thô).
 */
export function serverError(): Response {
  return jsonError("server_error", "Lỗi máy chủ, vui lòng thử lại sau", 500);
}

/** Độ dài tối đa của IP trả về — chặn input rác/độc hại. */
const MAX_IP_LENGTH = 64;
/** Giá trị mặc định khi không xác định được IP. */
const FALLBACK_IP = "0.0.0.0";

/**
 * Lấy IP người gọi theo thứ tự ưu tiên:
 *   `CF-Connecting-IP` → phần tử ĐẦU TIÊN của `X-Forwarded-For` (đã trim) → "0.0.0.0".
 *
 * Kết quả bị cắt còn tối đa 64 ký tự để tránh input phi lý.
 */
export function clientIp(req: Request): string {
  const cap = (raw: string | null): string => {
    if (!raw) return "";
    const trimmed = raw.trim();
    if (trimmed === "") return "";
    return trimmed.length > MAX_IP_LENGTH ? trimmed.slice(0, MAX_IP_LENGTH) : trimmed;
  };

  let ip = "";
  try {
    ip = cap(req.headers.get("CF-Connecting-IP"));
  } catch {
    ip = "";
  }
  if (ip !== "") return ip;

  try {
    const xff = req.headers.get("X-Forwarded-For");
    if (xff) {
      const first = xff.split(",")[0];
      ip = cap(first === undefined ? null : first);
    }
  } catch {
    ip = "";
  }
  if (ip !== "") return ip;

  return FALLBACK_IP;
}

/** Response HTML (đã kèm header chống cache + bảo mật). */
export function htmlResponse(body: string, status = 200): Response {
  const headers = noStore();
  // Set tường minh cùng lý do như JSON: runtime không tự suy ra Content-Type
  // khi `headers` đã là một đối tượng `Headers`.
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers });
}

/** Một dòng nhật ký kiểm toán. */
export interface AuditRow {
  action: string;
  detail?: string | null;
  ip?: string | null;
  created_at?: string;
}

/** Độ dài tối đa của `detail` trong audit_log. */
const MAX_AUDIT_DETAIL = 500;

/**
 * Gỡ MỌI ký tự điều khiển (charCode < 0x20 và 0x7F) — kể cả xuống dòng.
 * Ký tự điều khiển có thể dùng để giả mạo log hoặc phá định dạng bảng.
 */
function stripControlChars(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    out += input[i];
  }
  return out;
}

/**
 * Phát hiện chuỗi "trông giống" một cặp thông tin đăng nhập: có ký tự `|`
 * ngăn cách hai token KHÔNG chứa khoảng trắng (dạng `acc|pass`).
 *
 * Đây là lưới an toàn phòng khi có ai đó lỡ truyền nhầm nội dung stock vào audit.
 */
function looksLikeCredentialPair(input: string): boolean {
  const parts = input.split("|");
  if (parts.length !== 2) return false;
  const left = parts[0];
  const right = parts[1];
  if (left === undefined || right === undefined) return false;
  const nonSpace = (s: string): boolean => s.trim() !== "" && !/\s/.test(s.trim());
  return nonSpace(left) && nonSpace(right);
}

/** Giá trị thay thế khi `detail` bị nghi chứa cặp acc|pass. */
const REDACTED = "[redacted]";

/**
 * Ghi một dòng vào `audit_log`.
 *
 * Quy tắc an toàn (bắt buộc):
 * - Dùng PREPARED STATEMENT + bound params. KHÔNG nối chuỗi, KHÔNG template
 *   string trong SQL (chống SQL injection và chống rò rỉ định dạng).
 * - `detail` bị gỡ ký tự điều khiển và cắt còn tối đa 500 ký tự; nếu null /
 *   undefined thì lưu NULL.
 * - Nếu `detail` trông giống cặp acc|pass (có `|` ngăn hai token không khoảng
 *   trắng) thì BỎ nội dung, lưu "[redacted]" — không bao giờ để lọt vào DB.
 * - KHÔNG BAO GIỜ ném lỗi: mọi lỗi được nuốt và ghi qua `logLine()`, để việc
 *   ghi log không thể làm hỏng một request đang chạy.
 */
export async function writeAudit(db: D1Database, row: AuditRow): Promise<void> {
  try {
    // --- Chuẩn hoá action ---
    const actionRaw = typeof row.action === "string" ? row.action : "";
    const action = stripControlChars(actionRaw).trim().slice(0, 100);

    // --- Chuẩn hoá detail ---
    let detail: string | null = null;
    const rawDetail = row.detail;
    if (rawDetail !== null && rawDetail !== undefined) {
      const cleaned = stripControlChars(String(rawDetail));
      detail = looksLikeCredentialPair(cleaned) ? REDACTED : cleaned.slice(0, MAX_AUDIT_DETAIL);
    }

    // --- Chuẩn hoá ip ---
    let ip: string | null = null;
    const rawIp = row.ip;
    if (rawIp !== null && rawIp !== undefined) {
      const cleanedIp = stripControlChars(String(rawIp)).trim();
      ip = cleanedIp === "" ? null : cleanedIp.slice(0, MAX_IP_LENGTH);
    }

    // created_at: nếu người gọi không truyền thì để SQLite tự điền datetime('now').
    if (typeof row.created_at === "string" && row.created_at.trim() !== "") {
      await db
        .prepare("INSERT INTO audit_log (action, detail, ip, created_at) VALUES (?, ?, ?, ?)")
        .bind(action, detail, ip, row.created_at.trim())
        .run();
    } else {
      await db
        .prepare("INSERT INTO audit_log (action, detail, ip) VALUES (?, ?, ?)")
        .bind(action, detail, ip)
        .run();
    }
  } catch (err) {
    // Ghi audit lỗi KHÔNG được phá request. Chỉ log phần mô tả lỗi,
    // tuyệt đối không log payload hay nội dung stock.
    safeLog("writeAudit failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Ghi log có tiền tố `[shop-dashboard]`.
 *
 * CẢNH BÁO: người gọi TUYỆT ĐỐI KHÔNG được truyền payload thô, mật khẩu,
 * token, hay nội dung stock (acc|pass) vào đây — log Cloudflare có thể bị
 * đọc bởi bên thứ ba. Chỉ log mã lỗi, số liệu tổng hợp, IP, action.
 */
export function logLine(...parts: unknown[]): void {
  safeLog(...parts);
}

/**
 * So sánh hai chuỗi theo thời gian HẰNG SỐ (constant-time).
 *
 * Không dùng `===`, không dùng `localeCompare`, không return sớm khi gặp byte
 * khác nhau đầu tiên. Cách làm:
 * - Mã hoá cả hai chuỗi sang mảng byte UTF-8.
 * - Duyệt đúng `max(a.length, b.length)` vòng lặp (số vòng chỉ phụ thuộc độ dài,
 *   không phụ thuộc nội dung), XOR từng byte (byte thiếu coi như 0) và cộng dồn
 *   vào `diff`.
 * - Trộn thêm hiệu độ dài bằng `(a.length ^ b.length) !== 0` để độ dài khác nhau
 *   cũng cho kết quả false mà không return sớm.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;

  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);

  const max = ba.length > bb.length ? ba.length : bb.length;

  let diff = 0;
  for (let i = 0; i < max; i++) {
    const x = i < ba.length ? (ba[i] as number) : 0;
    const y = i < bb.length ? (bb[i] as number) : 0;
    diff |= x ^ y;
  }

  // Trộn độ dài vào kết quả: khác độ dài ⇒ chắc chắn false.
  diff |= ((ba.length ^ bb.length) !== 0 ? 1 : 0) as number;

  return diff === 0;
}
