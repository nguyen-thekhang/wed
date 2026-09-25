/**
 * test/seed-stale.mjs — dựng lại đúng một snapshot đã cũ, để kiểm tra cảnh báo.
 *
 * Dùng khi muốn thử tay: node test/seed-stale.mjs [soGioCu]
 * Mặc định 3 giờ.
 */

import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const hours = Number(process.argv[2] || 3);

const vn = new Date(Date.now() + 7 * 3600 * 1000 - hours * 3600 * 1000);
const p = (n) => String(n).padStart(2, "0");
const syncedAt =
  `${vn.getUTCFullYear()}-${p(vn.getUTCMonth() + 1)}-${p(vn.getUTCDate())}` +
  `T${p(vn.getUTCHours())}:${p(vn.getUTCMinutes())}:${p(vn.getUTCSeconds())}+07:00`;

const payload = {
  synced_at: syncedAt,
  totals: {
    revenue_delivered: 250000,
    orders_delivered: 3,
    orders_all: 5,
    users_total: 2,
    deposits_confirmed: 1,
    wallet_balance_sum: 350000,
  },
  by_day: [],
  by_product: [{ product_id: 1, name: "San pham cu", sold: 3, revenue: 250000 }],
  by_method: [{ method: "bank", orders: 3, revenue: 250000 }],
  by_status: [{ status: "delivered", count: 3 }],
  stock: [{ product_id: 1, available: 7, sold: 3 }],
};

const json = JSON.stringify(payload).replace(/'/g, "''");

const sql =
  "DELETE FROM sync_snapshots; " +
  `INSERT INTO sync_snapshots (synced_at, payload_json) VALUES ('${syncedAt}', '${json}');`;

console.log(`Chèn snapshot cũ ${hours} giờ, synced_at = ${syncedAt}`);

// Gọi wrangler qua node trực tiếp (không qua shell) để tránh lỗi escaping trên
// Windows và tránh phụ thuộc vào việc `npx` có trong PATH hay không.
const wranglerJs = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

execFileSync(
  process.execPath,
  [wranglerJs, "d1", "execute", "shop-dashboard", "--local", "--command", sql],
  { cwd: ROOT, stdio: "inherit" },
);

console.log("Xong. Mở dashboard và kiểm tra thanh trạng thái phải chuyển ĐỎ.");
