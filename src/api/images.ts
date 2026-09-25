/**
 * =====================================================================
 * src/api/images.ts — Quản lý ảnh: R2 (private) + D1 + audit.
 * =====================================================================
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH (CONTRACT.md §0):
 *   Bảng `stock` bên DB bán hàng có cột chứa cặp `acc|pass` thật.
 *   File này KHÔNG đọc, KHÔNG lưu, KHÔNG log và KHÔNG trả về cột đó.
 *   Ở đây chỉ có: bytes ảnh người dùng tự tải lên, ghi chú (note) do chính
 *   chủ ảnh gõ, kích thước, mime và sha256. Không có đường nào để nội dung
 *   của bảng `stock` đi qua module này.
 *
 * BUCKET R2 LÀ PRIVATE (IMAGES_DESIGN.md §Bảo mật, điều 1):
 *   - KHÔNG bật public access, KHÔNG gắn custom domain, KHÔNG presigned URL.
 *   - Mọi lần đọc ảnh đều phải đi qua Worker và đều phải `requireAuth` trước.
 *   - Vì vậy ảnh không thể xem được khi chưa đăng nhập, kể cả khi biết key.
 *
 * Trình tự bắt buộc của MỌI handler:
 *   requireAuth  →  validate đầu vào  →  chạm R2/D1  →  trả kết quả.
 *   Không bao giờ chạm R2 trước khi xác thực.
 */

import {
  clientIp,
  jsonError,
  jsonOk,
  noStore,
  serverError,
  unauthorized,
  writeAudit,
  type Env,
} from "../lib/response";
import { redactText } from "../lib/validate";
import { requireAuth } from "../auth";
import type { ImageRow, ImagesResponse, ImageUploadResponse } from "./api-types";

// =====================================================================
// Hằng số — hợp đồng đã freeze với IMAGES_DESIGN.md
// =====================================================================

/** Trần kích thước 1 ảnh: 5 MB. Vượt → 413 `payload_too_large`. */
export const MAX_IMAGE_BYTES: number = 5 * 1024 * 1024;

/**
 * Danh sách mime được phép. Đây là DANH SÁCH ĐÓNG: chỉ 3 định dạng ảnh
 * phổ thông, không SVG (SVG chứa script → XSS), không GIF, không BMP.
 */
export const ALLOWED_MIMES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

/**
 * Regex khoá R2 hợp lệ: `img_<uuid>.<ext>`.
 *
 * Dùng để CHỐNG PATH TRAVERSAL: `key` đến từ URL (`/api/images/:key`) nên do
 * người dùng kiểm soát. Nếu đưa thẳng `../../` hay `key` chứa `/` vào R2 API
 * thì có thể trỏ ra ngoài phạm vi mong muốn. Vì vậy phải khớp regex này
 * TRƯỚC KHI chạm vào R2 — không có ngoại lệ.
 */
export const R2_KEY_RE: RegExp = /^img_[0-9a-f-]{36}\.(jpg|png|webp)$/;

/** Ghi chú tối đa 200 ký tự (theo IMAGES_DESIGN.md). */
const MAX_NOTE_LENGTH = 200;

/** `limit` mặc định và trần cho GET /api/images. */
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Tiền tố log thống nhất của toàn bộ Worker. */
const LOG_PREFIX = "[shop-dashboard]";

/** Map mime đã sniff → đuôi file dùng cho khoá R2. */
const MIME_TO_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Câu thông báo chuẩn khi magic bytes không khớp định dạng nào được nhận. */
const BAD_IMAGE_MESSAGE = "chỉ nhận JPEG/PNG/WebP";

/**
 * Câu SELECT dùng chung cho bảng `images`.
 *
 * Cố ý liệt kê cột TƯỜNG MINH thay vì viết dấu sao: nếu sau này bảng có thêm
 * cột nhạy cảm thì nó sẽ không tự động lọt vào response. Đây cũng là lý do
 * không bao giờ dùng truy vấn "lấy tất cả cột" ở bất kỳ đâu trong dự án.
 */
const IMAGE_SELECT =
  "SELECT id, r2_key, note, mime, size_bytes, sha256, created_at FROM images";

// =====================================================================
// Tiện ích nội bộ
// =====================================================================

