/**
 * src/lib/uid-input.ts — Chuẩn hoá danh sách UID Facebook người dùng dán vào.
 *
 * Module này CỐ TÌNH dependency-free (không import gì từ dự án) để có thể
 * unit-test độc lập — cùng lý do với src/lib/validate.ts. Toàn bộ logic
 * parse UID nằm ở đây; src/api/fbcheck.ts chỉ lo phần gọi mạng.
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH (CONTRACT.md §0):
 *   Bảng `stock` của shop có cột `content` chứa cặp `acc|pass` thật.
 *   Ở đây chỉ có MỘT LOẠI SỐ ĐỊNH DANH CÔNG KHAI: UID Facebook.
 *   Hàm này KHÔNG đọc DB, KHÔNG log, KHÔNG trả về nội dung kho hàng.
 *
 *   Ranh giới quan trọng: dòng có hình dạng `acc|pass` KHÔNG BAO GIỜ được hiểu
 *   thành UID (xem `extractUidFromLine`). Nếu ai đó lỡ dán nhầm hàng vào ô nhập,
 *   nó bị đếm là dòng hỏng và bị bỏ qua — không được gửi đi đâu cả.
 */

/**
 * UID Facebook hợp lệ: 1..25 chữ số.
 *
 * UID thực tế thường 10–18 chữ số, nhưng ta cố ý thả rộng để không vô tình loại
 * nhầm một tài khoản hợp pháp. Siết chặt ở chỗ khác (giới hạn số lượng, rate
 * limit) thay vì ở đây.
 */
const UID_RE = /^[0-9]{1,25}$/;

/** Tham số `id`/`ids` trong URL profile Facebook. */
const URL_ID_RE = /(?:[?&](?:id|ids|profile_id|user_id)=)([0-9]{1,25})(?![0-9])/i;

/** Dấu phân tách dòng khi dán từ trình soạn thảo hoặc copy từ bảng tính. */
const LINE_SPLIT_RE = /[\r\n,;\t]+/;

/**
 * Rút UID ra khỏi một dòng người dùng dán.
 *
 * Người dùng thường copy thẳng từ trang quản lý hoặc từ ảnh chụp màn hình, nên
 * dòng đầu vào có thể là:
 *   - số thuần:            61579461239864
 *   - URL profile:         https://www.facebook.com/profile.php?id=61579461239864
 *   - URL có vế phụ:       ...?id=61579461239864&ref=bookmarks
 *
 * Còn dòng chứa CHỮ (kể cả `acc|pass`) thì trả `null` thay vì cố đoán — đoán
 * thêm là cách nhanh nhất để lọt input rác vào truy vấn Meta.
 *
 * @returns UID đã chuẩn hoá, hoặc null nếu dòng này không ra UID.
 */
export function extractUidFromLine(rawLine: string): string | null {
  const line = rawLine.trim();
  if (line === "") return null;

  // Trường hợp phổ biến nhất: dòng CHỈ gồm chữ số.
  if (UID_RE.test(line)) return line;

  // Có chữ → thử lấy từ tham số ?id= trong URL profile.
  const fromQuery = URL_ID_RE.exec(line);
  if (fromQuery && fromQuery[1]) return fromQuery[1];

  return null;
}

/** Kết quả tách danh sách UID: mảng UID hợp lệ + số dòng không ra được UID. */
export interface ParsedUidList {
  /** UID hợp lệ, đã bỏ trùng, giữ nguyên thứ tự người dùng gõ. */
  uids: string[];
  /** Số dòng không ra được UID. KHÔNG lưu nội dung dòng đó. */
  invalid: number;
}

/**
 * Tách danh sách UID từ body thô.
 *
 * Nhận `text` nguyên bản của request (dán một khối nhiều dòng là cách nhanh
 * nhất, không cần JS), đồng thời nhận JSON cho trường hợp gọi bằng `fetch`.
 *
 * Ba dạng JSON đều phải chạy được, vì cả ba đều là cách người dùng thật dán:
 *   - `{"uids": ["111", "222"]}`          — mảng (mỗi phần tử một UID)
 *   - `{"uids": "111\n222"}`              — MỘT CHUỖI nhiều dòng, đây chính là
 *     thứ public/js/uid.js gửi lên: nó dán cả khối vào ô textarea rồi gửi nguyên
 *     văn bản.
 *   - `["111", "222"]`                    — mảng thuần
 *
 * Văn bản thuần được tách theo Cả xuống dòng lẫn dấu phẩy/chấm phẩy/TAB,
 * vì người dùng hay copy từ bảng tính, nơi phân cách là TAB chứ không phải
 * xuống dòng.
 */
export function parseUidList(text: string): ParsedUidList {
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
        rawLines = list.map((v) =>
          typeof v === "string" ? v : typeof v === "number" ? String(v) : "",
        );
      } else if (typeof list === "string") {
        // `{"uids": "111\n222"}` — tách theo mọi dấu phân tách như văn bản thuần.
        rawLines = list.split(LINE_SPLIT_RE);
      }
    } catch {
      // JSON hỏng → coi như người dùng dán thẳng văn bản, thử tách ở dưới.
      rawLines = trimmed.split(LINE_SPLIT_RE);
    }
  } else {
    rawLines = trimmed.split(LINE_SPLIT_RE);
  }

  const seen = new Set<string>();
  const uids: string[] = [];
  let invalid = 0;

  for (const line of rawLines) {
    const uid = extractUidFromLine(line);
    if (uid === null) {
      // Dòng rỗng thì không tính là lỗi.
      if (line.trim() === "") continue;
      invalid++;
      continue;
    }
    if (seen.has(uid)) continue;
    seen.add(uid);
    uids.push(uid);
  }

  return { uids, invalid };
}
