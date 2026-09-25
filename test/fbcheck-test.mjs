/**
 * =============================================================================
 * test/fbcheck-test.mjs — kiểm tra tính năng kiểm tra UID Facebook
 * =============================================================================
 *
 * Chạy:  node test/fbcheck-test.mjs
 *
 * Chia làm 2 phần:
 *
 *   PHẦN 1 — LOGIC TĨNH (không cần mạng, luôn chạy được)
 *     Kiểm tra hàm `parseUidList`/`extractUidFromLine` với dữ liệu thật lấy từ
 *     ảnh chụp màn hình, cộng thêm ca bệnh: input rác, UID trùng, UID quá dài,
 *     hình thức `acc|pass` (không bao giờ được chứa vào danh sách UID).
 *
 *   PHẦN 2 — GỌI THẬT (cần mạng, tự bỏ qua nếu không ra được internet)
 *     Gọi endpoint công khai của Meta với UID có kết quả ĐÃ BIẾT TRƯỚC để
 *     chứng minh bộ phân loại 302=LIVE / 400=DIE vẫn đúng. Nếu mạng không có,
 *     script báo "bỏ qua" chứ KHÔNG báo pass — không bao giờ báo đạt khi chưa
 *     thực sự kiểm chứng.
 *
 * Điểm phân biệt với acceptance.mjs: file này chạm vào mạng bên ngoài, nên tách
 * riêng để phần kiểm tra tĩnh của acceptance.mjs vẫn chạy offline được.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

function ok(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skipTest(name, reason) {
  skip++;
  console.log(`  \u2296 ${name} — bỏ qua: ${reason}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/* ===========================================================================
 * PHẦN 1 — LOGIC TĨNH
 * ========================================================================= */

/**
 * Nạp hàm validate từ chính module đang chạy trên production.
 *
 * Node 24 tự bóc kiểu (type stripping) nên import thẳng file `.ts` được.
 * `src/lib/uid-input.ts` cố ý dependency-free, nên import nó không kéo theo D1
 * hay bất kỳ binding nào. Cách này kiểm đúng MÃ ĐANG CHẠY thay vì viết lại logic
 * trong test — viết lại thì test có thể đạt trong khi sản phẩm hỏng.
 */
async function loadUidHelpers() {
  try {
    const mod = await import("../src/lib/uid-input.ts");
    if (typeof mod.extractUidFromLine !== "function" || typeof mod.parseUidList !== "function") {
      return null;
    }
    return { extractUidFromLine: mod.extractUidFromLine, parseUidList: mod.parseUidList };
  } catch (err) {
    console.log(`      (không nạp được TypeScript: ${err && err.message})`);
    return null;
  }
}

section("1. LOGIC CHUẨN HOÁ DANH SÁCH UID");

const helpers = await loadUidHelpers();

