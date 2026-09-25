/**
 * =====================================================================
 * src/api/auth-routes.ts — POST /api/login và POST /api/logout.
 * =====================================================================
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH (CONTRACT.md §0):
 *   Bảng `stock` bên DB bán hàng có cột chứa cặp `acc|pass` thật.
 *   File này KHÔNG đọc, KHÔNG lưu, KHÔNG log và KHÔNG trả về cột đó.
 *   Mật khẩu admin ở đây là secret của CHÍNH dashboard (env.ADMIN_PASSWORD),
 *   hoàn toàn tách biệt với dữ liệu bán hàng.
 *
 * QUY TẮC VÀNG VỀ LOG:
 *   KHÔNG BAO GIỜ ghi log mật khẩu người dùng gửi lên, KHÔNG echo nó lại,
 *   KHÔNG đưa nó vào audit_log, KHÔNG đưa token phiên vào log/audit.
 *
 * THỨ TỰ XỬ LÝ CỦA LOGIN (không được đảo):
 *   POST-only → IP → RATE LIMIT → đọc body (có chặn kích thước)
 *   → kiểm mật khẩu → thành công/thất bại → audit → Set-Cookie.
 *   Rate limit đứng TRƯỚC khi đọc body để request bị chặn không tốn CPU
 *   băm PBKDF2 (150.000 vòng) — đó cũng là một vector DoS.
 */

import {
  clientIp,
  jsonError,
  jsonOk,
  noStore,
  serverError,
  timingSafeEqualStr,
  writeAudit,
  type Env,
} from "../lib/response";

import {
  MAX_FAILED_LOGINS,
  LOGIN_WINDOW_SECONDS,
  clearFailedLogins,
  clearSessionCookie,
  failedLoginCount,
  issueSession,
  recordFailedLogin,
  sessionCookie,
  sessionTtlSeconds,
  verifyPassword,
} from "../auth";

// =====================================================================
// Hằng số
// =====================================================================

/** Trần kích thước body của /api/login: 4 KB (mật khẩu thật chỉ vài chục byte). */
const MAX_LOGIN_BODY_BYTES = 4096;

/** Độ dài mật khẩu chấp nhận: 1..200 ký tự. */
const MIN_PASSWORD_LENGTH = 1;
const MAX_PASSWORD_LENGTH = 200;

/** Tiền tố log thống nhất của toàn bộ Worker. */
const LOG_PREFIX = "[shop-dashboard]";

/** Tiền tố nhận dạng hash PBKDF2 do `hashPassword()` sinh ra. */
const PBKDF2_PREFIX = "pbkdf2$";

/**
 * Regex "hợp lệ hoá nhẹ" cho IP/hostname do admin gửi lên ở route mở khoá.
 *
 * Vì sao export từ đây: router (`src/index.ts`) dùng nó để lọc danh sách IP
 * trước khi gọi `unlockLogin(env.DB, ips, selfIp)` của src/auth.ts. Router giữ
 * phần điều phối HTTP, còn quy tắc "chuỗi nào được coi là IP" được khai báo
 * một lần duy nhất ở module auth để hai nơi không lệch nhau.
 *
 * Chỉ cho phép chữ số thập lục phân, dấu ':' và '.' — tức IPv4/IPv6 hợp lệ về
 * mặt ký tự; mọi thứ khác (khoảng trắng, dấu nháy, ';', '%', '/') bị loại
 * trước khi chuỗi đó có cơ hội đi vào câu SQL của D1.
 */
export const UNLOCK_IP_RE: RegExp = /^[0-9a-fA-F:.]{1,64}$/;

// =====================================================================
// Tiện ích nội bộ
// =====================================================================

/** Ghi log lỗi nội bộ. KHÔNG BAO GIỜ truyền mật khẩu / token vào đây. */
function logError(where: string, err: unknown): void {
  console.error(`${LOG_PREFIX} ${where}`, err instanceof Error ? err.message : "?");
}

/** Lấy IP người gọi, không bao giờ ném lỗi (dùng được cả với Request giả trong test). */
function safeClientIp(request: Request): string {
  try {
    return clientIp(request);
  } catch {
    return "0.0.0.0";
  }
}

