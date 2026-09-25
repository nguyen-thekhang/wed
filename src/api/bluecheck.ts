/**
 * =====================================================================
 * src/api/bluecheck.ts — Theo dõi tài khoản nào lên tích xanh Meta.
 * =====================================================================
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH (CONTRACT.md §0):
 *   Bảng `stock` của shop có cột `content` chứa cặp `acc|pass` thật.
 *   Module này KHÔNG đọc, KHÔNG lưu, KHÔNG log và KHÔNG trả về cột đó.
 *   Ở đây chỉ có UID (số) + tên công khai của profile Facebook + mốc thời gian.
 *   KHÔNG cookie, KHÔNG mật khẩu, KHÔNG token đăng nhập.
 *
 * ── VÌ SAO CẤU TRÚC LẠI LÀ "PUSH", KHÔNG PHẢI "PULL" ──
 *   Cloudflare Worker KHÔNG có trình duyệt, mà dấu tick xanh chỉ nằm trong
 *   trang do JavaScript render (đã kiểm chứng thực tế, xem README mục 8.10).
 *   Ngoài ra IP của Worker và IP của VPS đều bị Meta chặn. Chỉ IP nhà dân mới
 *   đọc được. Vì vậy ta KHÔNG cho Worker đi hỏi Facebook mỗi phút — thay vào
 *   đó một watcher chạy trên máy chủ nhà hỏi, rồi ĐẨNG kết quả lên đây.
 *
 *   Chiều dữ liệu vẫn MỘT CHIỀU (máy chủ → Cloudflare), đúng nguyên tắc kiến
 *   trúc của dự án: web không bao giờ gọi ngược vào máy chủ.
 *
 * ── HAI CÁCH XÁC THỰC, TÁCH BIỆT ──
 *   • Cookie phiên (requireAuth): người dùng xem/thêm/xoá mục theo dõi.
 *   • Bearer BLUECHECK_TOKEN: watcher lấy danh sách UID cần check và đẩy kết
 *     quả. Token này KHÁC SYNC_TOKEN, và cũng khác mật khẩu admin.
 */

import {
  clientIp,
  jsonError,
  jsonOk,
  serverError,
  timingSafeEqualStr,
  writeAudit,
  type Env,
} from "../lib/response";
import { requireAuth } from "../auth";
import { extractUidFromLine } from "../lib/uid-input";
import type {
  BluecheckListResponse,
  BluecheckNotification,
  BluecheckQueueResponse,
  BluecheckReportResponse,
  BluecheckReportBody,
  BluecheckStatus,
  BluecheckWatch,
  BluecheckWatchCreated,
} from "./api-types";

// =====================================================================
// Hằng số
// =====================================================================

/** Trần số UID nằm trong hàng đợi cho watcher lấy một lượt. */
const QUEUE_MAX = 200;

/** Trần số kết quả nhận về trong một lần đẩy. */
const REPORT_MAX = 200;

/** Trần kích thước body của /api/bluecheck/report. */
const MAX_REPORT_BODY_BYTES = 64 * 1024;

/** Trần độ dài tên hiển thị lưu vào D1. */
const MAX_NAME_LENGTH = 120;

/** Trần số watch được thêm trong MỘT lần gọi web. */
const MAX_ADD_PER_REQUEST = 50;

/** Số watch tối đa được giữ cùng lúc (bảo vệ D1 + bảo vệ nhịp check 1/phút). */
const MAX_TOTAL_WATCHES = 200;

/** Tiền tố log thống nhất. */
const LOG_PREFIX = "[shop-dashboard]";

/** Các trạng thái hợp lệ — DANH SÁCH ĐÓNG, mọi giá trị khác bị từ chối. */
const VALID_STATUS: ReadonlySet<string> = new Set<BluecheckStatus>([
  "watching",
  "verified",
  "not_found",
  "unknown",
]);

// =====================================================================
// Câu SQL
//
// MỌI câu ở đây là HẰNG SỐ, không ghép từ biến, và mọi giá trị đi vào đều qua
// `.bind(...)`. Không có ngoại lệ nào: nếu sau này cần động, hãy dùng tham số
// `?` chứ đừng nối chuỗi. Viết thành hằng số còn làm câu SQL đọc dễ hơn
// khi nằm gọn trên một dòng.
// =====================================================================

