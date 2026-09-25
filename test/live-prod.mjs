/**
 * Kiểm tra chức năng còn nguyên trên PRODUCTION (chạy thẳng, không cần Worker cục bộ).
 *
 * Chỉ dùng đường KHÔNG tạo rác:
 *   - đăng nhập / đăng xuất
 *   - đọc (stats, logs, images, tickxanh)
 *   - kiểm tra UID với UID không tồn tại (vẫn chạy, không ghi vào DB sản phẩm)
 *   - từ chối tệp .exe đổi tên .jpg (đường từ chối, không tạo ảnh)
 *   - xác nhận asset được bảo vệ vẫn 302
 */
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "https://shop-dashboard.nguyenkhang170855.workers.dev";
const secrets = {};
for (const line of readFileSync(".deploy-secrets", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) secrets[m[1]] = m[2].trim();
}
const PWD = secrets.ADMIN_PASSWORD;

let pass = 0, fail = 0;
const bad = [];
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; bad.push(label); console.log(`  ✗ ${label}`); }
}

let cookie = "";
const api = async (path, opts = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    redirect: "manual",
    headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  const sc = r.headers.get("set-cookie");
  if (sc) {
    const m = sc.match(/shop_session=[^;]*/);
    if (m) cookie = m[0];
  }
  return r;
};

console.log("=== A. XÁC THỰC ===");
{
  const r = await api("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "sai-mat-khau-hoan-toan" }),
  });
  ok(r.status === 401, `mật khẩu sai -> 401 (thực tế ${r.status})`);
}
{
  const r = await api("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PWD }),
  });
  const sc = r.headers.get("set-cookie") || "";
  ok(r.status === 200, `đăng nhập đúng -> 200 (thực tế ${r.status})`);
  ok(/HttpOnly/i.test(sc), "cookie HttpOnly");
  ok(/SameSite=Strict/i.test(sc), "cookie SameSite=Strict");
  ok(cookie.length > 0, "nhận được cookie phiên");
}

console.log("\n=== B. ĐỌC DỮ LIỆU (các trang dùng) ===");
{
  const r = await api("/api/stats");
  const j = await r.json().catch(() => null);
  ok(r.status === 200, `GET /api/stats -> 200 (thực tế ${r.status})`);
  ok(j && j.totals, "có totals");
  ok(Array.isArray(j && j.by_day), "có by_day cho biểu đồ");
  ok(Array.isArray(j && j.by_product), "có by_product");
  ok(Array.isArray(j && j.by_method), "có by_method");
  ok(Array.isArray(j && j.by_status), "có by_status");
}
for (const [p, key] of [["/api/logs", "rows"], ["/api/logs/syncs", "rows"], ["/api/images", "items"], ["/api/tickxanh", "items"]]) {
  const r = await api(p);
  const j = await r.json().catch(() => null);
  ok(r.status === 200, `GET ${p} -> 200 (thực tế ${r.status})`);
}

console.log("\n=== C. KIỂM TRA UID (chạy thật, không ghi sản phẩm) ===");
{
  /*
    Hợp đồng thật của POST /api/fbcheck (xem src/api/fbcheck.ts):
      { ok, total, live: [], die: [], unknown: [], summary: {...} }
    Ba mảng phân loại RIÊNG BIỆT — không có mảng `results`.
    Lần kiểm tra đầu tiết đoán sai hợp đồng (đoán có `results`) và báo
    không đạt oan. Đây là bài học: đừng đoán cấu trúc phản hồi, hãy đọc nó.
  */
  const r = await api("/api/fbcheck", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uids: ["1000000000000000"] }),
  });
  ok(r.status === 200 || r.status === 400 || r.status === 429, `POST /api/fbcheck trả lời hợp lệ (thực tế ${r.status})`);
  if (r.status === 200) {
    const j = await r.json();
    ok(j.ok === true, "ok = true");
    ok(Array.isArray(j.live), "có mảng live");
    ok(Array.isArray(j.die), "có mảng die");
    ok(Array.isArray(j.unknown), "có mảng unknown");
    ok(j.summary && typeof j.summary.invalid_lines === "number", "có summary.invalid_lines");
    ok(j.total === 1, `total = 1 (thực tế ${j.total})`);
    // UID không tồn tại phải rơi vào một trong ba nhóm, không biến mất
    const seen = j.live.length + j.die.length + j.unknown.length;
    ok(seen === j.total, `mọi UID đều được phân loại (${seen}/${j.total})`);
  }
}
{
  // Body rỗng phải bị từ chối, không được im lặng
  const r = await api("/api/fbcheck", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uids: [] }),
  });
  ok(r.status >= 400, `uids rỗng bị từ chối (thực tế ${r.status})`);
}

console.log("\n=== D. TẢI ẢNH — CHỈ KIỂM ĐƯỜNG TỪ CHỐI (không tạo ảnh thật) ===");
{
  // File .exe đổi tên .jpg: server phải chặn theo magic bytes
  const fake = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ header
  const fd = new FormData();
  fd.append("file", new Blob([fake], { type: "image/jpeg" }), "khong-phai-anh.jpg");
  const r = await api("/api/images", { method: "POST", body: fd });
  ok(r.status >= 400, `.exe đổi tên .jpg bị từ chối (thực tế ${r.status})`);
}

console.log("\n=== E. BẢO VỆ TÀI NGUYÊN ===");
// Tài nguyên BẢO VỆ: phải 302 về trang đăng nhập khi chưa đăng nhập.
for (const p of ["/index.html", "/js/dashboard.js", "/uid.html", "/tickxanh.html", "/logs.html", "/images.html"]) {
  const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
  ok(r.status === 302, `${p} -> 302 khi chưa đăng nhập (thực tế ${r.status})`);
}
/*
  Tài nguyên CÔNG KHAI: phải 200, kể cả khi chưa đăng nhập.

  /css/app.css nằm ở nhóm này và ĐÓ LÀ CÓ CHỦ ĐÍCH: login.html nạp app.css,
  nếu chặn thì trang đăng nhập mất toàn bộ CSS. Lần kiểm tra đầu tiết xếp
  nhầm nó vào nhóm "được bảo vệ" và báo không đạt oan.

  Ngược lại /css/pages.css KHÔNG nằm trong danh sách này, vì login.html không
  nạp nó (chỉ 5 trang đã đăng nhập mới nạp). Nó thuộc nhóm được bảo vệ.
*/
for (const p of ["/login.html", "/css/app.css", "/css/motion.css", "/css/preloader.css", "/js/motion.js", "/js/login.js", "/img/sprite.svg"]) {
  const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
  ok(r.status === 200, `${p} -> 200 công khai (thực tế ${r.status})`);
}
{
  // pages.css chỉ dùng ở 5 trang sau đăng nhập -> phải được bảo vệ
  const r = await fetch(`${BASE}/css/pages.css`, { redirect: "manual" });
  ok(r.status === 302, `/css/pages.css -> 302 (không nạp ở login) (thực tế ${r.status})`);
}

console.log("\n=== F. ĐĂNG XUẤT ===");
{
  const r = await api("/api/logout", { method: "POST" });
  ok(r.status === 200, `POST /api/logout -> 200 (thực tế ${r.status})`);
  const r2 = await api("/api/stats");
  ok(r2.status === 401, `sau logout, /api/stats -> 401 (thực tế ${r2.status})`);
}

console.log(`\n${"=".repeat(50)}\nKẾT QUẢ: ${pass} đạt, ${fail} không đạt`);
if (bad.length) { console.log("Không đạt:"); bad.forEach((b) => console.log("  - " + b)); }
process.exitCode = fail ? 1 : 0;
