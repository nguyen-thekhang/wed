/**
 * src/auth.ts — Xác thực cho shop-dashboard (Cloudflare Workers).
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH CỦA DỰ ÁN:
 *   Bảng `stock` bên DB bán hàng có cột `content` chứa cặp `acc|pass` thật.
 *   Module này TUYỆT ĐỐI KHÔNG đọc / không sync / không log / không trả về cột đó.
 *   Ở đây chỉ có: mật khẩu admin (PBKDF2), phiên đăng nhập (HMAC), rate limit theo IP.
 *
 * Module này chỉ dùng Web Crypto (crypto.subtle) — KHÔNG dùng node:crypto, KHÔNG thư viện ngoài.
 */

import { writeAudit, type Env } from "./lib/response";

// =====================================================================
// Hằng số
// =====================================================================

/** Số lần đăng nhập sai tối đa cho mỗi IP trong 1 cửa sổ thời gian. */
export const MAX_FAILED_LOGINS = 5;

/** Cửa sổ rate limit: 900 giây = 15 phút. */
export const LOGIN_WINDOW_SECONDS = 900;

/**
 * Số vòng lặp PBKDF2-SHA256.
 * Yêu cầu dự án: >= 100.000 vòng. 150.000 vòng là mức cân bằng giữa an toàn
 * và thời gian CPU cho phép của Worker.
 */
export const PBKDF2_ITERATIONS = 150000;

/** Số vòng tối thiểu chấp nhận được khi đọc hash cũ (legacy) từ nơi khác. */
const MIN_ACCEPTED_ITERATIONS = 100000;

/** Độ dài khoá dẫn xuất (byte) và salt (byte). */
const PBKDF2_KEY_BYTES = 32;
const SALT_BYTES = 16;

/** Trần kích thước giá trị cookie đọc vào (chống header khổng lồ). */
const MAX_COOKIE_VALUE_LENGTH = 4096;

/** Trần kích thước token phiên chấp nhận (payload + chữ ký base64url). */
const MAX_TOKEN_LENGTH = 4096;

/** TTL phiên mặc định: 43200 giây = 12 giờ. */
const DEFAULT_SESSION_TTL_SECONDS = 43200;

/** Số IP tối đa cho phép trong một lần mở khoá thủ công. */
const MAX_UNLOCK_IPS = 20;

/** Độ dài tối đa của 1 chuỗi IP/hostname trong yêu cầu mở khoá. */
const MAX_IP_LENGTH = 64;

/** Chủ thể cố định của phiên (dashboard chỉ có 1 admin). */
const SESSION_SUBJECT = "admin";

/** Tên cookie mặc định khi env.SESSION_COOKIE trống. */
const DEFAULT_COOKIE_NAME = "shop_session";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// =====================================================================
// Tiện ích nội bộ: hex / base64url / so sánh hằng thời gian
// =====================================================================

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

/** Chuyển hex -> byte; trả null nếu chuỗi không phải hex hợp lệ (không ném lỗi). */
function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== "string") return null;
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    out[i] = byte;
  }
  return out;
}

/** Uint8Array -> chuỗi base64url (không padding). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Chuỗi base64url (có/không padding) -> Uint8Array; trả null nếu sai định dạng. */
function base64UrlToBytes(input: string): Uint8Array | null {
  if (typeof input !== "string" || input.length === 0) return null;
  // Chỉ nhận bảng chữ cái base64url, sau đó bù padding cho đủ bội số 4 (atob cần).
  if (!/^[A-Za-z0-9\-_]+$/.test(input)) return null;
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i) & 0xff;
    }
    return out;
  } catch {
    return null;
  }
}

function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(textEncoder.encode(text));
}