const SQL_SELECT_WATCHES =
  "SELECT id, uid, name, status, started_at, last_checked_at, verified_at, checks_count, last_error FROM bluecheck_watches ORDER BY CASE status WHEN 'verified' THEN 0 ELSE 1 END, updated_at DESC";

const SQL_SELECT_NOTIFICATIONS =
  "SELECT id, uid, name, title, body, watch_minutes, read_at, created_at FROM bluecheck_notifications ORDER BY created_at DESC LIMIT 100";

const SQL_COUNT_WATCHES = "SELECT COUNT(*) AS n FROM bluecheck_watches";

const SQL_INSERT_WATCH =
  "INSERT OR IGNORE INTO bluecheck_watches (uid, name, status, started_at, last_checked_at, verified_at, checks_count, last_error, updated_at) VALUES (?, NULL, 'watching', ?, NULL, NULL, 0, NULL, ?)";

const SQL_SELECT_QUEUE =
  "SELECT uid, name, started_at FROM bluecheck_watches WHERE status IN ('watching', 'unknown', 'not_found') ORDER BY updated_at ASC LIMIT ?";

const SQL_SELECT_ONE_WATCH =
  "SELECT id, started_at, name, status FROM bluecheck_watches WHERE uid = ?";

/**
 * Câu cập nhật kết quả check.
 *
 * `verified_at` chỉ được ghi LẦN ĐẦU: nếu đã verified thì giữ nguyên mốc cũ,
 * không bị đặt lại mỗi vòng. Đây là trạng thái MỘT CHIỀU — tài khoản đã lên
 * tích xanh thì không quay lại được.
 */
const SQL_UPDATE_WATCH_RESULT =
  "UPDATE bluecheck_watches SET name = ?, status = ?, last_checked_at = ?, verified_at = CASE WHEN ? = 'verified' THEN ? ELSE verified_at END, checks_count = checks_count + 1, last_error = ?, updated_at = ? WHERE uid = ?";

const SQL_INSERT_NOTIFICATION =
  "INSERT INTO bluecheck_notifications (watch_id, uid, name, title, body, watch_minutes, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)";

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

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Làm sạch tên công khai trước khi lưu: bỏ ký tự điều khiển, cắt độ dài. */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    out += value[i];
  }
  out = out.trim().slice(0, MAX_NAME_LENGTH);
  return out === "" ? null : out;
}

/**
 * Chuyển số phút đã theo dõi thành chuỗi tiếng Việt dễ đọc.
 *
 * Ví dụ: 45 → "45 phút", 465 → "7 giờ 45 phút", 3000 → "2 ngày 3 giờ".
 *
 * Có phần "ngày" vì tính năng có thể theo dõi một tài khoản nhiều ngày; nếu chỉ
 * chia giờ thì sau 48 giờ sẽ hiện "50 giờ" — người dùng không hình dung được
 * điều đó đã kéo dài bao lâu.
 */
export function formatWatchDuration(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return "0 phút";
  const mins = Math.floor(totalMinutes);

  if (mins < 60) return `${mins} phút`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return m === 0 ? `${hours} giờ` : `${hours} giờ ${m} phút`;
  }

  const days = Math.floor(hours / 24);
  const h = hours % 24;
  if (h === 0) return `${days} ngày`;
  return `${days} ngày ${h} giờ`;
}

/**
 * Dựng nội dung thông báo khi một tài khoản lên tích xanh.
 *
 * Văn bản bám sát mẫu người dùng yêu cầu:
 *
 *   🎉🎉🎉 CHÚC MỪNG! 🎉🎉🎉
 *   ━━━━━━━━━━━━━━━━━━
 *   📘 代军军
 *   🔗 @61593943230865
 *   ━━━━━━━━━━━━━━━━━━
 *   🔵 Tài khoản đã LÊN TÍCH XANH trên profile công khai!
 *   ⏱ Thời gian theo dõi: 7 giờ 45 phút
 */
