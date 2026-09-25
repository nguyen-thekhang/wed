/**
 * test/login-flow.mjs — kiểm tra LUỒNG ĐĂNG NHẬP thật như trình duyệt.
 *
 * Chạy: node test/login-flow.mjs
 *
 * Bài học: bản trước của trang login nhúng JS thẳng vào HTML, mà Worker lại gắn
 * CSP `script-src 'self'` => trình duyệt CHẶN script => bấm nút không có gì xảy
 * ra, không thông báo lỗi. Bộ test cũ không phát hiện vì chỉ kiểm tra HTTP status.
 *
 * Script này kiểm tra đúng thứ đã hỏng:
 *   1. HTML không còn <script> inline nào (thứ bị CSP chặn)
 *   2. Mọi <script src> trong HTML đều tải được (không 404)
 *   3. Form có method/action dự phòng để vẫn chạy khi JS bị chặn
 *   4. Server chấp nhận cả JSON và form-urlencoded (đường dự phòng thật sự chạy)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.PROD_URL || "https://shop-dashboard.nguyenkhang170855.workers.dev";

const secrets = {};
for (const line of readFileSync(join(ROOT, ".deploy-secrets"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) secrets[m[1]] = m[2].trim();
}

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

function section(t) {
  console.log(`\n${t}`);
}

/* -------------------------------------------------------------------------- */
section("A. HTML login không còn script bị CSP chặn");
/* -------------------------------------------------------------------------- */

const htmlRes = await fetch(`${BASE}/login.html`, { redirect: "manual" });
const html = await htmlRes.text();
const csp = htmlRes.headers.get("content-security-policy") || "";

const inlineScripts = (html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || []);
ok("không có thẻ <script> inline nào", inlineScripts.length === 0,
  `tìm thấy ${inlineScripts.length} thẻ — CSP sẽ chặn`);
ok("CSP vẫn là script-src 'self' (an toàn, không nới lỏng)",
  /script-src[^;]*'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), csp);

const inlineHandlers = (html.match(/\son[a-z]+\s*=\s*"/gi) || []);
ok("không có onclick/onload inline", inlineHandlers.length === 0,
  inlineHandlers.join(", "));

/* -------------------------------------------------------------------------- */
section("B. Mọi script HTML tham chiếu đều tải được");
/* -------------------------------------------------------------------------- */

const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
ok("có ít nhất 1 script src", srcs.length > 0, `tìm thấy ${srcs.length}`);

for (const src of srcs) {
  const r = await fetch(`${BASE}${src}`, { redirect: "manual" });
  ok(`${src} tải được (HTTP 200)`, r.status === 200, `nhận ${r.status}`);
  if (src === "/js/login.js") {
    const js = await r.text();
    ok("/js/login.js gắn listener vào form đăng nhập",
      js.includes("login-form") && js.includes("addEventListener"), "thiếu logic");
    // Chỉ bắt việc THỰC SỰ dùng localStorage, bỏ qua comment nói "không dùng".
    const codeOnly = js
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    ok("/js/login.js KHÔNG dùng localStorage",
      !/localStorage\s*[.[]/.test(codeOnly), "có dùng thật");
  }
}

/* -------------------------------------------------------------------------- */
section("C. Đường dự phòng khi JS bị chặn");
/* -------------------------------------------------------------------------- */

ok("form có method=post và action=/api/login",
  /<form[^>]*method="post"/i.test(html) && /<form[^>]*action="\/api\/login"/i.test(html),
  "form thiếu action => JS hỏng là hết đường vào");

// Server phải chấp nhận form-urlencoded, nếu không đường dự phòng vô nghĩa.
{
  const body = new URLSearchParams({ password: secrets.ADMIN_PASSWORD });
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
  ok("POST /api/login nhận form-urlencoded -> 200 (dự phòng chạy thật)",
    r.status === 200, `nhận ${r.status}`);
}

/* -------------------------------------------------------------------------- */
section("D. Luồng đăng nhập thật vẫn hoạt động");
/* -------------------------------------------------------------------------- */

{
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: secrets.ADMIN_PASSWORD }),
    redirect: "manual",
  });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  ok("đăng nhập JSON -> 200", r.status === 200, `nhận ${r.status}`);

  const stats = await fetch(`${BASE}/api/stats`, { headers: { Cookie: cookie } });
  ok("vào được /api/stats bằng phiên vừa tạo", stats.status === 200, `nhận ${stats.status}`);

  const dash = await fetch(`${BASE}/`, { headers: { Cookie: cookie }, redirect: "manual" });
  ok("vào được trang chủ bằng phiên đó", dash.status === 200, `nhận ${dash.status}`);
}

{
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "sai-mat-khau-kiem-tra" }),
    redirect: "manual",
  });
  ok("mật khẩu sai -> 401 (form sẽ hiện thông báo đỏ)",
    r.status === 401 || r.status === 429, `nhận ${r.status}`);
}

/* -------------------------------------------------------------------------- */
section("KẾT QUẢ");
/* -------------------------------------------------------------------------- */

console.log(`\n  ${pass} đạt, ${fail} không đạt`);
if (fail > 0) {
  console.log("\n  Không đạt:");
  failures.forEach((f) => console.log(`   - ${f}`));
}
console.log("");
process.exit(fail === 0 ? 0 : 1);