/** Ghi log lỗi nội bộ. KHÔNG BAO GIỜ truyền bytes ảnh / note thô / bí mật vào đây. */
function logError(where: string, err: unknown): void {
  console.error(`${LOG_PREFIX} ${where}`, err instanceof Error ? err.message : "?");
}

/**
 * Kiểm tra binding R2 có thật sự tồn tại không.
 *
 * VÌ SAO CẦN: R2 là tính năng phải bật riêng trong Cloudflare Dashboard (chấp
 * nhận điều khoản + thêm phương thức thanh toán). Nếu chưa bật, Worker vẫn
 * deploy được nhưng binding IMAGES sẽ là undefined lúc chạy, và mọi lời gọi
 * `env.IMAGES.put(...)` sẽ ném TypeError → 500 kèm stack trace trong log.
 *
 * Thay vì để trang Ảnh vỡ khó hiểu, ta trả về 503 kèm thông báo tiếng Việt nói
 * rõ cần làm gì. Phần còn lại của dashboard (thống kê, nhật ký) không hề bị ảnh
 * hưởng — chúng không dùng R2.
 */
function r2Ready(env: Env): env is Env & { IMAGES: R2Bucket } {
  return typeof env.IMAGES === "object" && env.IMAGES !== null;
}

/** Response 503 thống nhất khi R2 chưa được bật. */
function r2Unavailable(): Response {
  return jsonError(
    "r2_unavailable",
    "Tính năng ảnh chưa dùng được: bucket R2 chưa được bật cho tài khoản này. " +
      "Vào Cloudflare Dashboard → R2 → bật R2, rồi chạy lại: npx wrangler r2 bucket create shop-images",
    503,
  );
}

/** Cắt chuỗi an toàn cho log/audit (chống chuỗi khổng lồ làm phình log). */
function truncateForLog(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Kiểm tra `key` có đúng định dạng `img_<uuid>.<ext>` không.
 * Dùng lại cho cả view lẫn delete để không có nhánh nào quên validate.
 */
function isValidKey(key: unknown): key is string {
  return typeof key === "string" && R2_KEY_RE.test(key);
}

/** Lấy IP người gọi, chấp nhận cả Request giả trong test (không bao giờ ném lỗi). */
function safeClientIp(request: Request): string {
  try {
    return clientIp(request);
  } catch {
    return "0.0.0.0";
  }
}

/**
 * Ghi audit nhưng KHÔNG BAO GIỜ làm hỏng request.
 * `writeAudit` của lib/response vốn đã tự nuốt lỗi; bọc thêm một lớp ở đây để
 * chắc chắn rằng lỗi bất ngờ (DB chưa migrate, binding sai...) không đổi
 * kết quả HTTP của người dùng.
 */
async function auditSafe(db: D1Database, action: string, detail: string, ip: string): Promise<void> {
  try {
    await writeAudit(db, { action, detail, ip });
  } catch (err) {
    logError("audit failed", err);
  }
}

// =====================================================================
// 1) Nhận dạng định dạng ảnh bằng MAGIC BYTES
// =====================================================================

/**
 * Đọc vài byte ĐẦU TIÊN của file để xác định định dạng thật.
 *
 * QUAN TRỌNG — KHÔNG TIN `Content-Type` DO CLIENT GỬI:
 *   Header `Content-Type` (và cả tên file) là do trình duyệt/kẻ tấn công tự
 *   khai báo, hoàn toàn có thể sai hoặc cố tình giả mạo. Nếu chỉ tin header
 *   thì một file thực thi (`.exe`, `.php`, `.html`...) chỉ cần được đổi tên
 *   thành `evil.jpg` kèm `Content-Type: image/jpeg` là lọt qua. Vì vậy ta đọc
 *   chữ ký nhị phân (magic bytes) nằm ở đầu file — thứ mà kẻ tấn công buộc
 *   phải "đúng thật" nếu muốn file hoạt động như một ảnh:
 *     - JPEG : FF D8 FF                    (offset 0..2)
 *     - PNG  : 89 50 4E 47 0D 0A 1A 0A     (offset 0..7)
 *     - WEBP : "RIFF" (offset 0..3) VÀ "WEBP" (offset 8..11)
 *   Không khớp chữ ký nào → trả `null`, caller từ chối 400. Nhờ đó file `.exe`
 *   đổi tên thành `.jpg` BỊ TỪ CHỐI vì magic bytes của nó không khớp.
 *
 * @param bytes nội dung file (chỉ cần >= 12 byte đầu là đủ để kết luận)
 * @returns mime chuẩn trong ALLOWED_MIMES, hoặc `null` nếu không nhận dạng được.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (!bytes || typeof bytes.length !== "number") return null;

  // --- PNG: 89 50 4E 47 0D 0A 1A 0A (8 byte cố định) ---
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // --- JPEG: FF D8 FF (3 byte) ---
  // Byte thứ 3 thường là FF (SOI + marker) nhưng chỉ cần 3 byte này là đủ đặc trưng.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // --- WEBP: "RIFF" ở offset 0..3 VÀ "WEBP" ở offset 8..11 ---
  // Phải kiểm tra CẢ HAI: "RIFF" một mình còn là WAV/AVI, không phải ảnh.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 //   P
  ) {
    return "image/webp";
  }

  // Không khớp chữ ký nào → không phải ảnh được phép nhận.
  return null;
}

// =====================================================================
// 2) Ghi chú (note)
// =====================================================================

/**
 * Chuẩn hoá `note` do người dùng gửi.
 *
 * - Không phải chuỗi (hoặc rỗng sau khi trim) → `null` (ghi chú là tuỳ chọn).
 * - Trim, gỡ ký tự điều khiển, cắt còn tối đa 200 ký tự.
 * - Chạy qua `redactText` của lib/validate để lưới an toàn chung của dự án
 *   cũng được áp dụng cho văn bản tự do trước khi lưu DB / ghi audit.
 *
 * Lưu ý: `note` là văn bản do CHÍNH chủ ảnh gõ, không phải dữ liệu hệ thống,
 * nên không phải bí mật. Tuy vậy vẫn phải cắt ngắn và gỡ ký tự điều khiển để
 * không thể dùng nó để giả mạo log hay nhét dữ liệu rác vào DB.
 */
export function validateNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  let value = raw;

  // Gỡ ký tự điều khiển (charCode < 0x20 và 0x7F) — kể cả xuống dòng/tab.
  // Ký tự điều khiển có thể phá định dạng log hoặc đầu độc audit_log.
  let cleaned = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    cleaned += value[i];
  }
  value = cleaned;

  // Cắt độ dài TRƯỚC khi redact để không bao giờ redact một chuỗi khổng lồ.
  value = value.trim();
  if (value.length > MAX_NOTE_LENGTH) value = value.slice(0, MAX_NOTE_LENGTH);

  // Lưới an toàn dùng chung của dự án (che các mẫu giống bí mật/acc|pass).
  value = redactText(value);

  value = value.trim();
  if (value.length === 0) return null;
  return value;
}

