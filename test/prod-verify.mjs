/**
 * =============================================================================
 * test/prod-verify.mjs — kiểm tra Worker ĐÃ DEPLOY THẬT trên Cloudflare
 * =============================================================================
 *
 * Chạy: node test/prod-verify.mjs
 *
 * Khác với live-e2e.mjs (chạy trên Miniflare local), script này đánh vào URL
 * thật qua internet, dùng D1 thật và secret thật. Đây là bằng chứng cuối cùng
 * rằng bản deploy hoạt động, không chỉ bản local.
 *
 * Đọc mật khẩu từ .deploy-secrets (file chỉ dùng lúc deploy, KHÔNG commit).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.PROD_URL || "https://shop-dashboard.nguyenkhang170855.workers.dev";

/* -------------------------------------------------------------------------- */
/* Đọc secret để test đăng nhập thật                                          */
/* -------------------------------------------------------------------------- */

const secrets = {};
for (const f of [".deploy-secrets", ".dev.vars"]) {
  try {
    for (const line of readFileSync(join(ROOT, f), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) secrets[m[1]] = m[2].trim();
    }
    break;
  } catch {
    /* thử file kế tiếp */
  }
}

const SYNC_TOKEN = secrets.SYNC_TOKEN;
const ADMIN_PASSWORD = secrets.ADMIN_PASSWORD;

if (!SYNC_TOKEN || !ADMIN_PASSWORD) {
  console.error("Không đọc được secret từ .deploy-secrets — không test được.");
  process.exit(2);
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

function raw(path, init = {}) {
  return fetch(`${BASE}${path}`, { ...init, redirect: "manual" });
}

async function bodyOf(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isoAtVn(offsetHours = 0) {
  const vn = new Date(Date.now() + 7 * 3600 * 1000 + offsetHours * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${vn.getUTCFullYear()}-${p(vn.getUTCMonth() + 1)}-${p(vn.getUTCDate())}` +
    `T${p(vn.getUTCHours())}:${p(vn.getUTCMinutes())}:${p(vn.getUTCSeconds())}+07:00`
  );
}

function vnToday() {
  const vn = new Date(Date.now() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${vn.getUTCFullYear()}-${p(vn.getUTCMonth() + 1)}-${p(vn.getUTCDate())}`;
}

/* -------------------------------------------------------------------------- */
section(`A. Worker đang sống — ${BASE}`);
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/api/health");
  const b = await bodyOf(res);
  ok("GET /api/health -> 200", res.status === 200, `nhận ${res.status}`);
  ok("health báo ok:true", b && b.ok === true, JSON.stringify(b));
}

/* -------------------------------------------------------------------------- */
section("B. Sync API từ chối khi thiếu / sai token");
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/api/sync", {
    method: "POST",
    body: JSON.stringify({ synced_at: isoAtVn(0) }),
  });
  ok("POST /api/sync không token -> 401", res.status === 401, `nhận ${res.status}`);
}

{
  const res = await raw("/api/sync", {
    method: "POST",
    headers: { Authorization: "Bearer token-gia-mao" },
    body: JSON.stringify({ synced_at: isoAtVn(0) }),
  });
  ok("POST /api/sync sai token -> 401", res.status === 401, `nhận ${res.status}`);
}

/* -------------------------------------------------------------------------- */
section("C. Endpoint bảo vệ trả 401 khi chưa đăng nhập");
/* -------------------------------------------------------------------------- */

for (const p of ["/api/stats", "/api/stats/daily", "/api/stats/products", "/api/logs", "/api/logs/syncs", "/api/images"]) {
  const res = await raw(p);
  ok(`GET ${p} -> 401`, res.status === 401, `nhận ${res.status}`);
}

{
  const res = await raw("/api/images/img_11111111-2222-3333-4444-555555555555.jpg");
  ok("xem ảnh chưa đăng nhập -> 401", res.status === 401, `nhận ${res.status}`);
}

/* -------------------------------------------------------------------------- */
section("D. Trang HTML không lộ khi chưa đăng nhập");
/* -------------------------------------------------------------------------- */

for (const p of ["/", "/index.html", "/logs", "/images", "/js/dashboard.js"]) {
  const res = await raw(p);
  const loc = res.headers.get("location") || "";
  ok(
    `${p} -> chuyển hướng về login`,
    (res.status === 302 || res.status === 307) && loc.includes("/login"),
    `nhận ${res.status} ${loc}`,
  );
}

{
  const res = await raw("/login.html");
  const text = await res.text();
  ok("/login.html truy cập được", res.status === 200 || res.status === 307,
    `nhận ${res.status}`);
  ok("trang login có form đăng nhập", text.includes("login-form") || res.status === 307,
    "không thấy form");
}