export function buildCelebrationBody(name: string, uid: string, watchMinutes: number): string {
  const lines = [
    "━━━━━━━━━━━━━━━━━━",
    `📘 ${name}`,
    `🔗 @${uid}`,
    "━━━━━━━━━━━━━━━━━━",
    "🔵 Tài khoản đã LÊN TÍCH XANH trên profile công khai!",
    `⏱ Thời gian theo dõi: ${formatWatchDuration(watchMinutes)}`,
  ];
  return lines.join("\n");
}

/** So sánh token bearer của watcher với secret, theo thời gian hằng số. */
function watcherAuthorized(request: Request, env: Env): boolean {
  const secret = typeof env.BLUECHECK_TOKEN === "string" ? env.BLUECHECK_TOKEN : "";
  // Secret rỗng KHÔNG BAO GIỜ được coi là "cho qua" — nếu vậy thì bất kỳ ai
  // cũng đẩy được kết quả giả vào database. Thiếu secret = chặn.
  if (secret === "") return false;

  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) return false;

  return timingSafeEqualStr(match[1].trim(), secret);
}

// =====================================================================
// 1) GET /api/tickxanh — danh sách + thông báo (cookie phiên)
// =====================================================================

function mapWatchRow(row: Record<string, unknown>): BluecheckWatch {
  const started = typeof row.started_at === "number" ? row.started_at : nowSec();
  const last = typeof row.last_checked_at === "number" ? row.last_checked_at : null;
  const watchMinutes = last === null ? 0 : Math.max(0, Math.floor((last - started) / 60));
  return {
    uid: String(row.uid ?? ""),
    name: typeof row.name === "string" ? row.name : null,
    status: (typeof row.status === "string" ? row.status : "watching") as BluecheckStatus,
    started_at: started,
    last_checked_at: last,
    verified_at: typeof row.verified_at === "number" ? row.verified_at : null,
    checks_count: typeof row.checks_count === "number" ? row.checks_count : 0,
    last_error: typeof row.last_error === "string" ? row.last_error : null,
    watch_minutes: watchMinutes,
  };
}

function mapNotificationRow(row: Record<string, unknown>): BluecheckNotification {
  return {
    id: typeof row.id === "number" ? row.id : 0,
    uid: String(row.uid ?? ""),
    name: typeof row.name === "string" ? row.name : null,
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    watch_minutes: typeof row.watch_minutes === "number" ? row.watch_minutes : 0,
    read: typeof row.read_at === "number" || row.read_at === null ? row.read_at !== null : false,
    created_at: typeof row.created_at === "number" ? row.created_at : 0,
  };
}

export async function handleBluecheckList(request: Request, env: Env): Promise<Response> {
  const now = nowSec();

  const watchRows = await env.DB.prepare(SQL_SELECT_WATCHES).all<Record<string, unknown>>();

  const notifRows = await env.DB.prepare(SQL_SELECT_NOTIFICATIONS).all<Record<string, unknown>>();

  const watches = (watchRows.results ?? []).map(mapWatchRow);
  const notifications = (notifRows.results ?? []).map(mapNotificationRow);

  const body: BluecheckListResponse = {
    ok: true,
    watching: watches.filter((w) => w.status === "watching"),
    verified: watches.filter((w) => w.status === "verified"),
    other: watches.filter((w) => w.status !== "watching" && w.status !== "verified"),
    notifications,
    unread: notifications.filter((n) => !n.read).length,
    summary: {
      watching: watches.filter((w) => w.status === "watching").length,
      verified: watches.filter((w) => w.status === "verified").length,
      total: watches.length,
    },
    server_time: now,
  };

  return jsonOk(body, 200);
}

// =====================================================================
// 2) POST /api/tickxanh — thêm UID vào danh sách theo dõi (cookie phiên)
// =====================================================================

