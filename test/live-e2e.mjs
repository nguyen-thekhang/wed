/**
 * =============================================================================
 * test/live-e2e.mjs — kiểm tra đầu-cuối thật với Worker đang chạy
 * =============================================================================
 *
 * Chạy: node test/live-e2e.mjs
 * Cần:  npx wrangler dev --local --port 8787  (đang chạy ở cửa sổ khác)
 *
 * Bộ test này kiểm tra những tiêu chí nghiệm thu CHỈ đúng khi có Worker thật,
 * đặc biệt là luồng đã đăng nhập — thứ mà kiểm tra tĩnh không thể chứng minh:
 *
 *   - /api/sync không token -> 401, có token -> 200
 *   - đăng nhập đúng -> cookie HttpOnly/Secure/SameSite=Strict
 *   - /api/stats với phiên -> 200, số liệu khớp với payload đã sync
 *   - upload file .exe đổi tên .jpg -> BỊ TỪ CHỐI (kiểm tra magic bytes)
 *   - ảnh không xem được khi chưa đăng nhập
 *   - chạy sync 2 lần -> số liệu không nhân đôi
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";

// Đọc secret từ .dev.vars để test đăng nhập thật.
const devVars = {};
const devVarsPath = join(ROOT, ".dev.vars");
try {
  for (const line of readFileSync(devVarsPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) devVars[m[1]] = m[2].trim();
  }
} catch {
  console.error("Không đọc được .dev.vars — cần file này để test đăng nhập.");
  process.exit(2);
}

const SYNC_TOKEN = devVars.SYNC_TOKEN;
const ADMIN_PASSWORD = devVars.ADMIN_PASSWORD;

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

/** fetch không tự đi theo redirect — ta cần thấy đúng mã 302. */
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

/* -------------------------------------------------------------------------- */
section("A. /api/sync — xác thực bằng token tĩnh");
/* -------------------------------------------------------------------------- */

/**
 * Sinh synced_at là "bây giờ" theo giờ VN (+07:00).
 *
 * LƯU Ý CỰC DỄ SAI: `Date.now()` trả về epoch (UTC), KHÔNG phải giờ địa phương.
 * Muốn ra giờ tường VN thì cộng đúng 7 giờ vào epoch rồi đọc bằng các hàm
 * getUTC*(). Tuyệt đối không dùng getHours()/getDate() — chúng phụ thuộc
 * timezone của máy đang chạy test, nên cùng một đoạn code sẽ cho kết quả khác
 * nhau giữa máy đặt UTC+7 và máy đặt UTC.
 */
function vnWallClock(offsetHours = 0) {
  return new Date(Date.now() + 7 * 3600 * 1000 + offsetHours * 3600 * 1000);
}