function base64UrlToUtf8(input: string): string | null {
  const bytes = base64UrlToBytes(input);
  if (bytes === null) return null;
  try {
    return textDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * So sánh hằng thời gian (constant-time) giữa 2 mảng byte.
 * Chạy XOR-fold qua ĐỘ DÀI CỐ ĐỊNH (max của 2 độ dài) và gộp cả khác biệt độ dài
 * vào biến diff, nên thời gian chạy không phụ thuộc vị trí byte sai đầu tiên.
 * TUYỆT ĐỐI không dùng `===` để so hash/mật khẩu.
 */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const length = a.length > b.length ? a.length : b.length;
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    const x = i < a.length ? (a[i] as number) : 0;
    const y = i < b.length ? (b[i] as number) : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Import khoá HMAC-SHA256 từ SESSION_SECRET. Trả null nếu secret thiếu/rỗng. */
async function importHmacKey(env: Env): Promise<CryptoKey | null> {
  try {
    const secret = env && typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : "";
    if (secret.length === 0) return null;
    return await crypto.subtle.importKey(
      "raw",
      textEncoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  } catch {
    return null;
  }
}

// =====================================================================
// 1) PBKDF2 — băm & kiểm tra mật khẩu
// =====================================================================

/**
 * Băm mật khẩu bằng PBKDF2-SHA256.
 *
 * - PBKDF2 lặp >= 100.000 vòng (mặc định 150.000) để làm chậm brute-force.
 * - Salt riêng cho từng mật khẩu: 16 byte ngẫu nhiên sinh bằng crypto.getRandomValues,
 *   nhờ vậy 2 người cùng mật khẩu vẫn ra hash khác nhau (chống rainbow table).
 * - Khoá dẫn xuất 32 byte.
 * - Định dạng trả về: "pbkdf2$<iterations>$<saltHex>$<hashHex>".
 *
 * KHÔNG bao giờ ghi log mật khẩu hay hash ra ngoài.
 */
export async function hashPassword(
  password: string,
  saltHex?: string,
  iterations?: number,
): Promise<string> {
  const pass = typeof password === "string" ? password : "";

  // Số vòng: ưu tiên tham số truyền vào, chỉ nhận giá trị nguyên >= 100.000.
  let iter = PBKDF2_ITERATIONS;
  if (typeof iterations === "number" && Number.isFinite(iterations)) {
    const rounded = Math.floor(iterations);
    if (rounded >= MIN_ACCEPTED_ITERATIONS) iter = rounded;
  }

  // Salt: dùng saltHex nếu hợp lệ (hex, >= 8 byte), ngược lại sinh salt mới 16 byte.
  let salt: Uint8Array;
  const provided = typeof saltHex === "string" ? hexToBytes(saltHex) : null;
  if (provided !== null && provided.length >= 8) {
    salt = provided;
  } else {
    salt = new Uint8Array(SALT_BYTES);
    crypto.getRandomValues(salt);
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(pass),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    keyMaterial,
    PBKDF2_KEY_BYTES * 8,
  );

  return `pbkdf2$${iter}$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(derived))}`;
}

/**
 * Kiểm tra mật khẩu với chuỗi đã lưu dạng "pbkdf2$<iterations>$<saltHex>$<hashHex>".
 *
 * - Sai định dạng -> trả false, KHÔNG bao giờ ném lỗi.
 * - Tính lại bằng ĐÚNG salt và ĐÚNG số vòng ghi trong chuỗi đã lưu.
 * - So sánh bằng so sánh hằng thời gian trên byte (không so chuỗi hex bằng ===).
 * - Nếu hash cũ có iterations < 100.000 thì vẫn chấp nhận kiểm tra (coi là legacy),
 *   nhưng đây là trường hợp cần nâng cấp: hash mới sinh ra luôn >= 100.000 vòng.
 * - KHÔNG bao giờ log mật khẩu hay hash.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (typeof password !== "string" || typeof stored !== "string") return false;
    if (password.length === 0 || stored.length === 0) return false;

    const parts = stored.split("$");
    if (parts.length !== 4) return false;

    const algo = parts[0];
    const iterRaw = parts[1];
    const saltHex = parts[2];
    const hashHex = parts[3];
    if (algo !== "pbkdf2" || iterRaw === undefined || saltHex === undefined || hashHex === undefined) {
      return false;
    }

    const iter = Number.parseInt(iterRaw, 10);
    if (!Number.isFinite(iter) || iter < 1) return false;
    // Legacy: iterations thấp hơn chuẩn hiện tại vẫn phải xác minh được (không crash);
    // hash mới luôn được sinh với >= 100.000 vòng.
    if (iter < MIN_ACCEPTED_ITERATIONS) {
      // không return false — chỉ là hash cũ, vẫn kiểm tra bình thường.
    }

    const salt = hexToBytes(saltHex);
    const expected = hexToBytes(hashHex);
    if (salt === null || salt.length < 8) return false;
    if (expected === null || expected.length !== PBKDF2_KEY_BYTES) return false;

    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      textEncoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const derived = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
      keyMaterial,
      PBKDF2_KEY_BYTES * 8,
    );

    return timingSafeEqualBytes(new Uint8Array(derived), expected);
  } catch {
    // Không lộ stack trace, không log bí mật: mọi lỗi đều coi như xác thực thất bại.
    return false;
  }
}

// =====================================================================
// 2) Phiên đăng nhập — token stateless có chữ ký HMAC-SHA256
// =====================================================================

/**
 * Rút gọn IP trước khi nhét vào cookie.
 *
 * Lý do (bảo mật & riêng tư): cookie phiên được trình duyệt gửi đi mỗi request và
 * người dùng có thể đọc/sehen nội dung payload (nó chỉ được ký, KHÔNG mã hoá).
 * Vì vậy ta KHÔNG lưu IP đầy đủ trong cookie; chỉ lưu dạng thô:
 *   - IPv4  -> 2 octet đầu (ví dụ 203.113.0.0)
 *   - IPv6  -> 2 nhóm đầu
 *   - khác  -> "0.0"
 * Giá trị này chỉ dùng cho mục đích thống kê/đối chiếu thô, không phải danh tính.
 */
function coarseIp(ip: string): string {
  if (typeof ip !== "string" || ip.length === 0) return "0.0";
  const value = ip.trim();
  if (value.length === 0) return "0.0";

  if (value.includes(":")) {
    // IPv6 (hoặc IPv4-mapped): chỉ giữ 2 nhóm đầu.
    const groups = value.split(":").filter((g) => g.length > 0);
    if (groups.length === 0) return "0.0";
    return groups.slice(0, 2).join(":") + "::";
  }

  const octets = value.split(".");
  if (octets.length === 4) {
    return `${octets[0]}.${octets[1]}.0.0`;
  }
  return "0.0";
}

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
  ip: string;
}

/** Tạo token phiên mới: base64url(payload JSON) + "." + base64url(HMAC-SHA256). */
export async function issueSession(env: Env, ip: string): Promise<string> {
  try {
    const key = await importHmacKey(env);
    if (key === null) return "";

    const iat = nowEpochSeconds();
    const ttl = sessionTtlSeconds(env);
    const payload: SessionPayload = {
      sub: SESSION_SUBJECT,
      iat,
      exp: iat + ttl,
      // IP chỉ lưu dạng thô (2 octet đầu / 2 nhóm đầu) — xem chú thích coarseIp().
      ip: coarseIp(ip),
    };

    const payloadB64 = utf8ToBase64Url(JSON.stringify(payload));
    const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payloadB64));
    return `${payloadB64}.${bytesToBase64Url(new Uint8Array(signature))}`;
  } catch {
    return "";
  }
}

