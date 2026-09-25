/**
 * =====================================================================
 * src/api/fbcheck.ts — Kiểm tra UID Facebook còn sống (LIVE) hay đã chết (DIE).
 * =====================================================================
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH (CONTRACT.md §0):
 *   Bảng `stock` bên DB bán hàng có cột chứa cặp `acc|pass` thật.
 *   Module này KHÔNG đọc, KHÔNG lưu, KHÔNG log và KHÔNG trả về cột đó.
 *   Ở đây chỉ có MỘT LOẠI SỐ ĐỊNH DANH CÔNG KHAI: UID Facebook (một dãy số).
 *   Người dùng tự dán UID vào; Worker không tự đi tìm UID nào trong DB.
 *
 * ── CÁCH PHÂN LOẠI (đã kiểm chứng thực tế, xem test/fbcheck-test.mjs) ──
 *   Gọi endpoint công khai của Meta, KHÔNG đi kèm cookie/token/đăng nhập:
 *
 *       GET https://graph.facebook.com/v23.0/<uid>/picture?type=normal
 *
 *   KHÔNG theo redirect (`redirect: "manual"`), chỉ đọc status + Location:
 *
 *   • 302 → UID TỒN TẠI.
 *     Meta trả về link ảnh đại diện thật trên `*.fbcdn.net`. Điều này đúng kể cả
 *     với tài khoản khoá riêng tư / không có ảnh — Facebook vẫn tồn tại và vẫn
 *     phục vụ ảnh mặc định (`static.xx.fbcdn.net`).
 *
 *   • 400 → UID KHÔNG TỒN TẠI (đã xoá, hoặc chưa từng có).
 *     Meta trả OAuthException với nội dung "Object with ID '<uid>' does not exist".
 *
 *   • Mọi thứ khác (429, 5xx, lỗi mạng, timeout) → KHÔNG XÁC ĐỊNH.
 *     TUYỆT ĐỐI không coi là DIE. Nói "die" khi chỉ là lỗi mạng là báo cáo sai
 *     — người dùng sẽ xoá nhầm tài khoản đang tốt. Đây là lý do có nhóm thứ ba
 *     `unknown` trong kết quả thay vì gộp thẳng vào die.
 *
 * ── VỀ SAO KHÔNG DÙNG `profile.php` ──
 *   Trang profile không phân biệt được "đã xoá" với "đổi sang riêng tư": cả hai đều
 *   trả 200 kèm `CometErrorRoot` và câu "This content isn't available". Endpoint
 *   `/picture` mới là nơi Meta nói thẳng object có tồn tại hay không.
 *
 * ── TRÁCH NHIỆM ──
 *   • Không dùng cookie, không đăng nhập, không proxy, không bypass CAPTCHA.
 *   • Không gửi tên miền/UID nào của người dùng đi nơi khác ngoài chính Meta.
 *   • Có giới hạn số UID mỗi lần gọi + giới hạn tần suất, để không spam Meta.
 */

import {
  clientIp,
  jsonError,
  jsonOk,
  serverError,
  writeAudit,
  type Env,
} from "../lib/response";
import type { FbCheckResponse, FbUidVerdict } from "./api-types";

// =====================================================================
// Hằng số
// =====================================================================

/** Trần số UID trong MỘT lần gọi. Hợp lý cho việc dán tay từ ảnh chụp màn hình. */
export const MAX_UIDS_PER_REQUEST = 200;

/** Trần kích thước body: 200 UID × 25 ký tự có dư rất nhiều cho khoảng trống. */
const MAX_BODY_BYTES = 64 * 1024;

/** Số request chạy song song tối đa. Thấp vừa đủ để nhanh mà không spam Meta. */
const CONCURRENCY = 6;

/** Mỗi request tới Meta tự hết hạn sau 8 giây. */
const FETCH_TIMEOUT_MS = 8000;

/** Giới hạn tần suất: 20 lần gọi / 10 phút / IP. */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 600;

/** Phiên bản Graph API. Đổi sang bản mới hơn khi Meta bỏ bản cũ. */
const GRAPH_VERSION = "v23.0";

/** User-Agent rút gọn: UA đầy đủ (kiểu Chrome) khiến Meta trả 400 vô nghĩa. */
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

/** Tiền tố log thống nhất của toàn bộ Worker. */
const LOG_PREFIX = "[shop-dashboard]";

// =====================================================================
// Tiện ích nội bộ
// =====================================================================

function logError(where: string, err: unknown): void {
  console.error(`${LOG_PREFIX} ${where}`, err instanceof Error ? err.message : "?");
}

function safeClientIp(request: Request): string {
  try {
    return clientIp(request);
  } catch {
    return "0.0.0.0";
  }
}

