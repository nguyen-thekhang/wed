/**
 * =====================================================================
 * POST /api/sync — VPS đẩy snapshot số liệu TỔNG HỢP lên Worker.
 * =====================================================================
 *
 * QUY TẮC BẤT DI BẤT DỊCH (đọc CONTRACT.md §0 trước khi sửa file này):
 *   Bảng `stock` bên DB bán hàng có cột `content` chứa acc|pass thật.
 *   File này CHỈ nhận các con số tổng hợp: doanh thu, số đơn, số lượng tồn.
 *   KHÔNG có field nào trong payload có thể mang acc|pass, và TUYỆT ĐỐI
 *   không được thêm field như vậy. Nếu bạn thấy mình sắp thêm một field
 *   kiểu `content` / `account` / `password` → DỪNG LẠI và báo lỗi.
 *
 * QUY TẮC TIỀN: mọi số tiền trong payload là số NGUYÊN đồng VN.
 *   Cột D1 là INTEGER, không bao giờ REAL/float. Cộng trừ số nguyên nên
 *   không có sai số làm tròn; đổi sang float là sai sổ sách.
 *
 * LUỒNG XỬ LÝ (đúng thứ tự, không được đảo):
 *   POST → token (hằng thời gian) → chặn kích thước → parse JSON
 *        → validate → ghi D1 theo lô (batch) → dọn snapshot cũ → 200
 */

import {
  clientIp,
  jsonError,
  jsonOk,
  noStore,
  serverError,
  timingSafeEqualStr,
  unauthorized,
  type Env,
} from "../lib/response";
import {
  LIMITS,
  ValidationError,
  parseSyncPayload,
  type SyncPayload,
} from "../lib/validate";
import type { SyncMeta, SyncOkResponse } from "./api-types";

/** Trần kích thước body của /api/sync: 1 MB (payload thật chỉ vài chục KB). */
export const SYNC_BODY_MAX_BYTES: number = LIMITS.body_max_bytes;

/** Số ngày giữ lịch sử snapshot trước khi dọn bớt (luôn giữ bản mới nhất). */
const SNAPSHOT_RETENTION_DAYS = 90;

/** Tiền tố log, khớp quy ước của lib/response.logLine. */
const LOG_PREFIX = "[shop-dashboard]";

/**
 * So khớp token bằng phép so sánh HẰNG THỜI GIAN.
 *
 * TUYỆT ĐỐI không dùng `===` hay `String.prototype.startsWith` cho token:
 *   phép so sánh thông thường dừng ở ký tự đầu tiên khác nhau, nên thời gian
 *   chạy rò rỉ dần từng ký tự và kẻ tấn công có thể dò ra token.
 * `timingSafeEqualStr` (lib/response) luôn duyệt hết chuỗi trước khi kết luận.
 *
 * KHÔNG BAO GIỜ log token, kể cả khi đã cắt ngắn: log là nơi rò rỉ secret
 * phổ biến nhất. Ở đây chỉ log sự kiện "thiếu token" / "sai token".
 */
async function tokenEquals(provided: string | null, expected: string): Promise<boolean> {
  if (provided === null || provided.length === 0) return false;
  if (expected.length === 0) return false;
  return timingSafeEqualStr(provided, expected);
}

/**
 * Tách token từ header `Authorization: Bearer <token>`, có phương án dự phòng
 * `X-Sync-Token` cho các bản VPS cũ chưa kịp đổi header.
 *
 * @returns token, hoặc null nếu request không mang token nào.
 */