/**
 * Kiểm tra token phiên. Trả false (không ném lỗi) với: null/rỗng/sai định dạng/
 * chữ ký sai/hết hạn/secret thiếu.
 *
 * Dùng crypto.subtle.verify với khoá HMAC (kiểm tra chữ ký hằng thời gian),
 * sau đó mới đọc payload để kiểm tra exp/iat.
 */
export async function verifySession(env: Env, token: string | null): Promise<boolean> {
  try {
    if (typeof token !== "string") return false;
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;

    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) return false;

    const payloadB64 = token.slice(0, dot);
    const signatureB64 = token.slice(dot + 1);
    if (payloadB64.length === 0 || signatureB64.length === 0) return false;

    const signature = base64UrlToBytes(signatureB64);
    if (signature === null) return false;

    const key = await importHmacKey(env);
    if (key === null) return false;

    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      textEncoder.encode(payloadB64),
    );
    if (!ok) return false;

    // Chữ ký hợp lệ -> mới tin payload và kiểm tra thời hạn.
    const raw = base64UrlToUtf8(payloadB64);
    if (raw === null) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;

    const payload = parsed as Partial<SessionPayload>;
    if (payload.sub !== SESSION_SUBJECT) return false;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return false;
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) return false;
    // exp là epoch giây; cộng 1 giây dung sai cho lệch đồng hồ rất nhỏ.
    if (payload.exp + 1 <= nowEpochSeconds()) return false;
    // Token phát hành ở tương lai (đồng hồ sai) -> từ chối.
    if (payload.iat - 60 > nowEpochSeconds()) return false;
    // Không cho phiên sống dài hơn TTL cấu hình (chống payload bị sửa, dù đã có chữ ký).
    const ttl = sessionTtlSeconds(env);
    if (payload.exp - payload.iat > ttl + 60) return false;

    return true;
  } catch {
    return false;
  }
}

// =====================================================================
// 3) Cookie
// =====================================================================

/** Tên cookie phiên: env.SESSION_COOKIE hoặc "shop_session". */
export function sessionCookieName(env: Env): string {
  const raw = env && typeof env.SESSION_COOKIE === "string" ? env.SESSION_COOKIE.trim() : "";
  // Chỉ nhận tên cookie hợp lệ theo RFC 6265; ngược lại quay về mặc định.
  if (raw.length > 0 && raw.length <= 64 && /^[A-Za-z0-9_\-.]+$/.test(raw)) return raw;
  return DEFAULT_COOKIE_NAME;
}