if (!helpers) {
  ok("Nạp được hàm validate từ src/api/fbcheck.ts", false, "không tìm thấy khối hàm");
} else {
  const { extractUidFromLine, parseUidList } = helpers;
  ok("Nạp được hàm validate từ src/api/fbcheck.ts", true);

  // --- UID thuần ---
  ok("UID thuần được giữ nguyên", extractUidFromLine("61579461239864") === "61579461239864");

  ok(
    "Khoảng trắng quanh UID được cắt",
    extractUidFromLine("  61579461239864  ") === "61579461239864",
  );

  // --- URL profile ---
  ok(
    "URL profile.php?id= được rút ra UID",
    extractUidFromLine("https://www.facebook.com/profile.php?id=61579461239864") === "61579461239864",
  );

  ok(
    "URL có vế phụ &ref= vẫn rút được UID",
    extractUidFromLine("https://www.facebook.com/profile.php?id=61579461239864&ref=bookmarks") ===
      "61579461239864",
  );

  ok(
    "URL không có www vẫn rút được UID",
    extractUidFromLine("facebook.com/profile.php?id=123456") === "123456",
  );

  // --- Dòng bẩn ---
  ok("Dòng rỗng trả null", extractUidFromLine("") === null);
  ok("Dòng toàn chữ trả null", extractUidFromLine("abc xyz") === null);
  ok("Dòng trộn chữ và số không phải UID thì trả null", extractUidFromLine("uid 12345") === null);
  ok(
    "UID quá dài (>25 chữ số) bị từ chối",
    extractUidFromLine("1".repeat(26)) === null,
    "phải trả null vì trên 25 ký tự",
  );
  ok(
    "UID 25 chữ số vẫn nhận",
    extractUidFromLine("1".repeat(25)) === "1".repeat(25),
    "trả về phải là chuỗi, không phải số — số 25 chữ số vượt quá độ chính xác của number",
  );
  ok(
    "UID giữ nguyên dạng chuỗi (không bị ép thành number)",
    typeof extractUidFromLine("123456789012345") === "string",
  );

  // --- Dạng nguy hiểm: acc|pass KHÔNG BAO GIỜ được nuốt vào UID ---
  ok(
    "acc|pass KHÔNG bị hiểu thành UID",
    extractUidFromLine("taikhoan01|matkhau01") === null,
    "đây là ranh giới quan trọng: nội dung kho hàng không được lọt vào đây",
  );

  // --- Danh sách nhiều dòng: dùng UID thật lấy từ ảnh chụp màn hình ---
  const REAL_LIST = [
    "61580682967332",
    "61579461239864",
    "61582263437248",
    "61579461360216",
    "61578994978587",
    "61579518082356",
  ].join("\n");

  const parsedReal = parseUidList(REAL_LIST);
  ok("Danh sách 6 UID trong ảnh được đọc đủ 6", parsedReal.uids.length === 6, `đọc được ${parsedReal.uids.length}`);
  ok("Danh sách trong ảnh không có dòng hỏng", parsedReal.invalid === 0, `invalid=${parsedReal.invalid}`);
  ok(
    "Thứ tự UID giữ nguyên như người dùng gõ",
    parsedReal.uids[0] === "61580682967332" && parsedReal.uids[5] === "61579518082356",
  );

  // --- Loại bỏ trùng ---
  const parsedDup = parseUidList("111\n222\n111\n222\n333");
  ok("UID trùng bị loại, giữ lại 3 UID", parsedDup.uids.length === 3, `đọc được ${parsedDup.uids.length}`);

  // --- Phân tách theo dấu phẩy / tab (người dùng copy từ bảng tính) ---
  const parsedCsv = parseUidList("111,222,333");
  ok("Danh sách phân tách bằng dấu phẩy", parsedCsv.uids.length === 3, `đọc được ${parsedCsv.uids.length}`);

  const parsedTab = parseUidList("111\t222\t333");
  ok("Danh sách phân tách bằng TAB (copy từ Excel)", parsedTab.uids.length === 3, `đọc được ${parsedTab.uids.length}`);

  const parsedSemicolon = parseUidList("111;222;333");
  ok("Danh sách phân tách bằng dấu chấm phẩy", parsedSemicolon.uids.length === 3, `đọc được ${parsedSemicolon.uids.length}`);

  // --- JSON ---
  const parsedJson = parseUidList(JSON.stringify({ uids: ["111", "222"] }));
  ok("JSON { uids: [...] } được hiểu", parsedJson.uids.length === 2, `đọc được ${parsedJson.uids.length}`);

  const parsedJsonArray = parseUidList(JSON.stringify(["111", "222"]));
  ok("JSON mảng thuần được hiểu", parsedJsonArray.uids.length === 2, `đọc được ${parsedJsonArray.uids.length}`);

  // ĐÂY chính là thứ public/js/uid.js gửi lên: {"uids": "<cả khối văn bản>"}.
  // Trường hợp này TỪNG HỎNG (parser chỉ nhận mảng) khiến mọi lần bấm nút đều
  // báo "Danh sách rỗng". Giữ test này để không tái phát.
  const parsedJsonString = parseUidList(
    JSON.stringify({ uids: "61580682967332\n61579461239864\n61582263437248" }),
  );
  ok(
    'JSON {"uids": "<văn bản nhiều dòng>"} được hiểu (đúng thứ trang web gửi)',
    parsedJsonString.uids.length === 3,
    `đọc được ${parsedJsonString.uids.length}, cần 3`,
  );
  ok(
    "JSON chuỗi nhiều dòng giữ nguyên thứ tự UID",
    parsedJsonString.uids[0] === "61580682967332" &&
      parsedJsonString.uids[2] === "61582263437248",
  );

  const parsedJsonStringCsv = parseUidList(JSON.stringify({ uids: "111,222,333" }));
  ok(
    "JSON chuỗi phân tách bằng dấu phẩy cũng tách được",
    parsedJsonStringCsv.uids.length === 3,
    `đọc được ${parsedJsonStringCsv.uids.length}`,
  );

  const parsedBrokenJson = parseUidList('{"uids": [111,');
  ok("JSON hỏng không làm vỡ, trả về danh sách rỗng", parsedBrokenJson.uids.length === 0);

  // --- Dòng hỏng được đếm, không làm hỏng cả danh sách ---
  const parsedMixed = parseUidList("111\nxyz\n222\nabc|def\n333");
  ok("Danh sách trộn cả UID hợp lệ lẫn dòng rác", parsedMixed.uids.length === 3, `đọc được ${parsedMixed.uids.length}`);
  ok("Dòng rác được đếm vào `invalid`", parsedMixed.invalid === 2, `invalid=${parsedMixed.invalid}, cần 2`);

  // --- Rỗng ---
  const parsedEmpty = parseUidList("   \n\n  ");
  ok("Danh sách rỗng trả về 0 UID", parsedEmpty.uids.length === 0);
  ok("Danh sách rỗng KHÔNG báo dòng hỏng", parsedEmpty.invalid === 0);

  // --- Không bao giờ rò rỉ nội dung acc|pass ---
  const parsedCreds = parseUidList("user01|pass01\n111\n222|333");
  ok(
    "Dòng acc|pass không bao giờ lọt vào kết quả",
    parsedCreds.uids.length === 1 && parsedCreds.uids[0] === "111",
    `uids=${JSON.stringify(parsedCreds.uids)}`,
  );
}