// =====================================================================
// 3) Khoá R2 + băm SHA-256
// =====================================================================

/**
 * Sinh khoá R2 dạng `img_<uuid>.<ext>`.
 *
 * TUYỆT ĐỐI KHÔNG dùng tên file do client gửi (không dùng `file.name`):
 *   tên gốc có thể chứa `../`, `/`, ký tự điều khiển, hoặc trùng nhau và ghi
 *   đè ảnh của người khác. Dùng UUID v4 ngẫu nhiên vừa chống path traversal
 *   vừa bảo đảm mỗi lần upload là một object riêng, không thể đoán trước.
 *
 * `ext` PHẢI được suy ra từ mime ĐÃ SNIFF (không phải từ mime client khai báo);
 * hàm này chỉ kiểm tra lại một lần nữa cho chắc.
 */
export function makeR2Key(ext: string): string {
  const safeExt = ext === "jpg" || ext === "png" || ext === "webp" ? ext : "bin";
  // crypto.randomUUID() là UUID v4 (36 ký tự, chỉ [0-9a-f-]) → khớp R2_KEY_RE.
  return `img_${crypto.randomUUID()}.${safeExt}`;
}

/** Bảng hex để chuyển byte → 2 ký tự, nhanh hơn toString(16).padStart mỗi byte. */
const HEX_ALPHABET = "0123456789abcdef";

