/**
 * test/r2-verify.mjs — kiểm tra tính năng ảnh R2 trên PRODUCTION.
 *
 * Chạy: node test/r2-verify.mjs
 *
 * Kiểm tra đúng các tiêu chí nghiệm thu về ảnh:
 *   - upload .exe đổi tên .jpg -> bị từ chối (magic bytes)
 *   - upload JPEG thật -> 201, tên file dùng UUID
 *   - ảnh xem được khi đã đăng nhập
 *   - ẢNH KHÔNG XEM ĐƯỢC KHI CHƯA ĐĂNG NHẬP  <-- quan trọng nhất
 *   - xoá ảnh hoạt động
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

const raw = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, redirect: "manual" });

/* -------------------------------------------------------------------------- */
section("Đăng nhập");
/* -------------------------------------------------------------------------- */

const login = await raw("/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: secrets.ADMIN_PASSWORD }),
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
ok("đăng nhập -> 200", login.status === 200, `nhận ${login.status}`);

/* -------------------------------------------------------------------------- */
section("R2 đã bật — /api/images phải trả 200, không còn 503");
/* -------------------------------------------------------------------------- */

{
  const res = await raw("/api/images", { headers: { Cookie: cookie } });
  const body = await res.json().catch(() => ({}));
  ok("GET /api/images -> 200 (R2 đã hoạt động)", res.status === 200,
    `nhận ${res.status} ${JSON.stringify(body)}`);
  ok("trả về mảng images", Array.isArray(body?.images), JSON.stringify(body).slice(0, 120));
}

/* -------------------------------------------------------------------------- */
section("File .exe đổi tên .jpg phải bị TỪ CHỐI");
/* -------------------------------------------------------------------------- */

{
  // Header MZ thật của file PE (Windows executable), chỉ đổi tên thành .jpg.
  const exe = new Uint8Array([
    0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
    0xff, 0xff, 0x00, 0x00, 0xb8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const fd = new FormData();
  fd.append("file", new Blob([exe], { type: "image/jpeg" }), "trojan.jpg");
  const res = await raw("/api/images", { method: "POST", headers: { Cookie: cookie }, body: fd });
  const body = await res.json().catch(() => ({}));
  ok("upload .exe đội lốt .jpg -> 400", res.status === 400,
    `nhận ${res.status} ${JSON.stringify(body)}`);
}

/* -------------------------------------------------------------------------- */
section("Upload ảnh JPEG thật");
/* -------------------------------------------------------------------------- */

let uploadedKey = null;

{
  // JPEG hợp lệ tối thiểu: SOI + APP0(JFIF) + EOI
  const jpg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ]);
  const fd = new FormData();
  fd.append("file", new Blob([jpg], { type: "image/jpeg" }), "bang-chung-test.jpg");
  fd.append("note", "Anh kiem tra tinh nang R2");

  const res = await raw("/api/images", { method: "POST", headers: { Cookie: cookie }, body: fd });
  const body = await res.json().catch(() => ({}));
  ok("upload JPEG thật -> 201", res.status === 201, `nhận ${res.status} ${JSON.stringify(body)}`);

  uploadedKey = body?.image?.r2_key || null;

  ok("khoá R2 dùng UUID, KHÔNG dùng tên gốc client",
    typeof uploadedKey === "string" && /^img_[0-9a-f-]{36}\.jpg$/.test(uploadedKey),
    String(uploadedKey));
  ok("không trả URL R2 công khai",
    typeof body?.image?.url === "string" && body.image.url.startsWith("/api/images/"),
    String(body?.image?.url));
  ok("ghi chú được lưu", body?.image?.note === "Anh kiem tra tinh nang R2",
    String(body?.image?.note));
  ok("có sha256", typeof body?.image?.sha256 === "string" && body.image.sha256.length === 64,
    String(body?.image?.sha256));
}

/* -------------------------------------------------------------------------- */
section("QUAN TRỌNG NHẤT: ảnh phải được bảo vệ");
/* -------------------------------------------------------------------------- */

if (uploadedKey) {
  // 1. Không có phiên -> PHẢI 401.
  const noAuth = await raw(`/api/images/${uploadedKey}`);
  ok("xem ảnh khi CHƯA đăng nhập -> 401 (tiêu chí nghiệm thu)",
    noAuth.status === 401, `nhận ${noAuth.status}`);

  // 2. Cookie giả -> PHẢI 401.
  const fakeAuth = await raw(`/api/images/${uploadedKey}`, {
    headers: { Cookie: "shop_session=gia-mao.khong-hop-le" },
  });
  ok("xem ảnh với cookie giả -> 401", fakeAuth.status === 401, `nhận ${fakeAuth.status}`);

  // 3. Có phiên -> 200 và đúng nội dung.
  const withAuth = await raw(`/api/images/${uploadedKey}`, { headers: { Cookie: cookie } });
  ok("xem ảnh khi ĐÃ đăng nhập -> 200", withAuth.status === 200, `nhận ${withAuth.status}`);
  ok("Content-Type đúng image/jpeg",
    (withAuth.headers.get("content-type") || "").includes("image/jpeg"),
    withAuth.headers.get("content-type") || "");
  ok("có header nosniff",
    withAuth.headers.get("x-content-type-options") === "nosniff",
    withAuth.headers.get("x-content-type-options") || "");

  const bytes = new Uint8Array(await withAuth.arrayBuffer());
  ok("nội dung ảnh khớp JPEG magic bytes (FF D8 FF)",
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    `nhận ${bytes[0]?.toString(16)} ${bytes[1]?.toString(16)}`);

  // 4. Danh sách ảnh cũng phải được bảo vệ.
  const listNoAuth = await raw("/api/images");
  ok("danh sách ảnh chưa đăng nhập -> 401", listNoAuth.status === 401, `nhận ${listNoAuth.status}`);

  const listAuth = await raw("/api/images", { headers: { Cookie: cookie } });
  const lb = await listAuth.json();
  ok("ảnh vừa upload có trong danh sách",
    Array.isArray(lb?.images) && lb.images.some((i) => i.r2_key === uploadedKey),
    `có ${lb?.images?.length} ảnh`);

  // 5. Path traversal phải bị chặn.
  const traversal = await raw("/api/images/..%2F..%2Fetc%2Fpasswd", { headers: { Cookie: cookie } });
  ok("path traversal bị chặn (404)", traversal.status === 404, `nhận ${traversal.status}`);
}

/* -------------------------------------------------------------------------- */
section("Xoá ảnh");
/* -------------------------------------------------------------------------- */

if (uploadedKey) {
  const del = await raw(`/api/images/${uploadedKey}`, { method: "DELETE", headers: { Cookie: cookie } });
  ok("xoá ảnh -> 200", del.status === 200, `nhận ${del.status}`);

  const after = await raw(`/api/images/${uploadedKey}`, { headers: { Cookie: cookie } });
  ok("ảnh đã xoá -> 404", after.status === 404, `nhận ${after.status}`);
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