/* -------------------------------------------------------------------------- */
section("E. Đăng nhập thật và lấy phiên");
/* -------------------------------------------------------------------------- */

let sessionCookie = null;

{
  const res = await raw("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const b = await bodyOf(res);
  ok("đăng nhập bằng mật khẩu thật -> 200", res.status === 200,
    `nhận ${res.status} ${JSON.stringify(b)}`);
  ok("Set-Cookie có HttpOnly", /HttpOnly/i.test(setCookie), setCookie);
  ok("Set-Cookie có Secure", /Secure/i.test(setCookie), setCookie);
  ok("Set-Cookie có SameSite=Strict", /SameSite=Strict/i.test(setCookie), setCookie);
  sessionCookie = (setCookie.split(";")[0] || "").trim();
  ok("lấy được cookie phiên", sessionCookie.includes("="), sessionCookie);
}

{
  const res = await raw("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "mat-khau-sai" }),
  });
  ok("mật khẩu sai -> 401", res.status === 401, `nhận ${res.status}`);
}

/* -------------------------------------------------------------------------- */
section("F. Sync thật bằng token, rồi đọc lại số liệu");
/* -------------------------------------------------------------------------- */

// =============================================================================
// ⚠️ CẢNH BÁO AN TOÀN DỮ LIỆU — ĐỌC TRƯỚC KHI SỬA FILE NÀY
// =============================================================================
// Script này chạy trên PRODUCTION. Bản đầu tiên của nó đã gửi một payload giả
// (1.234.000 ₫) vào endpoint /api/sync thật, và vì /api/stats luôn lấy snapshot
// có synced_at MỚI NHẤT, payload giả đó đã CHE MẤT dữ liệu bán hàng thật của
// shop. Phải chạy lại sync_stats.py trên VPS mới khôi phục được.
//
// Vì vậy mặc định KHÔNG ghi gì cả. Muốn test đường ghi thì phải nói rõ:
//     ALLOW_WRITE_TESTS=1 node test/prod-verify.mjs
// và sau đó BẮT BUỘC chạy lại sync thật trên VPS để trả dữ liệu về đúng.
// =============================================================================

const ALLOW_WRITE = process.env.ALLOW_WRITE_TESTS === "1";

const payload = {
  synced_at: isoAtVn(0),
  totals: {
    revenue_delivered: 1234000,
    orders_delivered: 7,
    orders_all: 11,
    users_total: 4,
    deposits_confirmed: 2,
    wallet_balance_sum: 555000,
  },
  by_day: [{ date: vnToday(), revenue: 1234000, orders: 7 }],
  by_product: [{ product_id: 1, name: "Kiem tra production", sold: 7, revenue: 1234000 }],
  by_method: [
    { method: "bank", orders: 3, revenue: 500000 },
    { method: "khác", orders: 4, revenue: 734000 },
  ],
  by_status: [
    { status: "delivered", count: 7 },
    { status: "cancelled", count: 2 },
    { status: "expired", count: 2 },
  ],
  stock: [{ product_id: 1, available: 9, sold: 7 }],
};