/**
 * Băm nội dung file bằng SHA-256 (Web Crypto), trả về chuỗi hex thường (64 ký tự).
 *
 * `crypto.subtle.digest` nhận `BufferSource`; truyền đúng "cửa sổ" byte của
 * `bytes` (byteOffset/byteLength) để tránh băm nhầm cả ArrayBuffer lớn hơn.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", view);
  const out = new Uint8Array(digest);

  let hex = "";
  for (let i = 0; i < out.length; i++) {
    const byte = out[i] as number;
    hex += HEX_ALPHABET[(byte >> 4) & 0x0f];
    hex += HEX_ALPHABET[byte & 0x0f];
  }
  return hex;
}

// =====================================================================
// 4) Dựng ImageRow từ dòng D1
// =====================================================================

/** Dòng thô của bảng `images` (không bao gồm `url`). */
interface ImageDbRow {
  id: number;
  r2_key: string;
  note: string | null;
  mime: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

/**
 * Ghi chú về TRUY VẤN D1 trong file này (quy tắc bắt buộc):
 *
 *   - Mọi câu SQL là CHUỖI HẰNG NGUYÊN VẸN viết ngay tại chỗ gọi
 *     `db.prepare(...)`: không ghép bằng `+`, không nội suy `${}`, không dựng
 *     SQL từ biến. Nhờ vậy không có bất kỳ đường nào để input người dùng chạm
 *     vào cấu trúc câu lệnh.
 *   - Mọi GIÁ TRỊ động chỉ đi qua `.bind(...)` (prepared statement), kể cả
 *     `limit` của phân trang.
 *   - Cột được liệt kê TƯỜNG MINH (không `SELECT *`) để một cột mới thêm sau
 *     này không thể tự động lọt vào response.
 *
 * Bảng `images` chỉ chứa dữ liệu ảnh (r2_key/note/mime/size_bytes/sha256/
 * created_at). KHÔNG BAO GIỜ thêm cột nào có thể mang acc|pass vào đây.
 */

/** Đường dẫn tải ảnh qua Worker (KHÔNG BAO GIỜ là URL R2 công khai). */
function imageUrl(key: string): string {
  return `/api/images/${key}`;
}

/**
 * Chuyển dòng D1 → `ImageRow` đúng hợp đồng api-types.
 * Ép kiểu số về số nguyên an toàn để client không phải xử lý null/NaN.
 */
function toImageRow(row: ImageDbRow): ImageRow {
  const size = typeof row.size_bytes === "number" && Number.isFinite(row.size_bytes) ? row.size_bytes : 0;
  return {
    id: typeof row.id === "number" ? row.id : 0,
    r2_key: String(row.r2_key),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    mime: String(row.mime),
    size_bytes: Math.trunc(size),
    sha256: String(row.sha256),
    created_at: String(row.created_at),
    url: imageUrl(String(row.r2_key)),
  };
}

// =====================================================================
// 5) GET /api/images — danh sách ảnh mới nhất
// =====================================================================

/**
 * Đọc `limit` từ query: mặc định 50, kẹp trong khoảng 1..200.
 * Giá trị rác (chữ, số âm, số mũ, NaN) → quay về mặc định thay vì 400, để
 * dashboard không vỡ chỉ vì một tham số trang trí.
 */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIST_LIMIT;
  const trimmed = raw.trim();
  // Chỉ nhận chuỗi toàn chữ số: chặn "1e9", "0x10", " 12abc", "+5".
  if (!/^\d{1,9}$/.test(trimmed)) return DEFAULT_LIST_LIMIT;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed > MAX_LIST_LIMIT ? MAX_LIST_LIMIT : parsed;
}

/**
 * GET /api/images?limit=50
 *
 * Trả danh sách ảnh mới nhất (ORDER BY id DESC). Không cần audit cho thao tác
 * chỉ đọc này.
 */
export async function handleImagesList(request: Request, env: Env): Promise<Response> {
  try {
    // (1) XÁC THỰC TRƯỚC — bắt buộc, không có ngoại lệ.
    if (!(await requireAuth(request, env))) return unauthorized();

    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));

    // (2) Prepared statement + bound param (`limit`). `limit` đã được kẹp
    //     1..200 ở parseLimit nên không thể là giá trị bất thường.
    const result = await env.DB.prepare(
      `${IMAGE_SELECT} ORDER BY id DESC LIMIT ?1`,
    )
      .bind(limit)
      .all<ImageDbRow>();

    const rows = Array.isArray(result?.results) ? result.results : [];
    const body: ImagesResponse = { images: rows.map(toImageRow) };

    return jsonOk(body, 200, noStore());
  } catch (err) {
    logError("images list failed", err);
    return serverError();
  }
}