function extractSyncToken(request: Request): string | null {
  // Ưu tiên header chuẩn: Authorization: Bearer <token>
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== null) {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(authHeader.trim());
    if (match !== null && match[1] !== undefined) return match[1];
  }
  // Dự phòng: X-Sync-Token: <token> (một số bản VPS cũ dùng header này).
  const fallback = request.headers.get("X-Sync-Token");
  if (fallback !== null) {
    const trimmed = fallback.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * Kiểm tra token của request sync.
 *
 * Dùng cho cả router (`if (!(await requireSyncToken(req, env))) return unauthorized();`)
 * lẫn bên trong handleSync. Hàm này KHÔNG bao giờ ném lỗi và KHÔNG log token.
 */
export async function requireSyncToken(request: Request, env: Env): Promise<boolean> {
  const provided = extractSyncToken(request);
  if (provided === null) {
    console.warn(`${LOG_PREFIX} sync bị từ chối: thiếu token`);
    return false;
  }
  const expected = typeof env.SYNC_TOKEN === "string" ? env.SYNC_TOKEN : "";
  const ok = await tokenEquals(provided, expected);
  if (!ok) {
    console.warn(`${LOG_PREFIX} sync bị từ chối: token không đúng`);
  }
  return ok;
}

/**
 * Xử lý `POST /api/sync`.
 *
 * Thứ tự bắt buộc: kiểm tra method → xác thực token TRƯỚC KHI đọc body →
 * chặn kích thước → parse JSON → validate → ghi DB → trả 200.
 * Xác thực trước khi đọc body để request không có token không thể tiêu tốn
 * CPU/băng thông của Worker (chống dò token kèm payload lớn).
 */
export async function handleSync(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    // (1) Chỉ nhận POST.
    if (request.method !== "POST") {
      return jsonError("method_not_allowed", "Chỉ hỗ trợ POST", 405);
    }

    // (2) XÁC THỰC TRƯỚC, chưa chạm vào body. Sai/thiếu token → 401.
    //     So sánh hằng thời gian qua requireSyncToken (không dùng `===`).
    if (!(await requireSyncToken(request, env))) {
      return unauthorized("Token không hợp lệ");
    }

    // (3) Chặn theo Content-Length. Header có thể không tồn tại (chunked),
    //     nên vẫn phải kiểm tra lại độ dài thật sau khi đọc body.
    const contentLengthHeader = request.headers.get("Content-Length");
    if (contentLengthHeader !== null) {
      const declared = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declared) && declared > SYNC_BODY_MAX_BYTES) {
        return jsonError(
          "payload_too_large",
          `Payload vượt giới hạn ${SYNC_BODY_MAX_BYTES} byte`,
          413,
        );
      }
    }

    // (3b) Đọc body dạng text rồi đo byte thật (UTF-8). Payload rất nhỏ nên
    //      đọc một lần là đủ, không cần streaming.
    let rawText: string;
    try {
      rawText = await request.text();
    } catch {
      return jsonError("bad_request", "Không đọc được body", 400);
    }
    const actualBytes = new TextEncoder().encode(rawText).byteLength;
    if (actualBytes > SYNC_BODY_MAX_BYTES) {
      return jsonError(
        "payload_too_large",
        `Payload vượt giới hạn ${SYNC_BODY_MAX_BYTES} byte`,
        413,
      );
    }

    // (4) Parse JSON. Thông báo của JSON.parse có thể lộ chi tiết nội bộ
    //     (vị trí lỗi, đoạn text) nên KHÔNG bao giờ trả ra cho client.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      return jsonError("bad_request", "JSON không hợp lệ", 400);
    }

    // (5) Validate theo CONTRACT §2. ValidationError.message là thông báo
    //     tiếng Việt do mình kiểm soát nên được phép trả ra.
    let payload: SyncPayload;
    try {
      payload = parseSyncPayload(parsed);
    } catch (err) {
      if (err instanceof ValidationError) {
        return jsonError("bad_request", err.message, 400);
      }
      throw err;
    }

    // (6) Ghi D1 theo lô + (7) dọn snapshot cũ.
    const ip = clientIp(request);
    const { received_at } = await persistSyncPayload(env, payload, ip);

    // (8) 200 kèm header no-store.
    const body: SyncOkResponse = {
      ok: true,
      synced_at: payload.synced_at,
      received_at,
    };
    return jsonOk(body, 200, noStore());
  } catch (err) {
    // (9) Không lộ stack trace ra ngoài, chỉ log thông điệp ngắn.
    // ctx được giữ trong chữ ký (đã freeze) dù hiện tại batch tự chứa đủ.
    void ctx;
    console.error(
      `${LOG_PREFIX} sync failed`,
      err instanceof Error ? err.message : "unknown",
    );
    return serverError();
  }
}

