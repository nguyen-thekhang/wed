#!/usr/bin/env node
/**
 * test/asset-whitelist.mjs — KHOÁ CHỐNG HỒI QUY cho lỗi "asset công khai bị 302".
 *
 * Chạy:
 *   node test/asset-whitelist.mjs                       # chỉ kiểm tra tĩnh (không cần server)
 *   node test/asset-whitelist.mjs --base http://127.0.0.1:8799
 *   PROD_URL=https://... node test/asset-whitelist.mjs --base "$PROD_URL"
 *
 * ---------------------------------------------------------------------------
 * VÌ SAO CÓ FILE NÀY (lỗi thật đã kiểm chứng trên production)
 * ---------------------------------------------------------------------------
 * Worker chỉ phục vụ miễn phí những path nằm trong `PUBLIC_ASSET_PATHS`
 * (src/index.ts). Mọi path khác, khi chưa có cookie phiên, bị 302 đá về
 * /login.html?next=...
 *
 * Ba tệp của TRANG ĐĂNG NHẬP từng thiếu trong danh sách đó:
 *     /css/preloader.css  -> màn hình chờ mất toàn bộ CSS
 *     /js/preloader.js    -> màn hình chờ KHÔNG BAO GIỜ được gỡ
 *     /img/logo.svg       -> biểu trưng vỡ
 * Hậu quả: khối "0 % Đang tải" trơ trọi nằm trên form đăng nhập.
 *
 * Bộ test cũ không bắt được vì nó chỉ hỏi "HTTP status là gì" chứ không hỏi
 * "path này có được phép công khai không". File này hỏi đúng câu đó, và hỏi
 * NGAY TRÊN SOURCE OF TRUTH (`PUBLIC_ASSET_PATHS` trong src/index.ts), không
 * chép lại danh sách — chép lại thì danh sách sẽ trôi khỏi code thật.
 *
 * ---------------------------------------------------------------------------
 * NỘI DUNG KIỂM TRA
 * ---------------------------------------------------------------------------
 *   A. Phân tích PUBLIC_ASSET_PATHS từ src/index.ts bằng regex.
 *   B. Trích mọi tham chiếu cục bộ (bắt đầu bằng "/") trong 6 trang HTML:
 *      <script src>, <link rel="stylesheet" href>, <img src>, <use href>.
 *   C. login.html (trang CÔNG KHAI duy nhất): mọi tham chiếu phải nằm trong
 *      PUBLIC_ASSET_PATHS (hoặc là một trang của luồng đăng nhập). Đây chính là
 *      lưới bắt lỗi production ở trên.
 *   D. Năm trang CẦN ĐĂNG NHẬP: mọi tham chiếu phải tồn tại thật dưới public/
 *      (bắt lỗi gõ sai tên tệp và tham chiếu chết).
 *   E. (tuỳ chọn, --base <url>): tải từng asset của login.html với redirect
 *      TẮT, khẳng định HTTP 200.
 *
 * Không dùng thư viện ngoài. Thoát mã 1 nếu có lỗi, 0 nếu đạt.
 *
 * GHI CHÚ QUAN TRỌNG KHI DÙNG --base:
 *   Phải trỏ vào Worker thật (wrangler dev hoặc production). Máy chủ tĩnh xem
 *   trước (chỉ phục vụ public/, KHÔNG có xác thực) sẽ không nói lên điều gì về
 *   hành vi 302 của Worker.
 */

import { readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");
const INDEX_TS = join(ROOT, "src", "index.ts");

/** Sáu trang HTML của dashboard. login.html là trang công khai duy nhất. */
const PAGE_FILES = ["login.html", "index.html", "logs.html", "images.html", "uid.html", "tickxanh.html"];
const PUBLIC_PAGE = "login.html";
const AUTH_PAGES = PAGE_FILES.filter((p) => p !== PUBLIC_PAGE);

/**
 * Trang thuộc luồng đăng nhập: được phép xuất hiện trong tham chiếu của
 * login.html dù không phải asset. Hiện login.html không trỏ sang trang nào
 * khác, nhưng giữ đây để việc thêm liên kết hợp lệ không bị báo lỗi giả.
 */
const LOGIN_FLOW_PAGES = new Set(["/login", "/login.html"]);

/* -------------------------------------------------------------------------- */
/* Khung báo cáo                                                              */
/* -------------------------------------------------------------------------- */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* A. Phân tích PUBLIC_ASSET_PATHS (nguồn sự thật nằm trong src/index.ts)      */
/* -------------------------------------------------------------------------- */

/**
 * Lấy danh sách path công khai NGAY TỪ SOURCE, không chép lại.
 *
 * Phải bóc comment trước khi nhặt chuỗi, vì khối này có nhiều comment giải
 * thích lỗi production và ta không muốn nhặt nhầm chuỗi trong comment.
 * Trả về null nếu không tìm thấy khối — khi đó KHÔNG được im lặng cho qua.
 */
function parsePublicAssetPaths(source) {
  const block = source.match(
    /const\s+PUBLIC_ASSET_PATHS\s*=\s*new\s+Set<string>\s*\(\s*\[([\s\S]*?)\]\s*\)/,
  );
  if (!block) return null;

  const body = block[1]
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/gm, "$1 ");

  const paths = [];
  for (const m of body.matchAll(/"([^"]*)"/g)) paths.push(m[1]);
  return paths;
}

/* -------------------------------------------------------------------------- */
/* B. Trích tham chiếu cục bộ trong HTML                                      */
/* -------------------------------------------------------------------------- */

/** Đọc giá trị một thuộc tính trong một thẻ HTML (không phân biệt hoa thường). */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
}

/**
 * Trích mọi tham chiếu cục bộ của một trang.
 * Chỉ nhận tham chiếu BẮT ĐẦU BẰNG "/" (bỏ qua "#anchor", "http(s)://", "//cdn").
 */
function extractLocalRefs(html) {
  const refs = [];

  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(m[0], "src");
    if (src) refs.push({ kind: "script src", raw: src });
  }

  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = attr(tag, "rel") || "";
    if (!/\bstylesheet\b/i.test(rel)) continue;
    const href = attr(tag, "href");
    if (href) refs.push({ kind: 'link rel="stylesheet"', raw: href });
  }

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(m[0], "src");
    if (src) refs.push({ kind: "img src", raw: src });
  }

  for (const m of html.matchAll(/<use\b[^>]*>/gi)) {
    // `\bhref` cũng khớp phần `href` trong `xlink:href`, nên một regex là đủ.
    const href = attr(m[0], "href");
    if (href) refs.push({ kind: "use href", raw: href });
  }

  return refs
    .filter((r) => r.raw.startsWith("/") && !r.raw.startsWith("//"))
    .map((r) => ({ ...r, path: pathOnly(r.raw) }));
}

/** Bỏ fragment và query: "/img/sprite.svg#icon-eye" -> "/img/sprite.svg". */
function pathOnly(raw) {
  return raw.split("#")[0].split("?")[0];
}

/** Đường dẫn URL -> tệp thật dưới public/. Trả về null nếu không phải tệp. */
function resolvePublicFile(urlPath) {
  let rel = urlPath;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    /* giữ nguyên nếu chuỗi % không hợp lệ */
  }
  const abs = join(PUBLIC_DIR, rel);
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* E. Kiểm tra qua HTTP (tuỳ chọn)                                            */
/* -------------------------------------------------------------------------- */

