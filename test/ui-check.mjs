/**
 * test/ui-check.mjs — kiểm tra giao diện mới đã lên production đúng chưa.
 *
 * Xác nhận: CSS/JS mới đã deploy, các class giao diện mới hiện diện,
 * và trang login có đủ phần hero như thiết kế.
 */

const BASE = "https://shop-dashboard.nguyenkhang170855.workers.dev";

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; failures.push(name); console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`); }
}

function section(t) { console.log(`\n${t}`); }

/* -------------------------------------------------------------------------- */
section("CSS mới đã lên production");
/* -------------------------------------------------------------------------- */

const cssRes = await fetch(`${BASE}/css/app.css`);
const css = await cssRes.text();
ok("app.css tải được", cssRes.status === 200, `HTTP ${cssRes.status}`);
ok("có biến --accent-2 (màu nhấn gradient)", css.includes("--accent-2"));
ok("có class .hero-title (landing page)", css.includes(".hero-title"));
ok("có class .hero-accent (chữ gradient)", css.includes(".hero-accent"));
ok("có class .page-head (tiêu đề dashboard)", css.includes(".page-head"));
ok("có class .login-layout (2 cột)", css.includes(".login-layout"));
ok("KHÔNG nạp font từ CDN ngoài (CSP chặn)", !/@import|fonts\.googleapis/.test(css));
ok("có @media cho điện thoại", /@media\s*\(max-width/.test(css));

/* -------------------------------------------------------------------------- */
section("Trang đăng nhập có phần hero");
/* -------------------------------------------------------------------------- */

const loginHtml = await fetch(`${BASE}/login.html`, { redirect: "follow" }).then((r) => r.text());
ok("có khối .hero", /class="hero\b/.test(loginHtml));
ok("có tiêu đề lớn .hero-title", /class="hero-title"/.test(loginHtml));
ok("có dòng nhấn gradient .hero-accent", /class="hero-accent"/.test(loginHtml));
ok("có danh sách điểm nhấn .hero-points", /class="hero-points"/.test(loginHtml));
ok("có .login-layout bọc 2 cột", /class="login-layout"/.test(loginHtml));
ok("vẫn có form đăng nhập", /id="login-form"/.test(loginHtml));
ok("vẫn giữ đường dự phòng method/action",
  /method="post"/.test(loginHtml) && /action="\/api\/login"/.test(loginHtml));
ok("KHÔNG có script inline (CSP sẽ chặn)",
  (loginHtml.match(/<script(?![^>]*src=)[^>]*>/gi) || []).length === 0);
ok("KHÔNG hứa hẹn dữ liệu tài khoản trong phần giới thiệu",
  !/mật khẩu khách|tài khoản khách|acc\|pass/i.test(loginHtml));

/* -------------------------------------------------------------------------- */
section("Dashboard có tiêu đề trang");
/* -------------------------------------------------------------------------- */

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: (await import("node:fs")).readFileSync(
    new URL("../.deploy-secrets", import.meta.url), "utf8"
  ).match(/ADMIN_PASSWORD=(.*)/)[1].trim() }),
  redirect: "manual",
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const dashHtml = await fetch(`${BASE}/`, { headers: { Cookie: cookie } }).then((r) => r.text());
ok("có .page-head", /class="page-head/.test(dashHtml));
ok("có .page-title", /class="page-title"/.test(dashHtml));
ok("vẫn có đủ thẻ KPI", ["kpi-revenue","kpi-orders","kpi-users","kpi-wallet"]
  .every((id) => dashHtml.includes(`id="${id}"`)));
ok("vẫn có canvas biểu đồ", dashHtml.includes('id="chart-revenue"'));
ok("vẫn có thanh cảnh báo sync", dashHtml.includes('id="sync-bar"'));

/* -------------------------------------------------------------------------- */
section("Các trang khác vẫn tải được");
/* -------------------------------------------------------------------------- */

for (const p of ["/logs.html", "/images.html", "/js/login.js", "/js/dashboard.js", "/js/chart.js", "/css/scroll.css"]) {
  const r = await fetch(`${BASE}${p}`, { headers: { Cookie: cookie }, redirect: "manual" });
  ok(`${p} -> 200`, r.status === 200, `HTTP ${r.status}`);
}

/* -------------------------------------------------------------------------- */
section("KẾT QUẢ");
/* -------------------------------------------------------------------------- */

console.log(`\n  ${pass} đạt, ${fail} không đạt`);
if (fail > 0) { console.log("\n  Không đạt:"); failures.forEach((f) => console.log(`   - ${f}`)); }
console.log("");
process.exit(fail === 0 ? 0 : 1);