/**
 * Ghi một snapshot đã validate xuống D1 bằng MỘT lời gọi `db.batch`.
 *
 * Tính IDEMPOTENT (chạy lại cùng payload không nhân đôi số liệu):
 *   - Payload là ảnh chụp TOÀN PHẦN (full snapshot), không phải delta.
 *   - Mọi bảng đích đều upsert theo khoá tự nhiên: daily_stats theo `date`,
 *     product_stats theo `product_id`. Ghi lại cùng một ảnh chụp chỉ ghi đè
 *     đúng giá trị cũ, không cộng dồn → không thể nhân đôi doanh thu/số đơn.
 *   - Riêng `sync_snapshots` là LỊCH SỬ nên được phép thêm dòng mới, nhưng
 *     phải chặn bản ghi trùng cho CÙNG một `synced_at`:
 *       INSERT INTO sync_snapshots (...) SELECT ?1, ?2
 *       WHERE NOT EXISTS (SELECT 1 FROM sync_snapshots WHERE synced_at = ?1)
 *     Nhờ mệnh đề WHERE NOT EXISTS, VPS retry cùng mốc thời gian sẽ không
 *     tạo thêm dòng snapshot → endpoint idempotent theo `synced_at`.
 *
 * Mọi câu lệnh đều là prepared statement dùng `.bind(...)`: không nối chuỗi
 * SQL, không nội suy `${}` → không có đường SQL injection.
 *
 * @returns `received_at` thật do D1 sinh (UTC).
 */
