/**
 * test/prod-snapshot.mjs — in ra bằng chứng dashboard thật đang phục vụ dữ liệu.
 *
 * Chạy: node test/prod-snapshot.mjs
 * Dùng để mắt thường nhìn thấy KPI đã có số, không còn dấu "—".
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.PROD_URL || "https://shop-dashboard.nguyenkhang170855.workers.dev";

const secrets = {};
for (const line of readFileSync(join(ROOT, ".deploy-secrets"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) secrets[m[1]] = m[2].trim();
}

// 1. Đăng nhập
const loginRes = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: secrets.ADMIN_PASSWORD }),
  redirect: "manual",
});
const setCookie = loginRes.headers.get("set-cookie") || "";
const cookie = setCookie.split(";")[0];
console.log(`Đăng nhập: HTTP ${loginRes.status}`);
console.log(`Cookie: ${cookie.slice(0, 45)}...`);
console.log("");

// 2. Lấy HTML dashboard
const dashRes = await fetch(`${BASE}/`, { headers: { Cookie: cookie }, redirect: "manual" });
const html = await dashRes.text();
console.log(`GET / -> HTTP ${dashRes.status}, ${html.length} ký tự`);
console.log("");

const ids = [
  "sync-bar", "sync-badge", "kpi-revenue", "kpi-orders", "kpi-orders-all",
  "kpi-users", "kpi-wallet", "chart-revenue", "products-body",
  "methods-body", "status-body", "sync-history-body",
];
console.log("Các phần tử dashboard hiện diện trong HTML thật:");
for (const id of ids) {
  console.log(`  ${html.includes(`id="${id}"`) ? "OK  " : "THIẾU"} #${id}`);
}
console.log("");

// 3. Gọi API số liệu
const statsRes = await fetch(`${BASE}/api/stats`, { headers: { Cookie: cookie } });
const stats = await statsRes.json();
console.log(`GET /api/stats -> HTTP ${statsRes.status}`);
console.log("");
console.log("Số liệu dashboard sẽ hiển thị:");
console.log(`  Đồng bộ lần cuối : ${stats.synced_at}`);
console.log(`  Dữ liệu cũ?      : ${stats.stale ? "CÓ — cảnh báo đỏ" : "không"}`);
const t = stats.totals || {};
const vnd = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " ₫";
console.log(`  Tổng doanh thu   : ${vnd(t.revenue_delivered)}  (${t.orders_delivered} đơn delivered)`);
console.log(`  Tổng số đơn      : ${t.orders_all}`);
console.log(`  Người dùng       : ${t.users_total}`);
console.log(`  Tổng số dư ví    : ${vnd(t.wallet_balance_sum)}`);
console.log("");
console.log("  Theo phương thức :");
for (const m of stats.by_method || []) {
  console.log(`    ${String(m.method).padEnd(8)} ${String(m.orders).padStart(4)} đơn  ${vnd(m.revenue)}`);
}
console.log("");
console.log("  Theo trạng thái  :");
for (const s of stats.by_status || []) {
  console.log(`    ${String(s.status).padEnd(12)} ${s.count}`);
}
console.log("");
console.log("  Biểu đồ 30 ngày  : " + (stats.by_day || []).length + " điểm dữ liệu");
console.log("  Sản phẩm         : " + (stats.by_product || []).length + " dòng");

// 4. Lưu bản HTML để mở bằng trình duyệt nếu muốn
const out = join(ROOT, "test", "prod-dashboard.html");
writeFileSync(out, html, "utf8");
console.log("");
console.log(`Đã lưu HTML thật vào: test/prod-dashboard.html`);
console.log(`Mở trực tiếp tại   : ${BASE}`);