/**
 * Ghi audit nhưng KHÔNG BAO GIỜ làm hỏng luồng đăng nhập.
 * `writeAudit` của lib/response đã tự nuốt lỗi; bọc thêm một lớp để chắc chắn
 * rằng lỗi bất ngờ (DB chưa migrate...) không đổi kết quả HTTP.
 */
async function auditSafe(db: D1Database, action: string, detail: string, ip: string): Promise<void> {
  try {
    await writeAudit(db, { action, detail, ip });
  } catch (err) {
    logError("audit failed", err);
  }
}

/**
 * So sánh hai chuỗi theo thời gian HẰNG SỐ.
 *
 * Bọc lại `timingSafeEqualStr` của lib/response để module này chỉ có MỘT đường
 * so sánh bí mật duy nhất. TUYỆT ĐỐI không dùng `===` cho mật khẩu: phép so
 * sánh thường dừng ngay ở ký tự đầu tiên khác nhau nên thời gian chạy rò rỉ
 * dần từng ký tự, cho phép dò mật khẩu theo kiểu timing attack.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return timingSafeEqualStr(a, b);
}

/** Đọc 1 field text từ body `application/x-www-form-urlencoded`. */
function readFormField(body: string, field: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(body);
  } catch {
    return null;
  }
  const value = params.get(field);
  return value === null ? null : value;
}

/**
 * Bóc mật khẩu từ body request.
 *
 * Nhận CẢ HAI dạng để form HTML thuần (không JS) vẫn đăng nhập được:
 *   - `application/json` (dashboard dùng `fetch`): `{"password":"..."}`
 *   - `application/x-www-form-urlencoded` (form HTML thường): `password=...`
 * Chấp nhận cả FormData thật nếu Content-Type là multipart.
 *
 * @returns chuỗi mật khẩu, hoặc `null` nếu body không dùng được / thiếu field.
 */
async function extractPassword(request: Request): Promise<string | null> {
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();

  // --- multipart (một số client gửi form-data; hiếm nhưng vẫn chấp nhận) ---
  if (contentType.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch (err) {
      logError("login multipart parse failed", err);
      return null;
    }
    const value = form.get("password");
    return typeof value === "string" ? value : null;
  }

  // --- mọi dạng còn lại: đọc text thô (đã bị chặn trần 4 KB ở handler) ---
  let body: string;
  try {
    body = await request.text();
  } catch (err) {
    logError("login body read failed", err);
    return null;
  }

  if (body.length === 0) return null;

  // form-urlencoded (kể cả khi Content-Type bị thiếu nhưng body có dạng key=value)
  if (contentType.includes("application/x-www-form-urlencoded") || body.startsWith("password=")) {
    return readFormField(body, "password");
  }

  // JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>)["password"];
  return typeof value === "string" ? value : null;
}

/**
 * Kiểm tra mật khẩu gửi lên có khớp secret đang cấu hình không.
 *
 * SECRET CÓ THỂ Ở HAI DẠNG (cả hai đều được hỗ trợ có chủ đích):
 *   (a) Chuỗi thuần — cách đơn giản nhất cho dashboard 1 người dùng:
 *         wrangler secret put ADMIN_PASSWORD      # dán mật khẩu thô
 *       Khi đó ta so sánh bằng `timingSafeStringEqual` (hằng thời gian).
 *   (b) Hash PBKDF2 dạng "pbkdf2$<iterations>$<saltHex>$<hashHex>" do
 *       `hashPassword()` sinh ra. Cách này an toàn hơn vì secret nằm trong
 *       Cloudflare chỉ là hash, không phải mật khẩu gốc. Cách tạo:
 *         node --input-type=module -e "import('./src/auth.ts').then(...)"
 *       hoặc gọn hơn, dùng chính hàm đã export (chạy trong wrangler/workerd):
 *         const h = await hashPassword("mật-khẩu-của-bạn"); console.log(h);
 *       rồi: wrangler secret put ADMIN_PASSWORD   # dán chuỗi pbkdf2$... vừa in
 *       Khi đó ta kiểm tra bằng `verifyPassword()` (cũng hằng thời gian).
 *
 * Nhận dạng bằng tiền tố "pbkdf2$" — xem `PBKDF2_PREFIX`.
 *
 * KHÔNG BAO GIỜ log `provided` hay `stored`.
 */