/* ===========================================================================
 * PHẦN 1b — KIỂM TRA TÍNH NHẤT QUÁN CỦA MÃ NGUỒN
 * ========================================================================= */

section("2. MÃ NGUỒN CÓ ĐÚNG NHỮNG GÌ ĐÃ CAM KẾT KHÔNG");

const srcPath = join(ROOT, "src", "api", "fbcheck.ts");
if (existsSync(srcPath)) {
  const src = readFileSync(srcPath, "utf8");

  ok(
    "Có `redirect: \"manual\"` — bắt buộc, vì status 302 CHÍNH LÀ tín hiệu LIVE",
    src.includes('redirect: "manual"'),
    "thiếu thì Worker đi theo redirect và mất tín hiệu phân loại",
  );

  ok("Hạn chế số UID mỗi lần gọi", /MAX_UIDS_PER_REQUEST\s*=\s*\d+/.test(src));

  ok("Có timeout cho mỗi request tới Meta", src.includes("AbortController"));

  ok(
    "Lỗi mạng / timeout KHÔNG bị coi là `die`",
    /verdict:\s*"unknown"/.test(src),
    "thiếu thì người dùng sẽ xoá nhầm tài khoản đang tốt",
  );

  ok(
    "Không dùng cookie / token / đăng nhập / proxy",
    !/cookie|Authorization|Bearer|proxy/i.test(src.replace(/^\s*\*.*$/gm, "")),
    "chỉ được gọi endpoint công khai",
  );

  ok(
    "Không có SQL nối chuỗi (mọi truy vấn đều prepared + bind)",
    !/(prepare|SELECT|INSERT|DELETE|UPDATE)\s*\([^)]*\+/.test(src),
  );

  ok("Audit chỉ ghi số liệu tổng hợp, không ghi danh sách UID", /total=.*live=.*die=/.test(src));

  // Worker huỷ promise chưa hoàn tất ngay khi handler trả response, nên ghi log
  // kiểu fire-and-forget (`void audit(...)`) sẽ không bao giờ chạy. Đã gặp lỗi
  // này thật: audit_log luôn rỗng dù đã gọi API hàng chục lần.
  // Bỏ qua dòng chú thích để những từ khoá nằm trong comment không gây nhiễu.
  const codeOnly2 = src
    .split("\n")
    .filter((line) => !/^\s*(\/\*|\*|\/\/)/.test(line))
    .join("\n");

  const auditCall = codeOnly2.match(/(?:^|\n)\s*(void\s+|await\s+)?auditSafe\(/);
  ok(
    "Ghi audit được `await` — không bỏ `void` (nếu không sẽ không bao giờ ghi log)",
    !!auditCall && /await/.test(auditCall[0]),
    auditCall ? `tìm thấy lời gọi: "${auditCall[0].trim()}"` : "không tìm thấy lời gọi auditSafe",
  );
} else {
  ok("Tồn tại src/api/fbcheck.ts", false);
}

// Trang HTML phải tải đúng script và có đủ 3 khung kết quả.
const uidHtmlPath = join(ROOT, "public", "uid.html");
if (existsSync(uidHtmlPath)) {
  const html = readFileSync(uidHtmlPath, "utf8");
  ok("uid.html nạp /js/uid.js", html.includes('/js/uid.js'));
  ok("uid.html có ô nhập danh sách UID", html.includes('id="uid-input"'));
  // Kiểm tra theo ID, KHÔNG theo chữ hiển thị. Tiêu đề khung có thể đổi câu chữ
  // khi làm lại giao diện (từng đổi từ "Tài khoản Live" thành "LIVE", làm test
  // báo đỏ oan trong khi chức năng vẫn đúng). ID mới là hợp đồng JS bám vào.
  ok("uid.html có khung LIVE", html.includes('id="uid-live-list"'));
  ok("uid.html có khung DIE", html.includes('id="uid-die-list"'));
  ok("uid.html có khung chưa xác định", html.includes('id="uid-unknown-list"'));
  ok(
    "uid.html có nút Copy cho nhóm Live và Die",
    /data-copy="live"/.test(html) && /data-copy="die"/.test(html),
  );
  ok("uid.html nạp scroll.css (hiệu ứng cuộn chuẩn dự án)", html.includes("/css/scroll.css"));
  ok("uid.html KHÔNG nhúng script inline (CSP chặn)", !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html));
} else {
  ok("Tồn tại public/uid.html", false);
}