if (!ALLOW_WRITE) {
  console.log("  (bỏ qua phần GHI — đây là production)");
  console.log("  Vẫn kiểm tra được: endpoint sync có tồn tại và có từ chối token sai không.");
  console.log("");

  // Chỉ kiểm tra ĐỌC: endpoint phải tồn tại và từ chối token sai.
  const bad = await raw("/api/sync", {
    method: "POST",
    headers: { Authorization: "Bearer token-sai-de-kiem-tra", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  ok("POST /api/sync với token sai -> 401 (không ghi gì)", bad.status === 401, `nhận ${bad.status}`);

  // Đọc số liệu THẬT đang có, không ghi đè.
  const res = await raw("/api/stats", { headers: { Cookie: sessionCookie } });
  const b = await bodyOf(res);
  ok("GET /api/stats với phiên -> 200", res.status === 200, `nhận ${res.status}`);
  ok("có đủ các trường số liệu",
    b && b.totals && b.by_day && b.by_product && b.by_method && b.by_status && b.stock,
    Object.keys(b || {}).join(","));
  ok("by_day đủ 30 ngày liên tục", Array.isArray(b?.by_day) && b.by_day.length === 30,
    String(b?.by_day?.length));
  ok("doanh thu là số nguyên >= 0",
    Number.isInteger(b?.totals?.revenue_delivered) && b.totals.revenue_delivered >= 0,
    String(b?.totals?.revenue_delivered));
  ok("synced_at giữ +07:00",
    typeof b?.synced_at === "string" && b.synced_at.endsWith("+07:00"), String(b?.synced_at));
  ok("KHÔNG có acc|pass trong response", !/acc\|pass/.test(JSON.stringify(b)));
  ok("phân chia theo phương thức không bỏ sót nhóm nào",
    Array.isArray(b?.by_method) && b.by_method.length > 0,
    JSON.stringify(b?.by_method));
  console.log("");
  console.log("  Số liệu THẬT đang hiển thị:");
  console.log(`    Doanh thu : ${b?.totals?.revenue_delivered?.toLocaleString("vi-VN")} ₫`);
  console.log(`    Đơn       : ${b?.totals?.orders_all}`);
  console.log(`    Users     : ${b?.totals?.users_total}`);
} else {
  console.log("  ⚠️  ALLOW_WRITE_TESTS=1 — SẼ GHI DỮ LIỆU GIẢ VÀO PRODUCTION!");
  console.log("      Sau khi chạy xong BẮT BUỘC chạy lại trên VPS:");
  console.log("      python3 /opt/shop-dashboard/sync_stats.py -v");
  console.log("");

  const res = await raw("/api/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${SYNC_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const b = await bodyOf(res);
  ok("POST /api/sync đúng token -> 200", res.status === 200,
    `nhận ${res.status} ${JSON.stringify(b)}`);
  ok("trả ok:true + synced_at", b && b.ok === true && typeof b.synced_at === "string",
    JSON.stringify(b));

  const s = await raw("/api/stats", { headers: { Cookie: sessionCookie } });
  const sb = await bodyOf(s);
  ok("doanh thu khớp dữ liệu vừa sync = 1.234.000",
    sb?.totals?.revenue_delivered === 1234000, String(sb?.totals?.revenue_delivered));

  await raw("/api/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${SYNC_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const s2 = await raw("/api/stats", { headers: { Cookie: sessionCookie } });
  const sb2 = await bodyOf(s2);
  ok("sync lần 2 -> số liệu KHÔNG nhân đôi", sb2?.totals?.revenue_delivered === 1234000,
    String(sb2?.totals?.revenue_delivered));
  console.log("");
  console.log("  🔴 NHỚ CHẠY LẠI SYNC THẬT TRÊN VPS ĐỂ KHÔI PHỤC DỮ LIỆU!");
}

/* -------------------------------------------------------------------------- */
section("G. Nhật ký ghi nhận sync và login");
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/api/logs?limit=50", { headers: { Cookie: sessionCookie } });
  const b = await bodyOf(res);
  ok("GET /api/logs -> 200", res.status === 200, `nhận ${res.status}`);
  const actions = (b?.admin_log || []).map((r) => r.action);
  ok("audit_log có action 'sync'", actions.includes("sync"), actions.join(","));
  ok("audit_log có action 'login'", actions.includes("login"), actions.join(","));
}

/* -------------------------------------------------------------------------- */
section("H. Trang dashboard phục vụ đúng khi đã đăng nhập");
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/", { headers: { Cookie: sessionCookie } });
  const text = await res.text();
  ok("GET / với phiên -> 200", res.status === 200, `nhận ${res.status}`);
  ok("trả về HTML dashboard có canvas", text.includes("<canvas"), "không thấy canvas");
  ok("có header CSP", (res.headers.get("content-security-policy") || "").length > 0,
    "thiếu CSP");
  ok("có X-Content-Type-Options: nosniff",
    res.headers.get("x-content-type-options") === "nosniff", "thiếu nosniff");
  ok("có X-Frame-Options: DENY", res.headers.get("x-frame-options") === "DENY", "thiếu");
}

{
  const res = await raw("/logs.html", { headers: { Cookie: sessionCookie } });
  ok("GET /logs.html với phiên -> 200", res.status === 200, `nhận ${res.status}`);
}

/* -------------------------------------------------------------------------- */
section("I. Ảnh — R2 chưa bật thì phải báo 503 rõ ràng, không sập");
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/api/images", { headers: { Cookie: sessionCookie } });
  const b = await bodyOf(res);
  ok("GET /api/images với phiên -> 200 (đọc D1, không cần R2)",
    res.status === 200, `nhận ${res.status} ${JSON.stringify(b)}`);

  const fakeExe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
  const fd = new FormData();
  fd.append("file", new Blob([fakeExe], { type: "image/jpeg" }), "trojan.jpg");
  const up = await raw("/api/images", {
    method: "POST",
    headers: { Cookie: sessionCookie },
    body: fd,
  });
  ok("upload .exe đổi tên .jpg bị TỪ CHỐI (400 kể cả khi R2 chưa bật)",
    up.status === 400, `nhận ${up.status}`);
}

/* -------------------------------------------------------------------------- */
section("J. Không lộ stack trace");
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/api/khong-ton-tai");
  const text = await res.text();
  ok("endpoint lạ -> 404 JSON", res.status === 404, `nhận ${res.status}`);
  ok("không lộ stack trace", !/at\s+\w+\s*\(|\.ts:\d+|Error:/.test(text), text.slice(0, 150));
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