export async function persistSyncPayload(
  env: Env,
  payload: SyncPayload,
  ip: string,
): Promise<{ received_at: string }> {
  const db = env.DB;
  const nowIso = new Date().toISOString(); // UTC, dùng cho cột updated_at
  const payloadJson = JSON.stringify(payload);

  const statements: D1PreparedStatement[] = [];

  // (6a) Lưu snapshot lịch sử. WHERE NOT EXISTS ⇒ retry cùng synced_at là no-op.
  statements.push(
    db
      .prepare(
        `INSERT INTO sync_snapshots (synced_at, payload_json)
         SELECT ?1, ?2
         WHERE NOT EXISTS (SELECT 1 FROM sync_snapshots WHERE synced_at = ?1)`,
      )
      .bind(payload.synced_at, payloadJson),
  );

  // (6b) Doanh thu/số đơn theo ngày — upsert theo PRIMARY KEY `date`.
  for (const day of payload.by_day) {
    statements.push(
      db
        .prepare(
          `INSERT INTO daily_stats (date, revenue, orders, updated_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(date) DO UPDATE SET
             revenue = excluded.revenue,
             orders = excluded.orders,
             updated_at = excluded.updated_at`,
        )
        .bind(day.date, day.revenue, day.orders, nowIso),
    );
  }

  // (6c) Thống kê theo sản phẩm — upsert theo `product_id`.
  //      KHÔNG chạm cột `available` ở đây: cột đó do vòng lặp stock bên dưới
  //      quản lý, nên ghi ở đây sẽ vô tình ghi đè số tồn mới bằng số cũ.
  for (const product of payload.by_product) {
    statements.push(
      db
        .prepare(
          `INSERT INTO product_stats (product_id, name, sold, revenue, available, updated_at)
           VALUES (?1, ?2, ?3, ?4, 0, ?5)
           ON CONFLICT(product_id) DO UPDATE SET
             name = CASE WHEN excluded.name = '' THEN product_stats.name ELSE excluded.name END,
             sold = excluded.sold,
             revenue = excluded.revenue,
             updated_at = excluded.updated_at`,
        )
        .bind(
          product.product_id,
          product.name,
          product.sold,
          product.revenue,
          nowIso,
        ),
    );
  }

  // (6d) Tồn kho. `product_stats.name` là NOT NULL, mà payload stock KHÔNG
  //      nhất thiết có tên sản phẩm → khi thiếu tên thì dùng nhãn thay thế
  //      "SP #<id>". ON CONFLICT giữ nguyên name/sold/revenue cũ nếu bản ghi
  //      đến từ stock không mang theo thông tin đó:
  //        - available: luôn cập nhật (đây là mục đích của vòng lặp này);
  //        - sold: chỉ ghi đè khi giá trị mới > 0, tránh xoá số bán đã có;
  //        - name/revenue: giữ nguyên, không bao giờ bị xoá trắng.
  for (const row of payload.stock) {
    const productId = typeof row.product_id === "number" ? row.product_id : 0;
    const available = typeof row.available === "number" ? row.available : 0;
    const sold = typeof row.sold === "number" ? row.sold : 0;
    statements.push(
      db
        .prepare(
          `INSERT INTO product_stats (product_id, name, sold, revenue, available, updated_at)
           VALUES (?1, ?2, ?3, 0, ?4, ?5)
           ON CONFLICT(product_id) DO UPDATE SET
             available = excluded.available,
             sold = CASE WHEN excluded.sold > 0 THEN excluded.sold ELSE product_stats.sold END,
             updated_at = excluded.updated_at`,
        )
        .bind(productId, `SP #${productId}`, sold, available, nowIso),
    );
  }

  // (6e) Audit. `detail` CHỈ chứa số liệu tổng hợp, không bao giờ chứa acc|pass
  //      và không chứa token.
  const detail =
    `nhận snapshot: ${payload.by_day.length} ngày, ${payload.by_product.length} sản phẩm, ` +
    `doanh thu=${payload.totals.revenue_delivered}, đơn=${payload.totals.orders_delivered}`;
  statements.push(
    db
      .prepare(`INSERT INTO audit_log (action, detail, ip) VALUES ('sync', ?1, ?2)`)
      .bind(detail, ip),
  );

  // (7) Dọn snapshot cũ hơn 90 ngày, nhưng LUÔN giữ bản mới nhất:
  //     điều kiện `id <> (SELECT MAX(id) ...)` bảo đảm dashboard không bao giờ
  //     mất dữ liệu hiển thị, kể cả khi DB ngừng sync rất lâu.
  const cutoffIso = new Date(
    Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  statements.push(
    db
      .prepare(
        `DELETE FROM sync_snapshots
         WHERE received_at < ?1
           AND id <> (SELECT MAX(id) FROM sync_snapshots)`,
      )
      .bind(cutoffIso),
  );

  // Một batch = một giao dịch: hoặc tất cả cùng thành công, hoặc không gì cả.
  await db.batch(statements);

  // (6f) Lấy `received_at` do D1 sinh. Không dùng RETURNING cho đơn giản và
  //      chắc chắn tương thích.
  const row = await db
    .prepare(`SELECT received_at FROM sync_snapshots ORDER BY id DESC LIMIT 1`)
    .first<{ received_at: string }>();

  return { received_at: row?.received_at ?? nowIso };
}

/**
 * Mốc sync mới nhất theo thời gian VPS báo (`synced_at`).
 *
 * Trả `null` khi bảng chưa tồn tại (chưa chạy migrate) hoặc chưa có bản ghi,
 * để dashboard hiển thị trạng thái "chưa có dữ liệu" thay vì lỗi 500.
 */
export async function latestSnapshot(env: Env): Promise<SyncMeta | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT synced_at, received_at FROM sync_snapshots ORDER BY synced_at DESC LIMIT 1`,
    ).first<SyncMeta>();
    if (row === null || row === undefined) return null;
    return { synced_at: row.synced_at, received_at: row.received_at };
  } catch {
    // Bảng chưa được tạo (migrate chưa chạy) → coi như chưa có snapshot.
    return null;
  }
}