async function passwordMatches(env: Env, provided: string): Promise<boolean> {
  const stored = typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";

  if (stored.startsWith(PBKDF2_PREFIX)) {
    // (b) Hash PBKDF2: verifyPassword tự tính lại và so sánh hằng thời gian.
    return await verifyPassword(provided, stored);
  }

  // (a) Chuỗi thuần trong secret.
  return timingSafeStringEqual(provided, stored);
}

// =====================================================================
// POST /api/login
// =====================================================================

/**
 * POST /api/login
 *
 * Trả 200 `{ok:true}` + Set-Cookie phiên khi đúng mật khẩu.
 * Mọi trường hợp sai đều trả CÙNG một thông báo `invalid_credentials` để không
 * rò rỉ thông tin (không cho biết mật khẩu "gần đúng" hay tài khoản có tồn tại).
 */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  try {
    // (1) Chỉ nhận POST.
    if (request.method !== "POST") {
      const res = jsonError("method_not_allowed", "Chỉ hỗ trợ POST", 405);
      const headers = new Headers(res.headers);
      headers.set("Allow", "POST");
      return new Response(res.body, { status: 405, headers });
    }

    // (2) IP dùng cho rate limit + audit.
    const ip = safeClientIp(request);

    // (3) RATE LIMIT ĐẶT TRƯỚC TIÊN: 5 lần sai / 15 phút / IP.
    //     Cửa sổ 900 giây (LOGIN_WINDOW_SECONDS), trần 5 (MAX_FAILED_LOGINS).
    //     Khi IP đã chạm trần, chặn ngay ở đây — TRƯỚC khi đọc body và trước
    //     khi băm PBKDF2, nên kẻ dò mật khẩu không thể ép Worker tiêu tốn CPU.
    //     Bộ đếm nằm trong bảng login_attempts, khoá theo IP.
    const attempts = await failedLoginCount(env.DB, ip);
    if (attempts >= MAX_FAILED_LOGINS) {
      await auditSafe(env.DB, "login_blocked", "đăng nhập bị chặn do sai quá nhiều lần", ip);
      return jsonError(
        "rate_limited",
        "Sai quá nhiều lần, thử lại sau 15 phút",
        429,
      );
    }

    // (4) Kiểm tra cấu hình TRƯỚC khi đọc body.
    //     Secret rỗng/thiếu = cấu hình sai. TUYỆT ĐỐI không cho phép mật khẩu
    //     rỗng xác thực thành công (nếu không, hệ thống "hở" hoàn toàn khi
    //     admin quên `wrangler secret put`).
    const storedSecret = typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";
    if (storedSecret.length === 0) {
      console.error(
        `${LOG_PREFIX} CẤU HÌNH SAI: ADMIN_PASSWORD trống — từ chối mọi đăng nhập. ` +
          `Hãy chạy: wrangler secret put ADMIN_PASSWORD`,
      );
      return serverError();
    }

    // (4b) Chặn kích thước body BẰNG CẢ HAI cách: header Content-Length (nếu có)
    //      và độ dài thật sau khi đọc (chunked không có Content-Length).
    const contentLengthHeader = request.headers.get("Content-Length");
    if (contentLengthHeader !== null) {
      const declaredLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGIN_BODY_BYTES) {
        return jsonError("bad_request", "Body quá lớn", 400);
      }
    }

    // (5) Đọc body. Hỗ trợ JSON và application/x-www-form-urlencoded để form
    //     HTML thuần cũng đăng nhập được (không cần JavaScript).
    const password = await extractPassword(request);
    if (typeof password !== "string") {
      return jsonError("bad_request", "Thiếu mật khẩu", 400);
    }
    if (password.length > MAX_LOGIN_BODY_BYTES) {
      // Chốt chặn bổ sung: mật khẩu dài bất thường nghĩa là body không như mong đợi.
      return jsonError("bad_request", "Body quá lớn", 400);
    }

    // (6) Mật khẩu phải là chuỗi dài 1..200 ký tự.
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      await auditSafe(env.DB, "login_failed", "đăng nhập thất bại: độ dài mật khẩu không hợp lệ", ip);
      return jsonError("invalid_credentials", "Mật khẩu không đúng", 401);
    }

    // (7) Kiểm tra mật khẩu: chuỗi thuần HOẶC hash "pbkdf2$...".
    const ok = await passwordMatches(env, password);

    if (!ok) {
      // (7b) THẤT BẠI: ghi nhận 1 lần sai + audit. Detail TUYỆT ĐỐI không chứa
      //      mật khẩu người dùng vừa gửi (kể cả đã cắt ngắn hay băm).
      //      Dùng CHUNG thông báo với mọi trường hợp sai để không rò rỉ thông tin.
      await recordFailedLogin(env.DB, ip);
      await auditSafe(env.DB, "login_failed", "đăng nhập thất bại: mật khẩu không đúng", ip);
      return jsonError("invalid_credentials", "Mật khẩu không đúng", 401);
    }

    // (8) THÀNH CÔNG: xoá bộ đếm sai của IP, phát hành phiên, gắn cookie.
    await clearFailedLogins(env.DB, ip);

    const token = await issueSession(env, ip);
    if (token.length === 0) {
      // issueSession trả "" khi thiếu SESSION_SECRET hoặc lỗi crypto.
      // Không thể cấp phiên ⇒ coi là lỗi cấu hình phía server, KHÔNG log token.
      console.error(
        `${LOG_PREFIX} CẤU HÌNH SAI: không phát hành được phiên (kiểm tra SESSION_SECRET).`,
      );
      return serverError();
    }

    const cookie = sessionCookie(env, token, sessionTtlSeconds(env));

    await auditSafe(env.DB, "login", "đăng nhập thành công", ip);

    // Cookie đã có HttpOnly; Secure; SameSite=Strict; Path=/ (xem src/auth.ts).
    return jsonOk({ ok: true }, 200, noStore({ "Set-Cookie": cookie }));
  } catch (err) {
    // Không lộ stack trace; detail lỗi chỉ ghi nội bộ, không chứa mật khẩu/token.
    logError("login failed", err);
    return serverError();
  }
}