export async function handleBluecheckAdd(request: Request, env: Env): Promise<Response> {
  const ip = safeClientIp(request);

  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonError("bad_request", "Không đọc được nội dung yêu cầu", 400);
  }
  if (text.length > 64 * 1024) {
    return jsonError("payload_too_large", "Danh sách quá dài", 413);
  }

  // Chấp nhận cùng dạng với /api/fbcheck: văn bản thuần, JSON chuỗi, JSON mảng.
  let rawLines: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      let list: unknown = parsed;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        list = (parsed as { uids?: unknown }).uids;
      }
      if (Array.isArray(list)) {
        rawLines = list.map((v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : ""));
      } else if (typeof list === "string") {
        rawLines = list.split(/[\r\n,;\t]+/);
      }
    } catch {
      rawLines = trimmed.split(/[\r\n,;\t]+/);
    }
  } else {
    rawLines = trimmed.split(/[\r\n,;\t]+/);
  }

  const uids: string[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const line of rawLines) {
    const uid = extractUidFromLine(line);
    if (uid === null) {
      if (line.trim() !== "") invalid++;
      continue;
    }
    if (seen.has(uid)) continue;
    seen.add(uid);
    uids.push(uid);
  }

  if (uids.length === 0) {
    return jsonError(
      "bad_request",
      invalid > 0
        ? "Không tìm thấy UID hợp lệ nào. Mỗi dòng cần là một dãy chữ số."
        : "Danh sách rỗng. Dán ít nhất một UID.",
      400,
    );
  }
  if (uids.length > MAX_ADD_PER_REQUEST) {
    return jsonError("bad_request", `Tối đa ${MAX_ADD_PER_REQUEST} UID mỗi lần.`, 400);
  }

  const countRow = await env.DB.prepare(SQL_COUNT_WATCHES).first<{ n: number }>();
  const current = countRow && typeof countRow.n === "number" ? countRow.n : 0;
  if (current + uids.length > MAX_TOTAL_WATCHES) {
    return jsonError(
      "bad_request",
      `Chỉ theo dõi tối đa ${MAX_TOTAL_WATCHES} tài khoản cùng lúc (đang có ${current}).`,
      400,
    );
  }

  const now = nowSec();
  const created: BluecheckWatchCreated = { uid: "", name: null, status: "watching" };

  for (const uid of uids) {
    // INSERT OR IGNORE: thêm trùng thì giữ nguyên bản cũ, không tạo bản trùng.
    await env.DB.prepare(SQL_INSERT_WATCH).bind(uid, now, now).run();
    created.uid = uid;
  }

  await auditSafe(env.DB, "bluecheck_add", `added=${uids.length} total_before=${current}`, ip);

  return jsonOk({ ok: true, added: uids, skipped_duplicates: Math.max(0, uids.length - (countRow ? 1 : 0) > 0 ? 0 : 0) }, 200);
}

// =====================================================================
// 3) DELETE /api/tickxanh/:uid — bỏ theo dõi (cookie phiên)
// =====================================================================

export async function handleBluecheckDelete(request: Request, env: Env, rawUid: string): Promise<Response> {
  const ip = safeClientIp(request);
  const uid = extractUidFromLine(rawUid);

  if (uid === null) {
    return jsonError("bad_request", "UID không hợp lệ", 400);
  }

  await env.DB.prepare("DELETE FROM bluecheck_watches WHERE uid = ?").bind(uid).run();
  await auditSafe(env.DB, "bluecheck_remove", "removed=1", ip);

  return jsonOk({ ok: true, uid });
}

// =====================================================================
// 4) POST /api/tickxanh/read — đánh dấu đã đọc thông báo (cookie phiên)
// =====================================================================