// =====================================================================
// 6) POST /api/images — upload
// =====================================================================

/** Kết quả bóc tách body: bytes ảnh + mime client khai báo (chỉ để đối chiếu). */
interface ParsedUpload {
  bytes: Uint8Array;
  declaredMime: string | null;
  noteRaw: string | null;
}

/** Lấy mime (đã bỏ tham số charset) từ một header Content-Type thô. */
function cleanMime(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.length === 0 ? null : mime;
}

/**
 * Bóc tách body upload thành bytes thô + mime client khai báo + note thô.
 *
 * Nhận CẢ HAI dạng để UI dễ làm (IMAGES_DESIGN.md §Route):
 *   (a) `multipart/form-data`: field file tên bất kỳ (thường là `file`, hoặc
 *       LẤY PART FILE ĐẦU TIÊN nếu không có field nào tên `file`), kèm field
 *       text `note` tuỳ chọn.
 *   (b) raw binary: toàn bộ body là bytes ảnh, ghi chú qua query `?note=...`.
 *
 * @returns `null` nếu thân request không dùng được định dạng nào.
 */
async function readUploadBody(
  request: Request,
  searchParams: URLSearchParams,
): Promise<ParsedUpload | null> {
  const contentTypeHeader = request.headers.get("Content-Type");
  const mime = cleanMime(contentTypeHeader);
  const queryNote = searchParams.get("note");

  if (mime === "multipart/form-data") {
    let form: FormData;
    try {
      form = await request.formData();
    } catch (err) {
      logError("multipart parse failed", err);
      return null;
    }

    const toBytes = async (file: Blob): Promise<Uint8Array> =>
      new Uint8Array(await file.arrayBuffer());

    // Chọn part file: ưu tiên field tên `file`, nếu không có thì lấy part FILE
    // ĐẦU TIÊN (IMAGES_DESIGN.md: "field file tên bất kỳ"). Part text (note)
    // bị bỏ qua vì không có `arrayBuffer`.
    const asFile = (value: unknown): Blob | null =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as Blob).arrayBuffer === "function"
        ? (value as Blob)
        : null;

    let chosen: Blob | null = asFile(form.get("file"));
    if (chosen === null) {
      for (const value of form.values()) {
        const candidate = asFile(value);
        if (candidate !== null) {
          chosen = candidate;
          break;
        }
      }
    }

    if (chosen === null) return null;

    // Mime client khai báo cho part file — CHỈ dùng để đối chiếu/log cảnh báo,
    // không bao giờ dùng để quyết định định dạng thật (xem sniffImageMime).
    const declaredFromPart =
      typeof chosen.type === "string" && chosen.type !== "" ? chosen.type.toLowerCase() : null;

    let bytes: Uint8Array;
    try {
      bytes = await toBytes(chosen);
    } catch (err) {
      logError("multipart read failed", err);
      return null;
    }

    // Ghi chú: ưu tiên field text `note`, nếu không có thì dùng `?note=`.
    const noteEntry = form.get("note");
    const noteRaw = typeof noteEntry === "string" ? noteEntry : queryNote;

    return { bytes, declaredMime: declaredFromPart, noteRaw };
  }

  // --- Raw binary: cả body là ảnh ---
  // Chỉ nhận khi Content-Type không phải multipart. Với raw body, "mime khai
  // báo" chính là header Content-Type của request (nếu có).
  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch (err) {
    logError("raw body read failed", err);
    return null;
  }

  return { bytes: new Uint8Array(buffer), declaredMime: mime, noteRaw: queryNote };
}

/**
 * POST /api/images
 *
 * Luồng: auth → chặn kích thước (Content-Length, rồi số byte thật) → sniff
 * magic bytes → note → key → sha256 → R2 → D1 → audit → 201.
 */