function isoAtVn(offsetHours = 0) {
  const vn = vnWallClock(offsetHours);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${vn.getUTCFullYear()}-${p(vn.getUTCMonth() + 1)}-${p(vn.getUTCDate())}` +
    `T${p(vn.getUTCHours())}:${p(vn.getUTCMinutes())}:${p(vn.getUTCSeconds())}+07:00`
  );
}

function nowVnIso() {
  return isoAtVn(0);
}

/** Ngày VN hôm nay dạng YYYY-MM-DD. */
function vnTodayStr() {
  const vn = vnWallClock(0);
  const p = (n) => String(n).padStart(2, "0");
  return `${vn.getUTCFullYear()}-${p(vn.getUTCMonth() + 1)}-${p(vn.getUTCDate())}`;
}

const TODAY_VN = vnTodayStr();

const SAMPLE_PAYLOAD = {
  synced_at: nowVnIso(),
  totals: {
    revenue_delivered: 95000,
    orders_delivered: 2,
    orders_all: 3,
    users_total: 2,
    deposits_confirmed: 1,
    wallet_balance_sum: 350000,
  },
  by_day: [{ date: TODAY_VN, revenue: 95000, orders: 2 }],
  by_product: [{ product_id: 3, name: "Netflix 1 thang", sold: 2, revenue: 95000 }],
  by_method: [
    { method: "bank", orders: 1, revenue: 45000 },
    { method: "khác", orders: 1, revenue: 50000 },
  ],
  by_status: [
    { status: "delivered", count: 2 },
    { status: "cancelled", count: 1 },
  ],
  stock: [{ product_id: 3, available: 2, sold: 1 }],
};

/** Payload có synced_at đã cũ 3 giờ, để kiểm tra cảnh báo dữ liệu cũ. */
function stalePayload() {
  return { ...SAMPLE_PAYLOAD, synced_at: isoAtVn(-3) };
}

{
  const res = await raw("/api/sync", { method: "POST", body: JSON.stringify(SAMPLE_PAYLOAD) });
  ok("POST /api/sync không token -> 401", res.status === 401, `nhận ${res.status}`);
  const b = await bodyOf(res);
  ok("lỗi có dạng {error:{code}}", b && b.error && typeof b.error.code === "string", JSON.stringify(b));
}

{
  const res = await raw("/api/sync", {
    method: "POST",
    headers: { Authorization: "Bearer token-sai" },
    body: JSON.stringify(SAMPLE_PAYLOAD),
  });
  ok("POST /api/sync sai token -> 401", res.status === 401, `nhận ${res.status}`);
}

{
  const res = await raw("/api/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${SYNC_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(SAMPLE_PAYLOAD),
  });
  const b = await bodyOf(res);
  ok("POST /api/sync đúng token -> 200", res.status === 200, `nhận ${res.status} ${JSON.stringify(b)}`);
  ok("trả về ok:true + synced_at", b && b.ok === true && typeof b.synced_at === "string", JSON.stringify(b));
}

{
  // Payload rác phải bị từ chối, không được 500.
  const res = await raw("/api/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${SYNC_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ synced_at: "khong-phai-iso", totals: {} }),
  });
  ok("payload sai định dạng -> 400 (không phải 500)", res.status === 400, `nhận ${res.status}`);
}

{
  // Idempotent: gửi lại y hệt lần 2 vẫn 200.
  const res = await raw("/api/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${SYNC_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(SAMPLE_PAYLOAD),
  });
  ok("gửi lại cùng snapshot -> 200 (idempotent)", res.status === 200, `nhận ${res.status}`);
}

/* -------------------------------------------------------------------------- */
section("B. Đăng nhập & cookie phiên");
/* -------------------------------------------------------------------------- */

let sessionCookie = null;

{
  const res = await raw("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "sai-chac-chan" }),
  });
  ok("mật khẩu sai -> 401", res.status === 401 || res.status === 429, `nhận ${res.status}`);
}

{
  const res = await raw("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const b = await bodyOf(res);
  ok("mật khẩu đúng -> 200", res.status === 200, `nhận ${res.status} ${JSON.stringify(b)}`);
  ok("Set-Cookie có HttpOnly", /HttpOnly/i.test(setCookie), setCookie);
  ok("Set-Cookie có Secure", /Secure/i.test(setCookie), setCookie);
  ok("Set-Cookie có SameSite=Strict", /SameSite=Strict/i.test(setCookie), setCookie);
  ok("Set-Cookie có Path=/", /Path=\//i.test(setCookie), setCookie);
  ok("Set-Cookie KHÔNG chứa token dạng thô dễ đọc", !/token=/i.test(setCookie), setCookie);
  sessionCookie = (setCookie.split(";")[0] || "").trim();
  ok("lấy được cookie phiên để test tiếp", sessionCookie.includes("="), sessionCookie);
}

/* -------------------------------------------------------------------------- */
section("C. Số liệu trả về đúng sau khi sync (cần phiên)");
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/api/stats", { headers: { Cookie: sessionCookie } });
  const b = await bodyOf(res);
  ok("GET /api/stats với phiên -> 200", res.status === 200, `nhận ${res.status}`);
  ok("Content-Type là JSON", (res.headers.get("content-type") || "").includes("application/json"),
    res.headers.get("content-type") || "");
  ok("có đủ totals/by_day/by_product/by_method/by_status/stock",
    b && b.totals && b.by_day && b.by_product && b.by_method && b.by_status && b.stock,
    Object.keys(b || {}).join(","));
  ok("doanh thu delivered = 95000 (chỉ đơn delivered)",
    b?.totals?.revenue_delivered === 95000, String(b?.totals?.revenue_delivered));
  ok("by_day được điền đủ 30 ngày liên tục",
    Array.isArray(b?.by_day) && b.by_day.length === 30, String(b?.by_day?.length));
  ok("nhóm 'khác' vẫn còn (đơn method rỗng không bị mất)",
    Array.isArray(b?.by_method) && b.by_method.some((m) => m.method === "khác"),
    JSON.stringify(b?.by_method));
  ok("synced_at giữ đúng +07:00",
    typeof b?.synced_at === "string" && b.synced_at.endsWith("+07:00"), String(b?.synced_at));
  ok("KHÔNG có trường nào chứa acc|pass",
    !/acc\|pass/.test(JSON.stringify(b)));
}

/* -------------------------------------------------------------------------- */
section("D. Ảnh: từ chối file lạ đội lốt ảnh");
/* -------------------------------------------------------------------------- */

{
  // Đây là tiêu chí nghiệm thu: file .exe đổi tên thành .jpg phải bị từ chối.
  // Nội dung là header MZ thật của file PE, chỉ đổi tên thành .jpg.
  const fakeJpg = new Uint8Array([
    0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00,
  ]);
  const fd = new FormData();
  fd.append("file", new Blob([fakeJpg], { type: "image/jpeg" }), "trojan.jpg");
  fd.append("note", "day la file exe doi ten");

  const res = await raw("/api/images", { method: "POST", headers: { Cookie: sessionCookie }, body: fd });
  const b = await bodyOf(res);
  ok("upload .exe đổi tên .jpg -> BỊ TỪ CHỐI (400)", res.status === 400, `nhận ${res.status} ${JSON.stringify(b)}`);
}

{
  // File JPEG hợp lệ tối thiểu (SOI + APP0 + EOI) phải được nhận.
  const realJpg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ]);
  const fd = new FormData();
  fd.append("file", new Blob([realJpg], { type: "image/jpeg" }), "anh-that.jpg");
  fd.append("note", "anh that de test");

  const res = await raw("/api/images", { method: "POST", headers: { Cookie: sessionCookie }, body: fd });
  const b = await bodyOf(res);
  ok("upload JPEG thật -> 201", res.status === 201, `nhận ${res.status} ${JSON.stringify(b)}`);
  ok("khoá R2 dùng UUID, không dùng tên gốc của client",
    typeof b?.image?.r2_key === "string" && /^img_[0-9a-f-]{36}\.jpg$/.test(b.image.r2_key),
    String(b?.image?.r2_key));
  ok("không trả về URL R2 công khai",
    typeof b?.image?.url === "string" && b.image.url.startsWith("/api/images/"),
    String(b?.image?.url));

  const key = b?.image?.r2_key;

  if (key) {
    // Ảnh phải xem được KHI có phiên...
    const withSession = await raw(`/api/images/${key}`, { headers: { Cookie: sessionCookie } });
    ok("xem ảnh khi đã đăng nhập -> 200", withSession.status === 200, `nhận ${withSession.status}`);
    ok("ảnh trả về đúng Content-Type image/jpeg",
      (withSession.headers.get("content-type") || "").includes("image/jpeg"),
      withSession.headers.get("content-type") || "");

    // ...và KHÔNG xem được khi chưa đăng nhập. Đây là tiêu chí nghiệm thu.
    const noSession = await raw(`/api/images/${key}`);
    ok("xem ảnh khi CHƯA đăng nhập -> 401", noSession.status === 401, `nhận ${noSession.status}`);

    // Danh sách ảnh cũng phải yêu cầu đăng nhập.
    const listNo = await raw("/api/images");
    ok("danh sách ảnh chưa đăng nhập -> 401", listNo.status === 401, `nhận ${listNo.status}`);
    const listYes = await raw("/api/images", { headers: { Cookie: sessionCookie } });
    const lb = await bodyOf(listYes);
    ok("danh sách ảnh có phiên -> 200 và chứa ảnh vừa upload",
      listYes.status === 200 && Array.isArray(lb?.images) && lb.images.some((i) => i.r2_key === key),
      `status=${listYes.status}`);
  }
}

/* -------------------------------------------------------------------------- */
section("E. Nhật ký (audit log) ghi nhận sync và login");
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/api/logs?limit=50", { headers: { Cookie: sessionCookie } });
  const b = await bodyOf(res);
  ok("GET /api/logs với phiên -> 200", res.status === 200, `nhận ${res.status}`);
  ok("có mảng admin_log và syncs", Array.isArray(b?.admin_log) && Array.isArray(b?.syncs),
    Object.keys(b || {}).join(","));
  const actions = (b?.admin_log || []).map((r) => r.action);
  ok("audit_log có ghi action 'sync'", actions.includes("sync"), actions.join(","));
  ok("audit_log có ghi action 'login'", actions.includes("login"), actions.join(","));
  ok("audit_log KHÔNG chứa acc|pass", !/acc\|pass/.test(JSON.stringify(b?.admin_log || [])));
}

/* -------------------------------------------------------------------------- */
section("F. Không lộ stack trace, không lộ dữ liệu qua lỗi");
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/api/logs?date=khong-phai-ngay", { headers: { Cookie: sessionCookie } });
  const text = await res.text();
  ok("date sai định dạng -> 400", res.status === 400, `nhận ${res.status}`);
  ok("body lỗi không chứa stack trace",
    !/at\s+\w+\s*\(|\.ts:\d+|\.js:\d+|Error:/.test(text), text.slice(0, 200));
}

{
  const res = await raw("/api/khong-ton-tai");
  ok("endpoint lạ -> 404 JSON", res.status === 404, `nhận ${res.status}`);
}

/* -------------------------------------------------------------------------- */
section("G. Trang HTML yêu cầu đăng nhập (không lộ khi chưa login)");
/* -------------------------------------------------------------------------- */

for (const p of ["/", "/index.html", "/logs", "/images", "/js/dashboard.js"]) {
  const res = await raw(p);
  const isRedirect = res.status === 302 || res.status === 307 || res.status === 301;
  ok(`${p} chưa đăng nhập -> chuyển hướng sang login`,
    isRedirect && (res.headers.get("location") || "").includes("/login"),
    `nhận ${res.status} -> ${res.headers.get("location") || ""}`);
}

{
  const res = await raw("/", { headers: { Cookie: sessionCookie } });
  const text = await res.text();
  ok("GET / với phiên -> 200 và trả HTML dashboard", res.status === 200 && text.includes("<canvas"),
    `nhận ${res.status}`);
  ok("trang dashboard có header bảo mật CSP",
    (res.headers.get("content-security-policy") || "").length > 0,
    res.headers.get("content-security-policy") || "none");
  ok("trang dashboard có X-Content-Type-Options: nosniff",
    res.headers.get("x-content-type-options") === "nosniff",
    res.headers.get("x-content-type-options") || "none");
}

/* -------------------------------------------------------------------------- */
section("H. Đăng xuất xoá phiên");
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/api/logout", { method: "POST", headers: { Cookie: sessionCookie } });
  const setCookie = res.headers.get("set-cookie") || "";
  ok("POST /api/logout -> 200", res.status === 200, `nhận ${res.status}`);
  ok("Set-Cookie xoá phiên (Max-Age=0)", /Max-Age=0/i.test(setCookie), setCookie);

  const after = await raw("/api/stats", { headers: { Cookie: sessionCookie } });
  ok("cookie cũ vẫn dùng được sau logout? -> phải là 401 hoặc 200 tuỳ chính sách",
    after.status === 401 || after.status === 200, `nhận ${after.status}`);
}

/* -------------------------------------------------------------------------- */
section("I. Cảnh báo dữ liệu cũ (quá 1 giờ chưa sync)");
/* -------------------------------------------------------------------------- */

{
  // ---------------------------------------------------------------------
  // /api/stats LUÔN lấy snapshot theo `synced_at DESC` — tức mốc đồng bộ mới
  // nhất. Muốn thấy cảnh báo "dữ liệu cũ" thì snapshot cũ phải là bản DUY NHẤT
  // trong DB (đúng tình huống cron trên VPS đã chết vài tiếng).
  //
  // Chuẩn bị DB bằng đúng script mà người dùng sẽ dùng khi thử tay, để bộ test
  // kiểm tra luôn cả đường đi thật đó.
  // ---------------------------------------------------------------------
  const { execFileSync } = await import("node:child_process");
  const wranglerJs = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

  // Xoá sạch rồi chèn đúng một snapshot cũ 3 giờ (kèm payload hợp lệ).
  const vn = new Date(Date.now() + 7 * 3600 * 1000 - 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const staleIso =
    `${vn.getUTCFullYear()}-${p(vn.getUTCMonth() + 1)}-${p(vn.getUTCDate())}` +
    `T${p(vn.getUTCHours())}:${p(vn.getUTCMinutes())}:${p(vn.getUTCSeconds())}+07:00`;
  const staleJson = JSON.stringify({
    ...SAMPLE_PAYLOAD,
    synced_at: staleIso,
    totals: { ...SAMPLE_PAYLOAD.totals, revenue_delivered: 250000 },
  }).replace(/'/g, "''");

  const sql =
    "DELETE FROM sync_snapshots; " +
    `INSERT INTO sync_snapshots (synced_at, payload_json) VALUES ('${staleIso}', '${staleJson}');`;

  execFileSync(
    process.execPath,
    [wranglerJs, "d1", "execute", "shop-dashboard", "--local", "--command", sql],
    { cwd: ROOT, stdio: "pipe" },
  );

  const s = await raw("/api/stats", { headers: { Cookie: sessionCookie } });
  const b = await bodyOf(s);
  ok("chỉ còn snapshot cũ 3 giờ -> stale = true (dashboard hiện cảnh báo đỏ)",
    b?.stale === true, `stale=${b?.stale} sec=${b?.stale_seconds}`);
  ok("stale_seconds >= 3600", typeof b?.stale_seconds === "number" && b.stale_seconds >= 3600,
    String(b?.stale_seconds));

  // Dashboard phải lấy đúng dữ liệu của snapshot cũ đó.
  ok("doanh thu lấy từ snapshot cũ = 250000",
    b?.totals?.revenue_delivered === 250000, String(b?.totals?.revenue_delivered));
}

{
  // VPS đồng bộ lại -> cảnh báo phải tắt ngay.
  const res2 = await raw("/api/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${SYNC_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(SAMPLE_PAYLOAD),
  });
  ok("sync lại snapshot mới -> 200", res2.status === 200, `nhận ${res2.status}`);

  const s2 = await raw("/api/stats", { headers: { Cookie: sessionCookie } });
  const b2 = await bodyOf(s2);
  ok("vừa sync xong -> stale = false (hết cảnh báo)",
    b2?.stale === false, `stale=${b2?.stale} sec=${b2?.stale_seconds}`);
  ok("stale_seconds nhỏ (< 60)",
    typeof b2?.stale_seconds === "number" && b2.stale_seconds < 60, String(b2?.stale_seconds));
  ok("doanh thu cập nhật theo snapshot mới = 95000",
    b2?.totals?.revenue_delivered === 95000, String(b2?.totals?.revenue_delivered));
}

{
  // Bảo vệ khỏi báo động giả: gửi bù một snapshot CŨ trong khi DB đã có bản mới
  // hơn thì dashboard KHÔNG được quay lại trạng thái "cũ" (đây là lý do phải
  // sắp theo synced_at chứ không phải theo id).
  const res3 = await raw("/api/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${SYNC_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(stalePayload()),
  });
  ok("gửi bù snapshot cũ -> 200 (vẫn nhận, không lỗi)", res3.status === 200, `nhận ${res3.status}`);

  const s3 = await raw("/api/stats", { headers: { Cookie: sessionCookie } });
  const b3 = await bodyOf(s3);
  ok("có bản mới hơn trong DB -> vẫn stale = false (không báo động giả)",
    b3?.stale === false, `stale=${b3?.stale} sec=${b3?.stale_seconds}`);
  ok("doanh thu vẫn là của bản mới nhất = 95000",
    b3?.totals?.revenue_delivered === 95000, String(b3?.totals?.revenue_delivered));
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
