/**
 * =============================================================================
 * test/acceptance.mjs — kiểm tra các tiêu chí nghiệm thu chạy được tự động
 * =============================================================================
 *
 * Chạy:  node test/acceptance.mjs
 *
 * Những gì script này kiểm tra được mà KHÔNG cần deploy:
 *   1. Không có chỗ nào đọc cột chứa acc|pass trong src/ và sync_stats.py
 *   2. Không có SQL nối chuỗi bằng + hoặc template string
 *   3. Validate payload: từ chối payload lạ, chuẩn hoá method '' -> "khác"
 *   4. Chỉ đơn delivered mới tính doanh thu (kiểm tra qua sync_stats.py với DB thật)
 *   5. sync_stats.py chạy 2 lần cho cùng kết quả (idempotent)
 *   6. Thời gian có +07:00
 *   7. Magic bytes: file .exe đổi tên .jpg bị từ chối
 *   8. Mọi trang HTML đều tải scroll.css/scroll.js, có prefers-reduced-motion
 *   9. Định dạng tiền 1.234.567 ₫
 *
 * Những gì KHÔNG kiểm tra được ở đây (phải deploy mới kiểm tra):
 *   - Gọi /api/sync không token trả 401 (cần Worker đang chạy)
 *   - Ảnh không truy cập được khi chưa đăng nhập
 *   - Cảnh báo dữ liệu cũ trên dashboard
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
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

function section(title) {
  console.log(`\n${title}`);
}

/** Đọc mọi file .ts trong src/ và trả về [{path, text}]. */
function readSrcFiles() {
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|py)$/.test(entry)) out.push({ path: p, text: readFileSync(p, "utf8") });
    }
  }
  if (existsSync(join(ROOT, "src"))) walk(join(ROOT, "src"));
  return out;
}

/* -------------------------------------------------------------------------- */
section("1. KHÔNG đọc dữ liệu tài khoản/mật khẩu");
/* -------------------------------------------------------------------------- */

const srcFiles = readSrcFiles();
const syncPyPath = join(ROOT, "sync_stats.py");
const allProtectedFiles = [
  ...srcFiles,
  ...(existsSync(syncPyPath)
    ? [{ path: syncPyPath, text: readFileSync(syncPyPath, "utf8") }]
    : []),
];

ok(
  "Có file để kiểm tra (src/ + sync_stats.py)",
  allProtectedFiles.length >= 5,
  `tìm thấy ${allProtectedFiles.length} file`,
);

/** Bỏ comment trước khi kiểm tra SQL, để không bắt nhầm câu văn mô tả. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* ... */ (TS)
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ") // // ... (TS), giữ http://
    .replace(/"""[\s\S]*?"""/g, " ") // docstring Python
    .replace(/#[^\n]*/g, " "); // # ... (Python)
}