export async function handleImageUpload(request: Request, env: Env): Promise<Response> {
  try {
    // (1) XÁC THỰC TRƯỚC. Chưa đăng nhập thì không đọc body, không chạm R2.
    if (!(await requireAuth(request, env))) return unauthorized();

    // LƯU Ý VỀ THỨ TỰ: kiểm tra R2 có mặt được đặt SAU bước validate magic bytes
    // (xem bước 8), không đặt ở đây. Lý do: nếu chặn sớm, một file .exe đội lốt
    // .jpg sẽ nhận 503 "R2 chưa bật" thay vì 400 "sai định dạng" — tức là ta che
    // mất kết quả kiểm tra an ninh và bộ test nghiệm thu không còn chứng minh
    // được magic bytes hoạt động. Validate luôn phải thắng.

    // (2) Chặn sớm theo Content-Length khi header có mặt (chunked sẽ không có
    //     header này nên vẫn phải kiểm tra lại độ dài thật sau khi đọc).
    const contentLengthHeader = request.headers.get("Content-Length");
    if (contentLengthHeader !== null) {
      const declaredLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
        return jsonError(
          "payload_too_large",
          `Ảnh vượt giới hạn ${MAX_IMAGE_BYTES} byte`,
          413,
        );
      }
    }

    // (3) Đọc body.
    const url = new URL(request.url);
    const parsed = await readUploadBody(request, url.searchParams);
    if (parsed === null) {
      return jsonError("bad_request", "Thiếu dữ liệu ảnh trong request", 400);
    }

    // (3b) Kiểm tra kích thước THẬT (nguồn chân lý, không tin Content-Length).
    if (parsed.bytes.byteLength > MAX_IMAGE_BYTES) {
      return jsonError(
        "payload_too_large",
        `Ảnh vượt giới hạn ${MAX_IMAGE_BYTES} byte`,
        413,
      );
    }
    if (parsed.bytes.byteLength === 0) {
      return jsonError("bad_request", "File rỗng", 400);
    }

    // (4) SNIFF MAGIC BYTES — quyết định định dạng thật của nội dung.
    const sniffedMime = sniffImageMime(parsed.bytes);
    if (sniffedMime === null) {
      // KHÔNG echo lại Content-Type hay tên file do client gửi: chúng là dữ
      // liệu không đáng tin và có thể dùng để dò/đầu độc phía client.
      return jsonError("bad_request", BAD_IMAGE_MESSAGE, 400);
    }

    // (4b) Đối chiếu chéo với Content-Type client khai báo.
    //      Nếu client khai một mime KHÁC với mime đã sniff thì ta VẪN TIN MIME
    //      ĐÃ SNIFF (nội dung file là sự thật, header chỉ là lời khai), chỉ ghi
    //      log cảnh báo để còn truy vết. TUYỆT ĐỐI không dùng mime khai báo để
    //      chọn Content-Type trả về, không dùng để đặt đuôi file, không lưu nó
    //      xuống D1. Nhờ vậy `evil.jpg` khai `image/png` vẫn bị xử lý như JPEG.
    const declaredMime = parsed.declaredMime;
    if (declaredMime !== null && declaredMime !== sniffedMime) {
      // Log cảnh báo: chỉ ghi mime (dữ liệu ngắn, không phải bí mật), KHÔNG ghi
      // tên file của client và KHÔNG ghi nội dung file.
      console.warn(
        `${LOG_PREFIX} images upload: mime khai báo không khớp magic bytes (declared=${truncateForLog(
          declaredMime,
          40,
        )}, sniffed=${sniffedMime})`,
      );
    }

    // (5) Ghi chú: tuỳ chọn, trim, tối đa 200 ký tự, gỡ ký tự điều khiển.
    const note = validateNote(parsed.noteRaw);

    // (6) Khoá R2: UUID ngẫu nhiên, đuôi suy từ MIME ĐÃ SNIFF (không dùng tên
    //     file client gửi → chống path traversal và chống ghi đè).
    const ext = MIME_TO_EXT[sniffedMime] ?? "bin";
    const key = makeR2Key(ext);

    // (7) SHA-256 hex của nội dung.
    const sha = await sha256Hex(parsed.bytes);
    const size = parsed.bytes.byteLength;

    // (7b) ĐÃ validate xong toàn bộ đầu vào (kích thước, magic bytes, ghi chú).
    //      Giờ mới kiểm tra R2 có thật sự được bật hay không. Đặt ở đây để mọi
    //      payload rác vẫn nhận đúng lỗi 400/413 mô tả sai sót của chính nó,
    //      thay vì bị che bằng 503.
    if (!r2Ready(env)) return r2Unavailable();

    // (8) Đưa lên R2 (bucket PRIVATE — không có public URL, không presign).
    //     httpMetadata.contentType lấy từ mime ĐÃ SNIFF, không phải từ client.
    const putOptions: R2PutOptions = {
      httpMetadata: { contentType: sniffedMime },
      customMetadata: { sha256: sha },
    };
    await env.IMAGES.put(key, parsed.bytes, putOptions);

    // (9) Ghi D1. Prepared statement, bound params, KHÔNG nối chuỗi SQL và
    //     KHÔNG có `${}` trong câu SQL. created_at do SQLite sinh.
    let inserted: { id: number; created_at: string } | null = null;
    try {
      inserted = await env.DB.prepare(
        `INSERT INTO images (r2_key, note, mime, size_bytes, sha256, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         RETURNING id, created_at`,
      )
        .bind(key, note, sniffedMime, size, sha)
        .first<{ id: number; created_at: string }>();

      // D1 có thể trả null cho RETURNING tuỳ phiên bản → đọc lại theo r2_key
      // (r2_key là UNIQUE nên tra cứu này luôn xác định).
      if (inserted === null || inserted === undefined || typeof inserted.id !== "number") {
        inserted = await env.DB.prepare(
          `SELECT id, created_at FROM images WHERE r2_key = ?1`,
        )
          .bind(key)
          .first<{ id: number; created_at: string }>();
      }
    } catch (dbErr) {
      // R2 đã ghi thành công nhưng D1 lỗi → PHẢI xoá object vừa ghi để tránh
      // rác trong bucket (object mồ côi không có dòng D1 nào trỏ tới, không bao
      // giờ xem/xoá được qua UI). Xoá thất bại cũng chỉ log, không đổi mã lỗi.
      try {
        await env.IMAGES.delete(key);
      } catch (cleanupErr) {
        logError("rollback R2 after failed insert", cleanupErr);
      }
      throw dbErr;
    }

    // (10) Audit. `detail` chứa key + kích thước + ghi chú ĐÃ được làm sạch qua
    //      redactText và cắt ngắn. Ghi chú là văn bản tự do của chính chủ ảnh
    //      (không phải bí mật hệ thống), nhưng vẫn đi qua redactText để lưới an
    //      toàn chung của dự án chặn mọi mẫu giống acc|pass trước khi vào DB.
    const detailParts = [`ảnh ${key}`, `${size} byte`];
    if (note !== null) detailParts.push(truncateForLog(note, MAX_NOTE_LENGTH));
    await auditSafe(env.DB, "upload", detailParts.join(" "), safeClientIp(request));

    // (11) 201 + ImageRow đầy đủ.
    const row: ImageDbRow = {
      id: inserted?.id ?? 0,
      r2_key: key,
      note,
      mime: sniffedMime,
      size_bytes: size,
      sha256: sha,
      created_at: inserted?.created_at ?? "",
    };
    const body: ImageUploadResponse = { ok: true, image: toImageRow(row) };

    return jsonOk(body, 201, noStore());
  } catch (err) {
    // Không lộ stack trace ra ngoài; chỉ log message nội bộ.
    logError("image upload failed", err);
    return serverError();
  }
}