/** TTL phiên (giây): env.SESSION_TTL_SECONDS nếu hợp lệ và > 0, ngược lại 43200 (12 giờ). */
export function sessionTtlSeconds(env: Env): number {
  const raw = env && typeof env.SESSION_TTL_SECONDS === "string" ? env.SESSION_TTL_SECONDS.trim() : "";
  if (raw.length === 0) return DEFAULT_SESSION_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_TTL_SECONDS;
  // Chặn TTL vô lý (quá 1 năm) để tránh phiên sống vĩnh viễn do cấu hình sai.
  if (parsed > 31536000) return 31536000;
  return parsed;
}

/**
 * Chuỗi Set-Cookie cho phiên đăng nhập.
 *
 * Cờ cookie (quan trọng, không được bỏ):
 *   - HttpOnly : JavaScript không đọc được cookie -> chống XSS đánh cắp phiên.
 *   - Secure   : chỉ gửi qua HTTPS.
 *   - SameSite=Strict : chặn gửi cookie từ request cross-site -> chống CSRF.
 *   - Path=/   : áp dụng cho toàn site.
 */
export function sessionCookie(env: Env, token: string, maxAgeSeconds: number): string {
  const name = sessionCookieName(env);
  const safeToken = typeof token === "string" ? token.replace(/[\r\n;]/g, "") : "";
  const maxAge = Number.isFinite(maxAgeSeconds) ? Math.max(0, Math.floor(maxAgeSeconds)) : 0;
  return `${name}=${safeToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

/** Xoá cookie phiên (Max-Age=0). */
export function clearSessionCookie(env: Env): string {
  const name = sessionCookieName(env);
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/**
 * Đọc 1 cookie từ header `Cookie`. Không bao giờ ném lỗi.
 * - Tách theo ";", trim, so khớp CHÍNH XÁC tên cookie (không so khớp một phần).
 * - decodeURIComponent có bọc try/catch (cookie hỏng -> bỏ qua).
 * - Cắt trần 4096 ký tự để tránh header khổng lồ.
 */
export function readCookie(req: Request, name: string): string | null {
  try {
    if (req === null || typeof req !== "object") return null;
    if (typeof name !== "string" || name.length === 0) return null;

    const header = req.headers?.get("Cookie");
    if (!header || header.length === 0) return null;

    const parts = header.split(";");
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const key = part.slice(0, eq).trim();
      if (key !== name) continue;
      let value = part.slice(eq + 1).trim();
      if (value.length > MAX_COOKIE_VALUE_LENGTH) value = value.slice(0, MAX_COOKIE_VALUE_LENGTH);
      if (value.length === 0) return null;
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** True nếu request có phiên hợp lệ. Không bao giờ ném lỗi. */
export async function requireAuth(req: Request, env: Env): Promise<boolean> {
  try {
    const token = readCookie(req, sessionCookieName(env));
    if (token === null) return false;
    return await verifySession(env, token);
  } catch {
    return false;
  }
}

// =====================================================================
// 4) Rate limit đăng nhập: 5 lần sai / 15 phút / IP
// =====================================================================

/**
 * Số lần đăng nhập sai của IP trong cửa sổ 900 giây gần nhất.
 *
 * Mọi truy vấn đều dùng prepared statement với tham số bind (?1, ?2...),
 * KHÔNG nối chuỗi, KHÔNG template literal vào câu SQL -> không có SQL injection.
 * Dọn rác định kỳ: xoá các bản ghi cũ hơn 4 lần cửa sổ (60 phút) để bảng không phình.
 */
export async function failedLoginCount(db: D1Database, ip: string): Promise<number> {
  try {
    const since = nowEpochSeconds() - LOGIN_WINDOW_SECONDS;
    const staleBefore = nowEpochSeconds() - LOGIN_WINDOW_SECONDS * 4;

    try {
      await db
        .prepare("DELETE FROM login_attempts WHERE created_at < ?1")
        .bind(staleBefore)
        .run();
    } catch {
      // Dọn rác thất bại không được làm hỏng việc đếm.
    }

    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?1 AND created_at >= ?2")
      .bind(ip, since)
      .first<{ n: number }>();

    const n = row && typeof row.n === "number" ? row.n : 0;
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  } catch {
    // Fail-closed ở tầng gọi: lỗi DB trả 0 để không tự khoá người dùng oan.
    return 0;
  }
}

/** Ghi nhận 1 lần đăng nhập sai cho IP (epoch giây). Không ném lỗi. */
export async function recordFailedLogin(db: D1Database, ip: string): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO login_attempts (ip, created_at) VALUES (?1, ?2)")
      .bind(ip, nowEpochSeconds())
      .run();
  } catch {
    // Bỏ qua: không để lỗi ghi log làm sập luồng đăng nhập.
  }
}

/** Xoá toàn bộ lần đăng nhập sai của 1 IP (dùng khi đăng nhập thành công). */
export async function clearFailedLogins(db: D1Database, ip: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM login_attempts WHERE ip = ?1").bind(ip).run();
  } catch {
    // Bỏ qua.
  }
}

/**
 * Regex "dễ dãi" cho IP/hostname do admin nhập tay: IPv4, IPv6 hoặc hostname.
 * Mục đích chỉ là chặn rác/ký tự lạ trước khi đưa vào prepared statement.
 */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9\-.]{0,62}[A-Za-z0-9])?$/;

function isValidIpOrHost(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0 || v.length > MAX_IP_LENGTH) return false;

  const v4 = IPV4_RE.exec(v);
  if (v4 !== null) {
    for (let i = 1; i <= 4; i++) {
      const octet = Number.parseInt(v4[i] as string, 10);
      if (!Number.isFinite(octet) || octet < 0 || octet > 255) return false;
    }
    return true;
  }

  if (v.includes(":")) {
    if (!IPV6_RE.test(v)) return false;
    // Phải có ít nhất 2 nhóm ':' để tránh nhận chuỗi kiểu "::" rỗng nghĩa.
    return v.split(":").some((g) => g.length > 0);
  }

  return HOST_RE.test(v);
}

/**
 * Admin tự mở khoá đăng nhập cho chính mình (escape hatch khi bị khoá do nhập sai 5 lần).
 *
 * YÊU CẦU: người gọi PHẢI đã gọi requireAuth() thành công trước (route /api/admin/unlock-login).
 *
 * - `ips`: mảng tối đa 20 chuỗi, mỗi chuỗi phải khớp regex IP/hostname và dài <= 64 ký tự.
 *   Phần tử không hợp lệ bị BỎ QUA (không báo lỗi, không chèn vào SQL).
 * - `selfIp` LUÔN được xoá như mức cơ bản, kể cả khi `ips` rỗng hoặc toàn rác.
 * - Mỗi IP dùng 1 prepared DELETE, cộng dồn số dòng bị xoá.
 * - Ghi 1 dòng audit_log action='unlock' với detail tiếng Việt; KHÔNG chứa token/mật khẩu.
 * - Trả về tổng số dòng đã xoá. Không bao giờ ném lỗi.
 */
export async function unlockLogin(db: D1Database, ips: string[], selfIp: string): Promise<number> {
  try {
    // Danh sách IP cần xoá: bắt đầu bằng selfIp (luôn có), rồi các IP hợp lệ, đã khử trùng lặp.
    const targets: string[] = [];
    const seen = new Set<string>();

    const addTarget = (value: unknown): void => {
      if (targets.length >= MAX_UNLOCK_IPS + 1) return;
      if (!isValidIpOrHost(value)) return;
      const key = value.trim();
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(key);
    };

    addTarget(selfIp);

    if (Array.isArray(ips)) {
      let accepted = 0;
      for (const candidate of ips) {
        if (accepted >= MAX_UNLOCK_IPS) break;
        const before = targets.length;
        addTarget(candidate);
        if (targets.length > before) accepted++;
      }
    }

    let cleared = 0;
    for (const target of targets) {
      try {
        const result = await db
          .prepare("DELETE FROM login_attempts WHERE ip = ?1")
          .bind(target)
          .run();
        const changes = result?.meta?.changes;
        if (typeof changes === "number" && Number.isFinite(changes) && changes > 0) {
          cleared += Math.floor(changes);
        }
      } catch {
        // 1 IP lỗi không được chặn các IP còn lại.
      }
    }

    // Audit: chỉ ghi số lượng + IP người thực hiện, tuyệt đối không ghi token/mật khẩu.
    const detail = `mở khoá đăng nhập cho ${cleared} IP`;
    try {
      await writeAudit(db, { action: "unlock", detail, ip: selfIp });
    } catch {
      // Audit lỗi không được làm hỏng kết quả trả về.
    }

    return cleared;
  } catch {
    return 0;
  }
}