// =====================================================================
// POST /api/logout
// =====================================================================

/**
 * POST /api/logout
 *
 * Cố tình KHÔNG yêu cầu phiên hợp lệ: đăng xuất hai lần (hoặc đăng xuất khi
 * cookie đã hết hạn) phải vô hại, luôn trả 200 và luôn xoá cookie.
 *
 * Cũng KHÔNG gọi `clearFailedLogins`: đăng xuất không phải là bằng chứng đã
 * đăng nhập đúng, nên không được phép xoá bộ đếm rate limit (nếu không, kẻ
 * tấn công chỉ cần gọi /api/logout sau mỗi 4 lần sai để thoát rate limit).
 */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  try {
    if (request.method !== "POST") {
      const res = jsonError("method_not_allowed", "Chỉ hỗ trợ POST", 405);
      const headers = new Headers(res.headers);
      headers.set("Allow", "POST");
      return new Response(res.body, { status: 405, headers });
    }

    const ip = safeClientIp(request);
    await auditSafe(env.DB, "logout", "đăng xuất", ip);

    const headers = noStore({ "Set-Cookie": clearSessionCookie(env) });
    return jsonOk({ ok: true }, 200, headers);
  } catch (err) {
    logError("logout failed", err);
    // Kể cả khi audit lỗi, người dùng vẫn phải thoát được: trả 200 + xoá cookie.
    try {
      return jsonOk({ ok: true }, 200, noStore({ "Set-Cookie": clearSessionCookie(env) }));
    } catch {
      return serverError();
    }
  }
}