function parseBase(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") return argv[i + 1] || "";
    if (argv[i].startsWith("--base=")) return argv[i].slice("--base=".length);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Chạy                                                                       */
/* -------------------------------------------------------------------------- */

const baseArg = parseBase(process.argv.slice(2));
const BASE = baseArg ? baseArg.replace(/\/+$/, "") : null;

console.log("=".repeat(72));
console.log("KIỂM TRA DANH SÁCH TRẮNG ASSET — test/asset-whitelist.mjs");
console.log(BASE ? `Chế độ: tĩnh + HTTP (base = ${BASE})` : "Chế độ: chỉ kiểm tra tĩnh");
console.log("=".repeat(72));

/* ------------------------------- Phần A ---------------------------------- */

section("A. Phân tích PUBLIC_ASSET_PATHS từ src/index.ts");

const source = readFileSync(INDEX_TS, "utf8");
const publicPaths = parsePublicAssetPaths(source);

ok("tìm thấy khối `const PUBLIC_ASSET_PATHS = new Set<string>([...])` trong src/index.ts",
  publicPaths !== null, "regex không khớp — đã đổi cấu trúc? Sửa regex trong test này.");

const PUBLIC_SET = new Set(publicPaths || []);

ok("danh sách công khai có ít nhất 5 mục", PUBLIC_SET.size >= 5, `chỉ có ${PUBLIC_SET.size}`);
ok('danh sách công khai chứa "/login.html" (chốt an toàn của regex)',
  PUBLIC_SET.has("/login.html"), "regex có thể đã nhặt thiếu chuỗi");

console.log(`  \u2139 ${PUBLIC_SET.size} path công khai: ${[...PUBLIC_SET].join(", ")}`);

/* --------------- Ghi nhận: path công khai không có tệp thật --------------- */
{
  const noFile = [...PUBLIC_SET].filter((p) => !resolvePublicFile(p) && !LOGIN_FLOW_PAGES.has(p));
  if (noFile.length > 0) {
    console.log("  \u2139 GHI NHẬN (không tính là lỗi): path công khai nhưng không có tệp trong public/");
    for (const p of noFile) console.log(`      ${p}`);
  }
}

/* ------------------------------- Phần B ---------------------------------- */

section("B. Tham chiếu cục bộ trong 6 trang HTML");

const pageRefs = new Map();
for (const file of PAGE_FILES) {
  const abs = join(PUBLIC_DIR, file);
  let html = null;
  try {
    html = readFileSync(abs, "utf8");
  } catch {
    ok(`đọc được public/${file}`, false, "tệp không tồn tại hoặc không đọc được");
    continue;
  }
  const refs = extractLocalRefs(html);
  pageRefs.set(file, refs);
  const unique = new Set(refs.map((r) => r.path));
  console.log(`  \u2139 public/${file}: ${refs.length} tham chiếu, ${unique.size} đường dẫn riêng`);
}

ok("phân tích được cả 6 trang HTML", pageRefs.size === PAGE_FILES.length,
  `chỉ đọc được ${pageRefs.size}/${PAGE_FILES.length}`);

/* ------------------------------- Phần C ---------------------------------- */

section("C. login.html (trang CÔNG KHAI) — mọi tham chiếu phải nằm trong danh sách trắng");

{
  const refs = pageRefs.get(PUBLIC_PAGE) || [];
  const unique = [...new Map(refs.map((r) => [r.path, r])).values()];

  ok("login.html có ít nhất 1 tham chiếu cục bộ", unique.length > 0,
    "trang đăng nhập không tham chiếu asset nào? Có thể HTML đã đổi.");

  const missing = [];
  for (const ref of unique) {
    if (PUBLIC_SET.has(ref.path) || LOGIN_FLOW_PAGES.has(ref.path)) {
      ok(`login.html -> ${ref.path} (${ref.kind}) nằm trong danh sách công khai`, true);
    } else {
      missing.push(ref);
      ok(`login.html -> ${ref.path} (${ref.kind}) nằm trong danh sách công khai`, false,
        `THIẾU trong PUBLIC_ASSET_PATHS — người chưa đăng nhập sẽ bị 302 đá về /login.html`);
    }
  }

  if (missing.length > 0) {
    failures.push(
      "ĐƯỜNG DẪN CÒN THIẾU TRONG PUBLIC_ASSET_PATHS: " + missing.map((r) => r.path).join(", "),
    );
    console.log("\n  >>> Cách sửa: thêm (các) path sau vào PUBLIC_ASSET_PATHS trong src/index.ts:");
    for (const r of missing) console.log(`        "${r.path}",   // ${r.kind} của login.html`);
  }

  // Kiểm tra phụ: asset của trang công khai cũng phải tồn tại thật, nếu không
  // thì "công khai" cũng vô nghĩa (server sẽ trả 404 cho khách).
  const ghost = unique.filter((r) => !resolvePublicFile(r.path) && !LOGIN_FLOW_PAGES.has(r.path));
  ok("mọi tham chiếu của login.html tồn tại thật dưới public/", ghost.length === 0,
    ghost.map((r) => r.path).join(", "));
}

/* ------------------------------- Phần D ---------------------------------- */

section("D. Năm trang CẦN ĐĂNG NHẬP — mọi tham chiếu phải tồn tại thật dưới public/");

for (const file of AUTH_PAGES) {
  const refs = pageRefs.get(file);
  if (!refs) continue;
  const unique = [...new Map(refs.map((r) => [r.path, r])).values()];
  const dead = unique.filter((r) => !resolvePublicFile(r.path));

  ok(`public/${file}: ${unique.length} tham chiếu đều tồn tại thật`, dead.length === 0,
    dead.length > 0
      ? "tham chiếu chết: " + dead.map((r) => `${r.path} (${r.kind})`).join(", ")
      : "");
}

/* ------------------------------- Phần E ---------------------------------- */

if (BASE) {
  section(`E. Qua HTTP tại ${BASE} — asset của login.html phải trả 200 (redirect TẮT)`);

  let html = "";
  try {
    const pageRes = await fetch(`${BASE}/login.html`, { redirect: "manual" });
    ok("/login.html trả 200 khi chưa đăng nhập", pageRes.status === 200,
      `nhận ${pageRes.status}${pageRes.headers.get("location") ? ` -> ${pageRes.headers.get("location")}` : ""}`);
    html = await pageRes.text();
  } catch (err) {
    ok(`kết nối được tới ${BASE}`, false, err.message);
  }

  const refs = html ? extractLocalRefs(html) : [];
  const unique = [...new Map(refs.map((r) => [r.path, r])).values()];
  ok("HTML tải về từ server có tham chiếu cục bộ", unique.length > 0,
    "không trích được tham chiếu nào — server có trả đúng trang login không?");

  for (const ref of unique) {
    if (LOGIN_FLOW_PAGES.has(ref.path)) continue;
    try {
      const r = await fetch(`${BASE}${ref.path}`, { redirect: "manual" });
      const loc = r.headers.get("location");
      ok(`${ref.path} -> HTTP 200`, r.status === 200,
        `nhận ${r.status}${loc ? ` -> ${loc} (bị chặn, chưa nằm trong PUBLIC_ASSET_PATHS?)` : ""}`);
    } catch (err) {
      ok(`${ref.path} -> HTTP 200`, false, err.message);
    }
  }
} else {
  section("E. Kiểm tra qua HTTP — BỎ QUA (không có --base)");
  console.log("  \u2139 Thêm --base <url> để kiểm tra thật trên Worker đang chạy, ví dụ:");
  console.log("      node test/asset-whitelist.mjs --base http://127.0.0.1:8799");
}

/* ------------------------------- Kết quả --------------------------------- */

section("KẾT QUẢ");
console.log(`\n  ${pass} đạt, ${fail} không đạt`);
if (fail > 0) {
  console.log("\n  Không đạt:");
  for (const f of failures) console.log(`   - ${f}`);
}
console.log("");
process.exit(fail === 0 ? 0 : 1);