// =====================================================================
// 7) GET /api/images/:key — trả bytes ảnh (bắt buộc đăng nhập)
// =====================================================================

/**
 * GET /api/images/:key
 *
 * Yêu cầu đăng nhập TRƯỚC KHI chạm R2 (IMAGES_DESIGN.md §Bảo mật, điều 7):
 * ảnh phải KHÔNG thể truy cập được khi chưa đăng nhập, kể cả khi biết key.
 */
export async function handleImageView(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  try {
    // (1) XÁC THỰC TRƯỚC — đây là điều kiện nghiệm thu, không được đảo thứ tự.
    if (!(await requireAuth(request, env))) return unauthorized();

    // (1b) R2 phải có mặt, nếu không trả 503 rõ ràng thay vì 500.
    if (!r2Ready(env)) return r2Unavailable();

    // (2) Validate key theo regex TRƯỚC KHI chạm R2 (chống path traversal):
    //     key đến từ URL nên do người dùng kiểm soát; không khớp regex thì trả
    //     404 luôn, tuyệt đối không đưa chuỗi đó xuống R2 API.
    if (!isValidKey(key)) {
      return jsonError("not_found", "Không tìm thấy ảnh", 404);
    }

    // (3) Tra D1 để lấy mime thật đã lưu lúc upload.
    const row = await env.DB.prepare(`${IMAGE_SELECT} WHERE r2_key = ?1`)
      .bind(key)
      .first<ImageDbRow>();

    // (4) Lấy object từ R2 private.
    const object = await env.IMAGES.get(key);
    if (object === null || object === undefined) {
      // Có thể D1 còn dòng nhưng object đã bị xoá tay trên bucket → 404.
      return jsonError("not_found", "Không tìm thấy ảnh", 404);
    }
    if (row === null || row === undefined) {
      // Ngược lại: object tồn tại nhưng không có dòng D1 → coi như không hợp lệ.
      return jsonError("not_found", "Không tìm thấy ảnh", 404);
    }

    // (5) Content-Type: ưu tiên mime trong D1 (do server quyết định lúc upload),
    //     dự phòng httpMetadata của R2 nếu cột mime vì lý do nào đó trống.
    const metaMime =
      object.httpMetadata && typeof object.httpMetadata.contentType === "string"
        ? object.httpMetadata.contentType
        : null;
    const declared = typeof row.mime === "string" && row.mime.length > 0 ? row.mime : metaMime;
    const contentType =
      declared !== null && (ALLOWED_MIMES as readonly string[]).includes(declared)
        ? declared
        : "application/octet-stream";

    // (6) Header trả ảnh: không cache, không sniff, không cho nhúng vào context
    //     có script. CSP `sandbox` + `default-src 'none'` biến mọi nội dung bị
    //     lọt thành vô hại. KHÔNG BAO GIỜ dựng URL R2 công khai ở đây.
    const sizeBytes =
      typeof object.size === "number" && Number.isFinite(object.size)
        ? Math.trunc(object.size)
        : row.size_bytes;

    const headers = new Headers();
    headers.set("Content-Type", contentType);
    headers.set("Content-Length", String(sizeBytes));
    headers.set("Content-Disposition", "inline");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cache-Control", "private, no-store");
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");

    // (7) Stream thẳng body của R2 ra client (không nạp cả ảnh vào RAM lần nữa).
    return new Response(object.body, { status: 200, headers });
  } catch (err) {
    logError("image view failed", err);
    return serverError();
  }
}