// uid.js không được dùng innerHTML với dữ liệu server.
// Bỏ QUA dòng chú thích trước, vì chính comment của dự án cũng nhắc tới
// innerHTML — tìm trong cả file sẽ báo dương tính giả.
const uidJsPath = join(ROOT, "public", "js", "uid.js");
if (existsSync(uidJsPath)) {
  const js = readFileSync(uidJsPath, "utf8");
  const codeOnly = js
    .split("\n")
    .filter((line) => !/^\s*(\/\*|\*|\/\/)/.test(line))
    .join("\n");

  ok(
    "uid.js KHÔNG dùng innerHTML để chèn dữ liệu từ server",
    !/\.innerHTML\s*[+]?=/.test(codeOnly),
    "phải dùng createElement + textContent để không bị XSS",
  );
  ok("uid.js xử lý 401 bằng cách về trang đăng nhập", js.includes("/login.html?next="));
} else {
  ok("Tồn tại public/js/uid.js", false);
}

/* ===========================================================================
 * PHẦN 2 — GỌI THẬT (mạng)
 * ========================================================================= */

section("3. KIỂM CHỨNG THẬT VỚI META (cần mạng)");

/**
 * Gọi đúng endpoint mà Worker dùng, KHÔNG theo redirect, đọc status.
 * Hàm này CỐ TÝ sao chép logic trong src/api/fbcheck.ts.
 */
async function probe(uid) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://graph.facebook.com/v23.0/${uid}/picture?type=normal`, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "*/*" },
      signal: controller.signal,
    });
    const loc = res.headers.get("Location") || "";
    return { status: res.status, isDefaultAvatar: loc.includes("static.xx.fbcdn.net") };
  } finally {
    clearTimeout(timer);
  }
}

// Kết quả ĐÃ BIẾT TRƯỚC, lấy từ ảnh chụp màn hình + UID chắc chắn không tồn tại.
const LIVE_CASES = [
  ["4", "Mark Zuckerberg (chắc chắn tồn tại)"],
  ["61579461239864", "UID trong ảnh, cột Live"],
  ["61578994978587", "UID trong ảnh, cột Live"],
];
const DIE_CASES = [
  ["999999999999999", "chưa từng tồn tại"],
  ["1000000000000001", "chưa từng tồn tại"],
];

let networkOk = true;
try {
  const first = await probe("4");
  if (first.status === null) networkOk = false;
} catch {
  networkOk = false;
}

if (!networkOk) {
  skipTest("Bộ phân loại 302=LIVE / 400=DIE", "không gọi được graph.facebook.com từ máy này");
  console.log("      (Phần này CHỈ chạy được khi có mạng. Không có mạng = KHÔNG có kết quả,");
  console.log("       không phải là 'đã kiểm chứng'.)");
} else {
  for (const [uid, label] of LIVE_CASES) {
    try {
      const r = await probe(uid);
      ok(
        `LIVE: ${uid} → 302 (${label})`,
        r.status === 302,
        `nhận HTTP ${r.status}`,
      );
    } catch (err) {
      skipTest(`LIVE: ${uid}`, String(err && err.message));
    }
  }

  for (const [uid, label] of DIE_CASES) {
    try {
      const r = await probe(uid);
      ok(
        `DIE: ${uid} → 400 (${label})`,
        r.status === 400,
        `nhận HTTP ${r.status}`,
      );
    } catch (err) {
      skipTest(`DIE: ${uid}`, String(err && err.message));
    }
  }
}

/* ===========================================================================
 * TỔNG KẾT
 * ========================================================================= */

console.log(`\n${"-".repeat(60)}`);
console.log(`ĐẠT: ${pass}   KHÔNG ĐẠT: ${fail}   BỎ QUA: ${skip}`);
if (failures.length) {
  console.log("\nCác mục không đạt:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("-".repeat(60));

process.exit(fail > 0 ? 1 : 0);