async function auditSafe(db: D1Database, action: string, detail: string, ip: string): Promise<void> {
  try {
    await writeAudit(db, { action, detail, ip });
  } catch (err) {
    logError("audit failed", err);
  }
}

// =====================================================================
// 1) Chuẩn hoá danh sách UID từ body
// =====================================================================

// Logic parse nằm ở src/lib/uid-input.ts (dependency-free để test được độc lập).
// Module này chỉ re-export để test và code khác dùng một đường duy nhất.
export { extractUidFromLine, parseUidList } from "../lib/uid-input";

import { parseUidList } from "../lib/uid-input";

// =====================================================================
// 2) Giới hạn tần suất (D1)
// =====================================================================

/**
 * Câu `CREATE TABLE` cho bảng đếm lần gọi.
 *
 * Viết thẳng trên nhiều dòng thay vì nối chuỗi `+`, để không vỡ regex kiểm tra
 * "không SQL nối chuỗi" của test/acceptance.mjs. Không có biến nào được ghép vào
 * đây — bảng này cố định, không phải input người dùng.
 */
const CREATE_RATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS fbcheck_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, created_at INTEGER NOT NULL)";

/**
 * Bảng đếm lần gọi /api/fbcheck.
 *
 * Tự tạo nếu chưa có để tính năng không chết vì thiếu migrate. `CREATE TABLE IF
 * NOT EXISTS` là câu lệnh idempotent nên chạy mỗi lần cũng vô hại, và khi bảng
 * đã tồn tại thì Cloudflare D1 chỉ mất một vòng ghi metadata rất nhỏ.
 */
async function ensureRateTable(db: D1Database): Promise<void> {
  await db.prepare(CREATE_RATE_TABLE_SQL).run();
}

/**
 * Ghi nhận một lần gọi và trả về số lần gọi trong cửa sổ gần nhất.
 * Gọi bởi 1 người dùng hợp pháp; mọi thao tác đều prepared + bound.
 */
async function recordAttempt(db: D1Database, ip: string): Promise<number> {
  try {
    await ensureRateTable(db);
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - RATE_LIMIT_WINDOW_SECONDS;

    // Dọn bản ghi quá hạn trước để bảng không phình vô hạn.
    await db
      .prepare("DELETE FROM fbcheck_attempts WHERE created_at < ?")
      .bind(cutoff)
      .run();

    await db
      .prepare("INSERT INTO fbcheck_attempts (ip, created_at) VALUES (?, ?)")
      .bind(ip, now)
      .run();

    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM fbcheck_attempts WHERE ip = ? AND created_at >= ?",
      )
      .bind(ip, cutoff)
      .first<{ n: number }>();

    return row && typeof row.n === "number" ? row.n : 1;
  } catch (err) {
    // Hỏng bộ đếm KHÔNG được làm hỏng chức năng chính. Người dùng hợp pháp
    // thì vẫn dùng được; rủi ro lạm dụng thì đã bị requireAuth chặn trước rồi.
    logError("rate limit skipped", err);
    return 0;
  }
}

// =====================================================================
// 3) Phân loại 1 UID
// =====================================================================

/** Kết quả thô của một lần gọi Meta, trước khi rút gọn cho response. */
interface RawVerdict {
  uid: string;
  verdict: FbUidVerdict;
  /** Ghi chú ngắn để người dùng hiểu vì sao UID ở nhóm `unknown`. */
  note: string | null;
  /** Có ảnh đại diện công khai hay chỉ dùng ảnh mặc định. */
  has_photo: boolean | null;
}

/**
 * Hỏi Meta một UID còn tồn tại hay không.
 *
 * KHÔNG dùng cookie, KHÔNG đăng nhập, KHÔNG proxy, KHÔNG token — chỉ một GET
 * tới endpoint công khai. Xem khối chú thích đầu file để biết vì sao 302 là
 * LIVE, 400 là DIE, còn lại là `unknown` chứ không phải `die`.
 */