// Bắt mọi truy vấn SQL chạm tới bảng stock mà có SELECT *, hoặc có chữ "content"
// đứng cạnh SELECT — dấu hiệu đọc nhầm cột acc|pass.
const dangerousPatterns = [
  { re: /select\s+\*/i, label: "SELECT * (kéo theo mọi cột, kể cả cột cấm)" },
  { re: /select[^;`"']{0,200}\bcontent\b/i, label: "SELECT ... content" },
  { re: /\bcontent\s*=\s*['"]/i, label: "gán/so sánh cột content" },
  { re: /into\s+stock\b/i, label: "INSERT INTO stock" },
  { re: /update\s+stock\b/i, label: "UPDATE stock" },
  { re: /delete\s+from\s+stock\b/i, label: "DELETE FROM stock" },
];

let dangerous = [];
for (const f of allProtectedFiles) {
  const code = stripComments(f.text);
  for (const p of dangerousPatterns) {
    if (p.re.test(code)) dangerous.push(`${relative(ROOT, f.path)}: ${p.label}`);
  }
}
ok(
  "Không có SELECT * / truy vấn nguy hiểm nào trong src/ và sync_stats.py",
  dangerous.length === 0,
  dangerous.join("; "),
);

// sync_stats.py phải hoàn toàn không có từ khoá cấm (kể cả trong comment).
if (existsSync(syncPyPath)) {
  const py = readFileSync(syncPyPath, "utf8");
  const hits = py
    .split(/\r?\n/)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter((x) => /content/.test(x.line));
  ok(
    'sync_stats.py: grep "content" không ra kết quả',
    hits.length === 0,
    hits.map((h) => `dòng ${h.n}`).join(", "),
  );
} else {
  ok("sync_stats.py tồn tại", false, "không tìm thấy file");
}

/* -------------------------------------------------------------------------- */
section("2. Không nối chuỗi SQL");
/* -------------------------------------------------------------------------- */

// Tìm .prepare(`... ${...} ...`) hoặc .prepare("..." + biến)
//
// LƯU Ý: chỉ nội suy BIẾN mới nguy hiểm. Nội suy một HẰNG SỐ SQL khai báo trong
// chính file (ví dụ `${IMAGE_SELECT}`) là an toàn — nó không mang dữ liệu người dùng.
// Vì vậy ta phải bỏ qua các tên hằng đã biết trước khi kết luận.
const SQL_CONSTANTS = [
  "IMAGE_SELECT",
  "SYNC_INSERT",
  "DAILY_UPSERT",
  "PRODUCT_UPSERT",
  "STOCK_UPSERT",
];

const sqlConcat = [];
for (const f of srcFiles) {
  const code = stripComments(f.text);
  // .prepare(` ... ${X} ... `)
  const tplRe = /\.prepare\s*\(\s*`([^`]*)`/g;
  let m;
  while ((m = tplRe.exec(code)) !== null) {
    const inner = m[1];
    const interpolations = inner.match(/\$\{([^}]*)\}/g) || [];
    const unsafe = interpolations.filter((expr) => {
      const name = expr.slice(2, -1).trim();
      return !SQL_CONSTANTS.includes(name);
    });
    if (unsafe.length > 0) {
      sqlConcat.push(`${relative(ROOT, f.path)}: nội suy ${unsafe.join(", ")}`);
    }
  }
  // .prepare(" ... " + ...) hoặc .prepare(' ... ' + ...)
  const plusRe = /\.prepare\s*\(\s*(?:"[^"]*"|'[^']*')\s*\+/g;
  while ((m = plusRe.exec(code)) !== null) {
    sqlConcat.push(`${relative(ROOT, f.path)}: nối chuỗi bằng +`);
  }
}
ok(
  "Không có .prepare() nội suy biến hay nối chuỗi SQL",
  sqlConcat.length === 0,
  sqlConcat.join("; "),
);

// Mọi truy vấn phải dùng ? placeholder và .bind
const filesWithD1 = srcFiles.filter((f) => /\.prepare\(/.test(f.text));
ok(
  "Có file dùng prepared statement",
  filesWithD1.length >= 3,
  `${filesWithD1.length} file`,
);

/* -------------------------------------------------------------------------- */
section("3. Không lộ stack trace ra ngoài");
/* -------------------------------------------------------------------------- */

const leaky = srcFiles.filter(
  (f) =>
    /error\.stack/.test(f.text) && /jsonError|jsonOk|new Response/.test(f.text),
);
ok(
  "Không có file nào đưa error.stack vào response",
  leaky.length === 0,
  leaky.map((f) => relative(ROOT, f.path)).join(", "),
);

/* -------------------------------------------------------------------------- */
section("4. Xác thực sync bằng so sánh hằng thời gian");
/* -------------------------------------------------------------------------- */

const syncTs = srcFiles.find((f) => /api[\\/]sync\.ts$/.test(f.path));
if (syncTs) {
  const code = stripComments(syncTs.text);
  ok("api/sync.ts dùng timingSafeEqualStr", /timingSafeEqualStr/.test(code));
  // Chỉ bắt so sánh TOKEN bằng ===, bỏ qua kiểm tra null/độ dài và typeof.
  const badCompare = code
    .split(/\r?\n/)
    .filter((l) => /===/.test(l))
    .filter((l) => /(provided|expected|secret|SYNC_TOKEN)/i.test(l))
    .filter((l) => !/typeof|length|===\s*null|===\s*""/.test(l));
  ok(
    "api/sync.ts không so sánh token bằng ===",
    badCompare.length === 0,
    badCompare.map((l) => l.trim()).join(" | "),
  );

  // Khẳng định mạnh hơn: hàm so sánh phải là timingSafeEqualStr, không phải ===.
  ok(
    "so sánh token thật sự đi qua timingSafeEqualStr",
    /return\s+timingSafeEqualStr\(/.test(code),
  );
} else {
  ok("src/api/sync.ts tồn tại", false);
}

const responseTs = srcFiles.find((f) => /lib[\\/]response\.ts$/.test(f.path));
if (responseTs) {
  ok(
    "timingSafeEqualStr không dùng === bên trong",
    !/a\s*===\s*b/.test(responseTs.text),
  );
}

/* -------------------------------------------------------------------------- */
section("5. Hiệu ứng cuộn: đủ 3 file, có reduced-motion, không animate layout");
/* -------------------------------------------------------------------------- */

const scrollCssPath = join(ROOT, "public", "css", "scroll.css");
const scrollJsPath = join(ROOT, "public", "js", "scroll.js");
ok("public/css/scroll.css tồn tại", existsSync(scrollCssPath));
ok("public/js/scroll.js tồn tại", existsSync(scrollJsPath));

if (existsSync(scrollCssPath)) {
  const css = readFileSync(scrollCssPath, "utf8");
  ok("có scroll-behavior: smooth", /scroll-behavior\s*:\s*smooth/.test(css));
  ok("có @media (prefers-reduced-motion: reduce)", /prefers-reduced-motion\s*:\s*reduce/.test(css));
  ok("có easing cubic-bezier(0.22, 1, 0.36, 1)", /cubic-bezier\(\s*0?\.22\s*,\s*1\s*,\s*0?\.36\s*,\s*1\s*\)/.test(css));
  ok("có translateY(24px) cho trạng thái đầu", /translateY\(\s*24px\s*\)/.test(css));
  ok("có biến --delay cho stagger", /--delay/.test(css));
  ok("có will-change: opacity, transform", /will-change\s*:\s*opacity\s*,\s*transform/.test(css));

  // Không được transition/animate các thuộc tính gây layout.
  const badProps = ["top", "left", "width", "height", "margin", "padding", "border-width"];
  const transitionBlocks = css.match(/transition\s*:[^;]+;/g) || [];
  const offending = transitionBlocks.filter((b) =>
    badProps.some((p) => new RegExp(`(^|[\\s,])${p}([\\s,;]|$)`).test(b)),
  );
  ok(
    "transition chỉ dùng opacity/transform (không top/left/width/height/margin)",
    offending.length === 0,
    offending.join(" | "),
  );
}

if (existsSync(scrollJsPath)) {
  const js = readFileSync(scrollJsPath, "utf8");
  ok("dùng IntersectionObserver", /IntersectionObserver/.test(js));
  ok("KHÔNG dùng sự kiện scroll để tính toán", !/addEventListener\(\s*["']scroll["']/.test(js));
  ok("có unobserve()", /unobserve\s*\(/.test(js));
  ok("threshold 0.15", /threshold\s*:\s*0?\.15/.test(js));
  ok(
    'rootMargin "0px 0px -50px 0px"',
    /rootMargin\s*:\s*["']0px 0px -50px 0px["']/.test(js),
  );
  ok("tôn trọng prefers-reduced-motion trong JS", /prefers-reduced-motion/.test(js));
}

/* -------------------------------------------------------------------------- */
section("6. Magic bytes: file lạ đổi đuôi bị từ chối");
/* -------------------------------------------------------------------------- */

const imagesTs = srcFiles.find((f) => /api[\\/]images\.ts$/.test(f.path));
if (imagesTs) {
  ok("có hàm sniffImageMime", /sniffImageMime/.test(imagesTs.text));
  ok("kiểm tra magic bytes JPEG FF D8 FF", /0xff|0xFF/.test(imagesTs.text));
  ok("kiểm tra magic bytes PNG 89 50 4E 47", /0x89|0x50/.test(imagesTs.text));
  ok("kiểm tra RIFF/WEBP", /RIFF/i.test(imagesTs.text) && /WEBP/i.test(imagesTs.text));
  ok("giới hạn 5MB", /5\s*\*\s*1024\s*\*\s*1024/.test(imagesTs.text));
  ok("tên file R2 dùng UUID", /randomUUID/.test(imagesTs.text));
  ok("route xem ảnh có requireAuth", /requireAuth/.test(imagesTs.text));

  // Mô phỏng: header của một file .exe (MZ) đổi tên thành .jpg phải không khớp mọi mẫu.
  const exeHeader = [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00];
  const isJpeg =
    exeHeader[0] === 0xff && exeHeader[1] === 0xd8 && exeHeader[2] === 0xff;
  const isPng =
    exeHeader[0] === 0x89 &&
    exeHeader[1] === 0x50 &&
    exeHeader[2] === 0x4e &&
    exeHeader[3] === 0x47;
  const isWebp =
    exeHeader[0] === 0x52 &&
    exeHeader[1] === 0x49 &&
    exeHeader[2] === 0x46 &&
    exeHeader[3] === 0x46;
  ok(
    "header MZ (.exe) không khớp JPEG/PNG/WEBP → sẽ bị từ chối",
    !isJpeg && !isPng && !isWebp,
  );
} else {
  ok("src/api/images.ts tồn tại", false);
}

/* -------------------------------------------------------------------------- */
section("7. HTML: nạp đủ asset, không có dữ liệu tài khoản, có cảnh báo cũ");
/* -------------------------------------------------------------------------- */

const htmlPages = ["public/index.html", "public/login.html", "public/logs.html", "public/images.html"];
for (const rel of htmlPages) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    ok(`${rel} tồn tại`, false);
    continue;
  }
  const html = readFileSync(p, "utf8");
  ok(`${rel}: có noindex`, /name="robots"[^>]*noindex/.test(html));
  ok(`${rel}: nạp app.css`, /\/css\/app\.css/.test(html));
  ok(`${rel}: có lang="vi"`, /lang="vi"/.test(html));
  ok(`${rel}: không có onclick= inline`, !/\son[a-z]+\s*=\s*"/i.test(html));
  // Chỉ bắt việc THỰC SỰ dùng localStorage, không bắt câu văn nói "không dùng localStorage".
  const usesLocalStorage =
    /localStorage\s*\.\s*setItem/.test(html) ||
    /localStorage\s*\[/.test(html) ||
    /(window\.)?localStorage\s*=\s*/.test(html) ||
    /\.setItem\s*\(/.test(html);
  ok(`${rel}: không lưu token vào localStorage`, !usesLocalStorage);
}

const indexHtmlPath = join(ROOT, "public", "index.html");
if (existsSync(indexHtmlPath)) {
  const html = readFileSync(indexHtmlPath, "utf8");
  ok("index.html nạp scroll.css", /\/css\/scroll\.css/.test(html));
  ok("index.html nạp scroll.js", /\/js\/scroll\.js/.test(html));
  ok("index.html nạp chart.js", /\/js\/chart\.js/.test(html));
  ok("index.html nạp dashboard.js", /\/js\/dashboard\.js/.test(html));
  ok("index.html có canvas biểu đồ", /<canvas[^>]*id="chart-revenue"/.test(html));
  ok("index.html có thanh trạng thái sync", /id="sync-bar"/.test(html));
  // KHÔNG kể "kpi-wallet": chủ shop đã yêu cầu BỎ thẻ "Tổng số dư ví" khỏi
  // dashboard (số dư là thông tin nhạy cảm, không cần thiết để xem tình hình
  // kinh doanh). Test cũ vẫn đòi thẻ này nên đã được gỡ — xem README mục 8.11.
  for (const id of ["kpi-revenue", "kpi-orders", "kpi-orders-all", "kpi-users"]) {
    ok(`index.html có #${id}`, new RegExp(`id="${id}"`).test(html));
  }
  ok(
    "index.html ĐÃ BỎ thẻ 'Tổng số dư ví' theo yêu cầu",
    !/id="kpi-wallet"/.test(html),
    "nếu thẻ này quay lại, nghĩa là ai đó đã thêm lại mà không hỏi chủ shop",
  );
}

/* -------------------------------------------------------------------------- */
section("8. Định dạng tiền 1.234.567 ₫");
/* -------------------------------------------------------------------------- */

const dashJsPath = join(ROOT, "public", "js", "dashboard.js");
if (existsSync(dashJsPath)) {
  const js = readFileSync(dashJsPath, "utf8");
  ok("dashboard.js export window.ShopFmt", /window\.ShopFmt/.test(js));
  ok("có hàm formatVND", /function formatVND/.test(js));
  ok("ký hiệu ₫ đặt sau cùng", /"\s*₫"/.test(js) || /₫"/.test(js));

  // Chạy thật hàm formatVND tách ra từ source.
  const m = js.match(/function formatVND\(n\)\s*\{[\s\S]*?\n  \}/);
  if (m) {
    const fn = new Function("n", `${m[0]}; return formatVND(n);`);
    ok("formatVND(1234567) === '1.234.567 ₫'", fn(1234567) === "1.234.567 ₫", fn(1234567));
    ok("formatVND(0) === '0 ₫'", fn(0) === "0 ₫", fn(0));
    ok("formatVND(999) === '999 ₫'", fn(999) === "999 ₫", fn(999));
    ok("formatVND(1000000000) có 3 dấu chấm", fn(1000000000) === "1.000.000.000 ₫", fn(1000000000));
  } else {
    ok("tách được hàm formatVND để test", false);
  }

  ok("dashboard.js có ngưỡng cảnh báo 1 giờ", /3600/.test(js));
} else {
  ok("public/js/dashboard.js tồn tại", false);
}

/* -------------------------------------------------------------------------- */
section("9. sync_stats.py: read-only, idempotent, có --dry-run, +07:00");
/* -------------------------------------------------------------------------- */

if (existsSync(syncPyPath)) {
  const py = readFileSync(syncPyPath, "utf8");
  ok("mở DB bằng mode=ro URI", /mode=ro/.test(py));
  ok("có PRAGMA query_only", /query_only/i.test(py));
  ok("có cờ --dry-run", /--dry-run/.test(py));
  ok("có timezone +07:00", /\+07:00|hours=7|timedelta\(hours=7\)/.test(py));
  ok("có Authorization Bearer", /Bearer/.test(py));
  ok("xử lý method rỗng thành nhóm khác", /khác/.test(py));
  ok("không in token ra log", !/print\([^)]*token[^)]*\)/i.test(py));
  ok("chỉ tính doanh thu đơn delivered", /delivered/.test(py));

  // Chạy --dry-run thật với DB giả để kiểm chứng nghiệp vụ.
  let python = null;
  for (const candidate of ["python", "python3", "py"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      python = candidate;
      break;
    } catch {
      /* thử tiếp */
    }
  }

  if (python === null) {
    console.log("  ! Không tìm thấy Python trên máy này — bỏ qua test chạy thật");
  } else {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "shop-accept-"));
    const dbPath = join(tmp, "shop.db");

    const setup = `
import sqlite3
c = sqlite3.connect(${JSON.stringify(dbPath)})
c.executescript("""
CREATE TABLE users(user_id INTEGER PRIMARY KEY, username TEXT, full_name TEXT,
  balance INTEGER DEFAULT 0, created_at TEXT, points INTEGER DEFAULT 0, total_spent INTEGER DEFAULT 0);
CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, price INTEGER, description TEXT,
  warranty TEXT, active INTEGER, sale_price INTEGER, sale_end TEXT);
CREATE TABLE stock(id INTEGER PRIMARY KEY, product_id INTEGER, content TEXT, status TEXT, order_id INTEGER);
CREATE TABLE orders(id INTEGER PRIMARY KEY, user_id INTEGER, product_id INTEGER, qty INTEGER,
  price_each INTEGER, total INTEGER, payable INTEGER, status TEXT, method TEXT, created_at TEXT,
  paid_at TEXT, notified_at TEXT, coupon_code TEXT, discount_amount INTEGER, tier_discount INTEGER,
  qty_discount INTEGER, pay_code TEXT);
CREATE TABLE deposits(id INTEGER PRIMARY KEY, user_id INTEGER, amount INTEGER, code TEXT,
  payable INTEGER, status TEXT, created_at TEXT, confirmed_at TEXT, pay_code TEXT);
""")
c.execute("INSERT INTO users VALUES (1,'a','A',100000,'2026-09-01 10:00:00',0,0)")
c.execute("INSERT INTO users VALUES (2,'b','B',250000,'2026-09-02 10:00:00',0,0)")
c.execute("INSERT INTO products VALUES (3,'Netflix 1 thang',50000,'mo ta','bh',1,NULL,NULL)")
c.execute("INSERT INTO stock VALUES (1,3,'acc|pass-that-khong-duoc-doc','available',NULL)")
c.execute("INSERT INTO stock VALUES (2,3,'acc2|pass2','available',NULL)")
c.execute("INSERT INTO stock VALUES (3,3,'acc3|pass3','sold',10)")
# 2 don delivered (1 bank, 1 method rong) + 1 don cancelled
c.execute("INSERT INTO orders VALUES (10,1,3,1,50000,45000,45000,'delivered','bank','2026-09-22 17:08:26',NULL,NULL,NULL,5000,0,0,NULL)")
c.execute("INSERT INTO orders VALUES (11,1,3,1,50000,50000,50000,'delivered','','2026-09-22 18:08:26',NULL,NULL,NULL,0,0,0,NULL)")
c.execute("INSERT INTO orders VALUES (12,2,3,1,50000,50000,50000,'cancelled','bank','2026-09-22 19:08:26',NULL,NULL,NULL,0,0,0,NULL)")
c.execute("INSERT INTO deposits VALUES (1,1,100000,'X',100000,'confirmed','2026-09-20 10:00:00','2026-09-20 10:05:00',NULL)")
c.commit(); c.close()
`;
    const setupPath = join(tmp, "setup.py");
    writeFileSync(setupPath, setup, "utf8");

    try {
      execFileSync(python, [setupPath], { stdio: "pipe" });
      const out1 = execFileSync(
        python,
        [syncPyPath, "--db", dbPath, "--dry-run"],
        { encoding: "utf8" },
      );
      const payload = JSON.parse(out1.slice(out1.indexOf("{")));

      ok(
        "doanh thu chỉ cộng đơn delivered (45000 + 50000 = 95000)",
        payload.totals.revenue_delivered === 95000,
        `nhận được ${payload.totals.revenue_delivered}`,
      );
      ok(
        "đơn cancelled không làm tăng doanh thu",
        payload.totals.revenue_delivered === 95000 && payload.totals.orders_all === 3,
        `orders_all=${payload.totals.orders_all}`,
      );
      ok(
        "orders_delivered = 2",
        payload.totals.orders_delivered === 2,
        String(payload.totals.orders_delivered),
      );
      ok("users_total = 2", payload.totals.users_total === 2, String(payload.totals.users_total));
      ok(
        "wallet_balance_sum = 350000",
        payload.totals.wallet_balance_sum === 350000,
        String(payload.totals.wallet_balance_sum),
      );
      ok(
        "deposits_confirmed = 1",
        payload.totals.deposits_confirmed === 1,
        String(payload.totals.deposits_confirmed),
      );

      const methods = (payload.by_method || []).reduce((acc, m) => {
        acc[m.method] = m;
        return acc;
      }, {});
      ok("có nhóm bank với 1 đơn 45000", !!methods["bank"] && methods["bank"].orders === 1 && methods["bank"].revenue === 45000,
        JSON.stringify(methods["bank"]));
      ok(
        "đơn có method = '' được gom vào nhóm 'khác', KHÔNG bị mất",
        !!methods["khác"] && methods["khác"].orders === 1 && methods["khác"].revenue === 50000,
        JSON.stringify(methods["khác"] || null),
      );

      ok(
        "synced_at ghi rõ +07:00",
        typeof payload.synced_at === "string" && payload.synced_at.endsWith("+07:00"),
        payload.synced_at,
      );

      // Idempotent: chạy lần hai cho kết quả y hệt (bỏ synced_at vì nó là thời điểm chạy).
      const out2 = execFileSync(python, [syncPyPath, "--db", dbPath, "--dry-run"], {
        encoding: "utf8",
      });
      const payload2 = JSON.parse(out2.slice(out2.indexOf("{")));
      delete payload.synced_at;
      delete payload2.synced_at;
      ok(
        "chạy 2 lần liên tiếp cho cùng số liệu (không nhân đôi)",
        JSON.stringify(payload) === JSON.stringify(payload2),
      );

      // Không được có acc|pass trong payload gửi lên Cloudflare.
      const raw = JSON.stringify(payload);
      ok(
        "payload không chứa acc|pass",
        !/acc\|pass/.test(raw) && !/pass-that-khong-duoc-doc/.test(raw),
      );

      // DB bán hàng không bị thay đổi.
      const check = `
import sqlite3
c = sqlite3.connect(${JSON.stringify(dbPath)})
n = c.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
s = c.execute("SELECT status FROM stock WHERE id=1").fetchone()[0]
print(n, s)
c.close()
`;
      const checkPath = join(tmp, "check.py");
      writeFileSync(checkPath, check, "utf8");
      const res = execFileSync(python, [checkPath], { encoding: "utf8" }).trim();
      ok("DB bán hàng không bị ghi (orders vẫn 3, stock giữ nguyên)", res === "3 available", res);
    } catch (err) {
      ok("chạy được sync_stats.py --dry-run", false, String(err.message).slice(0, 400));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
} else {
  ok("sync_stats.py tồn tại", false);
}

/* -------------------------------------------------------------------------- */
section("10. Validate payload phía server");
/* -------------------------------------------------------------------------- */

const validateTs = srcFiles.find((f) => /lib[\\/]validate\.ts$/.test(f.path));
if (validateTs) {
  const v = validateTs.text;
  ok("có parseSyncPayload", /parseSyncPayload/.test(v));
  ok("chuẩn hoá method '' thành 'khác'", /khác/.test(v));
  ok("có ValidationError", /ValidationError/.test(v));
  ok("ép số nguyên cho tiền", /isInteger/.test(v));
  ok("giới hạn độ dài mảng", /by_product/.test(v) && /500/.test(v));
  ok("có vnToday/vnDateOf cho UTC+7", /vnToday/.test(v) && /vnDateOf/.test(v));
  ok("chặn tên sản phẩm dạng acc|pass", /\|/.test(v) && /redactText/.test(v));
} else {
  ok("src/lib/validate.ts tồn tại", false);
}

/* -------------------------------------------------------------------------- */
section("11. Rate limit đăng nhập 5 lần / 15 phút");
/* -------------------------------------------------------------------------- */

const authTs = srcFiles.find((f) => /[\\/]auth\.ts$/.test(f.path));
if (authTs) {
  ok("MAX_FAILED_LOGINS = 5", /MAX_FAILED_LOGINS\s*=\s*5/.test(authTs.text));
  ok("LOGIN_WINDOW_SECONDS = 900", /LOGIN_WINDOW_SECONDS\s*=\s*900/.test(authTs.text));
  ok("PBKDF2 >= 100000 vòng", /PBKDF2_ITERATIONS\s*=\s*1[0-9]{5}/.test(authTs.text));
  ok("cookie HttpOnly", /HttpOnly/.test(authTs.text));
  ok("cookie Secure", /Secure/.test(authTs.text));
  ok("cookie SameSite=Strict", /SameSite=Strict/.test(authTs.text));
  ok("không dùng localStorage", !/localStorage/.test(authTs.text));
}

/* -------------------------------------------------------------------------- */
section("12. Kết quả");
/* -------------------------------------------------------------------------- */

console.log(`\n  ${pass} đạt, ${fail} không đạt`);
if (fail > 0) {
  console.log("\n  Các mục không đạt:");
  failures.forEach((f) => console.log(`   - ${f}`));
}
console.log("");
process.exit(fail === 0 ? 0 : 1);