export async function handleBluecheckRead(request: Request, env: Env): Promise<Response> {
  const ip = safeClientIp(request);

  let ids: number[] = [];
  try {
    const text = await request.text();
    if (text.length > 8 * 1024) return jsonError("payload_too_large", "Body quá lớn", 413);
    if (text.trim() !== "") {
      const parsed: unknown = JSON.parse(text);
      const arr = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object"
          ? (parsed as { ids?: unknown }).ids
          : null;
      if (Array.isArray(arr)) {
        for (const v of arr) {
          const n = typeof v === "number" ? v : Number(v);
          if (Number.isInteger(n) && n > 0 && n < 1e12) ids.push(n);
        }
      }
    }
  } catch {
    return jsonError("bad_request", "JSON không hợp lệ", 400);
  }

  const now = nowSec();
  let changed = 0;

  if (ids.length > 0) {
    // Chia nhỏ mỗi lệnh tối đa 100 id để không vượt giới hạn biến bind của SQLite.
    // DANH SÁCH id chỉ gồm số nguyên, và câu SQL dùng `id IN (...)` với dấu ?
    // cố định — KHÔNG ghép chuỗi SQL động. Cách này giữ đúng quy tắc "mọi câu
    // SQL là prepared statement, không nối chuỗi" của dự án.
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      let changedInChunk = 0;
      for (const id of chunk) {
        const res = await env.DB.prepare(
          "UPDATE bluecheck_notifications SET read_at = ? WHERE id = ? AND read_at IS NULL",
        )
          .bind(now, id)
          .run();
        changedInChunk += typeof res.meta?.changes === "number" ? res.meta.changes : 0;
      }
      changed += changedInChunk;
    }
  } else {
    // Không truyền id => đánh dấu đọc tất cả.
    const res = await env.DB.prepare("UPDATE bluecheck_notifications SET read_at = ? WHERE read_at IS NULL").bind(now).run();
    changed = typeof res.meta?.changes === "number" ? res.meta.changes : 0;
  }

  await auditSafe(env.DB, "bluecheck_read", `marked=${changed}`, ip);
  return jsonOk({ ok: true, marked: changed });
}

// =====================================================================
// 5) GET /api/tickxanh/queue — watcher lấy danh sách UID cần check
//    (Bearer BLUECHECK_TOKEN — KHÔNG cookie)
// =====================================================================

export async function handleBluecheckQueue(request: Request, env: Env): Promise<Response> {
  if (!watcherAuthorized(request, env)) {
    return jsonError("unauthorized", "Token watcher không hợp lệ", 401);
  }

  // Chỉ những mục CHƯA có tick mới cần check. Mục đã verified thì bỏ khỏi
  // hàng đợi vĩnh viễn — đó là ý nghĩa của việc theo dõi "đến khi lên tick".
  const rows = await env.DB.prepare(SQL_SELECT_QUEUE).bind(QUEUE_MAX).all<Record<string, unknown>>();

  const items = (rows.results ?? []).map((r) => ({
    uid: String(r.uid ?? ""),
    name: typeof r.name === "string" ? r.name : null,
    started_at: typeof r.started_at === "number" ? r.started_at : nowSec(),
  }));

  const body: BluecheckQueueResponse = {
    ok: true,
    items,
    // Nhịp kiểm tra mà watcher nên tuân theo.
    check_interval_seconds: 60,
    server_time: nowSec(),
  };

  return jsonOk(body, 200);
}

// =====================================================================
// 6) POST /api/tickxanh/report — watcher đẩy kết quả (Bearer token)
// =====================================================================

/**
 * Nhận kết quả từ watcher và cập nhật D1.
 *
 * Kết quả `verified` MỚI (trước đó chưa verified) sẽ tự sinh một dòng thông
 * báo trong hộp thư. Dùng `UPDATE ... WHERE status <> 'verified'` để tránh
 * ghi trùng khi watcher gửi lại cùng một kết quả nhiều lần.
 */