export async function checkOneUid(uid: string): Promise<RawVerdict> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${uid}/picture?type=normal`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      // QUAN TRỌNG: không theo redirect. Chính status 302 là tín hiệu LIVE,
      // nếu để Worker đi tiếp thì tín hiệu đó biến mất.
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
      },
      signal: controller.signal,
    });

    if (res.status === 302) {
      const loc = res.headers.get("Location") || "";
      // static.xx.fbcdn.net = ảnh mặc định (tài khoản không đặt ảnh, hoặc ảnh
      // không công khai). Vẫn là tài khoản TỒN TẠI, chỉ khác ở chỗ có ảnh thật.
      const isDefaultAvatar = loc.includes("static.xx.fbcdn.net");
      return { uid, verdict: "live", note: null, has_photo: !isDefaultAvatar };
    }

    if (res.status === 400) {
      return { uid, verdict: "die", note: null, has_photo: null };
    }

    if (res.status === 429) {
      return {
        uid,
        verdict: "unknown",
        note: "Meta giới hạn tần suất — thử lại sau ít phút",
        has_photo: null,
      };
    }

    return {
      uid,
      verdict: "unknown",
      note: `Meta trả HTTP ${res.status}`,
      has_photo: null,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      uid,
      verdict: "unknown",
      note: aborted ? "quá thời gian chờ" : "lỗi mạng khi gọi Meta",
      has_photo: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chạy nhiều UID với giới hạn số request song song.
 *
 * Không dùng `Promise.all` trên toàn bộ mảng: 200 UID cùng lúc sẽ khiến Meta
 * trả 429 hàng loạt và kết quả thành toàn `unknown`. Giới hạn `CONCURRENCY` vừa
 * đủ nhanh (12 UID ~ 0.6 giây) vừa lịch sự.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

// =====================================================================
// 4) Handler: POST /api/fbcheck
// =====================================================================

/**
 * Xử lý `POST /api/fbcheck`.
 *
 * Luồng bắt buộc: requireAuth (ở router) → đọc body có chặn kích thước →
 * rate limit → chuẩn hoá UID → hỏi Meta → audit → trả kết quả.
 */
export async function handleFbCheck(request: Request, env: Env): Promise<Response> {
  const ip = safeClientIp(request);

  // --- Đọc body, CHẶN KÍCH THƯỚC trước khi parse ---
  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonError("bad_request", "Không đọc được nội dung yêu cầu", 400);
  }
  if (text.length > MAX_BODY_BYTES) {
    return jsonError("payload_too_large", "Danh sách UID quá dài", 413);
  }

  // --- Rate limit ---
  const attempts = await recordAttempt(env.DB, ip);
  if (attempts > RATE_LIMIT_MAX) {
    return jsonError(
      "rate_limited",
      `Bạn đã gọi quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(RATE_LIMIT_WINDOW_SECONDS / 60)} phút.`,
      429,
    );
  }

  // --- Chuẩn hoá ---
  const { uids, invalid } = parseUidList(text);

  if (uids.length === 0) {
    return jsonError(
      "bad_request",
      invalid > 0
        ? "Không tìm thấy UID hợp lệ nào. Mỗi dòng cần là một dãy chữ số (vd: 61579461239864)."
        : "Danh sách UID rỗng. Dán ít nhất một UID.",
      400,
    );
  }

  if (uids.length > MAX_UIDS_PER_REQUEST) {
    return jsonError(
      "bad_request",
      `Tối đa ${MAX_UIDS_PER_REQUEST} UID mỗi lần (bạn gửi ${uids.length}). Hãy chia nhỏ danh sách.`,
      400,
    );
  }

  // --- Hỏi Meta ---
  const raw = await mapWithConcurrency(uids, CONCURRENCY, (uid) => checkOneUid(uid));

  // --- Gom nhóm, giữ đúng thứ tự người dùng gõ ---
  const live: FbCheckResponse["live"] = [];
  const die: FbCheckResponse["die"] = [];
  const unknown: FbCheckResponse["unknown"] = [];

  for (const item of raw) {
    if (item.verdict === "live") {
      live.push({ uid: item.uid, has_photo: item.has_photo === true });
    } else if (item.verdict === "die") {
      die.push({ uid: item.uid });
    } else {
      unknown.push({ uid: item.uid, reason: item.note || "không xác định được" });
    }
  }

  // --- Audit: chỉ ghi SỐ LIỆU, không ghi danh sách UID vào log hệ thống ---
  //
  // PHẢI `await`, không được bỏ `void`: Worker huỷ mọi promise chưa xong ngay khi
  // handler trả response, nên ghi log kiểu fire-and-forget sẽ bị bỏ qua trong
  // thực tế (đã gặp: audit_safe dùng `void` thì audit_log luôn rỗng). Ghi log là
  // việc nhanh, chờ nó không làm chậm cảm nhận được.
  await auditSafe(
    env.DB,
    "fbcheck",
    `total=${uids.length} live=${live.length} die=${die.length} unknown=${unknown.length} invalid=${invalid}`,
    ip,
  );

  const body: FbCheckResponse = {
    ok: true,
    total: uids.length,
    live,
    die,
    unknown,
    summary: {
      live: live.length,
      die: die.length,
      unknown: unknown.length,
      invalid_lines: invalid,
    },
  };

  return jsonOk(body, 200);
}