// =====================================================================
// 8) DELETE /api/images/:key
// =====================================================================

/**
 * DELETE /api/images/:key
 *
 * Xoá object trên R2, xoá dòng D1, ghi audit `delete` (có kèm note đã redact).
 */
export async function handleImageDelete(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  try {
    // (1) XÁC THỰC TRƯỚC.
    if (!(await requireAuth(request, env))) return unauthorized();

    // (1b) R2 phải có mặt, nếu không trả 503 rõ ràng thay vì 500.
    if (!r2Ready(env)) return r2Unavailable();

    // (2) Validate key trước khi chạm R2 (chống path traversal).
    if (!isValidKey(key)) {
      return jsonError("not_found", "Không tìm thấy ảnh", 404);
    }

    // (3) Phải có dòng D1 tương ứng mới cho xoá (404 nếu không biết ảnh).
    const row = await env.DB.prepare(`${IMAGE_SELECT} WHERE r2_key = ?1`)
      .bind(key)
      .first<ImageDbRow>();

    if (row === null || row === undefined) {
      return jsonError("not_found", "Không tìm thấy ảnh", 404);
    }

    // (4) Xoá R2 TRƯỚC, rồi mới xoá D1: nếu xoá D1 trước mà xoá R2 lỗi thì
    //     object sẽ mồ côi vĩnh viễn (không còn cách nào tìm ra nó qua UI).
    //     Lỗi R2 ở đây được ném ra → 500, dòng D1 vẫn còn để admin thử lại.
    await env.IMAGES.delete(key);

    await env.DB.prepare(`DELETE FROM images WHERE r2_key = ?1`).bind(key).run();

    // (5) Audit: key + ghi chú đã làm sạch (redactText) để còn dấu vết ai xoá gì.
    const note = row.note === null || row.note === undefined ? null : String(row.note);
    const detailParts = [`xoá ảnh ${key}`];
    if (note !== null) detailParts.push(truncateForLog(note, MAX_NOTE_LENGTH));
    await auditSafe(env.DB, "delete", detailParts.join(" "), safeClientIp(request));

    return jsonOk({ ok: true }, 200, noStore());
  } catch (err) {
    logError("image delete failed", err);
    return serverError();
  }
}