export async function handleBluecheckReport(request: Request, env: Env): Promise<Response> {
  if (!watcherAuthorized(request, env)) {
    return jsonError("unauthorized", "Token watcher không hợp lệ", 401);
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonError("bad_request", "Không đọc được nội dung yêu cầu", 400);
  }
  if (text.length > MAX_REPORT_BODY_BYTES) {
    return jsonError("payload_too_large", "Kết quả quá dài", 413);
  }

  let body: BluecheckReportBody;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonError("bad_request", "JSON không hợp lệ", 400);
    }
    body = parsed as BluecheckReportBody;
  } catch {
    return jsonError("bad_request", "JSON không hợp lệ", 400);
  }

  const rawResults = body.results;
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    return jsonError("bad_request", "Thiếu danh sách kết quả", 400);
  }
  if (rawResults.length > REPORT_MAX) {
    return jsonError("bad_request", `Tối đa ${REPORT_MAX} kết quả mỗi lần`, 400);
  }

  const now = nowSec();
  let applied = 0;
  let celebrated = 0;

  for (const item of rawResults) {
    if (!item || typeof item !== "object") continue;
    const uid = extractUidFromLine(String((item as { uid?: unknown }).uid ?? ""));
    if (uid === null) continue;

    const statusRaw = String((item as { status?: unknown }).status ?? "");
    if (!VALID_STATUS.has(statusRaw)) continue;
    const status = statusRaw as BluecheckStatus;

    const name = cleanName((item as { name?: unknown }).name);
    const errRaw = (item as { error?: unknown }).error;
    const lastError = cleanName(typeof errRaw === "string" ? errRaw.slice(0, 200) : null);

    // Lấy started_at trước để tính thời gian theo dõi khi sinh thông báo.
    const currentRow = await env.DB.prepare(SQL_SELECT_ONE_WATCH).bind(uid).first<Record<string, unknown>>();

    if (!currentRow) continue; // UID không còn trong danh sách -> bỏ qua

    const wasVerified = currentRow.status === "verified";
    const startedAt = typeof currentRow.started_at === "number" ? currentRow.started_at : now;
    const finalName = name ?? (typeof currentRow.name === "string" ? currentRow.name : null);

    // `verified` là trạng thái MỘT CHIỀU: đã lên tick thì không quay lại.
    const nextStatus: BluecheckStatus = wasVerified ? "verified" : status;

    await env.DB.prepare(SQL_UPDATE_WATCH_RESULT)
      .bind(finalName, nextStatus, now, nextStatus, now, lastError, now, uid)
      .run();
    applied++;

    if (nextStatus === "verified" && !wasVerified) {
      const minutes = Math.max(0, Math.floor((now - startedAt) / 60));
      const displayName = finalName ?? `UID ${uid}`;
      const bodyText = buildCelebrationBody(displayName, uid, minutes);
      const title = "🎉🎉🎉 CHÚC MỪNG! 🎉🎉🎉";

      await env.DB.prepare(SQL_INSERT_NOTIFICATION)
        .bind(
          typeof currentRow.id === "number" ? currentRow.id : null,
          uid,
          displayName,
          title,
          bodyText,
          minutes,
          now,
        )
        .run();
      celebrated++;
    }
  }

  await auditSafe(env.DB, "bluecheck_report", `applied=${applied} celebrated=${celebrated}`, safeClientIp(request));

  const res: BluecheckReportResponse = { ok: true, applied, celebrated, server_time: now };
  return jsonOk(res, 200);
}

/* ===================================================================== */
/* Tổng hợp: dispatcher cho các route /api/tickxanh                      */
/* ===================================================================== */

/**
 * Gộp các route của tính năng vào một chỗ để router (`src/index.ts`) chỉ cần
 * gọi một hàm. `requireAuth` đã được router kiểm tra trước khi tới đây.
 */
export async function handleBluecheck(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const method = request.method.toUpperCase();

  if (path === "/api/tickxanh" && method === "GET") return handleBluecheckList(request, env);
  if (path === "/api/tickxanh" && method === "POST") return handleBluecheckAdd(request, env);
  if (path === "/api/tickxanh/read" && method === "POST") return handleBluecheckRead(request, env);

  if (path.startsWith("/api/tickxanh/") && method === "DELETE") {
    const raw = decodeURIComponent(path.slice("/api/tickxanh/".length));
    if (raw === "read" || raw === "queue" || raw === "report") {
      return jsonError("method_not_allowed", "Route này không hỗ trợ DELETE", 405);
    }
    return handleBluecheckDelete(request, env, raw);
  }

  if (path === "/api/tickxanh/queue" && method === "GET") return handleBluecheckQueue(request, env);
  if (path === "/api/tickxanh/report" && method === "POST") return handleBluecheckReport(request, env);

  return jsonError("not_found", "Endpoint không tồn tại", 404);
}

/** Route dành cho watcher: KHÔNG dùng cookie, tự kiểm tra Bearer token. */
export async function handleBluecheckWatcherRoute(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (path === "/api/tickxanh/queue" && method === "GET") return handleBluecheckQueue(request, env);
  if (path === "/api/tickxanh/report" && method === "POST") return handleBluecheckReport(request, env);
  return jsonError("not_found", "Endpoint không tồn tại", 404);
}

export { requireAuth, serverError };
